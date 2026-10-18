// Shared helpers for the Blueprint scripts: find Playwright and a Chromium, optional sharp, a static server.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, resolve } from 'node:path';

// Playwright comes from, in order: BLUEPRINT_PLAYWRIGHT (a folder whose node_modules has it), this folder,
// or the current project. Install it once with `bun add -d playwright` or `npm i -D playwright` anywhere.
function req(name) {
  const tries = [process.env.BLUEPRINT_PLAYWRIGHT, new URL('.', import.meta.url).pathname, process.cwd()].filter(Boolean);
  for (const dir of tries) {
    try { return createRequire(join(resolve(dir), 'package.json'))(name); } catch {}
  }
  return null;
}
export function chromium() {
  const pw = req('playwright') || req('playwright-core');
  if (!pw) { console.error('Playwright not found. Run `bun add -d playwright` (or npm) in this folder or your project, or set BLUEPRINT_PLAYWRIGHT.'); process.exit(2); }
  return pw.chromium;
}
// CHROME_PATH picks a browser binary; otherwise Playwright's own download is used (`bunx playwright install chromium`).
export async function launch() {
  const opts = { args: ['--disable-gpu'] };
  if (process.env.CHROME_PATH) opts.executablePath = process.env.CHROME_PATH;
  return chromium().launch(opts);
}
export const sharp = () => req('sharp');

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' };
// A small static server for a site folder. Never lists folders, never leaves the root.
export function serve(root, { host = '127.0.0.1', port = 0 } = {}) {
  root = resolve(root);
  const srv = createServer(async (rq, rs) => {
    try {
      let p = decodeURIComponent(new URL(rq.url, 'http://x').pathname);
      let f = resolve(join(root, p));
      if (f !== root && !f.startsWith(root + '/') && !f.startsWith(root + '\\')) throw 0;
      if ((await stat(f)).isDirectory()) f = join(f, 'index.html');
      const body = await readFile(f);
      rs.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
      rs.end(body);
    } catch { rs.writeHead(404, { 'content-type': 'text/plain' }); rs.end('not found'); }
  });
  return new Promise((ok) => srv.listen(port, host, () => ok({ url: `http://${host.includes(':') ? `[${host}]` : host}:${srv.address().port}/`, close: () => srv.close() })));
}
