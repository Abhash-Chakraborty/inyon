import { useEffect, useState } from 'react'
import { renderSVG } from 'uqr'
import { Smartphone } from 'lucide-react'
import { WEB_URL } from '@inyon/protocol'
import { api, ApiError } from '../lib/api.ts'
import { hubOrigin } from '../lib/hub.ts'
import { toast } from '../lib/store.ts'
import { copyText } from '../lib/clipboard.ts'
import { Button, Field, Sheet, Waiting, inputClass } from './ui/primitives.tsx'

type Code = { id: string; code: string; link: string; expiresAt: number }

/** "K7Q4MX2T:493812" as it is shown: K7Q4-MX2T and 493 812 */
const showId = (id: string) => `${id.slice(0, 4)}-${id.slice(4)}`
const showCode = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`

/**
 * Open this hub on your phone: a code the Inyon app scans (or types) to pair with the hub. The
 * hub only hands one out to someone who signed in a moment ago, so an old tab asks for the
 * password again first. The code works once, for ten minutes.
 */
export function PhoneSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [code, setCode] = useState<Code>()
  const [needPassword, setNeedPassword] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const fetchCode = async () => {
    setError(undefined)
    setBusy(true)
    try {
      setCode(await api.phonePair(hubOrigin()))
      setNeedPassword(false)
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setNeedPassword(true)
      else setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    if (!open) return
    setCode(undefined)
    setPassword('')
    void fetchCode()
  }, [open])

  const signIn = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await api.login(password)
      setPassword('')
      await fetchCode()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  // the camera opens the download page, which hands the code to the app; the app's own scanner
  // reads the same link straight from the page
  const qr = code ? renderSVG(`${WEB_URL}#hub?${code.link.slice('inyon://hub?'.length)}`, { border: 1, pixelSize: 6 }) : undefined
  const left = code ? Math.max(0, Math.round((code.expiresAt - Date.now()) / 60_000)) : 0

  return (
    <Sheet open={open} onClose={onClose} title="Open on your phone" icon={<Smartphone className="size-4" />}>
      {needPassword ? (
        <form onSubmit={signIn} className="space-y-4">
          <p className="text-[13px] leading-relaxed text-fg-2">Pairing a phone needs a fresh sign-in. Enter the hub's password once more.</p>
          <Field label="Password">
            <input className={inputClass} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus />
          </Field>
          {error && <p className="text-[12.5px] text-danger">{error}</p>}
          <Button variant="primary" type="submit" loading={busy} disabled={!password} className="w-full">
            Continue
          </Button>
        </form>
      ) : !code ? (
        error ? (
          <div className="space-y-3">
            <p className="text-[13px] text-danger">{error}</p>
            <Button variant="primary" onClick={fetchCode} loading={busy}>Try again</Button>
          </div>
        ) : (
          <Waiting label="Making a code" shape="panel" />
        )
      ) : (
        <div className="space-y-4">
          <p className="text-[13px] leading-relaxed text-fg-2">
            In the Inyon app, tap <span className="font-medium text-fg">Add</span>, then <span className="font-medium text-fg">Connect to a hub</span>, and scan this. The phone then reaches this hub and its machines itself, with no browser in between.
          </p>
          <div className="mx-auto w-fit rounded-2xl border border-line bg-white p-3" dangerouslySetInnerHTML={{ __html: qr! }} aria-label="Pairing code" role="img" />
          <div className="rounded-2xl border border-line bg-sunken px-4 py-3">
            <p className="text-[12.5px] text-fg-3">Can't scan it? In the app, type the hub's address and this code.</p>
            <div className="mt-2 grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 font-mono text-[14px]">
              <span className="text-fg-3">Address</span>
              <span className="tabular text-right text-fg">{hubOrigin().replace(/^https?:\/\//, '')}</span>
              <span className="text-fg-3">ID</span>
              <span className="tabular text-right tracking-[0.08em] text-fg">{showId(code.id)}</span>
              <span className="text-fg-3">Code</span>
              <span className="tabular text-right tracking-[0.2em] text-fg">{showCode(code.code)}</span>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3">
            <p className="text-[12px] text-fg-3">Works once, for {left} more minute{left === 1 ? '' : 's'}. Five wrong codes cancel it.</p>
            <Button size="sm" variant="ghost" onClick={() => copyText(code.link).then((ok) => ok && toast({ title: 'Link copied', tone: 'success' }))}>
              Copy link
            </Button>
          </div>
        </div>
      )}
    </Sheet>
  )
}
