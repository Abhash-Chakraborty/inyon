import type { HostState } from '@inyon/protocol'
import { shq, type Host } from './host.ts'
import { uninstallAgyIntegration, uninstallIntegration } from '../claude/integration.ts'

const hooked = (s?: HostState['integration']) => s === 'installed' || s === 'outdated' || s === 'removed'

/**
 * Removes one exact line from ~/.ssh/authorized_keys. The file is only rewritten when the copy
 * without the line has exactly the lines it should, so a full disk can never empty it.
 */
export function dropAuthorizedKey(line: string) {
  const l = shq(line)
  return `f="$HOME/.ssh/authorized_keys"; t="$f.inyon-tmp"; if [ -f "$f" ] && grep -qxF ${l} "$f"; then grep -vxF ${l} "$f" > "$t"; [ "$(wc -l < "$t")" -eq "$(( $(wc -l < "$f") - $(grep -cxF ${l} "$f") ))" ] && cat "$t" > "$f"; rm -f "$t"; fi;`
}

/**
 * Takes back what Inyon put on a machine, while it can still be reached, just before it's removed:
 * the Claude and Antigravity integration (hooks, status line, prompt log), the uploads, and any SSH
 * connection kept open to it. `also` is more shell to run there (the phone's key coming out of
 * authorized_keys). Gives up after 20 seconds; removing never waits on a machine that won't answer.
 */
export async function tidyMachine(host: Host, state: Pick<HostState, 'status' | 'integration' | 'agyIntegration'> | undefined, also = '') {
  const work = async () => {
    if (state?.status === 'online') {
      if (hooked(state.integration)) await uninstallIntegration(host).catch(() => {})
      else if (hooked(state.agyIntegration)) await uninstallAgyIntegration(host).catch(() => {})
      await host
        .exec(`rm -rf "$HOME/.inyon/uploads" "$HOME/.inyon/upload-policy" "$HOME/.inyon/events.jsonl" "$HOME/.inyon/events.old.jsonl"; ${also} true`, { timeoutMs: 10000 })
        .catch(() => {})
    }
    await host.close().catch(() => {})
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([work(), new Promise((r) => (timer = setTimeout(r, 20000)))])
  clearTimeout(timer)
}
