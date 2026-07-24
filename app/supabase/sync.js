/**
 * Supabase Background Sync Engine
 */
(function(window) {
  let isSyncing = false;

  async function runBackgroundSync(onUpdateCallback) {
    if (isSyncing) return;
    isSyncing = true;
    try {
      const lastSync = await window.PICKER_DB.getMeta('lastSync');
      const now = new Date().toISOString();

      // Process offline queue first
      await processOfflineQueue();

      // Incremental sync
      let prodResult, invResult;
      if (lastSync) {
        prodResult = await window.SUPABASE_PRODUCTS.syncProductsIncremental(lastSync);
        invResult = await window.SUPABASE_INVENTORY.syncInventoryIncremental(lastSync);
      } else {
        const products = await window.SUPABASE_PRODUCTS.downloadAllProducts();
        const inventory = await window.SUPABASE_INVENTORY.downloadAllInventory();
        prodResult = { updatedCount: products.length, products };
        invResult = { updatedCount: inventory.length, inventory };
      }

      await window.PICKER_DB.setMeta('lastSync', now);

      if (typeof onUpdateCallback === 'function') {
        onUpdateCallback(prodResult.products, invResult.inventory);
      }
    } catch (e) {
      console.error('[Sync] Background sync exception:', e);
    } finally {
      isSyncing = false;
    }
  }

  async function processOfflineQueue() {
    const queue = await window.PICKER_DB.getSyncQueue();
    if (!queue || queue.length === 0) return;

    const client = window.SUPABASE_CLIENT ? window.SUPABASE_CLIENT.instance : null;
    if (!client) return;

    for (const item of queue) {
      try {
        if (item.type === 'update_inventory') {
          const { error } = await client
            .from('inventory')
            .upsert(item.payload);

          if (!error) {
            await window.PICKER_DB.removeSyncQueue(item.id);
          }
        }
      } catch (e) {
        console.warn('[Sync] Failed to process queue item:', item.id, e);
      }
    }
  }

  window.SUPABASE_SYNC = {
    runBackgroundSync,
    processOfflineQueue
  };
})(typeof window !== 'undefined' ? window : this);
