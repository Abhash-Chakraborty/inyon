import { afterAll, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { viaCommand } from './via-backend.ts'

const dir = mkdtempSync(join(tmpdir(), 'tether-via-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// an ssh that records how it was called and runs the remote command the way a login shell would
writeFileSync(join(dir, 'ssh'), `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> "${dir}/args"; done\nfor last in "$@"; do :; done\nexec sh -c "$last"\n`)
chmodSync(join(dir, 'ssh'), 0o755)

test('a command reaches the server through the computer exactly as written', () => {
  const cmd = `printf '%s|' "it's" "a \\"quoted\\" \\$HOME" | tr a-z A-Z`
  const r = Bun.spawnSync(['sh', '-c', viaCommand({ id: 's', name: 's', kind: 'ssh', target: 'work-db', port: 2222, via: 'jump' }, cmd)], {
    env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir },
  })
  expect(r.stdout.toString()).toBe(`IT'S|A "QUOTED" $HOME|`)
  const args = Bun.file(join(dir, 'args')).text()
  return args.then((a) => {
    const argv = a.trim().split('\n')
    // no prompts, one shared connection under the computer's home, and the alias left to its config
    expect(argv).toContain('BatchMode=yes')
    expect(argv).toContain(`ControlPath=${dir}/.cache/tether-ssh/%C`)
    expect(argv.slice(argv.indexOf('-p'), argv.indexOf('-p') + 2)).toEqual(['-p', '2222'])
    expect(argv.slice(argv.indexOf('--') + 1, argv.indexOf('--') + 2)).toEqual(['work-db'])
  })
})

test("when the computer isn't connected, the server's error names it, not tether-node", async () => {
  const { viaBackend } = await import('./via-backend.ts')
  const jump = { id: 'jump-offline', name: 'Jump box', kind: 'link' as const }
  const via = viaBackend((id) => (id === jump.id ? jump : undefined))
  const r = await via.exec({ id: 'db', name: 'DB', kind: 'ssh', target: 'work-db', via: jump.id }, 'true', {})
  expect(r.code).toBe(255)
  expect(r.stderr).toBe("Jump box isn't connected right now, and this server is reached through it.")
  // and a computer that was unpaired since
  expect((await via.exec({ id: 'db', name: 'DB', kind: 'ssh', target: 'work-db', via: 'gone' }, 'true', {})).stderr).toMatch(/no longer paired/)
})
