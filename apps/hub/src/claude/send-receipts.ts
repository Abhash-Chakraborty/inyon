import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DATA_DIR } from '../config.ts'

type Receipt = { digest: string; expires: number; state: 'pending' | 'accepted'; result?: Promise<unknown> }
const RETENTION_MS = 24 * 60 * 60_000

export class SendReceipts {
  private receipts = new Map<string, Receipt>()

  constructor(private file?: string) {
    if (!file) return
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
      for (const [key, receipt] of Object.entries(saved) as [string, Receipt][]) {
        if (receipt && typeof receipt.digest === 'string' && typeof receipt.expires === 'number' && receipt.expires > Date.now() && (receipt.state === 'pending' || receipt.state === 'accepted')) this.receipts.set(key, receipt)
      }
    } catch {}
  }

  private save() {
    if (!this.file) return
    const saved = Object.fromEntries([...this.receipts].map(([key, { digest, expires, state }]) => [key, { digest, expires, state }]))
    const temporary = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(temporary, JSON.stringify(saved), { mode: 0o600 })
    fs.renameSync(temporary, this.file)
  }

  /** Survives lost responses and restarts without retaining prompt text. */
  sendOnce(key: string, text: string, send: () => Promise<unknown>): Promise<unknown> {
    const now = Date.now()
    for (const [id, receipt] of this.receipts) if (receipt.expires < now && (receipt.state === 'accepted' || !receipt.result)) this.receipts.delete(id)
    const digest = crypto.createHash('sha256').update(text).digest('hex')
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

const sends = new SendReceipts(path.join(DATA_DIR, 'send-receipts.json'))
export const sendOnce = (key: string, text: string, send: () => Promise<unknown>) => sends.sendOnce(key, text, send)
