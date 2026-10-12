import '../env.ts'
import { passwordProblem, setPassword } from '../password.ts'

// for a forgotten password; otherwise change it in Settings
const pw = process.argv[2] ?? prompt('New Inyon password:') ?? ''
const problem = passwordProblem(pw)
if (problem) {
  console.error(problem)
  process.exit(1)
}
setPassword(pw)
console.log('Password updated. Existing sign-ins were signed out; restart the hub if it is running.')
