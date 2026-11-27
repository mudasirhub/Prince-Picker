'use strict';
const CACHE_NAME = 'pa-picker-v20';
const IMAGE_CACHE_NAME = 'prince-picker-images-v1';

const WORKER_IMAGE_HOSTS = [
  'prince-picker-image-worker.prince-picker.workers.dev'
];
const PUBLIC_R2_HOSTS = [
  'pub-f1e8b42c57c64598b4251559ff578b2e.r2.dev'
];

const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './search_engine.js',
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
  './apple-touch-icon.png',
  './android-chrome-192.png',
  './android-chrome-512.png'
];

const OFFLINE_FALLBACK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120" role="img" aria-label="Image unavailable offline">' +
  '<rect width="120" height="120" rx="14" fill="#f4f4f5"/>' +
  '<g fill="none" stroke="#9ca3af" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" transform="translate(28,28)">' +
  '<rect x="4" y="8" width="56" height="48" rx="6"/>' +
  '<circle cx="21" cy="24" r="5"/>' +
  '<path d="M56 44L41 29L12 56"/>' +
  '</g>' +
  '</svg>';

function offlinePlaceholderResponse() {
  return new Response(OFFLINE_FALLBACK_SVG, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'X-Offline-Fallback': '1'
    }
  });
}

function isValidImageResponse(res) {
  if (!res || !res.ok || res.status !== 200 || res.type === 'opaque') {
    return false;
  }
  const contentType = (res.headers.get('Content-Type') || '').toLowerCase();
  if (contentType.includes('text/html') || contentType.includes('application/json')) {
    return false;
  }
  return contentType.startsWith('image/');
}

function isImagePath(pathname) {
  return /\.(webp|png|jpe?g|gif|svg|avif)$/i.test(pathname) ||
    pathname.startsWith('/products/') ||
    pathname.includes('/cdn-cgi/image/');
}

function isWorkerImageUrl(url) {
  return WORKER_IMAGE_HOSTS.includes(url.hostname) &&
    (url.pathname.startsWith('/products/') || url.pathname.includes('/cdn-cgi/image/') || isImagePath(url.pathname));
}

function isPublicR2ImageUrl(url) {
  return PUBLIC_R2_HOSTS.includes(url.hostname) &&
    (url.pathname.startsWith('/products/') || url.pathname.includes('/cdn-cgi/image/') || isImagePath(url.pathname));
}

function isImageRequest(request, url) {
  return request.destination === 'image' || isImagePath(url.pathname);
}

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
        keys
          .filter(k => k !== CACHE_NAME && k !== IMAGE_CACHE_NAME)
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

/* ── MESSAGE (Cache Purge & Updates) ── */
self.addEventListener('message', e => {
  const data = e.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (data.type === 'PURGE_IMAGE_CACHE' && data.url) {
    const targetUrl = data.url;
    e.waitUntil(
      Promise.all([
        caches.open(IMAGE_CACHE_NAME).then(c => c.delete(targetUrl, { ignoreSearch: true })),
        caches.open(CACHE_NAME).then(c => c.delete(targetUrl, { ignoreSearch: true }))
      ]).catch(() => {})
    );
  }
});

/* ── IMAGE FETCH HANDLER ── */
async function handleImageFetch(request, url, isWorkerUrl, isR2Url) {
  const imageCache = await caches.open(IMAGE_CACHE_NAME);
  let cached = await imageCache.match(request);

  if (!cached && !isWorkerUrl && !isR2Url) {
    const appCache = await caches.open(CACHE_NAME);
    cached = await appCache.match(request);
  }

  if (cached) {
    if (isValidImageResponse(cached)) {
      return cached;
    }
    // Purge invalid or error response that should never stay cached
    await imageCache.delete(request).catch(() => {});
  }

  // Immediate offline fallback without stalling UI rendering
  if (typeof self.navigator !== 'undefined' && self.navigator.onLine === false) {
    return offlinePlaceholderResponse();
  }

  let timeoutId = null;
  try {
    const canAbort = typeof AbortController !== 'undefined' && typeof setTimeout !== 'undefined';
    const controller = canAbort ? new AbortController() : null;
    if (controller && isWorkerUrl) {
      timeoutId = setTimeout(() => controller.abort(), 8000);
    }

    const networkReq = isWorkerUrl
      ? new Request(request.url, {
          mode: 'cors',
          credentials: 'omit',
          cache: request.cache === 'reload' ? 'reload' : 'default',
          ...(controller ? { signal: controller.signal } : {})
        })
      : request;

    const res = await fetch(networkReq);
    if (timeoutId) clearTimeout(timeoutId);

    // Strictly cache ONLY valid 200 image responses
    if (isValidImageResponse(res)) {
      const clone = res.clone();
      imageCache.put(request, clone).catch(() => {});
      return res;
    }

    // Do NOT cache 404, 500, or non-image error responses
    return res;
  } catch (_) {
    if (timeoutId) clearTimeout(timeoutId);
    return offlinePlaceholderResponse();
  }
}

/* ── FETCH ── */
self.addEventListener('fetch', e => {
  const { request } = e;
  const url = new URL(request.url);

  // Skip non-GET requests (uploads/deletes go straight to network)
  if (request.method !== 'GET') return;

  const isSameOrigin = url.origin === location.origin;
  const isWorkerImg = isWorkerImageUrl(url);
  const isR2Img = isPublicR2ImageUrl(url);

  // Product / worker / public R2 / local image requests with strict 200-only caching and instant offline fallback
  if (isWorkerImg || isR2Img || (isSameOrigin && isImageRequest(request, url))) {
    e.respondWith(handleImageFetch(request, url, isWorkerImg, isR2Img));
    return;
  }

  // Skip other cross-origin requests (CDNs, fonts, third-party URLs)
  if (!isSameOrigin) return;

  // Navigation / HTML requests: Network-first with cache fallback
  if (request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname === '/app/' || url.pathname === '/app') {
    e.respondWith(
      fetch(request)
        .then(res => {
          if (res && res.ok && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(request, clone));
          }
          return res;
        })
        .catch(() => caches.match(request).then(cached => cached || caches.match('./index.html') || caches.match('/app/index.html')))
    );
    return;
  }

  // API / JSON requests: Network-first with cache fallback
  const isData = url.pathname.endsWith('.json') || url.pathname.includes('/api/');
  if (isData) {
    e.respondWith(
      fetch(request)
        .then(res => {
          if (res && res.ok && res.status === 200) {
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

  // Static assets (JS/CSS): Stale-while-revalidate (never cache HTML fallbacks or error status codes)
  e.respondWith(
    caches.match(request).then(cached => {
      const networkFetch = fetch(request).then(res => {
        const ct = (res && res.headers.get('Content-Type') || '').toLowerCase();
        if (res && res.ok && res.status === 200 && !ct.includes('text/html')) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(request, clone));
        }
        return res;
      }).catch(() => cached || new Response('', { status: 503, statusText: 'Offline' }));
      return cached || networkFetch;
    })
  );
});
