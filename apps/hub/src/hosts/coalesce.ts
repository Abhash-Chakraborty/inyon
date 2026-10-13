/**
 * Runs `fn` for the first call at once, and for anything that follows within `ms` once more at
 * the end of the window. A burst of changes (several machines answering at the same time, a
 * screen update on every pane) reaches each app as one message instead of one per change.
 */
export function coalesce(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let again = false
  return () => {
    if (timer) {
      again = true
      return
    }
    fn()
    timer = setTimeout(function tick() {
      if (!again) {
        timer = undefined
        return
      }
      again = false
      fn()
      timer = setTimeout(tick, ms)
    }, ms)
    // the hub's timers never keep it alive on their own
    timer.unref?.()
  }
}
