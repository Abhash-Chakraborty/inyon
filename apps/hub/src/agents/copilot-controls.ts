import type { Host } from '../hosts/host.ts'
import { capturePanes, sendKeys, typeText } from '../tmux/tmux.ts'
import { copilotModels } from './copilot-models.ts'
import { parseCopilotScreen } from './copilot-screen.ts'

export type CopilotControl = { model: string } | { permission: 'default' | 'assisted' | 'allow-all' } | { mode: 'interactive' | 'plan' | 'autopilot' }

/** Caller holds the shared pane action lock and pauses draft mirroring before using this. */
export async function setCopilotControl(host: Host, pane: string, control: CopilotControl): Promise<void> {
  const read = async () => {
    const lines = ((await capturePanes(host, [pane])).get(pane) ?? []).map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''))
    return { lines, screen: parseCopilotScreen(lines) }
  }
  const before = await read()
  if (before.screen.working || before.screen.prompt || !before.screen.inputVisible || before.screen.draft) throw new Error('Copilot must be idle with an empty input before changing settings. Your draft has been preserved.')
  let command: string
  let matches: (view: Awaited<ReturnType<typeof read>>) => boolean
  if ('model' in control) {
    const catalog = await copilotModels(host)
    if (!catalog.models.some((m) => m.id === control.model)) throw new Error('This model is not available in the signed-in Copilot catalog')
    command = `/model ${control.model}`
    matches = ({ screen }) => screen.model?.toLowerCase() === control.model.toLowerCase()
  } else if ('permission' in control) {
    if (!['default', 'assisted', 'allow-all'].includes(control.permission)) throw new Error('Invalid Copilot permission mode')
    command = `/permissions ${control.permission}`
    matches = ({ screen }) => screen.mode === control.permission
  } else {
    if (!['interactive', 'plan', 'autopilot'].includes(control.mode)) throw new Error('Invalid Copilot execution mode')
    const executionMode = (lines: string[]) => {
      const footer = lines.findLast((line) => /(?:Manual Approval|Assisted Approval|Allow All)/.test(line)) ?? ''
      return /(?:^|·) Plan ·/.test(footer) ? 'plan' : /(?:^|·) Autopilot ·/.test(footer) ? 'autopilot' : 'interactive'
    }
    if (executionMode(before.lines) === control.mode) return
    for (let i = 0; i < 3; i++) {
      await sendKeys(host, pane, ['BTab'])
      await new Promise((resolve) => setTimeout(resolve, 350))
      const view = await read()
      if (view.screen.prompt) throw new Error('Copilot needs confirmation before changing execution mode')
      if (executionMode(view.lines) === control.mode) return
    }
    throw new Error('Copilot did not confirm the execution mode')
  }
  await typeText(host, pane, command)
  let typed = false
  for (let n = 0; n < 15; n++) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    const draft = (await read()).screen.draft
    if (draft === command || (command === '/model auto' && draft === '/model auto [efficiency|balance|intelligence|<tier>]') || (command === '/plan' && draft === '/plan [prompt]')) { typed = true; break }
    if (draft) break
  }
  if (!typed) throw new Error('Copilot input changed before the setting was submitted. Check the terminal.')
  await sendKeys(host, pane, ['Enter'])
  for (let n = 0; n < 20; n++) {
    await new Promise((resolve) => setTimeout(resolve, 150))
    const view = await read()
    const failure = view.lines.findLast((line) => /[✗×] Error:/.test(line) && !before.lines.includes(line))
    if (failure) throw new Error(failure.trim().replace(/^[✗×]\s*/, '').replace(/\s*┃$/, ''))
    if (!view.screen.draft && !view.screen.prompt && matches(view)) return
    if (view.screen.prompt) throw new Error('Copilot needs confirmation in the terminal before this setting can change')
  }
  throw new Error('Copilot did not confirm the setting. Check the terminal before retrying.')
}
