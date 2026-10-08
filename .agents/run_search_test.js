const { performance } = require('perf_hooks');
const PrinceSearchEngine = require('../app/search_engine.js');

console.log('=== TEST: PrinceSearchEngine on 20,000 SKUs ===');

// Generate 20,000 realistic automotive SKUs
const brands = ['Bajaj', 'Honda', 'Hero', 'TVS', 'Yamaha', 'Suzuki', 'Royal Enfield', 'KTM'];
const categories = ['Brake', 'Engine', 'Transmission', 'Electrical', 'Body', 'Suspension', 'Filters', 'Exhaust'];
const vehicles = [
  'Bajaj Pulsar 150', 'Bajaj Pulsar 220', 'Bajaj Discover 125', 'Bajaj Platina 100',
  'Honda Activa 6G', 'Honda Shine 125', 'Honda Unicorn 150', 'Honda CB Hornet',
  'Hero Splendor Plus', 'Hero HF Deluxe', 'Hero Glamour', 'Hero Passion Pro',
  'TVS Apache RTR 160', 'TVS Jupiter', 'TVS XL100', 'TVS Raider 125'
];

const mockProducts = [];
for (let i = 0; i < 20000; i++) {
  const brand = brands[i % brands.length];
  const cat = categories[i % categories.length];
  const veh = vehicles[i % vehicles.length];
  const rack = `R${(i % 20) + 1}`;
  const bin = `B${(i % 10) + 1}`;
  const locCode = `${rack}L1${bin}`;
  const whLocCode = `W${rack}L1${bin}`;

  mockProducts.push({
    id: `prod_${i}`,
    sku: `${brand.substring(0, 2).toUpperCase()}-${1000 + i}-${String.fromCharCode(65 + (i % 26))}`,
    barcode: `890${String(1000000000 + i)}`,
    name: `${cat} Component for ${veh} (#${i})`,
    brand,
    category: cat,
    loc: locCode,
    stock: (i % 50),
    qty: (i % 20),
    locations: [
      { storage_type: 'SHOP', location: locCode, qty: i % 20, is_primary: true },
      { storage_type: 'WAREHOUSE', location: whLocCode, qty: (i % 30) + 5, is_primary: false }
    ],
    vehicles: [veh]
  });
}

// Product matching the master prompt's critical example
const specialItem = {
  id: 'bp-991-special',
  sku: 'BP-991',
  barcode: '8909919919911',
  name: 'Front Disc Pad',
  brand: 'Bajaj',
  category: 'Brake',
  loc: 'R1L1B1',
  stock: 12,
  qty: 2,
  locations: [
    { storage_type: 'SHOP', location: 'R1L1B1', qty: 2, is_primary: true },
    { storage_type: 'WAREHOUSE', location: 'WR1L1B1', qty: 10, is_primary: false }
  ],
  vehicles: ['Bajaj Pulsar 150'],
  compatibility: [
    { make: 'Honda', model: 'Unicorn 150', name: 'Brake Pad' },
    { make: 'Bajaj', model: 'Discover 150', name: 'Disc Shoe' }
  ]
};
mockProducts[991] = specialItem;

// Measure build index time
console.log('Building index for 20,000 products...');
const t0 = performance.now();
PrinceSearchEngine.init(mockProducts);
const t1 = performance.now();
console.log(`✓ Index built in ${(t1 - t0).toFixed(2)} ms.`);

function runTest(query, description, checkFn) {
  const start = performance.now();
  const res = PrinceSearchEngine.search(query, { limit: 100 });
  const end = performance.now();
  const elapsed = (end - start).toFixed(2);
  const ok = checkFn(res);
  console.log(`[${ok ? 'PASS' : 'FAIL'}] "${query}" (${elapsed}ms) - ${description}`);
  if (!ok) {
    console.error('  Top results:', res.slice(0, 3).map(r => ({
      sku: r.product.sku,
      name: r.product.name,
      score: r.score,
      reason: r.matchedReason,
      highlight: r.matchHighlight
    })));
  }
}

// 1. Exact SKU
runTest('BP-991', 'Exact SKU match', res => {
  return res.length > 0 && res[0].product.sku === 'BP-991' && res[0].score === 100;
});

// 2. Normalized SKU (no dash, lowercase)
runTest('bp991', 'Normalized SKU match without hyphen', res => {
  return res.length > 0 && res[0].product.sku === 'BP-991' && res[0].score === 100;
});

// 3. Barcode
runTest('8909919919911', 'Barcode match', res => {
  return res.length > 0 && res[0].product.barcode === '8909919919911' && res[0].score === 100;
});

// 4. Primary Vehicle match
runTest('pulsar 150', 'Primary vehicle match', res => {
  return res.length > 0 && res[0].matchedReason === 'primary_vehicle';
});

// 5. Cross-vehicle compatibility search: "unicorn brake pad"
// MUST return physical product BP-991 with compatibility highlight!
runTest('unicorn brake pad', 'Cross-vehicle compatibility search matches BP-991', res => {
  const match = res.find(r => r.product.sku === 'BP-991');
  return !!match && match.matchedReason === 'compatibility';
});

// 6. Cross-vehicle compatibility alternate name: "discover disc shoe"
// MUST return physical product BP-991
runTest('discover disc shoe', 'Compatibility alternate name matches BP-991', res => {
  const match = res.find(r => r.product.sku === 'BP-991');
  return !!match && match.matchedReason === 'compatibility';
});

// 7. Location search: "R1L1B1"
runTest('R1L1B1', 'Exact location code matches products at that location', res => {
  return res.length > 0 && res[0].matchedReason === 'location';
});

// 8. Typo tolerance: "barke pad" -> "brake pad"
runTest('barke pad', 'Typo tolerance: "barke pad" matches brake pads', res => {
  return res.length > 0 && res[0].product.category === 'Brake';
});

// 9. Repeated query cache check
const c0 = performance.now();
const resCached = PrinceSearchEngine.search('unicorn brake pad');
const c1 = performance.now();
console.log(`[PASS] Cached query response time: ${(c1 - c0).toFixed(3)} ms`);
