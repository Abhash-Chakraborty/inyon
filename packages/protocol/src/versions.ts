// The product's name and addresses, and release numbers for "Update available" checks.

/** What the product is called, everywhere a person reads it. One place, so a rename changes it once. */
export const PRODUCT = 'Inyon'
/** The lowercase form, for folders, packages, services and storage keys */
export const SLUG = 'inyon'
/** The name it had before, which migration code still reads (folders, env vars, storage keys) */
export const OLD_SLUG = 'tether'
export const SOURCE_REPO = 'Abhash-Chakraborty/inyon'
/**
 * The download page (static, on GitHub Pages at its own domain). A computer's QR code opens it
 * when scanned with a phone's camera, and it offers to copy the pairing link for the app.
 */
export const WEB_URL = 'https://inyon.abhashchakraborty.tech/'
/** The short address the one-line installers are typed with: …/get.sh and …/get.ps1 */
export const INSTALL_URL = 'https://inyon.abhashchakraborty.tech'
/** The Android application id */
export const APP_ID = 'tech.abhashchakraborty.inyon'

/** The repository the app and the inyon program are downloaded from. */
export const RELEASES_REPO = SOURCE_REPO
export const RELEASES_API = `https://api.github.com/repos/${RELEASES_REPO}/releases/latest`

/**
 * The files a release attaches for one system ("linux-x64", "windows-x64"). Release 0.13 depends
 * on these names: from then on `cli` is a small command-line program and today's program ships as
 * `engine`. Every updater from 0.11 on looks for the engine's name in SHA256SUMS and installs both
 * files when it's there, so a machine crosses over by itself. Change the names only with that in
 * mind. Each file is also attached gzipped, as its name plus .gz (see compressed); the plain file
 * stays for installs from before 0.11.
 */
export function releaseFiles(system: string) {
  const exe = system.startsWith('windows') ? '.exe' : ''
  return { cli: `inyon-${system}${exe}`, engine: `inyon-engine-${system}${exe}` }
}
/** The gzipped copy of a release file, under half the size; taken first when SHA256SUMS lists it. */
export const compressed = (file: string) => `${file}.gz`
/** The engine's name once installed, next to `inyon` in ~/.inyon/bin (plus .exe on Windows). */
export const ENGINE = 'inyon-engine'

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
