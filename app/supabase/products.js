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

  window.SUPABASE_PRODUCTS = {
    downloadAllProducts,
    syncProductsIncremental
  };
})(typeof window !== 'undefined' ? window : this);
