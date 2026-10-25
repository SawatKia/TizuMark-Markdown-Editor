// 版本号统一升级：node scripts/bump-version.cjs <新版本号>
// 覆盖 check-version.mjs 检查的全部位置；只替换旧版本号本身，不改其它内容。
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const next = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(next || '')) {
  console.error('用法: node scripts/bump-version.cjs <x.y.z>');
  process.exit(1);
}

const pkgPath = path.join(root, 'package.json');
const old = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;

function rewrite(rel, fn) {
  const file = path.join(root, rel);
  const before = fs.readFileSync(file, 'utf8');
  const after = fn(before);
  if (after === before) throw new Error(`${rel} 中找不到旧版本 ${old}`);
  fs.writeFileSync(file, after);
}

function replaceAllText(text) {
  return text.split(old).join(next);
}

rewrite('package.json', (s) => s.replace(`"version": "${old}"`, `"version": "${next}"`));

rewrite('package-lock.json', (s) => {
  const lock = JSON.parse(s);
  lock.version = next;
  if (lock.packages && lock.packages['']) lock.packages[''].version = next;
  return JSON.stringify(lock, null, 2) + '\n';
});

rewrite('src-tauri/tauri.conf.json', (s) => s.replace(`"version": "${old}"`, `"version": "${next}"`));
rewrite('src-tauri/Cargo.toml', (s) => s.replace(`version = "${old}"`, `version = "${next}"`));
rewrite('update-windows-x86_64.json', replaceAllText);

for (const rel of ['README.md', 'README.en.md', 'README.es.md']) {
  rewrite(rel, (s) => s.replace(`Version-${old}-blue`, `Version-${next}-blue`));
}

rewrite('src/index.html', (s) => s.replace(`TizuMark v${old}`, `TizuMark v${next}`));
rewrite('src/modules/i18n-data.js', (s) => s.split(`TizuMark v${old}`).join(`TizuMark v${next}`).split(`appVersion: '${old}'`).join(`appVersion: '${next}'`));

console.log(`版本号 ${old} → ${next}`);
