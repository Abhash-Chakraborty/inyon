/* Blueprint site bar. Every page of the site (not the mockup screens) loads site.js, then this file, after
   kit/kit.js, and puts <header class="site-bar"></header> first in its body. From window.SITE it draws:
   - the bar: the brand (home), Back to the page above this one, the pages, Pages (all of them in a sheet)
     and the theme switch;
   - [data-crumbs]: where this page sits (Plan › Research › Battery tests);
   - [data-pager]: the previous and next page in reading order;
   - [data-page-cards]: a card for every page but the first, for the plan to lead into them.
   Any [data-site-pages] button opens the Pages sheet too (the viewer has one). Links stay relative, so the
   site works from a folder, a static server or inside Inyon's sandbox. */
(function () {
  const K = window.K;
  if (!K) return;
  const script = document.currentScript;
  // kit/nav.js sits one folder under the site's root, so the root is the folder above the script.
  const root = new URL('..', script ? script.src : location.href);
  const site = window.SITE || {};
  const all = (site.pages || []).filter((p) => p && p.id && p.href);
  const listed = all.filter((p) => !p.hidden);
  const url = (p) => new URL(p.href, root);
  const strip = (path) => path.replace(/index\.html$/, '').replace(/\/+$/, '/');
  const here = strip(location.pathname);
  const forced = document.body && document.body.dataset.page;
  const current = all.find((p) => p.id === forced) || all.find((p) => strip(url(p).pathname) === here) || null;
  const home = all[0] || null;
  const parentOf = (p) => (p && p.parent ? all.find((q) => q.id === p.parent) : p && p !== home ? home : null);
  const href = (p) => K.esc(url(p).href);
  const groups = [];
  for (const p of listed) {
    const g = p.group || '';
    let entry = groups.find((x) => x.name === g);
    if (!entry) groups.push((entry = { name: g, pages: [] }));
    entry.pages.push(p);
  }

  function openPages() {
    const body = groups.map((g) => `${g.name ? `<p class="sp-group">${K.esc(g.name)}</p>` : ''}<ul class="sp-list">${g.pages.map((p) => `<li><a href="${href(p)}"${p === current ? ' aria-current="page"' : ''}>${p.icon ? K.icon(p.icon) : K.icon('file-text')}<span>${K.esc(p.title)}</span>${p === current ? '<span class="sp-here">Here</span>' : ''}</a></li>`).join('')}</ul>`).join('');
    K.sheet.open({ title: 'Pages', icon: 'panels-top-left', body: `<nav class="site-pages" aria-label="All pages">${body}</nav>` });
  }

  function toggleTheme() {
    const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    K.setTheme(t);
    document.dispatchEvent(new CustomEvent('bp:theme', { detail: t }));
  }

  function bar(el) {
    const brand = (window.BRAND && window.BRAND.name) || 'Plan';
    const up = parentOf(current);
    // Top-level pages show as links; a group shows as one button whose menu lists its pages.
    const inline = groups.map((g) => g.name
      ? `<button class="sb-link sb-group${g.pages.includes(current) ? ' on' : ''}" type="button" data-group="${K.esc(g.name)}" aria-haspopup="menu">${K.esc(g.name)}${K.icon('chevron-down', 'i14')}</button>`
      : g.pages.map((p) => `<a class="sb-link${p === current ? ' on' : ''}" href="${href(p)}"${p === current ? ' aria-current="page"' : ''}>${K.esc(p.title)}</a>`).join('')).join('');
    el.innerHTML = `<div class="sb-in">
      ${up ? `<a class="icon-btn sb-back" href="${href(up)}" aria-label="Back to ${K.esc(up.title)}" data-tip="Back to ${K.esc(up.title)}">${K.icon('arrow-left')}</a>` : ''}
      <a class="sb-brand" href="${home ? href(home) : '#'}">${K.logo ? K.logo(20) : ''}<b>${K.esc(brand)}</b></a>
      <span class="sb-title">${current ? K.esc(current.title) : ''}</span>
      <nav class="sb-links" aria-label="Pages">${inline}</nav>
      <button class="btn sm sb-pages" type="button" data-site-pages aria-haspopup="dialog">${K.icon('panels-top-left')}<span>Pages</span></button>
      <button class="icon-btn" type="button" data-theme-toggle aria-label="Switch theme" data-tip="Switch theme">${K.icon('sun-moon')}</button>
    </div>`;
    el.classList.toggle('few', listed.length <= 6);
    el.querySelectorAll('[data-group]').forEach((b) => {
      const g = groups.find((x) => x.name === b.dataset.group);
      b.onclick = () => K.menu.open(b, g.pages.map((p) => ({ label: p.title, icon: p.icon || 'file-text', checked: p === current, onSelect: () => { location.href = url(p).href; } })));
    });
    // The on-screen link scrolls into view when the row is wider than the bar.
    const on = el.querySelector('.sb-link.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  function crumbs(el) {
    if (!current || current === home) { el.hidden = true; return; }
    const trail = [];
    for (let p = parentOf(current); p; p = parentOf(p)) { if (trail.includes(p)) break; trail.unshift(p); }
    const parts = trail.map((p) => `<a href="${href(p)}">${K.esc(p.title)}</a>`);
    if (current.group && !current.parent) parts.push(`<span>${K.esc(current.group)}</span>`);
    parts.push(`<span aria-current="page">${K.esc(current.title)}</span>`);
    el.innerHTML = `<nav class="crumbs" aria-label="Where you are">${parts.join(K.icon('chevron-right', 'i14'))}</nav>`;
  }

  function pager(el) {
    const i = listed.indexOf(current);
    if (i < 0) { el.hidden = true; return; }
    const prev = listed[i - 1], next = listed[i + 1];
    const link = (p, dir) => p ? `<a class="pg-${dir}" href="${href(p)}"${dir === 'prev' ? ' rel="prev"' : ' rel="next"'}><span class="pg-k">${dir === 'prev' ? K.icon('arrow-left', 'i14') + 'Previous' : 'Next' + K.icon('arrow-right', 'i14')}</span><b>${K.esc(p.title)}</b></a>` : '<span></span>';
    el.innerHTML = `<nav class="pager" aria-label="Previous and next page">${link(prev, 'prev')}${link(next, 'next')}</nav>`;
  }

  // [data-page-cards] on the plan: a card for every other page, with its blurb, so the plan is the way in.
  function cards(el) {
    const rest = listed.filter((p) => p !== home);
    if (!rest.length) { el.hidden = true; return; }
    el.innerHTML = `<div class="page-cards">${rest.map((p) => `<a class="page-card" href="${href(p)}">${p.icon ? K.icon(p.icon) : K.icon('file-text')}<span><b>${K.esc(p.title)}</b>${p.blurb ? `<small>${K.esc(p.blurb)}</small>` : ''}</span>${K.icon('arrow-right', 'i14')}</a>`).join('')}</div>`;
  }

  function draw() {
    document.querySelectorAll('header.site-bar').forEach(bar);
    document.querySelectorAll('[data-crumbs]').forEach(crumbs);
    document.querySelectorAll('[data-pager]').forEach(pager);
    document.querySelectorAll('[data-page-cards]').forEach(cards);
    K.icons(document);
  }
  document.addEventListener('click', (e) => {
    const t = e.target.closest && e.target.closest('[data-site-pages], [data-theme-toggle]');
    if (!t) return;
    if (t.hasAttribute('data-site-pages')) openPages(); else toggleTheme();
  });
  K.site = { pages: all, current, home, open: openPages, url: (p) => url(p).href };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', draw); else draw();
})();
