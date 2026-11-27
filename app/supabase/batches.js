/**
 * Batch ID & Multi-MRP Engine for Prince Picker
 * Supports multiple stock batches with different MRPs per SKU/product,
 * FIFO ordering, legacy B1 compatibility, and offline-first Supabase + IndexedDB sync.
 */
(function(window) {
  function genUuid() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    // RFC4122 v4 fallback
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function batchSeqNum(batchId) {
    const m = String(batchId || '').trim().match(/^B(\d+)$/i);
    return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
  }

  function sortBatchesFIFO(batches) {
    return [...batches].sort((a, b) => {
      const ta = Date.parse(a.created_at || '') || 0;
      const tb = Date.parse(b.created_at || '') || 0;
      if (ta !== tb) return ta - tb;
      const na = batchSeqNum(a.batch_id);
      const nb = batchSeqNum(b.batch_id);
      if (na !== nb) return na - nb;
      return String(a.batch_id || '').localeCompare(String(b.batch_id || ''));
    });
  }

  function getProductKey(product) {
    return String(product?.id || product?.barcode || product?.sku || '').trim();
  }

  function getProductLocation(product) {
    return String(product?.primary_location || product?.location || product?.loc || '').trim();
  }

  /**
   * Returns normalized FIFO-sorted batches for any product.
   * Legacy products without explicit batches are represented as a single B1 batch.
   */
  function normalizeBatches(product) {
    if (!product || typeof product !== 'object') return [];
    const prodId = getProductKey(product);
    const sku = String(product.sku || product.barcode || prodId).trim();
    const defaultLoc = getProductLocation(product);
    const fallbackTs = product.created_at || product.updated_at || '1970-01-01T00:00:00.000Z';

    const raw = Array.isArray(product.batches) ? product.batches : [];
    const clean = [];
    const seen = new Set();

    for (const b of raw) {
      if (!b || typeof b !== 'object') continue;
      const bid = String(b.batch_id || b.batchId || '').trim();
      if (!bid) continue;
      const key = bid.toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      clean.push({
        id: String(b.id || genUuid()),
        product_id: String(b.product_id || prodId),
        sku: String(b.sku || sku),
        batch_id: bid,
        mrp: Number(b.mrp ?? product.mrp ?? 0),
        stock_qty: Math.max(0, Number(b.stock_qty ?? b.qty ?? 0)),
        location: String(b.location || b.loc || defaultLoc || '').trim(),
        created_at: b.created_at || fallbackTs,
        updated_at: b.updated_at || product.updated_at || new Date().toISOString()
      });
    }

    if (clean.length === 0) {
      clean.push({
        id: `${prodId || 'prod'}::B1`,
        product_id: prodId,
        sku: sku,
        batch_id: 'B1',
        mrp: Number(product.mrp || 0),
        stock_qty: Math.max(0, Number(product.stock ?? product.qty ?? 0)),
        location: defaultLoc,
        created_at: fallbackTs,
        updated_at: product.updated_at || fallbackTs,
        _isVirtualDefault: true
      });
    }

    return sortBatchesFIFO(clean);
  }

  function getActiveBatches(product) {
    return normalizeBatches(product).filter(b => Number(b.stock_qty || 0) > 0);
  }

  function hasMultiBatches(product) {
    const active = getActiveBatches(product);
    if (active.length > 1) return true;
    if (Array.isArray(product?.batches) && product.batches.length > 1 && active.length >= 1) return true;
    return false;
  }

  function getDefaultBatch(product) {
    const active = getActiveBatches(product);
    if (active.length > 0) return active[0]; // Oldest in-stock (FIFO)
    const all = normalizeBatches(product);
    return all[0] || null;
  }

  function computeTotalStock(batchesOrProduct) {
    const list = Array.isArray(batchesOrProduct)
      ? batchesOrProduct
      : normalizeBatches(batchesOrProduct);
    return list.reduce((sum, b) => {
      const q = Number(b?.stock_qty ?? b?.qty ?? 0);
      return sum + (q > 0 ? q : 0);
    }, 0);
  }

  function suggestNextBatchId(product) {
    const existing = normalizeBatches(product);
    let maxN = 0;
    const used = new Set();
    for (const b of existing) {
      const bid = String(b.batch_id || '').trim().toUpperCase();
      if (bid) used.add(bid);
      const m = bid.match(/^B(\d+)$/);
      if (m) {
        maxN = Math.max(maxN, Number(m[1]));
      }
    }
    let nextN = Math.max(1, maxN + 1);
    while (used.has('B' + nextN)) nextN++;
    return 'B' + nextN;
  }

  function findSameMrpBatch(product, mrp) {
    const targetMrp = Number(mrp);
    if (isNaN(targetMrp)) return null;
    const all = normalizeBatches(product);
    return all.find(b => Number(b.mrp) === targetMrp) || null;
  }

  function syncParentTotalsFromBatches(product, opts = {}) {
    if (!product || typeof product !== 'object') return product;
    const batches = normalizeBatches(product).map(b => {
      const copy = { ...b };
      delete copy._isVirtualDefault;
      return copy;
    });
    const total = computeTotalStock(batches);
    const active = batches.filter(b => b.stock_qty > 0);
    const defBatch = active[0] || batches[0];

    product.batches = batches;
    product.total_stock = total;
    product.stock = total;
    product.qty = total;
    if (defBatch && (Number(defBatch.mrp) > 0 || !product.mrp)) {
      product.mrp = Number(defBatch.mrp || 0);
    }

    // Keep product.locations synchronized so facility/inventory helpers never read stale qty
    if (Array.isArray(product.locations) && product.locations.length > 0) {
      if (product.locations.length === 1) {
        product.locations[0].qty = total;
      } else if (typeof opts.delta === 'number' && opts.delta !== 0) {
        const targetLoc = String(opts.targetLocation || '').trim().toUpperCase();
        const locObj = (targetLoc && product.locations.find(l => String(l.location || '').trim().toUpperCase() === targetLoc))
          || product.locations.find(l => l.is_primary)
          || product.locations[0];
        if (locObj) {
          locObj.qty = Math.max(0, Number(locObj.qty || 0) + opts.delta);
        }
      }
    }

    product.updated_at = new Date().toISOString();
    return product;
  }

  function isMissingTableError(err) {
    if (!err) return false;
    const msg = String(err.message || err.details || err.hint || err || '').toLowerCase();
    return msg.includes('product_batches') && (msg.includes('does not exist') || msg.includes('schema cache') || msg.includes('404'));
  }

  async function saveBatchRemoteOrQueue(batchRow) {
    const cleanRow = {
      id: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(batchRow.id || ''))
        ? batchRow.id
        : genUuid(),
      product_id: String(batchRow.product_id),
      sku: String(batchRow.sku || batchRow.product_id),
      batch_id: String(batchRow.batch_id),
      mrp: Number(batchRow.mrp || 0),
      stock_qty: Math.max(0, Math.round(Number(batchRow.stock_qty || 0))),
      location: String(batchRow.location || ''),
      created_at: batchRow.created_at || new Date().toISOString(),
      updated_at: batchRow.updated_at || new Date().toISOString()
    };

    if (window.PICKER_DB && typeof window.PICKER_DB.putBatches === 'function') {
      try { await window.PICKER_DB.putBatches([cleanRow]); } catch (e) { }
    }

    const client = window.SUPABASE_CLIENT ? window.SUPABASE_CLIENT.instance : null;
    const isOnline = typeof navigator !== 'undefined' ? navigator.onLine !== false : true;

    if (!client || !isOnline) {
      if (window.PICKER_DB && typeof window.PICKER_DB.addSyncQueue === 'function') {
        await window.PICKER_DB.addSyncQueue('save_batch', cleanRow);
      }
      return { success: true, queued: true, synced: false, batch: cleanRow };
    }

    try {
      const { data, error } = await client
        .from('product_batches')
        .upsert(cleanRow, { onConflict: 'product_id,batch_id' })
        .select();

      if (!error) {
        const saved = (data && data[0]) ? data[0] : cleanRow;
        if (window.PICKER_DB && typeof window.PICKER_DB.putBatches === 'function') {
          try { await window.PICKER_DB.putBatches([saved]); } catch (e) { }
        }
        return { success: true, queued: false, synced: true, batch: saved };
      }

      if (isMissingTableError(error)) {
        // Remote migration not applied yet — product.batches JSONB handles persistence gracefully
        return { success: true, queued: false, synced: false, schemaPending: true, batch: cleanRow };
      }

      if (window.PICKER_DB && typeof window.PICKER_DB.addSyncQueue === 'function') {
        await window.PICKER_DB.addSyncQueue('save_batch', cleanRow);
      }
      return { success: true, queued: true, synced: false, error, batch: cleanRow };
    } catch (e) {
      if (window.PICKER_DB && typeof window.PICKER_DB.addSyncQueue === 'function') {
        await window.PICKER_DB.addSyncQueue('save_batch', cleanRow);
      }
      return { success: true, queued: true, synced: false, error: e, batch: cleanRow };
    }
  }

  /**
   * Add a new batch or merge into an existing batch on a product.
   */
  async function addOrMergeBatch(product, input) {
    if (!product || !input) return { success: false, error: 'Missing product or batch input' };
    const prodId = getProductKey(product);
    const sku = String(product.sku || product.barcode || prodId).trim();
    const mrp = Number(input.mrp);
    const stockQty = Math.max(0, Math.round(Number(input.stock_qty ?? input.qty ?? 0)));
    const location = String(input.location ?? getProductLocation(product)).trim();
    const mergeSameMrp = Boolean(input.mergeSameMrp);

    if (isNaN(mrp) || mrp < 0) return { success: false, error: 'Enter a valid MRP' };
    if (isNaN(stockQty) || stockQty <= 0) return { success: false, error: 'Enter stock quantity > 0' };

    // Materialize existing batches (including legacy B1 if this is the first extra batch)
    const currentBatches = normalizeBatches(product).map(b => {
      const copy = { ...b };
      delete copy._isVirtualDefault;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(copy.id || ''))) {
        copy.id = genUuid();
      }
      return copy;
    });

    const now = new Date().toISOString();
    let targetBatch = null;
    let wasNewBatch = false;

    if (mergeSameMrp) {
      targetBatch = currentBatches.find(b => Number(b.mrp) === mrp);
    }

    const requestedBatchId = String(input.batch_id || suggestNextBatchId(product)).trim();

    if (targetBatch) {
      targetBatch.stock_qty = Math.max(0, Number(targetBatch.stock_qty || 0) + stockQty);
      if (location) targetBatch.location = location;
      targetBatch.updated_at = now;
    } else {
      const existingById = currentBatches.find(b => String(b.batch_id).trim().toUpperCase() === requestedBatchId.toUpperCase());
      if (existingById) {
        existingById.mrp = mrp;
        existingById.stock_qty = Math.max(0, Number(existingById.stock_qty || 0) + stockQty);
        if (location) existingById.location = location;
        existingById.updated_at = now;
        targetBatch = existingById;
      } else {
        targetBatch = {
          id: genUuid(),
          product_id: prodId,
          sku,
          batch_id: requestedBatchId,
          mrp,
          stock_qty: stockQty,
          location,
          created_at: now,
          updated_at: now
        };
        currentBatches.push(targetBatch);
        wasNewBatch = true;
      }
    }

    product.batches = sortBatchesFIFO(currentBatches);
    syncParentTotalsFromBatches(product, { delta: stockQty, targetLocation: targetBatch.location });

    // Sync local app stores
    if (typeof window.syncProductToAppStores === 'function') {
      window.syncProductToAppStores(product);
    }

    // Persist batch locally & remotely
    const batchesToPersist = wasNewBatch && currentBatches.length > 1
      ? currentBatches
      : [targetBatch];

    let batchRes = { success: true, queued: false, synced: true, batch: targetBatch };
    for (const b of batchesToPersist) {
      const r = await saveBatchRemoteOrQueue(b);
      if (b.batch_id === targetBatch.batch_id) batchRes = r;
    }

    // Also update parent product record (total_stock + batches cache)
    if (window.SUPABASE_PRODUCTS && typeof window.SUPABASE_PRODUCTS.saveProduct === 'function') {
      try { await window.SUPABASE_PRODUCTS.saveProduct(product); } catch (e) { }
    } else if (window.PICKER_DB && typeof window.PICKER_DB.putProducts === 'function') {
      try { await window.PICKER_DB.putProducts([product]); } catch (e) { }
    }

    return {
      success: true,
      batch: targetBatch,
      merged: Boolean(!wasNewBatch),
      totalStock: product.stock,
      queued: Boolean(batchRes.queued),
      synced: Boolean(batchRes.synced)
    };
  }

  /**
   * Adjust stock on a specific batch_id (or FIFO default batch) and sync totals.
   */
  async function adjustBatchStock(product, batchId, qtyDelta, opts = {}) {
    if (!product) return { success: false, error: 'Missing product' };
    const batches = normalizeBatches(product).map(b => {
      const copy = { ...b };
      delete copy._isVirtualDefault;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(copy.id || ''))) {
        copy.id = genUuid();
      }
      return copy;
    });

    const cleanBid = String(batchId || '').trim();
    let target = cleanBid
      ? batches.find(b => String(b.batch_id).trim().toUpperCase() === cleanBid.toUpperCase())
      : (batches.find(b => b.stock_qty > 0) || batches[0]);

    const now = new Date().toISOString();
    if (!target) {
      target = {
        id: genUuid(),
        product_id: getProductKey(product),
        sku: String(product.sku || product.barcode || getProductKey(product)),
        batch_id: cleanBid || 'B1',
        mrp: Number(opts.unitMrp ?? product.mrp ?? 0),
        stock_qty: 0,
        location: String(opts.location || getProductLocation(product)),
        created_at: now,
        updated_at: now
      };
      batches.push(target);
    }

    const prevBatchQty = Number(target.stock_qty || 0);
    if (opts.mode === 'set') {
      target.stock_qty = Math.max(0, Math.round(Number(qtyDelta) || 0));
    } else {
      target.stock_qty = Math.max(0, Math.round(prevBatchQty + Number(qtyDelta || 0)));
    }
    const appliedDelta = target.stock_qty - prevBatchQty;
    target.updated_at = now;

    product.batches = sortBatchesFIFO(batches);
    syncParentTotalsFromBatches(product, { delta: appliedDelta, targetLocation: target.location });

    if (typeof window.syncProductToAppStores === 'function') {
      window.syncProductToAppStores(product);
    }

    let res = { success: true, queued: false, synced: true, batch: target };
    if (!opts.skipRemote) {
      res = await saveBatchRemoteOrQueue(target);
    } else if (window.PICKER_DB && typeof window.PICKER_DB.putBatches === 'function') {
      try { await window.PICKER_DB.putBatches([target]); } catch (e) { }
    }
    if (window.PICKER_DB && typeof window.PICKER_DB.putProducts === 'function') {
      try { await window.PICKER_DB.putProducts([product]); } catch (e) { }
    }

    return {
      success: true,
      batch: target,
      totalStock: product.stock,
      queued: Boolean(res.queued),
      synced: Boolean(res.synced)
    };
  }

  async function downloadAllBatches() {
    const client = window.SUPABASE_CLIENT ? window.SUPABASE_CLIENT.instance : null;
    const isOnline = typeof navigator !== 'undefined' ? navigator.onLine !== false : true;
    const localBatches = (window.PICKER_DB && typeof window.PICKER_DB.getAllBatches === 'function')
      ? await window.PICKER_DB.getAllBatches()
      : [];

    if (!client || !isOnline) return localBatches;

    try {
      const { data, error } = await client
        .from('product_batches')
        .select('*')
        .order('created_at', { ascending: true });

      if (error) {
        if (!isMissingTableError(error)) {
          console.warn('[Batches] Fetch warning:', error.message);
        }
        return localBatches;
      }

      if (Array.isArray(data) && data.length > 0 && window.PICKER_DB && typeof window.PICKER_DB.putBatches === 'function') {
        await window.PICKER_DB.putBatches(data);
        if (typeof window.PICKER_DB.getAllBatches === 'function') {
          return await window.PICKER_DB.getAllBatches();
        }
        return data;
      }
      return localBatches;
    } catch (e) {
      return localBatches;
    }
  }

  function attachBatchesToProducts(products, batches) {
    if (!Array.isArray(products) || !Array.isArray(batches) || batches.length === 0) return products;
    const byProd = new Map();
    for (const b of batches) {
      if (!b || !b.product_id) continue;
      const pid = String(b.product_id).trim();
      const sku = String(b.sku || '').trim();
      if (!byProd.has(pid)) byProd.set(pid, []);
      byProd.get(pid).push(b);
      if (sku && sku !== pid) {
        if (!byProd.has(sku)) byProd.set(sku, []);
        byProd.get(sku).push(b);
      }
    }

    for (const p of products) {
      if (!p) continue;
      const keys = [p.id, p.barcode, p.sku].filter(Boolean).map(k => String(k).trim());
      let matched = null;
      for (const k of keys) {
        if (byProd.has(k)) { matched = byProd.get(k); break; }
      }
      if (matched && matched.length > 0) {
        const mergedMap = new Map();
        const existing = Array.isArray(p.batches) ? p.batches : [];
        for (const eb of existing) {
          if (eb && eb.batch_id) mergedMap.set(String(eb.batch_id).toUpperCase(), eb);
        }
        for (const rb of matched) {
          if (rb && rb.batch_id) mergedMap.set(String(rb.batch_id).toUpperCase(), rb);
        }
        p.batches = sortBatchesFIFO(Array.from(mergedMap.values()));
        syncParentTotalsFromBatches(p);
      }
    }
    return products;
  }

  window.SUPABASE_BATCHES = {
    genUuid,
    normalizeBatches,
    getActiveBatches,
    hasMultiBatches,
    getDefaultBatch,
    computeTotalStock,
    suggestNextBatchId,
    findSameMrpBatch,
    syncParentTotalsFromBatches,
    saveBatchRemoteOrQueue,
    addOrMergeBatch,
    adjustBatchStock,
    downloadAllBatches,
    attachBatchesToProducts,
    sortBatchesFIFO
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = window.SUPABASE_BATCHES;
  }
})(typeof window !== 'undefined' ? window : globalThis);
