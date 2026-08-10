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

  async function processMovement(type, sku, qty, location, picker, sessionId) {
    const client = window.SUPABASE_CLIENT ? window.SUPABASE_CLIENT.instance : null;
    const isOnline = typeof navigator !== 'undefined' ? navigator.onLine !== false : true;
    const cleanType = String(type || 'PICK').toUpperCase();
    const cleanQty = Number(qty) || 1;

    if (!client || !isOnline) {
      if (window.PICKER_DB && typeof window.PICKER_DB.addSyncQueue === 'function') {
        await window.PICKER_DB.addSyncQueue('process_movement', { type: cleanType, sku, qty: cleanQty, location, picker, sessionId });
      }
      return { success: true, queued: true, synced: false };
    }

    try {
      const { data, error } = await client.rpc('fn_process_inventory_movement', {
        p_type: cleanType,
        p_sku: sku,
        p_qty: cleanQty,
        p_location: location || '',
        p_picker: picker || 'Picker',
        p_session_id: sessionId || ('SES-' + Date.now())
      });

      if (error) {
        console.warn('[Inventory] RPC movement error, queuing:', error.message);
        if (window.PICKER_DB && typeof window.PICKER_DB.addSyncQueue === 'function') {
          await window.PICKER_DB.addSyncQueue('process_movement', { type: cleanType, sku, qty: cleanQty, location, picker, sessionId });
        }
        return { success: true, queued: true, synced: false, error };
      }

      return { success: true, queued: false, synced: true, data };
    } catch (e) {
      console.error('[Inventory] Exception in processMovement:', e);
      if (window.PICKER_DB && typeof window.PICKER_DB.addSyncQueue === 'function') {
        await window.PICKER_DB.addSyncQueue('process_movement', { type: cleanType, sku, qty: cleanQty, location, picker, sessionId });
      }
      return { success: true, queued: true, synced: false, error: e };
    }
  }

  async function commitAuditSession(auditId, picker, items) {
    const client = window.SUPABASE_CLIENT ? window.SUPABASE_CLIENT.instance : null;
    const isOnline = typeof navigator !== 'undefined' ? navigator.onLine !== false : true;

    if (!client || !isOnline) {
      if (window.PICKER_DB && typeof window.PICKER_DB.addSyncQueue === 'function') {
        await window.PICKER_DB.addSyncQueue('commit_audit', { auditId, picker, items });
      }
      return { success: true, queued: true, synced: false };
    }

    try {
      const { data, error } = await client.rpc('fn_commit_audit_session', {
        p_audit_id: auditId,
        p_picker: picker || 'Picker',
        p_items: Array.isArray(items) ? items : []
      });

      if (error) {
        console.warn('[Inventory] Audit commit RPC error, queuing:', error.message);
        if (window.PICKER_DB && typeof window.PICKER_DB.addSyncQueue === 'function') {
          await window.PICKER_DB.addSyncQueue('commit_audit', { auditId, picker, items });
        }
        return { success: true, queued: true, synced: false, error };
      }

      return { success: true, queued: false, synced: true, data };
    } catch (e) {
      if (window.PICKER_DB && typeof window.PICKER_DB.addSyncQueue === 'function') {
        await window.PICKER_DB.addSyncQueue('commit_audit', { auditId, picker, items });
      }
      return { success: true, queued: true, synced: false, error: e };
    }
  }

  async function commitStockTransfer(transferId, picker, sourceLoc, destLoc, items) {
    const client = window.SUPABASE_CLIENT ? window.SUPABASE_CLIENT.instance : null;
    const isOnline = typeof navigator !== 'undefined' ? navigator.onLine !== false : true;

    if (!client || !isOnline) {
      if (window.PICKER_DB && typeof window.PICKER_DB.addSyncQueue === 'function') {
        await window.PICKER_DB.addSyncQueue('commit_transfer', { transferId, picker, sourceLoc, destLoc, items });
      }
      return { success: true, queued: true, synced: false };
    }

    try {
      const { data, error } = await client.rpc('fn_commit_stock_transfer', {
        p_transfer_id: transferId,
        p_picker: picker || 'Picker',
        p_source_loc: sourceLoc,
        p_dest_loc: destLoc,
        p_items: Array.isArray(items) ? items : []
      });

      if (error) {
        if (window.PICKER_DB && typeof window.PICKER_DB.addSyncQueue === 'function') {
          await window.PICKER_DB.addSyncQueue('commit_transfer', { transferId, picker, sourceLoc, destLoc, items });
        }
        return { success: true, queued: true, synced: false, error };
      }

      return { success: true, queued: false, synced: true, data };
    } catch (e) {
      if (window.PICKER_DB && typeof window.PICKER_DB.addSyncQueue === 'function') {
        await window.PICKER_DB.addSyncQueue('commit_transfer', { transferId, picker, sourceLoc, destLoc, items });
      }
      return { success: true, queued: true, synced: false, error: e };
    }
  }

  window.SUPABASE_INVENTORY = {
    downloadAllInventory,
    syncInventoryIncremental,
    updateInventory,
    processMovement,
    commitAuditSession,
    commitStockTransfer
  };
})(typeof window !== 'undefined' ? window : this);
