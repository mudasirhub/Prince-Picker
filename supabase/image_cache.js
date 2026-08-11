/**
 * Image Caching Engine for Prince Picker (Cache API + IndexedDB)
 */
(function(window) {
  const CACHE_NAME = 'prince-picker-images-v1';

  async function cacheImage(key, blobOrDataUrl) {
    if (!key) return false;
    try {
      if (window.caches) {
        const cache = await window.caches.open(CACHE_NAME);
        let response;
        if (blobOrDataUrl instanceof Blob) {
          response = new Response(blobOrDataUrl, {
            headers: { 'Content-Type': blobOrDataUrl.type || 'image/webp', 'Cache-Control': 'public, max-age=31536000, immutable' }
          });
        } else if (typeof blobOrDataUrl === 'string' && blobOrDataUrl.startsWith('data:')) {
          const arr = blobOrDataUrl.split(',');
          const mime = arr[0].match(/:(.*?);/)[1];
          const bstr = atob(arr[1]);
          let n = bstr.length;
          const u8arr = new Uint8Array(n);
          while (n--) u8arr[n] = bstr.charCodeAt(n);
          const blob = new Blob([u8arr], { type: mime });
          response = new Response(blob, {
            headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=31536000, immutable' }
          });
        }
        if (response && (key.startsWith('http://') || key.startsWith('https://') || key.startsWith('/'))) {
          await cache.put(key, response);
        }
      }
    } catch (e) {
      console.warn('[ImageCache] Cache API warning:', e);
    }

    // Also store in IndexedDB if PICKER_DB or legacy IDB exists
    try {
      if (window.PICKER_DB && typeof window.PICKER_DB.openDB === 'function') {
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
      if (window.caches && (key.startsWith('http://') || key.startsWith('https://') || key.startsWith('/'))) {
        const cache = await window.caches.open(CACHE_NAME);
        const matched = await cache.match(key);
        if (matched) {
          return key;
        }
      }
    } catch (e) { }

    try {
      if (window.PICKER_DB && typeof window.PICKER_DB.openDB === 'function') {
        const db = await window.PICKER_DB.openDB();
        if (db.objectStoreNames.contains('images')) {
          return new Promise((resolve) => {
            const tx = db.transaction('images', 'readonly');
            const store = tx.objectStore('images');
            const req = store.get(key);
            req.onsuccess = () => resolve(req.result ? req.result.data : null);
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
      if (window.caches && (key.startsWith('http://') || key.startsWith('https://') || key.startsWith('/'))) {
        const cache = await window.caches.open(CACHE_NAME);
        await cache.delete(key);
      }
    } catch (e) { }

    try {
      if (window.PICKER_DB && typeof window.PICKER_DB.openDB === 'function') {
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
