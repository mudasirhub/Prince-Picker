const fs = require('fs');
const path = require('path');

const root = __dirname;
const appDir = path.join(root, 'app');
const oldIndex = path.join(root, 'index.html');
const newIndex = path.join(appDir, 'index.html');
const marketing = path.join(root, 'marketing.html');

console.log('--- Prince Picker Migration Script ---');

// 1. Create /app/ dir if not exists
if (!fs.existsSync(appDir)) {
  fs.mkdirSync(appDir);
  console.log('✓ Created /app/ directory');
}

// 2. Move index.html to app/index.html
if (fs.existsSync(oldIndex)) {
  let content = fs.readFileSync(oldIndex, 'utf8');
  
  // 3. Update internal references
  // Fix Service Worker registration
  content = content.replace(/navigator\.serviceWorker\.register\('\/sw\.js'\)/g, "navigator.serviceWorker.register('./sw.js')");
  content = content.replace(/navigator\.serviceWorker\.register\('\/sw\.js'/g, "navigator.serviceWorker.register('./sw.js'");
  
  // Fix Manifest
  content = content.replace(/<link rel="manifest" href="manifest\.json">/g, '<link rel="manifest" href="./manifest.json">');
  content = content.replace(/href="\/manifest\.json"/g, 'href="./manifest.json"');

  // Any absolute paths that should be relative now
  content = content.replace(/href="\/favicon\.ico"/g, 'href="../favicon.ico"');
  
  fs.writeFileSync(newIndex, content);
  console.log('✓ Moved web application to /app/index.html and updated internal paths');
  
  // 4. Delete old sw.js and manifest.json from root (they are now in /app/)
  if (fs.existsSync(path.join(root, 'sw.js'))) {
    fs.unlinkSync(path.join(root, 'sw.js'));
    console.log('✓ Removed old /sw.js (new one is in /app/)');
  }
  if (fs.existsSync(path.join(root, 'manifest.json'))) {
    fs.unlinkSync(path.join(root, 'manifest.json'));
    console.log('✓ Removed old /manifest.json (new one is in /app/)');
  }

  // 5. Replace root index.html with marketing.html
  if (fs.existsSync(marketing)) {
    fs.copyFileSync(marketing, oldIndex);
    fs.unlinkSync(marketing);
    console.log('✓ Installed premium marketing site at root (/)');
  }

  try { require('./copy_icons.js'); } catch (e) { }
  console.log('--- Migration Complete! ---');
} else {
  console.log('! Error: index.html not found in root. Migration may have already run.');
}
