import { expect, test } from 'bun:test'
import { renderHook } from '@testing-library/react'
import type { AgentStatus } from '@inyon/protocol'
import { useSession } from './useSession.ts'
import { useStore } from '../../lib/store.ts'
import { agentPane, host } from '../../test/fixtures.ts'
import { flush } from '../../test/render.tsx'

const effortOf = async (status: Omit<AgentStatus, 'updatedAt'>) => {
  useStore.setState({ hosts: [host('box', { panes: [agentPane('%1', 'claude', { agent: { kind: 'claude', pid: 1, state: 'idle', status: { ...status, updatedAt: 1 } } })] })] })
  const { result } = renderHook(() => useSession('box', '%1'))
  await flush()
  return result.current.status?.effort
}

test("Claude's effort is the model's own level until one is picked, not \"Default\"", async () => {
  // Claude Code's status line names a level only once you choose one
  expect(await effortOf({ model: 'Opus 5.5' })).toBe('high')
  expect(await effortOf({ model: 'Sonnet 5.5' })).toBe('medium')
  expect(await effortOf({ model: 'Opus 5.5', effort: 'low' })).toBe('low')
  // a model whose default isn't known stays unknown
  expect(await effortOf({ model: 'Haiku 5.5' })).toBeUndefined()
})
