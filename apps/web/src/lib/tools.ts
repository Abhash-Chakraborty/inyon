import {
  Bot, FileCode2, FilePen, FilePlus2, FileSearch, FileText, FolderSearch, Globe, ListChecks, type LucideIcon,
  Plug, Search, Sparkles, SquareTerminal, Wrench, Workflow, MessageCircleQuestion, ClipboardList, Bell, Timer,
} from 'lucide-react'
import type { ToolCall } from './chat.ts'
import { shortPath } from './format.ts'

export interface ToolSummary {
  icon: LucideIcon
  verb: string
  target?: string
  /** monospace target (commands, patterns) */
  mono?: boolean
  stats?: { add: number; del: number }
}

function patchStats(call: ToolCall) {
  const patch = call.result?.meta?.patch
  if (!patch) return undefined
  let add = 0
  let del = 0
  for (const h of patch)
    for (const l of h.lines) {
      if (l.startsWith('+')) add++
      else if (l.startsWith('-')) del++
    }
  return { add, del }
}

const host = (u: string) => {
  try {
    return new URL(u).host + new URL(u).pathname.replace(/\/$/, '')
  } catch {
    return u
  }
}

export function summarize(call: ToolCall): ToolSummary {
  const i = call.input ?? {}
  const done = !!call.result
  switch (call.name) {
    case 'Bash':
      return { icon: SquareTerminal, verb: done ? 'Ran' : 'Running', target: i.description || firstLine(i.command), mono: !i.description }
    case 'BashOutput':
    case 'TaskOutput':
      return { icon: SquareTerminal, verb: 'Read output', target: i.bash_id || i.task_id }
    case 'Read':
      return { icon: FileText, verb: 'Read', target: shortPath(i.file_path, 60) }
    case 'Edit':
    case 'MultiEdit':
      return { icon: FilePen, verb: done ? 'Edited' : 'Editing', target: shortPath(i.file_path, 60), stats: patchStats(call) }
    case 'Write':
      return {
        icon: call.result?.meta?.created === false ? FilePen : FilePlus2,
        verb: done ? (call.result?.meta?.created === false ? 'Rewrote' : 'Created') : 'Writing',
        target: shortPath(i.file_path, 60),
        stats: patchStats(call),
      }
    case 'NotebookEdit':
      return { icon: FileCode2, verb: 'Edited notebook', target: shortPath(i.notebook_path, 60) }
    case 'Grep':
      return { icon: Search, verb: 'Searched', target: i.pattern, mono: true }
    case 'Glob':
      return { icon: FolderSearch, verb: 'Found files', target: i.pattern, mono: true }
    case 'LS':
      return { icon: FolderSearch, verb: 'Listed', target: shortPath(i.path, 60) }
    case 'WebFetch':
      return { icon: Globe, verb: 'Fetched', target: host(i.url ?? '') }
    case 'WebSearch':
      return { icon: Globe, verb: 'Searched the web', target: i.query }
    case 'Task':
    case 'Agent':
      return { icon: Bot, verb: 'Agent', target: i.description || i.subagent_type }
    case 'Skill':
      return { icon: Sparkles, verb: 'Skill', target: i.skill || i.command }
    case 'Workflow':
      return { icon: Workflow, verb: 'Workflow', target: i.name || 'script' }
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'TaskList':
      return { icon: ListChecks, verb: 'Tasks', target: i.subject || i.title || i.status }
    case 'ToolSearch':
      return { icon: FileSearch, verb: 'Loaded tools', target: i.query }
    case 'Monitor':
      return { icon: Timer, verb: 'Monitor', target: i.description || firstLine(i.command) }
    case 'PushNotification':
      return { icon: Bell, verb: 'Notified', target: i.title || i.message }
    case 'EnterPlanMode':
      return { icon: ClipboardList, verb: 'Entered plan mode' }
    case 'AskUserQuestion':
      return { icon: MessageCircleQuestion, verb: 'Asked' }
    case 'ApplyPatch': {
      const files = String(i.patch ?? '').match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm) ?? []
      const add = (String(i.patch ?? '').match(/^\+(?!\+\+)/gm) ?? []).length
      const del = (String(i.patch ?? '').match(/^-(?!--)/gm) ?? []).length
      return { icon: FilePen, verb: done ? 'Patched' : 'Patching', target: files.map((f) => shortPath(f.replace(/^\*\*\* \w+ File: /, ''), 40)).join(', '), stats: { add, del } }
    }
  }
  if (call.name.startsWith('mcp__')) {
    const [, server, ...tool] = call.name.split('__')
    return { icon: Plug, verb: tool.join('__').replace(/_/g, ' '), target: server.replace(/^claude_ai_/, '').replace(/_/g, ' ') }
  }
  const s = typeof i === 'object' ? Object.values(i).find((v) => typeof v === 'string' && v.length < 120) : undefined
  return { icon: Wrench, verb: call.name, target: s as string | undefined }
}

function firstLine(s?: string) {
  if (!s) return ''
  const l = s.split('\n')[0]
  return l.length > 120 ? `${l.slice(0, 120)}…` : l
}
