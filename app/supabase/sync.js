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
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;

    console.log(`[SYNC] Processing ${queue.length} queued offline items...`);

    for (const item of queue) {
      try {
        if (item.type === 'update_inventory') {
          console.log('[SYNC] Uploading queued inventory update:', item.payload);
          const { error } = await client
            .from('inventory')
            .upsert(item.payload);

          if (!error) {
            await window.PICKER_DB.removeSyncQueue(item.id);
            console.log('[SYNC] Inventory queue item complete:', item.id);
          } else {
            console.error('[SYNC] Error uploading inventory queue item:', error);
          }
        } else if (item.type === 'save_product' || item.type === 'upsert_product') {
          console.log('[SYNC] Upload queued product via saveProduct:', item.payload);
          if (window.SUPABASE_PRODUCTS && typeof window.SUPABASE_PRODUCTS.saveProduct === 'function') {
            const res = await window.SUPABASE_PRODUCTS.saveProduct(item.payload);
            if (res && (res.synced || res.success)) {
              await window.PICKER_DB.removeSyncQueue(item.id);
              console.log('[SYNC] Queue complete for product:', item.payload.id || item.payload.sku);
            } else {
              console.error('[SYNC] Failed to upload queued product:', res?.error);
              if (res?.error && !window.SUPABASE_PRODUCTS.isNetworkError(res.error)) {
                await window.PICKER_DB.removeSyncQueue(item.id);
              }
            }
          } else {
            const { data, error } = await client.from('products').upsert(item.payload, { onConflict: 'id' }).select();
            if (!error) {
              await window.PICKER_DB.removeSyncQueue(item.id);
            }
          }
        } else if (item.type === 'process_movement') {
          console.log('[SYNC] Processing queued inventory movement:', item.payload);
          const p = item.payload || {};
          const { error } = await client.rpc('fn_process_inventory_movement', {
            p_type: String(p.type || 'PICK').toUpperCase(),
            p_sku: p.sku || '',
            p_qty: Number(p.qty) || 1,
            p_location: p.location || '',
            p_picker: p.picker || 'Picker',
            p_session_id: p.sessionId || ('SES-' + Date.now())
          });
          if (!error) {
            await window.PICKER_DB.removeSyncQueue(item.id);
            console.log('[SYNC] Movement queue item complete:', item.id);
          } else {
            console.error('[SYNC] Error processing queued movement RPC:', error);
            const isNetErr = window.SUPABASE_PRODUCTS?.isNetworkError ? window.SUPABASE_PRODUCTS.isNetworkError(error) : false;
            if (error && !isNetErr && error.code !== 'FETCH_ERROR') {
              console.warn('[SYNC] Permanent error on queued movement. Removing item:', item.id);
              await window.PICKER_DB.removeSyncQueue(item.id);
            }
          }
        } else if (item.type === 'upload_image') {
          console.log('[SYNC] Processing queued offline image upload:', item.storagePath);
          if (item.dataUrl && item.dataUrl.startsWith('blob:')) {
            try {
              const chk = await fetch(item.dataUrl);
              if (!chk.ok) throw new Error('Revoked blob URL');
            } catch (eBlob) {
              console.warn('[SYNC] Revoked blob URL in sync queue. Removing item:', item.id);
              await window.PICKER_DB.removeSyncQueue(item.id);
              continue;
            }
          }
          if (window.IMAGE_UPLOADER && typeof window.IMAGE_UPLOADER.uploadSingleImage === 'function') {
            const upRes = await window.IMAGE_UPLOADER.uploadSingleImage(item.dataUrl, item.productId, { checksum: item.checksum });
            if (upRes && upRes.uploaded) {
              // Transaction Step 2 & 3: Update Supabase & refresh IndexedDB product cache
              if (item.productId && window.PICKER_DB && typeof window.PICKER_DB.getProductById === 'function') {
                const prod = await window.PICKER_DB.getProductById(item.productId);
                if (prod) {
                  const updatedImages = Array.isArray(prod.images) ? [...prod.images] : [];
                  const idx = updatedImages.findIndex(img => (img && (img.storagePath === item.storagePath || img.url === item.dataUrl)));
                  const metaObj = {
                    id: upRes.id || ('img_' + Date.now()),
                    url: upRes.url,
                    width: upRes.width || 0,
                    height: upRes.height || 0,
                    sizeBytes: upRes.sizeBytes || 0,
                    mime: 'image/webp',
                    checksum: item.checksum || '',
                    createdAt: upRes.createdAt || new Date().toISOString()
                  };
                  if (idx >= 0) updatedImages[idx] = metaObj;
                  else updatedImages.push(metaObj);

                  prod.images = updatedImages;
                  prod.image = updatedImages[0]?.url || prod.image || '';

                  if (window.SUPABASE_PRODUCTS && typeof window.SUPABASE_PRODUCTS.saveProduct === 'function') {
                    await window.SUPABASE_PRODUCTS.saveProduct(prod);
                  }
                }
              }

              // Transaction Step 4: Remove queue item
              await window.PICKER_DB.removeSyncQueue(item.id);
              console.log('[SYNC] Queued image upload transaction complete:', upRes.url);
            }
          }
        }
      } catch (e) {
        console.warn('[SYNC] Failed to process queue item:', item.id, e);
      }
    }
  }

  window.SUPABASE_SYNC = {
    runBackgroundSync,
    processOfflineQueue
  };
})(typeof window !== 'undefined' ? window : this);
