/**
 * Automated Verification Suite: Cloudflare Image Handler, Frontend Resilience & SW Cache Guardrails
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log('======================================================================');
console.log('CLOUDFLARE IMAGE HANDLER & OFFLINE RESILIENCE — VERIFICATION SUITE');
console.log('======================================================================\n');

let total = 0;
let passed = 0;

function test(name, fn) {
  total++;
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

async function asyncTest(name, fn) {
  total++;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

(async function main() {
  const PROD_BASE = 'https://prince-picker-image-worker.prince-picker.workers.dev';
  const PUBLIC_R2_BASE = 'https://pub-f1e8b42c57c64598b4251559ff578b2e.r2.dev';
  const workerMod = await import('../workers/image_upload_worker.js');
  const worker = workerMod.default;
  const config = require('../app/supabase/config.js');
  const uploader = require('../app/supabase/image_uploader.js');

  const webpBytes = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
    0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20
  ]);
  const jpegBytes = new Uint8Array([
    0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46,
    0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0xFF, 0xD9
  ]);
  const pngBytes = new Uint8Array([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
    0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52
  ]);

  const bucketMap = new Map();
  let simulateR2Failure = false;
  const mockBucket = {
    async get(key) {
      if (simulateR2Failure) throw new Error('Simulated R2 outage');
      if (!bucketMap.has(key)) return null;
      const entry = bucketMap.get(key);
      return {
        body: entry.bytes,
        size: entry.bytes.byteLength,
        httpEtag: 'etag_abc',
        uploaded: new Date('2026-11-26T00:00:00Z'),
        httpMetadata: { contentType: entry.contentType },
      };
    },
    async put(key, value, opts = {}) {
      if (simulateR2Failure) throw new Error('Simulated R2 write failure');
      const u8 = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value);
      bucketMap.set(key, {
        bytes: u8,
        contentType: opts.httpMetadata?.contentType,
      });
      return { key };
    },
    async delete(key) {
      bucketMap.delete(key);
      return true;
    },
  };

  const mockEnv = {
    PRINCE_BUCKET: mockBucket,
    PUBLIC_IMAGE_URL: PROD_BASE,
  };

  console.log('1. Worker URL Resolution, CORS & Error Handling');

  await asyncTest('OPTIONS preflight returns 204 with Capacitor/Web CORS headers', async () => {
    const req = new Request(`${PROD_BASE}/upload`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'capacitor://localhost',
        'Access-Control-Request-Headers': 'Authorization, X-Custom-WebView-Header',
      },
    });
    const res = await worker.fetch(req, mockEnv, {});
    assert.strictEqual(res.status, 204);
    assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), '*');
    assert.ok(res.headers.get('Access-Control-Allow-Methods').includes('GET'));
    assert.ok(res.headers.get('Access-Control-Allow-Methods').includes('POST'));
    assert.ok(res.headers.get('Access-Control-Allow-Headers').includes('X-Custom-WebView-Header'));
    assert.strictEqual(res.headers.get('Cross-Origin-Resource-Policy'), 'cross-origin');
  });

  await asyncTest('Duplicate slashes in GET path normalize cleanly to R2 key (200)', async () => {
    await mockBucket.put('products/SKU-1/test.webp', webpBytes, { httpMetadata: { contentType: 'image/webp' } });
    const req = new Request(`${PROD_BASE}//products///SKU-1//test.webp`, { method: 'GET' });
    const res = await worker.fetch(req, mockEnv, {});
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('Content-Type'), 'image/webp');
    assert.strictEqual(res.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  });

  await asyncTest('/cdn-cgi/image/... transformation route resolves R2 key cleanly without 403/404', async () => {
    const req = new Request(`${PROD_BASE}/cdn-cgi/image/width=400,quality=80/products/SKU-1/test.webp`, { method: 'GET' });
    const res = await worker.fetch(req, mockEnv, {});
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('Content-Type'), 'image/webp');
  });

  await asyncTest('Legacy R2 object stored as application/octet-stream serves accurate image MIME from extension', async () => {
    await mockBucket.put('products/SKU-1/photo.jpg', jpegBytes, { httpMetadata: { contentType: 'application/octet-stream' } });
    const req = new Request(`${PROD_BASE}/products/SKU-1/photo.jpg`, { method: 'GET' });
    const res = await worker.fetch(req, mockEnv, {});
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('Content-Type'), 'image/jpeg');
  });

  await asyncTest('Unknown GET route returns 404 JSON instead of 401', async () => {
    const req = new Request(`${PROD_BASE}/unknown-route`, { method: 'GET' });
    const res = await worker.fetch(req, mockEnv, {});
    assert.strictEqual(res.status, 404);
    assert.ok(res.headers.get('Content-Type').includes('application/json'));
  });

  await asyncTest('Path traversal attempt returns 404 JSON', async () => {
    const req = new Request(`${PROD_BASE}/products/../secret.txt`, { method: 'GET' });
    const res = await worker.fetch(req, mockEnv, {});
    assert.strictEqual(res.status, 404);
  });

  await asyncTest('R2 backend exception returns clean 500 JSON instead of HTML error page', async () => {
    simulateR2Failure = true;
    const req = new Request(`${PROD_BASE}/products/SKU-1/test.webp`, { method: 'GET' });
    const res = await worker.fetch(req, mockEnv, {});
    simulateR2Failure = false;
    assert.strictEqual(res.status, 500);
    const body = await res.json();
    assert.strictEqual(body.success, false);
    assert.ok(body.error.includes('Simulated R2 outage'));
  });

  console.log('\n2. Worker Upload Binary Buffer & MIME Integrity (WebP / JPEG / PNG)');

  await asyncTest('Multipart JPEG upload with octet-stream fallback preserves exact binary and sets image/jpeg', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([jpegBytes], { type: 'application/octet-stream' }), 'camera.bin');
    fd.append('productId', 'SKU-JPEG-1');

    const req = new Request(`${PROD_BASE}/upload`, {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token-12345' },
      body: fd,
    });
    const res = await worker.fetch(req, mockEnv, {});
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.mime, 'image/jpeg');
    assert.ok(body.storagePath.endsWith('.jpg'));
    const stored = bucketMap.get(body.storagePath);
    assert.strictEqual(stored.contentType, 'image/jpeg');
    assert.deepStrictEqual(Array.from(stored.bytes), Array.from(jpegBytes));
  });

  await asyncTest('Multipart PNG upload preserves exact binary and sets image/png', async () => {
    const fd = new FormData();
    fd.append('file', new Blob([pngBytes], { type: 'image/png' }), 'part.png');
    fd.append('productId', 'SKU-PNG-1');

    const req = new Request(`${PROD_BASE}/upload`, {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token-12345' },
      body: fd,
    });
    const res = await worker.fetch(req, mockEnv, {});
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.mime, 'image/png');
    assert.ok(body.storagePath.endsWith('.png'));
    const stored = bucketMap.get(body.storagePath);
    assert.strictEqual(stored.contentType, 'image/png');
    assert.deepStrictEqual(Array.from(stored.bytes), Array.from(pngBytes));
  });

  await asyncTest('Corrupted non-image upload returns 422 JSON', async () => {
    const req = new Request(`${PROD_BASE}/upload`, {
      method: 'POST',
      headers: { Authorization: 'Bearer valid-token-12345' },
      body: new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05]),
    });
    const res = await worker.fetch(req, mockEnv, {});
    assert.strictEqual(res.status, 422);
    const body = await res.json();
    assert.ok(body.error);
  });

  console.log('\n3. Frontend URL Normalization & Uploader Integration');

  test('resolveImageUrl normalizes duplicate slashes, unwraps /cdn-cgi/image/..., & maps to public R2 URL', () => {
    assert.strictEqual(
      config.resolveImageUrl(`${PUBLIC_R2_BASE}//products///ABC//1.webp`),
      `${PUBLIC_R2_BASE}/products/ABC/1.webp`
    );
    assert.strictEqual(
      config.resolveImageUrl(`${PROD_BASE}//products///ABC//1.webp`),
      `${PUBLIC_R2_BASE}/products/ABC/1.webp`
    );
    assert.strictEqual(
      config.resolveImageUrl('/cdn-cgi/image/width=300/products/ABC/1.jpg'),
      `${PUBLIC_R2_BASE}/products/ABC/1.jpg`
    );
    assert.strictEqual(
      config.resolveImageUrl(`https://princepicker.mudasirkhan.in/cdn-cgi/image/w=400/${PROD_BASE}/products/ABC/1.png`),
      `${PUBLIC_R2_BASE}/products/ABC/1.png`
    );
    assert.strictEqual(
      config.resolveImageUrl('https://pub-091b1d2070306c80f830d33d243cf4f0.r2.dev//products//ABC/1.webp?v=2'),
      `${PUBLIC_R2_BASE}/products/ABC/1.webp?v=2`
    );
    assert.strictEqual(
      config.resolveImageUrl('./picker-logo.png'),
      './picker-logo.png'
    );
  });

  await asyncTest('uploadSingleImage with skipQueue:true avoids duplicate sync_queue entries', async () => {
    const queuedCalls = [];
    global.PICKER_DB = {
      async addSyncQueue(type, payload) {
        queuedCalls.push({ type, payload });
        return 1;
      },
    };
    const prevNav = global.navigator;
    Object.defineProperty(global, 'navigator', { value: { onLine: false }, configurable: true });

    const dataUrl = 'data:image/jpeg;base64,' + Buffer.from(jpegBytes).toString('base64');
    const res = await uploader.uploadSingleImage(dataUrl, 'PROD-SKIP-Q', { skipQueue: true });

    Object.defineProperty(global, 'navigator', { value: prevNav, configurable: true });
    delete global.PICKER_DB;

    assert.strictEqual(res.queued, true);
    assert.strictEqual(queuedCalls.length, 0);
  });

  await asyncTest('uploadSingleImage offline queueing calls PICKER_DB.addSyncQueue with (type, payload)', async () => {
    const queuedCalls = [];
    global.PICKER_DB = {
      async addSyncQueue(type, payload) {
        queuedCalls.push({ type, payload });
        return 1;
      },
    };
    const prevNav = global.navigator;
    Object.defineProperty(global, 'navigator', { value: { onLine: false }, configurable: true });

    const dataUrl = 'data:image/jpeg;base64,' + Buffer.from(jpegBytes).toString('base64');
    const res = await uploader.uploadSingleImage(dataUrl, 'PROD-OFFLINE');

    Object.defineProperty(global, 'navigator', { value: prevNav, configurable: true });
    delete global.PICKER_DB;

    assert.strictEqual(res.queued, true);
    assert.strictEqual(res.mime, 'image/jpeg');
    assert.strictEqual(queuedCalls.length, 1);
    assert.strictEqual(queuedCalls[0].type, 'upload_image');
    assert.strictEqual(queuedCalls[0].payload.productId, 'PROD-OFFLINE');
    assert.strictEqual(queuedCalls[0].payload.mime, 'image/jpeg');
  });

  console.log('\n4. Service Worker Image Caching & Offline Guardrails');

  const swCode = fs.readFileSync(path.join(__dirname, '../app/sw.js'), 'utf8');
  const swCacheStore = new Map();
  const swListeners = {};
  let mockFetchImpl = async () => new Response('', { status: 404 });
  let mockOnline = true;

  const mockCachesApi = {
    async open(name) {
      if (!swCacheStore.has(name)) swCacheStore.set(name, new Map());
      const store = swCacheStore.get(name);
      return {
        async match(req, opts = {}) {
          const url = typeof req === 'string' ? req : req.url;
          const clean = opts.ignoreSearch ? url.split('?')[0] : url;
          for (const [k, v] of store.entries()) {
            const cmp = opts.ignoreSearch ? k.split('?')[0] : k;
            if (cmp === clean) return v.clone();
          }
          return undefined;
        },
        async put(req, res) {
          const url = typeof req === 'string' ? req : req.url;
          store.set(url, res.clone());
        },
        async delete(req, opts = {}) {
          const url = typeof req === 'string' ? req : req.url;
          const clean = opts.ignoreSearch ? url.split('?')[0] : url;
          for (const k of Array.from(store.keys())) {
            const cmp = opts.ignoreSearch ? k.split('?')[0] : k;
            if (cmp === clean) store.delete(k);
          }
          return true;
        },
      };
    },
    async keys() { return Array.from(swCacheStore.keys()); },
    async match(req) {
      for (const name of swCacheStore.keys()) {
        const c = await mockCachesApi.open(name);
        const m = await c.match(req);
        if (m) return m;
      }
      return undefined;
    },
  };

  const swSelf = {
    location: { origin: 'https://princepicker.mudasirkhan.in' },
    navigator: { get onLine() { return mockOnline; } },
    addEventListener(type, fn) { swListeners[type] = fn; },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  const swContext = {
    self: swSelf,
    location: swSelf.location,
    caches: mockCachesApi,
    Request,
    Response,
    URL,
    fetch: (...args) => mockFetchImpl(...args),
    console,
    addEventListener: swSelf.addEventListener,
    skipWaiting: swSelf.skipWaiting,
  };
  vm.runInNewContext(swCode, swContext);

  function dispatchSwFetch(url, destination = 'image') {
    let responsePromise;
    swListeners.fetch({
      request: { url, method: 'GET', destination, mode: 'no-cors', cache: 'default' },
      respondWith(p) { responsePromise = p; },
    });
    return responsePromise;
  }

  await asyncTest('SW caches valid 200 image responses from Cloudflare Worker', async () => {
    mockOnline = true;
    mockFetchImpl = async () => new Response(webpBytes, { status: 200, headers: { 'Content-Type': 'image/webp' } });
    const imgUrl = `${PROD_BASE}/products/SW-1/good.webp`;
    const res = await dispatchSwFetch(imgUrl);
    assert.strictEqual(res.status, 200);
    const imgCache = swCacheStore.get('prince-picker-images-v1');
    assert.ok(imgCache && imgCache.has(imgUrl));
  });

  await asyncTest('SW NEVER caches 404, 500, or HTML responses', async () => {
    mockOnline = true;
    const url404 = `${PROD_BASE}/products/SW-1/missing.webp`;
    mockFetchImpl = async () => new Response(JSON.stringify({ error: 'Image not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    const r404 = await dispatchSwFetch(url404);
    assert.strictEqual(r404.status, 404);
    assert.strictEqual(swCacheStore.get('prince-picker-images-v1').has(url404), false);

    const url500 = `${PROD_BASE}/products/SW-1/err.webp`;
    mockFetchImpl = async () => new Response('Server error', { status: 500, headers: { 'Content-Type': 'text/plain' } });
    const r500 = await dispatchSwFetch(url500);
    assert.strictEqual(r500.status, 500);
    assert.strictEqual(swCacheStore.get('prince-picker-images-v1').has(url500), false);

    const urlHtml = 'https://princepicker.mudasirkhan.in/app/fake.webp';
    mockFetchImpl = async () => new Response('<html>not an image</html>', { status: 200, headers: { 'Content-Type': 'text/html' } });
    const rHtml = await dispatchSwFetch(urlHtml);
    assert.strictEqual(rHtml.status, 200);
    assert.strictEqual(swCacheStore.get('prince-picker-images-v1').has(urlHtml), false);
  });

  await asyncTest('SW immediately serves inline SVG fallback when offline and uncached (never stalls or caches placeholder)', async () => {
    mockOnline = false;
    let networkCalled = false;
    mockFetchImpl = async () => { networkCalled = true; throw new Error('Should not wait on network'); };
    const offlineUrl = `${PROD_BASE}/products/SW-1/uncached.webp`;
    const res = await dispatchSwFetch(offlineUrl);
    assert.strictEqual(networkCalled, false);
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers.get('Content-Type').includes('image/svg+xml'));
    assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), '*');
    assert.strictEqual(res.headers.get('Cross-Origin-Resource-Policy'), 'cross-origin');
    assert.strictEqual(res.headers.get('X-Offline-Fallback'), '1');
    assert.strictEqual(swCacheStore.get('prince-picker-images-v1').has(offlineUrl), false);
  });

  await asyncTest('SW passes through public R2 image URLs without forcing CORS mode and serves SVG offline', async () => {
    mockOnline = true;
    let passedRequestMode = null;
    mockFetchImpl = async (req) => {
      passedRequestMode = req.mode;
      return new Response(webpBytes, { status: 200, headers: { 'Content-Type': 'image/webp' } });
    };
    const r2Url = `${PUBLIC_R2_BASE}/products/SW-R2/item.webp`;
    const onlineRes = await dispatchSwFetch(r2Url);
    assert.strictEqual(onlineRes.status, 200);
    assert.strictEqual(passedRequestMode, 'no-cors');

    mockOnline = false;
    const offlineRes = await dispatchSwFetch(`${PUBLIC_R2_BASE}/products/SW-R2/offline.webp`);
    assert.strictEqual(offlineRes.status, 200);
    assert.ok(offlineRes.headers.get('Content-Type').includes('image/svg+xml'));
  });

  console.log('\n5. app/index.html Inline Script Syntax & Error Loop Guards');

  const html = fs.readFileSync(path.join(__dirname, '../app/index.html'), 'utf8');
  test('All inline <script> blocks in app/index.html parse cleanly', () => {
    const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)]
      .filter(m => !/\bsrc=/i.test(m[1]) && !/application\/ld\+json/i.test(m[1]));
    assert.strictEqual(scripts.length, 2);
    scripts.forEach((m, i) => new vm.Script(m[2], { filename: `inline-script-${i}.js` }));
  });

  test('handleProductImgError clears onerror=null before fallback and prevents infinite retry loops', () => {
    assert.ok(html.includes('function handleProductImgError(imgEl'));
    assert.ok(html.includes('imgEl.onerror = null;'));
    assert.ok(html.includes('PRODUCT_PLACEHOLDER_SVG'));
    assert.strictEqual(html.includes("onerror=\"this.style.opacity='0.3'\""), false);

    // Execute extracted handleProductImgError in isolated VM
    const fnStart = html.indexOf('const PRODUCT_PLACEHOLDER_SVG =');
    const fnEnd = html.indexOf('function formatImageUrl(url)');
    assert.ok(fnStart !== -1 && fnEnd > fnStart);
    const snippet = html.slice(fnStart, fnEnd);

    const children = [];
    let currentDisplay = '';
    const fakeParent = {
      classList: { contains: () => false },
      querySelector: () => children.find(c => c.className === 'img-fallback-placeholder') || null,
      appendChild: el => children.push(el),
    };
    const fakeDoc = {
      createElement: () => ({ className: '', innerHTML: '' }),
    };
    const ctx = { document: fakeDoc };
    vm.runInNewContext(snippet, ctx);

    let errClearedFirst = false;
    const fakeImg = {
      _src: 'https://prince-picker-image-worker.prince-picker.workers.dev/products/X/bad.webp',
      get src() { return this._src; },
      set src(v) { this._src = v; },
      _onerror: () => {},
      get onerror() { return this._onerror; },
      set onerror(v) {
        if (v === null) errClearedFirst = true;
        this._onerror = v;
      },
      dataset: {},
      style: { get display() { return currentDisplay; }, set display(v) { currentDisplay = v; } },
      parentElement: fakeParent,
    };

    ctx.handleProductImgError(fakeImg);
    assert.strictEqual(errClearedFirst, true);
    assert.strictEqual(fakeImg.onerror, null);
    assert.strictEqual(currentDisplay, 'none');
    assert.strictEqual(children.length, 1);
    assert.strictEqual(children[0].className, 'img-fallback-placeholder');
    assert.ok(children[0].innerHTML.includes('<svg'));

    // Calling a second time must be idempotent without appending duplicate placeholders or resetting onerror
    ctx.handleProductImgError(fakeImg);
    assert.strictEqual(children.length, 1);

    // Secondary fallback URL that ALSO fails must fall back cleanly to placeholder with zero loop
    const fbChildren = [];
    let fbDisplay = '';
    const fbParent = {
      classList: { contains: () => false },
      querySelector: () => fbChildren.find(c => c.className === 'img-fallback-placeholder') || null,
      appendChild: el => fbChildren.push(el),
    };
    const fbCtx = { document: { createElement: () => ({ className: '', innerHTML: '' }) } };
    vm.runInNewContext(snippet, fbCtx);
    const fbImg = {
      src: `${PROD_BASE}/products/X/primary-404.webp`,
      onerror: () => {},
      dataset: { fallbackSrc: `${PROD_BASE}/products/X/secondary-404.webp` },
      style: { get display() { return fbDisplay; }, set display(v) { fbDisplay = v; } },
      parentElement: fbParent,
    };
    fbCtx.handleProductImgError(fbImg);
    assert.strictEqual(fbImg.src, `${PROD_BASE}/products/X/secondary-404.webp`);
    assert.strictEqual(fbImg.dataset.fallbackTried, '1');
    assert.strictEqual(typeof fbImg.onerror, 'function');
    // Simulate secondary failure firing once
    fbImg.onerror();
    assert.strictEqual(fbImg.onerror, null);
    assert.strictEqual(fbDisplay, 'none');
    assert.strictEqual(fbChildren.length, 1);
    assert.strictEqual(fbChildren[0].className, 'img-fallback-placeholder');
  });

  test('Image previews layer above bottom nav, scroll horizontally, omit crossorigin, and open multi-image slots', () => {
    const pdmModalMatch = html.match(/id="prodDetailModal"[^>]*z-index\s*:\s*(\d+)/i);
    assert.ok(pdmModalMatch && Number(pdmModalMatch[1]) > 900, 'prodDetailModal must layer above .bn (900)');
    const qrModalMatch = html.match(/id="qrPreviewModal"[\s\S]{0,120}z-index\s*:\s*(\d+)/i);
    assert.ok(qrModalMatch && Number(qrModalMatch[1]) > 900, 'qrPreviewModal must layer above .bn (900)');
    const fsViewerBlock = html.slice(html.indexOf('.pdm-fullscreen-viewer {'), html.indexOf('.pdm-fullscreen-viewer {') + 300);
    const fsZMatch = fsViewerBlock.match(/z-index\s*:\s*(\d+)/i);
    assert.ok(fsZMatch && Number(fsZMatch[1]) >= 1000, 'pdm-fullscreen-viewer must layer above modals');
    const gridBlock = html.slice(html.indexOf('.pdm-image-grid {'), html.indexOf('.pdm-image-grid {') + 400);
    assert.ok(/overflow-x\s*:\s*auto/i.test(gridBlock), '.pdm-image-grid must allow horizontal scroll');
    assert.strictEqual(/<img\b[^>]*crossorigin=["']anonymous["']/i.test(html), false, 'display <img> tags must not force crossorigin="anonymous"');
    assert.ok(html.includes('onclick="previewApImageSlot(${i})"'), 'renderMultiImageGrid must wire previewApImageSlot');
    assert.ok(html.includes('function previewApImageSlot(idx)'), 'previewApImageSlot helper must exist');
  });

  console.log('\n======================================================================');
  console.log(`VERIFICATION RESULTS: ${passed}/${total} PASSED`);
  console.log('======================================================================');
  if (passed !== total) process.exit(1);
})();
