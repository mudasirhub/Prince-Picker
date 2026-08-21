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

    const payload = {
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
      updated_at: product.updated_at || new Date().toISOString(),
      transactionId: txId
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

        // Fallback if PostgreSQL schema does not have locations, primary_location, or loc columns
        const errMsg = String(error.message || error.details || '');
        if (errMsg.includes('locations') || errMsg.includes('primary_location') || errMsg.includes('primary_storage') || errMsg.includes('storage_type') || errMsg.includes('loc')) {
          console.warn('[SAVE_PRODUCT] Retrying upsert without unrecognised SQL schema columns...');
          const legacyPayload = {
            id: payload.id,
            sku: payload.sku,
            barcode: payload.barcode,
            name: payload.name,
            brand: payload.brand,
            category: payload.category,
            location: payload.location,
            stock: payload.stock,
            mrp: payload.mrp,
            fitment_group: payload.fitment_group,
            intact: payload.intact,
            image: payload.image,
            updated_at: payload.updated_at
          };
          const retryRes = await client.from('products').upsert(legacyPayload, { onConflict: 'id' }).select();
          if (!retryRes.error && retryRes.data) {
            console.log('[SAVE_PRODUCT] Retry with legacy payload success:', retryRes.data);
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

  async function deleteProduct(identifier) {
    const client = window.SUPABASE_CLIENT ? window.SUPABASE_CLIENT.instance : null;
    const targetStr = String(identifier || '');
    if (!targetStr) return { success: false, error: 'No identifier provided' };

    if (!client) {
      console.warn('[Products] Supabase client offline. Queuing deletion for background sync.');
      if (window.PICKER_DB && typeof window.PICKER_DB.addSyncQueue === 'function') {
        await window.PICKER_DB.addSyncQueue('delete_product', { id: targetStr });
      }
      return { success: true, queued: true, synced: false };
    }

    try {
      const { data, error } = await client
        .from('products')
        .delete()
        .or(`id.eq.${targetStr},barcode.eq.${targetStr},sku.eq.${targetStr}`);

      if (error) {
        console.error('[Products] Error deleting product from Supabase:', error);
        if (isNetworkError(error)) {
          if (window.PICKER_DB && typeof window.PICKER_DB.addSyncQueue === 'function') {
            await window.PICKER_DB.addSyncQueue('delete_product', { id: targetStr });
          }
          return { success: true, queued: true, synced: false, error };
        }
        return { success: false, error };
      }

      console.log('[Products] Deleted product from Supabase:', targetStr);
      return { success: true, synced: true, data };
    } catch (e) {
      console.error('[Products] Exception deleting product:', e);
      if (isNetworkError(e)) {
        if (window.PICKER_DB && typeof window.PICKER_DB.addSyncQueue === 'function') {
          await window.PICKER_DB.addSyncQueue('delete_product', { id: targetStr });
        }
        return { success: true, queued: true, synced: false, error: e };
      }
      return { success: false, error: e };
    }
  }

  window.SUPABASE_PRODUCTS = {
    downloadAllProducts,
    syncProductsIncremental,
    saveProduct,
    deleteProduct,
    isNetworkError
  };
})(typeof window !== 'undefined' ? window : this);
