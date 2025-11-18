// Copies Monaco Editor's minified assets into public/monaco for offline/local serving
const fs = require('fs');
const path = require('path');

function copyDir(src, dest) {
  if (!fs.existsSync(src)) {
    console.log(`[copy-monaco] Source not found: ${src}`);
    return;
  }
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

try {
  const projectRoot = path.resolve(__dirname, '..');
  const src = path.join(projectRoot, 'node_modules', 'monaco-editor', 'min');
  const dest = path.join(projectRoot, 'public', 'monaco');
  copyDir(src, dest);
  console.log(`[copy-monaco] Copied Monaco assets to ${dest}`);
} catch (e) {
  console.warn('[copy-monaco] Failed to copy Monaco assets:', e.message);
}
