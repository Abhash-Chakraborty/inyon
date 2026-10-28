import { fetchLatestRelease, newerRelease, parseRelease, TEST_BUILD, VERSION, type HostConfig, type HostState, type NodeUpdate } from '@inyon/protocol'
import type { Host } from './host.ts'
import { nodeLinks } from './node-link.ts'

/**
 * Updating a machine's inyon from the app, one tap, never on its own. The machine runs its own
 * `inyon update --background`: one added to this hub takes the build the hub serves, a laptop
 * paired with the phone the newest release. It runs detached, since restarting inyon ends the
 * command that started it, checks the download, and puts the old copy back if the new one won't
 * start. Progress is read from its update-status file; success is the machine coming back with the
 * new version.
 *
 * Before the rename to Inyon the program was tether-node. A laptop paired with the phone ran
 * `tether-node update` the same way. A Windows machine added to a hub gets a script instead
 * (crates/inyon-hub/assets/hub-update.ps1), through the plain exec command every tether-node understands; once
 * the new version runs, it moves its services to inyon's own names.
 */

/** The first version with `tether-node update`; a phone-paired laptop before it reinstalls instead. */
const LAST_WITHOUT_UPDATE = '0.6.3'
/** The first version that's the inyon program, which updates itself from its hub too. */
const FIRST_INYON = '0.7.0'
const isInyon = (version: string) => !newerRelease(FIRST_INYON, version)

/**
 * Whether `target` is newer than a machine's `version`. The target is the newest release or this
 * hub's own version, which can be a test build ("0.19.0-rc.1"): that counts as the release it
 * leads to, so a hub on a test build still offers it to machines on the release before.
 */
export function newerTarget(target: string, version: string): boolean {
  if (!TEST_BUILD.test(target)) return newerRelease(target, version)
  const base = (v: string) => v.trim().replace(/[-+].*$/, '')
  const rc = (v: string) => Number(/-rc\.(\d+)$/.exec(v.trim())?.[1])
  if (newerRelease(base(target), base(version))) return true
  // the same release: only an earlier test build of it is older
  const same = !newerRelease(base(version), base(target)) && parseRelease(base(version)) !== undefined
  return same && TEST_BUILD.test(version.trim()) && rc(target) > rc(version)
}

/**
 * For a Windows machine still on tether-node: writes the script the hub sent and starts it as a
 * task of its own; the script's output goes to update.log.
 */
export const WINDOWS_LAUNCHER = `d="$HOME/.tether-node"
mkdir -p "$d" && cat > "$d/update.ps1" && printf 'running\\n' > "$d/update-status" || exit 1
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$d/update.ps1" -Launch < /dev/null`

/** The machine's own `inyon update`, started on its own. */
export const SELF_UPDATE = '"$INYON_EXE" ${INYON_SCRIPT:+"$INYON_SCRIPT"} update --background'
/** The same for a laptop paired with the phone that still runs tether-node. */
export const LINK_UPDATE = '"$TETHER_NODE_EXE" ${TETHER_NODE_SCRIPT:+"$TETHER_NODE_SCRIPT"} update --background'
/** inyon's folder, or tether-node's where it hasn't moved yet */
export const READ_STATUS = 'cat "$HOME/.inyon/node/update-status" 2>/dev/null || cat "$HOME/.tether-node/update-status" 2>/dev/null; true'

/** Fills in the checksum, version and architecture; refuses anything that isn't plainly one. */
export function fillUpdateScript(script: string, o: { sha256: string; version: string; arch: string }) {
  if (!/^[0-9a-f]{64}$/.test(o.sha256)) throw new Error('Bad checksum for the update script')
  if (!/^[0-9A-Za-z.+-]+$/.test(o.version)) throw new Error('Bad version for the update script')
  if (o.arch !== 'x64' && o.arch !== 'arm64') throw new Error('Bad architecture for the update script')
  const out = script.replaceAll('@@SHA256@@', o.sha256).replaceAll('@@VERSION@@', o.version).replaceAll('@@ARCH@@', o.arch)
  if (out.includes('@@')) throw new Error('The update script has a placeholder left')
  return out
}

const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** Whether this machine's inyon (or tether-node) can be updated from the app. */
export const canUpdate = (c: HostConfig, version: string, platform?: string) =>
  isInyon(version) || (c.kind === 'node' ? !platform || platform === 'win32' : newerRelease(version, LAST_WITHOUT_UPDATE))

interface Job {
  state: 'updating' | 'updated' | 'failed'
  target: string
  error?: string
  at: number
  timer?: ReturnType<typeof setTimeout>
}

export class NodeUpdates {
  private jobs = new Map<string, Job>()
  private listeners = new Set<() => void>()
  /** the hub's script for an old Windows machine (platform and arch as it reports them), checksum filled in */
  private script?: (platform: string, arch: string) => Promise<string>
  /** the newest release on the website, for phone-paired laptops */
  latestRelease?: string

  constructor(private o = { pollMs: 3000, timeoutMs: 15 * 60_000, keepMs: 60_000, failedMs: 30 * 60_000 }) {}

  useScripts(fn: (platform: string, arch: string) => Promise<string>) {
    this.script = fn
  }

  onChange(fn: () => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private changed() {
    for (const fn of this.listeners) fn()
  }

  /** The version a machine's inyon can update to. */
  latest(c: HostConfig) {
    return c.kind === 'node' ? VERSION : c.kind === 'link' ? this.latestRelease : undefined
  }

  /** What the app shows for a machine: nothing while its inyon is current. */
  view(s: HostState): NodeUpdate | undefined {
    const job = this.jobs.get(s.config.id)
    // updated by other means meanwhile: the old failure no longer matters
    if (job && !(job.state === 'failed' && s.nodeVersion && !newerTarget(job.target, s.nodeVersion))) {
      return { latest: job.target, supported: true, state: job.state, ...(job.error ? { error: job.error } : {}) }
    }
    const latest = this.latest(s.config)
    if (!latest || !s.nodeVersion || !newerTarget(latest, s.nodeVersion)) return undefined
    return { latest, supported: canUpdate(s.config, s.nodeVersion, nodeLinks.info.get(s.config.id)?.os?.split(' ')[0]) }
  }

  /** Starts an update; says why not when it can't (the API answers 409 with that). */
  start(host: Host, s: HostState): string | undefined {
    const c = s.config
    if (c.kind !== 'node' && c.kind !== 'link') return 'Only machines running inyon can be updated from here.'
    if (s.status !== 'online' || !nodeLinks.isUp(c.id)) return `${c.name} isn't connected. Update it once it's back online.`
    if (this.jobs.get(c.id)?.state === 'updating') return `inyon on ${c.name} is already updating.`
    const info = nodeLinks.info.get(c.id)
    const version = info?.version ?? s.nodeVersion
    const latest = this.latest(c)
    const [platform = '', arch = ''] = (info?.os ?? '').split(' ')
    if (!latest) return "The newest inyon version isn't known yet. Try again in a minute."
    if (!version || !newerTarget(latest, version)) return `inyon on ${c.name} is already up to date.`
    if (!canUpdate(c, version, platform)) {
      return c.kind === 'node'
        ? `${c.name} runs tether-node from before the rename to Inyon. Copy the "Add a machine" command again and run it there.`
        : `tether-node ${version} can't update itself. Run its setup command on ${c.name} again.`
    }
    const legacy = c.kind === 'node' && !isInyon(version)
    if (legacy && !this.script) return "This hub can't send updates to tether-node."
    const job: Job = { state: 'updating', target: latest, at: Date.now() }
    clearTimeout(this.jobs.get(c.id)?.timer)
    this.jobs.set(c.id, job)
    this.changed()
    this.run(host, c, job, legacy, platform, arch, version).catch((err) => this.finish(c.id, job, 'failed', String((err as Error)?.message ?? err)))
    return undefined
  }

  private async run(host: Host, c: HostConfig, job: Job, legacy: boolean, platform: string, arch: string, version: string) {
    const input = legacy ? await this.script!(platform, arch) : undefined
    const cmd = legacy ? WINDOWS_LAUNCHER : isInyon(version) ? SELF_UPDATE : LINK_UPDATE
    if (this.jobs.get(c.id) !== job) return
    const r = await host.exec(cmd, { input, timeoutMs: 90_000 })
    if (r.code !== 0) return this.finish(c.id, job, 'failed', (r.stderr || r.stdout).trim().split('\n').at(-1) || `The update didn't start (exit code ${r.code}).`)
    this.watch(host, c.id, job)
  }

  /** Follows the update until the machine is back with the new version, it fails, or it takes too long. */
  private watch(host: Host, id: string, job: Job) {
    const tick = async () => {
      if (this.jobs.get(id) !== job || job.state !== 'updating') return
      const up = nodeLinks.isUp(id)
      const version = up ? nodeLinks.info.get(id)?.version : undefined
      if (version && !newerTarget(job.target, version)) return this.finish(id, job, 'updated')
      if (up) {
        const line = (await host.exec(READ_STATUS, { timeoutMs: 10_000 }).catch(() => undefined))?.stdout.trim() ?? ''
        if (this.jobs.get(id) !== job) return
        if (line.startsWith('failed:')) return this.finish(id, job, 'failed', sentence(line.slice(7).trim()))
        if (line.startsWith('current')) return this.finish(id, job, 'failed', 'inyon found no newer version to install.')
      }
      if (Date.now() - job.at > this.o.timeoutMs) return this.finish(id, job, 'failed', 'The update is taking too long. See ~/.inyon/node/update.log on the machine.')
      job.timer = setTimeout(tick, this.o.pollMs)
    }
    job.timer = setTimeout(tick, this.o.pollMs)
  }

  private finish(id: string, job: Job, state: 'updated' | 'failed', error?: string) {
    if (this.jobs.get(id) !== job) return
    clearTimeout(job.timer)
    job.state = state
    job.error = error
    this.changed()
    // "updated" shows for a minute; a failure stays until the next try
    job.timer = setTimeout(() => {
      if (this.jobs.get(id) !== job) return
      this.jobs.delete(id)
      this.changed()
    }, state === 'updated' ? this.o.keepMs : this.o.failedMs)
  }

  /** The phone: looks up the newest release now and every six hours. */
  watchReleases(get: typeof fetch = fetch, everyMs = 6 * 3600_000) {
    const check = async () => {
      try {
        const { version } = await fetchLatestRelease(get)
        if (version !== this.latestRelease) {
          this.latestRelease = version
          this.changed()
        }
      } catch {}
    }
    check()
    return setInterval(check, everyMs)
  }
}

export const nodeUpdates = new NodeUpdates()
