// 图片加载失败时：在图片旁显示尝试的路径与底层错误，并提供「复制给 AI」的上下文提示词按钮。
const test = require('node:test');
const assert = require('node:assert');
const { processImages } = require('../src/modules/image-processor.js');

test('读盘失败时在图片旁显示原因与尝试的路径', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<div id="p"><figure><img src="figures/a.png" alt="x"></figure></div>');
  const preview = dom.window.document.getElementById('p');
  await processImages(preview, {
    activeTab: { filePath: 'D:/notes/doc.md' },
    imageCache: new Map(),
    tauri: { fetchImageAsBase64: async () => { throw 'Cannot resolve path D:/notes/figures/a.png: os error 3'; } },
    getCachedImageURL: (u) => u,
    getRenderGeneration: () => 1,
  });
  const note = preview.querySelector('.img-load-error');
  assert.ok(note, '应插入错误说明');
  assert.ok(note.textContent.includes('D:/notes/figures/a.png'), note.textContent);
  assert.ok(note.textContent.includes('os error 3'), note.textContent);
});

test('错误说明带「复制」按钮，复制内容是带上下文、可直接发给 AI 的提示词', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<div id="p"><img src="figures/a.png" alt="图一"></div>');
  let copied = '';
  Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText: async (t) => { copied = t; } } });
  const preview = dom.window.document.getElementById('p');
  await processImages(preview, {
    activeTab: { filePath: 'D:/notes/doc.md' },
    imageCache: new Map(),
    tauri: { fetchImageAsBase64: async () => { throw 'os error 3'; } },
    getCachedImageURL: (u) => u,
    getRenderGeneration: () => 1,
  });
  const btn = preview.querySelector('.img-load-error-copy');
  assert.ok(btn, '应有复制按钮');
  btn.click();
  await new Promise((r) => setTimeout(r, 10));
  for (const part of ['D:/notes/doc.md', 'figures/a.png', 'D:/notes/figures/a.png', 'os error 3', '图一']) {
    assert.ok(copied.includes(part), '提示词应含 ' + part + ' | ' + copied);
  }
  assert.ok(!copied.includes('[加载失败]'), 'alt 应为原始值');
  assert.strictEqual(btn.textContent, '已复制 ✓');
});
