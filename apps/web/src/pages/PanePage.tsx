import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { LogIn } from 'lucide-react'
import { AGENTS, type BackgroundTask, type SubagentInfo } from '@tether/protocol'
import { paneFromSlug } from '../lib/api.ts'
import { useStore } from '../lib/store.ts'
import { paneTitle } from '../lib/overview.ts'
import { SkinScope } from '../lib/skin.tsx'
import { ChatActionsContext } from '../lib/chatActions.ts'
import { Button, Empty, Spinner } from '../components/ui/primitives.tsx'
import { SignInSheet } from '../components/SignInSheet.tsx'
import { useSession } from '../components/session/useSession.ts'
import { SessionHeader } from '../components/session/SessionHeader.tsx'
import { ComposerControls } from '../components/session/ComposerControls.tsx'
import { SidePanel, SubagentSheet, TaskOutputSheet, type PanelTab } from '../components/session/Panels.tsx'
import { ActivitySheet, ControlsSheet } from '../components/session/MobileSheets.tsx'

// split out: markdown/highlighting and xterm are the heaviest parts of the app
const ChatView = lazy(() => import('../components/chat/ChatView.tsx').then((m) => ({ default: m.ChatView })))
const TerminalView = lazy(() => import('../components/terminal/TerminalView.tsx').then((m) => ({ default: m.TerminalView })))

const Loading = () => (
  <div className="flex flex-1 items-center justify-center">
    <Spinner className="size-5" />
  </div>
)

const useWide = () => {
  const [wide, setWide] = useState(() => matchMedia('(min-width: 1180px)').matches)
  useEffect(() => {
    const mq = matchMedia('(min-width: 1180px)')
    const on = () => setWide(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return wide
}

export function PanePage() {
  const params = useParams()
  const host = decodeURIComponent(params.host!)
  const pane = paneFromSlug(params.pane!)
  const [search, setSearch] = useSearchParams()
  const loaded = useStore((s) => s.hostsLoaded)
  const sidePanel = useStore((s) => s.settings.sidePanel)
  const setSettings = useStore((s) => s.setSettings)
  const s = useSession(host, pane)
  const { ref, info, agent } = s
  const view = (search.get('view') as 'chat' | 'terminal' | null) ?? (agent ? 'chat' : 'terminal')
  const wide = useWide()
  const [tab, setTab] = useState<PanelTab>('changes')
  const [sheet, setSheet] = useState<'controls' | 'activity' | null>(null)
  const [signIn, setSignIn] = useState(false)
  const [task, setTask] = useState<BackgroundTask | null>(null)
  const [sub, setSub] = useState<SubagentInfo | null>(null)
  const items = s.chat?.items ?? []

  const title = ref?.pane.label || info?.title || (ref ? paneTitle(ref) : 'Session')
  useEffect(() => {
    document.title = `${title} · Tether`
    return () => {
      document.title = 'Tether'
    }
  }, [title])

  const setView = (v: 'chat' | 'terminal') => setSearch(v === (agent ? 'chat' : 'terminal') ? {} : { view: v }, { replace: true })
  const actions = useMemo(
    () => ({
      openSubagent: (id: string) => {
        const a = s.info?.subagents.find((x) => x.toolUseId === id)
        setSub(a ?? { toolUseId: id, description: 'Subagent', status: 'done' })
      },
      openTask: setTask,
    }),
    [s.info?.subagents],
  )

  if (!ref && loaded && !info) {
    return (
      <div className="flex flex-1 flex-col">
        <Empty title="This pane is gone">The tmux pane was closed or its machine is unreachable.</Empty>
      </div>
    )
  }

  const showPanel = !!agent && wide && sidePanel

  return (
    <ChatActionsContext.Provider value={actions}>
      <SkinScope agent={agent} className="flex min-h-0 flex-1 flex-col bg-bg text-fg">
        <SessionHeader
          s={s}
          view={view}
          setView={setView}
          panelOpen={sidePanel}
          togglePanel={() => setSettings({ sidePanel: !sidePanel })}
          openSheet={(which) => {
            if (which === 'activity' && showPanel) setTab('activity')
            else setSheet(which)
          }}
        />
        {agent && ref?.host.signedIn && !ref.host.signedIn.includes(agent) && (
          <div className="flex shrink-0 items-center gap-3 border-b border-line bg-warn-soft/60 px-4 py-2 text-[13px]">
            <LogIn className="size-4 shrink-0 text-warn" />
            <span className="min-w-0 flex-1">{AGENTS[agent].name} isn't signed in on {ref.host.config.name}.</span>
            <Button size="xs" variant="primary" onClick={() => setSignIn(true)}>Sign in</Button>
          </div>
        )}
        {ref && <SignInSheet hostId={ref.host.config.id} hostName={ref.host.config.name} agent={signIn && agent ? agent : null} onClose={() => setSignIn(false)} />}
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <Suspense fallback={<Loading />}>
              {!ref && !info ? (
                <Loading />
              ) : view === 'chat' ? (
                <ChatView key={`${host}${pane}`} host={host} pane={pane} agent={agent} onTerminal={() => setView('terminal')} controls={agent ? <ComposerControls s={s} /> : undefined} />
              ) : (
                <TerminalView key={`${host}${pane}`} host={host} pane={pane} agent={agent} />
              )}
            </Suspense>
          </div>
          {showPanel && <SidePanel s={s} items={items} tab={tab} setTab={setTab} onTask={setTask} onSubagent={setSub} />}
        </div>
        <ControlsSheet s={s} open={sheet === 'controls'} onClose={() => setSheet(null)} />
        <ActivitySheet s={s} items={items} open={sheet === 'activity'} onClose={() => setSheet(null)} onTask={setTask} onSubagent={setSub} />
        <TaskOutputSheet host={host} task={task} onClose={() => setTask(null)} />
        <SubagentSheet s={s} sub={sub} onClose={() => setSub(null)} />
      </SkinScope>
    </ChatActionsContext.Provider>
  )
}
