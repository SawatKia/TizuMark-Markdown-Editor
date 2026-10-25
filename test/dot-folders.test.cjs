// 设置「显示以 . 开头的文件夹」：默认关；开启后 listDir 带 includeDotDirs；应用设置后文件树重列目录
const { test } = require('node:test');
const assert = require('node:assert');
const { buildEnv, cleanup, delay } = require('./helpers/app-env.cjs');

async function makeEditor() {
  const { w } = await buildEnv();
  await delay(300);
  return { w, ed: w.editor };
}

test('默认关闭；设置控件与状态同步、变更写入设置', async () => {
  const { w, ed } = await makeEditor();
  try {
    assert.strictEqual(ed.defaultSettings().showDotFolders, false);
    const cb = w.document.getElementById('set-show-dot-folders');
    assert.ok(cb && cb.checked === false);
    cb.checked = true;
    cb.dispatchEvent(new w.Event('change'));
    assert.strictEqual(ed.settings.showDotFolders, true);
  } finally { cleanup(w); }
});

test('文件树列目录时按设置传 includeDotDirs', async () => {
  const { w, ed } = await makeEditor();
  try {
    const calls = [];
    w.TauriApi.listDir = async (args) => { calls.push(args); return [{ name: '.notes', path: '/root/.notes', is_dir: true, mtime: 1, size: 0 }]; };
    ed.workspaceFolder = '/root';
    ed.settings.showDotFolders = false;
    await ed.renderFolderTree();
    assert.strictEqual(calls[0].includeDotDirs, false);
    ed.settings.showDotFolders = true;
    await ed.renderFolderTree();
    assert.strictEqual(calls[calls.length - 1].includeDotDirs, true);
    assert.ok([...w.document.querySelectorAll('#folder-tree')].some(el => el.textContent.includes('.notes')));
  } finally { cleanup(w); }
});

test('刷新按钮：点击重新列目录并显示新内容，期间转圈、完成后恢复', async () => {
  const { w, ed } = await makeEditor();
  try {
    let entries = [{ name: 'a.md', path: '/root/a.md', is_dir: false, mtime: 1, size: 1 }];
    let calls = 0;
    w.TauriApi.listDir = async () => { calls++; return entries; };
    ed.workspaceFolder = '/root';
    await ed.renderFolderTree();
    const btn = w.document.getElementById('btn-refresh-folders');
    assert.ok(btn, '应有刷新按钮');
    const before = calls;
    entries = entries.concat([{ name: 'b.md', path: '/root/b.md', is_dir: false, mtime: 2, size: 1 }]);
    btn.dispatchEvent(new w.Event('click'));
    assert.ok(btn.classList.contains('is-refreshing'), '刷新中应转圈');
    await delay(50);
    assert.ok(calls > before);
    assert.ok(!btn.classList.contains('is-refreshing'));
    assert.ok(w.document.getElementById('folder-tree').textContent.includes('b.md'));
  } finally { cleanup(w); }
});

test('并发渲染串行化：不会重复追加节点，且最终反映最新状态', async () => {
  const { w, ed } = await makeEditor();
  try {
    let entries = [{ name: 'a.md', path: '/root/a.md', is_dir: false, mtime: 1, size: 1 }];
    w.TauriApi.listDir = async () => { await delay(20); return entries; };
    ed.workspaceFolder = '/root';
    const p1 = ed.renderFolderTree();
    entries = [{ name: 'z.md', path: '/root/z.md', is_dir: false, mtime: 1, size: 1 }];
    const p2 = ed.renderFolderTree();
    await Promise.all([p1, p2]);
    const rows = w.document.querySelectorAll('#folder-tree .tree-node');
    assert.strictEqual(rows.length, 1);
    assert.ok(rows[0].textContent.includes('z.md'));
  } finally { cleanup(w); }
});

test('应用设置后文件树按新的 showDotFolders 重新列目录', async () => {
  const { w, ed } = await makeEditor();
  try {
    const seen = [];
    w.TauriApi.listDir = async (a) => { seen.push(a.includeDotDirs); return a.includeDotDirs ? [{ name: '.notes', path: '/root/.notes', is_dir: true, mtime: 1, size: 0 }] : []; };
    ed.workspaceFolder = '/root';
    await ed.renderFolderTree();
    assert.ok(!w.document.getElementById('folder-tree').textContent.includes('.notes'));
    ed.settings.showDotFolders = true;
    await ed.applyPendingSettings();
    assert.ok(w.document.getElementById('folder-tree').textContent.includes('.notes'), '保存/应用后立即出现点开头文件夹');
    assert.strictEqual(seen[seen.length - 1], true);
  } finally { cleanup(w); }
});
