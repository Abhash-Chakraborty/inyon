import { shq, type PtyHandle } from '../hosts/host.ts'
import { HttpError, registry } from '../hosts/registry.ts'
import { VIEW_PREFIX } from '../tmux/tmux.ts'
import { openMirror } from './mirror.ts'

/**
 * Mouse bindings for the view's own key table: wheel scrolls into tmux's history, clicks and drags
 * work as usual. Nothing else is bound, so the prefix key does nothing and every other key goes to
 * the program in the pane.
 */
export const VIEW_KEYS = [
  `bind-key -T inyon-view WheelUpPane if-shell -F '#{||:#{pane_in_mode},#{mouse_any_flag}}' 'send-keys -M' 'copy-mode -e'`,
  `bind-key -T inyon-view MouseDown1Pane 'select-pane -t = ; send-keys -M'`,
  `bind-key -T inyon-view MouseDrag1Pane if-shell -F '#{||:#{pane_in_mode},#{mouse_any_flag}}' 'send-keys -M' 'copy-mode -M'`,
].map((c) => `tmux ${c}`).join('; ')

/**
 * Opens a terminal on one pane's window, and only that window: a throwaway session that holds just
 * a link to it, with no status bar and a key table without the prefix, so the phone can't wander
 * off to other windows or sessions (or switch the laptop's view). The window itself is shared, so
 * what you type shows on the laptop too. The view session dies when we detach.
 */
export function openTerminal(
  hostId: string,
  paneId: string,
  cols: number,
  rows: number,
  onData: (d: Uint8Array) => void,
): PtyHandle {
  const found = registry.findPane(hostId, paneId)
  if (!found) throw new HttpError(404, 'Pane not found')
  const host = registry.host(hostId)
  // psmux runs one server per session, so a view session can't link another session's window
  if (registry.get(hostId)?.state?.os === 'Windows') {
    return openMirror(host, paneId, Math.max(10, cols), Math.max(4, rows), onData, (fn) =>
      registry.on((e) => e.type === 'pane-output' && e.host === hostId && e.pane === paneId && fn()),
    )
  }
  const view = `${VIEW_PREFIX}${Math.random().toString(36).slice(2, 8)}`
  const v = shq(view)
  const cmd = [
    `${VIEW_KEYS}; exec tmux -u new-session -s ${v} -n inyon-tmp`,
    `\\; link-window -s ${shq(found.window.id)} -t ${shq(`${view}:`)}`,
    `\\; kill-window -t ${shq(`${view}:inyon-tmp`)}`,
    `\\; set-option -t ${v} status off`,
    `\\; set-option -t ${v} key-table inyon-view`,
    `\\; set-option -t ${v} destroy-unattached on`,
    `\\; select-pane -t ${shq(paneId)}`,
  ].join(' ')
  return host.pty(cmd, Math.max(10, cols), Math.max(4, rows), onData)
}
