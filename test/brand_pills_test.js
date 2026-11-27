/**
 * Verification Suite: Brand Pills Upgrade (Inventory & Add/Edit Product)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log('======================================================================');
console.log('BRAND PILLS UPGRADE — VERIFICATION SUITE');
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
    console.error(`    ${err.stack || err.message}`);
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
    console.error(`    ${err.stack || err.message}`);
  }
}

const htmlPath = path.join(__dirname, '../app/index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

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
  const el = {
    id,
    value: initial.value || '',
    textContent: '',
    _innerHTML: '',
    style: {},
    dataset: { ...(initial.dataset || {}) },
    scrollLeft: 0,
    scrollTop: 0,
    children: [],
    classList: {
      _set: new Set(initial.classes || []),
      add(...cls) { cls.forEach(c => this._set.add(c)); },
      remove(...cls) { cls.forEach(c => this._set.delete(c)); },
      toggle(c, force) {
        if (force === undefined) {
          if (this._set.has(c)) { this._set.delete(c); return false; }
          this._set.add(c); return true;
        }
        if (force) this._set.add(c); else this._set.delete(c);
        return !!force;
      },
      contains(c) { return this._set.has(c); }
    },
    attributes: {},
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return this.attributes[k]; },
    appendChild(child) { this.children.push(child); return child; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    scrollIntoView() {},
    focus() {},
    addEventListener() {}
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._innerHTML; },
    set(val) {
      this._innerHTML = String(val || '');
      this.children = [];
      if (this.id === 'invBrandStrip') {
        const matches = [...this._innerHTML.matchAll(/class="inv-brand-pill([^"]*)"\s+data-brand="([^"]*)"/g)];
        this.children = matches.map(m => {
          const btn = makeEl('', {
            classes: ['inv-brand-pill', ...m[1].trim().split(/\s+/).filter(Boolean)],
            dataset: { brand: m[2] }
          });
          return btn;
        });
      }
    }
  });
  if (id === 'invBrandStrip') {
    el.querySelectorAll = (sel) => sel === '.inv-brand-pill' ? el.children : [];
    el.querySelector = (sel) => sel === '.inv-brand-pill.active' ? (el.children.find(c => c.classList.contains('active')) || null) : null;
  }
  if (id === 'apBrandPills') {
    el.querySelector = (sel) => {
      if (sel === '.ap-brand-pill.active') {
        const m = el._innerHTML.match(/class="ap-brand-pill active"\s+data-brand="([^"]*)"/);
        return m ? makeEl('', { dataset: { brand: m[1] }, classes: ['ap-brand-pill', 'active'] }) : null;
      }
      return null;
    };
  }
  return el;
}

function createAppHarness() {
  const scripts = extractScriptBlocks(html);
  const mainScript = scripts.reduce((a, b) => (b.length > a.length ? b : a), '');

  const extractFn = (name) => {
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
  };

  const brandsMatch = mainScript.match(/let BRANDS = \[[\s\S]*?\];/);
  if (!brandsMatch) throw new Error('BRANDS array not found');

  const elements = {
    searchList: makeEl('searchList'),
    searchCnt: makeEl('searchCnt'),
    invBrandStrip: makeEl('invBrandStrip'),
    invBrandClearChip: makeEl('invBrandClearChip'),
    homeQ: makeEl('homeQ'),
    apName: makeEl('apName'),
    apBrand: makeEl('apBrand'),
    apCustomBrandIn: makeEl('apCustomBrandIn'),
    apBrandPills: makeEl('apBrandPills'),
    apBrandSelectedHint: makeEl('apBrandSelectedHint'),
    apCat: makeEl('apCat'),
    apBarcode: makeEl('apBarcode'),
    apQty: makeEl('apQty', { value: '10' }),
    apThreshold: makeEl('apThreshold', { value: '5' }),
    apMRP: makeEl('apMRP', { value: '250' }),
    apSP: makeEl('apSP', { value: '220' }),
    apSaveBtn: makeEl('apSaveBtn'),
    apTitle: makeEl('apTitle'),
    intactToggle: makeEl('intactToggle'),
    prodList: makeEl('prodList')
  };

  const storage = {};
  const toasts = [];
  const openedDetails = [];
  const toggledCart = [];

  const sandbox = {
    console,
    Math,
    Date,
    JSON,
    String,
    Number,
    Array,
    Boolean,
    Object,
    Map,
    Set,
    RegExp,
    Promise,
    localStorage: {
      getItem: (k) => Object.prototype.hasOwnProperty.call(storage, k) ? storage[k] : null,
      setItem: (k, v) => { storage[k] = String(v); }
    },
    document: {
      getElementById: (id) => elements[id] || null,
      createElement: (tag) => makeEl(tag),
      querySelectorAll: () => []
    },
    window: {
      ScrollChromeController: { sync() {} },
      PrinceSearchEngine: null,
      SUPABASE_BATCHES: null,
      SUPABASE_PRODUCTS: null,
      PICKER_DB: null,
      PRODUCT_STORAGE: null
    },
    STATE: {
      products: [
        { _idx: 0, id: '1', name: 'Rear Brake Cable', barcode: '1001', sku: 'SKU-1', loc: 'R1L1B1', brand: 'Honda', stock: 12, mrp: 120 },
        { _idx: 1, id: '2', name: 'Chain Sprocket Kit', barcode: '1002', sku: 'SKU-2', loc: 'R1L1B2', brand: 'honda ', stock: 8, mrp: 650 },
        { _idx: 2, id: '3', name: 'Front Disk Pad', barcode: '1003', sku: 'SKU-3', loc: 'R1L1B3', brand: 'Bajaj', stock: 4, mrp: 450 },
        { _idx: 3, id: '4', name: 'Piston Ring Set', barcode: '1004', sku: 'SKU-4', loc: 'R1L2B1', brand: 'Honda', stock: 3, mrp: 780 },
        { _idx: 4, id: '5', name: 'Oil Filter', barcode: '1005', sku: 'SKU-5', loc: 'R1L2B2', brand: 'Yamaha', stock: 25, mrp: 220 }
      ],
      logs: [],
      barcodeIndex: new Map(),
      warehouseMap: {}
    },
    FS_PRODUCTS: [],
    CART: { items: [] },
    AP_EDIT_ID: null,
    AP_STORAGE_TYPE: 'SHOP',
    AP_LOC_MODE: 'EDIT',
    AP_TARGET_EDIT_LOC: null,
    AP_COMPAT_SEL: new Set(),
    AP_PRODUCT_IMAGES: [],
    AP_LAST_PRODUCT: null,
    FS_PROD_HANDLE: null,
    LS_LOGS: 'pa_logs',
    escapeHtml: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    hl: (s) => String(s ?? ''),
    fuzzy: (str, q) => String(str || '').toLowerCase().includes(String(q || '').toLowerCase()),
    locSort: (loc) => {
      const m = String(loc || '').match(/R(\d+)L(\d+)B(\d+)/i);
      return m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) : 999999;
    },
    getProductBatchKey: (p) => String(p.id || p.barcode),
    getProductBatchesInfo: (p) => ({
      isMulti: false,
      totalStock: p.stock || 0,
      selectedBatch: { batch_id: 'B1', mrp: p.mrp, location: p.loc, stock_qty: p.stock },
      activeBatches: []
    }),
    getEffectiveInventory: (id) => {
      const p = sandbox.STATE.products.find(x => x.id === id || x.barcode === id);
      return p ? p.stock : 0;
    },
    renderProductImgHtml: () => '<div class="pr-img"></div>',
    toast: (msg, type) => toasts.push({ msg, type }),
    openProdDetail: (id) => openedDetails.push(id),
    toggleCart: (idx) => toggledCart.push(idx),
    getAPLoc: () => 'R1L1B1',
    isIdDuplicate: () => false,
    formatImageUrl: (u) => u,
    buildWarehouseMap: () => ({}),
    renderAPExistingLocations: () => {},
    renderAPBatchesSummary: () => {},
    renderProductsList: () => {},
    normalizeProduct: (p) => p,
    syncProductToAppStores: (prod) => {
      const i = sandbox.FS_PRODUCTS.findIndex(x => x.id === prod.id);
      if (i >= 0) sandbox.FS_PRODUCTS[i] = prod; else sandbox.FS_PRODUCTS.push(prod);
      const si = sandbox.STATE.products.findIndex(x => x.id === prod.id);
      if (si >= 0) sandbox.STATE.products[si] = prod; else sandbox.STATE.products.push({ ...prod, _idx: sandbox.STATE.products.length });
    }
  };
  sandbox.FS_PRODUCTS = [...sandbox.STATE.products];
  sandbox.window.ScrollChromeController = sandbox.window.ScrollChromeController;

  const fnNames = [
    'normalizeLocFilterValue',
    'findMatchingActiveBatchForLocation',
    'productMatchesLocation',
    'renderInventoryLocChip',
    'normalizeBrandName',
    'getInventoryBrandCounts',
    'renderInventoryBrandStrip',
    'setInventoryBrandFilter',
    'toggleInventoryBrandFilter',
    'clearInventoryBrandFilter',
    'renderSearch',
    'registerBrandInCatalog',
    'getSelectableBrands',
    'renderAPBrandPills',
    'setAPBrand',
    'selectAPBrandPill',
    'addCustomBrandFromInput',
    'saveProduct',
    'clearFormFields',
    'dupProduct'
  ];

  const codeToRun = `
    ${brandsMatch[0]}
    const DEFAULT_BRANDS = [...BRANDS];
    let INVENTORY_BRAND_FILTER = '';
    let INVENTORY_LOC_FILTER = '';
    let _lastInvBrandStripSig = '';
    ${fnNames.map(extractFn).join('\n\n')}
  `;
  vm.createContext(sandbox);
  vm.runInContext(codeToRun, sandbox);

  return { sandbox, elements, storage, toasts, openedDetails, toggledCart };
}

test('All inline <script> blocks in app/index.html have valid JavaScript syntax', () => {
  const scripts = extractScriptBlocks(html);
  assert(scripts.length >= 1, 'Expected inline scripts in app/index.html');
  scripts.forEach((code, idx) => {
    new vm.Script(code, { filename: `app/index.html#script-${idx}` });
  });
});

test('CSS and HTML preserve scope, hide scrollbars cleanly, and use terracotta #C84B11 active highlights', () => {
  const screens = [...html.matchAll(/<div class="S(?:\s+[^"]*)?"\s+id="(s-[^"]+)"/g)].map(m => m[1]);
  assert(screens.includes('s-search'), 'Inventory screen s-search exists');
  assert(screens.includes('s-add-product'), 'Add/Edit Product screen s-add-product exists');
  assert(!screens.some(s => s.includes('brand')), 'No new brand screen/route added');

  assert(html.includes('scrollbar-width: none;'), 'Strip hides scrollbars via scrollbar-width: none');
  assert(html.includes('.inv-brand-strip::-webkit-scrollbar'), 'Strip hides WebKit scrollbars');
  assert(html.includes('#C84B11'), 'Terracotta #C84B11 active highlights present');
  assert(html.includes('id="invBrandStrip"'), 'Quick-filter brand strip mounted in s-search header');
  assert(html.includes('id="invBrandClearChip"'), 'Clear brand chip present in s-search results header');
  assert(html.includes('id="apBrandPills"') && html.includes('id="apCustomBrandIn"'), 'Add/Edit product uses brand pills + custom brand input');
  assert(!html.includes('id="brandDD"'), 'Plain text-only brandDD dropdown replaced in Add/Edit product');
});

test('normalizeBrandName trims, collapses spaces, applies title case, and preserves canonical catalog casing', () => {
  const { sandbox } = createAppHarness();
  assert.strictEqual(sandbox.normalizeBrandName('  honda  '), 'Honda');
  assert.strictEqual(sandbox.normalizeBrandName('HONDA'), 'Honda');
  assert.strictEqual(sandbox.normalizeBrandName('royal   enfield'), 'Royal Enfield');
  assert.strictEqual(sandbox.normalizeBrandName('harley-davidson'), 'Harley-Davidson');
  assert.strictEqual(sandbox.normalizeBrandName('tvs'), 'TVS');
  assert.strictEqual(sandbox.normalizeBrandName('k&n'), 'K&N');
  assert.strictEqual(sandbox.normalizeBrandName('  skf   bearings '), 'Skf Bearings');
  assert.strictEqual(sandbox.normalizeBrandName('   '), '');
});

test('Quick-Filter Brand Pill Strip sorts brands by inventory count and merges casing duplicates', () => {
  const { sandbox, elements } = createAppHarness();
  const counts = JSON.parse(JSON.stringify(sandbox.getInventoryBrandCounts()));
  assert.deepStrictEqual(counts, [
    { brand: 'Honda', count: 3 },
    { brand: 'Bajaj', count: 1 },
    { brand: 'Yamaha', count: 1 }
  ]);

  sandbox.renderSearch('');
  const stripHtml = elements.invBrandStrip.innerHTML;
  assert(stripHtml.includes('All <span class="bp-cnt">5</span>'), 'All pill shows total count');
  assert(stripHtml.indexOf('data-brand="Honda"') < stripHtml.indexOf('data-brand="Bajaj"'), 'Honda (3) precedes Bajaj (1)');
  assert(stripHtml.indexOf('data-brand="Bajaj"') < stripHtml.indexOf('data-brand="Yamaha"'), 'Alphabetical tie-breaker Bajaj before Yamaha');
});

test('Card brand pill filters Inventory, stops event bubbling, toggles off on re-tap or All/clear', () => {
  const { sandbox, elements, openedDetails, toggledCart } = createAppHarness();
  sandbox.renderSearch('');

  // Verify card brand pill markup has stopPropagation and never triggers card or cart handlers
  const cardHtml = elements.searchList.children.map(c => c.innerHTML).join('\n');
  assert(cardHtml.includes('class="brand-card-pill"'), 'Card renders brand-card-pill');
  assert(cardHtml.includes('onclick="event.stopPropagation(); toggleInventoryBrandFilter(this.dataset.brand)"'), 'Card brand pill stops propagation');
  assert.strictEqual(elements.searchList.children.length, 5, 'Initially shows all 5 products');

  // Tap Honda brand pill
  sandbox.toggleInventoryBrandFilter('Honda');
  assert.strictEqual(elements.searchList.children.length, 3, 'Filtering Honda matches both "Honda" and "honda " (3 items)');
  assert.strictEqual(elements.invBrandClearChip.style.display, 'inline-flex', 'Clear chip visible when brand active');
  assert(elements.searchList.children.every(c => c.innerHTML.includes('class="brand-card-pill active"')), 'Filtered cards show active brand pill');
  assert.strictEqual(openedDetails.length, 0, 'Card click did not fire');
  assert.strictEqual(toggledCart.length, 0, 'Add to Cart did not fire');

  // Search within selected brand
  elements.homeQ.value = 'piston';
  sandbox.renderSearch('piston');
  assert.strictEqual(elements.searchList.children.length, 1, 'Search "piston" within Honda returns 1 item');
  assert(elements.searchList.children[0].innerHTML.includes('Piston Ring Set'));

  // Tap active brand pill again -> restores full search results
  sandbox.toggleInventoryBrandFilter('Honda');
  assert.strictEqual(elements.invBrandClearChip.style.display, 'none', 'Clear chip hidden after toggle off');

  // Clear search -> full 5 items restored
  elements.homeQ.value = '';
  sandbox.renderSearch('');
  assert.strictEqual(elements.searchList.children.length, 5, 'Full inventory restored');

  // Set filter then clear via clearInventoryBrandFilter (All / × chip)
  sandbox.toggleInventoryBrandFilter('Bajaj');
  assert.strictEqual(elements.searchList.children.length, 1);
  sandbox.clearInventoryBrandFilter();
  assert.strictEqual(elements.searchList.children.length, 5, 'All / × clear chip restores full list');
});

asyncTest('Add/Edit Product brand pills support one-tap select, custom brand creation, duplicate prevention, and save normalization', async () => {
  const { sandbox, elements, storage } = createAppHarness();
  sandbox.renderAPBrandPills();
  const pillsHtml = elements.apBrandPills.innerHTML;
  assert(pillsHtml.includes('data-brand="Honda"'), 'Catalog brand Honda rendered as selectable pill');

  // One-tap pill selection
  sandbox.selectAPBrandPill('Bajaj');
  assert.strictEqual(elements.apBrand.value, 'Bajaj');
  assert.strictEqual(elements.apBrandSelectedHint.textContent, 'Selected: Bajaj');

  // Tapping same pill again deselects
  sandbox.selectAPBrandPill('Bajaj');
  assert.strictEqual(elements.apBrand.value, '');

  // Typing "  honda  " in Custom Brand selects existing "Honda" without creating duplicate
  elements.apCustomBrandIn.value = '  honda  ';
  sandbox.addCustomBrandFromInput();
  assert.strictEqual(elements.apBrand.value, 'Honda');
  assert.strictEqual(elements.apCustomBrandIn.value, '');
  const brandOccurrences = (elements.apBrandPills.innerHTML.match(/data-brand="Honda"/gi) || []).length;
  assert.strictEqual(brandOccurrences, 1, 'No duplicate Honda pill created');

  // Creating a genuinely new custom brand normalizes casing and persists
  elements.apCustomBrandIn.value = '  rolon   chain ';
  sandbox.addCustomBrandFromInput();
  assert.strictEqual(elements.apBrand.value, 'Rolon Chain');
  assert(JSON.parse(storage.pa_custom_brands).includes('Rolon Chain'), 'Custom brand persisted in localStorage');

  // Saving a product with unsubmitted lowercase custom brand normalizes on save
  elements.apName.value = 'Test Sprocket';
  elements.apBarcode.value = '9999';
  elements.apBrand.value = '';
  elements.apCustomBrandIn.value = '  ask   automotive ';
  await sandbox.saveProduct();
  const saved = sandbox.STATE.products.find(p => p.barcode === '9999');
  assert(saved, 'Product saved to STATE.products');
  assert.strictEqual(saved.brand, 'Ask Automotive', 'Brand normalized to title case on save');
  assert.strictEqual(elements.apCustomBrandIn.value, '', 'Custom brand input cleared after save');
  assert(elements.invBrandStrip.innerHTML.includes('data-brand="Ask Automotive"'), 'Inventory brand strip updated after save');
});

setImmediate(() => {
  console.log('\n----------------------------------------------------------------------');
  console.log(`RESULT: ${passed}/${total} tests passed.`);
  if (passed !== total) process.exit(1);
});
