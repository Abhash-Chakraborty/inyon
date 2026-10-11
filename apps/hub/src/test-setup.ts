// Tests run commands as local processes, as the hub does; records stay in memory.
import os from 'node:os'
import path from 'node:path'
import { mkdtempSync } from 'node:fs'
import { setHostBackends } from './hosts/host.ts'
import { processBackend } from './hosts/process-backend.ts'
import { nodeBackend } from './hosts/node-backend.ts'

const processes = processBackend(path.join(os.tmpdir(), 'tether-test-cm'))
setHostBackends((c) => (c.kind === 'node' ? nodeBackend : processes))

// Any tmux a test starts gets a server of its own. With $TMUX set, tmux ignores TMUX_TMPDIR and
// talks to the server it is running inside, so both variables go.
delete process.env.TMUX
delete process.env.TMUX_PANE
process.env.TMUX_TMPDIR = mkdtempSync(path.join(os.tmpdir(), 'tether-test-tmux-'))
