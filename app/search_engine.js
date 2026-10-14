/**
 * PRINCE PICKER — HIGH-PERFORMANCE ALGORITHMIC SEARCH ENGINE FOR ~20,000 SKUs
 * 
 * Offline-first, vocabulary-indexed, ranked search engine with:
 * - O(1) exact SKU, Barcode, and Product Name lookups
 * - Normalized SKU matching (KB-4521-X -> kb4521x) and SKU prefix matching
 * - Algorithmic Typo Tolerance (NO hardcoded typo dictionaries)
 * - Dynamic Damerau-Levenshtein & prefix candidate discovery across indexed vocabulary
 * - First-class Cross-Vehicle Compatibility search with match metadata
 * - Multi-location inventory search (Shop, Warehouse, Rack, Bin, Code)
 * - Compound multi-term queries (e.g. "vizor pulsar", "brake R1L1B1")
 * - LRU query cache (last 50 queries, <0.1ms return)
 * - Strict tiered ranking hierarchy (Exact always outranks fuzzy)
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

  // ──────────────────────────────────────────────
  // NORMALIZATION & TOKENIZATION
  // ──────────────────────────────────────────────

  function normalizeSKU(str) {
    if (!str) return '';
    return String(str).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function normalizeText(str) {
    if (!str) return '';
    return String(str)
      .normalize('NFKD')
      .toLowerCase()
      .replace(/[^\w\s-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function tokenize(str) {
    if (!str) return [];
    return String(str)
      .normalize('NFKD')
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

  function getCharCounts(str) {
    const counts = Object.create(null);
    for (let i = 0; i < str.length; i++) {
      const c = str[i];
      counts[c] = (counts[c] || 0) + 1;
    }
    return counts;
  }

  // ──────────────────────────────────────────────
  // ALGORITHMIC DAMERAU-LEVENSHTEIN (with transposition & early cutoff)
  // ──────────────────────────────────────────────

  function damerauLevenshtein(a, b, maxDist = 2) {
    if (a === b) return 0;
    const lenA = a.length, lenB = b.length;
    if (Math.abs(lenA - lenB) > maxDist) return maxDist + 1;
    if (lenA === 0) return lenB <= maxDist ? lenB : maxDist + 1;
    if (lenB === 0) return lenA <= maxDist ? lenA : maxDist + 1;

    const d = [];
    for (let i = 0; i <= lenA; i++) {
      d[i] = new Uint8Array(lenB + 1);
      d[i][0] = i;
    }
    for (let j = 0; j <= lenB; j++) {
      d[0][j] = j;
    }

    for (let i = 1; i <= lenA; i++) {
      let rowMin = 99;
      const aCode = a.charCodeAt(i - 1);
      for (let j = 1; j <= lenB; j++) {
        const bCode = b.charCodeAt(j - 1);
        const cost = aCode === bCode ? 0 : 1;
        let val = Math.min(
          d[i - 1][j] + 1,        // deletion
          d[i][j - 1] + 1,        // insertion
          d[i - 1][j - 1] + cost  // substitution
        );
        // Transposition (e.g. barke -> brake)
        if (i > 1 && j > 1 && aCode === b.charCodeAt(j - 2) && a.charCodeAt(i - 2) === bCode) {
          const transVal = d[i - 2][j - 2] + 1;
          if (transVal < val) val = transVal;
        }
        d[i][j] = val;
        if (val < rowMin) rowMin = val;
      }
      if (rowMin > maxDist) return maxDist + 1;
    }

    return d[lenA][lenB];
  }

  // ──────────────────────────────────────────────
  // LRU QUERY CACHE (Last 50 queries)
  // ──────────────────────────────────────────────

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

  // ──────────────────────────────────────────────
  // INVERTED SEARCH INDEX & ALGORITHMIC RETRIEVAL
  // ──────────────────────────────────────────────

  class SearchIndex {
    constructor() {
      this.products = [];
      this.productIdMap = new Map();       // ID / Barcode / SKU -> product index
      this.exactBarcodeMap = new Map();    // Barcode -> product index
      this.exactSkuMap = new Map();        // Normalized SKU -> Set of indices
      this.rawSkuMap = new Map();          // Lowercase raw SKU -> Set of indices
      this.skuPrefixMap = new Map();       // Prefix of normalized SKU -> Set of indices
      this.exactNameMap = new Map();       // Normalized full product name -> Set of indices
      
      // Token Inverted Posting Lists: token -> Set<prodIdx>
      this.tokenPostingMap = new Map();
      // Token Field Map: token -> Map<prodIdx, Set<fieldType>>
      this.tokenFieldMap = new Map();
      
      // Indexed Searchable Vocabulary (Unique tokens)
      this.vocabTokens = new Set();
      this.vocabByLength = new Map();      // length -> array of tokens
      this.vocabCharCounts = new Map();    // token -> char counts object
      this.vocabPrefix3Map = new Map();    // 3-char prefix -> array of tokens
      
      // Compatibility structures
      this.compatibilityEntries = [];      // array of structured compatibility records
      this.compatTokenToEntries = new Map(); // token -> Set<compatEntryIdx>
      
      // Location structure
      this.locationMap = new Map();        // location token -> Set<prodIdx>
      
      // Cache & state
      this.queryCache = new LRUCache(50);
      this.ready = false;
    }

    clear() {
      this.products = [];
      this.productIdMap.clear();
      this.exactBarcodeMap.clear();
      this.exactSkuMap.clear();
      this.rawSkuMap.clear();
      this.skuPrefixMap.clear();
      this.exactNameMap.clear();
      this.tokenPostingMap.clear();
      this.tokenFieldMap.clear();
      this.vocabTokens.clear();
      this.vocabByLength.clear();
      this.vocabCharCounts.clear();
      this.vocabPrefix3Map.clear();
      this.compatibilityEntries = [];
      this.compatTokenToEntries.clear();
      this.locationMap.clear();
      this.queryCache.clear();
      this.ready = false;
    }

    isReady() {
      return this.ready && this.products.length > 0;
    }

    buildIndex(productsList) {
      this.clear();
      if (!Array.isArray(productsList) || productsList.length === 0) {
        this.ready = true;
        return;
      }
      this.products = productsList;

      for (let i = 0; i < productsList.length; i++) {
        this._indexProduct(productsList[i], i);
      }

      this._finalizeVocabulary();
      this.ready = true;
    }

    _finalizeVocabulary() {
      this.vocabByLength.clear();
      this.vocabCharCounts.clear();
      this.vocabPrefix3Map.clear();

      for (const token of this.vocabTokens) {
        const len = token.length;
        if (!this.vocabByLength.has(len)) {
          this.vocabByLength.set(len, []);
        }
        this.vocabByLength.get(len).push(token);
        this.vocabCharCounts.set(token, getCharCounts(token));

        if (len >= 3) {
          const pfx = token.slice(0, 3);
          if (!this.vocabPrefix3Map.has(pfx)) {
            this.vocabPrefix3Map.set(pfx, []);
          }
          this.vocabPrefix3Map.get(pfx).push(token);
        }
      }
    }

    _indexProduct(p, idx) {
      if (!p) return;
      const prodKey = String(p.id || p.barcode || p.sku || idx);
      this.productIdMap.set(prodKey, idx);

      // 1. Exact Barcode indexing
      if (p.barcode) {
        const b = String(p.barcode).trim();
        this.exactBarcodeMap.set(b, idx);
        this.exactBarcodeMap.set(b.toLowerCase(), idx);
      }

      // 2. SKU indexing (raw, normalized, prefix, parts)
      if (p.sku) {
        const rawSku = String(p.sku).trim();
        const rawSkuLower = rawSku.toLowerCase();
        if (!this.rawSkuMap.has(rawSkuLower)) this.rawSkuMap.set(rawSkuLower, new Set());
        this.rawSkuMap.get(rawSkuLower).add(idx);

        const normSku = normalizeSKU(rawSku);
        if (normSku) {
          if (!this.exactSkuMap.has(normSku)) this.exactSkuMap.set(normSku, new Set());
          this.exactSkuMap.get(normSku).add(idx);

          // Index prefixes of normalized SKU (min 2 chars up to 8 chars)
          const maxPfx = Math.min(normSku.length, 8);
          for (let len = 2; len <= maxPfx; len++) {
            const pfx = normSku.slice(0, len);
            if (!this.skuPrefixMap.has(pfx)) this.skuPrefixMap.set(pfx, new Set());
            this.skuPrefixMap.get(pfx).add(idx);
          }
        }

        // Split SKU by separators (e.g. KB-4521-X -> kb, 4521, x)
        const skuTokens = tokenize(rawSku);
        for (const t of skuTokens) {
          if (t.length >= 3) {
            this._addToken(t, idx, 'SKU_PART');
          }
        }
      }

      // 3. Product Name indexing (O(1) exact name lookup + tokens)
      if (p.name) {
        const nameNorm = normalizeText(p.name);
        if (nameNorm) {
          if (!this.exactNameMap.has(nameNorm)) this.exactNameMap.set(nameNorm, new Set());
          this.exactNameMap.get(nameNorm).add(idx);
        }
        const nameTokens = tokenize(p.name);
        for (const t of nameTokens) {
          this._addToken(t, idx, 'NAME');
        }
      }

      // 4. Description indexing
      if (p.description) {
        const descTokens = tokenize(p.description);
        for (const t of descTokens) {
          this._addToken(t, idx, 'DESC');
        }
      }

      // 5. Brand & Category indexing
      if (p.brand) {
        const brandTokens = tokenize(p.brand);
        for (const t of brandTokens) {
          this._addToken(t, idx, 'BRAND');
        }
      }
      if (p.category) {
        const catTokens = tokenize(p.category);
        for (const t of catTokens) {
          this._addToken(t, idx, 'CAT');
        }
      }

      // 6. Primary Vehicles indexing
      const primaryVehicles = Array.isArray(p.vehicles)
        ? p.vehicles
        : (p.vehicle ? [p.vehicle] : []);
      for (const pv of primaryVehicles) {
        const vTokens = tokenize(pv);
        for (const t of vTokens) {
          this._addToken(t, idx, 'PRIMARY_VEH');
        }
      }

      // 7. Cross-Vehicle Compatibility Indexing (CRITICAL REQUIREMENT)
      const compats = Array.isArray(p.compatibility)
        ? p.compatibility
        : (p.compatibility ? (typeof p.compatibility === 'string' ? p.compatibility.split(',').map(s => s.trim()) : [p.compatibility]) : []);

      for (const c of compats) {
        let make = '';
        let model = '';
        let altName = '';
        let fullVeh = '';

        if (typeof c === 'object' && c !== null) {
          make = String(c.make || '').trim();
          model = String(c.model || '').trim();
          altName = String(c.name || c.alternate_name || '').trim();
          fullVeh = `${make} ${model}`.trim() || String(c.vehicle || '').trim();
        } else if (typeof c === 'string') {
          fullVeh = c.trim();
          const parts = fullVeh.split(/\s+/);
          make = parts[0] || '';
          model = parts.slice(1).join(' ') || '';
        }

        const vehTokens = tokenize(fullVeh);
        for (const t of vehTokens) {
          this._addToken(t, idx, 'COMPAT_VEH');
        }

        const altTokens = tokenize(altName);
        for (const t of altTokens) {
          this._addToken(t, idx, 'COMPAT_NAME');
        }

        const entryIdx = this.compatibilityEntries.length;
        const allCompatTokens = [...new Set([...vehTokens, ...altTokens])];

        this.compatibilityEntries.push({
          prodIdx: idx,
          make: make,
          model: model,
          vehicleFullName: fullVeh,
          name: altName,
          vehicleTokens: vehTokens,
          nameTokens: altTokens,
          allTokens: allCompatTokens
        });

        for (const t of allCompatTokens) {
          if (!this.compatTokenToEntries.has(t)) {
            this.compatTokenToEntries.set(t, new Set());
          }
          this.compatTokenToEntries.get(t).add(entryIdx);
        }
      }

      // 8. Location Indexing (Shop, Warehouse, Rack, Level, Bin)
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

    _addToken(token, idx, fieldType) {
      if (!token) return;
      if (!this.tokenPostingMap.has(token)) {
        this.tokenPostingMap.set(token, new Set());
      }
      this.tokenPostingMap.get(token).add(idx);

      if (!this.tokenFieldMap.has(token)) {
        this.tokenFieldMap.set(token, new Map());
      }
      const prodFieldMap = this.tokenFieldMap.get(token);
      if (!prodFieldMap.has(idx)) {
        prodFieldMap.set(idx, new Set());
      }
      prodFieldMap.get(idx).add(fieldType);

      this.vocabTokens.add(token);
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
        this._indexProduct(prod, idx);
        this._finalizeVocabulary();
        this.queryCache.clear();
      } else {
        const newIdx = this.products.length;
        this.products.push(prod);
        this._indexProduct(prod, newIdx);
        this._finalizeVocabulary();
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

    // ──────────────────────────────────────────────
    // ALGORITHMIC CANDIDATE GENERATION (PER TOKEN)
    // ──────────────────────────────────────────────

    getCandidatesForToken(tok) {
      const L = tok.length;
      const candidates = [];
      const seen = new Set();

      // 1. Exact match on vocabulary
      if (this.tokenPostingMap.has(tok)) {
        candidates.push({ token: tok, dist: 0, type: 'exact', similarity: 1.0 });
        seen.add(tok);
      }

      // 2. Prefix match on vocabulary (for length >= 3)
      if (L >= 3) {
        const pfx3 = tok.slice(0, 3);
        const pfxBucket = this.vocabPrefix3Map.get(pfx3);
        if (pfxBucket) {
          for (let i = 0; i < pfxBucket.length; i++) {
            const vTok = pfxBucket[i];
            if (vTok.length > L && vTok.startsWith(tok)) {
              if (!seen.has(vTok)) {
                const sim = Math.max(0.5, L / vTok.length);
                candidates.push({ token: vTok, dist: 0.5, type: 'prefix', similarity: sim });
                seen.add(vTok);
              }
            }
          }
        }
      }

      // 3. Algorithmic Typo Tolerance Rules (strictly dynamic, NO dictionaries):
      // - 1-2 chars: exact/prefix only (no fuzzy)
      // - 3 chars: conservative (only if no exact/prefix match, maxDist = 1, same first char, not pure digits)
      // - 4-5 chars: maxDist = 1
      // - 6+ chars: maxDist = 2
      let maxDist = 0;
      let allowFuzzy = false;
      const isAllDigits = /^\d+$/.test(tok);

      if (L <= 2) {
        maxDist = 0;
        allowFuzzy = false;
      } else if (L === 3) {
        if (candidates.length === 0 && !isAllDigits) {
          maxDist = 1;
          allowFuzzy = true;
        }
      } else if (L >= 4 && L <= 5) {
        maxDist = 1;
        allowFuzzy = true;
      } else if (L >= 6) {
        maxDist = 2;
        allowFuzzy = true;
      }

      if (allowFuzzy && maxDist > 0 && !isAllDigits) {
        const qCounts = getCharCounts(tok);
        const minLen = Math.max(3, L - maxDist);
        const maxLen = L + maxDist;

        for (let len = minLen; len <= maxLen; len++) {
          const bucket = this.vocabByLength.get(len);
          if (!bucket) continue;

          for (let i = 0; i < bucket.length; i++) {
            const vTok = bucket[i];
            if (seen.has(vTok)) continue;

            // Strict conservative rule for 3-letter tokens: must match initial char or transposition
            if (L === 3) {
              const initialMatch = (vTok[0] === tok[0]) || (vTok[0] === tok[1] && vTok[1] === tok[0]);
              if (!initialMatch) continue;
            }

            // Rapid character overlap pruning (skip if characters differ by more than maxDist)
            const vCounts = this.vocabCharCounts.get(vTok);
            if (vCounts) {
              let overlap = 0;
              for (const c in qCounts) {
                if (vCounts[c]) overlap += Math.min(qCounts[c], vCounts[c]);
              }
              if (overlap < Math.max(L, len) - maxDist) continue;
            }

            // Calculate true Damerau-Levenshtein distance with transpositions
            const dist = damerauLevenshtein(tok, vTok, maxDist);
            if (dist <= maxDist) {
              const sim = Math.max(0.4, 1.0 - (dist / Math.max(L, len)));
              candidates.push({ token: vTok, dist: dist, type: 'fuzzy', similarity: sim });
              seen.add(vTok);
            }
          }
        }
      }

      // Order candidates: exact first, then lower edit distance, then higher similarity
      candidates.sort((a, b) => {
        if (a.dist !== b.dist) return a.dist - b.dist;
        return b.similarity - a.similarity;
      });

      return candidates;
    }

    // ──────────────────────────────────────────────
    // FULL SEARCH & RANKING PIPELINE
    // ──────────────────────────────────────────────

    search(rawQuery, options = {}) {
      const q = (rawQuery || '').trim();
      if (!q) {
        const emptyRes = [];
        emptyRes.items = emptyRes;
        emptyRes.total = 0;
        emptyRes.query = '';
        return emptyRes;
      }

      const qLower = q.toLowerCase();
      const cached = this.queryCache.get(qLower);
      if (cached) return cached;

      const limit = options.limit || 50;
      const qNormSku = normalizeSKU(q);
      const queryTokens = tokenize(q);

      // Score Map: prodIdx -> { score, matchedReason, matchHighlight, matchType, matchedLocations, ... }
      const scoreMap = new Map();

      const recordScore = (idx, score, reason, highlight, matchType = 'exact', locationData = null) => {
        if (idx < 0 || idx >= this.products.length) return;
        const p = this.products[idx];
        if (!p) return;

        const existing = scoreMap.get(idx);
        if (!existing) {
          scoreMap.set(idx, {
            score: score,
            matchedReason: reason,
            matchHighlight: highlight || '',
            matchType: matchType,
            matchedLocations: locationData ? [locationData] : []
          });
        } else {
          if (score > existing.score) {
            existing.score = score;
            existing.matchedReason = reason;
            if (highlight) existing.matchHighlight = highlight;
            existing.matchType = matchType;
          }
          if (locationData && !existing.matchedLocations.some(l => l.code === locationData.code)) {
            existing.matchedLocations.push(locationData);
          }
        }
      };

      // ── STEP 1: EXACT BARCODE MATCH (Rank: 10,000) ──
      if (this.exactBarcodeMap.has(q) || this.exactBarcodeMap.has(qLower)) {
        const idx = this.exactBarcodeMap.get(q) ?? this.exactBarcodeMap.get(qLower);
        recordScore(idx, 10000, 'exact_barcode', `Barcode: ${q}`, 'exact_barcode');
      }

      // ── STEP 1: EXACT RAW SKU MATCH (Rank: 9,900) ──
      if (this.rawSkuMap.has(qLower)) {
        for (const idx of this.rawSkuMap.get(qLower)) {
          recordScore(idx, 9900, 'exact_sku', `SKU: ${this.products[idx].sku}`, 'exact_sku');
        }
      }

      // ── STEP 1: EXACT NORMALIZED SKU MATCH (Rank: 9,800) ──
      if (qNormSku && this.exactSkuMap.has(qNormSku)) {
        for (const idx of this.exactSkuMap.get(qNormSku)) {
          recordScore(idx, 9800, 'exact_sku', `SKU: ${this.products[idx].sku}`, 'exact_sku');
        }
      }

      // If an exact SKU or Barcode matched:
      // Prompt Rule: "SKU searches: prioritize exact/prefix matching. Do not aggressively fuzzy-match arbitrary SKU fragments."
      // If exact SKU/Barcode matched, return exact match immediately without adding arbitrary noise
      if (scoreMap.size > 0 && (this.exactBarcodeMap.has(q) || this.exactBarcodeMap.has(qLower) || this.rawSkuMap.has(qLower) || (qNormSku && this.exactSkuMap.has(qNormSku)))) {
        return this._formatAndCacheResults(scoreMap, limit, qLower, q);
      }

      // ── STEP 1: EXACT PRODUCT NAME MATCH (Rank: 8,500) ──
      const qNormText = normalizeText(q);
      if (qNormText && this.exactNameMap.has(qNormText)) {
        for (const idx of this.exactNameMap.get(qNormText)) {
          recordScore(idx, 8500, 'exact_name', this.products[idx].name, 'exact_name');
        }
      }

      // ── STEP 2: SKU PREFIX MATCH (Rank: 5,500) ──
      if (qNormSku && qNormSku.length >= 2) {
        if (this.skuPrefixMap.has(qNormSku)) {
          for (const idx of this.skuPrefixMap.get(qNormSku)) {
            recordScore(idx, 5500, 'prefix_sku', `SKU prefix: ${q.toUpperCase()}`, 'prefix_sku');
          }
        }
      }

      // ── LOCATION QUERIES (Exact rack/bin/code) ──
      const detectedLocationTokens = [];
      const nonLocationTokens = [];
      for (const t of queryTokens) {
        if (this.locationMap.has(t)) {
          detectedLocationTokens.push(t);
        } else {
          nonLocationTokens.push(t);
        }
      }

      if (this.locationMap.has(qLower)) {
        for (const idx of this.locationMap.get(qLower)) {
          recordScore(idx, 6000, 'location', `📍 Location match: ${q.toUpperCase()}`, 'location', { code: q.toUpperCase() });
        }
      }

      // ── PER-TOKEN CANDIDATE RETRIEVAL ACROSS SEARCHABLE VOCABULARY ──
      const tokenCandidatesMap = new Map();
      let totalCandidateCount = 0;

      for (const tok of queryTokens) {
        const cands = this.getCandidatesForToken(tok);
        tokenCandidatesMap.set(tok, cands);
        totalCandidateCount += cands.length;
      }

      // If gibberish query with 0 candidates across all tokens and no exact/prefix match:
      // return immediately (avoiding false positives)
      if (totalCandidateCount === 0 && scoreMap.size === 0) {
        const emptyRes = [];
        emptyRes.items = emptyRes;
        emptyRes.total = 0;
        emptyRes.query = q;
        this.queryCache.set(qLower, emptyRes);
        return emptyRes;
      }

      // ── STEP 3: CROSS-VEHICLE COMPATIBILITY MATCHING (Via Inverted Index) ──
      // Collect matching compatibility entries using indexed posting sets (NO full scan!)
      const matchedCompatEntryIndices = new Set();
      for (const qTok of queryTokens) {
        const cands = tokenCandidatesMap.get(qTok) || [];
        for (const cand of cands) {
          const entrySet = this.compatTokenToEntries.get(cand.token);
          if (entrySet) {
            for (const eIdx of entrySet) {
              matchedCompatEntryIndices.add(eIdx);
            }
          }
        }
      }

      for (const cIdx of matchedCompatEntryIndices) {
        const entry = this.compatibilityEntries[cIdx];
        const vehTokens = entry.vehicleTokens;
        const altTokens = entry.nameTokens;

        let vehMatched = false;
        let altMatched = false;
        let vehExact = false;
        let altExact = false;

        for (const qTok of queryTokens) {
          const cands = tokenCandidatesMap.get(qTok) || [];
          for (const cand of cands) {
            if (vehTokens.includes(cand.token)) {
              vehMatched = true;
              if (cand.dist === 0) vehExact = true;
            }
            if (altTokens.includes(cand.token)) {
              altMatched = true;
              if (cand.dist === 0) altExact = true;
            }
          }
        }

        if (vehMatched && altMatched) {
          const score = (vehExact && altExact) ? 7000 : 6600;
          const altLabel = entry.name ? ` (Saved name: ${entry.name})` : '';
          recordScore(
            entry.prodIdx,
            score,
            'compatibility',
            `🔄 Fits ${entry.vehicleFullName}${altLabel}`,
            'compatibility'
          );
        } else if (altMatched && queryTokens.length === 1) {
          recordScore(
            entry.prodIdx,
            altExact ? 6500 : 5800,
            'compatibility',
            `🔄 Fits ${entry.vehicleFullName} (Saved name: ${entry.name})`,
            'compatibility'
          );
        } else if (vehMatched && queryTokens.length === 1) {
          recordScore(
            entry.prodIdx,
            vehExact ? 5800 : 5200,
            'compatibility',
            `🔄 Compatible with ${entry.vehicleFullName}`,
            'compatibility'
          );
        }
      }

      // ── STEP 4: TOKEN INVERTED INDEX MATCHING (EXACT, PREFIX, FUZZY) ──
      // Process candidate products via inverted posting lists (O(candidates), NEVER O(20,000)!)
      const productCoverageMap = new Map();

      for (let tIdx = 0; tIdx < queryTokens.length; tIdx++) {
        const qTok = queryTokens[tIdx];
        const cands = tokenCandidatesMap.get(qTok) || [];

        for (const cand of cands) {
          const candWord = cand.token;
          const postingSet = this.tokenPostingMap.get(candWord);
          if (!postingSet) continue;

          for (const pIdx of postingSet) {
            let cov = productCoverageMap.get(pIdx);
            if (!cov) {
              cov = {
                queryTokensMatched: new Set(),
                simSum: 0,
                bestReason: 'token',
                bestHighlight: '',
                bestField: 'DESC',
                hasExactWord: false
              };
              productCoverageMap.set(pIdx, cov);
            }

            if (!cov.queryTokensMatched.has(tIdx)) {
              cov.queryTokensMatched.add(tIdx);
              cov.simSum += cand.similarity;
            }

            if (cand.dist === 0) {
              cov.hasExactWord = true;
            }

            const fieldMap = this.tokenFieldMap.get(candWord);
            const fieldSet = fieldMap ? fieldMap.get(pIdx) : null;
            if (fieldSet) {
              if (fieldSet.has('NAME')) cov.bestField = 'NAME';
              else if (fieldSet.has('BRAND') && cov.bestField !== 'NAME') cov.bestField = 'BRAND';
              else if (fieldSet.has('PRIMARY_VEH') && cov.bestField !== 'NAME') cov.bestField = 'PRIMARY_VEH';
            }

            if (cand.dist > 0 && !cov.bestHighlight) {
              cov.bestHighlight = `~${candWord}`;
              cov.bestReason = 'fuzzy_spelling';
            }
          }
        }
      }

      // Score products based on token coverage
      for (const [pIdx, cov] of productCoverageMap.entries()) {
        const p = this.products[pIdx];
        if (!p) continue;

        const matchedCount = cov.queryTokensMatched.size;
        const totalTokens = queryTokens.length;
        const avgSim = cov.simSum / matchedCount;

        // In multi-word queries, prune out single-token weak matches if query has 3+ tokens or if SKU_PART only
        if (totalTokens >= 3 && matchedCount < 2) continue;
        if (totalTokens > 1 && matchedCount === 1 && cov.bestField === 'SKU_PART' && !cov.hasExactWord) continue;

        let baseScore = 0;
        let reason = cov.bestReason;
        let matchType = 'token';
        let highlight = cov.bestHighlight;

        const pNameLower = (p.name || '').toLowerCase();

        if (totalTokens === 1) {
          const candObj = (tokenCandidatesMap.get(queryTokens[0]) || [])[0];
          const isExact = cov.hasExactWord;
          const isNamePrefix = pNameLower.startsWith(qLower);

          if (isExact) {
            if (cov.bestField === 'NAME') {
              baseScore = 4800;
              reason = 'exact_name_token';
              matchType = 'exact_name';
            } else if (cov.bestField === 'BRAND' || cov.bestField === 'CAT') {
              baseScore = 3200;
              reason = 'exact_brand';
              matchType = 'exact_brand';
            } else {
              baseScore = 2800;
              reason = 'exact_token';
            }
          } else if (isNamePrefix) {
            baseScore = 4200;
            reason = 'name_prefix';
            matchType = 'prefix';
            highlight = `Prefix: ${q}`;
          } else {
            // Algorithmic Fuzzy Match (e.g. "vizor" -> "visor", "clutsh" -> "clutch")
            if (cov.bestField === 'NAME') {
              baseScore = 3500 * avgSim;
              reason = 'fuzzy_spelling';
              matchType = 'fuzzy';
              if (candObj) highlight = `Did you mean "${candObj.token}"?`;
            } else if (cov.bestField === 'BRAND' || cov.bestField === 'PRIMARY_VEH') {
              baseScore = 2400 * avgSim;
              reason = 'fuzzy_brand_vehicle';
              matchType = 'fuzzy';
            } else {
              baseScore = 1800 * avgSim;
              reason = 'fuzzy_general';
              matchType = 'fuzzy';
            }
          }
        } else {
          // Multi-word queries: "vizor pulsar", "splender clutsh"
          if (matchedCount === totalTokens) {
            baseScore = 4000 + (cov.simSum * 400);
            reason = cov.hasExactWord ? 'multi_term_match' : 'multi_term_fuzzy';
            matchType = cov.hasExactWord ? 'multi_term' : 'fuzzy';
            highlight = `Matched all query terms (${queryTokens.join(' + ')})`;

            // Check if matches both primary vehicle and part name
            const pvList = Array.isArray(p.vehicles) ? p.vehicles : (p.vehicle ? [p.vehicle] : []);
            if (pvList.length > 0) {
              const pvTokens = tokenize(pvList.join(' '));
              const nameTokens = tokenize(p.name);
              const hasVeh = queryTokens.some(t => {
                const cands = tokenCandidatesMap.get(t) || [];
                return cands.some(c => pvTokens.includes(c.token));
              });
              const hasName = queryTokens.some(t => {
                const cands = tokenCandidatesMap.get(t) || [];
                return cands.some(c => nameTokens.includes(c.token));
              });
              if (hasVeh && hasName) {
                baseScore = 7500;
                reason = 'vehicle_product';
                matchType = 'vehicle_product';
                highlight = `🏍️ ${pvList[0]} • ${p.name}`;
              }
            }
          } else if (matchedCount > 1) {
            baseScore = 1500 + (matchedCount * 600) + (cov.simSum * 200);
            reason = 'partial_terms_match';
            matchType = 'partial';
          } else {
            // Only 1 out of multiple terms matched
            baseScore = 800 + (avgSim * 300);
            reason = 'single_term_match';
            matchType = 'partial';
          }
        }

        recordScore(pIdx, baseScore, reason, highlight, matchType);
      }

      // ── COMPOUND LOCATION QUERIES (Product + Location) ──
      // e.g. "brake R1L1B2"
      if (detectedLocationTokens.length > 0 && nonLocationTokens.length > 0) {
        for (const locTok of detectedLocationTokens) {
          if (this.locationMap.has(locTok)) {
            for (const idx of this.locationMap.get(locTok)) {
              const existing = scoreMap.get(idx);
              if (existing) {
                existing.score = Math.max(existing.score, 6500) + 1500;
                existing.matchedReason = 'compound_location';
                existing.matchHighlight = `📍 Located at ${locTok.toUpperCase()}`;
                existing.matchType = 'compound';
              }
            }
          }
        }
      }

      return this._formatAndCacheResults(scoreMap, limit, qLower, q, options.threshold || 500);
    }

    _formatAndCacheResults(scoreMap, limit, cacheKey, originalQuery, minThreshold = 500) {
      const results = [];
      for (const [idx, matchData] of scoreMap.entries()) {
        if (matchData.score < minThreshold) continue;
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
          score: Math.round(matchData.score),
          matchedReason: matchData.matchedReason,
          matchHighlight: matchData.matchHighlight,
          matchType: matchData.matchType,
          matchedLocations: locationContext
        });
      }

      // ── STRICT RANKING HIERARCHY ──
      // 1. Score DESC (Exact > Prefix > Multi-term > Fuzzy)
      // 2. In-Stock over Out-of-Stock
      // 3. Alphabetical Name ASC
      results.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const stockA = a.product.stock ?? a.product.qty ?? 0;
        const stockB = b.product.stock ?? b.product.qty ?? 0;
        if ((stockB > 0) !== (stockA > 0)) return (stockB > 0 ? 1 : 0) - (stockA > 0 ? 1 : 0);
        if (stockB !== stockA) return stockB - stockA;
        return (a.product.name || '').localeCompare(b.product.name || '');
      });

      const sliced = results.slice(0, limit);
      sliced.items = sliced;
      sliced.total = results.length;
      sliced.query = originalQuery;

      this.queryCache.set(cacheKey, sliced);
      return sliced;
    }
  }

  const instance = new SearchIndex();

  // ──────────────────────────────────────────────
  // UI DROPDOWN & AUTOCOMPLETE CONTROLLER
  // ──────────────────────────────────────────────

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
      currentResults = results ? (results.items || results) : [];
      activeIndex = -1;

      if (!currentResults || currentResults.length === 0) {
        dropdownEl.style.display = 'none';
        return;
      }

      positionDropdown();
      dropdownEl.innerHTML = '';

      const hdr = document.createElement('div');
      hdr.className = 'psd-header';
      hdr.textContent = `Found ${currentResults.length} result${currentResults.length === 1 ? '' : 's'}`;
      dropdownEl.appendChild(hdr);

      const listContainer = document.createElement('div');
      listContainer.className = 'psd-list';

      currentResults.forEach((item, index) => {
        const p = item.product;
        const row = document.createElement('div');
        row.className = 'psd-item';
        row.dataset.index = index;

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

    // 200–250ms debounce listener
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

    document.addEventListener('click', function (e) {
      if (!inputEl.contains(e.target) && !dropdownEl.contains(e.target)) {
        dropdownEl.style.display = 'none';
      }
    });

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

  // ──────────────────────────────────────────────
  // PUBLIC API EXPORTS
  // ──────────────────────────────────────────────

  return {
    instance: instance,
    init: function (productsList) {
      instance.buildIndex(productsList);
    },
    isReady: function () {
      return instance.isReady();
    },
    search: function (query, options) {
      return instance.search(query, options);
    },
    updateProduct: function (product) {
      instance.updateProduct(product);
    },
    indexProduct: function (product) {
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
    tokenize: tokenize,
    damerauLevenshtein: damerauLevenshtein
  };
});
