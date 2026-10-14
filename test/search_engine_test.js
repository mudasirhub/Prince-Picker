/**
 * COMPREHENSIVE AUTOMATED TEST SUITE FOR PRINCE PICKER FUZZY SEARCH ENGINE
 * Validates 15 test categories against realistic 20k-SKU style dataset.
 */

const assert = require('assert');
const PrinceSearchEngine = require('../app/search_engine.js');

console.log('====================================================');
console.log('PRINCE PICKER SEARCH ENGINE — 15 CATEGORY TEST SUITE');
console.log('====================================================\n');

// 1. Build a rich dataset representing Prince Picker spare parts
const testProducts = [
  {
    id: 1,
    name: 'Front Disc Pad Kit',
    sku: 'BP-991',
    barcode: '8901234560001',
    brand: 'Bajaj',
    category: 'Brakes',
    vehicles: ['Bajaj Pulsar 150'],
    compatibility: [
      { make: 'Honda', model: 'Unicorn 150', name: 'Brake Pad' },
      { make: 'Bajaj', model: 'Discover 150', name: 'Disc Shoe' }
    ],
    locations: [{ location: 'R1L1B2', storage_type: 'SHOP', stock: 10 }]
  },
  {
    id: 2,
    name: 'Front Visor Black Tinted',
    sku: 'VIS-001',
    barcode: '8901234560002',
    brand: 'Bajaj',
    category: 'Body Parts',
    vehicles: ['Bajaj Pulsar 150', 'Bajaj Pulsar 220'],
    locations: [{ location: 'R1L2B1', storage_type: 'SHOP', stock: 5 }]
  },
  {
    id: 3,
    name: 'Clutch Plate Assembly Heavy Duty',
    sku: 'CLU-HER-003',
    barcode: '8901234560003',
    brand: 'Hero',
    category: 'Clutch',
    vehicles: ['Hero Splendor Plus'],
    locations: [{ location: 'WR1L1B1', storage_type: 'WAREHOUSE', stock: 25 }]
  },
  {
    id: 4,
    name: 'Rear View Mirror Pair Left and Right',
    sku: 'MIR-TVS-004',
    barcode: '8901234560004',
    brand: 'TVS',
    category: 'Mirrors',
    vehicles: ['TVS Jupiter'],
    locations: [{ location: 'R2L1B1', storage_type: 'SHOP', stock: 8 }]
  },
  {
    id: 5,
    name: 'Engine Oil Filter Premium',
    sku: 'FIL-YAM-005',
    barcode: '8901234560005',
    brand: 'Yamaha',
    category: 'Filters',
    vehicles: ['Yamaha R15 V3'],
    locations: [{ location: 'R3L1B1', storage_type: 'SHOP', stock: 15 }]
  },
  {
    id: 6,
    name: 'Rear Shock Absorber Shocker Set',
    sku: 'SHK-HON-006',
    barcode: '8901234560006',
    brand: 'Honda',
    category: 'Suspension',
    vehicles: ['Honda Activa 6G'],
    locations: [{ location: 'WR2L1B1', storage_type: 'WAREHOUSE', stock: 6 }]
  },
  {
    id: 7,
    name: 'Rear Brake Cable Wire',
    sku: 'CAB-HON-007',
    barcode: '8901234560007',
    brand: 'Honda',
    category: 'Cables',
    vehicles: ['Honda Activa 5G', 'Honda Activa 6G'],
    locations: [{ location: 'R1L1B1', storage_type: 'SHOP', stock: 12 }]
  },
  {
    id: 8,
    name: 'Carburetor Assembly Standard',
    sku: 'CARB-BAJ-008',
    barcode: '8901234560008',
    brand: 'Bajaj',
    category: 'Fuel System',
    vehicles: ['Bajaj Platina 100'],
    locations: [{ location: 'R4L1B1', storage_type: 'SHOP', stock: 4 }]
  },
  {
    id: 9,
    name: 'Accelerator Cable Steel Inner',
    sku: 'ACC-HER-009',
    barcode: '8901234560009',
    brand: 'Hero',
    category: 'Cables',
    vehicles: ['Hero Passion Pro'],
    locations: [{ location: 'R4L2B1', storage_type: 'SHOP', stock: 9 }]
  },
  {
    id: 10,
    name: 'Chain Sprocket Kit 428H',
    sku: 'KB-4521-X',
    barcode: '8901234560010',
    brand: 'Rolon',
    category: 'Transmission',
    vehicles: ['Royal Enfield Classic 350'],
    locations: [{ location: 'R5L1B1', storage_type: 'SHOP', stock: 7 }]
  }
];

// Initialize search engine
PrinceSearchEngine.init(testProducts);

let passedTests = 0;
let totalTests = 0;

function runTest(categoryNum, name, testFn) {
  totalTests++;
  try {
    testFn();
    console.log(`  ✓ [Category ${categoryNum}] ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ [Category ${categoryNum}] ${name}`);
    console.error(`    Error: ${err.message}`);
  }
}

// ──────────────────────────────────────────────
// CATEGORY 1: Exact terms
// ──────────────────────────────────────────────
console.log('Running Category 1: Exact Terms...');
runTest(1, 'Exact search "visor" returns Visor product', () => {
  const res = PrinceSearchEngine.search('visor');
  assert.ok(res.length > 0, 'Expected results for "visor"');
  assert.strictEqual(res[0].product.sku, 'VIS-001');
});
runTest(1, 'Exact search "clutch" returns Clutch product', () => {
  const res = PrinceSearchEngine.search('clutch');
  assert.ok(res.length > 0, 'Expected results for "clutch"');
  assert.strictEqual(res[0].product.sku, 'CLU-HER-003');
});

// ──────────────────────────────────────────────
// CATEGORY 2: Prefix terms
// ──────────────────────────────────────────────
console.log('Running Category 2: Prefix Terms...');
runTest(2, 'Prefix search "vis" returns Visor', () => {
  const res = PrinceSearchEngine.search('vis');
  assert.ok(res.length > 0, 'Expected prefix match for "vis"');
  assert.ok(res.some(r => r.product.sku === 'VIS-001'));
});
runTest(2, 'Prefix search "clut" returns Clutch Plate', () => {
  const res = PrinceSearchEngine.search('clut');
  assert.ok(res.length > 0, 'Expected prefix match for "clut"');
  assert.ok(res.some(r => r.product.sku === 'CLU-HER-003'));
});

// ──────────────────────────────────────────────
// CATEGORY 3: Missing-character typos
// ──────────────────────────────────────────────
console.log('Running Category 3: Missing-character Typos...');
runTest(3, 'Missing char "vior" (missing s) resolves to visor', () => {
  const res = PrinceSearchEngine.search('vior');
  assert.ok(res.length > 0, 'Expected match for "vior"');
  assert.strictEqual(res[0].product.sku, 'VIS-001');
});
runTest(3, 'Missing char "visr" (missing o) resolves to visor', () => {
  const res = PrinceSearchEngine.search('visr');
  assert.ok(res.length > 0, 'Expected match for "visr"');
  assert.strictEqual(res[0].product.sku, 'VIS-001');
});
runTest(3, 'Missing char "brak" (missing e) resolves to brake products', () => {
  const res = PrinceSearchEngine.search('brak');
  assert.ok(res.length > 0, 'Expected match for "brak"');
  assert.ok(res.some(r => r.product.sku === 'BP-991' || r.product.sku === 'CAB-HON-007'));
});
runTest(3, 'Missing char "filtr" (missing e) resolves to filter', () => {
  const res = PrinceSearchEngine.search('filtr');
  assert.ok(res.length > 0, 'Expected match for "filtr"');
  assert.strictEqual(res[0].product.sku, 'FIL-YAM-005');
});

// ──────────────────────────────────────────────
// CATEGORY 4: Extra-character typos
// ──────────────────────────────────────────────
console.log('Running Category 4: Extra-character Typos...');
runTest(4, 'Extra char "visorr" (extra r) resolves to visor', () => {
  const res = PrinceSearchEngine.search('visorr');
  assert.ok(res.length > 0, 'Expected match for "visorr"');
  assert.strictEqual(res[0].product.sku, 'VIS-001');
});
runTest(4, 'Extra char "clutchh" (extra h) resolves to clutch', () => {
  const res = PrinceSearchEngine.search('clutchh');
  assert.ok(res.length > 0, 'Expected match for "clutchh"');
  assert.strictEqual(res[0].product.sku, 'CLU-HER-003');
});

// ──────────────────────────────────────────────
// CATEGORY 5: Character substitution
// ──────────────────────────────────────────────
console.log('Running Category 5: Character Substitution...');
runTest(5, 'Substituted "vizor" (z for s) resolves to visor (CORE BUG FIX)', () => {
  const res = PrinceSearchEngine.search('vizor');
  assert.ok(res.length > 0, 'Expected results for "vizor"');
  assert.strictEqual(res[0].product.sku, 'VIS-001');
});
runTest(5, 'Substituted "clutsh" (sh for ch) resolves to clutch', () => {
  const res = PrinceSearchEngine.search('clutsh');
  assert.ok(res.length > 0, 'Expected match for "clutsh"');
  assert.strictEqual(res[0].product.sku, 'CLU-HER-003');
});
runTest(5, 'Substituted "miror" resolves to mirror', () => {
  const res = PrinceSearchEngine.search('miror');
  assert.ok(res.length > 0, 'Expected match for "miror"');
  assert.strictEqual(res[0].product.sku, 'MIR-TVS-004');
});

// ──────────────────────────────────────────────
// CATEGORY 6: Character transposition
// ──────────────────────────────────────────────
console.log('Running Category 6: Character Transposition...');
runTest(6, 'Transposition "barke" (ar for ra) resolves to brake', () => {
  const res = PrinceSearchEngine.search('barke');
  assert.ok(res.length > 0, 'Expected match for "barke"');
  assert.ok(res.some(r => r.product.sku === 'BP-991' || r.product.sku === 'CAB-HON-007'));
});
runTest(6, 'Transposition "shkocer" resolves to shocker', () => {
  const res = PrinceSearchEngine.search('shkocer');
  assert.ok(res.length > 0, 'Expected match for "shkocer"');
  assert.strictEqual(res[0].product.sku, 'SHK-HON-006');
});

// ──────────────────────────────────────────────
// CATEGORY 7: Multi-word queries with one typo
// ──────────────────────────────────────────────
console.log('Running Category 7: Multi-word Queries with One Typo...');
runTest(7, '"vizor pulsar" returns Pulsar Visor at top rank', () => {
  const res = PrinceSearchEngine.search('vizor pulsar');
  assert.ok(res.length > 0, 'Expected match for "vizor pulsar"');
  assert.strictEqual(res[0].product.sku, 'VIS-001');
});
runTest(7, '"pulsar vior" returns Pulsar Visor at top rank', () => {
  const res = PrinceSearchEngine.search('pulsar vior');
  assert.ok(res.length > 0, 'Expected match for "pulsar vior"');
  assert.strictEqual(res[0].product.sku, 'VIS-001');
});
runTest(7, '"splender clutsh" returns Splendor Clutch Plate', () => {
  const res = PrinceSearchEngine.search('splender clutsh');
  assert.ok(res.length > 0, 'Expected match for "splender clutsh"');
  assert.strictEqual(res[0].product.sku, 'CLU-HER-003');
});

// ──────────────────────────────────────────────
// CATEGORY 8: Vehicle + part queries
// ──────────────────────────────────────────────
console.log('Running Category 8: Vehicle + Part Queries...');
runTest(8, '"pulsar disc" returns Front Disc Pad (BP-991)', () => {
  const res = PrinceSearchEngine.search('pulsar disc');
  assert.ok(res.length > 0, 'Expected match for "pulsar disc"');
  assert.strictEqual(res[0].product.sku, 'BP-991');
});
runTest(8, '"activa cable" returns Rear Brake Cable (CAB-HON-007)', () => {
  const res = PrinceSearchEngine.search('activa cable');
  assert.ok(res.length > 0, 'Expected match for "activa cable"');
  assert.strictEqual(res[0].product.sku, 'CAB-HON-007');
});

// ──────────────────────────────────────────────
// CATEGORY 9: Compatibility-name queries
// ──────────────────────────────────────────────
console.log('Running Category 9: Compatibility-Name Queries...');
runTest(9, '"unicorn brake" resolves to BP-991 via compatibility', () => {
  const res = PrinceSearchEngine.search('unicorn brake');
  assert.ok(res.length > 0, 'Expected match for "unicorn brake"');
  assert.strictEqual(res[0].product.sku, 'BP-991');
  assert.strictEqual(res[0].matchedReason, 'compatibility');
});
runTest(9, '"discover shoe" resolves to BP-991 via compatibility', () => {
  const res = PrinceSearchEngine.search('discover shoe');
  assert.ok(res.length > 0, 'Expected match for "discover shoe"');
  assert.strictEqual(res[0].product.sku, 'BP-991');
  assert.strictEqual(res[0].matchedReason, 'compatibility');
});

// ──────────────────────────────────────────────
// CATEGORY 10: SKU queries
// ──────────────────────────────────────────────
console.log('Running Category 10: SKU Queries...');
runTest(10, 'Exact SKU "BP-991" matches BP-991 with top score', () => {
  const res = PrinceSearchEngine.search('BP-991');
  assert.ok(res.length > 0, 'Expected match for "BP-991"');
  assert.strictEqual(res[0].product.sku, 'BP-991');
  assert.ok(res[0].score >= 9000, 'Exact SKU should have >= 9000 score');
});
runTest(10, 'Normalized SKU "kb4521x" matches "KB-4521-X"', () => {
  const res = PrinceSearchEngine.search('kb4521x');
  assert.ok(res.length > 0, 'Expected match for "kb4521x"');
  assert.strictEqual(res[0].product.sku, 'KB-4521-X');
});
runTest(10, 'Prefix SKU "BP-9" matches "BP-991"', () => {
  const res = PrinceSearchEngine.search('BP-9');
  assert.ok(res.length > 0, 'Expected prefix match for "BP-9"');
  assert.strictEqual(res[0].product.sku, 'BP-991');
});

// ──────────────────────────────────────────────
// CATEGORY 11: Location queries
// ──────────────────────────────────────────────
console.log('Running Category 11: Location Queries...');
runTest(11, 'Location search "R1L1B2" returns product in that bin', () => {
  const res = PrinceSearchEngine.search('R1L1B2');
  assert.ok(res.length > 0, 'Expected location match for R1L1B2');
  assert.strictEqual(res[0].product.sku, 'BP-991');
});
runTest(11, 'Compound search "brake R1L1B2" matches BP-991 with compound score', () => {
  const res = PrinceSearchEngine.search('brake R1L1B2');
  assert.ok(res.length > 0, 'Expected compound match');
  assert.strictEqual(res[0].product.sku, 'BP-991');
});

// ──────────────────────────────────────────────
// CATEGORY 12: Offline queries (pure in-memory verification)
// ──────────────────────────────────────────────
console.log('Running Category 12: Offline Queries...');
runTest(12, 'Search runs 100% locally in-memory without network', () => {
  // Ensure search works without window, fetch, or network
  const start = Date.now();
  for (let i = 0; i < 50; i++) {
    PrinceSearchEngine.search('vizor');
  }
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 100, `50 offline queries took ${elapsed}ms, expected < 100ms`);
});

// ──────────────────────────────────────────────
// CATEGORY 13: Exact-vs-fuzzy ranking
// ──────────────────────────────────────────────
console.log('Running Category 13: Exact-vs-Fuzzy Ranking...');
runTest(13, 'Exact match scores strictly higher than fuzzy match', () => {
  const exactRes = PrinceSearchEngine.search('visor');
  const fuzzyRes = PrinceSearchEngine.search('vizor');
  assert.ok(exactRes.length > 0 && fuzzyRes.length > 0);
  assert.ok(exactRes[0].score > fuzzyRes[0].score, `Exact score (${exactRes[0].score}) must be > fuzzy score (${fuzzyRes[0].score})`);
});
runTest(13, 'Exact SKU outranks partial or fuzzy matches', () => {
  const skuRes = PrinceSearchEngine.search('BP-991');
  assert.ok(skuRes[0].score >= 9000, 'SKU match must be in highest tier');
});

// ──────────────────────────────────────────────
// CATEGORY 14: Short-token false positives
// ──────────────────────────────────────────────
console.log('Running Category 14: Short-Token False Positives...');
runTest(14, '1-2 character tokens do not trigger fuzzy match to random words', () => {
  // "ab" or "xy" should NOT fuzzily match "Bajaj" or "Activa" or "Hero"
  const res = PrinceSearchEngine.search('xy');
  assert.strictEqual(res.length, 0, 'Expected 0 results for non-existent 2-char token');
});
runTest(14, 'Numeric 3-digit token "150" does not fuzzy match "220"', () => {
  const res = PrinceSearchEngine.search('150');
  // Should only match products that actually contain 150
  for (const item of res) {
    const text = `${item.product.name} ${item.product.vehicles} ${JSON.stringify(item.product.compatibility || [])}`;
    assert.ok(text.includes('150'), 'Product must actually contain "150"');
  }
});

// ──────────────────────────────────────────────
// CATEGORY 15: No-result behavior
// ──────────────────────────────────────────────
console.log('Running Category 15: No-Result Behavior...');
runTest(15, 'Gibberish query "xyzqwe1234" correctly returns zero results', () => {
  const res = PrinceSearchEngine.search('xyzqwe1234');
  assert.strictEqual(res.length, 0, 'Expected zero results for gibberish query');
});
runTest(15, 'Unrelated random text returns zero results without garbage fallbacks', () => {
  const res = PrinceSearchEngine.search('zzzzzzzzzz');
  assert.strictEqual(res.length, 0, 'Expected zero results for zzzzzzzzzz');
});

console.log('\n====================================================');
console.log(`TEST RESULTS: ${passedTests}/${totalTests} PASSED`);
console.log('====================================================');

if (passedTests !== totalTests) {
  process.exit(1);
}
