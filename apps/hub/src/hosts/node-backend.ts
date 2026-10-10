import type { HostBackend } from './host.ts'
import { nodeLinks } from './node-link.ts'
import { fromBase64, toBase64 } from '../platform/base64.ts'


/** Machines running tether-node: commands travel over the node's outbound WebSocket. */
export const nodeBackend: HostBackend = {
  exec(config, cmd, opts) {
    return new Promise((resolve, reject) => {
      const input = opts.input === undefined ? undefined : toBase64(opts.input)
      let op: ReturnType<typeof nodeLinks.start>
      const timer = setTimeout(() => {
        op?.send({ op: 'kill' })
        op?.done()
        resolve({ code: 124, stdout: '', stderr: 'timed out' })
      }, opts.timeoutMs ?? 20000)
      try {
        op = nodeLinks.start(config.id, { op: 'exec', cmd, input }, (m) => {
          if (m.type === 'exit' || m.type === 'error') {
            clearTimeout(timer)
            op.done()
            if (m.type === 'error') resolve({ code: 255, stdout: '', stderr: m.error ?? 'node error' })
            else resolve({ code: m.code ?? 1, stdout: m.stdout ?? '', stderr: m.stderr ?? '' })
          }
        })
      } catch (e) {
        clearTimeout(timer)
        reject(e)
      }
    })
  },

  stream(config, cmd, onLine, opts) {
    let finish!: (code: number) => void
    const exited = new Promise<number>((r) => (finish = r))
    try {
      const op = nodeLinks.start(config.id, { op: 'stream', cmd, keepStdin: !!opts.keepStdin }, (m) => {
        if (m.type === 'line') onLine(m.data)
        else if (m.type === 'exit' || m.type === 'error') {
          op.done()
          finish(m.code ?? 1)
        }
      })
      return { kill: () => (op.send({ op: 'kill' }), op.done(), finish(143)), exited }
    } catch {
      finish(255)
      return { kill() {}, exited }
    }
  },

  pty(config, cmd, cols, rows, onData) {
    let finish!: (code: number) => void
    const exited = new Promise<number>((r) => (finish = r))
    const op = nodeLinks.start(config.id, { op: 'pty', cmd, cols, rows }, (m) => {
      if (m.type === 'data') onData(fromBase64(m.data))
      else if (m.type === 'exit' || m.type === 'error') {
        op.done()
        finish(m.code ?? 1)
      }
    })
    return {
      write: (d) => op.send({ op: 'write', data: d }),
      resize: (c, r) => op.send({ op: 'resize', cols: c, rows: r }),
      kill: () => (op.send({ op: 'kill' }), op.done(), finish(143)),
      exited,
    }
  },
}
