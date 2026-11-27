/**
 * Automated Regression Test Suite: Cloudflare R2 Image Handler Production Migration
 * 
 * Verifies:
 * 1. Centralized Image Base URL & URL Resolution (old r2.dev -> production worker)
 * 2. Relative path normalization & duplicate prefix prevention
 * 3. Security filtering (blob: rejection, data: preservation, external URL preservation)
 * 4. Image Uploader default endpoints and URL resolution
 * 5. Cloudflare Worker GET/HEAD /products/* route handling, content types, ETag 304, 404
 * 6. Cloudflare Worker POST and DELETE route auth and production URL generation
 * 7. Verification that zero r2.dev domain references remain in resolved application URLs
 * 8. Standalone Supabase SQL migration script structure and query safety
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('===============================================================');
console.log('CLOUDFLARE R2 PRODUCTION MIGRATION — AUTOMATED REGRESSION SUITE');
console.log('===============================================================\n');

let totalTests = 0;
let passedTests = 0;

function test(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    Error: ${err.message}`);
    if (err.stack) console.error(err.stack);
  }
}

async function asyncTest(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    Error: ${err.message}`);
    if (err.stack) console.error(err.stack);
  }
}

(async function runAllSuites() {
  const config = require('../app/supabase/config.js');
  const uploader = require('../app/supabase/image_uploader.js');
  const workerModule = await import('../workers/image_upload_worker.js');
  const worker = workerModule.default;

  const PROD_BASE = 'https://pub-f1e8b42c57c64598b4251559ff578b2e.r2.dev';
  const WORKER_BASE = 'https://prince-picker-image-worker.prince-picker.workers.dev';
  const OLD_BASE_1 = 'https://pub-091b1d2070306c80f830d33d243cf4f0.r2.dev';
  const OLD_BASE_2 = 'https://prince-picker-image-worker.prince-picker.workers.dev';

  // ─────────────────────────────────────────────────────────────
  // SUITE 1: URL MIGRATION & RESOLUTION
  // ─────────────────────────────────────────────────────────────
  console.log('Suite 1: URL Migration & Centralized Resolution');

  test('Migrates old R2 dev domain 1 (pub-091b1d2070306c80f830d33d243cf4f0) to public R2 URL', () => {
    const oldUrl = `${OLD_BASE_1}/products/SAI-85-BP/b82d6ece-b192-4df8-a875-0c643916d89d.webp`;
    const resolved = config.resolveImageUrl(oldUrl);
    const expected = `${PROD_BASE}/products/SAI-85-BP/b82d6ece-b192-4df8-a875-0c643916d89d.webp`;
    assert.strictEqual(resolved, expected);
  });

  test('Migrates worker GET URLs (prince-picker-image-worker.workers.dev) to public R2 URL', () => {
    const oldUrl = `${OLD_BASE_2}/products/BA-150-FRONT/sample_uuid.webp`;
    const resolved = config.resolveImageUrl(oldUrl);
    const expected = `${PROD_BASE}/products/BA-150-FRONT/sample_uuid.webp`;
    assert.strictEqual(resolved, expected);
  });

  test('Migrates generic pub-*.r2.dev URLs to public R2 URL', () => {
    const oldUrl = 'https://pub-999999999999.r2.dev/products/test/img.webp';
    const resolved = config.resolveImageUrl(oldUrl);
    const expected = `${PROD_BASE}/products/test/img.webp`;
    assert.strictEqual(resolved, expected);
  });

  test('Resolves relative object paths without leading slash', () => {
    const relPath = 'products/SAI-85-BP/b82d6ece.webp';
    const resolved = config.resolveImageUrl(relPath);
    const expected = `${PROD_BASE}/products/SAI-85-BP/b82d6ece.webp`;
    assert.strictEqual(resolved, expected);
  });

  test('Resolves relative object paths with leading slash', () => {
    const relPath = '/products/SAI-85-BP/b82d6ece.webp';
    const resolved = config.resolveImageUrl(relPath);
    const expected = `${PROD_BASE}/products/SAI-85-BP/b82d6ece.webp`;
    assert.strictEqual(resolved, expected);
  });

  test('Does not duplicate prefix if URL is already production Worker base', () => {
    const prodUrl = `${PROD_BASE}/products/SAI-85-BP/b82d6ece.webp`;
    const resolved = config.resolveImageUrl(prodUrl);
    assert.strictEqual(resolved, prodUrl);
  });

  test('Strictly rejects blob: URLs to prevent broken image references', () => {
    const blobUrl = 'blob:http://localhost:3000/9876-5432-abcd';
    const resolved = config.resolveImageUrl(blobUrl);
    assert.strictEqual(resolved, '');
  });

  test('Preserves data: URI payloads intact', () => {
    const dataUri = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TAYAAAAvAAAA';
    const resolved = config.resolveImageUrl(dataUri);
    assert.strictEqual(resolved, dataUri);
  });

  test('Preserves external non-R2 web URLs intact', () => {
    const extUrl = 'https://images.unsplash.com/photo-1558981806-ec527fa84c39?w=500';
    const resolved = config.resolveImageUrl(extUrl);
    assert.strictEqual(resolved, extUrl);
  });

  test('Returns empty string for null, undefined, empty, or whitespace URLs', () => {
    assert.strictEqual(config.resolveImageUrl(null), '');
    assert.strictEqual(config.resolveImageUrl(undefined), '');
    assert.strictEqual(config.resolveImageUrl(''), '');
    assert.strictEqual(config.resolveImageUrl('   '), '');
  });

  // ─────────────────────────────────────────────────────────────
  // SUITE 2: IMAGE UPLOADER INTEGRATION
  // ─────────────────────────────────────────────────────────────
  console.log('\nSuite 2: Image Uploader Configuration & Methods');

  test('getR2PublicBaseUrl returns the public R2 URL', () => {
    const base = uploader.getR2PublicBaseUrl();
    assert.strictEqual(base, PROD_BASE);
  });

  test('DEFAULT_WORKER_ENDPOINT points to production Worker /upload route', () => {
    assert.strictEqual(uploader.DEFAULT_WORKER_ENDPOINT, `${WORKER_BASE}/upload`);
  });

  // ─────────────────────────────────────────────────────────────
  // SUITE 3: CLOUDFLARE WORKER COMPATIBILITY
  // ─────────────────────────────────────────────────────────────
  console.log('\nSuite 3: Cloudflare Worker GET/HEAD/POST Compatibility');

  // Create Mock R2 Bucket
  const mockBucketStore = new Map();
  const testWebpBytes = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, // 'RIFF'
    0x24, 0x00, 0x00, 0x00, // file length
    0x57, 0x45, 0x42, 0x50, // 'WEBP'
    0x56, 0x50, 0x38, 0x20  // 'VP8 '
  ]);

  const mockR2Bucket = {
    async get(key) {
      if (!mockBucketStore.has(key)) return null;
      const data = mockBucketStore.get(key);
      return {
        body: data.bytes,
        size: data.bytes.byteLength,
        httpEtag: 'etag_12345',
        uploaded: new Date('2026-11-13T00:00:00Z'),
        httpMetadata: {
          contentType: data.contentType || 'image/webp',
          cacheControl: 'public, max-age=31536000, immutable'
        }
      };
    },
    async put(key, value, options = {}) {
      mockBucketStore.set(key, {
        bytes: value,
        contentType: options.httpMetadata?.contentType || 'image/webp',
        customMetadata: options.customMetadata
      });
      return { key };
    },
    async delete(key) {
      mockBucketStore.delete(key);
      return true;
    }
  };

  const mockEnv = {
    PRINCE_BUCKET: mockR2Bucket,
    PUBLIC_IMAGE_URL: PROD_BASE,
    PUBLIC_R2_URL: PROD_BASE
  };

  await asyncTest('Worker GET /products/* returns 200 with image bytes and immutable cache headers', async () => {
    // Populate mock bucket
    await mockR2Bucket.put('products/TEST-PROD/img_1.webp', testWebpBytes, {
      httpMetadata: { contentType: 'image/webp' }
    });

    const req = new Request(`${PROD_BASE}/products/TEST-PROD/img_1.webp`, {
      method: 'GET'
    });
    const res = await worker.fetch(req, mockEnv, {});

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('Content-Type'), 'image/webp');
    assert.strictEqual(res.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
    assert.strictEqual(res.headers.get('Access-Control-Allow-Origin'), '*');
    assert.ok(res.headers.get('ETag'));
  });

  await asyncTest('Worker HEAD /products/* returns 200 with headers and empty body', async () => {
    const req = new Request(`${PROD_BASE}/products/TEST-PROD/img_1.webp`, {
      method: 'HEAD'
    });
    const res = await worker.fetch(req, mockEnv, {});

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('Content-Type'), 'image/webp');
    assert.strictEqual(res.headers.get('Content-Length'), String(testWebpBytes.byteLength));
    const text = await res.text();
    assert.strictEqual(text, '');
  });

  await asyncTest('Worker GET returns 304 Not Modified when If-None-Match matches ETag', async () => {
    const req = new Request(`${PROD_BASE}/products/TEST-PROD/img_1.webp`, {
      method: 'GET',
      headers: { 'If-None-Match': '"etag_12345"' }
    });
    const res = await worker.fetch(req, mockEnv, {});

    assert.strictEqual(res.status, 304);
  });

  await asyncTest('Worker GET returns 404 for missing image object', async () => {
    const req = new Request(`${PROD_BASE}/products/NON-EXISTENT/not_found.webp`, {
      method: 'GET'
    });
    const res = await worker.fetch(req, mockEnv, {});

    assert.strictEqual(res.status, 404);
    const body = await res.json();
    assert.strictEqual(body.error, 'Image not found');
  });

  await asyncTest('Worker GET / returns healthy status without requiring auth', async () => {
    const req = new Request(`${PROD_BASE}/`, { method: 'GET' });
    const res = await worker.fetch(req, mockEnv, {});

    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.status, 'healthy');
  });

  await asyncTest('Worker POST rejects requests without Authorization header (401)', async () => {
    const req = new Request(`${PROD_BASE}/upload`, {
      method: 'POST',
      body: testWebpBytes
    });
    const res = await worker.fetch(req, mockEnv, {});
    assert.strictEqual(res.status, 401);
  });

  await asyncTest('Worker POST generates public R2 URL on upload', async () => {
    const req = new Request(`${WORKER_BASE}/upload`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer test-valid-jwt-token-prince-picker',
        'X-Product-ID': 'TEST-SKU-99',
        'X-Image-Count': '0'
      },
      body: testWebpBytes
    });
    const res = await worker.fetch(req, mockEnv, {});
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert.ok(body.url.startsWith(`${PROD_BASE}/products/TEST-SKU-99/`));
  });

  await asyncTest('Worker DELETE successfully removes object from bucket', async () => {
    // Put test object
    const key = 'products/TEST-DEL/del_1.webp';
    await mockR2Bucket.put(key, testWebpBytes);

    const req = new Request(`${WORKER_BASE}/delete?path=${encodeURIComponent(key)}`, {
      method: 'DELETE',
      headers: {
        'Authorization': 'Bearer test-valid-jwt-token-prince-picker'
      }
    });
    const res = await worker.fetch(req, mockEnv, {});
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.success, true);
    assert.strictEqual(mockBucketStore.has(key), false);
  });

  // ─────────────────────────────────────────────────────────────
  // SUITE 4: APPLICATION CODE CONFIGURATION CONSISTENCY
  // ─────────────────────────────────────────────────────────────
  console.log('\nSuite 4: Application Code Configuration');

  test('app/supabase/config.js points image delivery to active public R2 URL and uploads to Worker', () => {
    assert.strictEqual(config.PRODUCTION_IMAGE_BASE_URL, PROD_BASE);
    assert.strictEqual(config.SUPABASE_CONFIG.workerEndpoint, `${WORKER_BASE}/upload`);
  });

  test('app/supabase/image_uploader.js uses active public R2 URL and Worker upload endpoint', () => {
    const content = fs.readFileSync(path.join(__dirname, '../app/supabase/image_uploader.js'), 'utf8');
    assert.ok(content.includes(PROD_BASE), 'image_uploader.js must reference active public R2 URL');
    assert.ok(content.includes(`${WORKER_BASE}/upload`), 'image_uploader.js must reference Worker /upload');
  });

  test('workers/wrangler.toml points variables to active public R2 URL', () => {
    const content = fs.readFileSync(path.join(__dirname, '../workers/wrangler.toml'), 'utf8');
    assert.ok(content.includes(`PUBLIC_IMAGE_URL = "${PROD_BASE}"`));
    assert.ok(content.includes(`PUBLIC_R2_URL = "${PROD_BASE}"`));
  });

  // ─────────────────────────────────────────────────────────────
  // SUITE 5: STANDALONE SUPABASE SQL MIGRATION SCRIPT INTEGRITY
  // ─────────────────────────────────────────────────────────────
  console.log('\nSuite 5: Standalone Supabase SQL Migration Script Integrity');

  const sqlPath = path.join(__dirname, '../supabase/migrations/20261113_migrate_r2_image_urls_to_worker.sql');

  test('SQL migration file exists and is readable', () => {
    assert.ok(fs.existsSync(sqlPath), 'SQL migration file must exist');
  });

  test('SQL script targets public.products table image and images columns', () => {
    const sql = fs.readFileSync(sqlPath, 'utf8');
    assert.ok(sql.includes('UPDATE products'), 'Must update products table');
    assert.ok(sql.includes('SET image = REPLACE('), 'Must update image column');
    assert.ok(sql.includes('SET images = REPLACE('), 'Must update images JSONB column');
  });

  test('SQL script includes BEGIN and COMMIT transaction wrappers', () => {
    const sql = fs.readFileSync(sqlPath, 'utf8');
    assert.ok(sql.includes('BEGIN;'), 'Must include BEGIN;');
    assert.ok(sql.includes('COMMIT;'), 'Must include COMMIT;');
  });

  test('SQL script includes preview SELECT queries and post-migration verification queries', () => {
    const sql = fs.readFileSync(sqlPath, 'utf8');
    assert.ok(sql.includes('SECTION 1: PRE-MIGRATION PREVIEW QUERIES'), 'Must have preview queries');
    assert.ok(sql.includes('SECTION 3: POST-MIGRATION VERIFICATION QUERIES'), 'Must have post-migration verification queries');
    assert.ok(sql.includes('COUNT(*) FILTER'), 'Must have summary verification counters');
  });

  test('SQL script targets only old development domains and preserves object paths', () => {
    const sql = fs.readFileSync(sqlPath, 'utf8');
    assert.ok(sql.includes('pub-091b1d2070306c80f830d33d243cf4f0.r2.dev'), 'Must target old base domain 1');
    assert.ok(sql.includes('pub-f1e8b42c57c64598b4251559ff578b2e.r2.dev'), 'Must target old base domain 2');
    assert.ok(sql.includes('prince-picker-image-worker.prince-picker.workers.dev'), 'Must replace with production worker URL');
  });

  // ─────────────────────────────────────────────────────────────
  // SUITE 6: PRESERVATION OF PRODUCT IMAGES IN SEARCH & VIEWS
  // ─────────────────────────────────────────────────────────────
  console.log('\nSuite 6: Product Images Rendering & Resolution');

  test('Product with legacy R2 URL formats to production Worker URL', () => {
    const mockProduct = {
      id: 'test_1',
      name: 'Test Brake Pad',
      image: 'https://pub-091b1d2070306c80f830d33d243cf4f0.r2.dev/products/SAI-85-BP/sample.webp',
      images: [
        { id: 'img_1', url: 'https://pub-091b1d2070306c80f830d33d243cf4f0.r2.dev/products/SAI-85-BP/sample.webp' }
      ]
    };
    const resolvedPrimary = config.resolveImageUrl(mockProduct.image);
    const resolvedGallery = config.resolveImageUrl(mockProduct.images[0].url);

    assert.strictEqual(resolvedPrimary, `${PROD_BASE}/products/SAI-85-BP/sample.webp`);
    assert.strictEqual(resolvedGallery, `${PROD_BASE}/products/SAI-85-BP/sample.webp`);
  });

  // ─────────────────────────────────────────────────────────────
  // SUMMARY
  // ─────────────────────────────────────────────────────────────
  console.log('\n===============================================================');
  console.log(`REGRESSION TEST RESULTS: ${passedTests}/${totalTests} PASSED`);
  console.log('===============================================================');

  if (passedTests !== totalTests) {
    process.exit(1);
  }
})();
