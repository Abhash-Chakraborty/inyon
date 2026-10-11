import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { ChevronRight, ClipboardPaste, Copy, ScanLine, SquareTerminal } from 'lucide-react'
import type { HostConfig } from '@tether/protocol'
import { api } from '../lib/api.ts'
import { toast, useStore } from '../lib/store.ts'
import { copyText } from '../lib/clipboard.ts'
import { plugin, readClipboard } from '../lib/native.ts'
import { useOpened } from '../lib/useOpened.ts'
import { keepAliveSupported, keepAliveWanted } from '../lib/keepalive.ts'
import { Button, Field, Segmented, Sheet, inputClass } from './ui/primitives.tsx'

const PAIR_COMMAND = 'tether-node pair'
const DOWNLOADS = 'https://github.com/Abhash-Chakraborty/tether-releases/releases/latest/download'
/** One line that downloads tether-node, starts it in the background and shows the code. */
export const SETUP_COMMANDS = {
  unix: { label: 'Mac or Linux', where: 'In a terminal (on a server, your SSH session), run:', command: `curl -fsSL ${DOWNLOADS}/get.sh | sh` },
  windows: { label: 'Windows', where: 'In PowerShell, run:', command: `irm ${DOWNLOADS}/get.ps1 | iex` },
} as const
const looksLikeLink = (s: string) => /^(tether:\/\/pair\?|https:\/\/\S+[?&]m=)/.test(s.trim())
/** tether-node prints a one-time ID like K7Q4-MX2T (Crockford base32: no I, L, O or U) */
const ID_CHARS = /[^0-9A-HJKMNP-TV-Z]/g
const cleanId = (s: string) => s.toUpperCase().replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V').replace(ID_CHARS, '').slice(0, 8)
const showId = (id: string) => (id.length > 4 ? `${id.slice(0, 4)}-${id.slice(4)}` : id)
/** "K7Q4-MX2T 493 812" pasted whole into either box */
const splitCode = (s: string) => /^\s*([0-9a-z]{4})[\s-]*([0-9a-z]{4})[\s:,-]+(\d{3})\s?(\d{3})\s*$/i.exec(s)

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
  const [how, setHow] = useState<'type' | 'paste'>('type')
  const [shortId, setShortId] = useState('')
  const [code, setCode] = useState('')
  const codeBox = useRef<HTMLInputElement>(null)
  const idBox = useRef<HTMLInputElement>(null)
  const linkBox = useRef<HTMLInputElement>(null)
  // a box to focus once the chosen way of entering the code has rendered
  const [focusBox, setFocusBox] = useState<'id' | 'link'>()
  useEffect(() => {
    if (!focusBox) return
    ;(focusBox === 'id' ? idBox : linkBox).current?.focus()
    setFocusBox(undefined)
  }, [focusBox, how])
  const typed = shortId.length === 8 && code.length === 6 ? `${shortId} ${code}` : undefined
  const setupCmd = SETUP_COMMANDS[os]
  useOpened(open, edit?.id ?? given, () => {
    setName(edit?.name ?? '')
    setLink(given ?? '')
    setHow(given ? 'paste' : 'type')
    setShortId('')
    setCode('')
  })
  const scanner = plugin('TetherDevice')?.scanQr

  const pair = async (text: string) => {
    if (!looksLikeLink(text) && !splitCode(text)) return toast({ title: "That isn't a pairing code", body: `Run ${PAIR_COMMAND} on the computer and scan the code it shows.`, tone: 'error' })
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
      // the scanner buzzes on a hit or a wrong code, unless haptics are off in Settings
      const r = await scanner!({ haptics: !!useStore.getState().settings.haptics })
      if (r?.text) {
        setLink(r.text)
        await pair(r.text)
      } else if (r?.type) {
        setHow('type')
        setFocusBox('id')
      } else if (r?.paste) {
        setHow('paste')
        setFocusBox('link')
      } else if (r?.denied) {
        // without the camera, the ID and code are the shortest way in
        setHow('type')
        setFocusBox('id')
        toast({ title: 'No camera access', body: 'Type the ID and code tether-node shows instead.', tone: 'info' })
      }
    } catch (err) {
      toast({ title: "Couldn't open the scanner", body: (err as Error).message, tone: 'error' })
    }
  }

  const paste = async () => {
    const text = await readClipboard().catch(() => '')
    if (text.trim()) setLink(text.trim())
    else toast({ title: 'Nothing to paste', body: 'Copy the link tether-node printed, then tap Paste.', tone: 'error' })
  }

  /** A whole "ID code" pasted into either box fills both; a finished code pairs straight away. */
  const typeId = (v: string) => {
    const both = splitCode(v)
    if (both) return fill(cleanId(both[1]! + both[2]!), both[3]! + both[4]!)
    const id = cleanId(v)
    setShortId(id)
    if (id.length === 8 && shortId.length < 8) codeBox.current?.focus()
  }
  const typeCode = (v: string) => {
    const both = splitCode(v)
    if (both) return fill(cleanId(both[1]! + both[2]!), both[3]! + both[4]!)
    fill(shortId, v.replace(/\D/g, '').slice(0, 6))
  }
  const fill = (id: string, c: string) => {
    setShortId(id)
    setCode(c)
    if (id.length === 8 && c.length === 6 && !busy) pair(`${id} ${c}`)
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
          <Button variant="primary" type="submit" form="laptop-form" loading={busy} disabled={how === 'type' ? !typed : !looksLikeLink(link)}>
            {busy ? 'Connecting…' : 'Pair'}
          </Button>
        </div>
      }
    >
      <form id="laptop-form" onSubmit={(e) => (e.preventDefault(), pair(how === 'type' ? typed ?? '' : link))} className="space-y-4">
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
        <div className="space-y-2.5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[12.5px] font-medium text-fg">{scanner ? "Can't scan it?" : '2. Enter what it shows'}</p>
            <Segmented size="sm" value={how} onChange={setHow} options={[{ v: 'type', label: 'Type a code' }, { v: 'paste', label: 'Paste the link' }]} />
          </div>
          {how === 'type' ? (
            <div key="type" className="animate-fade-in grid grid-cols-[1.25fr_1fr] gap-2">
              <Field label="ID">
                <input
                  ref={idBox}
                  className={clsx(inputClass, 'font-mono text-[15px] tracking-[0.08em]')}
                  value={showId(shortId)}
                  onChange={(e) => typeId(e.target.value)}
                  placeholder="K7Q4-MX2T"
                  aria-label="ID"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  autoComplete="off"
                  spellCheck={false}
                  enterKeyHint="next"
                />
              </Field>
              <Field label="Code">
                <input
                  ref={codeBox}
                  className={clsx(inputClass, 'font-mono text-[15px] tracking-[0.2em]')}
                  value={code}
                  onChange={(e) => typeCode(e.target.value)}
                  placeholder="000000"
                  aria-label="Code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  enterKeyHint="go"
                />
              </Field>
              <p className="col-span-2 text-[12px] leading-relaxed text-fg-3">The ID and code work once, for 10 minutes. Five wrong codes cancel them.</p>
            </div>
          ) : (
            <div key="paste" className="animate-fade-in flex gap-2">
              <input
                ref={linkBox}
                className={clsx(inputClass, 'min-w-0 flex-1 font-mono text-[12.5px]')}
                value={link}
                onChange={(e) => setLink(e.target.value)}
                placeholder="tether://pair?m=…"
                aria-label="Pairing link"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
              <Button type="button" variant="ghost" onClick={paste} aria-label="Paste">
                <ClipboardPaste className="size-4" />
              </Button>
            </div>
          )}
        </div>
        {onServer && (
          <button
            type="button"
            onClick={onServer}
            className="press flex w-full items-center gap-3 rounded-[12px] border border-line px-3.5 py-3 text-left hover:bg-sunken"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-sunken text-fg-2">
              <SquareTerminal className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[13.5px] font-medium text-fg">Connect over SSH</span>
              <span className="block text-[12px] leading-snug text-fg-3">Advanced. For servers you can't install Tether on: a key, a password, or none.</span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-fg-3" />
          </button>
        )}
      </form>
    </Sheet>
  )
}
