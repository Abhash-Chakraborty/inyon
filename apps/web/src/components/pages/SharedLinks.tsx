import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Globe, Users } from 'lucide-react'
import { api, type ShareLink, type ShareList } from '../../lib/api.ts'
import { toast } from '../../lib/store.ts'
import { usePages } from '../../lib/pages.ts'
import { asShareList, audience, shareError, shareMeta } from '../../lib/shares.ts'
import { confirmAction } from '../Confirm.tsx'
import { Button, Waiting, inputClass } from '../ui/primitives.tsx'

/**
 * Settings › Blueprints, the sharing part: the hub's public address for shared links (empty unless
 * set, and read-only when INYON_SHARE_ORIGIN sets it), and every live shared link with Revoke and
 * Revoke all. Rows for the Blueprints card.
 */
export function SharedLinks() {
  const [list, setList] = useState<ShareList>()
  const [error, setError] = useState('')
  const [address, setAddress] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const pages = usePages((s) => s.pages)
  useEffect(() => {
    let live = true
    api.shares().then(
      (got) => {
        if (!live) return
        const l = asShareList(got)
        setList(l)
        setAddress(l.address ?? '')
      },
      (e) => live && setError(shareError(e as Error)),
    )
    return () => void (live = false)
  }, [])
  const nameOf = (s: ShareLink) => pages?.find((p) => p.host === s.host && p.slug === s.slug)?.name ?? s.slug
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaving(true)
    setSaveError('')
    try {
      const l = asShareList(await api.setShareAddress(address.trim()))
      setList(l)
      setAddress(l.address ?? '')
      toast({ title: l.address ? 'Address saved' : 'Address cleared', body: l.address ? `Links for anyone open at ${l.address}.` : 'New links stay on your network.', tone: 'success' })
    } catch (err) {
      setSaveError((err as Error).message)
    } finally {
      setSaving(false)
    }
  }
  const revoke = async (s: ShareLink) => {
    try {
      await api.revokeShare(s.id)
      setList((l) => (l ? { ...l, links: l.links.filter((x) => x.id !== s.id) } : l))
      toast({ title: 'Link revoked', body: `The link to “${nameOf(s)}” stops working now.`, tone: 'success' })
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
  const changed = address.trim() !== (list.address ?? '')
  return (
    <>
      <form onSubmit={save} className="px-4 py-3.5">
        <label htmlFor="share-address" className="block text-[14px]">Address for shared links</label>
        <div className="mt-0.5 text-[12.5px] leading-snug text-fg-3">
          {list.fromEnv ? 'Set by INYON_SHARE_ORIGIN on the hub.' : 'Links for anyone open here. Point a reverse proxy at the hub that forwards only /share/. Empty keeps every link on your network.'}
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-2">
          <input
            id="share-address"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            readOnly={list.fromEnv}
            placeholder="https://share.example.com"
            spellCheck={false}
            autoCapitalize="off"
            inputMode="url"
            className={clsx(inputClass, 'min-w-0 flex-[1_1_220px] font-mono text-[13px]', list.fromEnv && 'text-fg-2')}
          />
          {!list.fromEnv && (
            <Button type="submit" size="sm" loading={saving} disabled={!changed} aria-label="Save the address for shared links">Save</Button>
          )}
        </div>
        {saveError && <p role="alert" className="mt-2 text-[13px] text-danger">{saveError}</p>}
      </form>
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
                  <span className="block truncate text-[13.5px]">{nameOf(s)}</span>
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
