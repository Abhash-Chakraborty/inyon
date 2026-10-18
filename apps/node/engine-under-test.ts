import path from 'node:path'

/**
 * The engine these tests run: this folder's Bun engine, or with INYON_TEST_ENGINE set, that
 * program instead. From 0.19 the inyon command answers the engine's commands itself when it's
 * started as `inyon-engine`, so CI points this at a link of that name to the Rust build and runs
 * the same tests against it.
 */
export const ENGINE: string[] = process.env.INYON_TEST_ENGINE ? [process.env.INYON_TEST_ENGINE] : [process.execPath, path.join(import.meta.dir, 'inyon.ts')]
