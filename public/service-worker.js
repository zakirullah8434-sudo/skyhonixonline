/**
 * SkyHonix Service Worker - Instant App Shell
 *
 * Strategy:
 *   - API              -> network only (never cached, offline -> 503)
 *   - HTML / navigate  -> ALWAYS network-first (cache only as offline fallback)
 *   - JS / CSS / fonts / images -> cache-first + background revalidate
 *
 * Bump SHELL_VERSION whenever a cached asset is renamed/removed.
 */
const SHELL_VERSION = 'skyhonix-shell-v22';
const PAGE_CACHE = 'skyhonix-pages-v22';
const ASSET_CACHE = 'skyhonix-assets-v22';

const SHELL_PAGES = [
  '/index.html',
  '/portal.html',
  '/teacher-portal.html',
  '/parent-portal.html',
  '/admin.html',
  '/manifest.json'
];

const SHELL_ASSETS = [
  '/css/styles.css?v=7',
  '/js/app.js?v=26',
  '/js/teacher-portal.js?v=16',
  '/js/parent-portal.js?v=16',
  '/js/section-history.js?v=1',
  '/js/landing.js?v=15',
  '/js/offline-core.js',
  '/js/offline-db.js',
  '/js/network-manager.js',
  '/js/cache-manager.js',
  '/js/sync-queue.js',
  '/js/sync-engine.js',
  '/js/sync-ui.js'
];

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
    // This fresh worker now controls every open page — including pages that
    // were served by an older worker. Re-navigate them immediately so a stale
    // page is replaced with current HTML/JS in the same app-open (the hash
    // fragment, e.g. #token=..., is preserved by client.navigate).
    const windows = await self.clients.matchAll({ type: 'window' });
    windows.forEach(c => { try { c.navigate(c.url); } catch (e) {} });
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
 * Used for uploads and static assets (NOT for HTML — see networkFirstNav).
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

/**
 * HTML is ALWAYS fetched fresh from the network; the cache is only used
 * as an offline fallback. An earlier version raced the network against a
 * short timeout which could serve stale HTML on slow mobile connections,
 * leaving the page and the JS bundle out of sync (blank modules, broken
 * switches). Freshness matters more than a few hundred ms here.
 */
async function networkFirstNav(request) {
  const cache = await caches.open(PAGE_CACHE);
  try {
    const res = await fetch(request);
    if (res && res.ok) cache.put(request, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    const cached = await cache.match(request);
    if (cached) return cached;
    const fallback = await cache.match('/portal.html');
    if (fallback) return fallback;
    return new Response('<h1>You are offline</h1>', {
      status: 503,
      headers: { 'Content-Type': 'text/html' }
    });
  }
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
