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

  const storedUrl = typeof localStorage !== 'undefined' ? localStorage.getItem('sp_project_url') : null;
  const storedKey = typeof localStorage !== 'undefined' ? localStorage.getItem('sp_anon_key') : null;
  const storedWorker = typeof localStorage !== 'undefined' ? localStorage.getItem('sp_worker_endpoint') : null;
  const storedImageBase = typeof localStorage !== 'undefined' ? localStorage.getItem('sp_image_base_url') : null;

  function getImageBaseUrl() {
    return (window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.imageBaseUrl)
      ? String(window.SUPABASE_CONFIG.imageBaseUrl).replace(/\/+$/, '')
      : PRODUCTION_IMAGE_BASE_URL;
  }

  function resolveImageUrl(url) {
    if (!url || typeof url !== 'string') return '';
    url = url.trim();
    if (!url) return '';

    // Strict security rule: Never render blob: URLs as persistent image URLs
    if (url.startsWith('blob:')) return '';
    if (url.startsWith('data:')) return url;

    const base = getImageBaseUrl();

    // 1. Target known legacy Cloudflare R2 development domains
    for (const oldDomain of OLD_R2_DOMAINS) {
      if (url.includes(oldDomain)) {
        return url.replace(new RegExp(`^https?:\\/\\/${oldDomain.replace(/\\./g, '\\.')}\\/?`, 'i'), `${base}/`);
      }
    }

    // 2. Generic pattern match for any pub-*.r2.dev development subdomain
    if (/^https?:\/\/pub-[a-z0-9]+\.r2\.dev\/?/i.test(url)) {
      return url.replace(/^https?:\/\/pub-[a-z0-9]+\.r2\.dev\/?/i, `${base}/`);
    }

    // 3. Avoid duplicate base URLs or malformed concatenated URLs
    if (url.startsWith(base)) {
      return url;
    }

    // 4. Other external web URLs (e.g. placeholder, cdn, avatars) remain intact
    if (/^https?:\/\//i.test(url)) {
      return url;
    }

    // 5. Root-relative or relative object path (e.g. 'products/...', '/products/...')
    const cleanKey = url.replace(/^\/+/, '');
    return `${base}/${cleanKey}`;
  }

  const configObj = {
    url: storedUrl || defaultConfig.url,
    anonKey: storedKey || defaultConfig.anonKey,
    imageBaseUrl: storedImageBase || PRODUCTION_IMAGE_BASE_URL,
    r2Endpoint: storedImageBase || PRODUCTION_IMAGE_BASE_URL,
    r2PublicUrl: storedImageBase || PRODUCTION_IMAGE_BASE_URL,
    workerEndpoint: storedWorker || 'https://prince-picker-image-worker.prince-picker.workers.dev/upload',
    getImageBaseUrl,
    resolveImageUrl,
    updateConfig: function(url, key, worker, imageBase) {
      if (typeof localStorage !== 'undefined') {
        if (url) localStorage.setItem('sp_project_url', url);
        if (key) localStorage.setItem('sp_anon_key', key);
        if (worker) localStorage.setItem('sp_worker_endpoint', worker);
        if (imageBase) localStorage.setItem('sp_image_base_url', imageBase);
      }
      if (url) window.SUPABASE_CONFIG.url = url;
      if (key) window.SUPABASE_CONFIG.anonKey = key;
      if (worker) window.SUPABASE_CONFIG.workerEndpoint = worker;
      if (imageBase) {
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
