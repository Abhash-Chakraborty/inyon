// node publish.mjs <site-dir> [--name "Plan name"] [--slug plan-name] [--by claude|codex|gemini|opencode]
// Adds a Blueprint site to Inyon's list of pages on this machine (~/.inyon/pages.json), so it opens in
// the Inyon app under Pages. Use it when the `inyon` command isn't installed; `inyon pages add` does the
// same. Publishing a folder again updates its entry and keeps its slug. Works with no hub running: the
// hub reads the file again when it changes.
//
// Exit codes: 0 listed, 1 refused (the message says why), 2 usage, 3 Inyon isn't set up here (serve
// the site with serve.mjs instead), 4 ~/.inyon can't be written from here (run the printed command).
import { hostname } from 'node:os';
import { basename, resolve } from 'node:path';
import { LOCAL_HOST, inyonDir, publish } from './pages.mjs';

const a = process.argv.slice(2);
const opt = (k) => { const i = a.indexOf(k); if (i < 0) return undefined; const v = a[i + 1]; a.splice(i, 2); return v === undefined || v.startsWith('--') ? null : v; };
const name = opt('--name'), slug = opt('--slug'), by = opt('--by');
if (a.includes('--help') || a.includes('-h') || a.length !== 1 || [name, slug, by].includes(null)) {
  console.error('usage: node publish.mjs <site-dir> [--name "Plan name"] [--slug plan-name] [--by claude|codex|gemini|opencode]');
  process.exit(2);
}
const dir = resolve(a[0]);
const q = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const manual = () => ['inyon pages add', q(dir), ...(name ? ['--name', q(name)] : []), ...(slug ? ['--slug', q(slug)] : [])].join(' ');

try {
  const { page, changed } = publish(dir, { name, slug, by });
  console.log(`"${page.name}" is in Inyon: Pages > ${hostname()} > ${basename(page.project)}${changed ? '' : ' (already listed)'}`);
  console.log(`Open it in the app at /pages/${LOCAL_HOST}/${page.slug}`);
} catch (e) {
  if (e.code === 'ENOINYON') {
    console.error(`${e.message}. Serve the site instead: node ${new URL('serve.mjs', import.meta.url).pathname} ${q(dir)} --host <private-ip>`);
    process.exit(3);
  }
  if (['EACCES', 'EPERM', 'EROFS'].includes(e.code)) {
    console.error(`Can't write to ${inyonDir()} from here (${e.code}). Ask the user to run this once:\n  ${manual()}`);
    process.exit(4);
  }
  console.error(e.message);
  process.exit(1);
}
