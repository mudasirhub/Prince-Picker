/**
 * Supabase Inventory Synchronization Engine
 */
(function(window) {
  async function downloadAllInventory() {
    const client = window.SUPABASE_CLIENT ? window.SUPABASE_CLIENT.instance : null;
    if (!client) {
      console.warn('[Inventory] Supabase client offline. Using local database.');
      return await window.PICKER_DB.getAllInventory();
    }

    try {
      const { data, error } = await client
        .from('inventory')
        .select('*');

      if (error) {
        console.error('[Inventory] Error fetching inventory:', error);
        return await window.PICKER_DB.getAllInventory();
      }

      if (data && Array.isArray(data)) {
        await window.PICKER_DB.putInventory(data);
      }
      return await window.PICKER_DB.getAllInventory();
    } catch (e) {
      console.error('[Inventory] Exception fetching inventory:', e);
      return await window.PICKER_DB.getAllInventory();
    }
  }

  async function syncInventoryIncremental(lastSyncTimestamp) {
    const client = window.SUPABASE_CLIENT ? window.SUPABASE_CLIENT.instance : null;
    if (!client || !lastSyncTimestamp) {
      return await downloadAllInventory();
    }

    try {
      const { data, error } = await client
        .from('inventory')
        .select('*')
        .gt('updated_at', lastSyncTimestamp);

      if (error) {
        console.warn('[Inventory] Incremental sync error:', error);
        return { updatedCount: 0, inventory: await window.PICKER_DB.getAllInventory() };
      }

      if (data && data.length > 0) {
        await window.PICKER_DB.putInventory(data);
        console.log(`[Inventory] Incremental sync updated ${data.length} inventory items.`);
        return { updatedCount: data.length, inventory: await window.PICKER_DB.getAllInventory() };
      }
      return { updatedCount: 0, inventory: await window.PICKER_DB.getAllInventory() };
    } catch (e) {
      console.error('[Inventory] Incremental sync exception:', e);
      return { updatedCount: 0, inventory: await window.PICKER_DB.getAllInventory() };
    }
  }

  async function updateInventory(sku, availableQty) {
    // 1. Always update local IndexedDB immediately for 0-latency UI
    await window.PICKER_DB.updateInventoryItem(sku, availableQty);

    const client = window.SUPABASE_CLIENT ? window.SUPABASE_CLIENT.instance : null;
    const timestamp = new Date().toISOString();

    if (!client) {
      // Offline: queue sync task
      await window.PICKER_DB.addSyncQueue('update_inventory', { sku, available_qty: availableQty, updated_at: timestamp });
      return { synced: false, queued: true };
    }

    try {
      const { error } = await client
        .from('inventory')
        .upsert({ sku, available_qty: availableQty, updated_at: timestamp });

      if (error) {
        await window.PICKER_DB.addSyncQueue('update_inventory', { sku, available_qty: availableQty, updated_at: timestamp });
        return { synced: false, queued: true };
      }
      return { synced: true, queued: false };
    } catch (e) {
      await window.PICKER_DB.addSyncQueue('update_inventory', { sku, available_qty: availableQty, updated_at: timestamp });
      return { synced: false, queued: true };
    }
  }

  window.SUPABASE_INVENTORY = {
    downloadAllInventory,
    syncInventoryIncremental,
    updateInventory
  };
})(typeof window !== 'undefined' ? window : this);
