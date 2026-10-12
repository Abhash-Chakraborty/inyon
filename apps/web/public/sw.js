// Inyon service worker: caches the app shell so the installed app opens instantly.
// API calls and the WebSocket always go to the network. Paths are under the worker's scope: `/` on
// a hub, `/inyon-releases/` for the web app on GitHub Pages.
const CACHE = 'inyon-v2'
const BASE = new URL(self.registration.scope).pathname

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll([BASE, BASE + 'manifest.webmanifest', BASE + 'icon-192.png'])))
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))))
  self.clients.claim()
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname === '/ws') return
  if (e.request.mode === 'navigate') {
    // network first for pages so updates show up, cached shell when offline
    e.respondWith(fetch(e.request).catch(() => caches.match(BASE)))
    return
  }
  if (url.pathname.startsWith(BASE + 'assets/')) {
    e.respondWith(
      caches.match(e.request).then(
        (hit) => hit || fetch(e.request).then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put(e.request, copy))
          return res
        }),
      ),
    )
  }
})

// Notifications while Inyon is closed: a hub, or in the web app a paired computer, sends them
// through the browser's push service (apps/web/src/lib/push.ts). The tag matches the open app's,
// so a newer one replaces an older one for the same session.
const APPLE = /iPhone|iPad|Macintosh/.test(navigator.userAgent) && !/Chrome|Chromium|Edg|Firefox/.test(navigator.userAgent)
self.addEventListener('push', (e) => {
  let p = {}
  try {
    p = e.data ? e.data.json() : {}
  } catch {}
  e.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      // the open app shows it itself; Safari ends a subscription whose pushes show nothing, so it always shows
      if (!APPLE && p.kind !== 'test' && wins.some((w) => w.focused && w.visibilityState === 'visible')) return
      await self.registration.showNotification(p.title || 'Inyon', {
        body: p.body || '',
        tag: p.tag || 'inyon',
        renotify: p.kind === 'waiting',
        data: { href: p.href || '/' },
        icon: BASE + 'icon-192.png',
        badge: BASE + 'badge-96.png',
      })
    })(),
  )
})

self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const href = (e.notification.data && e.notification.data.href) || '/'
  e.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const win = wins.find((w) => new URL(w.url).pathname.startsWith(BASE))
      if (win) {
        await win.focus()
        win.postMessage({ t: 'open', href })
        return
      }
      await self.clients.openWindow(BASE.replace(/\/$/, '') + href)
    })(),
  )
})
