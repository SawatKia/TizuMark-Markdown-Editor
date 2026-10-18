// P2-3 vendor 锁定（沿用 5f5b23e 范式）
//
// 从 node_modules 把 5 个运行时依赖（已在 dependencies）复制到 src/lib 的 vendor 子树，
// 使「vendor 文件」成为可由 node_modules 确定性再生的产物，而非手改的游离副本。
// 比「删 src/lib 改 npm 导入」更可逆：index.html 的 <script> 路径不变，只是内容改为由本脚本生成。
//
// 接入点：
//   - package.json "prepare"：npm install / npm ci 后自动重建 vendor（CI 用完整安装）。
//
// highlight.js 纳入再生（2026-08-01 升级 11.11.1）：
//   node_modules 的 highlight.js 包不发布浏览器 UMD 版 highlight.min.js（全局 hljs），
//   故用 esbuild 从 node_modules 现打包；入口必须【三路兼容】（window / globalThis /
//   module.exports）：浏览器 <script> 走 window.hljs，而测试 loadHljs 走
//   new Function('window','self','module','exports', code) 读 module.exports ——
//   历史 code-block「4 例退化」的根因即只设 globalThis.hljs 导致 loadHljs 拿到空对象，
//   并非 11.9.0→11.11.1 的高亮输出差异（已 A/B 验证）。styles/languages/common/core
//   从 node_modules 精确复制，版本与 package.json 声明（^11.10.0，实际 11.11.1）对齐。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LIB = path.join(ROOT, 'src', 'lib');
const NM = path.join(ROOT, 'node_modules');

// 复制：src 文件 -> dest 文件；src 目录 -> dest 目录（递归）。
function copyPath(src, dest) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const ent of fs.readdirSync(src)) {
      if (ent === 'node_modules' || ent === '.bin') continue;
      copyPath(path.join(src, ent), path.join(dest, ent));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

// 显式 manifest：node_modules 源 -> src/lib 目标。目录会被整体递归复制。
// 仅含「映射干净、版本与 package.json 完全一致」的 5 个库；highlight.js 见上说明，已排除。
const MANIFEST = [
  // codemirror（npm 包根有 mode/addon/theme，核心在 lib/）
  ['codemirror/lib/codemirror.js', 'codemirror/codemirror.js'],
  ['codemirror/lib/codemirror.css', 'codemirror/codemirror.css'],
  ['codemirror/mode', 'codemirror/mode'],
  ['codemirror/addon', 'codemirror/addon'],
  ['codemirror/theme', 'codemirror/theme'],
  // katex
  ['katex/dist/katex.min.js', 'katex/katex.min.js'],
  ['katex/dist/katex.min.css', 'katex/katex.min.css'],
  ['katex/dist/contrib/auto-render.min.js', 'katex/auto-render.min.js'],
  ['katex/dist/fonts', 'katex/fonts'],
  // mermaid
  ['mermaid/dist/mermaid.min.js', 'mermaid/mermaid.min.js'],
  // html2canvas（单文件）
  ['html2canvas/dist/html2canvas.min.js', 'html2canvas.min.js'],
  // markdown-it（单文件）
  ['markdown-it/dist/markdown-it.min.js', 'markdown-it.min.js'],
  // html-docx-js（单文件 UMD，自带 jszip；导出 Word .docx 用，挂 window.htmlDocx）
  ['html-docx-js/dist/html-docx.js', 'html-docx.min.js'],
  // highlight.js：highlight.min.js 用 esbuild 打包（见 buildHighlightMin），
  // 其余伴随文件从 node_modules 精确复制（styles/languages/common/core）
  ['highlight.js/styles/github.min.css', 'highlight.js/github.min.css'],
  ['highlight.js/styles/github.css', 'highlight.js/github.css'],
  ['highlight.js/styles/github-dark.min.css', 'highlight.js/github-dark.min.css'],
  ['highlight.js/styles/github-dark.css', 'highlight.js/github-dark.css'],
  // 注意：不复制 highlight.js/lib/common.js、lib/core.js —— node_modules 无包根 ESM shim，
  // 且全仓库无任何引用（index.html/app.js/测试均不用），避免生成错位内容。
  ['highlight.js/lib/languages', 'highlight.js/languages'],
];

// highlight.min.js：esbuild 现打包一个全局 hljs（三路兼容，见头部说明）。
async function buildHighlightMin() {
  const esbuild = await import('esbuild');
  const outfile = path.join(LIB, 'highlight.js', 'highlight.min.js');
  const contents = [
    "import hljs from 'highlight.js';",
    "if (typeof window !== 'undefined') window.hljs = hljs;",
    "if (typeof globalThis !== 'undefined') globalThis.hljs = hljs;",
    "if (typeof module !== 'undefined' && module.exports) module.exports = hljs;",
  ].join('\n');
  await esbuild.build({
    stdin: { contents, resolveDir: ROOT, loader: 'js' },
    bundle: true,
    format: 'iife',
    minify: true,
    outfile,
    logLevel: 'silent',
  });
  console.log('[ensure-vendor] 打包 highlight.min.js（三路兼容 global hljs）完成');
}

// docx 库（v9.7.1，ESM，无浏览器 UMD）：esbuild 现打包为 IIFE 全局 DocxLib。
// docx 入口用 node_modules/docx/dist/index.mjs（package.json "module"），供 worker 的
// importScripts('./docx.min.js') 使用。无 Buffer/stream 报错，无需 shim。
async function buildDocxMin() {
  const esbuild = await import('esbuild');
  const outfile = path.join(LIB, 'docx.min.js');
  const contents = "export * from 'docx';";
  await esbuild.build({
    stdin: { contents, resolveDir: ROOT, loader: 'js' },
    bundle: true,
    format: 'iife',
    globalName: 'DocxLib',
    minify: true,
    outfile,
    logLevel: 'silent',
  });
  console.log('[ensure-vendor] 打包 docx.min.js（全局 DocxLib）完成');
}

// mathml2omml（MathML → OMML 转换，Word 可编辑公式）：esbuild 打包为 IIFE 全局 MathML2OMML。
// 入口用 ESM 构建（dist/index.esm.js；CJS 入口引用 module.exports，浏览器 IIFE 缺该全局会抛错）。
// 主线程 DOCX 导出把 KaTeX 的 <math> 转成 OMML 字符串，随 structure 传给 worker 注入 oMath。
async function buildMathML2OMML() {
  const esbuild = await import('esbuild');
  const outfile = path.join(LIB, 'mathml2omml.min.js');
  await esbuild.build({
    entryPoints: [path.join(NM, 'mathml2omml', 'dist', 'index.esm.js')],
    bundle: true,
    format: 'iife',
    globalName: 'MathML2OMML',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    outfile,
    logLevel: 'silent',
  });
  console.log('[ensure-vendor] 打包 mathml2omml.min.js（全局 MathML2OMML）完成');
}

// @mermaid-js/layout-elk（mermaid 11 的 ELK 布局插件，独立包、仅 ESM 无 UMD）：
// esbuild 打包为 IIFE 全局 MermaidElkLayouts（三路兼容同 highlight.min.js）。
// 入口用官方预压缩 dist/mermaid-layout-elk.esm.min.mjs（其 chunks 已 minify；
// 从 core.mjs 打包会拉入未压缩 chunks，产物 ~5MB，用 esm.min 约 2MB）。
// 不注册时 mermaid 对 frontmatter `config: layout: elk` 抛「Unknown layout algorithm: elk」
// 整图渲染失败；注册入口在 preview-post.js 顶部（registerLayoutLoaders 一次即全局生效）。
async function buildMermaidElkLayouts() {
  const esbuild = await import('esbuild');
  const outfile = path.join(LIB, 'mermaid', 'mermaid-layout-elk.min.js');
  const contents = [
    "import elkLayouts from '@mermaid-js/layout-elk/dist/mermaid-layout-elk.esm.min.mjs';",
    "if (typeof window !== 'undefined') window.MermaidElkLayouts = elkLayouts;",
    "if (typeof globalThis !== 'undefined') globalThis.MermaidElkLayouts = elkLayouts;",
    "if (typeof module !== 'undefined' && module.exports) module.exports = elkLayouts;",
  ].join('\n');
  await esbuild.build({
    stdin: { contents, resolveDir: ROOT, loader: 'js' },
    bundle: true,
    format: 'iife',
    minify: true,
    platform: 'browser',
    target: 'es2020',
    outfile,
    logLevel: 'silent',
  });
  console.log('[ensure-vendor] 打包 mermaid-layout-elk.min.js（全局 MermaidElkLayouts）完成');
}

await buildHighlightMin();
await buildDocxMin();
await buildMathML2OMML();
await buildMermaidElkLayouts();

let missing = 0;
for (const [relSrc, relDest] of MANIFEST) {
  const src = path.join(NM, relSrc);
  const dest = path.join(LIB, relDest);
  if (!fs.existsSync(src)) {
    console.error(`[ensure-vendor] 缺失源：${relSrc}（node_modules 未安装？）`);
    missing++;
    continue;
  }
  copyPath(src, dest);
}

if (missing > 0) {
  console.error(`[ensure-vendor] 有 ${missing} 个源缺失，vendor 不完整。请先 npm install。`);
  process.exit(1);
}

// TizuMark CM5 本地补丁（2026-10-21 WYSIWYG「输入文字页面乱跳」修复）：
// codemirror.js 是从 node_modules 确定性再生的 vendor 副本（src/lib/codemirror/ 在
// .gitignore 内、不进 git），下列两处修复只存在于该文件——每次复制后必须在此重新打，
// 否则下一次 npm install / npm ci 会抹掉修复、乱跳/跳顶静默复发。
// 口径：严格字符串替换。已含 marker = 幂等跳过；锚点消失且无 marker = vendor 源码
// 变了（CM 升级等）→ 必须失败显式报出，绝不静默跳过（静默 = 修复悄悄丢失）。
function applyTizuMarkCm5Patches() {
  const dest = path.join(LIB, 'codemirror', 'codemirror.js');
  let code = fs.readFileSync(dest, 'utf8');
  const patches = [
    {
      // 已渲染行保留实测行高：WYSIWYG 遮罩是行内 markText(replacedWith)，估算式
      // widgetsHeight+文本行高会把 2600px TOC 遮罩行/340px 图片行重置回 ~15px，
      // lineWrapping 下每次 refresh 都跑本函数 → 操作末 mustScroll 单跳数千 px 跳顶。
      name: 'estimateLineHeights 跳过已渲染行（WYSIWYG 遮罩行保留实测行高）',
      marker: 'if (rendered.has(line)) return;',
      from: 'function estimateLineHeights(cm) {\n    var doc = cm.doc, est = estimateHeight(cm);\n    doc.iter(function (line) {\n      var estHeight = est(line);\n      if (estHeight != line.height) { updateLineHeight(line, estHeight); }\n    });\n  }',
      to: 'function estimateLineHeights(cm) {\n    var doc = cm.doc, est = estimateHeight(cm);\n    // TizuMark 补丁（2026-10-21 WYSIWYG 不跳顶）：已渲染（display.view 在视口内）的行保留实测行高，\n    // 不做启发式估算——WYSIWYG 遮罩是行内 markText(replacedWith) 节点（非 line.widgets），估算式\n    // 会把 TOC 大遮罩行/图片行重置回单行高，lineWrapping 下每次 refresh 重估 → 操作末\n    // updateHeightsInViewport 按「实测 − 被重置记录值」补偿 scroller.scrollTop，单跳可达数千 px。\n    // 未渲染行照旧估算（滚动条预估所需，原语义不变）。\n    var view = cm.display.view, rendered = new WeakSet();\n    for (var i = 0; i < view.length; i++) {\n      var vl = view[i] && view[i].line;\n      if (vl) rendered.add(vl);\n    }\n    doc.iter(function (line) {\n      if (rendered.has(line)) return;\n      var estHeight = est(line);\n      if (estHeight != line.height) { updateLineHeight(line, estHeight); }\n    });\n  }',
    },
    {
      // refresh 以真实滚动重同步：原生滚动锚定在 CM 操作之外移动真实滚动条，
      // doc.scrollTop 只在操作末同步；按陈旧 doc 值做 pending 重断言会把已修正
      // 位置改回，上层 delta 补偿再二次计入（实测 2570 vs 3161 → 1182px 过冲）。
      name: 'refresh() 首句以真实 scroller 滚动同步 doc.scrollTop',
      marker: 'if (this.display.wrapper.offsetHeight) { this.doc.scrollTop = this.display.scroller.scrollTop; }',
      from: 'refresh: methodOp(function() {\n        var oldHeight = this.display.cachedTextHeight;\n        regChange(this);',
      to: 'refresh: methodOp(function() {\n        var oldHeight = this.display.cachedTextHeight;\n        // TizuMark 补丁（2026-10-21 WYSIWYG 不跳顶）：浏览器原生滚动锚定会在视口上方内容高度变化时\n        // （遮罩占位缩放等，CM 操作之外）移动真实滚动条，而 doc.scrollTop 只在操作结束才同步；\n        // 按陈旧 doc 值做 pending 重断言会把已被修正的实际位置改回，上层 delta 补偿再二次计入\n        // （harness 实测 TOC 占位窗口内真实滚动 3161 vs doc.scrollTop 2570，最终 1182px 过冲）。\n        // 与 endOperation_finish 的同步方向一致：以真实当前滚动为准。\n        if (this.display.wrapper.offsetHeight) { this.doc.scrollTop = this.display.scroller.scrollTop; }\n        regChange(this);',
    },
  ];
  let bad = 0;
  for (const p of patches) {
    if (code.indexOf(p.marker) !== -1) {
      console.log('[ensure-vendor] CM5 补丁已在（幂等跳过）：' + p.name);
      continue;
    }
    if (code.indexOf(p.from) === -1) {
      console.error(`[ensure-vendor] CM5 补丁锚点未找到：${p.name}（vendor 源码已变化，须更新补丁；拒绝继续以免修复静默丢失）`);
      bad++;
      continue;
    }
    code = code.replace(p.from, p.to);
    console.log('[ensure-vendor] CM5 补丁已应用：' + p.name);
  }
  fs.writeFileSync(dest, code);
  if (bad > 0) {
    console.error(`[ensure-vendor] ${bad} 个 CM5 补丁未应用，vendor 不完整`);
    process.exit(1);
  }
}

applyTizuMarkCm5Patches();

console.log('[ensure-vendor] vendor 同步完成：src/lib（codemirror/katex/mermaid/html2canvas/markdown-it/highlight.js）');
