// 导出与阅读模式一致性（2026-10-25 用户反馈的回归守卫）
//
// 用户当轮反馈的现象分三类，根因都在「导出帧拿到的样式/内容与阅读模式不是同一份」：
//   ① 导出 PDF / HTML 里公式出现第二份纯文本（a²+b²=c² 后面跟 a2 + b2 = c2）
//      → KaTeX 的 .katex-mathml 副本平时靠 CSS clip-path 隐藏，导出帧一旦缺样式就裸露；
//   ② 导出后代码高亮全丢
//      → hljs 主题 CSS 走裸 fetch，失败即静默为空；
//   ③ 导出 HTML / 长图与阅读模式差异大
//      → HTML 用另写的 _documentExportCSS（与 styles.css 两套平行实现），长图用 html2canvas
//        自带绘制器（不支持 MathML/clip-path/color-mix）。
//
// 本文件守住四条口径：MathML 必摘、样式必从 CSSOM 直读、HTML 必带 .preview-content 根、
// PDF 必走 PrintToPdf 且打印态必须干净。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withEditor } = require('./helpers/app-env.cjs');

const ROOT = path.resolve(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'export.js'), 'utf8');

const sliceFn = (startMarker, endMarker) => {
  const a = SRC.indexOf(startMarker);
  const b = endMarker ? SRC.indexOf(endMarker) : SRC.length;
  assert.ok(a > 0 && b > a, `无法定位方法体：${startMarker} … ${endMarker}`);
  return SRC.slice(a, b);
};

// ---------------------------------------------------------------- MathML 副本

test('MathML 副本：导出前一律从 clone 摘掉，不依赖 CSS clip-path 隐藏', () => {
  const calls = SRC.match(/this\._stripKatexMathml\(/g) || [];
  // exportImage / exportHTML / _preparePdfClone（PDF 主路径与回退共用）
  assert.ok(calls.length >= 3,
    `_stripKatexMathml 应至少被长图、HTML、PDF 三处调用，实得 ${calls.length} 处`);
  for (const fn of ['async exportImage()', 'async exportHTML()', 'async _preparePdfClone()']) {
    const body = sliceFn(fn, fn === 'async _preparePdfClone()' ? '// 回退路径用' : undefined);
    assert.ok(body.includes('this._stripKatexMathml('), `${fn} 未摘除 .katex-mathml 副本`);
  }
});

test('MathML 副本：只动导出副本，live preview 必须原样保留（DOCX 靠它取 OMML 源）', async () => {
  await withEditor({}, async (w, ed) => {
    ed.preview.innerHTML = '<p>前</p><span class="katex"><span class="katex-mathml"><math><mi>a</mi></math></span>'
      + '<span class="katex-html">a</span></span><p>后</p>';
    const clone = ed.preview.cloneNode(true);
    ed._stripKatexMathml(clone);
    assert.strictEqual(clone.querySelectorAll('.katex-mathml').length, 0, '副本里 MathML 未被移除');
    assert.strictEqual(clone.querySelectorAll('.katex-html').length, 1, '副本里可视化层被误删');
    assert.strictEqual(ed.preview.querySelectorAll('.katex-mathml').length, 1,
      'live preview 被改动 —— export-docx.js 正是从 .katex-mathml 取 <math> 转 OMML 的，会直接毁掉 DOCX 公式');
  });
});

// ---------------------------------------------------------------- 样式采集

test('样式采集：CSSOM 直读优先于 fetch（fetch 失败会静默变空串，是高亮/MathML 事故源头）', () => {
  const fnBody = sliceFn('_exportStyleFromLink(matchFn) {', '_absolutizeCssUrls');
  assert.ok(fnBody.includes('link.sheet'), '样式采集未经 <link>.sheet 读 CSSOM');
  assert.ok(fnBody.includes('cssRules'), '样式采集未读 cssRules');
  assert.ok(!/fetch\(/.test(fnBody), '样式采集仍依赖 fetch（失败即静默为空）');

  // exportHTML / exportImage 的 katex / hljs 一律走采集器，不得再裸 fetch
  for (const fn of ['async exportHTML()', 'async exportImage()']) {
    const body = sliceFn(fn, fn === 'async exportHTML()' ? 'async exportWord' : 'async exportPDF()');
    assert.ok(body.includes('this._exportStyleFromLink('), `${fn} 未使用样式采集器`);
    assert.ok(!/fetch\('lib\/katex/.test(body), `${fn} 仍在裸 fetch katex.min.css`);
  }
});

test('样式采集：KaTeX 字体 url 绝对化 / 内联（否则导出帧字体 404，公式字形退化）', () => {
  const absBody = sliceFn('_absolutizeCssUrls(css, baseHref) {', '导出帧不需要 KaTeX');
  assert.ok(absBody.includes('new URL(u, baseHref)'), '未按样式表位置解析相对 url');
  assert.match(absBody, /data:\|blob:\|https\?:\|file:/, '未跳过已是绝对的 url（会重复改写）');

  const inlineBody = sliceFn('async _inlineCssFonts(css, baseHref) {', '_waitImagesReady');
  assert.ok(inlineBody.includes('readAsDataURL'), '字体未内联为 data URI（SVG-as-image 不能加载外部资源）');
  assert.match(inlineBody, /woff2/, '未限定字体格式（会把整个字体目录塞进导出物）');
});

// ---------------------------------------------------------------- 导出 HTML

test('导出 HTML：复用阅读模式样式（不再用平行维护的 _documentExportCSS）+ 保留作用域根', () => {
  const body = sliceFn('async exportHTML() {', 'async exportWord');
  assert.ok(!body.includes('_documentExportCSS()'),
    'exportHTML 仍用 _documentExportCSS —— 与 styles.css 是两套平行实现，必然与阅读模式漂移');
  assert.ok(body.includes('this._inlineCssFonts('), '导出 HTML 未内联 KaTeX 字体（换机器打开公式字形退化）');
  assert.match(body, /<div class="\$\{containerClass\}">/,
    '导出 HTML 丢了 .preview-content 作用域根 —— styles.css 的阅读样式几乎全是它的后代选择器');
  assert.match(body, /data-theme="\$\{theme\}"/, '导出 HTML 未带 data-theme（主题变量取不到）');
  assert.ok(body.includes("this.t('exportingHTML')"), '导出 HTML 没有 loading 文案');
  assert.ok(/finally \{[\s\S]{0,160}?this\._hideExportOverlay\(\)/.test(body),
    '导出 HTML 的遮罩未在 finally 收尾（失败/取消会留全屏遮罩）');
});

// ---------------------------------------------------------------- 导出 PDF

test('导出 PDF：主路径走 PrintToPdf（无打印对话框 / 无下载气泡），失败回退系统打印', () => {
  const body = sliceFn('async exportPDF() {', 'async _preparePdfClone');
  assert.ok(body.includes('TauriApi.printToPdf('), 'exportPDF 未走 WebView2 PrintToPdf');
  assert.ok(body.includes('await dialogSave('), 'exportPDF 未先让用户选保存路径（PrintToPdf 直接落盘）');
  assert.ok(body.includes('this._exportViaSystemPrint('), 'exportPDF 缺系统打印回退（旧 WebView2 运行时会整条失败）');
  // 回退必须在 catch 里，而不是 finally
  const catchBlock = body.slice(body.indexOf('} catch (e) {'));
  assert.ok(catchBlock.includes('_exportViaSystemPrint('), '系统打印回退不在 catch 分支');
});

test('导出 PDF：打印态规则必须覆盖 styles.css 自带的 @media print（否则 UI 与遮罩被印进 PDF）', () => {
  const body = sliceFn('async exportPDF() {', 'async _preparePdfClone');
  // styles.css:8121 起的老 @media print 会用 #app{display:block!important} 把应用重新显示出来
  assert.match(body, /@media print \{[\s\S]{0,400}?html\.pdf-printing #app \{ display: none !important; \}/,
    '打印媒体里没有强制隐藏 #app —— PDF 第一页会印出标签栏和整块预览（实测过）');
  // 遮罩：屏幕规则与打印规则必须同一选择器，否则特异性低的那条压不住
  assert.match(body, /html\.pdf-printing #tm-export-overlay \{ display: flex !important; \}/,
    '屏幕态未保留遮罩');
  assert.match(body, /@media print \{[\s\S]{0,500}?html\.pdf-printing #tm-export-overlay \{ display: none !important; \}/,
    '打印态遮罩未用同一选择器隐藏（只写 #id 特异性不足，遮罩会被印进 PDF）');
  assert.ok(body.includes("document.body.classList.add('pdf-printing')"), '未进入打印态');
  assert.ok(body.includes("document.body.classList.remove('pdf-printing')"), '导出后未退出打印态');
});

test('导出 PDF 行为：PrintToPdf 成功后打印态 DOM 全部清理', async () => {
  await withEditor({ invokeImpl: (cmd) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.pdf';
    return null;
  } }, async (w, ed) => {
    let printed = null;
    ed.showConfirmDialog = async () => true;
    w.TauriApi.printToPdf = async (args) => { printed = args; };
    ed.activeTab.filePath = '/docs/note.md';
    ed.preview.innerHTML = '<p>段落</p>';

    await ed.exportPDF();

    assert.ok(printed, 'PrintToPdf 未被调用');
    assert.ok(printed.options && printed.options.path === '/tmp/out.pdf', '保存路径未透传给 PrintToPdf');
    assert.strictEqual(printed.options.pageWidth, 8.27, 'A4 页面宽度（英寸）不对');
    assert.strictEqual(printed.options.marginTop, 0.59, '页边距（1.5cm ≈ 0.59in）不对');

    assert.strictEqual(w.document.getElementById('pdf-print-root'), null, '打印态副本未移除');
    assert.strictEqual(w.document.getElementById('tm-pdf-print-style'), null, '打印态样式未移除');
    assert.strictEqual(w.document.getElementById('tm-export-expand-style'), null, '展开样式未移除');
    assert.strictEqual(w.document.getElementById('tm-export-overlay'), null, '遮罩未移除');
    assert.strictEqual(w.document.body.classList.contains('pdf-printing'), false, 'body 仍带 pdf-printing');
    assert.strictEqual(w.document.documentElement.classList.contains('pdf-printing'), false,
      'html 仍带 pdf-printing（会导致整页 UI 持续隐藏）');
  });
});

test('导出 PDF 行为：PrintToPdf 失败时回退系统打印，且打印态同样清理', async () => {
  await withEditor({ invokeImpl: (cmd) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.pdf';
    return null;
  } }, async (w, ed) => {
    let fallback = false;
    ed.showConfirmDialog = async () => true;
    w.TauriApi.printToPdf = async () => { throw new Error('WebView2 运行时过旧'); };
    ed._exportViaSystemPrint = async () => { fallback = true; };
    ed.activeTab.filePath = '/docs/note.md';
    ed.preview.innerHTML = '<p>段落</p>';

    await ed.exportPDF();

    assert.ok(fallback, 'PrintToPdf 失败后未回退到系统打印（旧 WebView2 上 PDF 导出会整个不可用）');
    assert.strictEqual(w.document.getElementById('pdf-print-root'), null, '回退后打印态副本未移除');
    assert.strictEqual(w.document.body.classList.contains('pdf-printing'), false, '回退后 body 仍带 pdf-printing');
  });
});

test('导出 PDF：回退帧自带完整 appCSS + KaTeX（不依赖网络）', () => {
  // 注意：_buildPdfPrintFrameHtml 在源码里位于 exportPDF 之后，结束标记必须取它的下一个方法
  const body = sliceFn('async _buildPdfPrintFrameHtml(clone) {', 'async _exportViaSystemPrint(');
  assert.ok(body.includes('this._exportStyleFromLink('), '回退打印帧未从 CSSOM 采集样式');
  assert.ok(body.includes('this._exportExpandRules('), '回退打印帧未展开滚动容器（只印一屏）');
  assert.ok(!/fetch\('lib\/katex/.test(body), '回退打印帧仍裸 fetch katex CSS');
});

// ---------------------------------------------------------------- 长图

test('长图：改由浏览器自己渲染（SVG foreignObject），不再用 html2canvas 的自带绘制器', () => {
  const body = sliceFn('async exportImage() {', 'async exportPDF');
  assert.ok(body.includes('XMLSerializer'), '长图未走 XMLSerializer（HTML 序列化不是 well-formed XML，SVG 会解析失败）');
  assert.ok(body.includes('foreignObject'), '长图未走 foreignObject');
  assert.ok(!body.includes('html2canvas('), '长图仍在调用 html2canvas（不支持 MathML/clip-path/color-mix，与阅读模式必然不一致）');
  assert.ok(body.includes('this._inlineCssFonts('), '长图未内联 KaTeX 字体（SVG-as-image 不能加载外部资源）');
});

test('长图：导出必须带 loading 遮罩并在 finally 收尾', () => {
  const body = sliceFn('async exportImage() {', 'async exportPDF');
  assert.ok(body.includes("this.t('generatingImg')"), '长图导出没有 loading 文案');
  assert.ok(/finally \{[\s\S]{0,240}?this\._hideExportOverlay\(\)/.test(body),
    '长图遮罩未在 finally 收尾');
});
