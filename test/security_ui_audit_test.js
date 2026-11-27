/**
 * Verification Suite: UI Bugs, Responsive Scaling & Security Hardening Audit
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { pathToFileURL } = require('url');

const ROOT = path.join(__dirname, '..');

let total = 0;
let passed = 0;
const asyncQueue = [];

function test(name, fn) {
  total++;
  const run = async () => fn();
  asyncQueue.push(
    run().then(
      () => {
        console.log(`  ✓ ${name}`);
        passed++;
      },
      (err) => {
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.stack || err.message}`);
        process.exitCode = 1;
      }
    )
  );
}

function makeHs256Jwt(payload, secret) {
  const b64url = (obj) =>
    Buffer.from(JSON.stringify(obj))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const body = b64url(payload);
  const sig = crypto
    .createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${header}.${body}.${sig}`;
}

function createR2Mock() {
  const objects = new Map();
  return {
    objects,
    PRINCE_BUCKET: {
      async put(key, body, opts) {
        objects.set(key, { body: Buffer.from(body), httpMetadata: opts?.httpMetadata || {} });
      },
      async get(key) {
        const entry = objects.get(key);
        if (!entry) return null;
        return {
          body: entry.body,
          httpMetadata: entry.httpMetadata,
          httpEtag: '"mock-etag"'
        };
      },
      async head(key) {
        const entry = objects.get(key);
        if (!entry) return null;
        return { httpMetadata: entry.httpMetadata, httpEtag: '"mock-etag"' };
      },
      async delete(key) {
        objects.delete(key);
      }
    }
  };
}

console.log('======================================================================');
console.log('SECURITY, UI & RESPONSIVE SCALING AUDIT — VERIFICATION SUITE');
console.log('======================================================================\n');

const html = fs.readFileSync(path.join(ROOT, 'app/index.html'), 'utf8');
const productsJs = fs.readFileSync(path.join(ROOT, 'app/supabase/products.js'), 'utf8');
const uploaderJs = fs.readFileSync(path.join(ROOT, 'app/supabase/image_uploader.js'), 'utf8');
const workerJs = fs.readFileSync(path.join(ROOT, 'workers/image_upload_worker.js'), 'utf8');
const swJs = fs.readFileSync(path.join(ROOT, 'app/sw.js'), 'utf8');
const vercelJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const rootMigration = fs.readFileSync(path.join(ROOT, 'supabase/migrations/20261127_security_hardening.sql'), 'utf8');
const appMigration = fs.readFileSync(path.join(ROOT, 'app/supabase/migrations/20261127_security_hardening.sql'), 'utf8');

test('1. Cloudflare worker blocks SVG MIME and hardens GET headers (nosniff + CSP sandbox)', async () => {
  assert(!/svg\s*:\s*['"]image\/svg\+xml['"]/.test(workerJs), 'SVG MIME must not be served inline');
  const mod = await import(pathToFileURL(path.join(ROOT, 'workers/image_upload_worker.js')).href);
  const env = createR2Mock();
  env.objects.set('products/test/hero.jpg', {
    body: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    httpMetadata: { contentType: 'image/jpeg' }
  });
  const res = await mod.default.fetch(new Request('https://worker.example/products/test/hero.jpg'), env);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get('X-Content-Type-Options'), 'nosniff');
  assert((res.headers.get('Content-Security-Policy') || '').includes('sandbox'), 'CSP sandbox missing on image GET');
});

test('2. Cloudflare worker enforces origin allowlist and rejects placeholder Bearer token', async () => {
  const mod = await import(pathToFileURL(path.join(ROOT, 'workers/image_upload_worker.js')).href);
  const env = createR2Mock();

  const badOriginReq = new Request('https://worker.example/upload', {
    method: 'POST',
    headers: {
      Origin: 'https://evil-attacker.example',
      Authorization: 'Bearer valid-token-12345'
    }
  });
  const badOriginRes = await mod.default.fetch(badOriginReq, env);
  assert.strictEqual(badOriginRes.status, 403);

  const placeholderReq = new Request('https://worker.example/upload', {
    method: 'POST',
    headers: {
      Origin: 'https://princepicker.mudasirkhan.in',
      Authorization: 'Bearer anon-jwt-token-prince-picker'
    }
  });
  const placeholderRes = await mod.default.fetch(placeholderReq, env);
  assert.strictEqual(placeholderRes.status, 401);
});

test('3. Cloudflare worker verifies WORKER_AUTH_TOKEN and HS256 SUPABASE_JWT_SECRET when configured', async () => {
  const mod = await import(pathToFileURL(path.join(ROOT, 'workers/image_upload_worker.js')).href);
  const secret = 'test-jwt-secret-for-unit-verification';
  const env = {
    ...createR2Mock(),
    WORKER_AUTH_TOKEN: 'worker-secret-token-xyz',
    SUPABASE_JWT_SECRET: secret
  };

  // Forged JWT fails
  const badRes = await mod.default.fetch(
    new Request('https://worker.example/delete?path=products/abc/1.webp', {
      method: 'DELETE',
      headers: {
        Origin: 'https://princepicker.mudasirkhan.in',
        Authorization: 'Bearer ' + makeHs256Jwt({ role: 'anon', exp: Math.floor(Date.now() / 1000) + 300 }, 'wrong-secret')
      }
    }),
    env
  );
  assert.strictEqual(badRes.status, 401);

  // Expired JWT fails
  const expRes = await mod.default.fetch(
    new Request('https://worker.example/delete?path=products/abc/1.webp', {
      method: 'DELETE',
      headers: {
        Origin: 'https://princepicker.mudasirkhan.in',
        Authorization: 'Bearer ' + makeHs256Jwt({ role: 'anon', exp: Math.floor(Date.now() / 1000) - 60 }, secret)
      }
    }),
    env
  );
  assert.strictEqual(expRes.status, 401);

  // Valid HS256 JWT passes auth and deletes key
  env.objects.set('products/abc/1.webp', { body: Buffer.from('x'), httpMetadata: { contentType: 'image/webp' } });
  const okJwtRes = await mod.default.fetch(
    new Request('https://worker.example/delete?path=products/abc/1.webp', {
      method: 'DELETE',
      headers: {
        Origin: 'https://princepicker.mudasirkhan.in',
        Authorization: 'Bearer ' + makeHs256Jwt({ role: 'anon', exp: Math.floor(Date.now() / 1000) + 300 }, secret)
      }
    }),
    env
  );
  assert.strictEqual(okJwtRes.status, 200);
  assert(!env.objects.has('products/abc/1.webp'), 'R2 object should be deleted');

  // Valid shared WORKER_AUTH_TOKEN also passes auth
  env.objects.set('products/abc/2.webp', { body: Buffer.from('y'), httpMetadata: { contentType: 'image/webp' } });
  const okWorkerTokRes = await mod.default.fetch(
    new Request('https://worker.example/delete?path=products/abc/2.webp', {
      method: 'DELETE',
      headers: {
        Origin: 'https://princepicker.mudasirkhan.in',
        Authorization: 'Bearer worker-secret-token-xyz'
      }
    }),
    env
  );
  assert.strictEqual(okWorkerTokRes.status, 200);
  assert(!env.objects.has('products/abc/2.webp'), 'R2 object should be deleted with WORKER_AUTH_TOKEN');
});

test('4. Worker OPTIONS preflight sanitizes Access-Control-Request-Headers', async () => {
  const mod = await import(pathToFileURL(path.join(ROOT, 'workers/image_upload_worker.js')).href);
  const env = createR2Mock();
  const res = await mod.default.fetch(
    new Request('https://worker.example/upload', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://princepicker.mudasirkhan.in',
        'Access-Control-Request-Headers': 'Authorization, Content-Type, Bad$Header, Invalid Header!'
      }
    }),
    env
  );
  assert.strictEqual(res.status, 204);
  const allowed = res.headers.get('Access-Control-Allow-Headers') || '';
  assert(allowed.includes('Authorization') && allowed.includes('Content-Type'));
  assert(!allowed.includes('Bad$Header') && !allowed.includes('Invalid Header'));
});

test('5. image_uploader.js removes hardcoded placeholder token and products.js clamps/sanitizes writes', async () => {
  assert(!uploaderJs.includes('anon-jwt-token-prince-picker'), 'Placeholder bearer token must be removed');

  let savedRow = null;
  let orFilterArg = null;
  const mockQuery = {
    upsert(rows) {
      savedRow = Array.isArray(rows) ? rows[0] : rows;
      return {
        select() {
          return Promise.resolve({ data: [savedRow], error: null });
        }
      };
    },
    delete() {
      return {
        or(expr) {
          orFilterArg = expr;
          return Promise.resolve({ error: null });
        },
        eq() {
          return Promise.resolve({ error: null });
        }
      };
    },
    select() {
      return {
        eq() { return Promise.resolve({ data: [], error: null }); },
        or() { return Promise.resolve({ data: [], error: null }); }
      };
    }
  };

  const sandbox = {
    window: {
      SUPABASE_CLIENT: {
        instance: {
          from() { return mockQuery; }
        }
      },
      SUPABASE_BATCHES: null,
      SUPABASE_IMAGE_UTILS: null
    },
    console: { log() {}, warn() {}, error() {} }
  };
  vm.runInNewContext(productsJs, sandbox);

  const res = await sandbox.window.SUPABASE_PRODUCTS.saveProduct({
    id: 'P-1',
    name: 'Test Item',
    barcode: 'SKU-1',
    mrp: -500,
    sp: -250,
    stock: -12,
    total_stock: -12,
    qty: -4,
    threshold: -3
  });
  assert(res.success, 'saveProduct should succeed with mocked client');
  assert.strictEqual(savedRow.mrp, 0);
  assert.strictEqual(savedRow.sp, 0);
  assert.strictEqual(savedRow.stock, 0);
  assert.strictEqual(savedRow.total_stock, 0);
  assert.strictEqual(savedRow.qty, 0);
  assert.strictEqual(savedRow.threshold, 0);

  await sandbox.window.SUPABASE_PRODUCTS.deleteProduct('abc,id.eq.1()\\');
  assert(orFilterArg && !/[()]/.test(orFilterArg) && orFilterArg.indexOf('abc,id') === -1, 'PostgREST .or filter chars should be stripped');
});

test('6. app/index.html inline JS <script> blocks compile cleanly without syntax errors', () => {
  const scriptRegex = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi;
  let match;
  let scriptIndex = 0;
  while ((match = scriptRegex.exec(html)) !== null) {
    const attrs = (match[1] || '').toLowerCase();
    if (attrs.includes('application/ld+json') || /\bsrc\s*=/.test(attrs)) continue;
    scriptIndex++;
    const code = match[2].trim();
    if (!code) continue;
    new vm.Script(code, { filename: `index-inline-${scriptIndex}.js` });
  }
  assert(scriptIndex > 0, 'Expected inline JS scripts in app/index.html');
});

test('7. app/index.html escapes XSS in hl() and newly patched template paths & validates saveProduct', () => {
  const escMatch = html.match(/function escapeHtml\([\s\S]*?\n    \}/);
  const hlMatch = html.match(/function hl\([\s\S]*?\n    \}/);
  assert(escMatch && hlMatch, 'escapeHtml and hl functions must exist');
  const ctx = {};
  vm.runInNewContext(escMatch[0] + '\n' + hlMatch[0], ctx);
  const payload = '<img src=x onerror=alert(1)> foo';
  const highlighted = ctx.hl(payload, 'foo');
  assert(!highlighted.includes('<img'), 'hl() must escape raw HTML tags');
  assert(highlighted.includes('&lt;img'), 'hl() should HTML-escape <img');
  assert(highlighted.includes('<mark>f</mark><mark>o</mark><mark>o</mark>'), 'hl() should highlight matched text cleanly');

  assert(html.includes('value="${escapeHtml(ci.note || \'\')}"'), 'confirmNoteVal must escape ci.note');
  assert(html.includes('${escapeHtml(STATE.pickerName || \'Picker\')}'), 'renderDashboard must escape pickerName');
  assert(html.includes('${escapeHtml(item.name)}'), 'renderCart must escape item.name');
  assert(html.includes('data-code="${escapeHtml(p.barcode || p.loc || \'\')}" onclick="selectManualSuggestion(this.dataset.code)"'), 'Manual suggestions must use escaped dataset');
  assert(html.includes('+ Create "${escapeHtml(inp.value)}"'), 'filterDD must escape new category/brand entry');
  assert(html.includes('rawMrpCheck < 0 || rawSpCheck < 0 || rawQtyCheck < 0 || rawThreshCheck < 0'), 'saveProduct must reject negative inputs');
  assert(html.includes("e?.name === 'NotAllowedError'"), 'openScanner must handle denied camera permission explicitly');
});

test('8. Responsive CSS & asset hardening checks in index.html, sw.js, vercel.json', () => {
  assert(/input,\s*textarea,\s*select\s*\{[^}]*font-size:\s*16px\s*!important/.test(html), '16px input font-size rule missing');
  assert(/\.ib\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/.test(html), '.ib must be >=44x44px');
  assert(/\.bn\s*\{[^}]*overflow:\s*visible\s*!important/.test(html), '.bn must allow floating Scan button overflow');
  assert(/#toast\s*\{[^}]*z-index:\s*1000000/.test(html), '#toast z-index must clear scanner/modals');
  assert(!html.includes('../picker%20logo.png'), 'Broken relative ../picker%20logo.png should be replaced');
  assert(html.includes('./picker-logo.png'), 'Login logo must reference cached ./picker-logo.png');
  assert(swJs.includes("'pa-picker-v24'"), 'Service worker cache version should be bumped to pa-picker-v24');

  const globalHdr = vercelJson.headers.find((h) => h.source === '/(.*)');
  assert(globalHdr, 'Expected /(.*) header rule in vercel.json');
  const keys = Object.fromEntries(globalHdr.headers.map((x) => [x.key, x.value]));
  assert(!keys['Access-Control-Allow-Origin'], 'Wildcard Access-Control-Allow-Origin should be removed from vercel.json');
  assert.strictEqual(keys['X-Content-Type-Options'], 'nosniff');
  assert.strictEqual(keys['X-Frame-Options'], 'SAMEORIGIN');
});

test('9. SQL hardening migration is mirrored and enforces RLS + non-negative constraints', () => {
  assert.strictEqual(rootMigration, appMigration, 'root and app security migrations must stay identical');
  assert(rootMigration.includes('DROP POLICY IF EXISTS "Public pickers read policy" ON pickers;'));
  assert(rootMigration.includes('REVOKE ALL ON TABLE pickers FROM anon, authenticated;'));
  assert(rootMigration.includes('CHECK (mrp >= 0)'));
  assert(rootMigration.includes('CHECK (stock_qty >= 0)'));
  assert(rootMigration.includes('p_qty IS NULL OR p_qty <= 0 OR p_qty > 100000'));
  assert(rootMigration.includes('p_unit_mrp IS NOT NULL AND p_unit_mrp < 0'));
  assert(rootMigration.includes('FOR UPDATE'));
  assert(rootMigration.includes('SET search_path = public, pg_temp'));
});

Promise.all(asyncQueue).then(() => {
  console.log(`\nSUMMARY: ${passed}/${total} tests passed.`);
  if (passed !== total) process.exit(1);
});
