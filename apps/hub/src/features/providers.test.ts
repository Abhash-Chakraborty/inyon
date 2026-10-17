import { afterAll, afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { catalogueFrom, disconnectProvider, listProviders, mergeProviders, parseAuthList } from './providers.ts'
import { registry } from '../hosts/registry.ts'

afterAll(() => mock.restore())
afterEach(() => mock.restore())

// what `opencode auth list` prints (1.19), colours and all
const LIST = `\x1b[0m
\x1b[90m┌\x1b[39m  Credentials \x1b[90m/home/me/.local/share/opencode/auth.json\x1b[39m
\x1b[90m│\x1b[39m
\x1b[32m●\x1b[39m  GitHub Copilot \x1b[90moauth\x1b[39m
\x1b[90m│\x1b[39m
\x1b[32m●\x1b[39m  Anthropic api
\x1b[90m│\x1b[39m
\x1b[90m└\x1b[39m  2 credentials

\x1b[90m┌\x1b[39m  Environment
\x1b[90m│\x1b[39m
\x1b[32m●\x1b[39m  Groq \x1b[90mGROQ_API_KEY\x1b[39m
\x1b[90m│\x1b[39m
\x1b[90m└\x1b[39m  1 environment variable
`

const catalogue = catalogueFrom({
  connected: ['opencode', 'anthropic', 'github-copilot', 'groq'],
  all: [
    { id: 'opencode', name: 'OpenCode', env: ['OPENCODE_API_KEY'], key: 'SECRET' },
    { id: 'anthropic', name: 'Anthropic', env: ['ANTHROPIC_API_KEY'], key: 'SECRET' },
    { id: 'github-copilot', name: 'GitHub Copilot', env: ['GITHUB_TOKEN'] },
    { id: 'groq', name: 'Groq', env: ['GROQ_API_KEY'] },
    { id: 'zai', name: 'Z.AI', env: ['ZHIPU_API_KEY'] },
    { id: 'openai', name: 'OpenAI', env: ['OPENAI_API_KEY'] },
    { id: 'bad id', name: 'Nope', env: [] },
  ],
})

describe("OpenCode's providers", () => {
  test('`opencode auth list` is read as credentials and environment variables', () => {
    expect(parseAuthList(LIST)).toEqual({
      credentials: [{ name: 'GitHub Copilot', type: 'oauth' }, { name: 'Anthropic', type: 'api' }],
      env: [{ name: 'Groq', variable: 'GROQ_API_KEY' }],
    })
    expect(parseAuthList('┌  Credentials x\n│\n└  0 credentials\n')).toEqual({ credentials: [], env: [] })
  })

  test('the catalogue keeps ids, names and variables, never keys, and drops ids a shell could misread', () => {
    expect(JSON.stringify(catalogue)).not.toContain('SECRET')
    expect(catalogue.providers.map((p) => p.id)).toEqual(['opencode', 'anthropic', 'github-copilot', 'groq', 'zai', 'openai'])
  })

  test('connected ones first (with how they connected), then the popular ones, then the rest by name', () => {
    const list = mergeProviders(catalogue, parseAuthList(LIST))
    expect(list.map((p) => [p.id, p.connected, p.via, p.type])).toEqual([
      ['anthropic', true, 'credential', 'api'],
      ['github-copilot', true, 'credential', 'oauth'],
      ['groq', true, 'env', undefined],
      ['opencode', true, undefined, undefined],
      ['openai', false, undefined, undefined],
      ['zai', false, undefined, undefined],
    ])
    expect(list.find((p) => p.id === 'groq')?.env).toEqual(['GROQ_API_KEY'])
    // a credential for a provider the catalogue doesn't list still shows
    expect(mergeProviders({ providers: [], connected: [] }, { credentials: [{ name: 'My Proxy', type: 'api' }], env: [] })).toEqual([{ id: 'my-proxy', name: 'My Proxy', connected: true, via: 'credential', type: 'api' }])
  })

  test('disconnecting runs `opencode auth logout`, and a provider from the environment says how to disconnect it', async () => {
    const ran: string[] = []
    const host = { id: 'h', exec: async (cmd: string) => { ran.push(cmd); return { code: 0, stdout: cmd.includes('auth logout') ? '┌  Remove credential\n│\n└  Logout successful\n' : LIST, stderr: '' } } }
    spyOn(registry, 'host').mockReturnValue(host as any)
    spyOn(registry, 'get').mockReturnValue(undefined)
    spyOn(registry, 'refresh').mockImplementation(() => {})
    await disconnectProvider('h', 'anthropic')
    expect(ran[0]).toContain("opencode auth logout 'anthropic'")
    const envOnly = { id: 'h', exec: async (cmd: string) => ({ code: 0, stdout: cmd.includes('auth logout') ? '┌  Remove credential\n│\n■  No credentials found\n' : LIST, stderr: '' }) }
    spyOn(registry, 'host').mockReturnValue(envOnly as any)
    await expect(disconnectProvider('h', 'groq')).rejects.toThrow('GROQ_API_KEY')
    await expect(disconnectProvider('h', 'openai')).rejects.toThrow('no saved credential')
    await expect(disconnectProvider('h', 'bad id')).rejects.toThrow('Unknown provider')
  })

  test("the list comes back with an error line instead of failing when OpenCode's server can't start", async () => {
    const host = { id: 'h-none-' + Math.random(), exec: async (cmd: string) => ({ code: 0, stdout: cmd.includes('auth list') ? '' : 'command not found', stderr: '' }) }
    spyOn(registry, 'host').mockReturnValue(host as any)
    spyOn(registry, 'findPane').mockReturnValue(undefined)
    const r = await listProviders('h')
    expect(r.providers).toEqual([])
    expect(r.error).toContain("couldn't be read")
  })
})
