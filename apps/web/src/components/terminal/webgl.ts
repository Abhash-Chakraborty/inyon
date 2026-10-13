import type { Terminal } from '@xterm/xterm'
import { setRenderer } from '../../lib/renderer.ts'

type WebglModule = Pick<typeof import('@xterm/addon-webgl'), 'WebglAddon'>

/**
 * Draws an opened terminal with WebGL, which is far cheaper than the DOM renderer on a phone. The
 * addon comes in its own chunk once the terminal is up. Without WebGL (activating throws) or when
 * the browser drops the context later, xterm's default renderer takes over again.
 */
export function attachWebgl(term: Terminal, load: () => Promise<WebglModule> = () => import('@xterm/addon-webgl')) {
  let closed = false
  let addon: { dispose(): void } | undefined
  const done = load().then(
    ({ WebglAddon }) => {
      if (closed) return
      const a = new WebglAddon()
      a.onContextLoss(() => {
        a.dispose()
        addon = undefined
        setRenderer('dom')
      })
      try {
        term.loadAddon(a)
        addon = a
        setRenderer('webgl')
      } catch {
        setRenderer('dom')
      }
    },
    () => setRenderer('dom'),
  )
  return {
    /** settled once the renderer is decided (tests) */
    done,
    dispose() {
      closed = true
      addon?.dispose()
      addon = undefined
    },
  }
}
