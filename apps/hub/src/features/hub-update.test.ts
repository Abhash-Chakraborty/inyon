import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { LATEST_URL } from '@inyon/protocol'
import { CHECK_EVERY, exec, hubUpdater, REPO, updateHub, type Exec } from './hub-update.ts'

// Every update here runs against throwaway repositories in the temp dir, with fake bun and
// systemctl, never against this checkout.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inyon-hub-update-'))
const bin = path.join(root, 'bin')
const calls = path.join(root, 'calls')
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
}
const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(['git', ...args], { cwd, env: gitEnv, stdout: 'pipe', stderr: 'pipe' })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.toString().trim()
}
let n = 0
/** An "origin" with one commit and a clone of it, the way a hub is installed. */
function checkout(tags: string[] = []) {
  const dir = path.join(root, `r${++n}`)
  const origin = `${dir}-origin`
  fs.mkdirSync(origin, { recursive: true })
  git(origin, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(origin, 'package.json'), JSON.stringify({ version: '0.6.3' }))
  git(origin, 'add', '.')
  git(origin, 'commit', '-qm', 'first')
  for (const t of tags) git(origin, 'tag', t)
  git(root, 'clone', '-q', origin, dir)
  expect(fs.realpathSync(dir)).not.toBe(fs.realpathSync(REPO))
  return { dir, origin }
}
const commit = (cwd: string, file: string, text = file) => {
  fs.writeFileSync(path.join(cwd, file), text)
  git(cwd, 'add', '.')
  git(cwd, 'commit', '-qm', file)
}
const called = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [])

beforeAll(() => {
  fs.mkdirSync(bin)
  // the fakes write down how they were called; systemctl knows only the unit named in FAKE_UNIT
  fs.writeFileSync(path.join(bin, 'bun'), `#!/bin/sh\necho "bun $*" >> "${calls}"\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/sh\necho "systemctl $*" >> "${calls}"\n[ "$2" = cat ] && [ "$3" != "$FAKE_UNIT.service" ] && exit 1\nexit 0\n`, { mode: 0o755 })
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

/** `exec` with the fake tools in place of the real ones */
const run: Exec = (cmd, cwd) => exec(['bun', 'systemctl'].includes(cmd[0]) ? [path.join(bin, cmd[0]), ...cmd.slice(1)] : cmd, cwd)
const quiet = () => {
  const lines: string[] = []
  return { lines, log: (l: string) => void lines.push(l) }
}

describe('the update refuses what it would break', () => {
  test('a checkout with local changes', async () => {
    const { dir } = checkout()
    fs.writeFileSync(path.join(dir, 'package.json'), '{"version":"edited"}')
    const r = await updateHub({ repo: dir, run, ...quiet() })
    expect(r).toEqual({ ok: false, error: 'The checkout has local changes. Commit or stash them first.' })
    expect(called()).toEqual([])
  })

  test('a folder that is not a git checkout', async () => {
    const dir = path.join(root, 'plain')
    fs.mkdirSync(dir)
    const r = await updateHub({ repo: dir, run, ...quiet() })
    expect(r.ok).toBe(false)
    expect(r.error).toContain("isn't a git checkout")
  })

  test('a folder inside some other repository is not a checkout of Inyon', async () => {
    const { dir } = checkout()
    fs.mkdirSync(path.join(dir, 'apps'))
    const r = await updateHub({ repo: path.join(dir, 'apps'), run, ...quiet() })
    expect(r.error).toContain("isn't a git checkout")
  })

  test("a branch that can't fast-forward", async () => {
    const { dir, origin } = checkout()
    commit(origin, 'upstream.txt')
    commit(dir, 'local.txt')
    const r = await updateHub({ repo: dir, run, ...quiet() })
    expect(r).toEqual({ ok: false, error: "Couldn't fast-forward main: it has commits the remote doesn't. Merge or reset it by hand, then try again." })
    expect(called()).toEqual([])
    expect(fs.existsSync(path.join(dir, 'upstream.txt'))).toBe(false)
  })

  test('a detached checkout', async () => {
    const { dir } = checkout()
    git(dir, 'checkout', '-q', '--detach')
    expect((await updateHub({ repo: dir, run, ...quiet() })).error).toContain('not a branch')
  })
})

describe('an update that can go ahead', () => {
  test('pulls, installs, builds, and says to restart when there is no unit', async () => {
    fs.rmSync(calls, { force: true })
    const { dir, origin } = checkout()
    commit(origin, 'package.json', JSON.stringify({ version: '0.6.4' }))
    const { lines, log } = quiet()
    const r = await updateHub({ repo: dir, run, log })
    expect(r).toEqual({ ok: true, restarted: false })
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version).toBe('0.6.4')
    expect(called()).toEqual(['bun install --frozen-lockfile', 'bun --filter @inyon/web build', 'systemctl --user cat inyon-hub.service', 'systemctl --user cat tether-hub.service'])
    expect(lines.at(-1)).toBe('Updated to Inyon 0.6.4. Restart the hub to run it.')
  })

  // a hub set up before the rename to Inyon still has its tether-hub unit
  test.each(['inyon-hub', 'tether-hub'])('the command restarts the systemd unit when there is one (%s)', async (unit) => {
    fs.rmSync(calls, { force: true })
    const { dir, origin } = checkout()
    commit(origin, 'more.txt')
    const p = Bun.spawn([process.execPath, path.join(import.meta.dir, '../cli/update.ts'), '--repo', dir], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_UNIT: unit },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = await new Response(p.stdout).text()
    expect(await p.exited).toBe(0)
    expect(called().at(-1)).toBe(`systemctl --user restart ${unit}`)
    expect(out).toContain(`Restarting ${unit}`)
    expect(fs.existsSync(path.join(dir, 'more.txt'))).toBe(true)
  })

  test('the command exits with an error and says why when it refuses', async () => {
    const { dir } = checkout()
    fs.writeFileSync(path.join(dir, 'package.json'), '{}')
    const p = Bun.spawn([process.execPath, path.join(import.meta.dir, '../cli/update.ts'), '--repo', dir], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: 'pipe' })
    expect(await new Response(p.stdout).text()).toContain('The checkout has local changes')
    expect(await p.exited).toBe(1)
  })
})

describe('the hub checks for updates and starts one', () => {
  /** counts how often the remote is asked */
  const counting = () => {
    const seen = { fetches: 0 }
    const r: Exec = (cmd, cwd) => {
      if (cmd[0] === 'git' && cmd[1] === 'fetch') seen.fetches++
      return run(cmd, cwd)
    }
    return { seen, run: r }
  }

  test('reports the newest release tag and asks the remote at most every half hour', async () => {
    const { dir, origin } = checkout(['v0.6.3'])
    for (const t of ['v0.6.4', 'v0.6.10', 'v0.7.0-rc.1']) git(origin, 'tag', t)
    commit(origin, 'next.txt')
    let t = 1_000_000
    const c = counting()
    const u = hubUpdater({ repo: dir, dataDir: path.join(root, 'data1'), version: '0.6.3', run: c.run, now: () => t })
    const first = await u.status()
    expect(first).toMatchObject({ current: '0.6.3', latest: '0.6.10', behind: 1, canUpdate: true })
    expect(c.seen.fetches).toBe(1)
    t += CHECK_EVERY - 1000
    await u.status()
    expect(c.seen.fetches).toBe(1)
    t += 2000
    await u.status()
    expect(c.seen.fetches).toBe(2)
    // "Check now" in Settings
    await u.status(true)
    expect(c.seen.fetches).toBe(3)
  })

  test('two requests at once share one check', async () => {
    const { dir } = checkout()
    const c = counting()
    const u = hubUpdater({ repo: dir, dataDir: path.join(root, 'data2'), version: '0.6.3', run: c.run })
    await Promise.all([u.status(), u.status(), u.status()])
    expect(c.seen.fetches).toBe(1)
  })

  test('says why it cannot update, and up to date has no latest', async () => {
    const { dir } = checkout(['v0.6.3'])
    fs.writeFileSync(path.join(dir, 'package.json'), '{}')
    const u = hubUpdater({ repo: dir, dataDir: path.join(root, 'data3'), version: '0.6.3', run })
    const s = await u.status()
    expect(s).toMatchObject({ canUpdate: false, reason: 'The checkout has local changes. Commit or stash them first.', behind: 0 })
    expect(s.latest).toBeUndefined()
  })

  test('POST starts the script on its own and answers at once', async () => {
    const { dir } = checkout()
    const dataDir = path.join(root, 'data4')
    const spawned: { cmd: string[]; cwd: string; log: string }[] = []
    let alive = true
    const u = hubUpdater({ repo: dir, dataDir, version: '0.6.3', run, spawn: (cmd, o) => (spawned.push({ cmd, ...o }), 4242), alive: (pid) => pid === 4242 && alive })
    const post = (u.routes['/api/hub/update'].POST as () => Promise<Response>)
    const res = await post()
    expect(res.status).toBe(202)
    expect(spawned).toHaveLength(1)
    expect(spawned[0].cmd.slice(1)).toEqual([path.resolve(import.meta.dir, '../cli/update.ts'), '--repo', dir, '--job', u.jobFile])
    expect(spawned[0]).toMatchObject({ cwd: dir, log: u.logFile })
    expect(JSON.parse(fs.readFileSync(u.jobFile, 'utf8'))).toMatchObject({ pid: 4242, step: 'start' })
    expect((await u.status()).running).toBe(true)
    // a second tap while it runs
    const again = await post()
    expect(again.status).toBe(409)
    expect(spawned).toHaveLength(1)

    // the script got as far as the restart, which took it down with the old hub: that's success
    alive = false
    fs.writeFileSync(u.jobFile, JSON.stringify({ pid: 4242, started: 1, step: 'restart' }))
    const after = await u.status()
    expect(after.running).toBeUndefined()
    expect(after.error).toBeUndefined()
    // cut short earlier than that
    fs.writeFileSync(u.jobFile, JSON.stringify({ pid: 4242, started: 1, step: 'install' }))
    expect(await u.status()).toMatchObject({ error: 'The last update stopped before it finished.', log: u.logFile })
    // failed, as the script wrote it down
    fs.writeFileSync(u.jobFile, JSON.stringify({ pid: 4242, started: 1, step: 'build', error: 'Building the web app failed.' }))
    expect(await u.status()).toMatchObject({ error: 'Building the web app failed.', log: u.logFile })
  })

  test('POST refuses a checkout with local changes without starting anything', async () => {
    const { dir } = checkout()
    fs.writeFileSync(path.join(dir, 'package.json'), '{}')
    let spawned = 0
    const u = hubUpdater({ repo: dir, dataDir: path.join(root, 'data5'), version: '0.6.3', run, spawn: () => (spawned++, 1) })
    const res = await (u.routes['/api/hub/update'].POST as () => Promise<Response>)()
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe('The checkout has local changes. Commit or stash them first.')
    expect(spawned).toBe(0)
  })

  test('an update without a unit to restart says the hub needs a restart', async () => {
    const { dir, origin } = checkout()
    const before = git(dir, 'rev-parse', '--short', 'HEAD')
    commit(origin, 'new.txt')
    git(dir, 'pull', '-q', '--ff-only')
    const u = hubUpdater({ repo: dir, dataDir: path.join(root, 'data6'), version: '0.6.3', commit: before, run })
    fs.mkdirSync(path.dirname(u.jobFile), { recursive: true })
    fs.writeFileSync(u.jobFile, JSON.stringify({ pid: 1, started: 1, step: 'build', done: true, restarted: false }))
    expect((await u.status()).restartNeeded).toBe(true)
  })
})

describe('a hub run as the inyon program', () => {
  /** latest.json on the website naming `version`; the addresses asked are noted in `urls` */
  const urls: string[] = []
  const releases = (version: unknown, status = 200) =>
    (async (url: string) => (urls.push(String(url)), Response.json({ version, tag: `v${version}`, files: [] }, { status }))) as unknown as typeof fetch

  test('looks for a new release on the website, not in a checkout', async () => {
    const asked: string[][] = []
    const run: Exec = async (cmd) => (asked.push(cmd), { code: 0, out: '' })
    const dataDir = path.join(root, 'bin1')
    urls.length = 0
    const u = hubUpdater({ dataDir, version: '0.7.0', run, binary: true, statusFile: path.join(dataDir, 'update-status'), fetch: releases('0.7.2') })
    expect(await u.status()).toMatchObject({ current: '0.7.0', latest: '0.7.2', canUpdate: true })
    expect(asked).toEqual([])
    expect(urls).toEqual([LATEST_URL])
    const same = hubUpdater({ dataDir, version: '0.7.2', run, binary: true, statusFile: path.join(dataDir, 'update-status'), fetch: releases('0.7.2') })
    expect((await same.status()).latest).toBeUndefined()
  })

  test('a website that is down, or names no release, means no update rather than an error', async () => {
    const dataDir = path.join(root, 'bin1b')
    const statusFile = path.join(dataDir, 'update-status')
    const run: Exec = async () => ({ code: 0, out: '' })
    const answers: (typeof fetch)[] = [releases('0.9.0', 503), releases('0.9.0-rc.1'), releases(undefined), (async () => new Response('<html>')) as unknown as typeof fetch]
    for (const get of answers) {
      expect(await hubUpdater({ dataDir, version: '0.7.0', run, binary: true, statusFile, fetch: get }).status()).toMatchObject({ current: '0.7.0', latest: undefined, canUpdate: true })
    }
  })

  test("POST runs the program's own update on its own, and its status file says how it went", async () => {
    const dataDir = path.join(root, 'bin2')
    const statusFile = path.join(dataDir, 'node', 'update-status')
    fs.mkdirSync(path.dirname(statusFile), { recursive: true })
    const asked: string[][] = []
    const run: Exec = async (cmd) => (asked.push(cmd), { code: 0, out: '' })
    const u = hubUpdater({ dataDir, version: '0.7.0', run, binary: true, statusFile, program: '/home/me/.inyon/bin/inyon', fetch: releases('0.7.2') })
    const post = u.routes['/api/hub/update'].POST as () => Promise<Response>
    expect((await post()).status).toBe(202)
    expect(asked).toEqual([['/home/me/.inyon/bin/inyon', 'update', '--background']])
    fs.writeFileSync(statusFile, 'running\n')
    expect(await u.status()).toMatchObject({ running: true })
    expect((await post()).status).toBe(409)
    fs.writeFileSync(statusFile, "failed: The download didn't match the release's checksum, so nothing was changed. Try again.\n")
    expect(await u.status()).toMatchObject({ error: "The download didn't match the release's checksum, so nothing was changed. Try again.", log: path.join(dataDir, 'node', 'update.log') })
  })

  test("an update that can't start says why", async () => {
    const dataDir = path.join(root, 'bin3')
    const run: Exec = async () => ({ code: 1, out: 'systemd-run: not found' })
    const u = hubUpdater({ dataDir, version: '0.7.0', run, binary: true, statusFile: path.join(dataDir, 'update-status'), fetch: releases('0.7.2') })
    const res = await (u.routes['/api/hub/update'].POST as () => Promise<Response>)()
    expect(res.status).toBe(500)
    expect(((await res.json()) as { error: string }).error).toBe('systemd-run: not found')
    expect(await u.status()).toMatchObject({ error: 'systemd-run: not found' })
  })
})
