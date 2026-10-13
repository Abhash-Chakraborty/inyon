/**
 * What the service worker caches at install. The source (public/sw.js) has an empty list; the
 * build (vite.config.ts) fills in this build's hashed files, so a second open needs no network
 * for the app itself. Not part of the app: nothing in src imports this.
 */

/** The part of a built file the list needs (Rolldown's OutputChunk and OutputAsset have more). */
export type BuiltFile = { type: 'chunk' | 'asset'; fileName: string; isEntry?: boolean; imports?: string[]; dynamicImports?: string[]; facadeModuleId?: string | null }

/** The phone app runs the hub in-process (lib/phone.ts); the worker only runs in a browser, which never loads it. */
const PHONE_HUB = /[\\/]apps[\\/]hub[\\/]src[\\/]phone[\\/]index\.ts$/

/** Every asset, and the chunks a browser can reach from the entry: the phone's hub and what only it imports are left out. */
export function browserFiles(bundle: Record<string, BuiltFile>): string[] {
  const seen = new Set<string>()
  const walk = (name: string) => {
    const f = bundle[name]
    if (!f || f.type !== 'chunk' || seen.has(name) || PHONE_HUB.test(f.facadeModuleId ?? '')) return
    seen.add(name)
    for (const next of [...(f.imports ?? []), ...(f.dynamicImports ?? [])]) walk(next)
  }
  for (const f of Object.values(bundle)) if (f.type === 'chunk' && f.isEntry) walk(f.fileName)
  return Object.values(bundle).filter((f) => f.type === 'asset' || seen.has(f.fileName)).map((f) => f.fileName)
}

/** The worker's source with the files to cache filled in. */
export function withPrecacheList(sw: string, files: string[]): string {
  const marker = /^const ASSETS = \[\]/m
  if (!marker.test(sw)) throw new Error('sw.js has no `const ASSETS = []` line to fill in')
  const list = files.filter((a) => a.startsWith('assets/')).sort()
  return sw.replace(marker, `const ASSETS = ${JSON.stringify(list)}`)
}
