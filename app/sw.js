'use strict';
const CACHE_NAME = 'pa-picker-v12';
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './supabase/config.js',
  './supabase/client.js',
  './supabase/db.js',
  './supabase/auth.js',
  './supabase/products.js',
  './supabase/inventory.js',
  './supabase/sync.js',
  './supabase/image_utils.js',
  './supabase/image_optimizer.js',
  './supabase/image_cache.js',
  './supabase/image_uploader.js',
  './supabase/storage.js',
  './picker-logo.png',
  './picker%20logo.png',
  './apple-touch-icon.png',
  './android-chrome-192.png',
  './android-chrome-512.png'
];

/* ── INSTALL ── */
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        return Promise.allSettled(
          STATIC_ASSETS.map(url => cache.add(url).catch(err => console.warn('[SW] Failed to cache:', url, err)))
        );
      })
      .then(() => self.skipWaiting())
      .catch(err => {
        console.warn('[SW] Caching static assets warning:', err);
        self.skipWaiting();
      })
  );
});

/* ── ACTIVATE ── */
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* ── FETCH ── */
self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') return;

  // Skip cross-origin requests (CDNs, fonts, etc.)
  if (url.origin !== location.origin) return;

  // API / JSON requests: Network-first with cache fallback
  const isData = url.pathname.endsWith('.json') || url.pathname.includes('/api/');
  if (isData) {
    e.respondWith(
      fetch(request)
        .then(res => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(request, clone));
          }
          return res;
        })
        .catch(() =>
          caches.match(request).then(cached =>
            cached || new Response(JSON.stringify({ error: 'offline' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            })
          )
        )
    );
    return;
  }

  // Static assets: Stale-while-revalidate
  e.respondWith(
    caches.match(request).then(cached => {
      const networkFetch = fetch(request).then(res => {
        if (res && res.ok) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(request, clone));
        }
        return res;
      }).catch(() => cached);
      return cached || networkFetch;
    })
  );
});
