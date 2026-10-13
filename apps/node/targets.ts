import { releaseFiles } from '@inyon/protocol'

/**
 * The systems the engine (this program, built with Bun) ships for, and the file a release
 * attaches for each (see build.ts). Bun has no Windows on ARM build, so that system runs the
 * x64 engine under the arm64 command.
 */
export const TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'windows-x64'] as const
export type Target = (typeof TARGETS)[number]
/** The systems the inyon command (apps/cli, Rust) ships for: the engine's and Windows on ARM. */
export const CLI_TARGETS = [...TARGETS, 'windows-arm64'] as const
export type CliTarget = (typeof CLI_TARGETS)[number]
export const engineFile = (t: Target) => releaseFiles(t).engine
export const cliFile = (t: CliTarget) => releaseFiles(t).cli
