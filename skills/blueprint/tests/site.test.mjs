// bun test skills/blueprint/tests
// site.mjs: the page list, add-page, --adopt for sites made before the site bar, and the reachability check.
import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { addPage, adopt, checkSite, entry, insertEntry, readSite } from '../scripts/site.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'bp-site-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const template = fileURLToPath(new URL('../assets/site', import.meta.url));
let n = 0;
const fresh = () => { const d = join(tmp, `s${++n}`); cpSync(template, d, { recursive: true }); return d; };

describe('the template', () => {
  test('lists every page and puts the bar on each', () => {
    expect(checkSite(template)).toEqual([]);
    const ids = readSite(template).pages.map((p) => p.id);
    expect(ids).toEqual(['plan', 'screens', 'matrix', 'offline']);
  });
});

describe('add-page', () => {
  test('writes the page from _page.html and lists it last', () => {
    const d = fresh();
    addPage(d, { id: 'battery-tests', title: 'Battery tests', group: 'Research', icon: 'battery', blurb: 'Runtime on one charge.' });
    const html = readFileSync(join(d, 'battery-tests.html'), 'utf8');
    expect(html).toContain('<h1>Battery tests</h1>');
    expect(html).not.toContain('__TITLE__');
    expect(html).not.toContain('__LEDE__');
    const pages = readSite(d).pages;
    expect(pages.at(-1)).toEqual({ id: 'battery-tests', title: 'Battery tests', href: 'battery-tests.html', icon: 'battery', group: 'Research', blurb: 'Runtime on one charge.' });
    expect(checkSite(d)).toEqual([]);
  });

  test('puts a page after another one, with a parent', () => {
    const d = fresh();
    addPage(d, { id: 'wiring', title: 'Wiring', after: 'plan', parent: 'matrix' });
    const pages = readSite(d).pages;
    expect(pages[1]).toMatchObject({ id: 'wiring', parent: 'matrix' });
  });

  test('escapes the title in the page and in site.js', () => {
    const d = fresh();
    addPage(d, { id: 'q', title: "Sam's <b>list</b>" });
    expect(readFileSync(join(d, 'q.html'), 'utf8')).toContain('<h1>Sam\'s &lt;b&gt;list&lt;/b&gt;</h1>');
    expect(readSite(d).pages.at(-1).title).toBe("Sam's <b>list</b>");
  });

  test('refuses a bad id, a used id, an existing file and an unknown parent', () => {
    const d = fresh();
    expect(() => addPage(d, { id: 'Bad Id', title: 'x' })).toThrow(/lowercase/);
    expect(() => addPage(d, { id: 'matrix', title: 'x' })).toThrow(/already has/);
    writeFileSync(join(d, 'loose.html'), '<title>Loose</title>');
    expect(() => addPage(d, { id: 'loose', title: 'x' })).toThrow(/exists already/);
    expect(() => addPage(d, { id: 'y', title: 'Y', parent: 'nope' })).toThrow(/no page "nope"/);
    expect(() => addPage(d, { id: 'z' })).toThrow(/--title/);
  });
});

describe('--adopt', () => {
  // A site from before the site bar: no site.js, no nav.js, pages without the tags, an extra page.
  const old = () => {
    const d = fresh();
    for (const f of ['site.js', 'kit/nav.js', '_page.html', 'offline.html']) unlinkSync(join(d, f));
    for (const f of ['index.html', 'matrix.html']) {
      const p = join(d, f);
      writeFileSync(p, readFileSync(p, 'utf8').replace(/<script src="site\.js"><\/script>\n?/, '').replace(/<script src="kit\/nav\.js"><\/script>\n?/, '').replace(/<header class="site-bar[^"]*"><\/header>\n?/, ''));
    }
    // the viewer as it was: no site.js, no nav.js, no Pages button
    const v = join(d, 'mockups/index.html');
    writeFileSync(v, readFileSync(v, 'utf8').replace('<script src="../site.js"></script><script src="../kit/nav.js"></script>', '').replace(/\n\s*<button class="icon-btn" data-site-pages[^\n]*/, ''));
    const css = join(d, 'kit/blueprint.css');
    const s = readFileSync(css, 'utf8');
    writeFileSync(css, s.slice(0, s.indexOf('/* ---------- site bar')));
    writeFileSync(join(d, 'wiring.html'), '<!doctype html><html><head><title>Wiring guide</title><script src="kit/kit.js"></script></head><body><h1>Wiring</h1></body></html>');
    writeFileSync(join(d, 'cart.html'), '<!doctype html><html><head><title>Shopping list</title></head><body></body></html>');
    return d;
  };

  test('writes site.js, lists the pages it finds and puts the bar where the kit loads', () => {
    const d = old();
    expect(checkSite(d)).toEqual(['no site.js: run add-page.mjs --adopt to give the site its page list and site bar']);
    const r = adopt(d);
    expect(r.created).toBe(true);
    expect(r.added.sort()).toEqual(['cart.html', 'wiring.html']);
    expect(r.noKit).toEqual(['cart.html']);
    expect(r.bar).toEqual(expect.arrayContaining(['index.html', 'matrix.html', 'wiring.html']));
    const pages = readSite(d).pages;
    expect(pages.map((p) => p.id)).toEqual(['plan', 'screens', 'matrix', 'cart', 'wiring']);
    expect(pages.find((p) => p.id === 'wiring')).toMatchObject({ title: 'Wiring guide', group: 'More' });
    const wiring = readFileSync(join(d, 'wiring.html'), 'utf8');
    expect(wiring).toContain('<script src="kit/kit.js"></script><script src="site.js"></script><script src="kit/nav.js"></script>');
    expect(wiring).toContain('<header class="site-bar"></header>');
    expect(existsSync(join(d, 'kit/nav.js'))).toBe(true);
    expect(readFileSync(join(d, 'kit/blueprint.css'), 'utf8')).toContain('end of the site bar');
    // the doc page styles that add-page.mjs pages use came along
    expect(readFileSync(join(d, 'kit/blueprint.css'), 'utf8')).toContain('end of the doc pages');
    // the viewer got its tags and a Pages button, not a bar
    const viewer = readFileSync(join(d, 'mockups/index.html'), 'utf8');
    expect(viewer).toContain('<script src="../kit/kit.js"></script><script src="../site.js"></script><script src="../kit/nav.js"></script>');
    expect(viewer.match(/data-site-pages/g)).toHaveLength(1);
    expect(viewer).not.toContain('class="site-bar');
    // only the page that doesn't load the kit is left
    expect(checkSite(d)).toEqual(["cart.html doesn't load kit/nav.js, so it has no way to the other pages"]);
  });

  test('is safe to run twice', () => {
    const d = old();
    adopt(d);
    const first = readFileSync(join(d, 'site.js'), 'utf8');
    const css = readFileSync(join(d, 'kit/blueprint.css'), 'utf8');
    const again = adopt(d);
    expect(again.added).toEqual([]);
    expect(again.bar).toEqual([]);
    expect(readFileSync(join(d, 'site.js'), 'utf8')).toBe(first);
    expect(readFileSync(join(d, 'kit/blueprint.css'), 'utf8')).toBe(css);
  });

  test("a site that renamed its kit's stylesheet gets the bar's styles there", () => {
    const d = old();
    // the kit renamed for the product, as a site built for one brand does
    renameSync(join(d, 'kit/blueprint.css'), join(d, 'kit/acme.css'));
    for (const f of ['index.html', 'matrix.html']) {
      const p = join(d, f);
      writeFileSync(p, readFileSync(p, 'utf8').replace('kit/blueprint.css', 'kit/acme.css'));
    }
    const r = adopt(d);
    expect(r.css).toBe('kit/acme.css');
    expect(existsSync(join(d, 'kit/blueprint.css'))).toBe(false);
    const css = readFileSync(join(d, 'kit/acme.css'), 'utf8');
    expect(css).toContain('end of the site bar');
    expect(css).toContain('end of the doc pages');
    // and once only
    adopt(d);
    expect(readFileSync(join(d, 'kit/acme.css'), 'utf8')).toBe(css);
    // the usual name is reported too, and a site with no stylesheet at all says so
    expect(adopt(old()).css).toBe('kit/blueprint.css');
    const bare = old();
    unlinkSync(join(bare, 'kit/blueprint.css'));
    expect(adopt(bare).css).toBeUndefined();
  });

  test('adds only what an existing site.js is missing', () => {
    const d = fresh();
    writeFileSync(join(d, 'notes.html'), '<title>Notes</title><script src="kit/kit.js"></script><body></body>');
    const r = adopt(d);
    expect(r.created).toBe(false);
    expect(r.added).toEqual(['notes.html']);
    expect(readSite(d).pages.map((p) => p.id)).toEqual(['plan', 'screens', 'matrix', 'offline', 'notes']);
  });
});

describe('pages that half have the bar', () => {
  test('a mention of nav.js in a comment is not the script, and a missing bar is added on its own', () => {
    const d = fresh();
    writeFileSync(join(d, 'a.html'), '<!doctype html><head><!-- kit/nav.js comes later --><script src="kit/kit.js"></script></head><body><h1>A</h1></body>');
    writeFileSync(join(d, 'b.html'), "<!doctype html><head><script src='./kit/kit.js'></script><script src='site.js'></script><script src='./kit/nav.js'></script></head><body><h1>B</h1></body>");
    const problems = checkSite(d);
    expect(problems).toContain("a.html isn't in site.js, so nothing links to it: add it with add-page.mjs --adopt");
    const r = adopt(d);
    expect(r.bar.sort()).toEqual(['a.html', 'b.html']);
    const a = readFileSync(join(d, 'a.html'), 'utf8');
    expect(a).toContain('<script src="kit/kit.js"></script><script src="site.js"></script><script src="kit/nav.js"></script>');
    expect(a).toContain('<header class="site-bar"></header>');
    // b already loaded both: it gets the bar and no second copy of the scripts
    const b = readFileSync(join(d, 'b.html'), 'utf8');
    expect(b.match(/nav\.js/g)).toHaveLength(1);
    expect(b).toContain('<header class="site-bar"></header>');
    expect(checkSite(d)).toEqual([]);
  });
});

describe('odd input', () => {
  test('a title with a line break or $& is written as it is', () => {
    const d = fresh();
    addPage(d, { id: 'costs', title: 'Costs $& benefits', blurb: 'Two\nlines' });
    expect(readFileSync(join(d, 'costs.html'), 'utf8')).toContain('<h1>Costs $&amp; benefits</h1>');
    expect(readSite(d).pages.at(-1)).toMatchObject({ title: 'Costs $& benefits', blurb: 'Two\nlines' });
    expect(checkSite(d)).toEqual([]);
  });

  test('a page that would break a hand-edited site.js is refused before anything is written', () => {
    const d = fresh();
    const s = readFileSync(join(d, 'site.js'), 'utf8');
    // no comma after the last entry
    writeFileSync(join(d, 'site.js'), s.replace(/\},(\s*\],\s*\};?\s*)$/, '}$1'));
    expect(readSite(d).pages).toHaveLength(4);
    expect(() => addPage(d, { id: 'more', title: 'More' })).toThrow(/would break site\.js/);
    expect(existsSync(join(d, 'more.html'))).toBe(false);
  });

  test('check-site names an empty entry and a link out of the folder instead of crashing', () => {
    const d = fresh();
    const s = readFileSync(join(d, 'site.js'), 'utf8');
    writeFileSync(join(d, 'site.js'), insertEntry(s.replace("pages: [", "pages: [\n    null,"), { id: 'up', title: 'Up', href: '../index.html' }));
    const problems = checkSite(d);
    expect(problems).toContain('site.js: an entry lacks id, title or href (null)');
    expect(problems).toContain("site.js: up links to ../index.html; hrefs are relative to the site's folder");
  });
});

describe('check-site', () => {
  test('names an unlisted page, a missing file, an absolute href and a page with no bar', () => {
    const d = fresh();
    writeFileSync(join(d, 'stray.html'), '<title>Stray</title>');
    const s = readFileSync(join(d, 'site.js'), 'utf8');
    writeFileSync(join(d, 'site.js'), insertEntry(insertEntry(s, { id: 'gone', title: 'Gone', href: 'gone.html' }), { id: 'web', title: 'Web', href: 'https://example.com/' }));
    writeFileSync(join(d, 'offline.html'), '<title>Offline</title>');
    expect(checkSite(d)).toEqual([
      "offline.html doesn't load kit/nav.js, so it has no way to the other pages",
      "site.js: gone points at gone.html, which doesn't exist",
      'site.js: web links to https://example.com/; hrefs are relative to the site\'s folder',
      "stray.html isn't in site.js, so nothing links to it: add it with add-page.mjs --adopt",
    ]);
  });

  test('says when site.js is broken', () => {
    const d = fresh();
    writeFileSync(join(d, 'site.js'), 'window.SITE = {');
    expect(checkSite(d)[0]).toMatch(/site\.js doesn't run/);
  });
});

test('entry writes quotes and booleans the way site.js reads them', () => {
  expect(entry({ id: 'a', title: "It's", href: 'a.html', hidden: true, group: '' })).toBe("{ id: 'a', title: 'It\\'s', href: 'a.html', hidden: true }");
});
