#!/usr/bin/env node
// 统一版本号到 lzc/package.yml、electron/package.json、android/android/app/build.gradle。
// CI 三平台(jobs)共用；用 Node 而非 sed 规避跨平台引号转义问题。
const fs = require('fs');
const v = process.argv[2];
if (!v) { console.error('用法: node set_version.js <版本号>'); process.exit(1); }
const upd = (file, fn) => {
  try { fs.writeFileSync(file, fn(fs.readFileSync(file, 'utf8'))); }
  catch (e) { console.warn('跳过 ' + file + ': ' + e.message); }
};
upd('lzc/package.yml', (s) => s.replace(/^version: .*/m, 'version: ' + v));
upd('electron/package.json', (s) => { const j = JSON.parse(s); j.version = v; return JSON.stringify(j, null, 2) + '\n'; });
upd('android/android/app/build.gradle', (s) => s.replace(/versionName\s*"[^"]*"/, 'versionName "' + v + '"'));
console.log('已同步版本到 lzc/package.yml, electron/package.json, android/android/app/build.gradle → ' + v);
