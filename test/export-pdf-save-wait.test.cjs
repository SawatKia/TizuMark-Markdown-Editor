// exportPDF 双路径契约回归测试
//
// 2026-10-25 设计（用户反馈：导出 PDF 时软件右上角弹出像浏览器一样的下载气泡）：
//   ① 点击导出 → 弹"导出 PDF"确认框，含醒目警示文案（"文件较大时生成 PDF 耗时较长…"）；
//   ② 确认后先用应用内保存对话框选路径 —— PrintToPdf 直接写盘，不经过浏览器下载管线，
//      所以**必须**自己问路径，否则无处落地；
//   ③ 主路径：WebView2 `ICoreWebView2_7::PrintToPdf`（`TauriApi.printToPdf`）直接落盘，
//      全程无打印对话框、无下载气泡、无 iframe；
//   ④ 回退路径（旧 WebView2 运行时抛错）：原系统打印 iframe + contentWindow.print()，
//      文字仍是可选中的矢量文本。
//
// 已废弃的旧断言（这一版起不再成立）：
//   - 「确认后不弹应用内保存框」—— 新方案**要**弹（②）；
//   - 「30s safetyTimer 兜底隐藏 overlay」—— 主路径有真实落盘回调，不再需要。
const test = require('node:test');
const assert = require('node:assert');
const { withEditor, delay } = require('./helpers/app-env.cjs');

const pdfSaveInvoke = (cmd) => (cmd === 'plugin:dialog|save' ? '/tmp/out.pdf' : null);

// 捕获 iframe + 拦截 30s watchdog（其他定时器放行真实执行）。
function installHarness(w) {
  const capturedIframes = [];
  const origCreateElement = w.document.createElement.bind(w.document);
  w.document.createElement = function (tag) {
    const el = origCreateElement(tag);
    if (String(tag).toLowerCase() === 'iframe') capturedIframes.push(el);
    return el;
  };

  const realSetTimeout = w.setTimeout;
  const longTimers = new Map(); // 负数 id -> 回调
  let nextId = -1;
  w.setTimeout = function (fn, ms, ...args) {
    if (ms === 30000) { const id = nextId--; longTimers.set(id, fn); return id; }
    return realSetTimeout.call(this, fn, ms, ...args);
  };
  const realClearTimeout = w.clearTimeout;
  w.clearTimeout = function (id) {
    if (typeof id === 'number' && id < 0) { longTimers.delete(id); return undefined; }
    return realClearTimeout.call(this, id);
  };

  return {
    capturedIframes,
    longTimers,
    fireLongTimers() {
      for (const fn of Array.from(longTimers.values())) fn();
    },
    restore() {
      w.document.createElement = origCreateElement;
      w.setTimeout = realSetTimeout;
      w.clearTimeout = realClearTimeout;
    },
    fireAfterprint(iframe) {
      iframe.contentWindow.dispatchEvent(new w.Event('afterprint'));
    },
  };
}

test('exportPDF: 确认框展示醒目警示文案，确认后走 PrintToPdf 主路径（不建 iframe）', async () => {
  let printed = 0;
  await withEditor({ invokeImpl: pdfSaveInvoke }, async (w, ed) => {
    w.TauriApi.printToPdf = async () => { printed += 1; };
    const h = installHarness(w);
    try {
      ed.activeTab.name = 'NOTE.md';
      const exportPromise = ed.exportPDF();
      await delay(5);
      const warnEl = w.document.getElementById('confirm-dialog-warning');
      const warnTextEl = w.document.getElementById('confirm-dialog-warning-text');
      assert.ok(warnEl, '确认框应含 #confirm-dialog-warning 节点');
      assert.ok(!warnEl.classList.contains('hidden'), '传 warning 时警示块必须打开（无 hidden）');
      assert.ok(warnTextEl, '确认框应含 #confirm-dialog-warning-text 节点');
      assert.match(warnTextEl.textContent, /耐心等待/, '警示文案应含"耐心等待"');
      assert.match(warnTextEl.textContent, /未生成完/, '警示文案应含"未生成完"');
      assert.match(warnTextEl.textContent, /文件损坏/, '警示文案应含"文件损坏"');

      w.document.getElementById('confirm-dialog-confirm').click();
      await exportPromise.catch(() => {});

      assert.strictEqual(printed, 1, '确认后应走 PrintToPdf 主路径');
      assert.strictEqual(h.capturedIframes.length, 0, '主路径不应创建打印 iframe（那是旧系统的下载气泡来源）');
    } finally {
      h.restore();
    }
  });
});

test('exportPDF: 用户点取消 → 既不选保存路径，也不打印', async () => {
  let dialogSaveCalled = 0;
  let printed = 0;
  await withEditor({
    invokeImpl: (cmd) => { if (cmd === 'plugin:dialog|save') dialogSaveCalled += 1; return null; },
  }, async (w, ed) => {
    w.TauriApi.printToPdf = async () => { printed += 1; };
    const h = installHarness(w);
    try {
      ed.activeTab.name = 'NOTE.md';
      const exportPromise = ed.exportPDF();
      await delay(5);
      w.document.getElementById('confirm-dialog-cancel').click();
      await exportPromise.catch(() => {});

      assert.strictEqual(dialogSaveCalled, 0, '用户取消时不应弹保存对话框');
      assert.strictEqual(printed, 0, '用户取消时不应打印');
      assert.strictEqual(h.capturedIframes.length, 0, '用户取消时不应创建打印 iframe');
      assert.strictEqual(w.document.getElementById('tm-export-overlay'), null, '用户取消时不应留遮罩');
    } finally {
      h.restore();
    }
  });
});

test('exportPDF 主路径：先选路径 → PrintToPdf 直接落盘（A4 + 1.5cm 边距），打印态全部复原', async () => {
  let args = null;
  await withEditor({ invokeImpl: pdfSaveInvoke }, async (w, ed) => {
    w.TauriApi.printToPdf = async (a) => { args = a; };
    ed.showConfirmDialog = async () => true;
    ed.activeTab.name = 'RELEASE_NOTES.md';
    ed.activeTab.filePath = '/docs/RELEASE_NOTES.md';
    w.editor.preview.innerHTML = '<p>正文</p>';

    await ed.exportPDF();

    assert.ok(args, 'PrintToPdf 未被调用');
    assert.strictEqual(args.options.path, '/tmp/out.pdf', '保存路径未透传给 PrintToPdf');
    assert.strictEqual(args.options.pageWidth, 8.27, 'A4 宽度（英寸）不对');
    assert.strictEqual(args.options.pageHeight, 11.69, 'A4 高度（英寸）不对');
    assert.strictEqual(args.options.marginTop, 0.59, '1.5cm ≈ 0.59in 的边距不对');

    // 打印态必须完整复原，否则主界面会一直空白
    assert.strictEqual(w.document.getElementById('pdf-print-root'), null, '打印态副本未移除');
    assert.strictEqual(w.document.getElementById('tm-pdf-print-style'), null, '打印态样式未移除');
    assert.strictEqual(w.document.getElementById('tm-export-expand-style'), null, '展开样式未移除');
    assert.strictEqual(w.document.getElementById('tm-export-overlay'), null, '遮罩未移除');
    assert.strictEqual(w.document.body.classList.contains('pdf-printing'), false, 'body 仍带 pdf-printing');
    assert.strictEqual(w.document.documentElement.classList.contains('pdf-printing'), false,
      'html 仍带 pdf-printing（整页 UI 会持续隐藏）');
  });
});

test('exportPDF 回退路径：PrintToPdf 抛错 → 系统打印 iframe，内容是可选中文本', async () => {
  await withEditor({ invokeImpl: pdfSaveInvoke }, async (w, ed) => {
    w.TauriApi.printToPdf = async () => { throw new Error('旧版 WebView2 无 PrintToPdf'); };
    ed.showConfirmDialog = async () => true;
    ed.activeTab.name = 'NOTE.md';
    w.editor.preview.innerHTML = '<p>可选中的正文</p>';
    const h = installHarness(w);
    try {
      await ed.exportPDF().catch(() => {});

      const iframe = h.capturedIframes[0];
      assert.ok(iframe, 'PrintToPdf 不可用时应回退建打印 iframe');
      // srcdoc 是真实 HTML 文本（矢量文字），不是整页位图
      assert.match(iframe.srcdoc, /可选中的正文/, 'srcdoc 应含真实文字节点，保证 PDF 文字可选中');
      assert.ok(!/<img[^>]+data:image\/png;base64,[^"]{500,}/.test(iframe.srcdoc), 'srcdoc 不应是整页位图');

      let printed = 0;
      iframe.contentWindow.print = () => { printed += 1; };
      iframe.onload();
      assert.strictEqual(printed, 1, 'onload 后应调用系统打印 print()');

      // afterprint 收尾：iframe 清理 + 主窗口 title 还原
      w.document.title = 'TizuMark';
      iframe.onload(); // 再走一次以覆盖 title（onload 幂等，仅覆盖 title）
      h.fireAfterprint(iframe);
      assert.strictEqual(iframe.parentNode, null, 'afterprint 后 iframe 应已清理');
      assert.strictEqual(w.document.title, 'TizuMark', 'afterprint 后主窗口 title 应还原');
    } finally {
      h.restore();
    }
  });
});

test('exportPDF 回退路径：无 afterprint 时 30s watchdog 兜底收尾（清 iframe + 还原 title）', async () => {
  await withEditor({ invokeImpl: pdfSaveInvoke }, async (w, ed) => {
    w.TauriApi.printToPdf = async () => { throw new Error('旧版 WebView2 无 PrintToPdf'); };
    ed.showConfirmDialog = async () => true;
    ed.activeTab.name = '说明文档.md';
    w.document.title = 'TizuMark';
    const h = installHarness(w);
    try {
      await ed.exportPDF().catch(() => {});
      const iframe = h.capturedIframes[0];
      assert.ok(iframe && typeof iframe.onload === 'function');
      iframe.onload();
      assert.strictEqual(w.document.title, '说明文档', 'onload 后主窗口 title 应被覆盖为去扩展名文件名');

      assert.ok(h.longTimers.size >= 1, '应排队至少 1 个 30s 兜底定时器');
      h.fireLongTimers();

      assert.strictEqual(iframe.parentNode, null, '30s 兜底应移除 iframe');
      assert.strictEqual(w.document.title, 'TizuMark', '30s 兜底应还原主窗口 title');
      assert.strictEqual(w.document.querySelector('.pdf-loading-spinner'), null, '30s 兜底应隐藏 overlay');
    } finally {
      h.restore();
    }
  });
});
