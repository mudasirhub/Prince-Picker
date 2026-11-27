/**
 * Verification Suite: Centralized Back Navigation Controller (PWA History + Capacitor Android)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log('======================================================================');
console.log('BACK NAVIGATION CONTROLLER — VERIFICATION SUITE');
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

const html = fs.readFileSync(path.join(__dirname, '../app/index.html'), 'utf8');

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
    style: { display: initial.display || '' },
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
    blurCalled: 0,
    blur() {
      this.blurCalled++;
      if (this._doc && this._doc.activeElement === this) {
        this._doc.activeElement = null;
      }
    }
  };
  return el;
}

function extractConstModule(mainScript, constName) {
  const marker = `    const ${constName} = (function () {`;
  const start = mainScript.indexOf(marker);
  if (start < 0) throw new Error(`Module ${constName} not found`);
  const endMarker = `    window.${constName} = ${constName};`;
  const end = mainScript.indexOf(endMarker, start);
  if (end < 0) throw new Error(`End marker for ${constName} not found`);
  return mainScript.slice(start, end + endMarker.length);
}

function createHarness(options = {}) {
  const scripts = extractScriptBlocks(html);
  const mainScript = scripts.reduce((a, b) => (b.length > a.length ? b : a), '');
  const backNavSrc = extractConstModule(mainScript, 'BackNavController');

  const elements = {
    's-search': makeEl('s-search', { classes: ['S', 'on'] }),
    's-orders': makeEl('s-orders', { classes: ['S'] }),
    's-cart': makeEl('s-cart', { classes: ['S'] }),
    's-products': makeEl('s-products', { classes: ['S'] }),
    's-add-product': makeEl('s-add-product', { classes: ['S'] }),
    's-adhoc': makeEl('s-adhoc', { classes: ['S'] }),
    's-drop': makeEl('s-drop', { classes: ['S'] }),
    'homeQ': makeEl('homeQ'),
    'homeSearchDropdown': makeEl('homeSearchDropdown', { display: 'none' }),
    'prodQ': makeEl('prodQ'),
    'prodSearchDropdown': makeEl('prodSearchDropdown', { display: 'none' }),
    'scanner-modal': makeEl('scanner-modal'),
    'manual-input-modal': makeEl('manual-input-modal', { display: 'none' }),
    'prodDetailModal': makeEl('prodDetailModal', { display: 'none' }),
    'pdmAddBatchForm': makeEl('pdmAddBatchForm', { display: 'none' }),
    'pdmFullscreenViewer': makeEl('pdmFullscreenViewer', { display: 'none' }),
    'moreSheet': makeEl('moreSheet'),
    'notifSheet': makeEl('notifSheet'),
    'filterModal': makeEl('filterModal', { display: 'none' }),
    'batchSelectModal': makeEl('batchSelectModal', { display: 'none' }),
    'qrPreviewModal': makeEl('qrPreviewModal', { display: 'none' }),
    'customQrModal': makeEl('customQrModal', { display: 'none' }),
    'auditStartModal': makeEl('auditStartModal', { display: 'none' }),
    'auditResumeModal': makeEl('auditResumeModal', { display: 'none' }),
    'transferResumeModal': makeEl('transferResumeModal', { display: 'none' }),
    'transferLogsModal': makeEl('transferLogsModal', { display: 'none' }),
    'pwaInstallPromptModal': makeEl('pwaInstallPromptModal', { display: 'none' }),
    'installHelpModal': makeEl('installHelpModal', { display: 'none' })
  };

  // Simulated browser session history stack
  const historyEntries = [null];
  let historyIdx = 0;
  let exitedBrowser = false;
  const listeners = {};
  const toasts = [];
  const capListeners = {};
  let capExitCalled = 0;

  const doc = {
    activeElement: null,
    getElementById: (id) => elements[id] || null,
    querySelector: (sel) => {
      if (sel === '.S.on') {
        return Object.values(elements).find(el => el.classList.contains('S') && el.classList.contains('on')) || null;
      }
      return null;
    }
  };
  elements.homeQ._doc = doc;
  elements.prodQ._doc = doc;

  const sandbox = {
    console,
    Date,
    Set,
    Map,
    Array,
    Object,
    String,
    Number,
    Boolean,
    Promise,
    queueMicrotask,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    document: doc,
    window: null,
    history: {
      get state() { return historyEntries[historyIdx]; },
      get length() { return historyEntries.length; },
      replaceState(state) {
        historyEntries[historyIdx] = state;
      },
      pushState(state) {
        historyEntries.splice(historyIdx + 1);
        historyEntries.push(state);
        historyIdx = historyEntries.length - 1;
      },
      go(delta) {
        const next = historyIdx + delta;
        if (next < 0) {
          exitedBrowser = true;
          historyIdx = -1;
          return;
        }
        historyIdx = Math.min(historyEntries.length - 1, next);
        const st = historyEntries[historyIdx];
        setTimeout(() => {
          (listeners.popstate || []).forEach(fn => fn({ state: st }));
        }, 0);
      },
      back() {
        this.go(-1);
      }
    },
    addEventListener(type, fn) {
      listeners[type] = listeners[type] || [];
      listeners[type].push(fn);
    },
    Capacitor: options.capacitorNative ? {
      isNativePlatform: () => true,
      Plugins: {
        App: {
          addListener(ev, fn) {
            capListeners[ev] = capListeners[ev] || [];
            capListeners[ev].push(fn);
          },
          exitApp() { capExitCalled++; }
        }
      }
    } : null,
    PRODUCT_GALLERY: { viewerOpen: false },
    INVENTORY_LOC_FILTER: '',
    INVENTORY_BRAND_FILTER: '',
    adhocState: { timerInt: null },
    ScrollLockManager: {
      unlock() { sandbox.BackNavController.sync(); }
    },
    ScrollChromeController: {
      syncCalls: [],
      sync(id) { this.syncCalls.push(id); }
    },
    toast(msg) { toasts.push(msg); },
    nav(screenId) {
      Object.values(elements).forEach(el => {
        if (el.classList.contains('S')) el.classList.remove('on');
      });
      if (elements[screenId]) elements[screenId].classList.add('on');
      sandbox.BackNavController.onScreenChange(screenId);
    },
    closePdmFullscreen() {
      sandbox.PRODUCT_GALLERY.viewerOpen = false;
      elements.pdmFullscreenViewer.style.display = 'none';
      sandbox.BackNavController.sync();
    },
    togglePdmAddBatchForm(force) {
      elements.pdmAddBatchForm.style.display = force ? 'block' : 'none';
      sandbox.BackNavController.sync();
    },
    closeProdDetail() {
      elements.prodDetailModal.style.display = 'none';
      elements.pdmAddBatchForm.style.display = 'none';
      sandbox.PRODUCT_GALLERY.viewerOpen = false;
      elements.pdmFullscreenViewer.style.display = 'none';
      sandbox.BackNavController.sync();
    },
    closeScanner() {
      elements['scanner-modal'].classList.remove('on');
      sandbox.BackNavController.sync();
    },
    closeManualEntryModal() {
      elements['manual-input-modal'].style.display = 'none';
      sandbox.BackNavController.sync();
    },
    closeMore() {
      elements.moreSheet.classList.remove('open');
      sandbox.BackNavController.sync();
    },
    closeFilterModal() {
      elements.filterModal.style.display = 'none';
      sandbox.BackNavController.sync();
    },
    clearInventoryLocFilter() {
      sandbox.INVENTORY_LOC_FILTER = '';
      sandbox.BackNavController.onFilterChange('loc', '');
    },
    clearInventoryBrandFilter() {
      sandbox.INVENTORY_BRAND_FILTER = '';
      sandbox.BackNavController.onFilterChange('brand', '');
    },
    renderSearch(q) {
      sandbox._lastSearch = q;
      sandbox.BackNavController.sync();
    },
    stopInlineScanner() { sandbox._stoppedInlineScanner = true; },
    stopDropInlineScanner() { sandbox._stoppedDropScanner = true; }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(backNavSrc, sandbox);
  sandbox.BackNavController.init();

  const flush = () => new Promise(r => setTimeout(r, 20));
  const simulatePwaBack = async () => {
    sandbox.history.back();
    await flush();
  };
  const simulateCapacitorBack = async () => {
    (capListeners.backButton || []).forEach(fn => fn());
    await flush();
  };

  return {
    sandbox,
    elements,
    doc,
    toasts,
    historyEntries,
    getHistoryIdx: () => historyIdx,
    hasExitedBrowser: () => exitedBrowser,
    getCapExitCalled: () => capExitCalled,
    flush,
    simulatePwaBack,
    simulateCapacitorBack
  };
}

test('All inline script blocks in app/index.html parse cleanly', () => {
  const scripts = extractScriptBlocks(html);
  scripts.forEach((src, i) => {
    assert.doesNotThrow(() => new vm.Script(src), `Script block #${i} syntax error`);
  });
});

test('PWA: Back steps one layer at a time through scanner -> modal -> pill filters -> search -> tabs -> double-back exit', async () => {
  const h = createHarness();
  await h.flush();

  // Base guard should be at index 1 (ppBase at 0, ppGuard at 1)
  assert.strictEqual(h.getHistoryIdx(), 1);

  // Navigate to Products tab, open Product Detail, open Add Batch Form, open Fullscreen Viewer, open Scanner
  h.sandbox.nav('s-products');
  await h.flush();
  h.elements.prodDetailModal.style.display = 'flex';
  h.sandbox.BackNavController.sync();
  await h.flush();
  h.sandbox.togglePdmAddBatchForm(true);
  await h.flush();
  h.sandbox.PRODUCT_GALLERY.viewerOpen = true;
  h.elements.pdmFullscreenViewer.style.display = 'flex';
  h.sandbox.BackNavController.sync();
  await h.flush();

  assert.strictEqual(h.sandbox.BackNavController.getStateSnapshot().desiredStack.length, 4);

  // Press 1: closes pdmFullscreenViewer
  await h.simulatePwaBack();
  assert.strictEqual(h.sandbox.PRODUCT_GALLERY.viewerOpen, false);
  assert.strictEqual(h.elements.prodDetailModal.style.display, 'flex');

  // Press 2: closes pdmAddBatchForm
  await h.simulatePwaBack();
  assert.strictEqual(h.elements.pdmAddBatchForm.style.display, 'none');
  assert.strictEqual(h.elements.prodDetailModal.style.display, 'flex');

  // Press 3: closes prodDetailModal
  await h.simulatePwaBack();
  assert.strictEqual(h.elements.prodDetailModal.style.display, 'none');
  assert.strictEqual(h.elements['s-products'].classList.contains('on'), true);

  // Press 4: returns from s-products to Inventory (s-search)
  await h.simulatePwaBack();
  assert.strictEqual(h.elements['s-search'].classList.contains('on'), true);
  assert.strictEqual(h.getHistoryIdx(), 1);

  // Now on Inventory: type search query, apply Brand pill, apply Location pill, focus homeQ, open scanner
  h.elements.homeQ.value = 'brake';
  h.doc.activeElement = h.elements.homeQ;
  h.sandbox.INVENTORY_BRAND_FILTER = 'Hero';
  h.sandbox.BackNavController.onFilterChange('brand', 'Hero');
  h.sandbox.INVENTORY_LOC_FILTER = 'R1L1B1';
  h.sandbox.BackNavController.onFilterChange('loc', 'R1L1B1');
  h.elements['scanner-modal'].classList.add('on');
  h.sandbox.BackNavController.sync();
  await h.flush();

  // Press 5: closes scanner-modal
  await h.simulatePwaBack();
  assert.strictEqual(h.elements['scanner-modal'].classList.contains('on'), false);

  // Press 6 (Sub-step A): blurs focused search input without clearing query/pills
  await h.simulatePwaBack();
  assert.strictEqual(h.elements.homeQ.blurCalled, 1);
  assert.strictEqual(h.sandbox.INVENTORY_LOC_FILTER, 'R1L1B1');
  assert.strictEqual(h.elements.homeQ.value, 'brake');

  // Press 7 (Sub-step B): clears most recent pill filter (Location)
  await h.simulatePwaBack();
  assert.strictEqual(h.sandbox.INVENTORY_LOC_FILTER, '');
  assert.strictEqual(h.sandbox.INVENTORY_BRAND_FILTER, 'Hero');

  // Press 8 (Sub-step B): clears Brand pill filter
  await h.simulatePwaBack();
  assert.strictEqual(h.sandbox.INVENTORY_BRAND_FILTER, '');
  assert.strictEqual(h.elements.homeQ.value, 'brake');

  // Press 9 (Sub-step C): clears search query and restores full list
  await h.simulatePwaBack();
  assert.strictEqual(h.elements.homeQ.value, '');
  assert.strictEqual(h.sandbox._lastSearch, '');
  assert.strictEqual(h.getHistoryIdx(), 1);

  // Press 10 (Root 1st back): arms exit & shows toast, does NOT exit
  await h.simulatePwaBack();
  assert.strictEqual(h.hasExitedBrowser(), false);
  assert.strictEqual(h.toasts[h.toasts.length - 1], 'Press back again to exit');
  assert.strictEqual(h.getHistoryIdx(), 1);

  // Press 11 (Root 2nd back within 2s): exits browser/PWA cleanly
  await h.simulatePwaBack();
  assert.strictEqual(h.hasExitedBrowser(), true);
});

test('Closing modals/sheets/filters via on-screen UI stays synced with history (no ghost back steps)', async () => {
  const h = createHarness();
  await h.flush();

  // Open More sheet, then close it + nav('s-products') in the same synchronous turn
  h.elements.moreSheet.classList.add('open');
  h.sandbox.BackNavController.sync();
  await h.flush();
  assert.strictEqual(h.getHistoryIdx(), 2);

  h.sandbox.closeMore();
  h.sandbox.nav('s-products');
  await h.flush();

  // Still depth 2 (one step for s-products), NOT depth 3!
  assert.strictEqual(h.getHistoryIdx(), 2);

  // Open filterModal, close via UI button
  h.elements.filterModal.style.display = 'flex';
  h.sandbox.BackNavController.sync();
  await h.flush();
  assert.strictEqual(h.getHistoryIdx(), 3);

  h.sandbox.closeFilterModal();
  await h.flush();
  assert.strictEqual(h.getHistoryIdx(), 2);

  // Single hardware back returns directly to Inventory (no ghost filter/more steps)
  await h.simulatePwaBack();
  assert.strictEqual(h.elements['s-search'].classList.contains('on'), true);
  assert.strictEqual(h.getHistoryIdx(), 1);

  // Next back hits root double-back toast immediately
  await h.simulatePwaBack();
  assert.strictEqual(h.toasts[h.toasts.length - 1], 'Press back again to exit');
});

test('Capacitor Android: backButton listener steps cleanly without double-firing and calls exitApp only on 2nd root press', async () => {
  const h = createHarness({ capacitorNative: true });
  await h.flush();

  h.sandbox.nav('s-orders');
  await h.flush();
  h.elements['scanner-modal'].classList.add('on');
  h.sandbox.BackNavController.sync();
  await h.flush();
  h.elements['manual-input-modal'].style.display = 'flex';
  h.sandbox.BackNavController.sync();
  await h.flush();

  assert.strictEqual(h.getHistoryIdx(), 4);

  // 1st native back: closes manual-input-modal (topmost above scanner)
  await h.simulateCapacitorBack();
  assert.strictEqual(h.elements['manual-input-modal'].style.display, 'none');
  assert.strictEqual(h.elements['scanner-modal'].classList.contains('on'), true);
  assert.strictEqual(h.getHistoryIdx(), 3);

  // 2nd native back: closes scanner-modal (did NOT double-fire!)
  await h.simulateCapacitorBack();
  assert.strictEqual(h.elements['scanner-modal'].classList.contains('on'), false);
  assert.strictEqual(h.elements['s-orders'].classList.contains('on'), true);
  assert.strictEqual(h.getHistoryIdx(), 2);

  // 3rd native back: navigates from s-orders back to Inventory (s-search)
  await h.simulateCapacitorBack();
  assert.strictEqual(h.elements['s-search'].classList.contains('on'), true);
  assert.strictEqual(h.getHistoryIdx(), 1);
  assert.strictEqual(h.getCapExitCalled(), 0);

  // 4th native back: shows "Press back again to exit"
  await h.simulateCapacitorBack();
  assert.strictEqual(h.toasts[h.toasts.length - 1], 'Press back again to exit');
  assert.strictEqual(h.getCapExitCalled(), 0);

  // 5th native back within 2s: calls Capacitor App.exitApp()
  await h.simulateCapacitorBack();
  assert.strictEqual(h.getCapExitCalled(), 1);
});

Promise.all(asyncTests).then(() => {
  console.log('\n----------------------------------------------------------------------');
  console.log(`RESULT: ${passed}/${total} tests passed.`);
  if (passed !== total) process.exit(1);
});
