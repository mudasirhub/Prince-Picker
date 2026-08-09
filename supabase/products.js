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
  async function saveProduct(product) {
    if (!product) {
      console.error('[SAVE_PRODUCT] Error: No product provided');
      return { success: false, error: 'No product provided' };
    }

    const id = String(product.id || product.barcode || product.sku || '');
    const barcode = String(product.barcode || product.sku || id);
    const sku = String(product.sku || product.barcode || id);

    const imagesList = Array.isArray(product.images) && product.images.length > 0
      ? product.images
      : (product.image ? [{ id: 'img_primary', url: product.image, mime: 'image/webp' }] : []);

    const primaryImageUrl = (imagesList[0] && (imagesList[0].url || imagesList[0])) || product.image || '';

    const payload = {
      id: id,
      sku: sku,
      barcode: barcode,
      name: product.name || '',
      brand: product.brand || '',
      category: product.category || '',
      location: product.location || product.loc || '',
      loc: product.loc || product.location || '',
      mrp: Number(product.mrp || 0),
      sp: Number(product.sp || 0),
      stock: Number(product.stock ?? product.qty ?? 0),
      qty: Number(product.qty ?? product.stock ?? 0),
      threshold: Number(product.threshold !== undefined && product.threshold !== null ? product.threshold : 5),
      fitment_group: product.fitment_group || '',
      compatibility: Array.isArray(product.compatibility) ? product.compatibility : [],
      images: imagesList,
      image: primaryImageUrl,
      updated_at: product.updated_at || new Date().toISOString()
    };

    console.log('[SAVE_PRODUCT] Product:', product);
    console.log('[SAVE_PRODUCT] Payload:', payload);

    // 1. Update local IndexedDB cache first
    if (window.PICKER_DB && typeof window.PICKER_DB.putProducts === 'function') {
      try {
        await window.PICKER_DB.putProducts([payload]);
      } catch (errDB) {
        console.warn('[SAVE_PRODUCT] IndexedDB putProducts warning:', errDB);
      }
    }

    const client = window.SUPABASE_CLIENT ? window.SUPABASE_CLIENT.instance : null;
    const isOnline = typeof navigator !== 'undefined' ? navigator.onLine !== false : true;

    // Handle offline state or missing Supabase client
    if (!client || !isOnline) {
      console.log('[SAVE_PRODUCT] Offline or Supabase client unavailable. Queuing product upload...');
      if (window.PICKER_DB && typeof window.PICKER_DB.addSyncQueue === 'function') {
        await window.PICKER_DB.addSyncQueue('save_product', payload);
        console.log('[SAVE_PRODUCT] Queued:', payload.id);
      }
      return { success: true, queued: true, synced: false };
    }

    // 2. Execute Supabase upsert request
    console.log('[SAVE_PRODUCT] Sending upsert...');
    try {
      const { data, error } = await client
        .from('products')
        .upsert(payload, { onConflict: 'id' })
        .select();

      if (error) {
        console.error('[SAVE_PRODUCT] Error:', error);

        // Fallback if 'loc' is a generated column in PostgreSQL
        const errMsg = String(error.message || error.details || '');
        if (errMsg.includes('loc') && payload.loc) {
          console.warn('[SAVE_PRODUCT] Retrying upsert without generated "loc" column...');
          const payloadNoLoc = { ...payload };
          delete payloadNoLoc.loc;
          const retryRes = await client.from('products').upsert(payloadNoLoc, { onConflict: 'id' }).select();
          if (!retryRes.error && retryRes.data) {
            console.log('[SAVE_PRODUCT] Retry without loc success:', retryRes.data);
            if (retryRes.data.length > 0 && window.PICKER_DB && typeof window.PICKER_DB.putProducts === 'function') {
              await window.PICKER_DB.putProducts(retryRes.data);
            }
            return { success: true, queued: false, synced: true, data: retryRes.data };
          }
        }

        if (isNetworkError(error)) {
          console.warn('[SAVE_PRODUCT] Network error detected. Queuing upload...');
          if (window.PICKER_DB && typeof window.PICKER_DB.addSyncQueue === 'function') {
            await window.PICKER_DB.addSyncQueue('save_product', payload);
            console.log('[SAVE_PRODUCT] Queued:', payload.id);
          }
          return { success: true, queued: true, synced: false, error };
        } else {
          console.error('[SAVE_PRODUCT] Database error (not queued):', error.message || error, error);
          return { success: false, queued: false, synced: false, error };
        }
      }

      console.log('[SAVE_PRODUCT] Success:', data);

      // Refresh/update local cache with returned row data
      if (data && Array.isArray(data) && data.length > 0) {
        if (window.PICKER_DB && typeof window.PICKER_DB.putProducts === 'function') {
          await window.PICKER_DB.putProducts(data);
        }
      }

      return { success: true, queued: false, synced: true, data };
    } catch (e) {
      console.error('[SAVE_PRODUCT] Exception during upsert:', e);
      if (isNetworkError(e)) {
        console.warn('[SAVE_PRODUCT] Network exception. Queuing upload...');
        if (window.PICKER_DB && typeof window.PICKER_DB.addSyncQueue === 'function') {
          await window.PICKER_DB.addSyncQueue('save_product', payload);
          console.log('[SAVE_PRODUCT] Queued:', payload.id);
        }
        return { success: true, queued: true, synced: false, error: e };
      }
      return { success: false, queued: false, synced: false, error: e };
    }
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
