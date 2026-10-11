import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn as spawnChild } from 'node:child_process'
import { VERSION, newestRelease } from '@tether/protocol'

/**
 * Updating a hub that was installed with git clone: pull, install, build the web app, restart.
 * `pnpm hub:update` runs it in a terminal; Settings starts the same script from the hub. Nothing
 * here runs by itself: the hub only looks for new tags, at most every half hour.
 */

/** the checkout the hub runs from */
export const REPO = path.resolve(import.meta.dir, '../../../..')
const SCRIPT = path.resolve(import.meta.dir, '../cli/update.ts')
const UNIT = 'tether-hub'

export type Exec = (cmd: string[], cwd: string) => Promise<{ code: number; out: string }>

/**
 * PATH with the places Bun and pnpm install themselves. A systemd user unit starts with a short
 * PATH that often has neither.
 */
export function toolPath(env: NodeJS.ProcessEnv = process.env) {
  const home = env.HOME || os.homedir()
  const extra = [path.dirname(process.execPath), path.join(home, '.bun/bin'), path.join(home, '.local/share/pnpm'), path.join(home, '.local/bin'), '/usr/local/bin']
  return [...new Set([...(env.PATH ?? '').split(':').filter(Boolean), ...extra])].join(':')
}

export const exec: Exec = async (cmd, cwd) => {
  try {
    const p = Bun.spawn(cmd, { cwd, env: { ...process.env, PATH: toolPath() }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
    return { code, out: `${out}${err}`.trim() }
  } catch (e) {
    // not installed
    return { code: 127, out: String((e as Error).message ?? e) }
  }
}

const real = (p: string) => {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

/** Whether `repo` can be updated with a fast-forward pull, and the branch it's on. */
export async function checkCheckout(repo: string, run: Exec = exec): Promise<{ branch?: string; reason?: string; git: boolean }> {
  const top = await run(['git', 'rev-parse', '--show-toplevel'], repo)
  if (top.code !== 0 || real(top.out) !== real(repo)) return { git: false, reason: `${repo} isn't a git checkout, so it can't update itself. Install Tether with git clone to get updates.` }
  const branch = (await run(['git', 'symbolic-ref', '--short', '-q', 'HEAD'], repo)).out
  if (!branch) return { git: true, reason: 'The checkout is on a tag or commit, not a branch. Run git checkout main in it first.' }
  const status = await run(['git', 'status', '--porcelain', '--untracked-files=no'], repo)
  if (status.code !== 0 || status.out) return { git: true, branch, reason: 'The checkout has local changes. Commit or stash them first.' }
  if ((await run(['git', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], repo)).code !== 0)
    return { git: true, branch, reason: `The ${branch} branch doesn't follow a remote branch, so there's nothing to pull.` }
  return { git: true, branch }
}

export interface UpdateSteps {
  repo: string
  run?: Exec
  log?: (line: string) => void
  /** called before each step, with its name */
  step?: (name: string) => void
}

/**
 * The update itself: refuses a checkout with local changes or one that can't fast-forward, then
 * pulls, installs, builds the web app and restarts the systemd unit if there is one.
 */
export async function updateHub({ repo, run = exec, log = console.log, step = () => {} }: UpdateSteps): Promise<{ ok: boolean; error?: string; restarted?: boolean }> {
  const fail = (error: string, out = '') => {
    if (out) log(out)
    log(error)
    return { ok: false, error }
  }
  step('check')
  log(`Checking ${repo}`)
  const co = await checkCheckout(repo, run)
  if (co.reason) return fail(co.reason)
  step('fetch')
  log('Fetching new commits and tags')
  const fetched = await run(['git', 'fetch', '--tags'], repo)
  if (fetched.code !== 0) return fail("Couldn't fetch from the remote. Check the network and try again.", fetched.out)
  step('pull')
  log(`Updating ${co.branch}`)
  const pulled = await run(['git', 'pull', '--ff-only'], repo)
  if (pulled.code !== 0) return fail(`Couldn't fast-forward ${co.branch}: it has commits the remote doesn't. Merge or reset it by hand, then try again.`, pulled.out)
  if (pulled.out) log(pulled.out)
  step('install')
  log('Installing dependencies')
  const installed = await run(['pnpm', 'install', '--frozen-lockfile'], repo)
  if (installed.code !== 0) return fail(installed.code === 127 ? "pnpm isn't installed, or isn't on the PATH." : 'pnpm install failed.', installed.out)
  step('build')
  log('Building the web app')
  const built = await run(['pnpm', '--filter', '@tether/web', 'build'], repo)
  if (built.code !== 0) return fail('Building the web app failed.', built.out)
  let version = ''
  try {
    version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version ?? ''
  } catch {}
  const updated = `Updated to Tether ${version || 'the newest version'}.`
  if ((await run(['systemctl', '--user', 'cat', `${UNIT}.service`], repo)).code !== 0) {
    log(`${updated} Restart the hub to run it.`)
    return { ok: true, restarted: false }
  }
  // from Settings this is the last thing the script does: stopping the unit stops the script too
  step('restart')
  log(`${updated} Restarting ${UNIT}`)
  const restarted = await run(['systemctl', '--user', 'restart', UNIT], repo)
  if (restarted.code !== 0) return fail(`Couldn't restart ${UNIT}. Restart the hub by hand.`, restarted.out)
  log('Done.')
  return { ok: true, restarted: true }
}

// ---------- the hub's side: is there an update, and start one ----------

export interface HubUpdateStatus {
  current: string
  /** the newest release tag newer than the running hub */
  latest?: string
  /** commits on the branch's remote that the checkout doesn't have yet */
  behind?: number
  canUpdate: boolean
  reason?: string
  checkedAt: number
  /** an update started from Settings is running */
  running?: boolean
  /** why the last update from Settings failed, and where its log is */
  error?: string
  log?: string
  /** the checkout was updated, but the hub is still running the old code */
  restartNeeded?: boolean
}

interface Job {
  pid?: number
  started: number
  step?: string
  error?: string
  done?: boolean
  restarted?: boolean
}

export interface HubUpdateOptions {
  repo?: string
  dataDir: string
  version?: string
  /** the commit the hub started from */
  commit?: string
  run?: Exec
  /** starts the update script on its own, so it outlives the hub; returns its pid */
  spawn?: (cmd: string[], o: { cwd: string; log: string }) => number | undefined
  now?: () => number
  alive?: (pid: number) => boolean
}

/** A refusal with the HTTP status the route answers with. */
export class UpdateRefused extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

/** at most this often the hub asks the remote for new tags, unless Settings asks for a check */
export const CHECK_EVERY = 30 * 60_000

const spawnDetached = (cmd: string[], o: { cwd: string; log: string }) => {
  const fd = fs.openSync(o.log, 'w', 0o600)
  try {
    const child = spawnChild(cmd[0], cmd.slice(1), { cwd: o.cwd, detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, PATH: toolPath() } })
    child.unref()
    return child.pid
  } finally {
    fs.closeSync(fd)
  }
}

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** The commit `repo` has checked out, short, or '' when it isn't a git checkout. */
export function headCommit(repo = REPO) {
  try {
    const r = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD'], { cwd: repo, stdout: 'pipe', stderr: 'ignore' })
    return r.exitCode === 0 ? r.stdout.toString().trim() : ''
  } catch {
    return ''
  }
}

/** The routes and their state; `jobFile` is written by the update script as it goes. */
export function hubUpdater(o: HubUpdateOptions) {
  const repo = o.repo ?? REPO
  const version = o.version ?? VERSION
  const run = o.run ?? exec
  const spawn = o.spawn ?? spawnDetached
  const now = o.now ?? Date.now
  const alive = o.alive ?? pidAlive
  const jobFile = path.join(o.dataDir, 'hub-update.json')
  const logFile = path.join(o.dataDir, 'hub-update.log')
  let cache: Omit<HubUpdateStatus, 'running' | 'error' | 'log' | 'restartNeeded'> | undefined
  let checking: Promise<typeof cache> | undefined

  const readJob = (): Job | undefined => {
    try {
      return JSON.parse(fs.readFileSync(jobFile, 'utf8'))
    } catch {
      return undefined
    }
  }

  async function check() {
    const co = await checkCheckout(repo, run)
    let latest: string | undefined
    let behind: number | undefined
    if (co.git) {
      await run(['git', 'fetch', '--tags', '--quiet'], repo)
      latest = newestRelease((await run(['git', 'tag', '--list', 'v*'], repo)).out.split('\n'), version)
      const count = await run(['git', 'rev-list', '--count', 'HEAD..@{u}'], repo)
      if (count.code === 0 && /^\d+$/.test(count.out)) behind = Number(count.out)
    }
    return { current: version, latest, behind, canUpdate: !co.reason, reason: co.reason, checkedAt: now() }
  }

  /** what an update from Settings is doing, or how the last one ended */
  async function jobState(): Promise<Pick<HubUpdateStatus, 'running' | 'error' | 'log' | 'restartNeeded'>> {
    const job = readJob()
    if (!job) return {}
    if (job.error) return { error: job.error, log: logFile }
    if (job.done) {
      // updated without a unit to restart: the hub still runs the code it started with
      const head = (await run(['git', 'rev-parse', '--short', 'HEAD'], repo)).out
      return !job.restarted && o.commit && head && head !== o.commit ? { restartNeeded: true } : {}
    }
    if (job.pid ? alive(job.pid) : now() - job.started < 10_000) return { running: true }
    // the restart stops the script along with the old hub; earlier than that it was cut short
    return job.step === 'restart' ? {} : { error: 'The last update stopped before it finished.', log: logFile }
  }

  async function status(refresh = false): Promise<HubUpdateStatus> {
    if (refresh || !cache || now() - cache.checkedAt > CHECK_EVERY) {
      checking ??= check().finally(() => (checking = undefined))
      cache = await checking
    }
    return { ...cache!, ...(await jobState()) }
  }

  async function start() {
    if ((await jobState()).running) throw new UpdateRefused(409, 'An update is already running.')
    const co = await checkCheckout(repo, run)
    if (co.reason) throw new UpdateRefused(409, co.reason)
    fs.mkdirSync(o.dataDir, { recursive: true })
    // written before the script starts, which then adds its progress
    fs.writeFileSync(jobFile, JSON.stringify({ started: now(), step: 'start' } satisfies Job), { mode: 0o600 })
    const pid = spawn([process.execPath, SCRIPT, '--repo', repo, '--job', jobFile], { cwd: repo, log: logFile })
    if (!pid) {
      writeJob(jobFile, { error: "Couldn't start the update." })
      throw new UpdateRefused(500, "Couldn't start the update.")
    }
    writeJob(jobFile, { pid })
    cache = undefined
    return pid
  }

  const json = (data: unknown, status = 200) => Response.json(data, { status })
  return {
    status,
    start,
    jobFile,
    logFile,
    routes: {
      '/api/hub/update': {
        GET: async (req: Request) => json(await status(new URL(req.url).searchParams.has('refresh'))),
        POST: async () => {
          try {
            await start()
          } catch (e) {
            if (e instanceof UpdateRefused) return json({ error: e.message }, e.status)
            throw e
          }
          return json({ started: true }, 202)
        },
      },
    },
  }
}

/** Updates the update script's progress in the hub's job file (see `hubUpdater`). */
export function writeJob(file: string, patch: Partial<Job>) {
  let job: Job = { started: Date.now() }
  try {
    job = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {}
  fs.writeFileSync(file, JSON.stringify({ ...job, ...patch }), { mode: 0o600 })
}
