// The site's page list (site.js) and the site bar: read it, add a page, bring an older site onto it, and
// check that every page can be reached. Used by add-page.mjs and check-site.mjs.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const asset = (f) => fileURLToPath(new URL(`../assets/site/${f}`, import.meta.url));
export const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const NAV_CSS_START = '/* ---------- site bar, crumbs, pager, Pages sheet (kit/nav.js) ---------- */';
const NAV_CSS_END = '/* ---------- end of the site bar ---------- */';
const DOC_CSS_START = '/* ---------- doc pages: the plan and every page added with add-page.mjs ---------- */';
const DOC_CSS_END = '/* ---------- end of the doc pages ---------- */';
const NAV_TAGS = (up) => `<script src="${up}site.js"></script><script src="${up}kit/nav.js"></script>`;

// window.SITE.pages from site.js, run in an empty context (the file is plain data).
export function readSite(dir) {
  const file = join(dir, 'site.js');
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  const box = { window: {} };
  try { vm.runInNewContext(text, box, { timeout: 500 }); } catch (e) { throw new Error(`site.js doesn't run: ${e.message}`); }
  const pages = box.window.SITE && Array.isArray(box.window.SITE.pages) ? box.window.SITE.pages : null;
  if (!pages) throw new Error('site.js has no window.SITE.pages list');
  return { file, text, pages };
}

// a single-quoted JS string; line breaks are escaped too, or site.js would stop running
const quote = (v) => `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')}'`;
export function entry(p) {
  const keys = ['id', 'title', 'href', 'icon', 'group', 'blurb', 'parent', 'hidden'];
  return `{ ${keys.filter((k) => p[k] !== undefined && p[k] !== null && p[k] !== '').map((k) => `${k}: ${typeof p[k] === 'boolean' ? p[k] : quote(p[k])}`).join(', ')} }`;
}

// Put a new entry into site.js's text: after the page `after`, or last in the list.
export function insertEntry(text, p, after) {
  const line = `    ${entry(p)},`;
  if (after) {
    const re = new RegExp(`^.*\\bid:\\s*'${after}'.*$`, 'm');
    const m = re.exec(text);
    if (!m) throw new Error(`site.js has no page "${after}"`);
    const end = m.index + m[0].length;
    return `${text.slice(0, end)}\n${line}${text.slice(end)}`;
  }
  const close = text.search(/\n\s*\],\s*\n\s*\};?\s*$/);
  if (close < 0) throw new Error("couldn't find the end of the pages list in site.js");
  return `${text.slice(0, close)}\n${line}${text.slice(close)}`;
}

const titleOf = (html, fallback) => {
  const t = /<title>([^<]*)<\/title>/i.exec(html) || /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  const s = t ? t[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
  return s && !/^__TITLE__$/.test(s) ? s : fallback;
};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// add-page: <id>.html from _page.html (or the skill's copy for a site made before it), listed in site.js.
export function addPage(dir, { id, title, lede = '', icon, group, blurb, parent, after, hidden }) {
  if (!ID.test(id || '')) throw new Error('the id is lowercase letters, digits and dashes, like battery-tests');
  if (!title) throw new Error('give the page a --title');
  const site = readSite(dir);
  if (!site) throw new Error(`${dir} has no site.js; run add-page.mjs --adopt first`);
  if (site.pages.some((p) => p.id === id)) throw new Error(`site.js already has a page "${id}"`);
  const href = `${id}.html`;
  const out = join(dir, href);
  if (existsSync(out)) throw new Error(`${href} exists already; add it with --adopt instead`);
  if (parent && !site.pages.some((p) => p.id === parent)) throw new Error(`site.js has no page "${parent}" to be the parent`);
  const tpl = existsSync(join(dir, '_page.html')) ? join(dir, '_page.html') : asset('_page.html');
  // replacer functions, so a $& or $' in the title is written as it is
  const html = readFileSync(tpl, 'utf8').replace(/__TITLE__/g, () => esc(title)).replace(/__LEDE__/g, () => esc(lede || `What ${title.toLowerCase()} covers, in a sentence or two.`));
  // a site.js edited by hand (no comma after the last entry, an entry over several lines) could come
  // out broken; check it runs before writing anything
  const list = insertEntry(site.text, { id, title, href, icon, group, blurb, parent, hidden: hidden || undefined }, after);
  try { vm.runInNewContext(list, { window: {} }, { timeout: 500 }); } catch (e) { throw new Error(`adding the page would break site.js (${e.message}); fix site.js by hand, then try again`); }
  writeFileSync(out, html);
  writeFileSync(site.file, list);
  return out;
}

const htmlFiles = (dir) => readdirSync(dir).filter((f) => f.endsWith('.html') && !f.startsWith('_') && !f.startsWith('.'));
const noComments = (html) => html.replace(/<!--[\s\S]*?-->/g, '');
// a <script> element that loads the file, with either quote and any ./ or ../ in front; a mention in
// a comment doesn't count
const loads = (html, file) => new RegExp(`<script\\b[^>]*\\bsrc\\s*=\\s*["'](?:\\.{1,2}\\/)*${file.replace(/[./]/g, '\\$&')}["']`, 'i').test(noComments(html));
const hasNav = (html) => loads(html, 'kit/nav.js');
const hasKit = (html) => loads(html, 'kit/kit.js');
const hasBar = (html) => /<header\b[^>]*class\s*=\s*["'][^"']*\bsite-bar\b/i.test(noComments(html));

// The site's own stylesheet: kit/blueprint.css, or the kit stylesheet its pages link when the kit was
// renamed for the product (kit/acme.css). Undefined when no page links one.
function kitCss(dir) {
  const std = join(dir, 'kit', 'blueprint.css');
  if (existsSync(std)) return std;
  for (const f of ['index.html', ...htmlFiles(dir)]) {
    const p = join(dir, f);
    if (!existsSync(p)) continue;
    const m = /<link\b[^>]*\bhref\s*=\s*["'](?:\.\/)?kit\/([^"'?#/]+\.css)["']/i.exec(noComments(readFileSync(p, 'utf8')));
    if (m && existsSync(join(dir, 'kit', m[1]))) return join(dir, 'kit', m[1]);
  }
}

// --adopt: bring a site made before the site bar onto it. Copies kit/nav.js, adds the bar's styles to
// the site's stylesheet (kit/blueprint.css, or the one its pages link), writes site.js from the pages it
// finds (or adds the ones site.js is missing), and puts the bar on every page that loads the kit. Pages
// that don't load the kit are listed but keep their own header; they're reported so you can add the tags
// by hand. `report.css` names the stylesheet the styles went into; without one the bar has no styles.
export function adopt(dir) {
  const report = { added: [], bar: [], noKit: [], created: false, css: undefined };
  mkdirSync(join(dir, 'kit'), { recursive: true });
  copyFileSync(asset('kit/nav.js'), join(dir, 'kit', 'nav.js'));
  const css = kitCss(dir) ?? join(dir, 'kit', 'blueprint.css');
  if (existsSync(css)) report.css = relative(dir, css).split(sep).join('/');
  const skillCss = readFileSync(asset('kit/blueprint.css'), 'utf8');
  const navCss = skillCss.slice(skillCss.indexOf(NAV_CSS_START), skillCss.indexOf(NAV_CSS_END) + NAV_CSS_END.length);
  if (existsSync(css) && !readFileSync(css, 'utf8').includes(NAV_CSS_START)) writeFileSync(css, `${readFileSync(css, 'utf8').trimEnd()}\n\n${navCss}\n`);
  // the doc page styles too, which pages from add-page.mjs are built on (older sites kept them in index.html)
  const docCss = skillCss.slice(skillCss.indexOf(DOC_CSS_START), skillCss.indexOf(DOC_CSS_END) + DOC_CSS_END.length);
  if (existsSync(css) && !readFileSync(css, 'utf8').includes(DOC_CSS_START)) writeFileSync(css, `${readFileSync(css, 'utf8').trimEnd()}\n\n${docCss}\n`);
  if (!existsSync(join(dir, '_page.html'))) copyFileSync(asset('_page.html'), join(dir, '_page.html'));

  let site = readSite(dir);
  if (!site) {
    const first = [];
    if (existsSync(join(dir, 'index.html'))) first.push({ id: 'plan', title: 'Plan', href: 'index.html', icon: 'file-text' });
    if (existsSync(join(dir, 'mockups', 'index.html'))) first.push({ id: 'screens', title: 'Screens', href: 'mockups/index.html', icon: 'layout-template' });
    if (existsSync(join(dir, 'matrix.html'))) first.push({ id: 'matrix', title: 'Matrix', href: 'matrix.html', icon: 'table-2' });
    const head = readFileSync(asset('site.js'), 'utf8');
    const intro = head.slice(0, head.indexOf('window.SITE'));
    writeFileSync(join(dir, 'site.js'), `${intro}window.SITE = {\n  pages: [\n${first.map((p) => `    ${entry(p)},`).join('\n')}\n  ],\n};\n`);
    report.created = true;
    site = readSite(dir);
  }
  const known = new Set(site.pages.map((p) => p.href));
  let text = site.text;
  const ids = new Set(site.pages.map((p) => p.id));
  for (const f of htmlFiles(dir).sort()) {
    if (known.has(f)) continue;
    let id = f.replace(/\.html$/, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'page';
    while (ids.has(id)) id += '-2';
    ids.add(id);
    const p = { id, title: titleOf(readFileSync(join(dir, f), 'utf8'), f.replace(/\.html$/, '')), href: f, group: 'More' };
    text = insertEntry(text, p);
    report.added.push(f);
  }
  writeFileSync(site.file, text);

  for (const p of readSite(dir).pages) {
    if (!p || typeof p.href !== 'string') continue;
    const file = join(dir, p.href);
    // the screens have no bar; the viewer gets a Pages button instead of one
    if (!existsSync(file) || (p.href.startsWith('mockups/') && p.href !== 'mockups/index.html')) continue;
    const viewer = p.href === 'mockups/index.html';
    const before = readFileSync(file, 'utf8');
    let html = before;
    if (!hasNav(html)) {
      if (!hasKit(html)) { report.noKit.push(p.href); continue; }
      const up = '../'.repeat(p.href.split('/').length - 1);
      html = html.replace(/(<script\b[^>]*\bsrc\s*=\s*["'](?:\.{1,2}\/)*kit\/kit\.js["'][^>]*><\/script>)/i, (m) => `${m}${NAV_TAGS(up)}`);
    }
    if (viewer) {
      if (!/data-site-pages/.test(html)) html = html.replace(/(<a class="icon-btn" href="\.\.\/index\.html"[^>]*>[\s\S]*?<\/a>)/, '$1\n      <button class="icon-btn" data-site-pages aria-label="Pages" data-tip="Pages"><i data-lucide="panels-top-left"></i></button>');
    } else if (!hasBar(html)) {
      html = html.replace(/(<body[^>]*>)/i, '$1\n<header class="site-bar"></header>');
    }
    if (html !== before) { writeFileSync(file, html); report.bar.push(p.href); }
  }
  return report;
}

// What stops a reader getting around: pages missing from site.js, entries with no file, pages without
// the bar, links that leave the folder.
export function checkSite(dir) {
  const problems = [];
  let site;
  try { site = readSite(dir); } catch (e) { return [e.message]; }
  if (!site) return ['no site.js: run add-page.mjs --adopt to give the site its page list and site bar'];
  const seen = new Set();
  for (const p of site.pages) {
    if (!p || typeof p !== 'object' || !p.id || !p.title || !p.href) { problems.push(`site.js: an entry lacks id, title or href (${JSON.stringify(p)})`); continue; }
    if (seen.has(p.id)) problems.push(`site.js: the id "${p.id}" is used twice`);
    seen.add(p.id);
    const rel = relative(dir, join(dir, String(p.href)));
    if (/^([a-z]+:|\/)/i.test(p.href) || rel === '..' || rel.startsWith(`..${sep}`)) { problems.push(`site.js: ${p.id} links to ${p.href}; hrefs are relative to the site's folder`); continue; }
    const file = join(dir, p.href);
    if (!existsSync(file)) { problems.push(`site.js: ${p.id} points at ${p.href}, which doesn't exist`); continue; }
    if (p.parent && !site.pages.some((q) => q && q.id === p.parent)) problems.push(`site.js: ${p.id}'s parent "${p.parent}" isn't a page`);
    const html = readFileSync(file, 'utf8');
    if (!hasNav(html)) problems.push(`${p.href} doesn't load kit/nav.js, so it has no way to the other pages`);
  }
  const listed = new Set(site.pages.filter(Boolean).map((p) => p.href));
  for (const f of htmlFiles(dir)) if (!listed.has(f)) problems.push(`${f} isn't in site.js, so nothing links to it: add it with add-page.mjs --adopt`);
  return problems;
}

