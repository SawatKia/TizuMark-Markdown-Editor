// 引用/提示块活动态「分段遮罩」的**多行原子结构整体保源码**行为测试（2026-10-28）。
//
// 背景（行为级根因，非静态断言）：引用块活动态把块按光标行切成上/下两段独立渲染
// （_wysiwygApplyQuoteSegments）。这条切分是行粒度的，**不认多行结构** —— 一旦某多行
// 结构的中间某行成为光标行，两段源码各自结构不完整，remark 的容错解析产出与渲染态
// 完全不符的结果，用户看到的就是「样式崩了」：
//   - 围栏代码块：上段补出**空代码盒** `<pre><code></code></pre>`、下段把后续正文**吞进
//     代码块**（demo.md 截图问题：空代码框 + 大框套正文）
//   - 缩进代码块：同围栏
//   - 表格：下半丢表头分隔行 → 渲染成带裸 `|` 的普通文本
//   - 展示公式 $$…$$：落单的 `$$` 当字面量显示出来
//   - HTML 容器（<details> 等）：结构破裂、闭标签裸露
//   - 列表（含嵌套）：下段剩余兄弟/子项被提升成**顶层新列表**（实测 `<ol start="2">`
//     顶格），嵌套缩进层级整体丢失
//
// 修复：光标落在多行结构内时，**整个结构**保持源码（raw 区扩到 [rawS, rawE]），
// 不在结构内则完全维持旧的「光标行单点」口径（null → 零回归面）。
// 本文件直接用真实 Markdown 行跑 quoteAtomicRange，并验证「切片渲染不再产出错误结构」。

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..');
// wysiwyg.js L66 加载期引用裸全局 TMConst（收口进 constants.js 共享常量
// BLOCKQUOTE_LINE_RE）。Node 独立 require 没有 index.html 的 script 链 → 先备最小
// window（constants.js IIFE 写 window.TMConst = 裸全局），显式加载补全
// （同 wysiwyg-blocks.test.cjs L20-24 / list-insert.test.cjs L44-48 先例）。
global.window = global.window || globalThis;
require(path.join(ROOT, 'src', 'modules', 'constants.js'));
const { quoteAtomicRange, quoteAtomicRanges, stripQuotePrefix } =
  require(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'));
const { renderMarkdown } = require(path.join(ROOT, 'src', 'unified-renderer.js'));

// 让「行内容」当入参更好读：返回 cur 行 → 区间（块内相对行号，闭区间）
const at = (lines, cur) => quoteAtomicRange(lines, cur);

// ---------- ① 引用内围栏代码块（demo.md 原文形态） ----------
const FENCE = [
  '> 在 TizuMark 中构建项目：',
  '> ',
  '> ```shell',
  '> npm run build',
  '> ```',
  '> ',
  '> 构建产物位于 `src-tauri/target/release/`。',
];

test('引用内围栏：开行/内容行/闭行都归入整段围栏，围栏外仍为 null（光标行单点口径回归保护）', () => {
  assert.deepStrictEqual(at(FENCE, 2), [2, 4], '围栏开行须归入 [2,4]（整段围栏）');
  assert.deepStrictEqual(at(FENCE, 3), [2, 4], '围栏内容行须归入 [2,4]（点这就是原撕裂根源）');
  assert.deepStrictEqual(at(FENCE, 4), [2, 4], '围栏闭行须归入 [2,4]');
  assert.strictEqual(at(FENCE, 0), null, '普通段落行须保持 null（旧单点口径）');
  assert.strictEqual(at(FENCE, 1), null, '空行须保持 null');
  assert.strictEqual(at(FENCE, 5), null, '围栏后空行须保持 null');
  assert.strictEqual(at(FENCE, 6), null, '围栏后段落须保持 null');
});

test('引用内围栏：fragments 渲染不再产出空代码盒 / 正文被吞进代码块（对照旧切法）', () => {
  for (const cur of [2, 3, 4]) {
    const [s, e] = at(FENCE, cur);
    const topHtml = renderMarkdown(FENCE.slice(0, s).join('\n'));
    const botHtml = renderMarkdown(FENCE.slice(e + 1).join('\n'));
    assert.ok(!/<pre/.test(topHtml), `cur=${cur} 上段仍渲染出代码块（应无 pre）：${topHtml}`);
    assert.ok(!/<pre/.test(botHtml), `cur=${cur} 下段仍渲染出代码块（正文被吞）：${botHtml}`);
    assert.ok(!/```/.test(topHtml + botHtml), `cur=${cur} 段内出现裸露围栏标记：${topHtml}${botHtml}`);
    assert.ok(/构建产物/.test(botHtml), `cur=${cur} 下段丢失围栏后正文：${botHtml}`);
  }
  // 差分对照：旧的单点切法（上段 [start,cur)、下段 (cur,end]）必然出错 —— 锁住修复意图
  const oldTop = renderMarkdown(FENCE.slice(0, 3).join('\n'));
  const oldBot = renderMarkdown(FENCE.slice(4).join('\n'));
  assert.ok(/<pre/.test(oldTop), '差分对照失效：旧切法上段本应补出空代码盒');
  assert.ok(/<pre/.test(oldBot), '差分对照失效：旧切法下段本应把正文吞进代码块');
});

// ---------- ② 引用内表格 ----------
const TABLE = [
  '> 下面是一个表：',
  '> ',
  '> | 特性 | 说明 |',
  '> | --- | --- |',
  '> | DOCX | 导出 |',
  '> | PDF | 打印 |',
  '> ',
  '> 表格结束。',
];

test('引用内表格：每行都归入整张表，差异 fixture 覆盖表头/分隔/数据行', () => {
  for (const cur of [2, 3, 4, 5]) assert.deepStrictEqual(at(TABLE, cur), [2, 5], `cur=${cur}`);
  assert.strictEqual(at(TABLE, 0), null);
  assert.strictEqual(at(TABLE, 7), null);
});

test('引用内表格：fragments 不再渲染出裸管道符文本（对照旧切法）', () => {
  for (const cur of [2, 3, 4, 5]) {
    const [s, e] = at(TABLE, cur);
    const botHtml = renderMarkdown(TABLE.slice(e + 1).join('\n'));
    assert.ok(!/\|/.test(botHtml), `cur=${cur} 下段仍渲染出裸管道符：${botHtml}`);
    assert.ok(/表格结束/.test(botHtml), `cur=${cur} 下段丢失表格后正文：${botHtml}`);
  }
  const oldBot = renderMarkdown(TABLE.slice(5).join('\n'));
  assert.ok(/\|/.test(oldBot), '差分对照失效：旧切法下段本应渲染出裸管道符文本');
});

// ---------- ③ 引用内缩进代码块（4 空格） ----------
const INDENT = [
  '> 示例代码：',
  '> ',
  '>     npm i',
  '>     npm run build',
  '> ',
  '> 结束。',
];

test('引用内缩进代码块：连续缩进行归入一段，非缩进行不误伤', () => {
  assert.deepStrictEqual(at(INDENT, 2), [2, 3]);
  assert.deepStrictEqual(at(INDENT, 3), [2, 3]);
  assert.strictEqual(at(INDENT, 1), null);
  assert.strictEqual(at(INDENT, 4), null, '块尾空行/普通段落不得被缩进代码块吸附');
  // 3 空格列表续行 ≠ 缩进代码块（≥4 空格才成代码块）：它随列表整体收录（见 ⑥），
  // 此处只校验其所属文献主体是「列表」而非「缩进代码」——两者地区
  const nested = ['> 步：', '> 1. 一', '>    1. 子'];
  assert.deepStrictEqual(at(nested, 2), [1, 2], '3 空格嵌套项应归列表整体，不归缩进代码块');
});

// ---------- ④ 引用内展示公式 $$ … $$ ----------
const MATH = [
  '> 公式：',
  '> ',
  '> $$',
  '> E = mc^2',
  '> $$',
  '> ',
  '> 结束。',
];

test('引用内展示公式：开/内容/闭行归入整段，不再让落单 $$ 显现', () => {
  assert.deepStrictEqual(at(MATH, 2), [2, 4]);
  assert.deepStrictEqual(at(MATH, 3), [2, 4]);
  assert.deepStrictEqual(at(MATH, 4), [2, 4]);
  assert.strictEqual(at(MATH, 6), null);
  const [s, e] = at(MATH, 3);
  const botHtml = renderMarkdown(MATH.slice(e + 1).join('\n'));
  assert.ok(!/\$\$/.test(botHtml), '下段仍渲染出落单 $$ 字面量：' + botHtml);
});

// ---------- ⑤ 引用内 HTML 容器块 ----------
const HTML = [
  '> 详情：',
  '> ',
  '> <details>',
  '> <summary>展开</summary>',
  '> ',
  '> 内容',
  '> ',
  '> </details>',
  '> ',
  '> 结束。',
];

test('引用内 HTML 容器：开标签到闭标签归入整段（含内部空行），闭标签不裸露', () => {
  for (const cur of [2, 3, 4, 5, 6, 7]) assert.deepStrictEqual(at(HTML, cur), [2, 7], `cur=${cur}`);
  assert.strictEqual(at(HTML, 9), null);
  const [s, e] = at(HTML, 5);
  const botHtml = renderMarkdown(HTML.slice(e + 1).join('\n'));
  assert.ok(!/<\/details>/.test(botHtml), '下段仍渲染出裸露闭标签：' + botHtml);
});

// ---------- ⑥ 引用内列表（含嵌套）整体收录 ----------
const LIST = [
  '> 步骤：',
  '> ',
  '> 1. 第一步',
  '>    1. 子步骤',
  '>    2. 子步骤二',
  '> 2. 第二步',
  '> ',
  '> 结束。',
];

test('引用内列表：整段收录（含嵌套子项），下段不再把子项提升成顶层新列表', () => {
  for (const cur of [2, 3, 4, 5]) assert.deepStrictEqual(at(LIST, cur), [2, 5], `cur=${cur}`);
  assert.strictEqual(at(LIST, 0), null);
  assert.strictEqual(at(LIST, 7), null);
  const [s, e] = at(LIST, 3);
  const botHtml = renderMarkdown(LIST.slice(e + 1).join('\n'));
  assert.ok(!/<ol/.test(botHtml), '下段仍渲染出被提升的顶层列表：' + botHtml);
  // 差分对照：旧切法下段必产 '<ol start="2">'（子项被提升成顶层列表，缩进层级丢失）
  const oldBot = renderMarkdown(LIST.slice(4).join('\n'));
  assert.ok(/<ol/.test(oldBot), '差分对照失效：旧切法下段本应产被提升的顶层列表');
});

// ---------- ⑦ 嵌套引用 / callout / 混合：确实能剥前缀到内容层 ----------
test('嵌套引用 `> > ` 内的围栏：剥掉多层前缀后仍能识别', () => {
  const lines = [
    '> 外层',
    '> ',
    '> > 内层说明：',
    '> > ',
    '> > ```js',
    '> > console.log(1)',
    '> > ```',
    '> ',
    '> 外层结束。',
  ];
  assert.deepStrictEqual(at(lines, 4), [4, 6]);
  assert.deepStrictEqual(at(lines, 5), [4, 6]);
  assert.deepStrictEqual(at(lines, 2), null, '嵌套引用的普通文字行须保持 null');
});

test('callout 内的围栏：[!NOTE] 标记行不影响围栏识别', () => {
  const lines = [
    '> [!NOTE]',
    '> 提示：',
    '> ',
    '> ```bash',
    '> echo hi',
    '> ```',
    '> ',
    '> 结束。',
  ];
  assert.deepStrictEqual(at(lines, 3), [3, 5]);
  assert.deepStrictEqual(at(lines, 4), [3, 5]);
  assert.strictEqual(at(lines, 1), null);
});

test('引用内表格 + 围栏混合：两种结构各自成段、互不相犯', () => {
  const lines = [
    '> ',
    '> | a | b |',
    '> | --- | --- |',
    '> | 1 | 2 |',
    '> ',
    '> ```sh',
    '> ls -l',
    '> ```',
    '> ',
    '> 收尾',
  ];
  for (const cur of [1, 2, 3]) assert.deepStrictEqual(at(lines, cur), [1, 3], `表 cur=${cur}`);
  for (const cur of [5, 6, 7]) assert.deepStrictEqual(at(lines, cur), [5, 7], `栏 cur=${cur}`);
  assert.strictEqual(at(lines, 0), null);
  assert.strictEqual(at(lines, 9), null);
});

// ---------- ⑧ 未闭合：吃到块末（不多不少） ----------
test('未闭合围栏 / 未闭合公式：区间延伸至块末，不越界', () => {
  const unclosedFence = ['> 说明：', '> ```sh', '> ls', '> 没有闭合'];
  assert.deepStrictEqual(at(unclosedFence, 1), [1, 3]);
  assert.deepStrictEqual(at(unclosedFence, 3), [1, 3]);
  assert.strictEqual(at(unclosedFence, 0), null);
  const unclosedMath = ['> 说明：', '> $$', '> x = 1'];
  assert.deepStrictEqual(at(unclosedMath, 1), [1, 2]);
  const unclosedHtml = ['> 说明：', '> <div>', '> 内容'];
  assert.deepStrictEqual(at(unclosedHtml, 1), [1, 2]);
});

test('波浪围栏 ~~~ 与反引号围栏同口径', () => {
  const lines = ['> 说明：', '> ~~~js', '> console.log(1)', '> ~~~', '> 收尾'];
  assert.deepStrictEqual(at(lines, 1), [1, 3]);
  assert.deepStrictEqual(at(lines, 2), [1, 3]);
  assert.strictEqual(at(lines, 4), null);
});

// ---------- ⑨ 纯函数口径：剥前缀、区间不重叠、越界安全 ----------
test('stripQuotePrefix：逐层剥到内容，保留内容相对缩进', () => {
  assert.strictEqual(stripQuotePrefix('> hello'), 'hello');
  assert.strictEqual(stripQuotePrefix('> > > deep'), 'deep');
  assert.strictEqual(stripQuotePrefix('>     code'), '    code', '相对缩进必须保留（缩进代码块判定依赖）');
  assert.strictEqual(stripQuotePrefix('>    - cont'), '   - cont');
  assert.strictEqual(stripQuotePrefix('no prefix'), 'no prefix');
});

test('quoteAtomicRanges：区间互不重叠且单调不越界', () => {
  for (const lines of [FENCE, TABLE, INDENT, MATH, HTML, LIST]) {
    const ranges = quoteAtomicRanges(lines.map(stripQuotePrefix));
    let prevEnd = -1;
    for (const [s, e] of ranges) {
      assert.ok(s >= 0 && e < lines.length, `区间越界 ${s},${e}`);
      assert.ok(s > prevEnd, `区间重叠/乱序 ${s},${e}`);
      assert.ok(e >= s, `空区间 ${s},${e}`);
      prevEnd = e;
    }
  }
});

test('quoteAtomicRange：越界/空入参返回 null（不抛）', () => {
  assert.strictEqual(quoteAtomicRange([], 0), null);
  assert.strictEqual(quoteAtomicRange(FENCE, -1), null);
  assert.strictEqual(quoteAtomicRange(FENCE, 99), null);
  assert.strictEqual(quoteAtomicRange(null, 0), null);
});

// ---------- ⑩ 接线收口：wysiwyg.js 真的用了这份整体判定 ----------
test('接线：_wysiwygApplyQuoteSegments 按 quoteAtomicRange 扩到整段源码', () => {
  const wys = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  assert.match(wys, /const ar = quoteAtomicRange\(rawLines, cur - b\.start\);/,
    '多处引用缺 quoteAtomicRange 调用（仍按光标行单点切分）');
  assert.match(wys, /const rawS = ar \? b\.start \+ ar\[0\] : cur;[\s\S]{0,80}?const rawE = ar \? b\.start \+ ar\[1\] : cur;/,
    '缺 rawS/rawE 回落（不在多行结构内时须退回光标行单点口径）');
  assert.match(wys, /mk\(b\.start, rawS, 'wysiwyg-quote-seg-top'\)/, '上段未以 rawS 收口');
  assert.match(wys, /mk\(rawE \+ 1, b\.end, 'wysiwyg-quote-seg-bottom'\)/, '下段未以 rawE 起算');
  // 接缝视觉参量（open/deep）必须跟着 raw 区走，不能还挂在旧的光标行两侧
  assert.match(wys, /const deepTop = rawS > b\.start && lvlOf\(rawS - 1\) > curLvl;/, 'deepTop 未按 raw 区上侧重算');
  assert.match(wys, /const deepBot = rawE \+ 1 < b\.end && lvlOf\(rawE \+ 1\) > curLvl;/, 'deepBot 未按 raw 区下侧重算');
  // 幂等键必须含范围：结构行数变化（加表格行/围栏内容）时须重挂
  assert.match(wys, /\{ idx, cur, curLvl, rawS, rawE, topSrc, botSrc \}/, '幂等状态缺 rawS/rawE');
  assert.match(wys, /stripQuotePrefix, quoteAtomicRanges, quoteAtomicRange,/, '纯函数未导出（测试无法直接 require 单测）');
});
