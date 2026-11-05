import { useCallback, useState } from 'react'
import { Link } from 'react-router-dom'
import clsx from 'clsx'
import { Check, Copy, Globe, Share2, Users } from 'lucide-react'
import { api, type ShareLink, type ShareList } from '../../lib/api.ts'
import { toast } from '../../lib/store.ts'
import { copyText } from '../../lib/clipboard.ts'
import { useOpened } from '../../lib/useOpened.ts'
import { arrowStep, Button, Segmented, Sheet, Waiting } from '../ui/primitives.tsx'
import { SHARE_DAYS, asShareList, audience, shareError, shareMeta, shareUrl } from '../../lib/shares.ts'
import type { Page } from '../../lib/pages.ts'

type Who = 'network' | 'public'

/** The host part of an address, for "Opens at share.example.com". */
const hostOf = (address: string) => {
  try {
    return new URL(address).host
  } catch {
    return address
  }
}

/**
 * "Share…": a link to one blueprint for someone outside the app. People on your network is the
 * default and uses the hub's own address; Anyone with the link needs the hub's public address
 * for shared links, set in Settings. The link is shown once, since the hub keeps only its hash;
 * the page's live links are listed under it, each with Revoke.
 */
export function ShareSheet({ page, open, onClose }: { page: Page; open: boolean; onClose: () => void }) {
  const [list, setList] = useState<ShareList>()
  const [loadError, setLoadError] = useState('')
  const [who, setWho] = useState<Who>('network')
  const [days, setDays] = useState<string>('7')
  const [made, setMade] = useState<{ url: string; public: boolean }>()
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    try {
      setList(asShareList(await api.pageShares(page.host, page.slug)))
      setLoadError('')
    } catch (e) {
      setLoadError(shareError(e as Error))
    }
  }, [page.host, page.slug])
  useOpened(open, page.id, () => {
    setWho('network')
    setDays('7')
    setMade(undefined)
    setCopied(false)
    setError('')
    setList(undefined)
    setLoadError('')
    void load()
  })
  const address = list?.address ?? null
  const create = async () => {
    setBusy(true)
    setError('')
    try {
      const s = await api.sharePage(page.host, page.slug, { public: who === 'public', days: Number(days) })
      const url = shareUrl(page.host, s.url)
      setMade({ url, public: s.public })
      setCopied(false)
      if (await copyText(url)) setCopied(true)
      void load()
    } catch (e) {
      setError(shareError(e as Error))
    } finally {
      setBusy(false)
    }
  }
  const copy = async () => {
    if (made && (await copyText(made.url))) {
      setCopied(true)
      toast({ title: 'Copied the link', tone: 'success' })
    }
  }
  const revoke = async (s: ShareLink) => {
    try {
      await api.unsharePage(page.host, page.slug, s.id)
      setList((l) => (l ? { ...l, links: l.links.filter((x) => x.id !== s.id) } : l))
      toast({ title: 'Link revoked', body: 'It stops working now.', tone: 'success' })
    } catch (e) {
      toast({ title: "Couldn't revoke the link", body: (e as Error).message, tone: 'error' })
    }
  }
  const choices: { v: Who; icon: React.ReactNode; title: string; hint: React.ReactNode; off?: boolean }[] = [
    { v: 'network', icon: <Users className="size-4" />, title: 'People on your network', hint: "Uses this hub's address, for devices that already reach it." },
    {
      v: 'public',
      icon: <Globe className="size-4" />,
      title: 'Anyone with the link',
      off: !address,
      hint: address ? (
        `Opens at ${hostOf(address)}, through the proxy you set up.`
      ) : (
        <>
          Set an address for shared links in{' '}
          <Link to="/settings#blueprints" onClick={onClose} className="underline decoration-line-strong underline-offset-2 hover:text-fg">
            Settings › Blueprints
          </Link>{' '}
          first.
        </>
      ),
    },
  ]
  const pick = (v: Who) => {
    if (choices.find((c) => c.v === v)?.off) return
    setWho(v)
  }
  const onKey = (e: React.KeyboardEvent) => {
    const at = choices.findIndex((c) => c.v === who)
    const next = arrowStep(e.key, at, choices.length)
    if (next === undefined) return
    e.preventDefault()
    pick(choices[next]!.v)
  }
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={`Share “${page.name}”`}
      icon={<Share2 className="size-4 text-fg-2" />}
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Done</Button>
          <Button variant="primary" loading={busy} disabled={!list} onClick={() => void create()}>Create link</Button>
        </div>
      }
    >
      <div className="space-y-5">
        <div>
          <div id="share-who" className="mb-1.5 text-[12.5px] font-medium text-fg-2">Who can open it</div>
          <div role="radiogroup" aria-labelledby="share-who" onKeyDown={onKey} className="divide-y divide-line overflow-hidden rounded-2xl border border-line">
            {choices.map((c) => {
              const on = who === c.v
              return (
                <div
                  key={c.v}
                  role="radio"
                  aria-checked={on}
                  aria-disabled={c.off || undefined}
                  tabIndex={on ? 0 : -1}
                  onClick={() => pick(c.v)}
                  className={clsx('flex min-h-[56px] items-start gap-3 px-3.5 py-3 outline-none focus-visible:bg-hover', c.off ? 'cursor-default' : 'cursor-pointer hover:bg-hover/60')}
                >
                  <span className={clsx('mt-0.5 shrink-0', c.off ? 'text-fg-3' : 'text-fg-2')}>{c.icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className={clsx('block text-[14px]', c.off && 'text-fg-3')}>{c.title}</span>
                    <span className="mt-0.5 block text-[12.5px] leading-snug text-fg-3">{c.hint}</span>
                  </span>
                  <span aria-hidden className={clsx('mt-1 flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors', on ? 'border-fg bg-fg' : 'border-line-strong', c.off && 'opacity-50')}>
                    {on && <span className="size-1.5 rounded-full bg-bg" />}
                  </span>
                </div>
              )
            })}
          </div>
          {who === 'public' && <p className="mt-2 text-[12.5px] leading-snug text-fg-3">Every file in the blueprint's folder opens with the link, research notes too.</p>}
        </div>

        <div>
          <div className="mb-1.5 text-[12.5px] font-medium text-fg-2">Expires after</div>
          <Segmented size="sm" label="Expires after" value={days} onChange={setDays} options={SHARE_DAYS.map((d) => ({ v: d.v, label: d.label }))} />
        </div>

        {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}

        {made && (
          <div className="animate-pop rounded-2xl border border-line-strong bg-elev p-3 shadow-card">
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate font-mono text-[12.5px]" title={made.url} data-testid="share-url">{made.url}</code>
              <Button size="sm" variant="secondary" onClick={() => void copy()}>
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <p className="mt-2 text-[12px] leading-snug text-fg-3">Copy it now: the hub keeps only a fingerprint of it, so it can't show it again.</p>
          </div>
        )}

        <div>
          <div className="mb-1.5 text-[12.5px] font-medium text-fg-2">Live links</div>
          {!list && !loadError ? (
            <Waiting shape="rows" count={1} label="Loading shared links" className="py-2" />
          ) : loadError ? (
            <p className="text-[13px] text-fg-3">{loadError}</p>
          ) : !list?.links.length ? (
            <p className="text-[13px] text-fg-3">None yet.</p>
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line">
              {list.links.map((s) => (
                <li key={s.id} className="flex items-center gap-3 px-3.5 py-2.5">
                  <span className="shrink-0 text-fg-3">{s.public ? <Globe className="size-4" /> : <Users className="size-4" />}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px]">{audience(s)}</span>
                    <span className="block truncate font-mono text-[12px] text-fg-3">{shareMeta(s)}</span>
                  </span>
                  <Button size="xs" variant="ghost" onClick={() => void revoke(s)}>Revoke</Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Sheet>
  )
}
