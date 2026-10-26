// 原生 HTML 图文块：<figure><img src=相对/绝对路径><figcaption>，前后带 HTML 注释标记。
// 注释与 id/class 必须经 sanitize 后保留；图片路径原样交给 image-processor 读盘。
const test = require('node:test');
const assert = require('node:assert');
const { renderMarkdown, renderMarkdownBlocks } = require('../src/unified-renderer.js');
const { processImages } = require('../src/modules/image-processor.js');

const FIG = '<!-- figure:a -->\n'
  + '<figure class="fig" id="fig-a"><img src="figures/a.png" alt="แผนภาพ">'
  + '<figcaption><strong>อ่านภาพนี้ยังไง:</strong> ข้อความ</figcaption></figure>\n'
  + '<!-- /figure:a -->';

test('figure 块：注释、id、class、相对路径 img、figcaption 全部保留', () => {
  const html = renderMarkdown('前文\n\n' + FIG + '\n\n后文', { softBreaks: false });
  assert.ok(html.includes('<!-- figure:a -->'), html);
  assert.ok(html.includes('<!-- /figure:a -->'), html);
  assert.ok(html.includes('<figure class="fig" id="fig-a">'), html);
  assert.ok(html.includes('src="figures/a.png"'), html);
  assert.ok(html.includes('<figcaption><strong>อ่านภาพนี้ยังไง:</strong>'), html);
});

test('行内 HTML <img> 绝对路径（Windows / Unix）原样保留', () => {
  const html = renderMarkdown('<img src="C:/x/a.png" alt="a"> <img src="/home/u/b.png" alt="b">', { softBreaks: false });
  assert.ok(html.includes('src="C:/x/a.png"'), html);
  assert.ok(html.includes('src="/home/u/b.png"'), html);
});

test('分块渲染（所见即所得）下 figure 块不丢图', () => {
  const blocks = renderMarkdownBlocks('# T\n\n' + FIG + '\n\n后文\n', {});
  assert.ok(blocks.some((b) => b.html.includes('<figure') && b.html.includes('figures/a.png')));
});

test('image-processor 对 figure 内相对/绝对 img 读盘并替换 src', async () => {
  const mk = (src) => ({
    getAttribute: (k) => (k === 'src' ? src : null),
    src,
  });
  const imgs = [mk('figures/a.png'), mk('D:/abs/b.png')];
  const preview = { querySelectorAll: () => imgs };
  const asked = [];
  await processImages(preview, {
    activeTab: { filePath: 'D:/notes/doc.md' },
    imageCache: new Map(),
    tauri: { fetchImageAsBase64: async ({ url }) => { asked.push(url); return 'QUJD'; } },
    getCachedImageURL: (u) => u,
    getRenderGeneration: () => 1,
  });
  assert.deepStrictEqual(asked.sort(), ['D:/abs/b.png', 'D:/notes/figures/a.png']);
  assert.ok(imgs.every((i) => i.src.startsWith('data:image/png;base64,')));
});
