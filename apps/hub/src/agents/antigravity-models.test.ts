import { expect, test } from 'bun:test'
import { agyModels, parseAgyModels } from './antigravity-models.ts'

const catalog = 'Fetching available models...\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\ngemini-3.1-pro-low\tGemini 3.1 Pro (Low)\nclaude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\ngpt-oss-120b-medium\tGPT-OSS 120B (Medium)\n'

test('catalog groups advertised Gemini variants without inventing unsupported efforts', () => {
  const models = parseAgyModels(catalog)
  expect(models).toHaveLength(3)
  expect(models[0]).toMatchObject({ id: 'gemini-3.1-pro', efforts: ['low', 'high'], variants: { high: 'gemini-3.1-pro-high', low: 'gemini-3.1-pro-low' } })
  expect(models[1]).toMatchObject({ id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)', efforts: [] })
  expect(models[2]).toMatchObject({ id: 'gpt-oss-120b-medium', efforts: [] })
  expect(parseAgyModels('login failed')).toEqual([])
})

test('concurrent discovery uses one host request; failure remains explicit', async () => {
  let calls = 0
  const host = { id: 'models-test', exec: async () => { calls++; await Promise.resolve(); return { code: 0, stdout: catalog, stderr: '' } } }
  const [first, second] = await Promise.all([agyModels(host), agyModels(host)])
  expect(calls).toBe(1)
  expect(first.source).toBe('cli')
  expect(second).toEqual(first)
  expect((await agyModels({ id: 'models-error', exec: async () => ({ code: 1, stdout: '', stderr: 'not signed in' }) })).error).toBe('not signed in')
})
