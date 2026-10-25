// 自动保存恢复前预览：列表 ↔ 预览面板切换、内容以纯文本呈现、从预览触发恢复
const { test } = require('node:test');
const assert = require('node:assert');
const { buildEnv, cleanup } = require('./helpers/app-env.cjs');

const delay = (ms) => new Promise(r => setTimeout(r, ms));
const entry = { name: 'tabc__1.json', path: 'C:\d\tabc__1.json', mtime: 1700000000000 };
const info = { name: 'a.md', content: '# T\n<script>alert(1)</script>\nline3', savedAt: 1700000000000 };

test('预览：显示内容（纯文本、不执行 HTML），可返回列表', async () => {
  const { w } = await buildEnv();
  await delay(300);
  try {
    const ed = w.editor;
    const d = w.document;
    ed.showAutosavePreview(entry, info);
    assert.ok(d.getElementById('autosave-list').classList.contains('hidden'));
    assert.ok(!d.getElementById('autosave-preview-pane').classList.contains('hidden'));
    const pre = d.getElementById('autosave-preview-text');
    assert.strictEqual(pre.textContent, info.content);
    assert.strictEqual(pre.querySelector('script'), null);
    assert.match(d.getElementById('autosave-preview-meta').textContent, /3/);
    d.getElementById('autosave-preview-back').dispatchEvent(new w.Event('click'));
    assert.ok(!d.getElementById('autosave-list').classList.contains('hidden'));
    assert.ok(d.getElementById('autosave-preview-pane').classList.contains('hidden'));
  } finally { cleanup(w); }
});

test('预览面板的「恢复到…」调用 recoverAutosave；关闭弹框会重置回列表视图', async () => {
  const { w } = await buildEnv();
  await delay(300);
  try {
    const ed = w.editor;
    const d = w.document;
    let got = null;
    ed.recoverAutosave = (i, e) => { got = { i, e }; };
    ed.showAutosavePreview(entry, info);
    d.getElementById('autosave-preview-recover').dispatchEvent(new w.Event('click'));
    assert.strictEqual(got.i, info);
    assert.strictEqual(got.e, entry);
    ed.hideAutosaveDialog();
    assert.ok(!d.getElementById('autosave-list').classList.contains('hidden'), '关闭后下次打开应是列表');
  } finally { cleanup(w); }
});
