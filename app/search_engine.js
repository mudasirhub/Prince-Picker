/**
 * PRINCE PICKER — HIGH-PERFORMANCE SEARCH ENGINE FOR ~20,000 SKUs
 * 
 * Offline-first, token-indexed, ranked search engine with:
 * - O(1) exact SKU & Barcode lookups
 * - Normalized SKU matching (KB-4521-X -> kb4521x)
 * - First-class Cross-Vehicle Compatibility search with match metadata
 * - Multi-location inventory search (Shop, Warehouse, Rack, Bin, Code)
 * - Compound queries (e.g. "brake R1L1B1" or "pulsar 150 brake")
 * - Practical typo tolerance with automotive domain dictionary
 * - LRU query cache (last 50 queries, <1ms return)
 * - Ranked results according to Prince Picker authority guidelines
 * - Pure discovery engine: NEVER mutates inventory or overrides inventoryTransaction()
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.PrinceSearchEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Common automotive typos and synonyms dictionary
  const TYPO_SYNONYMS = {
    'barke': 'brake',
    'brak': 'brake',
    'clutsh': 'clutch',
    'cluch': 'clutch',
    'disck': 'disc',
    'disk': 'disc',
    'accelator': 'accelerator',
    'accel': 'accelerator',
    'carborator': 'carburetor',
    'carburator': 'carburetor',
    'shocker': 'shock',
    'filt': 'filter',
    'plug': 'spark plug',
    'spocket': 'sprocket',
    'gaskit': 'gasket',
    'cylender': 'cylinder',
    'bering': 'bearing',
    'leverr': 'lever',
    'indecator': 'indicator',
    'actva': 'activa',
    'pulser': 'pulsar',
    'splender': 'splendor',
    'apche': 'apache',
    'unicon': 'unicorn'
  };

  function normalizeSKU(str) {
    if (!str) return '';
    return String(str).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function tokenize(str) {
    if (!str) return [];
    return String(str)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(t => t.length > 0);
  }

  function escapeHTML(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function levenshteinDistance(a, b) {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;
    if (Math.abs(a.length - b.length) > 2) return 99;

    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }
    return matrix[b.length][a.length];
  }

  class LRUCache {
    constructor(maxSize = 50) {
      this.maxSize = maxSize;
      this.cache = new Map();
    }
    get(key) {
      if (!this.cache.has(key)) return null;
      const val = this.cache.get(key);
      this.cache.delete(key);
      this.cache.set(key, val);
      return val;
    }
    set(key, val) {
      if (this.cache.has(key)) {
        this.cache.delete(key);
      } else if (this.cache.size >= this.maxSize) {
        const firstKey = this.cache.keys().next().value;
        this.cache.delete(firstKey);
      }
      this.cache.set(key, val);
    }
    clear() {
      this.cache.clear();
    }
  }

  class SearchIndex {
    constructor() {
      this.products = [];
      this.productIdMap = new Map(); // id/key -> index
      this.exactBarcodeMap = new Map(); // barcode -> index
      this.exactSkuMap = new Map(); // normalized SKU -> Set of indices
      this.rawSkuMap = new Map(); // exact raw SKU -> Set of indices
      this.skuPrefixMap = new Map(); // prefix (2..6) -> Set of indices
      this.tokenIndex = new Map(); // token -> Set of indices
      this.primaryVehicleIndex = new Map(); // vehicle token -> Set of indices
      this.compatibilityEntries = []; // array of { prodIdx, make, model, name, vehicleFullName, tokens }
      this.locationMap = new Map(); // location token / code -> Set of indices
      this.queryCache = new LRUCache(50);
      this.isIndexing = false;
    }

    clear() {
      this.products = [];
      this.productIdMap.clear();
      this.exactBarcodeMap.clear();
      this.exactSkuMap.clear();
      this.rawSkuMap.clear();
      this.skuPrefixMap.clear();
      this.tokenIndex.clear();
      this.primaryVehicleIndex.clear();
      this.compatibilityEntries = [];
      this.locationMap.clear();
      this.queryCache.clear();
    }

    buildIndex(productsList) {
      this.clear();
      if (!Array.isArray(productsList) || productsList.length === 0) return;
      this.products = productsList;

      for (let i = 0; i < productsList.length; i++) {
        this._indexProduct(productsList[i], i);
      }
    }

    _indexProduct(p, idx) {
      if (!p) return;
      const prodKey = String(p.id || p.barcode || p.sku || idx);
      this.productIdMap.set(prodKey, idx);

      // 1. Barcode indexing
      if (p.barcode) {
        const b = String(p.barcode).trim();
        this.exactBarcodeMap.set(b, idx);
        this.exactBarcodeMap.set(b.toLowerCase(), idx);
      }

      // 2. SKU indexing (raw, normalized, prefixes)
      if (p.sku) {
        const rawSku = String(p.sku).trim();
        const rawSkuLower = rawSku.toLowerCase();
        if (!this.rawSkuMap.has(rawSkuLower)) this.rawSkuMap.set(rawSkuLower, new Set());
        this.rawSkuMap.get(rawSkuLower).add(idx);

        const normSku = normalizeSKU(rawSku);
        if (normSku) {
          if (!this.exactSkuMap.has(normSku)) this.exactSkuMap.set(normSku, new Set());
          this.exactSkuMap.get(normSku).add(idx);

          // Index prefixes of normalized SKU (min 2 chars, up to 7 chars)
          const maxPfx = Math.min(normSku.length, 7);
          for (let len = 2; len <= maxPfx; len++) {
            const pfx = normSku.slice(0, len);
            if (!this.skuPrefixMap.has(pfx)) this.skuPrefixMap.set(pfx, new Set());
            this.skuPrefixMap.get(pfx).add(idx);
          }
        }

        // Split SKU by separators (e.g. KB-4521-X -> kb, 4521, x)
        const skuTokens = tokenize(rawSku);
        for (const t of skuTokens) {
          this._addToken(t, idx);
        }
      }

      // 3. Name, Brand, Category indexing
      const nameTokens = tokenize(p.name);
      for (const t of nameTokens) this._addToken(t, idx);

      const brandTokens = tokenize(p.brand);
      for (const t of brandTokens) this._addToken(t, idx);

      const catTokens = tokenize(p.category);
      for (const t of catTokens) this._addToken(t, idx);

      // 4. Primary Vehicle indexing
      const primaryVehicles = Array.isArray(p.vehicles) ? p.vehicles : (p.vehicle ? [p.vehicle] : []);
      for (const pv of primaryVehicles) {
        const vTokens = tokenize(pv);
        for (const t of vTokens) {
          this._addToken(t, idx);
          if (!this.primaryVehicleIndex.has(t)) this.primaryVehicleIndex.set(t, new Set());
          this.primaryVehicleIndex.get(t).add(idx);
        }
      }

      // 5. Compatibility indexing (CRITICAL REQUIREMENT)
      // Physical product fits multiple vehicles; can have vehicle-specific alternate names
      const compats = Array.isArray(p.compatibility) ? p.compatibility : (p.compatibility ? [p.compatibility] : []);
      for (const c of compats) {
        let make = '';
        let model = '';
        let altName = '';
        let fullVeh = '';

        if (typeof c === 'object' && c !== null) {
          make = String(c.make || '').trim();
          model = String(c.model || '').trim();
          altName = String(c.name || '').trim();
          fullVeh = `${make} ${model}`.trim();
        } else if (typeof c === 'string') {
          fullVeh = c.trim();
          const parts = fullVeh.split(/\s+/);
          make = parts[0] || '';
          model = parts.slice(1).join(' ') || '';
        }

        const compatTokens = tokenize(`${fullVeh} ${altName}`);
        for (const t of compatTokens) {
          this._addToken(t, idx);
        }

        this.compatibilityEntries.push({
          prodIdx: idx,
          make: make,
          model: model,
          vehicleFullName: fullVeh,
          name: altName,
          tokens: compatTokens
        });
      }

      // 6. Location indexing (CRITICAL REQUIREMENT)
      const locList = Array.isArray(p.locations) && p.locations.length > 0
        ? p.locations
        : [{ location: p.primary_location || p.location || p.loc || 'R1L1B1', storage_type: p.storage_type || p.primary_storage || 'SHOP' }];

      for (const locItem of locList) {
        const rawCode = String(locItem.location || locItem.code || '').trim().toUpperCase();
        if (!rawCode) continue;

        const isWh = rawCode.startsWith('W') || String(locItem.storage_type || '').toUpperCase() === 'WAREHOUSE';
        const zone = isWh ? 'WAREHOUSE' : 'SHOP';

        this._addLocationToken(rawCode, idx);
        this._addLocationToken(rawCode.toLowerCase(), idx);
        this._addLocationToken(zone.toLowerCase(), idx);

        const rackMatch = rawCode.match(/(W?R\d+)/);
        if (rackMatch) this._addLocationToken(rackMatch[1].toLowerCase(), idx);

        const binMatch = rawCode.match(/(B\d+)/);
        if (binMatch) this._addLocationToken(binMatch[1].toLowerCase(), idx);

        const rackLevelMatch = rawCode.match(/(W?R\d+L\d+)/);
        if (rackLevelMatch) this._addLocationToken(rackLevelMatch[1].toLowerCase(), idx);
      }
    }

    _addToken(token, idx) {
      if (!token) return;
      if (!this.tokenIndex.has(token)) {
        this.tokenIndex.set(token, new Set());
      }
      this.tokenIndex.get(token).add(idx);
    }

    _addLocationToken(token, idx) {
      if (!token) return;
      const t = token.toLowerCase();
      if (!this.locationMap.has(t)) {
        this.locationMap.set(t, new Set());
      }
      this.locationMap.get(t).add(idx);
    }

    updateProduct(prod) {
      if (!prod) return;
      const prodKey = String(prod.id || prod.barcode || prod.sku);
      if (this.productIdMap.has(prodKey)) {
        const idx = this.productIdMap.get(prodKey);
        this.products[idx] = prod;
        this.queryCache.clear();
      } else {
        const newIdx = this.products.length;
        this.products.push(prod);
        this._indexProduct(prod, newIdx);
        this.queryCache.clear();
      }
    }

    removeProduct(idOrBarcode) {
      if (!idOrBarcode) return;
      const key = String(idOrBarcode);
      if (this.productIdMap.has(key)) {
        const idx = this.productIdMap.get(key);
        this.products[idx] = null;
        this.queryCache.clear();
      }
    }

    search(rawQuery, options = {}) {
      const q = (rawQuery || '').trim();
      if (!q) return [];

      const qLower = q.toLowerCase();
      const cached = this.queryCache.get(qLower);
      if (cached) return cached;

      const limit = options.limit || 50;
      const qNormSku = normalizeSKU(q);
      const queryTokens = tokenize(q);

      const scoreMap = new Map();

      const addScore = (idx, score, reason, highlight, locationData) => {
        if (idx < 0 || idx >= this.products.length) return;
        const p = this.products[idx];
        if (!p) return;

        const existing = scoreMap.get(idx);
        if (!existing) {
          scoreMap.set(idx, {
            score: score,
            matchedReason: reason,
            matchHighlight: highlight || '',
            matchedLocations: locationData ? [locationData] : []
          });
        } else {
          if (score > existing.score) {
            existing.score = score;
            existing.matchedReason = reason;
            if (highlight) existing.matchHighlight = highlight;
          }
          if (locationData && !existing.matchedLocations.some(l => l.code === locationData.code)) {
            existing.matchedLocations.push(locationData);
          }
        }
      };

      // ── 1. EXACT BARCODE MATCH (Rank: 100) ──
      if (this.exactBarcodeMap.has(q) || this.exactBarcodeMap.has(qLower)) {
        const idx = this.exactBarcodeMap.get(q) ?? this.exactBarcodeMap.get(qLower);
        addScore(idx, 100, 'exact_barcode', `Barcode: ${q}`);
      }

      // ── 2. EXACT SKU MATCH (Rank: 100) ──
      if (this.rawSkuMap.has(qLower)) {
        for (const idx of this.rawSkuMap.get(qLower)) {
          addScore(idx, 100, 'exact_sku', `SKU: ${this.products[idx].sku}`);
        }
      }
      if (qNormSku && this.exactSkuMap.has(qNormSku)) {
        for (const idx of this.exactSkuMap.get(qNormSku)) {
          addScore(idx, 100, 'exact_sku', `SKU: ${this.products[idx].sku}`);
        }
      }

      // ── 3. PREFIX SKU MATCH (Rank: 95) ──
      if (qNormSku && qNormSku.length >= 2) {
        if (this.skuPrefixMap.has(qNormSku)) {
          for (const idx of this.skuPrefixMap.get(qNormSku)) {
            addScore(idx, 95, 'prefix_sku', `SKU prefix: ${q.toUpperCase()}`);
          }
        }
      }

      // ── 4. LOCATION DETECTION & FILTERING ──
      const detectedLocationTokens = [];
      const nonLocationTokens = [];
      for (const t of queryTokens) {
        if (this.locationMap.has(t)) {
          detectedLocationTokens.push(t);
        } else {
          nonLocationTokens.push(t);
        }
      }

      // Exact single location query (e.g. "R1L1B1")
      if (this.locationMap.has(qLower)) {
        for (const idx of this.locationMap.get(qLower)) {
          addScore(idx, 90, 'location', `📍 Location match: ${q.toUpperCase()}`, { code: q.toUpperCase() });
        }
      }

      // ── 5. COMPATIBILITY MATCHING (Rank: 80 - 85) ──
      for (let cIdx = 0; cIdx < this.compatibilityEntries.length; cIdx++) {
        const entry = this.compatibilityEntries[cIdx];
        const fullVehLower = entry.vehicleFullName.toLowerCase();
        const altNameLower = entry.name.toLowerCase();

        // Exact compatibility vehicle
        if (fullVehLower === qLower) {
          addScore(
            entry.prodIdx,
            80,
            'compatibility',
            `🔄 Fits ${entry.vehicleFullName}${entry.name ? ' — Saved name: ' + entry.name : ''}`
          );
        }
        // Vehicle + alternate name match (e.g. "unicorn brake pad")
        else if (queryTokens.length >= 2) {
          const matchesVehicle = queryTokens.some(t => fullVehLower.includes(t));
          const matchesAlt = entry.name && queryTokens.some(t => altNameLower.includes(t) || (TYPO_SYNONYMS[t] && altNameLower.includes(TYPO_SYNONYMS[t])));
          if (matchesVehicle && matchesAlt) {
            addScore(
              entry.prodIdx,
              85,
              'compatibility',
              `🔄 Fits ${entry.vehicleFullName} — Saved name: ${entry.name}`
            );
          } else if (matchesVehicle) {
            addScore(
              entry.prodIdx,
              75,
              'compatibility',
              `🔄 Compatible with ${entry.vehicleFullName}`
            );
          }
        } else if (queryTokens.length === 1) {
          const t = queryTokens[0];
          if (fullVehLower.includes(t) && t.length >= 3) {
            addScore(
              entry.prodIdx,
              75,
              'compatibility',
              `🔄 Compatible with ${entry.vehicleFullName}`
            );
          } else if (altNameLower.includes(t) && t.length >= 3) {
            addScore(
              entry.prodIdx,
              80,
              'compatibility',
              `🔄 Fits ${entry.vehicleFullName} (Alternate: ${entry.name})`
            );
          }
        }
      }

      // ── 6. PRIMARY VEHICLE MATCH (Rank: 75 - 85) ──
      for (const t of queryTokens) {
        if (this.primaryVehicleIndex.has(t)) {
          for (const idx of this.primaryVehicleIndex.get(t)) {
            const p = this.products[idx];
            const pv = Array.isArray(p.vehicles) ? p.vehicles[0] : (p.vehicle || '');
            addScore(idx, 75, 'primary_vehicle', `🏍️ ${pv || 'Primary vehicle'} match`);
          }
        }
      }

      // ── 7. TOKEN INVERTED INDEX & AUTOMOTIVE TYPO CORRECTION ──
      const expandedTokens = queryTokens.map(tok => {
        return TYPO_SYNONYMS[tok] ? TYPO_SYNONYMS[tok].split(' ') : [tok];
      }).flat();

      for (const tok of expandedTokens) {
        if (this.tokenIndex.has(tok)) {
          for (const idx of this.tokenIndex.get(tok)) {
            const p = this.products[idx];
            if (!p) continue;
            const pNameLower = (p.name || '').toLowerCase();
            const isExactName = pNameLower === qLower;
            const isBrand = (p.brand || '').toLowerCase() === tok;
            const isCat = (p.category || '').toLowerCase() === tok;

            let score = 50;
            let reason = 'token';
            if (isExactName) {
              score = 90;
              reason = 'exact_name';
            } else if (isBrand || isCat) {
              score = 65;
              reason = isBrand ? 'brand' : 'category';
            } else if (pNameLower.includes(qLower)) {
              score = 70;
              reason = 'name_contains';
            }
            addScore(idx, score, reason);
          }
        } else if (tok.length >= 3) {
          // Prefix matching in tokens
          for (const [indexedToken, idxSet] of this.tokenIndex.entries()) {
            if (indexedToken.startsWith(tok)) {
              for (const idx of idxSet) {
                addScore(idx, 60, 'prefix');
              }
            }
          }

          // Levenshtein typo tolerance for tokens >= 5 chars
          if (tok.length >= 5) {
            for (const [indexedToken, idxSet] of this.tokenIndex.entries()) {
              if (Math.abs(indexedToken.length - tok.length) <= 1 && indexedToken.length >= 4) {
                const dist = levenshteinDistance(tok, indexedToken);
                if (dist <= 1) {
                  for (const idx of idxSet) {
                    addScore(idx, 40, 'typo');
                  }
                }
              }
            }
          }
        }
      }

      // ── 8. COMPOUND MATCHES (Location + Product OR Vehicle + Product) ──
      if (detectedLocationTokens.length > 0 && nonLocationTokens.length > 0) {
        // e.g. "brake R1L1B1"
        for (const locTok of detectedLocationTokens) {
          if (this.locationMap.has(locTok)) {
            for (const idx of this.locationMap.get(locTok)) {
              const existing = scoreMap.get(idx);
              if (existing) {
                // Product already matched keyword and ALSO has this location!
                existing.score = Math.max(existing.score, 95);
                existing.matchedReason = 'compound_location';
                existing.matchHighlight = `📍 Located at ${locTok.toUpperCase()}`;
              }
            }
          }
        }
      }

      if (queryTokens.length > 1) {
        for (const [idx, item] of scoreMap.entries()) {
          const p = this.products[idx];
          if (!p) continue;
          const searchHaystack = `${p.name} ${p.brand || ''} ${p.category || ''} ${p.sku || ''} ${Array.isArray(p.vehicles) ? p.vehicles.join(' ') : ''}`.toLowerCase();
          const allMatched = queryTokens.every(tok => {
            const canonical = TYPO_SYNONYMS[tok] || tok;
            return searchHaystack.includes(tok) || searchHaystack.includes(canonical);
          });
          if (allMatched) {
            item.score = Math.max(item.score, 85);
            if (!item.matchHighlight) {
              item.matchHighlight = `Matched all query terms`;
            }
          }
        }
      }

      // Convert scoreMap to sorted result list
      const results = [];
      for (const [idx, matchData] of scoreMap.entries()) {
        const p = this.products[idx];
        if (!p) continue;

        const locationContext = [];
        if (Array.isArray(p.locations) && p.locations.length > 0) {
          for (const loc of p.locations) {
            locationContext.push({
              storage_type: loc.storage_type || (String(loc.location || '').toUpperCase().startsWith('W') ? 'WAREHOUSE' : 'SHOP'),
              location: loc.location || loc.code || '',
              qty: loc.qty ?? loc.stock ?? 0,
              is_primary: Boolean(loc.is_primary)
            });
          }
        } else {
          locationContext.push({
            storage_type: p.storage_type || p.primary_storage || 'SHOP',
            location: p.primary_location || p.location || p.loc || 'R1L1B1',
            qty: p.stock ?? p.qty ?? 0,
            is_primary: true
          });
        }

        results.push({
          product: p,
          score: matchData.score,
          matchedReason: matchData.matchedReason,
          matchHighlight: matchData.matchHighlight,
          matchedLocations: locationContext
        });
      }

      // Sort by Score DESC, then stock availability, then name ASC
      results.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const stockA = a.product.stock ?? a.product.qty ?? 0;
        const stockB = b.product.stock ?? b.product.qty ?? 0;
        if (stockB !== stockA) return stockB - stockA;
        return (a.product.name || '').localeCompare(b.product.name || '');
      });

      const sliced = results.slice(0, limit);
      this.queryCache.set(qLower, sliced);
      return sliced;
    }
  }

  const instance = new SearchIndex();

  /**
   * UI Dropdown Controller with Keyboard Navigation (Up/Down/Enter/Escape)
   */
  function attachSearchUI(inputEl, options = {}) {
    if (!inputEl) return null;

    let dropdownEl = document.getElementById(options.dropdownId || 'princeSearchDropdown');
    if (!dropdownEl) {
      dropdownEl = document.createElement('div');
      dropdownEl.id = options.dropdownId || 'princeSearchDropdown';
      dropdownEl.className = 'prince-search-dropdown';
      document.body.appendChild(dropdownEl);
    }

    let activeIndex = -1;
    let currentResults = [];
    let debounceTimer = null;

    function positionDropdown() {
      const rect = inputEl.getBoundingClientRect();
      dropdownEl.style.top = `${rect.bottom + window.scrollY + 6}px`;
      dropdownEl.style.left = `${Math.max(12, rect.left)}px`;
      dropdownEl.style.width = `${Math.min(window.innerWidth - 24, rect.width)}px`;
    }

    function renderDropdown(results) {
      currentResults = results;
      activeIndex = -1;

      if (!results || results.length === 0) {
        dropdownEl.style.display = 'none';
        return;
      }

      positionDropdown();
      dropdownEl.innerHTML = '';

      // Section: Top suggestions
      const hdr = document.createElement('div');
      hdr.className = 'psd-header';
      hdr.textContent = `Found ${results.length} result${results.length === 1 ? '' : 's'}`;
      dropdownEl.appendChild(hdr);

      const listContainer = document.createElement('div');
      listContainer.className = 'psd-list';

      results.forEach((item, index) => {
        const p = item.product;
        const row = document.createElement('div');
        row.className = 'psd-item';
        row.dataset.index = index;

        // Stock quantity lookup (via getEffectiveInventory if available, otherwise static)
        let effStock = p.stock ?? p.qty ?? 0;
        if (typeof window.getEffectiveInventory === 'function') {
          try {
            effStock = window.getEffectiveInventory(p.id || p.barcode || p.sku);
          } catch (e) { }
        }

        const isLow = effStock <= (p.threshold ?? 5);
        const isOut = effStock <= 0;

        let badgeHtml = '';
        if (item.matchHighlight) {
          badgeHtml = `<div class="psd-highlight">${escapeHTML(item.matchHighlight)}</div>`;
        }

        const primaryLoc = (item.matchedLocations && item.matchedLocations[0])
          ? `${item.matchedLocations[0].location} (${item.matchedLocations[0].storage_type || 'Shop'})`
          : (p.primary_location || p.location || p.loc || 'R1L1B1');

        row.innerHTML = `
          <div class="psd-item-left">
            <div class="psd-sku">${escapeHTML(p.sku || p.barcode || 'N/A')}</div>
            <div class="psd-name">${escapeHTML(p.name || 'Unnamed')}</div>
            ${badgeHtml}
            <div class="psd-meta">
              <span>📍 ${escapeHTML(primaryLoc)}</span>
              ${p.brand ? `<span>• ${escapeHTML(p.brand)}</span>` : ''}
              ${p.mrp ? `<span>• ₹${p.mrp}</span>` : ''}
            </div>
          </div>
          <div class="psd-item-right">
            <span class="psd-stock-badge ${isOut ? 'out' : isLow ? 'low' : 'ok'}">
              ${isOut ? '0 pcs' : `${effStock} pcs`}
            </span>
          </div>
        `;

        row.addEventListener('click', (e) => {
          e.stopPropagation();
          selectItem(index);
        });

        listContainer.appendChild(row);
      });

      dropdownEl.appendChild(listContainer);
      dropdownEl.style.display = 'block';
    }

    function selectItem(index) {
      if (index >= 0 && index < currentResults.length) {
        const item = currentResults[index];
        dropdownEl.style.display = 'none';
        if (typeof options.onSelect === 'function') {
          options.onSelect(item.product, item);
        } else if (typeof window.openProdDetail === 'function') {
          window.openProdDetail(item.product);
        }
      }
    }

    function updateHighlight() {
      const items = dropdownEl.querySelectorAll('.psd-item');
      items.forEach((el, idx) => {
        el.classList.toggle('active', idx === activeIndex);
        if (idx === activeIndex) {
          el.scrollIntoView({ block: 'nearest' });
        }
      });
    }

    // Input listener with 200-250ms debounce
    inputEl.addEventListener('input', function () {
      clearTimeout(debounceTimer);
      const val = this.value.trim();
      if (!val) {
        dropdownEl.style.display = 'none';
        return;
      }
      debounceTimer = setTimeout(() => {
        const results = instance.search(val);
        renderDropdown(results);
      }, 220);
    });

    // Keyboard navigation
    inputEl.addEventListener('keydown', function (e) {
      if (dropdownEl.style.display === 'none') return;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIndex = Math.min(activeIndex + 1, currentResults.length - 1);
        updateHighlight();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIndex = Math.max(activeIndex - 1, 0);
        updateHighlight();
      } else if (e.key === 'Enter') {
        if (activeIndex >= 0 && activeIndex < currentResults.length) {
          e.preventDefault();
          selectItem(activeIndex);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        dropdownEl.style.display = 'none';
      }
    });

    // Close on click outside
    document.addEventListener('click', function (e) {
      if (!inputEl.contains(e.target) && !dropdownEl.contains(e.target)) {
        dropdownEl.style.display = 'none';
      }
    });

    // Reposition on window resize
    window.addEventListener('resize', function () {
      if (dropdownEl.style.display === 'block') {
        positionDropdown();
      }
    });

    return {
      hide: () => { dropdownEl.style.display = 'none'; },
      render: renderDropdown
    };
  }

  return {
    instance: instance,
    init: function (productsList) {
      instance.buildIndex(productsList);
    },
    search: function (query, options) {
      return instance.search(query, options);
    },
    updateProduct: function (product) {
      instance.updateProduct(product);
    },
    removeProduct: function (idOrBarcode) {
      instance.removeProduct(idOrBarcode);
    },
    clearCache: function () {
      instance.queryCache.clear();
    },
    attachSearchUI: attachSearchUI,
    normalizeSKU: normalizeSKU,
    tokenize: tokenize
  };
});
