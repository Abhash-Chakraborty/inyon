import { noticeSinks } from '../core.ts'
import { payloadFor, registrations, removeRegistration, type PushPayload, type Registration } from './registrations.ts'
import { sendPush, type Sent } from './webpush.ts'

/**
 * A hub is always on, so it sends the browsers' push notifications itself: every notice the open
 * app would show, including a machine going offline, reaches a closed tab or installed app too.
 */

/** Sends one notice to every browser that wants it; drops the ones their push service says are gone. */
export async function pushAll(p: PushPayload, send: (r: Registration, p: PushPayload) => Promise<Sent> = (r, p) => sendPush(r.subscription, p, r.vapid), only?: string) {
  let delivered = 0
  await Promise.all(
    registrations()
      .filter((r) => (p.kind !== 'done' || r.done) && (!only || r.subscription.endpoint === only))
      .map(async (r) => {
        try {
          const res = await send(r, p)
          if (res.ok) delivered++
          else if (res.gone) removeRegistration(r.subscription.endpoint)
          else console.error(`push: ${new URL(r.subscription.endpoint).host} answered ${res.status}`)
        } catch (err) {
          console.error(`push: ${(err as Error).message}`)
        }
      }),
  )
  return delivered
}

export function startHubPush() {
  noticeSinks.add((n) => void pushAll(payloadFor(n)))
}
