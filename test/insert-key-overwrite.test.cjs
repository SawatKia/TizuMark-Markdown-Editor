// 回归：CM5 默认 Insert=toggleOverwrite，误触后在行中输入会吞掉后面的字。
// 两处 extraKeys（初始化 + applyShortcuts 重设）都必须把 Insert 接成空操作。
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

for (const file of ['editor-core.js', 'shortcuts.js']) {
  test(`${file}: extraKeys 禁用 Insert 覆盖模式`, () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', file), 'utf8');
    assert.match(src, /'Insert':\s*\(\)\s*=>\s*\{\}/);
  });
}

test('editor-core.js: overwriteToggle 兜底关回插入模式', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'modules', 'editor-core.js'), 'utf8');
  assert.match(src, /on\('overwriteToggle',.*toggleOverwrite\(false\)/);
});
