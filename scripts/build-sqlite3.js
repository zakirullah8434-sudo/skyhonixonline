#!/usr/bin/env node
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const sqlite3Dir = path.join(__dirname, '..', 'node_modules', 'sqlite3');

if (!fs.existsSync(sqlite3Dir)) {
  console.log('sqlite3 not installed, skipping native build');
  process.exit(0);
}

const bindingDir = path.join(sqlite3Dir, 'build', 'Release');
const bindingFile = path.join(bindingDir, 'node_sqlite3.node');

if (fs.existsSync(bindingFile)) {
  console.log('sqlite3 native binary already exists, skipping build');
  process.exit(0);
}

console.log('Building sqlite3 native binary directly (bypassing npm allowScripts)...');

try {
  const prebuildBin = path.join(sqlite3Dir, 'node_modules', '.bin', 'prebuild-install');
  if (fs.existsSync(prebuildBin)) {
    execSync(`"${prebuildBin}" -r napi`, { cwd: sqlite3Dir, stdio: 'inherit' });
    console.log('sqlite3 prebuilt binary downloaded successfully');
    process.exit(0);
  }
} catch (e) {
  console.log('prebuild-install failed, falling back to node-gyp rebuild...');
}

try {
  execSync('npx node-gyp rebuild', { cwd: sqlite3Dir, stdio: 'inherit' });
  console.log('sqlite3 built from source successfully');
} catch (e) {
  console.error('Failed to build sqlite3 native binary:', e.message);
  process.exit(1);
}
