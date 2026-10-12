import { useState } from 'react'
import clsx from 'clsx'
import { ChevronDown, Shield, Target } from 'lucide-react'
import { AGENTS, type AgentKind } from '@inyon/protocol'
import type { SessionModel } from './useSession.ts'
import { currentModelId } from './useSession.ts'
import { modelName } from '../../lib/format.ts'
import { Button, Field, Menu, Sheet, inputClass } from '../ui/primitives.tsx'

export const EFFORT_LABEL: Record<string, string> = { default: 'Default', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'X-high', max: 'Max', ultra: 'Ultra' }

function Chip({ children, onClick, title, tone, open, innerRef }: { children: React.ReactNode; onClick?: () => void; title?: string; tone?: 'goal'; open?: boolean; innerRef?: React.Ref<HTMLButtonElement> }) {
  return (
    <button
      ref={innerRef}
      type="button"
      title={title}
      onClick={onClick}
      onMouseDown={(e) => e.preventDefault()}
      className={clsx(
        'inline-flex h-8 max-w-[220px] shrink-0 items-center gap-1.5 rounded-[9px] px-2 text-[12.5px] font-medium transition-colors',
        tone === 'goal' ? 'text-accent-text hover:bg-accent-soft' : 'text-fg-2 hover:bg-hover hover:text-fg',
        open && 'bg-hover text-fg',
      )}
    >
      {children}
    </button>
  )
}

export function EffortBars({ level, levels }: { level?: string; levels: string[] }) {
  const i = level ? levels.indexOf(level) : -1
  return (
    <span className="flex items-end gap-[2px]" aria-hidden>
      {[0, 1, 2, 3].map((n) => (
        <span key={n} className={clsx('w-[3px] rounded-[1px]', n <= Math.round((i / Math.max(1, levels.length - 1)) * 3) && i >= 0 ? 'bg-accent' : 'bg-line-strong')} style={{ height: 5 + n * 2.5 }} />
      ))}
    </span>
  )
}

/** Model, effort, permission mode and goal, in the composer where you use them. */
export function ComposerControls({ s }: { s: SessionModel }) {
  const [goalOpen, setGoalOpen] = useState(false)
  const { def, status, info, agent, actions } = s
  if (!agent || !def) return null
  const modelId = currentModelId(def, status, info?.model)
  // a catalog id (OpenCode's "provider/model") reads better as its label, without the provider prefix
  const listed = def.models.find((m) => m.id === modelId)?.label.split(' · ').pop()
  const modelLabel = listed ?? status?.model ?? (info?.model ? modelName(info.model) : 'Default model')
  const mode = s.screen?.mode ?? s.ref?.pane.agent?.mode ?? info?.mode
  const goal = info?.goal
  const goalOn = !!goal && !goal.met
  return (
    <>
      {def.models.length > 0 && (
        <Menu
          name="model"
          header="Model"
          items={def.models.map((m) => ({ key: m.id, label: m.label, hint: m.note, selected: m.id === modelId, onSelect: () => actions.setModel(m.id) }))}
          trigger={({ toggle, ref, open }) => (
            <Chip innerRef={ref} onClick={toggle} open={open} title="Model">
              <span className="truncate">{modelLabel}</span>
              <ChevronDown className="size-3 shrink-0 opacity-60" />
            </Chip>
          )}
        />
      )}
      {s.efforts.length > 0 && (
        <Menu
          name="effort"
          header="Reasoning effort"
          width={220}
          items={[
            // OpenCode runs a model without a variant unless one is picked
            ...(agent === 'opencode' ? [{ key: 'default', label: 'Default', selected: !status?.effort, onSelect: () => actions.setEffort('default') }] : []),
            ...s.efforts.map((e) => ({ key: e, label: EFFORT_LABEL[e] ?? e, selected: status?.effort === e, onSelect: () => actions.setEffort(e) })),
          ]}
          trigger={({ toggle, ref, open }) => (
            <Chip innerRef={ref} onClick={toggle} open={open} title={`Reasoning effort${status?.effort ? `: ${EFFORT_LABEL[status.effort] ?? status.effort}` : ''}`}>
              <EffortBars level={status?.effort} levels={s.efforts} />
              <span>{status?.effort ? EFFORT_LABEL[status.effort] ?? status.effort : 'Default'}</span>
            </Chip>
          )}
        />
      )}
      {def.modes.length > 0 && (
        <Menu
          name="mode"
          header={agent === 'opencode' ? 'Agent mode' : 'Permission mode'}
          width={220}
          items={def.modes.map((m) => ({ key: m.id, label: m.label, selected: modeMatches(mode, m.id, agent), onSelect: () => actions.setMode(m.id) }))}
          trigger={({ toggle, ref, open }) => (
            <Chip innerRef={ref} onClick={toggle} open={open} title={`${agent === 'opencode' ? 'Agent mode' : 'Permission mode'}: ${modeLabel(mode, agent)}`}>
              <Shield className="size-3.5 shrink-0" />
              <span className="hidden truncate sm:inline">{modeLabel(mode, agent)}</span>
            </Chip>
          )}
        />
      )}
      {def.set.goal && (
        <Chip tone={goalOn ? 'goal' : undefined} onClick={() => setGoalOpen(true)} title={goalOn ? `Goal: ${goal!.condition}` : 'Set a goal'}>
          <Target className="size-3.5 shrink-0" />
          {goalOn ? <span className="max-w-[140px] truncate">{goal!.condition}</span> : <span className="hidden sm:inline">Goal</span>}
        </Chip>
      )}
      <GoalSheet key={String(goalOpen)} s={s} open={goalOpen} onClose={() => setGoalOpen(false)} />
    </>
  )
}

export function GoalSheet({ s, open, onClose }: { s: SessionModel; open: boolean; onClose: () => void }) {
  const goal = s.info?.goal
  const active = !!goal && !goal.met
  const [text, setText] = useState(goal?.condition ?? '')
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Goal"
      icon={<Target className="size-4 text-fg-3" />}
      footer={
        <div className="flex items-center gap-2">
          {active && s.def?.set.clearGoal && (
            <Button variant="danger" onClick={() => (s.actions.clearGoal(), onClose())}>
              Turn off
            </Button>
          )}
          <Button className="ml-auto" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="accent" disabled={!text.trim()} onClick={() => (s.actions.setGoal(text.trim()), onClose())}>
            {active ? 'Update goal' : 'Set goal'}
          </Button>
        </div>
      }
    >
      <p className="mb-4 text-[13.5px] leading-relaxed text-fg-2">The agent checks this condition before it stops, and keeps going until it's met.</p>
      {goal && (
        <div className={clsx('mb-4 rounded-[12px] border px-3.5 py-2.5 text-[13px]', goal.met ? 'border-ok/30 bg-ok-soft/60' : 'border-line bg-sunken')}>
          <div className="font-medium">{goal.met ? 'Last goal was met' : 'Active goal'}</div>
          <div className="mt-0.5 line-clamp-3 text-fg-2">{goal.condition}</div>
          {goal.met && goal.reason && <div className="mt-1 line-clamp-2 text-[12px] text-fg-3">{goal.reason}</div>}
        </div>
      )}
      <Field label={active ? 'Change the goal' : 'New goal'}>
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="All tests pass and the PR is open" className={clsx(inputClass, 'h-auto resize-none py-2.5 leading-relaxed')} />
      </Field>
    </Sheet>
  )
}

/** Codex names its modes itself (permission presets); the others share Claude's names. */
const OWN_MODES = new Set(['codex', 'copilot', 'opencode'])

export function modeLabel(mode?: string, agent?: AgentKind) {
  if (agent && OWN_MODES.has(agent)) return AGENTS[agent].modes.find((m) => m.id === (mode || 'default'))?.label ?? mode ?? 'Default'
  if (!mode || /^(manual|default|normal)$/.test(mode)) return 'Ask each time'
  if (/accept/.test(mode)) return 'Accept edits'
  if (/plan/.test(mode)) return 'Plan'
  if (/bypass/.test(mode)) return 'Bypass permissions'
  if (/auto/.test(mode)) return 'Auto'
  return mode
}

export function modeMatches(mode: string | undefined, id: string, agent?: AgentKind) {
  if (agent && OWN_MODES.has(agent)) return (mode || 'default') === id
  const l = modeLabel(mode)
  return (
    (id === 'default' && l === 'Ask each time') ||
    (id === 'acceptEdits' && l === 'Accept edits') ||
    (id === 'plan' && l === 'Plan') ||
    (id === 'auto' && l === 'Auto') ||
    (id === 'bypassPermissions' && l === 'Bypass permissions')
  )
}
