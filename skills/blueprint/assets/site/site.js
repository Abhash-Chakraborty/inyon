// The site's pages in reading order. kit/nav.js draws the site bar, the crumbs and the previous/next links
// from this list, so a page that isn't here can't be reached. Add pages with scripts/add-page.mjs.
// Fields: id, title, href (from the site's root), icon (Lucide), group (pages with the same group share one
// menu in the bar), blurb (one line under its card on the plan), parent (the page Back goes to; the first
// page otherwise), hidden (left out of the bar and the pager, still reachable by link).
window.SITE = {
  pages: [
    { id: 'plan', title: 'Plan', href: 'index.html', icon: 'file-text' },
    /* mockups */{ id: 'screens', title: 'Screens', href: 'mockups/index.html', icon: 'layout-template' },/* /mockups */
    { id: 'matrix', title: 'Matrix', href: 'matrix.html', icon: 'table-2' },
    { id: 'offline', title: 'Offline sync', href: 'offline.html', icon: 'cloud-off', group: 'Details', blurb: 'What the phone keeps, and how two people\'s edits merge.' },
  ],
};
