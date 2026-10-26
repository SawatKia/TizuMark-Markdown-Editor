// P1-1：src/modules/image-processor.js 的纯函数 + 依赖注入单测。
// 直接驱动模块（不经 app.js），覆盖三路径、缓存命中零重复 IO、代际过期提前返回不写 DOM、
// 以及「仅 isBundled 回退」铁律。bundled-demo.test.cjs 仍从编辑器实例整链路复跑同一铁律。
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { processImages, TRANSPARENT_PIXEL } = require('../src/modules/image-processor.js');

// 构造一个带 #preview 容器的 jsdom window；URL.createObjectURL 在 Node 不存在，
// 这里只测绝对/相对/isBundled 三路径（均不进入「无 filePath 的 fetch 分支」），
// 故无需真实 createObjectURL。
function makePreview(html) {
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="preview">' + html + '</div></body></html>');
  return dom.window.document.getElementById('preview');
}

// 标准 deps 构造器：tauri 记录所有调用，getCachedImageURL 做可断言的包裹。
function makeDeps(overrides = {}) {
  const calls = [];
  const tauri = {
    fetchImageAsBase64: async (args) => {
      calls.push({ cmd: 'fetch', args });
      if (overrides.fetchThrow) throw new Error('no such file ' + (args && args.url));
      return overrides.fetchReturn || 'AAAA';
    },
    readBundledImageAsBase64: async (args) => {
      calls.push({ cmd: 'bundled', args });
      return 'CCCC';
    },
  };
  const state = { gen: overrides.gen || 1 };
  return {
    calls,
    state,
    deps: {
      activeTab: overrides.activeTab || { filePath: 'D:/docs/note.md' },
      imageCache: new Map(),
      tauri,
      getCachedImageURL: (d) => 'BLOB:' + d,
      getRenderGeneration: () => state.gen,
      ...overrides.extraDeps,
    },
  };
}

test('绝对路径：直接走 fetch_image_as_base64，并按 getCachedImageURL 写回', async () => {
  const preview = makePreview('<img src="/abs.png" alt="x">');
  const { calls, deps } = makeDeps({ activeTab: { filePath: 'D:/docs/note.md' } });
  await processImages(preview, deps);
  assert.equal(calls.length, 1, '应只调用一次 fetch');
  assert.equal(calls[0].cmd, 'fetch');
  assert.equal(calls[0].args.url, '/abs.png');
  const img = preview.querySelector('img');
  assert.equal(img.getAttribute('src'), 'BLOB:data:image/png;base64,AAAA', '应写回经 getCachedImageURL 包裹的 data URI');
});

test('相对路径（非 isBundled）成功：按 dir 补全绝对路径', async () => {
  const preview = makePreview('<img src="pic.png">');
  const { calls, deps } = makeDeps({ activeTab: { filePath: 'D:/docs/note.md' } });
  await processImages(preview, deps);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.url, 'D:/docs/pic.png', '应相对 .md 目录补全');
  assert.match(preview.querySelector('img').getAttribute('src'), /BLOB:data:image\/png;base64/);
});

test('Windows \\\\?\\ 长路径前缀 filePath：去掉前缀再拼相对路径（避免 os error 123 混合分隔符）', async () => {
  // read_bundled_file 在 dev 模式返回带 \\?\ 前缀的 canonical 路径（如
  // \\?\D:\project\tizu-mark\src-tauri\target\debug\demo.md）
  const preview = makePreview('<img src="assets/icon.png" alt="i">');
  const { calls, deps } = makeDeps({
    activeTab: { filePath: '\\\\?\\D:\\project\\tizu-mark\\src-tauri\\target\\debug\\demo.md' },
  });
  await processImages(preview, deps);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'fetch');
  assert.equal(
    calls[0].args.url,
    'D:\\project\\tizu-mark\\src-tauri\\target\\debug/assets/icon.png',
    '拼接 URL 不应含 \\\\?\\ 前缀（混合分隔符会触发 Path::canonicalize os error 123）',
  );
  assert.match(preview.querySelector('img').getAttribute('src'), /BLOB:data:image\/png;base64/);
});

test('相对路径（非 isBundled）本地失败：绝不回退 read_bundled_image_as_base64', async () => {
  const preview = makePreview('<img src="missing.png" alt="m">');
  const { calls, deps } = makeDeps({ activeTab: { filePath: 'D:/docs/note.md' }, fetchThrow: true });
  await processImages(preview, deps);
  assert.equal(calls.filter((c) => c.cmd === 'bundled').length, 0, '普通文档缺图严禁回退打包资源');
  assert.match(preview.querySelector('img').getAttribute('alt'), /加载失败|failed to load/i, '缺图应标记加载失败');
});

test('相对路径（isBundled）本地失败：回退 read_bundled_image_as_base64，filename 用原始相对路径', async () => {
  const preview = makePreview('<img src="assets/icon.png" alt="i">');
  const { calls, deps } = makeDeps({
    activeTab: { filePath: 'C:/Program Files/TizuMark/demo.md', isBundled: true },
    fetchThrow: true,
  });
  await processImages(preview, deps);
  const fetchCalls = calls.filter((c) => c.cmd === 'fetch');
  const bundledCalls = calls.filter((c) => c.cmd === 'bundled');
  assert.equal(fetchCalls.length, 1, '应先尝试本地 fetch');
  assert.equal(fetchCalls[0].args.url, 'C:/Program Files/TizuMark/assets/icon.png');
  assert.equal(bundledCalls.length, 1, '本地失败后应回退');
  assert.equal(bundledCalls[0].args.filename, 'assets/icon.png', 'filename 用原始相对路径，由 Rust dev/prod 定位');
  assert.match(preview.querySelector('img').getAttribute('src'), /BLOB:data:image\/png;base64/);
});

test('缓存命中：imageCache 已有条目时零重复 IO', async () => {
  const preview = makePreview('<img src="/abs.png">');
  const { calls, deps } = makeDeps({ activeTab: { filePath: 'D:/docs/note.md' } });
  deps.imageCache.set('/abs.png', 'data:image/png;base64,CACHED');
  await processImages(preview, deps);
  assert.equal(calls.filter((c) => c.cmd === 'fetch').length, 0, '缓存命中不应再 invoke');
  assert.equal(preview.querySelector('img').getAttribute('src'), 'BLOB:data:image/png;base64,CACHED');
});

test('打包文档（isBundled 无 filePath）：相对图片走 read_bundled_image_as_base64，而非页面 fetch', async () => {
  const preview = makePreview('<img src="assets/icon.png" alt="i">');
  const { calls, deps } = makeDeps({ activeTab: { isBundled: true } });
  await processImages(preview, deps);
  const fetchCalls = calls.filter((c) => c.cmd === 'fetch');
  const bundledCalls = calls.filter((c) => c.cmd === 'bundled');
  assert.equal(fetchCalls.length, 0, '无 filePath 的打包文档不应做页面相对 fetch（会 404）');
  assert.equal(bundledCalls.length, 1, '应直接走打包资源定位命令');
  assert.equal(bundledCalls[0].args.filename, 'assets/icon.png', 'filename 用原始相对路径，由 Rust dev/prod 定位');
  assert.match(preview.querySelector('img').getAttribute('src'), /BLOB:data:image\/png;base64/, '应写回可显示 data URI');
});

test('代际过期：IO 进行中代际变化，提前返回不写 DOM', async () => {
  const preview = makePreview('<img src="pic.png" alt="p">');
  const { state, deps } = makeDeps({
    activeTab: { filePath: 'D:/docs/note.md' },
    // 在 fetch 期间把代际顶上去，模拟「用户又敲了一下字触发重渲染」
    extraDeps: {},
  });
  // 让 fetch 实现在 await 期间 bump 代际
  deps.tauri.fetchImageAsBase64 = async (args) => {
    state.gen = state.gen + 1; // 模拟重渲染使代际 +1
    return 'XXXX';
  };
  await processImages(preview, deps);
  // 写完前 gen 已不等于快照 → 提前 return；src 已被同步占位为透明像素（非过期 data URI），
  // 新一次渲染会替换 innerHTML，无视觉影响。关键是「不写入过期的 data URI」。
  assert.equal(preview.querySelector('img').getAttribute('src'), TRANSPARENT_PIXEL, '代际过期应提前返回，不写入过期 data URI');
  assert.equal(preview.querySelector('img').getAttribute('alt'), 'p', '不应被标记加载失败');
});

test('内联 / 远程 / blob 资源：直接跳过，不触发任何 IO', async () => {
  const preview = makePreview(
    '<img src="data:image/png;base64,Z" alt="a">' +
    '<img src="https://example.com/x.png" alt="b">' +
    '<img src="blob:abc-123" alt="c">',
  );
  const { calls, deps } = makeDeps({ activeTab: { filePath: 'D:/docs/note.md' } });
  await processImages(preview, deps);
  assert.equal(calls.length, 0, '可显示资源应完全跳过');
});

test('file:// 协议：去掉前缀按绝对路径处理', async () => {
  const preview = makePreview('<img src="file:///D:/a/b.png">');
  const { calls, deps } = makeDeps({ activeTab: { filePath: 'D:/docs/note.md' } });
  await processImages(preview, deps);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.url, '/D:/a/b.png', 'file:// 前缀去掉后作为绝对路径');
});
