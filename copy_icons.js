const fs = require('fs');
const path = require('path');

const root = __dirname;
const src = path.join(root, 'picker logo.png');
const appDir = path.join(root, 'app');

if (!fs.existsSync(appDir)) {
  fs.mkdirSync(appDir, { recursive: true });
}

if (fs.existsSync(src)) {
  const targets = [
    path.join(root, 'picker-logo.png'),
    path.join(root, 'android-chrome-192.png'),
    path.join(root, 'android-chrome-512.png'),
    path.join(root, 'apple-touch-icon.png'),
    path.join(appDir, 'picker-logo.png'),
    path.join(appDir, 'picker logo.png'),
    path.join(appDir, 'android-chrome-192.png'),
    path.join(appDir, 'android-chrome-512.png'),
    path.join(appDir, 'apple-touch-icon.png'),
  ];

  targets.forEach(t => {
    try {
      fs.copyFileSync(src, t);
      console.log('✓ Copied logo to:', t);
    } catch (e) {
      console.error('Failed to copy to', t, e.message);
    }
  });

  const bridgeSrc = path.join(root, 'picker-bridge.js');
  const bridgeDest = path.join(appDir, 'picker-bridge.js');
  if (fs.existsSync(bridgeSrc)) {
    try {
      fs.copyFileSync(bridgeSrc, bridgeDest);
      console.log('✓ Copied picker-bridge.js to:', bridgeDest);
    } catch (e) {
      console.error('Failed to copy picker-bridge.js:', e.message);
    }
  }
} else {
  console.error('Source logo not found:', src);
}
