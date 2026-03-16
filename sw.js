'use strict';
const V = 'pa-picker-v2';

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(V)
      .then(c => c.addAll(['/']))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== V).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;
  const isData = url.endsWith('.json') || url.includes('/api/');

  if (isData) {
    // Network-first: fetch fresh data, cache it, fall back to cache if offline
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(V).then(c => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() =>
          caches.match(e.request).then(cached =>
            cached || new Response(JSON.stringify({ error: 'offline' }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' }
            })
          )
        )
    );
    return;
  }

  if (e.request.method === 'GET') {
    // Cache-first: serve from cache, fetch + update if not cached
    e.respondWith(
      caches.match(e.request).then(cached => {
        const networkFetch = fetch(e.request).then(res => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(V).then(c => c.put(e.request, clone));
          }
          return res;
        }).catch(() => cached);
        return cached || networkFetch;
      })
    );
  }
});
