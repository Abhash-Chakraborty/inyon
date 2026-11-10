import type { PairedHub } from '../lib/hubs.ts'
import { forgetHub } from '../lib/hubs.ts'
import { isDown, useConnLog } from '../lib/connlog.ts'
import { toast } from '../lib/store.ts'
import { Logo } from './AppShell.tsx'
import { LastDrop, hubLogId, openConnectHelp } from './ConnectSheet.tsx'
import { Button } from './ui/primitives.tsx'

/**
 * The hubs this phone is paired with, one row each: its name and address, its last drop,
 * Can't connect? while it's out of reach, and Forget. In Settings, and on the Computers page while
 * a hub hasn't answered yet, so a hub that never will can be taken off where it's waited for.
 */
export function HubRows({ hubs }: { hubs: PairedHub[] }) {
  useConnLog()
  return (
    <>
      {hubs.map((h) => (
        <div key={h.id} className="flex items-center gap-3 px-4 py-3 text-[14px]">
          <Logo className="size-[18px]" />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{h.name}</span>
            <span className="block truncate font-mono text-[12px] text-fg-3">{h.url.replace(/^https?:\/\//, '')}{h.version ? ` · ${h.version}` : ''}</span>
            <LastDrop id={hubLogId(h.id)} />
          </span>
          {isDown(hubLogId(h.id)) && (
            <Button size="sm" variant="ghost" onClick={() => openConnectHelp(hubLogId(h.id))}>
              Can't connect?
            </Button>
          )}
          <Button size="sm" variant="ghost" aria-label={`Forget ${h.name}`} onClick={() => (forgetHub(h.id), toast({ title: `${h.name} forgotten`, body: 'Its machines are gone from this app. The hub still lists this phone until you forget it there too.', tone: 'success' }))}>
            Forget
          </Button>
        </div>
      ))}
    </>
  )
}
