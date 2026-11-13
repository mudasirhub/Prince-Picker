/**
 * HYBRID SEARCH ENGINE AUTOMATED REGRESSION TEST SUITE
 * 
 * Verifies all required search engine criteria:
 * 1. Exact matching (test -> test)
 * 2. Prefix matching (tes -> test)
 * 3. Substring matching, including incomplete words (est -> test)
 * 4. Whitespace normalization and token merging (te st -> test)
 * 5. Fuzzy matching with Damerau-Levenshtein distance:
 *    - Missing characters (tst -> test, vior -> visor)
 *    - Transposed characters (tset -> test, viosr -> visor)
 *    - Substituted characters (vizor -> visor)
 * 6. Strict ranking priority: Exact > Prefix > Substring > Fuzzy
 * 7. Conservative matching for 1-2 char queries (0 edits, no fuzzy)
 * 8. At most one edit for 3-4 char queries (dist <= 1)
 * 9. Preservation of product ranking, SKU grouping, fitment, and location search
 * 10. Indexed vocabulary rather than linear scanning
 */

const assert = require('assert');
const PrinceSearchEngine = require('../app/search_engine.js');

console.log('===============================================================');
console.log('HYBRID TOKEN SEARCH ENGINE — AUTOMATED REGRESSION SUITE');
console.log('===============================================================\n');

let totalTests = 0;
let passedTests = 0;

function test(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    Error: ${err.message}`);
    if (err.stack) console.error(err.stack);
  }
}

// ─────────────────────────────────────────────────────────────
// DATASET INITIALIZATION
// ─────────────────────────────────────────────────────────────

const regressionProducts = [
  {
    id: 1,
    name: 'Spark Plug Test Unit Standard',
    sku: 'TST-001',
    barcode: '8901000000001',
    brand: 'Bosch',
    category: 'Electrical',
    vehicles: ['Bajaj Pulsar 150'],
    locations: [{ location: 'R1L1B1', storage_type: 'SHOP', stock: 10 }]
  },
  {
    id: 2,
    name: 'Front Visor Black Tinted',
    sku: 'VIS-001',
    barcode: '8901000000002',
    brand: 'Bajaj',
    category: 'Body Parts',
    vehicles: ['Bajaj Pulsar 150', 'Bajaj Pulsar 220'],
    compatibility: [
      { make: 'Honda', model: 'Unicorn 160', name: 'Windshield Screen' }
    ],
    locations: [{ location: 'R1L2B1', storage_type: 'SHOP', stock: 5 }]
  },
  {
    id: 3,
    name: 'Testing Adapter Cable',
    sku: 'TST-ADAPT-003',
    barcode: '8901000000003',
    brand: 'OEM',
    category: 'Cables',
    vehicles: ['Hero Splendor Plus'],
    locations: [{ location: 'R2L1B1', storage_type: 'SHOP', stock: 15 }]
  },
  {
    id: 4,
    name: 'Latest Diagnostic Equipment Tool',
    sku: 'TOOL-LST-004',
    barcode: '8901000000004',
    brand: 'Minda',
    category: 'Tools',
    vehicles: ['Universal Two Wheeler'],
    locations: [{ location: 'WR1L1B1', storage_type: 'WAREHOUSE', stock: 8 }]
  },
  {
    id: 5,
    name: 'Front Disc Brake Pad Set',
    sku: 'BP-991',
    barcode: '8901000000005',
    brand: 'Bajaj',
    category: 'Brakes',
    vehicles: ['Bajaj Pulsar 150'],
    compatibility: [
      { make: 'Honda', model: 'Unicorn 150', name: 'Brake Pad' },
      { make: 'Bajaj', model: 'Discover 150', name: 'Disc Shoe' }
    ],
    locations: [{ location: 'R1L1B2', storage_type: 'SHOP', stock: 12 }]
  },
  {
    id: 6,
    name: 'Chain Sprocket Heavy Duty',
    sku: 'KB-4521-X',
    barcode: '8901000000006',
    brand: 'Rolon',
    category: 'Transmission',
    vehicles: ['Royal Enfield Classic 350'],
    locations: [{ location: 'R3L1B1', storage_type: 'SHOP', stock: 0 }] // out of stock
  },
  {
    id: 7,
    name: 'Chain Sprocket Standard Kit',
    sku: 'KB-4521-Y',
    barcode: '8901000000007',
    brand: 'Rolon',
    category: 'Transmission',
    vehicles: ['Royal Enfield Classic 350'],
    locations: [{ location: 'R3L1B2', storage_type: 'SHOP', stock: 7 }] // in stock
  }
];

PrinceSearchEngine.init(regressionProducts);

// ─────────────────────────────────────────────────────────────
// SUITE 1: USER-SPECIFIED TEST CASES
// ─────────────────────────────────────────────────────────────
console.log('Suite 1: Required Target Test Cases');

test('test → test (Exact match)', () => {
  const res = PrinceSearchEngine.search('test');
  assert.ok(res.length > 0, 'Expected results for "test"');
  assert.strictEqual(res[0].product.id, 1, 'Product 1 ("Test Unit") should be top result');
  assert.strictEqual(res[0].matchType, 'exact_name');
  assert.strictEqual(res[0].score, 5000);
});

test('est → test (Substring matching, incomplete word)', () => {
  const res = PrinceSearchEngine.search('est');
  assert.ok(res.length > 0, 'Expected results for "est"');
  const matchedTest = res.some(r => r.product.id === 1);
  assert.ok(matchedTest, 'Product 1 ("Test Unit") should be matched by substring "est"');
  assert.strictEqual(res[0].matchType, 'substring');
});

test('te st → test (Whitespace normalization & token merging)', () => {
  const res = PrinceSearchEngine.search('te st');
  assert.ok(res.length > 0, 'Expected results for "te st"');
  assert.strictEqual(res[0].product.id, 1, 'Product 1 ("Test Unit") should be matched by "te st"');
  assert.strictEqual(res[0].matchType, 'exact_name');
});

test('tst → test (Missing character detection, Damerau-Levenshtein dist 1)', () => {
  const res = PrinceSearchEngine.search('tst');
  assert.ok(res.length > 0, 'Expected results for "tst"');
  const matchedTest = res.some(r => r.product.id === 1);
  assert.ok(matchedTest, 'Product 1 ("Test Unit") should be matched by "tst"');
});

test('tset → test (Transposed character detection, Damerau-Levenshtein dist 1)', () => {
  const res = PrinceSearchEngine.search('tset');
  assert.ok(res.length > 0, 'Expected results for "tset"');
  assert.strictEqual(res[0].product.id, 1, 'Product 1 ("Test Unit") should be matched by "tset"');
  assert.strictEqual(res[0].matchType, 'fuzzy');
});

test('tes → test (Prefix matching)', () => {
  const res = PrinceSearchEngine.search('tes');
  assert.ok(res.length > 0, 'Expected results for "tes"');
  const matchedTest = res.some(r => r.product.id === 1);
  assert.ok(matchedTest, 'Product 1 ("Test Unit") should be matched by prefix "tes"');
  assert.strictEqual(res[0].matchType, 'prefix');
});

test('vior → visor (Missing character detection "s")', () => {
  const res = PrinceSearchEngine.search('vior');
  assert.ok(res.length > 0, 'Expected results for "vior"');
  assert.strictEqual(res[0].product.id, 2, 'Product 2 ("Visor") should be top result');
  assert.strictEqual(res[0].matchType, 'fuzzy');
});

test('vizor → visor (Substituted character detection "z" for "s")', () => {
  const res = PrinceSearchEngine.search('vizor');
  assert.ok(res.length > 0, 'Expected results for "vizor"');
  assert.strictEqual(res[0].product.id, 2, 'Product 2 ("Visor") should be top result');
  assert.strictEqual(res[0].matchType, 'fuzzy');
});

test('viosr → visor (Transposed character detection "os" for "so")', () => {
  const res = PrinceSearchEngine.search('viosr');
  assert.ok(res.length > 0, 'Expected results for "viosr"');
  assert.strictEqual(res[0].product.id, 2, 'Product 2 ("Visor") should be top result');
  assert.strictEqual(res[0].matchType, 'fuzzy');
});

// ─────────────────────────────────────────────────────────────
// SUITE 2: STRICT RANKING PRIORITY (Exact > Prefix > Substring > Fuzzy)
// ─────────────────────────────────────────────────────────────
console.log('\nSuite 2: Strict Ranking Priority');

test('Ranking order is strictly Exact > Prefix > Substring > Fuzzy', () => {
  // Test query "test":
  // Exact match: "Spark Plug Test Unit Standard" (id: 1)
  // Prefix match: "Testing Adapter Cable" (id: 3)
  // Substring match: "Latest Diagnostic Tester Tool" (id: 4)
  const res = PrinceSearchEngine.search('test');
  assert.ok(res.length >= 3, 'Expected at least 3 matches');

  const exactIdx = res.findIndex(r => r.product.id === 1);
  const prefixIdx = res.findIndex(r => r.product.id === 3);
  const substrIdx = res.findIndex(r => r.product.id === 4);

  assert.ok(exactIdx !== -1, 'Exact match must exist');
  assert.ok(prefixIdx !== -1, 'Prefix match must exist');
  assert.ok(substrIdx !== -1, 'Substring match must exist');

  assert.ok(exactIdx < prefixIdx, `Exact index (${exactIdx}) must precede Prefix index (${prefixIdx})`);
  assert.ok(prefixIdx < substrIdx, `Prefix index (${prefixIdx}) must precede Substring index (${substrIdx})`);

  assert.ok(res[exactIdx].score > res[prefixIdx].score, 'Exact score must be > Prefix score');
  assert.ok(res[prefixIdx].score > res[substrIdx].score, 'Prefix score must be > Substring score');
});

test('Prefix match strictly outranks Substring and Fuzzy when no exact match exists', () => {
  // Query "tes" against index:
  // Prefix: "Test Unit" (id: 1) and "Testing Adapter" (id: 3)
  // Substring: "Latest Diagnostic Tester Tool" (id: 4)
  const res = PrinceSearchEngine.search('tes');
  assert.ok(res.length >= 2, 'Expected prefix and substring matches');

  const pfxItem = res.find(r => r.product.id === 1 || r.product.id === 3);
  const subItem = res.find(r => r.product.id === 4);

  assert.ok(pfxItem && subItem, 'Both prefix and substring items must be found');
  assert.ok(pfxItem.score > subItem.score, `Prefix score (${pfxItem.score}) must exceed Substring score (${subItem.score})`);
});

test('Substring match strictly outranks Fuzzy match', () => {
  // Setup a mini-index to verify Substring vs Fuzzy scoring directly
  const compIndex = [
    { id: 101, name: 'Latest Product Substring', sku: 'SUB-1', stock: 10 },
    { id: 102, name: 'Tea Product Fuzzy', sku: 'FUZ-2', stock: 10 }
  ];
  PrinceSearchEngine.init(compIndex);

  const res = PrinceSearchEngine.search('tes');
  // "tes" is a substring of "Latest"
  // "tes" is fuzzy 1-edit from "Tea"
  const sub = res.find(r => r.product.id === 101);
  const fuz = res.find(r => r.product.id === 102);

  assert.ok(sub, 'Substring product must match');
  assert.ok(fuz, 'Fuzzy product must match');
  assert.ok(sub.score > fuz.score, `Substring score (${sub.score}) must exceed Fuzzy score (${fuz.score})`);

  // Restore main regression dataset
  PrinceSearchEngine.init(regressionProducts);
});

// ─────────────────────────────────────────────────────────────
// SUITE 3: CONSERVATIVE MATCHING FOR 1-2 CHARACTER QUERIES
// ─────────────────────────────────────────────────────────────
console.log('\nSuite 3: Conservative Matching for 1-2 Char Queries');

test('1-character query returns 0 results to prevent false positive floods', () => {
  const res = PrinceSearchEngine.search('t');
  assert.strictEqual(res.length, 0, '1-character token "t" must return 0 results');
});

test('2-character query does NOT trigger fuzzy matching for typos', () => {
  // "ts" matches SKU prefix 'TST-001' with type 'prefix_sku', but must NOT trigger fuzzy matching
  const res = PrinceSearchEngine.search('ts');
  const hasFuzzy = res.some(r => r.matchType === 'fuzzy');
  assert.strictEqual(hasFuzzy, false, '2-character query "ts" must NOT trigger fuzzy matching');

  // Query with no prefix/exact match returns 0 results
  const resXy = PrinceSearchEngine.search('xy');
  assert.strictEqual(resXy.length, 0, '2-character non-matching query "xy" must return 0 results');
});

test('2-character query with non-existent token returns 0 results', () => {
  const res = PrinceSearchEngine.search('xz');
  assert.strictEqual(res.length, 0, '2-character query "xz" must return 0 results');
});

test('2-character valid prefix safely matches without fuzzy distortion', () => {
  // "te" is a valid prefix of "test" / "testing"
  const res = PrinceSearchEngine.search('te');
  assert.ok(res.length > 0, '2-character prefix "te" should match "test" / "testing"');
  for (const item of res) {
    assert.strictEqual(item.matchType, 'prefix', 'Match type must be prefix');
  }
});

// ─────────────────────────────────────────────────────────────
// SUITE 4: 3-4 CHARACTER EDIT LIMITS (At Most One Edit)
// ─────────────────────────────────────────────────────────────
console.log('\nSuite 4: 3-4 Character Query Edit Limits');

test('3-character query allows 1 edit (tst -> test, dist = 1)', () => {
  const res = PrinceSearchEngine.search('tst');
  assert.ok(res.length > 0, '1 edit on 3-char query must match');
});

test('3-character query rejects 2 edits (txx -> test, dist = 2)', () => {
  const resTxx = PrinceSearchEngine.search('txx');
  const matchedTest = resTxx.some(r => r.product.id === 1);
  assert.strictEqual(matchedTest, false, '2 edits on 3-char query must NOT match');
});

test('4-character query allows 1 edit (tset -> test, transposition dist = 1)', () => {
  const res = PrinceSearchEngine.search('tset');
  assert.ok(res.length > 0, '1 edit on 4-char query must match');
});

test('4-character query rejects 2 edits (txxt -> test, dist = 2)', () => {
  const res = PrinceSearchEngine.search('txxt');
  const matchedTest = res.some(r => r.product.id === 1);
  assert.strictEqual(matchedTest, false, '2 edits on 4-char query must NOT match');
});

test('3-digit numeric query does not fuzzy match unrelated numbers', () => {
  const res = PrinceSearchEngine.search('150');
  // Must match only products containing 150
  assert.ok(res.length > 0);
  for (const item of res) {
    const hay = `${item.product.name} ${item.product.vehicles} ${JSON.stringify(item.product.compatibility || [])}`;
    assert.ok(hay.includes('150'), 'Numeric query must only match products containing 150');
  }
});

// ─────────────────────────────────────────────────────────────
// SUITE 5: PRESERVATION OF EXISTING FUNCTIONALITY
// ─────────────────────────────────────────────────────────────
console.log('\nSuite 5: Preservation of Existing Functionality');

test('Preserves SKU grouping & matching: Exact, Normalized, Prefix', () => {
  // Exact SKU
  const exactRes = PrinceSearchEngine.search('BP-991');
  assert.ok(exactRes.length > 0);
  assert.strictEqual(exactRes[0].product.sku, 'BP-991');
  assert.strictEqual(exactRes[0].score, 9900);

  // Normalized SKU (no hyphens, lowercase)
  const normRes = PrinceSearchEngine.search('kb4521x');
  assert.ok(normRes.length > 0);
  assert.strictEqual(normRes[0].product.sku, 'KB-4521-X');

  // SKU prefix
  const pfxRes = PrinceSearchEngine.search('BP-9');
  assert.ok(pfxRes.length > 0);
  assert.strictEqual(pfxRes[0].product.sku, 'BP-991');
});

test('Preserves Product Ranking: In-stock over Out-of-stock, stock DESC, name ASC', () => {
  // Products 6 and 7 both have normalized SKU prefix 'KB-4521'
  // Product 6: stock = 0 (out of stock)
  // Product 7: stock = 7 (in stock)
  const res = PrinceSearchEngine.search('KB-4521');
  assert.ok(res.length >= 2, 'Expected both KB-4521 products');
  assert.strictEqual(res[0].product.id, 7, 'In-stock product (stock=7) must rank above out-of-stock product');
  assert.strictEqual(res[1].product.id, 6, 'Out-of-stock product (stock=0) must rank lower');
});

test('Preserves Fitment & Vehicle Compatibility Search', () => {
  // Primary vehicle
  const vehRes = PrinceSearchEngine.search('pulsar visor');
  assert.ok(vehRes.length > 0);
  assert.strictEqual(vehRes[0].product.id, 2);

  // Compatibility make + model + alternate part name
  const compRes = PrinceSearchEngine.search('unicorn brake');
  assert.ok(compRes.length > 0);
  assert.strictEqual(compRes[0].product.sku, 'BP-991');
});

test('Preserves Location Search (Shop, Warehouse, Compound)', () => {
  // Bin code
  const locRes = PrinceSearchEngine.search('R1L1B2');
  assert.ok(locRes.length > 0);
  assert.strictEqual(locRes[0].product.sku, 'BP-991');

  // Warehouse location
  const whRes = PrinceSearchEngine.search('WR1L1B1');
  assert.ok(whRes.length > 0);
  assert.strictEqual(whRes[0].product.id, 4);

  // Compound location query: Product + Location
  const compoundRes = PrinceSearchEngine.search('brake R1L1B2');
  assert.ok(compoundRes.length > 0);
  assert.strictEqual(compoundRes[0].product.sku, 'BP-991');
  assert.strictEqual(compoundRes[0].matchType, 'compound');
});

test('Uses indexed vocabulary rather than scanning entire product database', () => {
  assert.ok(PrinceSearchEngine.instance.vocabTokens.size > 0, 'Vocabulary tokens must be indexed');
  assert.ok(PrinceSearchEngine.instance.vocabByLength.size > 0, 'Vocabulary by length must be indexed');
  assert.ok(PrinceSearchEngine.instance.vocabSubstring3Map.size > 0, 'Vocabulary 3-gram substrings must be indexed');
  assert.ok(PrinceSearchEngine.instance.vocabPrefix3Map.size > 0, 'Vocabulary 3-gram prefixes must be indexed');
});

// ─────────────────────────────────────────────────────────────
// SUMMARY
// ─────────────────────────────────────────────────────────────
console.log('\n===============================================================');
console.log(`REGRESSION TEST RESULTS: ${passedTests}/${totalTests} PASSED`);
console.log('===============================================================');

if (passedTests !== totalTests) {
  process.exit(1);
}
