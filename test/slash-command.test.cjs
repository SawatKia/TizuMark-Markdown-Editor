// slash 命令面板测试：输入 / 触发（行首或空格后）、过滤、方向导航、Enter 确认插入、
// Esc 关闭、空格关闭、and/ 等正文斜杠不误触。
// 使用 withEditor 串行化，避免 node:test 并发子测试互相踩踏共享的 global.window/document。
const test = require('node:test');
const assert = require('node:assert');
const { withEditor } = require('./helpers/app-env.cjs');

// 模拟「输入 / 并触发」：在指定位置插入 /，光标移到 / 后，调用触发检测
function typeSlash(ed, line, ch) {
  ed.cm.replaceRange('/', { line, ch });
  const pos = { line, ch: ch + 1 };
  ed.cm.setCursor(pos);
  ed._maybeTriggerSlash(ed.cm, pos);
}

test('slash: 行首输入 / 触发面板', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  ed.cm.setValue('');
  typeSlash(ed, 0, 0);
  assert.strictEqual(ed._slashOpen, true, '行首 / 应触发面板');
  assert.ok(w.document.getElementById('slash-panel'), '应创建面板 DOM');
  assert.strictEqual(w.document.getElementById('slash-panel').classList.contains('hidden'), false, '面板应可见');
}));

test('slash: / 前有空格时触发', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  ed.cm.setValue('hello '); // 末尾有空格
  typeSlash(ed, 0, 6);
  assert.strictEqual(ed._slashOpen, true, '空格后 / 应触发面板');
}));

test('slash: and/ 等正文斜杠不触发', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  ed.cm.setValue('and');
  typeSlash(ed, 0, 3); // 在 d 后插入 /，前缀为字母
  assert.strictEqual(ed._slashOpen, false, '非空格/行首前的 / 不应触发');
}));

test('slash: 输入 query 实时过滤（h1 筛出标题）', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  ed.cm.setValue('');
  typeSlash(ed, 0, 0);
  assert.strictEqual(ed._slashOpen, true);
  ed._slashQuery = 'h1';
  ed._renderSlashPanel();
  const filtered = ed._slashFiltered;
  assert.ok(filtered.length >= 1, '应包含 h1 命令');
  assert.ok(filtered.every((c) => /h1|heading|title|biaoti/i.test(c.label + c.keywords.join(','))), '过滤结果应匹配 h1 关键字');
  // 面板只渲染匹配项
  const items = w.document.querySelectorAll('#slash-panel .slash-item');
  assert.strictEqual(items.length, filtered.length, '面板项数与过滤结果一致');
}));

test('slash: 中文关键字过滤（表格）', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  ed.cm.setValue('');
  typeSlash(ed, 0, 0);
  ed._slashQuery = '表格';
  ed._renderSlashPanel();
  assert.strictEqual(ed._slashFiltered.length, 1, '表格应只匹配 insert-table');
  assert.strictEqual(ed._slashFiltered[0].action, 'insert-table');
}));

test('slash: 空 query 显示全部命令', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  ed.cm.setValue('');
  typeSlash(ed, 0, 0);
  ed._slashQuery = '';
  ed._renderSlashPanel();
  assert.strictEqual(ed._slashFiltered.length, ed._buildSlashCommands().length, '空 query 应列出全部命令');
}));

test('slash: 列表已优选——上标/下标已移除，高频置顶', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  const cmds = ed._buildSlashCommands();
  // 上标/下标为纯 HTML 边缘标签，已从面板移除（手写即可）
  assert.ok(!cmds.some((c) => c.action === 'insert-superscript'), '上标应已移除');
  assert.ok(!cmds.some((c) => c.action === 'insert-subscript'), '下标应已移除');
  assert.strictEqual(cmds.length, 28, '优选后应为 28 项，实际: ' + cmds.length);
  // 高频块级语法置顶：标题1/2/3 → 无序/有序/任务列表
  const front = cmds.slice(0, 6).map((c) => c.action).join(',');
  assert.strictEqual(front, 'insert-h1,insert-h2,insert-h3,insert-ul,insert-ol,insert-task',
    '前 6 项应为高频标题与列表，实际: ' + front);
  // 深层标题沉底
  const tail = cmds.slice(-3).map((c) => c.action).join(',');
  assert.strictEqual(tail, 'insert-h4,insert-h5,insert-h6', '末尾应为 H4/H5/H6，实际: ' + tail);
}));

test('slash: 方向键导航（含循环）', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  ed.cm.setValue('');
  typeSlash(ed, 0, 0);
  const n = ed._slashFiltered.length;
  assert.ok(n > 2, '命令数应大于 2 以便测试导航');
  const start = ed._slashSel;
  ed._slashMove(1);
  assert.strictEqual(ed._slashSel, (start + 1) % n, '下移应 +1（循环）');
  ed._slashMove(-1);
  assert.strictEqual(ed._slashSel, start, '上移应回到原位');
  ed._slashMove(-1);
  assert.strictEqual(ed._slashSel, (start - 1 + n) % n, '从顶端上移应循环到底端');
}));

test('slash: 无匹配时关闭面板', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  ed.cm.setValue('');
  typeSlash(ed, 0, 0);
  ed._slashQuery = 'zzzznotexist';
  ed._renderSlashPanel();
  assert.strictEqual(ed._slashOpen, false, '无匹配应关闭面板');
  assert.ok(w.document.getElementById('slash-panel').classList.contains('hidden'), '面板应隐藏');
}));

test('slash: Enter 确认插入标题（行首）', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  ed.cm.setValue('');
  typeSlash(ed, 0, 0);
  ed._slashQuery = 'h1';
  ed._renderSlashPanel();
  ed._slashSel = 0; // insert-h1
  ed._slashConfirm();
  assert.strictEqual(ed._slashOpen, false, '确认后面板应关闭');
  // insert-h1 走 insertLinePrefix('# ')，行首 /h1 删除后空行追加 # 前缀
  assert.ok(ed.cm.getValue().startsWith('# '), '确认后应插入标题前缀，实际: ' + JSON.stringify(ed.cm.getValue()));
}));

test('slash: 全局 keydown 拦截 Enter 执行确认', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  ed.cm.setValue('');
  typeSlash(ed, 0, 0);
  ed._slashQuery = 'table';
  ed._renderSlashPanel();
  ed._slashSel = 0; // insert-table
  // 派发真实 keydown，验证全局捕获监听能拦截并确认
  const ev = new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
  w.document.dispatchEvent(ev);
  assert.strictEqual(ed._slashOpen, false, 'Enter 派发后面板应关闭');
  assert.ok(ed.cm.getValue().includes('|'), '应通过全局 Enter 插入表格模板');
}));

test('slash: 全局 keydown Esc 关闭面板', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  ed.cm.setValue('');
  typeSlash(ed, 0, 0);
  assert.strictEqual(ed._slashOpen, true);
  const ev = new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  w.document.dispatchEvent(ev);
  assert.strictEqual(ed._slashOpen, false, 'Esc 派发后面板应关闭');
}));

test('slash: 空格视为放弃，关闭面板', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  ed.cm.setValue('');
  typeSlash(ed, 0, 0); // 行首 /，光标 ch=1
  assert.strictEqual(ed._slashOpen, true);
  // 模拟在 / 后输入空格
  ed.cm.replaceRange(' ', { line: 0, ch: 1 });
  ed.cm.setCursor({ line: 0, ch: 2 });
  ed._updateSlashFromCursor();
  assert.strictEqual(ed._slashOpen, false, 'query 含空格应关闭面板');
}));

test('slash: 光标回退到 / 之前关闭面板', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  ed.cm.setValue('');
  typeSlash(ed, 0, 0);
  assert.strictEqual(ed._slashOpen, true);
  // 删除 /（光标回到 ch=0）
  ed.cm.replaceRange('', { line: 0, ch: 0 }, { line: 0, ch: 1 });
  ed.cm.setCursor({ line: 0, ch: 0 });
  ed._updateSlashFromCursor();
  assert.strictEqual(ed._slashOpen, false, '删除 / 后光标回退应关闭面板');
}));

// 真实路径：仅靠 replaceRange 经 cursorActivity 自动触发（不手动调 _maybeTriggerSlash），
// 验证此前 inputRead 不可靠导致的「输入 / 无反应」缺陷已修复。
test('slash: 真实路径 replaceRange 自动触发面板（不手动调用）', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  ed.cm.setValue('');
  // replaceRange 会触发 cursorActivity → _maybeTriggerSlash，无需手动调用
  ed.cm.replaceRange('/', { line: 0, ch: 0 });
  assert.strictEqual(ed._slashOpen, true, '输入框 / 经 cursorActivity 路径应自动打开面板');
  assert.strictEqual(w.document.getElementById('slash-panel').classList.contains('hidden'), false, '面板应可见');
}));

test('slash: 真实路径继续输入字母实时过滤', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  ed.cm.setValue('');
  ed.cm.replaceRange('/', { line: 0, ch: 0 }); // 自动打开面板
  assert.strictEqual(ed._slashOpen, true);
  // 继续输入 t a b → 经 cursorActivity 实时更新 query
  ed.cm.replaceRange('tab', { line: 0, ch: 1 });
  assert.strictEqual(ed._slashQuery, 'tab', '继续输入应实时更新 query');
  assert.strictEqual(ed._slashFiltered.length, 1, 'tab 应只匹配 表格(insert-table)');
  assert.strictEqual(ed._slashFiltered[0].action, 'insert-table');
}));

test('slash: 面板防溢出——光标贴近屏幕底部时翻转到光标上方（2026-10-13「最下面输入被挡住」）', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  ed.cm.setValue('');
  typeSlash(ed, 0, 0);
  const panel = w.document.getElementById('slash-panel');
  assert.ok(panel, '面板应存在');
  // jsdom 无布局：stub 光标坐标 + 面板尺寸（真实浏览器里是实测值）
  const VH = w.innerHeight || 768;
  const VW = w.innerWidth || 1024;
  const PH = 300, PW = 220;
  Object.defineProperty(panel, 'offsetHeight', { configurable: true, value: PH });
  Object.defineProperty(panel, 'offsetWidth', { configurable: true, value: PW });
  const origCoords = ed.cm.cursorCoords;
  const setCoords = (c) => { ed.cm.cursorCoords = () => c; };
  try {
    // ① 光标贴近底部（下方只剩 10px，放不下 300px 面板）→ 翻转到光标上方
    const bottomCoords = { left: 50, top: VH - 40, right: 50, bottom: VH - 10 };
    ed._closeSlashPanel();
    ed.cm.setValue('');
    setCoords(bottomCoords);
    typeSlash(ed, 0, 0);
    assert.strictEqual(ed._slashOpen, true, '应触发面板');
    const topUp = parseFloat(panel.style.top);
    assert.strictEqual(topUp, bottomCoords.top - 4 - PH, '下方放不下应翻转到光标上方');
    assert.ok(topUp + PH <= VH - 8, '翻转后面板必须完整落在视口内');
    // ② 光标在屏幕中部（下方放得下）→ 保持下方定位（不回归）
    const midCoords = { left: 50, top: 100, right: 50, bottom: 130 };
    ed._closeSlashPanel();
    ed.cm.setValue('');
    setCoords(midCoords);
    typeSlash(ed, 0, 0);
    assert.strictEqual(parseFloat(panel.style.top), midCoords.bottom + 4, '下方放得下时保持光标下方');
    // ③ 光标贴近右缘 → 左移面板防右溢出
    const rightCoords = { left: VW - 10, top: 100, right: VW - 10, bottom: 130 };
    ed._closeSlashPanel();
    ed.cm.setValue('');
    setCoords(rightCoords);
    typeSlash(ed, 0, 0);
    assert.ok(parseFloat(panel.style.left) + PW <= VW - 8, '贴近右缘应左移，面板不得超出屏幕右缘');
  } finally {
    ed.cm.cursorCoords = origCoords;
  }
}));
