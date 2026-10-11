// Release numbers, for "Update available" checks in the hub and the apps.

/**
 * The public repository the app and tether-node are downloaded from (the source is private). One
 * place, so a rename changes it once; tether-node keeps its own copy as it bundles no shared code.
 */
export const RELEASES_REPO = 'Abhash-Chakraborty/tether-releases'
export const RELEASES_DOWNLOAD = `https://github.com/${RELEASES_REPO}/releases/latest/download`
export const RELEASES_API = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`

/**
 * A release number as [major, minor, patch]: "0.6.10" and "v0.6.10" both work. A prerelease
 * ("0.7.0-rc.1") or anything else gives undefined, so it never counts as an update.
 */
export function parseRelease(v: string): [number, number, number] | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined
}

/**
 * Whether release `next` is newer than the running version `current`. A build between releases
 * ("0.6.3-build.41", from main after 0.6.3) counts as the release it's built on.
 */
export function newerRelease(next: string, current: string): boolean {
  const a = parseRelease(next)
  const b = parseRelease(current.trim().replace(/[-+].*$/, ''))
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

/** The newest release among `versions` that is newer than `current`, if any. */
export function newestRelease(versions: string[], current: string): string | undefined {
  let best: string | undefined
  for (const v of versions) if (newerRelease(v, best ?? current)) best = v
  return best?.replace(/^v/, '')
}
