/**
 * Regression & Verification Suite: Products Tab (`#s-products` / `renderProductsList`)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log('======================================================================');
console.log('PRODUCTS TAB RENDERING & FILTERING — VERIFICATION SUITE');
console.log('======================================================================\n');

let total = 0;
let passed = 0;
const asyncTests = [];

function test(name, fn) {
  total++;
  const res = fn();
  if (res && typeof res.then === 'function') {
    asyncTests.push(
      res.then(
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
  } else {
    try {
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`  ✗ ${name}`);
      console.error(`    ${err.stack || err.message}`);
      process.exitCode = 1;
    }
  }
}

const htmlPath = path.join(__dirname, '../app/index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const batchesCode = fs.readFileSync(path.join(__dirname, '../app/supabase/batches.js'), 'utf8');

function extractScriptBlocks(sourceHtml) {
  const scripts = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(sourceHtml)) !== null) {
    const attrs = m[1] || '';
    if (!/\bsrc\s*=/i.test(attrs) && !/application\/ld\+json/i.test(attrs)) {
      scripts.push(m[2]);
    }
  }
  return scripts;
}

function makeEl(id, initial = {}) {
  const listeners = {};
  const el = {
    id,
    value: initial.value || '',
    textContent: '',
    _innerHTML: '',
    style: {},
    dataset: { ...(initial.dataset || {}) },
    children: [],
    className: '',
    onclick: null,
    classList: {
      _set: new Set(initial.classes || []),
      add(...cls) { cls.forEach(c => this._set.add(c)); },
      remove(...cls) { cls.forEach(c => this._set.delete(c)); },
      contains(c) { return this._set.has(c); }
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    addEventListener(type, fn) {
      listeners[type] = listeners[type] || [];
      listeners[type].push(fn);
    },
    dispatchEvent(type) {
      (listeners[type] || []).forEach(fn => fn.call(el, { target: el }));
    },
    _listeners: listeners
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._innerHTML; },
    set(val) {
      this._innerHTML = String(val || '');
      this.children = [];
    }
  });
  return el;
}

function extractFunction(mainScript, name) {
  const startRe = new RegExp(`^    (?:async\\s+)?function\\s+${name}\\s*\\(`, 'm');
  const m = startRe.exec(mainScript);
  if (!m) throw new Error(`Function ${name} not found in app/index.html`);
  let pos = m.index;
  while (true) {
    const endIdx = mainScript.indexOf('\n    }', pos);
    if (endIdx < 0) throw new Error(`Unclosed function ${name}`);
    const candidate = mainScript.slice(m.index, endIdx + 6);
    try {
      new vm.Script(candidate);
      return candidate;
    } catch (e) {
      pos = endIdx + 6;
    }
  }
}

function createHarness(options = {}) {
  const scripts = extractScriptBlocks(html);
  const mainScript = scripts.reduce((a, b) => (b.length > a.length ? b : a), '');

  const elements = {
    prodList: makeEl('prodList'),
    prodStats: makeEl('prodStats'),
    prodQ: makeEl('prodQ'),
    prodImportIn: makeEl('prodImportIn'),
    imgImportIn: makeEl('imgImportIn')
  };

  const sandbox = {
    console,
    Math,
    Date,
    Set,
    Map,
    Array,
    Object,
    String,
    Number,
    Boolean,
    JSON,
    Promise,
    setTimeout,
    clearTimeout,
    localStorage: {
      _data: { ...(options.localStorage || {}) },
      getItem(k) { return Object.prototype.hasOwnProperty.call(this._data, k) ? this._data[k] : null; },
      setItem(k, v) { this._data[k] = String(v); }
    },
    document: {
      getElementById: (id) => elements[id] || null,
      createElement: (tag) => makeEl(tag),
      querySelectorAll: () => []
    },
    window: null,
    STATE: {
      products: [],
      barcodeIndex: new Map(),
      warehouseMap: null,
      pendingTransferOverlays: []
    },
    FS_PRODUCTS: [],
    FS_IMAGES: {},
    PROD_FILTER: 'all',
    FILTER_BRANDS: new Set(),
    FILTER_CATS: new Set(),
    CATS: ['Brakes', 'Filters'],
    VEHICLES: ['Pulsar 150'],
    BRANDS: ['Hero', 'Bajaj'],
    DEFAULT_CATS: ['Brakes', 'Filters'],
    DEFAULT_VEHICLES: ['Pulsar 150'],
    DEFAULT_BRANDS: ['Hero', 'Bajaj'],
    SELECTED_PRODUCT_BATCHES: {},
    ScrollChromeController: { syncCalls: [], sync(id) { this.syncCalls.push(id); } },
    PrinceSearchEngine: options.searchEngine || null,
    PICKER_DB: options.pickerDb || null,
    buildWarehouseMap: () => ({ shop: {}, warehouse: {} }),
    evaluateStockNotifications: () => {},
    getEffectiveInventory: () => undefined,
    openProdDetail: (id) => { sandbox._openedDetail = id; },
    toast: () => {},
    updateFileLbl: () => {},
    renderAPBrandPills: () => {},
    debounce: (fn) => fn
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(batchesCode, sandbox);

  const fns = [
    'escapeHtml',
    'formatImageUrl',
    'getProductImageSrc',
    'getProductImgCandidates',
    'renderProductImgHtml',
    'normalizeBrandName',
    'normalizeProduct',
    'loadProducts',
    'getProductBatchKey',
    'getProductBatchesInfo',
    'locSort',
    'getProductFacilityInfo',
    'syncFStoState',
    'renderProductsList',
    'wireProductsInputs'
  ];

  const snippet = [
    'let _prodListRenderSeq = 0;',
    'let _productsInputsWired = false;',
    'const PROD_IMAGE_BASE = "https://img.example.com";',
    'const PRODUCT_PLACEHOLDER_SVG = "<svg></svg>";',
    'function renderProductPlaceholderHtml() { return "<div class=\\"img-fallback-placeholder\\"></div>"; }',
    ...fns.map(fn => extractFunction(mainScript, fn))
  ].join('\n\n');

  vm.runInContext(snippet, sandbox);
  return { sandbox, elements, mainScript };
}

test('All inline scripts in app/index.html compile and no undefined esc() calls remain', () => {
  const scripts = extractScriptBlocks(html);
  scripts.forEach((src, idx) => {
    assert.doesNotThrow(() => new vm.Script(src), `Script block #${idx} syntax error`);
  });
  assert.strictEqual(/\besc\s*\(/.test(html), false, 'Found undefined esc(...) helper call in app/index.html');
});

test('renderProductsList renders single-batch and multi-batch products without crashing', async () => {
  const { sandbox, elements } = createHarness();
  sandbox.loadProducts([
    {
      id: 'P1',
      sku: 'SKU-1',
      barcode: '8901',
      name: 'Brake Pad & Shoe <Front>',
      brand: 'Hero',
      category: 'Brakes',
      loc: 'R1L1B1',
      mrp: 150,
      stock: 10
    },
    {
      id: 'P2',
      sku: 'SKU-2',
      barcode: '8902',
      name: 'Air Filter Multi-MRP',
      brand: 'Bajaj',
      category: 'Filters',
      loc: 'R1L1B2',
      mrp: 200,
      stock: 12,
      batches: [
        { id: 'P2::B1', product_id: 'P2', batch_id: 'B1', mrp: 180, stock_qty: 5, location: 'R1L1B2' },
        { id: 'P2::B2', product_id: 'P2', batch_id: 'B2', mrp: 200, stock_qty: 7, location: 'WR1L1B1' }
      ]
    }
  ]);

  await sandbox.renderProductsList('');

  assert.strictEqual(elements.prodList.children.length, 2, 'Expected both products to render in #prodList');
  assert(elements.prodList.children[0].innerHTML.includes('Brake Pad &amp; Shoe &lt;Front&gt;'), 'Product name should be escaped');
  assert(elements.prodList.children[1].innerHTML.includes('B1 · ₹180 (5)'), 'Multi-batch summary tag B1 should render');
  assert(elements.prodList.children[1].innerHTML.includes('B2 · ₹200 (7)'), 'Multi-batch summary tag B2 should render');
  assert(elements.prodList.children[1].innerHTML.includes('2 Batches'), 'Multi-batch count badge should render');
  assert(elements.prodStats.innerHTML.includes('>2<'), 'Stats chip should show total count 2');
  assert(sandbox.ScrollChromeController.syncCalls.includes('s-products'), 'ScrollChromeController should sync s-products');
});

test('renderProductsList supports search query, facility filters, and brand/category filters', async () => {
  const { sandbox, elements } = createHarness();
  sandbox.loadProducts([
    {
      id: 'P1',
      sku: 'SKU-1',
      barcode: '8901',
      name: 'Shop Brake Pad',
      brand: 'Hero',
      category: 'Brakes',
      loc: 'R1L1B1',
      stock: 3,
      threshold: 5
    },
    {
      id: 'P2',
      sku: 'SKU-2',
      barcode: '8902',
      name: 'Warehouse Filter',
      brand: 'Bajaj',
      category: 'Filters',
      loc: 'WR2L1B1',
      stock: 0,
      threshold: 5
    }
  ]);

  await sandbox.renderProductsList('brake');
  assert.strictEqual(elements.prodList.children.length, 1);
  assert(elements.prodList.children[0].innerHTML.includes('Shop Brake Pad'));

  sandbox.PROD_FILTER = 'low';
  await sandbox.renderProductsList('');
  assert.strictEqual(elements.prodList.children.length, 1);
  assert(elements.prodList.children[0].innerHTML.includes('Shop Brake Pad'));

  sandbox.PROD_FILTER = 'out';
  await sandbox.renderProductsList('');
  assert.strictEqual(elements.prodList.children.length, 1);
  assert(elements.prodList.children[0].innerHTML.includes('Warehouse Filter'));

  sandbox.PROD_FILTER = 'warehouse';
  await sandbox.renderProductsList('');
  assert.strictEqual(elements.prodList.children.length, 1);
  assert(elements.prodList.children[0].innerHTML.includes('WAREHOUSE · WR2L1B1'));
});

test('renderProductsList recovers cached products from PICKER_DB when in-memory arrays are empty', async () => {
  const { sandbox, elements } = createHarness({
    pickerDb: {
      async getAllProducts() {
        return [{
          id: 'P-DB',
          sku: 'SKU-DB',
          barcode: '9901',
          name: 'Cached Clutch Plate',
          brand: 'Hero',
          loc: 'R2L1B1',
          mrp: 350,
          stock: 8
        }];
      },
      async getAllBatches() {
        return [
          { id: 'P-DB::B1', product_id: 'P-DB', batch_id: 'B1', mrp: 320, stock_qty: 3, location: 'R2L1B1' },
          { id: 'P-DB::B2', product_id: 'P-DB', batch_id: 'B2', mrp: 350, stock_qty: 5, location: 'R2L1B1' }
        ];
      }
    }
  });

  await sandbox.renderProductsList('');
  assert.strictEqual(elements.prodList.children.length, 1);
  assert(elements.prodList.children[0].innerHTML.includes('Cached Clutch Plate'));
  assert(elements.prodList.children[0].innerHTML.includes('B2 · ₹350 (5)'));
});

test('wireProductsInputs binds prodQ input filtering and restores custom lists', async () => {
  const { sandbox, elements } = createHarness({
    localStorage: {
      pa_custom_brands: JSON.stringify(['Motul'])
    }
  });
  sandbox.loadProducts([
    { id: 'P1', sku: 'S1', barcode: '101', name: 'Motul Oil', brand: 'Motul', loc: 'R1L1B1', stock: 5 },
    { id: 'P2', sku: 'S2', barcode: '102', name: 'Brake Shoe', brand: 'Hero', loc: 'R1L1B2', stock: 5 }
  ]);

  sandbox.wireProductsInputs();
  assert(sandbox.BRANDS.includes('Motul'), 'Custom brand should be restored from localStorage');

  elements.prodQ.value = 'motul';
  elements.prodQ.dispatchEvent('input');
  await new Promise(r => setTimeout(r, 10));

  assert.strictEqual(elements.prodList.children.length, 1);
  assert(elements.prodList.children[0].innerHTML.includes('Motul Oil'));
});

Promise.all(asyncTests).then(() => {
  console.log('\n----------------------------------------------------------------------');
  console.log(`RESULT: ${passed}/${total} tests passed.`);
  if (passed !== total) process.exit(1);
});
