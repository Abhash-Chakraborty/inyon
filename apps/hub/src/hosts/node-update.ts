import { newerRelease, RELEASES_API, VERSION, type HostConfig, type HostState, type NodeUpdate } from '@inyon/protocol'
import type { Host } from './host.ts'
import { nodeLinks } from './node-link.ts'

/**
 * Updating tether-node from the app, one tap, never on its own. A machine paired with the hub gets
 * a script (apps/node/hub-update.sh or .ps1) through the plain exec command every tether-node
 * version understands, so one from before `tether-node update` existed can be updated too. The
 * script runs detached, since restarting tether-node ends the command that started it, checks the
 * download against the checksum the hub filled in, and puts the old copy back if the new one won't
 * start. A laptop paired with the phone runs `tether-node update --background` (newer versions).
 * Progress is read from ~/.tether-node/update-status; success is the machine coming back with the
 * new version.
 */

/** The first version with `tether-node update`; a phone-paired laptop before it reinstalls instead. */
const LAST_WITHOUT_UPDATE = '0.6.3'

/** Writes the script the hub sent and starts it detached; the script's output goes to update.log. */
export function updateLauncher(platform: string) {
  if (platform === 'win32') {
    return `d="$HOME/.tether-node"
mkdir -p "$d" && cat > "$d/update.ps1" && printf 'running\\n' > "$d/update-status" || exit 1
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$d/update.ps1" -Launch < /dev/null`
  }
  // outside tether-node's systemd unit, so the restart doesn't end the update; elsewhere in a
  // session of its own. The script stops the tether-node that ran this ($PPID) when there's no
  // service manager to restart it.
  return `d="$HOME/.tether-node"
mkdir -p "$d" && cat > "$d/update.sh" && printf 'running\\n' > "$d/update-status" || exit 1
TETHER_NODE_PID=$PPID
export TETHER_NODE_PID
if [ -f "$HOME/.config/systemd/user/tether-node.service" ] && command -v systemd-run > /dev/null 2>&1 && systemd-run --user --collect --quiet /bin/sh "$d/update.sh" < /dev/null > /dev/null 2>&1; then exit 0; fi
if command -v setsid > /dev/null 2>&1; then
  setsid /bin/sh "$d/update.sh" < /dev/null > /dev/null 2>&1 &
else
  nohup /bin/sh "$d/update.sh" < /dev/null > /dev/null 2>&1 &
fi
exit 0`
}

/** For a laptop paired with the phone: its own `tether-node update`, started on its own. */
export const LINK_UPDATE = '"$TETHER_NODE_EXE" ${TETHER_NODE_SCRIPT:+"$TETHER_NODE_SCRIPT"} update --background'
const READ_STATUS = 'cat "$HOME/.tether-node/update-status" 2>/dev/null; true'

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

/** Whether this tether-node can update itself from the app. */
export const canUpdate = (c: HostConfig, version: string) => c.kind === 'node' || newerRelease(version, LAST_WITHOUT_UPDATE)

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
  /** the hub's script for a machine (platform and arch as tether-node reports them), checksum filled in */
  private script?: (platform: string, arch: string) => Promise<string>
  /** the newest tether-node on inyon-releases, for phone-paired laptops */
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

  /** The version a machine's tether-node can update to. */
  latest(c: HostConfig) {
    return c.kind === 'node' ? VERSION : c.kind === 'link' ? this.latestRelease : undefined
  }

  /** What the app shows for a machine: nothing while its tether-node is current. */
  view(s: HostState): NodeUpdate | undefined {
    const job = this.jobs.get(s.config.id)
    // updated by other means meanwhile: the old failure no longer matters
    if (job && !(job.state === 'failed' && s.nodeVersion && !newerRelease(job.target, s.nodeVersion))) {
      return { latest: job.target, supported: true, state: job.state, ...(job.error ? { error: job.error } : {}) }
    }
    const latest = this.latest(s.config)
    if (!latest || !s.nodeVersion || !newerRelease(latest, s.nodeVersion)) return undefined
    return { latest, supported: canUpdate(s.config, s.nodeVersion) }
  }

  /** Starts an update; says why not when it can't (the API answers 409 with that). */
  start(host: Host, s: HostState): string | undefined {
    const c = s.config
    if (c.kind !== 'node' && c.kind !== 'link') return 'Only machines running tether-node can be updated from here.'
    if (s.status !== 'online' || !nodeLinks.isUp(c.id)) return `${c.name} isn't connected. Update it once it's back online.`
    if (this.jobs.get(c.id)?.state === 'updating') return `tether-node on ${c.name} is already updating.`
    const info = nodeLinks.info.get(c.id)
    const version = info?.version ?? s.nodeVersion
    const latest = this.latest(c)
    if (!latest) return "The newest tether-node version isn't known yet. Try again in a minute."
    if (!version || !newerRelease(latest, version)) return `tether-node on ${c.name} is already up to date.`
    if (!canUpdate(c, version)) return `tether-node ${version} can't update itself. Run its setup command on ${c.name} again.`
    if (c.kind === 'node' && !this.script) return "This hub can't send tether-node updates."
    const [platform = '', arch = ''] = (info?.os ?? '').split(' ')
    const job: Job = { state: 'updating', target: latest, at: Date.now() }
    clearTimeout(this.jobs.get(c.id)?.timer)
    this.jobs.set(c.id, job)
    this.changed()
    this.run(host, c, job, platform, arch).catch((err) => this.finish(c.id, job, 'failed', String((err as Error)?.message ?? err)))
    return undefined
  }

  private async run(host: Host, c: HostConfig, job: Job, platform: string, arch: string) {
    const input = c.kind === 'node' ? await this.script!(platform, arch) : undefined
    const cmd = c.kind === 'node' ? updateLauncher(platform) : LINK_UPDATE
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
      if (version && !newerRelease(job.target, version)) return this.finish(id, job, 'updated')
      if (up) {
        const line = (await host.exec(READ_STATUS, { timeoutMs: 10_000 }).catch(() => undefined))?.stdout.trim() ?? ''
        if (this.jobs.get(id) !== job) return
        if (line.startsWith('failed:')) return this.finish(id, job, 'failed', sentence(line.slice(7).trim()))
        if (line.startsWith('current')) return this.finish(id, job, 'failed', 'tether-node found no newer version to install.')
      }
      if (Date.now() - job.at > this.o.timeoutMs) return this.finish(id, job, 'failed', 'The update is taking too long. See ~/.tether-node/update.log on the machine.')
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

  /** The phone: looks up the newest tether-node release now and every six hours. */
  watchReleases(get: typeof fetch = fetch, everyMs = 6 * 3600_000) {
    const check = async () => {
      try {
        const r = await get(RELEASES_API, { headers: { accept: 'application/vnd.github+json' } })
        const tag = r.ok ? String(((await r.json()) as { tag_name?: string })?.tag_name ?? '') : ''
        const version = tag.replace(/^v/, '')
        if (/^\d+(\.\d+)*/.test(version) && version !== this.latestRelease) {
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
