// 文件树拖放移动（2026-10-21）：拖动文件/文件夹到目录上完成移动。
// 设计：dragstart 写「剪切」剪贴板（快照拖拽前的剪贴板/上下文），drop 复用
// fileTreePaste({source:'drag'}) 管线（目标解析/自身子目录守卫/(n) 后缀/movePath/tab 同步）。
// 断言重点：
//   - 取消拖拽（无 drop 直接 dragend）必须恢复拖拽前的剪贴板与上下文
//   - 非法目标（自身/子目录/拖回自身父目录）不发起 movePath，不产生「name (1)」副本
//   - 成功移动走 TauriApi.movePath、状态文案为「已移动」、打开中的 tab 同步新路径
//   - 树空白区 = 工作区根目录
//
// jsdom 无原生 DragEvent/DataTransfer：用普通 Event + 手动挂 dataTransfer 桩，
// 直接 dispatchEvent 触发 handler（与真实浏览器同一套监听器）。

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

// 构造带 dataTransfer 桩的拖拽事件（jsdom 无 DragEvent）
function dragEvent(w, type, dataTransfer) {
  const ev = new w.Event(type, { bubbles: true, cancelable: true });
  if (dataTransfer !== undefined) ev.dataTransfer = dataTransfer;
  return ev;
}
function dtStub() {
  return { effectAllowed: '', dropEffect: '', setData() {}, getData() { return ''; } };
}

// 建工作区 + mock listDir + 渲染真实文件树
async function setupTree(ed, w, listings) {
  w.TauriApi.listDir = async ({ path }) => (listings[path] || []);
  ed.expandedFolders = new Set(ed.expandedFolders || []);
  ed.workspaceFolder = '/root';
  await ed.renderFolderTree();
}
const rowOf = (w, path) => w.document.querySelector(`#folder-tree .tree-node[data-path="${path}"] > .tree-row`);

test('dnd: dragstart 写「剪切」剪贴板并挂 dragging 类；取消拖拽恢复拖拽前剪贴板', async () => {
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
    row.dispatchEvent(dragEvent(w, 'dragstart', dtStub()));
    assert.strictEqual(ed._fileClipboard.op, 'cut', 'dragstart 应写剪切剪贴板');
    assert.strictEqual(ed._fileClipboard.path, '/root/a.md');
    assert.ok(row.classList.contains('dragging'), '拖拽源行应挂 dragging 类');

    // 未 drop 直接 dragend（模拟 ESC 取消）
    row.dispatchEvent(dragEvent(w, 'dragend'));
    assert.strictEqual(ed._fileClipboard.op, 'copy', '取消拖拽应恢复拖拽前剪贴板');
    assert.strictEqual(ed._fileClipboard.path, '/root/keep.md');
    assert.ok(!row.classList.contains('dragging'), 'dragend 应摘掉 dragging 类');
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
    fileRow.dispatchEvent(dragEvent(w, 'dragstart', dtStub()));

    // 悬停目标文件夹：允许 drop + 高亮
    const hover = dragEvent(w, 'dragover', dtStub());
    dirRow.dispatchEvent(hover);
    assert.strictEqual(hover.dataTransfer.dropEffect, 'move', '合法目标 dropEffect 应为 move');
    assert.ok(dirRow.classList.contains('drop-target'), '合法目标应高亮');
    assert.strictEqual(hover.defaultPrevented, true, 'dragover 应 preventDefault（允许 drop）');

    dirRow.dispatchEvent(dragEvent(w, 'drop', dtStub()));
    await delay(80);
    assert.strictEqual(calls.length, 1, '应经 TauriApi.movePath 移动一次');
    assert.strictEqual(calls[0].from, '/root/a.md');
    assert.strictEqual(calls[0].to, '/root/docs/a.md');
    assert.ok(statuses.some(s => String(s).includes(ed.t('fileMoveDone'))), '状态应提示「已移动」');
    assert.strictEqual(ed._fileClipboard, null, '剪切粘贴成功后剪贴板应清空');
    assert.strictEqual(ed.tabs[0].filePath, '/root/docs/a.md', '打开中的 tab 应同步新路径');
    assert.strictEqual(toasts.length, 0, '成功路径不应有错误 toast');

    dirRow.dispatchEvent(dragEvent(w, 'dragend'));
    assert.strictEqual(ed._fileClipboard, null, '成功 drop 后 dragend 不应恢复旧剪贴板');
    assert.ok(!dirRow.classList.contains('drop-target'), 'dragend 应清掉目标高亮');
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
    projRow.dispatchEvent(dragEvent(w, 'dragstart', dtStub()));

    const hover = dragEvent(w, 'dragover', dtStub());
    subRow.dispatchEvent(hover);
    assert.strictEqual(hover.dataTransfer.dropEffect, 'none', '拖到自身子目录应为禁止态');
    assert.ok(subRow.classList.contains('drop-invalid'), '非法目标应挂 drop-invalid');

    subRow.dispatchEvent(dragEvent(w, 'drop', dtStub()));
    await delay(50);
    assert.strictEqual(calls.length, 0, '非法目标不应发起 movePath');
    projRow.dispatchEvent(dragEvent(w, 'dragend'));
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
    aRow.dispatchEvent(dragEvent(w, 'dragstart', dtStub()));
    const hover = dragEvent(w, 'dragover', dtStub());
    bRow.dispatchEvent(hover);
    assert.strictEqual(hover.dataTransfer.dropEffect, 'none', '拖回自身父目录应为禁止态');
    bRow.dispatchEvent(dragEvent(w, 'drop', dtStub()));
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
    docsRow.dispatchEvent(dragEvent(w, 'dragstart', dtStub()));
    const treeEl = w.document.getElementById('folder-tree');
    const hover = dragEvent(w, 'dragover', dtStub());
    treeEl.dispatchEvent(hover);
    assert.strictEqual(hover.dataTransfer.dropEffect, 'none', '拖回根目录（自身父目录）应为禁止态');
    treeEl.dispatchEvent(dragEvent(w, 'drop', dtStub()));
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
    xRow.dispatchEvent(dragEvent(w, 'dragstart', dtStub()));
    const hover = dragEvent(w, 'dragover', dtStub());
    treeEl.dispatchEvent(hover);
    assert.strictEqual(hover.dataTransfer.dropEffect, 'move', '子目录文件拖到根目录是合法移动');
    treeEl.dispatchEvent(dragEvent(w, 'drop', dtStub()));
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
    aRow.dispatchEvent(dragEvent(w, 'dragstart', dtStub()));
    dirRow.dispatchEvent(dragEvent(w, 'drop', dtStub()));
    await delay(80);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].to, '/root/docs/a (1).md', '同名冲突应加 (1) 后缀');
  } finally { cleanup(w); }
});
