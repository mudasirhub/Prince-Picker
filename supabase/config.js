/**
 * Supabase & Cloudflare Production Storage Configuration for Prince Picker
 * Centralized Production Image Delivery & Cloudflare Worker Endpoint
 */
(function(window) {
  const PRODUCTION_IMAGE_BASE_URL = 'https://prince-picker-image-worker.prince-picker.workers.dev';
  const OLD_R2_DOMAINS = [
    'pub-091b1d2070306c80f830d33d243cf4f0.r2.dev',
    'pub-f1e8b42c57c64598b4251559ff578b2e.r2.dev'
  ];

  const defaultConfig = {
    url: 'https://jzwpbiqiplsuuukbxhnq.supabase.co',
    anonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp6d3BiaXFpcGxzdXV1a2J4aG5xIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ4NjQzNDcsImV4cCI6MjEwMDQ0MDM0N30.-Sxvmx1hsz3P64GKS_77T2iGDTYj5ysMtQZxw1vdtM0',
  };

  function isLegacyR2Host(val) {
    if (!val || typeof val !== 'string') return false;
    return /\.r2\.dev\b/i.test(val);
  }

  const storedUrl = typeof localStorage !== 'undefined' ? localStorage.getItem('sp_project_url') : null;
  const storedKey = typeof localStorage !== 'undefined' ? localStorage.getItem('sp_anon_key') : null;
  const rawStoredWorker = typeof localStorage !== 'undefined' ? localStorage.getItem('sp_worker_endpoint') : null;
  const rawStoredImageBase = typeof localStorage !== 'undefined' ? localStorage.getItem('sp_image_base_url') : null;

  const storedWorker = (rawStoredWorker && !isLegacyR2Host(rawStoredWorker)) ? rawStoredWorker : null;
  const storedImageBase = (rawStoredImageBase && !isLegacyR2Host(rawStoredImageBase)) ? rawStoredImageBase : null;

  function getImageBaseUrl() {
    const raw = (window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.imageBaseUrl)
      ? String(window.SUPABASE_CONFIG.imageBaseUrl)
      : PRODUCTION_IMAGE_BASE_URL;
    return (isLegacyR2Host(raw) ? PRODUCTION_IMAGE_BASE_URL : raw).replace(/\/+$/, '');
  }

  /**
   * Collapse duplicate slashes in a path (preserving query string) and strip leading slashes.
   */
  function normalizeImagePath(pathWithQuery) {
    const qIdx = pathWithQuery.indexOf('?');
    const rawPath = qIdx >= 0 ? pathWithQuery.slice(0, qIdx) : pathWithQuery;
    const query = qIdx >= 0 ? pathWithQuery.slice(qIdx) : '';
    const cleanPath = rawPath.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '');
    return cleanPath + query;
  }

  /**
   * Unwrap /cdn-cgi/image/<options>/<target> paths so broken/unsupported proxy URLs
   * resolve directly to the canonical Worker R2 object URL.
   */
  function unwrapCdnCgiPath(pathOrUrl) {
    const match = pathOrUrl.match(/^(?:https?:\/\/[^/]+)?\/+cdn-cgi\/image\/[^/]+\/(.+)$/i);
    if (!match) return null;
    let target = match[1].trim();
    if (/^https?%3a/i.test(target)) {
      try { target = decodeURIComponent(target); } catch (_) { }
    }
    // Handle nested http:/host/products/... after slash normalization or full URL
    if (/^https?:\/+[^/]+\//i.test(target)) {
      target = target.replace(/^https?:\/+/i, 'https://');
      return target;
    }
    return target;
  }

  function resolveImageUrl(url) {
    if (!url || typeof url !== 'string') return '';
    url = url.trim();
    if (!url) return '';

    // Strict security rule: Never render blob: URLs as persistent image URLs
    if (url.startsWith('blob:')) return '';
    if (url.startsWith('data:')) return url;

    const base = getImageBaseUrl();

    // Unwrap /cdn-cgi/image/<opts>/... recursively if present
    const unwrapped = unwrapCdnCgiPath(url);
    if (unwrapped && unwrapped !== url) {
      return resolveImageUrl(unwrapped);
    }

    // 1. Target known legacy Cloudflare R2 development domains
    for (const oldDomain of OLD_R2_DOMAINS) {
      if (url.includes(oldDomain)) {
        const escaped = oldDomain.replace(/\./g, '\\.');
        const stripped = url.replace(new RegExp(`^https?:\\/\\/${escaped}\\/*`, 'i'), '');
        return `${base}/${normalizeImagePath(stripped)}`;
      }
    }

    // 2. Generic pattern match for any pub-*.r2.dev development subdomain
    if (/^https?:\/\/pub-[a-z0-9]+\.r2\.dev\b/i.test(url)) {
      const stripped = url.replace(/^https?:\/\/pub-[a-z0-9]+\.r2\.dev\/*/i, '');
      return `${base}/${normalizeImagePath(stripped)}`;
    }

    // 3. Normalize already-pointed production Worker URLs (collapse duplicate slashes)
    if (url.startsWith(base)) {
      const rest = url.slice(base.length);
      if (!rest || rest === '/') return base;
      return `${base}/${normalizeImagePath(rest)}`;
    }

    // 4. Relative or root-relative product keys wrapped under app domain (e.g. https://princepicker.mudasirkhan.in/products/...)
    if (/^https?:\/\/[^/]+\/+products\//i.test(url)) {
      const stripped = url.replace(/^https?:\/\/[^/]+\/+/i, '');
      return `${base}/${normalizeImagePath(stripped)}`;
    }

    // 5. Other external web URLs (e.g. placeholder, cdn, avatars) remain intact
    if (/^https?:\/\//i.test(url)) {
      return url;
    }

    // 6. Local app assets (./ or non-products root paths) remain intact
    if (url.startsWith('./') || (url.startsWith('/') && !/^\/+products\//i.test(url))) {
      return url;
    }

    // 7. Root-relative or relative object path (e.g. 'products/...', '/products/...', '//products//...')
    return `${base}/${normalizeImagePath(url)}`;
  }

  const configObj = {
    url: storedUrl || defaultConfig.url,
    anonKey: storedKey || defaultConfig.anonKey,
    imageBaseUrl: storedImageBase || PRODUCTION_IMAGE_BASE_URL,
    r2Endpoint: storedImageBase || PRODUCTION_IMAGE_BASE_URL,
    r2PublicUrl: storedImageBase || PRODUCTION_IMAGE_BASE_URL,
    workerEndpoint: storedWorker || `${PRODUCTION_IMAGE_BASE_URL}/upload`,
    getImageBaseUrl,
    resolveImageUrl,
    updateConfig: function(url, key, worker, imageBase) {
      if (typeof localStorage !== 'undefined') {
        if (url) localStorage.setItem('sp_project_url', url);
        if (key) localStorage.setItem('sp_anon_key', key);
        if (worker && !isLegacyR2Host(worker)) localStorage.setItem('sp_worker_endpoint', worker);
        if (imageBase && !isLegacyR2Host(imageBase)) localStorage.setItem('sp_image_base_url', imageBase);
      }
      if (url) window.SUPABASE_CONFIG.url = url;
      if (key) window.SUPABASE_CONFIG.anonKey = key;
      if (worker && !isLegacyR2Host(worker)) window.SUPABASE_CONFIG.workerEndpoint = worker;
      if (imageBase && !isLegacyR2Host(imageBase)) {
        window.SUPABASE_CONFIG.imageBaseUrl = imageBase;
        window.SUPABASE_CONFIG.r2Endpoint = imageBase;
        window.SUPABASE_CONFIG.r2PublicUrl = imageBase;
      }
    }
  };

  window.SUPABASE_CONFIG = configObj;
  window.resolveImageUrl = resolveImageUrl;
  window.getImageBaseUrl = getImageBaseUrl;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      SUPABASE_CONFIG: configObj,
      PRODUCTION_IMAGE_BASE_URL,
      OLD_R2_DOMAINS,
      resolveImageUrl,
      getImageBaseUrl
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
