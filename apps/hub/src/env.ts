import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { useStore } from './platform/store.ts'
import { fsStore } from './platform/fs-store.ts'
import { setLocalHost } from './config.ts'
import { setHostBackends } from './hosts/host.ts'
import { processBackend } from './hosts/process-backend.ts'
import { nodeBackend } from './hosts/node-backend.ts'

// The hub process: records as files under ~/.tether, and this machine as the "local" host.
// Imported first by the hub's entry points, before anything reads a record.
export const DATA_DIR = process.env.TETHER_DATA_DIR || path.join(os.homedir(), '.tether')
export const PORT = Number(process.env.PORT || 4777)
export const BIND = process.env.BIND || '127.0.0.1'
/**
 * Serve HTTPS directly (paths to a PEM certificate and key). Browsers only treat the app as
 * installable, and allow clipboard images and notifications, on HTTPS.
 */
export const TLS = process.env.TLS_CERT && process.env.TLS_KEY ? { cert: process.env.TLS_CERT, key: process.env.TLS_KEY } : undefined

useStore(fsStore(DATA_DIR))
fs.mkdirSync(path.join(DATA_DIR, 'cm'), { recursive: true, mode: 0o700 })
setLocalHost({ id: 'local', name: os.hostname(), kind: 'local' })
const processes = processBackend(path.join(DATA_DIR, 'cm'))
setHostBackends((c) => (c.kind === 'node' ? nodeBackend : processes))
