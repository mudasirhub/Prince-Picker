// Run once: node patch_picker.js
const fs = require('fs');
const f = 'M:/Prince-Picker-main/index.html';
let c = fs.readFileSync(f, 'utf8');
const EOL = c.includes('\r\n') ? '\r\n' : '\n';
const needle = `</script>${EOL}</body>${EOL}</html>`;
const inject = `</script>${EOL}<script src="picker-bridge.js"></script>${EOL}</body>${EOL}</html>`;
if (c.includes(needle)) {
  // Make sure we only replace the LAST occurrence
  const idx = c.lastIndexOf(needle);
  c = c.slice(0, idx) + inject + c.slice(idx + needle.length);
  fs.writeFileSync(f, c);
  console.log('OK - picker-bridge.js injected into picker app');
} else {
  console.error('needle not found, trying LF...');
  const n2 = needle.replace(/\r\n/g,'\n');
  const r2 = inject.replace(/\r\n/g,'\n');
  const idx = c.lastIndexOf(n2);
  if (idx !== -1) {
    c = c.slice(0, idx) + r2 + c.slice(idx + n2.length);
    fs.writeFileSync(f, c);
    console.log('OK - patched with LF');
  } else {
    console.log('Last 300:', JSON.stringify(c.slice(-300)));
  }
}
