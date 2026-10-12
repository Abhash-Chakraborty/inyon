import os from 'node:os'
import path from 'node:path'
import { closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { sendPush, type PushSubscriptionJSON, type Vapid } from '../hub/src/push/webpush.ts'
import { listPhones } from './link.ts'
import { nodeDir } from './paths.ts'

/**
 * Notifications for the web app while it's closed. The page has no server, so this machine sends
 * them: a paired browser hands over its push registration (`inyon push set`, run by the app over
 * the encrypted link), and when an agent's hook says it needs you or finished, this sends an
 * encrypted message straight to that browser's push service. Nothing goes through a server of
 * Inyon's, and the push service only sees ciphertext.
 *
 * The hooks write to ~/.inyon/events.jsonl, one JSON line per event with the tmux pane it came
 * from (see the hub's claude/integration.ts).
 */

export interface PushEntry {
  /** the phone's link key, as phones.json has it */
  phone: string
  /** this machine's id in that phone's app, for the notification's tag and link */
  host: string
  subscription: PushSubscriptionJSON
  vapid: Vapid
  done: boolean
}

const file = () => path.join(nodeDir(), 'push.json')
export const eventsFile = () => path.join(os.homedir(), '.inyon', 'events.jsonl')

export function readEntries(): PushEntry[] {
  try {
    const all = JSON.parse(readFileSync(file(), 'utf8'))
    return Array.isArray(all) ? all : []
  } catch {
    return []
  }
}

function writeEntries(all: PushEntry[]) {
  mkdirSync(nodeDir(), { recursive: true, mode: 0o700 })
  const tmp = `${file()}.${process.pid}.tmp`
  // the VAPID keys let anyone notify that browser: readable by this user only
  writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 })
  renameSync(tmp, file())
}

/** Replaces everything one phone gave, after checking its shape. */
export function setEntries(input: any) {
  const phone = String(input?.phone ?? '')
  const host = String(input?.host ?? '')
  if (!/^[0-9a-f]{64}$/.test(phone)) throw new Error('push set: bad phone key')
  if (!host || host.length > 200) throw new Error('push set: bad host id')
  const regs: any[] = Array.isArray(input.registrations) ? input.registrations : []
  const mine = regs.map((r): PushEntry => {
    const s = r?.subscription
    const j = r?.vapid?.privateJwk
    if (typeof s?.endpoint !== 'string' || !s.endpoint.startsWith('https://')) throw new Error('push set: bad endpoint')
    if (typeof s.keys?.p256dh !== 'string' || typeof s.keys?.auth !== 'string') throw new Error('push set: bad keys')
    if (j?.kty !== 'EC' || j.crv !== 'P-256' || ![j.d, j.x, j.y].every((v) => typeof v === 'string')) throw new Error('push set: bad VAPID key')
    const subject = String(r.vapid.subject ?? '')
    if (!/^(mailto:|https:\/\/)/.test(subject)) throw new Error('push set: bad VAPID subject')
    return {
      phone,
      host,
      subscription: { endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } },
      vapid: { privateJwk: { kty: 'EC', crv: 'P-256', d: j.d, x: j.x, y: j.y }, subject },
      done: r.done !== false,
    }
  })
  writeEntries([...readEntries().filter((e) => e.phone !== phone), ...mine])
  return mine.length
}

/** A phone that's forgotten gets no more notifications from here. */
export function forgetPushes(phone: string) {
  const all = readEntries()
  const kept = all.filter((e) => e.phone !== phone)
  if (kept.length !== all.length) writeEntries(kept)
}

export interface Notice {
  kind: 'waiting' | 'done' | 'test'
  pane: string
  title: string
  body: string
}

/** Sends a notice to every paired browser that wants it; returns how many push services took it. */
export async function deliver(n: Notice, o: { only?: string; send?: typeof sendPush } = {}) {
  const paired = listPhones()
  const all = readEntries()
  const gone = new Set<string>()
  let sent = 0
  await Promise.all(
    all
      .filter((e) => paired[e.phone] && (!o.only || e.subscription.endpoint === o.only) && (n.kind !== 'done' || e.done))
      .map(async (e) => {
        const machine = !n.pane
        const payload = {
          title: n.title,
          body: n.body,
          kind: n.kind,
          // the same tag and link as the open app, so one replaces the other (apps/web/src/lib/store.ts)
          tag: n.kind === 'test' ? 'test' : machine ? `machine:${e.host}` : `${e.host}:${n.pane}`,
          href: n.kind === 'test' ? '/settings#notifications' : `/m/${encodeURIComponent(e.host)}/p/${n.pane.replace(/^%/, '')}`,
        }
        try {
          const r = await (o.send ?? sendPush)(e.subscription, payload, e.vapid)
          if (r.ok) sent++
          else if (r.gone) gone.add(e.subscription.endpoint)
          else console.error(`push: ${new URL(e.subscription.endpoint).host} answered ${r.status}`)
        } catch (err) {
          console.error(`push: ${(err as Error).message}`)
        }
      }),
  )
  // unsubscribed or expired: the browser subscribes again and the app hands it over
  if (gone.size) writeEntries(readEntries().filter((e) => !gone.has(e.subscription.endpoint)))
  return sent
}

/**
 * What an agent's hook event means for a notification. Claude Code: PermissionRequest when it asks
 * to run something, Stop when it's done answering. Its Notification event only repeats those
 * (a permission prompt) or nags after a minute idle, so it's left out.
 */
export function noticeFor(line: string): { kind: 'waiting' | 'done'; pane: string; agent: string; body: string } | undefined {
  let ev: any
  try {
    ev = JSON.parse(line)
  } catch {
    return
  }
  const pane = String(ev?.pane ?? '')
  const d = ev?.data
  if (!/^%\d+$/.test(pane) || !d) return
  if (d.hook_event_name === 'PermissionRequest') return { kind: 'waiting', pane, agent: 'Claude', body: d.tool_name ? `Claude wants to use ${d.tool_name}` : 'Claude needs your input' }
  if (d.hook_event_name === 'Stop' && !d.stop_hook_active) {
    const said = typeof d.last_assistant_message === 'string' ? d.last_assistant_message.replace(/\s+/g, ' ').trim() : ''
    return { kind: 'done', pane, agent: 'Claude', body: said ? (said.length > 140 ? `${said.slice(0, 139)}…` : said) : 'Claude finished' }
  }
}

/** The pane's title as the app shows it (Claude's conversation title), else session:window. */
async function titleOf(pane: string) {
  try {
    const p = Bun.spawn(['tmux', 'display-message', '-p', '-t', pane, '#{pane_title}\t#{session_name}:#{window_index}'], { stdout: 'pipe', stderr: 'ignore' })
    const [title = '', where = ''] = (await new Response(p.stdout).text()).trim().split('\t')
    // the same clean-up as the app (registry.ts paneTitle): a leading spinner or mark goes
    const clean = title.replace(/^[^\w\s]\s+/u, '').trim()
    return clean && clean !== os.hostname() ? clean : where || pane
  } catch {
    return pane
  }
}

/**
 * Follows the hook log from its current end. It's checked once a second; the hook moves it aside
 * past 2 MB, which shows here as the file getting shorter.
 */
export function followEvents(onLine: (line: string) => void, events = eventsFile(), everyMs = 1000) {
  const size = () => {
    try {
      return statSync(events).size
    } catch {
      return 0
    }
  }
  let pos = size()
  let rest = ''
  const timer = setInterval(() => {
    const end = size()
    if (end < pos) (pos = 0), (rest = '')
    if (end === pos) return
    const fd = openSync(events, 'r')
    try {
      const buf = Buffer.alloc(Math.min(end - pos, 1 << 20))
      const n = readSync(fd, buf, 0, buf.length, pos)
      pos += n
      const lines = (rest + buf.subarray(0, n).toString('utf8')).split('\n')
      rest = lines.pop() ?? ''
      for (const l of lines) if (l.trim()) onLine(l)
    } finally {
      closeSync(fd)
    }
  }, everyMs)
  return () => clearInterval(timer)
}

/** The link service's part: notify paired browsers when an agent needs you or finishes. */
export function startPush() {
  // one notice per pane and kind every few seconds: a hook can fire twice for one prompt
  const recent = new Map<string, number>()
  return followEvents((line) => {
    const n = noticeFor(line)
    if (!n || !readEntries().length) return
    const key = `${n.pane} ${n.kind}`
    if (Date.now() - (recent.get(key) ?? 0) < 5000) return
    recent.set(key, Date.now())
    void titleOf(n.pane).then((title) => deliver({ kind: n.kind, pane: n.pane, title, body: n.body }))
  })
}

/** `inyon push set|test|list`: what the app runs here over the link, and a look for you. */
export async function pushCommand(args: string[]) {
  const [sub] = args
  if (sub === 'set') return console.log(setEntries(JSON.parse(await Bun.stdin.text())))
  if (sub === 'test') {
    const { endpoint } = JSON.parse(await Bun.stdin.text())
    return console.log(await deliver({ kind: 'test', pane: '', title: 'Inyon', body: `Notifications from ${os.hostname()} work, even with Inyon closed.` }, { only: String(endpoint) }))
  }
  if (sub === 'list' || !sub) {
    const phones = listPhones()
    const all = readEntries()
    if (!all.length) return console.log('No browser gets notifications from this machine yet.')
    for (const e of all) console.log(`${(phones[e.phone]?.name ?? 'forgotten phone').padEnd(24)} ${new URL(e.subscription.endpoint).host}${e.done ? '' : ' (needs-you only)'}`)
    return
  }
  console.error('usage: inyon push [list|set|test]')
  process.exit(2)
}
