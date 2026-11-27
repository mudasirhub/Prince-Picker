/**
 * IndexedDB Local Database Engine for Prince Picker
 * Primary runtime database for 100% offline-first operations.
 */
(function(window) {
  const DB_NAME = 'PrincePickerDB';
  const DB_VERSION = 2;
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        // Products store
        if (!db.objectStoreNames.contains('products')) {
          const prodStore = db.createObjectStore('products', { keyPath: 'sku' });
          prodStore.createIndex('barcode', 'barcode', { unique: false });
          prodStore.createIndex('updated_at', 'updated_at', { unique: false });
          prodStore.createIndex('category', 'category', { unique: false });
        }
        // Product batches store (Multi-MRP & Batch ID)
        if (!db.objectStoreNames.contains('product_batches')) {
          const batchStore = db.createObjectStore('product_batches', { keyPath: 'id' });
          batchStore.createIndex('product_id', 'product_id', { unique: false });
          batchStore.createIndex('batch_id', 'batch_id', { unique: false });
          batchStore.createIndex('created_at', 'created_at', { unique: false });
        }
        // Inventory store
        if (!db.objectStoreNames.contains('inventory')) {
          const invStore = db.createObjectStore('inventory', { keyPath: 'sku' });
          invStore.createIndex('updated_at', 'updated_at', { unique: false });
        }
        // Meta store
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
        // Sync queue for offline writes
        if (!db.objectStoreNames.contains('sync_queue')) {
          db.createObjectStore('sync_queue', { keyPath: 'id', autoIncrement: true });
        }
      };

      request.onsuccess = (e) => resolve(e.target.result);
      request.onerror = (e) => {
        console.error('[IndexedDB] Failed to open database:', e.target.error);
        reject(e.target.error);
      };
    });
    return dbPromise;
  }

  // Meta Store Helpers
  async function getMeta(key) {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction('meta', 'readonly');
      const store = tx.objectStore('meta');
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : null);
      req.onerror = () => resolve(null);
    });
  }

  async function setMeta(key, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('meta', 'readwrite');
      const store = tx.objectStore('meta');
      const req = store.put({ key, value });
      req.onsuccess = () => resolve(true);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  // Products Store Helpers
  async function getAllProducts() {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction('products', 'readonly');
      const store = tx.objectStore('products');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  }

  async function putProducts(products) {
    if (!Array.isArray(products) || products.length === 0) return;
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('products', 'readwrite');
      const store = tx.objectStore('products');
      products.forEach(p => {
        if (!p) return;
        const skuKey = String(p.sku || p.barcode || p.id || '');
        if (!skuKey) return;
        const item = {
          ...p,
          id: String(p.id || p.barcode || skuKey),
          sku: skuKey,
          name: p.name || '(No Name)',
          barcode: String(p.barcode || skuKey),
          loc: p.loc || p.location || p.primary_location || '',
          location: p.location || p.loc || p.primary_location || '',
          primary_storage: p.primary_storage || p.storage_type || ((p.location || p.loc || '').toUpperCase().startsWith('W') ? 'WAREHOUSE' : 'SHOP'),
          primary_location: p.primary_location || p.location || p.loc || '',
          storage_type: p.storage_type || p.primary_storage || ((p.location || p.loc || '').toUpperCase().startsWith('W') ? 'WAREHOUSE' : 'SHOP'),
          locations: Array.isArray(p.locations) ? p.locations : [],
          category: p.category || p.brand || '',
          brand: p.brand || '',
          mrp: Number(p.mrp || p.price || 0),
          sp: Number(p.sp || p.mrp || 0),
          stock: Number(p.stock ?? p.qty ?? p.available_qty ?? 0),
          qty: Number(p.qty ?? p.stock ?? p.available_qty ?? 0),
          threshold: Number(p.threshold !== undefined && p.threshold !== null ? p.threshold : 5),
          fitment_group: p.fitment_group || '',
          compatibility: Array.isArray(p.compatibility) ? p.compatibility : [],
          batches: Array.isArray(p.batches) ? p.batches : [],
          images: Array.isArray(p.images) && p.images.length > 0 ? p.images : (p.image ? [{ id: 'img_primary', url: p.image, mime: 'image/webp' }] : []),
          image: p.image || (Array.isArray(p.images) && p.images[0] ? (p.images[0].url || p.images[0]) : ''),
          updated_at: p.updated_at || new Date().toISOString()
        };
        store.put(item);
      });
      tx.oncomplete = () => resolve(true);
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  async function getProductById(id) {
    if (!id) return null;
    const db = await openDB();
    const cleanId = String(id).trim();
    return new Promise((resolve) => {
      const tx = db.transaction('products', 'readonly');
      const store = tx.objectStore('products');
      const req = store.get(cleanId);
      req.onsuccess = () => {
        if (req.result) return resolve(req.result);
        try {
          const idx = store.index('barcode');
          const idxReq = idx.get(cleanId);
          idxReq.onsuccess = () => resolve(idxReq.result || null);
          idxReq.onerror = () => resolve(null);
        } catch (e) {
          resolve(null);
        }
      };
      req.onerror = () => resolve(null);
    });
  }

  // Inventory Store Helpers
  async function getAllInventory() {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction('inventory', 'readonly');
      const store = tx.objectStore('inventory');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  }

  async function putInventory(inventoryItems) {
    if (!Array.isArray(inventoryItems) || inventoryItems.length === 0) return;
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('inventory', 'readwrite');
      const store = tx.objectStore('inventory');
      inventoryItems.forEach(item => {
        store.put({
          sku: String(item.sku),
          available_qty: Number(item.available_qty ?? item.stock ?? 0),
          updated_at: item.updated_at || new Date().toISOString()
        });
      });
      tx.oncomplete = () => resolve(true);
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  async function updateInventoryItem(sku, availableQty) {
    const db = await openDB();
    const updated_at = new Date().toISOString();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['inventory', 'products'], 'readwrite');
      const invStore = tx.objectStore('inventory');
      const prodStore = tx.objectStore('products');

      invStore.put({ sku: String(sku), available_qty: Number(availableQty), updated_at });

      const prodReq = prodStore.get(String(sku));
      prodReq.onsuccess = () => {
        if (prodReq.result) {
          const prod = prodReq.result;
          prod.stock = Number(availableQty);
          prod.updated_at = updated_at;
          prodStore.put(prod);
        }
      };

      tx.oncomplete = () => resolve(true);
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  // Sync Queue Helpers
  async function addSyncQueue(type, payload) {
    const queue = await getSyncQueue();
    const existing = queue.find(q => {
      if (q.type !== type) return false;
      if (type === 'save_product' || type === 'upsert_product') {
        const qId = q.payload?.id || q.payload?.sku || q.payload?.barcode;
        const pId = payload?.id || payload?.sku || payload?.barcode;
        return qId && pId && String(qId) === String(pId);
      }
      if (type === 'update_inventory') {
        return q.payload?.sku && payload?.sku && String(q.payload.sku) === String(payload.sku);
      }
      if (type === 'save_batch') {
        return q.payload?.product_id && payload?.product_id &&
          String(q.payload.product_id) === String(payload.product_id) &&
          String(q.payload.batch_id || '').trim().toUpperCase() === String(payload.batch_id || '').trim().toUpperCase();
      }
      return false;
    });

    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('sync_queue', 'readwrite');
      const store = tx.objectStore('sync_queue');
      const itemToSave = {
        type,
        payload,
        timestamp: new Date().toISOString(),
        created_at: existing ? (existing.created_at || Date.now()) : Date.now(),
        retries: existing ? (existing.retries || 0) : 0
      };
      if (existing && existing.id !== undefined) {
        itemToSave.id = existing.id;
      }
      const req = store.put(itemToSave);
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async function getSyncQueue() {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction('sync_queue', 'readonly');
      const store = tx.objectStore('sync_queue');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  }

  async function removeSyncQueue(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('sync_queue', 'readwrite');
      const store = tx.objectStore('sync_queue');
      const req = store.delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  // Product Batches Store Helpers (Batch ID & Multi-MRP)
  async function getAllBatches() {
    const db = await openDB();
    if (!db.objectStoreNames.contains('product_batches')) return [];
    return new Promise((resolve) => {
      const tx = db.transaction('product_batches', 'readonly');
      const store = tx.objectStore('product_batches');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    });
  }

  async function getBatchesByProduct(productId) {
    if (!productId) return [];
    const db = await openDB();
    if (!db.objectStoreNames.contains('product_batches')) return [];
    const cleanId = String(productId).trim();
    return new Promise((resolve) => {
      const tx = db.transaction('product_batches', 'readonly');
      const store = tx.objectStore('product_batches');
      try {
        const idx = store.index('product_id');
        const req = idx.getAll(cleanId);
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch (e) {
        resolve([]);
      }
    });
  }

  async function putBatches(batches) {
    if (!Array.isArray(batches) || batches.length === 0) return;
    const db = await openDB();
    if (!db.objectStoreNames.contains('product_batches')) return;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('product_batches', 'readwrite');
      const store = tx.objectStore('product_batches');
      let prodIdx = null;
      try { prodIdx = store.index('product_id'); } catch (e) {}

      batches.forEach(b => {
        if (!b || !b.product_id || !b.batch_id) return;
        const prodId = String(b.product_id).trim();
        const batchId = String(b.batch_id).trim();
        const id = String(b.id || `${prodId}::${batchId}`);
        const item = {
          ...b,
          id,
          product_id: prodId,
          sku: String(b.sku || prodId),
          batch_id: batchId,
          mrp: Number(b.mrp || 0),
          stock_qty: Math.max(0, Number(b.stock_qty ?? b.qty ?? 0)),
          location: String(b.location || b.loc || ''),
          created_at: b.created_at || new Date().toISOString(),
          updated_at: b.updated_at || new Date().toISOString()
        };
        if (prodIdx) {
          const req = prodIdx.getAll(prodId);
          req.onsuccess = () => {
            const existing = req.result || [];
            existing.forEach(ex => {
              if (ex && ex.id !== id && String(ex.batch_id || '').trim().toUpperCase() === batchId.toUpperCase()) {
                store.delete(ex.id);
              }
            });
            store.put(item);
          };
          req.onerror = () => store.put(item);
        } else {
          store.put(item);
        }
      });
      tx.oncomplete = () => resolve(true);
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  async function deleteBatch(id) {
    if (!id) return false;
    const db = await openDB();
    if (!db.objectStoreNames.contains('product_batches')) return false;
    return new Promise((resolve) => {
      const tx = db.transaction('product_batches', 'readwrite');
      const store = tx.objectStore('product_batches');
      store.delete(String(id));
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  }

  async function clearDatabase() {
    const db = await openDB();
    const stores = ['products', 'inventory', 'meta', 'sync_queue'];
    if (db.objectStoreNames.contains('product_batches')) stores.push('product_batches');
    return new Promise((resolve, reject) => {
      const tx = db.transaction(stores, 'readwrite');
      stores.forEach(s => tx.objectStore(s).clear());
      tx.oncomplete = () => resolve(true);
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  async function purgeDemoProducts() {
    try {
      const db = await openDB();
      const demoSkus = [
        'RBC-HON-001','FDP-BAJ-002','EOF-YAM-003','CPS-HER-004','AFS-KN-005',
        'ISP-NGK-006','WBP-BSH-007','CSK-HON-008','HLB-PHL-009','CAF-MOB-010',
        'TCB-BAJ-011','BAT-AMA-012','BFC-CAS-013','PRS-HON-014','GSC-SUZ-015',
        '8901234560001','8901234560002','8901234560003','8901234560004','8901234560005',
        '8901234560006','8901234560007','8901234560008','8901234560009','8901234560010',
        '8901234560011','8901234560012','8901234560013','8901234560014','8901234560015'
      ];
      return new Promise((resolve) => {
        const tx = db.transaction('products', 'readwrite');
        const store = tx.objectStore('products');
        demoSkus.forEach(key => store.delete(key));
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    } catch (e) {
      return false;
    }
  }

  async function deleteProduct(identifier) {
    if (!identifier) return false;
    const targetStr = String(identifier);
    try {
      const db = await openDB();
      const stores = db.objectStoreNames.contains('product_batches') ? ['products', 'product_batches'] : ['products'];
      return new Promise((resolve) => {
        const tx = db.transaction(stores, 'readwrite');
        const store = tx.objectStore('products');
        
        // 1. Direct delete by primary key 'sku'
        store.delete(targetStr);

        // 2. Also search by barcode index and delete matching records
        try {
          const barcodeIdx = store.index('barcode');
          const getReq = barcodeIdx.getAll(targetStr);
          getReq.onsuccess = () => {
            const matches = getReq.result || [];
            matches.forEach(item => {
              if (item && item.sku) store.delete(item.sku);
            });
          };
        } catch (eIdx) {}

        // 3. Clean up any matching product_batches rows
        if (stores.includes('product_batches')) {
          try {
            const batchStore = tx.objectStore('product_batches');
            const pIdx = batchStore.index('product_id');
            const bReq = pIdx.getAll(targetStr);
            bReq.onsuccess = () => {
              (bReq.result || []).forEach(b => {
                if (b && b.id) batchStore.delete(b.id);
              });
            };
          } catch (eBatch) {}
        }

        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      });
    } catch (e) {
      console.error('[PICKER_DB] deleteProduct exception:', e);
      return false;
    }
  }

  window.PICKER_DB = {
    openDB,
    getMeta,
    setMeta,
    getAllProducts,
    getProductById,
    putProducts,
    deleteProduct,
    getAllBatches,
    getBatchesByProduct,
    putBatches,
    deleteBatch,
    getAllInventory,
    putInventory,
    updateInventoryItem,
    addSyncQueue,
    getSyncQueue,
    removeSyncQueue,
    clearDatabase,
    purgeDemoProducts
  };
})(typeof window !== 'undefined' ? window : this);
