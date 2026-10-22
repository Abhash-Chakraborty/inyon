import { closeSync, constants, ftruncateSync, lstatSync, openSync, rmSync, writeSync } from 'node:fs'
import { dlopen, FFIType, ptr } from 'bun:ffi'

/**
 * An OS lock on a file: flock on Linux and macOS, LockFileEx on Windows, the same calls Rust's
 * `File::try_lock` makes, so the Bun engine and the built-in one keep each other out. The system
 * lets go of it when the holder exits or dies, so no lock is ever judged stale by its age.
 */
export interface Held {
  release(): void
}

const LOCK_EX = 2
const LOCK_NB = 4

type Posix = { flock: (fd: number, op: number) => number }
type Win = {
  CreateFileW: (name: ReturnType<typeof ptr>, access: number, share: number, sec: null, how: number, flags: number, template: null) => bigint
  LockFileEx: (h: bigint, flags: number, reserved: number, low: number, high: number, overlapped: ReturnType<typeof ptr>) => number
  CloseHandle: (h: bigint) => number
}

let posix: Posix | null | undefined
let win: Win | null | undefined

function loadPosix(): Posix | null {
  if (posix !== undefined) return posix
  const names = process.platform === 'darwin' ? ['libSystem.B.dylib', '/usr/lib/libSystem.B.dylib'] : ['libc.so.6', 'libc.so', `libc.musl-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}.so.1`]
  posix = null
  for (const name of names) {
    try {
      posix = dlopen(name, { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }).symbols as unknown as Posix
      break
    } catch {}
  }
  return posix
}

function loadWin(): Win | null {
  if (win !== undefined) return win
  try {
    win = dlopen('kernel32.dll', {
      CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i64 },
      LockFileEx: { args: [FFIType.i64, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
      CloseHandle: { args: [FFIType.i64], returns: FFIType.i32 },
    }).symbols as unknown as Win
  } catch {
    win = null
  }
  return win
}

/** Anything but a plain file in the lock's place (a symlink, dangling or not, a folder) goes first. */
function clearWay(file: string) {
  try {
    const st = lstatSync(file)
    if (!st.isFile()) rmSync(file, { recursive: true, force: true })
  } catch {}
}

/**
 * Locks `file` now, or returns null when another process holds it. Throws when the system can't
 * lock at all (the caller says so and decides).
 */
export function tryLock(file: string): Held | null {
  clearWay(file)
  if (process.platform === 'win32') {
    const k = loadWin()
    if (!k) throw new Error("couldn't load kernel32 to lock files")
    const name = Buffer.from(`${file}\0`, 'utf16le')
    // GENERIC_READ | GENERIC_WRITE, shared like Rust's open, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL
    const h = k.CreateFileW(ptr(name), 0xc0000000, 7, null, 4, 0x80, null)
    if (h === -1n) throw new Error(`couldn't open ${file}`)
    // the whole file, as Rust's lock takes it: LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY
    const overlapped = new Uint8Array(32)
    if (!k.LockFileEx(h, 3, 0, 0xffffffff, 0xffffffff, ptr(overlapped))) {
      k.CloseHandle(h)
      return null
    }
    return { release: () => void k.CloseHandle(h) }
  }
  const c = loadPosix()
  if (!c) throw new Error("couldn't load libc to lock files")
  const fd = openSync(file, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
  if (c.flock(fd, LOCK_EX | LOCK_NB) !== 0) {
    closeSync(fd)
    return null
  }
  try {
    // for whoever looks: the pid that holds it
    ftruncateSync(fd, 0)
    writeSync(fd, `${process.pid}\n`, 0)
  } catch {}
  return { release: () => closeSync(fd) }
}
