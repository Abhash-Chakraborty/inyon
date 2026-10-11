import { ed25519 } from '@noble/curves/ed25519.js'
import type { HostConfig } from '@tether/protocol'
import { useStore } from '../platform/store.ts'
import { setHostBackends } from '../hosts/host.ts'
import { setLocalHost } from '../config.ts'
import { splitTarget, sshBackend, toBase64, fromBase64, type Credentials } from './ssh-backend.ts'
import type { Handler, Method, Routes } from '../core.ts'
import type { PhoneRuntime, StartPhone, SshPlugin } from './types.ts'
import { identityFromSeed, parsePairLink, parseShortCode, resolveShortCode } from '@tether/link'
import { nodeBackend } from '../hosts/node-backend.ts'
import { linkConnector } from './link.ts'

/**
 * The phone app runs Tether's core itself and SSHes straight into your servers: no hub, no
 * password. The web app hands it a store and the native SSH plugin and calls it in-process.
 */
export const startPhone: StartPhone = async ({ store, ssh }) => {
  // records some modules read as they load, so the store goes in before the core is imported
  useStore(store)
  setLocalHost(undefined)
  const keys = phoneKeys(ssh)
  const conn = sshBackend(ssh, (config) => keys.credentials(config))
  // laptops paired with `tether-node pair` take the same commands a hub sends to tether-node
  setHostBackends((config) => (config.kind === 'link' ? nodeBackend : conn.backend))

  const core = await import('../core.ts')
  const { registry, HttpError } = await import('../hosts/registry.ts')
  const { api, body, json, ok, newHostId, clients, newClient, clientMessage, closeClient, coreRoutes, startCore } = core

  const links = linkConnector(keys.noise, phoneName(), (id, urls, relays) => registry.note(id, { urls, relays }))
  const ensureLinks = () => {
    for (const c of registry.configs()) if (c.kind === 'link') links.ensure(c)
  }
  registry.on((e) => e.type === 'overview' && ensureLinks())

  /** Server fields from the add/edit form; the secret goes to the keystore, the rest to the list. */
  const serverForm = (b: any, cur?: HostConfig) => {
    const name = String(b.name ?? cur?.name ?? '').trim()
    const target = String(b.target ?? cur?.target ?? '').trim()
    if (!name) throw new HttpError(400, 'Give the server a name')
    const { username, host } = splitTarget(target)
    if (!username || !/^[\w.-]+$/.test(username)) throw new HttpError(400, 'Use user@host, like me@100.64.0.5')
    if (!/^[\w.:-]+$/.test(host) || host.startsWith('-')) throw new HttpError(400, 'The address has unexpected characters')
    const port = b.port ? Number(b.port) : cur?.port
    if (port !== undefined && !(port > 0 && port < 65536)) throw new HttpError(400, 'Port must be 1-65535')
    const hostKey = String(b.hostKey ?? cur?.hostKey ?? '')
    if (!hostKey.startsWith('SHA256:')) throw new HttpError(400, "Check the server's fingerprint first")
    const auth = (b.auth ?? cur?.auth ?? 'phone-key') as NonNullable<HostConfig['auth']>
    if (!['phone-key', 'password', 'key'].includes(auth)) throw new HttpError(400, 'Unknown sign-in method')
    return { name, kind: 'ssh' as const, target, port, hostKey, auth }
  }

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
        if (cfg.auth !== 'phone-key' && !secret) throw new HttpError(400, cfg.auth === 'password' ? 'Enter the password' : 'Paste the private key')
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
        // a typed ID and code: the relays say which machine the ID stands for
        const info = short ? await resolveShortCode(short).catch(() => undefined) : parsePairLink(text)
        if (short && !info) throw new HttpError(404, 'No computer has that ID right now. Check it, or run `tether-node pair` again for a new one (each lasts 10 minutes).')
        if (!info) throw new HttpError(400, "That isn't a Tether pairing code. Run `tether-node pair` on the computer and scan the code it shows.")
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
          return json({ id: same.id })
        }
        const name = String(b.name ?? '').trim() || welcome.hostname || info.name || 'Laptop'
        const id = newHostId(name)
        registry.add({ id, name, kind: 'link', machineId: info.id, ...addresses })
        return json({ id })
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
        if (cfg.auth !== 'phone-key' && cfg.auth !== cur.auth && !secret) throw new HttpError(400, cfg.auth === 'password' ? 'Enter the password' : 'Paste the private key')
        if (secret) await keys.save(id, secret)
        if (cfg.auth === 'phone-key') await keys.drop(id)
        await conn.forget(id)
        registry.update(id, cfg)
        return ok()
      }),
      DELETE: api(async (req) => {
        const id = req.params.id
        links.forget(id)
        await conn.forget(id)
        await keys.drop(id)
        registry.remove(id)
        return ok()
      }),
    },
  }

  const router = makeRouter([phoneRoutes, coreRoutes])
  startCore()
  ensureLinks()

  return {
    async fetch(req) {
      const { handler, params } = router(new URL(req.url).pathname, req.method as Method)
      if (!handler) return json({ error: 'Not found' }, { status: 404 })
      return handler(Object.assign(req, { params }))
    },
    background(hidden) {
      registry.quiet(hidden)
      registry.holdAlerts(hidden)
    },
    resume() {
      registry.quiet(false)
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
/** What a laptop lists this phone as: its model when the WebView says it. */
function phoneName() {
  const model = /Android [\d.]+; ([^;)]+)/.exec(globalThis.navigator?.userAgent ?? '')?.[1]?.trim()
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
      return `ssh-ed25519 ${toBase64(blob)} tether-phone`
    },
    async credentials(config: HostConfig): Promise<Credentials> {
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
