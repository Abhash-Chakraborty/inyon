#!/usr/bin/env python3
"""Update a Blueprint site's progress.json, which the plan page polls every 20 seconds.

  progress.py [--file site/progress.json] task <id> <todo|doing|done|blocked> [note]
  progress.py [--file ...] add <release-r> <id> "<title>"     add a task to a release (r is "R1" etc.)
  progress.py [--file ...] link <id> <url>                     attach a PR or link to a task
  progress.py [--file ...] log "<text>"                        add a line to the activity log
  progress.py [--file ...] now "<text>"                        set the "working on" line

--file defaults to $BLUEPRINT_PROGRESS, then ./progress.json. Several workers can run it at once: it locks
the file on Linux and macOS.
"""
import json, sys, datetime, os
try:
    import fcntl
except ImportError:  # Windows: no lock, run one writer at a time
    fcntl = None

args = sys.argv[1:]
path = os.environ.get('BLUEPRINT_PROGRESS', 'progress.json')
if args[:1] == ['--file']:
    path, args = args[1], args[2:]
if not args:
    sys.exit(__doc__)
now = datetime.datetime.now().astimezone().isoformat(timespec='minutes')


def rollup(r):
    st = [x['status'] for x in r['tasks']]
    r['status'] = 'done' if st and all(s == 'done' for s in st) else 'blocked' if 'blocked' in st else 'doing' if any(s in ('doing', 'done') for s in st) else 'todo'


def find(d, tid):
    for r in d['releases']:
        for t in r['tasks']:
            if t['id'] == tid:
                return r, t
    sys.exit(f'no task {tid}')


with open(path, 'r+', encoding='utf-8') as f:
    if fcntl:
        fcntl.flock(f, fcntl.LOCK_EX)
    d = json.load(f)
    cmd, a = args[0], args[1:]
    if cmd == 'task':
        if len(a) < 2 or a[1] not in ('todo', 'doing', 'done', 'blocked'):
            sys.exit(__doc__)
        r, t = find(d, a[0])
        t['status'] = a[1]
        if len(a) > 2:
            t['note'] = a[2]
        t['updated'] = now
        rollup(r)
        d['log'].insert(0, {'t': now, 'text': f"{r['v']} · {t['title']}: {a[1]}" + (f" ({a[2]})" if len(a) > 2 else '')})
    elif cmd == 'add':
        r = next((x for x in d['releases'] if x['r'] == a[0]), None) or sys.exit(f'no release {a[0]}')
        r['tasks'].append({'id': a[1], 'title': a[2], 'status': 'todo'})
        rollup(r)
    elif cmd in ('link', 'pr'):
        find(d, a[0])[1]['link'] = a[1]
    elif cmd == 'log':
        d['log'].insert(0, {'t': now, 'text': a[0]})
    elif cmd == 'now':
        d['now'] = a[0]
    else:
        sys.exit(__doc__)
    d['log'] = d['log'][:200]
    d['updated'] = now
    f.seek(0)
    f.truncate()
    json.dump(d, f, indent=1, ensure_ascii=False)
