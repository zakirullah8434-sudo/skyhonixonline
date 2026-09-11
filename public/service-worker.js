/**
 * SkyHonix Service Worker - PWA Shell Caching
 * Cache-first for static assets, network-first for API
 */
const CACHE_NAME = 'skyhonix-v2';
const SHELL = [
  '/',
  '/index.html',
  '/portal.html',
  '/teacher-portal.html',
  '/parent-portal.html',
  '/admin.html',
  '/css/styles.css',
  '/js/app.js',
  '/js/teacher-portal.js',
  '/js/parent-portal.js',
  '/js/landing.js',
  '/js/offline-core.js',
  '/manifest.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(SHELL).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request).then(r => {
        if (r.ok) { const c = r.clone(); caches.open(CACHE_NAME).then(ca => ca.put(e.request, c)); }
        return r;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(c => c || fetch(e.request).then(r => {
      if (r.ok) { const cl = r.clone(); caches.open(CACHE_NAME).then(ca => ca.put(e.request, cl)); }
      return r;
    }).catch(() => {
      if (e.request.headers.get('accept')?.includes('text/html')) return caches.match('/portal.html');
      return new Response('Offline', { status: 503 });
    }))
  );
});

self.addEventListener('sync', (e) => {
  if (e.tag === 'skyhonix-sync') {
    e.waitUntil(self.clients.matchAll().then(cs => cs.forEach(c => c.postMessage({ type: 'BACKGROUND_SYNC' }))));
  }
});
