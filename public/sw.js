/**
 * SkyHonix Service Worker - Instant App Shell
 *
 * Strategy (optimised for sub-second loads in the School / Teacher / Parent APKs):
 *   - API              -> network only (never cached, offline -> 503)
 *   - HTML / navigate  -> network with a short timeout, falls back to cache instantly
 *   - JS / CSS / fonts / images -> cache-first + background revalidate (stale-while-revalidate)
 *
 * Bump SHELL_VERSION whenever a cached asset is renamed/removed.
 */
const SHELL_VERSION = 'skyhonix-shell-v10';
const PAGE_CACHE = 'skyhonix-pages-v10';
const ASSET_CACHE = 'skyhonix-assets-v10';

const SHELL_PAGES = [
  '/index.html',
  '/portal.html',
  '/teacher-portal.html',
  '/parent-portal.html',
  '/admin.html',
  '/manifest.json'
];

const SHELL_ASSETS = [
  '/css/styles.css?v=3',
  '/js/app.js?v=15',
  '/js/teacher-portal.js?v=15',
  '/js/parent-portal.js?v=15',
  '/js/landing.js?v=15',
  '/js/offline-core.js',
  '/js/offline-db.js',
  '/js/network-manager.js',
  '/js/cache-manager.js',
  '/js/sync-queue.js',
  '/js/sync-engine.js',
  '/js/sync-ui.js'
];

const NAV_TIMEOUT = 700;   // ms before a navigation falls back to cache
const ASSET_TIMEOUT = 500; // ms before a static asset falls back to cache

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const pageCache = await caches.open(PAGE_CACHE);
    await Promise.all(SHELL_PAGES.map(u => pageCache.add(u).catch(() => {})));
    const assetCache = await caches.open(ASSET_CACHE);
    await Promise.all(SHELL_ASSETS.map(u => assetCache.add(u).catch(() => {})));
  })());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = [SHELL_VERSION, PAGE_CACHE, ASSET_CACHE];
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => keep.indexOf(k) === -1).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

function delay(ms, value) {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function backgroundFetch(request, cache) {
  return fetch(request).then((res) => {
    if (res && res.ok && (res.type === 'basic' || res.type === 'cors' || res.type === 'opaque')) {
      cache.put(request, res.clone()).catch(() => {});
    }
    return res;
  }).catch(() => null);
}

/**
 * Serve the cached copy as soon as the network has not answered within the
 * time budget; when the network answers first, the fresher copy is used.
 * Either way the cache is refreshed in the background, so the next load is
 * always up to date AND always instant.
 */
async function cachedWithinBudget(request, cacheName, budget) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request, { ignoreSearch: false });
  const network = backgroundFetch(request, cache);

  if (!cached) {
    const res = await network;
    return res || new Response('', { status: 504, statusText: 'Offline' });
  }

  const fresh = await Promise.race([network, delay(budget, null)]);
  return fresh || cached;
}

async function networkFirstNav(request) {
  const cache = await caches.open(PAGE_CACHE);
  const network = fetch(request).then((res) => {
    if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
    return res;
  }).catch(() => null);

  const res = await Promise.race([network, delay(NAV_TIMEOUT, null)]);
  if (res) return res;

  const cached = await cache.match(request);
  if (cached) return cached;

  // Nothing cached yet — keep waiting for the network instead of failing
  const waited = await network;
  if (waited) return waited;

  const fallback = await cache.match('/portal.html');
  if (fallback) return fallback;
  return new Response('<h1>You are offline</h1>', {
    status: 503,
    headers: { 'Content-Type': 'text/html' }
  });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch (e) { return; }

  // API always goes to the network (IndexedDB offline layer owns API caching)
  if (url.pathname.indexOf('/api/') === 0) {
    event.respondWith(
      fetch(request).catch(() => new Response(
        JSON.stringify({ error: 'Offline', offline: true }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      ))
    );
    return;
  }

  // Uploaded assets (logos / student photos) : cached, revalidated in background
  if (url.pathname.indexOf('/uploads/') === 0) {
    event.respondWith(cachedWithinBudget(request, ASSET_CACHE, ASSET_TIMEOUT));
    return;
  }

  // HTML documents / SPA navigation
  if (request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html')) {
    event.respondWith(networkFirstNav(request));
    return;
  }

  // Static code + styles + fonts + images: served in a flash, refreshed behind the scenes
  if (/\.(js|css|png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|eot|map)(\?.*)?$/i.test(url.pathname + url.search)
      || url.hostname !== self.location.hostname) {
    event.respondWith(cachedWithinBudget(request, ASSET_CACHE, ASSET_TIMEOUT));
    return;
  }

  event.respondWith(
    fetch(request).then((res) => {
      if (res && res.ok) {
        const clone = res.clone();
        caches.open(ASSET_CACHE).then(c => c.put(request, clone)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(request).then(r => r || new Response('', { status: 504 })))
  );
});

self.addEventListener('sync', (event) => {
  if (event.tag === 'skyhonix-sync') {
    event.waitUntil(
      self.clients.matchAll().then((clients) => {
        clients.forEach((client) => client.postMessage({ type: 'TRIGGER_SYNC' }));
      })
    );
  }
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});
