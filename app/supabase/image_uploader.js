/**
 * Secure Concurrency-Limited Image Uploader for Prince Picker
 * Features:
 * - Authorization Bearer Token pass-through
 * - Browser -> Cloudflare Worker API -> Cloudflare R2
 * - 3 Retries with exponential backoff (1s, 3s, 5s)
 * - Concurrency Limit = 2 (prevents mobile memory spikes)
 * - Version 1 Metadata Parsing + Latency Telemetry
 * - Atomic R2 Cleanup helper (deleteR2Image)
 */
(function (window) {
  function generateUUID() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'u_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 9);
  }

  const DEFAULT_WORKER_ENDPOINT = 'https://prince-picker-image-worker.prince-picker.workers.dev/upload';
  const DEFAULT_R2_PUBLIC_URL = 'https://pub-f1e8b42c57c64598b4251559ff578b2e.r2.dev';
  const MAX_RETRIES = 3;
  const RETRY_DELAYS = [1000, 3000, 5000];

  function getR2PublicBaseUrl() {
    return (window.SUPABASE_CONFIG && (window.SUPABASE_CONFIG.r2PublicUrl || window.SUPABASE_CONFIG.r2Endpoint)) || DEFAULT_R2_PUBLIC_URL;
  }

  function getAuthToken() {
    try {
      if (window.SUPABASE_CLIENT && window.SUPABASE_CLIENT.instance && window.SUPABASE_CLIENT.instance.auth) {
        const session = window.SUPABASE_CLIENT.instance.auth.session ? window.SUPABASE_CLIENT.instance.auth.session() : null;
        if (session && session.access_token) return session.access_token;
      }
    } catch (e) { }
    return (window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.anonKey) || 'anon-jwt-token-prince-picker';
  }

  async function uploadSingleImage(blobOrDataUrl, productId, options = {}) {
    const uploadStart = Date.now();
    const uuid = generateUUID();
    const cleanProdId = String(productId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
    const storagePath = `products/${cleanProdId}/${uuid}.webp`;
    const checksum = options.checksum || '';
    const width = options.width || 0;
    const height = options.height || 0;
    const imageCount = options.imageCount || 0;

    const isOnline = typeof navigator !== 'undefined' ? navigator.onLine !== false : true;

    let blob = blobOrDataUrl;
    if (typeof blobOrDataUrl === 'string' && blobOrDataUrl.startsWith('data:')) {
      const arr = blobOrDataUrl.split(',');
      const mime = (arr[0].match(/:(.*?);/) || [])[1] || 'image/webp';
      const bstr = atob(arr[1]);
      let n = bstr.length;
      const u8arr = new Uint8Array(n);
      while (n--) u8arr[n] = bstr.charCodeAt(n);
      blob = new Blob([u8arr], { type: mime });
    }

    const workerUrl = (window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.workerEndpoint) || DEFAULT_WORKER_ENDPOINT;
    const authToken = getAuthToken();

    // 1. Retry Loop with Bearer Auth Header & Backoff
    if (isOnline && workerUrl) {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const formData = new FormData();
          formData.append('file', blob, `${uuid}.webp`);
          formData.append('productId', cleanProdId);
          formData.append('checksum', checksum);
          formData.append('width', width);
          formData.append('height', height);

          const response = await fetch(workerUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${authToken}`,
              'X-Product-ID': cleanProdId,
              'X-Checksum': checksum,
              'X-Image-Width': String(width),
              'X-Image-Height': String(height),
              'X-Image-Count': String(imageCount),
            },
            body: formData
          });

          if (response.ok) {
            const result = await response.json();
            if (result && result.success && result.url) {
              const uploadDurationMs = Date.now() - uploadStart;
              console.log(`[ImageUploader] Worker upload success in ${uploadDurationMs}ms:`, result.url);
              return {
                url: result.url,
                id: result.id || ('img_' + uuid),
                storagePath: result.storagePath || storagePath,
                sizeBytes: result.sizeBytes || (blob instanceof Blob ? blob.size : 0),
                width: result.width || width,
                height: result.height || height,
                mime: 'image/webp',
                checksum: result.checksum || checksum,
                createdAt: result.createdAt || new Date().toISOString(),
                version: result.version || 1,
                tags: result.tags || [],
                notes: result.notes || '',
                uploadDurationMs: uploadDurationMs,
                workerLatencyMs: result.workerLatencyMs || 0,
                uploaded: true,
                remote: true,
                provider: 'cloudflare-worker-r2'
              };
            }
          } else {
            console.warn(`[ImageUploader] Worker attempt ${attempt + 1} HTTP ${response.status}`);
          }
        } catch (errWorker) {
          console.warn(`[ImageUploader] Worker attempt ${attempt + 1} exception:`, errWorker);
        }

        if (attempt < MAX_RETRIES) {
          const delay = RETRY_DELAYS[attempt] || 2000;
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    function blobToDataUrl(b) {
      return new Promise(resolve => {
        if (!b || !(b instanceof Blob)) return resolve('');
        const r = new FileReader();
        r.onloadend = () => resolve(r.result || '');
        r.onerror = () => resolve('');
        r.readAsDataURL(b);
      });
    }

    // 2. Offline / Local Fallback Queueing
    let fallbackUrl = typeof blobOrDataUrl === 'string' ? blobOrDataUrl : '';
    if ((!fallbackUrl || fallbackUrl.startsWith('blob:')) && blob instanceof Blob) {
      fallbackUrl = await blobToDataUrl(blob);
    }

    const defaultUrl = `${getR2PublicBaseUrl()}/${storagePath}`;

    try {
      if (window.PICKER_DB && typeof window.PICKER_DB.addSyncQueue === 'function') {
        await window.PICKER_DB.addSyncQueue({
          type: 'upload_image',
          productId: cleanProdId,
          storagePath: storagePath,
          checksum: checksum,
          dataUrl: typeof blobOrDataUrl === 'string' ? blobOrDataUrl : fallbackUrl
        });
      }
    } catch (e) { }

    return {
      url: fallbackUrl || defaultUrl,
      id: 'img_' + uuid,
      storagePath,
      sizeBytes: blob instanceof Blob ? blob.size : 0,
      width,
      height,
      mime: 'image/webp',
      checksum,
      createdAt: new Date().toISOString(),
      version: 1,
      tags: [],
      notes: '',
      uploadDurationMs: Date.now() - uploadStart,
      uploaded: false,
      remote: false,
      queued: true,
      provider: 'offline-cache'
    };
  }

  /**
   * Upload multiple compressed images with Concurrency Limit = 2
   */
  async function uploadMultipleImagesParallel(items, productId) {
    if (!Array.isArray(items) || items.length === 0) return [];

    const results = [];
    const CONCURRENCY_LIMIT = 2;

    for (let i = 0; i < items.length; i += CONCURRENCY_LIMIT) {
      const chunk = items.slice(i, i + CONCURRENCY_LIMIT);
      const chunkPromises = chunk.map((item, idx) => {
        const payload = item.blob || item.dataUrl || item;
        const checksum = item.checksum || '';
        const width = item.width || 0;
        const height = item.height || 0;
        return uploadSingleImage(payload, productId, { checksum, width, height, imageCount: i + idx });
      });

      const chunkResults = await Promise.allSettled(chunkPromises);

      chunkResults.forEach((res, idx) => {
        const itemIdx = i + idx;
        if (res.status === 'fulfilled') {
          results[itemIdx] = { ...items[itemIdx], ...res.value };
        } else {
          console.error(`[ImageUploader] Image ${itemIdx} upload failed:`, res.reason);
          results[itemIdx] = {
            ...items[itemIdx],
            url: items[itemIdx].dataUrl || '',
            error: res.reason ? res.reason.message : 'Upload failed'
          };
        }
      });
    }

    return results;
  }

  /**
   * Delete object from R2 via Cloudflare Worker DELETE route with Authorization Header
   */
  async function deleteR2Image(imageUrlOrPath) {
    if (!imageUrlOrPath) return false;
    const workerUrl = (window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.workerEndpoint) || DEFAULT_WORKER_ENDPOINT;

    if (window.IMAGE_CACHE && typeof window.IMAGE_CACHE.deleteCachedImage === 'function') {
      window.IMAGE_CACHE.deleteCachedImage(imageUrlOrPath);
    }

    if (!workerUrl) return false;

    try {
      let storagePath = imageUrlOrPath;
      if (storagePath.startsWith('http://') || storagePath.startsWith('https://')) {
        const u = new URL(storagePath);
        storagePath = u.pathname.replace(/^\/+/, '');
      }

      const authToken = getAuthToken();
      const deleteEndpoint = `${workerUrl}?path=${encodeURIComponent(storagePath)}`;
      const resp = await fetch(deleteEndpoint, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${authToken}`
        }
      });
      if (resp.ok) {
        console.log('[ImageUploader] Deleted R2 image:', storagePath);
        return true;
      }
    } catch (e) {
      console.warn('[ImageUploader] R2 image delete warning:', e);
    }
    return false;
  }

  window.IMAGE_UPLOADER = {
    uploadSingleImage,
    uploadMultipleImagesParallel,
    deleteR2Image,
    generateUUID,
    getR2PublicBaseUrl,
    DEFAULT_WORKER_ENDPOINT
  };
})(typeof window !== 'undefined' ? window : this);
