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

test('应用设置会重渲染文件树，使开关即时生效', async () => {
  const { w, ed } = await makeEditor();
  try {
    let renders = 0;
    ed.renderFolderTree = async () => { renders++; };
    ed.workspaceFolder = '/root';
    ed.settings.showDotFolders = true;
    await ed.applyPendingSettings();
    assert.ok(renders >= 1);
  } finally { cleanup(w); }
});
