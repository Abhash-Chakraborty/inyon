import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import type { HostConfig } from '@tether/protocol'

export const DATA_DIR = process.env.TETHER_DATA_DIR || path.join(os.homedir(), '.tether')
export const PORT = Number(process.env.PORT || 4777)
export const BIND = process.env.BIND || '127.0.0.1'
/**
 * Serve HTTPS directly (paths to a PEM certificate and key). Browsers only treat the app as
 * installable, and allow clipboard images and notifications, on HTTPS.
 */
export const TLS = process.env.TLS_CERT && process.env.TLS_KEY ? { cert: process.env.TLS_CERT, key: process.env.TLS_KEY } : undefined

const HUB_FILE = path.join(DATA_DIR, 'hub.json')
const HOSTS_FILE = path.join(DATA_DIR, 'hosts.json')

fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 })
fs.mkdirSync(path.join(DATA_DIR, 'cm'), { recursive: true, mode: 0o700 })

interface HubFile {
  secret: string
  passwordHash?: string
  salt?: string
}

function writeJson(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(tmp, file)
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

let hub = readJson<HubFile>(HUB_FILE, { secret: '' })
if (!hub.secret) {
  hub.secret = crypto.randomBytes(32).toString('hex')
  writeJson(HUB_FILE, hub)
}

export const sessionSecret = () => hub.secret

export function hashPassword(password: string, salt: string) {
  return crypto.scryptSync(password, salt, 64).toString('hex')
}

export function setPassword(password: string) {
  const salt = crypto.randomBytes(16).toString('hex')
  // rotating the secret signs everyone out
  hub = { secret: crypto.randomBytes(32).toString('hex'), salt, passwordHash: hashPassword(password, salt) }
  writeJson(HUB_FILE, hub)
}

export function hasPassword() {
  return !!hub.passwordHash
}

/** Async so a burst of guesses doesn't block the hub while scrypt runs. */
export async function checkPassword(password: string) {
  if (!hub.passwordHash || !hub.salt) return false
  const hash = await new Promise<Buffer>((ok, fail) => crypto.scrypt(password, hub.salt!, 64, (e, k) => (e ? fail(e) : ok(k))))
  const a = hash
  const b = Buffer.from(hub.passwordHash, 'hex')
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/** A password you can type on a phone, and long enough not to guess. */
export const passwordProblem = (pw: string) =>
  pw.length < 8 ? 'Use at least 8 characters.' : pw.length > 1024 ? 'That password is too long.' : undefined

// ---------- hosts ----------

const LOCAL: HostConfig = { id: 'local', name: os.hostname(), kind: 'local' }

export function loadHosts(): HostConfig[] {
  const hosts = readJson<HostConfig[]>(HOSTS_FILE, [])
  if (!hosts.some((h) => h.id === 'local')) hosts.unshift(LOCAL)
  return hosts
}

export function saveHosts(hosts: HostConfig[]) {
  writeJson(HOSTS_FILE, hosts)
}

// ---------- hub settings ----------

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json')

export interface HubSettings {
  uploads: { retentionDays: number; maxMB: number; longPasteLines: number }
  /** machines where Tether keeps a tmux session running */
  keepSession?: Record<string, boolean>
  /** resume idle Claude sessions that stopped reporting live numbers (off unless turned on) */
  autoResume?: boolean
}

const DEFAULT_SETTINGS: HubSettings = { uploads: { retentionDays: 7, maxMB: 100, longPasteLines: 40 } }

export function loadSettings(): HubSettings {
  const s = readJson<Partial<HubSettings>>(SETTINGS_FILE, {})
  return { ...DEFAULT_SETTINGS, ...s, uploads: { ...DEFAULT_SETTINGS.uploads, ...(s.uploads ?? {}) } }
}

export function saveSettings(s: HubSettings) {
  writeJson(SETTINGS_FILE, s)
}
