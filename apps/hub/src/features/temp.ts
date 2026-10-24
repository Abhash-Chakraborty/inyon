import { shq } from '../hosts/host.ts'
import { HttpError, registry } from '../hosts/registry.ts'

/**
 * Agent temp files: the pasted images, screenshots and scratch folders coding agents leave on a
 * machine, for the app's Temp files screen. The machine's own `inyon temp … --json` does the work
 * (apps/cli/src/temp.rs): it knows the folders, checks every path is strictly inside one of them
 * and never follows a link out. The hub only runs it and hands the answer on, so a machine reached
 * over SSH, a paired one and the hub's own all behave the same.
 */

/**
 * The machine's inyon: the one the connection runs from (INYON_EXE, set for paired machines), else
 * the one on PATH or in ~/.inyon/bin. Exit 127 when there's none.
 */
export const INYON = `x="\${INYON_EXE:-}"; s="\${INYON_SCRIPT:-}"
if [ -z "$x" ]; then x="$(command -v inyon 2>/dev/null)"; s=; fi
if [ -z "$x" ] && [ -x "$HOME/.inyon/bin/inyon" ]; then x="$HOME/.inyon/bin/inyon"; fi
[ -n "$x" ] || { echo 'inyon: not found' >&2; exit 127; }
"$x" \${s:+"$s"} temp`

/** The biggest image the app gets whole (as the CLI's own limit). */
export const PREVIEW_MAX = 8 * 1024 * 1024

export const tooOld = (name: string) => `Update Inyon on ${name} to see its temp files`
export const missing = (name: string) => `Install Inyon on ${name} to see its temp files`

/** What an inyon from before `temp` says when asked for it (clap's words, and the engine's). */
const UNKNOWN = /unrecognized subcommand|unexpected argument|unknown command|^inyon-engine\b|^usage:/im

function machine(hostId: string) {
  const rt = registry.get(hostId)
  if (!rt) throw new HttpError(404, 'Unknown machine')
  if (!rt.probe?.home) throw new HttpError(503, 'Machine is not connected yet')
  return { host: rt.host, name: rt.host.config.name }
}

/** Runs `inyon temp <args> --json` on the machine and reads its answer. */
async function run(hostId: string, args: string, input?: string, timeoutMs = 60_000): Promise<Record<string, unknown>> {
  const { host, name } = machine(hostId)
  const r = await host.exec(`${INYON} ${args}`, { input, timeoutMs })
  return readAnswer(name, r)
}

/** The command's JSON, or the error a person can act on. */
export function readAnswer(name: string, r: { code: number; stdout: string; stderr: string }): Record<string, unknown> {
  let data: unknown
  try {
    data = JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '')
  } catch {}
  if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>
  const said = `${r.stderr}\n${r.stdout}`
  if (r.code === 127 || /inyon: not found/.test(said)) throw new HttpError(409, missing(name))
  if (UNKNOWN.test(said)) throw new HttpError(409, tooOld(name))
  if (r.code === 124) throw new HttpError(504, `${name} took too long to answer`)
  throw new HttpError(500, said.trim().split('\n').at(-1) || `Couldn't read the temp files on ${name}`)
}

/** A refusal from the command itself ("That isn't inside one of the temp folders…"). */
function refused(data: Record<string, unknown>) {
  if (data.ok === false && typeof data.error === 'string') throw new HttpError(400, data.error)
  return data
}

/** Everything in the machine's temp folders, one item per session folder, upload day or loose file. */
export async function tempList(hostId: string) {
  return refused(await run(hostId, 'ls --json'))
}

/** Every file inside one item, newest first. */
export async function tempFiles(hostId: string, path: string) {
  if (!path) throw new HttpError(400, 'Which item?')
  return refused(await run(hostId, `files --json -- ${shq(path)}`))
}

/** One file to look at: text, or an image as base64 up to `max` bytes. */
export async function tempPreview(hostId: string, path: string, max = PREVIEW_MAX) {
  if (!path) throw new HttpError(400, 'Which file?')
  const limit = Math.max(1, Math.min(PREVIEW_MAX, Math.floor(Number(max)) || PREVIEW_MAX))
  return refused(await run(hostId, `show --json --max ${limit} -- ${shq(path)}`))
}

/**
 * Deletes items for good. The paths go on stdin, so a long list fits where a command line
 * wouldn't (Windows stops at 32k characters). Paths the machine refused come back in `failed`.
 */
export async function tempDelete(hostId: string, paths: unknown) {
  if (!Array.isArray(paths) || !paths.length || !paths.every((p) => typeof p === 'string' && p)) throw new HttpError(400, 'Send the paths to delete')
  const data = await run(hostId, 'rm --stdin --json', JSON.stringify(paths), 120_000)
  // nothing deleted is still an answer: the app shows each path and why it stayed
  if (Array.isArray(data.failed)) return { ...data, ok: true }
  return refused(data)
}
