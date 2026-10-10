// Tests run commands as local processes, as the hub does; records stay in memory.
import os from 'node:os'
import path from 'node:path'
import { setHostBackends } from './hosts/host.ts'
import { processBackend } from './hosts/process-backend.ts'
import { nodeBackend } from './hosts/node-backend.ts'

const processes = processBackend(path.join(os.tmpdir(), 'tether-test-cm'))
setHostBackends((c) => (c.kind === 'node' ? nodeBackend : processes))
