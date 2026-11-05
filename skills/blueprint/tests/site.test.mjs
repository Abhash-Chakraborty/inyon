// bun test skills/blueprint/tests
// site.mjs: the page list, add-page, --adopt for sites made before the site bar, and the reachability check.
import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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

  test('adds only what an existing site.js is missing', () => {
    const d = fresh();
    writeFileSync(join(d, 'notes.html'), '<title>Notes</title><script src="kit/kit.js"></script><body></body>');
    const r = adopt(d);
    expect(r.created).toBe(false);
    expect(r.added).toEqual(['notes.html']);
    expect(readSite(d).pages.map((p) => p.id)).toEqual(['plan', 'screens', 'matrix', 'offline', 'notes']);
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
