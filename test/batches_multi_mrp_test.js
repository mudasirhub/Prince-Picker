/**
 * Regression & Integration Verification Suite: Batch ID & Multi-MRP Support
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

console.log('======================================================================');
console.log('BATCH ID & MULTI-MRP SUPPORT — VERIFICATION SUITE');
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

function loadBatchesModule(overrides = {}) {
  const code = fs.readFileSync(path.join(__dirname, '../app/supabase/batches.js'), 'utf8');
  const dbBatches = [];
  const queue = [];
  const savedProducts = [];
  const remoteUpserts = [];

  const supabaseInstance = overrides.remoteFails
    ? {
        from: () => ({
          upsert: () => ({
            select: async () => ({ data: null, error: { message: 'Network unreachable' } })
          }),
          select: () => ({ order: async () => ({ data: null, error: { message: 'Network unreachable' } }) })
        })
      }
    : {
        from: (table) => ({
          upsert: (row) => ({
            select: async () => {
              remoteUpserts.push({ table, row });
              return { data: [row], error: null };
            }
          }),
          select: () => ({
            order: async () => ({
              data: remoteUpserts.filter(r => r.table === 'product_batches').map(r => r.row),
              error: null
            })
          })
        })
      };

  const mockWindow = {
    navigator: { onLine: overrides.onLine !== undefined ? overrides.onLine : true },
    PICKER_DB: {
      putBatches: async (items) => {
        for (const it of items) {
          const idx = dbBatches.findIndex(b => b.id === it.id);
          if (idx >= 0) dbBatches[idx] = { ...it };
          else dbBatches.push({ ...it });
        }
      },
      getBatchesByProduct: async (pid) => dbBatches.filter(b => b.product_id === pid || b.sku === pid),
      getAllBatches: async () => [...dbBatches],
      addSyncQueue: async (type, payload) => { queue.push({ type, payload }); },
      putProducts: async (prods) => { savedProducts.push(...prods); }
    },
    SUPABASE_PRODUCTS: {
      saveProduct: async (p) => { savedProducts.push(JSON.parse(JSON.stringify(p))); return { success: true, synced: mockWindow.navigator.onLine }; }
    },
    SUPABASE_CLIENT: {
      instance: supabaseInstance
    },
    syncProductToAppStores: overrides.syncProductToAppStores || null,
    crypto: require('crypto').webcrypto || require('crypto')
  };
  mockWindow.window = mockWindow;

  const sandbox = {
    window: mockWindow,
    navigator: mockWindow.navigator,
    crypto: mockWindow.crypto,
    console,
    Date,
    Math,
    JSON,
    String,
    Number,
    Array,
    Boolean,
    Object,
    Map,
    Set,
    Promise
  };
  vm.runInNewContext(code, sandbox, { filename: 'app/supabase/batches.js' });
  return {
    api: mockWindow.SUPABASE_BATCHES,
    dbBatches,
    queue,
    savedProducts,
    remoteUpserts,
    mockWindow
  };
}

(async function main() {
  const indexPath = path.join(__dirname, '../app/index.html');
  const html = fs.readFileSync(indexPath, 'utf8');

  test('app/index.html loads supabase/batches.js and all inline <script> blocks have valid JS syntax', () => {
    assert(html.includes('<script src="./supabase/batches.js"></script>'), 'Missing batches.js script tag');
    const scripts = [];
    const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      if (/src=|ld\+json/i.test(m[1])) continue;
      scripts.push(m[2]);
    }
    assert.strictEqual(scripts.length, 2, 'Must keep exact 2 inline JS script blocks');
    for (let i = 0; i < scripts.length; i++) {
      new vm.Script(scripts[i], { filename: `app/index.html#inline-${i}` });
    }
  });

  test('Existing screens contain inline Add Batch form & Batch/MRP quick-select sheet without extra pages', () => {
    assert(html.includes('id="pdmBatchesBlock"'), 'Missing #pdmBatchesBlock in #prodDetailModal');
    assert(html.includes('id="pdmAddBatchForm"'), 'Missing #pdmAddBatchForm in #prodDetailModal');
    assert(html.includes('id="pdmBatchIdIn"'), 'Missing Batch ID input #pdmBatchIdIn');
    assert(html.includes('id="pdmBatchMrpIn"'), 'Missing MRP input #pdmBatchMrpIn');
    assert(html.includes('id="pdmBatchQtyIn"'), 'Missing Stock Qty input #pdmBatchQtyIn');
    assert(html.includes('id="pdmBatchLocIn"'), 'Missing Location input #pdmBatchLocIn');
    assert(html.includes('id="batchSelectModal"'), 'Missing #batchSelectModal quick-select sheet');
    assert(html.includes('selectInventoryBatch('), 'Missing Inventory batch pill handler');
    assert(html.includes('openAddBatchForProduct('), 'Missing inline + Batch trigger');
  });

  test('SW static assets, IDB v2 schema, and SQL migration support product_batches & movement batch tracking', () => {
    const sw = fs.readFileSync(path.join(__dirname, '../app/sw.js'), 'utf8');
    const db = fs.readFileSync(path.join(__dirname, '../app/supabase/db.js'), 'utf8');
    const mig = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261127_product_batches.sql'), 'utf8');
    assert(sw.includes("'./supabase/batches.js'"), 'sw.js must precache batches.js');
    assert(!sw.includes("'pa-picker-v20'"), 'sw.js cache name must be bumped past v20');
    assert(db.includes('DB_VERSION = 2'), 'IndexedDB DB_VERSION must be 2');
    assert(db.includes("'product_batches'"), 'IndexedDB must define product_batches store');
    assert(mig.includes('CREATE TABLE IF NOT EXISTS product_batches'), 'SQL migration must create product_batches');
    assert(mig.includes('p_batch_id TEXT DEFAULT NULL'), 'SQL RPC must accept p_batch_id');
    assert(mig.includes('p_unit_mrp NUMERIC DEFAULT NULL'), 'SQL RPC must accept p_unit_mrp');
  });

  test('Legacy single-MRP product resolves to virtual B1 batch transparently', () => {
    const { api } = loadBatchesModule();
    const legacy = {
      id: 'SKU-100',
      sku: 'SKU-100',
      barcode: 'SKU-100',
      name: 'Brake Pad',
      mrp: 100,
      stock: 9,
      location: 'WR1L1B1'
    };
    const batches = api.normalizeBatches(legacy);
    assert.strictEqual(batches.length, 1);
    assert.strictEqual(batches[0].batch_id, 'B1');
    assert.strictEqual(batches[0].mrp, 100);
    assert.strictEqual(batches[0].stock_qty, 9);
    assert.strictEqual(batches[0].location, 'WR1L1B1');
    assert.strictEqual(batches[0]._isVirtualDefault, true);
    assert.strictEqual(api.hasMultiBatches(legacy), false);
    assert.strictEqual(api.suggestNextBatchId(legacy), 'B2');
  });

  await asyncTest('Adding a new batch with different MRP creates B2, syncs total_stock, and preserves FIFO', async () => {
    const { api, dbBatches, remoteUpserts } = loadBatchesModule();
    const prod = {
      id: 'SKU-100',
      sku: 'SKU-100',
      barcode: 'SKU-100',
      name: 'Brake Pad',
      mrp: 100,
      stock: 9,
      location: 'WR1L1B1'
    };

    const res = await api.addOrMergeBatch(prod, {
      batch_id: 'B2',
      mrp: 120,
      stock_qty: 5,
      location: 'WR1L2B3'
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.merged, false);
    assert.strictEqual(res.totalStock, 14);
    assert.strictEqual(prod.stock, 14);
    assert.strictEqual(prod.total_stock, 14);
    assert.strictEqual(prod.batches.length, 2);
    assert.strictEqual(prod.batches[0].batch_id, 'B1');
    assert.strictEqual(prod.batches[1].batch_id, 'B2');
    assert.strictEqual(api.hasMultiBatches(prod), true);
    assert.strictEqual(api.suggestNextBatchId(prod), 'B3');
    assert.strictEqual(api.getDefaultBatch(prod).batch_id, 'B1');
    assert(dbBatches.length >= 2, 'Both B1 and B2 should be stored in IDB');
    assert(remoteUpserts.some(u => u.table === 'product_batches' && u.row.batch_id === 'B2'), 'B2 pushed to Supabase');
  });

  await asyncTest('Adding stock with exact same MRP merges when mergeSameMrp=true or creates new Batch ID when false', async () => {
    const { api } = loadBatchesModule();
    const prod = {
      id: 'SKU-200',
      sku: 'SKU-200',
      mrp: 150,
      stock: 4,
      location: 'SH1L1B1'
    };

    const merged = await api.addOrMergeBatch(prod, {
      batch_id: 'B2',
      mrp: 150,
      stock_qty: 6,
      mergeSameMrp: true
    });
    assert.strictEqual(merged.merged, true);
    assert.strictEqual(merged.batch.batch_id, 'B1');
    assert.strictEqual(merged.batch.stock_qty, 10);
    assert.strictEqual(prod.stock, 10);
    assert.strictEqual(prod.batches.length, 1);

    const sep = await api.addOrMergeBatch(prod, {
      batch_id: 'B2',
      mrp: 150,
      stock_qty: 3,
      mergeSameMrp: false
    });
    assert.strictEqual(sep.merged, false);
    assert.strictEqual(prod.batches.length, 2);
    assert.strictEqual(prod.stock, 13);
  });

  await asyncTest('FIFO skips zero-stock batches and stock deduction targets strict batch_id', async () => {
    const { api } = loadBatchesModule();
    const prod = {
      id: 'SKU-300',
      sku: 'SKU-300',
      mrp: 100,
      stock: 14,
      location: 'WR1L1B1',
      batches: [
        { id: '11111111-1111-4111-8111-111111111111', product_id: 'SKU-300', sku: 'SKU-300', batch_id: 'B1', mrp: 100, stock_qty: 9, location: 'WR1L1B1', created_at: '2026-01-01T00:00:00Z' },
        { id: '22222222-2222-4222-8222-222222222222', product_id: 'SKU-300', sku: 'SKU-300', batch_id: 'B2', mrp: 120, stock_qty: 5, location: 'WR1L2B1', created_at: '2026-01-02T00:00:00Z' }
      ]
    };

    const adj = await api.adjustBatchStock(prod, 'B2', -3);
    assert.strictEqual(adj.success, true);
    assert.strictEqual(prod.batches.find(b => b.batch_id === 'B1').stock_qty, 9);
    assert.strictEqual(prod.batches.find(b => b.batch_id === 'B2').stock_qty, 2);
    assert.strictEqual(prod.stock, 11);

    await api.adjustBatchStock(prod, 'B1', -9);
    assert.strictEqual(prod.batches.find(b => b.batch_id === 'B1').stock_qty, 0);
    assert.strictEqual(prod.stock, 2);
    const active = api.getActiveBatches(prod);
    assert.strictEqual(active.length, 1);
    assert.strictEqual(active[0].batch_id, 'B2');
    assert.strictEqual(api.getDefaultBatch(prod).batch_id, 'B2');
  });

  await asyncTest('Offline batch creation queues save_batch cleanly for later Supabase sync', async () => {
    const { api, queue, dbBatches } = loadBatchesModule({ onLine: false });
    const prod = {
      id: 'SKU-OFF',
      sku: 'SKU-OFF',
      mrp: 80,
      stock: 5,
      location: 'WR2L1B1'
    };

    const res = await api.addOrMergeBatch(prod, {
      batch_id: 'B2',
      mrp: 95,
      stock_qty: 7,
      location: 'WR2L1B2'
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.queued, true);
    assert.strictEqual(res.synced, false);
    assert(queue.some(q => q.type === 'save_batch' && q.payload.batch_id === 'B2'), 'Offline queue must record save_batch');
    assert(dbBatches.some(b => b.batch_id === 'B2'), 'Local IDB must immediately hold offline batch');
  });

  test('Cart keeps B1 (₹100) and B2 (₹120) as separate line items & scanner/pick/logs wire batch_id and unit_mrp', () => {
    assert(html.includes('String(c.batch_id || \'B1\') === batchId') || html.includes("String(c.batch_id || 'B1') === targetBatchId"), 'Cart must distinguish line items by batch_id');
    assert(html.includes('unit_mrp: unitMrp'), 'Cart line item must store unit_mrp');
    assert(html.includes('batchInfo.activeBatches.length > 1'), 'Barcode scan must check multiple active batches');
    assert(html.includes("openBatchSelectModal(p, 1, 'pick')"), 'Barcode scan must open #batchSelectModal for multi-MRP');
    assert(html.includes('batchId: ci.batch_id') && html.includes('unitMrp: ci.unit_mrp'), 'Pick confirmation & scanLoop must pass batchId & unitMrp to inventoryTransaction');
    assert(html.includes("var key = i.sku + '_' + i.intent + (i.batch_id ? '_' + i.batch_id : '')"), 'LogsUI.merge must separate batches by batch_id');
    assert(html.includes('batch_id: item.batch_id || \'\'') && html.includes('unit_mrp: item.unit_mrp ?? null'), 'LogsUI.buildPayload must include batch_id and unit_mrp');
    assert(html.includes('resolvedBatchId'), 'inventoryTransaction must forward resolved FIFO batch_id to processMovement');
    assert(html.includes('window.SUPABASE_BATCHES.downloadAllBatches()'), 'doLogin must download batches');
  });

  await asyncTest('Locations qty stays synced with batch adds/deductions & downloadAllBatches preserves unsynced local batches', async () => {
    const { api, dbBatches } = loadBatchesModule();
    const prod = {
      id: 'SKU-LOC',
      sku: 'SKU-LOC',
      mrp: 100,
      stock: 9,
      location: 'WR1L1B1',
      locations: [{ storage_type: 'WAREHOUSE', location: 'WR1L1B1', qty: 9, is_primary: true }]
    };

    await api.addOrMergeBatch(prod, { batch_id: 'B2', mrp: 120, stock_qty: 5, location: 'WR1L1B1' });
    assert.strictEqual(prod.locations[0].qty, 14, 'Single location qty must match synced total_stock');

    await api.adjustBatchStock(prod, 'B2', -3);
    assert.strictEqual(prod.locations[0].qty, 11, 'Single location qty must reflect batch deduction');

    // Simulate an unsynced local batch remaining in IDB while remote returns B1
    await dbBatches.push({ id: '33333333-3333-4333-8333-333333333333', product_id: 'SKU-LOCAL', sku: 'SKU-LOCAL', batch_id: 'B9', mrp: 250, stock_qty: 2, location: 'WR1L1B1', created_at: '2026-01-03T00:00:00Z' });
    const all = await api.downloadAllBatches();
    assert(all.some(b => b.batch_id === 'B9'), 'downloadAllBatches must return local unsynced batches via getAllBatches');
  });

  test('products.js includes total_stock & mirrored app/supabase migration matches root migration', () => {
    const prodsJs = fs.readFileSync(path.join(__dirname, '../app/supabase/products.js'), 'utf8');
    const rootMig = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261127_product_batches.sql'), 'utf8');
    const appMig = fs.readFileSync(path.join(__dirname, '../app/supabase/migrations/20261127_product_batches.sql'), 'utf8');
    assert(prodsJs.includes('total_stock:'), 'products.js fullPayload must include total_stock');
    assert.strictEqual(appMig, rootMig, 'app/supabase/migrations/20261127_product_batches.sql must match root migration');
  });

  console.log('\n----------------------------------------------------------------------');
  console.log(`RESULT: ${passed}/${total} tests passed.`);
  if (passed !== total) process.exit(1);
})();
