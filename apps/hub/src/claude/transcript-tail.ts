import { shq } from '../hosts/host.ts'

/**
 * Following a transcript file on another machine. A long session's file runs to tens of megabytes,
 * mostly screenshots as base64 the app never shows, so a remote read drops those on the machine
 * itself. Every line's real size is still counted, so after a dropped connection the read picks up
 * at the byte where it stopped instead of starting over.
 */

/** Bytes a string takes as UTF-8, without encoding it (transcript lines can be megabytes). */
export function utf8Length(s: string) {
  let n = s.length
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 2 // a surrogate pair is 4 bytes, 2 already counted
      i++
    } else if (c > 0x7ff) n += 2
    else if (c > 0x7f) n += 1
  }
  return n
}

/**
 * Prints each line's size in the file (a line of \x1e and the bytes, newline included) before the
 * line, so the count doesn't depend on how the other end decodes text. In lines that carry base64
 * (images), each run of 1024+ base64 characters becomes an ellipsis; prose, paths and hashes always
 * break sooner. Written for any POSIX awk (gawk, mawk, busybox, macOS).
 */
const SLIM = `BEGIN { r = "[A-Za-z0-9+/=]"; for (i = 0; i < 10; i++) r = r r; r = r "[A-Za-z0-9+/=]*" }
{
  n = length($0); s = $0; o = ""; cut = 0
  if (n > 1024 && index(s, "base64")) while (match(s, r)) {
    a = RSTART; l = RLENGTH
    if (a > 1 && substr(s, a - 1, 1) == "\\\\") { a++; l-- }
    o = o substr(s, 1, a - 1) "…"; s = substr(s, a + l); cut = 1
  }
  printf "\\036%d\\n", n + 1
  if (cut) print o s
  else print
  fflush()
}`

/**
 * Follows `path` from byte `from`; `slim` drops image data on the far side (for remote machines).
 * With `follow` off it reads to the end and exits.
 *
 * A remote follow must run with stdin kept open (`keepStdin`): it ends itself when stdin closes.
 * Over SSH nothing else stops it. Closing the connection doesn't signal `tail -F | awk`, and they
 * only notice once they write to the closed connection, which for a quiet transcript is never.
 */
export function tailCommand(path: string, from: number, slim: boolean, follow = true) {
  const tail = `tail -c +${from + 1}${follow ? ' -F' : ''} ${shq(path)} 2>/dev/null`
  if (!slim) return `exec ${tail}`
  // mawk holds back piped input until its buffer fills unless it's told the input is live
  const run = `if command -v awk >/dev/null 2>&1; then a=awk; case "$(awk -W version </dev/null 2>&1 | head -n 1)" in *mawk*) a="awk -W interactive";; esac; ${tail} | LC_ALL=C $a ${shq(SLIM)}; else ${tail}; fi`
  if (!follow) return run
  // a background job's stdin is /dev/null, so it watches the real one through fd 3; once that
  // closes it stops this shell's other children (tail and awk), and when they end it goes too
  return `exec 3<&0; { cat <&3; pkill -P $$; } >/dev/null 2>&1 & w=$!; ${run}; kill $w 2>/dev/null`
}

/**
 * The file's size, and whether byte `from` starts a line (the one before it is a newline), so a
 * read can carry on from there. Prints "<size> <ok>".
 */
export function sizeCommand(path: string, from: number) {
  const f = shq(path)
  if (!from) return `echo "$(wc -c < ${f} 2>/dev/null || echo 0) 1"`
  return `echo "$(wc -c < ${f} 2>/dev/null || echo 0) $(dd if=${f} bs=1 skip=${from - 1} count=1 2>/dev/null | od -An -tx1 | tr -d ' \\n' | grep -c '^0a$')"`
}

export function parseSize(stdout: string) {
  const [size, ok] = stdout.trim().split(/\s+/)
  return { size: Number(size) || 0, aligned: ok === '1' }
}

/** Turns the lines of a tail into entries, keeping count of how far into the file they reach. */
export class TranscriptReader {
  /** bytes of the file read up to the end of the last complete line */
  offset: number
  private size?: number
  /** a line that didn't parse; the stream may have cut it short, so it counts once another follows */
  private held = 0

  constructor(from = 0) {
    this.offset = from
  }

  /** The line's entry (if it is one) and the bytes it took in the file; undefined for a size mark. */
  line(raw: string): { entry?: any; bytes: number } | undefined {
    if (raw.charCodeAt(0) === 0x1e) {
      // two marks in a row: the line between was empty, and streams don't pass empty lines on
      if (this.size !== undefined) this.offset += this.size
      this.size = Number(raw.slice(1)) || undefined
      return undefined
    }
    const bytes = this.size ?? utf8Length(raw) + 1
    this.size = undefined
    this.offset += this.held
    this.held = 0
    let entry: any
    try {
      entry = JSON.parse(raw)
    } catch {
      this.held = bytes
      return { bytes }
    }
    this.offset += bytes
    return { entry, bytes }
  }
}
