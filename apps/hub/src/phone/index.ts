import { ed25519 } from '@noble/curves/ed25519.js'
import type { HostConfig } from '@inyon/protocol'
import { kv, useStore } from '../platform/store.ts'
import { setHostBackends } from '../hosts/host.ts'
import { setLocalHost } from '../config.ts'
import { splitTarget, sshBackend, toBase64, fromBase64, type Credentials } from './ssh-backend.ts'
import type { Handler, Method, Routes } from '../core.ts'
import type { PhoneRuntime, StartPhone, SshPlugin } from './types.ts'
import { identityFromSeed, parsePairLink, parseShortCode, resolveShortCode } from '@inyon/link'
import { nodeBackend } from '../hosts/node-backend.ts'
import { viaBackend } from '../hosts/via-backend.ts'
import { linkConnector, type PendingUnpair } from './link.ts'

/**
 * The phone app runs Inyon's core itself and SSHes straight into your servers: no hub, no
 * password. The web app hands it a store and the native SSH plugin and calls it in-process.
 */
export const startPhone: StartPhone = async ({ store, ssh, name }) => {
  // records some modules read as they load, so the store goes in before the core is imported
  useStore(store)
  setLocalHost(undefined)
  const keys = phoneKeys(ssh)
  const conn = sshBackend(ssh, (config) => keys.credentials(config))
  // laptops paired with `inyon pair` take the same commands a hub sends to inyon, and
  // a server reached through one of them goes as `ssh` commands run there
  let lookup = (_id: string): HostConfig | undefined => undefined
  const via = viaBackend((id) => lookup(id))
  setHostBackends((config) => (config.kind === 'link' ? nodeBackend : config.via ? via : conn.backend))

  const core = await import('../core.ts')
  const { registry, HttpError } = await import('../hosts/registry.ts')
  const { watchers } = await import('../claude/watcher.ts')
  const { saveDraftsAtOnce } = await import('../claude/drafts.ts')
  lookup = (id) => registry.get(id)?.host.config
  const { api, body, json, ok, newHostId, clients, newClient, clientMessage, closeClient, coreRoutes, saveEverything, startCore } = core

  const links = linkConnector(keys.noise, name || phoneName(), (id, urls, relays) => registry.note(id, { urls, relays }), {
    // computers removed while out of reach, told to forget the phone once they answer
    pending: { load: () => kv.get<PendingUnpair[]>('pending-unpairs') ?? [], save: (list) => (list.length ? kv.set('pending-unpairs', list) : kv.del('pending-unpairs')) },
  })
  const ensureLinks = () => {
    for (const c of registry.configs()) if (c.kind === 'link') links.ensure(c)
  }
  registry.on((e) => e.type === 'overview' && ensureLinks())

  /** Server fields from the add/edit form; the secret goes to the keystore, the rest to the list. */
  const serverForm = (b: any, cur?: HostConfig) => {
    const name = String(b.name ?? cur?.name ?? '').trim()
    const target = String(b.target ?? cur?.target ?? '').trim()
    if (!name) throw new HttpError(400, 'Give the server a name')
    const port = b.port ? Number(b.port) : cur?.port
    if (port !== undefined && !(port > 0 && port < 65536)) throw new HttpError(400, 'Port must be 1-65535')
    // through a paired computer: its ssh signs in and checks the server's key, and an alias from
    // its ~/.ssh/config is a fine address
    const via = String(b.via ?? cur?.via ?? '')
    if (via) {
      const computer = registry.get(via)?.host.config
      if (computer?.kind !== 'link') throw new HttpError(400, 'Pick a paired computer to connect from')
      if (!/^[\w.@:-]+$/.test(target) || target.startsWith('-')) throw new HttpError(400, 'Use user@host, or a name from that computer\'s ~/.ssh/config')
      return { name, kind: 'ssh' as const, target, port, via, hostKey: undefined, auth: undefined }
    }
    const { username, host } = splitTarget(target)
    if (!username || !/^[\w.-]+$/.test(username)) throw new HttpError(400, 'Use user@host, like me@100.64.0.5')
    if (!/^[\w.:-]+$/.test(host) || host.startsWith('-')) throw new HttpError(400, 'The address has unexpected characters')
    const hostKey = String(b.hostKey ?? cur?.hostKey ?? '')
    if (!hostKey.startsWith('SHA256:')) throw new HttpError(400, "Check the server's fingerprint first")
    const auth = (b.auth ?? cur?.auth ?? 'phone-key') as NonNullable<HostConfig['auth']>
    if (!['phone-key', 'password', 'key', 'none'].includes(auth)) throw new HttpError(400, 'Unknown sign-in method')
    return { name, kind: 'ssh' as const, target, port, hostKey, auth, via: undefined }
  }

  const needsSecret = (auth: HostConfig['auth']) => auth === 'password' || auth === 'key'

  /** The password or pasted key, when the form brought one (an edit may keep the old one). */
  const secretFrom = (b: any, auth: HostConfig['auth']): Credentials | undefined => {
    if (auth === 'password' && b.password) return { password: String(b.password) }
    if (auth === 'key' && b.privateKey) return { privateKey: String(b.privateKey), passphrase: b.passphrase ? String(b.passphrase) : undefined }
    return undefined
  }

  const phoneRoutes: Routes = {
    // nothing to sign in to: the phone is the hub
    '/api/session': () => json({ authed: true, phone: true }),
    '/api/logout': () => ok(),
    '/api/phone/key': { GET: api(async () => json({ publicKey: await keys.publicLine() })) },
    '/api/phone/probe': {
      POST: api(async (req) => {
        const b = await body(req)
        const { host } = splitTarget(String(b.target ?? '').trim())
        if (!host) throw new HttpError(400, 'Enter the server address')
        try {
          return json(await ssh.probe({ host, port: Number(b.port) || 22 }))
        } catch (err) {
          throw new HttpError(502, `Can't reach ${host}: ${(err as Error).message}`)
        }
      }),
    },
    '/api/hosts': {
      POST: api(async (req) => {
        const b = await body(req)
        const cfg = serverForm(b)
        const secret = secretFrom(b, cfg.auth)
        if (needsSecret(cfg.auth) && !secret) throw new HttpError(400, cfg.auth === 'password' ? 'Enter the password' : 'Paste the private key')
        const id = newHostId(cfg.name)
        if (secret) await keys.save(id, secret)
        registry.add({ ...cfg, id })
        return json({ id })
      }),
    },
    '/api/phone/pair': {
      POST: api(async (req) => {
        const b = await body(req)
        const text = String(b.link ?? '')
        const short = parseShortCode(text)
        // a typed ID and code: the relays say which machine the two together stand for
        const info = short ? await resolveShortCode(short).catch(() => undefined) : parsePairLink(text)
        if (short && !info) throw new HttpError(404, "That ID and code don't match a computer right now. Check both against the terminal, or run `inyon pair` again for new ones (each lasts 10 minutes).")
        if (!info) throw new HttpError(400, "That isn't an Inyon pairing code. Run `inyon pair` on the computer and scan the code it shows.")
        let welcome
        try {
          welcome = await links.pair(info)
        } catch (err) {
          throw new HttpError(502, (err as Error).message)
        }
        const same = registry.configs().find((c) => c.kind === 'link' && c.machineId === info.id)
        const addresses = { urls: welcome.urls ?? info.urls, relays: welcome.relays ?? info.relays }
        if (same) {
          registry.note(same.id, addresses)
          links.resume()
          return json({ id: same.id, machineId: info.id })
        }
        const name = String(b.name ?? '').trim() || welcome.hostname || info.name || 'Laptop'
        const id = newHostId(name)
        registry.add({ id, name, kind: 'link', machineId: info.id, ...addresses })
        // the machine's id, for the app to show after a typed code: anyone who saw the code could
        // have published their own computer under it
        return json({ id, machineId: info.id })
      }),
    },
    '/api/hosts/:id': {
      PATCH: api(async (req) => {
        const id = req.params.id
        const cur = registry.get(id)?.host.config
        if (!cur) throw new HttpError(404, 'Unknown server')
        const b = await body(req)
        if (cur.kind === 'link') {
          const name = String(b.name ?? '').trim()
          if (!name) throw new HttpError(400, 'Give the computer a name')
          registry.note(id, { name })
          registry.refresh(id, 0)
          return ok()
        }
        const cfg = serverForm(b, cur)
        const secret = secretFrom(b, cfg.auth)
        if (needsSecret(cfg.auth) && (cfg.auth !== cur.auth || cur.via) && !secret) throw new HttpError(400, cfg.auth === 'password' ? 'Enter the password' : 'Paste the private key')
        if (secret) await keys.save(id, secret)
        if (!needsSecret(cfg.auth)) await keys.drop(id)
        await conn.forget(id)
        registry.update(id, cfg)
        return ok()
      }),
      DELETE: api(async (req) => {
        const id = req.params.id
        const rt = registry.get(id)
        // while it still answers: Inyon's hooks and uploads come off it, and so does the phone's key
        if (rt) {
          const { dropAuthorizedKey, tidyMachine } = await import('../hosts/tidy.ts')
          await tidyMachine(rt.host, rt.state, rt.host.config.auth === 'phone-key' ? dropAuthorizedKey(await keys.publicLine()) : '')
        }
        const told = rt?.host.config.kind === 'link' ? links.forget(id, rt.host.config) : (links.forget(id), true)
        await conn.forget(id)
        await keys.drop(id)
        registry.remove(id)
        // it was handed this browser's push signing key and subscription, and may keep them: the
        // page makes new ones and hands them to the computers left (apps/web/src/lib/push.ts)
        const { registrations } = await import('../push/registrations.ts')
        if (registrations().length) (globalThis as { dispatchEvent?: (e: Event) => boolean }).dispatchEvent?.(new Event('inyon:push-rotate'))
        // a computer out of reach still trusts the phone until it hears; the app says so
        return json({ ok: true, ...(told ? {} : { untold: rt?.host.config.name }) })
      }),
    },
  }

  // notifications while the page is closed come from the computers (push/node-push.ts)
  const { startNodePush, pushTest } = await import('../push/node-push.ts')
  const { pushRoutes } = await import('../push/routes.ts')
  const router = makeRouter([phoneRoutes, pushRoutes(pushTest, { only: true }), coreRoutes])
  startCore()
  ensureLinks()
  startNodePush(async () => (await keys.noise()).publicKey)
  // laptops paired with the phone update from the website's copy of the newest release; its
  // latest.json answers the WebView (CORS)
  const { nodeUpdates } = await import('../hosts/node-update.ts')
  nodeUpdates.watchReleases()

  return {
    async fetch(req) {
      const { handler, params } = router(new URL(req.url).pathname, req.method as Method)
      if (!handler) return json({ error: 'Not found' }, { status: 404 })
      return handler(Object.assign(req, { params }))
    },
    background(hidden) {
      registry.quiet(hidden)
      watchers.quiet(hidden)
      registry.holdAlerts(hidden)
      // Android may close the app from the background: keep what each open chat has read, drafts
      // and how each machine looked
      saveDraftsAtOnce(hidden)
      if (hidden) saveEverything()
    },
    resume() {
      registry.quiet(false)
      watchers.quiet(false)
      registry.holdAlerts(false)
      links.resume()
      // SSH connections that died in the background fail their next command; probe now, not at the next poll
      for (const c of registry.configs()) registry.refresh(c.id, 0)
    },
    connect(send) {
      const c = newClient(send)
      clients.add(c)
      return { message: (raw) => clientMessage(c, raw), close: () => closeClient(c) }
    },
  } satisfies PhoneRuntime
}

/** Matches "/api/hosts/:id/panes/:pane/send"-style routes; the first table that has a path wins. */
function makeRouter(tables: Routes[]) {
  const compiled = tables.flatMap((t) =>
    Object.entries(t).map(([path, entry]) => {
      const names: string[] = []
      const re = new RegExp(`^${path.replace(/:(\w+)/g, (_, n) => (names.push(n), '([^/]+)'))}$`)
      return { re, names, entry }
    }),
  )
  return (pathname: string, method: Method): { handler?: Handler; params: Record<string, string> } => {
    let allowed = false
    for (const { re, names, entry } of compiled) {
      const m = re.exec(pathname)
      if (!m) continue
      const handler = typeof entry === 'function' ? entry : entry[method]
      if (!handler) {
        // another table may answer this method for the same path (the phone overrides only some)
        allowed = true
        continue
      }
      const params: Record<string, string> = {}
      names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1]!)))
      return { handler, params }
    }
    return { handler: allowed ? () => Response.json({ error: 'Method not allowed' }, { status: 405 }) : undefined, params: {} }
  }
}

/**
 * The phone's own SSH key (made on first use, one for every server, so you add one line to
 * authorized_keys) and each server's password or pasted key, all in the Android keystore.
 */
/**
 * What a laptop lists this phone as when the app didn't name it: its model when the WebView says
 * it, without the build ("A142", not "A142 Build/BP2A.250605.031").
 */
function phoneName() {
  const model = /Android [\d.]+; ([^;)]+)/.exec(globalThis.navigator?.userAgent ?? '')?.[1]?.replace(/\s+Build\/.*$/, '').trim()
  return model && model !== 'K' && !/^wv$/.test(model) ? model : 'Phone'
}

function phoneKeys(ssh: SshPlugin) {
  const KEY = 'phone-key'
  let mine: Promise<{ seed: Uint8Array; pub: Uint8Array }> | undefined

  const own = () =>
    (mine ??= (async () => {
      const saved = (await ssh.getSecret({ key: KEY })).value
      if (saved) {
        const { seed, pub } = JSON.parse(saved)
        return { seed: fromBase64(seed), pub: fromBase64(pub) }
      }
      const { secretKey, publicKey } = ed25519.keygen()
      await ssh.setSecret({ key: KEY, value: JSON.stringify({ seed: toBase64(secretKey), pub: toBase64(publicKey) }) })
      return { seed: secretKey, pub: publicKey }
    })().catch((err) => {
      mine = undefined
      throw err
    }))

  return {
    /** The OpenSSH public key line for authorized_keys. */
    async publicLine() {
      const { pub } = await own()
      // the wire format: string "ssh-ed25519", then string <32-byte key>, each length-prefixed
      const type = new TextEncoder().encode('ssh-ed25519')
      const blob = new Uint8Array(4 + type.length + 4 + pub.length)
      const view = new DataView(blob.buffer)
      view.setUint32(0, type.length)
      blob.set(type, 4)
      view.setUint32(4 + type.length, pub.length)
      blob.set(pub, 8 + type.length)
      return `ssh-ed25519 ${toBase64(blob)} inyon-phone`
    },
    async credentials(config: HostConfig): Promise<Credentials> {
      // nothing to sign in with: the server's "none" sign-in is tried first anyway, and an empty
      // password covers an account that has none
      if (config.auth === 'none') return { password: '' }
      if ((config.auth ?? 'phone-key') === 'phone-key') {
        const { seed, pub } = await own()
        return { ed25519Seed: toBase64(seed), ed25519Public: toBase64(pub) }
      }
      const saved = (await ssh.getSecret({ key: `server:${config.id}` })).value
      if (!saved) throw new Error('The sign-in for this server is missing. Edit it and enter it again.')
      return JSON.parse(saved)
    },
    /** The same key, in the form the encrypted link to a laptop uses. */
    async noise() {
      return identityFromSeed((await own()).seed).noise
    },
    save: (id: string, c: Credentials) => ssh.setSecret({ key: `server:${id}`, value: JSON.stringify(c) }),
    drop: (id: string) => ssh.deleteSecret({ key: `server:${id}` }).catch(() => {}),
  }
}
