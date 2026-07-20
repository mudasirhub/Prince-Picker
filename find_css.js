const fs = require('fs');
const lines = fs.readFileSync('m:/Prince-Picker-main/index.html', 'utf8').split('\n');
lines.forEach((l, i) => {
  if (l.includes('scan-flash')) {
    console.log(`${i+1}: ${l}`);
  }
});
