import { useState } from 'react'
import clsx from 'clsx'
import { Check, CircleAlert, Copy, Globe } from 'lucide-react'
import { api, type ShareCheck, type ShareList } from '../../lib/api.ts'
import { copyText } from '../../lib/clipboard.ts'
import { toast } from '../../lib/store.ts'
import { useOpened } from '../../lib/useOpened.ts'
import { addressOf, asShareList, checkLines, dnsRecord, fieldOf, nameAdvice, nameOf, proxyConfig, validName, type ProxyKind } from '../../lib/shares.ts'
import { Button, Segmented, Sheet, inputClass } from '../ui/primitives.tsx'

const PROXIES: { v: ProxyKind; label: string }[] = [
  { v: 'caddy', label: 'Caddy' },
  { v: 'traefik', label: 'Traefik' },
  { v: 'nginx', label: 'nginx' },
]

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="flex gap-3">
      <span aria-hidden className="mt-px flex size-6 shrink-0 items-center justify-center rounded-full border border-line-strong font-mono text-[12px] text-fg-2">{n}</span>
      <div className="min-w-0 flex-1">
        <h3 className="text-[14px] font-medium">{title}</h3>
        <div className="mt-1.5 space-y-2.5 text-[13px] leading-snug text-fg-2">{children}</div>
      </div>
    </section>
  )
}

function CopyBlock({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    if (await copyText(text)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    }
  }
  return (
    <div className="relative overflow-hidden rounded-2xl border border-line bg-elev">
      <pre className="max-h-64 overflow-auto p-3 pr-20 font-mono text-[12px] leading-relaxed text-fg">{text}</pre>
      <Button size="xs" variant="secondary" className="absolute right-2 top-2" onClick={() => void copy()} aria-label={`Copy ${label}`}>
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  )
}

/** The lines of a check, each with a mark: done, or what to fix. */
export function CheckResult({ check }: { check: ShareCheck }) {
  return (
    <ul className="space-y-2" aria-label="Check result" data-testid="share-check">
      {checkLines(check).map((l) => (
        <li key={l.title} className="flex gap-2.5">
          {l.ok ? <Check className="mt-0.5 size-4 shrink-0 text-fg-2" aria-label="Done" /> : <CircleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-label="To fix" />}
          <span className="min-w-0">
            <span className="block text-[13.5px] text-fg">{l.title}</span>
            {l.body && <span className="mt-0.5 block text-[12.5px] leading-snug text-fg-3">{l.body}</span>}
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Settings › Blueprints › Set up: the public address for links made for Anyone with the link, in
 * four steps. Pick a subdomain kept for this, point its DNS at the proxy, have the proxy forward only
 * /share/ to the hub, then save and check. The check asks the address for a probe only this hub can
 * answer, so a green result means links really arrive here, and that nothing else is let through.
 */
export function ShareSetup({ open, onClose, list, onSaved }: { open: boolean; onClose: () => void; list: ShareList; onSaved: (l: ShareList, c?: ShareCheck) => void }) {
  const [name, setName] = useState('')
  const [proxy, setProxy] = useState<ProxyKind>('caddy')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // the check, with the name it was for: typing another name hides it
  const [checked, setChecked] = useState<{ name: string; c: ShareCheck }>()
  // keyed on opening only: saving changes the address, and that mustn't wipe the check it starts
  useOpened(open, 'setup', () => {
    setName(list.address ? fieldOf(list.address) : '')
    setError('')
    setChecked(undefined)
    setBusy(false)
  })
  const clean = nameOf(name)
  const valid = validName(clean)
  const advice = nameAdvice(clean)
  const shown = valid ? clean : 'share.example.com'
  const check = checked?.name === name ? checked.c : undefined
  const record = dnsRecord(shown)
  const upstream = list.upstream ?? '127.0.0.1:4777'
  const saveAndCheck = async () => {
    setBusy(true)
    setError('')
    setChecked(undefined)
    try {
      let l = list
      if (!list.fromEnv && addressOf(name) !== (list.address ?? '')) {
        l = asShareList(await api.setShareAddress(addressOf(name)))
        // saved: Settings shows the new address even if the check then fails
        onSaved(l)
      }
      const c = await api.checkShareAddress()
      setChecked({ name, c })
      onSaved(l, c)
      if (c.reach.ok && c.wall.ok) toast({ title: 'Shared links work', body: `Links for anyone open at ${nameOf(c.address)}.`, tone: 'success' })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet
      open={open}
      onClose={onClose}
      wide
      title="Address for shared links"
      icon={<Globe className="size-4 text-fg-2" />}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>{check?.reach.ok ? 'Done' : 'Close'}</Button>
          <Button variant="primary" loading={busy} disabled={!valid} onClick={() => void saveAndCheck()}>{list.fromEnv || addressOf(name) === (list.address ?? '') ? 'Check' : 'Save and check'}</Button>
        </div>
      }
    >
      <div className="space-y-6">
        <p className="text-[13px] leading-snug text-fg-3">
          Links for <span className="text-fg-2">Anyone with the link</span> open at an address of their own, through a proxy you run. Only <code className="font-mono text-[12px]">/share/</code> links get
          through it: no app, no sign-in, nothing else from this hub. Links for your network keep working without any of this.
        </p>

        <Step n={1} title="Pick a subdomain">
          <p>One you keep for this, such as share.yourdomain.com. Not your main domain, and not the address you open Inyon at.</p>
          <input
            aria-label="Name for shared links"
            value={name}
            onChange={(e) => setName(e.target.value)}
            readOnly={list.fromEnv}
            placeholder="share.example.com"
            spellCheck={false}
            autoCapitalize="off"
            inputMode="url"
            className={clsx(inputClass, 'w-full font-mono text-[13px]', list.fromEnv && 'text-fg-2')}
          />
          {list.fromEnv && <p className="text-[12.5px] text-fg-3">Set by INYON_SHARE_ORIGIN on the hub.</p>}
          {advice && <p role="status" className="text-[12.5px] text-warn">{advice}</p>}
        </Step>

        <Step n={2} title="Point it at your proxy">
          <p>
            Add this record where <span className="text-fg">{record.zone}</span>'s DNS is kept, pointing at the public IP of the server your proxy runs on.
          </p>
          <div className="overflow-x-auto rounded-2xl border border-line">
            <table className="w-full text-left font-mono text-[12.5px]">
              <thead className="text-fg-3">
                <tr className="border-b border-line">
                  <th className="px-3 py-2 font-normal">Type</th>
                  <th className="px-3 py-2 font-normal">Name</th>
                  <th className="px-3 py-2 font-normal">Points to</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="px-3 py-2">{record.type}</td>
                  <td className="px-3 py-2">{record.name}</td>
                  <td className="px-3 py-2 font-sans text-fg-2">your proxy's public IP</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-[12.5px] text-fg-3">
            If DNS for a subdomain of {record.zone} is kept on its own, name the record from that zone instead. Use AAAA for an IPv6 address. On Cloudflare, set it to DNS only, or use Full (strict) SSL with the proxy turned on.
          </p>
        </Step>

        <Step n={3} title="Forward only /share/ to the hub">
          <p>Your proxy gets the certificate and passes /share/ links to the hub at {upstream}, keeping the Host header. Everything else on the name answers 404.</p>
          <Segmented size="sm" label="Proxy" value={proxy} onChange={setProxy} options={PROXIES} />
          <CopyBlock text={proxyConfig(proxy, shown, upstream)} label={`the ${proxy} example`} />
          <p className="text-[12.5px] text-fg-3">
            From a container, use the host's address instead of {upstream.split(':')[0]}. A password, an IP allowlist or a rate limit on the proxy are extra walls the hub doesn't need to know about.
          </p>
        </Step>

        <Step n={4} title={list.fromEnv ? 'Check it' : 'Save and check'}>
          <p>The hub asks the address for something only it can answer, so a pass means links really arrive here.</p>
          {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
          {check && <CheckResult check={check} />}
        </Step>
      </div>
    </Sheet>
  )
}
