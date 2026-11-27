/**
 * Verification Suite: Interactive Location (`loc`) Pills on Inventory Tab
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log('======================================================================');
console.log('LOCATION PILLS FILTER — VERIFICATION SUITE');
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
        this.children = matches.map(m => makeEl('', {
          classes: ['inv-brand-pill', ...m[1].trim().split(/\s+/).filter(Boolean)],
          dataset: { brand: m[2] }
        }));
      }
    }
  });
  if (id === 'invBrandStrip') {
    el.querySelectorAll = (sel) => sel === '.inv-brand-pill' ? el.children : [];
    el.querySelector = (sel) => sel === '.inv-brand-pill.active' ? (el.children.find(c => c.classList.contains('active')) || null) : null;
  }
  return el;
}

function createHarness() {
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
    invLocClearChip: makeEl('invLocClearChip'),
    homeQ: makeEl('homeQ')
  };

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
    crypto: require('crypto').webcrypto || require('crypto'),
    document: {
      getElementById: (id) => elements[id] || null,
      createElement: (tag) => makeEl(tag),
      querySelectorAll: () => []
    },
    window: {
      ScrollChromeController: { sync() {} },
      PrinceSearchEngine: null
    },
    STATE: {
      products: [
        {
          _idx: 0,
          id: 'p1',
          name: 'Rear Brake Cable',
          barcode: '1001',
          sku: 'SKU-1',
          loc: 'WR1L1B1',
          primary_location: 'WR1L1B1',
          brand: 'Honda',
          stock: 12,
          mrp: 120
        },
        {
          _idx: 1,
          id: 'p2',
          name: 'Front Disk Pad',
          barcode: '1002',
          sku: 'SKU-2',
          loc: ' wr1l1b1 ',
          primary_location: ' wr1l1b1 ',
          brand: 'Bajaj',
          stock: 5,
          mrp: 450
        },
        {
          _idx: 2,
          id: 'p3',
          name: 'Chain Sprocket Kit',
          barcode: '1003',
          sku: 'SKU-3',
          loc: 'R1L1B1',
          primary_location: 'R1L1B1',
          brand: 'Honda',
          stock: 10,
          mrp: 650,
          batches: [
            { id: 'b1', batch_id: 'B1', mrp: 650, stock_qty: 4, location: 'R1L1B1', created_at: '2026-01-01T00:00:00Z' },
            { id: 'b2', batch_id: 'B2', mrp: 690, stock_qty: 6, location: 'WR1L1B1', created_at: '2026-02-01T00:00:00Z' },
            { id: 'b3', batch_id: 'B3', mrp: 710, stock_qty: 0, location: 'R9L9B9', created_at: '2026-03-01T00:00:00Z' }
          ]
        },
        {
          _idx: 3,
          id: 'p4',
          name: 'Air Filter Element',
          barcode: '1004',
          sku: 'SKU-4',
          loc: 'R2L1B1',
          primary_location: 'R2L1B1',
          brand: 'Yamaha',
          stock: 14,
          mrp: 240
        }
      ],
      logs: [],
      barcodeIndex: new Map(),
      warehouseMap: {}
    },
    CART: { items: [] },
    escapeHtml: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    hl: (s) => String(s ?? ''),
    fuzzy: (str, q) => String(str || '').toLowerCase().includes(String(q || '').toLowerCase()),
    locSort: (loc) => {
      const m = String(loc || '').match(/R(\d+)L(\d+)B(\d+)/i);
      return m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) : 999999;
    },
    getEffectiveInventory: (id) => {
      const p = sandbox.STATE.products.find(x => x.id === id || x.barcode === id);
      return p ? p.stock : 0;
    },
    renderProductImgHtml: () => '<div class="pr-img"></div>',
    openProdDetail: (id) => openedDetails.push(id),
    toggleCart: (idx) => toggledCart.push(idx)
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(batchesCode, sandbox);
  sandbox.SUPABASE_BATCHES = sandbox.window.SUPABASE_BATCHES;

  const fnNames = [
    'getProductBatchKey',
    'getProductBatchesInfo',
    'selectInventoryBatch',
    'normalizeLocFilterValue',
    'findMatchingActiveBatchForLocation',
    'productMatchesLocation',
    'renderInventoryLocChip',
    'setInventoryLocFilter',
    'toggleInventoryLocFilter',
    'clearInventoryLocFilter',
    'normalizeBrandName',
    'getInventoryBrandCounts',
    'renderInventoryBrandStrip',
    'setInventoryBrandFilter',
    'toggleInventoryBrandFilter',
    'clearInventoryBrandFilter',
    'renderSearch'
  ];

  const codeToRun = `
    ${brandsMatch[0]}
    const SELECTED_PRODUCT_BATCHES = {};
    let INVENTORY_BRAND_FILTER = '';
    let INVENTORY_LOC_FILTER = '';
    let _lastInvBrandStripSig = '';
    ${fnNames.map(extractFn).join('\n\n')}
  `;
  vm.runInContext(codeToRun, sandbox);

  return { sandbox, elements, openedDetails, toggledCart };
}

test('CSS and HTML reuse Brand Pill styling and add Location filter chip without new screens', () => {
  const screens = [...html.matchAll(/<div class="S(?:\s+[^"]*)?"\s+id="(s-[^"]+)"/g)].map(m => m[1]);
  assert.deepStrictEqual(
    screens.filter(s => s.includes('loc') || s.includes('brand')),
    [],
    'No new screens/routes added'
  );
  assert(html.includes('.loc-card-pill'), 'CSS defines .loc-card-pill matching .brand-card-pill');
  assert(html.includes('.loc-card-pill.active'), 'CSS defines .loc-card-pill.active terracotta highlight');
  assert(html.includes('id="invLocClearChip"'), 'Removable active location filter badge exists near results bar');
});

test('Location pill filters case-insensitively with trimming, prevents bubbling, and toggles off cleanly', () => {
  const { sandbox, elements, openedDetails, toggledCart } = createHarness();
  sandbox.renderSearch('');
  assert.strictEqual(elements.searchList.children.length, 4);

  // Verify card location pill has stopPropagation
  const initialHtml = elements.searchList.children.map(c => c.innerHTML).join('\n');
  assert(initialHtml.includes('class="loc-card-pill"'), 'Cards render interactive .loc-card-pill');
  assert(initialHtml.includes('onclick="event.stopPropagation(); toggleInventoryLocFilter(this.dataset.loc)"'), 'Location pill stops event bubbling');

  // Tap WR1L1B1 (trimmed/case-insensitive matches p1 WR1L1B1, p2 " wr1l1b1 ", and p3 via in-stock batch B2 at WR1L1B1)
  sandbox.toggleInventoryLocFilter('  WR1L1B1 ');
  assert.strictEqual(elements.searchList.children.length, 3, 'Matches primary & batch locations case-insensitively');
  assert.strictEqual(elements.invLocClearChip.style.display, 'inline-flex', 'Active location badge visible');
  assert.strictEqual(elements.invLocClearChip.textContent, '📍 WR1L1B1 ×', 'Active location badge shows 📍 WR1L1B1 ×');
  assert.strictEqual(elements.searchCnt.textContent, '3 of 4 items');
  assert(elements.searchList.children.every(c => c.innerHTML.includes('class="loc-card-pill active"')), 'All matching cards highlight location pill');
  assert.strictEqual(openedDetails.length, 0, 'Card click did not fire');
  assert.strictEqual(toggledCart.length, 0, 'Add to Cart did not fire');

  // Tap active location pill again -> toggles off
  sandbox.toggleInventoryLocFilter('wr1l1b1');
  assert.strictEqual(elements.searchList.children.length, 4, 'Full list restored on second tap');
  assert.strictEqual(elements.invLocClearChip.style.display, 'none', 'Location clear chip hidden');

  // Filter then clear via clear chip
  sandbox.toggleInventoryLocFilter('R2L1B1');
  assert.strictEqual(elements.searchList.children.length, 1);
  sandbox.clearInventoryLocFilter();
  assert.strictEqual(elements.searchList.children.length, 4, 'Clear chip restores full list');
});

test('Multi-batch location matching ignores zero-stock batches and auto-highlights matching active batch pill', () => {
  const { sandbox, elements } = createHarness();

  // R9L9B9 only exists on p3 batch B3 which has stock_qty: 0 -> should not match
  sandbox.toggleInventoryLocFilter('R9L9B9');
  assert.strictEqual(elements.searchList.children.length, 0, 'Zero-stock batch location does not match');
  assert(elements.searchList.innerHTML.includes('clearInventoryLocFilter()'), 'Empty state offers Clear Location button');

  // WR1L1B1 exists on p3 batch B2 (stock_qty: 6); p3 primary is R1L1B1 (B1)
  sandbox.toggleInventoryLocFilter('WR1L1B1');
  const p3Card = elements.searchList.children.find(c => c.innerHTML.includes('Chain Sprocket Kit'));
  assert(p3Card, 'Multi-batch product p3 included when filtering WR1L1B1');
  assert(p3Card.innerHTML.includes('class="batch-pill active" onclick="event.stopPropagation(); selectInventoryBatch(\'p3\',\'B2\')"'), 'Matching batch pill B2 auto-highlighted on card');
  assert(p3Card.innerHTML.includes('data-loc="WR1L1B1"'), 'Displayed location pill reflects matching batch B2 location');
});

test('Location filter composes seamlessly with Brand filter and Search query', () => {
  const { sandbox, elements } = createHarness();

  // Brand Honda + Location WR1L1B1 -> p1 (Honda @ WR1L1B1) and p3 (Honda @ batch B2 WR1L1B1), excluding p2 (Bajaj @ wr1l1b1)
  sandbox.toggleInventoryBrandFilter('Honda');
  sandbox.toggleInventoryLocFilter('WR1L1B1');
  assert.strictEqual(elements.searchList.children.length, 2, 'Honda + WR1L1B1 yields 2 items');
  assert.strictEqual(elements.searchCnt.textContent, '2 of 4 items');

  // Add Search query "cable" -> narrows to p1 only
  elements.homeQ.value = 'cable';
  sandbox.renderSearch('cable');
  assert.strictEqual(elements.searchList.children.length, 1, 'Honda + WR1L1B1 + "cable" yields 1 item');
  assert(elements.searchList.children[0].innerHTML.includes('Rear Brake Cable'));
  assert.strictEqual(elements.searchCnt.textContent, '1 of 4 found');

  // Clear location only -> Honda + "cable" still active
  sandbox.clearInventoryLocFilter();
  assert.strictEqual(elements.searchList.children.length, 1);

  // Clear search + brand -> restores all 4
  elements.homeQ.value = '';
  sandbox.clearInventoryBrandFilter();
  assert.strictEqual(elements.searchList.children.length, 4);
});

console.log('\n----------------------------------------------------------------------');
console.log(`RESULT: ${passed}/${total} tests passed.`);
if (passed !== total) process.exit(1);
