/**
 * IndexedDB Local Database Engine for Prince Picker
 * Primary runtime database for 100% offline-first operations.
 */
(function(window) {
  const DB_NAME = 'PrincePickerDB';
  const DB_VERSION = 1;
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
        const item = {
          sku: String(p.sku || p.barcode || p.id),
          name: p.name || '(No Name)',
          barcode: String(p.barcode || p.sku || ''),
          loc: p.loc || p.location || '',
          category: p.category || p.brand || '',
          brand: p.brand || '',
          mrp: Number(p.mrp || p.price || 0),
          stock: Number(p.stock || p.available_qty || 0),
          updated_at: p.updated_at || new Date().toISOString()
        };
        store.put(item);
      });
      tx.oncomplete = () => resolve(true);
      tx.onerror = (e) => reject(e.target.error);
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
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('sync_queue', 'readwrite');
      const store = tx.objectStore('sync_queue');
      const req = store.add({
        type,
        payload,
        timestamp: new Date().toISOString(),
        retries: 0
      });
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

  async function clearDatabase() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(['products', 'inventory', 'meta', 'sync_queue'], 'readwrite');
      tx.objectStore('products').clear();
      tx.objectStore('inventory').clear();
      tx.objectStore('meta').clear();
      tx.objectStore('sync_queue').clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  window.PICKER_DB = {
    openDB,
    getMeta,
    setMeta,
    getAllProducts,
    putProducts,
    getAllInventory,
    putInventory,
    updateInventoryItem,
    addSyncQueue,
    getSyncQueue,
    removeSyncQueue,
    clearDatabase
  };
})(typeof window !== 'undefined' ? window : this);
