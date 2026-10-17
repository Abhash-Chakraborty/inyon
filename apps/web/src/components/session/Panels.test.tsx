import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { SidePanel, type PanelTab } from './Panels.tsx'
import { useSession } from './useSession.ts'
import { useStore } from '../../lib/store.ts'
import { agentPane, host } from '../../test/fixtures.ts'

function Panel({ closing }: { closing?: boolean }) {
  const s = useSession('box', '%1')
  const [tab, setTab] = useState<PanelTab>('changes')
  return <SidePanel s={s} items={[]} tab={tab} setTab={setTab} onTask={() => {}} onSubagent={() => {}} closing={closing} />
}
const panel = (closing?: boolean) => render(<MemoryRouter><Panel closing={closing} /></MemoryRouter>)

describe('the side panel', () => {
  // happy-dom has no layout: the tabs say where they are, 80px apart and 70px wide
  const left = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetLeft')
  const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
  beforeEach(() => {
    useStore.setState({ hosts: [host('box', { panes: [agentPane('%1', 'claude')] })] })
    const index = function (this: HTMLElement) {
      return [...(this.parentElement?.querySelectorAll('[role=tab]') ?? [])].indexOf(this)
    }
    Object.defineProperty(HTMLElement.prototype, 'offsetLeft', { configurable: true, get() { const i = index.call(this); return i < 0 ? 0 : 10 + i * 80 } })
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get() { return index.call(this) < 0 ? 0 : 70 } })
  })
  afterEach(() => {
    for (const [name, d] of [['offsetLeft', left], ['offsetWidth', width]] as const) {
      if (d) Object.defineProperty(HTMLElement.prototype, name, d)
      else delete (HTMLElement.prototype as any)[name]
    }
  })

  test('one underline slides under the chosen tab, and the body comes in fresh', async () => {
    const user = userEvent.setup()
    const { container } = panel()
    const line = () => container.querySelector('[data-part=underline]') as HTMLElement
    const body = () => container.querySelector('.overflow-y-auto') as HTMLElement
    expect(container.querySelectorAll('[data-part=underline]')).toHaveLength(1)
    expect(line().style.transform).toBe('translateX(10px) scaleX(0.7)')
    // drawn in place at first, so it doesn't slide in from the edge
    expect(line().className).not.toContain('transition-transform')
    const was = body()
    await user.click(screen.getByRole('tab', { name: 'Activity' }))
    expect(line().style.transform).toBe('translateX(170px) scaleX(0.7)')
    expect(line().className).toContain('transition-transform')
    expect(body()).not.toBe(was)
    expect(body().className).toContain('animate-fade-in')
    // no tab carries a border of its own any more: the line is the one mark
    for (const tab of screen.getAllByRole('tab')) expect(tab.className).not.toMatch(/border-b/)
  })

  test('comes in from its edge, and fades while it is closing', () => {
    expect(panel().container.querySelector('aside')!.className).toContain('animate-panel-in')
    expect(panel(true).container.querySelector('aside')!.className).toContain('animate-fade-out')
  })
})
