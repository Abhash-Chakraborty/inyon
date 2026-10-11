import { useState } from 'react'
import clsx from 'clsx'
import { ClipboardPaste, Copy, ScanLine } from 'lucide-react'
import type { HostConfig } from '@tether/protocol'
import { api } from '../lib/api.ts'
import { toast } from '../lib/store.ts'
import { copyText } from '../lib/clipboard.ts'
import { plugin } from '../lib/native.ts'
import { useOpened } from '../lib/useOpened.ts'
import { keepAliveSupported, keepAliveWanted } from '../lib/keepalive.ts'
import { Button, Field, Sheet, inputClass } from './ui/primitives.tsx'

const PAIR_COMMAND = 'tether-node pair'
const DOWNLOADS = 'https://github.com/Abhash-Chakraborty/tether-releases/releases/latest/download'
/** One line that downloads tether-node, starts it in the background and shows the code. */
export const SETUP_COMMANDS = {
  unix: { label: 'Mac or Linux', where: 'In a terminal (on a server, your SSH session), run:', command: `curl -fsSL ${DOWNLOADS}/get.sh | sh` },
  windows: { label: 'Windows', where: 'In PowerShell, run:', command: `irm ${DOWNLOADS}/get.ps1 | iex` },
} as const
const looksLikeLink = (s: string) => /^(tether:\/\/pair\?|https:\/\/\S+[?&]m=)/.test(s.trim())

/**
 * Pairing a computer (laptop, desktop or server) that runs `tether-node pair`: scan the code it
 * shows (or paste its link) and the phone connects to it directly, end to end encrypted, from any
 * network. A server shows the code right in the SSH session. Editing one only renames it.
 */
export function LaptopSheet({ open, onClose, edit, link: given, onServer }: { open: boolean; onClose: () => void; edit?: HostConfig; link?: string; onServer?: () => void }) {
  const [name, setName] = useState('')
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [os, setOs] = useState<keyof typeof SETUP_COMMANDS>('unix')
  const setupCmd = SETUP_COMMANDS[os]
  useOpened(open, edit?.id ?? given, () => {
    setName(edit?.name ?? '')
    setLink(given ?? '')
  })
  const scanner = plugin('TetherDevice')?.scanQr

  const pair = async (text: string) => {
    if (!looksLikeLink(text)) return toast({ title: "That isn't a pairing code", body: `Run ${PAIR_COMMAND} on the computer and scan the code it shows.`, tone: 'error' })
    setBusy(true)
    try {
      await api.pairLaptop(text.trim())
      toast({ title: 'Paired', body: 'It stays paired until you remove it here or run tether-node forget there.', tone: 'success' })
      // alerts only arrive while the app runs; the first pairing is the moment to say so
      if (keepAliveSupported() && !keepAliveWanted()) {
        setTimeout(() => toast({ title: 'Want alerts while Tether is closed?', body: 'Turn on Stay connected in Settings. Tap to open it.', tone: 'info', href: '/settings#background' }), 1200)
      }
      onClose()
    } catch (err) {
      toast({ title: "Couldn't pair", body: (err as Error).message, tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const scan = async () => {
    try {
      const r = await scanner!()
      if (r?.text) {
        setLink(r.text)
        await pair(r.text)
      }
    } catch (err) {
      toast({ title: "Couldn't open the scanner", body: (err as Error).message, tone: 'error' })
    }
  }

  const paste = async () => {
    const text = await navigator.clipboard?.readText().catch(() => '')
    if (text) setLink(text.trim())
    else toast({ title: 'Nothing to paste', body: 'Copy the link tether-node printed, then tap Paste.', tone: 'error' })
  }

  const rename = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!edit || !name.trim()) return
    setBusy(true)
    try {
      await api.updateHost(edit.id, { name: name.trim() })
      onClose()
    } catch (err) {
      toast({ title: 'Could not rename', body: (err as Error).message, tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  if (edit) {
    return (
      <Sheet
        open={open}
        onClose={onClose}
        title={`Rename ${edit.name}`}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
            <Button variant="primary" type="submit" form="laptop-form" loading={busy} disabled={!name.trim()}>Save</Button>
          </div>
        }
      >
        <form id="laptop-form" onSubmit={rename}>
          <Field label="Name">
            <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} maxLength={64} autoFocus />
          </Field>
        </form>
      </Sheet>
    )
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Add a computer"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="laptop-form" loading={busy} disabled={!looksLikeLink(link)}>
            {busy ? 'Connecting…' : 'Pair'}
          </Button>
        </div>
      }
    >
      <form id="laptop-form" onSubmit={(e) => (e.preventDefault(), pair(link))} className="space-y-4">
        <p className="text-[13px] leading-relaxed text-fg-2">
          A laptop, desktop or server. The phone connects to it directly from any network, end to end encrypted. No VPN or open ports.
        </p>
        <div className="rounded-[12px] border border-line bg-code p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[12.5px] font-medium text-fg">1. On the computer</p>
            <div role="tablist" aria-label="Operating system" className="flex rounded-[8px] border border-line p-0.5">
              {(Object.keys(SETUP_COMMANDS) as (keyof typeof SETUP_COMMANDS)[]).map((k) => (
                <button key={k} type="button" role="tab" aria-selected={os === k} onClick={() => setOs(k)} className={clsx('press rounded-[6px] px-2 py-0.5 text-[12px]', os === k ? 'bg-elev text-fg shadow-sm' : 'text-fg-3 hover:text-fg')}>
                  {SETUP_COMMANDS[k].label}
                </button>
              ))}
            </div>
          </div>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-fg-2">{setupCmd.where}</p>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all font-mono text-[12px] leading-snug text-fg">{setupCmd.command}</code>
            <Button type="button" size="sm" variant="ghost" onClick={() => copyText(setupCmd.command).then((ok) => ok && toast({ title: 'Command copied', tone: 'success' }))} aria-label="Copy the command">
              <Copy className="size-3.5" />
            </Button>
          </div>
          <p className="mt-1.5 text-[12px] leading-relaxed text-fg-3">
            It installs Tether's small helper for your user (no admin rights), keeps it running and shows a code. Already set up? Run <code className="font-mono">{PAIR_COMMAND}</code>.
          </p>
        </div>
        {scanner && (
          <div className="space-y-2">
            <p className="text-[12.5px] font-medium text-fg">2. Scan the code it shows</p>
            <Button type="button" size="lg" variant="accent" className="w-full" onClick={scan} disabled={busy}>
              <ScanLine className="size-4" /> Scan the code
            </Button>
          </div>
        )}
        <Field label={scanner ? 'Or paste the link it printed' : 'Paste the link it printed'}>
          <div className="flex gap-2">
            <input
              className={clsx(inputClass, 'min-w-0 flex-1 font-mono text-[12.5px]')}
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="tether://pair?m=…"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            <Button type="button" variant="ghost" onClick={paste} aria-label="Paste">
              <ClipboardPaste className="size-4" />
            </Button>
          </div>
        </Field>
        {onServer && (
          <button type="button" onClick={onServer} className="py-1.5 text-[12.5px] text-fg-3 underline-offset-2 hover:text-fg hover:underline">
            Can't install anything? Connect over SSH instead
          </button>
        )}
      </form>
    </Sheet>
  )
}
