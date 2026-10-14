/**
 * 20,000 SKU BENCHMARK AND STRESS TEST FOR PRINCE SEARCH ENGINE
 */

const assert = require('assert');
const PrinceSearchEngine = require('../app/search_engine.js');

console.log('Generating 20,000 realistic SKUs...');

const makes = ['Hero', 'Honda', 'Bajaj', 'TVS', 'Yamaha', 'Suzuki', 'Royal Enfield', 'KTM', 'Kawasaki', 'Mahindra'];
const models = [
  'Splendor Plus', 'HF Deluxe', 'Passion Pro', 'Glamour 125', 'CB Shine 125', 'Activa 6G', 'Activa 125',
  'Dio 110', 'Unicorn 160', 'Hornet 2.0', 'Pulsar 150', 'Pulsar NS200', 'Pulsar 220F', 'Platina 100',
  'Discover 125', 'Avenger 220', 'Jupiter 110', 'Ntorq 125', 'Apache RTR 160', 'Apache RTR 200',
  'R15 V3', 'R15 V4', 'MT 15', 'FZ S V3', 'Fascino 125', 'Ray ZR 125', 'Access 125', 'Burgman Street',
  'Gixxer 150', 'Classic 350', 'Bullet 350', 'Meteor 350', 'Hunter 350', 'Duke 200', 'Duke 250', 'Duke 390'
];

const partTypes = [
  'Front Brake Pad', 'Rear Brake Shoe', 'Clutch Plate Set', 'Clutch Cable', 'Throttle Cable',
  'Front Visor Glass', 'Headlight Visor Mask', 'Side Mirror Left', 'Side Mirror Right',
  'Engine Oil Filter', 'Air Filter Element', 'Iridium Spark Plug', 'Chain Sprocket Kit',
  'Front Fork Oil Seal', 'Rear Shock Absorber', 'Disc Brake Rotor', 'Master Cylinder Kit',
  'Wheel Bearing 6201', 'Wheel Bearing 6302', 'Carburetor Repair Kit', 'Piston Ring Standard',
  'Handlebar Weight', 'Footrest Rubber Front', 'Brake Lever Right', 'Clutch Lever Left',
  'Silencer Heat Shield', 'Speedometer Cable', 'Ignition Lock Set', 'Starter Motor Carbon Brush',
  'Battery 12V 5Ah Sealed', 'Battery 12V 9Ah', 'LED Headlight Bulb H4', 'Indicator Flasher Relay',
  'Drive Belt Kevlar', 'Variator Roller Weight Set', 'Gasket Kit Full Engine'
];

const brands = ['OEM Genuine', 'Bosch', 'NGK', 'Rolon', 'Minda', 'Varroc', 'Endurance', 'Gabriel', 'Castrol', 'Motul'];

const products = [];
for (let i = 1; i <= 20000; i++) {
  const make = makes[i % makes.length];
  const model = models[(i * 3) % models.length];
  const part = partTypes[i % partTypes.length];
  const brand = brands[(i * 7) % brands.length];
  const rack = `R${(i % 15) + 1}`;
  const level = `L${(i % 5) + 1}`;
  const bin = `B${(i % 10) + 1}`;
  const loc = (i % 3 === 0) ? `W${rack}${level}${bin}` : `${rack}${level}${bin}`;
  const storage = (i % 3 === 0) ? 'WAREHOUSE' : 'SHOP';

  const sku = `PP-${make.slice(0, 3).toUpperCase()}-${String(i).padStart(5, '0')}`;
  const barcode = `890${String(i).padStart(10, '0')}`;

  // Compatibility entries for every 3rd product
  const compatibility = [];
  if (i % 3 === 0) {
    const compModel = models[(i * 5) % models.length];
    const compMake = makes[(i * 2) % makes.length];
    compatibility.push({
      make: compMake,
      model: compModel,
      name: part.includes('Pad') ? 'Disc Shoe Alternate' : (part.includes('Cable') ? 'Control Wire' : 'Replacement Part')
    });
  }

  products.push({
    id: i,
    name: `${part} ${make} ${model}`,
    sku: sku,
    barcode: barcode,
    brand: brand,
    category: part.split(' ')[0],
    vehicles: [`${make} ${model}`],
    compatibility: compatibility,
    locations: [{ location: loc, storage_type: storage, stock: (i % 20) + 1 }]
  });
}

console.log(`Generated ${products.length} products. Indexing into PrinceSearchEngine...`);

const startBuild = performance.now();
PrinceSearchEngine.init(products);
const buildTime = performance.now() - startBuild;

console.log(`Index built in ${buildTime.toFixed(2)} ms!`);
console.log(`Vocabulary size: ${PrinceSearchEngine.instance.vocabTokens.size} unique tokens across 20k SKUs.`);

assert.ok(PrinceSearchEngine.isReady(), 'Search engine must report ready');
assert.ok(buildTime < 1500, `Build time should be fast (< 1500ms, took ${buildTime}ms)`);

console.log('\nRunning Benchmarks (cold query execution times):');

const benchmarkQueries = [
  { q: 'PP-HER-00010', type: 'Exact SKU' },
  { q: '8900000000010', type: 'Exact Barcode' },
  { q: 'ppher000', type: 'Normalized SKU Prefix' },
  { q: 'R1L1B1', type: 'Location Code' },
  { q: 'visor', type: 'Exact Keyword' },
  { q: 'vizor', type: 'Fuzzy Single Typo (z for s)' },
  { q: 'vior', type: 'Fuzzy Single Typo (missing s)' },
  { q: 'visr', type: 'Fuzzy Single Typo (missing o)' },
  { q: 'visorr', type: 'Fuzzy Single Typo (extra r)' },
  { q: 'clutsh', type: 'Fuzzy Typo (sh for ch)' },
  { q: 'miror', type: 'Fuzzy Typo (missing r)' },
  { q: 'brak', type: 'Fuzzy Typo (missing e)' },
  { q: 'filtr', type: 'Fuzzy Typo (missing e)' },
  { q: 'barke', type: 'Fuzzy Transposition (ar for ra)' },
  { q: 'vizor pulsar', type: 'Multi-word with Typo' },
  { q: 'splender clutsh', type: 'Multi-word with Two Typos' },
  { q: 'pulsar brake', type: 'Compound Vehicle + Part' },
  { q: 'unicorn disc shoe', type: 'Compatibility Search' }
];

let totalQueryTime = 0;

benchmarkQueries.forEach(({ q, type }) => {
  const t0 = performance.now();
  const res = PrinceSearchEngine.search(q, { limit: 20 });
  const t1 = performance.now();
  const dur = t1 - t0;
  totalQueryTime += dur;
  console.log(`  [${dur.toFixed(2).padStart(6, ' ')} ms] "${q.padEnd(20, ' ')}" (${type}) -> Found ${res.total} items (top: ${res[0] ? res[0].product.name.slice(0, 35) : 'None'})`);
  assert.ok(dur < 50, `Cold query "${q}" must execute in < 50ms (took ${dur}ms)`);
});

const avgTime = totalQueryTime / benchmarkQueries.length;
console.log(`\nAverage Cold Query Latency: ${avgTime.toFixed(2)} ms (Threshold target: < 20ms)`);

console.log('\nTesting LRU Query Cache (repeat & backspace queries):');
const cacheTestQueries = ['vizor', 'vizor', 'vizor pulsar', 'vizor', 'vizor pulsar'];
cacheTestQueries.forEach((q, idx) => {
  const t0 = performance.now();
  const res = PrinceSearchEngine.search(q);
  const t1 = performance.now();
  const dur = t1 - t0;
  console.log(`  Cache step ${idx + 1}: query "${q}" took ${dur.toFixed(4)} ms`);
  assert.ok(dur < 1.0, `Cached query must take < 1ms (took ${dur}ms)`);
});

console.log('\nTesting Memory & Isolation:');
assert.strictEqual(typeof PrinceSearchEngine.updateProduct, 'function');
assert.strictEqual(typeof PrinceSearchEngine.removeProduct, 'function');
assert.strictEqual(typeof PrinceSearchEngine.clearCache, 'function');

console.log('\n====================================================');
console.log('20,000 SKU BENCHMARK PASSED WITH FLYING COLORS!');
console.log('====================================================');
