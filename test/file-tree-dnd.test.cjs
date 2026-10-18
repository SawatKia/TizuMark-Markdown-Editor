// 文件树拖放移动（2026-10-21 功能；2026-10-22 指针事件重构）：拖动文件/文件夹到目录上完成移动。
// 重构原因：Tauri v2 默认 dragDropEnabled=true，wry 在 WebView2 子窗口注册原生 IDropTarget，
// 对页面内部 HTML5 拖拽回 DROPEFFECT_NONE（OS 层拒绝 drop）→ 原生 DnD 在应用内不可用。
// 改用指针事件（与标签页拖拽 initTabDragEvents 同口径）：
//   mousedown 记起点 → mousemove 超 5px 阈值激活（写「剪切」剪贴板，快照拖拽前状态）
//   → elementFromPoint 解析落点（行高亮/光标表态）→ mouseup 复用
//   fileTreePaste({source:'drag'}) 管线（目标解析/自身子目录守卫/(n) 后缀/movePath/tab 同步）。
// 断言重点：
//   - 激活写「剪切」剪贴板、挂 dragging 类、生成拖拽影子；取消（ESC/放到无效处）恢复拖拽前剪贴板
//   - 非法目标（自身/子目录/拖回自身父目录）不发起 movePath，光标 not-allowed
//   - 成功移动走 TauriApi.movePath、状态文案「已移动」、打开中的 tab 同步新路径
//   - 树空白区 = 工作区根目录
//   - 未越阈的普通点击不启动拖拽；拖拽结束后的 click 被抑制一次
//
// jsdom 无真实命中测试：mock document.elementFromPoint（与 tab-drag.test.cjs 同款做法），
// 真实 MouseEvent 派发走与生产同一套监听器。

const test = require('node:test');
const assert = require('node:assert');
const { buildEnv, cleanup, delay } = require('./helpers/app-env.cjs');

async function makeEditor() {
  const { w } = await buildEnv({ captureInitErr: true });
  await delay(300);
  return { w, ed: w.editor };
}

function stubUi(ed, opts = {}) {
  ed.showPromptDialog = opts.prompt || (async () => null);
  ed.showConfirmDialog = opts.confirm || (async () => false);
  ed.showToast = opts.toast || (() => {});
  ed.setStatus = opts.status || (() => {});
  ed.updateTabBar = () => {};
  ed.saveSession = () => {};
}

function mouse(w, type, el, x, y, extra = {}) {
  el.dispatchEvent(new w.MouseEvent(type, Object.assign(
    { button: 0, clientX: x, clientY: y, bubbles: true, cancelable: true }, extra
  )));
}

// 完整拖拽：mousedown(起点) → mousemove(超阈激活+更新) → 返回已激活的会话状态
function dragTo(w, ed, sourceRow, targetEl, at = [60, 60]) {
  w.document.elementFromPoint = () => targetEl;
  mouse(w, 'mousedown', sourceRow, 10, 10);
  mouse(w, 'mousemove', w.document, at[0], at[1]);
  return at;
}

// 建工作区 + mock listDir + 渲染真实文件树
async function setupTree(ed, w, listings) {
  w.TauriApi.listDir = async ({ path }) => (listings[path] || []);
  ed.expandedFolders = new Set(ed.expandedFolders || []);
  ed.workspaceFolder = '/root';
  await ed.renderFolderTree();
}
const rowOf = (w, path) => w.document.querySelector(`#folder-tree .tree-node[data-path="${path}"] > .tree-row`);

test('dnd: 激活写「剪切」剪贴板并挂 dragging 类与影子；ESC 取消恢复拖拽前剪贴板', async () => {
  const { w, ed } = await makeEditor();
  try {
    stubUi(ed);
    await setupTree(ed, w, {
      '/root': [
        { name: 'a.md', path: '/root/a.md', is_dir: false },
      ],
    });
    // 用户拖拽前已复制过别的文件
    ed._fileClipboard = { op: 'copy', path: '/root/keep.md', isDir: false };
    ed._fileTreeCtx = { path: '/root/keep.md', isDir: false, nodeEl: null };

    const row = rowOf(w, '/root/a.md');
    assert.ok(row, 'a.md 行应渲染出来');
    dragTo(w, ed, row, row);
    assert.strictEqual(ed._fileClipboard.op, 'cut', '激活应写剪切剪贴板');
    assert.strictEqual(ed._fileClipboard.path, '/root/a.md');
    assert.ok(row.classList.contains('dragging'), '拖拽源行应挂 dragging 类');
    assert.ok(w.document.querySelector('.tree-drag-ghost'), '激活应生成拖拽影子');
    assert.strictEqual(w.document.body.style.cursor, 'not-allowed', '悬停源行（自身父目录）应为禁止光标');

    // ESC 取消
    w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    assert.strictEqual(ed._fileClipboard.op, 'copy', '取消拖拽应恢复拖拽前剪贴板');
    assert.strictEqual(ed._fileClipboard.path, '/root/keep.md');
    assert.ok(!row.classList.contains('dragging'), '取消应摘掉 dragging 类');
    assert.strictEqual(w.document.querySelector('.tree-drag-ghost'), null, '取消应移除影子');
    assert.strictEqual(w.document.body.style.cursor, '', '取消应还原光标');
    assert.strictEqual(ed._treeDragActive, false, '取消应清会话标志');
  } finally { cleanup(w); }
});

test('dnd: 文件拖到文件夹 → movePath(from,to=文件夹/文件名)，状态「已移动」，打开的 tab 同步', async () => {
  const { w, ed } = await makeEditor();
  try {
    const calls = [];
    const statuses = [];
    const toasts = [];
    stubUi(ed, { status: (m) => statuses.push(m), toast: (m) => toasts.push(m) });
    w.TauriApi.movePath = async (args) => { calls.push(args); };
    await setupTree(ed, w, {
      '/root': [
        { name: 'docs', path: '/root/docs', is_dir: true },
        { name: 'a.md', path: '/root/a.md', is_dir: false },
      ],
      '/root/docs': [],
    });
    ed.tabs = [{ filePath: '/root/a.md', name: 'a.md' }];

    const fileRow = rowOf(w, '/root/a.md');
    const dirRow = rowOf(w, '/root/docs');
    dragTo(w, ed, fileRow, dirRow);
    assert.ok(dirRow.classList.contains('drop-target'), '合法目标应高亮');
    assert.strictEqual(w.document.body.style.cursor, 'move', '合法目标应为 move 光标');

    mouse(w, 'mouseup', w.document, 60, 60);
    await delay(80);
    assert.strictEqual(calls.length, 1, '应经 TauriApi.movePath 移动一次');
    assert.strictEqual(calls[0].from, '/root/a.md');
    assert.strictEqual(calls[0].to, '/root/docs/a.md');
    assert.ok(statuses.some(s => String(s).includes(ed.t('fileMoveDone'))), '状态应提示「已移动」');
    assert.strictEqual(ed._fileClipboard, null, '剪切粘贴成功后剪贴板应清空');
    assert.strictEqual(ed.tabs[0].filePath, '/root/docs/a.md', '打开中的 tab 应同步新路径');
    assert.strictEqual(toasts.length, 0, '成功路径不应有错误 toast');
    assert.strictEqual(w.document.querySelector('.tree-drag-ghost'), null, '结束应移除影子');
    assert.strictEqual(w.document.body.style.cursor, '', '结束应还原光标');
    assert.ok(!dirRow.classList.contains('drop-target') || !dirRow.isConnected, '结束应清掉目标高亮');
    assert.strictEqual(ed._treeDragSuppressClick, true, '拖拽结束后应置 click 抑制');

    // 抑制生效：紧随的 click 被吞（用 docs 行：第一次 click 不应更新 _fileTreeCtx，
    // 第二次 click 恢复正常行为）。mock listDir 是静态列表，不反映移动结果，故不在此查 a.md 新位置。
    const docsRow2 = rowOf(w, '/root/docs');
    assert.ok(docsRow2, '重渲染后 docs 行仍在根目录');
    assert.strictEqual(ed._fileTreeCtx, null, '粘贴完成后上下文应已清空');
    docsRow2.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert.strictEqual(ed._fileTreeCtx, null, '拖拽后第一次 click 应被抑制（上下文不更新）');
    docsRow2.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
    assert.ok(ed._fileTreeCtx && ed._fileTreeCtx.path === '/root/docs', '第二次 click 恢复正常行为');
  } finally { cleanup(w); }
});

test('dnd: 文件夹拖到自身子目录 → 非法，不发起 movePath', async () => {
  const { w, ed } = await makeEditor();
  try {
    const calls = [];
    stubUi(ed);
    w.TauriApi.movePath = async (args) => { calls.push(args); };
    // 展开 proj 让 sub 行渲染出来
    ed.expandedFolders.add('/root/proj');
    await setupTree(ed, w, {
      '/root': [
        { name: 'proj', path: '/root/proj', is_dir: true },
      ],
      '/root/proj': [
        { name: 'sub', path: '/root/proj/sub', is_dir: true },
      ],
    });

    const projRow = rowOf(w, '/root/proj');
    const subRow = rowOf(w, '/root/proj/sub');
    assert.ok(projRow && subRow, 'proj 与其子目录 sub 应渲染出来');
    dragTo(w, ed, projRow, subRow);
    assert.ok(subRow.classList.contains('drop-invalid'), '非法目标应挂 drop-invalid');
    assert.strictEqual(w.document.body.style.cursor, 'not-allowed', '非法目标应为禁止光标');

    mouse(w, 'mouseup', w.document, 60, 60);
    await delay(50);
    assert.strictEqual(calls.length, 0, '非法目标不应发起 movePath');
    assert.strictEqual(ed._fileClipboard, null, '非法 drop 后恢复拖拽前剪贴板（原本为空）');
  } finally { cleanup(w); }
});

test('dnd: 文件拖回自身父目录（放到同级兄弟文件上）→ 无意义移动，不产生 name (1) 副本', async () => {
  const { w, ed } = await makeEditor();
  try {
    const calls = [];
    stubUi(ed);
    w.TauriApi.movePath = async (args) => { calls.push(args); };
    await setupTree(ed, w, {
      '/root': [
        { name: 'a.md', path: '/root/a.md', is_dir: false },
        { name: 'b.md', path: '/root/b.md', is_dir: false },
      ],
    });
    const aRow = rowOf(w, '/root/a.md');
    const bRow = rowOf(w, '/root/b.md');
    dragTo(w, ed, aRow, bRow);
    assert.ok(bRow.classList.contains('drop-invalid'), '拖回自身父目录应为禁止态');
    mouse(w, 'mouseup', w.document, 60, 60);
    await delay(50);
    assert.strictEqual(calls.length, 0, '无意义移动不应发起 movePath（避免误产生 a (1).md）');
  } finally { cleanup(w); }
});

test('dnd: 根目录文件夹拖到树空白区（= 自身父目录=根）→ 无意义移动，不复制', async () => {
  const { w, ed } = await makeEditor();
  try {
    const calls = [];
    stubUi(ed);
    w.TauriApi.movePath = async (args) => { calls.push(args); };
    await setupTree(ed, w, {
      '/root': [
        { name: 'docs', path: '/root/docs', is_dir: true },
      ],
      '/root/docs': [],
    });
    const docsRow = rowOf(w, '/root/docs');
    const treeEl = w.document.getElementById('folder-tree');
    dragTo(w, ed, docsRow, treeEl);
    assert.ok(treeEl.classList.contains('tree-drop-root'), '空白区落点应整块树区域描边');
    assert.strictEqual(w.document.body.style.cursor, 'not-allowed', '拖回根目录（自身父目录）应为禁止态');
    mouse(w, 'mouseup', w.document, 60, 60);
    await delay(50);
    assert.strictEqual(calls.length, 0, '不应发起 movePath（避免误产生 docs (1)）');
  } finally { cleanup(w); }
});

test('dnd: 子目录文件拖到树空白区 → 移动到工作区根目录', async () => {
  const { w, ed } = await makeEditor();
  try {
    const calls = [];
    stubUi(ed);
    w.TauriApi.movePath = async (args) => { calls.push(args); };
    // 展开 docs 让 x.md 行渲染出来
    ed.expandedFolders.add('/root/docs');
    await setupTree(ed, w, {
      '/root': [
        { name: 'docs', path: '/root/docs', is_dir: true },
      ],
      '/root/docs': [
        { name: 'x.md', path: '/root/docs/x.md', is_dir: false },
      ],
    });
    const xRow = rowOf(w, '/root/docs/x.md');
    const treeEl = w.document.getElementById('folder-tree');
    dragTo(w, ed, xRow, treeEl);
    assert.strictEqual(w.document.body.style.cursor, 'move', '子目录文件拖到根目录是合法移动');
    mouse(w, 'mouseup', w.document, 60, 60);
    await delay(80);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].from, '/root/docs/x.md');
    assert.strictEqual(calls[0].to, '/root/x.md', '应移动到工作区根目录');
  } finally { cleanup(w); }
});

test('dnd: 目标目录已有同名文件 → 复用粘贴管线的 (n) 后缀', async () => {
  const { w, ed } = await makeEditor();
  try {
    const calls = [];
    stubUi(ed);
    w.TauriApi.movePath = async (args) => { calls.push(args); };
    await setupTree(ed, w, {
      '/root': [
        { name: 'docs', path: '/root/docs', is_dir: true },
        { name: 'a.md', path: '/root/a.md', is_dir: false },
      ],
      '/root/docs': [
        { name: 'a.md', path: '/root/docs/a.md', is_dir: false },
      ],
    });
    const aRow = rowOf(w, '/root/a.md');
    const dirRow = rowOf(w, '/root/docs');
    dragTo(w, ed, aRow, dirRow);
    mouse(w, 'mouseup', w.document, 60, 60);
    await delay(80);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].to, '/root/docs/a (1).md', '同名冲突应加 (1) 后缀');
  } finally { cleanup(w); }
});

test('dnd: 未越阈的普通点击不启动拖拽；中键 mousedown 不启动拖拽', async () => {
  const { w, ed } = await makeEditor();
  try {
    stubUi(ed);
    await setupTree(ed, w, {
      '/root': [
        { name: 'a.md', path: '/root/a.md', is_dir: false },
        { name: 'docs', path: '/root/docs', is_dir: true },
      ],
      '/root/docs': [],
    });
    const row = rowOf(w, '/root/a.md');

    // 普通点击：mousedown + 微小移动 + mouseup（未越 5px 阈值）
    mouse(w, 'mousedown', row, 10, 10);
    mouse(w, 'mousemove', w.document, 12, 11);
    assert.ok(ed._treeDragState, 'mousedown 应记录待激活会话');
    assert.strictEqual(ed._treeDragState.active, false, '未越阈不应激活');
    mouse(w, 'mouseup', w.document, 12, 11);
    assert.strictEqual(ed._treeDragState, null, '纯点击后待激活状态应清空');
    assert.strictEqual(ed._fileClipboard, null, '纯点击不应写剪贴板');
    assert.strictEqual(w.document.querySelector('.tree-drag-ghost'), null, '纯点击不应有影子');

    // 中键 mousedown 不启动拖拽
    mouse(w, 'mousedown', row, 10, 10, { button: 1 });
    assert.strictEqual(ed._treeDragState, null, '中键不应启动拖拽');
  } finally { cleanup(w); }
});
