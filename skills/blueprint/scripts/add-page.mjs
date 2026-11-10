// node add-page.mjs <dir> <id> --title "Battery tests" [--group Research] [--icon battery] [--blurb "..."]
//                   [--lede "..."] [--parent <id>] [--after <id>] [--hidden]
// node add-page.mjs <dir> --adopt
// Adds a page to a Blueprint site: <dir>/<id>.html from _page.html, listed in site.js, so the site bar,
// the crumbs, the previous/next links and the plan's page cards all reach it. Give each topic its own page
// rather than growing the plan. --adopt brings a site made before the site bar onto it: kit/nav.js, the
// bar's styles, site.js listing every page it finds, and the bar on every page that loads the kit.
import { relative } from 'node:path';
import { addPage, adopt, checkSite } from './site.mjs';

const a = process.argv.slice(2);
const opt = (k) => { const i = a.indexOf(k); return i < 0 ? undefined : a.splice(i, 2)[1]; };
const flag = (k) => { const i = a.indexOf(k); if (i < 0) return false; a.splice(i, 1); return true; };
const usage = 'usage: node add-page.mjs <dir> <id> --title "Title" [--group G] [--icon lucide-name] [--blurb "..."] [--lede "..."] [--parent id] [--after id] [--hidden]\n       node add-page.mjs <dir> --adopt';
const o = { title: opt('--title'), group: opt('--group'), icon: opt('--icon'), blurb: opt('--blurb'), lede: opt('--lede'), parent: opt('--parent'), after: opt('--after'), hidden: flag('--hidden') };
const adopting = flag('--adopt');
const [dir, id] = a.filter((x) => !x.startsWith('--'));
if (!dir || (!adopting && !id)) { console.error(usage); process.exit(2); }

try {
  if (adopting) {
    const r = adopt(dir);
    if (r.created) console.log('Wrote site.js with the pages it found.');
    if (!r.css) console.log("Found no kit stylesheet (kit/blueprint.css, or a kit/*.css a page links), so the site bar has no styles yet. Copy the skill's kit/blueprint.css into kit/ and link it.");
    else if (r.css !== 'kit/blueprint.css') console.log(`Added the site bar's styles to ${r.css}, the stylesheet this site's pages link.`);
    if (r.added.length) console.log(`Listed ${r.added.length} page${r.added.length > 1 ? 's' : ''} under "More": ${r.added.join(', ')}. Give them real groups, titles and blurbs in site.js.`);
    if (r.bar.length) console.log(`Put the site bar on ${r.bar.join(', ')}. Remove any back links or page buttons those pages drew themselves.`);
    if (r.noKit.length) console.log(`These pages don't load kit/kit.js, so they have no site bar yet: ${r.noKit.join(', ')}. Add the kit's scripts and <header class="site-bar"></header> to them, or leave them reachable from the Pages sheet.`);
  } else {
    const out = addPage(dir, { id, ...o });
    console.log(`Added ${relative(process.cwd(), out) || out} and listed it in site.js. Write it, then check the site with check-site.mjs.`);
  }
} catch (e) { console.error(e.message); process.exit(1); }
const left = checkSite(dir);
if (left.length) { console.log(`Still to fix:\n- ${left.join('\n- ')}`); process.exitCode = adopting ? 0 : 1; }
