const fs = require('fs');
const path = require('path');
const lines = fs.readFileSync(path.join(__dirname, 'app/index.html'), 'utf8').split('\n');
lines.forEach((line, i) => {
  if (line.includes('p.stock') || line.includes('product.stock') || line.includes('openProductSheet') || line.includes('showProduct')) {
    console.log(`${i+1}: ${line.trim()}`);
  }
});
