/**
 * Service worker (roadmap 4.1): app-shell precache, plus Web Push (4.3).
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
 * - Push (docs/architecture/push.md): the payload is only a hint
 *   ({ type, installationId, badge }, never mail content). Every push shows
 *   a generic notification - iOS revokes the subscription after pushes
 *   without one (no silent push) - and updates the app badge. A click
 *   focuses or opens the app, which then syncs (roadmap 4.5).
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

const NOTIFICATION_TAG = 'new-mail'

function readPushPayload(event) {
  try {
    const data = event.data ? event.data.json() : null
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

function setBadge(count) {
  const nav = self.navigator
  if (!nav || typeof nav.setAppBadge !== 'function') return Promise.resolve()
  const update = count > 0 ? nav.setAppBadge(count) : nav.clearAppBadge()
  return update.catch(() => {})
}

self.addEventListener('push', (event) => {
  const data = readPushPayload(event)
  const badge = Number.isInteger(data.badge) && data.badge >= 0 ? data.badge : null
  // Always show a notification, even for an unreadable payload (iOS).
  // Same tag: a newer push replaces the previous notification.
  const notify = self.registration.showNotification('Neue E-Mail', {
    tag: NOTIFICATION_TAG,
    renotify: true,
    icon: '/icons/icon-192.png',
    data: { url: '/' },
  })
  event.waitUntil(Promise.all([notify, badge === null ? null : setBadge(badge)]))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const client = windows.find((w) => new URL(w.url).origin === self.location.origin)
      if (client) {
        // The app syncs on focus anyway; the message makes it immediate.
        client.postMessage({ type: 'SYNC_REQUEST' })
        return client.focus()
      }
      return self.clients.openWindow('/')
    }),
  )
})

// The push service rotated the subscription (not on iOS): subscribe again
// with the same key and report it; the session cookie goes along.
self.addEventListener('pushsubscriptionchange', (event) => {
  const options = event.oldSubscription && event.oldSubscription.options
  if (!options || !options.applicationServerKey) return
  event.waitUntil(
    self.registration.pushManager
      .subscribe({ userVisibleOnly: true, applicationServerKey: options.applicationServerKey })
      .then((subscription) =>
        fetch('/api/push/subscriptions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(subscription.toJSON()),
        }),
      )
      .catch(() => {}),
  )
})
