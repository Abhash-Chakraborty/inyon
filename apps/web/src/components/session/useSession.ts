import { useMemo } from 'react'
import { AGENTS, chatKey, type AgentKind, type AgentStatus } from '@tether/protocol'
import { api } from '../../lib/api.ts'
import { toast, useStore } from '../../lib/store.ts'
import { allPanes } from '../../lib/overview.ts'
import { copyText } from '../../lib/clipboard.ts'
import { useAgentCatalog } from './useAgentCatalog.ts'
import { confirmAction } from '../Confirm.tsx'

/** Everything a session view needs: pane ref, live status, transcript summary, and actions. */
export function useSession(host: string, pane: string) {
  const hosts = useStore((s) => s.hosts)
  const chat = useStore((s) => s.chats[chatKey(host, pane)])
  const ref = useMemo(() => allPanes(hosts).find((r) => r.host.config.id === host && r.pane.id === pane), [hosts, host, pane])
  const agent: AgentKind | undefined = ref?.pane.agent?.kind ?? chat?.info?.agent
  const catalog = useAgentCatalog(host, pane, agent)
  const def = useMemo(() => agent ? { ...AGENTS[agent], models: catalog?.models ?? AGENTS[agent].models } : undefined, [agent, catalog])
  const info = chat?.info
  const live = ref?.pane.agent?.status
  // OpenCode's numbers come from its transcript, but the model and variant you just picked show
  // first on its footer (or its API), which the pane reports
  const reported: AgentStatus | undefined = agent === 'copilot'
    ? info?.status ?? live
    : agent === 'opencode' && info?.status
      ? { ...info.status, ...(live?.model && { model: live.model, modelId: live.modelId, effort: live.effort }), ...(live?.contextSize && { contextSize: live.contextSize }) }
      : live
  // a session that isn't reporting still has a known model, and so a known window size
  const selectedModel = def?.models.find((m) => m.id === currentModelId(def, reported, info?.model))
  const status = useMemo(() => {
    if (!reported) return reported
    const size = !reported.contextSize && selectedModel?.context
    // "default" on the footer means the model's own default level
    const effort = reported.effort === 'default' && selectedModel?.defaultEffort
    return size || effort ? { ...reported, ...(size && { contextSize: size }), ...(effort && { effort }) } : reported
  }, [reported, selectedModel])
  const screen = chat?.screen
  const efforts = def?.set.effort || selectedModel?.variants ? selectedModel?.efforts ?? def?.efforts ?? [] : []

  const selectModel = (id: string) => {
    const model = def?.models.find((m) => m.id === id)
    const variants = model?.variants
    const variant = variants?.[status?.effort ?? ''] ?? Object.values(variants ?? {})[0]
    return def?.set.model && setting(def.set.model(variant ?? id, status?.effort), 'Could not switch model')
  }

  const run = async (label: string, fn: () => Promise<unknown>) => {
    try {
      await fn()
    } catch (e) {
      toast({ title: label, body: (e as Error).message, tone: 'error' })
    }
  }
  const send = (text: string, label = 'Could not send') => run(label, () => api.send(host, pane, text))
  // a setting goes to the agent as a slash command, but the chat doesn't show it as a message
  const setting = (text: string, label: string) => run(label, () => api.setting(host, pane, text))

  const actions = {
    send,
    setModel: selectModel,
    setEffort: (level: string) => selectedModel?.variants?.[level]
      ? setting(`/model ${selectedModel.variants[level]}`, 'Could not change effort')
      : def?.set.effort && setting(def.set.effort(level), 'Could not change effort'),
    setMode: (mode: string) => run('Could not switch mode', () => api.mode(host, pane, mode)),
    setGoal: (text: string) => def?.set.goal && setting(def.set.goal(text), 'Could not set goal'),
    clearGoal: () => def?.set.clearGoal && setting(def.set.clearGoal, 'Could not clear goal'),
    compact: () => def?.set.compact && send(def.set.compact, 'Could not compact'),
    clear: () => def?.set.clear && send(def.set.clear, 'Could not clear'),
    rc: (on: boolean) =>
      run(on ? 'Could not turn on Remote Control' : 'Could not turn off Remote Control', async () => {
        await api.rc(host, pane, on)
        toast({ title: on ? 'Remote Control on' : 'Remote Control off', tone: 'success' })
      }),
    rewind: async () => {
      if (agent === 'claude' || agent === 'antigravity') return send('/rewind')
      if (agent === 'opencode') {
        if (!(await confirmAction({ title: 'Undo your last message?', body: 'OpenCode reverts it and its file changes, and puts the message back in its input box.', yes: 'Undo', danger: true }))) return
        return send('/undo', 'Could not undo')
      }
      if (agent !== 'codex' || !(await confirmAction({ title: 'Rewind your last message?', body: 'Codex forgets it and its reply. To go further back, use the rewind button under any message.', yes: 'Rewind', danger: true }))) return
      return run('Could not rewind', async () => {
        await api.rewind(host, pane)
        toast({ title: 'Conversation rewound', tone: 'success' })
      })
    },
    interrupt: () => run('Could not interrupt', () => api.interrupt(host, pane)),
    exit: async () => {
      if (!def || !(await confirmAction({ title: `Exit ${def.name}?`, body: 'The conversation is saved; the pane goes back to its shell.', yes: 'Exit' }))) return
      return run(`Could not exit ${def.name}`, async () => {
        await api.exit(host, pane)
        toast({ title: `${def.name} exited`, tone: 'success' })
      })
    },
    copyId: async () => {
      const id = info?.sessionId ?? ref?.pane.agent?.sessionId
      if (!id) return
      if (await copyText(id)) toast({ title: 'Session ID copied', tone: 'success' })
      else toast({ title: 'Session ID', body: id, tone: 'info' })
    },
  }

  return { ref, agent, def, status, info, screen, chat, actions, efforts, catalog }
}

export type SessionModel = ReturnType<typeof useSession>

/** Claude reports "Opus 5.5"; map to the alias we send. */
export function currentModelId(def: (typeof AGENTS)[AgentKind] | undefined, status?: AgentStatus, model?: string) {
  if (!def) return undefined
  const label = (status?.model ?? model ?? '').toLowerCase()
  return def.models.find((m) => label.includes(m.label.toLowerCase()) || label.includes(m.id.toLowerCase()) || (status?.modelId ?? '').includes(m.id))?.id
}
