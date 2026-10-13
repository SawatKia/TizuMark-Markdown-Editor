// 阶段1 回归测试：三模式（阅读 / 源码 / 实时预览）骨架。
//
// 覆盖本次改动的行为契约：
//   1. 顶部三钮存在且文案为新名（阅读 / 源码 / 实时预览），data-mode 正确；
//   2. setViewMode 支持第三模式：切到 wysiwyg 写 viewMode、加 wysiwyg-mode 类、按钮 active；
//   3. Ctrl+\（toggleViewMode）三模式循环 阅读→源码→实时预览→阅读；
//   4. 类型守卫：非 Markdown（图片/明文）切实时预览被拦截并提示，不改状态；
//   5. 悬停简介 tooltip 挂载 + i18n key 齐全（三语言）。
//
// 静态断言走 readBundle()（app.js 已拆分到 modules/，不可直接 readFileSync('src/app.js')）。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { readBundle, ROOT } = require('./helpers/app-bundle.cjs');

const INDEX = path.join(ROOT, 'src', 'index.html');
const html = fs.readFileSync(INDEX, 'utf8');
const bundle = readBundle();

// ---------- 1. 顶部三钮结构与文案 ----------

test('顶部视图模式为三钮，且文案已重命名为 阅读/源码/实时预览', () => {
  assert.match(html, /id="btn-view-preview"/, '缺少 btn-view-preview');
  assert.match(html, /id="btn-view-edit"/, '缺少 btn-view-edit');
  assert.match(html, /id="btn-view-wysiwyg"/, '缺少 btn-view-wysiwyg（第三模式按钮）');

  // 只在 .view-mode-tabs 容器内断言文案，避免误伤设置面板里的「预览」分区名等
  const start = html.indexOf('class="view-mode-tabs"');
  assert.ok(start > 0, '未找到 .view-mode-tabs 容器');
  const block = html.slice(start, html.indexOf('</div>', html.indexOf('btn-view-wysiwyg')) + 6);
  assert.doesNotMatch(block, />\s*预览\s*<\/span>/, '模式按钮仍写「预览」，应改为「阅读」');
  assert.doesNotMatch(block, />\s*编辑\s*<\/span>/, '模式按钮仍写「编辑」，应改为「源码」');
  assert.match(block, />\s*阅读\s*<\/span>/);
  assert.match(block, />\s*源码\s*<\/span>/);
  assert.match(block, />\s*实时预览\s*<\/span>/);

  assert.match(html, /data-mode="preview"/);
  assert.match(html, /data-mode="edit"/);
  assert.match(html, /data-mode="wysiwyg"/);
});

test('三钮均带 data-tip-key（悬停简介数据源），且不再用原生 title', () => {
  const keys = [...html.matchAll(/data-tip-key="([^"]+)"/g)].map(m => m[1]);
  assert.deepStrictEqual(
    keys.slice(0, 3),
    ['viewModeReadTip', 'viewModeSourceTip', 'viewModeWysiwygTip'],
    '三钮 tip-key 缺失或顺序不对'
  );
  // 原生 title 延迟高、无法多行、样式不可控，本阶段统一改自定义 tooltip
  const tabsBlock = html.slice(html.indexOf('view-mode-tabs'), html.indexOf('view-mode-tabs') + 2000);
  assert.doesNotMatch(tabsBlock, /title="(预览模式|编辑模式)"/, '三钮仍在用原生 title');
});

// ---------- 2. setViewMode / applyViewMode 支持第三模式 ----------

test('applyViewMode 依据 viewMode 切换三钮 active 并挂 wysiwyg-mode 类', () => {
  assert.match(bundle, /btn-view-wysiwyg/, 'theme.js 未引用第三模式按钮');
  assert.match(bundle, /classList\.add\('wysiwyg-mode'\)/, '缺少 wysiwyg-mode 容器类');
  assert.match(
    bundle,
    /classList\.remove\('preview-mode',\s*'editor-collapsed',\s*'preview-collapsed',\s*'text-only',\s*'wysiwyg-mode'\)/,
    'applyViewMode 未在重置类名时清除 wysiwyg-mode（会导致模式切换后残留）'
  );
  assert.match(
    bundle,
    /btnWysiwyg\.classList\.toggle\('active',\s*this\.viewMode === 'wysiwyg'\)/,
    '第三钮 active 态未随 viewMode 切换'
  );
});

test('实时预览仅对 Markdown 开放：非 md 被 setViewMode 守卫拦截', () => {
  assert.match(
    bundle,
    /if \(_kind !== 'markdown' && mode === 'wysiwyg'\) \{[^}]*showToast[^}]*return;/s,
    '缺少「非 Markdown 不得切实时预览」的守卫'
  );
});

// ---------- 3. Ctrl+\ 三模式循环 ----------

test('toggleViewMode 为三模式循环（阅读→源码→实时预览→阅读）', () => {
  // 旧的二态实现必须已消失
  assert.doesNotMatch(
    bundle,
    /setViewMode\(this\.viewMode === 'preview' \? 'edit' : 'preview'\)/,
    'toggleViewMode 仍是旧的二态切换'
  );
  const m = bundle.match(/toggleViewMode\(\)\s*\{([\s\S]*?)\n\s{6}\},/);
  assert.ok(m, '未找到 toggleViewMode 实现');
  assert.match(m[1], /const order = \['preview',\s*'edit',\s*'wysiwyg'\]/, '循环顺序不是 阅读→源码→实时预览');
  assert.match(m[1], /order\[\(cur \+ 1\) % order\.length\]/, '未按顺序取下一模式（无法循环）');
});

// ---------- 4. 空行占位提示 ----------

test('空行占位提示：markText 实现 + 光标/输入事件均已接线', () => {
  assert.match(html, /<script src="modules\/empty-hint\.js"><\/script>/, 'index.html 未引入 empty-hint.js');
  assert.match(bundle, /Object\.assign\(MarkdownEditor\.prototype,\s*TMEmptyHint\.mixin\)/, 'TMEmptyHint mixin 未挂载');

  // 事件接线：change 与 cursorActivity 两处都要重算
  const coreChanges = bundle.match(/this\.cm\.on\('change',[\s\S]*?\n\s*\}\);/);
  assert.ok(coreChanges && /updateEmptyLineHint\(\)/.test(coreChanges[0]), 'change 事件未重算空行提示');
  // cursorActivity 段以 updateOutlineActive(cursor.line) 收尾（该行之后可能还有别的语句，故用宽松边界）
  const cursorIdx = bundle.indexOf("this.cm.on('cursorActivity'");
  assert.ok(cursorIdx > 0, '未找到 cursorActivity 绑定');
  const coreCursor = bundle.slice(cursorIdx, cursorIdx + 2000);
  assert.match(coreCursor, /updateEmptyLineHint\(\)/, 'cursorActivity 未重算空行提示（光标进出空行不增删）');
});

test('空行占位提示：仅独立空行显示，排除代码围栏内', () => {
  assert.match(bundle, /line\.trim\(\) === ''/, '未判定空行');
  assert.match(bundle, /isInsideFence/, '未排除代码围栏内的空行');
  assert.match(bundle, /\/\^`\{3,\}\|\^~\{3,\}\//, '围栏判定正则缺失');
  // 阅读模式无光标，不应显示提示
  assert.match(bundle, /if \(this\.viewMode === 'preview'\) return this\.clearEmptyLineHint\(\);/, '阅读模式不应显示空行提示');
});

test('空行占位提示：样式与 i18n 文案齐备（三语言）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  assert.match(css, /\.cm-empty-placeholder/, '缺少 .cm-empty-placeholder 样式');
  const i18n = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'i18n-data.js'), 'utf8');
  const hits = i18n.match(/emptyLineHint:/g) || [];
  assert.strictEqual(hits.length, 3, 'emptyLineHint 应在 zh/en/es 三语言各有一份');
});

// ---------- 5. i18n 文案完整性 ----------

test('三模式名与简介的 i18n key 在 zh/en/es 三语言齐备', () => {
  const i18n = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'i18n-data.js'), 'utf8');
  for (const key of ['viewModeRead', 'viewModeSource', 'viewModeWysiwyg',
                     'viewModeReadTip', 'viewModeSourceTip', 'viewModeWysiwygTip']) {
    const n = (i18n.match(new RegExp(`${key}:`, 'g')) || []).length;
    assert.strictEqual(n, 3, `${key} 应在 zh/en/es 各有一份，实际 ${n} 份`);
  }
  // 简介必须是可读长度（一两个字不算简介）
  assert.match(i18n, /viewModeWysiwygTip: '[^']{20,}'/, '所见即所得简介过短');
});

test('设置「默认视图」下拉新增实时预览选项', () => {
  const settings = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'settings.js'), 'utf8');
  const start = settings.indexOf('_selects.defaultView = new Select');
  assert.ok(start > 0, '未找到默认视图 Select');
  const block = settings.slice(start, start + 600);
  assert.match(block, /value: 'wysiwyg'/, '默认视图下拉缺少「实时预览」选项');
  // 选项文案改用新模式名
  assert.match(block, /t\('viewModeRead'\)/, '默认视图选项文案未用 viewModeRead');
  assert.match(block, /t\('viewModeSource'\)/, '默认视图选项文案未用 viewModeSource');
  assert.match(block, /t\('viewModeWysiwyg'\)/, '默认视图选项文案未用 viewModeWysiwyg');
});

// ---------- 6. 未保存保护 ----------

test('beforeunload 拦截未保存内容（防实时预览下静默丢失）', () => {
  const m = bundle.match(/window\.addEventListener\('beforeunload',[\s\S]*?\}\);\s*\n\s{2}\}/);
  assert.ok(m, '未找到 beforeunload 处理');
  assert.match(m[0], /t\.isModified/, 'beforeunload 未检查未保存标签');
  assert.match(m[0], /e\.preventDefault\(\)/, 'beforeunload 未 preventDefault（不会触发提示）');
  assert.match(m[0], /e\.returnValue = ''/, '缺少 returnValue 兜底（旧内核兼容）');
});

// ---------- 7. 块级遮罩核心（阶段1 补做项） ----------

test('wysiwyg 模块已注册且核心方法齐备', () => {
  assert.match(html, /<script src="modules\/wysiwyg\.js"><\/script>/, 'index.html 未引入 wysiwyg.js');
  assert.match(bundle, /Object\.assign\(MarkdownEditor\.prototype,\s*TMWysiwyg\.mixin\)/, 'TMWysiwyg mixin 未挂载');
  for (const m of ['computeWysiwygBlocks', 'wysiwygBlockIndexAt', 'renderWysiwygMasks',
                   'maskWysiwygBlock', 'unmaskWysiwygBlock', 'setWysiwygActiveBlock',
                   'syncWysiwygActiveBlock', 'refreshWysiwygBlocks', 'clearWysiwygMasks']) {
    assert.match(bundle, new RegExp(m + '\\s*\\('), '缺少核心方法 ' + m);
  }
});

test('遮罩用 markText+replacedWith 真正替换源码（单一数据源，不做逆序列化）', () => {
  // ⚠️ 不得用 addLineWidget：只在行下方「附加」、不隐藏源码行 -> 源码与渲染重复
  assert.doesNotMatch(bundle, /cm\.addLineWidget\(/, '仍用 addLineWidget（源码与渲染会重复）');
  assert.match(bundle, /cm\.markText\(/, '未用 markText');
  assert.match(bundle, /replacedWith: node/, '未用 replacedWith 替换源码文本');
  assert.match(bundle, /clearWhenEmpty: false/, '缺 clearWhenEmpty:false（文本清空时标记消失会闪烁）');
  // 渲染入口必须是既有 unified 管线，不得引入 DOM->MD 反序列化
  assert.match(bundle, /UnifiedRenderer\.renderMarkdown\(/, '未走既有 unified 渲染管线');
  assert.doesNotMatch(bundle, /turndown/i, '出现了 turndown（逆序列化），与单一数据源原则冲突');
});

test('遮罩必须带 preview-content 类，否则标题/表格/列表全无排版样式', () => {
  // 预览排版 CSS 的作用域是 `.preview-content xxx`（styles.css 1801 起）。
  // 遮罩节点不带该类 → 一张样式都套不上；真机表现为「渲染出来格式基本全丢」。
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  assert.match(wsrc, /node\.className = MASK_CLASS \+ ' preview-content'/,
    '遮罩节点未带 preview-content 类（渲染将无标题/表格/列表样式）');
  // CSS 侧须用更高优先级覆盖 preview-content 自身的容器属性，否则撑坏 CM 行盒
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  assert.match(css, /\.CodeMirror \.wysiwyg-block-mask\.preview-content \{/,
    '缺少 .CodeMirror .wysiwyg-block-mask.preview-content 覆盖规则');
  for (const prop of ['overflow: visible', 'display: block', 'white-space: normal']) {
    assert.ok(css.indexOf(prop) >= 0, '覆盖规则缺少 ' + prop);
  }
  // ⚠️ white-space:normal 是关键：CM 行是 pre，遮罩继承会把渲染 HTML 里标签间的
  //    换行符全显示为真实换行（列表序号单独成行、块内大空隙）——2026-10-07 真机定位
  assert.match(css, /wysiwyg-block-mask\.preview-content[\s\S]{0,900}white-space: normal;/,
    '遮罩未恢复 white-space:normal（渲染 HTML 的标签间换行会变成真实换行）');
  // 与阅读模式完全一致（2026-10-08 用户要求）：早期「淡色块标识」灰底（color-mix --bg-secondary）
  // 让整页呈灰条观感、与阅读模式肉眼可辨，已改为透明底；渲染态与源码态靠字体差异区分
  assert.match(css, /wysiwyg-block-mask\.preview-content[\s\S]{0,900}background: transparent;/,
    '遮罩应为透明底（与阅读模式一致，不得再有块级底色）');
});

test('点击必须能进块：遮罩自行接管 mousedown，不得依赖 CM 坐标映射', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // pointer-events:none 会让点击穿透到空白 -> CM 拿不到有效坐标 -> 点不进块（真机实测）
  assert.doesNotMatch(wsrc, /pointerEvents = 'none'/,
    '仍设 pointer-events:none（点击穿透，CM 无法定位，块点不进去）');
  assert.match(wsrc, /addEventListener\('mousedown'/, '遮罩未接管 mousedown');
  assert.match(wsrc, /ev\.stopPropagation\(\)/, '未阻止冒泡（CM 的坐标映射会覆盖我们的定位）');
  // 定位必须基于 marker.find() 的实时位置，块划分变化后才不会错位
  assert.match(wsrc, /mark && mark\.find \? mark\.find\(\) : null/, '未用 marker.find() 取实时位置');
  // 定位光标用 setSelection（不是 setCursor）：后者会 ensureCursorVisible 抢先滚动，
  // 使随后的点击锚定判定「已可见」而失效（真机「点击屏幕乱跳」根因之一）。
  assert.match(wsrc, /cm\.setSelection\(/, '接管点击后未设置光标');
  assert.match(wsrc, /cm\.focus\(\)/, '未聚焦编辑器（光标设了但键盘输入不到）');
});

test('块划分以 remark 解析器为主（与阅读模式同一套解析），splitBlocks 仅回退', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // 主路径：remark 切块 —— 手写行级切块器与 CommonMark 边界有系统性偏差
  //（`1.` 独立行 + 缩进内容被拆开 → 渲染出「只剩序号的空列表项」），逐块渲染对不上阅读模式
  assert.match(wsrc, /UnifiedRenderer\.renderMarkdownBlocks\(/, 'computeWysiwygBlocks 未走 remark 切块主路径');
  assert.match(wsrc, /if \(blocks\) return blocks;/, 'remark 切块失败时未直接采用其结果');
  // 回退路径保留（渲染器不可用时兜底）；行为验证见 test/wysiwyg-blocks.test.cjs
  assert.match(bundle, /function splitBlocks\(lines\)/, '回退切块器 splitBlocks 缺失');
  const codeOnly = wsrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(codeOnly, /function isBlockStart/, 'wysiwyg.js 仍保留粗粒度 isBlockStart（会误切块）');
  // 渲染器侧：块边界取自 remark node.position
  const rsrc = fs.readFileSync(path.join(ROOT, 'src', 'unified-renderer.js'), 'utf8');
  assert.match(rsrc, /function renderMarkdownBlocks\(content, options\)/, '渲染器缺少 renderMarkdownBlocks');
  assert.match(rsrc, /node\.position\.start\.line/, '块边界未取自 remark node.position');
  assert.match(rsrc, /module\.exports = \{ renderMarkdown, renderMarkdownBlocks \}/, 'Node 导出缺 renderMarkdownBlocks');
  assert.match(rsrc, /return \{ renderMarkdown, renderMarkdownBlocks \};/, '浏览器导出缺 renderMarkdownBlocks');
});

test('增量更新：change 不得全量重建遮罩（否则每次按键都卡）', () => {
  const coreSrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'editor-core.js'), 'utf8');
  // change 事件里必须是廉价的 refreshWysiwygBlocks（仅更新行索引缓存 + 防抖补齐）
  assert.match(coreSrc, /if \(this\.viewMode === 'wysiwyg'\) this\.refreshWysiwygBlocks\(\)/,
    'change 未走增量 refreshWysiwygBlocks');
  assert.doesNotMatch(coreSrc, /viewMode === 'wysiwyg'\) this\.renderWysiwygMasks\(\)/,
    'change 仍在全量 renderWysiwygMasks（每次按键把整篇重渲染一遍）');
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // 昂贵的渲染必须防抖
  assert.match(wsrc, /_wysiwygMaskTimer = setTimeout\(/, '缺少防抖补齐定时器');
  // 跨块只处理受影响的两个块（旧块恢复遮罩 + 新块撤遮罩）
  assert.match(wsrc, /if \(prev >= 0\) \{[\s\S]{0,300}?this\.maskWysiwygBlock\(prev\);/, '未恢复旧块遮罩');
  // 旧块在活动期间被编辑过，缓存 html 已过期，恢复遮罩前必须重渲染
  assert.match(wsrc, /b\.html = this\.renderWysiwygBlockHtml\(b\.start, b\.end\);/,
    '旧块恢复遮罩前未按最新源码重渲染（会把编辑前的旧内容盖回去）');
  assert.match(wsrc, /this\.unmaskWysiwygBlock\(idx\);/, '未撤掉新活动块遮罩');
  const setIdx = wsrc.indexOf('setWysiwygActiveBlock(idx) {');
  assert.ok(setIdx > 0, '未找到 setWysiwygActiveBlock');
  assert.doesNotMatch(wsrc.slice(setIdx, setIdx + 400), /clearWysiwygMasks/,
    'setWysiwygActiveBlock 内部不得全量重建（每次跨块都会整篇重排）');
});

test('块高抖动补偿必须同步完成（不得用 rAF，异步补偿本身就是可见跳动）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  assert.match(wsrc, /cm\.cursorCoords\(null, 'window'\)/, '未用 cursorCoords 取光标视口坐标');
  assert.match(wsrc, /cm\.scrollTo\(info\.left, info\.top \+ delta\)/, '未按差值回滚滚动');
  assert.doesNotMatch(wsrc, /requestAnimationFrame/, '仍在用 rAF 做异步补偿（本身就会看到跳动）');
  assert.doesNotMatch(wsrc, /info\.clientHeight/, '误用 info.clientHeight（CM5 scrollInfo 无此字段）');
  // 差值过大说明是结构级变化，此时补偿反而更糟，须放弃
  assert.match(wsrc, /Math\.abs\(delta\) > vh/, '缺少过大差值的放弃判定');
});

test('遮罩生命周期正确：离开模式清理，不泄漏 mark', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // 注意：必须锚到定义体（'clearWysiwygMasks() {'），首个出现处是 renderWysiwygMasks 里的调用
  const cIdx = wsrc.indexOf('clearWysiwygMasks() {');
  assert.ok(cIdx > 0, '缺少 clearWysiwygMasks 定义');
  // 窗口含开头的「标题活动行装饰清理」块（2026-10-14），需放宽到 mark 遍历之后
  const blk = wsrc.slice(cIdx, cIdx + 1200);
  assert.match(blk, /Array\.from\(this\._wysiwygMarks\.values\(\)\)/, '未遍历清理 mark');
  assert.match(blk, /mark\.clear\(\)/, '未 clear mark（会泄漏）');
  assert.match(blk, /clearTimeout\(this\._wysiwygMaskTimer\)/, '未清理防抖定时器');
  const themeSrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'theme.js'), 'utf8');
  const avIdx = themeSrc.indexOf('applyViewMode()');
  assert.ok(avIdx > 0, '未找到 applyViewMode');
  assert.match(themeSrc.slice(avIdx, avIdx + 4000), /this\.clearWysiwygMasks\(\)/, 'applyViewMode 未清理遮罩');
});

test('实时预览独占编辑区：预览栏隐藏（与阅读/源码区分）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  assert.match(css, /\.editor-container\.wysiwyg-mode \.preview-pane \{ display: none; \}/,
    '实时预览下预览栏应隐藏（否则与阅读模式无异）');
  assert.match(css, /\.editor-container\.wysiwyg-mode \.editor-pane \{ flex: 1 1 100%/,
    '实时预览下编辑区应占满宽度');
});
// ---------- 8. 模式名回归护栏（曾被 i18n 覆盖回「预览/编辑」） ----------

test('模式名由 i18n 统一提供：阅读/源码/实时预览（三钮全覆盖）', () => {
  const i18njs = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'i18n.js'), 'utf8');
  // 三个按钮都要被 i18n 赋值；曾因只覆盖两个而让 HTML 里的新名被改回旧名
  for (const [btn, key] of [
    ['btn-view-preview', 'viewModeRead'],
    ['btn-view-edit', 'viewModeSource'],
    ['btn-view-wysiwyg', 'viewModeWysiwyg'],
  ]) {
    assert.match(i18njs, new RegExp(`updateMenuText\\('${btn}', t\\('${key}'\\)\\)`),
      `${btn} 未用 ${key} 赋值（会被 i18n 覆盖成旧名）`);
  }
  // 不得再对三钮用旧的 preview/edit 键
  assert.doesNotMatch(i18njs, /updateMenuText\('btn-view-(preview|edit)', t\('(preview|edit)'\)\)/,
    '三钮仍在用旧的 t(preview)/t(edit)');
  // 原生 title 也换成简介（自定义 tooltip 为主，title 为无障碍/回退）
  for (const key of ['viewModeReadTip', 'viewModeSourceTip', 'viewModeWysiwygTip']) {
    assert.match(i18njs, new RegExp(`setTitle\\('btn-view-\\w+', t\\('${key}'\\)\\)`), `title 未用 ${key}`);
  }
});

test('空行占位提示：wrap 类 + CSS 变量文案（data-hint 方案已被证伪）', () => {
  const esrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'empty-hint.js'), 'utf8');
  // 曾用零长度 markText + replacedWith，CM5 中不渲染 → 提示不显示
  assert.doesNotMatch(esrc, /cm\.markText\(/,
    '仍用 markText（零长度 markText 在 CM5 不渲染，提示不会出现）');
  assert.match(esrc, /cm\.addLineClass\(/, '未用 addLineClass');
  assert.match(esrc, /cm\.removeLineClass\(/, '未实现清理（removeLineClass）');
  // ⚠️ data-hint 方案已证伪：CM5 没有 getLineElement API，行 DOM 拿不到，属性永远写不上
  // 只禁代码调用，注释里提到该 API 名是允许的（用于记录踩坑）
  assert.doesNotMatch(esrc, /cm\.getLineElement\(/, '仍调用不存在的 cm.getLineElement（data-hint 永远写不上）');
  // 同上：只禁代码写入，注释中提及方案名是允许的
  assert.doesNotMatch(esrc, /setAttribute\('data-hint'|data-hint\s*=/,
    '仍用 data-hint（拿不到行 DOM，属性写不上）');
  // 文案走 CSS 变量（documentElement 上设置，切语言自动刷新）
  assert.match(esrc, /--empty-hint-text/, '未写入 --empty-hint-text CSS 变量');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  assert.match(css, /\.CodeMirror \.cm-empty-placeholder \.CodeMirror-line::after \{/, '缺少行内 ::after');
  assert.match(css, /content: var\(--empty-hint-text/, '::after 未取 CSS 变量');
  // 类挂在 wrap（行包装器），CSS 从包装器穿透到 .CodeMirror-line
  assert.match(esrc, /addLineClass\(handle, 'wrap'/, '未挂到 wrap（挂 background 时 ::after 不在行内）');
});

// ---------- 9. 块间空行塌缩（2026-10-07 真机反馈「间隔了很多空行」） ----------

test('空行塌缩：updateWysiwygBlankLines 存在且增量挂类，光标所在空行例外', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  for (const m of ['updateWysiwygBlankLines', '_setWysiwygBlankClass', '_isWysiwygBlankLine']) {
    assert.match(wsrc, new RegExp(m + '\\s*\\('), '缺少方法 ' + m);
  }
  // 必须走 diff 增量（prev/next 集合比对），不得每次全量 addLineClass
  assert.match(wsrc, /const prev = this\._wysiwygBlankLines;/, '未做增量 diff');
  assert.match(wsrc, /if \(!next\.has\(i\)\) this\._setWysiwygBlankClass\(i, false\);/, '未摘除失效行');
  assert.match(wsrc, /if \(!prev\.has\(i\)\) this\._setWysiwygBlankClass\(i, true\);/, '未挂新增行');
  // 光标所在空行不塌缩（需要光标与占位提示可见）
  assert.match(wsrc, /i !== curLine && cm\.getLine\(i\)\.trim\(\) === ''/,
    '未排除光标所在行（光标会被压扁）');
  // cursorActivity 时临时摘掉光标行塌缩类，离开后恢复
  assert.match(wsrc, /_setWysiwygBlankClass\(line, false\)/, '光标进入空行未恢复全高');
  // 生命周期：清理时须撤掉全部塌缩类（窗口含开头的标题装饰清理块，2026-10-14）
  const cIdx = wsrc.indexOf('clearWysiwygMasks() {');
  const blk = wsrc.slice(cIdx, cIdx + 1700);
  assert.match(blk, /for \(const i of this\._wysiwygBlankLines\) this\._setWysiwygBlankClass\(i, false\);/,
    '清理未撤空行塌缩类（离开模式后空行仍是塌缩态）');
  // 两处调用：全量重建后 + 防抖补齐后
  // 全量重建收尾：refresh 后必须先冲刷异步 pass（TOC/图片/图表首帧就绪），再更新空行塌缩
  //（缩进不定：renderWysiwygMasks 主体包在 try 内，行首空格数随重构变化）
  assert.match(wsrc, /cm\.refresh\(\); \} catch \(_\) \{ \/\* ignore \*\/ \}\n(?:[^\n]*\n)*?\s*this\.flushWysiwygAsyncPasses\(\);\n\s*this\.updateWysiwygBlankLines\(\);/,
    '全量重建后未冲刷异步 pass / 未更新空行塌缩');
  assert.match(wsrc, /self\.updateWysiwygBlankLines\(\);/, '防抖补齐后未更新空行塌缩');
});

test('CSS：空行塌缩为小间距，遮罩行盒 strut 置 0', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  assert.match(css, /\.CodeMirror \.cm-wysiwyg-blank \.CodeMirror-line \{ line-height: 12px; \}/,
    '缺少空行塌缩样式（块与块之间会隔出整行空白）');
  assert.match(css, /pre\.CodeMirror-line:has\(> span > \.CodeMirror-widget > \.wysiwyg-block-mask\)/,
    '缺少遮罩行 strut 置 0 规则');
  assert.match(css, /:has\(\> span \> \.CodeMirror-widget \> \.wysiwyg-block-mask\)[\s\S]{0,80}line-height: 0;/,
    'strut 置 0 规则缺少 line-height: 0');
});

// ---------- 10. 渲染态任务复选框（阶段2 计划项） ----------

test('复选框回写须加块起始行偏移（data-source-line 是切片内相对行号）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  assert.match(wsrc, /toggleWysiwygTaskCheckbox\(box\)/, '缺少 toggleWysiwygTaskCheckbox');
  // 从遮罩节点取块索引并用块表换算绝对行号
  assert.ok(wsrc.indexOf("box.closest ? box.closest('.' + MASK_CLASS) : null") >= 0,
    '未从遮罩节点定位所在块');
  assert.match(wsrc, /\(block \? block\.start : 0\) \+ srcLine - 1/,
    '未按块起始行偏移换算（data-source-line 是切片内相对行号，漏加会勾错行）');
  // 点击接管里须先让位给复选框处理
  assert.match(wsrc, /closest\('input\[type="checkbox"\]'\)/, 'mousedown 未识别复选框点击');
  // 翻转后立即重渲染所在块
  assert.match(wsrc, /toggleWysiwygTaskCheckbox\(box\);\n            return;/, '复选框点击未短路光标定位');
});

// ---------- 11. 点击锚定（真机反馈「点击后屏幕乱跳」的根因修复） ----------

// 取遮罩 mousedown 处理器的完整源码块。
// ⚠️ 不能简单 indexOf('});')：setSelection 的多行实参结尾自带 '});'，会把块提前截断。
function mousedownBlock(wsrc) {
  const start = wsrc.indexOf("node.addEventListener('mousedown'");
  const end = wsrc.indexOf('\n      });\n', start);
  return wsrc.slice(start, end < 0 ? wsrc.length : end);
}

test('点击定位须关闭 CM 自动滚动（ensureCursorVisible 会抢先滚一次）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // setSelection 默认会 ensureCursorVisible（codemirror.js:5195）把行顶到视口边缘，
  // 之后 scrollIntoView 判定「已可见」便不再动作，锚定彻底失效。
  const calls = wsrc.match(/cm\.setSelection\([\s\S]{0,200}?\}\)/g) || [];
  assert.ok(calls.length >= 2, `遮罩 mousedown 应有两处 setSelection（表格/普通），实得 ${calls.length}`);
  for (const c of calls) {
    assert.match(c, /scroll: false/, 'setSelection 未关闭自动滚动（滚动权必须独占在锚定手里）');
  }
  // 鼠标来源标注只约束 mousedown 分支（另有 #锚点跳转的程序化 setSelection，非鼠标触发）
  const md = mousedownBlock(wsrc);
  const mouseCalls = md.match(/cm\.setSelection\([\s\S]{0,200}?\}\)/g) || [];
  assert.ok(mouseCalls.length >= 2, `mousedown 内应有两处 setSelection（表格/普通），实得 ${mouseCalls.length}`);
  for (const c of mouseCalls) {
    assert.match(c, /origin: '\*mouse'/, 'mousedown 内 setSelection 未标注鼠标来源');
  }
  // 不得再用会触发自动滚动的 setCursor
  assert.ok(!/cm\.setCursor\(/.test(md), 'mousedown 内仍用 setCursor（会 ensureCursorVisible）');
});

test('锚定须在 setSelection 返回后执行（operation 内滚动会被 pending 冲掉）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // _applyWysiwygClickAnchor：mousedown 内 setSelection/focus 之后调用
  assert.match(wsrc, /_applyWysiwygClickAnchor\(\) \{/, '缺少 _applyWysiwygClickAnchor');
  const md = mousedownBlock(wsrc);
  const seq = md.match(/cm\.focus\(\);\s*\n?\s*self\._applyWysiwygClickAnchor\(\);/g) || [];
  // 2026-10-13 Phase 2：表格格点击改走 _wysiwygStartCellEdit 就地编辑（不再做光标定位/点击锚定），
  // 点击锚定契约保留在「普通块点击分支」（编辑按钮分支走 scrollIntoView，另一套机制）
  assert.ok(seq.length >= 1, `普通块点击分支须在 focus 后锚定，实得 ${seq.length}`);
  // _restoreWysiwygAnchor 被 cursorActivity（operation 内）调起，只清锚点量、不做滚动
  const rIdx = wsrc.indexOf('    _restoreWysiwygAnchor() {');
  const rblk = wsrc.slice(rIdx, rIdx + 700);
  assert.match(rblk, /if \(this\._wysiwygClickAnchor\) \{ this\._wysiwygAnchorY = null; return; \}/,
    '_restoreWysiwygAnchor 仍在 operation 内滚动（会被 CM pending 机制冲掉）');
  // 锚定用「事后测量 + 差值补偿」：点击位置必须换算为编辑器视口内坐标（旧实现拿窗口坐标
  // click.y 直接当 scrollIntoView 的 margin，真机编辑器上方的工具栏导致基准错位，每次点击
  // 往下滚一个工具栏高，2026-10-09 用户反馈），再 scrollTo 补偿差值把行顶放回点击处
  const aIdx = wsrc.indexOf('_applyWysiwygClickAnchor() {');
  const ablk = wsrc.slice(aIdx, aIdx + 1600);
  assert.match(ablk, /getBoundingClientRect\(\)\.top/, '点击锚点未换算为编辑器视口坐标（真机有工具栏，窗口坐标基准错位）');
  assert.match(ablk, /cm\.scrollTo\(info\.left, info\.top \+ delta\);/, '点击锚定未做差值补偿（行顶回不到精确点击处）');
  assert.match(ablk, /Math\.abs\(delta\) > vh/, '点击锚定缺少结构级变化守卫（差值过大应放弃补偿）');
  assert.ok(!/cm\.scrollIntoView\(pos,/.test(ablk), '点击锚定仍在用 scrollIntoView margin 机制（margin 带内不补偿 + 坐标基准错位）');
});

test('点击遮罩块须先撤遮罩再落光标（CM5 会钳制标记区间内的 setSelection 位置）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const md = mousedownBlock(wsrc);
  // CM5 对落在 replacedWith 标记区间**内部**的 setSelection 位置会钳制到标记首/末端
  // （2026-10-09 实测：点多行块中部，光标恒落到块尾/块首行，用户反复点偏）。
  // 落光标前必须先 setWysiwygActiveBlock 撤掉本块标记，让目标行成为真实源码行；
  // 活动块索引按「目标行」查（增量刷新后闭包 idx 可能已位移，行→块才是准的）。
  // 2026-10-14 起走 _wysiwygBlockIndexAtFresh（防抖窗口内块表滞后守卫，见专项测试）
  const hits = md.match(/setWysiwygActiveBlock\(self\._wysiwygBlockIndexAtFresh\(/g) || [];
  assert.ok(hits.length >= 2, `表格/普通两个点击分支都须先撤目标块遮罩，实得 ${hits.length}`);
  const firstAct = md.search(/setWysiwygActiveBlock\(self\._wysiwygBlockIndexAtFresh\(/);
  const firstSel = md.search(/cm\.setSelection\(/);
  assert.ok(firstAct >= 0 && firstSel > firstAct, '撤遮罩发生在 setSelection 之后（标记未清时落光标必被 CM5 钳制）');
});

test('活动块未变时也要消费点击锚点（残留会污染后续光标移动）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const sIdx = wsrc.indexOf('    setWysiwygActiveBlock(idx) {');
  const sblk = wsrc.slice(sIdx, sIdx + 1400); // 开头含「在编格延迟提交」守卫（较长注释，2026-10-13 后变长，窗口需覆盖同块短路的 return）
  assert.match(sblk, /if \(prev === idx\)/, '缺少同块短路分支');
  // 消费锚点必须在同块短路的 return 之前完成（中间允许高亮重挂等收尾语句）
  assert.match(sblk, /this\._restoreWysiwygAnchor\(\);[\s\S]{0,220}?return;/,
    '同块短路时未消费锚点（残留的 click 锚点会让下一次普通光标移动跳到无关位置）');
});

// ---------- 11b. 格编辑启动重遮罩旧活动块（2026-10-14 用户截图「点表格后下面一行还是源码态」） ----------

test('进格编辑重遮罩旧活动块：重遮 + 无活动块 + 被钳光标重激活三路拦截', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // ① 格编辑启动重遮旧块（须在 _wysiwygCellEditing 立起后调用；表格自身块除外）
  const rcIdx = wsrc.indexOf('_wysiwygReMaskActiveForCellEdit(tableIdx) {');
  assert.ok(rcIdx > 0, '缺 _wysiwygReMaskActiveForCellEdit');
  const rcBlk = wsrc.slice(rcIdx, rcIdx + 900);
  assert.match(rcBlk, /prev === tableIdx\) return;/, '表格自身块被重遮（应除外）');
  assert.match(rcBlk, /this\._wysiwygActiveIdx = -1;/, '未清活动块（无活动块 = 全部遮罩）');
  assert.match(rcBlk, /this\.maskWysiwygBlock\(prev\);/, '旧活动块未重新遮罩');
  const scIdx = wsrc.indexOf('this._wysiwygCellEditing = {');
  assert.ok(scIdx > 0, '未找到 _wysiwygCellEditing 状态立起点');
  const scBlk = wsrc.slice(scIdx, scIdx + 900);
  assert.match(scBlk, /this\._wysiwygReMaskActiveForCellEdit\(idx\);/, '_wysiwygStartCellEditOn 未调用旧块重遮罩');
  // ② syncWysiwygActiveBlock 守卫：进格编辑重遮罩时 reCheckSelection 把光标钳到旧块末行
  //    （仍在块内）触发的 cursorActivity 不得把刚遮的块重新激活
  const syncIdx = wsrc.indexOf('syncWysiwygActiveBlock() {');
  const syncBlk = wsrc.slice(syncIdx, syncIdx + 800);
  assert.match(syncBlk, /if \(this\._wysiwygCellEditing\) \{ this\._restoreWysiwygAnchor\(\); return; \}/,
    'syncWysiwygActiveBlock 缺格编辑守卫（被钳 cursorActivity 会重解罩旧块）');
  // ③ 结构刷新现算：已挂遮罩的块不得「激活」（被钳光标落在遮罩块内 → -1）；
  //    拖拽提交/增行增列、防抖重算、全量增量三处统一走同一助手
  const aifcIdx = wsrc.indexOf('_wysiwygActiveIdxFromCursor() {');
  assert.ok(aifcIdx > 0, '缺 _wysiwygActiveIdxFromCursor');
  const aifcBlk = wsrc.slice(aifcIdx, aifcIdx + 500);
  assert.match(aifcBlk, /this\._wysiwygMarks\.has\(bi\)\) return -1;/, '遮罩块可被判活动块（会解罩回源码态）');
  const uses = (wsrc.match(/_wysiwygActiveIdxFromCursor\(\);/g) || []).length;
  assert.ok(uses >= 3, '结构刷新路径未统一走 _wysiwygActiveIdxFromCursor（拖拽提交/防抖/全量增量 3 处），实际 ' + uses);
});

// ---------- 11c. 格内文字选中 + 点外部失焦（2026-10-14 用户要求） ----------

test('格内文字可选中 + 点其他行/空白处单元格失焦（选中三路放行、提交四处挂钩）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // ① 正在编辑的本格 mousedown 直接 return（在 preventDefault 之前）——原生拖选才生效
  assert.match(wsrc,
    /hitCell && self\._wysiwygCellEditing && hitCell === self\._wysiwygCellEditing\.cell\) return;/,
    '点本格未放行原生选择（preventDefault 会杀死拖选）');
  // ② 「先提交失焦」挂钩：mask mousedown try 头（另一格/留白/另一块）+ 表格外 capture 守卫
  //    + 拖拽 up（轨道单击）+ 拖拽 cancel + 既有分支 commit-first（切格/增行增列）
  const commits = (wsrc.match(/_wysiwygEndCellEdit\(true, false\);/g) || []).length;
  assert.ok(commits >= 6, '点其他行/空白处失焦提交挂钩不足（try头/capture守卫/拖up/拖cancel/切格/增行列 6 处），实际 ' + commits);
  // ③ CSS：编辑态格子恢复文本选择（遮罩节点默认 user-select:none 会拦掉一切选中）
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  const ceIdx = css.indexOf('table th.wysiwyg-cell-editing {');
  assert.ok(ceIdx > 0, '缺 .wysiwyg-cell-editing 规则');
  assert.match(css.slice(ceIdx, ceIdx + 700), /user-select: text;/, '编辑态格未恢复 user-select（格内文字选不中）');
});

// ---------- 11d. 标题活动行「灰 # 前缀 + 渲染文字」（2026-10-14 用户要求，Typora 式） ----------

test('活动块源文态装饰：标题#前缀/列表符号/代码围栏 + 应用点齐全', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  assert.match(wsrc, /_wysiwygApplyActiveDecor\(idx\) \{/, '缺 _wysiwygApplyActiveDecor');
  const dIdx = wsrc.indexOf('_wysiwygApplyActiveDecor(idx) {');
  const dBlk = wsrc.slice(dIdx, dIdx + 6500);
  assert.match(dBlk, /add\(b\.start, 0, m\[0\]\.length, 'wysiwyg-heading-hash'\);/, '# 前缀段缺失（应小灰显示）');
  assert.match(dBlk, /wysiwyg-heading-text wysiwyg-heading-text-' \+ level/, '正文段缺失（应渲染尺寸显示）');
  assert.match(dBlk, /b\.end - b\.start === 1 && RE\.heading\.test\(first\)/, '标题分支未按单行块判定');
  assert.match(dBlk, /RE\.fence\.test\(first\.trim\(\)\)/, '缺代码块（围栏）分支');
  assert.match(dBlk, /wysiwyg-code-fence/, '缺围栏行标记类（上下三个 ` 应灰显）');
  assert.match(dBlk, /wysiwyg-list-bullet/, '缺列表圆点标记类（• 应渲染化）');
  assert.match(dBlk, /wysiwyg-task-box/, '缺任务复选框标记类（☐☑ 应渲染化）');
  assert.match(dBlk, /checked/, '复选框无勾选态（[x] 应渲染为已勾选）');
  assert.match(dBlk, /wysiwyg-ol-marker/, '缺有序序号标记类');
  assert.match(dBlk, /!RE\.hr\.test\(first\.trim\(\)\)/, 'HR 行（- - -）未排除（会被误装饰成列表）');
  // 列表块级排版行类（2026-10-15）：挂挂 + 追踪清理（切块/拆场先清后挂）
  assert.match(dBlk, /wysiwyg-list-line/, '活动列表行未挂块级排版行类');
  assert.match(dBlk, /wysiwyg-list-indent/, 'ul/ol 活动行未挂缩进行类');
  assert.ok((wsrc.match(/_wysiwygListLines/g) || []).length >= 5, '列表行类未追踪（切块/拆场需先清后挂）');
  // 应用点：setWysiwygActiveBlock / change 钩子 / 进 wysiwyg 尾 / 防抖尾 / 全量增量尾
  const applies = (wsrc.match(/_wysiwygApplyActiveDecor\((?:this|self)\._wysiwygActiveIdx\)|_wysiwygApplyActiveDecor\(idx\);/g) || []).length;
  assert.ok(applies >= 5, '装饰应用点不足（切块/change钩子/进wysiwyg尾/防抖尾/全量增量尾），实际 ' + applies);
  assert.match(wsrc, /_ensureWysiwygActiveDecorHook\(\);/, 'change 钩子未登记');
  assert.match(wsrc, /c\.from\.line < b\.end && c\.to\.line >= b\.start\)/, 'change 钩子未按编辑交叠重算装饰');
  const clIdx = wsrc.indexOf('clearWysiwygMasks() {');
  assert.match(wsrc.slice(clIdx, clIdx + 1200), /_wysiwygActiveDecor/, '离开模式未清活动块装饰（源文行残留样式）');
  // CSS：标题——灰 # + 预览字族/加粗变量 + h1–h6 六级尺寸
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  assert.match(css, /wysiwyg-heading-hash \{[\s\S]{0,200}color: var\(--text-secondary\);/, '# 前缀未用主题次级色（灰）');
  assert.match(css, /wysiwyg-heading-hash \{[\s\S]{0,400}font-size: 0\.8em;/,
    '# 前缀未统一字号（2026-10-15 用户要求：各级 # 一样大）');
  assert.doesNotMatch(css, /wysiwyg-heading-hash-\d \{/, '残留按级 # 字号规则（应已合并为统一 0.8em）');
  assert.match(css, /wysiwyg-heading-text \{[\s\S]{0,200}font-family: var\(--font-preview\);/, '正文未用预览字族（与渲染标题不一致）');
  for (let n = 1; n <= 6; n++) {
    assert.ok(css.indexOf('wysiwyg-heading-text-' + n + ' {') >= 0, '缺 h' + n + ' 渲染尺寸 CSS');
  }
});

test('列表/代码块活动行渲染化 CSS：源符号透明化 + ::before 渲染符号 + 围栏灰显', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  // 圆点/复选框：源字符所在 span 透明化（保留真实宽度 → 光标测量精准；
  // 不可用 width:0 + overflow:hidden——会连 ::before 符号一起裁掉）
  assert.match(css, /\.wysiwyg-list-bullet \{[\s\S]{0,400}color: transparent;/,
    '圆点 span 未透明化（源字符会同时可见）');
  assert.match(css, /\.wysiwyg-task-box \{[\s\S]{0,200}color: transparent;/,
    '复选框 span 未透明化（源字符会同时可见）');
  // 画圆垂直居中锚定行盒（真机 WebView2 内联 span 字体盒按基线放置，与渲染 disc
  // 差 1px——2026-10-15 用户截图「点入编辑黑点往上移一点点」）：盒高=行高 1.7em +
  // vertical-align:top → ::before top:50% 严格=行盒中心
  assert.match(css, /\.wysiwyg-list-bullet \{[\s\S]{0,700}display: inline-block;[\s\S]{0,120}height: 1\.7em;[\s\S]{0,120}vertical-align: top;/,
    '圆点盒未锁定行盒（inline-block + 1.7em + vertical-align:top 缺一，真机黑点会偏 1px）');
  assert.doesNotMatch(css.slice(css.indexOf('.wysiwyg-list-bullet {'),
    css.indexOf('.wysiwyg-list-bullet {') + 400), /overflow:\s*hidden/,
    '源符号 span 用了 overflow:hidden（会裁掉 ::before 渲染符号）');
  // 圆点符号：画圆而非 '•' 字符（2026-10-15 用户截图：'•' 字符比渲染 disc marker 小且偏上）
  assert.match(css, /wysiwyg-list-bullet::before[\s\S]{0,250}width: 6px;[\s\S]{0,120}border-radius: 50%;/,
    '无序圆点未用画圆（须与渲染 disc marker 同形：6px 实心圆）');
  assert.match(css, /wysiwyg-list-bullet::before[\s\S]{0,250}left: -7px;/,
    '圆点 left 应为 -7px（canvas 像素实测：渲染 disc x=38–43，画圆 38–44 逐像素重合；-6px 偏右 1px，用户仍觉「黑点往右移」）');
  // 画圆垂直位=disc 字形绘制位（非几何中心）：Edge154（=WebView2 同引擎）加权重心实测
  // disc 中心=行顶+0.906em；absolute 盒 round 落位 vs disc AA 不取整 → 0.906em 部分行差
  // 1px（用户第三组截图「有一部分黑点会动」）；绿圆分离法扫描：0.922–0.952em 全同 Δ=0，
  // 取中值 0.938em（取整平台正中，相位滚动/字号组合都稳）
  assert.match(css, /wysiwyg-list-bullet::before[\s\S]{0,300}top: calc\(0\.938em - 3px\);/,
    '画圆 top 须为 calc(0.938em - 3px)（disc 重心 0.906em + round/AA 取整差补偿的中值；50%/0.906em 都会在真机部分行偏 1px）');
  assert.match(css, /wysiwyg-list-bullet::before[\s\S]{0,300}background: var\(--text-primary\);/, '圆点未用正文色');
  // 任务行圆点不画符号（渲染预览任务项 list-style:none，只有复选框）
  assert.match(css, /wysiwyg-task-bullet::before[\s\S]{0,80}content: none;/, '任务行圆点未隐藏（与渲染预览不一致）');
  const wsrc2 = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  assert.match(wsrc2, /wysiwyg-list-bullet wysiwyg-task-bullet/, '任务行未单独标记圆点字符');
  // 复选框：未勾选边框 / 勾选主题成功色 + 白色对勾
  assert.match(css, /wysiwyg-task-box::before[\s\S]{0,300}border: 1\.5px solid var\(--border-color\);/,
    '复选框未对齐预览样式（1.5px 边框）');
  assert.match(css, /wysiwyg-task-box\.checked::before[\s\S]{0,150}--color-success/, '勾选态未用主题成功色');
  assert.match(css, /wysiwyg-task-box\.checked::after[\s\S]{0,200}transform: rotate\(45deg\);/, '缺勾选对勾');
  // 正文/序号：预览字族（与渲染列表一致）
  assert.match(css, /wysiwyg-list-text \{[\s\S]{0,100}var\(--font-preview\)/, '列表正文未用预览字族');
  assert.match(css, /wysiwyg-ol-marker \{[\s\S]{0,100}var\(--font-preview\)/, '有序序号未用预览字族');
  // 有序序号 24px 右对齐槽（2026-10-16 用户反馈「有序列表点入编辑态有向右偏移」：
  // 旧「行缩进+8px + 源空格自然宽」按「1. 」≈16px 估算、实测 16.48px → 正文偏右
  // 0.48px、序号偏左 ~4px）。固定 width:24px（= 渲染 ol padding，border-box）右对齐
  // + padding-right 4px（复刻渲染原生 marker ~6px 与正文间距 − 字形右旁白 ~2px）
  // + 源空格零宽（.wysiwyg-ol-space）→ 正文恒 56px、序号墨迹 ≈ 渲染 [44,50]。
  assert.match(css, /wysiwyg-ol-marker \{[\s\S]{0,200}display: inline-block;/, '有序序号未 inline-block（无法固定槽宽/右对齐）');
  assert.match(css, /wysiwyg-ol-marker \{[\s\S]{0,200}width: 24px;/, '有序序号槽宽未固定 24px（= 渲染 ol padding；多位数撑宽会推正文）');
  assert.match(css, /wysiwyg-ol-marker \{[\s\S]{0,200}text-align: right;/, '有序序号未右对齐（应复刻渲染 outside marker 右缘对齐）');
  assert.match(css, /wysiwyg-ol-marker \{[\s\S]{0,200}padding-right: 4px;/, '有序序号未补 4px 右距（渲染 marker 与正文间距 ~6px − 字形右旁白 ~2px）');
  assert.match(css, /wysiwyg-ol-space \{[\s\S]{0,120}width: 0;/, '有序源空格未零宽（会把正文再推一个空格宽）');
  assert.match(wsrc2, /'wysiwyg-ol-space'/, '有序标记后未挂零宽空格 span');
  assert.match(wsrc2, /else if \(!taskM && !olM && indentList\)/, 'ol 标记行未排除行缩进（应只由 24px marker 槽提供缩进，续行才走 -indent-ol）');
  // 列表活动行块级排版（2026-10-15 用户反馈：编辑态比渲染态「小、密、缩进不同」）：
  // 项间距 4px（渲染 li margin-bottom）+ ul/ol 行缩进在行基准 32px 上叠 12px（序号左缘对齐）
  assert.match(css, /wysiwyg-list-line \{[\s\S]{0,80}padding-bottom: 4px;/, '列表活动行缺项间距（渲染 li 有 4px margin-bottom，编辑态「密」）');
  assert.match(css, /wysiwyg-list-line\.wysiwyg-list-indent-ul \{[\s\S]{0,120}calc\(var\(--wysiwyg-line-inset, 32px\) \+ 13px\)/,
    'ul 缩进未在行基准上 calc 叠加 13px（「- 」≈11px，24−11=13 正文才落回渲染 56px）');
  // ol **续行**仍走 +8px 行缩进 + 源前导空格近似（标记行已改用 24px marker 槽，见上）
  assert.match(css, /wysiwyg-list-line\.wysiwyg-list-indent-ol \{[\s\S]{0,120}calc\(var\(--wysiwyg-line-inset, 32px\) \+ 8px\)/,
    'ol 续行缩进未在行基准上 calc 叠加 8px（续行无 marker 槽，沿用旧近似口径）');
  assert.match(css, /padding-left: var\(--wysiwyg-line-inset, 32px\);/, 'wysiwyg 行基准留白未变量化（列表缩进无法叠加）');
  // S42（2026-10-15 用户截图：列表项 "5454554" 编辑态带下划线、渲染态没有）：
  // gfm 模式 gitHubSpice 把 7–40 位十六进制串认成 SHA → cm-link token →
  // codemirror.css .cm-link { text-decoration: underline } 在编辑态漏出；渲染器不识别
  // → 不一致。必须关 gitHubSpice（普通 URL 的 cm-link 走 urlRE 分支，渲染态本有下划线，保留）。
  const ecore = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'editor-core.js'), 'utf8');
  assert.match(ecore, /gitHubSpice:\s*false/, 'gfm 模式未关 gitHubSpice（SHA/issue 串被认成链接，编辑态漏下划线）');
  // token 的 text-decoration 也要中和（.cm-link 下划线 / .cm-strikethrough 删除线漏出）；
  // 渲染态链接口径 = .preview-content a { text-decoration:none } → 编辑态 cm-link 无下划线
  assert.match(css, /wysiwyg-plain-text span\[class[*]="cm-"\] \{[\s\S]{0,800}text-decoration: none;/,
    'cm- token span 未中和 text-decoration（gitHubSpice 关后 URL 的 cm-link 下划线仍会漏出，与渲染态 <a> 口径不符）');
  assert.doesNotMatch(css, /wysiwyg-inline-link \{\s*color: var\(--accent-color\);\s*text-decoration: underline;/,
    '独立 wysiwyg-inline-link 规则不应带 underline（渲染态链接无下划线）');
  // S43（2026-10-15 用户截图：「点击编辑后内容会向上动一下」）：遮罩高度含渲染元素
  // 自身 margin-bottom（ul/ol/p = 14px；> *:last-child 清零被 block-edit-btn 占了
  // last-child 位而失效）+ 遮罩 padding 1+2 + border-bottom 1 → 活动块须用块边缘行
  // （wysiwyg-block-edge-top/bottom，非 cm-wysiwyg-active-first/last——那对非容器块
  // 只挂光标行 lo=hi）给 14px 边距族补 顶距 1px / 底距 17px 才逐像素等高。
  assert.match(wsrc2, /wysiwyg-block-edge-top/, '缺块边缘行类（wysiwyg-block-edge-top）——活动块无法补齐遮罩 margin/padding 差');
  assert.match(wsrc2, /wysiwyg-block-edge-bottom/, '缺块边缘行类（wysiwyg-block-edge-bottom）');
  assert.match(wsrc2, /wysiwyg-para-line/, '缺段落行类（wysiwyg-para-line）——段落块（p 的 14px 边距族）无法参与块高补齐');
  assert.match(css, /wysiwyg-list-line\.wysiwyg-block-edge-top,\s*\n[^}]*wysiwyg-para-line\.wysiwyg-block-edge-top \{[\s\S]{0,60}padding-top: 1px;/,
    '块边缘首行未补 1px 顶距（对齐遮罩 padding-top）');
  assert.match(css, /wysiwyg-list-line\.wysiwyg-block-edge-bottom,\s*\n[^}]*wysiwyg-para-line\.wysiwyg-block-edge-bottom \{[\s\S]{0,60}padding-bottom: 17px;/,
    '块边缘末行未补 17px 底距（14px margin + 2px 遮罩 padding-bottom + 1px border-bottom）');
  // 代码围栏：灰显（语法标志）
  assert.match(css, /wysiwyg-code-fence \{[\s\S]{0,100}var\(--text-secondary\)/, '围栏未灰显');
});

// ---------- 12. 遮罩渲染后处理对齐（真机 demo.md：公式块露 $$ 源码） ----------

test('遮罩须补跑预览后处理（与阅读模式 render() 同序全链，走 RenderPost 共享管线）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  assert.match(wsrc, /_postProcessWysiwygNode\(node\)/, 'maskWysiwygBlock 未调用后处理');
  // renderMarkdown 只产出结构 HTML，后处理统一走 RenderPost 共享管线（modules/render-post.js）：
  // 与阅读模式 render() 同 stage 同顺序（同步 stage 在 _postProcessWysiwygNode，
  // 异步 stage 在 _wysiwygPostProcessAsync 里 DOM 落定后补跑）
  const pIdx = wsrc.indexOf('_postProcessWysiwygNode(node) {');
  const pblk = wsrc.slice(pIdx, pIdx + 2500);
  assert.match(pblk, /RenderPost\.enableCheckboxes\(node\)/, '复选框未解禁（渲染态点不动）');
  assert.match(pblk, /RenderPost\.processEmoji\(node\)/, '未补跑 emoji 还原（遮罩里露 :rocket: 短码）');
  assert.match(pblk, /RenderPost\.processMath\(node\)/, '未补跑公式渲染（遮罩里会露原始 $$ 源码）');
  assert.match(pblk, /RenderPost\.processAbbreviations\(node, postOpts\)/, '未补跑缩写还原');
  assert.match(pblk, /RenderPost\.processHeadings\(node, postOpts\)/, '未补跑标题锚点 id（#链接跳转失效）');
  assert.match(pblk, /RenderPost\.addCopyButtons\(node, postOpts\)/, '未补跑代码块复制按钮');
  assert.match(pblk, /RenderPost\.processCodeBlocks\(node/, '未补跑代码高亮（遮罩里代码无高亮）');
  // 代码行号与阅读模式同源：看 #preview 的 code-line-numbers 类（同一设置写入，
  // preview-controller 同款判据）
  assert.match(pblk, /preview\.classList\.contains\('code-line-numbers'\)/, '代码行号未与阅读模式同源');
  // 后处理要在 innerHTML 赋值之后、markText 之前对节点执行
  const mIdx = wsrc.indexOf('node.innerHTML = html;');
  const seg = wsrc.slice(mIdx, mIdx + 300);
  assert.match(seg, /_postProcessWysiwygNode\(node\)/, '后处理未紧跟 innerHTML 赋值');
  // 共享管线本体必须真的调各 pass（两模式共用的渲染逻辑收敛在 render-post.js）
  const rpIdx = bundle.indexOf('const RenderPost = {');
  assert.ok(rpIdx > 0, '缺少 RenderPost 共享管线（两模式渲染逻辑必须同一入口）');
  const rblk = bundle.slice(rpIdx, rpIdx + 9000);
  assert.match(rblk, /PreviewPost\.processEmojiShortcodes\(container\)/, '共享管线未接 emoji pass');
  assert.match(rblk, /PreviewPost\.processMath\(container\)/, '共享管线未接公式 pass');
  assert.match(rblk, /PreviewPost\.processAbbreviations\(container, opts\)/, '共享管线未接缩写 pass');
  assert.match(rblk, /PreviewPost\.processHeadings\(container, opts\)/, '共享管线未接标题锚点 pass');
  assert.match(rblk, /PreviewPost\.addCopyButtons\(container, opts\)/, '共享管线未接复制按钮 pass');
  assert.match(rblk, /CodeBlock\.processCodeBlocks\(container/, '共享管线未接代码高亮 pass');
  assert.match(rblk, /removeAttribute\('disabled'\)/, '共享管线未解禁复选框');
});

test('遮罩异步 pass（图片/Mermaid/TOC）与排版同步、行号隐藏、锚点跳转齐备', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // 异步 pass：挂遮罩后登记，DOM 落定后由 flush 统一执行；节点级代数防旧请求写脏重建后的 DOM
  assert.match(wsrc, /_wysiwygPostProcessAsync\(node, idx\)/, '缺少异步 pass 方法');
  assert.match(wsrc, /RenderPost\.prepareImages\(node/, '未补跑图片本地解析（相对路径图片不显示）');
  assert.match(wsrc, /RenderPost\.runMermaid\(node/, '未补跑 Mermaid 渲染（遮罩里露源码）');
  assert.match(wsrc, /RenderPost\.applyCodeScrollOverflow\(node/, '未补跑代码块按需滚动条');
  assert.match(wsrc, /_wysiwygReplaceToc\(node\)/, '未补跑 [TOC] 目录替换');
  assert.match(wsrc, /_wysiwygMaskGen = \(this\._wysiwygMaskGen \|\| 0\) \+ 1/, '缺代数递增（遮罩重建后旧异步会写脏 DOM）');
  // 共享管线必须真的接图片/mermaid pass
  assert.match(bundle, /ImageProcessor\.processImages\(container/, '共享管线未接图片 pass');
  assert.match(bundle, /processMermaid\(container, opts\)/, '共享管线未接 mermaid pass');
  // 排版同步：阅读模式的字号/行高/字体是 #preview 的内联样式，遮罩必须复制计算值
  assert.match(wsrc, /_wysiwygMaskTypography\(node\)/, 'maskWysiwygBlock 未同步排版');
  assert.match(wsrc, /getComputedStyle\(this\.preview\)/, '排版同步未读 #preview 计算值');
  // 行号：所见即所得下强制隐藏，离开按设置恢复
  assert.match(wsrc, /applyWysiwygEditorChrome\(\) \{/, '缺少编辑器外壳同步方法');
  assert.match(wsrc, /cm\.setOption\('lineNumbers', on \? false :/, '行号未在所见即所得下隐藏');
  assert.match(wsrc, /this\.applyWysiwygEditorChrome\(\);\n    \},\n  \};/, 'clearWysiwygMasks 未恢复编辑器外壳');
  // #锚点跳转（wysiwyg 下 TOC/交叉引用点击须定位到源码行）
  assert.match(wsrc, /_wysiwygScrollToAnchor\(id\) \{/, '缺少锚点跳转方法');
  assert.match(wsrc, /_wysiwygScrollLineToCenter\(line\);/, '锚点跳转未把目标行滚到视口中部');
  // 链接分派与阅读模式共用
  const musrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'misc-ui.js'), 'utf8');
  assert.match(musrc, /async handlePreviewLinkClick\(link\) \{/, '缺少链接统一分派方法');
  assert.match(musrc, /this\.viewMode === 'wysiwyg'/, '链接分派未区分所见即所得的锚点行为');
  // 设置变更不得把行号改回（applySettings 走外壳同步入口）
  const ssrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'settings.js'), 'utf8');
  assert.match(ssrc, /if \(this\.applyWysiwygEditorChrome\) this\.applyWysiwygEditorChrome\(\);/,
    'applySettings 未走所见即所得外壳同步（设置变更会把行号改回）');
});

// ---------- 13. 虚拟模式滚动锚定（真机：滚动/点击视口内容被冲走） ----------

test('视口遮罩更新须做滚动锚定，恢复性滚动不得再触发 scroll 钩子', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const uIdx = wsrc.indexOf('updateWysiwygViewportMasks() {');
  const ublk = wsrc.slice(uIdx, wsrc.indexOf('_ensureWysiwygScrollHook()', uIdx));
  // 更新前采锚（虚拟模式才需要；小文档窗口=全文，遮罩集合不变）
  assert.match(ublk, /if \(this\._wysiwygVirtual\) \{[\s\S]{0,400}coordsChar/, '未在更新前采集视口顶行锚点');
  // 迭代收敛补偿：单次 scrollTo 会被 CM 高度重算时序部分 clamp；
  // 循环次数为调优参数（6 轮给远距一次性跳转的结构级位移留收敛余量），不锁死具体值
  assert.match(ublk, /for \(let i = 0; i < \d+; i\+\+\)[\s\S]{0,80}charCoords\(\{ line: anchor\.line/, '未做迭代收敛补偿（单次 scrollTo 会残留漂移）');
  assert.match(ublk, /_wysiwygAnchorRestoring = true/, '恢复性滚动未加标志位');
  // scroll 钩子须跳过恢复性滚动，否则锚定 → scroll → 更新 → 再锚定死循环
  const hIdx = wsrc.indexOf("_ensureWysiwygScrollHook() {");
  const hblk = wsrc.slice(hIdx, hIdx + 600);
  assert.match(hblk, /if \(self\._wysiwygAnchorRestoring\) return;/, 'scroll 钩子未跳过恢复性滚动（会死循环）');
});

// ---------- 14. 全量预渲染 + 全量视图驻留（2026-10-09：快速滚动源码闪现/落点漂移） ----------

test('行数 ≤ 10000 走全量预渲染：上限常量 + 预计算 + 前台兜底', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  assert.match(wsrc, /WYSIWYG_FULL_RENDER_MAX_LINES = 10000;/, '缺少全量渲染行数上限（10000）');
  // 全量块表：maxBlocks:Infinity（一块不跳）+ 回退切块器
  assert.match(wsrc, /precomputeWysiwygBlocksFull\(\) \{/, '缺少全量预计算入口');
  assert.match(wsrc, /maxBlocks: Infinity/, '全量预计算未用 maxBlocks:Infinity（会跳块）');
  // renderWysiwygMasks：按行数定全量/虚拟，全量时走 _enterWysiwygFullView
  assert.match(wsrc, /const full = cm\.lineCount\(\) <= WYSIWYG_FULL_RENDER_MAX_LINES;/, '未按行数决定全量模式');
  assert.match(wsrc, /this\._wysiwygFull = full;/, '未记录全量模式标志');
  assert.match(wsrc, /if \(full\) \{[\s\S]{0,60}?this\._enterWysiwygFullView\(\);/, '全量模式未走全量视图驻留');
  // 全量预渲染期间源文变化须作废预渲染结果
  assert.match(wsrc, /cm\.getValue\(\) === preValue/, '预渲染结果未校验源文未变（期间编辑会挂旧块表）');
});

test('全量视图驻留：直接写 cm.options 扩视口（避开 setOption 的内置 refresh），离开时恢复', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // ⚠️ 必须直接写 cm.options：setOption('viewportMargin') 的选项处理器自带 cm.refresh()，
  // 会多一次全量重渲染（万行文档 ~1.8s，2026-10-09 实测）
  assert.match(wsrc, /cm\.options\.viewportMargin = cm\.lineCount\(\) \+ 100;/, '全量视图驻留未扩视口到整篇');
  assert.doesNotMatch(wsrc, /setOption\('viewportMargin', cm\.lineCount/, '扩视口走了 setOption（触发内置 refresh，多一次全量重渲染）');
  // 单 operation 批量挂全部非活动块遮罩
  const eIdx = wsrc.indexOf('_enterWysiwygFullView() {');
  const eblk = wsrc.slice(eIdx, eIdx + 800);
  assert.match(eblk, /cm\.operation\(\(\) => \{/, '全量挂遮罩未用单 operation 批量（逐块=数千次 display 更新）');
  // 离开所见即所得恢复默认视口余量（窗口 3200：函数内含批量撤遮罩 + 活动块高亮撤行类 +
  // 正文排版行类撤除，函数体变长）
  const cIdx = wsrc.indexOf('clearWysiwygMasks() {');
  const cblk = wsrc.slice(cIdx, cIdx + 4200);
  assert.match(cblk, /setOption\('viewportMargin', 10\)/, '离开全量模式未恢复默认视口余量');
  assert.match(cblk, /this\._wysiwygFull = false;/, '离开未复位全量标志');
});

test('setViewMode 拦截走后台预渲染：按钮「渲染中」，完成后才切视图', () => {
  const themeSrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'theme.js'), 'utf8');
  // setViewMode 在同步切换流程之前拦截 wysiwyg
  assert.match(themeSrc, /if \(mode === 'wysiwyg'\) \{[\s\S]{0,300}?beginWysiwygPreRender/, 'setViewMode 未拦截所见即所得走预渲染');
  assert.match(themeSrc, /this\._cancelWysiwygPreRender\(\); \/\/ 用户抢先切到别的模式：取消预渲染/, '切到别的模式未取消在飞预渲染');
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // 预渲染入口：行数超限/空文档不启动（返回 false 走同步流程）
  assert.match(wsrc, /beginWysiwygPreRender\(\) \{/, '缺少预渲染入口');
  assert.match(wsrc, /if \(cm\.lineCount\(\) > WYSIWYG_FULL_RENDER_MAX_LINES\) return false;/, '超限行数未退回同步流程');
  // 让出一帧再跑昂贵步骤（wysiwyg.js 禁 rAF），完成前校验标签/模式未变
  const bIdx = wsrc.indexOf('beginWysiwygPreRender() {');
  const bblk = wsrc.slice(bIdx, bIdx + 4000);
  assert.match(bblk, /setTimeout\(/, '预渲染未让出主线程（首帧 spinner 画不出来）');
  assert.match(bblk, /self\.activeTab !== self\._wysiwygPreRenderTab || self\.viewMode !== self\._wysiwygPreRenderMode/, '预渲染完成未校验标签/模式未变（期间切走会错切视图）');
  assert.match(bblk, /self\.viewMode = 'wysiwyg';/, '预渲染完成后未执行模式切换');
  assert.match(bblk, /self\.applyViewMode\(\);/, '预渲染完成后未 applyViewMode（遮罩由 50ms 计时器消费预渲染块表）');
  // 预渲染结果在 applyViewMode 之后写入（其内部 clearWysiwygMasks 会清掉未消费结果）
  assert.match(bblk, /self\.applyViewMode\(\);[\s\S]{0,200}?self\._wysiwygPreRenderedBlocks = blocks;/, '预渲染块表未在 applyViewMode 之后落位（会被内部清理吃掉）');
  // 取消路径：代数递增 + 清定时器 + 按钮还原
  assert.match(wsrc, /_cancelWysiwygPreRender\(\) \{/, '缺少预渲染取消方法');
  assert.match(wsrc, /clearTimeout\(this\._wysiwygPreRenderTimer\)/, '取消未清预渲染定时器');
  // 按钮「渲染中」指示（类 + 文案）
  assert.match(wsrc, /_setWysiwygButtonRendering\(on\) \{/, '缺少按钮渲染中指示方法');
  assert.match(wsrc, /btn\.classList\.toggle\('wysiwyg-rendering', !!on\)/, '未切换 wysiwyg-rendering 类');
  assert.match(wsrc, /t\('viewModeWysiwygRendering'\)/, '按钮文案未走 i18n');
});

test('切标签取消在飞预渲染（它面向旧标签，不能在新标签上切视图）', () => {
  const themeSrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'theme.js'), 'utf8');
  const sIdx = themeSrc.indexOf('syncViewModeToTab() {');
  assert.ok(sIdx > 0, '缺少 syncViewModeToTab');
  assert.match(themeSrc.slice(sIdx, sIdx + 400), /if \(this\._wysiwygPreRendering\) this\._cancelWysiwygPreRender\(\);/,
    '切标签未取消在飞预渲染（会在新标签上错切视图 + 按钮残留「渲染中」）');
});

test('全量模式增量刷新：只重切边界 + 仅重挂源文变化的块（输入停顿不卡）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // refreshWysiwygBlocks 的全量快速路径
  assert.match(wsrc, /if \(self\._wysiwygFull\) \{\n          self\._refreshWysiwygFullIncremental\(\);/,
    '防抖刷新未走全量增量路径（万行文档每次停顿全量重挂会卡数秒）');
  const fIdx = wsrc.indexOf('_refreshWysiwygFullIncremental() {');
  assert.ok(fIdx > 0, '缺少全量增量刷新方法');
  const fblk = wsrc.slice(fIdx, fIdx + 2500);
  // 只切边界不渲染 html（skipHtml）
  assert.match(fblk, /this\.computeWysiwygBlocks\(true\)/, '增量刷新未按仅解析模式重切块');
  // 源文本同一性匹配：未变块保留旧 marker（CM 标记自动跟随文本）
  assert.match(fblk, /b\.src = this\._wysiwygBlockSource\(b\);/, '增量刷新未计算块源文本键');
  assert.match(fblk, /nb\.html = \(ob\.html !== undefined\) \? ob\.html : nb\.html;/, '未变块未复用缓存 html');
  assert.match(fblk, /data-block-index/, '块索引位移未同步遮罩节点块号（点击映射会落错块）');
  // 变化块在单 operation 内重挂
  assert.match(fblk, /cm\.operation\(\(\) => \{/, '增量刷新重挂未用单 operation 批量');
  assert.match(fblk, /this\.maskWysiwygBlock\(k\);/, '未重挂变化的块');
  // 渲染器支持 skipHtml（只切边界）
  const rsrc = fs.readFileSync(path.join(ROOT, 'src', 'unified-renderer.js'), 'utf8');
  assert.match(rsrc, /options\.skipHtml/, 'renderMarkdownBlocks 缺 skipHtml 选项');
});

test('旧块重渲后同步源文本键（否则增量刷新误判「源未变」保留旧遮罩）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  assert.match(wsrc, /b\.src = this\._wysiwygBlockSource\(b\); \}/, 'setWysiwygActiveBlock 重渲旧块后未同步源文本键');
});

test('虚拟模式（>10000 行）增强预取：沿滚动方向加大遮罩窗口', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  assert.match(wsrc, /WYSIWYG_PREFETCH_MARGIN = 200;/, '缺少虚拟模式增强预取边距');
  const uIdx = wsrc.indexOf('updateWysiwygViewportMasks() {');
  const ublk = wsrc.slice(uIdx, wsrc.indexOf('_ensureWysiwygScrollHook()', uIdx));
  assert.match(ublk, /this\._wysiwygLastScrollTop/, '未记录上次滚动位置（方向预取无从谈起）');
  assert.match(ublk, /top > this\._wysiwygLastScrollTop/, '未识别向下滚动方向');
  assert.match(ublk, /WYSIWYG_PREFETCH_MARGIN \* 2/, '滚动方向未加倍预取');
});

test('批量 DOM：空行挂类 / 撤遮罩均单 operation（万行文档不进出不卡）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // 空行 diff 挂类单 operation
  const blIdx = wsrc.indexOf('updateWysiwygBlankLines() {');
  const blblk = wsrc.slice(blIdx, blIdx + 1200);
  assert.match(blblk, /cm\.operation\(\(\) => \{/, '空行挂类未用单 operation 批量（数千空行=数千次 display 更新）');
  // 视口遮罩挂/撤单 operation
  const uIdx = wsrc.indexOf('updateWysiwygViewportMasks() {');
  const ublk = wsrc.slice(uIdx, wsrc.indexOf('_ensureWysiwygScrollHook()', uIdx));
  assert.match(ublk, /cm\.operation\(\(\) => \{\n        \/\/ 撤掉窗外遮罩/, '视口遮罩挂/撤未用单 operation 批量');
});

test('渲染中指示：CSS spinner + 三语言 i18n key', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  assert.match(css, /\.view-mode-tab\.wysiwyg-rendering \.icon \{\s*display: none;\s*\}/, '渲染中未隐藏原图标');
  assert.match(css, /\.view-mode-tab\.wysiwyg-rendering::before \{/, '缺少渲染中 spinner 伪元素');
  assert.match(css, /wysiwyg-rendering::before[\s\S]{0,300}animation: wysiwyg-mode-spin/, 'spinner 未接旋转动画');
  assert.match(css, /@keyframes wysiwyg-mode-spin/, '缺少旋转关键帧');
  const i18n = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'i18n-data.js'), 'utf8');
  const zh = i18n.indexOf("viewModeWysiwyg: '实时预览'");
  const en = i18n.indexOf("viewModeWysiwyg: 'Live Preview'");
  const es = i18n.indexOf("viewModeWysiwyg: 'Vista en vivo'", en + 10);
  for (const [name, idx] of [['zh', zh], ['en', en], ['es', es]]) {
    assert.ok(idx > 0, '未找到 ' + name + ' 的 viewModeWysiwyg');
    assert.match(i18n.slice(idx, idx + 200), /viewModeWysiwygRendering: '[^']+'/, name + ' 缺 viewModeWysiwygRendering 文案');
  }
});

// ---------- 15. 2026-10-12 六项真机反馈 + 卡死回归 + 跳转修复 ----------

test('格编辑 + 行列拖：按下前已存在的格编辑阈值不取消、释放时源码重建前提交（2026-10-14 用户反馈）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  assert.match(src, /st\.cellEditAtDown = this\._wysiwygCellEditing;/,
    '拖拽启动未记录按下前已存在的格编辑');
  assert.match(src, /this\._wysiwygCellEditing !== st\.cellEditAtDown\) this\._wysiwygEndCellEdit\(false\);/,
    '阈值块应只取消「本次按下才触发」的格编辑（取消已存在的编辑会丢内容）');
  const up = src.indexOf('_wysiwygTableDragUp() {');
  const upEnd = up >= 0 ? src.indexOf('_wysiwygTableDragCancel', up) : -1;
  assert.ok(up >= 0 && upEnd > up, '找不到 _wysiwygTableDragUp 函数体');
  assert.match(src.slice(up, upEnd), /if \(this\._wysiwygCellEditing\) this\._wysiwygEndCellEdit\(true, false\);/,
    '拖拽释放（已移动）必须先在源码重建前提交已存在的格编辑');
});

test('引用 + 行内语法渲染化：活动块 > 前缀灰显/左竖条，行内标记透明/文本渲染（2026-10-14 用户要求，Typora 式）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  assert.match(src, /function parseWysiwygInlineSpans\(text\)/, '缺少行内语法单遍扫描纯函数 parseWysiwygInlineSpans');
  for (const c of ['wysiwyg-inline-marker', 'wysiwyg-bold', 'wysiwyg-italic', 'wysiwyg-inline-code',
    'wysiwyg-strike', 'wysiwyg-highlight', 'wysiwyg-inline-link']) {
    assert.match(src, new RegExp(c), '缺少行内类 ' + c);
  }
  assert.match(src, /wysiwyg-quote-prefix/, '缺少引用前缀灰显类');
  assert.match(src, /wysiwyg-quote-bar/, '缺少引用左竖条类（最外层 > 的 ::before）');
  assert.match(src, /wysiwyg-quote-text/, '缺少引用正文预览字体类');
  // 排除项：围栏（代码内容）/表格（格编辑独立机制）/frontmatter 不得参与行内解析
  const dIdx = src.indexOf('_wysiwygApplyActiveDecor');
  const dBody = src.slice(dIdx, src.indexOf('_ensureWysiwygActiveDecorHook'));
  assert.match(dBody, /isFenceBlock/, '围栏块未排除行内解析（代码内容里的 ** 会被误判粗体）');
  assert.match(dBody, /isTableBlock/, '表格块未排除行内解析');
  assert.match(dBody, /isFrontmatter/, 'frontmatter 未排除行内解析（YAML 行会误判行内语法）');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  assert.match(css, /\.wysiwyg-quote-prefix \{[^}]*var\(--text-secondary\)/, '引用前缀未灰显');
  assert.match(css, /\.wysiwyg-quote-bar::before \{[^}]*var\(--accent-color\)/, '引用左竖条未用 accent-color');
  assert.match(css, /\.wysiwyg-inline-marker \{[^}]*color: transparent/, '行内标记未透明');
  assert.doesNotMatch(css, /\.wysiwyg-inline-code \{[^}]*padding/, '行内代码不应加 padding（会干扰光标 x 测量）');
});

test('底部滚动余量：.CodeMirror-lines padding-bottom 50vh（2026-10-14 用户反馈：底部行滚不上来）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  assert.match(css, /\.CodeMirror-lines \{[^}]*padding-bottom: 50vh;/,
    '缺少底部滚动余量（内容底缘即滚动底缘，编辑底部行不便）');
});

test('异步 pass 刷新风暴守卫：仅块内含 img/mermaid/[TOC] 才启动 pass 链（卡死回归）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const pIdx = wsrc.indexOf('_wysiwygPostProcessAsync(node, idx) {');
  assert.ok(pIdx > 0, '缺少 _wysiwygPostProcessAsync');
  const pblk = wsrc.slice(pIdx, pIdx + 2500);
  // 三个存在性守卫：无内容可处理的块不得进入 pass 链（no-op promise 的 then 仍会触发 refresh）
  assert.match(pblk, /querySelector\('img'\) != null|querySelector\('img'\)/, '缺 img 存在性守卫（无图片块也跑 prepareImages → 每块一次 cm.refresh 风暴）');
  assert.match(pblk, /code\.language-mermaid/, '缺 mermaid 存在性守卫');
  // 源码里 [TOC] 是转义字面量 \[TOC\]，按 hasToc 守卫变量 + TOC 字样匹配
  assert.match(pblk, /hasToc = node\.querySelectorAll[\s\S]{0,160}?TOC/, '缺 [TOC] 段存在性守卫');
});

test('ref 定义行块：渲染器输出零高度占位 + 双条件判据 + CSS 塌缩（阅读模式对齐）', () => {
  const rsrc = fs.readFileSync(path.join(ROOT, 'src', 'unified-renderer.js'), 'utf8');
  // 源文本为 REF_DEF_LINE = /^\s{0,3}\[：`^` 需 \^ 转义，源里的反斜杠需 \\ 匹配
  assert.match(rsrc, /REF_DEF_LINE = \/\^\\s\{0,3\}\\\[/, '缺少 ref 定义行判定正则');
  assert.match(rsrc, /function isOnlyLinkRefDefs\(slice\)/, '缺少「整块纯定义」判据函数');
  assert.match(rsrc, /html === '' && slice\.trim\(\) && isOnlyLinkRefDefs\(slice\)/, '占位必须双条件（空 html + 纯定义行）——渲染失败的块保持源码可见');
  assert.match(rsrc, /<div class="wysiwyg-block-hidden"><\/div>/, '占位输出缺失');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  assert.match(css, /\.wysiwyg-block-hidden \{\s*height: 0;\s*overflow: hidden;/, '缺占位塌缩 CSS（height:0 + overflow:hidden）');
});

test('预渲染带 loading 覆盖层：挂起至遮罩挂完、按代配对释放（不残留/不早放）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // 释放助手：按代（gen）配对，错代不得消费（新一代预渲染持有自己的 loading 层）
  assert.match(wsrc, /_wysiwygReleasePreRenderLoad\(\) \{[\s\S]{0,420}this\._wysiwygPreRenderLoadGen !== this\._wysiwygPreRenderGen[\s\S]{0,240}this\._endPaneLoad\(\);/,
    '缺少 _wysiwygReleasePreRenderLoad（按代配对的 loading 层释放）');
  const bIdx = wsrc.indexOf('beginWysiwygPreRender() {');
  assert.ok(bIdx > 0, '缺少 beginWysiwygPreRender');
  const bblk = wsrc.slice(bIdx, bIdx + 4200);
  // 打开 loading 层并标记本代持有（setTimeout 闭包内是 self.，this 不指向 mixin 对象）
  assert.match(bblk, /this\._beginPaneLoad\(\)/, '预渲染开始未调 _beginPaneLoad（用户看到全屏源码数秒）');
  assert.match(bblk, /this\._wysiwygPreRenderLoadOpen = true/, '预渲染开始未标记 loading 层持有（释放配对错乱）');
  assert.match(bblk, /this\._wysiwygPreRenderLoadGen = gen/, '未记录持有 loading 层的代（新预渲染启动会吃掉旧覆盖层）');
  // 完成路径**不得**裸调 _endPaneLoad 提前释放：applyViewMode 的 50ms 计时器之后还要挂全部
  // 遮罩（数秒同步步骤），早放 = 「loading 消失 → 源码/空白数秒」（2026-10-13 用户反馈 #1）
  assert.ok(!/self\._endPaneLoad\(\)/.test(bblk), 'beginWysiwygPreRender 内仍裸调 _endPaneLoad（应按代经助手释放）');
  assert.match(bblk, /self\._wysiwygReleasePreRenderLoad\(\);/, '预渲染中止路径未收尾 loading 层（覆盖层残留）');
  const cIdx = wsrc.indexOf('_cancelWysiwygPreRender() {');
  assert.ok(cIdx > 0, '缺少 _cancelWysiwygPreRender');
  const cblk = wsrc.slice(cIdx, cIdx + 900);
  const relAt = cblk.indexOf('this._wysiwygReleasePreRenderLoad()');
  const bumpAt = cblk.indexOf('_wysiwygPreRenderGen = (this._wysiwygPreRenderGen || 0) + 1');
  assert.ok(relAt > 0 && (bumpAt < 0 || relAt < bumpAt),
    '取消预渲染未先于 gen 推进释放 loading 层（按代配对会失败，覆盖层残留）');
  // renderWysiwygMasks 挂完遮罩（含 refresh/冲刷异步 pass）才在 finally 释放——所有提前返回路径同样收尾
  const rIdx = wsrc.indexOf('renderWysiwygMasks() {');
  assert.ok(rIdx > 0, '缺少 renderWysiwygMasks');
  assert.match(wsrc.slice(rIdx, rIdx + 3400), /finally \{[\s\S]{0,80}this\._wysiwygReleasePreRenderLoad\(\);/,
    'renderWysiwygMasks 未在 finally 释放预渲染 loading 层（早放露源码/残留）');
  // 离开所见即所得（快切模式会清掉 50ms 计时器、renderWysiwygMasks 永不执行）也要收尾
  const themeSrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'theme.js'), 'utf8');
  const aIdx = themeSrc.indexOf('applyViewMode() {');
  assert.ok(aIdx > 0, '缺少 applyViewMode');
  assert.match(themeSrc.slice(aIdx, aIdx + 1500),
    /viewMode !== 'wysiwyg'[\s\S]{0,220}this\._wysiwygReleasePreRenderLoad\(\);/,
    'applyViewMode 离开所见即所得时未收尾仍持有的预渲染 loading 层');
});

test('切标签进 wysiwyg 走预渲染管线（不裸奔源码）+ renderWysiwygMasks 预渲染期守卫', () => {
  const themeSrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'theme.js'), 'utf8');
  const sIdx = themeSrc.indexOf('syncViewModeToTab() {');
  assert.ok(sIdx > 0, '缺少 syncViewModeToTab');
  const sblk = themeSrc.slice(sIdx, sIdx + 2000);
  assert.match(sblk, /if \(target === 'wysiwyg'\)/, '切标签未对 wysiwyg 目标单列分支');
  assert.match(sblk, /this\.beginWysiwygPreRender && this\.beginWysiwygPreRender\(\)/, '切标签进 wysiwyg 未走 beginWysiwygPreRender（大文档会同步 precompute 数秒源码裸奔）');
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const rIdx = wsrc.indexOf('renderWysiwygMasks() {');
  assert.ok(rIdx > 0, '缺少 renderWysiwygMasks');
  assert.match(wsrc.slice(rIdx, rIdx + 400), /if \(this\._wysiwygPreRendering\) return;/, '预渲染在飞时 renderWysiwygMasks 未跳过（会消费到旧块表/空块表）');
});

test('块「编辑」按钮：非列表块挂载 + 列表块豁免（点行即编辑）+ 点击先取区间再解罩 + 右键放行 + i18n/CSS 齐备', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  assert.match(wsrc, /_addWysiwygEditButton\(node\) \{/, '缺少 _addWysiwygEditButton');
  const eIdx = wsrc.indexOf('_addWysiwygEditButton(node) {');
  const eblk = wsrc.slice(eIdx, eIdx + 1200);
  assert.match(eblk, /class\.\.\.|'block-edit-btn'/, '按钮缺 block-edit-btn 类');
  assert.match(eblk, /t\('editBlock'\)/, '按钮文案未走 i18n');
  assert.match(eblk, /querySelector\('button\.block-edit-btn'\)/, '按钮未做去重（重复挂）');
  // 列表块豁免（2026-10-16 用户反馈 #1）：maskWysiwygBlock 按块首行判列表，列表不挂按钮、
  // 改挂 no-btn 类（补回 14px 底边距，遮罩高度与有按钮时一致）
  assert.match(wsrc, /_wysiwygBlockIsList\(b\) \{/, '缺少 _wysiwygBlockIsList（列表块判据）');
  const lIdx = wsrc.indexOf('_wysiwygBlockIsList(b) {');
  const lblk = wsrc.slice(lIdx, lIdx + 700);
  assert.match(lblk, /\^\s*\\s\{0,3\}\(\[-\*\+\]\|\\d\{1,9\}\[\.\)\]\)\(\\s\|\$\)/,
    '列表判据未用「≤3 空格 + 列表标记，后随空格/Tab/行尾」CommonMark 口径（`1.` 独占一行也是合法标记）');
  const mkIdx = wsrc.indexOf('maskWysiwygBlock(idx) {');
  const mkblk = wsrc.slice(mkIdx, mkIdx + 4000);
  assert.match(mkblk, /_wysiwygBlockIsList\(b\)\) node\.classList\.add\('wysiwyg-mask-no-btn'\);/, '列表块遮罩未挂 no-btn 类（ul 成 last-child 后 14px 边距被清零、遮罩矮 14px）');
  assert.match(mkblk, /else this\._addWysiwygEditButton\(node\);/, 'maskWysiwygBlock 未在非列表块挂载编辑按钮');
  // CSS：no-btn 遮罩补回内容元素 14px 底边距（特异性须压过 last-child 清零规则）
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  assert.match(css, /wysiwyg-mask-no-btn > \*:last-child \{ margin-bottom: 14px; \}/, 'no-btn 遮罩未补回 14px 底边距（渲染↔源码切换块下内容跳动）');
  // 点击：先 mark.find() 取块区间（撤罩后区间失效），再解罩 + 光标落块首
  const mIdx = wsrc.indexOf('button.block-edit-btn');
  assert.ok(mIdx > 0, '缺 block-edit-btn 的 mousedown 处理');
  const mblk = wsrc.slice(mIdx, mIdx + 900);
  assert.match(mblk, /mark\.find\(\)/, '编辑按钮点击未用 mark.find() 取块区间');
  assert.match(mblk, /setWysiwygActiveBlock/, '编辑按钮点击未解罩目标块');
  // 列表行精确落行（2026-10-16 用户反馈 #2）：点 <li> 内走 data-source-line（remark 插件
  // 标注的块切片内 1-based 行号）还原精确行，替代整块竖向比例估算（点中间项恒偏上一行）
  assert.match(wsrc, /ev\.target\.closest\('li'\)/, '列表行点击未取 <li> 目标（精确落行入口缺失）');
  const liIdx = wsrc.indexOf("ev.target.closest('li')");
  const liblk = wsrc.slice(liIdx, liIdx + 1500);
  assert.match(liblk, /data-source-line/, '列表行落点未用 data-source-line 标注');
  assert.match(liblk, /r\.from\.line \+ Math\.max\(0, srcLine - 1\)/, '列表行精确行号未按「块首行 + 标注行号 − 1」还原');
  assert.match(liblk, /!exactLine && rect\.height > 0/, '非列表项点击未保留比例估算回退');
  // 右键菜单放行（与 copy-btn 同待遇）
  const cmSrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'context-menu.js'), 'utf8');
  assert.ok((cmSrc.match(/\.copy-btn, \.block-edit-btn/g) || []).length >= 2, 'context-menu 右键放行未含 block-edit-btn（两处 handler 都要）');
  // i18n 三语言
  const i18n = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'i18n-data.js'), 'utf8');
  assert.ok((i18n.match(/editBlock: /g) || []).length >= 3, 'editBlock i18n 三语言不齐');
  // CSS：hover 显现 + 代码块块内让位复制按钮
  assert.match(css, /\.block-edit-btn \{/, '缺 .block-edit-btn 基础样式');
  assert.match(css, /\.wysiwyg-block-mask:hover \.block-edit-btn \{ opacity: 1/, '编辑按钮未在 hover 时显现');
  assert.match(css, /right: 76px/, '代码块块内编辑按钮未让位复制按钮');
});

test('活动块背景高亮：cm-wysiwyg-active-block 行类 + 统一挂/撤 + CSS', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  assert.match(wsrc, /ACTIVE_CLASS = 'cm-wysiwyg-active-block'/, '缺少 ACTIVE_CLASS 常量');
  assert.match(wsrc, /_applyWysiwygActiveHighlight\(\) \{/, '缺少 _applyWysiwygActiveHighlight');
  // 至少 5 个挂/撤挂点：setWysiwygActiveBlock 两路、全量渲染尾、增量刷新尾、清遮罩撤光（setTimeout 闭包内为 self.）
  const callCount = (wsrc.match(/(?:this|self)\._applyWysiwygActiveHighlight\(\)/g) || []).length;
  assert.ok(callCount >= 5, '_applyWysiwygActiveHighlight 挂点不足（应覆盖活动块切换两路/全量渲染尾/增量刷新尾/清遮罩撤光），实际 ' + callCount);
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  // ⚠️ 选择器必须命中 CM5 实际渲染的 div.CodeMirror-linebackground（addLineClass('background')
  // 的类不在 pre.CodeMirror-line 上——旧选择器从未生效，2026-10-13 浏览器诊断发现）
  const hlIdx = css.indexOf('div.CodeMirror-linebackground.cm-wysiwyg-active-block');
  assert.ok(hlIdx > 0, '活动块高亮 CSS 未锚定 div.CodeMirror-linebackground（CM5 bgClass 实际落点）');
  const hlRule = css.slice(hlIdx, hlIdx + 300);
  // 2026-10-13 三轮修正（用户：「左边一个个的小圆角不好看，要显示为其他颜色、看起来像一块
  // 编辑」，参考图 = 代码块灰盒）：底色 = 代码块同色 --code-bg；逐行无圆角（多行连成整块）；
  // 仅块首行上缘/末行下缘圆角（JS 挂 first/last 行类）→ 整块读作一个圆角矩形编辑区
  assert.match(hlRule, /background: var\(--code-bg\)/, '活动块高亮未用代码块同色 --code-bg 底色');
  assert.ok(!/border-radius/.test(hlRule), '活动块底色规则仍带逐行圆角（多行会看起来一排小圆角条）');
  assert.match(css, /cm-wysiwyg-active-first \{[^}]*border-top-left-radius: 6px/, '缺块首行上缘圆角规则');
  assert.match(css, /cm-wysiwyg-active-last \{[^}]*border-bottom-left-radius: 6px/, '缺块末行下缘圆角规则');
  // JS 侧首/末行角类成对管理（挂/撤都含两个角类）
  assert.match(wsrc, /ACTIVE_FIRST_CLASS = 'cm-wysiwyg-active-first'/, '缺少 ACTIVE_FIRST_CLASS 常量');
  assert.match(wsrc, /ACTIVE_LAST_CLASS = 'cm-wysiwyg-active-last'/, '缺少 ACTIVE_LAST_CLASS 常量');
  const hlFnIdx = wsrc.indexOf('_applyWysiwygActiveHighlight() {');
  const hlFn = wsrc.slice(hlFnIdx, hlFnIdx + 2600);
  assert.match(hlFn, /addLineClass\(h, 'background', ACTIVE_FIRST_CLASS\)/, '活动块首行未挂圆角类');
  assert.match(hlFn, /addLineClass\(h, 'background', ACTIVE_LAST_CLASS\)/, '活动块末行未挂圆角类');
  // 2026-10-14 用户要求「只有光标所在行是灰色」：非容器块按选区头行取行号，
  // 光标块内移动时由 setWysiwygActiveBlock 同块路径重挂 → 底色跟随光标
  assert.match(hlFn, /getCursor\('head'\)/, '活动块高亮未按光标行（选区头行）取行号（单行灰底）');
  assert.match(hlFn, /RE\.fence\.test\(\(first \|\| ''\)\.trim\(\)\) \|\| RE\.table\.test\(first \|\| ''\)/,
    '缺容器块（围栏/表格）整块灰盒例外判断');
  // 撤除须在两处都覆盖：_applyWysiwygActiveHighlight 重挂旧行 + clearWysiwygMasks 整体清理
  assert.ok((wsrc.match(/removeLineClass\(h, 'background', ACTIVE_FIRST_CLASS\)/g) || []).length >= 2,
    '首行角类撤除点不足（_apply 重挂 + clearWysiwygMasks 两处都要撤）');
  assert.ok((wsrc.match(/removeLineClass\(h, 'background', ACTIVE_LAST_CLASS\)/g) || []).length >= 2,
    '末行角类撤除点不足（_apply 重挂 + clearWysiwygMasks 两处都要撤）');
});

test('编辑态排版对齐渲染态（2026-10-14 用户截图反馈）：plain-text 行类 + 字号同步 + CSS 同参', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  // JS：活动块源文行挂 .wysiwyg-plain-text 行类（先清后挂，撤除两处覆盖）
  assert.match(wsrc, /addLineClass\(h, 'text', 'wysiwyg-plain-text'\)/, '活动块源文行未挂 plain-text 行类');
  assert.ok((wsrc.match(/removeLineClass\(h, 'text', 'wysiwyg-plain-text'\)/g) || []).length >= 2,
    'plain-text 行类撤除点不足（_apply 重挂 + clearWysiwygMasks 两处都要撤）');
  // 字号同步：读 #preview 计算值（用户「预览字号」设置，含缩放），回落 settings
  assert.match(wsrc, /_syncWysiwygTextSize\(\) \{/, '缺少 _syncWysiwygTextSize');
  const syncIdx = wsrc.indexOf('_syncWysiwygTextSize() {');
  const syncFn = wsrc.slice(syncIdx, syncIdx + 1400);
  assert.match(syncFn, /getComputedStyle\(this\.preview\)/, '未读 #preview 计算字号');
  assert.match(syncFn, /previewFontSize/, '缺 settings.previewFontSize 回落');
  assert.match(syncFn, /--wysiwyg-text-size/, '未同步 --wysiwyg-text-size 变量');
  // CSS：与渲染态遮罩 .wysiwyg-block-mask.preview-content 同参（预览字族/1.7 行高/正文色/
  // 字号=「预览字号」变量，默认 16px）
  const ptIdx = css.indexOf('.wysiwyg-plain-text {');
  assert.ok(ptIdx > 0, '缺少 .wysiwyg-plain-text 规则');
  const ptRule = css.slice(ptIdx, ptIdx + 400);
  assert.match(ptRule, /font-family: var\(--font-preview\)/, 'plain-text 未用预览字族');
  assert.match(ptRule, /font-size: var\(--wysiwyg-text-size, 16px\)/, 'plain-text 字号未同步「预览字号」设置');
  assert.match(ptRule, /line-height: 1\.7/, 'plain-text 行高未对齐渲染态 1.7');
  assert.match(ptRule, /color: var\(--text-primary\)/, 'plain-text 颜色未对齐渲染态正文色');
  // 2026-10-14 用户截图二轮：① 块内空行（松散列表项间）不挂 plain-text——本类行高 1.7
  // 特异性高于空行塌缩规则（.CodeMirror .cm-wysiwyg-blank .CodeMirror-line 12px），
  // 挂了会把空行撑回全高 → 列表编辑态「多出来很多空白行」
  const plainLoop = wsrc.indexOf('this._wysiwygPlainLines = [];');
  assert.ok(plainLoop > 0, '缺 plain-text 挂行循环');
  assert.match(wsrc.slice(plainLoop, plainLoop + 700),
    /\(cm\.getLine\(lineNo\) \|\| ''\)\.trim\(\) === ''\) continue/, 'plain-text 挂行循环未跳过块内空行');
  // ② gfm token 色中和：标题 cm-header（蓝）/列表 cm-variable-2（海军蓝）/引用 cm-quote（绿）
  // 等 token span 嵌在渲染化 span 内，内层 color 压过继承 → 编辑态文字发蓝。
  // plain-text 行内所有 cm-* span 统一 color:inherit
  const tokIdx = css.indexOf('.wysiwyg-plain-text span[class*="cm-"]');
  assert.ok(tokIdx > 0, '缺少 gfm token 色中和规则（.wysiwyg-plain-text span[class*="cm-"]）');
  assert.match(css.slice(tokIdx, tokIdx + 200), /color: inherit/, 'token 色中和规则未设 color: inherit');
});

test('表格单元格就地源码编辑（Phase 2 / R5，2026-10-13）：点击进格编辑、提交回写+重渲、三处守卫齐备', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // mousedown 表格分支路由到单元格编辑（Ctrl/Cmd+格内链接放行到链接分支）
  const cellBranch = src.indexOf("cellEl.closest('a')");
  assert.ok(cellBranch > 0, '缺表格单元格点击分支');
  assert.match(src.slice(cellBranch, cellBranch + 1500), /_wysiwygStartCellEdit\(/,
    '表格格点击未路由到 _wysiwygStartCellEdit');
  assert.match(src.slice(cellBranch, cellBranch + 1500), /ctrlKey \|\| ev\.metaKey/,
    '格内链接 Ctrl/Cmd 跟随未放行');
  // 提交回写：专用 origin 的 replaceRange + b.src 同步 + 立即重渲本块
  const endIdx = src.indexOf('_wysiwygEndCellEdit(commit, settle) {');
  assert.ok(endIdx > 0, '缺 _wysiwygEndCellEdit');
  const endBody = src.slice(endIdx, endIdx + 4000);
  assert.match(endBody, /replaceRange\([\s\S]{0,220}\+wysiwygTableCell'\)/, '单元格提交缺专用 origin 的 replaceRange 回写');
  assert.match(endBody, /b\.src = this\._wysiwygBlockSource\(b\)/, '单元格提交未同步 b.src（全量增量刷新将误判源未变）');
  assert.match(endBody, /this\.maskWysiwygBlock\(blockIdx\)/, '单元格提交未立即重渲本块遮罩');
  assert.match(endBody, /this\._wysiwygCellEditing = null/, '结束编辑未清状态（重入守卫失效）');
  // 三处守卫：活动块切换 / 撤本块遮罩 / 整体清遮罩 前必须先提交。
  // setWysiwygActiveBlock 的守卫必须**延迟**到下一 tick（它常由 cursorActivity 调起、
  // 在 CM mousedown operation 内，同步提交 → NotFoundError，2026-10-13 用户报）；
  // 另两处撤罩会销毁在编格 DOM，必须同步。
  const actIdx = src.indexOf('setWysiwygActiveBlock(idx) {');
  assert.ok(actIdx > 0, '缺 setWysiwygActiveBlock');
  // 守卫须延迟到下一 tick（CM mousedown operation 内同步提交 → NotFoundError）；
  // 延迟 tick 内还须防误触发：单元格已被替换（st2.cell !== cell）或焦点仍在原格
  // （cursorActivity 误触发，打字到一半被提交/光标跳走，2026-10-13 真机反馈）都跳过
  assert.match(src.slice(actIdx, actIdx + 1000), /setTimeout\(\(\) => \{[\s\S]{0,400}st2\.cell !== cell[\s\S]{0,300}document\.activeElement === cell[\s\S]{0,200}self\._wysiwygEndCellEdit\(true\);[\s\S]{0,40}\}, 0\);/,
    'setWysiwygActiveBlock 的在编格提交守卫未延迟到下一 tick（CM operation 内同步提交 → NotFoundError；延迟 tick 内需防误触发）');
  const unmaskIdx = src.indexOf('unmaskWysiwygBlock(idx) {');
  assert.ok(unmaskIdx > 0, '缺 unmaskWysiwygBlock');
  assert.match(src.slice(unmaskIdx, unmaskIdx + 600), /_wysiwygCellEditing\.blockIdx === idx[\s\S]{0,120}_wysiwygEndCellEdit\(true\)/,
    'unmaskWysiwygBlock 缺本块在编格提交守卫');
  const clearIdx = src.indexOf('clearWysiwygMasks() {');
  assert.ok(clearIdx > 0, '缺 clearWysiwygMasks');
  assert.match(src.slice(clearIdx, clearIdx + 500), /_wysiwygEndCellEdit\(true\)/, 'clearWysiwygMasks 缺在编格提交守卫');
  // 纯函数导出（行为测试见 wysiwyg-blocks.test.cjs）
  assert.match(src, /const api = \{[\s\S]{0,220}splitTableRow, editTableRowCell\,/,
    'splitTableRow / editTableRowCell 未导出');
  // CSS：单元格源码编辑态样式
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  assert.match(css, /wysiwyg-cell-editing[\s\S]{0,320}outline: 1px solid var\(--accent-color\)/,
    '缺表格单元格源码编辑态样式（accent 描边）');
});

test('表格行/列操作（2026-10-13 用户要求）：hover 增行/增列 + 拖拽换位接线齐备；blur 提交延迟到下一 tick（NotFoundError 修复）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // 结构纯函数导出（行为测试见 wysiwyg-blocks.test.cjs）
  assert.match(src, /parseTableStructure, buildTableLine, addTableRow, addTableColumn, moveTableRow, moveTableColumn\,/,
    '增行/增列/换位纯函数未导出');
  // 遮罩构建时注入表格工具（wrap 定位容器 + 两枚按钮）
  assert.match(src, /this\._addWysiwygTableTools\(node\);/, 'maskWysiwygBlock 未挂载表格工具');
  const tIdx = src.indexOf('_addWysiwygTableTools(node) {');
  assert.ok(tIdx > 0, '缺 _addWysiwygTableTools');
  assert.match(src.slice(tIdx, tIdx + 900), /wysiwyg-table-wrap/, '表格未包进定位容器（按钮无法相对表格定位）');
  assert.match(src.slice(tIdx, tIdx + 900), /wysiwyg-table-add-col/, '缺增列按钮');
  assert.match(src.slice(tIdx, tIdx + 900), /wysiwyg-table-add-row/, '缺增行按钮');
  // mousedown 路由：工具按钮短路 → _wysiwygTableAdd；格分支带拖拽守卫
  const toolBranch = src.indexOf("closest('.wysiwyg-table-add-row, .wysiwyg-table-add-col')");
  assert.ok(toolBranch > 0, 'mousedown 未识别表格工具按钮');
  assert.match(src.slice(toolBranch, toolBranch + 400), /_wysiwygTableAdd\(/, '工具按钮点击未路由到 _wysiwygTableAdd');
  const cellBranch = src.indexOf('const dragSt = self._wysiwygTableDrag;');
  assert.ok(cellBranch > 0, '格点击分支未引用拖拽状态');
  assert.match(src.slice(cellBranch, cellBranch + 400), /if \(dragSt\) \{[\s\S]{0,250}if \(!isOwnHeaderDrag\) return;/,
    '格点击分支缺拖拽守卫（pointerdown 先于 mousedown；表头格自身列拖态例外放行格编辑）');
  // mousedown 顶部总守卫：拖拽中 gutter 按下的目标是轨道 span（非单元格），
  // 不吞掉会落到「点击映射源码行」分支 → 拖拽中途撤罩表格块 + 挪光标；
  // 表头格自身列拖态例外（2026-10-13 反馈 #2：表头点击也要进格编辑）
  const mdIdx = src.indexOf("node.addEventListener('mousedown'");
  assert.match(src.slice(mdIdx, mdIdx + 1400), /if \(self\._wysiwygTableDrag\) \{[\s\S]{0,500}if \(!ownHeader\) \{ ev\.preventDefault\(\); return; \}/,
    'mousedown 缺拖拽中总守卫（轨道按下会触发点击映射 → 撤罩表格块）');
  // pointerdown 拖拽入口 + 行把手区（首格左 16px）
  assert.match(src, /node\.addEventListener\('pointerdown'/, '遮罩未委托 pointerdown（行/列拖拽入口）');
  const dIdx = src.indexOf('_wysiwygTableDragStart(ev) {');
  assert.ok(dIdx > 0, '缺 _wysiwygTableDragStart');
  assert.match(src.slice(dIdx, dIdx + 3300), /dxRow < 16 && dxRow >= -16/,
    '行拖拽把手区未限定在 [格左缘-16, 格左缘+16)（表格外左缘把手，下界防整条 gutter 误判）');
  // 格编辑结束焦点恢复（2026-10-13 反馈残留：Enter 提交后 blur 焦点掉 body = 光标丢失）：
  // 下一 tick 判定——仅当焦点掉 body 才回编辑器（不干扰点另一格/点源码行已接走的焦点）
  const rfIdx = src.indexOf('_wysiwygRestoreEditorFocus(endLine) {');
  assert.ok(rfIdx > 0, '缺 _wysiwygRestoreEditorFocus（格编辑结束焦点回编辑器）');
  assert.match(src.slice(rfIdx, rfIdx + 900), /setTimeout\(\(\) => \{[\s\S]{0,300}_wysiwygTableDrag[\s\S]{0,200}document\.activeElement/,
    '焦点恢复未延迟判定 / 未在拖拽进行中让路');
  assert.match(src.slice(rfIdx, rfIdx + 900), /ae && ae !== document\.body[\s\S]{0,400}cm\.focus\(\)/,
    '焦点恢复未在焦点掉 body 时回 CM（光标丢失根因）');
  // 提交 + 取消两路都必须调用（定义 1 处 + 调用 2 处 = 3）
  assert.strictEqual((src.match(/_wysiwygRestoreEditorFocus\(/g) || []).length, 3,
    '焦点恢复未同时接在提交路径与取消（Esc）路径');
  // 列悬停高亮 + 表上方拖拽胶囊（2026-10-13 参考图）：CSS 选不到「同列」，JS 按悬停列
  // 给整列挂 wysiwyg-col-hover；胶囊 = th::before，表头按下 + 4px 阈值逻辑零改动接管
  assert.match(src, /setColHover/, '缺列悬停类托管（setColHover）');
  assert.match(src, /wysiwyg-col-hover/, '缺列悬停类名');
  // 行悬停也须 JS 托管：行把手盒在 tr 盒外而又是 tr:hover 的产物（循环依赖，纯 CSS
  // 时指针移向把手 → :hover 失效 → 把手消失 → 命中掉 pre，行拖拽启动不了）
  assert.match(src, /setRowHover/, '缺行悬停类托管（setRowHover）');
  assert.match(src, /wysiwyg-row-hover/, '缺行悬停类名');
  // 边缘邻近悬停（2026-10-13 用户第 2/3 条）：左 gutter → 行握点；顶 gutter → 列握点；
  // 停在单元格上 → 都不出（悬停零高亮，只有拖动才蓝）
  assert.match(src, /addEventListener\('mousemove', \((e)\) => \{[\s\S]{0,900}gridLeft[\s\S]{0,600}gridTop - 24[\s\S]{0,600}gridLeft - 24/,
    '缺 mousemove 边缘邻近判定（左 gutter 带 gridLeft-24 / 顶 gutter 带 gridTop-24，与 24px 常驻轨道同宽）');
  assert.match(src, /addEventListener\('mousemove', \((e)\) => \{[\s\S]{0,1600}setRowHover\(null\); setColHover\(-1\);/,
    '缺 mousemove 兜底（停在单元格上 → 两握点都隐藏）');
  assert.match(src, /addEventListener\('mouseleave', \(\) => \{ setRowHover\(null\); setColHover\(-1\); \}\)/, '缺离开 wrap 清行/列悬停接线');
  // 轨道 + 握点两件套：轨道常驻命中区（DOM 冒泡进 wrap），握点 JS 定位
  assert.match(src, /rowGripEl\.className = 'wysiwyg-table-row-grip'/, '缺行握点元素（可见小把手，轨道内 JS 定位）');
  assert.match(src, /colGripEl\.className = 'wysiwyg-table-col-grip'/, '缺列握点元素（可见小把手，轨道内 JS 定位）');
  // 结构提交：整块 replaceRange + 清 250ms 防抖 + 立即重算块表（全量增量 / 非全量视口重挂两路）
  const cIdx = src.indexOf('_wysiwygCommitTableBlock(blockIdx, newSource, origin) {');
  assert.ok(cIdx > 0, '缺 _wysiwygCommitTableBlock（行数可能变，不能走单行提交路径）');
  const cblk = src.slice(cIdx, cIdx + 1800);
  assert.match(cblk, /clearTimeout\(this\._wysiwygMaskTimer\)/, '整块回写后未清 250ms 输入防抖（会重复解析）');
  assert.match(cblk, /_refreshWysiwygFullIncremental\(\)/, '全量模式回写后未立即重算块表');
  assert.match(cblk, /computeWysiwygBlocks\(\);/, '非全量模式回写后未立即重算块表');
  // 增行/增列 → 自动格编辑新格（回写后块索引可能位移，须显式传新索引）
  const aIdx = src.indexOf('_wysiwygTableAdd(kind, maskNode) {');
  assert.ok(aIdx > 0, '缺 _wysiwygTableAdd');
  assert.match(src.slice(aIdx, aIdx + 1700), /_wysiwygStartCellEditAt\(tRow, tCol, newIdx\)/,
    '增行/增列后未自动进入新格编辑（Typora 式无缝续输）');
  assert.match(src.slice(aIdx, aIdx + 1700), /const tRow = \(kind === 'row'\) \? rows\.length - 2 : 0;[\s\S]{0,120}const tCol = \(kind === 'row'\) \? 0 : lastInfo\.cells\.length - 1;/,
    '增行/增列落格未改新增行/列的第一个单元格（2026-10-14 用户要求：增行=新末行首格，增列=新末列表头格）');
  // 拖拽：4px 阈值（表头不动手=格编辑）+ 进拖先取消误触发的格编辑 + 释放按纯函数回写
  const mIdx = src.indexOf('_wysiwygTableDragMove(e) {');
  assert.ok(mIdx > 0, '缺 _wysiwygTableDragMove');
  assert.match(src.slice(mIdx, mIdx + 700), /Math\.abs\(e\.clientX - st\.startX\) < 4/, '缺拖拽阈值（表头按下不动手 = 格编辑）');
  assert.match(src.slice(mIdx, mIdx + 700), /_wysiwygEndCellEdit\(false\)/, '进入拖拽未先取消表头误触发的格编辑');
  const upIdx = src.indexOf('_wysiwygTableDragUp() {');
  assert.ok(upIdx > 0, '缺 _wysiwygTableDragUp');
  // 窗口含开头的「无位移+格编辑失焦」分支（2026-10-14），需放宽到回写模式之后
  assert.match(src.slice(upIdx, upIdx + 2200), /moveTableRow\(src, st\.idx, to\) : moveTableColumn\(src, st\.idx, to\)/,
    '拖拽释放未走纯函数回写');
  assert.match(src.slice(upIdx, upIdx + 2200), /_wysiwygCommitTableBlock\(idx, newSrc, '\+wysiwygTableMove'\)/,
    '拖拽释放未整块回写');
  // blur 提交一律延迟到下一 tick：blur 常发生在 CM 自己的 mousedown operation 内，
  // 同步 replaceRange + 重挂遮罩会毁掉 CM 操作还要移动的节点 → NotFoundError（2026-10-13 用户报）
  const blurIdx = src.indexOf("cell.addEventListener('blur'");
  assert.ok(blurIdx > 0, '缺 blur 监听');
  assert.match(src.slice(blurIdx, blurIdx + 1000), /setTimeout\(\(\) => \{[\s\S]{0,320}document\.activeElement === cell[\s\S]{0,200}_wysiwygEndCellEdit\(true\);/,
    'blur 提交未延迟（同步提交在 CM operation 内重建行 DOM → NotFoundError；延迟 tick 内需防焦点搬回误触发）');
  // 悬停状态 JS 托管（2026-10-13 反馈 #3：按钮在盒外 6px 空隙 + 下缘落下方块内容区被
  // 相邻行 z-index:2 压在下面 → 纯 CSS :hover 点不到）。JS 维护悬停类 + 延迟隐藏。
  // 反馈 #4/#5（边缘条带）：显示改由 per-strip 悬停类驱动——条带自身即悬停区
  //（透明时也恒可命中），鼠标在表格本体上不显示；悬停桥（行 z-index 抬升）保留。
  assert.match(src, /wysiwyg-table-tools-hover/, '缺 JS 托管的悬停桥状态类');
  assert.match(src, /addEventListener\('mouseleave', scheduleHideTools\)/, '缺离开 wrap 的延迟隐藏接线');
  assert.match(src, /wysiwyg-table-line-hover/, '缺悬停期表格行 z-index 抬升接线（压过下方块）');
  assert.match(src, /armStripHover\(colBtn, 'wysiwyg-table-add-col-hover'\)/, '缺增列条带 per-strip 悬停接线');
  assert.match(src, /armStripHover\(rowBtn, 'wysiwyg-table-add-row-hover'\)/, '缺增行条带 per-strip 悬停接线');
  const ashIdx = src.indexOf('const armStripHover = (stripEl, cls) => {');
  assert.ok(ashIdx > 0, '缺条带悬停托管函数（armStripHover）');
  assert.match(src.slice(ashIdx, ashIdx + 700), /setTimeout\(\(\) => \{ timer = null; wrap\.classList\.remove\(cls\); \}, 200\)/,
    '条带悬停缺 200ms 宽限（跨越 6px 间隙时会在点击落定前消失）');
  assert.match(src.slice(ashIdx, ashIdx + 700), /stripEl\.addEventListener\('mouseenter', show\);/,
    '条带悬停缺 mouseenter 显示接线');
  // CSS：边缘条带由 per-strip 悬停类驱动显隐（opacity，恒 display:flex；条带自身恒可命中）
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  assert.match(css, /\.wysiwyg-table-wrap \{ position: relative; width: fit-content; max-width: 100%; padding-top: 24px; padding-bottom: 24px; \}/,
    '缺表格容器定位锚 / 未收窄到表格网格宽（整宽 wrap 会让条带漂离表格）/ 缺上下留白（各 24px：上容纳列拖把手、下容纳增行条带，2026-10-13 反馈 #8 定稿）');
  assert.match(css, /\.wysiwyg-table-wrap\.wysiwyg-table-add-col-hover \.wysiwyg-table-add-col[\s\S]{0,120}\.wysiwyg-table-wrap\.wysiwyg-table-add-row-hover \.wysiwyg-table-add-row \{[\s\S]{0,120}opacity: 1;/,
    '增列/增行条带未随 per-strip 悬停类显示（反馈 #5：移到边缘才显示）');
  assert.match(css, /opacity: 0;/, '条带默认未透明隐藏（恒 display:flex，用 opacity 显隐）');
  assert.match(css, /pointer-events: auto;[\s\S]{0,80}条带自身即悬停触发区|\.wysiwyg-table-add-col,[\s\S]{0,400}pointer-events: auto;/,
    '条带透明态未保持可命中（反馈 #5：条带自身即悬停触发区，必须恒 pointer-events:auto）');
  assert.match(css, /\.CodeMirror \.CodeMirror-line\.wysiwyg-table-line-hover \{ z-index: 3; \}/, '缺悬停期表格行 z-index 抬升（须含 .CodeMirror 前缀压过 codemirror.css）');
  assert.match(css, /wysiwyg-table-add-col \{ left: 100%; top: 24px; bottom: 24px; width: 16px; margin-left: 0; \}/,
    '缺增列竖条几何（右缘、与表格同高、16px 宽；反馈 #3 紧贴表格边框 = margin-left:0；上下界=24px 留白内表体区）');
  assert.match(css, /wysiwyg-table-add-row \{ bottom: 8px; left: 0; width: 100%; height: 16px; \}/,
    '缺增行横条几何（下缘通宽、16px 厚与竖条一致；反馈 #3 紧贴表格底边 = bottom:8px 即条带顶缘=表底缘，落 wrap 下留白 24px 内不压下一行）');
  // 拖拽视觉（2026-10-13 用户第 6 条：只有拖动才高亮）：被拖行/列浅蓝底
  //（2026-10-13 反馈 #1/#2 定稿：淡蓝背景 = 被拖行/列；列原「右缘蓝线」inset 阴影移除，
  // 蓝线统一为独立落点指示线 .wysiwyg-table-drop-line，避免双蓝线混淆）
  assert.match(css, /wysiwyg-table-dragging-row \{[\s\S]{0,120}background-color: var\(--accent-subtle\)/, '缺拖动中被拖行高亮');
  assert.match(css, /wysiwyg-table-dragging-col \{[\s\S]{0,120}background-color: var\(--accent-subtle\);\s*\}/, '缺拖动中被拖列高亮（仅浅蓝底，右缘蓝线已移交给落点指示线）');
  assert.ok(!/wysiwyg-table-dragging-col[\s\S]{0,200}inset -2px/.test(css), '被拖列右缘蓝线未移除（参考图只有一条落点蓝线，双蓝线会混淆）');
  // 落点指示线（2026-10-13 反馈 #1/#2：蓝线 = 要拖动到的位置）：行拖横线通表宽、
  // 列拖竖线通表高（top:24/bottom:24 = 留白内表体区，随 wrap 上下留白 24px），
  // 默认 opacity:0 只在拖动态显示
  assert.match(css, /\.wysiwyg-table-drop-line \{[\s\S]{0,200}position: absolute;[\s\S]{0,200}background: var\(--accent-color\);[\s\S]{0,200}opacity: 0;[\s\S]{0,200}pointer-events: none;/,
    '缺落点指示线基础规则（蓝线、默认隐藏、不拦命中）');
  assert.match(css, /wysiwyg-drop-line-row \{ left: 0; width: 100%; height: 2px; \}/, '缺行拖落点横线几何（通表宽 2px 细线）');
  assert.match(css, /wysiwyg-drop-line-col \{ top: 24px; bottom: 24px; width: 2px; \}/, '缺列拖落点竖线几何（通表高 2px 细线，上下界=留白内表体区）');
  assert.match(css, /wysiwyg-table-col-pill\.wysiwyg-dragging \.wysiwyg-table-col-grip \{[\s\S]{0,200}background: var\(--accent-color\)/,
    '缺拖动中握点蓝底胶囊（轨道 .wysiwyg-dragging → 内部握点变蓝底）');
  // 表格外拖拽轨道+握点（2026-10-13 参考图）：必须是 wrap 上的真实元素——伪元素伸到
  // 表盒外会被 .preview-content table 的 overflow-x:auto 裁剪（不可见/不可命中）。
  // 轨道 = 常驻透明命中区（gutter 在 wrap 盒外，事件靠 DOM 冒泡进 wrap，轨道不常驻则
  // gutter 里 mousemove/pointerdown 收不到）；握点 = 可见小把手，JS 定位。
  const rhIdx = css.indexOf('.wysiwyg-table-row-handle');
  assert.ok(rhIdx > 0, '缺行轨道元素规则（.wysiwyg-table-row-handle，wrap 上常驻真实元素）');
  assert.match(css.slice(rhIdx, rhIdx + 300), /position: absolute;[\s\S]{0,60}left: -24px;[\s\S]{0,80}top: 24px;[\s\S]{0,80}bottom: 24px;[\s\S]{0,80}width: 24px;/,
    '行轨道未覆盖左 gutter 带（left:-24px 宽 24px = 常驻命中区，与列轨同宽；上下界随 wrap 留白 24px）');
  const rgIdx = css.indexOf('.wysiwyg-table-row-grip');
  assert.ok(rgIdx > 0, '缺行握点规则（.wysiwyg-table-row-grip，轨道内可见小把手）');
  assert.match(css.slice(rgIdx, rgIdx + 400), /color: var\(--text-tertiary/, '行握点悬停态非中性灰点阵');
  const pillIdx2 = css.indexOf('.wysiwyg-table-col-pill');
  assert.ok(pillIdx2 > 0, '缺列轨道元素规则（.wysiwyg-table-col-pill，wrap 上常驻真实元素）');
  assert.match(css.slice(pillIdx2, pillIdx2 + 300), /top: 0;[\s\S]{0,160}height: 24px;/,
    '列轨道未覆盖顶 gutter 带（top:0 高 24px = wrap 上留白区，底边贴表顶，不再伸到行外）');
  const cgIdx = css.indexOf('.wysiwyg-table-col-grip');
  assert.ok(cgIdx > 0, '缺列握点规则（.wysiwyg-table-col-grip，轨道内可见小把手）');
  assert.match(css.slice(cgIdx, cgIdx + 450), /color: var\(--text-tertiary/, '列握点悬停态非中性灰点阵');
  // 悬停不高亮：wysiwyg-row-hover / wysiwyg-col-hover 只作状态类，不得再有底色规则；
  // 阅读模式的行 hover 高亮（.preview-content tbody tr:hover）在遮罩上必须豁免
  assert.ok(css.indexOf('tr.wysiwyg-row-hover {') < 0, '悬停行高亮规则未移除（用户第 6 条：只有拖动才高亮）');
  assert.ok(!/td\.wysiwyg-col-hover[\s\S]{0,200}background-color/.test(css), '悬停列高亮规则未移除（用户第 6 条：只有拖动才高亮）');
  assert.match(css, /\.editor-container\.wysiwyg-mode \.wysiwyg-block-mask tbody tr:hover \{[\s\S]{0,80}background-color: transparent/,
    '缺 wysiwyg 遮罩 tr:hover 豁免（阅读模式行 hover 高亮漏进遮罩 → 悬停行出浅蓝底）');
  // 顶部留白：表格是文档首行时，表上方把手不得被滚动容器裁掉（用户第 1 条反馈）
  assert.match(css, /\.editor-container\.wysiwyg-mode \.CodeMirror-lines \{[\s\S]{0,80}padding-top: 24px;/,
    '缺 wysiwyg 模式内容顶部留白（表格在文档首行时列把手被顶缘裁剪）');
  // JS：轨道元素创建（常驻命中区）+ 握点定位 + 拖拽入口分支
  assert.match(src, /rowTrackEl\.className = 'wysiwyg-table-row-handle'/, '缺行轨道元素创建（wrap 上常驻真实元素）');
  assert.match(src, /colTrackEl\.className = 'wysiwyg-table-col-pill'/, '缺列轨道元素创建（wrap 上常驻真实元素）');
  assert.match(src, /rowGripEl\.style\.top = \(rr\.top - kr\.top \+ rr\.height \/ 2 - gh \/ 2\)/,
    '行握点未随悬停行中线定位（按实测握点高 gh 居中；offsetParent = 行轨，须以行轨 rect 为基准）');
  assert.match(src, /colGripEl\.style\.left = \(hr\.left - kr\.left \+ hr\.width \/ 2\)/,
    '列握点未随悬停列中心定位（offsetParent = 列轨，须以列轨 rect 为基准）');
  assert.match(src, /rowTrackEl\.getBoundingClientRect\(\)[\s\S]{0,260}rowGripEl\.style\.top/,
    '行握点定位未以行轨 rect 为基准（wrap 加上下留白后以 wrap rect 为基准会整体偏移上留白 24px）');
  const dsIdx = src.indexOf('_wysiwygTableDragStart(ev) {');
  assert.match(src.slice(dsIdx, dsIdx + 2500), /closest\('\.wysiwyg-table-row-handle'\)/, '拖拽入口未接行把手元素');
  assert.match(src.slice(dsIdx, dsIdx + 2500), /closest\('\.wysiwyg-table-col-pill'\)/, '拖拽入口未接列把手元素');
  // 表头行可拖（2026-10-13 反馈 #2）：行轨反查从 i=0 起、行握点不再排除 THEAD
  assert.match(src.slice(dsIdx, dsIdx + 2500), /closest\('\.wysiwyg-table-row-handle'\)[\s\S]{0,400}for \(let i = 0; i < trsAll\.length/,
    '拖拽入口行轨反查未含表头行（i 须从 0 起，反馈 #2）');
  assert.ok(src.indexOf("parentElement.tagName !== 'THEAD'") < 0,
    '行握点仍排除表头行（反馈 #2：表头行也要出握点、可拖）');
  // 表头格点击也可编辑（2026-10-13 反馈「表头也要可以编辑」）：表头格是列拖把手，
  // mousedown 对本表头格自身启动的列拖态放行格编辑；真拖动超阈值时先取消编辑再进拖拽
  assert.match(src, /cellEl === dragSt\.trs\[0\]\.children\[dragSt\.idx\]/,
    '表头格普通点击未放行格编辑（表头也是列拖把手，但点击不动应进格编辑）');
  // 阈值处只取消「本次按下才触发」的格编辑（表头按下误触）；按下前已存在的格编辑
  // 保留到释放时提交（2026-10-14 用户反馈：改完格内容立即拖行/列不得丢内容）
  assert.match(src, /if \(this\._wysiwygCellEditing && this\._wysiwygCellEditing !== st\.cellEditAtDown\) this\._wysiwygEndCellEdit\(false\);/,
    '拖拽超阈值未区分「本次按下触发的格编辑」与「按下前已存在的格编辑」（取消后者会丢内容）');
  // 表头行拖拽的 DOM 结构保护：tr 离开 thead 会被浏览器收进 tbody——
  // 恢复时须归位 thead；原位释放（no-op）也须恢复 DOM（防留下空 thead）
  assert.match(src, /thead\.appendChild\(dragTr\)/, '表头行拖拽恢复未归位 thead（会留下空 thead 坏结构）');
  assert.match(src, /to === st\.idx\) \{[\s\S]{0,120}_wysiwygTableRestoreDom\(st\);/,
    '原位释放未恢复 DOM（表头拖拽 no-op 会留下坏结构）');
  // 拖动中蓝胶囊跟随指针（2026-10-13 反馈 #1，行/列同款）：
  // 行拖按 y、列拖按 x 连续定位（clamp 到轨道），mouse 移动让位给 pointermove 写入
  assert.match(src, /gripEl\.style\.top = top \+ 'px'/, '拖拽中行握点未按指针 y 连续跟随（反馈 #1）');
  assert.match(src, /gripEl\.style\.left = left \+ 'px'/, '拖拽中列握点未按指针 x 连续跟随（反馈 #1）');
  assert.match(src, /if \(self\._wysiwygTableDrag && self\._wysiwygTableDrag\.moved\) return;/,
    'mousemove 未在拖拽中让位（会与拖拽跟随两路写入打架 → 胶囊跳动/消失）');
  // 拖动态切换：超阈值轨道加 .wysiwyg-dragging（内部握点变蓝底），结束态恢复
  assert.match(src, /track\.classList\.add\('wysiwyg-dragging'\)/, '进入拖拽未把轨道切为拖动态（握点变蓝底胶囊）');
  assert.match(src, /querySelectorAll\('\.wysiwyg-dragging'\)/, '结束拖拽未恢复握点悬停态');
  // 落点指示线（2026-10-13 反馈 #1/#2：拖拽中被拖行/列留在原位淡蓝高亮、蓝线标落点，
  // 对齐参考图——不再实时重排 DOM，释放时按 st.target 一次换位提交）
  assert.match(src, /dropLineEl\.className = 'wysiwyg-table-drop-line'/, '缺落点指示线元素创建');
  assert.match(src, /lineEl\.style\.top = \(boundary - wr\.top - 1\) \+ 'px'/, '行拖落点线未按边界 y 定位（相对 wrap 盒、2px 线居中于边界 = 边界-1）');
  assert.match(src, /lineEl\.style\.left = \(boundary - wr\.left - 1\) \+ 'px'/, '列拖落点线未按边界 x 定位（相对 wrap 盒、2px 线居中于边界 = 边界-1）');
  assert.match(src, /lineEl\.className = 'wysiwyg-table-drop-line wysiwyg-drop-line-row'/, '行拖落点线未切横线形态');
  assert.match(src, /lineEl\.className = 'wysiwyg-table-drop-line wysiwyg-drop-line-col'/, '列拖落点线未切竖线形态');
  assert.match(src, /const to = \(typeof st\.target === 'number' && isFinite\(st\.target\)\) \? st\.target : st\.idx;/,
    '拖拽释放未按 st.target（move 中算出的落点）提交（拖拽中 DOM 恒为原序，不能读 DOM 序）');
  assert.ok(src.indexOf('ref.before(dragTr)') < 0 && src.indexOf('after(dragTr)') < 0,
    '拖拽中仍在实时重排 DOM（反馈 #1/#2：被拖项应留在原位高亮，蓝线指示落点，释放时一次换位）');
  assert.match(src, /st\.target = st\.idx;/, '拖拽状态未初始化落点 st.target（未动指针即释放时的兜底）');
  // 蓝把手尺寸（2026-10-13 反馈「行/列拖按钮样式一致」）：同一风格 = 16px 厚 + 4px 圆角，
  // 点阵恒为未按下态 ⋮⋮ 2×3 点阵（2026-10-14 用户反馈：按下/拖动只背景变蓝，不换点阵）
  // ——行拖 = 竖条（16px 宽 × 行高）；列拖 = 横条（宽 = 被拖列宽、高 16px）；结束态清除 inline 尺寸
  assert.match(css, /wysiwyg-table-row-handle\.wysiwyg-dragging \.wysiwyg-table-row-grip \{[\s\S]{0,200}background: var\(--accent-color\);[\s\S]{0,120}border-radius: 4px;/,
    '行拖蓝把手未做 16px 厚圆角竖条（与列拖/增行增列条同厚 16px）');
  assert.match(src, /grip\.style\.height = rh \+ 'px'/, '行拖进入拖动态未把蓝把手高度设为行高（反馈 #3）');
  assert.match(src, /const refRow = st\.trs\[st\.idx\];/, '行拖蓝把手行高取值源不对（行拖 = 被拖行）');
  assert.ok(!/grip\.textContent = '\\u22EE';/.test(src) && !/grip\.textContent = '\\u22EF'/.test(src),
    '按下/拖动仍换点阵文本（2026-10-14 用户反馈：点阵须保持未按下态 ⋮⋮ 2×3 点阵，只变蓝底）');
  assert.match(css, /wysiwyg-table-col-pill\.wysiwyg-dragging \.wysiwyg-table-col-grip \{[\s\S]{0,200}border-radius: 4px;/,
    '列拖蓝把手未做圆角宽横条（参考图：宽横条）');
  assert.ok(!/wysiwyg-table-col-pill\.wysiwyg-dragging \.wysiwyg-table-col-grip \{[\s\S]{0,200}width: 16px;/.test(css),
    '列拖把手仍定宽 16px（应为宽横条、宽度 = 被拖列宽）');
  assert.match(src, /grip\.style\.width = Math\.max\(26, Math\.round\(cw\)\) \+ 'px'/,
    '列拖蓝把手宽未按被拖列宽设置（参考图：宽横条，最小 26px 兜底）');
  assert.match(src, /g\.style\.height = '';[\s\S]{0,160}g\.style\.width = '';[\s\S]{0,160}g\.textContent = '\\u22EE\\u22EE';/,
    '结束拖拽未清除蓝胶囊 inline 尺寸/点阵文本（会残留行高/宽横胶囊）');
  // 落点线 inline 坐标残留（2026-10-14 用户截图「线跑右边去了」）：无提交的拖拽
  // （原位释放/取消）不重建遮罩，同一 drop-line 元素存活到下一次拖拽；行拖/列拖各写
  // 各的轴（top/left），残留的 inline 压过 CSS left:0/top:24px → 另一方向的线串位
  // （列拖残留 left=表宽 → 行拖横线从表右缘起飞、向右延伸出表格）。收尾必须连
  // left/top 一起清；move 中写自己轴前清另一轴（每次拖拽自洽，纵深防御）。
  const edDragIdx = src.indexOf('_wysiwygEndTableDragState() {');
  assert.ok(edDragIdx > 0, '缺 _wysiwygEndTableDragState');
  const edDragBody = src.slice(edDragIdx, edDragIdx + 2200);
  assert.match(edDragBody, /lineEl\.style\.opacity = '0';[\s\S]{0,200}lineEl\.style\.left = '';[\s\S]{0,80}lineEl\.style\.top = '';[\s\S]{0,120}lineEl\.className = 'wysiwyg-table-drop-line';/,
    '结束拖拽未清落点线 inline 坐标（残留 left/top 会让下一方向拖拽的线串位）');
  assert.match(src, /lineEl\.style\.left = ''; \/\/ 清上一次列拖残留的 inline left/,
    '行拖未清上一次列拖残留的 inline left（纵深防御：每次拖拽自洽）');
  assert.match(src, /lineEl\.style\.top = ''; \/\/ 清上一次行拖残留的 inline top/,
    '列拖未清上一次行拖残留的 inline top（纵深防御：每次拖拽自洽）');
  // 握点尺寸（2026-10-13 反馈 #3 定稿）：16×16 小方块、点阵 12px、与增行/增列条同厚
  assert.match(css.slice(rgIdx, rgIdx + 400), /height: 16px;/, '行握点未做 16px 高小方块（与增行/增列条同厚 16px）');
  assert.match(css.slice(rgIdx, rgIdx + 400), /font-size: 12px;/, '行握点点阵未加大（反馈 #3）');
  assert.match(css.slice(cgIdx, cgIdx + 450), /top: 2px;[\s\S]{0,80}height: 16px;/, '列握点未做 16px 高小方块（24px 上留白内底缘距表顶缘 6px，与行握点同距）');
  // IME 时序怪癖守卫（2026-10-13 用户第 7 条「输入完马上丢光标，像被回写」）：
  // compositionend 可能先于选字确认 Enter 到达（isComposing=false）——250ms 内只吞不提交
  assert.match(src, /lastCompositionEnd: 0/, '格编辑状态未记录组合结束时刻');
  assert.match(src, /st\.lastCompositionEnd = Date\.now\(\)/, 'compositionend 未记录时刻');
  assert.match(src, /e\.key === 'Enter' && st\.lastCompositionEnd && Date\.now\(\) - st\.lastCompositionEnd < 250/,
    '缺 IME 确认键残影守卫（组合刚结束的 Enter 被误当提交 → 回写重渲 + 焦点跳出格）');
  // 提交路径同步补焦点（延迟恢复的同步兜底）：setSelection 后直接 cm.focus()
  assert.ok((src.match(/cm\.focus\(\)/g) || []).length >= 2,
    '提交路径未同步 cm.focus()（延迟恢复外的第一道焦点归宿保障）');
});

test('配色方案：default 白底蓝 + 独立 classic 主题 + 设置项/导出透传', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  // default = 白底 + #2563EB 蓝
  const dIdx = css.indexOf('[data-color-scheme="default"]');
  assert.ok(dIdx > 0, '缺 default 配色变量块');
  const dblk = css.slice(dIdx, dIdx + 2600);
  assert.match(dblk, /--bg-primary: #ffffff/, 'default 未改白底');
  assert.match(dblk, /--accent-color: #2563eb/, 'default 主题色未改 #2563EB');
  // classic 独立主题（旧暖灰风格）
  const cIdx = css.indexOf('[data-color-scheme="classic"]');
  assert.ok(cIdx > 0, '缺 classic 配色变量块');
  const cblk = css.slice(cIdx, cIdx + 2600);
  assert.match(cblk, /--bg-primary: #faf9f7/, 'classic 未保留暖灰底');
  assert.match(css, /data-color-scheme="classic"\]\[data-theme="dark"\]/, 'classic 深色变量块未纳入选择器组');
  // 设置项 + i18n
  const stSrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'settings.js'), 'utf8');
  assert.match(stSrc, /\{ value: 'classic', label: t\('schemeClassic'\) \}/, '设置选项缺 classic');
  const i18n = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'i18n-data.js'), 'utf8');
  assert.match(i18n, /schemeClassic: '经典'/, 'zh 缺 schemeClassic');
  assert.match(i18n, /schemeClassic: 'Classic'/, 'en 缺 schemeClassic');
  assert.match(i18n, /schemeClassic: 'Clásico'/, 'es 缺 schemeClassic');
});

test('所见即所得跳转修复：面包屑/锚点/全局搜索跳转前解罩目标块', () => {
  const laySrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'layout.js'), 'utf8');
  const jIdx = laySrc.indexOf('_jumpToHeadingLine(line) {');
  assert.ok(jIdx > 0, '缺少 _jumpToHeadingLine');
  const jblk = laySrc.slice(jIdx, jIdx + 1400);
  assert.match(jblk, /this\.viewMode === 'wysiwyg'/, '面包屑跳转未识别 wysiwyg 模式');
  assert.match(jblk, /this\.setWysiwygActiveBlock\(idx\)/, '面包屑跳转未先解罩目标块（光标被 clamp 到遮罩边缘，跳不准）');
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const aIdx = wsrc.indexOf('_wysiwygScrollToAnchor(id) {');
  assert.ok(aIdx > 0, '缺少 _wysiwygScrollToAnchor');
  const ablk = wsrc.slice(aIdx, aIdx + 3000);
  assert.match(ablk, /this\._wysiwygMarks\.has\(aIdx\)\) this\.setWysiwygActiveBlock\(aIdx\)/, '锚点跳转未先解罩目标块');
  const fSrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'find.js'), 'utf8');
  const fmIdx = fSrc.indexOf('async jumpToMatch(filePath, line, col, len) {');
  assert.ok(fmIdx > 0, '缺少 jumpToMatch');
  const fblk = fSrc.slice(fmIdx, fmIdx + 3000);
  assert.match(fblk, /this\.viewMode === 'wysiwyg'/, '全局搜索跳转未识别 wysiwyg 模式');
  assert.match(fblk, /this\.setWysiwygActiveBlock\(idx\)/, '全局搜索跳转未解罩目标块');
  assert.match(fblk, /Date\.now\(\) - t0 < 2000/, '遮罩未挂完时未等块表就绪（刚切文件预渲染在飞会落空）');
});

test('precompute 防御：返回前滤除缺 start/end 的畸形块（HMR 混载 reading-start 崩溃双保险）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const pIdx = wsrc.indexOf('precomputeWysiwygBlocksFull() {');
  assert.ok(pIdx > 0, '缺少 precomputeWysiwygBlocksFull');
  const pblk = wsrc.slice(pIdx, pIdx + 2200);
  assert.match(pblk, /blocks\.filter\(\(b\) => b && typeof b\.start === 'number' && typeof b\.end === 'number' && b\.end > b\.start\)/,
    'precompute 返回前未滤畸形块条目（undefined 元素进下游 .start 读取即崩）');
});

test('表格交互 2026-10-14 四项修复：表后落行/Enter 切格/点空白不撤罩', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // ① 表格是文档最后块时，格编辑结束须在块后补空行再落光标——clamp 到块内最后一行会
  // 把表格判成活动块撤罩，「表格下面的一行一旦输入内容，表格就会变成源码格式」
  const elIdx = src.indexOf('_wysiwygCellEditEndLine(b) {');
  assert.ok(elIdx > 0, '缺 _wysiwygCellEditEndLine（格编辑结束落位行）');
  const elblk = src.slice(elIdx, elIdx + 900);
  assert.match(elblk, /base >= cm\.lineCount\(\)/, '未识别「块是文档最后块」（b.end == lineCount）');
  assert.match(elblk, /cm\.replaceRange\('\\n', \{ line: last, ch \}, \{ line: last, ch \}, '\+wysiwygTableCell'\)/,
    '块后无行时未补空行（光标仍会落进表格遮罩区间）');
  assert.strictEqual((src.match(/_wysiwygCellEditEndLine\(/g) || []).length, 3,
    '补空行落位未同时接在提交路径与取消（Esc）路径（定义 1 处 + 调用 2 处 = 3）');
  // ③ Enter = 移到下一格：同行右邻 → 下一行首格 → 末行提交回编辑器；
  // 切格前必须先提交本格（状态被新格覆盖后旧格 blur 守卫变 no-op，内容会丢）
  assert.match(src, /let nr = st\.rowIdx, nc = st\.colIdx \+ 1;[\s\S]{0,60}if \(nc >= n\) \{ nr = st\.rowIdx \+ 1; nc = 0; \}/,
    'Enter 未算下一格（右邻 → 下一行首格）');
  assert.match(src, /if \(nr < trsNow\.length\) \{[\s\S]{0,60}self\._wysiwygStartCellEditAt\(nr, nc\);/,
    'Enter 有下一格时未进下一格编辑（末行才走提交回编辑器）');
  const saIdx = src.indexOf('_wysiwygStartCellEditAt(rowIdx, colIdx, blockIdx) {');
  assert.ok(saIdx > 0, '缺少 _wysiwygStartCellEditAt');
  assert.match(src.slice(saIdx, saIdx + 400), /if \(this\._wysiwygCellEditing\) this\._wysiwygEndCellEdit\(true, false\);/,
    '切格（Tab/Enter/增行增列）未先提交本格（旧格内容丢失）/ 提交未用 settle=false（切格会误挪光标到块后、表格是最后块时误补空行）');
  // ④ 点表格右侧/下方空白不进源码模式：capture 阶段按「点击映射行是否落在已挂遮罩的
  // 表格块」拦截（preventDefault → CM onMouseDown 先查 defaultPrevented 不挪光标）；
  // 遮罩内表格杂点（wrap 留白）在遮罩 mousedown 吞掉，不再走纵向比例映射源码行
  const gIdx = src.indexOf('_ensureWysiwygTableClickGuard() {');
  assert.ok(gIdx > 0, '缺表格点击守卫 _ensureWysiwygTableClickGuard');
  const gblk = src.slice(gIdx, gIdx + 1600);
  assert.match(gblk, /wrapper\.addEventListener\('mousedown', \(ev\) => \{[\s\S]{0,200}t\.closest\('\.' \+ MASK_CLASS\)\) return;/,
    '守卫未排除遮罩内部点击（格/轨道/条带/按钮由遮罩自行派发）');
  assert.match(gblk, /cm\.coordsChar\(\{ left: ev\.clientX, top: ev\.clientY \}\)/, '守卫未按点击坐标换算源码行');
  assert.match(gblk, /wysiwygBlockIndexAt\(pos\.line\)/, '守卫未把点击行映射到块');
  assert.match(gblk, /maskNode\.querySelector\('\.wysiwyg-table-wrap'\)/, '守卫未识别「已挂遮罩的表格块」');
  assert.match(gblk, /ev\.preventDefault\(\);[\s\S]{0,80}\}, true\);/, '守卫未 preventDefault（CM 仍会把光标落进表格行撤罩）');
  assert.match(src, /this\._ensureWysiwygTableClickGuard\(\);/, '守卫未在遮罩挂载流程接线');
  assert.match(src, /if \(node\.querySelector && node\.querySelector\('\.wysiwyg-table-wrap'\)\) return;/,
    '遮罩内表格杂点未吞掉（会落入纵向比例映射 → 整表撤罩变源码）');
  // ① 根因修复：GFM 会把表格末行之下紧邻的非空文本行解析成表格行（吸进表格 → 光标行
  // 落入表格块 → 判活动块撤罩变源码）。输入守卫：表下空行被插入非空白文本时整体下移
  // 一行（空行留在表格与文本之间）；IME 组合期跳过、compositionend 后补下移。
  const pgIdx = src.indexOf('_wysiwygPushTypedLineBelowTable(L) {');
  assert.ok(pgIdx > 0, '缺表下输入下移 _wysiwygPushTypedLineBelowTable');
  const pgblk = src.slice(pgIdx, pgIdx + 1200);
  assert.match(pgblk, /blocks\[i\]\.end === L/, '未识别「行上方是块末行」');
  assert.match(pgblk, /node\.querySelector\('\.wysiwyg-table-wrap'\)/, '未限定已挂遮罩的表格块（活动表格 = 源码态，正常编辑不得干扰）');
  assert.match(pgblk, /cm\.replaceRange\('\\n', \{ line: L, ch: 0 \}, \{ line: L, ch: 0 \}, '\+wysiwygTableTypeGuard'\)/, '未把输入下移一行（空行分隔被吃掉）');
  const tgIdx = src.indexOf('_ensureWysiwygTableTypeGuard() {');
  assert.ok(tgIdx > 0, '缺表下输入守卫接线 _ensureWysiwygTableTypeGuard');
  const tgblk = src.slice(tgIdx, tgIdx + 1600);
  assert.match(tgblk, /if \(c\.from\.line !== c\.to\.line \|\| c\.from\.ch !== c\.to\.ch\) return;/,
    '守卫未限定「纯插入」（零宽替换 from==to；CM5 零宽插入 removed=[""]，不能按 removed 判）');
  assert.match(tgblk, /before\.trim\(\) !== ''/, '守卫未限定「插入前行为空白」（已有内容的行不是分隔空行）');
  assert.match(tgblk, /this\.cm\.on\('compositionend'/, '缺 IME compositionend 补下移（组合期跳过、组合落定后下移）');
  assert.match(src, /this\._ensureWysiwygTableTypeGuard\(\);/, '输入守卫未在遮罩挂载流程接线');
});

test('遮罩点击防抖窗口守卫：输入后 250ms 内点其他块遮罩不得整篇闪烁（S38 全格式矩阵实锤的竞态）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // 块表在 change 后 250ms 防抖才重切；窗口内点遮罩时实时行号查旧表漏块 → -1 →
  // setWysiwygActiveBlock(-1) 撤掉当前活动块 → 整篇瞬间全遮罩闪一下。-1 时须同步轻
  // 切块（computeWysiwygBlocks(true) parseOnly，不渲染）用最新表再查。
  const fIdx = src.indexOf('_wysiwygBlockIndexAtFresh(line) {');
  assert.ok(fIdx > 0, '缺 _wysiwygBlockIndexAtFresh（遮罩点击的防抖窗口块表守卫）');
  const fblk = src.slice(fIdx, fIdx + 700);
  assert.match(fblk, /this\.computeWysiwygBlocks\(true\)/, '守卫未做 parseOnly 轻切块（只切边界不渲染，廉价同步）');
  assert.match(fblk, /idx = this\.wysiwygBlockIndexAt\(line\);/, '轻切块后未按最新表重查索引');
  // 遮罩 mousedown 的两条活动块落点（普通点击 + 块编辑按钮）都必须走 Fresh 版
  assert.match(src, /self\.setWysiwygActiveBlock\(self\._wysiwygBlockIndexAtFresh\(line\)\);/,
    '遮罩普通点击未走 _wysiwygBlockIndexAtFresh（防抖窗口内点击会整篇遮罩闪烁）');
  assert.match(src, /self\.setWysiwygActiveBlock\(self\._wysiwygBlockIndexAtFresh\(r\.from\.line\)\);/,
    '块编辑按钮点击未走 _wysiwygBlockIndexAtFresh（同一竞态）');
});

test('幽灵 Enter 吞除：WebView2 中文 IME 选字确认残影键不再多续列表行（2026-10-14 用户反馈「列表回车后光标落新行的下一行」）', () => {
  const fsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'format.js'), 'utf8');
  const coreSrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'editor-core.js'), 'utf8');
  // ① Enter 键处理体（extraKeys 'Enter' 绑定，editor-core L170-171）开头有幽灵窗守卫：
  // 组合刚结束 250ms 内返回（undefined = 键被消费，codemirror.js doHandleBinding 语义）
  const hIdx = fsrc.indexOf('_handleTableEnter(cm) {');
  assert.ok(hIdx > 0, '缺 _handleTableEnter（Enter 键映射处理体）');
  const hblk = fsrc.slice(hIdx, hIdx + 1400);
  assert.match(hblk, /this\._lastCompositionEnd && now - this\._lastCompositionEnd < 250\) return;/,
    '缺幽灵 Enter 吞除窗守卫（组合刚结束的残影 Enter 会多续一条列表行 → 真实 Enter 再续一条 → 光标在新行下面一行）');
  // ② 时间戳必须来自输入域的原生 DOM compositionend：CM 5.65.18 不触发用户级
  // compositionstart/end 编辑器事件（cm.on 处理器不执行，官方源码已核），
  // 挂 cm.on 上的时间戳永远是 undefined → 守卫失效
  assert.match(coreSrc, /getInputField\(\);[\s\S]{0,200}addEventListener\('compositionend', \(\) => \{[\s\S]{0,80}this\._lastCompositionEnd = Date\.now\(\);/,
    '幽灵 Enter 时间戳未挂输入域原生 DOM compositionend（cm.on compositionend 在 CM 5.65.18 不触发）');
});

test('token 中和 + 同身 span 渲染色重申（CM5 合并同区间 marker 成同身 span）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  // 中和规则本体：plain-text 行内所有 cm- token span 继承（压掉 gfm 蓝/海军蓝/绿/紫）
  assert.match(css, /wysiwyg-plain-text span\[class[*]="cm-"\] \{[\s\S]{0,40}color: inherit;/,
    'token 中和规则本体丢失（编辑态文字会恢复 gfm token 色）');
  // CM5 把 token 区间与渲染化区间完全重合的两个 marker 合并成同一个 span
  //（cm-quote + wysiwyg-quote-text 同身、cm-header + wysiwyg-heading-hash 同身）；
  // 中和规则 (0,4,1) 压过渲染化颜色规则 (0,3,0) → 同身 span 的渲染色被洗掉
  //（引用正文次级色被洗成主色、列表符号透明被洗成实色，2026-10-14 全格式矩阵实测）。
  // 必须以 (0,5,1) 同前缀重申「有渲染色设计」的类（规则序在中和之后）。
  const oIdx = css.indexOf('class*="wysiwyg-quote-text"]');
  assert.ok(oIdx > 0, '缺同身 span 渲染色重申（引用正文的 --text-secondary 会被中和规则洗成主色）');
  const oblk = css.slice(Math.max(0, oIdx - 900), oIdx + 2400);
  assert.match(oblk, /wysiwyg-plain-text span\[class[*]="wysiwyg-quote-text"\][\s\S]{0,300}wysiwyg-quote-prefix[\][\s\S]{0,120}color: var\(--text-secondary\);/,
    '引用正文/前缀次级色未用 (0,5,1) 重申');
  assert.match(oblk, /wysiwyg-plain-text span\[class[*]="wysiwyg-heading-hash"\][\s\S]{0,120}color: var\(--text-secondary\);/,
    '标题 # 前缀次级色未用 (0,5,1) 重申');
  assert.match(oblk, /wysiwyg-plain-text span\[class[*]="wysiwyg-inline-link"\][\s\S]{0,160}color: var\(--accent-color\);/,
    '链接主题色未用 (0,5,1) 重申');
  assert.doesNotMatch(oblk, /wysiwyg-plain-text span\[class[*]="wysiwyg-inline-link"\][\s\S]{0,200}text-decoration: underline/,
    '链接重申规则不得含 underline（渲染态 .preview-content a 是 text-decoration:none，2026-10-15 对齐口径）');
  assert.match(oblk, /wysiwyg-plain-text span\[class[*]="wysiwyg-underline"\][\s\S]{0,100}text-decoration: underline;/,
    '缺 <u> 同身 span 下划线重申（中和规则会洗掉，与渲染态 ins/u 不一致）');
  assert.match(oblk, /wysiwyg-plain-text span\[class[*]="wysiwyg-strike"\][\s\S]{0,100}text-decoration: line-through;/,
    '缺 ~~ 同身 span 删除线重申（cm-strikethrough token 同身会被中和规则洗掉）');
  assert.match(oblk, /wysiwyg-plain-text span\[class[*]="wysiwyg-inline-marker"\][\s\S]{0,1200}wysiwyg-list-bullet[\][\s\S]{0,500}wysiwyg-task-box[\][\s\S]{0,120}color: transparent;/,
    '标记透明/列表符号透明/任务框透明未用 (0,5,1) 重申（源字符会压住 ::before 渲染符号）');
});

test('列表回车幽灵键双窗：keydown 重复投递窗（窗②）+ input 通道幽灵换行守卫', () => {
  const fsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'format.js'), 'utf8');
  const csrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'editor-core.js'), 'utf8');
  // format.js：先记录本笔 keydown Enter（即使被吞也记录）——input 通道守卫靠它识别重复投递
  assert.match(fsrc, /this\._lastEnterKeydownAt = now;/,
    '缺 _lastEnterKeydownAt 记录（input 通道守卫依赖它识别「同一按键的重复投递」）');
  // 窗②：距上一笔 Enter <150ms 且组合 10s 内刚结束 → 吞（真人连按 ≥80ms + 无 IME 上下文不误吞）
  assert.match(fsrc, /sincePrevEnter < 150 && this\._lastCompositionEnd && now - this\._lastCompositionEnd < 10000\) return;/,
    '缺幽灵窗②（用户选字后又输入一段再回车：重复投递 Enter 紧随真实 Enter 数十 ms 到达，窗①已失效 → 多一行、光标落新行下一行）');
  // editor-core：beforeinput 幽灵换行守卫（CM5 ContentEditableInput 只监听 input 不监听
  // beforeinput → 幽灵 insertLineBreak 会作为裸换行进模型；合法 keydown Enter 被
  // extraKeys preventDefault 后浏览器不再投递 beforeinput → 窗口内到达者必为幽灵）
  assert.match(csrc, /addEventListener\('beforeinput', \(e\) => \{[\s\S]{0,120}insertLineBreak[\s\S]{0,80}insertParagraph/,
    '缺 input 通道守卫（幽灵 beforeinput insertLineBreak 会被 CM5 当裸换行读进模型）');
  assert.match(csrc, /_lastEnterKeydownAt && Date\.now\(\) - this\._lastEnterKeydownAt < 300/,
    '幽灵换行窗口未对齐 _lastEnterKeydownAt（300ms）');
  assert.match(csrc, /e\.preventDefault\(\);/, '缺幽灵 beforeinput 的取消（不取消则对应 input 事件仍触发、CM 仍读得到）');
});

test('块内回车续行保持活动块：光标行紧邻活动块末端时同步轻切块再查（2026-10-15 用户反馈「提示块按一次回车就退出编辑渲染」）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const sIdx = src.indexOf('syncWysiwygActiveBlock() {');
  assert.ok(sIdx > 0, '缺 syncWysiwygActiveBlock（cursorActivity 活动块同步）');
  const sblk = src.slice(sIdx, sIdx + 2600);
  // 旧表未命中（-1）时不再直接按 -1 处理
  assert.match(sblk, /let activeIdx = this\.wysiwygBlockIndexAt\(line\);/,
    '活动块现算未走可纠正路径（旧块表滞后 250ms，Enter 续行新行不在旧表里）');
  // 紧邻活动块末端 → 同步轻切块（parseOnly）按最新表再查：续行仍在块内 → 保持活动；
  // 真在块外 → 照旧 -1（防抖刷新的 marks 守卫会把重遮固化，错过这个时机活动块回不来）
  assert.match(sblk, /line === pb\.end\) activeIdx = this\._wysiwygBlockIndexAtFresh\(line\);/,
    '缺紧邻活动块末端行的同步重查（Enter 续行新行 = 活动块 end 的下一行，旧表漏它 → 当前块被重遮渲染、没法继续换行）');
});

test('下划线渲染化：<u> 原生 HTML 标签在编辑态同渲染观感（2026-10-14 全格式矩阵用户要求）', () => {
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  const pIdx = wsrc.indexOf('function parseWysiwygInlineSpans(text) {');
  assert.ok(pIdx > 0, '缺 parseWysiwygInlineSpans');
  const pblk = wsrc.slice(pIdx, pIdx + 4200);
  assert.match(pblk, /reUnderline = \/\^<u>\(\[\^<\\n\][+]\)<\\\/u>\//, '缺 <u></u> 行内形态正则（单标签成对、不含嵌套标签/换行）');
  assert.match(pblk, /kind = 'underline'/, '缺 underline 分支');
  assert.match(pblk, /push\(start, start \+ 3, 'wysiwyg-inline-marker'\);[\s\S]{0,120}push\(start \+ 3, end - 4, 'wysiwyg-underline'\);/,
    '开/闭标签宽度不对称（<u> 3 字符 / </u> 4 字符）未单独处理（走了对称 tick 分支会错位）');
  assert.match(css, /\.wysiwyg-underline \{ text-decoration: underline; \}/, '缺 .wysiwyg-underline 渲染样式（与渲染态 <u> 观感一致）');
});

test('混合列表黑点归位（CommonMark：空行不拆列表；::before 画圆取代原生 marker，2026-10-16 用户反馈 #3 规范口径）', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  const rsrc = fs.readFileSync(path.join(ROOT, 'src', 'unified-renderer.js'), 'utf8');
  const wsrc = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'wysiwyg.js'), 'utf8');
  // 用户场景 = ul + 空行 + 任务列表。CommonMark：空行只把列表变松散，同型列表从不因
  // 空行断开 → 必须渲染为一个 contains-task-list（用户确认按规范、不拆块）。
  // 任务样式把 ul padding 清零后，普通项若只恢复 list-style:disc，原生 outside marker
  // 相对 **li 边框缘**（=ul 内容缘）定位 → 黑点偏左 24px（截图「黑点与左侧距离异常」）。
  // 修复：list-style:none + padding-left:24px（正文回 x=56）+ ::before 画圆（38–44px，
  // 与正常 ul disc / WYSIWYG 画圆同坐标）。
  assert.match(css, /ul\.contains-task-list > li:not\(\.task-list-item\)\s*\{[^}]*list-style: none;/,
    '混合列表普通项应 list-style:none（原生 disc 相对 li 边框缘定位会偏左 24px，不能恢复原生 marker）');
  assert.match(css, /ul\.contains-task-list > li:not\(\.task-list-item\)\s*\{[^}]*padding-left: 24px;/,
    '混合列表普通项未恢复 padding-left:24px（正文应与任务文本同列 x=56）');
  assert.match(css, /li:not\(\.task-list-item\)\s*::before[^}]*left: 6px;[^}]*width: 6px;/,
    '缺 ::before 画圆（left:6px → 38–44px，与正常 ul disc 同位）');
  assert.match(css, /li:not\(\.task-list-item\)\s*::before[^}]*top: calc\(0\.938em - 3px\)/,
    '画圆 top 锚点未用 WYSIWYG 画圆同式 0.938em（S45 已对正常 ul disc 做像素校准，两态同锚才同位）');
  // 回归守卫：渲染层/遮罩层不得再出现「按空行拆列表」机制（2026-10-16 用户否决：
  // 拆块与 CommonMark 相悖，且引入 gap 块/CM5 行合并等新问题）
  assert.ok(!rsrc.includes('splitListAtBlankLines'), 'splitListAtBlankLines 不得复活（CommonMark 空行只松散、不拆）');
  assert.ok(!rsrc.includes('wysiwyg-list-gap'), 'wysiwyg-list-gap 空行占位不得复活');
  assert.ok(!wsrc.includes('listGap'), 'wysiwyg.js 的 listGap 遮罩特判不得复活');
  // no-btn 列表判定：标记后允许「空格/Tab/行尾」（`1.` 独占一行的有序列表也是列表；
  // 只认 \s 会误判为非列表 → 漏 no-btn，S14 实测）
  assert.match(wsrc, /_wysiwygBlockIsList\(b\) \{[\s\S]{0,400}\(\\s\|\$\)/,
    'no-btn 列表判定未允许标记位于行尾（`1.` 独占一行的有序列表被误判为非列表）');
});
