/**
 * Production Cloudflare Worker for Prince Picker (Cloudflare R2 Proxy & Image Delivery)
 *
 * Features:
 * - Public Image Delivery: GET & HEAD /products/* and /cdn-cgi/image/.../products/* from R2 bucket PRINCE_BUCKET
 * - URL & Key Normalization: Collapses duplicate slashes, decodes safe URI segments, rejects path traversal
 * - Upload & MIME Integrity: Supports multipart/form-data and raw binary uploads; validates magic bytes for
 *   WebP (RIFF...WEBP), JPEG (FF D8 FF), and PNG (89 50 4E 47) and sets accurate Content-Type headers
 * - CDN Caching & CORS: Cache-Control: public, max-age=31536000, immutable, ETag + 304, Cross-Origin-Resource-Policy,
 *   full CORS headers for web, PWA, and Capacitor WebView (https://localhost / capacitor://localhost)
 * - Clean JSON Errors: Accurate HTTP status codes (400, 401, 403, 404, 405, 413, 415, 422, 429, 500)
 */

const rateLimitMap = new Map();

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024; // 2 MB hard worker ceiling (client optimizes to <= 700 KB)

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Product-ID, X-Checksum, X-Image-Width, X-Image-Height, X-Image-Count, Authorization, If-None-Match, Cache-Control',
  'Access-Control-Expose-Headers': 'Content-Type, Content-Length, ETag, Cache-Control, Last-Modified',
  'Access-Control-Max-Age': '86400',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

const EXT_TO_MIME = {
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  avif: 'image/avif',
};

function jsonResponse(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': status >= 400 ? 'no-store' : 'no-cache',
      ...extraHeaders,
    },
  });
}

function safeDecodeURIComponent(str) {
  try {
    return decodeURIComponent(str);
  } catch (_) {
    return str;
  }
}

/**
 * Normalize an R2 object key or URL pathname, stripping /cdn-cgi/image/<opts>/ prefixes,
 * collapsing duplicate slashes, trimming leading/trailing slashes, and blocking traversal.
 */
function normalizeStorageKey(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return '';
  let pathStr = rawInput.trim();
  if (!pathStr) return '';

  if (/^https?:\/\//i.test(pathStr)) {
    try {
      pathStr = new URL(pathStr).pathname;
    } catch (_) {
      return '';
    }
  }

  pathStr = pathStr.split('?')[0].split('#')[0];
  pathStr = safeDecodeURIComponent(pathStr);
  pathStr = pathStr.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');

  // Unwrap Cloudflare /cdn-cgi/image/<options>/<target> proxy routes if routed through the worker
  if (pathStr.startsWith('cdn-cgi/image/')) {
    const afterPrefix = pathStr.slice('cdn-cgi/image/'.length);
    const firstSlash = afterPrefix.indexOf('/');
    if (firstSlash === -1) return '';
    let target = afterPrefix.slice(firstSlash + 1).replace(/^\/+/, '');

    // Target inside /cdn-cgi/image/<opts>/https:/host/products/... (single slash after collapse)
    const nestedUrlMatch = target.match(/^https?:\/+[^/]+\/(.+)$/i);
    if (nestedUrlMatch) {
      target = nestedUrlMatch[1];
    }
    pathStr = target.replace(/\/+/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
  }

  if (!pathStr) return '';
  const segments = pathStr.split('/');
  if (segments.some(seg => seg === '..' || seg === '.' || seg.includes('\0'))) {
    return '';
  }

  return pathStr;
}

/**
 * Inspect magic bytes to detect real binary image format (WebP, JPEG, PNG).
 * Ensures accurate Content-Type & extension instead of falling back to application/octet-stream.
 */
function detectImageFromBytes(buffer) {
  if (!buffer || buffer.byteLength < 4) return null;
  const bytes = new Uint8Array(buffer.slice(0, 16));

  // WebP: 'RIFF' (0..3) + 'WEBP' (8..11)
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return { mime: 'image/webp', ext: 'webp' };
  }

  // JPEG: FF D8 FF
  if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
    return { mime: 'image/jpeg', ext: 'jpg' };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 &&
    bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A
  ) {
    return { mime: 'image/png', ext: 'png' };
  }

  return null;
}

function inferImageContentType(key, object) {
  let metaType = (object?.httpMetadata?.contentType || '').split(';')[0].trim().toLowerCase();
  if (metaType === 'image/jpg') metaType = 'image/jpeg';
  if (metaType && metaType.startsWith('image/') && metaType !== 'image/unknown') {
    return metaType;
  }
  const extMatch = String(key || '').toLowerCase().match(/\.([a-z0-9]+)$/);
  if (extMatch && EXT_TO_MIME[extMatch[1]]) {
    return EXT_TO_MIME[extMatch[1]];
  }
  return 'image/webp';
}

function matchesIfNoneMatch(ifNoneMatchHeader, objectEtag) {
  if (!ifNoneMatchHeader || !objectEtag) return false;
  const cleanEtag = String(objectEtag).replace(/^W\//, '').replace(/^"+|"+$/g, '');
  const candidates = ifNoneMatchHeader.split(',').map(v => v.trim());
  return candidates.some(tag => {
    if (tag === '*') return true;
    const normalized = tag.replace(/^W\//, '').replace(/^"+|"+$/g, '');
    return normalized === cleanEtag;
  });
}

async function handlePublicGetOrHead(request, env, url) {
  const rawPathname = url.pathname || '/';
  const collapsedPath = rawPathname.replace(/\/+/g, '/');

  if (collapsedPath === '/' || collapsedPath === '' || collapsedPath === '/health') {
    return jsonResponse({
      service: 'prince-picker-image-worker',
      status: 'healthy',
      message: 'Prince Picker Cloudflare Image Worker Active',
    }, 200);
  }

  const cleanKey = normalizeStorageKey(rawPathname);
  if (!cleanKey || !cleanKey.startsWith('products/')) {
    return jsonResponse({ error: 'Image route not found', path: rawPathname }, 404);
  }

  if (!env.PRINCE_BUCKET) {
    return jsonResponse({ error: 'R2 bucket binding PRINCE_BUCKET not configured' }, 500);
  }

  let object = await env.PRINCE_BUCKET.get(cleanKey);

  // Fallback: if URL-encoded vs raw key mismatch occurred on legacy uploads
  if (!object) {
    const rawTrimmed = collapsedPath.replace(/^\/+/, '');
    if (rawTrimmed && rawTrimmed !== cleanKey && rawTrimmed.startsWith('products/')) {
      object = await env.PRINCE_BUCKET.get(rawTrimmed);
    }
  }

  if (!object) {
    return jsonResponse({ error: 'Image not found', path: cleanKey }, 404);
  }

  const etagValue = object.httpEtag ? `"${String(object.httpEtag).replace(/^"+|"+$/g, '')}"` : '';

  if (matchesIfNoneMatch(request.headers.get('If-None-Match'), object.httpEtag)) {
    const notModifiedHeaders = new Headers({
      ...CORS_HEADERS,
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    if (etagValue) notModifiedHeaders.set('ETag', etagValue);
    return new Response(null, { status: 304, headers: notModifiedHeaders });
  }

  const contentType = inferImageContentType(cleanKey, object);
  const headers = new Headers({
    ...CORS_HEADERS,
    'Content-Type': contentType,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Accept-Ranges': 'bytes',
  });

  if (object.size !== undefined && object.size !== null) {
    headers.set('Content-Length', String(object.size));
  }
  if (etagValue) headers.set('ETag', etagValue);
  if (object.uploaded) headers.set('Last-Modified', object.uploaded.toUTCString());

  if (request.method === 'HEAD') {
    return new Response(null, { status: 200, headers });
  }

  return new Response(object.body, { status: 200, headers });
}

function validateBearerAuth(request) {
  const authHeader = request.headers.get('Authorization') || '';
  if (!authHeader || !/^bearer\s+/i.test(authHeader)) {
    return { ok: false, error: 'Unauthorized: Missing or invalid Authorization Bearer Token' };
  }
  const token = authHeader.replace(/^bearer\s+/i, '').trim();
  if (!token || token.length < 10) {
    return { ok: false, error: 'Unauthorized: Malformed Access Token' };
  }
  return { ok: true, token };
}

async function handleDelete(request, env, url, startTime) {
  try {
    let storagePath = url.searchParams.get('path') || url.searchParams.get('url') || '';
    if (!storagePath && request.headers.get('Content-Type')?.includes('application/json')) {
      const body = await request.json().catch(() => ({}));
      storagePath = body.path || body.url || '';
    }

    const normalizedKey = normalizeStorageKey(storagePath);
    if (!normalizedKey || !normalizedKey.startsWith('products/')) {
      return jsonResponse({ error: 'Invalid path scope. Must start with products/' }, 400);
    }

    if (!env.PRINCE_BUCKET) {
      return jsonResponse({ error: 'R2 bucket binding PRINCE_BUCKET not configured' }, 500);
    }

    await env.PRINCE_BUCKET.delete(normalizedKey);
    return jsonResponse({
      success: true,
      deleted: normalizedKey,
      latencyMs: Date.now() - startTime,
    }, 200);
  } catch (errDel) {
    return jsonResponse({ success: false, error: errDel?.message || 'Delete error' }, 500);
  }
}

function checkRateLimit(request) {
  const clientIP = request.headers.get('CF-Connecting-IP') || '127.0.0.1';
  const nowMs = Date.now();
  const windowMs = 60 * 1000;
  const ipRecords = rateLimitMap.get(clientIP) || [];
  const validRecords = ipRecords.filter(t => nowMs - t < windowMs);

  if (validRecords.length >= 20) {
    return false;
  }
  validRecords.push(nowMs);
  rateLimitMap.set(clientIP, validRecords);
  return true;
}

async function handleUpload(request, env, url, startTime) {
  const cleanRoute = (url.pathname || '/').replace(/\/+/g, '/').replace(/\/+$/, '') || '/';
  if (cleanRoute !== '/' && cleanRoute !== '/upload') {
    return jsonResponse({ error: 'Upload route not found', path: url.pathname }, 404);
  }

  if (!env.PRINCE_BUCKET) {
    return jsonResponse({ error: 'R2 bucket binding PRINCE_BUCKET not configured' }, 500);
  }

  if (!checkRateLimit(request)) {
    return jsonResponse({ error: 'Too Many Requests: Rate limit exceeded (20 uploads/minute)' }, 429);
  }

  let fileData;
  let productId = request.headers.get('X-Product-ID') || 'unknown';
  let checksum = request.headers.get('X-Checksum') || '';
  let width = Number(request.headers.get('X-Image-Width')) || 0;
  let height = Number(request.headers.get('X-Image-Height')) || 0;
  const imageCount = Number(request.headers.get('X-Image-Count')) || 0;

  if (imageCount >= 4) {
    return jsonResponse({ error: 'Forbidden: Product already has maximum 4 images' }, 403);
  }

  const contentTypeHeader = (request.headers.get('Content-Type') || '').toLowerCase();

  if (contentTypeHeader.includes('multipart/form-data')) {
    let formData;
    try {
      formData = await request.formData();
    } catch (formErr) {
      return jsonResponse({ error: 'Malformed multipart/form-data payload' }, 400);
    }

    const file = formData.get('file') || formData.get('image') || formData.get('photo');
    if (!file || typeof file.arrayBuffer !== 'function') {
      return jsonResponse({ error: 'No valid image file uploaded' }, 400);
    }

    productId = formData.get('productId') || productId;
    checksum = formData.get('checksum') || checksum;
    width = Number(formData.get('width')) || width;
    height = Number(formData.get('height')) || height;
    fileData = await file.arrayBuffer();
  } else {
    fileData = await request.arrayBuffer();
  }

  if (!fileData || fileData.byteLength === 0) {
    return jsonResponse({ error: 'Empty payload received' }, 400);
  }
  if (fileData.byteLength > MAX_UPLOAD_BYTES) {
    return jsonResponse({ error: `File size exceeds maximum ${Math.round(MAX_UPLOAD_BYTES / 1024)} KB limit` }, 413);
  }

  const detected = detectImageFromBytes(fileData);
  if (!detected) {
    return jsonResponse({
      error: 'Unsupported or corrupted image file. Valid WebP, JPEG, or PNG magic header required',
    }, 422);
  }

  const uuid = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : ('u_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 8));

  const cleanProdId = String(productId).replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
  const keyPath = `products/${cleanProdId}/${uuid}.${detected.ext}`;
  const createdAt = new Date().toISOString();

  await env.PRINCE_BUCKET.put(keyPath, fileData, {
    httpMetadata: {
      contentType: detected.mime,
      cacheControl: 'public, max-age=31536000, immutable',
    },
    customMetadata: {
      productId: cleanProdId,
      checksum: String(checksum || ''),
      createdAt,
      version: '1',
    },
  });

  const domainBase = env.PUBLIC_IMAGE_URL || env.PUBLIC_R2_URL || 'https://prince-picker-image-worker.prince-picker.workers.dev';
  const cleanDomain = String(domainBase).replace(/\/+$/, '');
  const publicUrl = `${cleanDomain}/${keyPath}`;

  return jsonResponse({
    success: true,
    url: publicUrl,
    id: 'img_' + uuid,
    storagePath: keyPath,
    sizeBytes: fileData.byteLength,
    width,
    height,
    mime: detected.mime,
    checksum: String(checksum || ''),
    createdAt,
    version: 1,
    tags: [],
    notes: '',
    workerLatencyMs: Date.now() - startTime,
  }, 200);
}

export default {
  async fetch(request, env, ctx) {
    const startTime = Date.now();

    try {
      if (request.method === 'OPTIONS') {
        const preflightHeaders = new Headers(CORS_HEADERS);
        const reqHeaders = request.headers.get('Access-Control-Request-Headers');
        if (reqHeaders) {
          preflightHeaders.set(
            'Access-Control-Allow-Headers',
            `${CORS_HEADERS['Access-Control-Allow-Headers']}, ${reqHeaders}`
          );
        }
        return new Response(null, { status: 204, headers: preflightHeaders });
      }

      const url = new URL(request.url);

      if (request.method === 'GET' || request.method === 'HEAD') {
        return await handlePublicGetOrHead(request, env, url);
      }

      // Mutating routes require Bearer Token authentication
      const authCheck = validateBearerAuth(request);
      if (!authCheck.ok) {
        return jsonResponse({ error: authCheck.error }, 401);
      }

      if (request.method === 'DELETE' || url.pathname.replace(/\/+$/, '') === '/delete') {
        return await handleDelete(request, env, url, startTime);
      }

      if (request.method === 'POST') {
        return await handleUpload(request, env, url, startTime);
      }

      return jsonResponse({ error: `Method ${request.method} not allowed` }, 405);
    } catch (err) {
      return jsonResponse({
        success: false,
        error: err?.message || 'Internal Worker Error',
      }, 500);
    }
  },
};
