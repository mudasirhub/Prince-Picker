/**
 * Secure Concurrency-Limited Image Uploader for Prince Picker
 * Features:
 * - Authorization Bearer Token pass-through
 * - Browser -> Cloudflare Worker API -> Cloudflare R2
 * - Exact binary Blob & MIME preservation (image/webp, image/jpeg, image/png)
 * - 3 Retries with exponential backoff (1s, 3s, 5s) on transient failures only
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
    if (window.SUPABASE_CONFIG && typeof window.SUPABASE_CONFIG.getImageBaseUrl === 'function') {
      return window.SUPABASE_CONFIG.getImageBaseUrl();
    }
    return (window.SUPABASE_CONFIG && (window.SUPABASE_CONFIG.imageBaseUrl || window.SUPABASE_CONFIG.r2PublicUrl || window.SUPABASE_CONFIG.r2Endpoint)) || DEFAULT_R2_PUBLIC_URL;
  }

  function getAuthToken() {
    try {
      if (window.SUPABASE_CLIENT && window.SUPABASE_CLIENT.instance && window.SUPABASE_CLIENT.instance.auth) {
        const session = window.SUPABASE_CLIENT.instance.auth.session ? window.SUPABASE_CLIENT.instance.auth.session() : null;
        if (session && session.access_token) return session.access_token;
      }
    } catch (e) { }
    return (window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.anonKey) || '';
  }

  async function detectMimeFromBlob(blob) {
    if (!blob || !(blob instanceof Blob)) return 'image/webp';
    const declared = (blob.type || '').toLowerCase();
    if (declared === 'image/webp' || declared === 'image/jpeg' || declared === 'image/png') {
      return declared;
    }
    if (declared === 'image/jpg') return 'image/jpeg';

    try {
      const slice = blob.slice(0, 12);
      const buf = await slice.arrayBuffer();
      const b = new Uint8Array(buf);
      if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
          b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
        return 'image/webp';
      }
      if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) {
        return 'image/jpeg';
      }
      if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 &&
          b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A) {
        return 'image/png';
      }
    } catch (_) { }
    return 'image/webp';
  }

  function extForMime(mime) {
    if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
    if (mime === 'image/png') return 'png';
    return 'webp';
  }

  async function uploadSingleImage(blobOrDataUrl, productId, options = {}) {
    const uploadStart = Date.now();
    const uuid = generateUUID();
    const cleanProdId = String(productId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
    const checksum = options.checksum || '';
    const width = options.width || 0;
    const height = options.height || 0;
    const imageCount = options.imageCount || 0;

    const isOnline = typeof navigator !== 'undefined' ? navigator.onLine !== false : true;

    let blob = blobOrDataUrl;
    if (typeof blobOrDataUrl === 'string' && blobOrDataUrl.startsWith('data:')) {
      const arr = blobOrDataUrl.split(',');
      const mime = (arr[0].match(/:(.*?);/) || [])[1] || 'image/webp';
      const bstr = atob(arr[1] || '');
      let n = bstr.length;
      const u8arr = new Uint8Array(n);
      while (n--) u8arr[n] = bstr.charCodeAt(n);
      blob = new Blob([u8arr], { type: mime });
    }

    const detectedMime = await detectMimeFromBlob(blob);
    const ext = extForMime(detectedMime);
    const storagePath = `products/${cleanProdId}/${uuid}.${ext}`;

    // Re-wrap if MIME was empty or application/octet-stream so multipart preserves accurate image MIME
    let uploadBlob = blob;
    if (blob instanceof Blob && (!blob.type || blob.type === 'application/octet-stream' || !blob.type.startsWith('image/'))) {
      uploadBlob = new Blob([blob], { type: detectedMime });
    }

    const workerUrl = (window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.workerEndpoint) || DEFAULT_WORKER_ENDPOINT;
    const authToken = getAuthToken();

    // 1. Retry Loop with Bearer Auth Header & Backoff
    if (isOnline && workerUrl && uploadBlob instanceof Blob) {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const formData = new FormData();
          formData.append('file', uploadBlob, `${uuid}.${ext}`);
          formData.append('productId', cleanProdId);
          formData.append('checksum', checksum);
          formData.append('width', String(width));
          formData.append('height', String(height));

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
              const resolvedUrl = (window.SUPABASE_CONFIG && typeof window.SUPABASE_CONFIG.resolveImageUrl === 'function')
                ? window.SUPABASE_CONFIG.resolveImageUrl(result.url)
                : ((typeof window.resolveImageUrl === 'function') ? window.resolveImageUrl(result.url) : result.url);
              console.log(`[ImageUploader] Worker upload success in ${uploadDurationMs}ms:`, resolvedUrl);
              return {
                url: resolvedUrl,
                id: result.id || ('img_' + uuid),
                storagePath: result.storagePath || storagePath,
                sizeBytes: result.sizeBytes || uploadBlob.size || 0,
                width: result.width || width,
                height: result.height || height,
                mime: result.mime || detectedMime,
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
            // Do not waste backoff cycles on deterministic 4xx validation/auth errors (except 429)
            if (response.status >= 400 && response.status < 500 && response.status !== 429 && response.status !== 408) {
              break;
            }
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

    // 2. Offline / Local Fallback Queueing (never store blob: URLs)
    let fallbackUrl = typeof blobOrDataUrl === 'string' && !blobOrDataUrl.startsWith('blob:') ? blobOrDataUrl : '';
    if (!fallbackUrl && uploadBlob instanceof Blob) {
      fallbackUrl = await blobToDataUrl(uploadBlob);
    }

    const defaultUrl = `${getR2PublicBaseUrl()}/${storagePath}`;

    if (!options.skipQueue) {
      try {
        if (window.PICKER_DB && typeof window.PICKER_DB.addSyncQueue === 'function') {
          await window.PICKER_DB.addSyncQueue('upload_image', {
            productId: cleanProdId,
            storagePath: storagePath,
            checksum: checksum,
            mime: detectedMime,
            dataUrl: fallbackUrl
          });
        }
      } catch (e) { }
    }

    return {
      url: fallbackUrl || defaultUrl,
      id: 'img_' + uuid,
      storagePath,
      sizeBytes: uploadBlob instanceof Blob ? uploadBlob.size : 0,
      width,
      height,
      mime: detectedMime,
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
      let storagePath = String(imageUrlOrPath).trim();
      if (/^https?:\/\//i.test(storagePath)) {
        const u = new URL(storagePath);
        storagePath = u.pathname;
      }
      storagePath = storagePath.replace(/\/+/g, '/').replace(/^\/+/, '');
      if (storagePath.startsWith('cdn-cgi/image/')) {
        const m = storagePath.match(/^cdn-cgi\/image\/[^/]+\/(.+)$/i);
        if (m) storagePath = m[1].replace(/^https?:\/+[^/]+\//i, '').replace(/^\/+/, '');
      }

      const authToken = getAuthToken();
      const deleteBase = workerUrl.replace(/\/+$/, '').replace(/\/upload$/i, '') + '/delete';
      const deleteEndpoint = `${deleteBase}?path=${encodeURIComponent(storagePath)}`;
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
  window.uploadSingleImage = uploadSingleImage;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      uploadSingleImage,
      uploadMultipleImagesParallel,
      deleteR2Image,
      generateUUID,
      getR2PublicBaseUrl,
      DEFAULT_WORKER_ENDPOINT
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
