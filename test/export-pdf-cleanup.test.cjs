// exportPDF 清理路径回归测试
// 根因：用户报告"导出 PDF（选另存为 PDF/更改保存目录）"完成后，约 30 秒后弹
// `Uncaught TypeError: Cannot read properties of null (reading 'removeEventListener')`（app.js:6067）。
//
// 触发链：
//   1. iframe.onload 注册 afterprint 监听 + setTimeout(cleanup, 30000)；
//   2. 用户在系统打印对话框选"另存为 PDF"并保存成功，触发 afterprint，after 回调
//      调 iframe.contentWindow.removeEventListener + iframe.remove() + setStatus；
//   3. 30 秒后 setTimeout 触发，再次尝试 iframe.contentWindow.removeEventListener，
//      但此时 contentWindow 已是 null → NPE。
//
// 修复：抽 cleanup 闭包 + cleaned 互斥标志，两条路径共用；对 contentWindow 做 null 防护。
// 本测试通过拦截 createElement 捕获 iframe，模拟 afterprint 后再触发 30s 路径，
// 验证：① 不再 NPE；② cleanup 互斥（iframe 只被 remove 一次）；③ 无 afterprint 时
// 30s 路径能正常清理。
//
// 关键细节：jsdom 会在 iframe.appendChild 之后用内部 Window 覆盖 contentWindow，
// 故不能用「替换 contentWindow 为 mock 对象」的方式。改为：
//   - 用真实 jsdom contentWindow（支持 addEventListener / dispatchEvent）；
//   - 通过 dispatchEvent(new win.Event('afterprint')) 模拟打印完成；
//   - 劫持 setTimeout 把硬编码的 30000ms 暂存到 longTimers，按需触发，免真实等 30s。
const test = require('node:test');
const assert = require('node:assert');
const { withEditor } = require('./helpers/app-env.cjs');

// 2026-10-25：exportPDF 主路径改为 WebView2 PrintToPdf（直接落盘，无打印对话框、无下载气泡）。
// 本文件守护的是**回退路径**（旧 WebView2 运行时 / PrintToPdf 抛错）的 iframe 收尾逻辑，
// 故每条用例都先把导出逼上回退：给定保存路径 + 让 printToPdf 抛错。
const pdfSaveInvoke = (cmd) => (cmd === 'plugin:dialog|save' ? '/tmp/out.pdf' : null);
function forceFallbackPath(w, ed) {
  ed.showConfirmDialog = async () => true;
  w.TauriApi.printToPdf = async () => { throw new Error('模拟旧版 WebView2：无 ICoreWebView2_7::PrintToPdf'); };
}

function installPdfTestHarness(w) {
  // 拦截 createElement 捕获 iframe
  const capturedIframes = [];
  const origCreateElement = w.document.createElement.bind(w.document);
  w.document.createElement = function (tag) {
    const el = origCreateElement(tag);
    if (String(tag).toLowerCase() === 'iframe') capturedIframes.push(el);
    return el;
  };

  // 劫持 setTimeout：把硬编码的 30000ms 暂存到 longTimers，由测试按需触发
  const realSetTimeout = w.setTimeout;
  const longTimers = [];
  w.setTimeout = function (fn, ms, ...args) {
    if (ms === 30000) {
      longTimers.push(fn);
      return -1;
    }
    return realSetTimeout.call(this, fn, ms, ...args);
  };

  return {
    capturedIframes,
    longTimers,
    restore() {
      w.document.createElement = origCreateElement;
      w.setTimeout = realSetTimeout;
    },
    fireAfterprint(iframe) {
      iframe.contentWindow.dispatchEvent(new w.Event('afterprint'));
    },
  };
}

test('exportPDF: afterprint 后 30s 清理不再 NPE（contentWindow 已 null）', async () => {
  await withEditor({ invokeImpl: pdfSaveInvoke }, async (w, ed) => {
    forceFallbackPath(w, ed);
    const h = installPdfTestHarness(w);
    try {
      await ed.exportPDF().catch(() => {});
      assert.ok(h.capturedIframes.length >= 1, 'exportPDF 应至少创建了一个 iframe');
      const iframe = h.capturedIframes[0];
      assert.strictEqual(typeof iframe.onload, 'function', 'iframe.onload 应已设置');

      // 触发 iframe.onload：模拟 srcdoc 加载完成（jsdom 不会自动触发）
      iframe.onload();
      assert.ok(iframe.parentNode, 'onload 后 iframe 应仍在文档中');

      // 模拟用户"另存为 PDF"成功，触发 afterprint
      h.fireAfterprint(iframe);

      // after 回调已执行 cleanup：iframe 应已被 remove
      assert.strictEqual(iframe.parentNode, null, 'afterprint 触发后 iframe 应已被移除');

      // 关键断言：手动触发 30s 路径的 cleanup（修复前会 NPE）
      assert.strictEqual(h.longTimers.length >= 1, true, '应已排队 30s 定时器（cleanup 路径）');
      assert.doesNotThrow(
        () => { for (const fn of h.longTimers) fn(); },
        '30s 清理路径触发不应抛 NPE（修复前：Cannot read properties of null）',
      );

      // 清理互斥：iframe 仍只有一次 remove（parentNode 仍为 null，无重复副作用）
      assert.strictEqual(iframe.parentNode, null, 'iframe 仍应处于已移除状态');
    } finally {
      h.restore();
    }
  });
});

test('exportPDF: 无 afterprint 触发时，30s 清理路径正常移除 iframe', async () => {
  // 场景：用户在打印对话框选"取消"或不操作，30s 后 setTimeout 清理。
  await withEditor({ invokeImpl: pdfSaveInvoke }, async (w, ed) => {
    forceFallbackPath(w, ed);
    const h = installPdfTestHarness(w);
    try {
      await ed.exportPDF().catch(() => {});
      const iframe = h.capturedIframes[0];
      assert.ok(iframe && typeof iframe.onload === 'function');
      iframe.onload();
      // 不触发 afterprint
      assert.ok(iframe.parentNode, 'onload 后 iframe 仍在文档中');

      assert.doesNotThrow(
        () => { for (const fn of h.longTimers) fn(); },
        '30s 清理路径在无 afterprint 时也应不抛错',
      );
      assert.strictEqual(iframe.parentNode, null, '30s 路径应正常移除 iframe');
    } finally {
      h.restore();
    }
  });
});

test('exportPDF: cleanup 互斥——after 路径先到，30s 路径后到不重复操作', async () => {
  // 验证 cleaned 标志位：两条路径都触发也只 remove 一次。
  // 通过劫持 contentWindow.removeEventListener 计数验证。
  await withEditor({ invokeImpl: pdfSaveInvoke }, async (w, ed) => {
    forceFallbackPath(w, ed);
    const h = installPdfTestHarness(w);
    try {
      await ed.exportPDF().catch(() => {});
      const iframe = h.capturedIframes[0];

      // 劫持 removeEventListener 计数（afterprint 类型）
      let removeAfterPrintCount = 0;
      const win = iframe.contentWindow;
      const origRemove = win.removeEventListener.bind(win);
      win.removeEventListener = function (type, cb, opts) {
        if (type === 'afterprint') removeAfterPrintCount++;
        return origRemove(type, cb, opts);
      };

      iframe.onload();
      const before = removeAfterPrintCount;

      // 路径 1：afterprint 触发 cleanup（removeEventListener +1）
      h.fireAfterprint(iframe);
      const afterAfterprint = removeAfterPrintCount;
      assert.strictEqual(afterAfterprint, before + 1, 'afterprint 路径应调一次 removeEventListener');

      // 路径 2：30s setTimeout 触发 cleanup（应被 cleaned 标志位挡掉，不再调 removeEventListener）
      for (const fn of h.longTimers) fn();
      assert.strictEqual(
        removeAfterPrintCount,
        afterAfterprint,
        '30s 路径应被 cleaned 标志位互斥，不重复 removeEventListener',
      );
      assert.strictEqual(iframe.parentNode, null, 'iframe 仍应已移除（仅一次）');
    } finally {
      h.restore();
    }
  });
});

test('exportPDF: 打印文件名预填去扩展名的 md 文件名（非空白）', async () => {
  await withEditor({ invokeImpl: pdfSaveInvoke }, async (w, ed) => {
    forceFallbackPath(w, ed);
    const h = installPdfTestHarness(w);
    try {
      ed.activeTab.name = 'RELEASE_NOTES.md';
      await ed.exportPDF().catch(() => {});
      const iframe = h.capturedIframes[0];
      assert.ok(iframe, '应创建 iframe');

      // srcdoc 的 <title> 应为去扩展名的文件名（不含 .md，系统打印自动补 .pdf）
      const m = /<title>([^<]*)<\/title>/.exec(iframe.srcdoc);
      assert.ok(m, 'srcdoc 应含 <title>');
      assert.strictEqual(m[1], 'RELEASE_NOTES', 'srcdoc <title> 应为去扩展名文件名');

      // onload：模拟 srcdoc 加载完成
      iframe.onload();

      // onload 后应显式同步到打印文档 title（确保 WebView2 打印对话框文件名非空）
      const docTitle = iframe.contentDocument && iframe.contentDocument.title;
      assert.strictEqual(docTitle, 'RELEASE_NOTES', 'onload 后 contentDocument.title 应预填去扩展名 md 文件名');

      // 同时验证：文件名不应为空白 / 不应带 .md
      assert.ok(docTitle && docTitle.length > 0, '打印文件名不应为空');
      assert.ok(!docTitle.endsWith('.md'), '打印文件名不应残留 .md 扩展名');
    } finally {
      h.restore();
    }
  });
});

test('exportPDF: onload 显式写 contentDocument.title 覆盖已有（srcdoc 不自动采用时仍生效）', async () => {
  // 直接验证「iframe.contentDocument.title = escapedTitle」这条显式写入路径：
  // 在 onload 前把 contentDocument.title 污染成别的值，onload 后必须被改回 escapedTitle。
  // （真实 WebView 中 srcdoc 不一定自动采用 <title>，此写入保证文件名预填。）
  await withEditor({ invokeImpl: pdfSaveInvoke }, async (w, ed) => {
    forceFallbackPath(w, ed);
    const h = installPdfTestHarness(w);
    try {
      ed.activeTab.name = '我的笔记.md';
      await ed.exportPDF().catch(() => {});
      const iframe = h.capturedIframes[0];

      // onload 前污染 contentDocument.title
      assert.ok(iframe.contentDocument, 'contentDocument 应存在');
      iframe.contentDocument.title = 'SOME_WRONG_TITLE';

      // onload 应用显式写入
      iframe.onload();

      assert.strictEqual(
        iframe.contentDocument.title,
        '我的笔记',
        'onload 应把 contentDocument.title 改写为去扩展名 md 文件名',
      );
    } finally {
      h.restore();
    }
  });
});

test('exportPDF: 主窗口 document.title 临时覆盖为 md 文件名（afterprint 后还原）', async () => {
  // 真正的文件名来源是主窗口（顶层 frame）title，而非 srcdoc 子 frame <title>。
  // 验证 onload 临时覆盖 + afterprint 触发后还原。
  await withEditor({ invokeImpl: pdfSaveInvoke }, async (w, ed) => {
    forceFallbackPath(w, ed);
    const h = installPdfTestHarness(w);
    try {
      ed.activeTab.name = 'RELEASE_NOTES.md';
      w.document.title = 'TizuMark'; // 模拟主窗口原有标题
      await ed.exportPDF().catch(() => {});
      const iframe = h.capturedIframes[0];
      iframe.onload();

      // print 前主窗口 title 应被覆盖为 md 文件名（去扩展名）
      assert.strictEqual(w.document.title, 'RELEASE_NOTES', 'onload 后主窗口 title 应临时改为 md 文件名');

      // afterprint 触发后还原主窗口标题
      h.fireAfterprint(iframe);
      assert.strictEqual(w.document.title, 'TizuMark', 'afterprint 后主窗口 title 应还原');
    } finally {
      h.restore();
    }
  });
});

test('exportPDF: 无 afterprint 时，30s 超时路径也还原主窗口 title', async () => {
  await withEditor({ invokeImpl: pdfSaveInvoke }, async (w, ed) => {
    forceFallbackPath(w, ed);
    const h = installPdfTestHarness(w);
    try {
      ed.activeTab.name = '说明文档.md';
      w.document.title = 'TizuMark';
      await ed.exportPDF().catch(() => {});
      const iframe = h.capturedIframes[0];
      iframe.onload();
      assert.strictEqual(w.document.title, '说明文档', 'onload 后主窗口 title 应被覆盖为去扩展名文件名');

      // 不触发 afterprint（用户在对话框取消等），走 30s 超时 cleanup 兜底还原
      for (const fn of h.longTimers) fn();
      assert.strictEqual(w.document.title, 'TizuMark', '30s 超时路径应还原主窗口 title');
    } finally {
      h.restore();
    }
  });
});

test('exportPDF: afterprint 后立即收尾（不再保留 loading，警示已前置到确认框）', async () => {
  // 收窄后的设计：OS 打印后台异步落盘无法检测，警示已在确认框里展示给用户。
  // afterprint 一触发即收尾：清 iframe / 还原主窗口 title / 立即隐藏 overlay / 不再轮询 file_meta。
  // 关键不变量：afterprint 后【不应】再调 file_meta（撤销了旧版 700ms 轮询）。
  let fileMetaCalled = 0;
  await withEditor({
    invokeImpl: (cmd) => {
      if (cmd === 'plugin:dialog|save') return '/tmp/out.pdf';
      if (cmd === 'file_meta') { fileMetaCalled += 1; return null; }
      return null;
    },
  }, async (w, ed) => {
    forceFallbackPath(w, ed);
    const h = installPdfTestHarness(w);
    try {
      ed.activeTab.name = 'DEMO.md';
      w.document.title = 'TizuMark';
      await ed.exportPDF().catch(() => {});
      const iframe = h.capturedIframes[0];
      iframe.onload();
      assert.strictEqual(w.document.title, 'DEMO', 'onload 后主窗口 title 应被覆盖');

      // 触发 afterprint（用户在系统框里点完打印/取消后触发）
      h.fireAfterprint(iframe);

      // 立即收尾
      assert.strictEqual(iframe.parentNode, null, 'afterprint 后 iframe 应已清理');
      assert.strictEqual(w.document.title, 'TizuMark', 'afterprint 后主窗口 title 应还原');
      assert.strictEqual(
        w.document.querySelector('.pdf-loading-text'),
        null,
        'afterprint 后 loading overlay 必须立即隐藏（不再保留"等待写入"提示）',
      );
      // 给一个微任务窗口，确保任何被排队的旧轮询都已执行
      await new Promise(r => setTimeout(r, 20));
      assert.strictEqual(fileMetaCalled, 0, '新方案不再调用 file_meta（不轮询落盘）');
    } finally {
      h.restore();
    }
  });
});

test('exportPDF: 图片内联为 base64（srcdoc 不含 blob: / 相对路径，根除空白图）', async () => {
  // 根因：exportPDF 原直接把预览 clone 塞进 srcdoc，未内联图片。预览 img.src 全是
  // processImages 生成的 blob: URL，打印帧同源可解析但会被 LRU 回收失效 → PDF 空白图。
  // 修复：复用 _inlineImagesForExport，塞 srcdoc 前把 blob:/file:///相对路径全内联为 base64。
  const captured = {};
  await withEditor({
    invokeImpl: (cmd, args) => {
      if (cmd === 'plugin:dialog|save') return '/tmp/out.pdf';
      if (cmd === 'fetch_image_as_base64') return 'RELBASE64';
      return null;
    },
  }, async (w, ed) => {
    forceFallbackPath(w, ed);
    ed.activeTab.name = 'NOTE.md';
    ed.activeTab.filePath = '/docs/note.md';
    // 模拟真实预览：一张 blob:（processImages 缓存），一张相对路径
    w.editor.preview.innerHTML =
      '<img src="blob:http://localhost/abc-123">' +
      '<img src="images/a.png">';
    // 拦截 fetch：blob: 拉取返回可转 data URI 的 blob 响应；styles.css 等拉取直接抛错走 CSSOM 兜底
    w.fetch = async (url) => {
      if (String(url).startsWith('blob:')) {
        return { ok: true, blob: async () => new w.Blob(['hello'], { type: 'image/png' }) };
      }
      throw new Error('unexpected fetch: ' + url);
    };

    const h = installPdfTestHarness(w);
    try {
      await ed.exportPDF().catch(() => {});
      const iframe = h.capturedIframes[0];
      assert.ok(iframe && iframe.srcdoc, '应创建含打印 HTML 的 iframe');
      const doc = iframe.srcdoc;

      // 相对路径图片内联为 base64
      assert.ok(doc.includes('data:image/png;base64,RELBASE64'), '相对路径图片应内联为 base64');
      // 关键不变量：srcdoc 不得再含 blob:（避免打印帧 blob 失效导致空白图）
      assert.ok(!doc.includes('blob:'), 'srcdoc 不应含 blob:（图片应已内联）');
      // 相对路径原 src 已被替换
      assert.ok(!doc.includes('src="images/a.png"'), '相对路径原 src 不应保留');
      // blob: 图片也应被还原为 data:（非 blob:）
      assert.ok(!doc.includes('blob:http'), 'blob: 图片应被还原为内联 data URI，不得保留 blob: 源');
    } finally {
      h.restore();
    }
  });
});

test('exportPDF: 暗色模式下导出帧仍取亮色 hljs 配色（白纸可读性）', async () => {
  // 根因：导出帧纸面恒为白底（data-theme="light"），但旧实现取「当前已加载」的
  // #highlight-theme CSS——暗色模式下那是 github-dark 的浅灰 token 色，落白纸面几乎不可见
  // （用户反馈：暗黑模式导出 PDF 代码块文字发灰看不清）。修复：一律取亮色 github.min.css。
  await withEditor({ invokeImpl: pdfSaveInvoke }, async (w, ed) => {
    forceFallbackPath(w, ed);
    // 模拟应用当前处于暗色模式：isDark + data-theme + hljs 主题链接已切 github-dark
    ed.isDark = true;
    w.document.documentElement.setAttribute('data-theme', 'dark');
    const link = w.document.getElementById('highlight-theme');
    if (link) link.setAttribute('href', 'lib/highlight.js/github-dark.min.css');

    const fetchCalls = [];
    const realFetch = w.fetch;
    w.fetch = async (url) => {
      fetchCalls.push(String(url));
      return { ok: false, text: async () => '' };
    };
    const h = installPdfTestHarness(w);
    try {
      await ed.exportPDF().catch(() => {});
      // 关键断言：导出帧请求亮色 hljs CSS，而非应用当前加载的暗色
      assert.ok(
        fetchCalls.includes('lib/highlight.js/github.min.css'),
        '导出帧应 fetch 亮色 hljs CSS（github.min.css），实际请求: ' + JSON.stringify(fetchCalls),
      );
      assert.ok(
        !fetchCalls.includes('lib/highlight.js/github-dark.min.css'),
        '导出帧不得 fetch 暗色 hljs CSS（github-dark）',
      );
      // 导出帧 html 钉亮色 scheme
      const iframe = h.capturedIframes[0];
      assert.ok(iframe && iframe.srcdoc, '应创建含打印 HTML 的 iframe');
      assert.ok(/data-theme="light"/.test(iframe.srcdoc), '导出帧应钉 data-theme="light"');
    } finally {
      w.fetch = realFetch;
      h.restore();
    }
  });
});
