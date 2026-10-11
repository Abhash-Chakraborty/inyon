import { REPO, updateHub, writeJob } from '../features/hub-update.ts'

// pnpm hub:update: pulls the newest Tether, installs, builds the web app and restarts the hub.
// Settings starts it too, with --job naming the file where the hub reads its progress.
const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i > 1 ? process.argv[i + 1] : undefined
}
const job = arg('--job')
const repo = arg('--repo') ?? REPO

const r = await updateHub({ repo, step: (step) => job && writeJob(job, { step }) })
if (job) writeJob(job, r.ok ? { done: true, restarted: r.restarted } : { error: r.error })
process.exit(r.ok ? 0 : 1)
