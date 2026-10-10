import { useState } from 'react'
import { api } from '../lib/api.ts'
import { useStore } from '../lib/store.ts'
import { Logo } from '../components/AppShell.tsx'
import { Button, inputClass } from '../components/ui/primitives.tsx'

export function Login() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const setAuthed = useStore((s) => s.setAuthed)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await api.login(password)
      setAuthed(true)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-dvh items-center justify-center px-6">
      <form onSubmit={submit} className="animate-slide-up w-full max-w-[360px]">
        <Logo className="size-12 rounded-2xl" />
        <h1 className="mt-6 font-serif text-[30px] leading-tight tracking-tight">Welcome back</h1>
        <p className="mt-1.5 text-[15px] text-fg-2">Sign in to reach your machines and coding agents.</p>
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className={`${inputClass} mt-7 h-12`}
        />
        {error && <p className="mt-2 text-sm text-danger">{error}</p>}
        <Button type="submit" variant="primary" size="lg" className="mt-4 w-full" loading={busy} disabled={!password}>
          Continue
        </Button>
      </form>
    </div>
  )
}
