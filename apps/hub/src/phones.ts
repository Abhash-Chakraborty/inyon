import crypto from 'node:crypto'
import os from 'node:os'
import { newShortCode, parseShortCode } from '@inyon/link'
import { VERSION, type PairedPhone, type PhoneClaim, type PhoneClaimResult, type PhonePairCode } from '@inyon/protocol'
import { HttpError } from './hosts/registry.ts'
import { kv } from './platform/store.ts'

/**
 * Phones paired with this hub. The hub's web app, signed in, shows a one-time code (a QR, or an ID
 * and six digits to type); the phone claims it and gets a token it sends as a bearer from then on,
 * since a browser cookie never leaves the browser. Codes and tickets live in memory, so a restart
 * drops them; paired phones are kept in the records, with only the hash of each token.
 */

/** how long a code stays claimable */
export const CODE_TTL = 10 * 60_000
/** how long a WebSocket ticket stays usable */
export const TICKET_TTL = 30_000
/** wrong digits before a code is dropped: six digits give a guess 5 in a million */
const WRONG_TRIES = 5
/** failed claims one address gets a minute, as with the setup code */
const CLAIMS_PER_MINUTE = 8
/** how often a phone's lastSeen is written */
const SEEN_EVERY = 60_000

interface PhoneRecord {
  id: string
  name: string
  /** sha256 of the token, hex */
  tokenHash: string
  pairedAt: number
  lastSeen: number
}

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex')
const same = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b))

/** The hub as the app names it; INYON_HUB_NAME for a name of your own. */
export const hubName = () => process.env.INYON_HUB_NAME || os.hostname()

/** A stable id for this hub, made once, so the app tells two hubs apart even when both get renamed. */
export function hubId() {
  let id = kv.get<string>('hub.id')
  if (!id) kv.set('hub.id', (id = crypto.randomBytes(8).toString('hex')))
  return id
}

let phones: PhoneRecord[] = kv.get<PhoneRecord[]>('phones') ?? []
const savePhones = () => kv.set('phones', phones)

// ---------- pairing ----------

const codes = new Map<string, { code: string; expiresAt: number; tries: number }>()

/** The hub address the phone will talk to; the page sends its own origin, so a proxy's name is kept. */
function hubOrigin(origin: unknown) {
  const s = String(origin ?? '').replace(/\/+$/, '')
  let u: URL | undefined
  try {
    u = new URL(s)
  } catch {}
  if (!u || !/^https?:$/.test(u.protocol) || u.origin !== s) throw new HttpError(400, 'Unexpected hub address')
  return s
}

/** A fresh code for the web app to show. */
export function newPairCode(origin: unknown, now = Date.now()): PhonePairCode {
  const hub = hubOrigin(origin)
  for (const [id, c] of codes) if (c.expiresAt <= now) codes.delete(id)
  const { id, code } = newShortCode()
  const expiresAt = now + CODE_TTL
  codes.set(id, { code, expiresAt, tries: 0 })
  const link = 'inyon://hub?' + new URLSearchParams({ u: hub, c: `${id}:${code}`, n: hubName() })
  return { id, code, link, expiresAt }
}

const EXPIRED = 'That code has expired. Show a new one on the hub.'

// failed claims by address, for the minute they count
const claims = new Map<string, { n: number; reset: number }>()

function countFailure(ip: string, now: number) {
  for (const [k, v] of claims) if (v.reset < now) claims.delete(k)
  const a = claims.get(ip) ?? { n: 0, reset: now + 60_000 }
  a.n++
  claims.set(ip, a)
}

/**
 * The phone hands in a code. Unknown and expired codes read the same, so the ID alone tells a
 * guesser nothing; wrong digits are counted against the code and against the address.
 */
export function claimPhone(ip: string, claim: Partial<PhoneClaim>, now = Date.now()): PhoneClaimResult {
  const a = claims.get(ip)
  if (a && a.reset >= now && a.n >= CLAIMS_PER_MINUTE) throw new HttpError(429, 'Too many attempts. Try again in a minute.')
  const parsed = parseShortCode(String(claim.code ?? ''))
  const entry = parsed && codes.get(parsed.id)
  if (!parsed || !entry || entry.expiresAt <= now) {
    if (parsed) codes.delete(parsed.id)
    countFailure(ip, now)
    throw new HttpError(404, EXPIRED)
  }
  if (!same(parsed.code, entry.code)) {
    if (++entry.tries >= WRONG_TRIES) codes.delete(parsed.id)
    countFailure(ip, now)
    throw new HttpError(401, 'Those digits are not right.')
  }
  codes.delete(parsed.id)
  const token = crypto.randomBytes(32).toString('base64url')
  const name = String(claim.name ?? '').trim().slice(0, 60) || 'Phone'
  phones.push({ id: crypto.randomBytes(6).toString('hex'), name, tokenHash: sha256(token), pairedAt: now, lastSeen: now })
  savePhones()
  return { token, hub: hubAbout() }
}

/** What a phone shows for this hub; sent again with every ticket, so a renamed or updated hub shows as it is now. */
export const hubAbout = () => ({ id: hubId(), name: hubName(), version: VERSION })

// ---------- signed-in phones ----------

const bearer = (req: Request) => req.headers.get('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1]

/** The request carries a bearer token (good or not): it is a phone's, never a browser's. */
export const hasBearer = (req: Request) => !!bearer(req)

function byToken(token: string, now: number) {
  const hash = sha256(token)
  const phone = phones.find((p) => same(p.tokenHash, hash))
  if (phone && now - phone.lastSeen >= SEEN_EVERY) {
    phone.lastSeen = now
    savePhones()
  }
  return phone
}

/** The paired phone a request comes from, by its bearer token. */
export function phoneFor(req: Request, now = Date.now()): PhoneRecord | undefined {
  const token = bearer(req)
  return token ? byToken(token, now) : undefined
}

// ---------- WebSocket tickets ----------

// a page can't put a header on a WebSocket, so a phone trades its token for a short-lived ticket
const tickets = new Map<string, { phone: string; expiresAt: number }>()

export function issueTicket(phoneId: string, now = Date.now()) {
  for (const [t, v] of tickets) if (v.expiresAt <= now) tickets.delete(t)
  const ticket = crypto.randomBytes(32).toString('base64url')
  tickets.set(ticket, { phone: phoneId, expiresAt: now + TICKET_TTL })
  return ticket
}

/** The phone a ticket was issued to, once: a second use finds nothing. */
export function redeemTicket(ticket: string, now = Date.now()): PhoneRecord | undefined {
  const t = tickets.get(ticket)
  tickets.delete(ticket)
  if (!t || t.expiresAt <= now) return
  return phones.find((p) => p.id === t.phone)
}

// ---------- open connections and removal ----------

// a token is only checked when a connection opens, so removing a phone has to close the ones it has
const sockets = new Map<{ close(code?: number, reason?: string): void }, string>()

/** Keeps `socket` as a phone's until it closes, so removing the phone can end it. */
export function holdPhoneSocket(phoneId: string, socket: { close(code?: number, reason?: string): void }) {
  sockets.set(socket, phoneId)
  return () => void sockets.delete(socket)
}

/** Lists the phones for the app; the one asking is marked. */
export function listPhones(req: Request, now = Date.now()): PairedPhone[] {
  const mine = phoneFor(req, now)?.id
  return phones.map(({ id, name, pairedAt, lastSeen }) => ({ id, name, pairedAt, lastSeen, ...(id === mine ? { thisPhone: true as const } : {}) }))
}

/** Forgets a phone: its token stops working now, and its connections are closed. */
export function revokePhone(id: string) {
  if (!phones.some((p) => p.id === id)) return false
  phones = phones.filter((p) => p.id !== id)
  savePhones()
  for (const [socket, phone] of sockets) {
    if (phone !== id) continue
    sockets.delete(socket)
    try {
      socket.close(4001, 'Phone removed')
    } catch {}
  }
  return true
}
