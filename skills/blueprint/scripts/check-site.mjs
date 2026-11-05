// node check-site.mjs <dir>
// Checks that a reader can get around a Blueprint site: every page is in site.js, every entry has its
// file, every page loads the site bar (kit/nav.js), and no entry leaves the folder. Exits 1 with a list
// of what to fix. Needs no browser, so run it after every page you add.
import { checkSite } from './site.mjs';

const dir = process.argv[2];
if (!dir) { console.error('usage: node check-site.mjs <dir>'); process.exit(2); }
const problems = checkSite(dir);
if (problems.length) { console.log(`${problems.length} to fix:\n- ${problems.join('\n- ')}`); process.exit(1); }
console.log('Every page is listed and has the site bar.');
