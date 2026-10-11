import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Copy, ShieldAlert, ShieldCheck } from 'lucide-react'
import type { HostConfig } from '@tether/protocol'
import { api, type ServerForm } from '../lib/api.ts'
import { toast } from '../lib/store.ts'
import { copyText } from '../lib/clipboard.ts'
import { authorizeCommand } from '../lib/phone.ts'
import { useOpened } from '../lib/useOpened.ts'
import { Button, Field, Segmented, Sheet, inputClass } from './ui/primitives.tsx'

type Auth = ServerForm['auth']

/**
 * Adding or editing a server in the phone app. The phone connects to it itself over SSH: you give
 * the address and how to sign in, then confirm the server's fingerprint the first time.
 */
export function ServerSheet({ open, onClose, edit, onLaptop }: { open: boolean; onClose: () => void; edit?: HostConfig; onLaptop?: () => void }) {
  const [name, setName] = useState('')
  const [target, setTarget] = useState('')
  const [port, setPort] = useState('')
  const [auth, setAuth] = useState<Auth>('phone-key')
  const [password, setPassword] = useState('')
  const [privateKey, setPrivateKey] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [phoneKey, setPhoneKey] = useState('')
  // the fingerprint the server showed, waiting for a yes; and the address it belongs to
  const [found, setFound] = useState<{ fingerprint: string; keyType: string; at: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const fingerprint = useRef<HTMLDivElement>(null)

  useOpened(open, edit?.id, () => {
    setName(edit?.name ?? '')
    setTarget(edit?.target ?? '')
    setPort(edit?.port ? String(edit.port) : '')
    setAuth(edit?.auth ?? 'phone-key')
    setPassword('')
    setPrivateKey('')
    setPassphrase('')
    setFound(null)
    api.phoneKey().then((k) => setPhoneKey(k.publicKey), () => {})
  })

  // the fingerprint appears under the fold of a phone-sized sheet: bring it into view to be read
  useEffect(() => {
    if (found) fingerprint.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [found?.fingerprint, found?.at])

  const address = `${target.trim()}:${port || 22}`
  const noUser = !!target.trim() && !target.includes('@')
  const known = edit?.hostKey && `${edit.target}:${edit.port ?? 22}` === address ? edit.hostKey : undefined
  const confirmed = found?.at === address ? found.fingerprint : known
  const keptSecret = !!edit && edit.auth === auth
  const ready = !!name.trim() && /^[^@\s]+@[^@\s]+$/.test(target.trim()) && (auth === 'phone-key' || keptSecret || (auth === 'password' ? !!password : !!privateKey.trim()))

  /** Asks the server for its key, so you can compare it before the phone ever signs in. */
  const check = async () => {
    setBusy(true)
    try {
      const r = await api.probe(target.trim(), port ? Number(port) : undefined)
      setFound({ ...r, at: address })
    } catch (err) {
      toast({ title: "Couldn't reach the server", body: (err as Error).message, tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const save = async (hostKey: string) => {
    setBusy(true)
    try {
      const body: ServerForm = {
        name: name.trim(),
        target: target.trim(),
        port: port ? Number(port) : undefined,
        hostKey,
        auth,
        password: auth === 'password' && password ? password : undefined,
        privateKey: auth === 'key' && privateKey.trim() ? privateKey.trim() : undefined,
        passphrase: auth === 'key' && passphrase ? passphrase : undefined,
      }
      if (edit) await api.editServer(edit.id, body)
      else await api.addServer(body)
      toast({ title: edit ? 'Server updated' : 'Server added', body: 'Connecting over SSH…', tone: 'success' })
      onClose()
    } catch (err) {
      toast({ title: 'Could not save', body: (err as Error).message, tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!ready || busy) return
    if (found && found.at === address) return save(found.fingerprint)
    if (confirmed) return save(confirmed)
    check()
  }

  const changed = !!known && found?.at === address && found.fingerprint !== known
  const asking = !!found && found.at === address && found.fingerprint !== known

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={edit ? `Edit ${edit.name}` : 'Add a server'}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="server-form" loading={busy} disabled={!ready}>
            {asking ? (edit ? 'Trust and save' : 'Trust and add') : confirmed ? (edit ? 'Save' : 'Add server') : 'Continue'}
          </Button>
        </div>
      }
    >
      <form id="server-form" onSubmit={submit} className="space-y-4">
        {!edit && (
          <p className="text-[13px] leading-relaxed text-fg-2">
            This phone connects to the server itself over SSH. Nothing runs in between and nothing is installed there. The phone has to be able to reach it: same Wi-Fi, or a VPN like Tailscale or NetBird. A server on Tailscale SSH lets the phone in with no key or password.
          </p>
        )}
        <Field label="Name">
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="Work server" autoFocus={!edit} />
        </Field>
        <div className="grid grid-cols-[1fr_92px] gap-3">
          <Field label="User and address" hint={noUser ? 'Add the user name too, like you@server' : undefined}>
            <input
              className={clsx(inputClass, 'font-mono text-[13.5px]')}
              value={target}
              onChange={(e) => setTarget(e.target.value.trim())}
              placeholder="you@100.64.0.5"
              inputMode="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </Field>
          <Field label="Port">
            <input className={inputClass} value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ''))} placeholder="22" inputMode="numeric" />
          </Field>
        </div>

        <Field label="Sign in with">
          <Segmented full value={auth} onChange={setAuth} options={[{ v: 'phone-key', label: 'Phone key' }, { v: 'password', label: 'Password' }, { v: 'key', label: 'Private key' }]} />
        </Field>
        {auth === 'phone-key' && (
          <div className="rounded-[12px] border border-line bg-code p-3">
            <p className="text-[12.5px] leading-relaxed text-fg-2">Run this once on the server to let this phone in. The private half of the key never leaves the phone.</p>
            {phoneKey && (
              <Button size="sm" className="mt-2.5" onClick={() => copyText(authorizeCommand(phoneKey)).then((ok) => ok && toast({ title: 'Command copied', tone: 'success' }))}>
                <Copy className="size-3.5" /> Copy the command
              </Button>
            )}
          </div>
        )}
        {auth === 'password' && (
          <input
            type="password"
            className={inputClass}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={keptSecret ? 'Leave empty to keep the saved password' : 'Password'}
            autoComplete="off"
          />
        )}
        {auth === 'key' && (
          <>
            <textarea
              className={clsx(inputClass, 'h-28 py-2 font-mono text-[11.5px] leading-snug')}
              value={privateKey}
              onChange={(e) => setPrivateKey(e.target.value)}
              placeholder={keptSecret ? 'Leave empty to keep the saved key' : '-----BEGIN OPENSSH PRIVATE KEY-----'}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            <input type="password" className={inputClass} value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder="Passphrase, if the key has one" autoComplete="off" />
          </>
        )}

        {asking && found && (
          <div ref={fingerprint} className={clsx('flex scroll-mb-4 gap-3 rounded-[12px] px-3.5 py-3 text-[13px] leading-relaxed', changed ? 'bg-danger-soft text-danger' : 'bg-ok-soft/60 text-fg-2')}>
            {changed ? <ShieldAlert className="mt-0.5 size-4 shrink-0" /> : <ShieldCheck className="mt-0.5 size-4 shrink-0 text-ok" />}
            <span className="min-w-0">
              {changed ? "The server's key is different from the one you trusted before. Only continue if you reinstalled it or changed its keys." : 'The server says its key is:'}
              <code className="mt-1.5 block break-all font-mono text-[12px] text-fg">{found.fingerprint}</code>
              <span className="mt-1 block text-[12px] text-fg-3">
                {found.keyType}. To compare, run <code className="font-mono">ssh-keygen -lf /etc/ssh/ssh_host_{keyName(found.keyType)}_key.pub</code> on the server.
              </span>
            </span>
          </div>
        )}
        {onLaptop && (
          <button type="button" onClick={onLaptop} className="py-1.5 text-[12.5px] text-fg-3 underline-offset-2 hover:text-fg hover:underline">
            Scan a code instead (easiest)
          </button>
        )}
        {edit && known && !asking && (
          <button type="button" onClick={check} className="-my-1.5 py-1.5 text-[12.5px] text-fg-3 underline-offset-2 hover:text-fg hover:underline">
            Check the server's key again
          </button>
        )}
      </form>
    </Sheet>
  )
}

/** "ssh-ed25519" → "ed25519", the name of its host key file. */
const keyName = (type: string) => (type.includes('ed25519') ? 'ed25519' : type.includes('ecdsa') ? 'ecdsa' : 'rsa')
