/**
 * Supabase Product Synchronization Engine
 */
(function(window) {
  async function downloadAllProducts() {
    const client = window.SUPABASE_CLIENT ? window.SUPABASE_CLIENT.instance : null;
    if (!client) {
      console.warn('[Products] Supabase client offline. Using local database.');
      return await window.PICKER_DB.getAllProducts();
    }

    try {
      const { data, error } = await client
        .from('products')
        .select('*');

      if (error) {
        console.error('[Products] Error fetching products:', error);
        return await window.PICKER_DB.getAllProducts();
      }

      if (data && Array.isArray(data)) {
        await window.PICKER_DB.putProducts(data);
      }
      return await window.PICKER_DB.getAllProducts();
    } catch (e) {
      console.error('[Products] Exception fetching products:', e);
      return await window.PICKER_DB.getAllProducts();
    }
  }

  async function syncProductsIncremental(lastSyncTimestamp) {
    const client = window.SUPABASE_CLIENT ? window.SUPABASE_CLIENT.instance : null;
    if (!client || !lastSyncTimestamp) {
      return await downloadAllProducts();
    }

    try {
      const { data, error } = await client
        .from('products')
        .select('*')
        .gt('updated_at', lastSyncTimestamp);

      if (error) {
        console.warn('[Products] Incremental sync error:', error);
        return { updatedCount: 0, products: await window.PICKER_DB.getAllProducts() };
      }

      if (data && data.length > 0) {
        await window.PICKER_DB.putProducts(data);
        console.log(`[Products] Incremental sync updated ${data.length} products.`);
        return { updatedCount: data.length, products: await window.PICKER_DB.getAllProducts() };
      }
      return { updatedCount: 0, products: await window.PICKER_DB.getAllProducts() };
    } catch (e) {
      console.error('[Products] Incremental sync exception:', e);
      return { updatedCount: 0, products: await window.PICKER_DB.getAllProducts() };
    }
  }

  /**
   * Save (upsert) a product to Supabase and update local IndexedDB cache.
   * Logs every step, handles offline queueing, and differentiates network vs database errors.
   */
  async function saveProduct(product, transactionId) {
    if (!product) {
      console.error('[SAVE_PRODUCT] Error: No product provided');
      return { success: false, error: 'No product provided' };
    }

    const txId = transactionId || '';

    const id = String(product.id || product.barcode || product.sku || '');
    const barcode = String(product.barcode || product.sku || id);
    const sku = String(product.sku || product.barcode || id);

    const rawImagesList = Array.isArray(product.images) && product.images.length > 0
      ? product.images
      : (product.image ? [{ id: 'img_primary', url: product.image, mime: 'image/webp' }] : []);

    const imagesList = rawImagesList.map(img => {
      if (typeof img === 'string') {
        return img.startsWith('blob:') ? '' : img;
      }
      if (img && typeof img === 'object') {
        const u = typeof img.url === 'string' ? img.url : '';
        if (u.startsWith('blob:')) {
          const fallback = (img.dataUrl && !img.dataUrl.startsWith('blob:')) ? img.dataUrl : '';
          return { ...img, url: fallback };
        }
      }
      return img;
    }).filter(img => {
      if (!img) return false;
      if (typeof img === 'string') return img.length > 0;
      if (typeof img === 'object') return Boolean(img.url || img.dataUrl);
      return false;
    });

    let rawPrimary = (imagesList[0] && (imagesList[0].url || (typeof imagesList[0] === 'string' ? imagesList[0] : ''))) || (typeof product.image === 'string' ? product.image : '');
    if (typeof rawPrimary === 'string' && rawPrimary.startsWith('blob:')) rawPrimary = '';
    const primaryImageUrl = rawPrimary;

    // Full rich payload
    const fullPayload = {
      id: id,
      sku: sku,
      barcode: barcode,
      name: product.name || '',
      brand: product.brand || '',
      category: product.category || '',
      location: product.location || product.loc || '',
      loc: product.loc || product.location || '',
      primary_storage: product.primary_storage || product.storage_type || '',
      primary_location: product.primary_location || product.location || product.loc || '',
      storage_type: product.storage_type || product.primary_storage || '',
      locations: Array.isArray(product.locations) ? product.locations : [],
      mrp: Number(product.mrp || 0),
      sp: Number(product.sp || 0),
      stock: Number(product.stock ?? product.qty ?? 0),
      threshold: Number(product.threshold !== undefined && product.threshold !== null ? product.threshold : 5),
      fitment_group: product.fitment_group || '',
      intact: Boolean(product.intact ?? product.is_intact ?? (product.fitment_group ? true : false)),
      is_intact: Boolean(product.is_intact ?? product.intact ?? (product.fitment_group ? true : false)),
      compatibility: Array.isArray(product.compatibility) ? product.compatibility : [],
      images: imagesList,
      image: primaryImageUrl,
      updated_at: product.updated_at || new Date().toISOString()
    };

    // Clean standard core payload (minimal columns matching default database schemas)
    const corePayload = {
      id: id,
      sku: sku,
      barcode: barcode,
      name: product.name || '',
      brand: product.brand || '',
      category: product.category || '',
      location: product.location || product.loc || '',
      loc: product.loc || product.location || '',
      primary_storage: product.primary_storage || product.storage_type || '',
      primary_location: product.primary_location || product.location || product.loc || '',
      storage_type: product.storage_type || product.primary_storage || '',
      locations: Array.isArray(product.locations) ? product.locations : [],
      stock: Number(product.stock ?? product.qty ?? 0),
      mrp: Number(product.mrp || 0),
      fitment_group: product.fitment_group || '',
      intact: Boolean(product.intact ?? product.is_intact ?? (product.fitment_group ? true : false)),
      image: primaryImageUrl,
      updated_at: product.updated_at || new Date().toISOString(),
      transactionId: txId
    };

    console.log('[SAVE_PRODUCT] Product:', product);

    // 1. Update local IndexedDB cache first for instant offline UI
    if (window.PICKER_DB && typeof window.PICKER_DB.putProducts === 'function') {
      try {
        await window.PICKER_DB.putProducts([fullPayload]);
      } catch (errDB) {
        console.warn('[SAVE_PRODUCT] IndexedDB putProducts warning:', errDB);
      }
    }

    const client = window.SUPABASE_CLIENT ? window.SUPABASE_CLIENT.instance : null;
    const isOnline = typeof navigator !== 'undefined' ? navigator.onLine !== false : true;

    if (!client || !isOnline) {
      console.log('[SAVE_PRODUCT] Offline or Supabase client unavailable. Queuing product upload...');
      if (window.PICKER_DB && typeof window.PICKER_DB.addSyncQueue === 'function') {
        await window.PICKER_DB.addSyncQueue('save_product', corePayload);
      }
      return { success: true, queued: true, synced: false };
    }

    // 2. Self-healing multi-stage upsert to withstand database schema differences & 400 Bad Request errors
    const fullNoLoc = { ...fullPayload }; delete fullNoLoc.loc;
    const coreNoLoc = { ...corePayload }; delete coreNoLoc.loc;
    const coreNoIdNoLoc = { ...corePayload }; delete coreNoIdNoLoc.id; delete coreNoIdNoLoc.loc;

    const attempts = [
      { name: 'Full Payload (id conflict)', payload: fullPayload, conflict: 'id' },
      { name: 'Full Payload (no loc, id conflict)', payload: fullNoLoc, conflict: 'id' },
      { name: 'Core Payload (id conflict)', payload: corePayload, conflict: 'id' },
      { name: 'Core Payload (no loc, id conflict)', payload: coreNoLoc, conflict: 'id' },
      { name: 'Core Payload (sku conflict)', payload: corePayload, conflict: 'sku' },
      { name: 'Core Payload (no loc, sku conflict)', payload: coreNoLoc, conflict: 'sku' },
      { name: 'Core Payload (barcode conflict)', payload: corePayload, conflict: 'barcode' },
      { name: 'Core Payload (no id, no loc, sku conflict)', payload: coreNoIdNoLoc, conflict: 'sku' }
    ];

    let lastError = null;

    for (let i = 0; i < attempts.length; i++) {
      const att = attempts[i];
      console.log(`[SAVE_PRODUCT] Trying stage ${i + 1}: ${att.name}...`);

      try {
        const query = client.from('products').upsert(att.payload, { onConflict: att.conflict }).select();
        const { data, error } = await query;

        if (!error && data) {
          console.log(`[SAVE_PRODUCT] Success on stage ${i + 1} (${att.name}):`, data);
          if (data && Array.isArray(data) && data.length > 0 && window.PICKER_DB && typeof window.PICKER_DB.putProducts === 'function') {
            await window.PICKER_DB.putProducts(data);
          }
          return { success: true, queued: false, synced: true, data };
        }

        lastError = error;
        console.warn(`[SAVE_PRODUCT] Stage ${i + 1} failed (${att.name}):`, error?.message || error?.details || error, error);

        if (isNetworkError(error)) {
          console.warn('[SAVE_PRODUCT] Network disconnect detected during stage. Queuing for background sync...');
          if (window.PICKER_DB && typeof window.PICKER_DB.addSyncQueue === 'function') {
            await window.PICKER_DB.addSyncQueue('save_product', corePayload);
          }
          return { success: true, queued: true, synced: false, error };
        }
      } catch (errStage) {
        lastError = errStage;
        console.warn(`[SAVE_PRODUCT] Stage ${i + 1} exception (${att.name}):`, errStage);
        if (isNetworkError(errStage)) {
          if (window.PICKER_DB && typeof window.PICKER_DB.addSyncQueue === 'function') {
            await window.PICKER_DB.addSyncQueue('save_product', corePayload);
          }
          return { success: true, queued: true, synced: false, error: errStage };
        }
      }
    }

    // If remote upsert failed across all stages, safely queue item locally so user work is never lost
    console.warn('[SAVE_PRODUCT] All remote upsert stages encountered schema/REST issues. Queuing locally:', lastError);
    if (window.PICKER_DB && typeof window.PICKER_DB.addSyncQueue === 'function') {
      await window.PICKER_DB.addSyncQueue('save_product', corePayload);
    }
    return { success: true, queued: true, synced: false, error: lastError, note: 'Saved locally and queued for background sync' };
  }

  function isNetworkError(err) {
    if (!err) return false;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    const msg = String(err.message || err.details || err || '').toLowerCase();
    if (msg.includes('fetch') || msg.includes('network') || msg.includes('failed to fetch') || msg.includes('timeout') || msg.includes('offline')) {
      return true;
    }
    if (err.name === 'TypeError' || err.status === 0 || err.code === 'PGRST000') {
      return true;
    }
    return false;
  }

  window.SUPABASE_PRODUCTS = {
    downloadAllProducts,
    syncProductsIncremental,
    saveProduct,
    isNetworkError
  };
})(typeof window !== 'undefined' ? window : this);
