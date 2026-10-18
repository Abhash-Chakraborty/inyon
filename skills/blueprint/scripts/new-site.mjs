// node new-site.mjs <dir> --name "Product" [--force]
// Copies the Blueprint site template into <dir> and sets the product name. Then replace the sample
// "Pantry" content: kit/data.js, mockups/screens.js, the screens, matrix-data.js, progress.json, index.html.
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
const a = process.argv.slice(2);
const opt = (k) => { const i = a.indexOf(k); return i < 0 ? null : a.splice(i, 2)[1]; };
const force = a.includes('--force'); const rest = a.filter((x) => x !== '--force');
const name = opt('--name');
const dir = rest.find((x) => x !== name);
if (!dir) { console.error('usage: node new-site.mjs <dir> --name "Product" [--force]'); process.exit(2); }
const out = resolve(dir);
if (existsSync(out) && readdirSync(out).length && !force) { console.error(`${out} is not empty; pass --force to copy over it`); process.exit(1); }
cpSync(new URL('../assets/site', import.meta.url).pathname, out, { recursive: true });
if (name) {
  const f = join(out, 'kit/data.js');
  writeFileSync(f, readFileSync(f, 'utf8').replace("name: 'Pantry'", `name: ${JSON.stringify(name).replace(/^"|"$/g, "'")}`));
}
console.log(`Blueprint site in ${out}${name ? ` for ${name}` : ''}.\nServe it: node ${new URL('serve.mjs', import.meta.url).pathname} ${dir} --host <private-ip>`);
