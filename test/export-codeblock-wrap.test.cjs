// 导出（HTML / PDF）代码块换行 + 全量展开回归测试
//
// 历史根因（两条都还在守）：
//   - 导出 HTML 的代码块不换行，出现横向滚动条（用户："导出 html 时，代码框里没有换行了"）；
//   - 导出 PDF 的代码块带横竖滚动条，看不全代码（用户："导出PDF，代码带有横向竖向滚动条"）。
//
// 2026-10-25 架构变更：三个导出链路（HTML / PDF / 长图）不再各自手写一套 CSS，
// 统一改为「CSSOM 直读完整 styles.css」+ 导出侧 `_exportExpandRules()` 全量展开。
// 因此断言口径也随之改变：
//   · 「样式来自 styles.css」 —— 断言导出文档里确实带着 styles.css 的 pre / .code-line 规则；
//   · 「导出不丢内容」 —— 断言导出侧展开规则带 !important，能压住 styles.css 的
//     `.code-scroll{max-height:300px}` 和 `.preview-content:not(.code-wrap) .code-line-text{white-space:pre}`。
//
// 测试环境注意：jsdom 不加载外链样式表（`link.sheet` 恒为 null），CSSOM 采集在测试里恒为空串。
// 故这里把**真实** styles.css 文本灌进采集器 —— 既验证 appCSS 真的拼进导出文档，
// 也避免断言退化成「导出侧自己写了什么」的自说自话。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const pathMod = require('node:path');
const { withEditor } = require('./helpers/app-env.cjs');

const REAL_STYLES_CSS = fs.readFileSync(pathMod.join(__dirname, '../src/styles.css'), 'utf8');
const REAL_STYLES_BASE = 'http://localhost/src/styles.css';

function stubStyleCollect(ed) {
  ed._exportStyleFromLink = () => ({ css: REAL_STYLES_CSS, base: REAL_STYLES_BASE });
}

test('exportHTML: 代码块来自 styles.css + 导出侧全量展开（静态文档没有 JS 去开滚动条）', async () => {
  const captured = {};
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.html';
    if (cmd === 'write_file') { captured.content = args.content; return undefined; }
    return null;
  } }, async (w, ed) => {
    stubStyleCollect(ed);
    ed.activeTab.filePath = '/docs/note.md';
    w.editor.preview.innerHTML =
      '<pre><code>function longLineDemo() {\n  const x = "这是一行非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常长的代码，需要换行才能看全";\n}</code></pre>';

    await ed.exportHTML();

    assert.ok(captured.content, '应写出 HTML');
    const c = captured.content;

    // ① 阅读样式确实来自 styles.css（唯一的样式真源）
    assert.ok(
      /\.preview-content pre\s*\{[^}]*background-color:\s*var\(--code-bg\)/.test(c),
      '导出文档未带上 styles.css 的 .preview-content pre 规则（样式没进导出 → 与阅读模式必然不一致）',
    );
    assert.ok(/\.code-line\s*\{[^}]*display:\s*flex/.test(c),
      '导出文档缺 .code-line display:flex（code-block.js 输出的 .code-line 会全挤成一行）');
    assert.ok(/\.code-line-text\s*\{[^}]*white-space:\s*pre-wrap/.test(c),
      '导出文档缺 .code-line-text 规则');

    // ② 导出侧展开规则：必须 !important 才压得住 styles.css 的裁切/不换行
    assert.match(c, /pre \{ white-space: pre-wrap !important/, '导出 HTML 的 pre 未强制换行');
    assert.match(c, /pre \{ white-space: pre-wrap !important[^}]*overflow: visible !important/,
      '导出 HTML 的 pre 溢出未可见（仍会出滚动条）');
    assert.match(c, /\.code-line-text \{ white-space: pre-wrap !important/,
      '.code-line-text 未强制换行 —— 关掉「代码块换行」设置时 styles.css 给的是 white-space:pre');
    assert.match(c, /\.code-scroll \{ max-height: none !important; overflow: visible !important; \}/,
      '.code-scroll 未展开 —— 静态文档里超过 300px 的代码会被直接裁掉（没有任何滚动条可救）');
    // 注意排除 .preview-content .md2-error pre —— 解析错误回显块**故意**保留横向滚动，
    // 且已由 _exportExpandRules 的 `.md2-error pre { overflow: visible !important }` 展开。
    assert.ok(!/(?<!md2-error )pre\s*\{[^}]*overflow-x:\s*auto/.test(c),
      '导出 HTML 的 pre 不应含 overflow-x: auto');
  });
});

test('exportHTML: code.hljs 背景透明（styles.css 同源，修复"内白外灰"）', async () => {
  // hljs 主题里 .hljs 元素带 background:#ffffff，pre 内会叠一层白底盖住 pre 的灰底。
  // 现在「预览 / PDF / 导出 HTML」三处共用 styles.css 里那两条 !important 规则，
  // 只要 appCSS 真的进了导出文档，导出侧就自动一致。
  const captured = {};
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.html';
    if (cmd === 'write_file') { captured.content = args.content; return undefined; }
    return null;
  } }, async (w, ed) => {
    stubStyleCollect(ed);
    ed.activeTab.filePath = '/docs/note.md';
    w.editor.preview.innerHTML = '<pre><code class="hljs language-js">const x = 1;</code></pre>';
    await ed.exportHTML();
    assert.ok(captured.content, '应写出 HTML');
    const c = captured.content;

    assert.ok(
      /\.preview-content pre code\.hljs[^{]*\{[^}]*background:\s*transparent\s*!important/.test(c),
      '导出文档未带 .preview-content pre code.hljs 透明背景规则（!important 才能压住 hljs 主题 #fff）',
    );
    assert.ok(
      /\.preview-content pre \.hljs[^{]*\{[^}]*background:\s*transparent\s*!important/.test(c),
      '导出文档未带 .preview-content pre .hljs 透明背景规则（漏掉 token span 仍会白底）',
    );
    // 防退化：不能退回 background:none —— 同特异性会被 .hljs 反压
    assert.ok(
      !/pre\s+code\s*\{[^}]*background:\s*none\b/.test(c),
      'pre code 不能再用 background:none（specificity 不如 .hljs）',
    );
  });
});

test('exportHTML: 代码块背景取自主题 --code-bg（与阅读模式同源，不再硬编码 #f6f5f4）', async () => {
  // 历史：导出模板曾硬编码 pre 背景 #f0efee → #e8e8e8 → #f6f5f4，与阅读模式（--code-bg）
  // 永远差一档色，这正是「导出与阅读模式不一致」的一类成因。现在 pre 背景完全由
  // styles.css 的 var(--code-bg) 决定，导出文档带 data-theme 让变量能解析。
  const captured = {};
  await withEditor({ invokeImpl: (cmd, args) => {
    if (cmd === 'plugin:dialog|save') return '/tmp/out.html';
    if (cmd === 'write_file') { captured.content = args.content; return undefined; }
    return null;
  } }, async (w, ed) => {
    stubStyleCollect(ed);
    ed.activeTab.filePath = '/docs/note.md';
    await ed.exportHTML();
    assert.ok(captured.content, '应写出 HTML');
    const c = captured.content;

    assert.match(c, /\.preview-content pre\s*\{[^}]*background-color:\s*var\(--code-bg\)/,
      '导出文档的 pre 背景不是 var(--code-bg)（与阅读模式不同源）');
    // 主题变量必须能解析：导出文档根节点带 data-theme
    assert.match(c, /<html[^>]*data-theme="[^"]+"/, '导出文档未带 data-theme，--code-bg 取不到值');
    const m = /--code-bg:\s*(#[0-9a-fA-F]{3,8})/.exec(c);
    assert.ok(m, '导出文档里没有 --code-bg 定义（pre 背景会退化成透明/白）');
    assert.ok(!/^#fff{1,2}$/i.test(m[1]) && !/^#ffffff$/i.test(m[1]),
      `--code-bg 不该是纯白（实际 ${m[1]}）—— 代码块在白底页面上要能看出灰底`);
  });
});

test('exportPDF: 回退打印帧显式让 pre 换行且溢出可见（无滚动条）', async () => {
  // PDF 主路径是 WebView2 PrintToPdf（直接落盘、无打印对话框），回退路径才建 iframe。
  // 两条路径共用 `_preparePdfClone` + `_buildPdfPrintFrameHtml` 的打印帧，故这里直接
  // 校验打印帧内容，比去拦 iframe 更稳（jsdom 不会真的加载 srcdoc）。
  await withEditor({}, async (w, ed) => {
    stubStyleCollect(ed);
    ed.activeTab.name = 'DEMO.md';
    ed.preview.innerHTML = '<pre><code class="hljs">const x = 1;</code></pre>';
    const doc = await ed._buildPdfPrintFrameHtml(ed.preview.cloneNode(true));

    // printCSS 中的 pre 规则应强制换行 + 溢出可见
    assert.ok(doc.includes('.preview-content pre { white-space: pre-wrap !important'),
      'printCSS 应含 .preview-content pre 换行规则');
    assert.ok(doc.includes('.code-scroll { max-height: none !important; overflow: visible !important; }'),
      'printCSS 应展开 .code-scroll（否则超 300px 的代码被裁掉）');
    assert.ok(doc.includes('.code-line-text { white-space: pre-wrap !important'),
      'printCSS 应让 .code-line-text 换行');
    // 不应出现会触发横向滚动的 overflow-x: auto（作用于 pre；.md2-error pre 见上一条用例说明）
    assert.ok(!/(?<!md2-error )pre\s*\{[^}]*overflow-x:\s*auto/.test(doc),
      '打印帧的 pre 不应含 overflow-x: auto');
    // 关键：导出 PDF 必须显式块级化 .code-line 行结构（不依赖 styles.css 采集成功）
    assert.match(doc, /\.code-line\s*\{[^}]*display:\s*flex\s*!important/,
      'printCSS 应让 .code-line display:flex !important（每行独占一行）');
    assert.match(doc, /\.code-line-text\s*\{[^}]*flex:\s*1 1 auto\s*!important/,
      'printCSS 应让 .code-line-text 可伸缩（长行才压得下）');
  });
});

test('styles.css: .hljs 元素背景透明——统一用 pre 的 --code-bg（修复"内白外灰"）', async () => {
  // 根因：hljs 主题（github.css）里 .hljs 元素带 background:#ffffff；
  // pre 内是 display:block + padding:1em，会在 pre 的 var(--code-bg) 灰色之上叠一层白底，
  // 形成"灰色外框 + 白色内框"的双层背景。用户在 PDF 导出后尤其明显（"灰色中有白色"）。
  // 修复：styles.css 加 .preview-content pre code.hljs / .hljs { background: transparent }。
  // 现在这条规则是三条导出链路的共同真源，改动它必须跑本文件全部用例。
  const css = REAL_STYLES_CSS;
  assert.ok(
    /\.preview-content\s+pre\s+code\.hljs[\s\S]{0,200}background:\s*transparent\s*!important/.test(css),
    'styles.css 应让 .preview-content pre code.hljs 背景透明（!important 覆盖 hljs 主题白底）',
  );
  // 不能只覆盖 .hljs 而漏掉 pre code.hljs（hljs 主题里 pre code.hljs 才是 pre 内主块）
  assert.ok(
    /\.preview-content\s+pre\s+\.hljs[\s\S]{0,200}background:\s*transparent\s*!important/.test(css),
    'styles.css 应让 .preview-content pre .hljs 背景透明',
  );
});

test('exportPDF: 回退打印帧带上 appCSS（.hljs 灰底一致由 styles.css 保证）', async () => {
  // 与上一条对称：PDF 打印帧注入的就是 styles.css 采集结果，只要它没落进帧里，
  // 上面那两条 .hljs 透明规则就形同虚设（hljs 主题的 #ffffff 会盖住 pre 的灰底）。
  await withEditor({}, async (w, ed) => {
    stubStyleCollect(ed);
    ed.activeTab.name = 'NOTE.md';
    ed.preview.innerHTML = '<pre><code class="hljs">const x = 1;</code></pre>';
    const doc = await ed._buildPdfPrintFrameHtml(ed.preview.cloneNode(true));

    assert.ok(
      /\.preview-content\s+pre\s+code\.hljs[\s\S]{0,200}background:\s*transparent\s*!important/.test(doc),
      '打印帧未带 styles.css 的 .hljs 透明规则（appCSS 没落地）',
    );
    assert.ok(
      /\.preview-content\s+pre\s+\.hljs[\s\S]{0,200}background:\s*transparent\s*!important/.test(doc),
      '打印帧未带 styles.css 的 .hljs 透明规则（appCSS 没落地）',
    );
  });
});
