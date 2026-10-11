import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { Host } from '../hosts/host.ts'
import { drawScreen, inputCommand, openMirror, parseScreen, toInput } from './mirror.ts'

test('typing becomes literal text, keys by name, and raw bytes only for the rest', () => {
  expect(toInput('hello')).toEqual([{ text: 'hello' }])
  expect(toInput('ls -la\r')).toEqual([{ text: 'ls -la' }, { keys: ['Enter'] }])
  expect(toInput('\x1b[A\x1b[B\x1bOC\x7f\t\x03')).toEqual([{ keys: ['Up', 'Down', 'Right', 'BSpace', 'Tab', 'C-c'] }])
  expect(toInput('\x1b[1;5D\x1b[3~\x1b[5~\x1b[Z')).toEqual([{ keys: ['C-Left', 'DC', 'PPage', 'BTab'] }])
  expect(toInput('\x1bb\x1b')).toEqual([{ keys: ['M-b', 'Escape'] }])
  expect(toInput('\x1c\x1f\x00')).toEqual([{ keys: ['C-\\', 'C-_', 'C-Space'] }])
  expect(toInput('héllo ⏺ 日本')).toEqual([{ text: 'héllo ⏺ 日本' }])
  // a mouse report has no name: it goes as the bytes it is
  expect(toInput('\x1b[<0;3;4M')).toEqual([{ hex: ['1b', '5b', '3c', '30', '3b', '33', '3b', '34', '4d'] }])
})

test('a bracketed paste goes in as one paste, with the text around it kept in order', () => {
  expect(toInput('a\x1b[200~line 1\rline 2\x1b[201~\r')).toEqual([{ text: 'a' }, { paste: 'line 1\rline 2' }, { keys: ['Enter'] }])
  const c = inputCommand('%14.1', { paste: 'x\r\ny' })
  // through a file: psmux's load-buffer takes a path, not "-"
  expect(c.cmd).toMatch(/load-buffer -b 'tether-term-\w+' "\$f" && tmux paste-buffer -d -p -b 'tether-term-\w+' -t '%14\.1'/)
  expect(c.input).toBe('x\ny')
})

test("text is quoted for the shell, so it can't run as a command", () => {
  expect(inputCommand('%1', { text: "'; rm -rf ~; echo '" }).cmd).toBe(`tmux send-keys -t '%1' -l -- ''\\''; rm -rf ~; echo '\\'''`)
  expect(inputCommand('%1', { keys: ['C-\\'] }).cmd).toBe(`tmux send-keys -t '%1' 'C-\\'`)
})

test('the screen is read with its size and cursor, one entry per row', () => {
  const s = parseScreen('10 3 2 1 1\nab\n\x1b[31mred\x1b[0m\n')!
  expect(s).toEqual({ width: 10, height: 3, cursor: { x: 2, y: 1, visible: true }, lines: ['ab', '\x1b[31mred\x1b[0m', ''] })
  expect(parseScreen('')).toBeUndefined()
  expect(parseScreen("can't find pane\n")).toBeUndefined()
})

test('only the rows that changed are drawn again', () => {
  const a = parseScreen('10 3 0 0 1\none\ntwo\nthree')!
  const first = drawScreen(undefined, a)
  // wrapping off, so a pane wider than the phone is cut at the edge
  expect(first.startsWith('\x1b[?7l')).toBe(true)
  expect(first).toContain('\x1b[2;1H\x1b[0mtwo')
  const b = parseScreen('10 3 3 1 1\none\ntwo!\nthree')!
  expect(drawScreen(a, b)).toBe('\x1b[2;1H\x1b[0mtwo!\x1b[0m\x1b[K\x1b[2;4H\x1b[?25h')
  expect(drawScreen(b, b)).toBe('')
  expect(drawScreen(b, { ...b, cursor: { ...b.cursor, visible: false } })).toBe('\x1b[2;4H\x1b[?25l')
})

// The mirror only uses what psmux has (capture-pane -e, display, send-keys -l/-H/names, paste-buffer,
// resize-window), so it is checked end to end against a real tmux server of the test's own.
const dir = mkdtempSync('/tmp/tether-mirror-')
const own = `unset TMUX TMUX_PANE; export TMUX_TMPDIR='${dir}';`
const local = new Host({ id: 'mirror', name: 'mirror', kind: 'local' } as any)
const host = { ...local, config: local.config, exec: (cmd: string, o?: any) => local.exec(`${own} ${cmd}`, o) } as unknown as Host
let pane = ''

beforeAll(async () => {
  pane = (await host.exec(`tmux new-session -d -s mirror -x 80 -y 20 -P -F '#{pane_id}' "printf 'ready\\\\n'; exec cat -v"`)).stdout.trim()
  const socket = (await host.exec(`tmux display -p -t mirror '#{socket_path}'`)).stdout.trim()
  if (!socket.startsWith(dir)) throw new Error(`tmux used ${socket || 'an unknown server'}, not the test's own`)
})
afterAll(async () => {
  await local.exec(`[ -S '${dir}/tmux-'"$(id -u)"/default ] && tmux -S '${dir}/tmux-'"$(id -u)"/default kill-server 2>/dev/null; true`)
  rmSync(dir, { recursive: true, force: true })
})

const until = async (what: () => Promise<boolean> | boolean, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await what()) return
  throw new Error('timed out')
}
const screen = async () => (await host.exec(`tmux capture-pane -p -t ${pane}`)).stdout

test('a terminal on a pane shows its screen, types into it, and gives the window back when closed', async () => {
  let shown = ''
  const dec = new TextDecoder()
  const term = openMirror(host, pane, 60, 15, (d) => (shown += dec.decode(d)))
  await until(() => shown.includes('ready'))
  // the window takes the phone's size while the terminal is open
  expect((await host.exec(`tmux display -p -t ${pane} '#{window_width}x#{window_height}'`)).stdout.trim()).toBe('60x15')

  term.write('hello world\r')
  await until(async () => (await screen()).split('hello world').length === 3) // the echo, and cat's copy
  await until(() => shown.split('hello world').length >= 3)

  term.write('\x1b[A')
  await until(async () => (await screen()).includes('^[[A'))
  term.write('\x1b[200~pasted text\x1b[201~\r')
  await until(async () => (await screen()).split('pasted text').length === 3)

  term.resize(40, 10)
  await until(async () => (await host.exec(`tmux display -p -t ${pane} '#{window_width}x#{window_height}'`)).stdout.trim() === '40x10')

  term.kill()
  expect(await term.exited).toBe(0)
  await until(async () => (await host.exec(`tmux show -wv -t ${pane} window-size`)).stdout.trim() !== 'manual')
})

test('the terminal ends when its pane goes away', async () => {
  const p = (await host.exec(`tmux new-session -d -s gone -P -F '#{pane_id}' 'sleep 600'`)).stdout.trim()
  const term = openMirror(host, p, 40, 10, () => {})
  await Bun.sleep(200)
  await host.exec(`tmux kill-session -t gone`)
  expect(await Promise.race([term.exited, Bun.sleep(5000).then(() => 'still open')])).not.toBe('still open')
})
