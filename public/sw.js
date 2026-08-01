/**
 * The dashboard's service worker.
 *
 * One job, and it is deliberately small: make the app *open* when there is no
 * signal. A packer in a stockroom at the back of a building has one bar and a
 * pile of parcels, and an app that shows a browser error page there is an app
 * they stop using.
 *
 * ## What it caches, and what it refuses to
 *
 * The shell — the HTML document and the hashed JS/CSS Vite emits — is cached and
 * served offline. Nothing else is. In particular:
 *
 *   **No API responses.** Every one of them is tenant-scoped and personal, and a
 *   shared device with a stale cache is a seller reading somebody else's orders.
 *   The data a packer needs offline is held by the app itself, per tenant, and
 *   cleared on sign-out — see `src/lib/offline`.
 *
 *   **No storefront.** This worker is registered from the dashboard document
 *   only. A buyer's page is server-rendered against a hard LCP budget and has no
 *   use for a worker that would have to boot before it could help.
 *
 *   **No POST.** The Cache API cannot store a non-GET request, and pretending
 *   otherwise by keying on a URL would serve one order's response for another's.
 *
 * ## Why the shell is stale-while-revalidate rather than cache-first
 *
 * Cache-first on the document pins a seller to whatever version they installed
 * until the cache is manually busted, which is how a PWA ends up weeks behind.
 * Serving the cached copy and fetching a fresh one in the background gives the
 * offline open *and* a next-load update, and Vite's hashed filenames mean the
 * assets a new document asks for are new URLs — so there is never a mismatched
 * pair.
 */

const VERSION = 'selld-shell-v1'
const SHELL = '/index.html'

/** Only ever the app shell and its hashed assets. Never data. */
function isShellRequest(url) {
  if (url.origin !== self.location.origin) return false
  return (
    url.pathname === '/' ||
    url.pathname.startsWith('/assets/') ||
    url.pathname === '/manifest.webmanifest' ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.svg')
  )
}

self.addEventListener('install', (event) => {
  // Take over as soon as this version is installed rather than waiting for every
  // tab to close. A packer who reloads because something looked wrong should get
  // the fix, not the version that looked wrong.
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll([SHELL])).then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)

  // A navigation: the SPA has one document, so any route resolves to the shell.
  // Network first, because a fresh document is worth the wait when there is a
  // network — and the cached shell is what makes the app open when there is not.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone()
          void caches.open(VERSION).then((cache) => cache.put(SHELL, copy))
          return response
        })
        .catch(() => caches.match(SHELL).then((cached) => cached ?? Response.error())),
    )
    return
  }

  if (!isShellRequest(url)) return

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone()
            void caches.open(VERSION).then((cache) => cache.put(request, copy))
          }
          return response
        })
        .catch(() => cached ?? Response.error())
      // Stale first when we have it: the point is that the app opens now.
      return cached ?? network
    }),
  )
})
