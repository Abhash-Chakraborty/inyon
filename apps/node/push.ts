import os from 'node:os'
import path from 'node:path'
import { closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { sendPush, type PushSubscriptionJSON, type Vapid } from '../hub/src/push/webpush.ts'
import { backgroundOnScreen } from '../hub/src/claude/screen.ts'
import { listPhones } from './link.ts'
import { emit } from './output.ts'
import { home, nodeDir } from './paths.ts'

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
export const eventsFile = () => path.join(home(), '.inyon', 'events.jsonl')

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
          href: n.kind === 'test' ? '/settings#notifications' : machine ? `/machines/${encodeURIComponent(e.host)}` : `/m/${encodeURIComponent(e.host)}/p/${n.pane.replace(/^%/, '')}`,
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
 * past 2 MB (see the hub's claude/integration.ts), which shows here as a new file (another inode,
 * or none for a moment), read from its top.
 */
export function followEvents(onLine: (line: string) => void, events = eventsFile(), everyMs = 1000) {
  const stat = () => {
    try {
      const s = statSync(events)
      return { size: s.size, ino: s.ino }
    } catch {
      return { size: 0, ino: 0 }
    }
  }
  let { size: pos, ino } = stat()
  let rest = ''
  const timer = setInterval(() => {
    const now = stat()
    if (now.ino !== ino || now.size < pos) (pos = 0), (rest = ''), (ino = now.ino)
    if (now.size === pos) return
    let fd: number | undefined
    try {
      fd = openSync(events, 'r')
      const buf = Buffer.alloc(Math.min(now.size - pos, 1 << 20))
      const n = readSync(fd, buf, 0, buf.length, pos)
      pos += n
      const lines = (rest + buf.subarray(0, n).toString('utf8')).split('\n')
      rest = lines.pop() ?? ''
      for (const l of lines) if (l.trim()) onLine(l)
    } catch {
      // moved aside or busy between the look and the read: the next tick starts over
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }, everyMs)
  return () => clearInterval(timer)
}

type HookNotice = NonNullable<ReturnType<typeof noticeFor>>

/** What the pane's footer lists as still running ("1 shell, 1 agent"), read the way the hub reads it. */
async function backgroundOf(pane: string): Promise<string | null | undefined> {
  try {
    const p = Bun.spawn(['tmux', 'capture-pane', '-p', '-t', pane], { stdout: 'pipe', stderr: 'ignore' })
    const text = await new Response(p.stdout).text()
    if ((await p.exited) !== 0) return undefined
    return backgroundOnScreen(text.split('\n'))
  } catch {
    return undefined
  }
}

/**
 * The link service's part: notify paired browsers when an agent needs you or finishes. A turn
 * that ends with agents or shells still running isn't finished: Claude's Stop fires all the
 * same, so the finish waits until the pane's footer lists nothing (checked every few seconds,
 * for half an hour at most).
 */
export function startPush(o: { events?: string; everyMs?: number; checkMs?: number; background?: (pane: string) => Promise<string | null | undefined>; send?: typeof sendPush } = {}) {
  // one notice per pane and kind every few seconds: a hook can fire twice for one prompt
  const recent = new Map<string, number>()
  // the finish on hold per pane; a newer event for the pane takes over
  const held = new Map<string, object>()
  const background = o.background ?? backgroundOf
  const checkMs = o.checkMs ?? 5000
  const send = (n: HookNotice) => void titleOf(n.pane).then((title) => deliver({ kind: n.kind, pane: n.pane, title, body: n.body }, { send: o.send }))
  const finish = async (n: HookNotice) => {
    const token = {}
    held.set(n.pane, token)
    const startedAt = Date.now()
    while (await background(n.pane)) {
      if (Date.now() - startedAt > 30 * 60_000) break
      await new Promise((r) => setTimeout(r, checkMs))
      if (held.get(n.pane) !== token) return
    }
    if (held.get(n.pane) !== token) return
    held.delete(n.pane)
    send(n)
  }
  return followEvents((line) => {
    const n = noticeFor(line)
    if (!n || !readEntries().length) return
    const key = `${n.pane} ${n.kind}`
    if (Date.now() - (recent.get(key) ?? 0) < 5000) return
    recent.set(key, Date.now())
    // a question while a finish waits: the turn went on, so that finish is no longer news
    held.delete(n.pane)
    if (n.kind === 'done') void finish(n)
    else send(n)
  }, o.events, o.everyMs)
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
    const browsers = all.map((e) => ({ phone: e.phone, name: phones[e.phone]?.name, host: e.host, endpoint: new URL(e.subscription.endpoint).host, done: e.done }))
    if (!all.length) return emit({ browsers }, 'No browser gets notifications from this machine yet.')
    return emit({ browsers }, browsers.map((b) => `${(b.name ?? 'forgotten phone').padEnd(24)} ${b.endpoint}${b.done ? '' : ' (needs-you only)'}`).join('\n'))
  }
  console.error('usage: inyon push [list|set|test]')
  process.exit(2)
}
