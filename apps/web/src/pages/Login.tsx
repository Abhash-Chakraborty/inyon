import { useEffect, useState } from 'react'
import { api } from '../lib/api.ts'
import { useStore } from '../lib/store.ts'
import { Logo } from '../components/AppShell.tsx'
import { Button, Field, inputClass } from '../components/ui/primitives.tsx'
import { isNative } from '../lib/native.ts'
import { hubBase, normalizeHub, setHubBase, setHubToken } from '../lib/hub.ts'

export function Login() {
  const native = isNative()
  // the phone apps ask where your hub is; a browser is already on it
  const [hub, setHub] = useState(() => hubBase())
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [code, setCode] = useState('')
  // a new hub has no password yet: the first visit creates it
  const [setup, setSetup] = useState<{ code: boolean } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const setAuthed = useStore((s) => s.setAuthed)

  useEffect(() => {
    if (native) return
    api.session().then((s) => s.setup && setSetup({ code: !!s.setupCode })).catch(() => {})
  }, [native])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (native) {
        const url = normalizeHub(hub)
        try {
          new URL(url)
        } catch {
          throw new Error('Enter your hub address, like http://my-server:4777')
        }
        if (url !== hubBase() || !setup) {
          setHubBase(url)
          setHubToken('')
          // the phone app learns the hub is new once it can reach it
          const s = await api.session()
          if (s.setup && !setup) {
            setSetup({ code: !!s.setupCode })
            setConfirm('')
            return
          }
          if (!s.setup) setSetup(null)
        }
      }
      if (setup) {
        if (password.length < 8) throw new Error('Use at least 8 characters.')
        if (password !== confirm) throw new Error("The two passwords don't match.")
        await api.createPassword(password, setup.code ? code : undefined)
      } else await api.login(password)
      setAuthed(true)
    } catch (err) {
      const msg = (err as Error).message
      // fetch says "Failed to fetch" / "Load failed" when the address can't be reached at all
      setError(native && /fetch|load failed|network/i.test(msg) ? `Can't reach ${normalizeHub(hub)}. Check the address, and that this phone is on the same Tailscale or NetBird network.` : msg)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-6">
      <form onSubmit={submit} className="animate-slide-up w-full max-w-[360px]">
        <Logo className="size-12 rounded-2xl" />
        <h1 className="mt-6 font-serif text-[30px] leading-tight tracking-tight">{setup ? 'Create your password' : 'Welcome back'}</h1>
        <p className="mt-1.5 text-[15px] text-fg-2">
          {setup
            ? "This hub is new. Pick the password you'll use to sign in from your browser and phone."
            : native ? 'Connect to your Tether hub to reach your machines and coding agents.' : 'Sign in to reach your machines and coding agents.'}
        </p>
        {native && (
          <div className="mt-7">
            <Field label="Hub address">
              <input
                type="text"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={hub}
                onChange={(e) => setHub(e.target.value)}
                placeholder="http://my-server:4777"
                className={`${inputClass} h-12 font-mono text-[14px]`}
              />
            </Field>
          </div>
        )}
        <input
          type="password"
          autoFocus={!native}
          autoComplete={setup ? 'new-password' : 'current-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={setup ? 'New password (8+ characters)' : 'Password'}
          className={`${inputClass} ${native ? 'mt-3' : 'mt-7'} h-12`}
        />
        {setup && (
          <input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Type it again"
            className={`${inputClass} mt-3 h-12`}
          />
        )}
        {setup?.code && (
          <div className="mt-4">
            <Field label="Setup code" hint="The hub printed it when it started. It's also in ~/.tether/setup-code on the hub machine.">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                className={`${inputClass} h-12 font-mono text-[14px]`}
              />
            </Field>
          </div>
        )}
        {error && <p className="mt-2 text-sm text-danger">{error}</p>}
        <Button type="submit" variant="primary" size="lg" className="mt-4 w-full" loading={busy} disabled={!password || (native && !hub.trim()) || (!!setup && !confirm) || (!!setup?.code && !code.trim())}>
          {setup ? 'Create password' : 'Continue'}
        </Button>
      </form>
    </div>
  )
}
