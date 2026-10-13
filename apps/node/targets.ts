import { releaseFiles } from '@inyon/protocol'

/**
 * The systems a hub hands an engine to (see apps/hub node-dist): Linux against glibc, macOS and
 * Windows x64. Bun has no Windows on ARM build, so that system runs the x64 engine under the
 * arm64 command.
 */
export const HUB_TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'windows-x64'] as const
export type HubTarget = (typeof HUB_TARGETS)[number]
/**
 * The systems the engine (this program, built with Bun) ships for, and the file a release
 * attaches for each (see build.ts): the hub's, plus Linux against musl for Alpine, where the
 * glibc build doesn't start. The musl engine needs libstdc++ and libgcc from apk.
 */
export const TARGETS = [...HUB_TARGETS, 'linux-x64-musl', 'linux-arm64-musl'] as const
export type Target = (typeof TARGETS)[number]
/**
 * The systems the inyon command (apps/cli, Rust) ships for: the hub's and Windows on ARM. On
 * Linux it's one static build per processor, which runs on glibc and musl alike.
 */
export const CLI_TARGETS = [...HUB_TARGETS, 'windows-arm64'] as const
export type CliTarget = (typeof CLI_TARGETS)[number]
export const engineFile = (t: Target) => releaseFiles(t).engine
export const cliFile = (t: CliTarget) => releaseFiles(t).cli
