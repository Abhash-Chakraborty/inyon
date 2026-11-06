import { useEffect, useState } from 'react'
import { Globe, Users } from 'lucide-react'
import { api, type ShareCheck, type ShareLink, type ShareList } from '../../lib/api.ts'
import { toast } from '../../lib/store.ts'
import { usePages } from '../../lib/pages.ts'
import { asShareList, audience, nameOf, shareError, shareMeta } from '../../lib/shares.ts'
import { confirmAction } from '../Confirm.tsx'
import { Button, Waiting } from '../ui/primitives.tsx'
import { CheckResult, ShareSetup } from './ShareSetup.tsx'

/**
 * Settings › Blueprints, the sharing part: the hub's public address for shared links (off unless
 * set up, and read-only when INYON_SHARE_ORIGIN sets it) with Set up, Check and Turn off, and every
 * live shared link with Revoke and Revoke all. Rows for the Blueprints card.
 */
export function SharedLinks() {
  const [list, setList] = useState<ShareList>()
  const [error, setError] = useState('')
  const [setup, setSetup] = useState(false)
  const [check, setCheck] = useState<ShareCheck>()
  const [checking, setChecking] = useState(false)
  const pages = usePages((s) => s.pages)
  useEffect(() => {
    let live = true
    api.shares().then(
      (got) => {
        if (!live) return
        setList(asShareList(got))
      },
      (e) => live && setError(shareError(e as Error)),
    )
    return () => void (live = false)
  }, [])
  const pageName = (s: ShareLink) => pages?.find((p) => p.host === s.host && p.slug === s.slug)?.name ?? s.slug
  const runCheck = async () => {
    setChecking(true)
    try {
      setCheck(await api.checkShareAddress())
    } catch (err) {
      toast({ title: "Couldn't check the address", body: (err as Error).message, tone: 'error' })
    } finally {
      setChecking(false)
    }
  }
  const turnOff = async () => {
    const ok = await confirmAction({ title: 'Turn off the public address?', body: 'Links for anyone stop opening there, and new links stay on your network. Your proxy and DNS record stay as they are.', yes: 'Turn off', danger: true })
    if (!ok) return
    try {
      setList(asShareList(await api.setShareAddress('')))
      setCheck(undefined)
      toast({ title: 'Public address off', body: 'New links stay on your network.', tone: 'success' })
    } catch (err) {
      toast({ title: "Couldn't turn it off", body: (err as Error).message, tone: 'error' })
    }
  }
  const revoke = async (s: ShareLink) => {
    try {
      await api.revokeShare(s.id)
      setList((l) => (l ? { ...l, links: l.links.filter((x) => x.id !== s.id) } : l))
      toast({ title: 'Link revoked', body: `The link to “${pageName(s)}” stops working now.`, tone: 'success' })
    } catch (err) {
      toast({ title: "Couldn't revoke the link", body: (err as Error).message, tone: 'error' })
    }
  }
  const revokeAll = async () => {
    const n = list?.links.length ?? 0
    const ok = await confirmAction({ title: `Revoke ${n === 1 ? 'the shared link' : `all ${n} shared links`}?`, body: 'Whoever has them can no longer open those blueprints. Links in the app keep working.', yes: 'Revoke all', danger: true })
    if (!ok) return
    try {
      await api.revokeAllShares()
      setList((l) => (l ? { ...l, links: [] } : l))
      toast({ title: 'Shared links revoked', tone: 'success' })
    } catch (err) {
      toast({ title: "Couldn't revoke them", body: (err as Error).message, tone: 'error' })
    }
  }
  if (error) {
    return (
      <div className="px-4 py-3.5">
        <div className="text-[14px]">Shared links</div>
        <div className="mt-0.5 text-[12.5px] text-fg-3">{error}</div>
      </div>
    )
  }
  if (!list) return <Waiting shape="rows" count={1} label="Loading shared links" className="px-4 py-3.5" />
  const status = !list.address ? 'Off. Links stay on your network until you set one up.' : !check ? 'Links for anyone open here.' : check.reach.ok && check.wall.ok ? 'Checked: links reach this hub.' : 'The last check found something to fix.'
  return (
    <>
      <div className="px-4 py-3.5" id="share-address">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="min-w-0 flex-[1_1_220px]">
            <div className="text-[14px]">Address for shared links</div>
            <div className="mt-0.5 text-[12.5px] leading-snug text-fg-3">
              {list.address && <code className="font-mono text-[12.5px] text-fg-2">{nameOf(list.address)}</code>}
              {list.address && ' · '}
              {status}
              {list.fromEnv && ' Set by INYON_SHARE_ORIGIN.'}
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {list.address && <Button size="sm" variant="secondary" loading={checking} onClick={() => void runCheck()}>Check</Button>}
            <Button size="sm" variant={list.address ? 'ghost' : 'secondary'} onClick={() => setSetup(true)}>{!list.address ? 'Set up' : list.fromEnv ? 'Guide' : 'Change'}</Button>
            {list.address && !list.fromEnv && <Button size="sm" variant="ghost" onClick={() => void turnOff()}>Turn off</Button>}
          </div>
        </div>
        {check && <div className="mt-3"><CheckResult check={check} /></div>}
        <ShareSetup open={setup} onClose={() => setSetup(false)} list={list} onSaved={(l, c) => { setList(l); setCheck(c) }} />
      </div>
      <div className="px-4 py-3.5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="min-w-0 flex-[1_1_220px]">
            <div className="text-[14px]">Shared links</div>
            <div className="mt-0.5 text-[12.5px] leading-snug text-fg-3">{list.links.length ? 'Live links to your blueprints, on every machine.' : 'None live. Share a blueprint from its ⋯ menu.'}</div>
          </div>
          {list.links.length > 0 && <Button size="sm" variant="danger" onClick={() => void revokeAll()}>Revoke all</Button>}
        </div>
        {list.links.length > 0 && (
          <ul className="mt-3 divide-y divide-line overflow-hidden rounded-2xl border border-line">
            {list.links.map((s) => (
              <li key={s.id} className="flex items-center gap-3 px-3.5 py-2.5">
                <span className="shrink-0 text-fg-3" title={audience(s)}>{s.public ? <Globe className="size-4" /> : <Users className="size-4" />}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px]">{pageName(s)}</span>
                  <span className="block truncate font-mono text-[12px] text-fg-3">{audience(s)} · {shareMeta(s)}</span>
                </span>
                <Button size="xs" variant="ghost" onClick={() => void revoke(s)}>Revoke</Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  )
}
