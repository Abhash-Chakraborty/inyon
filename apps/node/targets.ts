/** The systems the inyon program is built for, and its file name for each (see build.ts). */
export const TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'windows-x64'] as const
export type Target = (typeof TARGETS)[number]
export const fileName = (t: Target) => `inyon-${t}${t.startsWith('windows') ? '.exe' : ''}`
