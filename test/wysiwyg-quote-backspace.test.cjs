// 引用行 `> ` 前缀区 Backspace·Delete 守卫的行为测试（2026-10-31）。
//
// 背景（QA 真机实测 + 用户截图）：WYSIWYG 活动引用行里 `> ` 由 wysiwyg-quote-slot 槽
// 隐藏（看得见的正文从槽后开始），但光标在正文起点按 Backspace 走 CM 原生逐字符删：
//   - QA 实测：第一次不剥 `>`、反而把下方 `---` 上移，第二次误删行尾字符——始终退不出引用
//   - 原生逐次删出「>文本」「>」裸露中间态（与列表任务项 7 次删除同族问题）
//   - 用户截图：空引用行裸露 `> `（隐藏槽只对非空内容行生效的观感问题，CSS 侧修复）
//
// 修复口径（quoteMarkerZoneEnd + _ensureWysiwygListKeyGuard 引用分支）：
//   - Backspace（光标在 `> ` 区内或正文起点）→ 一次剥离整个前缀（退出引用，Typora 同口径）
//   - Delete 行尾 + 下一行是引用行 → 剥下一行前缀后并接（原生会并出「> 甲> 乙」残骸）
//   - 字面块（围栏/缩进代码/HTML 容器/frontmatter）行文里的 `> ` 是内容 → 守卫放行
//     （_wysiwygLineInLiteralBlock，接线断言在 view-mode-wysiwyg.test.cjs）
// 本文件直接用真实 Markdown 行跑 quoteMarkerZoneEnd（守卫与单测共用同一纯函数），
// 并与 stripQuotePrefix 做同源差分锁死口径。

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// wysiwyg.js 加载期引用裸全局 TMConst —— 先加载 constants.js 补全
//（同 wysiwyg-list-backspace.test.cjs 先例）。
global.window = global.window || globalThis;
require(path.join(ROOT, 'src', 'modules', 'constants.js'));
const { quoteMarkerZoneEnd: z, stripQuotePrefix } = require(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'));

// ---------- ① 单层/嵌套引用行 ----------
test('引用行：`> ` 前缀区终点 = 正文起点；嵌套逐层累加', () => {
  assert.strictEqual(z('> 引用行'), 2);
  assert.strictEqual(z('> > 嵌套引用'), 4, '两层 `> ` 全段入区');
  assert.strictEqual(z('> > > 三层嵌套'), 6);
  assert.strictEqual(z('>> 紧凑嵌套'), 3, '`>> `：首 `>` 无空格 + 次 `>` 带空格（`[ \\t]?` 可选逐层累加）');
  assert.strictEqual(z('>text'), 1, '`>` 后无空格：区只含 `>`');
  assert.strictEqual(z('> '), 2, '空引用行 → 整行入区（Backspace 一次剥成普通空行）');
  assert.strictEqual(z('>'), 1);
  assert.strictEqual(z('   > 三空格前导'), 5, '前导 ≤3 空格同属前缀区（CommonMark 口径）');
  assert.strictEqual(z('  > > 前导缩进嵌套'), 6);
});

// ---------- ② 非引用行（零回归面） ----------
test('非引用行返回 0：段落/列表/缩进代码/围栏/表格/空行全走原生', () => {
  assert.strictEqual(z('普通段落'), 0);
  assert.strictEqual(z('- 无序项'), 0, '列表行走列表守卫（listMarkerZoneEnd），不在引用区');
  assert.strictEqual(z('1. 有序项'), 0);
  assert.strictEqual(z('# 标题'), 0);
  assert.strictEqual(z('    > 4 空格缩进代码'), 0, '缩进代码行文里的 > 是字面内容（\\s{0,3} 不匹配 4 空格）');
  assert.strictEqual(z('\t> 制表缩进代码'), 3,
    '\\s{0,3} 含 \\t（与 stripQuotePrefix 同源，刻意不特判）；缩进代码场景由守卫的 _wysiwygLineInLiteralBlock 放行兜底');
  assert.strictEqual(z('```js'), 0);
  assert.strictEqual(z('| 表格 | 行 |'), 0);
  assert.strictEqual(z(''), 0);
  assert.strictEqual(z('   '), 0);
  assert.strictEqual(z('---'), 0);
  assert.strictEqual(z('--- > 不是引用'), 0, '集合线/表格线非引用前缀');
});

// ---------- ③ 与 stripQuotePrefix 同源差分 ----------
test('区终点与 stripQuotePrefix 严格同源：剥掉的前缀长度 = 区终点', () => {
  const lines = [
    '> 引用行', '> > 嵌套引用', '> > > 三层嵌套', '>text', '> ', '>',
    '   > 三空格前导', '  > > 前导缩进嵌套', '>> 紧凑嵌套', '> [ ] 引用内任务',
    '> 1. 引用内有序', '> | 引用内表格 |', '> ```js', '> - - -',
  ];
  for (const line of lines) {
    const stripped = stripQuotePrefix(line);
    assert.strictEqual(line.length - stripped.length, z(line),
      `前缀长度差分失败：${JSON.stringify(line)}`);
  }
});

// ---------- ④ 剥离语义（对照原生逐字符删的中间态） ----------
test('剥离语义：从正文起点一次剥到 0 = 退出引用，不经过裸露中间态', () => {
  // 原生 4 次 Backspace：`> 引用` → `> 引用`(删空格) → `> 引用`(删>) wait — 原生从 ch=2
  // 起删：#1 删空格 → `>引用`；#2 删 > → `引用`（此中间态即裸露）；守卫第 1 次直达。
  const line = '> 引用正文';
  const stripped = line.slice(z(line));
  assert.strictEqual(stripped, '引用正文', '一次剥离 = 退出引用，跳过「>引用正文」裸露态');
  // 嵌套：一次剥掉全部层（与列表守卫「一次剥离整个标记」同口径，无逐层中间态）
  const nested = '> > 深层内容';
  assert.strictEqual(nested.slice(z(nested)), '深层内容');
  // Delete 并接语义：下一行前缀剥掉后并接，不残留「> 甲> 乙」
  const a = '> 甲行', b = '> 乙行';
  const joined = a + b.slice(z(b));
  assert.strictEqual(joined, '> 甲行乙行', 'Delete 行尾并接 = 剥下一行前缀后拼接');
});
