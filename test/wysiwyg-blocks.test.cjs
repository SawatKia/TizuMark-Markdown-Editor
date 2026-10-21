// 块切分的**行为**测试（不靠静态断言，真的跑切分结果）。
//
// 背景：阶段1 的块遮罩用 isBlockStart（虚拟滚动用的粗粒度判定）切块，实测出阻塞级 bug：
//   - 表格被逐行切碎（| a | b | 与 | --- | --- | 分成两块）
//   - 相邻标题/段落没被切开（光标在正文里，整段连标题一起变源码）
// 本文件直接验证「给定 Markdown → 切出哪些块」，是回归护栏。

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// wysiwyg.js L66 加载期引用裸全局 TMConst（098bc7b 2026-10-20 把引用行口径收口进
// constants.js 共享常量 BLOCKQUOTE_LINE_RE）。Node 独立 require 没有 index.html 的
// script 链 → 先备最小 window（constants.js IIFE 写 window.TMConst = 裸全局），
// 显式加载 constants.js 补全（同 list-insert.test.cjs L44-48 先例）。
global.window = global.window || globalThis;
require(path.join(ROOT, 'src', 'modules', 'constants.js'));
const { splitBlocks, splitTableRow, editTableRowCell } = require(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'));

const split = (md) => splitBlocks(md.split('\n')).map(b => b.lines);

// ---------- 表格：必须整体一块 ----------

test('表格：多行表格（含分隔行）切为【一块】，不逐行切碎', () => {
  const md = ['| a | b |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |'].join('\n');
  const bs = split(md);
  assert.strictEqual(bs.length, 1, '表格被切碎了：' + JSON.stringify(bs));
  assert.strictEqual(bs[0].length, 4);
});

test('表格：前后有正文时，表格独立成块', () => {
  const md = ['前面段落', '', '| a | b |', '| --- | --- |', '| 1 | 2 |', '', '后面段落'].join('\n');
  assert.deepStrictEqual(split(md), [['前面段落'], ['| a | b |', '| --- | --- |', '| 1 | 2 |'], ['后面段落']]);
});

// ---------- 相邻标题：必须切开 ----------

test('相邻标题与段落：无空行也要各自成块', () => {
  const md = ['# 标题', '正文一段', '## 子标题', '更多正文', '结尾'].join('\n');
  assert.deepStrictEqual(split(md), [
    ['# 标题'],
    ['正文一段'],
    ['## 子标题'],
    // CommonMark 语义：相邻纯文本行属同一段落，故「更多正文」与「结尾」是一块
    ['更多正文', '结尾'],
  ]);
});

// ---------- 列表：整体一块（含任务列表、嵌套） ----------

// 2026-10-21 用户反馈：点列表项应只显示**光标所在列表项**的源码、兄弟项保持渲染态
// → 紧凑列表（块内无空行）按项切块，每项一个块（listItem/listItemPos 标签供遮罩
// 片段底距与活动块 edge-bottom 判定用）；松散列表（项间空行）保持整块——空行是真实
// 源行，拆项会把它裸露成可见行、渲染间距改变。

test('无序列表（紧凑）：连续列表项按项切块（每项一块）', () => {
  const md = ['- a', '- b', '- c'].join('\n');
  assert.deepStrictEqual(split(md), [['- a'], ['- b'], ['- c']]);
});

test('有序列表（紧凑）：连续列表项按项切块（每项一块）', () => {
  const md = ['1. a', '2. b', '3. c'].join('\n');
  assert.deepStrictEqual(split(md), [['1. a'], ['2. b'], ['3. c']]);
});

test('任务列表（紧凑）：按项切块（不按 - [ ] 拆项内容）', () => {
  const md = ['- [ ] a', '- [x] b', '- [ ] c'].join('\n');
  assert.deepStrictEqual(split(md), [['- [ ] a'], ['- [x] b'], ['- [ ] c']]);
});

test('紧凑列表按项切块：listItem/listItemPos 标签（first/middle/last）', () => {
  const bs = splitBlocks(['- a', '- b', '- c']);
  assert.deepStrictEqual(bs.map(b => [b.start, b.end]), [[0, 1], [1, 2], [2, 3]]);
  assert.ok(bs.every(b => b.listItem === true), '逐项块必须带 listItem 标签');
  assert.deepStrictEqual(bs.map(b => b.listItemPos), ['first', 'middle', 'last']);
});

test('紧凑列表带嵌套子项：子项归属父项块（整棵子树 = 一项），同级项另起块', () => {
  const md = ['- a', '  - b', '  - c', '- d'].join('\n');
  assert.deepStrictEqual(split(md), [['- a', '  - b', '  - c'], ['- d']]);
});

test('嵌套列表（单项+深层子项）：单项即整列表，保持一块', () => {
  const md = ['- a', '    - b', '        - c'].join('\n');
  assert.deepStrictEqual(split(md), [['- a', '    - b', '        - c']]);
});

test('松散列表（项间空行）：保持整块（空行在块内，不拆项、无 listItem 标签）', () => {
  const lines = ['- a', '', '- b', '', '- c'];
  const bs = splitBlocks(lines);
  assert.strictEqual(bs.length, 1, JSON.stringify(bs));
  assert.deepStrictEqual(bs[0].lines, lines, '松散列表整块必须含项间空行');
  assert.ok(!bs[0].listItem, '松散列表不按项切块');
});

test('列表与后续正文分开（空行分隔；紧凑列表按项切）', () => {
  const md = ['- a', '- b', '', '后续正文'].join('\n');
  assert.deepStrictEqual(split(md), [['- a'], ['- b'], ['后续正文']]);
});

// ---------- 引用块 / callout ----------

test('引用块：连续 > 行切为一块', () => {
  const md = ['> 引用1', '> 引用2'].join('\n');
  assert.deepStrictEqual(split(md), [['> 引用1', '> 引用2']]);
});

test('callout（> [!NOTE] 多行）：整体一块', () => {
  const md = ['> [!NOTE]', '> 正文第一行', '> 正文第二行'].join('\n');
  assert.deepStrictEqual(split(md), [['> [!NOTE]', '> 正文第一行', '> 正文第二行']]);
});

test('嵌套引用：多层 > 仍为一块', () => {
  const md = ['> 外层', '> > 内层'].join('\n');
  assert.deepStrictEqual(split(md), [['> 外层', '> > 内层']]);
});

// ---------- 代码围栏 ----------

test('代码围栏：含语言标注与内部空行，整体一块且不误切', () => {
  const md = ['```js', 'const a=1;', '', 'const b=2;', '```'].join('\n');
  assert.deepStrictEqual(split(md), [['`js', 'const a=1;', '', 'const b=2;', '```'].map((s, i) => md.split('\n')[i])]);
});

test('围栏内的 # 与 | 不得被当成块起点', () => {
  const md = ['```', '# not a heading', '| not | a table |', '```'].join('\n');
  assert.strictEqual(split(md).length, 1, '围栏内部被误切');
});

test('未闭合围栏：剩余全部归一块（不得吞掉后续文档）', () => {
  const md = ['```', 'a', 'b'].join('\n');
  assert.strictEqual(split(md).length, 1);
});

// ---------- 其他块级 ----------

test('水平分割线：单独成块', () => {
  const md = ['a', '', '---', '', 'b'].join('\n');
  assert.deepStrictEqual(split(md), [['a'], ['---'], ['b']]);
});

test('front matter：--- 到 --- 之间为一块', () => {
  const md = ['---', 'title: x', '---', '', '正文'].join('\n');
  assert.deepStrictEqual(split(md), [['---', 'title: x', '---'], ['正文']]);
});

test('普通段落：连续文本为一块', () => {
  const md = ['第一行', '第二行', '第三行'].join('\n');
  assert.deepStrictEqual(split(md), [['第一行', '第二行', '第三行']]);
});

test('混合文档：逐块切分正确（覆盖典型场景）', () => {
  const md = [
    '# 标题',
    '正文段落',
    '## 子标题',
    '- 列表A',
    '- 列表B',
    '',
    '| 表头 | 二 |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '> [!WARNING]',
    '> 注意',
    '',
    '```py',
    'print(1)',
    '```',
    '',
    '结尾',
  ].join('\n');
  assert.deepStrictEqual(split(md), [
    ['# 标题'],
    ['正文段落'],
    ['## 子标题'],
    ['- 列表A'],
    ['- 列表B'],
    ['| 表头 | 二 |', '| --- | --- |', '| 1 | 2 |'],
    ['> [!WARNING]', '> 注意'],
    ['```py', 'print(1)', '```'],
    ['结尾'],
  ]);
});

// ---------- 边界 ----------

test('空文档 / 全空行：不产生任何块', () => {
  assert.deepStrictEqual(split(''), []);
  assert.deepStrictEqual(split('\n\n\n'), []);
});

test('块内不含空行（空行一律作分隔，不归属任何块）', () => {
  for (const b of split('# a\n\n正文\n\n- x\n\n> y')) {
    assert.ok(!b.some(l => l.trim() === ''), '块内混入了空行：' + JSON.stringify(b));
  }
});

test('行号区间与块内容一致（start/end 精确）', () => {
  const lines = ['# t', 'p', '', '- a', '- b'];
  const bs = splitBlocks(lines);
  for (const b of bs) {
    assert.deepStrictEqual(lines.slice(b.start, b.end), b.lines, '行号区间与内容不符');
  }
});

// ---------- remark 解析器切块（renderMarkdownBlocks，主路径） ----------
// 手写 splitBlocks 与 CommonMark 边界有系统性偏差，遮罩切块已改为 remark 解析器
// （与阅读模式同一套解析），保证逐块渲染与阅读模式完全一致。
// 渲染器是纯 CommonJS（require('unified') 等），Node 可直接加载做行为验证。

const { renderMarkdownBlocks } = require('../src/unified-renderer.js');

test('remark 切块：`1.` 独立行 + 缩进内容必须是一个有序列表块（不得拆出空列表项）', () => {
  // 曾被手写切块器拆成两块：`1.` 渲染成空列表项（只剩序号）、缩进行渲染成独立块
  // —— 即真机截图里「带有序号的空行」。remark 解析与阅读模式一致，必须整块。
  const md = ['1.', '    收到任务，先检查是否有匹配的 skill', '', '2.', '    设计先于编码'].join('\n');
  const blocks = renderMarkdownBlocks(md, {});
  assert.strictEqual(blocks.length, 1, '应切为 1 块（整个有序列表），实际 ' + blocks.length);
  assert.strictEqual(blocks[0].start, 0);
  assert.strictEqual(blocks[0].end, 5);
  const html = blocks[0].html;
  assert.match(html, /<ol/, '应渲染为有序列表');
  assert.match(html, /收到任务/, '列表项内容不得丢失');
  assert.match(html, /设计先于编码/, '第二个列表项内容不得丢失');
  assert.doesNotMatch(html, /<li>\s*<\/li>/, '不得出现空列表项（只剩序号的空行）');
});

test('remark 切块：表格含对齐行整体一块，标题/段落/表格各自成块，紧凑列表按项切块，空行不归属', () => {
  const md = [
    '# 标题',
    '',
    '正文一段',
    '',
    '- 项目 A',
    '- 项目 B',
    '',
    '| a | b |',
    '| --- | --- |',
    '| 1 | 2 |',
    '',
    '结尾',
  ].join('\n');
  const blocks = renderMarkdownBlocks(md, {});
  assert.strictEqual(blocks.length, 6, '标题/段落/列表两项/表格/段落各一块，实际 ' + blocks.length);
  assert.deepStrictEqual(blocks.map(b => [b.start, b.end]), [[0, 1], [2, 3], [4, 5], [5, 6], [7, 10], [11, 12]]);
  const table = blocks[4];
  assert.match(table.html, /<table/, '表格整体渲染（含分隔行与数据行）');
  for (const b of blocks) assert.ok(b.html && b.html.trim(), '每个内容块都应有渲染 html');
  assert.ok(blocks[2].listItem && blocks[2].listItemPos === 'first', '首个列表项块应带 listItem/first 标签');
  assert.ok(blocks[3].listItem && blocks[3].listItemPos === 'last', '末个列表项块应带 listItem/last 标签');
});

test('remark 切块：紧凑有序列表按项切块，逐项片段 <ol start=N>（序号与源一致，不回位 1）', () => {
  const md = ['1. 甲', '2. 乙', '3. 丙'].join('\n');
  const blocks = renderMarkdownBlocks(md, {});
  assert.deepStrictEqual(blocks.map(b => [b.start, b.end]), [[0, 1], [1, 2], [2, 3]]);
  assert.ok(blocks.every(b => b.listItem), '紧凑有序列表必须按项切块');
  assert.match(blocks[1].html, /<ol start="2"[^>]*>/, '第 2 项片段须带 start="2"（否则序号回位 1）');
  assert.match(blocks[2].html, /<ol start="3"[^>]*>/, '第 3 项片段须带 start="3"');
  assert.doesNotMatch(blocks[0].html, /start="[23]"/, '首项片段不得带后项序号');
  assert.match(blocks[1].html, /乙/, '逐项片段不得丢内容');
});

test('remark 切块：紧凑列表带嵌套子项——父项含子项行段为一块，同级项另起块', () => {
  const md = ['- a', '  - b', '- c'].join('\n');
  const blocks = renderMarkdownBlocks(md, {});
  assert.deepStrictEqual(blocks.map(b => [b.start, b.end]), [[0, 2], [2, 3]]);
  assert.match(blocks[0].html, /<ul [^>]*>\s*<li [^>]*>a\s*<ul [^>]*>\s*<li [^>]*>b/, '父项片段须含嵌套子列表（与整列表渲染同构）');
});

test('remark 切块：松散列表（项间空行）保持一块（无 listItem 标签，块内含空行）', () => {
  const md = ['- a', '', '- b'].join('\n');
  const blocks = renderMarkdownBlocks(md, {});
  assert.strictEqual(blocks.length, 1, '松散列表不得拆项：' + JSON.stringify(blocks.map(b => [b.start, b.end])));
  assert.strictEqual(blocks[0].start, 0);
  assert.strictEqual(blocks[0].end, 3);
  assert.ok(!blocks[0].listItem, '松散列表不按项切块');
});

test('remark 切块：围栏代码块内部空行/井号不切断，HTML 注释单块', () => {
  const md = [
    '```js',
    '# 不是标题',
    '',
    'const a = 1;',
    '```',
    '',
    '<!-- 注释 -->',
  ].join('\n');
  const blocks = renderMarkdownBlocks(md, {});
  assert.strictEqual(blocks.length, 2);
  assert.strictEqual(blocks[0].end, 5, '围栏吃到闭合行为止');
  assert.match(blocks[0].html, /<code|<pre/, '代码块渲染');
  assert.strictEqual(blocks[1].start, 6);
});

test('remark 切块：块边界与阅读模式一致（逐块 html 与整篇渲染同构；逐项列表片段各重发列表容器标签）', () => {
  const md = ['## 小节', '', '段落文本', '', '1. 甲', '2. 乙'].join('\n');
  const { renderMarkdown } = require('../src/unified-renderer.js');
  const blocks = renderMarkdownBlocks(md, {});
  // 逐块渲染的标签序列应与整篇渲染一致（同一套 remark 解析的必然结果）；唯一例外：
  // 紧凑列表按项切块后，每个项片段自带一个 <ol>/<ul> 容器（n 项 → n 个开标签，整篇为 1）
  const tagsOf = (h) => (h.match(/<(h\d|p|ol|ul|li|table)[ >]/g) || []).join(',');
  const whole = tagsOf(renderMarkdown(md, {}));
  const byBlocks = blocks.map(b => tagsOf(b.html)).join(',');
  const itemBlocks = blocks.filter(b => b.listItem);
  const count = (t, tag) => (t.split(',').filter(x => x === tag).length);
  const norm = (t) => t.split(',').filter(x => x !== '<ol ' && x !== '<ul ').join(',');
  assert.strictEqual(norm(byBlocks), norm(whole), '除逐项列表容器标签外，逐块渲染应与整篇一致');
  assert.strictEqual(count(byBlocks, '<ol '), count(whole, '<ol ') + Math.max(0, itemBlocks.length - 1),
    '逐项列表片段每项重发一个 <ol> 容器（n 项 → n 个开标签）');
  assert.strictEqual(count(byBlocks, '<li '), count(whole, '<li '), 'li 数量须与整篇一致');
});

test('remark 切块：多行展示公式内含独占一行的 `=`（setext 下划线）必须整块且渲染为公式而非巨型 h1', () => {
  // 真机 demo.md 矩阵乘法公式（2026-10-08 用户截图）：公式内部有一行单独的 `=`，
  // 若切块前未做公式守卫，remark 会把 `=` 当 setext 标题下划线，把公式劈成两块、
  // 前半渲染成一个装着公式源码的巨型 h1。切块必须先经 guardMathBlocks 保护。
  const md = [
    '矩阵乘法：',
    '',
    '$$',
    '\\begin{bmatrix}',
    'a_{11} & a_{12} \\\\',
    'a_{21} & a_{22}',
    '\\end{bmatrix}',
    '=',
    '\\begin{bmatrix}',
    'c_{11} & c_{12} \\\\',
    'c_{21} & c_{22}',
    '\\end{bmatrix}',
    '$$',
    '',
    '结尾段落',
  ].join('\n');
  const blocks = renderMarkdownBlocks(md, {});
  // 公式（行 2..12，0-based）必须是【一个】块，不得被 `=` 行劈开
  const mathBlock = blocks.find(b => b.start <= 2 && 2 < b.end);
  assert.ok(mathBlock, '应存在覆盖公式起始行的块');
  assert.strictEqual(mathBlock.start, 2, '公式块应从 `$$` 行开始');
  assert.strictEqual(mathBlock.end, 13, '公式块应吃到闭合 `$$` 行（含），实际 end=' + mathBlock.end);
  assert.doesNotMatch(mathBlock.html, /<h1[\s>]/, '公式块不得渲染出巨型 h1（setext 误判）');
  assert.match(mathBlock.html, /math-display/, '公式块应渲染为展示公式容器');
  // 公式前后的普通块不受影响
  assert.ok(blocks.some(b => /矩阵乘法/.test(b.html)), '公式前段落块应保留');
  assert.ok(blocks.some(b => /结尾段落/.test(b.html)), '公式后段落块应保留');
});

test('ref 定义行单独成块：渲染为空时输出 wysiwyg-block-hidden 占位（与阅读模式「不显示定义行」对齐）', () => {
  // 2026-10-12 真机反馈：阅读模式整篇渲染时 remark 把纯 `[label]: url` 定义块解析为空
  // （无 html），逐块渲染该块 html='' → 旧实现按「渲染失败」保留源码态 → 实时预览
  // 露出定义行而阅读模式隐藏。占位 div 让遮罩把该块盖成高度 0（CSS 塌缩）。
  const md = ['正文一段 [TizuMark][ref-example]。', '', '[ref-example]: https://example.com "title"', ''].join('\n');
  const blocks = renderMarkdownBlocks(md, {});
  // 定义块（行 2..3，0-based [2,4) 或 [2,3)——取决于尾随空行归属）
  const defBlock = blocks.find(b => /[^\n]*\[ref-example\]:/.test(md.split('\n').slice(b.start, b.end).join('\n')));
  assert.ok(defBlock, '应存在 ref 定义块');
  assert.match(defBlock.html, /<div class="wysiwyg-block-hidden"><\/div>/, '纯 ref 定义块必须输出塌缩占位（实际：' + defBlock.html + '）');
  // 正文块不受影响（引用处跨块还原是 R12 后置项，这里只断言正文块 html 非空）
  const para = blocks.find(b => b !== defBlock);
  assert.ok(para && para.html && !/wysiwyg-block-hidden/.test(para.html), '正文块不应被塌缩占位覆盖');
});

test('占位判据双条件：定义行紧贴段落（无空行）并入段落块 → html 非空 → 不输出占位', () => {
  // 占位只认「渲染结果为空 且 块内每行都是合法 ref 定义」。无空行时 remark 把定义行并入
  // 上一段落（URL 变内联链接）→ 整块 html 非空 → 块必须正常显示，不得塌缩吞内容。
  const blocks = renderMarkdownBlocks('段落文本\n[x]: https://x.example', {});
  assert.strictEqual(blocks.length, 1, '应切 1 块（定义行并入段落），实际 ' + blocks.length);
  assert.doesNotMatch(blocks[0].html, /wysiwyg-block-hidden/, 'html 非空的块不得被塌缩占位覆盖');
  assert.match(blocks[0].html, /<p/, '应渲染为段落');
  assert.match(blocks[0].html, /段落文本/, '段落内容不得丢失');
});

test('precompute 防御：renderMarkdownBlocks 返回的块必须全部带合法 start/end（防 undefined 元素进下游 .start）', () => {
  // 2026-10-12：HMR 混载旧模块时曾出现 "Cannot read properties of undefined (reading 'start')"，
  // precomputeWysiwygBlocksFull 返回前 filter 畸形条目；渲染器侧同样不得产出畸形块。
  const md = ['# 标题', '', '段落。', '', '[r]: https://r.example', '', '- a', '- b'].join('\n');
  const blocks = renderMarkdownBlocks(md, {});
  for (const b of blocks) {
    assert.ok(b && typeof b.start === 'number' && typeof b.end === 'number' && b.end > b.start,
      '渲染器产出的每个块必须带合法 start/end：' + JSON.stringify(b));
  }
});

// ---------- 表格行纯函数（splitTableRow / editTableRowCell，Phase 2 单元格就地编辑） ----------

test('splitTableRow：标准带首尾竖线行 → 单元格数组 + 首尾风格标记', () => {
  const info = splitTableRow('| 列甲 | 列乙 |');
  assert.deepStrictEqual(info.cells, ['列甲', '列乙']);
  assert.strictEqual(info.hasLeading, true);
  assert.strictEqual(info.hasTrailing, true);
});

test('splitTableRow：无首尾竖线行保持无竖线风格；单元格内 \\| 不切分', () => {
  const info = splitTableRow('a | b');
  assert.deepStrictEqual(info.cells, ['a', 'b']);
  assert.strictEqual(info.hasLeading, false);
  assert.strictEqual(info.hasTrailing, false);
  const esc = splitTableRow('| x\\|y | z |');
  assert.deepStrictEqual(esc.cells, ['x\\|y', 'z'], '转义竖线 \\| 必须留在单元格内，不切分');
});

test('splitTableRow：空单元格 / 前导与尾随空格 trim', () => {
  assert.deepStrictEqual(splitTableRow('|  | 空 |  |').cells, ['', '空', '']);
  assert.deepStrictEqual(splitTableRow('|  带空格  |  z  |').cells, ['带空格', 'z']);
});

test('editTableRowCell：替换单元格并保留首尾竖线风格', () => {
  assert.strictEqual(editTableRowCell('| 1 | 2 |', 1, '新值'), '| 1 | 新值 |');
  assert.strictEqual(editTableRowCell('1 | 2', 0, '新值'), '新值 | 2', '无竖线行回写仍不带首尾竖线');
});

test('editTableRowCell：新文本中的裸 | 自动转义；原 \\| 保持 \\|（先解后转，幂等）', () => {
  assert.strictEqual(editTableRowCell('| 1 | 2 |', 1, 'a|b'), '| 1 | a\\|b |');
  assert.strictEqual(editTableRowCell('| 1 | x\\|y |', 1, 'x\\|y'), '| 1 | x\\|y |', '未改动的转义格回写后保持原样');
  assert.strictEqual(editTableRowCell('| 1 | x\\|y |', 1, 'x|y'), '| 1 | x\\|y |', '用户删掉反斜杠 → 仍被重新转义');
});

test('editTableRowCell：colIdx 越界 → 原样返回；换行折叠为空格', () => {
  assert.strictEqual(editTableRowCell('| 1 | 2 |', 5, 'x'), '| 1 | 2 |');
  assert.strictEqual(editTableRowCell('| 1 | 2 |', -1, 'x'), '| 1 | 2 |');
  assert.strictEqual(editTableRowCell('| 1 | 2 |', 1, 'a\nb\rc'), '| 1 | a b c |');
});

// ---------- 表格结构纯函数（增行/增列/拖拽换位，2026-10-13 用户要求） ----------

const { addTableRow, addTableColumn, moveTableRow, moveTableColumn } =
  require(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'));

const T3 = ['| a | b |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |'].join('\n');

test('addTableRow：末尾增一空行（格数=表头格数），其余行原样', () => {
  const out = addTableRow(T3);
  const lines = out.split('\n');
  assert.strictEqual(lines.length, 5, '行数 +1：' + out);
  assert.strictEqual(lines[0], '| a | b |');
  assert.strictEqual(lines[1], '| --- | --- |');
  assert.strictEqual(lines[2], '| 1 | 2 |');
  assert.strictEqual(lines[3], '| 3 | 4 |');
  // 新行 = 2 个空格（写法与 editTableRowCell 的空格约定一致，remark trim 后为空）
  assert.deepStrictEqual(splitTableRow(lines[4]).cells, ['', '']);
});

test('addTableRow：保留无首尾竖线风格', () => {
  const bare = ['a | b', '--- | ---', '1 | 2'].join('\n');
  const lines = addTableRow(bare).split('\n');
  assert.strictEqual(lines[0], 'a | b');
  assert.strictEqual(lines[3], ' | ', '无竖线空行 = 两空格以 " | " 连接');
});

test('addTableRow：畸形输入（非表格/单行）→ null，不破坏原文', () => {
  assert.strictEqual(addTableRow('不是表格'), null);
  assert.strictEqual(addTableRow('| 只有表头 |'), null);
});

test('addTableColumn：每行 +1 空列（分隔行补 ---），其余格原样', () => {
  const out = addTableColumn(T3);
  const lines = out.split('\n');
  assert.strictEqual(lines.length, 4, '行数不变：' + out);
  assert.deepStrictEqual(splitTableRow(lines[0]).cells, ['a', 'b', '']);
  assert.deepStrictEqual(splitTableRow(lines[1]).cells, ['---', '---', '---']);
  assert.deepStrictEqual(splitTableRow(lines[2]).cells, ['1', '2', '']);
  assert.deepStrictEqual(splitTableRow(lines[3]).cells, ['3', '4', '']);
});

test('moveTableRow：行序重排（0=表头行、1=首数据行），分隔行恒居第 2 行', () => {
  // 数据行 0（tr 1，值 1|2）移到末尾（行序列 = 表头 + 数据行，不含分隔行）
  const out1 = moveTableRow(T3, 1, 2).split('\n');
  assert.deepStrictEqual(out1, ['| a | b |', '| --- | --- |', '| 3 | 4 |', '| 1 | 2 |']);
  // 表头行下移到数据区（新表头 = 原首数据行），分隔行仍第 2 行
  const out2 = moveTableRow(T3, 0, 2).split('\n');
  assert.strictEqual(out2[1], '| --- | --- |', '分隔行必须恒在源码第 2 行');
  assert.deepStrictEqual(splitTableRow(out2[0]).cells, ['1', '2'], '表头 = 原首数据行');
});

test('moveTableRow：越界/同位 → 原样返回', () => {
  assert.strictEqual(moveTableRow(T3, 9, 0), T3);
  assert.strictEqual(moveTableRow(T3, 0, 9), T3);
  assert.strictEqual(moveTableRow(T3, 1, 1), T3);
  assert.strictEqual(moveTableRow('不是表格', 0, 1), null);
});

test('moveTableColumn：列序重排，对齐标记随列走', () => {
  const t = ['| a | b |', '| :--- | ---: |', '| 1 | 2 |'].join('\n');
  // 列 0 移到列 1 之后
  const out = moveTableColumn(t, 0, 1).split('\n');
  assert.deepStrictEqual(splitTableRow(out[0]).cells, ['b', 'a']);
  assert.deepStrictEqual(splitTableRow(out[1]).cells, ['---:', ':---'], '对齐标记随列移动');
  assert.deepStrictEqual(splitTableRow(out[2]).cells, ['2', '1']);
});

test('moveTableColumn：越界/同位 → 原样返回', () => {
  assert.strictEqual(moveTableColumn(T3, 5, 0), T3);
  assert.strictEqual(moveTableColumn(T3, 0, 0), T3);
  assert.strictEqual(moveTableColumn('不是表格', 0, 1), null);
});
