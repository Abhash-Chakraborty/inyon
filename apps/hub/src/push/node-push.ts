import { bytesToHex } from '@noble/hashes/utils.js'
import { newerRelease } from '@inyon/protocol'
import { registry } from '../hosts/registry.ts'
import { sha256Hex } from '../platform/store.ts'
import { onRegistrations, registrations, type Registration } from './registrations.ts'

/**
 * The web app has no server to send its notifications, so each paired computer sends them: the
 * page hands every computer this browser's push registration (`inyon push set`), and the computer
 * sends when an agent's hook says it needs you or finished. The computer keys them by this
 * phone's link key, the one it paired with, so `inyon forget` takes them away too.
 */

/** `inyon push set`, with what to keep on stdin. */
export const PUSH_SET = '"$INYON_EXE" ${INYON_SCRIPT:+"$INYON_SCRIPT"} push set'
/** `inyon push test`: sends a test to the endpoint on stdin, prints how many went out. */
export const PUSH_TEST = '"$INYON_EXE" ${INYON_SCRIPT:+"$INYON_SCRIPT"} push test'
/** The first inyon with them; an older one is left alone until it's updated. */
export const FIRST_PUSH = '0.10.0'

/** What a computer keeps for this phone: its id there for each registration, and the registrations. */
export const pushSetInput = (phone: string, host: string, regs: Registration[]) =>
  JSON.stringify({ phone, host, registrations: regs.map(({ subscription, vapid, done }) => ({ subscription, vapid, done })) })

export function startNodePush(phoneKey: () => Promise<Uint8Array>) {
  // what each computer was last given, so a reconnect doesn't send it again
  const given = new Map<string, string>()
  // computers it failed on, by when: try again a while later
  const failedAt = new Map<string, number>()
  let running = false
  let again = false

  const sync = async () => {
    if (running) return void (again = true)
    running = true
    try {
      const phone = bytesToHex(await phoneKey())
      const regs = registrations()
      for (const h of registry.overview()) {
        const id = h.config.id
        if (!canPush(h)) continue
        if (Date.now() - (failedAt.get(id) ?? 0) < 5 * 60_000) continue
        const input = pushSetInput(phone, id, regs)
        const sig = sha256Hex(input)
        if (given.get(id) === sig) continue
        // a computer that was never given any has nothing to forget
        if (!regs.length && !given.has(id)) continue
        const host = registry.get(id)?.host
        if (!host) continue
        const r = await host.exec(PUSH_SET, { input, timeoutMs: 15_000 }).catch((err) => ({ code: -1, stdout: '', stderr: String(err?.message ?? err) }))
        if (r.code === 0) {
          given.set(id, sig)
          failedAt.delete(id)
        } else {
          failedAt.set(id, Date.now())
          console.error(`push: ${id}: ${(r.stderr || r.stdout).trim().slice(0, 200)}`)
        }
      }
    } finally {
      running = false
      if (again) {
        again = false
        void sync()
      }
    }
  }

  registry.on((e) => e.type === 'overview' && void sync())
  onRegistrations(() => void sync())
  void sync()
}

const canPush = (h: { config: { kind: string }; status: string; nodeVersion?: string }) =>
  h.config.kind === 'link' && h.status === 'online' && !!h.nodeVersion && !newerRelease(FIRST_PUSH, h.nodeVersion)

/** A test from every computer that can send one; they share a tag, so it shows once. */
export async function pushTest(endpoint: string) {
  const sent = await Promise.all(
    registry.overview().filter(canPush).map(async (h) => {
      const r = await registry.get(h.config.id)?.host.exec(PUSH_TEST, { input: JSON.stringify({ endpoint }), timeoutMs: 20_000 }).catch(() => undefined)
      return r?.code === 0 ? Number(r.stdout.trim()) || 0 : 0
    }),
  )
  return sent.reduce((a, b) => a + b, 0)
}
