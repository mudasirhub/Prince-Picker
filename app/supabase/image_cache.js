/**
 * Image Caching Engine for Prince Picker (Cache API + IndexedDB)
 * Enforces strict 200-only caching and purges stale/replaced entries across all caches.
 */
(function(window) {
  const CACHE_NAME = 'prince-picker-images-v1';

  function isCacheableUrl(key) {
    return typeof key === 'string' && (key.startsWith('http://') || key.startsWith('https://') || key.startsWith('/'));
  }

  async function cacheImage(key, blobOrDataUrl) {
    if (!key) return false;
    try {
      if (typeof window !== 'undefined' && window.caches && isCacheableUrl(key)) {
        const cache = await window.caches.open(CACHE_NAME);
        let response = null;
        if (blobOrDataUrl instanceof Blob && blobOrDataUrl.size > 0) {
          const mime = (blobOrDataUrl.type && blobOrDataUrl.type.startsWith('image/')) ? blobOrDataUrl.type : 'image/webp';
          response = new Response(blobOrDataUrl, {
            status: 200,
            headers: {
              'Content-Type': mime,
              'Cache-Control': 'public, max-age=31536000, immutable',
              'Access-Control-Allow-Origin': '*',
              'Cross-Origin-Resource-Policy': 'cross-origin'
            }
          });
        } else if (typeof blobOrDataUrl === 'string' && blobOrDataUrl.startsWith('data:image/')) {
          const arr = blobOrDataUrl.split(',');
          const mimeMatch = arr[0].match(/:(.*?);/);
          const mime = (mimeMatch && mimeMatch[1]) ? mimeMatch[1] : 'image/webp';
          const bstr = atob(arr[1] || '');
          let n = bstr.length;
          const u8arr = new Uint8Array(n);
          while (n--) u8arr[n] = bstr.charCodeAt(n);
          const blob = new Blob([u8arr], { type: mime });
          response = new Response(blob, {
            status: 200,
            headers: {
              'Content-Type': mime,
              'Cache-Control': 'public, max-age=31536000, immutable',
              'Access-Control-Allow-Origin': '*',
              'Cross-Origin-Resource-Policy': 'cross-origin'
            }
          });
        }
        if (response && response.ok && response.status === 200) {
          await cache.put(key, response);
        }
      }
    } catch (e) {
      console.warn('[ImageCache] Cache API warning:', e);
    }

    try {
      if (typeof window !== 'undefined' && window.PICKER_DB && typeof window.PICKER_DB.openDB === 'function') {
        const db = await window.PICKER_DB.openDB();
        if (db.objectStoreNames.contains('images')) {
          const tx = db.transaction('images', 'readwrite');
          const store = tx.objectStore('images');
          store.put({ id: key, data: blobOrDataUrl, timestamp: new Date().toISOString() });
        }
      }
    } catch (e) { }

    return true;
  }

  async function getCachedImage(key) {
    if (!key) return null;
    try {
      if (typeof window !== 'undefined' && window.caches && isCacheableUrl(key)) {
        const cache = await window.caches.open(CACHE_NAME);
        const matched = await cache.match(key);
        if (matched) {
          const ct = (matched.headers.get('Content-Type') || '').toLowerCase();
          if (matched.ok && matched.status === 200 && ct.startsWith('image/')) {
            return key;
          }
          // Evict corrupted or error response if present
          await cache.delete(key);
        }
      }
    } catch (e) { }

    try {
      if (typeof window !== 'undefined' && window.PICKER_DB && typeof window.PICKER_DB.openDB === 'function') {
        const db = await window.PICKER_DB.openDB();
        if (db.objectStoreNames.contains('images')) {
          return new Promise((resolve) => {
            const tx = db.transaction('images', 'readonly');
            const store = tx.objectStore('images');
            const req = store.get(key);
            req.onsuccess = () => {
              const resData = req.result ? req.result.data : null;
              if (typeof resData === 'string' && resData.startsWith('blob:')) {
                resolve(null);
              } else {
                resolve(resData);
              }
            };
            req.onerror = () => resolve(null);
          });
        }
      }
    } catch (e) { }

    return null;
  }

  async function deleteCachedImage(key) {
    if (!key) return false;
    try {
      if (typeof window !== 'undefined' && window.caches && isCacheableUrl(key)) {
        const cacheNames = await window.caches.keys();
        await Promise.all(
          cacheNames.map(name => window.caches.open(name).then(c => c.delete(key, { ignoreSearch: true })))
        );
      }
      if (typeof navigator !== 'undefined' && navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'PURGE_IMAGE_CACHE', url: key });
      }
    } catch (e) { }

    try {
      if (typeof window !== 'undefined' && window.PICKER_DB && typeof window.PICKER_DB.openDB === 'function') {
        const db = await window.PICKER_DB.openDB();
        if (db.objectStoreNames.contains('images')) {
          const tx = db.transaction('images', 'readwrite');
          const store = tx.objectStore('images');
          store.delete(key);
        }
      }
    } catch (e) { }

    return true;
  }

  window.IMAGE_CACHE = {
    cacheImage,
    getCachedImage,
    deleteCachedImage
  };
})(typeof window !== 'undefined' ? window : this);
