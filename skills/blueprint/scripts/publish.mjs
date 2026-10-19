// node publish.mjs <site-dir> [--name "Plan name"] [--slug plan-name] [--by claude|codex|gemini|opencode]
// Adds a Blueprint site to Inyon's list of pages on this machine (~/.inyon/pages.json), so it opens in
// the Inyon app under Pages. Use it when the `inyon` command isn't installed; `inyon pages add` does the
// same. Publishing a folder again updates its entry and keeps its slug. Works with no hub running: the
// hub reads the file again when it changes.
//
// Exit codes: 0 listed, 1 refused (the message says why), 2 usage, 3 Inyon isn't set up here (serve
// the site with serve.mjs instead), 4 ~/.inyon can't be written from here (run the printed command),
// 5 listed, but this machine doesn't run a hub, so the app can't show it yet (serve it with serve.mjs too).
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { LOCAL_HOST, hubHere, inyonDir, publish } from './pages.mjs';

const a = process.argv.slice(2);
const opt = (k) => { const i = a.indexOf(k); if (i < 0) return undefined; const v = a[i + 1]; a.splice(i, 2); return v === undefined || v.startsWith('--') ? null : v; };
const name = opt('--name'), slug = opt('--slug'), by = opt('--by');
if (a.includes('--help') || a.includes('-h') || a.length !== 1 || [name, slug, by].includes(null)) {
  console.error('usage: node publish.mjs <site-dir> [--name "Plan name"] [--slug plan-name] [--by claude|codex|gemini|opencode]');
  process.exit(2);
}
const dir = resolve(a[0]);
const win = process.platform === 'win32';
// quoted for the user's own shell: PowerShell on Windows, a POSIX shell elsewhere
const q = (s) => (win
  ? (/^[\w+=:./\\-]+$/.test(s) ? s : `'${s.replace(/'/g, "''")}'`)
  : (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`));
// the installed program by its full path, so the command works where inyon isn't on the PATH
const bin = join(inyonDir(), 'bin', win ? 'inyon.exe' : 'inyon');
const inyon = existsSync(bin) ? (win ? `& ${q(bin)}` : q(bin)) : 'inyon';
const manual = () => [`${inyon} pages add`, q(dir), ...(name ? ['--name', q(name)] : []), ...(slug ? ['--slug', q(slug)] : [])].join(' ');
const serve = () => `node ${q(new URL('serve.mjs', import.meta.url).pathname)} ${q(dir)} --host <private-ip>`;

try {
  const { page, changed } = publish(dir, { name, slug, by });
  const again = changed ? '' : ' (already listed)';
  // the same lines `inyon pages add` prints; without a hub here there's no app path to hand over
  if (!hubHere()) {
    console.log(`"${page.name}" is listed on ${hostname()}, under ${basename(page.project)}${again}.`);
    console.log("This machine doesn't run a hub. For now the app shows pages from the hub's own machine only. The app can't open this page yet.");
    console.log(`Serve the site to open it now: ${serve()}`);
    process.exit(5);
  }
  console.log(`"${page.name}" is in Inyon: Pages > ${hostname()} > ${basename(page.project)}${again}`);
  console.log(`Open it in the app at /pages/${LOCAL_HOST}/${page.slug}`);
} catch (e) {
  if (e.code === 'ENOINYON') {
    console.error(`${e.message}. Serve the site instead: ${serve()}`);
    process.exit(3);
  }
  if (['EACCES', 'EPERM', 'EROFS'].includes(e.code)) {
    console.error(`Can't write to ${inyonDir()} from here (${e.code}). Ask the user to run this once:\n  ${manual()}`);
    process.exit(4);
  }
  console.error(e.message);
  process.exit(1);
}
