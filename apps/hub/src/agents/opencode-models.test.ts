import { describe, expect, test } from 'bun:test'
import { footerModelName, modelFromFooter, noteProviderNames, parseOpenCodeAgents, parseOpenCodeModels, withoutProvider } from './opencode-models.ts'
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
      { id: 'opencode/big-pickle', label: 'OpenCode · Big Pickle', context: 200000, efforts: [] },
      { id: 'opencode/ling-3.1-flash-free', label: 'OpenCode · Ling 3.1 Flash Free', context: 262144, efforts: ['low', 'medium'] },
    ])
    expect(JSON.stringify(models)).not.toContain('never-keep-this')
  })

  test('the footer names the model and its provider (1.19 says "OpenCode", older versions "OpenCode Zen")', () => {
    const models = parseOpenCodeModels(OUTPUT)
    expect(modelFromFooter(models, 'Ling 3.1 Flash Free OpenCode')?.id).toBe('opencode/ling-3.1-flash-free')
    expect(modelFromFooter(models, 'Big Pickle OpenCode Zen')?.id).toBe('opencode/big-pickle')
    expect(modelFromFooter(models, 'Something Else')).toBeUndefined()
    expect(withoutProvider('Big Pickle OpenCode')).toBe('Big Pickle')
    expect(withoutProvider('Big Pickle OpenCode Zen')).toBe('Big Pickle')
    expect(footerModelName(models, 'Ling 3.1 Flash Free OpenCode')).toBe('Ling 3.1 Flash Free')
    expect(footerModelName(undefined, 'Mystery Model Anthropic')).toBe('Mystery Model')
  })

  test('two providers offering the same model: the one the footer ends with', () => {
    const models = [
      { id: 'openai/gpt-5', label: 'OpenAI · GPT-5' },
      { id: 'openrouter/openai/gpt-5', label: 'OpenRouter · GPT-5' },
      { id: 'openai/gpt-5.1-codex', label: 'OpenAI · GPT-5.1 Codex' },
    ]
    expect(modelFromFooter(models, 'GPT-5 OpenRouter')?.id).toBe('openrouter/openai/gpt-5')
    expect(modelFromFooter(models, 'GPT-5 OpenAI')?.id).toBe('openai/gpt-5')
    expect(modelFromFooter(models, 'GPT-5.1 Codex OpenAI')?.id).toBe('openai/gpt-5.1-codex')
  })

  test('provider names a machine reports are used from then on', () => {
    noteProviderNames([{ id: 'acme-cloud', name: 'Acme Cloud' }])
    expect(withoutProvider('Some Model Acme Cloud')).toBe('Some Model')
  })

  test('`opencode agent list` gives the agents a session can switch to', () => {
    const out = 'build (primary)\n  [\n  {\n    "permission": "*"\n  }\n  ]\nplan (primary)\n  []\nexplore (subagent)\n  []\nreviewer (all)\n  []\ntitle (primary)\n  []\n'
    expect(parseOpenCodeAgents(out)).toEqual([{ id: 'build', label: 'Build' }, { id: 'plan', label: 'Plan' }, { id: 'reviewer', label: 'Reviewer' }])
    expect(parseOpenCodeAgents('')).toEqual([])
  })

  test('a multi-line paste shows as its line count, which counts only for text just put there', () => {
    expect(inputContains('[Pasted ~3 lines]', 'one\ntwo\nthree', true)).toBe(true)
    expect(inputContains('[Pasted ~3 lines]', 'one\ntwo', true)).toBe(false)
    // an older paste with as many lines is a different message
    expect(inputContains('[Pasted ~3 lines]', 'one\ntwo\nthree')).toBe(false)
  })
})
