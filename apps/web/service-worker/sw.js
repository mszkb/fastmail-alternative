/**
 * Service worker (roadmap 4.1): app-shell precache only.
 *
 * - PRECACHE and VERSION are injected by scripts/build-sw.mjs after
 *   `nuxt generate` (hashed assets, index.html, manifest, icons).
 * - Navigations are answered with the cached app shell (index.html), so the
 *   app starts offline; precached files are served cache-first.
 * - /api/* is never touched: no API response (mail content!) lands in the
 *   Cache Storage. Offline storage of mail data is roadmap 4.6 and follows
 *   the security model (docs/architecture/security.md).
 * - A new version waits until the user confirms the update prompt in the
 *   app (message SKIP_WAITING); old shell caches are removed on activate.
 */
/* global PRECACHE, VERSION */
const CACHE_PREFIX = 'fma-shell-'
const CACHE_NAME = CACHE_PREFIX + VERSION
const SHELL_URL = '/index.html'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' })))),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') void self.skipWaiting()
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  // Same origin only; the API is always network-only (never cached).
  if (url.origin !== self.location.origin) return
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return

  if (request.mode === 'navigate') {
    event.respondWith(
      caches
        .open(CACHE_NAME)
        .then((cache) => cache.match(SHELL_URL))
        .then((cached) => cached || fetch(request)),
    )
    return
  }

  if (!PRECACHE.includes(url.pathname)) return
  event.respondWith(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.match(url.pathname))
      .then((cached) => cached || fetch(request)),
  )
})
