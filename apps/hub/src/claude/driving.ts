/**
 * Panes whose agent menu Tether itself is working through (a model or mode change goes through
 * the agent's own picker). Those menus aren't questions for you: they're kept off the app and
 * out of "needs your input" notifications while it lasts.
 */
const driving = new Set<string>()
const key = (hostId: string, paneId: string) => `${hostId}\0${paneId}`
export const isDriving = (hostId: string, paneId: string) => driving.has(key(hostId, paneId))
export function startDriving(hostId: string, paneId: string) {
  driving.add(key(hostId, paneId))
  return () => driving.delete(key(hostId, paneId))
}
