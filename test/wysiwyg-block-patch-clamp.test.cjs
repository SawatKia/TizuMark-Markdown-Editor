// 块表即时修补的行号钳位回归测试（2026-10-24 真机取证）。
//
// 背景：_wysiwygPatchBlockTableForChange 对「变更起点在块首行行首」的块整体位移
// start/end。当变更**删除了块所在区间**（负 delta、文档缩小）时，start 可能移成负数
// （真机实测：活动块 [0,1) 时整文删除 → 块表 [[-2,1]]）——getLine(-n) 返回 undefined，
// _wysiwygApplyActiveDecor 里 `RE.fence.test(first.trim())` 直接抛
// "Cannot read properties of undefined (reading 'trim')"，CM 操作链被打断、编辑器卡死。
// 既有 `b.start >= cm.lineCount()` 守卫只拦上界、拦不住负数与上移后的 end 越界。
// 修复 = 位移后钳回 [0, lineCount]（陈旧块由 250ms 防抖重解析收敛，幂等）。

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
global.window = global.window || globalThis;
require(path.join(ROOT, 'src', 'modules', 'constants.js'));
const { mixin } = require(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'));

// 最小 self 桩：修补函数只读 cm.lineCount / cm.getLine / this._wysiwygBlocks
function makeSelf(blocks, lineCount) {
  return {
    cm: { lineCount: () => lineCount, getLine: (n) => (n >= 0 && n < lineCount ? '' : undefined) },
    _wysiwygBlocks: blocks,
  };
}
const patch = (blocks, from, delta, lineCount) => {
  const self = makeSelf(blocks, lineCount);
  const changed = mixin._wysiwygPatchBlockTableForChange.call(self, { from }, delta);
  return { changed, spans: blocks.map((b) => [b.start, b.end]) };
};

test('整块被删：start 移成负数须钳回 0（真机崩溃场景 [[-2,1]]）', () => {
  const r = patch([{ start: 0, end: 1 }], { line: 0, ch: 0 }, -2, 1);
  assert.ok(r.changed);
  assert.deepStrictEqual(r.spans, [[0, 0]], 'start 不得为负、end 不得越过 start');
});

test('正常位移（变更在块上方）：钳位须为 no-op，不改变既有语义', () => {
  const r = patch([{ start: 2, end: 3 }], { line: 0, ch: 0 }, -1, 5);
  assert.deepStrictEqual(r.spans, [[1, 2]]);
  const g = patch([{ start: 0, end: 2 }], { line: 0, ch: 0 }, 1, 4);
  assert.deepStrictEqual(g.spans, [[1, 3]], '增行正向位移不受钳位影响');
});

test('end 越过新行数：钳到 lineCount（start 仍为合法值）', () => {
  const r = patch([{ start: 0, end: 5 }], { line: 0, ch: 0 }, -3, 2);
  assert.deepStrictEqual(r.spans, [[0, 2]]);
});

test('start 越界（负向过大）：钳回 0，不得为负（getLine(-n)=undefined 崩溃根因）', () => {
  const r = patch([{ start: 4, end: 6 }], { line: 0, ch: 0 }, -6, 1);
  assert.deepStrictEqual(r.spans, [[0, 0]]);
});

test('变更起点在块中间（非位移分支）：不走钳位，非围栏块返回 false', () => {
  const r = patch([{ start: 0, end: 3 }], { line: 1, ch: 2 }, -1, 3);
  assert.strictEqual(r.changed, false);
  assert.deepStrictEqual(r.spans, [[0, 3]], '非围栏块范围不即时修（既有口径），钳位不得误伤');
});
