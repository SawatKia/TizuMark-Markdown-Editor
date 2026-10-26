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
  assert.strictEqual(btn.textContent, 'Copied ✓');
});

test('文案走注入的 t()；复制给 AI 的提示词始终是英文', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<div id="p"><img src="a.png" alt="x"></div>');
  let copied = '';
  Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText: async (t) => { copied = t; } } });
  const preview = dom.window.document.getElementById('p');
  const zh = { imgErrTitle: '图片未显示', imgErrPath: '路径', imgErrReason: '原因', imgErrCopy: '复制错误信息', imgErrCopied: '已复制 ✓', imageLoadFailed: '[图片加载失败]' };
  await processImages(preview, {
    activeTab: { filePath: 'D:/n/d.md' },
    imageCache: new Map(),
    tauri: { fetchImageAsBase64: async () => { throw 'boom'; } },
    getCachedImageURL: (u) => u,
    getRenderGeneration: () => 1,
    t: (k) => zh[k] || k,
  });
  const note = preview.querySelector('.img-load-error');
  assert.ok(note.textContent.includes('图片未显示') && note.textContent.includes('路径: ') && note.textContent.includes('原因: boom'), note.textContent);
  const btn = preview.querySelector('.img-load-error-copy');
  assert.strictEqual(btn.textContent, '复制错误信息');
  btn.click();
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(btn.textContent, '已复制 ✓');
  assert.ok(copied.startsWith('I am using the TizuMark Markdown editor'), copied);
  assert.ok(!/[\u4e00-\u9fff]/.test(copied.replace('D:/n/d.md', '')), '提示词不应含中文: ' + copied);
});

test('未注入 t 时退回英文默认文案', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<div id="p"><img src="a.png"></div>');
  const preview = dom.window.document.getElementById('p');
  await processImages(preview, {
    activeTab: null, imageCache: new Map(), tauri: {}, getCachedImageURL: (u) => u, getRenderGeneration: () => 1,
  });
  const txt = preview.querySelector('.img-load-error').textContent; assert.ok(txt.startsWith('Image not displayed'), txt);
});

test('复制的提示词包含错误信息、逐步 trace、堆栈与图片 HTML', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<div id="p"><img src="figures/a.png" alt="图"></div>');
  let copied = '';
  Object.defineProperty(dom.window.navigator, 'clipboard', { value: { writeText: async (t) => { copied = t; } } });
  const preview = dom.window.document.getElementById('p');
  await processImages(preview, {
    activeTab: { filePath: 'D:/n/d.md' },
    imageCache: new Map(),
    tauri: { fetchImageAsBase64: async () => { throw new Error('os error 3'); } },
    getCachedImageURL: (u) => u,
    getRenderGeneration: () => 1,
  });
  preview.querySelector('.img-load-error-copy').click();
  await new Promise((r) => setTimeout(r, 10));
  for (const part of ['## Error message', 'os error 3', '## Trace', 'fetch_image_as_base64(D:/n/figures/a.png)', 'FAILED: os error 3', '## Stack trace', 'at ', '<img src="figures/a.png"', '## Environment']) {
    assert.ok(copied.includes(part), '应含 ' + part + ' | ' + copied);
  }
});

test('相对路径在文档目录找不到时，向上在祖先目录查找（manuscript/ → 书籍根 figures/）', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<div id="p"><img src="figures/a.png" alt="x"></div>');
  const preview = dom.window.document.getElementById('p');
  const asked = [];
  await processImages(preview, {
    activeTab: { filePath: 'D:/book/manuscript/ch3.md' },
    imageCache: new Map(),
    tauri: {
      fetchImageAsBase64: async ({ url }) => {
        asked.push(url);
        if (url === 'D:/book/figures/a.png') return 'QUJD';
        throw new Error('os error 3');
      },
    },
    getCachedImageURL: (u) => u,
    getRenderGeneration: () => 1,
  });
  assert.deepStrictEqual(asked, ['D:/book/manuscript/figures/a.png', 'D:/book/figures/a.png']);
  const img = preview.querySelector('img');
  assert.ok(img.src.startsWith('data:image/png;base64,'), img.src);
  assert.strictEqual(preview.querySelector('.img-load-error'), null);
});

test('祖先目录也找不到：报错 trace 列出每一次尝试，且不越过盘符根', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<div id="p"><img src="figures/a.png"></div>');
  const preview = dom.window.document.getElementById('p');
  const asked = [];
  await processImages(preview, {
    activeTab: { filePath: 'D:/book/manuscript/ch3.md' },
    imageCache: new Map(),
    tauri: { fetchImageAsBase64: async ({ url }) => { asked.push(url); throw new Error('os error 3'); } },
    getCachedImageURL: (u) => u,
    getRenderGeneration: () => 1,
  });
  assert.deepStrictEqual(asked, ['D:/book/manuscript/figures/a.png', 'D:/book/figures/a.png']);
  assert.ok(preview.querySelector('.img-load-error'));
});

test('../ 开头的相对路径不做祖先回退', async () => {
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<div id="p"><img src="../figures/a.png"></div>');
  const asked = [];
  await processImages(dom.window.document.getElementById('p'), {
    activeTab: { filePath: 'D:/book/manuscript/ch3.md' },
    imageCache: new Map(),
    tauri: { fetchImageAsBase64: async ({ url }) => { asked.push(url); throw new Error('x'); } },
    getCachedImageURL: (u) => u,
    getRenderGeneration: () => 1,
  });
  assert.strictEqual(asked.length, 1);
});
