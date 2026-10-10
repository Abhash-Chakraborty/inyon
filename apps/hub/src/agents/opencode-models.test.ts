import { describe, expect, test } from 'bun:test'
import { modelFromFooter, parseOpenCodeModels } from './opencode-models.ts'
import { inputContains } from '../claude/delivery.ts'

// the shape `opencode models --verbose` prints; headers and options stand in for secrets
const OUTPUT = `opencode/big-pickle
{
  "id": "big-pickle",
  "providerID": "opencode",
  "name": "Big Pickle",
  "headers": { "x-secret": "never-keep-this" },
  "options": { "apiKey": "never-keep-this" },
  "limit": { "context": 200000, "output": 32000 },
  "status": "active",
  "variants": {}
}
opencode/ling-3.1-flash-free
{
  "id": "ling-3.1-flash-free",
  "name": "Ling 3.1 Flash Free",
  "limit": { "context": 262144 },
  "variants": { "low": { "reasoningEffort": "low" }, "medium": {}, "high": { "disabled": true } }
}
anthropic/old-model
{
  "name": "Old",
  "status": "deprecated",
  "limit": { "context": 1 }
}
`

describe('OpenCode models', () => {
  test('keeps id, name, context and variants, nothing else', () => {
    const models = parseOpenCodeModels(OUTPUT)
    expect(models).toEqual([
      { id: 'opencode/big-pickle', label: 'OpenCode Zen · Big Pickle', context: 200000, efforts: [] },
      { id: 'opencode/ling-3.1-flash-free', label: 'OpenCode Zen · Ling 3.1 Flash Free', context: 262144, efforts: ['low', 'medium'] },
    ])
    expect(JSON.stringify(models)).not.toContain('never-keep-this')
  })

  test('the footer names the model and its provider', () => {
    const models = parseOpenCodeModels(OUTPUT)
    expect(modelFromFooter(models, 'Ling 3.1 Flash Free OpenCode Zen')?.id).toBe('opencode/ling-3.1-flash-free')
    expect(modelFromFooter(models, 'Big Pickle OpenCode Zen')?.id).toBe('opencode/big-pickle')
    expect(modelFromFooter(models, 'Something Else')).toBeUndefined()
  })

  test('a multi-line paste shows as its line count', () => {
    expect(inputContains('[Pasted ~3 lines]', 'one\ntwo\nthree')).toBe(true)
    expect(inputContains('[Pasted ~3 lines]', 'one\ntwo')).toBe(false)
  })
})
