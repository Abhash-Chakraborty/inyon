import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { Bell, ChevronRight, Copy, KeyRound, LogOut, Monitor, Moon, Smartphone, Sun, Vibrate } from 'lucide-react'
import { AGENTS } from '@tether/protocol'
import { api, type HubSettings } from '../lib/api.ts'
import { toast, useStore } from '../lib/store.ts'
import { haptic } from '../lib/haptics.ts'
import { AgentLogo } from '../lib/skin.tsx'
import { Button, Segmented, Spinner, Toggle, inputClass } from '../components/ui/primitives.tsx'
import { HostDot, hostLine, sshAddress } from '../components/ui/status.tsx'
import { askNativeNotifications, isNative, nativeNotificationsOn, nativeNotify, plugin } from '../lib/native.ts'
import { allowBackground, batteryUnrestricted, keepAliveSupported, keepAliveWanted, setKeepAlive } from '../lib/keepalive.ts'
import { copyText } from '../lib/clipboard.ts'
import { authorizeCommand } from '../lib/phone.ts'
import { UploadsCard } from './Machines.tsx'
import { Logo } from '../components/AppShell.tsx'
import { COMMIT, VERSION } from '../lib/version.ts'

/** The phone app: stay connected while it's in the background, and Android's battery limits. */
function Background() {
  const [on, setOn] = useState(keepAliveWanted)
  const [unrestricted, setUnrestricted] = useState<boolean | undefined>()
  useEffect(() => {
    const check = () => batteryUnrestricted().then(setUnrestricted)
    check()
    // back from the system settings page
    document.addEventListener('visibilitychange', check)
    return () => document.removeEventListener('visibilitychange', check)
  }, [])
  const toggle = (v: boolean) => {
    setOn(v)
    setKeepAlive(v).catch((err) => {
      setOn(!v)
      toast({ title: "Couldn't change that", body: (err as Error).message, tone: 'error' })
    })
  }
  return (
    <Section id="background" title="In the background">
      <Row label="Stay connected" hint="Keeps your machines connected while Tether is closed, so alerts arrive right away. Shows a small ongoing notification and uses a little more battery.">
        <Toggle on={on} onChange={toggle} label="Stay connected" />
      </Row>
      {unrestricted === false && (
        <Row label="Battery limits" hint="Android is limiting Tether in the background, so it loses its connection once the screen has been off a while. Allow it to run in the background to keep alerts coming.">
          <button type="button" onClick={() => allowBackground().then((ok) => ok !== undefined && setUnrestricted(ok))} className="h-8 rounded-[9px] border border-line-strong px-3 text-[13px] font-medium hover:bg-hover">
            Allow
          </button>
        </Row>
      )}
    </Section>
  )
}

/** Which Tether this is, to check for updates or put in a bug report. */
function About() {
  const [app, setApp] = useState<{ version: string; build: string } | undefined>()
  useEffect(() => {
    plugin('App')?.getInfo().then((i: { version?: unknown; build?: unknown }) => typeof i?.version === 'string' && setApp({ version: i.version, build: String(i.build ?? '') })).catch(() => {})
  }, [])
  const summary = `Tether ${VERSION}${COMMIT ? ` (${COMMIT})` : ''}${app ? ` · Android app ${app.version}, build ${app.build}` : ''}`
  return (
    <Section id="about" title="About">
      <Row label="Version" hint={COMMIT ? `Built from commit ${COMMIT}` : undefined}>
        <span className="font-mono text-[13px] text-fg-2">{VERSION}</span>
      </Row>
      {app && (
        <Row label="Android app">
          <span className="font-mono text-[13px] text-fg-2">{app.version}</span>
        </Row>
      )}
      <button
        type="button"
        onClick={() => copyText(summary).then((ok) => ok && toast({ title: 'Version copied', tone: 'success' }))}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left text-[14px] font-medium hover:bg-hover/50"
      >
        <Copy className="size-4 text-fg-3" /> Copy version details
      </button>
    </Section>
  )
}

function Section({ id, title, desc, children }: { id?: string; title: string; desc?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20">
      <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
      {desc && <p className="mt-0.5 text-[13px] text-fg-3">{desc}</p>}
      <div className="mt-3 divide-y divide-line overflow-hidden rounded-[14px] border border-line bg-elev">{children}</div>
    </section>
  )
}

function Row({ label, hint, children }: { label: React.ReactNode; hint?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3.5">
      <div className="min-w-0 flex-[1_1_220px]">
        <div className="text-[14px]">{label}</div>
        {hint && <div className="mt-0.5 text-[12.5px] leading-snug text-fg-3">{hint}</div>}
      </div>
      {children}
    </div>
  )
}

const NAV = [
  ['appearance', 'Appearance'],
  ['agents', 'Agents'],
  ['uploads', 'Uploads and clipboard'],
  ['notifications', 'Notifications'],
  ['machines', isNative() ? 'Computers' : 'Machines'],
  ...(isNative()
    ? ([['phone-key', "This phone's key"]] as const)
    : ([['devices', 'Other devices'], ['account', 'Account']] as const)),
  ['about', 'About'],
] as const

export function Settings() {
  const settings = useStore((s) => s.settings)
  const set = useStore((s) => s.setSettings)
  const hosts = useStore((s) => s.hosts)
  const setAuthed = useStore((s) => s.setAuthed)
  const [hub, setHub] = useState<HubSettings | null>(null)
  const native = isNative()
  const [perm, setPerm] = useState<string>(native ? 'default' : typeof Notification !== 'undefined' ? Notification.permission : 'unsupported')
  useEffect(() => {
    if (native) void nativeNotificationsOn().then((on) => on !== undefined && setPerm(on ? 'granted' : 'default'))
  }, [native])
  const secure = native || window.isSecureContext
  const allow = () => (native ? askNativeNotifications().then((ok) => setPerm(ok ? 'granted' : 'denied')) : Notification.requestPermission().then(setPerm))
  /** Shows what a notification looks like here, so you know they get through. */
  const testNotification = async () => {
    const title = 'Tether'
    const body = 'Notifications work. You\u2019ll get one when an agent finishes or needs you.'
    if (native ? await nativeNotify(title, body, '/settings#notifications', 'test', 'done') : (() => {
      try {
        new Notification(title, { body, tag: 'test', icon: '/icon-192.png', badge: '/badge-96.png' })
        return true
      } catch {
        return false
      }
    })()) toast({ title: 'Test notification sent', tone: 'success' })
    else toast({ title: "Couldn't show a notification", body: 'Check that notifications are allowed for Tether in your settings.', tone: 'error' })
  }

  useEffect(() => {
    api.settings().then(setHub).catch(() => {})
    const hash = location.hash.slice(1)
    if (hash) setTimeout(() => document.getElementById(hash)?.scrollIntoView(), 50)
  }, [])

  const saveHub = async (p: Partial<HubSettings['uploads']>, extra: Partial<Omit<HubSettings, 'uploads'>> = {}) => {
    if (!hub) return
    const next = { ...hub, ...extra, uploads: { ...hub.uploads, ...p } }
    setHub(next)
    try {
      setHub(await api.saveSettings(next))
    } catch (e) {
      toast({ title: 'Could not save', body: (e as Error).message, tone: 'error' })
    }
  }

  const agentsByKind = Object.values(AGENTS).map((a) => ({ a, on: hosts.filter((h) => h.agents.includes(a.kind)).map((h) => h.config.name) }))

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <header className="pt-safe sticky top-0 z-20 border-b border-line bg-bg/90 backdrop-blur-md">
        <div className="flex h-[52px] items-center gap-3 px-4 lg:px-7">
          <span className="md:hidden">
            <Logo />
          </span>
          <h1 className="text-[15px] font-semibold tracking-tight">Settings</h1>
        </div>
      </header>
      <div className="mx-auto flex max-w-[1040px] gap-10 px-4 py-7 lg:px-7">
        <nav className="sticky top-[76px] hidden h-fit w-[190px] shrink-0 space-y-0.5 lg:block">
          {NAV.map(([id, label]) => (
            <a key={id} href={`#${id}`} className="block rounded-[8px] px-2.5 py-1.5 text-[13px] text-fg-2 hover:bg-hover hover:text-fg">
              {label}
            </a>
          ))}
        </nav>
        <div className="min-w-0 flex-1 space-y-9 pb-16">
          <Section id="appearance" title="Appearance">
            <Row label="Theme">
              <Segmented
                value={settings.theme}
                onChange={(theme) => set({ theme })}
                options={[
                  { v: 'light', label: <><Sun className="size-3.5" /> Light</> },
                  { v: 'dark', label: <><Moon className="size-3.5" /> Dark</> },
                  { v: 'system', label: <><Monitor className="size-3.5" /> Auto</> },
                ]}
              />
            </Row>
            <Row label="Match the agent inside sessions" hint="Each agent's colours, logo and reply font. Off keeps the neutral look everywhere.">
              <div className="flex items-center gap-1.5">
                {(['claude', 'codex', 'opencode', 'copilot'] as const).map((k) => (
                  <AgentLogo key={k} kind={k} size={20} />
                ))}
                <span className="ml-2">
                  <Toggle on={settings.agentSkins} onChange={(agentSkins) => set({ agentSkins })} label="Agent skins" />
                </span>
              </div>
            </Row>
            <Row label="Reply font" hint="Auto uses each agent's own: serif for Claude, sans for Codex, mono for OpenCode.">
              <Segmented size="sm" value={settings.replyFont} onChange={(replyFont) => set({ replyFont })} options={[{ v: 'auto', label: 'Auto' }, { v: 'serif', label: 'Serif' }, { v: 'sans', label: 'Sans' }, { v: 'mono', label: 'Mono' }]} />
            </Row>
            <Row label="Tool calls in chat" hint="Everything shows each command, file and search with its timing, and background jobs with their live state. Compact folds long runs into a few lines.">
              <Segmented size="sm" value={settings.toolDetail} onChange={(toolDetail) => set({ toolDetail })} options={[{ v: 'all', label: 'Everything' }, { v: 'compact', label: 'Compact' }]} />
            </Row>
            <Row label={<span className="flex items-center gap-2"><Vibrate className="size-4 text-fg-3" /> Haptic feedback</span>} hint="Taps, sends and answers buzz on phones (Android, and iPhone with iOS 17.4 or later).">
              <Toggle on={settings.haptics} onChange={(haptics) => (set({ haptics }), haptics && setTimeout(() => haptic('success'), 30))} label="Haptics" />
            </Row>
          </Section>

          <Section id="agents" title="Agents" desc="Found on your machines. Tether picks the right one for each pane automatically.">
            {agentsByKind.map(({ a, on }) => (
              <Row
                key={a.kind}
                label={
                  <span className="flex items-center gap-3">
                    <AgentLogo kind={a.kind} size={28} />
                    <span>
                      <span className="block font-medium">{a.name}</span>
                      <span className="block text-[12px] text-fg-3">{on.length ? `On ${on.join(', ')}` : 'Not installed on any machine'}</span>
                    </span>
                  </span>
                }
              >
                <div className="flex items-center gap-3 text-[12px] text-fg-3">
                  <code className="rounded-[7px] border border-line bg-code px-2 py-1 font-mono text-[12px] text-fg-2">{a.launch}</code>
                  <span className={clsx('shrink-0 whitespace-nowrap rounded-[6px] px-2 py-0.5 text-[11.5px]', a.chat ? 'bg-ok-soft text-ok' : 'bg-sunken text-fg-3')}>{a.chat ? 'Chat view' : 'Terminal'}</span>
                </div>
              </Row>
            ))}
          </Section>

          <section id="sessions" className="scroll-mt-20">
            <h2 className="text-[15px] font-semibold tracking-tight">Live numbers</h2>
            <p className="mt-0.5 text-[13px] text-fg-3">
              Plan limits come from each machine's signed-in Claude account, the same numbers as /usage, so they follow account switches by themselves.
            </p>
            <div className="mt-3 divide-y divide-line overflow-hidden rounded-[14px] border border-line bg-elev">
              {!hub ? (
                <div className="flex justify-center py-6"><Spinner /></div>
              ) : (
                <Row label="Restart sessions that stop reporting" hint="When a session's settings are swapped under it, its cost and effort stop updating. If on, Tether resumes it once it's idle, with nothing typed and no background shells.">
                  <Toggle on={!!hub.autoResume} onChange={(v) => saveHub({}, { autoResume: v })} label="Restart sessions that stop reporting" />
                </Row>
              )}
            </div>
          </section>

          <section id="uploads" className="scroll-mt-20">
            <h2 className="text-[15px] font-semibold tracking-tight">Uploads and clipboard</h2>
            <p className="mt-0.5 text-[13px] text-fg-3">Files you attach, paste or drop are copied to ~/.tether/uploads on the session's machine, and the agent gets their paths.</p>
            <div className="mt-3 divide-y divide-line overflow-hidden rounded-[14px] border border-line bg-elev">
              {!hub ? (
                <div className="flex justify-center py-6"><Spinner /></div>
              ) : (
                <>
                  <Row label="Delete uploads after" hint="Checked every few hours on every connected machine.">
                    <Segmented size="sm" value={String(hub.uploads.retentionDays)} onChange={(v) => saveHub({ retentionDays: Number(v) })} options={[{ v: '1', label: '1 day' }, { v: '7', label: '7 days' }, { v: '30', label: '30 days' }, { v: '0', label: 'Never' }]} />
                  </Row>
                  <Row label="Largest file">
                    <Segmented size="sm" value={String(hub.uploads.maxMB)} onChange={(v) => saveHub({ maxMB: Number(v) })} options={[{ v: '25', label: '25 MB' }, { v: '100', label: '100 MB' }, { v: '500', label: '500 MB' }]} />
                  </Row>
                </>
              )}
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {hosts.map((h) => (
                <UploadsCard key={h.config.id} host={h} compact />
              ))}
            </div>
          </section>

          <Section id="notifications" title="Notifications">
            <Row label="When an agent finishes" hint="A notice when a session goes from working to idle. Needs-you alerts are always on.">
              <Toggle on={settings.notifyDone} onChange={(notifyDone) => set({ notifyDone })} label="Finished notices" />
            </Row>
            <Row label={<span className="flex items-center gap-2"><Bell className="size-4 text-fg-3" /> System notifications</span>} hint={!secure ? 'Browsers only allow these over HTTPS or in the installed app. In-app notices still work.' : perm === 'granted' ? 'On for this device' : perm === 'denied' ? 'Turned off in your phone\'s settings for Tether' : 'Alerts while Tether is in the background'}>
              {perm !== 'granted' && perm !== 'unsupported' && perm !== 'denied' && secure && (
                <button type="button" onClick={allow} className="h-8 rounded-[9px] border border-line-strong px-3 text-[13px] font-medium hover:bg-hover">
                  Allow
                </button>
              )}
              {perm === 'granted' && (
                <button type="button" onClick={testNotification} className="h-8 rounded-[9px] border border-line-strong px-3 text-[13px] font-medium hover:bg-hover">
                  Send a test
                </button>
              )}
            </Row>
          </Section>

          {keepAliveSupported() && <Background />}

          <Section id="machines" title="Machines">
            {hosts.map((h) => (
              <Link key={h.config.id} to={`/machines/${encodeURIComponent(h.config.id)}`} className="flex items-center gap-3 px-4 py-3.5 hover:bg-hover/50">
                <HostDot status={h.status} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-medium">{h.config.name}</span>
                  <span className="block truncate text-[12px] text-fg-3">{hostLine(h, `${h.config.kind === 'local' ? 'This hub' : h.config.kind === 'node' ? h.hostname ?? 'Paired machine' : h.config.kind === 'link' ? h.hostname ?? 'Laptop' : sshAddress(h.config, hosts)} · integration ${h.integration === 'installed' ? 'on' : 'off'}`)}</span>
                </span>
                <ChevronRight className="size-4 text-fg-3" />
              </Link>
            ))}
          </Section>

          {native ? (
            <PhoneKey />
          ) : (
            <>
          <OtherDevices />

          <Section id="account" title="Account">
            <ChangePassword />
            <button
              type="button"
              onClick={async () => {
                await api.logout().catch(() => {})
                setAuthed(false)
              }}
              className="flex w-full items-center gap-3 px-4 py-3.5 text-left text-[14px] font-medium text-danger hover:bg-danger-soft/50"
            >
              <LogOut className="size-4" /> Sign out
            </button>
          </Section>
            </>
          )}
          <About />
          <p className="text-center text-[12px] text-fg-3">Agent marks belong to their owners</p>
        </div>
      </div>
    </div>
  )
}

/** A new password signs out every other browser and phone; this one stays signed in. */
function ChangePassword() {
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const reset = () => (setOpen(false), setCurrent(''), setNext(''), setAgain(''), setError(''))
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="flex w-full items-center gap-3 px-4 py-3.5 text-left text-[14px] font-medium hover:bg-hover/50">
        <KeyRound className="size-4 text-fg-3" /> Change password
      </button>
    )
  }
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (next.length < 8) return setError('Use at least 8 characters.')
    if (next !== again) return setError("The two new passwords don't match.")
    setBusy(true)
    try {
      await api.changePassword(current, next)
      haptic('success')
      toast({ title: 'Password changed', body: 'Other devices need to sign in again.', tone: 'success' })
      reset()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={save} className="space-y-2.5 px-4 py-4">
      <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="Current password" className={`${inputClass} h-11`} autoFocus />
      <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="New password (8+ characters)" className={`${inputClass} h-11`} />
      <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} placeholder="New password again" className={`${inputClass} h-11`} />
      {error && <p className="text-[13px] text-danger">{error}</p>}
      <p className="text-[12.5px] text-fg-3">Every other browser and phone signed in to this hub will need the new password.</p>
      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={reset}>Cancel</Button>
        <Button type="submit" variant="primary" loading={busy} disabled={!current || !next || !again}>Change password</Button>
      </div>
    </form>
  )
}

/** The phone app signs in to SSH computers with its own key: one line to add to authorized_keys. */
function PhoneKey() {
  const [key, setKey] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    api.phoneKey().then((k) => setKey(k.publicKey), (e) => setError((e as Error).message))
  }, [])
  const copy = (text: string, title: string) => copyText(text).then((ok) => ok && toast({ title, tone: 'success' }))
  return (
    <Section id="phone-key" title="This phone's key" desc="For computers added over SSH instead of with a code: the phone signs in with this key once it's in their ~/.ssh/authorized_keys.">
      <div className="px-4 py-3.5">
        {error ? (
          <p className="text-[13px] text-danger">{error}</p>
        ) : !key ? (
          <Spinner />
        ) : (
          <>
            <p className="break-all rounded-[10px] bg-sunken px-3 py-2.5 font-mono text-[12px] leading-relaxed text-fg-2">{key}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => copy(key, 'Key copied')}>
                <Copy className="size-3.5" /> Copy key
              </Button>
              <Button size="sm" variant="ghost" onClick={() => copy(authorizeCommand(key), 'Command copied')}>
                <KeyRound className="size-3.5" /> Copy the command that adds it
              </Button>
            </div>
            <p className="mt-2.5 text-[12.5px] leading-snug text-fg-3">Run that command on each server (in a terminal you already have there). The private half never leaves this phone.</p>
          </>
        )}
      </div>
    </Section>
  )
}

/** Where to open Tether from a phone or another computer: this same hub address. */
function OtherDevices() {
  const address = window.location.origin
  const local = /^https?:\/\/(localhost|127\.)/.test(address)
  const https = address.startsWith('https:')
  return (
    <Section id="devices" title="Your other devices" desc="Everything runs on this hub. Open the same address anywhere you want Tether.">
      <Row
        label="Hub address"
        hint={local ? 'This is the hub machine itself. Other devices use its Tailscale or NetBird name or IP with the same port.' : undefined}
      >
        <button
          type="button"
          onClick={() => copyText(address).then((ok) => ok && toast({ title: 'Address copied', tone: 'success' }))}
          className="flex max-w-full items-center gap-2 rounded-[9px] border border-line-strong px-3 py-1.5 font-mono text-[12.5px] hover:bg-hover"
        >
          <span className="truncate">{address}</span>
          <Copy className="size-3.5 shrink-0 text-fg-3" />
        </button>
      </Row>
      <Row
        label={<span className="flex items-center gap-2"><Smartphone className="size-4 text-fg-3" /> On your phone</span>}
        hint={
          <>
            Open the address in the phone's browser while it's on the same Tailscale or NetBird network. The Android app doesn't need this hub: it pairs with your computers directly (one command and a code), or reaches servers over SSH.
            {!https && ' Adding it to the home screen as an app, with notifications, needs the hub on HTTPS.'}
          </>
        }
      />
    </Section>
  )
}
