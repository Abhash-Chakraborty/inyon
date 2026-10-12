import { useState } from 'react'
import clsx from 'clsx'
import { Copy, LogOut, Shrink, RadioTower, RotateCcw, Target, Trash2 } from 'lucide-react'
import type { BackgroundTask, ChatItem, SubagentInfo } from '@inyon/protocol'
import { AgentLogo } from '../../lib/skin.tsx'
import { Segmented, Sheet, Toggle } from '../ui/primitives.tsx'
import { UsagePanel } from './Usage.tsx'
import { ActivityTab, ChangesTab, PreviewTab } from './Panels.tsx'
import { GoalSheet, modeMatches } from './ComposerControls.tsx'
import { currentModelId, type SessionModel } from './useSession.ts'
import { confirmAction } from '../Confirm.tsx'

const EFFORT_SHORT: Record<string, string> = { minimal: 'Min', low: 'Low', medium: 'Med', high: 'High', xhigh: 'X-high', max: 'Max', ultra: 'Ultra' }

export function ControlsSheet({ s, open, onClose }: { s: SessionModel; open: boolean; onClose: () => void }) {
  const [goalOpen, setGoalOpen] = useState(false)
  const { def, status, info, agent, actions } = s
  if (!def) return null
  const modelId = currentModelId(def, status, info?.model)
  const mode = s.screen?.mode ?? s.ref?.pane.agent?.mode ?? info?.mode
  const goalOn = !!info?.goal && !info.goal.met
  // while the agent asks something, it takes no commands: typing one would answer the question
  const asking = !!s.screen?.prompt
  const Label = ({ children }: { children: React.ReactNode }) => <div className="mb-2 text-[13px] font-medium text-fg-2">{children}</div>
  return (
    <>
      <Sheet open={open} onClose={onClose} title={def.name} icon={<AgentLogo kind={agent} size={24} />}>
        <div className="space-y-5">
          {asking && (
            <div className="rounded-2xl border border-warn/35 bg-warn-soft/50 px-3.5 py-2.5 text-[13px] text-fg-2">
              {def.name} is asking you something. Answer it in the chat, and the model, effort and mode controls come back.
            </div>
          )}
          {!asking && (
          <div className="min-w-0 space-y-5">
          {def.models.length > 0 && (
            <div>
              <Label>Model</Label>
              <div className="grid grid-cols-2 gap-2">
                {def.models.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => actions.setModel(m.id)}
                    className={clsx('rounded-2xl border px-3 py-2.5 text-left', m.id === modelId ? 'border-accent bg-accent-soft' : 'border-line hover:bg-hover')}
                  >
                    <div className="text-[14px] font-semibold">{m.label}</div>
                    {m.note && <div className="text-[12px] text-fg-3">{m.note}</div>}
                  </button>
                ))}
              </div>
            </div>
          )}
          {s.efforts.length > 0 && (
            <div>
              <Label>Reasoning effort</Label>
              <Segmented full value={status?.effort ?? ''} onChange={(v) => actions.setEffort(v)} options={s.efforts.map((e) => ({ v: e, label: EFFORT_SHORT[e] ?? e }))} />
            </div>
          )}
          {def.modes.length > 0 && (
            <div>
              <Label>{agent === 'opencode' ? 'Agent mode' : 'Permission mode'}</Label>
              <div className="flex flex-wrap gap-1.5">
                {def.modes.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => actions.setMode(m.id)}
                    className={clsx('h-9 rounded-xl border px-3 text-[13px]', modeMatches(mode, m.id, agent) ? 'border-accent bg-accent-soft font-medium' : 'border-line text-fg-2 hover:bg-hover')}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="divide-y divide-line rounded-3xl border border-line">
            {def.set.goal && (
              <div className="flex items-center gap-3 px-3.5 py-3">
                <Target className="size-4 text-fg-3" />
                <button type="button" onClick={() => setGoalOpen(true)} className="min-w-0 flex-1 text-left">
                  <div className="text-[14px] font-medium">Goal</div>
                  <div className="truncate text-[12px] text-fg-3">{goalOn ? info!.goal!.condition : info?.goal?.met ? 'Last goal met' : 'Keep working until a condition is met'}</div>
                </button>
                <Toggle on={goalOn} onChange={(v) => (v ? setGoalOpen(true) : actions.clearGoal())} label="Goal" />
              </div>
            )}
            {def.set.rc && (
              <div className="flex items-center gap-3 px-3.5 py-3">
                <RadioTower className="size-4 text-fg-3" />
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-medium">Remote Control</div>
                  <div className="truncate text-[12px] text-fg-3">{info?.rc ? `On · reachable from ${agent === 'antigravity' ? 'Antigravity' : 'claude.ai'}` : 'Off'}</div>
                </div>
                {info?.rc && (
                  <a href={info.rc.url} target="_blank" rel="noreferrer" className="rounded-full border border-line-strong px-2.5 py-1 text-[12.5px] font-medium">
                    Open
                  </a>
                )}
                <Toggle on={!!info?.rc} onChange={(v) => actions.rc(v)} label="Remote Control" />
              </div>
            )}
          </div>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(64px,1fr))] gap-2">
            {[
              def.set.compact && { label: 'Compact', icon: Shrink, on: actions.compact },
              (agent === 'claude' || agent === 'antigravity' || agent === 'codex' || agent === 'opencode') && { label: agent === 'opencode' ? 'Undo' : 'Rewind', icon: RotateCcw, on: actions.rewind },
              { label: 'Copy ID', icon: Copy, on: actions.copyId },
              def.set.clear && { label: 'Clear', icon: Trash2, on: async () => (await confirmAction({ title: 'Start a fresh conversation?', body: 'The current one is saved and can be resumed later.', yes: 'Clear' })) && actions.clear() },
              { label: 'Exit', icon: LogOut, on: actions.exit },
            ]
              .filter(Boolean)
              .map((a: any) => (
                <button key={a.label} type="button" onClick={a.on} className="flex h-16 flex-col items-center justify-center gap-1.5 rounded-2xl border border-line text-[12px] hover:bg-hover">
                  <a.icon className="size-4 text-fg-2" />
                  {a.label}
                </button>
              ))}
          </div>
          </div>
          )}
          <UsagePanel status={status} info={info} host={s.ref?.host} agent={agent} agentInfo={s.ref?.pane.agent} pane={s.ref?.pane.id} onCompact={def.set.compact ? actions.compact : undefined} />
        </div>
      </Sheet>
      <GoalSheet key={String(goalOpen)} s={s} open={goalOpen} onClose={() => setGoalOpen(false)} />
    </>
  )
}

export function ActivitySheet({ s, items, open, onClose, onTask, onSubagent }: { s: SessionModel; items: ChatItem[]; open: boolean; onClose: () => void; onTask: (t: BackgroundTask) => void; onSubagent: (a: SubagentInfo) => void }) {
  const [tab, setTab] = useState<'activity' | 'changes' | 'preview'>('activity')
  return (
    <Sheet open={open} onClose={onClose} wide title="Activity">
      <div className="-mx-1 mb-3">
        <Segmented full value={tab} onChange={setTab} options={[{ v: 'activity', label: 'Running' }, { v: 'changes', label: 'Changes' }, { v: 'preview', label: 'Preview' }]} />
      </div>
      <div className="-mx-5 flex min-h-[50dvh] flex-col">
        {tab === 'activity' && <ActivityTab s={s} onTask={onTask} onSubagent={onSubagent} />}
        {tab === 'changes' && <ChangesTab items={items} />}
        {tab === 'preview' && <PreviewTab storageKey={`${s.ref?.host.config.id}:${s.ref?.pane.id}`} suggestions={[]} />}
      </div>
    </Sheet>
  )
}
