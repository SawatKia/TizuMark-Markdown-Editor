// 点击弹框外的遮罩关闭弹框：复用 × / 取消按钮；EULA 与跨文件搜索不参与
const { test } = require('node:test');
const assert = require('node:assert');
const { buildEnv, cleanup } = require('./helpers/app-env.cjs');

function press(w, el) {
  el.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
  el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
}

test('快捷键 / 自动保存 / 关于 弹框：点遮罩关闭', async () => {
  const { w } = await buildEnv();
  try {
    for (const id of ['shortcuts-dialog', 'autosave-dialog', 'about-dialog', 'file-search-dialog', 'slash-order-dialog']) {
      const ov = w.document.getElementById(id);
      ov.classList.remove('hidden');
      press(w, ov);
      assert.ok(ov.classList.contains('hidden'), id + ' 应被点击遮罩关闭');
    }
  } finally { cleanup(w); }
});

test('弹框内部点击 / 内部按下遮罩抬起：不关闭', async () => {
  const { w } = await buildEnv();
  try {
    const ov = w.document.getElementById('autosave-dialog');
    ov.classList.remove('hidden');
    press(w, ov.querySelector('.dialog'));
    assert.ok(!ov.classList.contains('hidden'), '点弹框内部不应关闭');
    ov.querySelector('.dialog').dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
    ov.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    assert.ok(!ov.classList.contains('hidden'), '内部按下、遮罩抬起不应关闭');
  } finally { cleanup(w); }
});

test('EULA 与跨文件搜索不参与遮罩关闭；确认类弹框点遮罩 = 取消', async () => {
  const { w } = await buildEnv();
  try {
    for (const id of ['eula-dialog', 'cross-search-dialog']) {
      const ov = w.document.getElementById(id);
      ov.classList.remove('hidden');
      press(w, ov);
      assert.ok(!ov.classList.contains('hidden'), id + ' 不应被遮罩关闭');
      ov.classList.add('hidden');
    }
    const cf = w.document.getElementById('confirm-dialog');
    let cancelled = false;
    w.document.getElementById('confirm-dialog-cancel').addEventListener('click', () => { cancelled = true; });
    cf.classList.remove('hidden');
    press(w, cf);
    assert.ok(cancelled, '确认弹框点遮罩应触发取消按钮');
  } finally { cleanup(w); }
});
