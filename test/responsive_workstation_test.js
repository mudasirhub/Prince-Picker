const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'app/index.html'), 'utf8');
const searchEngineSrc = fs.readFileSync(path.join(ROOT, 'app/search_engine.js'), 'utf8');

function extractAllScripts(docHtml) {
  const scripts = [];
  const re = /<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(docHtml)) !== null) {
    scripts.push(m[1]);
  }
  return scripts;
}

function extractConstModule(scriptSrc, name) {
  const startMarker = `const ${name} = (function () {`;
  const endMarker = `window.${name} = ${name};`;
  const sIdx = scriptSrc.indexOf(startMarker);
  const eIdx = scriptSrc.indexOf(endMarker, sIdx);
  assert(sIdx !== -1 && eIdx !== -1, `Could not extract module ${name}`);
  return scriptSrc.slice(sIdx, eIdx + endMarker.length);
}

function makeFakeElement(tag, id) {
  const listeners = new Map();
  const classes = new Set();
  const attrs = new Map();
  const children = [];
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    id: id || '',
    value: '',
    textContent: '',
    innerHTML: '',
    scrollTop: 0,
    scrollHeight: 1200,
    clientHeight: 600,
    parentElement: null,
    dataset: {},
    style: { cssText: '' },
    classList: {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      toggle: (c, force) => {
        if (force === undefined) {
          if (classes.has(c)) classes.delete(c); else classes.add(c);
        } else if (force) classes.add(c);
        else classes.delete(c);
      },
      contains: c => classes.has(c)
    },
    setAttribute: (k, v) => attrs.set(k, String(v)),
    getAttribute: k => attrs.has(k) ? attrs.get(k) : null,
    addEventListener: (ev, fn) => {
      if (!listeners.has(ev)) listeners.set(ev, []);
      listeners.get(ev).push(fn);
    },
    removeEventListener: (ev, fn) => {
      if (!listeners.has(ev)) return;
      listeners.set(ev, listeners.get(ev).filter(f => f !== fn));
    },
    dispatch: (ev, eventObj = {}) => {
      const normalized = { preventDefault: () => {}, stopPropagation: () => {}, ...eventObj };
      const fns = listeners.get(ev) || [];
      fns.forEach(fn => fn.call(el, normalized));
    },
    appendChild: child => {
      child.parentElement = el;
      children.push(child);
      return child;
    },
    remove: () => { el.parentElement = null; },
    contains: target => target === el || children.includes(target),
    querySelector: sel => {
      if (sel === '.psd-quick-add-btn' && String(el.innerHTML || '').includes('psd-quick-add-btn')) {
        if (!el._qaBtn) el._qaBtn = makeFakeElement('button', '');
        return el._qaBtn;
      }
      return null;
    },
    querySelectorAll: sel => {
      if (sel === '.psd-item') {
        const out = [];
        const walk = node => {
          (node._children || []).forEach(c => {
            if ((c._classes && c._classes.has('psd-item')) || String(c.className || '').includes('psd-item')) out.push(c);
            walk(c);
          });
        };
        walk(el);
        return out;
      }
      return [];
    },
    scrollIntoView: () => {},
    closest: sel => (sel === '.search-row' ? el.parentElement : null),
    getBoundingClientRect: () => ({ left: 16, right: 374, top: 20, bottom: 64, width: 358, height: 44 }),
    focus: () => { if (el._ownerDoc) el._ownerDoc.activeElement = el; },
    blur: () => { if (el._ownerDoc && el._ownerDoc.activeElement === el) el._ownerDoc.activeElement = el._ownerDoc.body; },
    select: () => { el._selected = true; },
    _listeners: listeners,
    _classes: classes,
    _children: children,
    _selected: false
  };
  let _innerHTML = '';
  Object.defineProperty(el, 'innerHTML', {
    get: () => _innerHTML,
    set: val => {
      _innerHTML = String(val || '');
      if (_innerHTML === '') children.length = 0;
    }
  });
  return el;
}

async function runSuite() {
  console.log('======================================================================');
  console.log('RESPONSIVE MOBILE + PC WORKSTATION ARCHITECTURE — VERIFICATION SUITE');
  console.log('======================================================================\n');

  const scripts = extractAllScripts(html);
  assert(scripts.length > 0, 'Expected inline scripts in app/index.html');
  scripts.forEach((src, i) => {
    new vm.Script(src, { filename: `app/index.html#script-${i}` });
  });
  new vm.Script(searchEngineSrc, { filename: 'app/search_engine.js' });
  console.log('  ✓ All inline <script> blocks and app/search_engine.js parse with zero syntax errors');

  // Assert no forbidden esc( helper regression
  assert(!/\besc\s*\(/.test(html), 'Found forbidden esc() call instead of escapeHtml()');

  // CSS & Responsive Architecture Checks
  assert(html.includes('--or: #C84B11') || html.includes('--or:#C84B11'), 'Preserves #C84B11 terracotta accent');
  assert(html.includes('--bg: #F8F6F4') || html.includes('--bg:#F8F6F4'), 'Preserves #F8F6F4 warm cream surface');
  assert(html.includes('100dvh'), 'Uses 100dvh viewport safety');
  assert(html.includes('env(safe-area-inset-top)') && html.includes('env(safe-area-inset-bottom)'), 'Uses mobile safe-area insets');
  assert(html.includes('id="desktopTopNav"') && html.includes('backdrop-filter: blur(12px)'), 'Includes blurred sticky desktop top nav');
  assert(html.includes('max-width: 1280px'), 'Includes centered 1280px desktop container');
  assert(html.includes('grid-template-columns: repeat(2, minmax(0, 1fr))'), 'Includes 2-column tablet grid');
  assert(html.includes('grid-template-columns: repeat(3, minmax(0, 1fr))'), 'Includes 3-column desktop grid');
  assert(html.includes('grid-template-columns: minmax(0, 65fr) minmax(320px, 35fr)'), 'Includes 65/35 Cart & Orders split pane');
  assert(html.includes('border-radius: 20px 20px 0 0'), 'Includes mobile bottom-sheet radius');
  assert(html.includes('max-width: 520px'), 'Includes centered 520px desktop dialogs');
  assert(html.includes('prefers-reduced-motion: reduce'), 'Respects prefers-reduced-motion');
  assert(html.includes('id="homeQClearBtn"') && html.includes('id="prodQClearBtn"'), 'Includes × clear search buttons');
  assert(html.includes('class="card-cart-stepper"'), 'Includes inline - / qty / + cart stepper on inventory cards');
  assert(html.includes('id="desktopUsbBarcodeIn"'), 'Includes desktop USB barcode input inside scanner dialog');
  console.log('  ✓ Responsive CSS, layout tokens, 100dvh, safe-areas, grids, split views, and dialogs verified');

  // Test ScrollChromeController behavior across mobile & desktop breakpoints
  const mainScript = scripts.reduce((a, b) => (b.length > a.length ? b : a), '');
  const scrollCtrlSrc = extractConstModule(mainScript, 'ScrollChromeController');

  const topEl = makeFakeElement('div', 'topBar');
  const bottomEl = makeFakeElement('nav', 'bottomNav');
  const scEl = makeFakeElement('div', 'scMain');
  const searchIn = makeFakeElement('input', 'homeQ');
  const screenEl = makeFakeElement('div', 's-search');
  screenEl.style.setProperty = () => {};
  topEl.closest = () => screenEl;
  screenEl.querySelector = sel => {
    if (sel === '.sa-top' || sel === '.search-area' || sel === '.scroll-upper-bar') return topEl;
    if (sel === '.sa-sc' || sel === '.sc') return scEl;
    if (sel === '.bn') return bottomEl;
    if (sel === 'input#homeQ' || sel === 'input#prodQ' || sel === 'input') return searchIn;
    return null;
  };
  let mmListener = null;
  const scrollCtx = {
    window: {
      innerWidth: 390,
      innerHeight: 600,
      addEventListener: () => {},
      removeEventListener: () => {},
      requestAnimationFrame: fn => fn(),
      getComputedStyle: () => ({ paddingTop: '0', paddingBottom: '0' }),
      matchMedia: () => ({
        matches: scrollCtx.window.innerWidth >= 768,
        addEventListener: (_ev, fn) => { mmListener = fn; }
      })
    },
    document: {
      activeElement: null,
      body: makeFakeElement('body', 'body'),
      documentElement: { scrollTop: 0, scrollHeight: 600, clientHeight: 600 },
      getElementById: id => (id === 's-search' ? screenEl : (id === 'homeQ' ? searchIn : null)),
      querySelectorAll: sel => (sel === '[data-scroll-chrome]' ? [topEl, bottomEl] : []),
      addEventListener: () => {},
      removeEventListener: () => {}
    },
    getComputedStyle: () => ({ paddingTop: '0', paddingBottom: '0' }),
    requestAnimationFrame: fn => fn(),
    setTimeout,
    clearTimeout
  };
  scrollCtx.window.document = scrollCtx.document;
  vm.createContext(scrollCtx);
  vm.runInContext(scrollCtrlSrc, scrollCtx);

  const ctrl = scrollCtx.window.ScrollChromeController;
  ctrl.attachToScreen('s-search');
  // Scroll down past 25px with deltaY > 8px -> hide both bars on mobile
  scEl.scrollTop = 45;
  scEl.dispatch('scroll');
  assert(topEl.classList.contains('sa-bar-hidden') && bottomEl.classList.contains('sa-bar-hidden'), 'Mobile scroll down past 25px hides top & bottom chrome');

  // Simulate iOS/Android bottom rubber-band bounce (scrollTop > maxScroll = 600), then upward gesture (-10px)
  scEl.scrollTop = 640; // Clamps to 600
  scEl.dispatch('scroll');
  scEl.scrollTop = 590; // Delta from clamped 600 is -10 (< -4)
  scEl.dispatch('scroll');
  assert(!topEl.classList.contains('sa-bar-hidden') && !bottomEl.classList.contains('sa-bar-hidden'), 'Upward scroll reveals bars even from rubber-band bounce');

  // Search focus override locks upper bar visible and hides bottom bar on mobile
  scEl.scrollTop = 100;
  scEl.dispatch('scroll');
  scrollCtx.document.activeElement = searchIn;
  searchIn.dispatch('focus');
  assert(!topEl.classList.contains('sa-bar-hidden') && bottomEl.classList.contains('sa-bar-hidden'), 'Focused search locks top bar and hides mobile bottom nav');
  scrollCtx.document.activeElement = null;

  // Desktop breakpoint >= 768px disables auto-hide & clears hidden state on resize
  scrollCtx.window.innerWidth = 1280;
  if (typeof mmListener === 'function') mmListener({ matches: true });
  ctrl.reset();
  scEl.scrollTop = 180;
  scEl.dispatch('scroll');
  assert(!topEl.classList.contains('sa-bar-hidden') && !bottomEl.classList.contains('sa-bar-hidden'), 'Desktop >= 768px keeps bars visible and resets chrome on resize');
  console.log('  ✓ ScrollChromeController mobile hiding, rubber-band clamped reveal, search override & desktop lock verified');

  // Test search_engine.js attachSearchUI dropdown + backdrop + quick-add + Enter vs Shift+Enter
  const ddParent = makeFakeElement('div', 'body');
  const searchRow = makeFakeElement('div', 'row');
  searchRow.getBoundingClientRect = () => ({ left: 16, right: 390, top: 14, bottom: 60, width: 374, height: 46 });
  const homeInput = makeFakeElement('input', 'homeQ');
  const searchArea = makeFakeElement('div', 'searchArea');
  searchArea.getBoundingClientRect = () => ({ left: 0, right: 412, top: 0, bottom: 110, width: 412, height: 110 });
  homeInput.closest = sel => (sel === '.search-row' ? searchRow : (sel === '.search-area' ? searchArea : null));
  const ddEl = makeFakeElement('div', 'homeSearchDropdown');
  const byId = { homeQ: homeInput, homeSearchDropdown: ddEl };

  const seCtx = {
    module: { exports: {} },
    window: { innerWidth: 1200, innerHeight: 800, addEventListener: () => {} },
    document: {
      activeElement: homeInput,
      body: ddParent,
      getElementById: id => byId[id] || null,
      addEventListener: () => {},
      removeEventListener: () => {}
    },
    setTimeout: fn => { fn(); return 1; },
    clearTimeout: () => {}
  };
  seCtx.document.createElement = tag => {
    const created = makeFakeElement(tag, '');
    return new Proxy(created, {
      set(target, prop, val) {
        target[prop] = val;
        if (prop === 'id' && val) byId[val] = target;
        return true;
      }
    });
  };
  seCtx.window.document = seCtx.document;
  vm.createContext(seCtx);
  vm.runInContext(searchEngineSrc, seCtx);

  const se = seCtx.module.exports;
  se.init([
    { barcode: 'BP-991', name: 'Front Disc Pad', brand: 'Brembo', loc: 'R1L1B2', stock: 8, mrp: 450, batches: [{ batch_id: 'B1', mrp: 450, stock: 8 }], compat: ['Pulsar'] }
  ]);
  let inspected = null;
  let quickAdded = null;
  se.attachSearchUI(homeInput, {
    dropdownId: 'homeSearchDropdown',
    onSelect: p => { inspected = p; },
    onQuickAdd: p => { quickAdded = p; }
  });

  homeInput.value = 'disc';
  homeInput.dispatch('input');
  assert.strictEqual(ddEl.style.width, '374px', 'Search dropdown spans full .search-row width');
  assert(byId['homeSearchDropdownBackdrop'] && byId['homeSearchDropdownBackdrop'].style.display === 'block', 'Search dropdown reveals dimmed backdrop');
  const renderedRows = ddEl.querySelectorAll('.psd-item');
  assert(renderedRows.length > 0 && renderedRows[0].innerHTML.includes('psd-quick-add-btn'), 'Search dropdown renders + quick-add button next to stock');

  homeInput.dispatch('keydown', { key: 'ArrowDown', preventDefault: () => {} });
  homeInput.dispatch('keydown', { key: 'Enter', shiftKey: false, preventDefault: () => {} });
  assert.strictEqual(quickAdded && quickAdded.barcode, 'BP-991', 'Enter on highlighted search item quick-adds to Cart');
  assert.strictEqual(inspected, null, 'Plain Enter does not open details modal');

  homeInput.value = 'disc';
  homeInput.dispatch('input');
  homeInput.dispatch('keydown', { key: 'ArrowDown', preventDefault: () => {} });
  homeInput.dispatch('keydown', { key: 'Enter', shiftKey: true, preventDefault: () => {} });
  assert.strictEqual(inspected && inspected.barcode, 'BP-991', 'Shift+Enter on highlighted search item opens product details');
  console.log('  ✓ Search UI full-width dropdown, dimmed backdrop, + quick-add & Enter vs Shift+Enter verified');

  // Test KeyboardShortcutController
  const kbSrc = extractConstModule(mainScript, 'KeyboardShortcutController');
  const navCalls = [];
  const cleared = [];
  let scannerToggles = 0;
  let newProdOpens = 0;
  let adhocScans = 0;
  let moreOpens = 0;
  let cartSubmitted = 0;

  const kbSearch = makeFakeElement('div', 's-search');
  kbSearch.classList.add('on');
  const kbHomeQ = makeFakeElement('input', 'homeQ');
  const kbDd = makeFakeElement('div', 'homeSearchDropdown');
  const kbDoc = {
    activeElement: null,
    body: makeFakeElement('body', 'body'),
    querySelector: sel => (sel === '.S.on' ? kbSearch : null),
    getElementById: id => ({ homeQ: kbHomeQ, homeSearchDropdown: kbDd }[id] || null),
    _listeners: {},
    addEventListener: (ev, fn) => { kbDoc._listeners[ev] = fn; }
  };
  kbHomeQ._ownerDoc = kbDoc;
  kbDoc.activeElement = kbDoc.body;

  const kbCtx = {
    window: {},
    document: kbDoc,
    nav: s => { navCalls.push(s); kbSearch.id = s; },
    startAdhocScan: () => { adhocScans++; },
    openMore: () => { moreOpens++; },
    toggleQuickBarcodeScanner: () => { scannerToggles++; },
    openNewProductDialog: () => { newProdOpens++; },
    startFreePickSession: () => { cartSubmitted++; },
    clearHomeSearch: () => { kbHomeQ.value = ''; cleared.push('query'); },
    INVENTORY_LOC_FILTER: 'R1L1B1',
    INVENTORY_BRAND_FILTER: 'Brembo',
    clearInventoryLocFilter: () => { kbCtx.INVENTORY_LOC_FILTER = ''; cleared.push('loc'); },
    clearInventoryBrandFilter: () => { kbCtx.INVENTORY_BRAND_FILTER = ''; cleared.push('brand'); },
    setTimeout,
    clearTimeout
  };
  vm.createContext(kbCtx);
  vm.runInContext(kbSrc, kbCtx);
  kbCtx.window.KeyboardShortcutController.init();

  const fireKey = (opts) => {
    let prevented = false;
    kbDoc._listeners.keydown({ preventDefault: () => { prevented = true; }, ...opts });
    return prevented;
  };

  // '/' focuses search and selects text when not typing in an input
  kbHomeQ.value = 'brake';
  assert(fireKey({ key: '/', target: kbDoc.body }), '/ handled globally');
  // '/' is ignored inside editable input
  assert(!fireKey({ key: '/', target: kbHomeQ }), '/ ignored when inside input');
  // Ctrl+K focuses search even when inside another control
  assert(fireKey({ key: 'k', ctrlKey: true, target: kbHomeQ }), 'Ctrl+K handled');
  // Layered Esc: open dropdown & blur -> clear query -> clear loc -> clear brand
  kbDd.style.display = 'block';
  kbDoc.activeElement = kbHomeQ;
  assert(fireKey({ key: 'Escape' }) && kbDd.style.display === 'none' && kbDoc.activeElement !== kbHomeQ, 'Esc layer 1 closes dropdown & blurs');
  assert(fireKey({ key: 'Escape' }) && kbHomeQ.value === '' && cleared[0] === 'query', 'Esc layer 2 clears query');
  assert(fireKey({ key: 'Escape' }) && cleared[1] === 'loc', 'Esc layer 3 clears location pill filter');
  assert(fireKey({ key: 'Escape' }) && cleared[2] === 'brand', 'Esc layer 4 clears brand pill filter');

  // Alt+1..5, F2 / Alt+B, Alt+N, Ctrl+Enter
  fireKey({ key: '1', altKey: true });
  fireKey({ key: '2', altKey: true });
  fireKey({ key: 'Enter', ctrlKey: true });
  fireKey({ key: '3', altKey: true });
  fireKey({ key: '4', altKey: true });
  fireKey({ key: '5', altKey: true });
  fireKey({ key: 'F2' });
  fireKey({ key: 'b', altKey: true });
  fireKey({ key: 'n', altKey: true });
  assert.deepStrictEqual(navCalls, ['s-orders', 's-cart', 's-search'], 'Alt+1/2/4 navigate Orders, Cart, Inventory');
  assert.strictEqual(adhocScans, 1, 'Alt+3 triggers Scan');
  assert.strictEqual(moreOpens, 1, 'Alt+5 triggers More');
  assert.strictEqual(cartSubmitted, 1, 'Ctrl+Enter submits active Cart session');
  assert.strictEqual(scannerToggles, 2, 'F2 and Alt+B toggle barcode scanner');
  assert.strictEqual(newProdOpens, 1, 'Alt+N opens Add New Product dialog');
  console.log('  ✓ KeyboardShortcutController (/, Ctrl+K, layered Esc, Alt+1..5, F2, Alt+B, Alt+N, Ctrl+Enter) verified');

  console.log('\n----------------------------------------------------------------------');
  console.log('RESULT: ALL RESPONSIVE MOBILE + PC WORKSTATION CHECKS PASSED.');
  console.log('----------------------------------------------------------------------');
}

runSuite();
