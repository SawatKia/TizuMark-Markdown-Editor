// 快捷键不依赖输入语言：非拉丁布局（泰语/俄语等）下 e.key 是本地字符，须回退到 e.code，
// 否则 Ctrl+Z/C/V 会落入「屏蔽其它 Ctrl 组合」分支被 preventDefault。
const { test } = require('node:test');
const assert = require('node:assert');

global.window = {};
global.TMConst = { Tab: class {}, dialogSave: async () => null };
const { mixin } = require('../src/modules/shortcuts.js');
const ed = Object.assign({}, mixin);

test('_shortcutKey: 泰语布局下按物理键位', () => {
  assert.strictEqual(ed._shortcutKey({ key: 'ผ', code: 'KeyZ' }), 'z');
  assert.strictEqual(ed._shortcutKey({ key: 'แ', code: 'KeyC' }), 'c');
  assert.strictEqual(ed._shortcutKey({ key: 'อ', code: 'KeyV' }), 'v');
  assert.strictEqual(ed._shortcutKey({ key: 'ๅ', code: 'Digit1' }), '1');
});

test('_shortcutKey: 拉丁布局按 e.key（兼容 Dvorak/AZERTY），特殊键原样小写', () => {
  assert.strictEqual(ed._shortcutKey({ key: 'Z', code: 'KeyZ' }), 'z');
  assert.strictEqual(ed._shortcutKey({ key: 'w', code: 'KeyZ' }), 'w');
  assert.strictEqual(ed._shortcutKey({ key: 'Home', code: 'Home' }), 'home');
  assert.strictEqual(ed._shortcutKey({ key: 'ArrowLeft', code: 'ArrowLeft' }), 'arrowleft');
});

test('_dispatchGlobalShortcut: 泰语 Ctrl+C/V/Z 放行，不 preventDefault', () => {
  for (const [key, code] of [['แ', 'KeyC'], ['อ', 'KeyV'], ['ผ', 'KeyZ'], ['ฟ', 'KeyA']]) {
    let prevented = false;
    ed._dispatchGlobalShortcut({
      key, code, ctrlKey: true, shiftKey: false, altKey: false, metaKey: false,
      preventDefault() { prevented = true; }, stopPropagation() {},
    });
    assert.strictEqual(prevented, false, `${code} 不应被拦截`);
  }
});
