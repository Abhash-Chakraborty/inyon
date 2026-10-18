#!/usr/bin/env bash
# Checks the skills under skills/ the way someone installing them would use them. Each needs a
# SKILL.md with a name that matches its folder and a description. For blueprint, it starts a site
# from the template, renders every sample screen at phone and desktop sizes (failing on a console
# error or a button that does nothing), and drives progress.py through each command.
# Needs Node and Playwright's Chromium (BLUEPRINT_PLAYWRIGHT names a folder that has Playwright).
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

for dir in "$root"/skills/*/; do
  name=$(basename "$dir")
  head -1 "$dir/SKILL.md" | grep -qx -- '---' || { echo "$name: SKILL.md has no frontmatter"; exit 1; }
  grep -qx "name: $name" "$dir/SKILL.md" || { echo "$name: SKILL.md's name isn't $name"; exit 1; }
  grep -q '^description: ..' "$dir/SKILL.md" || { echo "$name: SKILL.md has no description"; exit 1; }
done

bp="$root/skills/blueprint"
for f in "$bp"/scripts/*.mjs "$bp"/assets/site/kit/*.js "$bp"/assets/site/*.js "$bp"/assets/site/mockups/*.js; do node --check "$f"; done
python3 -m py_compile "$bp/scripts/progress.py"

node "$bp/scripts/new-site.mjs" "$tmp/site" --name "Test app"
grep -q "name: 'Test app'" "$tmp/site/kit/data.js"
if node "$bp/scripts/new-site.mjs" "$tmp/site" --name x 2>/dev/null; then echo "new-site.mjs copied over a site that wasn't empty"; exit 1; fi

p="python3 $bp/scripts/progress.py --file $tmp/site/progress.json"
$p task r1-sync done "synced"
$p add R2 r2-extra "One more task"
$p link r2-extra https://example.com/pr/1
$p now "Checking"
$p log "A line"
python3 - "$tmp/site/progress.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
r1, r2 = d['releases'][0], d['releases'][1]
assert [t['status'] for t in r1['tasks'] if t['id'] == 'r1-sync'] == ['done'], r1
assert any(t['id'] == 'r2-extra' and t['link'] == 'https://example.com/pr/1' for t in r2['tasks']), r2
assert d['now'] == 'Checking' and d['log'][0]['text'] == 'A line', d['log'][:2]
PY
if $p task nope done 2>/dev/null; then echo "progress.py took an unknown task"; exit 1; fi

node "$bp/scripts/stills.mjs" "$tmp/site" --audit
echo "skills ok"
