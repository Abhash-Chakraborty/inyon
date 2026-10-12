// The product's name and addresses, and release numbers for "Update available" checks.

/** What the product is called, everywhere a person reads it. One place, so a rename changes it once. */
export const PRODUCT = 'Inyon'
/** The lowercase form, for folders, packages, services and storage keys */
export const SLUG = 'inyon'
/** The name it had before, which migration code still reads (folders, env vars, storage keys) */
export const OLD_SLUG = 'tether'
export const SOURCE_REPO = 'Abhash-Chakraborty/inyon'
/** The hosted app (a static PWA) */
export const WEB_URL = 'https://inyon.abhashchakraborty.tech'
/** The Android application id */
export const APP_ID = 'tech.abhashchakraborty.inyon'

/**
 * The public repository the app and tether-node are downloaded from (the source is private).
 * tether-node keeps its own copy as it bundles no shared code.
 */
export const RELEASES_REPO = 'Abhash-Chakraborty/inyon-releases'
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
