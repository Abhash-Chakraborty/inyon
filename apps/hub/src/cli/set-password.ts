import { setPassword } from '../config.ts'

const pw = process.argv[2] ?? prompt('New Tether password:')
if (!pw || pw.length < 8) {
  console.error('Use at least 8 characters.')
  process.exit(1)
}
setPassword(pw)
console.log('Password updated. Existing sign-ins were signed out; restart the hub if it is running.')
