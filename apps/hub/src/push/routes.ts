import { api, body, json, ok, type Routes } from '../core.ts'
import { HttpError } from '../hosts/registry.ts'
import { addRegistration, registrations, removeRegistration, validRegistration } from './registrations.ts'

/**
 * The browser's side: POST its registration when notifications are allowed (and again when the
 * "finished" setting changes), DELETE it when they're turned off, and ask for a test that goes the
 * whole way through its push service. `test` sends one to that endpoint and says how many went out.
 * In the web app every registration is this one browser's, so a new one replaces the last (`only`).
 */
export function pushRoutes(test: (endpoint: string) => Promise<number>, o: { only?: boolean } = {}): Routes {
  return {
    '/api/push': {
      POST: api(async (req) => {
        const r = validRegistration(await body(req, 16 * 1024))
        if (o.only) for (const old of registrations()) if (old.subscription.endpoint !== r.subscription.endpoint) removeRegistration(old.subscription.endpoint)
        addRegistration(r)
        return ok()
      }),
      DELETE: api(async (req) => {
        const { endpoint } = await body<{ endpoint?: string }>(req, 16 * 1024)
        if (typeof endpoint !== 'string') throw new HttpError(400, 'Which endpoint?')
        removeRegistration(endpoint)
        return ok()
      }),
    },
    '/api/push/test': {
      POST: api(async (req) => {
        const { endpoint } = await body<{ endpoint?: string }>(req, 16 * 1024)
        if (typeof endpoint !== 'string') throw new HttpError(400, 'Which endpoint?')
        return json({ sent: await test(endpoint) })
      }),
    },
  }
}

export const TEST_PAYLOAD = { title: 'Inyon', body: 'Notifications work, even with Inyon closed.', tag: 'test', href: '/settings#notifications', kind: 'test' as const }
