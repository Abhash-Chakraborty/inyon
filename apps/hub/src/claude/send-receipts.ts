import { kv, sha256Hex } from '../platform/store.ts'

type Receipt = { digest: string; expires: number; state: 'pending' | 'accepted'; result?: Promise<unknown> }
const RETENTION_MS = 24 * 60 * 60_000

export class SendReceipts {
  private receipts = new Map<string, Receipt>()

  /** `key` is where the receipts are kept; without one they live only in memory */
  constructor(private key?: string) {
    if (!key) return
    const saved = kv.get<Record<string, Receipt>>(key) ?? {}
    for (const [id, receipt] of Object.entries(saved)) {
      if (receipt && typeof receipt.digest === 'string' && typeof receipt.expires === 'number' && receipt.expires > Date.now() && (receipt.state === 'pending' || receipt.state === 'accepted')) this.receipts.set(id, receipt)
    }
  }

  private save() {
    if (!this.key) return
    kv.set(this.key, Object.fromEntries([...this.receipts].map(([id, { digest, expires, state }]) => [id, { digest, expires, state }])))
  }

  /** Survives lost responses and restarts without retaining prompt text. */
  sendOnce(key: string, text: string, send: () => Promise<unknown>): Promise<unknown> {
    const now = Date.now()
    for (const [id, receipt] of this.receipts) if (receipt.expires < now && (receipt.state === 'accepted' || !receipt.result)) this.receipts.delete(id)
    const digest = sha256Hex(text)
    const existing = this.receipts.get(key)
    if (existing) {
      if (existing.digest !== digest) return Promise.reject(new Error('The send id was already used for a different message'))
      if (existing.result) return existing.result
      if (existing.state === 'accepted') return Promise.resolve()
      return Promise.reject(new Error('The hub restarted during this send. Check the terminal before sending again. Your message is available to copy.'))
    }
    if (this.receipts.size >= 1000) return Promise.reject(new Error('Too many outstanding sends. Try again later.'))
    const receipt: Receipt = { digest, expires: now + RETENTION_MS, state: 'pending' }
    this.receipts.set(key, receipt)
    try { this.save() } catch (error) { this.receipts.delete(key); return Promise.reject(error) }
    receipt.result = Promise.resolve().then(send).then((result) => {
      receipt.state = 'accepted'
      receipt.expires = Date.now() + RETENTION_MS
      this.save()
      return result
    }, (error) => {
      this.receipts.delete(key)
      this.save()
      throw error
    })
    return receipt.result
  }
}

const sends = new SendReceipts('send-receipts')
export const sendOnce = (key: string, text: string, send: () => Promise<unknown>) => sends.sendOnce(key, text, send)
