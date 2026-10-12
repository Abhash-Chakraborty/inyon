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
