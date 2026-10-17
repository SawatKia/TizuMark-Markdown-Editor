// 插入空行功能（Eclipse/VS Code 风格）：
//   - insertLineBelow（Ctrl+Enter）：在光标所在行【下方】插入空行，当前行光标后的文本不被截断，
//     插入后光标跳转到新加的空行（行首）。
//   - insertLineAbove（Ctrl+Shift+Enter）：在光标所在行【上方】插入空行，原行整体下移，
//     插入后光标跳转到新加的空行（行首）。
//   - 新行均为纯空行，不继承当前行缩进。
//
// 使用 test/helpers/app-env.cjs 的 withEditor 在真实 CodeMirror 实例上验证。

const test = require('node:test');
const assert = require('node:assert');
const { withEditor } = require('./helpers/app-env.cjs');

test('insertLineBelow: 光标在行中间不截断当前行，下方新增空行，光标跳到新行行首', () => {
  return withEditor({ captureInitErr: true }, async (w, ed) => {
    ed.cm.setValue('aaa bbb ccc\nddd eee');
    ed.cm.setCursor({ line: 0, ch: 4 }); // "aaa |bbb ccc"
    ed.insertLineBelow();
    assert.strictEqual(ed.cm.getValue(), 'aaa bbb ccc\n\nddd eee');
    assert.strictEqual(ed.cm.getLine(0), 'aaa bbb ccc', '原行未被截断');
    const c = ed.cm.getCursor();
    assert.strictEqual(c.line, 1, '光标应跳到新加的空行（行1）');
    assert.strictEqual(c.ch, 0, '光标应在新行行首');
  });
});

test('insertLineBelow: 光标在行尾，下方新增空行，光标跳到新行行首', () => {
  return withEditor({ captureInitErr: true }, async (w, ed) => {
    ed.cm.setValue('aaa\nbbb');
    ed.cm.setCursor({ line: 0, ch: 3 });
    ed.insertLineBelow();
    assert.strictEqual(ed.cm.getValue(), 'aaa\n\nbbb');
    const c = ed.cm.getCursor();
    assert.strictEqual(c.line, 1);
    assert.strictEqual(c.ch, 0);
  });
});

test('insertLineBelow: 光标在最后一行（文档自动扩展），光标跳到新行行首', () => {
  return withEditor({ captureInitErr: true }, async (w, ed) => {
    ed.cm.setValue('aaa\nbbb');
    ed.cm.setCursor({ line: 1, ch: 3 });
    ed.insertLineBelow();
    assert.strictEqual(ed.cm.getValue(), 'aaa\nbbb\n');
    const c = ed.cm.getCursor();
    assert.strictEqual(c.line, 2);
    assert.strictEqual(c.ch, 0);
  });
});

test('insertLineBelow: 空文档，变为两行，光标跳到新行行首（行1,列0）', () => {
  return withEditor({ captureInitErr: true }, async (w, ed) => {
    ed.cm.setValue('');
    ed.cm.setCursor({ line: 0, ch: 0 });
    ed.insertLineBelow();
    assert.strictEqual(ed.cm.getValue(), '\n');
    const c = ed.cm.getCursor();
    assert.strictEqual(c.line, 1);
    assert.strictEqual(c.ch, 0);
  });
});

test('insertLineAbove: 光标在行中间，原行下移，上方新增空行，光标跳到新行行首', () => {
  return withEditor({ captureInitErr: true }, async (w, ed) => {
    ed.cm.setValue('aaa bbb\nccc');
    ed.cm.setCursor({ line: 0, ch: 4 });
    ed.insertLineAbove();
    assert.strictEqual(ed.cm.getValue(), '\naaa bbb\nccc');
    const c = ed.cm.getCursor();
    assert.strictEqual(c.line, 0, '光标应跳到新加的空行（行0）');
    assert.strictEqual(c.ch, 0, '光标应在新行行首');
    assert.strictEqual(ed.cm.getLine(1), 'aaa bbb', '原行整体下移未被截断');
  });
});

test('insertLineAbove: 光标在首行，文档顶部新增空行，光标跳到新行行首（行0,列0）', () => {
  return withEditor({ captureInitErr: true }, async (w, ed) => {
    ed.cm.setValue('aaa\nbbb');
    ed.cm.setCursor({ line: 0, ch: 0 });
    ed.insertLineAbove();
    assert.strictEqual(ed.cm.getValue(), '\naaa\nbbb');
    const c = ed.cm.getCursor();
    assert.strictEqual(c.line, 0);
    assert.strictEqual(c.ch, 0);
  });
});

test('extraKeys 注册：Ctrl-Enter / Ctrl+Shift+Enter 进入 CM extraKeys 并通过该通道触发，光标跳到新行行首', () => {
  return withEditor({ captureInitErr: true }, async (w, ed) => {
    ed.cm.setValue('aaa\nbbb');
    ed.cm.setCursor({ line: 0, ch: 2 });
    const ek = ed.cm.getOption('extraKeys');
    assert.strictEqual(typeof ek['Ctrl-Enter'], 'function', 'Ctrl+Enter 应注册为 extraKeys');
    assert.strictEqual(typeof ek['Shift-Ctrl-Enter'], 'function', 'Ctrl+Shift+Enter 应注册为 extraKeys（Shift 在前）');

    // 通过 CM 通道触发下方插入
    ek['Ctrl-Enter'](ed.cm);
    assert.strictEqual(ed.cm.getValue(), 'aaa\n\nbbb');
    assert.strictEqual(ed.cm.getCursor().line, 1, '下方插入后光标应跳到新行（行1）');
    assert.strictEqual(ed.cm.getCursor().ch, 0, '下方插入后光标应在新行行首');

    // 复位后通过 CM 通道触发上方插入
    ed.cm.setCursor({ line: 0, ch: 2 });
    ek['Shift-Ctrl-Enter'](ed.cm);
    assert.strictEqual(ed.cm.getValue(), '\naaa\n\nbbb');
    assert.strictEqual(ed.cm.getCursor().line, 0, '上方插入后光标应跳到新行（行0）');
    assert.strictEqual(ed.cm.getCursor().ch, 0, '上方插入后光标应在新行行首');
  });
});
