import { Host, shq } from '../hosts/host.ts'

/**
 * Real-time pane activity from tmux itself. One control-mode client per tmux session (read-only,
 * and flagged so it never affects window sizes) reports `%output` for every pane as it changes,
 * plus structural events (windows/panes opened, closed, renamed).
 */
export class LiveTmux {
  private clients = new Map<string, { kill(): void }>()

  constructor(
    private host: Host,
    private onOutput: (pane: string) => void,
    private onStructure: () => void,
  ) {}

  /** Keep exactly one client per session id in `sessions`. */
  sync(sessions: string[]) {
    const want = new Set(sessions)
    for (const [id, c] of this.clients) {
      if (!want.has(id)) {
        c.kill()
        this.clients.delete(id)
      }
    }
    for (const id of want) if (!this.clients.has(id)) this.attach(id)
  }

  private attach(id: string) {
    const cmd = `exec tmux -C attach-session -t ${shq(id)} -f read-only,ignore-size`
    const s = this.host.stream(
      cmd,
      (line) => {
        if (line.startsWith('%output ') || line.startsWith('%extended-output ')) {
          const pane = line.split(' ', 3)[1]
          if (pane?.startsWith('%')) this.onOutput(pane)
        } else if (/^%(window-add|window-close|unlinked-window-add|unlinked-window-close|window-renamed|layout-change|sessions-changed|session-renamed|pane-mode-changed|window-pane-changed)\b/.test(line)) {
          this.onStructure()
        } else if (line.startsWith('%exit')) {
          this.clients.delete(id)
        }
      },
      { keepStdin: true },
    )
    this.clients.set(id, s)
    s.exited.then(() => {
      if (this.clients.get(id) === s) this.clients.delete(id)
    })
  }

  stop() {
    for (const c of this.clients.values()) c.kill()
    this.clients.clear()
  }
}
