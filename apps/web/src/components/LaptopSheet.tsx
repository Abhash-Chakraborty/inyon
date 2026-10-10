import { useState } from 'react'
import clsx from 'clsx'
import { ClipboardPaste, Copy, ScanLine } from 'lucide-react'
import type { HostConfig } from '@tether/protocol'
import { api } from '../lib/api.ts'
import { toast } from '../lib/store.ts'
import { copyText } from '../lib/clipboard.ts'
import { plugin } from '../lib/native.ts'
import { useOpened } from '../lib/useOpened.ts'
import { Button, Field, Sheet, inputClass } from './ui/primitives.tsx'

const PAIR_COMMAND = 'tether-node pair'
const looksLikeLink = (s: string) => /^(tether:\/\/pair\?|https:\/\/\S+[?&]m=)/.test(s.trim())

/**
 * Pairing a laptop that runs `tether-node pair`: scan the code it shows (or paste its link) and the
 * phone connects to it directly, end to end encrypted, from any network. Editing one only renames it.
 */
export function LaptopSheet({ open, onClose, edit, link: given, onServer }: { open: boolean; onClose: () => void; edit?: HostConfig; link?: string; onServer?: () => void }) {
  const [name, setName] = useState('')
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  useOpened(open, edit?.id ?? given, () => {
    setName(edit?.name ?? '')
    setLink(given ?? '')
  })
  const scanner = plugin('TetherDevice')?.scanQr

  const pair = async (text: string) => {
    if (!looksLikeLink(text)) return toast({ title: "That isn't a pairing code", body: `Run ${PAIR_COMMAND} on the laptop and scan the code it shows.`, tone: 'error' })
    setBusy(true)
    try {
      await api.pairLaptop(text.trim())
      toast({ title: 'Laptop paired', body: 'It stays paired until you remove it here or run tether-node forget there.', tone: 'success' })
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
      title="Pair a laptop"
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
          The phone connects to the laptop itself, from any network. No server, VPN or open port needed, and everything between them is end to end encrypted.
        </p>
        <div className="rounded-[12px] border border-line bg-code p-3">
          <p className="text-[12.5px] leading-relaxed text-fg-2">On the laptop, run</p>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-fg">{PAIR_COMMAND}</code>
            <Button type="button" size="sm" variant="ghost" onClick={() => copyText(PAIR_COMMAND).then((ok) => ok && toast({ title: 'Command copied', tone: 'success' }))} aria-label="Copy the command">
              <Copy className="size-3.5" />
            </Button>
          </div>
          <p className="mt-1.5 text-[12px] leading-relaxed text-fg-3">It shows a code for 10 minutes and keeps running so the phone can reach the laptop.</p>
        </div>
        {scanner && (
          <Button type="button" size="lg" variant="accent" className="w-full" onClick={scan} disabled={busy}>
            <ScanLine className="size-4" /> Scan the code
          </Button>
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
            Add a server over SSH instead
          </button>
        )}
      </form>
    </Sheet>
  )
}
