import type { HookPaneState } from '../tmux/tmux.ts'

type Shown = 'waiting' | 'working' | 'idle'

/** The longest a turn is shown as working on the hooks' and an answer's word alone. */
const MAX_MS = 15 * 60_000
/**
 * A working Claude redraws every second (the spinner, the elapsed time); a screen that hasn't
 * changed this long is an agent that stopped, whatever the last signal said.
 */
const STILL_MS = 8_000

/** Hook events that start or continue a turn; Stop (and a new session) end it. */
const BUSY = new Set(['UserPromptSubmit', 'PermissionRequest'])
const DONE = new Set(['Stop', 'SessionStart', 'SessionEnd'])

const hookSays = (h: HookPaneState['data']): 'busy' | 'done' | undefined => {
  const name = h.hook_event_name ?? ''
  if (BUSY.has(name)) return 'busy'
  if (DONE.has(name)) return 'done'
  if (name === 'Notification') {
    // "Claude is waiting for your input" comes after a minute idle; the rest ask for something mid-turn
    return h.notification_type === 'idle_prompt' || /waiting for your input/i.test(h.message ?? '') ? 'done' : 'busy'
  }
  return undefined
}

interface Turn {
  since: number
  /** the screen showed Claude working during this turn, so its idle can be believed */
  seenWorking: boolean
  screen?: string
  sameSince: number
}

/**
 * Claude's turns as the hub knows them besides the screen. Right after a prompt is answered, and
 * while Claude runs a long command on some terminals (psmux), its screen can read as idle although
 * the turn goes on. An answer from Inyon, or a hook event that starts a turn, holds the session
 * at working until a signal says the turn ended: the Stop hook, a working screen that went idle,
 * a screen that stopped changing, or a long time.
 */
export class Turns {
  private turns = new Map<string, Turn>()
  /** when each pane's last turn ended, so the hook event that started it doesn't start it again */
  private ended = new Map<string, number>()

  /** A prompt was answered (or a message sent) from Inyon: the turn goes on. */
  start(key: string, now = Date.now()) {
    this.turns.set(key, { since: now, seenWorking: false, sameSince: now })
  }

  end(key: string, now = Date.now()) {
    this.turns.delete(key)
    this.ended.set(key, now)
  }

  forget(key: string) {
    this.turns.delete(key)
    this.ended.delete(key)
  }

  /** What to show for a pane whose screen reads `shown`, given its last hook event and screen text. */
  state(key: string, shown: Shown, screen: string, hook?: HookPaneState, now = Date.now()): Shown {
    let turn = this.turns.get(key)
    const said = hook && hookSays(hook.data)
    const at = (hook?.ts ?? 0) * 1000
    if (said === 'busy' && !turn && at > (this.ended.get(key) ?? 0) && now - at < MAX_MS) {
      this.start(key, at)
      turn = this.turns.get(key)
    }
    if (!turn) return shown
    // (hook times are whole seconds)
    if ((said === 'done' && at >= Math.floor(turn.since / 1000) * 1000) || now - turn.since > MAX_MS) {
      this.end(key, now)
      return shown
    }
    // a question mid-turn doesn't end it: once it's answered the turn carries on
    if (shown === 'waiting') {
      turn.screen = undefined
      return shown
    }
    if (shown === 'working') {
      turn.seenWorking = true
      turn.screen = undefined
      return shown
    }
    if (turn.seenWorking) {
      this.end(key, now)
      return shown
    }
    if (turn.screen !== screen) {
      turn.screen = screen
      turn.sameSince = now
    } else if (now - turn.sameSince >= STILL_MS) {
      this.end(key, now)
      return shown
    }
    return 'working'
  }
}
