// 列表/定义列表行「隐藏标记前缀」Backspace·Delete 守卫的行为测试（2026-10-24）。
//
// 背景（用户截图 + 真机探针实测，.workbuddy/diag-list-backspace.cjs）：WYSIWYG 活动块里
// 列表标记是透明/零宽装饰（wysiwyg-task-prefix 24px 槽 + task-box-zero 零宽槽等），光标
// 在正文起点按 Backspace 走 CM 原生逐字符删：
//   - 任务项「- [ ] 准备 macOS 适配」要 **7 次**才能并到上一行；中间态逐次裸露：
//     `- [ ]准备`（RE.task 失配 → ul 回退渲染「• []」，用户截图 2）、`- [ 准备`（裸 `[ `）、
//     `-准备`（裸 `-`）
//   - 有序项 4 次（`2.第二步` 裸序号）、无序项 3 次（`-无序乙` 裸 `-`）
//   - 空任务项 `- [ ] ` 还要 5~6 次
//   - Delete 行尾并下一项会并出「- 无序甲- 无序乙」标记残骸
//
// 修复口径（listMarkerZoneEnd + _ensureWysiwygListKeyGuard）：
//   - 标记区内（含正文起点）Backspace → 一次剥离整个标记（项变普通段落）；
//     空项 → 整行并入上一行（一次删到上一行）
//   - Delete 行尾 + 下一行是标记行 → 剥标记后并接
//   - 标题 `#`（可见小灰）、引用 `>`（光标行可见）**不在区内**：可见字符逐字符删即
//     所见即所得，不拦截
// 本文件直接用真实 Markdown 行跑 listMarkerZoneEnd（守卫与行装饰共用同一纯函数），
// 并以探针实测的「原生中间态」作对照，锁死剥离语义。

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// wysiwyg.js L66 加载期引用裸全局 TMConst —— 先加载 constants.js 补全
// （同 wysiwyg-quote-atomic-seg.test.cjs / wysiwyg-blocks.test.cjs 先例）。
global.window = global.window || globalThis;
require(path.join(ROOT, 'src', 'modules', 'constants.js'));
const { listMarkerZoneEnd } = require(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'));

const z = (line) => listMarkerZoneEnd(line);

// ---------- ① 任务项（用户主诉） ----------
test('任务项：隐藏标记区覆盖整段「- [ ] 」，终点 = 正文起点', () => {
  assert.strictEqual(z('- [ ] 准备 macOS 适配'), 6, '正文起点 = 「准」处（探针场景 1 起点）');
  assert.strictEqual(z('- [x] 已完成事项'), 6, '勾选态同区');
  assert.strictEqual(z('- [X] 大写 X 亦同'), 6);
  assert.strictEqual(z('  - [ ] 嵌套任务项'), 8, '前导缩进也是隐藏字符（wysiwyg-list-space-zero），须入区');
  assert.strictEqual(z('* [ ] 星号 bullet 同口径'), 6);
  assert.strictEqual(z('+ [ ] 加号 bullet 同口径'), 6);
  assert.strictEqual(z('- [ ] '), 6, '空任务项（正文空白）：区终点 = 行尾 → 守卫整行并入上一行');
});

// ---------- ② 无序/有序项（探针场景 2/3） ----------
test('无序/有序项：标记区终点 = 正文起点；空项整行入区', () => {
  assert.strictEqual(z('- 无序乙'), 2);
  assert.strictEqual(z('1. 第一步说明'), 3);
  assert.strictEqual(z('2. 第二步说明'), 3);
  assert.strictEqual(z('10. 两位数序号'), 4, '多位数序号全段入区');
  assert.strictEqual(z('1) 圆括号序号（渲染态嵌套层）'), 3);
  assert.strictEqual(z('- '), 2, '空无序项 → 整行');
  assert.strictEqual(z('3. '), 3, '空有序项 → 整行');
});

// ---------- ③ 中间态/破损行（原生逐字符删会到达的破损状态） ----------
test('破损中间态：RE.task 失配时回落 ul 口径（守卫保证正常路径不会再产出这些状态）', () => {
  // 原生删除第 1 次后的状态：`- [ ]准备`（task 失配，ul 命中）→ 区只含 `- `，
  // 剩余 `[ ]` 已是可见裸字符 → 不在隐藏区（删它们是可见编辑，无需拦截）
  assert.strictEqual(z('- [ ]准备'), 2);
  assert.strictEqual(z('- [ 准备'), 2);
  assert.strictEqual(z('- 准备'), 2);
  assert.strictEqual(z('2.第二步说明'), 0, '有序项删掉空格后 ol 失配 → 非标记行（裸序号可见，原生删）');
  assert.strictEqual(z('-无序乙'), 0, '无序项删掉空格后 ul 失配 → 非标记行');
});

// ---------- ④ 非标记行（零回归面） ----------
test('非标记行返回 0：标题/引用/段落/围栏/表格/空行全走原生', () => {
  assert.strictEqual(z('# 标题'), 0, 'ATX 标题 # 可见（小灰字），逐字符删即所见即所得');
  assert.strictEqual(z('> 引用行'), 0, '引用 > 光标行可见，不拦截');
  assert.strictEqual(z('> > 嵌套引用'), 0);
  assert.strictEqual(z('普通段落'), 0);
  assert.strictEqual(z(''), 0);
  assert.strictEqual(z('   '), 0);
  assert.strictEqual(z('```js'), 0);
  assert.strictEqual(z('| 表格 | 行 |'), 0);
  assert.strictEqual(z('- - -'), 0, '集合线可能被 ul 正则误吞（首「- 」），显式排除');
  assert.strictEqual(z('---'), 0);
  assert.strictEqual(z('1. 0.2 之类非列表？'), 3, '仍是 ol 形态（数字 + . + 空格）—— CommonMark 同口径');
});

// ---------- ⑤ 定义列表 dd 行 ----------
test('dd 行「: 」透明前缀入区（wysiwyg-dd-colon 同为隐藏前缀）', () => {
  assert.strictEqual(z(': 定义内容'), 2);
  assert.strictEqual(z(':'), 1, '孤冒号 dd 行（isDd 口径 ^(: |:$)）');
});

// ---------- ⑥ 剥离语义差分（对照探针实测的原生中间态） ----------
test('剥离语义：从正文起点一次剥到 0，等价于把探针 7 次按键的终点一步达成', () => {
  // 探针场景 1：7 次 Backspace 才把「- [ ] 准备 macOS 适配」并进上一行，
  // 中间态：#1 `- [ ]准备`（裸「• []」截图态）→ #6 `准备 macOS 适配` → #7 才并上。
  // 守卫口径：第 1 次即达「准备 macOS 适配」（剥离 [0, zoneEnd)），
  // 第 2 次在「正文起点 ch=0 + 非标记行」走原生并行。
  const line = '- [ ] 准备 macOS 适配';
  const stripped = line.slice(z(line));
  assert.strictEqual(stripped, '准备 macOS 适配', '一次剥离 = 探针 6 次按键的净效果，且不经过任何裸露中间态');
  // 空项：整行并入（不残留「- [ ]」「- 」等中间态）
  const empty = '- [ ] ';
  assert.strictEqual(z(empty), empty.length, '空项区终点 = 行尾 → 整行并入上一行');
});
