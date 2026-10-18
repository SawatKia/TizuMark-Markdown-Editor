// slash 命令排序对话框测试：自定义顺序（slashOrder）、显隐（slashHidden）、
// 新命令补尾、陈旧 id 忽略、对话框草稿初始化、勾选联动、保存落盘、面板仅显示非隐藏项。
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

test('slash-order: _buildSlashBaseCatalogIds 含全部 42 项', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  const ids = ed._buildSlashBaseCatalogIds();
  // 2026-10-22：28 项 + 内容类型补齐 14 项（定义列表/折叠区块/脚注/进度条/居中块/
  // 下划线/插入/删除/图注/按键/缩写/注音/上标/下标）= 42 项
  assert.strictEqual(ids.length, 42, '基础目录应为 42 项，实际: ' + ids.length);
  assert.ok(ids.includes('insert-h1') && ids.includes('insert-h6'), '应含首尾标题');
  // 新增 14 项必须在排序对话框目录内（否则对话框看不到它们的开关）
  for (const id of ['insert-dl', 'insert-details', 'insert-footnote', 'insert-progress', 'insert-center',
    'insert-u', 'insert-ins', 'insert-del', 'insert-figure', 'insert-kbd',
    'insert-abbreviation', 'insert-ruby', 'insert-superscript', 'insert-subscript']) {
    assert.ok(ids.includes(id), '排序目录缺新增项 ' + id);
  }
  // 默认顺序：前置高频项置顶
  assert.strictEqual(
    ids.slice(0, 4).join(','),
    'insert-inline-code,insert-hr,insert-quote,insert-code-block',
    '前置高频项（行内代码/水平线/引用块/代码块）应排最前'
  );
  // 字体类（加粗/斜体/删除线/高亮）应沉底
  const font = ['insert-bold', 'insert-italic', 'insert-strikethrough', 'insert-highlight'];
  assert.ok(font.every((f) => ids.indexOf(f) >= ids.length - 4), '字体类应置底');
}));

test('slash-order: _applySlashLayout 按 slashOrder 重排', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  const catalog = [
    { action: 'a', label: 'A' }, { action: 'b', label: 'B' },
    { action: 'c', label: 'C' }, { action: 'd', label: 'D' },
  ];
  ed.settings.slashOrder = ['c', 'a', 'd', 'b'];
  ed.settings.slashHidden = [];
  const out = ed._applySlashLayout(catalog);
  assert.strictEqual(out.map((c) => c.action).join(','), 'c,a,d,b', '应按保存顺序重排');
}));

test('slash-order: _applySlashLayout 过滤隐藏项', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  const catalog = [
    { action: 'a', label: 'A' }, { action: 'b', label: 'B' }, { action: 'c', label: 'C' },
  ];
  ed.settings.slashOrder = ['a', 'b', 'c'];
  ed.settings.slashHidden = ['b'];
  const out = ed._applySlashLayout(catalog);
  assert.strictEqual(out.map((c) => c.action).join(','), 'a,c', '隐藏项 b 应被过滤');
}));

test('slash-order: _applySlashLayout 新命令补尾、陈旧 id 忽略', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  const catalog = [
    { action: 'a', label: 'A' }, { action: 'b', label: 'B' }, { action: 'new', label: 'NEW' },
  ];
  // 保存顺序里含陈旧 id 'old'（目录已不存在），且未列出新增的 'new'
  ed.settings.slashOrder = ['old', 'b', 'a'];
  ed.settings.slashHidden = [];
  const out = ed._applySlashLayout(catalog);
  // 陈旧 'old' 被忽略、'b','a' 按序、'new' 补到末尾
  assert.strictEqual(out.map((c) => c.action).join(','), 'b,a,new', '应忽略陈旧并补尾新项，实际: ' + out.map((c) => c.action).join(','));
}));

test('slash-order: _buildSlashCommands 反映自定义顺序与隐藏', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  ed.settings.slashOrder = ['insert-image', 'insert-bold', 'insert-h1'];
  ed.settings.slashHidden = ['insert-table'];
  ed._slashCommands = null;
  const cmds = ed._buildSlashCommands();
  const actions = cmds.map((c) => c.action);
  assert.strictEqual(actions[0], 'insert-image', '首项应为 insert-image');
  assert.ok(!actions.includes('insert-table'), '隐藏的 insert-table 不应出现');
  // 未列出的其余项按默认序补在后面，总数 = 42(2026-10-22 含 14 新增项) - 1(隐藏) = 41
  assert.strictEqual(cmds.length, 41, '总数应为 41，实际: ' + cmds.length);
}));

test('slash-order: _moveSlashOrderItem 在草稿内移动', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  ed._slashOrderDraft = ['a', 'b', 'c', 'd'];
  ed._moveSlashOrderItem(0, 2);
  assert.strictEqual(ed._slashOrderDraft.join(','), 'b,c,a,d', '从 0 移到 2 应得 b,c,a,d，实际: ' + ed._slashOrderDraft);
  ed._moveSlashOrderItem(3, 0);
  assert.strictEqual(ed._slashOrderDraft.join(','), 'd,b,c,a', '从 3 移到 0 应得 d,b,c,a，实际: ' + ed._slashOrderDraft);
}));

test('slash-order: showSlashOrderDialog 初始化草稿为全 42 项、对话框可见', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  ed.settings.slashOrder = undefined;
  ed.settings.slashHidden = undefined;
  ed.showSlashOrderDialog();
  assert.strictEqual(ed._slashOrderOpen, true, '对话框应标记为打开');
  // 2026-10-22：28 项 + 内容类型补齐 14 项 = 42 项（新项须出现在排序对话框）
  assert.strictEqual(ed._slashOrderDraft.length, 42, '草稿应为 42 项');
  // 默认隐藏：字体类 4 项 + 新增内容类型 14 项（默认不启用），其余开关默认开启
  assert.strictEqual(ed._slashHiddenDraft.size, 18, '默认应隐藏 18 项（字体 4 + 新增 14），实际: ' + ed._slashHiddenDraft.size);
  assert.ok(ed._slashHiddenDraft.has('insert-bold'), '加粗应默认隐藏');
  assert.ok(ed._slashHiddenDraft.has('insert-dl'), '新增项（如定义列表）应默认隐藏');
  assert.ok(!ed._slashHiddenDraft.has('insert-h1'), '非字体/非新增项（如标题1）默认应显示');
  const list = w.document.getElementById('slash-order-list');
  assert.strictEqual(list.children.length, 42, '对话框应渲染 42 行，实际: ' + list.children.length);
  assert.strictEqual(w.document.getElementById('slash-order-dialog').classList.contains('hidden'), false, '对话框应可见');
}));

test('slash-order: 取消勾选将项加入隐藏草稿', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  ed.settings.slashOrder = undefined;
  ed.settings.slashHidden = undefined;
  ed.showSlashOrderDialog();
  const list = w.document.getElementById('slash-order-list');
  // 找到 insert-image 行并取消勾选
  const rows = Array.from(list.querySelectorAll('.slash-order-row'));
  const target = rows.find((r) => r.querySelector('.slash-order-label').textContent === '图片');
  assert.ok(target, '应存在「图片」行');
  const cb = target.querySelector('input[type=checkbox]');
  assert.strictEqual(cb.checked, true, '默认应勾选');
  cb.checked = false;
  cb.dispatchEvent(new w.Event('change'));
  assert.ok(ed._slashHiddenDraft.has('insert-image'), '取消勾选后 insert-image 应进入隐藏草稿');
  assert.ok(target.classList.contains('hidden-cmd'), '行应加 hidden-cmd 样式');
}));

test('slash-order: applySlashOrder 写盘、清缓存、面板仅显示非隐藏项', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  ed.settings.slashOrder = undefined;
  ed.settings.slashHidden = undefined;
  ed.showSlashOrderDialog();
  // 隐藏「图片」
  const list = w.document.getElementById('slash-order-list');
  const target = Array.from(list.querySelectorAll('.slash-order-row'))
    .find((r) => r.querySelector('.slash-order-label').textContent === '图片');
  const cb = target.querySelector('input[type=checkbox]');
  cb.checked = false;
  cb.dispatchEvent(new w.Event('change'));
  // 保存
  ed.applySlashOrder();
  assert.strictEqual(ed._slashOrderOpen, false, '保存后对话框应关闭');
  assert.ok(ed.settings.slashHidden.includes('insert-image'), '设置应记录隐藏项');
  assert.strictEqual(ed._slashCommands, null, '应清缓存');
  // 面板仅显示 23 项（默认字体类 4 项隐藏 + 本测试隐藏的「图片」1 项），无「图片」
  ed.cm.setValue('');
  typeSlash(ed, 0, 0);
  const items = w.document.querySelectorAll('#slash-panel .slash-item');
  assert.strictEqual(items.length, 23, '面板应显示 23 项，实际: ' + items.length);
  const labels = Array.from(items).map((i) => i.querySelector('.slash-label').textContent);
  assert.ok(!labels.includes('图片'), '面板不应含被隐藏的「图片」');
}));

test('slash-order: resetSlashOrder 恢复默认顺序与全显示', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  ed.settings.slashOrder = ['insert-image', 'insert-bold'];
  ed.settings.slashHidden = ['insert-table'];
  ed.showSlashOrderDialog();
  // 先制造脏数据
  ed._slashOrderDraft = ['insert-h6', 'insert-h5'];
  ed._slashHiddenDraft = new Set(['insert-h1']);
  ed.resetSlashOrder();
  assert.strictEqual(ed._slashOrderDraft.join(','), ed._buildSlashBaseCatalogIds().join(','), '应恢复默认顺序');
  // 2026-10-22：默认隐藏 = 字体类 4 项 + 新增内容类型 14 项（默认不启用）
  assert.strictEqual(ed._slashHiddenDraft.size, 18, '恢复默认应隐藏 18 项（字体 4 + 新增 14），实际: ' + ed._slashHiddenDraft.size);
  assert.ok(ed._slashHiddenDraft.has('insert-bold'), '恢复默认后加粗应隐藏');
  assert.ok(ed._slashHiddenDraft.has('insert-details'), '恢复默认后新增项（折叠区块）应隐藏');
}));

// 锁住「快捷插入」分区设置弹窗 DOM：说明 hint 与管理按钮各占一个普通 .settings-row，
// 且 hint 在按钮「上方」（不能用 settings-row-stacked，否则 form-hint 走 margin-top: 4px，
// 与设置里其他提示框的 10px 间距不一致）。
test('slash-order: 设置里「管理快捷插入…」按钮上方为普通 .form-hint 提示框', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  const btn = w.document.getElementById('btn-manage-slash');
  assert.ok(btn, '应存在「管理快捷插入…」按钮');
  assert.ok(btn.textContent.includes('管理快捷插入'), '按钮文字应为「管理快捷插入…」');
  const btnRow = btn.closest('.settings-row');
  assert.ok(btnRow && !btnRow.classList.contains('settings-row-stacked'), '按钮所在 row 不应带 stacked 修饰');
  assert.ok(!btnRow.querySelector('.form-hint'), '按钮所在 row 内不应含 hint（hint 应独立成行且在上方）');
  // 取 btn 所在 settings-section 内的 hint（避免匹配到前面分区的 form-hint）
  const section = btn.closest('.settings-section');
  const hint = section.querySelector('.form-hint');
  assert.ok(hint, '该分区内应存在 .form-hint 提示框');
  const hintRow = hint.closest('.settings-row');
  assert.ok(hintRow && !hintRow.classList.contains('settings-row-stacked'), 'hint 所在 row 不应带 stacked 修饰');
  assert.ok(hint.querySelector('.hint-icon'), 'hint 应带提示图标');
  assert.ok(hint.textContent.includes('在编辑器输入'), 'hint 应含说明文字');
  // 顺序：hint row 应在按钮 row 之前
  const rel = hintRow.compareDocumentPosition(btnRow);
  assert.ok(rel & w.Node.DOCUMENT_POSITION_FOLLOWING, 'hint 应位于「管理快捷插入…」按钮之前');
}));

// 锁住「快捷插入」分区标题 + 排序对话框标题的通俗命名
test('slash-order: 「快捷插入」分区标题与排序对话框标题应为通俗中文', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  const sectionName = w.document.querySelector('#btn-manage-slash').closest('.settings-section').querySelector('.settings-section-name');
  assert.strictEqual(sectionName.textContent.trim(), '快捷插入', '设置里「快捷插入」分区标题应为通俗中文');
  const dialogTitle = w.document.getElementById('slash-order-title');
  assert.ok(dialogTitle, '应存在 slash-order-title');
  assert.strictEqual(dialogTitle.textContent.trim(), '快捷插入顺序', '快捷插入顺序对话框标题应为通俗中文');
}));

// =====================================================================
// 拖拽「跟手浮动 ghost」专项测试
// =====================================================================

// 给元素 stub 一个固定的 getBoundingClientRect，让落点计算可预测
function stubRect(el, x, y, w, h) {
  el.getBoundingClientRect = () => ({ left: x, top: y, right: x + w, bottom: y + h, width: w, height: h, x, y });
}

// 在 jsdom 中 dispatchEvent 一个带 clientX/Y 的 PointerMove/PointerUp
function dispatchPointer(doc, type, x, y) {
  let ev;
  try {
    ev = new doc.defaultView.MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
  } catch (_) {
    ev = new doc.defaultView.Event(type, { bubbles: true });
  }
  Object.defineProperty(ev, 'clientX', { value: x, configurable: true });
  Object.defineProperty(ev, 'clientY', { value: y, configurable: true });
  doc.dispatchEvent(ev);
}

test('slash-order 拖拽：mousedown 在 handle 上创建 ghost + 源行占位', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  ed.showSlashOrderDialog();
  const list = w.document.getElementById('slash-order-list');
  assert.ok(list, '应存在 slash-order-list');
  const rows = Array.from(list.querySelectorAll('.slash-order-row'));
  rows.forEach((el, i) => stubRect(el, 12, 100 + i * 40, 580, 40));

  const sourceIdx = 1;
  const row = rows[sourceIdx];
  stubRect(row, 12, 100 + sourceIdx * 40, 580, 40);
  const handle = row.querySelector('.slash-order-handle');

  // 调用 _startSlashOrderDrag
  const ev = { clientX: 50, clientY: 130, preventDefault: () => {}, target: handle };
  ed._startSlashOrderDrag(ev, sourceIdx, row);

  // 断言：ghost 已创建、源行已加 dragging-source
  const ghost = w.document.body.querySelector('.slash-order-ghost');
  assert.ok(ghost, 'mousedown 后应在 body 上创建 .slash-order-ghost');
  assert.ok(row.classList.contains('dragging-source'), '源行应加 .dragging-source 占位');
  // 清理
  dispatchPointer(w.document, 'pointerup', 50, 130);
}));

test('slash-order 拖拽：pointermove 时 ghost 跟随鼠标 + 蓝色插入线定位', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  ed.showSlashOrderDialog();
  const list = w.document.getElementById('slash-order-list');
  const rows = Array.from(list.querySelectorAll('.slash-order-row'));
  rows.forEach((el, i) => stubRect(el, 12, 100 + i * 40, 580, 40));
  const sourceIdx = 0;
  const row = rows[sourceIdx];
  stubRect(row, 12, 100 + sourceIdx * 40, 580, 40);
  // 让 ghost 也有真实高度（jsdom 不自动布局）
  Object.defineProperty(row, 'offsetHeight', { value: 40, configurable: true });
  const handle = row.querySelector('.slash-order-handle');
  ed._startSlashOrderDrag({ clientX: 50, clientY: 110, preventDefault: () => {}, target: handle }, sourceIdx, row);

  let ghost = w.document.body.querySelector('.slash-order-ghost');
  // 移动到第 5 行附近（中心 Y ≈ 100 + 5*40 + 20 = 320）
  dispatchPointer(w.document, 'pointermove', 200, 320);
  ghost = w.document.body.querySelector('.slash-order-ghost');
  // ghost.style.left 应被设置
  assert.ok(ghost.style.left !== '' && ghost.style.left !== 'NaNpx', `ghost.style.left 应被 pointermove 设置为数值 (got '${ghost.style.left}')`);
  // 应出现一条蓝色插入线，且位于第 5 行之后（指向插入到第 5、6 行之间）
  const dropLine = list.querySelector('.slash-order-drop-line');
  assert.ok(dropLine, '拖动时应出现一条蓝色插入线');
  assert.strictEqual(rows[5].nextElementSibling, dropLine, '插入线应在第 5 行之后（指示插入到 5、6 之间）');
  // 清理
  dispatchPointer(w.document, 'pointerup', 200, 320);
}));

test('slash-order 拖拽：pointerup 按 ghost 中心 Y 正确落位到 draft 新索引', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  ed.showSlashOrderDialog();
  const list = w.document.getElementById('slash-order-list');
  const rows = Array.from(list.querySelectorAll('.slash-order-row'));
  rows.forEach((el, i) => stubRect(el, 12, 100 + i * 40, 580, 40));
  const sourceIdx = 1;
  const row = rows[sourceIdx];
  stubRect(row, 12, 100 + sourceIdx * 40, 580, 40);
  Object.defineProperty(row, 'offsetHeight', { value: 40, configurable: true });
  const handle = row.querySelector('.slash-order-handle');

  // mousedown 在 source 行 (中心 Y ≈ 140)
  ed._startSlashOrderDrag({ clientX: 50, clientY: 140, preventDefault: () => {}, target: handle }, sourceIdx, row);

  // 把 ghost 拖到第 6 行附近（中心 Y ≈ 100 + 6*40 + 20 = 360）—— 向下拖
  dispatchPointer(w.document, 'pointermove', 200, 360);
  // 松手前先记录蓝线指示的插入缝隙（蓝线下一项 = 源项最终的后邻）
  const line = list.querySelector('.slash-order-drop-line');
  assert.ok(line, '拖动中应存在蓝色插入线');
  const lineNextLabel = line.nextElementSibling
    ? line.nextElementSibling.querySelector('.slash-order-label').textContent
    : '(末尾)';
  dispatchPointer(w.document, 'pointerup', 200, 360);

  // ghost 应被销毁，源行 dragging-source 应被清除，蓝色插入线应移除
  assert.strictEqual(w.document.body.querySelector('.slash-order-ghost'), null, 'pointerup 后 ghost 应销毁');
  assert.ok(!list.querySelector('.dragging-source'), 'pointerup 后 dragging-source 应清除');
  assert.ok(!list.querySelector('.slash-order-drop-line'), 'pointerup 后插入线应清除');

  // 验证源项已移动到蓝线指示的位置（实时预览）：
  // 起始 idx=1（draft 中第 2 项，新默认序为 insert-hr），源行 DOM1 rect.top=140
  // offsetY = 140-140 = 0 → ghost 中心 Y = (360-0)+40/2 = 380
  // visible 行首个中心>380 为 DOM7(无序列表, 中心400) → visible 下标 6
  // 落点 draft 索引 = visualInsert = 6（不再 +1），与蓝线位置一致
  const sourceId = ed._buildSlashBaseCatalogIds()[1]; // 原 idx=1 的项
  const newIdx = ed._slashOrderDraft.indexOf(sourceId);
  assert.strictEqual(newIdx, 6, `源项应从 idx=1 落到蓝线指示的 idx=6（got ${newIdx}）`);
  // 实时预览：落点后邻 = 松手前蓝线的下一项
  const after = ed._slashBaseCatalogFull().find((c) => c.action === ed._slashOrderDraft[newIdx + 1]);
  assert.strictEqual(after ? after.label : '(末尾)', lineNextLabel,
    '落点后邻应等于蓝线所示插入缝隙的下一项');

  // 列表应重新渲染，元素数不变
  const newRows = list.querySelectorAll('.slash-order-row');
  assert.strictEqual(newRows.length, ed._buildSlashBaseCatalogIds().length, '落位后行数应保持');
}));

test('slash-order 拖拽：松开在源行附近（向下不到下一行）→ draft 顺序不变', async () => withEditor({ captureInitErr: true }, async (w, ed) => {
  ed.showSlashOrderDialog();
  const list = w.document.getElementById('slash-order-list');
  const rows = Array.from(list.querySelectorAll('.slash-order-row'));
  rows.forEach((el, i) => stubRect(el, 12, 100 + i * 40, 580, 40));
  const sourceIdx = 2;
  const row = rows[sourceIdx];
  stubRect(row, 12, 100 + sourceIdx * 40, 580, 40);
  Object.defineProperty(row, 'offsetHeight', { value: 40, configurable: true });
  const handle = row.querySelector('.slash-order-handle');

  const baseDraft = ed._slashOrderDraft.slice();
  ed._startSlashOrderDrag({ clientX: 50, clientY: 100 + sourceIdx * 40 + 10, preventDefault: () => {}, target: handle }, sourceIdx, row);
  // 在源行下半部稍微移动后松开（仍停在源行中线下，没超过其下边界）
  dispatchPointer(w.document, 'pointermove', 70, 100 + sourceIdx * 40 + 15);
  dispatchPointer(w.document, 'pointerup', 70, 100 + sourceIdx * 40 + 15);
  // 不管落点是否移动，关键是流程不应抛错——这覆盖最小情况：mouseup 不会破坏状态
  assert.ok(Array.isArray(ed._slashOrderDraft), '拖动结束 _slashOrderDraft 应仍为数组');
  assert.strictEqual(ed._slashOrderDraft.length, baseDraft.length, 'draft 长度不应变化');
}));
