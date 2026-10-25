// 2026-10-28 用户要求：导出长图/PDF/DOCX 时，渲染态所有「超长滚动/裁切」容器必须展开显示全部，
// 不管设置里代码块选的是「滚动」还是「全部」——任何导出不得丢失内容。
//
// 渲染态滚动/裁切容器（styles.css）与三链路修复点：
//   .code-scroll（代码块 300px + overflow-y）/ table（display:block + overflow-x）/
//   .katex-display-wrapper/.math-display/.katex-display（overflow-x）/ .mermaid-container /
//   .md2-error pre
//   ① 长图 exportImage：clone 同文档内渲染态样式生效 → 注入按 clone id 作用域的展开 CSS
//      （finally 移除），画布宽度 max(800, 内容宽度) 兜底超宽内容
//   ② PDF exportPDF：打印帧载入完整 styles.css → printCSS 追加同口径覆盖
//   ③ HTML/DOCX _documentExportCSS：自有标签级样式表里公式/图表容器解除横向裁切 + 单元格断词
// 公共口径收口在 MarkdownEditor._exportExpandRules(scope)（避免三处口径漂移）。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { withEditor } = require('./helpers/app-env.cjs');

const ROOT = path.resolve(__dirname, '..');
const EXPORT_SRC = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'export.js'), 'utf8');

test('S88 源码口径：_exportExpandRules 公共展开方法覆盖全部滚动/裁切容器', () => {
  assert.match(EXPORT_SRC, /_exportExpandRules\(scope\) \{/,
    'export.js 缺 _exportExpandRules 公共展开口径（三链路应共用，防漂移）');
  const m = EXPORT_SRC.match(/_exportExpandRules\(scope\) \{[\s\S]*?\n      \},/);
  assert.ok(m, '无法定位 _exportExpandRules 方法体');
  const body = m[0];
  assert.ok(body.includes('.code-scroll { max-height: none !important; overflow: visible !important; }'),
    '展开口径缺代码块（.code-scroll 300px 裁解除除）');
  assert.ok(body.includes('pre { white-space: pre-wrap !important;'),
    '展开口径缺代码 pre-wrap（no-wrap 设置的长行导出裁切）');
  assert.ok(body.includes('table { display: table !important; overflow: visible !important; }'),
    '展开口径缺宽表（display:block + overflow-x 恢复 table 布局）');
  assert.ok(body.includes('td, ${p}th { overflow-wrap: break-word !important;'),
    '展开口径缺单元格断词（长 token 压缩换行防溢出）');
  assert.ok(body.includes('.mermaid-container { overflow: visible !important; }'),
    '展开口径缺图表容器横向裁切解除');
  assert.ok(body.includes('.katex-display-wrapper, ${p}.math-display, ${p}.katex-display { overflow: visible !important; }'),
    '展开口径缺公式容器横向裁切解除');
  assert.ok(body.includes('.md2-error pre { overflow: visible !important; }'),
    '展开口径缺表格错误回显横向裁切解除');
});

test('S88 长图：exportImage 注入作用域展开 CSS + 宽度兜底 + data:URL + finally 清理', () => {
  // 2026-10-25 长图换渲染引擎（html2canvas → SVG foreignObject），断言随之改锚点，
  // 但守的是同一组约束：展开口径必须按导出副本作用域、宽度按内容兜底、结束必须清理干净。
  assert.ok(EXPORT_SRC.includes("host.id = 'tm-png-export-root';"),
    'exportImage 未给导出副本设作用域 id（展开 CSS 无法只作用于副本）');
  assert.ok(EXPORT_SRC.includes("expandStyle.id = 'tm-export-expand-style';"),
    'exportImage 未注入展开样式节点');
  assert.ok(EXPORT_SRC.includes("expandStyle.textContent = this._exportExpandRules('#tm-png-export-root');"),
    'exportImage 展开样式未走公共口径（_exportExpandRules）');
  assert.ok(EXPORT_SRC.includes('const W = Math.max(800, Math.ceil(host.scrollWidth));'),
    'exportImage 画布宽度未按内容兜底（超宽公式/宽表会裁切）');
  // SVG 必须以 data: URL 交给 <img>：blob: 形式的 SVG 画进 canvas 会污染画布，
  // toDataURL 直接抛 SecurityError（实测），整条长图导出会失败。
  assert.ok(EXPORT_SRC.includes("'data:image/svg+xml;base64,' + btoa(svgBin)"),
    'exportImage 的 SVG 未走 data: URL（blob: 会污染 canvas，toDataURL 抛 SecurityError）');
  assert.ok(!/new Blob\(\[svgMarkup\]/.test(EXPORT_SRC),
    'exportImage 仍在用 Blob 包装 SVG（blob: URL 会污染 canvas）');
  // canvas 上限自适应：超长文档必须降 scale 而不是裁内容
  assert.match(EXPORT_SRC, /const MAX_SIDE = 32767;[\s\S]{0,300}?Math\.sqrt\(MAX_AREA \/ \(W \* H\)\)/,
    'exportImage 未按 canvas 上限（单边 32767 / 面积 268MP）自适应降 scale');
  // finally 清理（顺序：先展开样式后导出副本）
  assert.match(EXPORT_SRC,
    /finally \{[\s\S]{0,300}?expandStyle\.parentNode\.removeChild\(expandStyle\);[\s\S]{0,200}?host\.parentNode\.removeChild\(host\);/,
    'exportImage finally 未清理展开样式/导出副本（会残留作用域 CSS 与离屏 DOM）');
});

test('S88 PDF：printCSS 使用公共展开口径（宽表/公式不再裁切）', () => {
  assert.ok(EXPORT_SRC.includes('${this._exportExpandRules(\'.preview-content\')}'),
    'PDF printCSS 未走公共展开口径（打印帧载入完整 styles.css，必须覆盖渲染态滚动规则）');
  // 旧的去重行应已收口（不再单独手写 code-scroll 展开，避免双份口径）
  const printSection = EXPORT_SRC.slice(EXPORT_SRC.indexOf('const printCSS'));
  assert.ok(!printSection.includes('.code-scroll { max-height: none !important; overflow: visible !important; }'),
    'printCSS 残留手写的 code-scroll 展开行（应只保留 _exportExpandRules 一份）');
});

test('S88 HTML/DOCX：_documentExportCSS 公式/图表容器解除横向裁切 + 单元格断词', () => {
  assert.match(EXPORT_SRC, /\.math-display \{ display: block; text-align: center; margin: 16px 0; overflow: visible; \}/,
    '_documentExportCSS 的 .math-display 仍 overflow-x:auto（宽公式导出裁切）');
  assert.match(EXPORT_SRC, /\.mermaid-container \{[\s\S]{0,200}overflow: visible; \}/,
    '_documentExportCSS 的 .mermaid-container 仍 overflow-x:auto（宽图表导出裁切）');
  assert.ok(EXPORT_SRC.includes('th, td { padding: 8px 12px; border: 1px solid #d4d4d8; text-align: left; overflow-wrap: break-word; word-break: break-word; }'),
    '_documentExportCSS 单元格缺断词（宽表长 token 溢出页面）');
});

test('S88 长图行为：导出失败也必须清理副本文档节点与遮罩（finally 兜底）', async () => {
  // jsdom 没有真实布局与 canvas：exportImage 会在「内容高度为 0」处抛错。
  // 这条用例守的正是 finally —— 导出失败/取消都不能留下离屏副本、作用域 CSS 和全屏遮罩。
  await withEditor({ invokeImpl: (cmd) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.png';
    if (cmd === 'write_binary_file') return undefined;
    return null;
  } }, async (w, ed) => {
    ed.activeTab.filePath = '/docs/note.md';
    w.editor.preview.innerHTML = '<p>段落</p><pre><code class="hljs"><div class="code-scroll"><span class="code-line">x</span></div></code></pre>';

    await ed.exportImage();

    assert.strictEqual(w.document.getElementById('tm-png-export-root'), null, '导出后离屏副本未移除');
    assert.strictEqual(w.document.getElementById('tm-export-expand-style'), null, '导出后展开样式节点未移除');
    assert.strictEqual(w.document.getElementById('tm-export-overlay'), null, '导出后全屏遮罩未移除');
  });
});
