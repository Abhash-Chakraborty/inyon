/**
 * How a command answers: text for a person, or one JSON line (`{"v":1,"ok":true,…}`) with
 * `--json`, which the inyon command (apps/cli) reads when it runs this program for `pair`,
 * `forget`, `push` and the hub's commands. With `--json` anything meant for a person goes to
 * stderr, so stdout stays one line of JSON.
 */
export const JSON_OUT = process.argv.includes('--json')

/** The arguments without the --json flag, wherever it was given. */
export const argv = process.argv.slice(2).filter((a) => a !== '--json')

/** A line for a person: stdout, or stderr under --json. */
export const say = (...a: unknown[]) => (JSON_OUT ? console.error(...a) : console.log(...a))

/** A command's answer: `value` as JSON under --json, else `message` (when there is one). */
export function emit(value: Record<string, unknown>, message?: string) {
  if (JSON_OUT) console.log(JSON.stringify({ v: 1, ok: true, ...value }))
  else if (message) console.log(message)
}

/** Ends the command with an error: JSON on stdout and exit 1 under --json, else the message on stderr. */
export function fail(message: string, code = 2): never {
  if (JSON_OUT) {
    console.log(JSON.stringify({ v: 1, ok: false, error: message }))
    process.exit(1)
  }
  console.error(message)
  process.exit(code)
}

export interface PairOutput {
  /** the link for the app (inyon://pair?…) */
  link: string
  /** what the QR code carries: the web app's address with the pairing after # */
  qr: string
  /** the typed-in form, when the relays took it */
  short?: { id: string; code: string }
  urls: string[]
  relays: string[]
  /** whether the link runs on its own (a service), so this process ends once the code is shown */
  service: boolean
}

/** What `pair --json` prints. The short code is left out when it couldn't be published. */
export function pairResult(o: PairOutput & { typed: boolean }) {
  const { typed, short, ...rest } = o
  return { ...rest, ...(typed && short ? { short } : {}) }
}
