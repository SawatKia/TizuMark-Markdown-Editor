// 无头浏览器对比测试：阅读模式 vs 所见即所得（真实 Chromium + 真实 CM5 + 真实渲染管线）。
// 用法：node scripts/wysiwyg-browser-check.mjs
// 依赖：playwright（全局 npm 包）+ 项目根下 _wysiwyg_compare.html harness。
// 结果非 0 退出码 = 存在不一致。
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

// playwright 解析：按序尝试 环境变量 → 本地依赖 → 各用户全局 npm 目录（跨设备可移植）。
// 找不到包但找到 ms-playwright 浏览器缓存时，可退到 playwright-core（若可用）。
function loadPlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    'playwright',
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', 'playwright'),
    'C:/Users/admin/AppData/Roaming/npm/node_modules/playwright',
  ].filter(Boolean);
  for (const c of candidates) {
    try { return require(c); } catch (_) { /* 试下一个 */ }
  }
  throw new Error('未找到 playwright：npm i -g playwright（或设 PLAYWRIGHT_MODULE 指向包目录）');
}
const pw = loadPlaywright();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const url = pathToFileURL(path.join(root, '_wysiwyg_compare.html')).href;

// 浏览器可执行文件：优先 playwright 自带；否则扫 ms-playwright 缓存（本机 chromium-1217）
function findChromium() {
  const cacheRoot = path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright');
  if (fs.existsSync(cacheRoot)) {
    for (const dir of fs.readdirSync(cacheRoot).filter(d => d.startsWith('chromium-')).sort().reverse()) {
      const exe = path.join(cacheRoot, dir, 'chrome-win64', 'chrome.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  return undefined;
}
// 启动：⚠️ 必须用系统 Edge（channel:'msedge'）——app 真机是 WebView2（Edge 同版本引擎）。
// 2026-10-15 黑点 1px 教训：disc marker 的绘制规则（基线锚定 0.906em）与 Playwright
// Chromium（13x，几何中心 0.85em）不同，用自带 Chromium 校准的样式在真机差 1px
//（用户截图复测才发现）。Edge 无前置校准意义时（CI 无 Edge）才回退自带 Chromium。
let browser;
let isEdgeDriver = false; // 真机 WebView2 同引擎 → 像素级断言可用（见 S51）
try {
  browser = await pw.chromium.launch({ headless: true, channel: 'msedge' });
  isEdgeDriver = true;
  console.log('[driver] 浏览器: 系统 Edge（与 app WebView2 同引擎）');
} catch (e) {
  try {
    browser = await pw.chromium.launch({ headless: true });
    console.log('[driver] 浏览器: playwright 自带 Chromium（Edge 不可用，真机校准项可能失真）');
  } catch (e2) {
    const exe = findChromium();
    if (!exe) throw e2;
    browser = await pw.chromium.launch({ headless: true, executablePath: exe });
  }
}
let fail = 0;
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('页面异常: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

  // S10 的虚构相对图片（img1.png / sub/img2.png）：遮罩内裸 <img src> 会触发浏览器原生 load，
  // 文件在磁盘上不存在 → 404 被计入页面错误（真实磁盘读逻辑由 mock TauriApi 覆盖，不受影响）。
  // 拦截并回一份有效 1x1 PNG，让原生 load 成功、不产生噪音。
  const TINY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64');
  for (const p of ['img1.png', 'sub/img2.png']) {
    await page.route('**/' + p, (route) => route.fulfill({
      contentType: 'image/png',
      body: TINY_PNG,
    }));
  }

  // ---------- 场景 1：渲染一致性 ----------
  await page.goto(url, { waitUntil: 'load' });
  await page.evaluate(() => window.__runCompare());
  const r = await page.evaluate(() => window.__RESULT);
  console.log('=== 场景 1：所见即所得 vs 阅读模式（渲染一致性） ===');
  console.log(`遮罩块数: ${r.maskCount}  remark 块数: ${r.blockCount}`);
  const checks = [
    [`遮罩 white-space = ${r.ws}（应为 normal，否则标签间换行会显示为真实换行）`, r.ws === 'normal'],
    [`逐块渲染与整篇渲染标签序列同构（与阅读模式一致的核心判据）`, r.structureEqual],
    [`列表序号与内容同行（li↔p 顶部差 ${r.listInlineGap}px，应 < 8）`, r.listInlineGap != null && r.listInlineGap < 8],
    [`无空列表项（「只剩序号的空行」）: ${r.emptyLi} 个`, r.emptyLi === 0],
    [`空行塌缩生效: ${r.blankCollapsed} 行`, r.blankCollapsed > 0],
    // 2026-10-17 两级语义：块间独立空行光标落其上不显示提示（点击行缝不出现「新行」）；
    // 块内空行（松散列表项间）照常显示
    [`块间独立空行：光标落其上不显示提示（点击行缝不出现「新行」）: ${r.hintIndependentSuppressed}`,
      r.hintIndependentSuppressed === true],
    [`块内空行：提示照常显示 + 文案 = ${r.hintText}（应为 "emptyLineHint"）: shown=${r.hintInBlockShown}`,
      r.hintInBlockShown === true && typeof r.hintText === 'string' && r.hintText.includes('emptyLineHint')],
    // 短文档遮罩后不足一屏，scrollTop 恒为 0，锚定被浏览器钳制 → 此处只做「不产生结构性跳动」宽松判定；
    // 严格锚定验证放场景 3（长文档，顶部/底部都有滚动余量）。
    [`点击不产生结构性跳动（短文档钳制偏差 ${r.clickAnchorGap}px，应 < 视口 600）${r.clickDiag ? ' ' + JSON.stringify(r.clickDiag) : ''}`,
      r.clickAnchorGap != null && r.clickAnchorGap < 600],
    [`表格单元格点击进就地源码编辑（contenteditable + 显示源码 + 光标不再移源码行）: ${JSON.stringify(r.tableCellEdit)}`,
      r.tableCellEdit && r.tableCellEdit.editable === true && r.tableCellEdit.text === '2' && r.tableCellEdit.cursorLine === 0],
    [`渲染态点击任务复选框可切换源码: ${r.checkboxToggled}`, r.checkboxToggled],
    [`遮罩内公式已转 KaTeX（不补跑预览后处理会露 $$ 源码）: ${r.mathRendered}`, r.mathRendered],
    [`遮罩内代码块已高亮包裹（code-scroll）: ${r.codeHighlighted}`, r.codeHighlighted],
    [`遮罩内复选框已移除 disabled（否则渲染态点不动）: ${r.checkboxEnabled}`, r.checkboxEnabled],
    [`遮罩数与 remark 块数一致（活动块除外）: ${r.maskCount} === ${r.blockCount} - 1`,
      r.maskCount === r.blockCount - (r.activeIdx >= 0 ? 1 : 0)],
    // ---- 显示效果与阅读模式完全一致（2026-10-08 需求）----
    [`所见即所得下编辑器行号已隐藏: ${r.gutterHidden}`, r.gutterHidden === true],
    [`遮罩字号与阅读模式一致: ${r.fontSizeParity}`, r.fontSizeParity === true],
    [`遮罩行高与阅读模式一致: ${r.lineHeightParity}`, r.lineHeightParity === true],
    [`遮罩字体族与阅读模式一致: ${r.fontFamilyParity}`, r.fontFamilyParity === true],
    [`遮罩无块级底色（与阅读模式同白底）: ${r.bgTransparent}`, r.bgTransparent === true],
    [`水平边距与阅读模式一致${r.paddingParity ? `（遮罩 ${r.paddingParity.mask}px / 阅读 ${r.paddingParity.reading}px）` : ''}: ${!!r.paddingParity && r.paddingParity.equal}`,
      !!r.paddingParity && r.paddingParity.equal === true],
    [`遮罩内 emoji 短码已还原: ${r.emojiRendered}`, r.emojiRendered === true],
    [`遮罩内缩写已还原为 <abbr>: ${r.abbrRendered}`, r.abbrRendered === true],
    [`遮罩内标题已生成锚点 id: ${r.headingIdSet}`, r.headingIdSet === true],
    [`遮罩内 details 已展开: ${r.detailsOpened}`, r.detailsOpened === true],
    [`遮罩内代码块有复制按钮: ${r.copyBtnPresent}`, r.copyBtnPresent === true],
    [`多行展示公式（含 setext 触发行 =）保持为完整单块: ${r.mathBlockIntact}`, r.mathBlockIntact === true],
  ];
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) fail++;
  }
  if (!r.structureEqual) {
    console.log('  --- 标签序列差异 ---');
    console.log('  整篇: ' + r.wholeTagsSample);
    console.log('  逐块: ' + r.maskTagsSample);
  }

  // ---------- 场景 2：大文档虚拟遮罩 + IME ----------
  await page.evaluate(() => window.__runVirtual());
  const v = await page.evaluate(() => window.__RESULT2);
  console.log('\n=== 场景 2：大文档虚拟遮罩 + IME 守卫 ===');
  console.log(`块数: ${v.blockCount}  全量重建耗时: ${v.elapsed}ms`);
  const checks2 = [
    [`虚拟模式已启用（${v.blockCount} 块 > 80）: ${v.virtual}`, v.virtual],
    [`初始只挂视口附近遮罩: ${v.maskCount} 个（应远小于块数）`, v.virtual && v.maskCount < v.blockCount],
    [`滚动后遮罩跟随视口: ${v.maskCountAfterScroll} 个`, v.maskCountAfterScroll > 0 && v.maskCountAfterScroll < v.blockCount],
    [`IME 组合期间防抖补齐被顺延: ${v.imeDeferred}`, v.imeDeferred],
  ];
  for (const [label, ok] of checks2) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) fail++;
  }

  // ---------- 场景 3：长文档严格点击锚定 ----------
  await page.evaluate(() => window.__runAnchor());
  const a = await page.evaluate(() => window.__RESULT3);
  console.log('\n=== 场景 3：长文档点击锚定（编辑器下移 ' + (a.offset || 0) + 'px 模拟真机工具栏，用户反馈「点击屏幕乱跳/每次点击往下滚」的主场景）===');
  for (const s of a.samples) console.log('  ' + (s ? JSON.stringify(s) : '无可见遮罩（跳过）'));
  const off = a.offset || 0;
  const inView = a.samples.filter(Boolean).every(s => s.top >= off && s.top < off + 600);
  const checks3 = [
    // 硬底线：被点中的源码行必须留在视口内——这才是「不乱跳」
    [`每次点击后目标源码行都在视口内（${off} ≤ top < ${off + 600}）: ${inView}`, inView],
    // S71 口径（2026-10-21 用户反馈「点某行进编辑态再点其他行，页面往下移动一段距离」）：
    // 被点源码行顶边落回撤罩前位置（像素级一致块 → 页面不动）；旧口径「行顶回点击 y」
    // 会把行顶钉到点击点，点行中部整页下移半个行高（最大偏差曾 26px = h2 遮罩半高）
    [`被点行顶边落回撤罩前位置（最大偏差 ${a.maxGap}px，应 < 1）`, a.maxGap < 1],
    [`点击锚点已消费、无残留（残留会污染后续光标移动导致乱跳）: ${a.residualClean}`, a.residualClean],
  ];
  for (const [label, ok] of checks3) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) fail++;
  }

  // ---------- 场景 4：虚拟模式滚动锚定 ----------
  await page.evaluate(() => window.__runScrollAnchor());
  const sa = await page.evaluate(() => window.__RESULT5);
  console.log('\n=== 场景 4：虚拟模式滚动锚定（遮罩更新不冲走视口内容）===');
  console.log('  漂移样本: ' + JSON.stringify(sa.drifts));
  const checks4 = [
    [`遮罩更新前后视口顶行位置不漂移（最大 ${sa.maxDrift}px，应 < 20）`, sa.maxDrift < 20],
  ];
  for (const [label, ok] of checks4) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) fail++;
  }

  // ---------- 场景 5：整篇视觉比对（截图） ----------
  // 用 demo.md 同时渲染所见即所得与阅读模式，截图留档供肉眼/视觉模型比对。
  let demoText = null;
  try {
    demoText = fs.readFileSync(path.join(root, 'demo.md'), 'utf8');
  } catch (_) { demoText = null; }
  if (demoText) {
    await page.evaluate((t) => window.__runVisual(t), demoText);
    await new Promise(r => setTimeout(r, 1500)); // 等图片/布局稳定
    // ⚠️ 截图前把视口撑到整页高度（1280×1200 = 两个 600px 容器）：headless 下
    // fullPage 的 captureBeyondViewport 不绘制原 720px 视口以下的 overflow 区域
    //（阅读区 h1 下方整片空白，2026-10-09 截图诊断确认），改普通截图即完整
    await page.setViewportSize({ width: 1280, height: 1200 });
    await new Promise(r => setTimeout(r, 300)); // 等视口变化后的重排落定
    const shot = path.join(root, 'screenshots', 'wysiwyg-vs-reading.png');
    fs.mkdirSync(path.dirname(shot), { recursive: true });
    await page.screenshot({ path: shot });
    console.log('\n=== 场景 5：整篇视觉比对（截图） ===');
    console.log('  截图: ' + path.relative(root, shot));
  }

  // ---------- 场景 6：全量模式快速滚动（≤10000 行：全量预渲染 + 全量视图驻留） ----------
  // 用户主诉：快速滚动闪源码 / 落点漂移。全量模式下所有行恒渲染 + 恒实测高度，
  // 任意位置首跳必须精确落位（≤1px），refresh 后几何自愈。
  await page.evaluate(() => window.__runFullFast(750));
  const ff = await page.evaluate(() => window.__RESULT6);
  console.log('\n=== 场景 6：全量模式快速滚动（' + ff.lineCount + ' 行） ===');
  console.log(`全量重建耗时: ${ff.renderMs}ms  视口驻留 margin: ${ff.margin}  遮罩: ${ff.maskCount}/${ff.blockCount} 块`);
  console.log('  首跳误差: ' + JSON.stringify(ff.jumps) + '  refresh 后误差: ' + ff.errAfterRefresh + 'px');
  const checks6 = [
    [`全量模式已启用（行数 ≤ 10000）: ${ff.full}`, ff.full === true],
    [`全量视图驻留（viewportMargin ≥ 行数 ${ff.lineCount}）: ${ff.margin}`, ff.margin >= ff.lineCount],
    [`遮罩全量挂载（活动块除外）: ${ff.maskCount} === ${ff.blockCount} - 1`, ff.maskCount === ff.blockCount - 1],
    [`滚动/跳转不增不删遮罩（全量模式无按需挂撤）: ${ff.maskCountAfter} === ${ff.maskCount}`, ff.maskCountAfter === ff.maskCount],
    [`任意位置首跳落点误差 ≤ 1px（最大 ${ff.maxJumpErr}px，几何自愈）`, ff.maxJumpErr <= 1],
    [`cm.refresh() 后几何自愈（落点误差 ${ff.errAfterRefresh}px ≤ 1）`, ff.errAfterRefresh <= 1],
  ];
  for (const [label, ok] of checks6) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) fail++;
  }

  // ---------- 场景 7：按钮点击预渲染流程（后台预计算 → 完成后切视图 → 消费块表） ----------
  await page.evaluate(() => window.__runPreRenderFlow());
  const pf = await page.evaluate(() => window.__RESULT7);
  console.log('\n=== 场景 7：按钮点击预渲染流程（时序验证） ===');
  const checks7 = [
    [`预渲染已启动（行数 ≤ 上限）: ${pf.started}`, pf.started === true],
    [`预渲染已完成、状态复位: ${pf.preRenderingDone}`, pf.preRenderingDone === true],
    [`完成后视图已切换到所见即所得: ${pf.mode}`, pf.mode === 'wysiwyg'],
    [`全量模式 + 视口驻留（margin ${pf.margin} ≥ 行数 ${pf.lineCount}）: ${pf.full}`, pf.full === true && pf.margin >= pf.lineCount],
    [`预渲染块表被 50ms 计时器消费（遮罩 ${pf.maskCount}/${pf.blocks}，活动块除外）: ${pf.masksConsumed}`, pf.masksConsumed === true],
  ];
  for (const [label, ok] of checks7) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) fail++;
  }

  // ---------- 场景 8：点击落点（多行遮罩块点击落在点击比例对应的块内行） ----------
  // 真实鼠标（page.mouse.click 走真实命中测试）；每次点击前 __clickLandingSetup 建全新编辑器，
  // 避免活动块切换/异步布局污染坐标。
  // 回归（2026-10-09 真机反馈「点击成块内容经常新增一行」）：CM5 把落在 replacedWith 标记
  // 区间内部的 setSelection 位置钳制到标记首/末端——修复前点遮罩块中部，光标恒落到块首/块尾
  // 行，用户反复点偏、点进块缝空行出现「输入 / 可插入内容…」提示行。修复：先撤遮罩再落光标，
  // 点中部必须落在块中部。
  const landings = [];
  let landGeo = null;
  for (const where of ['center', 'bottom-2']) {
    const g = await page.evaluate(() => window.__clickLandingSetup());
    if (g.error) { landings.push({ where, line: -1, text: '', inBlock: false, active: -2 }); break; }
    if (g.ok) landGeo = g;
    const y = where === 'center' ? (g.node.top + g.node.bottom) / 2 : g.node.bottom - 2;
    await page.mouse.click(g.node.left + 200, y);
    await new Promise(r => setTimeout(r, 300));
    landings.push(await page.evaluate((w) => {
      const cm = window.__landingCM, ed = window.__landingEd;
      const cur = cm.getCursor().line;
      return { where: w, line: cur, text: (cm.getLine(cur) || '').slice(0, 12), inBlock: ed.wysiwygBlockIndexAt(cur), active: ed._wysiwygActiveIdx };
    }, where));
  }
  console.log('\n=== 场景 8：点击落点（多行遮罩块点击落在点击行） ===');
  for (const l of landings) console.log(`  ${l.where}: line ${l.line}（"${l.text}"） inBlock=${l.inBlock} activeIdx=${l.active}`);
  const L8 = landGeo ? landGeo.list : { start: 0, end: 0, lines: 0, blockIndex: -1 };
  const midLo8 = L8.start + Math.floor(L8.lines / 3);
  const midHi8 = L8.start + L8.lines - 1 - Math.floor(L8.lines / 3);
  const c8 = landings.find(l => l.where === 'center');
  const b8 = landings.find(l => l.where === 'bottom-2');
  const checks8 = [
    [`块中部点击落在中部带 [${midLo8},${midHi8}]（修复前 CM5 钳制到块首/尾行）: line=${c8 && c8.line}`, !!c8 && c8.line >= midLo8 && c8.line <= midHi8],
    [`点击块已撤遮罩并成为活动块（activeIdx=${c8 && c8.active} === 块=${L8.blockIndex}）`, !!c8 && c8.active === L8.blockIndex],
    [`块底边点击落在块末两行 [${L8.start + L8.lines - 2},${L8.end - 1}]: line=${b8 && b8.line}`, !!b8 && b8.line >= L8.start + L8.lines - 2 && b8.line <= L8.end - 1],
  ];
  for (const [label, ok] of checks8) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) fail++;
  }

  // ---------- S9：[TOC] 目录（WYSIWYG 与阅读模式同规则；回归异步 pass 生命周期） ----------
  await page.evaluate(() => window.__runToc());
  const tc = await page.evaluate(() => window.__RESULT_TOC);
  console.log('\n=== S9：[TOC] 目录（所见即所得 vs 阅读模式）===');
  const checks9 = [
    [`遮罩 [TOC] 块已替换为 toc-wrapper（批量挂遮罩后异步 pass 必须补跑）: ${tc.hasToc}`, tc.hasToc === true],
    [`目录链接数 = 4（4 个标题，含 3 级嵌套）: ${tc.linkCount}`, tc.linkCount === 4],
    [`目录内容与阅读模式同构（同一份 toc HTML）: ${tc.tocEqual}`, tc.tocEqual === true],
    [`遮罩内无残留 [TOC] 源文本: ${tc.tocLeft}`, tc.tocLeft === 0],
    [`[TOC] 块可被光标移入（转源码态，活动块契约）: ${tc.activeIsToc}`, tc.activeIsToc === true],
    [`光标移出后重挂遮罩，TOC 再次注入: ${tc.tocAfterRemask}`, tc.tocAfterRemask === true],
  ];
  for (const [label, ok] of checks9) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) fail++;
  }

  // ---------- S10：图片（读盘 pass + 光标移动后重挂不失效） ----------
  await page.evaluate(() => window.__runImages());
  const im = await page.evaluate(() => window.__RESULT_IMG);
  console.log('\n=== S10：图片（遮罩内图片加载 + 重挂回归）===');
  console.log('  entry: ' + JSON.stringify(im.entry) + '  afterMove: ' + JSON.stringify(im.afterMove));
  const checks10 = [
    [`进入后两张遮罩图片均加载为 data URI: ${im.entry.loaded}/${im.entry.total}`, im.entry.total === 2 && im.entry.loaded === 2],
    [`无透明占位/相对路径残留: transparent=${im.entry.transparent} other=${im.entry.other}`, im.entry.transparent === 0 && im.entry.other === 0],
    [`光标移动后重挂的图片仍加载: ${im.afterMove.loaded}/${im.afterMove.total}`, im.afterMove.total === 2 && im.afterMove.loaded === 2],
  ];
  for (const [label, ok] of checks10) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) fail++;
  }

  // ---------- S11：长代码块按需滚动条（与阅读模式同条件） ----------
  await page.evaluate(() => window.__runCodeScroll());
  const sc = await page.evaluate(() => window.__RESULT_SCROLL);
  console.log('\n=== S11：长代码块按需滚动条（与阅读模式一致）===');
  console.log('  wysiwyg: ' + JSON.stringify(sc.wysiwyg) + '  reading: ' + JSON.stringify(sc.reading));
  const nsOk = sc.noScroll.length === 2 && sc.noScroll.every((x) => x.ok === true || (x.cls && x.ov !== 'auto' && x.expanded));
  const checks11 = [
    [`长代码块（>300px）：阅读模式=${sc.reading[0] && sc.reading[0].ov} / 所见即所得=${sc.wysiwyg[0] && sc.wysiwyg[0].ov}（均应为 auto）`,
      sc.reading[0] && sc.reading[0].ov === 'auto' && sc.wysiwyg[0] && sc.wysiwyg[0].ov === 'auto'],
    [`短代码块：两侧均不出现按需滚动条（hidden）`,
      sc.reading[1] && sc.reading[1].ov === 'hidden' && sc.wysiwyg[1] && sc.wysiwyg[1].ov === 'hidden'],
    [`codeScroll=false：遮罩挂 code-no-scroll 类且高度自适应无滚动（${sc.noScroll.length} 块）`, nsOk],
  ];
  for (const [label, ok] of checks11) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) fail++;
  }

  // ---------- S12：Mermaid 图表（批量渲染 + 重挂回归） ----------
  await page.evaluate(() => window.__runMermaid());
  const mm = await page.evaluate(() => window.__RESULT_MMD);
  console.log('\n=== S12：Mermaid 图表（遮罩内渲染 vs 阅读模式）===');
  console.log('  entry: ' + JSON.stringify(mm.entry) + '  reading: ' + JSON.stringify(mm.reading) + '  afterMove: ' + JSON.stringify(mm.afterMove));
  const checks12 = [
    [`3 张遮罩图表全部渲染为 SVG（防批量跳过/并发 id 碰撞）: ${mm.entry.svgs}/${mm.entry.containers}`,
      mm.entry.containers === 3 && mm.entry.svgs === 3],
    [`遮罩内无 mermaid 源码残留: ${mm.entry.codeLeft}`, mm.entry.codeLeft === 0],
    [`阅读模式参照物同为 3 张 SVG: ${mm.reading.svgs}`, mm.reading.svgs === 3],
    [`光标移动后重挂的图表恢复: ${mm.afterMove.svgs}/${mm.afterMove.containers}`,
      mm.afterMove.containers === 3 && mm.afterMove.svgs === 3],
  ];
  for (const [label, ok] of checks12) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) fail++;
  }

  // ---------- S13：ref 定义行塌缩（与阅读模式「不显示定义行」对齐，2026-10-12 #1） ----------
  await page.evaluate(() => window.__runRefDef());
  const rd = await page.evaluate(() => window.__RESULT_REFDEF);
  console.log('\n=== S13：ref 定义行（所见即所得塌缩占位 vs 阅读模式不显示）===');
  console.log('  ' + JSON.stringify(rd));
  const checks13 = [
    [`定义行块输出塌缩占位（连续定义 remark 按行拆块、各块独立塌缩）: ${rd.hiddenDivs}`, rd.placeholderOk === true],
    [`占位零高度（CSS 塌缩生效）: ${rd.hiddenHeight}px`, rd.hiddenHeight === 0],
    [`编辑器可见文本无定义行/URL 泄漏: ${rd.defLineVisible}`, rd.defLineVisible === false],
    [`阅读模式参照物同样不显示定义行: ${rd.readingShowsDef}`, rd.readingShowsDef === false],
  ];
  for (const [label, ok] of checks13) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) fail++;
  }

  // ---------- S14：块「编辑」按钮（挂载口径 / hover 显现 / 代码块让位 / 点击解罩落块首，2026-10-12 #4） ----------
  // 鼠标先复位到左上角并等过渡落定（0.2s opacity 过渡）：上一场景的鼠标位置若悬停在
  // 本场景首个带按钮遮罩上，opacity 会处于过渡中间值（实测 0.9606），默认隐藏断言误判
  await page.mouse.move(2, 2);
  await new Promise((res) => setTimeout(res, 300));
  await page.evaluate(() => window.__runEditBtn());
  const bt = await page.evaluate(() => window.__RESULT_BTN);
  console.log('\n=== S14：块「编辑」按钮（hover 显现 + 点击解罩落块首）===');
  console.log('  ' + JSON.stringify(bt));
  const checks14 = [
    [`非列表/非标题/非普通文字/非引用的遮罩块均挂编辑按钮: ${bt.btnNonList}/${bt.nonListMasks}`, bt.allHaveBtn === true],
    [`列表遮罩块不挂编辑按钮（2026-10-16 反馈 #1：点行即编辑）: ${bt.listMasks} 个列表块 / ${bt.btnList} 个带按钮`,
      bt.listNoBtn === true],
    [`标题遮罩块不挂编辑按钮（2026-10-17 用户要求：点遮罩即编辑）: ${bt.headingMasks} 个标题块 / ${bt.btnHeading} 个带按钮 / ${bt.headingNoBtnCls} 个挂 no-btn-heading 类`,
      bt.headingNoBtn === true],
    [`普通文字段落不挂编辑按钮（2026-07-13 用户要求：点文字即编辑）: ${bt.plainMasks} 个普通文字块 / ${bt.btnPlain} 个带按钮 / ${bt.plainNoBtnCls} 个挂 no-btn 类`,
      bt.plainNoBtn === true],
    [`引用/提示块不挂编辑按钮（2026-10-25 用户要求：点遮罩即编辑，与标题同口径）: ${bt.quoteMasks} 个引用块 / ${bt.btnQuote} 个带按钮`,
      bt.quoteNoBtn === true],
    [`按钮默认隐藏（opacity 0，hover 显现）: ${bt.defaultOpacity}`, bt.defaultOpacity === '0'],
    [`代码块内让位复制按钮（right=76px）: ${bt.codeOffsetOk}`, bt.codeOffsetOk === true],
    [`普通块 right=8px（2026-10-17 与复制按钮统一指标后由 10px 改 8px）: ${bt.plainOffset}`, bt.plainOffset === true],
    [`代码块「编辑/复制」两钮同排对齐（中心 Y 差 ${bt.btnPair && bt.btnPair.centerGap}px / 高度差 ${bt.btnPair && bt.btnPair.heightGap}px，2026-10-17 用户反馈）`,
      bt.btnPairAligned === true],
    [`点击编辑按钮（表格块）：解罩 + 光标落块首行: ${JSON.stringify(bt.click)}`,
      bt.click && bt.click.unmasked === true && bt.click.activeIdx >= 0 && bt.click.cursorLine === bt.click.expectedLine],
  ];
  for (const [label, ok] of checks14) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) fail++;
  }

  // ---------- S15：活动块背景高亮（cm-wysiwyg-active-block 行类，2026-10-12 #5） ----------
  await page.evaluate(() => window.__runActiveHighlight());
  const hl = await page.evaluate(() => window.__RESULT_HL);
  console.log('\n=== S15：活动块背景高亮 ===');
  console.log('  ' + JSON.stringify(hl));
  const checks15 = [
    [`光标所在块解罩 + 光标行灰底（底色=代码块同色 + 单行块四角全圆）: ${JSON.stringify(hl.inPara)}`,
      hl.inPara && hl.inPara.line2 === true && hl.inPara.unmasked === true &&
      hl.inPara.para && hl.inPara.para.bg !== 'rgba(0, 0, 0, 0)' &&
      hl.codeBg && hl.inPara.para.bg === hl.codeBg &&
      hl.inPara.para.first === true && hl.inPara.para.last === true],
    [`点列表首行进多行列表（2026-10-16 起列表无编辑按钮，点行=用户路径）：旧行撤光 + 只有光标行（块首行 12）灰底（块内其余行无底、单行四角全圆）: ${JSON.stringify(hl.inList)}`,
      hl.inList && hl.inList.cursorLine === 12 && hl.inList.line2 === false && hl.inList.line12 === true &&
      hl.inList.line13 === false && hl.inList.rows === 1 && hl.inList.singleLineAllCorners === true],
    [`灰底随光标在块内移动（行 13 有底、行 12 撤底）: ${JSON.stringify(hl.inListFollow)}`,
      hl.inListFollow && hl.inListFollow.line13 === true && hl.inListFollow.line12 === false &&
      hl.inListFollow.rows === 1 && hl.inListFollow.singleLineAllCorners === true],
    [`移到块间空行：块行全部撤光（行 12/13 无底）+ 块重新遮罩；光标行（行 1）保留灰底（2026-10-21 修订：块间空行光标行全高 + 灰，S69 同源）: ${JSON.stringify(hl.onBlank)}`,
      hl.onBlank && hl.onBlank.activeIdx === -1 && hl.onBlank.line1 === true &&
      hl.onBlank.line12 === false && hl.onBlank.line13 === false && hl.onBlank.bgRows === 1],
  ];
  for (const [label, ok] of checks15) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) fail++;
  }

  // ---------- S16：预渲染管线（loading 配对 / 在飞守卫 / 切标签内容替换后重算，2026-10-12 #2/#3） ----------
  await page.evaluate(() => window.__runPreRenderTabFlow());
  const pr = await page.evaluate(() => window.__RESULT_PRERENDER);
  console.log('\n=== S16：预渲染管线（loading + 切标签重算）===');
  console.log('  ' + JSON.stringify(pr));
  const checks16 = [
    [`预渲染启动且在飞: started=${pr.started} inFlight=${pr.inFlight}`, pr.started === true && pr.inFlight === true],
    [`开始时 loading 层计数 +1: begin=${pr.beginAtStart}`, pr.beginAtStart === 1],
    [`在飞期间 renderWysiwygMasks 被守卫跳过`, pr.guardHeld === true],
    [`完成后切模式 + 块表非空 + loading 释放: ${JSON.stringify(pr.done)}`,
      pr.done && pr.done.viewMode === 'wysiwyg' && pr.done.preRendering === false && pr.done.blocks > 0
        && pr.done.loadBegin === pr.done.loadEnd && pr.done.applyCalls === 1],
    [`切标签（内容替换）后按新文档重算: ${JSON.stringify(pr.tab)}`,
      pr.tabStarted === true && pr.tab.valueOk === true && pr.tab.firstLine === '# 新文档' && pr.tab.blocks === 4],
    [`loading 计数全程配对: begin=${pr.tab.loadBegin} end=${pr.tab.loadEnd}`, pr.tab.loadBegin === pr.tab.loadEnd],
  ];
  for (const [label, ok] of checks16) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) fail++;
  }

  // ---------- S17：所见即所得跳转解罩（多行块行定位 / 锚点 #id，2026-10-12 二报告） ----------
  await page.evaluate(() => window.__runJumpUnmask());
  const jp = await page.evaluate(() => window.__RESULT_JUMP);
  console.log('\n=== S17：跳转解罩（多行块行定位 + 锚点）===');
  console.log('  ' + JSON.stringify(jp));
  const checks17 = [
    [`多行列表块被遮罩: ${JSON.stringify(jp.listBlock)}`, jp.listBlock && jp.listBlock.masked === true],
    [`未解罩直接定位被 clamp 到遮罩边缘（旧缺陷复现）: cursor=${jp.directClamp.cursorLine} target=${jp.directClamp.target}`,
      jp.directClamp && jp.directClamp.clamped === true],
    [`解罩后再定位：精确落点: cursor=${jp.afterFix.cursorLine}`, jp.afterFix && jp.afterFix.landed === true],
    [`锚点跳转：目标块先解罩 + 落点准确: ${JSON.stringify(jp.anchor)}`,
      jp.anchor && jp.anchor.maskedBefore === true && jp.anchor.maskedAfter === false && jp.anchor.landed === true],
  ];
  for (const [label, ok] of checks17) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) fail++;
  }

  // ---------- S18：表格单元格就地源码编辑（Phase 2 / R5，2026-10-13） ----------
  await page.evaluate(() => window.__runTableCellEdit());
  const ce = await page.evaluate(() => window.__RESULT_CELLEDIT);
  console.log('\n=== S18：表格单元格就地源码编辑（Phase 2 / R5）===');
  console.log('  ' + JSON.stringify(ce));
  const checks18 = [
    [`点格进就地源码编辑（contenteditable + 整表仍遮罩 + 表格块非活动）: ${JSON.stringify(ce.entered)}`,
      ce.entered && ce.entered.editable === true && ce.entered.cls === true &&
      ce.entered.text === '2' && ce.entered.tableStillMasked === true && ce.entered.tableNotActive === true],
    [`失焦提交：整行重建 + 裸 | 自动转义 + 他格保留: ${JSON.stringify(ce.rowAfter)}`,
      ce.rowAfter === '| 1 | hello \\| world |'],
    [`提交后遮罩重渲（旧节点离场 + 新格渲染文本 + 非编辑态 + 光标落表后首行）: ${JSON.stringify(ce.rerendered)}`,
      ce.rerendered && ce.rerendered.oldDetached === true &&
      ce.rerendered.newCellText === 'hello | world' && ce.rerendered.notEditable === true &&
      ce.rerendered.cursorLine === 26 && ce.rerendered.activeIdx === -1],
    [`Tab 行内切格：次格进编辑（显示其原始源码）+ 前格恢复 + 无变化不改源码: ${JSON.stringify(ce.tab)}`,
      ce.tab && ce.tab.nextEditable === true && ce.tab.nextText === 'hello \\| world' &&
      ce.tab.firstRestored === '1' && ce.tab.rowUnchanged === true],
    [`Esc 取消：源码不变 + 格恢复渲染内容 + 退出编辑态: ${JSON.stringify(ce.esc)}`,
      ce.esc && ce.esc.rowUnchanged === true && ce.esc.restoredText === 'hello | world' &&
      ce.esc.notEditable === true],
  ];
  for (const [label, ok] of checks18) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) fail++;
  }

  // ---------- S19：大文档 loading 持留至遮罩挂完（2026-10-13 反馈 #1） ----------
  await page.evaluate(() => window.__runPreRenderHold());
  const hd = await page.evaluate(() => window.__RESULT_HOLD);
  console.log('\n=== S19：大文档 loading 持留至遮罩挂完 ===');
  console.log('  ' + JSON.stringify(hd));
  const checks19 = [
    [`大文档预渲染管线跑通（~1000 行 / 数百块全挂遮罩）: ${JSON.stringify(hd.mt)}`,
      hd.mt && hd.mt.lines > 800 && hd.mt.masks >= hd.mt.blocks - 1],
    [`loading 不早于遮罩挂载释放（release≥mount，无「loading 后空白/源码数秒」）: mount=${hd.mt && hd.mt.mountedAt}ms release=${hd.mt && hd.mt.releasedAt}ms`,
      hd.holdOk === true],
  ];
  for (const [label, ok] of checks19) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) fail++;
  }

  // ---------- S20：表格行/列操作（2026-10-13 用户要求 #2） ----------
  await page.evaluate(() => window.__runTableTools());
  const tt = await page.evaluate(() => window.__RESULT_TABLETOOLS);
  console.log('\n=== S20：表格行/列操作（增行/增列/拖拽换位） ===');
  console.log('  ' + JSON.stringify(tt));
  const checks20 = [
    [`工具注入：wrap 容器 + 增行/增列按钮（默认隐藏，hover 显示）: ${JSON.stringify(tt.injected)}`,
      tt.injected && tt.injected.wrap === true && tt.injected.btnHidden === true],
    [`增行：源码 +1 空行（5→6 行，新行全空格）: ${JSON.stringify(tt.addRow)}`,
      tt.addRow && tt.addRow.lines === 6 && tt.addRow.lastRowEmpty === true],
    [`增行后自动格编辑新末行首格（无缝续输；2026-10-14：光标在新增行第一个单元格）: ${JSON.stringify(tt.autoEdit1)}`,
      tt.autoEdit1 && tt.autoEdit1.editable === true && tt.autoEdit1.isFirstCell === true && tt.autoEdit1.rowIsLast === true],
    [`增列：每行 5 根竖线（4 列）+ 分隔行 4 段: ${JSON.stringify(tt.addCol)}`,
      tt.addCol && tt.addCol.cellsPerRow.every((n) => n === 5) && tt.addCol.sepOk === 4],
    [`增列后自动格编辑新末列表头格（2026-10-14：光标在新增列第一个单元格）: ${JSON.stringify(tt.autoEdit2)}`,
      tt.autoEdit2 && tt.autoEdit2.isTh === true && tt.autoEdit2.inThead === true && tt.autoEdit2.isLastCol === true],
    [`行拖拽：r1 拖到 r2 中心 → 数据行序 [r2,r1,r3,空行]（纯函数回写整块）: ${JSON.stringify(tt.rowDrag && tt.rowDrag.order)}`,
      tt.rowDrag && JSON.stringify(tt.rowDrag.order) === JSON.stringify(['r2a', 'r1a', 'r3a', '']) &&
      JSON.stringify(tt.rowDrag.grid) === JSON.stringify([
        ['r2a', 'r2b', 'r2c', ''],
        ['r1a', 'r1b', 'r1c', ''],
        ['r3a', 'r3b', 'r3c', ''],
        ['', '', '', ''],
      ])],
    [`列拖拽：甲列拖过乙中点 → 表头 [乙,甲,丙,空] + 每数据行列同步换位: ${JSON.stringify(tt.colDrag && tt.colDrag.header)}`,
      tt.colDrag && JSON.stringify(tt.colDrag.header) === JSON.stringify(['乙', '甲', '丙', '']) &&
      JSON.stringify(tt.colDrag.dataRows) === JSON.stringify([
        ['r2b', 'r2a', 'r2c', ''],
        ['r1b', 'r1a', 'r1c', ''],
        ['r3b', 'r3a', 'r3c', ''],
      ]) && tt.colDrag.dragGone === true],
    [`结构提交后块表一致（遮罩在、块跨 6 行 = 5+增行、表头列序已换位）: ${JSON.stringify(tt.finalState)}`,
      tt.finalState && tt.finalState.masked === true && tt.finalState.blockSpan === 6 &&
      JSON.stringify(tt.finalState.srcFirstCells) === JSON.stringify(['乙', '甲', '丙', ''])],
  ];
  for (const [label, ok] of checks20) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) fail++;
  }

  // ---------- S21：格编辑真实 I/O 诊断（2026-10-13 反馈 #3） ----------
  // 真实 trusted 事件：page.mouse.click 进格 → 读焦点/选区 → page.keyboard.type 输入 → 再读。
  // 用于定位「点格选中文字 / 一输入就失焦」：焦点被谁夺走、输入了多少字符。
  {
    console.log('\n=== S21：格编辑真实 I/O 诊断（真实鼠标+键盘） ===');
    const rio = await page.evaluate(() => window.__runCellEditRealIO());
    if (rio.err) {
      console.log('  ⚠ 场景初始化失败: ' + rio.err);
    } else {
      const before = await page.evaluate(() => window.__cellState());
      await page.mouse.click(rio.rect.x + rio.rect.w / 2, rio.rect.y + rio.rect.h / 2);
      await new Promise(r => setTimeout(r, 150));
      const afterClick = await page.evaluate(() => window.__cellState());
      await page.keyboard.type('xy', { delay: 60 });
      await new Promise(r => setTimeout(r, 150));
      const afterType = await page.evaluate(() => window.__cellState());
      // 再按一次键，观察是否「只输得进一点」
      await page.keyboard.press('z');
      await new Promise(r => setTimeout(r, 150));
      const afterType2 = await page.evaluate(() => window.__cellState());
      const j = (o) => JSON.stringify(o);
      console.log('  点击前:      ' + j(before));
      console.log('  真实点击后:  ' + j(afterClick));
      console.log('  输入 xy 后:  ' + j(afterType));
      console.log('  再按 z 后:   ' + j(afterType2));
      console.log('  （目标格点击前文本: ' + JSON.stringify(rio.cellTextBefore) + '，rect=' + j(rio.rect) + '）');
      // Enter 提交 → 焦点不得掉 body（2026-10-13 反馈残留：提交后「光标丢失」= 焦点掉出编辑器）
      await page.keyboard.press('Enter');
      await new Promise(r => setTimeout(r, 250));
      const afterEnter = await page.evaluate(() => {
        const ae = document.activeElement;
        return {
          activeTag: ae ? ae.tagName : null,
          isBody: ae === document.body,
          inCM: !!(ae && ae.closest && ae.closest('.CodeMirror')),
          editingCell: !!document.querySelector('div.wysiwyg-block-mask table .wysiwyg-cell-editing'),
          row: (() => { const el = document.querySelector('.CodeMirror'); const cm = el && el.CodeMirror; return cm ? cm.getLine(25) : null; })(),
        };
      });
      console.log('  Enter 提交后: ' + j(afterEnter));
      const checks21 = [
        ['真实点击后焦点在格内', afterClick.activeIsCell === true && afterClick.cellEditable === 'true'],
        ['点格不再整格全选（选区为空/折叠）', afterClick.selStr === '' || afterClick.selStr === null],
        ['输入 xy 焦点保持在格内', afterType.activeIsCell === true],
        ['输入字符追加进格（原文本保留，如 2xy）', afterType.cellText === '2xy' || afterType.cellText === 'xy2'],
        ['持续输入不丢焦点（2xyz）', afterType2.activeIsCell === true && (afterType2.cellText || '').length >= 4],
        ['Enter 提交结束格编辑', afterEnter.editingCell === false],
        ['Enter 提交后焦点不掉 body（光标不丢失）', afterEnter.isBody === false],
        ['Enter 提交后焦点回到编辑器', afterEnter.inCM === true],
        ['Enter 提交内容已回写源码行', (afterEnter.row || '').indexOf('xyz') >= 0],
      ];
      for (const [label, ok] of checks21) {
        console.log(`  ${ok ? '✓' : '✗'} ${label}`);
        if (!ok) fail++;
      }
    }
  }

  // ---------- S22：格编辑 IME 组合期不中断（中文 Enter 确认拼音 ≠ 提交格子） ----------
  {
    console.log('\n=== S22：格编辑 IME 组合期不中断 ===');
    await page.evaluate(() => window.__runCellEditIME());
    const ime = await page.evaluate(() => window.__RESULT_CELLEDIT_IME);
    if (ime.err) {
      console.log('  ⚠ 场景失败: ' + ime.err);
      fail++;
    } else {
      const checks22 = [
        ['进格编辑', ime.entered === true],
        ['组合期 Enter 不提交（源码不变）', ime.duringComposing.rowUnchanged === true],
        ['组合期 Enter 不丢编辑态', ime.duringComposing.stillInEdit === true],
        ['组合期 Enter 格 DOM 未脱离', ime.duringComposing.cellStillConnected === true],
        ['组合结束后的残影 Enter 被吞（不提交/不换行/编辑态保留）', ime.afterComposingEnd.ghostEnterSwallowed === true],
        ['超 250ms 窗口后 Enter 正常提交', ime.commitAfterGhost.committed === true],
        ['提交行含确认汉字', ime.commitAfterGhost.rowHasChar === true],
      ];
      for (const [label, ok] of checks22) {
        console.log(`  ${ok ? '✓' : '✗'} ${label}`);
        if (!ok) fail++;
      }
    }
  }

  // ---------- S25：格编辑期间异步 pass 完成不得打掉焦点（2026-10-14 反馈） ----------
  // 图片/Mermaid/TOC 加载完成回调 → cm.refresh() 重建行 DOM → 聚焦格被移挂触发 blur →
  // 误提交 + 焦点跳走。契约：编辑中 refresh 挂起（不重建 DOM），编辑结束后补跑。
  {
    console.log('\n=== S25：格编辑期间异步遮罩刷新不打掉焦点 ===');
    await page.evaluate(() => window.__runCellEditAsyncRefresh());
    const ar = await page.evaluate(() => window.__RESULT_CELLEDIT_AREFRESH);
    if (ar.err) {
      console.log('  ⚠ 场景失败: ' + ar.err);
      fail++;
    } else {
      const checks25 = [
        ['进格编辑', ar.entered === true],
        ['编辑中触发的遮罩刷新被挂起（未立即 cm.refresh）', ar.refreshPendingDuringEdit === true],
        ['编辑态保留（焦点未被异步刷新打掉）', ar.stillEditing === true],
        ['格 DOM 未脱离（行 DOM 未被重建）', ar.cellStillConnected === true],
        ['contenteditable 保持', ar.cellEditable === 'true'],
        ['源码行未变（打字中途未被误提交）', ar.rowUnchanged === true],
        ['Enter 正常提交（补跑后回写生效）', typeof ar.rowAfterCommit === 'string' && ar.rowAfterCommit !== '| a | b |'],
        ['挂起的刷新在提交后已补跑', ar.pendingFlushedAfterCommit === true],
        ['提交后表格遮罩仍正常', ar.tableStillThere === true],
      ];
      for (const [label, ok] of checks25) {
        console.log(`  ${ok ? '✓' : '✗'} ${label}`);
        if (!ok) fail++;
      }
    }
  }

  // ---------- S23：增行/增列「边缘条带」（2026-10-13 反馈 #4/#5，参考有道云笔记） ----------
  // 条带 = 右缘通高竖条（增列）/ 下缘通宽横条（增行），浅灰底 + 细边框 + 居中「＋」。
  // 显示条件 = 鼠标移到表格右边/下边一点（条带自身即悬停区，透明时也恒可命中）；
  // 鼠标在表格本体上不显示。2026-10-13 反馈 #3：条带**紧贴表格边框**（无 6/10px 间隙）。
  {
    console.log('\n=== S23：增行/增列边缘条带（右缘竖条/下缘横条，移到边缘才显示） ===');
    const hv = await page.evaluate(() => window.__runTableToolsHover());
    if (hv.err) {
      console.log('  ⚠ 场景失败: ' + hv.err);
      fail++;
    } else {
      const pause = (ms) => new Promise(r => setTimeout(r, ms));
      const j = (o) => JSON.stringify(o);
      console.log('  可见网格: ' + j(hv.gridRect) + ' | table 盒: ' + j(hv.tableRect) + ' | wrap: ' + j(hv.wrapRect) + ' | pre 行: ' + j(hv.preRect));
      // 阶段 1：增行（下缘横条）。滑到表格中心 → 分步下移（表内 → 间隙 → 条带中心）→ 真实点击。
      // ⚠️ 必须用 gridRect（可见网格）坐标：table 元素盒曾被 width:100% 撑满整行。
      await page.mouse.move(hv.gridRect.cx, hv.gridRect.top + hv.gridRect.h / 2);
      await pause(180); // > opacity 过渡 120ms，避免读到过渡中间值
      const atTable = await page.evaluate(() => window.__btnState('wysiwyg-table-add-row'));
      const rowSteps = [
        { name: '表内底部', x: hv.gridRect.cx, y: hv.gridRect.bottom - 2 },
        { name: '表底缘（紧贴=条带顶）', x: hv.gridRect.cx, y: hv.gridRect.bottom + 1 },
        { name: '条带中心', x: hv.addRowBtn.x, y: hv.addRowBtn.y },
      ];
      const rowSamples = [];
      for (const s of rowSteps) {
        await page.mouse.move(s.x, s.y);
        await pause(120);
        rowSamples.push({ ...s, ...(await page.evaluate(() => window.__btnState('wysiwyg-table-add-row'))) });
      }
      // 真实点击增行条带
      await page.mouse.click(hv.addRowBtn.x, hv.addRowBtn.y);
      await pause(200);
      const shapeAfterRow = await page.evaluate(() => window.__tableShape());
      // 阶段 2：增列（右缘竖条）。提交后遮罩已重建 → 重新取几何。
      await page.evaluate(() => new Promise(r => setTimeout(r, 80)));
      const hv2 = await page.evaluate(() => {
        const t = document.querySelector('div.wysiwyg-block-mask table');
        if (!t) return null;
        const cells = Array.from(t.querySelectorAll('tr')[0].children);
        const fr = cells[0].getBoundingClientRect();
        const lr = cells[cells.length - 1].getBoundingClientRect();
        const r = t.getBoundingClientRect();
        return { right: lr.right, cy: fr.top + (lr.bottom - fr.top) / 2, cx: (fr.left + lr.right) / 2, cyy: fr.top + (lr.bottom - fr.top) / 2 };
      });
      let colSamples = [], shapeAfterCol = null;
      if (hv2) {
        const addColBtn = { x: hv2.right + 8, y: hv2.cy }; // 竖条中心 = 网格右缘 + 8（紧贴，无间隙）
        await page.mouse.move(hv2.cx, hv2.cyy);
        await pause(120);
        const colSteps = [
          { name: '表内右部', x: hv2.right - 2, y: hv2.cy },
          { name: '表右缘（紧贴=条带左）', x: hv2.right + 1, y: hv2.cy },
          { name: '条带中心', x: addColBtn.x, y: addColBtn.y },
        ];
        for (const s of colSteps) {
          await page.mouse.move(s.x, s.y);
          await pause(120);
          colSamples.push({ ...s, ...(await page.evaluate(() => window.__btnState('wysiwyg-table-add-col'))) });
        }
        await page.mouse.click(addColBtn.x, addColBtn.y);
        await pause(200);
        shapeAfterCol = await page.evaluate(() => window.__tableShape());
      }
      console.log('  悬停表格时增行条带: ' + j(atTable));
      console.log('  增行滑动采样: ' + j(rowSamples));
      console.log('  增列滑动采样: ' + j(colSamples));
      const vis = (s) => parseFloat(s.opacity) >= 0.9 && s.stripHover === true; // 容差：opacity 过渡 120ms
      const hid = (s) => parseFloat(s.opacity) < 0.1 && s.stripHover !== true;
      // 回归守卫（2026-10-13 用户截图「按钮离表格很远」）：wrap 收窄到表格网格宽，
      // 条带必须紧贴可见网格边缘——而不是落在整行（pre）中心/最右缘。
      const preCx = hv.preRect ? hv.preRect.x + hv.preRect.w / 2 : hv.tableRect.cx;
      const preRight = hv.preRect ? hv.preRect.right : hv.tableRect.right;
      const checks23 = [
        ['wrap 收窄到表格网格宽（±8px）', Math.abs(hv.wrapRect.w - hv.gridRect.w) < 8],
        ['增行横条中心在网格下缘（离整行中心 >100px）', Math.abs(hv.addRowBtn.x - hv.gridRect.cx) < 2 && Math.abs(hv.addRowBtn.x - preCx) > 100],
        ['增列竖条中心在网格右缘（紧贴，中心 = 右缘 + 8；离整行右缘 >100px）', Math.abs(hv.addColBtn.x - (hv.gridRect.right + 8)) < 2 && Math.abs(hv.addColBtn.x - preRight) > 100],
        ['悬停表格本体：条带不显示（反馈 #5）', hid(atTable)],
        ['表内底部：条带仍不显示', hid(rowSamples.find(s => s.name === '表内底部'))],
        ['增行横条紧贴表格底边（条带顶缘 = 表底缘 ±1.5，反馈 #3）', !!(hv.rowStripRect && Math.abs(hv.rowStripRect.top - hv.gridRect.bottom) < 1.5)],
        ['表底缘（紧贴处）：横条显示', vis(rowSamples.find(s => s.name === '表底缘（紧贴=条带顶）'))],
        ['鼠标移到下边一点（条带上）：横条显示', vis(rowSamples.find(s => s.name === '条带中心'))],
        ['条带悬停期表格行 z-index 抬升（压过下方块）', (rowSamples.find(s => s.name === '条带中心').lineZ || '0') !== '2'],
        ['真实点击增行成功（行数 +1）', shapeAfterRow.rows === hv.trBefore + 1],
        // 2026-07 二轮优化（跟随参考图）：两条带宽度一致（均 16px）；条带紧贴表格边框（无间隙）；
        // wrap 上下留白 24+24（容纳浮空把手）；增行横条落在下留白内（不遮挡下一行内容）
        ['增行/增列条带宽度一致（均 16px）', !!(hv.rowStripRect && hv.colStripRect && Math.abs(hv.rowStripRect.h - 16) < 0.5 && Math.abs(hv.colStripRect.w - 16) < 0.5 && Math.abs(hv.rowStripRect.h - hv.colStripRect.w) < 0.5)],
        ['wrap 含上下留白（高 = 表格高 + 48px ±3）', Math.abs((hv.wrapRect.h - hv.tableRect.h) - 48) < 3],
        ['增行横条不遮挡下一行内容（条带底缘 ≤ 下一行顶缘 - 4px）', !!(hv.rowStripRect && hv.nextLineTop != null && hv.rowStripRect.bottom <= hv.nextLineTop - 4)],
        ['增列竖条与表格同高（顶/底贴表格 ±2px）', !!(hv.colStripRect && hv.rowStripRect && Math.abs(hv.colStripRect.top - hv.gridRect.top) < 2 && Math.abs(hv.colStripRect.bottom - hv.gridRect.bottom) < 2)],
      ];
      if (hv2) {
        checks23.push(['悬停表格本体时增列竖条不显示', hid(colSamples.find(s => s.name === '表内右部'))]);
        checks23.push(['增列竖条紧贴表格右边（条带左缘 = 表右缘 ±1.5，反馈 #3）', !!(hv.colStripRect && Math.abs(hv.colStripRect.left - hv.gridRect.right) < 1.5)]);
        checks23.push(['表右缘（紧贴处）：竖条显示', vis(colSamples.find(s => s.name === '表右缘（紧贴=条带左）'))]);
        checks23.push(['鼠标移到右边一点（条带上）：竖条显示', vis(colSamples.find(s => s.name === '条带中心'))]);
        checks23.push(['真实点击增列成功（列数 +1）', shapeAfterCol ? (shapeAfterCol.cols === hv.tdColsBefore + 1) : false]);
      }
      for (const [label, ok] of checks23) {
        console.log(`  ${ok ? '✓' : '✗'} ${label}`);
        if (!ok) fail++;
      }
    }
  }

  // ---------- S24：表格外拖拽把手（2026-10-13 用户参考图 2/3/6，边缘邻近触发） ----------
  // 行轨道 = 表左缘外 24px（常驻命中区），行握点 JS 定位到悬停行中线（表头行同样出）；
  // 列轨道 = 表上方 24px（常驻命中区），列握点 JS 定位到悬停列中心。
  // 视觉两档：悬停 = 灰色点阵 16×16 小握点（无底色、无行/列高亮）；停在单元格上 = 都不出；
  // 拖动（超 4px 阈值）= 握点变 16px 厚蓝底圆角矩形 + 被拖行/列浅蓝高亮（**留在原位，不实时重排**）
  // + **2px 蓝色落点指示线**（行拖 = 横线通表宽、列拖 = 竖线通表高，标出要拖动到的位置），
  // 蓝把手**跟随指针**连续移动。两种把手同厚 16px（与增行/增列条带一致）、距边框等距 6px。
  // 表头行可拖（拖走后落到首位的数据行升为新表头）；表头格普通点击可编辑。真实鼠标全流程。
  {
    console.log('\n=== S24：表格外拖拽把手（边缘邻近 / 悬停灰 / 拖动蓝高亮跟随 / 表头可拖） ===');
    const hd = await page.evaluate(() => window.__runTableHandles());
    if (hd.err) {
      console.log('  ⚠ 场景失败: ' + hd.err);
      fail++;
    } else {
      const pause = (ms) => new Promise(r => setTimeout(r, ms));
      const j = (o) => JSON.stringify(o);
      const hs = () => page.evaluate(() => window.__handleState());
      const hitAt = (x, y) => page.evaluate(([px, py]) => {
        const el = document.elementFromPoint(px, py);
        return el ? el.tagName + '|' + String(el.className).slice(0, 40) : null;
      }, [x, y]);
      // 阶段 0：停在单元格上 → 两个握点都不出现（悬停只认 gutter 边缘）
      await page.mouse.move(hd.col2Cell.x, hd.col2Cell.y);
      await pause(150);
      const hs0 = await hs();
      // 阶段 1：鼠标移到第 1 数据行左边一点（左 gutter）→ 灰色行握点，行不高亮
      await page.mouse.move(hd.rowHandle.x, hd.rowHandle.y);
      await pause(150);
      const hs1 = await hs();
      const hitRh = await hitAt(hd.rowHandle.x, hd.rowHandle.y);
      console.log('  hover 单元格: ' + j({ rowGrip: hs0.rowGrip && hs0.rowGrip.opacity, colGrip: hs0.colGrip && hs0.colGrip.opacity }) + ' | hover 行 gutter: ' + j(hs1) + ' | 命中: ' + hitRh);
      // 阶段 2：真实拖行——在左 gutter 按下（= 行轨/行握点），拖过第 3 数据行中点；
      // 拖动中读：被拖行浅蓝高亮 + 握点变蓝底胶囊 + 蓝胶囊跟随指针（反馈 #1）
      await page.mouse.down();
      await pause(80);
      const hsPress1 = await hs(); // 按下未拖动：把手应已变蓝（用户反馈），无行高亮/落点线
      await page.mouse.move(hd.rowHandle.x, hd.rowDragTo.y, { steps: 10 });
      // 中途折返到「第 2 数据行中线 + 9px」（非任何行中心）读握点位置：
      // 跟随 = 握点中心 ≈ 指针 y；旧的「按行中心吸附」实现会差 9px 而失败
      const midY = hd.rows[1].cy + 9;
      await page.mouse.move(hd.rowHandle.x, midY);
      await pause(80);
      const hsFollow = await hs();
      await page.mouse.move(hd.rowHandle.x, hd.rowDragTo.y, { steps: 4 });
      await pause(120);
      const hsDrag1 = await hs();
      await page.mouse.up();
      await pause(300);
      const hsPostRow = await hs();
      const srcAfterRow = await page.evaluate(() => window.__tableSourceLines());
      const lineInfo = (o) => (o.dropLine ? { op: o.dropLine.opacity, isRow: o.dropLine.isRow, isCol: o.dropLine.isCol, cx: +o.dropLine.rect.cx.toFixed(1), cy: +o.dropLine.rect.cy.toFixed(1), w: +o.dropLine.rect.w.toFixed(1), h: +o.dropLine.rect.h.toFixed(1) } : null);
      console.log('  拖行中(跟随点 y=' + midY.toFixed(1) + '): ' + j({ gripCy: hsFollow.rowGrip && hsFollow.rowGrip.rect.cy, dragRowBg: hsFollow.dragRowBg, line: lineInfo(hsFollow), domOrder: hsFollow.domOrder }) + ' | 拖行中: ' + j({ dragRowBg: hsDrag1.dragRowBg, trackDrag: hsDrag1.rowTrack && hsDrag1.rowTrack.dragging, gripBg: hsDrag1.rowGrip && hsDrag1.rowGrip.background, line: lineInfo(hsDrag1), domOrder: hsDrag1.domOrder, tableB: hsDrag1.tableRect && +hsDrag1.tableRect.b.toFixed(1), tableW: hsDrag1.tableRect && +hsDrag1.tableRect.w.toFixed(1) }) + ' | 拖行后: ' + j({ line: lineInfo(hsPostRow), src: srcAfterRow }));
      // 阶段 3：鼠标移到第 2 列上边一点（顶 gutter）→ 灰色列握点，列不高亮
      await page.mouse.move(hd.colPill.x, hd.colPill.y);
      await pause(150);
      const hs2 = await hs();
      const hitPl = await hitAt(hd.colPill.x, hd.colPill.y);
      console.log('  hover 列 gutter: ' + j(hs2) + ' | 命中: ' + hitPl);
      // 阶段 4：真实拖列——在顶 gutter 按下（= 列轨/列握点）拖到第 3 列右侧；
      // 拖动中读：被拖列浅蓝高亮（留在原位）+ 蓝色落点竖线（表右缘）+ 握点变蓝底胶囊
      await page.mouse.down();
      await pause(80);
      const hsPress2 = await hs(); // 按下未拖动：列把手应已变蓝
      await page.mouse.move(hd.colDragTo.x, hd.colPill.y, { steps: 10 });
      await pause(120);
      const hsDrag2 = await hs();
      await page.mouse.up();
      await pause(300);
      const srcAfterCol = await page.evaluate(() => window.__tableSourceLines());
      console.log('  拖列中: ' + j({ dragCol: hsDrag2.dragColStyle, trackDrag: hsDrag2.colTrack && hsDrag2.colTrack.dragging, gripBg: hsDrag2.colGrip && hsDrag2.colGrip.background, line: lineInfo(hsDrag2), tableR: hsDrag2.tableRect && +hsDrag2.tableRect.r.toFixed(1), tableH: hsDrag2.tableRect && +hsDrag2.tableRect.h.toFixed(1) }) + ' | 拖列后: ' + j(srcAfterCol));
      // 阶段 5：表头行左边一点（同一左 gutter 带 × 表头行中线）→ 行握点同样出现（反馈 #2）
      await page.mouse.move(hd.headGutter.x, hd.headGutter.y);
      await pause(150);
      const hsHead = await hs();
      const hitHead = await hitAt(hd.headGutter.x, hd.headGutter.y);
      console.log('  hover 表头 gutter: ' + j(hsHead) + ' | 命中: ' + hitHead);
      // 阶段 6：真实拖表头行到底部 → 原首个数据行升为新表头（moveTableRow 语义）
      await page.mouse.down();
      await page.mouse.move(hd.rowHandle.x, hd.rowDragTo.y, { steps: 10 });
      await pause(120);
      await page.mouse.up();
      await pause(300);
      const srcAfterHead = await page.evaluate(() => window.__tableSourceLines());
      console.log('  拖表头后: ' + j(srcAfterHead));

      // 阶段 7：表头格**普通点击**（不动）→ 进格编辑（2026-10-13 反馈 #2：表头也要
      // 可以编辑；2026-10-20 起表头格不再是列拖把手，按下即格编辑、无拖拽）
      let headEdit = null, headEsc = null;
      const hdHead = await page.evaluate(() => {
        const th = document.querySelector('div.wysiwyg-block-mask table th');
        if (!th) return null;
        const r = th.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      if (hdHead) {
        await page.mouse.click(hdHead.x, hdHead.y);
        await pause(150);
        headEdit = await page.evaluate(() => {
          const th = document.querySelector('div.wysiwyg-block-mask table th');
          return th ? {
            editable: th.getAttribute('contenteditable') === 'true',
            cls: th.classList.contains('wysiwyg-cell-editing'),
            text: th.textContent,
          } : null;
        });
        console.log('  表头点击编辑态: ' + j(headEdit));
        await page.keyboard.press('Escape');
        await pause(150);
        headEsc = await page.evaluate(() => {
          const th = document.querySelector('div.wysiwyg-block-mask table th');
          return th ? { notEditable: th.getAttribute('contenteditable') !== 'true', text: th.textContent, src: window.__tableSourceLines()[0] } : null;
        });
        console.log('  表头 Esc 后: ' + j(headEsc));
      }

      // 阶段 8（2026-10-20 用户要求：表头不允许拖动，只有顶部/左侧把手可发起拖拽）：
      // 表头格按下 + 拖过 4px 阈值 → 不得启动列拖拽（无轨道拖态/列高亮/落点线、
      // 源码列序不变）；按下语义仍是格编辑
      let headDrag = null;
      const hdHead2 = await page.evaluate(() => {
        const ths = document.querySelectorAll('div.wysiwyg-block-mask table thead th');
        const th = ths[1];
        if (!th) return null;
        const r = th.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: th.textContent };
      });
      if (hdHead2) {
        await page.mouse.move(hdHead2.x, hdHead2.y);
        await pause(100);
        await page.mouse.down();
        await pause(80);
        const hsPressH = await hs();
        await page.mouse.move(hdHead2.x + 40, hdHead2.y, { steps: 8 });
        await pause(120);
        const hsDragH = await hs();
        await page.mouse.up();
        await pause(300);
        // 格编辑（如有）Esc 取消，留给后续断言干净表格
        await page.keyboard.press('Escape');
        await pause(150);
        const srcAfterHeadDrag = await page.evaluate(() => window.__tableSourceLines());
        headDrag = {
          pressColTrack: hsPressH.colTrack && hsPressH.colTrack.dragging,
          pressRowTrack: hsPressH.rowTrack && hsPressH.rowTrack.dragging,
          dragCol: hsDragH.dragColStyle,
          dropLine: hsDragH.dropLine ? hsDragH.dropLine.opacity : null,
          src: srcAfterHeadDrag,
        };
        console.log('  表头格拖动: ' + j(headDrag));
      }

      const rowOrder = (lines) => (lines || []).slice(2).map((l) => (l.split('|')[1] || '').trim());
      const checks24 = [
        ['停在单元格上：行/列握点都不出现', hs0.rowGrip && hs0.rowGrip.opacity === '0' && hs0.colGrip && hs0.colGrip.opacity === '0'],
        ['行 gutter 出灰色行握点（opacity 1）', hs1.rowGrip && hs1.rowGrip.opacity === '1'],
        ['行握点在表格外（不覆盖网格、右缘距表左缘 6px、定位在悬停行中线）', hs1.rowGrip && Math.abs(hs1.rowGrip.rect.r - (hd.gridLeft - 6)) < 1.5 && hs1.rowGrip.rect.l < hd.gridLeft && Math.abs(hs1.rowGrip.rect.cy - hd.rows[0].cy) < 2.5],
        ['行握点可命中（elementFromPoint = 握点/轨道）', /SPAN\|wysiwyg-table-row-/.test(hitRh || '')],
        ['悬停行只出灰握点（无底色）', hs1.rowGrip && hs1.rowGrip.background === 'rgba(0, 0, 0, 0)'],
        ['悬停行不高亮（底色透明，仅拖动才高亮）', !hs1.rowBg || hs1.rowBg === 'rgba(0, 0, 0, 0)'],
        ['悬停行时列握点不出现', hs1.colGrip && hs1.colGrip.opacity === '0'],
        // 2026-07 用户反馈：按下鼠标即变蓝（不等拖动阈值）；但未拖动时无高亮/落点线
        ['按下未拖动：行把手已变蓝（蓝底圆角矩形）', !!(hsPress1.rowTrack && hsPress1.rowTrack.dragging && hsPress1.rowGrip && hsPress1.rowGrip.background === 'rgb(37, 99, 235)' && hsPress1.rowGrip.opacity === '1')],
        ['按下未拖动：行不高亮、落点线未显示（点击语义保留）', hsPress1.dragRowBg === undefined && hsPress1.dropLine && hsPress1.dropLine.opacity === '0'],
        ['按下未拖动：列把手已变蓝', !!(hsPress2.colTrack && hsPress2.colTrack.dragging && hsPress2.colGrip && hsPress2.colGrip.background === 'rgb(37, 99, 235)' && hsPress2.colGrip.opacity === '1')],
        ['按下未拖动：列不高亮、落点线未显示', hsPress2.dragColStyle === undefined && hsPress2.dropLine && hsPress2.dropLine.opacity === '0'],
        ['拖动中被拖行浅蓝高亮（accent-subtle）', !!(hsDrag1.dragRowBg && hsDrag1.dragRowBg !== 'rgba(0, 0, 0, 0)')],
        ['拖动中握点变蓝底胶囊', !!(hsDrag1.rowTrack && hsDrag1.rowTrack.dragging && hsDrag1.rowGrip && hsDrag1.rowGrip.background === 'rgb(37, 99, 235)')],
        ['拖动中蓝胶囊跟随小手（握点中心 ≈ 指针 y，非吸附行中心）', !!(hsFollow.rowGrip && Math.abs(hsFollow.rowGrip.rect.cy - midY) < 3)],
        // 2026-07 二轮优化（跟随参考图 4/5）：拖拽蓝把手 = 16px 厚圆角矩形（radius 4）、
        // 白点阵居中；行拖 = 竖条（16×行高）、列拖 = 横条（列宽×16），与增行/增列条同厚
        ['行拖蓝把手 = 16px 宽圆角竖条（与列拖把手同厚度 = 增行/增列条 16px）', !!(hsDrag1.rowGrip && Math.abs(hsDrag1.rowGrip.rect.w - 16) < 1.5)],
        ['行拖蓝胶囊高度 = 被拖行行高', !!(hsDrag1.rowGrip && hd.rows[0] && Math.abs(hsDrag1.rowGrip.rect.h - hd.rows[0].h) < 2.5)],
        ['列拖蓝胶囊 = 横胶囊：宽度 ≈ 被拖列宽', !!(hsDrag2.colGrip && hd.ths[1] && Math.abs(hsDrag2.colGrip.rect.w - hd.ths[1].w) < 3.5)],
        ['列拖胶囊高度 = 16px（与行拖胶囊同厚度 = 增行/增列条 16px）', !!(hsDrag2.colGrip && Math.abs(hsDrag2.colGrip.rect.h - 16) < 1.5)],
        ['行拖/列拖胶囊样式一致（厚度均 16px）', !!(hsDrag1.rowGrip && hsDrag2.colGrip && Math.abs(hsDrag1.rowGrip.rect.w - 16) < 1.5 && Math.abs(hsDrag2.colGrip.rect.h - 16) < 1.5)],
        // 2026-10-13 反馈 #1：行拖落点指示线（淡蓝背景 = 被拖行、蓝线 = 要拖动到的位置）
        ['拖行中落点线 = 蓝色横线通表宽（反馈 #1）', !!(hsDrag1.dropLine && hsDrag1.dropLine.isRow && hsDrag1.dropLine.opacity === '1' && hsDrag1.tableRect && Math.abs(hsDrag1.dropLine.rect.w - hsDrag1.tableRect.w) < 2.5)],
        ['拖行中落点线在表底缘（2px 细线、居中于落点边界，参考图 5）', !!(hsDrag1.dropLine && hsDrag1.tableRect && Math.abs(hsDrag1.dropLine.rect.h - 2) < 1 && Math.abs(hsDrag1.dropLine.rect.cy - hsDrag1.tableRect.b) < 2.5)],
        ['中途折返落点线随指针移到第 3 行顶缘（不实时重排、线标落点）', !!(hsFollow.dropLine && hsFollow.dropLine.opacity === '1' && hd.rows[2] && Math.abs(hsFollow.dropLine.rect.cy - hd.rows[2].y) < 2.5)],
        ['拖行中 DOM 不实时重排（被拖行留在原位、仅淡蓝高亮）', !!(hsDrag1.domOrder && hs0.domOrder && JSON.stringify(hsDrag1.domOrder) === JSON.stringify(hs0.domOrder) && hsDrag1.domOrder[1] === 'a2')],
        ['释放后落点线隐藏', !!(hsPostRow.dropLine && hsPostRow.dropLine.opacity === '0')],
        ['真实拖行成功（首数据行移到底部：a3,a4,a2）', JSON.stringify(rowOrder(srcAfterRow)) === JSON.stringify(['a3', 'a4', 'a2'])],
        ['列 gutter 出灰色列握点（opacity 1）', hs2.colGrip && hs2.colGrip.opacity === '1'],
        ['列握点浮于表上方（完全在表格外、底缘距表顶缘 6px、x = 悬停列中心）——上留白 24px', !!(hs2.colGrip && hd.ths[1] && hs2.colGrip.rect.b <= hd.ths[1].top + 0.5 && Math.abs(hs2.colGrip.rect.b - (hd.ths[1].top - 6)) < 1.5 && Math.abs(hs2.colGrip.rect.cx - hd.ths[1].cx) < 2.5)],
        ['列握点可命中（elementFromPoint = 握点/轨道）', /SPAN\|wysiwyg-table-col-/.test(hitPl || '')],
        ['悬停列只出灰握点（无底色、列格不高亮）', hs2.colGrip && hs2.colGrip.background === 'rgba(0, 0, 0, 0)' && (!hs2.hoverColCellBg || hs2.hoverColCellBg === 'rgba(0, 0, 0, 0)')],
        ['悬停列时行握点不出现', hs2.rowGrip && hs2.rowGrip.opacity === '0'],
        ['拖动中被拖列浅蓝高亮（右缘蓝线已改为落点指示线）', !!(hsDrag2.dragColStyle && hsDrag2.dragColStyle.bg !== 'rgba(0, 0, 0, 0)' && !/inset/.test(hsDrag2.dragColStyle.shadow || ''))],
        // 2026-10-13 反馈 #2：列拖落点指示线（淡蓝背景 = 被拖列、蓝线 = 要拖动到的位置）
        ['拖列中落点线 = 蓝色竖线通表高（反馈 #2）', !!(hsDrag2.dropLine && hsDrag2.dropLine.isCol && hsDrag2.dropLine.opacity === '1' && hsDrag2.tableRect && Math.abs(hsDrag2.dropLine.rect.h - hsDrag2.tableRect.h) < 2.5)],
        ['拖列中落点线在表右缘（2px 细线、居中于落点边界，参考图 4）', !!(hsDrag2.dropLine && hsDrag2.tableRect && Math.abs(hsDrag2.dropLine.rect.w - 2) < 1 && Math.abs(hsDrag2.dropLine.rect.cx - hsDrag2.tableRect.r) < 2.5)],
        ['拖动中握点变蓝底胶囊', !!(hsDrag2.colTrack && hsDrag2.colTrack.dragging && hsDrag2.colGrip && hsDrag2.colGrip.background === 'rgb(37, 99, 235)')],
        ['真实拖列成功（B 列移到 C 后：A1,C1,B1）', !!(srcAfterCol && srcAfterCol[0].indexOf('| A1 | C1 | B1 |') >= 0)],
        ['表头行左边一点也出灰色行握点（定位表头行中线）', !!(hsHead.rowGrip && hsHead.rowGrip.opacity === '1' && hsHead.rowGrip.background === 'rgba(0, 0, 0, 0)' && Math.abs(hsHead.rowGrip.rect.cy - hd.headGutter.y) < 2.5)],
        ['表头 gutter 命中握点/轨道', /SPAN\|wysiwyg-table-row-/.test(hitHead || '')],
        ['真实拖表头成功（首个数据行升为新表头：a3 行居首）', !!(srcAfterHead && srcAfterHead[0].trim() === '| a3 | c3 | b3 |' && srcAfterHead[1] === '| --- | --- | --- |')],
        ['拖表头后原表头成为末行数据行（A1 行居末）', !!(srcAfterHead && srcAfterHead[4] === '| A1 | C1 | B1 |')],
        ['表头格普通点击进格编辑（表头也要可以编辑，反馈 #2）', !!(headEdit && headEdit.editable && headEdit.cls && headEdit.text === 'a3')],
        ['表头编辑 Esc 取消恢复（源码不变）', !!(headEsc && headEsc.notEditable && headEsc.text === 'a3' && headEsc.src === '| a3 | c3 | b3 |')],
        // 2026-10-20 用户要求：表头不允许拖动（只有顶部/左侧把手可发起拖拽）
        ['表头格按下+拖动超阈值：不启动任何拖拽（无轨道拖态/列高亮/落点线）',
          !!(headDrag && !headDrag.pressColTrack && !headDrag.pressRowTrack && !headDrag.dragCol && headDrag.dropLine === '0')],
        ['表头格拖动后源码列序不变（a3,c3,b3 不换位）',
          !!(headDrag && headDrag.src && headDrag.src[0] && headDrag.src[0].indexOf('| a3 | c3 | b3 |') >= 0)],
      ];
      for (const [label, ok] of checks24) {
        console.log(`  ${ok ? '✓' : '✗'} ${label}`);
        if (!ok) fail++;
      }
    }
  }

  // ---------- S26：表格交互 2026-10-14 四项修复 ----------
  // ① 表格是文档最后块：格提交后表后补空行落光标，表下输入不伤表格（合成事件，harness 内）
  // ③ Enter 切格：右邻 → 下一行首格；末行 = 提交回编辑器（合成事件，harness 内）
  // ④ 点表格网格右侧空白 → 表格保持遮罩、光标不动（真实点击）；
  //    只有块右上「编辑」按钮可进源码态（真实点击）。
  {
    console.log('\n=== S26：表格交互 2026-10-14 四项修复 ===');
    const tf = await page.evaluate(() => window.__runTableFixes2026());
    if (tf.err) {
      console.log('  ⚠ 场景失败: ' + tf.err);
      fail++;
    } else {
      const cursorNow = () => page.evaluate(() => {
        const el = document.querySelector('.CodeMirror');
        const cm = el && el.CodeMirror;
        return cm ? cm.getCursor() : null;
      });
      const tableMasked = () => page.evaluate(() =>
        !!document.querySelector('div.wysiwyg-block-mask .wysiwyg-table-wrap'));
      const beforeCursor = await cursorNow();
      // ④ 真实点击表格网格右缘外 24px（越过 16px 增列条带）→ 不得撤罩/挪光标
      await page.mouse.click(tf.gridRect.right + 24, tf.gridRect.cy);
      await new Promise(r => setTimeout(r, 150));
      const afterRight = {
        cursor: await cursorNow(),
        masked: await tableMasked(),
        noEditing: await page.evaluate(() => !document.querySelector('div.wysiwyg-block-mask table .wysiwyg-cell-editing')),
      };
      // ④ 编辑按钮 = 唯一源码入口（真实点击）
      let afterBtn = null;
      if (tf.editBtnRect) {
        await page.mouse.click(tf.editBtnRect.x + tf.editBtnRect.w / 2, tf.editBtnRect.y + tf.editBtnRect.h / 2);
        await new Promise(r => setTimeout(r, 250));
        afterBtn = {
          unmasked: !(await tableMasked()),
          cursorLine: (await cursorNow() || {}).line,
        };
      }
      console.log('  合成阶段: ' + JSON.stringify({ nav: [tf.navRight, tf.navThird, tf.navWrapRow], exit: tf.exitLastRow, below: tf.typeBelow }));
      console.log('  右侧空白点击后: ' + JSON.stringify(afterRight));
      console.log('  编辑按钮点击后: ' + JSON.stringify(afterBtn));
      const checks26 = [
        ['表格为文档最后块（场景前提）', tf.tableIsLastBlock === true],
        ['Enter 进右邻格 + 本格内容已提交', !!(tf.navRight && tf.navRight.moved === true && tf.navRight.prevCommitted === true)],
        ['Enter 续进第三格', tf.navThird === true],
        ['Enter 无右邻 → 下一行首格', tf.navWrapRow === true],
        ['末行 Enter = 提交回编辑器（r3cz 回写、无残留编辑态）', !!(tf.exitLastRow && tf.exitLastRow.committed === true && tf.exitLastRow.noEditing === true)],
        ['表后落行：补空行 + 光标落新行（不再落进表格遮罩区间）', !!(tf.exitLastRow && tf.exitLastRow.lineGained && tf.exitLastRow.newLineEmpty && tf.exitLastRow.cursorOnNewLine)],
        ['提交后表格保持遮罩（不判活动块、不变源码态）', !!(tf.exitLastRow && tf.exitLastRow.tableStillMasked && tf.exitLastRow.tableNotActive)],
        ['表下空行输入：成段落块、表格保持渲染、表源未动', !!(tf.typeBelow && tf.typeBelow.paragraphLine && tf.typeBelow.tableStillMasked && tf.typeBelow.tableNotActive && tf.typeBelow.tableSrcUntouched)],
        ['点表格右侧空白：表格保持遮罩（不进源码模式）', afterRight.masked === true && afterRight.noEditing === true],
        ['点表格右侧空白：光标不动', !!(afterRight.cursor && beforeCursor && afterRight.cursor.line === beforeCursor.line && afterRight.cursor.ch === beforeCursor.ch)],
        ['编辑按钮 = 唯一源码入口（真实点击进源码态、光标落块首行）', !!(afterBtn && afterBtn.unmasked === true && afterBtn.cursorLine === 2)],
      ];
      for (const [label, ok] of checks26) {
        console.log(`  ${ok ? '✓' : '✗'} ${label}`);
        if (!ok) fail++;
      }
    }
  }

  // ---------- S27：表格拖拽落点线 inline 坐标残留（偶发「线跑右边去了」，2026-10-14） ----------
  // 步骤1：列3 从顶部列轨拖到末尾（target=表格右缘）原位释放 → 无提交 → 遮罩不重建，
  //   drop-line 元素存活（带 inline left = 表宽）；
  // 步骤2：行拖 → 落点横线必须从表格**左缘**开始、宽=表宽（修复前：继承残留 inline
  //   left，横线从表格右缘起飞、向右延伸出表格——用户截图场景）。
  {
    console.log('\n=== S27：表格拖拽落点线残留（线跑右边去了） ===');
    const dl = await page.evaluate(() => window.__runDropLineLeak2026());
    if (dl.err) {
      console.log('  ⚠ 场景失败: ' + dl.err);
      fail++;
    } else {
      const lineState = () => page.evaluate(() => {
        const l = document.querySelector('div.wysiwyg-block-mask .wysiwyg-table-drop-line');
        if (!l) return null;
        const r = l.getBoundingClientRect();
        return { cls: l.className, left: l.style.left, top: l.style.top, op: l.style.opacity, x: r.x, w: r.width };
      });
      // 步骤1：列拖（按列3 正上方列轨 → 拖过末列中线到末尾 → 原位释放不提交）
      await page.mouse.move(dl.colStart.x, dl.colStart.y);
      await page.mouse.down();
      await page.mouse.move(dl.colStart.x + 40, dl.colStart.y, { steps: 6 });
      const mid1 = await lineState();
      await page.mouse.up();
      await new Promise(r => setTimeout(r, 100));
      const after1 = await lineState();
      // 步骤2：行拖（按数据行左侧行轨 → 下拖到末尾）
      await page.mouse.move(dl.rowStart.x, dl.rowStart.y);
      await page.mouse.down();
      await page.mouse.move(dl.rowStart.x, dl.rowStart.y + 40, { steps: 6 });
      const mid2 = await lineState();
      await page.mouse.up();
      console.log('  列拖(中): ' + JSON.stringify(mid1) + '  列拖(释放后): ' + JSON.stringify(after1));
      console.log('  行拖(中): ' + JSON.stringify(mid2));
      const checks27 = [
        ['场景前提：表格为文档最后块', dl.tableIsLastBlock === true],
        ['列拖：落点线=竖线且定位在表右缘（复现残留的最坏值）', !!(mid1 && mid1.cls.indexOf('drop-line-col') >= 0 && mid1.op === '1' && Math.abs(mid1.x - (dl.grid.right - 1)) <= 2)],
        ['列拖释放：drop-line inline left 已清除（不留残留）', after1 && after1.left === ''],
        ['行拖：横线从表格左缘开始（「线跑右边去了」不复现）', !!(mid2 && mid2.cls.indexOf('drop-line-row') >= 0 && mid2.op === '1' && Math.abs(mid2.x - dl.grid.left) <= 2)],
        ['行拖：横线宽=表宽（不再从右缘起飞延伸出表格）', !!(mid2 && Math.abs(mid2.w - dl.grid.w) <= 2)],
        ['行拖：drop-line 无残留 inline left（每次拖拽自洽）', mid2 && mid2.left === ''],
      ];
      for (const [label, ok] of checks27) {
        console.log(`  ${ok ? '✓' : '✗'} ${label}`);
        if (!ok) fail++;
      }
    }
  }

  // ---------- S28：点表格格后旧活动块未失焦渲染（偶发视觉 bug，2026-10-14 用户截图） ----------
  // 步骤1：点表下标题（隔空行）→ 标题转活动块（源码态）——正常行为；
  // 步骤2：点表格「极速」格 → 格就地编辑；
  // 期望：标题失焦重新渲染（重新遮罩）、无活动块、表格保持渲染。
  // 修复前：遮罩 mousedown stopPropagation 后 CM 光标/cursorActivity 不再变化，
  // 旧活动块无人重遮 → 标题一直源码态+高亮。
  {
    console.log('\n=== S28：点表格格后旧活动块失焦渲染 ===');
    const ca = await page.evaluate(() => window.__runCellActiveBlock2026());
    if (ca.err) {
      console.log('  ⚠ 场景失败: ' + ca.err);
      fail++;
    } else {
      const read = () => page.evaluate(() => window.__s28read());
      // 步骤1：真实点击表下标题 → 标题应转活动块（源码态）、标题块（title）重遮
      await page.mouse.click(ca.headingRect.x, ca.headingRect.y);
      await new Promise(r => setTimeout(r, 250));
      const afterHead = await read();
      // 步骤2：真实点击表格「极速」格 → 格就地编辑 + 旧活动块（标题）失焦重渲染。
      // ⚠️ 格坐标必须在步骤1 之后重新测量：点标题会使标题块撤罩（渲染高度 ≠ 源码行高），
      // 表格随之位移，初始几何已失效（旧坐标会点错到上一行）。
      const cellRect2 = await page.evaluate(() => {
        const c = document.querySelector('div.wysiwyg-block-mask table tbody tr:nth-child(2) td:nth-child(3)');
        if (!c) return null;
        const r = c.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: c.textContent };
      });
      if (!cellRect2 || cellRect2.text !== '极速') {
        console.log('  ⚠ 步骤2 目标格重定位失败: ' + JSON.stringify(cellRect2));
        fail++;
      } else {
        await page.mouse.click(cellRect2.x, cellRect2.y);
        await new Promise(r => setTimeout(r, 250));
        const afterCell = await read();
        console.log('  初始: ' + JSON.stringify(ca.initial));
        console.log('  点标题后: ' + JSON.stringify(afterHead));
        console.log('  点格后: ' + JSON.stringify(afterCell));
        const checks28 = [
          ['前提：初始活动块=标题（源码态），表格/表下标题均渲染', ca.initial && ca.initial.activeIdx === 0 && ca.initial.tableMasked === true && ca.initial.headingMasked === true && ca.initial.titleMasked === false],
          ['点表下标题：标题转活动块（源码态+高亮）、原活动块重遮', afterHead && afterHead.headingMasked === false && afterHead.headingActiveLine === true && afterHead.titleMasked === true],
          ['点表格格：格进入就地编辑（文本=极速）', afterCell && afterCell.cellEditing === true && afterCell.editingText === '极速'],
          ['点表格格：表下标题失焦重新渲染（源码态收起）', afterCell && afterCell.headingMasked === true && afterCell.headingActiveLine === false],
          ['点表格格：无活动块（activeIdx=-1）', afterCell && afterCell.activeIdx === -1],
          ['点表格格：表格保持渲染（不整表撤罩）', afterCell && afterCell.tableMasked === true],
        ];
        for (const [label, ok] of checks28) {
          console.log(`  ${ok ? '✓' : '✗'} ${label}`);
          if (!ok) fail++;
        }
      }
    }
  }

  // ---------- S29：格内文字选中 + 点外部失焦（2026-10-14 用户要求） ----------
  // ① 进格编辑后真实 down-move-up 拖选 → 应选出格内文本（修复前：preventDefault +
  //    遮罩 user-select:none 双重拦截，选不中）；
  // ② 点另一格 → 原格提交、新格编辑（既有行为回归）；
  // ③ 点表 wrap 下留白 → 单元格失焦提交（修复前：吞掉不动，格保持编辑）；
  // ④ 再进格 → 点表下段落块 → 单元格失焦提交 + 段落转活动块（修复前：格保持编辑）。
  {
    console.log('\n=== S29：格内文字选中 + 点外部失焦 ===');
    const cs = await page.evaluate(() => window.__runCellSelectFocus2026());
    if (cs.err) {
      console.log('  ⚠ 场景失败: ' + cs.err);
      fail++;
    } else {
      const read = () => page.evaluate(() => window.__s29read());
      // ① 点 cellA 进格编辑
      await page.mouse.click(cs.cellA.x0, cs.cellA.y);
      await new Promise(r => setTimeout(r, 200));
      const inEdit = await read();
      // 进格后旧活动块（标题）重遮罩 → 渲染高度 ≠ 源码行高 → 表格整体位移，
      // 坐标必须重测（同 S28 步骤：陈旧坐标会点中上方行）
      let cellA2 = await page.evaluate(() => {
        const c = document.querySelector('div.wysiwyg-block-mask table tbody tr td');
        if (!c || c.textContent !== '甲格文字选中测试内容') return null;
        const r = c.getBoundingClientRect();
        return { x0: r.x + 28, y: r.y + r.height / 2, x1: r.x + r.width - 8 };
      });
      if (!cellA2) {
        console.log('  ⚠ 进格后重测 cellA 失败');
        fail++;
      }
      // ① 格内真实拖选（down → move → up）
      if (cellA2) {
        await page.mouse.move(cellA2.x0, cellA2.y);
        await page.mouse.down();
        await page.mouse.move(cellA2.x1, cellA2.y, { steps: 8 });
        await page.mouse.up();
      }
      await new Promise(r => setTimeout(r, 120));
      const afterSelect = await read();
      // ② 点另一格（c2）
      let cellB2 = await page.evaluate(() => {
        const c = document.querySelector('div.wysiwyg-block-mask table tbody tr:nth-child(2) td:nth-child(1)');
        if (!c) return null;
        const r = c.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: c.textContent };
      });
      if (cellB2 && cellB2.text === 'c2') {
        await page.mouse.click(cellB2.x, cellB2.y);
        await new Promise(r => setTimeout(r, 200));
      }
      const afterOtherCell = await read();
      // ③ 点表 wrap 下留白（最底 8px 带，避开增行条带）
      let gutter2 = await page.evaluate(() => {
        const w = document.querySelector('div.wysiwyg-block-mask .wysiwyg-table-wrap');
        if (!w) return null;
        const r = w.getBoundingClientRect();
        return { x: r.x + 30, y: r.bottom - 4 };
      });
      if (gutter2) {
        await page.mouse.click(gutter2.x, gutter2.y);
        await new Promise(r => setTimeout(r, 200));
      }
      const afterGutter = await read();
      // ④ 再进格（c2）→ 点表下段落块
      cellB2 = await page.evaluate(() => {
        const c = document.querySelector('div.wysiwyg-block-mask table tbody tr:nth-child(2) td:nth-child(1)');
        if (!c) return null;
        const r = c.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: c.textContent };
      });
      if (cellB2 && cellB2.text === 'c2') {
        await page.mouse.click(cellB2.x, cellB2.y);
        await new Promise(r => setTimeout(r, 200));
      }
      const inCell2 = await read();
      const para2 = await page.evaluate(() => {
        const p = document.querySelector('div.wysiwyg-block-mask p');
        if (!p) return null;
        const r = p.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: p.textContent };
      });
      if (para2 && para2.text === '表下段落。') {
        await page.mouse.click(para2.x, para2.y);
        await new Promise(r => setTimeout(r, 250));
      }
      const afterPara = await read();
      console.log('  进格编辑: ' + JSON.stringify(inEdit));
      console.log('  格内拖选后: ' + JSON.stringify(afterSelect));
      console.log('  点另一格后: ' + JSON.stringify(afterOtherCell));
      console.log('  点下留白后: ' + JSON.stringify(afterGutter));
      console.log('  再进格: ' + JSON.stringify(inCell2));
      console.log('  点段落块后: ' + JSON.stringify(afterPara));
      const checks29 = [
        ['前提：点格进入就地编辑（格内显示源码文本）', inEdit && inEdit.cellEditing === true && inEdit.editingText === '甲格文字选中测试内容'],
        ['格内文字可选中：真实拖选选出文本、格保持编辑', afterSelect && afterSelect.selText.length >= 2 && afterSelect.selInCellA === true && afterSelect.cellEditing === true],
        ['点另一格：原格提交失焦、新格编辑（c2）', afterOtherCell && afterOtherCell.cellEditing === true && afterOtherCell.editingText === 'c2'],
        ['点表格下留白：单元格失焦（无编辑态、焦点不在格上）', afterGutter && afterGutter.cellEditing === false && afterGutter.activeIsCell === false],
        ['再进格后点另一块（段落）：单元格失焦提交、段落转活动块（源码态）', inCell2 && inCell2.cellEditing === true && afterPara && afterPara.cellEditing === false && afterPara.paraMasked === false && afterPara.activeIdx >= 0],
      ];
      for (const [label, ok] of checks29) {
        console.log(`  ${ok ? '✓' : '✗'} ${label}`);
        if (!ok) fail++;
      }
    }
  }

  // ---------- S30：标题活动行「灰 # 前缀 + 渲染文字」（2026-10-14 用户要求，Typora 式） ----------
  // 修复前：点标题/光标在标题行 → 整行源码（等宽 `## xxx`）；修复后：# 前缀小灰 +
  // 正文渲染尺寸/字重（.wysiwyg-heading-hash / .wysiwyg-heading-text-{level} 两段
  // text marker），h1–h6 全覆盖。
  {
    console.log('\n=== S30：标题活动行 = 灰#前缀 + 渲染文字（h1–h6） ===');
    const HD = ['# 一级标题文字', '## 二级标题文字', '### 三级标题文字',
      '#### 四级标题文字', '##### 五级标题文字', '###### 六级标题文字'];
    const hd = await page.evaluate(() => window.__runHeadingDecor2026());
    if (hd.err) {
      console.log('  ⚠ 场景失败: ' + hd.err);
      fail++;
    } else {
      const read = () => page.evaluate(() => window.__s30read());
      const initial = await read();
      console.log('  初始(h1 活动): ' + JSON.stringify(initial));
      const checks30 = [];
      checks30.push(['初始：h1 活动行 = # 前缀 + 渲染尺寸(text-1)，其余 6 块遮罩',
        !!(initial && initial.hash === '#' && (initial.textCls || '').indexOf('wysiwyg-heading-text-1') >= 0 &&
          initial.text === ' 一级标题文字' && initial.masks === 6)]);
      let r = await page.evaluate(() => window.__s30rects());
      for (let n = 2; n <= 6; n++) {
        if (!r[n]) { checks30.push(['h' + n + '：未找到遮罩（场景异常）', false]); continue; }
        await page.mouse.click(r[n].x, r[n].y);
        await new Promise(rr => setTimeout(rr, 200));
        const st = await read();
        console.log('  点 h' + n + ' 后: ' + JSON.stringify(st));
        checks30.push(['点 h' + n + '：活动行 = ' + n + ' 个#前缀 + 渲染尺寸(text-' + n + ')，其余 6 块遮罩',
          !!(st && st.hash === '#'.repeat(n) && (st.textCls || '').indexOf('wysiwyg-heading-text-' + n) >= 0 &&
            st.text === ' ' + HD[n - 1].slice(n + 1) && st.masks === 6)]);
        r = await page.evaluate(() => window.__s30rects());
      }
      if (r[1]) {
        await page.mouse.click(r[1].x, r[1].y);
        await new Promise(rr => setTimeout(rr, 200));
        const st = await read();
        checks30.push(['切回 h1：装饰恢复 1 级（旧装饰已清、无残留）',
          !!(st && st.hash === '#' && (st.textCls || '').indexOf('wysiwyg-heading-text-1') >= 0 && st.masks === 6)]);
      } else {
        checks30.push(['切回 h1：未找到遮罩（场景异常）', false]);
      }
      // 行内编辑：活动 h1 行末输入 → 装饰自动跟随（新字符进渲染段、# 前缀不变）
      await page.keyboard.type('X');
      await new Promise(rr => setTimeout(rr, 150));
      const stEdit = await read();
      console.log('  输入 X 后: ' + JSON.stringify(stEdit));
      checks30.push(['标题行输入：# 前缀不变、新字符在渲染文字段（装饰自动跟随）',
        !!(stEdit && stEdit.hash === '#' && stEdit.text === ' 一级标题文字X' &&
          (stEdit.textCls || '').indexOf('wysiwyg-heading-text-1') >= 0)]);
      // 点段落 → 全部标题回遮罩（装饰清除）
      r = await page.evaluate(() => window.__s30rects());
      if (r.p) {
        await page.mouse.click(r.p.x, r.p.y);
        await new Promise(rr => setTimeout(rr, 250));
        const stP = await read();
        console.log('  点段落后: ' + JSON.stringify(stP));
        checks30.push(['点段落：标题装饰清除、标题全回遮罩（段落为活动块未遮罩，余 6）',
          !!(stP && stP.hash === null && stP.text === null && stP.masks === 6)]);
      } else {
        checks30.push(['点段落：未找到遮罩（场景异常）', false]);
      }
      for (const [label, ok] of checks30) {
        console.log(`  ${ok ? '✓' : '✗'} ${label}`);
        if (!ok) fail++;
      }
    }
  }

  // ---------- S31：列表/代码块活动行渲染化（2026-10-14 用户要求） ----------
  // 修复前：活动列表/代码块整块源码（`- 项` / `1. 项` / `- [x] 项` / ``` 原样）；
  // 修复后：• 圆点 / 数字序号 / ☐☑ 复选框 + 正文预览字族；代码块 = 渲染灰盒内编辑 +
  // 上下围栏灰显（语法标志）。
  {
    console.log('\n=== S31：列表/代码块活动行渲染化（ul/ol/task/fence） ===');
    const lc = await page.evaluate(() => window.__runListCodeDecor2026());
    if (lc.err) {
      console.log('  ⚠ 场景失败: ' + lc.err);
      fail++;
    } else {
      const read = () => page.evaluate(() => window.__s31read());
      const initial = await read();
      console.log('  初始(ul 活动): ' + JSON.stringify(initial));
      const checks31 = [];
      // 紧凑列表逐项切块（2026-10-21）：初始光标在行 0 → ul 首项块活动（1 圆点）；
      // 点 DOM 首个 ul 遮罩 = 含嵌套子项的第二项块（父+子 2 圆点）；ol/task 同理逐项。
      checks31.push(['初始：ul 首项活动行 = 1 个•圆点 + 条目文字，其余 7 块遮罩',
        initial.bullets === 1 && initial.listTexts.join('|') === '无序条目一' &&
        initial.masks === 7 && initial.activeIdx === 0]);
      let r = await page.evaluate(() => window.__s31rects());
      if (!r.ol) {
        checks31.push(['ol 块：未找到遮罩（场景异常）', false]);
      } else {
        await page.mouse.click(r.ol.x, r.ol.y);
        await new Promise(rr => setTimeout(rr, 200));
        const st = await read();
        console.log('  点 ol 后: ' + JSON.stringify(st));
        checks31.push(['点 ol（首项）：数字序号 1. 原样渲染 + 条目文字（预览字族）',
          st.olMarkers.join('|') === '1.' && st.listTexts.join('|') === '有序条目一' &&
          st.bullets === 0 && st.masks === 7]);
      }
      r = await page.evaluate(() => window.__s31rects());
      if (!r.task) {
        checks31.push(['task 块：未找到遮罩（场景异常）', false]);
      } else {
        await page.mouse.click(r.task.x, r.task.y);
        await new Promise(rr => setTimeout(rr, 200));
        const st = await read();
        console.log('  点 task 后: ' + JSON.stringify(st));
        checks31.push(['点 task（首项）：0 圆点（任务项渲染态无黑点）+ 1 前缀槽（未勾选）+ 任务文字（含框后源空格间距）',
          st.bullets === 0 && st.taskBoxes === 1 && st.taskChecked === 0 &&
          st.listTexts.join('|') === ' 未完成任务' && st.masks === 7]);
      }
      r = await page.evaluate(() => window.__s31rects());
      if (!r.code) {
        checks31.push(['code 块：未找到遮罩（场景异常）', false]);
      } else {
        await page.mouse.click(r.code.x, r.code.y);
        await new Promise(rr => setTimeout(rr, 200));
        const st = await read();
        console.log('  点 code 后: ' + JSON.stringify(st));
        checks31.push(['点 code：上下围栏灰显（```js / ```）+ 灰盒=整块 4 行（2026-10-18：上下围栏进灰框，含围栏 2 行）',
          st.fences.join('|') === '```js|```' && st.activeBoxLines === 4 &&
          st.listTexts.length === 0 && st.masks === 7]);
        // 行内编辑：代码块内输入 → 装饰稳定（围栏不变）
        await page.keyboard.type('X');
        await new Promise(rr => setTimeout(rr, 150));
        const stE = await read();
        checks31.push(['代码块内输入：围栏装饰稳定（仍 2 段灰显）',
          stE.fences.join('|') === '```js|```' && stE.masks === 7]);
      }
      r = await page.evaluate(() => window.__s31rects());
      if (r.para) {
        await page.mouse.click(r.para.x, r.para.y);
        await new Promise(rr => setTimeout(rr, 250));
        const stP = await read();
        console.log('  点段落后: ' + JSON.stringify(stP));
        checks31.push(['点段落：列表/代码装饰全清（无残留 span）',
          stP.bullets === 0 && stP.taskBoxes === 0 && stP.olMarkers.length === 0 &&
          stP.fences.length === 0 && stP.masks === 7]);
      } else {
        checks31.push(['点段落：未找到遮罩（场景异常）', false]);
      }
      for (const [label, ok] of checks31) {
        console.log(`  ${ok ? '✓' : '✗'} ${label}`);
        if (!ok) fail++;
      }
    }
  }

  // ---------- S32：底部滚动余量（2026-10-14 用户反馈：底部行没法往上滚） ----------
  {
    console.log('\n=== S32：底部行滚动余量（底部无行时也能上滚一段；harness 内复现真实 app CSS 顺序：codemirror.css 裸规则在 styles.css 之后，50vh 须靠特异性取胜） ===');
    const bs = await page.evaluate(() => window.__runBottomScroll2026());
    if (bs.err) {
      console.log('  ⚠ 场景失败: ' + bs.err);
      fail++;
    } else {
      console.log('  初始: ' + JSON.stringify(bs.initial));
      const bottom = await page.evaluate(() => window.__s32read(true));
      console.log('  滚到底后: ' + JSON.stringify(bottom));
      const ok = bottom.padBottomPx >= 150 && bottom.lastLineBottomGap >= 120;
      console.log('  ' + (ok ? '✓' : '✗') +
        ' 滚到底后底部行高出底缘 ≥120px（底部滚动余量 ' + Math.round(bottom.padBottomPx) + 'px，实际间距 ' +
        Math.round(bottom.lastLineBottomGap) + 'px）');
      if (!ok) fail++;
    }
    await page.evaluate(() => { const s = document.getElementById('s32-late-css'); if (s) s.remove(); });
  }

  // ---------- S33：格编辑后拖行/列不丢内容（2026-10-14 用户反馈） ----------
  {
    console.log('\n=== S33：格编辑后立即拖行/列，内容不得丢失 ===');
    const cd = await page.evaluate(() => window.__runCellEditDrag2026());
    if (cd.err) {
      console.log('  ⚠ 场景失败: ' + cd.err);
      fail++;
    } else {
      // ① 进格 (1,1) 输入，不点别处，立即拖该行（原位释放）
      const c = await page.evaluate(() => window.__s33cellRect(1, 1));
      if (!c) {
        console.log('  ⚠ 目标格 rect 未取到');
        fail++;
      } else {
        await page.mouse.click(c.x, c.y);
        await new Promise(r => setTimeout(r, 150));
        await page.keyboard.type('改', { delay: 50 });
        await new Promise(r => setTimeout(r, 150));
        const typed = await page.evaluate(() => window.__s33read());
        const hp = await page.evaluate(() => window.__s33handlePoint(1));
        if (!hp) {
          console.log('  ⚠ 行把手点未取到');
          fail++;
        } else {
          await page.mouse.move(hp.x, hp.y);
          await page.mouse.down();
          await page.mouse.move(hp.x, hp.y + 18, { steps: 4 });
          await new Promise(r => setTimeout(r, 80));
          await page.mouse.up();
          await new Promise(r => setTimeout(r, 250));
          const afterDrag = await page.evaluate(() => window.__s33read());
          console.log('  输入后: ' + JSON.stringify({ cellEditing: typed.cellEditing, editingText: typed.editingText }));
          console.log('  拖行（原位）后: ' + JSON.stringify(afterDrag));
          const checks33a = [
            ['进格编辑并输入', typed.cellEditing === true && (typed.editingText || '').indexOf('改') >= 0],
            ['立即拖行后内容不丢（源码含输入内容）', afterDrag.src.indexOf('改') >= 0],
            ['拖行后格编辑已结束', afterDrag.cellEditing === false],
          ];
          for (const [label, ok] of checks33a) {
            console.log(`  ${ok ? '✓' : '✗'} ${label}`);
            if (!ok) fail++;
          }
          // ③ 实际换位 + 内容保留：进另一格输入，把行拖到不同位置
          await page.evaluate(() => window.__runCellEditDrag2026());
          const c2 = await page.evaluate(() => window.__s33cellRect(1, 0));
          if (!c2) {
            console.log('  ⚠ 换位场景几何未取到');
            fail++;
          } else {
            await page.mouse.click(c2.x, c2.y);
            await new Promise(r => setTimeout(r, 150));
            await page.keyboard.type('甲', { delay: 50 });
            await new Promise(r => setTimeout(r, 150));
            // ⚠️ 进格编辑后重读几何：格编辑把旧活动块（表前段落）重遮罩，整表下移，
            // 点格前读的 rect 已陈旧（按下会落错行）——真实场景人手在把手上随表移动
            const r2 = await page.evaluate(() => window.__s33rowRect(2));
            const hp2 = await page.evaluate(() => window.__s33handlePoint(1));
            if (!r2 || !hp2) {
              console.log('  ⚠ 换位场景拖拽几何未取到');
              fail++;
            } else {
            await page.mouse.move(hp2.x, hp2.y);
            await page.mouse.down();
            await page.mouse.move(hp2.x, r2.y + r2.h * 0.75, { steps: 6 }); // 越过第 2 行中线 → 换位
            await new Promise(r => setTimeout(r, 80));
            await page.mouse.up();
            await new Promise(r => setTimeout(r, 250));
            const afterMove = await page.evaluate(() => window.__s33read());
            const lines = afterMove.src.split('\n');
            const iJia = lines.findIndex((l) => l.indexOf('甲') >= 0);
            const iSan = lines.findIndex((l) => l.indexOf('行三A') >= 0);
            console.log('  换位后: ' + JSON.stringify({ iJia, iSan, src: afterMove.src }));
            const checks33b = [
              ['实际换位成功（输入行移到行三之后）', iJia > iSan && iJia >= 0],
              ['换位后内容保留（甲在源码中）', iJia >= 0],
            ];
            for (const [label, ok] of checks33b) {
              console.log(`  ${ok ? '✓' : '✗'} ${label}`);
              if (!ok) fail++;
            }
            }
          }
        }
      }
    }
  }

  // ---------- S34：引用 + 行内语法渲染化（2026-10-14 用户要求，Typora 式） ----------
  {
    console.log('\n=== S34：引用前缀 + 行内语法（粗体/斜体/代码/删除线/高亮/链接）渲染化 ===');
    const id34 = await page.evaluate(() => window.__runInlineDecor2026());
    if (id34.err) {
      console.log('  ⚠ 场景失败: ' + id34.err);
      fail++;
    } else {
      const has = (arr, cls) => !!arr && arr.some((c) => c.indexOf(cls) >= 0);
      const checks34 = [];
      // ① 挂载后首段即活动块：行内语法 span 应全部就位
      const l0 = await page.evaluate(() => window.__s34classes(0));
      console.log('  行0（活动段落）: ' + JSON.stringify(l0));
      checks34.push(['段落：粗体/斜体/行内代码/删除线/高亮 span 齐备',
        has(l0, 'wysiwyg-bold') && has(l0, 'wysiwyg-italic') && has(l0, 'wysiwyg-inline-code') &&
        has(l0, 'wysiwyg-strike') && has(l0, 'wysiwyg-highlight') && has(l0, 'wysiwyg-inline-marker')]);
      // ⑥ 编辑语义（趁块0未遮罩先做：CM5 光标不能落在被遮罩块内部，会被钳到块末——
      //    真实用户只能点遮罩进块（光标落行末），setCursor 进遮罩内部不可达）：
      //    删掉一个 * → 粗体样式消失（change 钩子重算）
      await page.evaluate(() => window.__s34cursor(0, 11));
      await new Promise(r => setTimeout(r, 80));
      await page.keyboard.press('Backspace');
      await new Promise(r => setTimeout(r, 150));
      const l0b = await page.evaluate(() => window.__s34classes(0));
      console.log('  删一个 * 后行0: ' + JSON.stringify(l0b));
      checks34.push(['删掉一个 * 后粗体样式消失（编辑语义）', !has(l0b, 'wysiwyg-bold')]);
      // ② 切到链接行：链接文字渲染化 + 标记隐藏
      await page.evaluate(() => window.__s34cursor(1, 0));
      await new Promise(r => setTimeout(r, 150));
      const l1 = await page.evaluate(() => window.__s34classes(1));
      console.log('  行1（活动链接行）: ' + JSON.stringify(l1));
      checks34.push(['链接：文字 span + 标记 span（[ ] (url) 隐藏）',
        has(l1, 'wysiwyg-inline-link') && has(l1, 'wysiwyg-inline-marker')]);
      // ③ 切到引用第一行：前缀灰显 + 正文渲染字体 + 行内粗体（嵌套 span）
      await page.evaluate(() => window.__s34cursor(3, 0));
      await new Promise(r => setTimeout(r, 150));
      const l3 = await page.evaluate(() => window.__s34classes(3));
      console.log('  行3（活动引用行）: ' + JSON.stringify(l3));
      checks34.push(['引用：> 槽 span（含空格，24px）+ 正文 span + 行内粗体（引用内嵌套）',
        has(l3, 'wysiwyg-quote-slot') && has(l3, 'wysiwyg-quote-text') && has(l3, 'wysiwyg-bold')]);
      // ④ 切到嵌套引用行：两层 > 各一个 24px 槽（竖条画在槽 ::before 上）
      await page.evaluate(() => window.__s34cursor(4, 0));
      await new Promise(r => setTimeout(r, 150));
      const l4 = await page.evaluate(() => window.__s34classes(4));
      console.log('  行4（活动嵌套引用行）: ' + JSON.stringify(l4));
      checks34.push(['嵌套引用：两层 "> " 各带 24px 槽（wysiwyg-quote-slot ×2）',
        Array.isArray(l4) && l4.filter((c) => c.indexOf('wysiwyg-quote-slot') >= 0).length >= 2]);
      // ⑤ 切到代码块内部行：围栏排除行内解析（** 不得变粗体）
      await page.evaluate(() => window.__s34cursor(7, 0));
      await new Promise(r => setTimeout(r, 150));
      const l6 = await page.evaluate(() => window.__s34classes(6));
      const l7 = await page.evaluate(() => window.__s34classes(7));
      console.log('  行6/7（活动代码块）: ' + JSON.stringify({ l6, l7 }));
      checks34.push(['代码块：围栏行灰显 且 行内 ** 不误判为粗体',
        has(l6, 'wysiwyg-code-fence') && !has(l7, 'wysiwyg-bold')]);
      for (const [label, ok] of checks34) {
        console.log(`  ${ok ? '✓' : '✗'} ${label}`);
        if (!ok) fail++;
      }
    }
  }

  // ---------- S35：光标行单行灰底 + 编辑态排版=渲染态（2026-10-14 用户截图反馈） ----------
  // 文档：标题(0) / 空(1) / 松散列表(2-5，行4=项间空行) / 围栏(6-8) / 段落(9)
  {
    console.log('\n=== S35：光标行单行灰底 + 编辑态排版对齐渲染态（含 token 色中和/空行塌缩） ===');
    const p35 = await page.evaluate(() => window.__runPlainTextDecor2026());
    if (p35.err) {
      console.log('  ⚠ 场景失败: ' + p35.err);
      fail++;
    } else {
      const checks35 = [];
      const sleep35 = (ms) => new Promise(r => setTimeout(r, ms));
      const PRIMARY = 'rgb(34, 38, 46)'; // --text-primary 默认值 #22262e
      const SECONDARY = 'rgb(102, 109, 121)'; // --text-secondary 默认值 #666d79
      const TRANSPARENT = 'rgba(0, 0, 0, 0)';
      // ① 初始活动标题行：gfm cm-header token（默认主题蓝色）不得出现——token span 颜色
      //    只能是正文色（中和继承）/次级色（# 前缀渲染色，同身 span 重申）/透明（标记）
      console.log('  标题行 token 色: ' + JSON.stringify(p35.initial.headingTokens));
      checks35.push(['标题行：cm-header token span 存在且无主题蓝（=正文色/次级色/透明）',
        Array.isArray(p35.initial.headingTokens) && p35.initial.headingTokens.length > 0 &&
        p35.initial.headingTokens.every((c) => c === PRIMARY || c === SECONDARY || c === TRANSPARENT)]);
      checks35.push(['标题行：挂 plain-text 行类', p35.initial.headingPlain === true]);
      // ② 点列表遮罩（行3）进块：只有光标行灰底（块内其余行无底）
      const mp = await page.evaluate(() => window.__s35maskPoint(3));
      if (!mp) {
        console.log('  ⚠ 列表遮罩定位失败');
        fail++;
      } else {
        await page.mouse.click(mp.x, mp.y);
        await sleep35(250);
        const b = await page.evaluate(() => ({
          activeIdx: window.__s35ed._wysiwygActiveIdx,
          cursorLine: window.__s35ed.cm.getCursor().line,
          bg2: window.__s35bg(2), bg3: window.__s35bg(3), bg5: window.__s35bg(5),
        }));
        console.log('  点列表后: ' + JSON.stringify(b));
        // 点列表行走 data-source-line 精确落行（2026-10-16）：点击点=遮罩中心 → 落中间项（行3）
        const expectBg = { 2: b.bg2, 3: b.bg3, 5: b.bg5 };
        const others = [2, 3, 5].filter((n) => n !== b.cursorLine);
        checks35.push(['列表块：只有光标行灰底（块内其余行无底）',
          b.activeIdx === 1 && b.cursorLine >= 2 && b.cursorLine <= 5 &&
          (expectBg[b.cursorLine] || b.cursorLine === 4) &&
          others.every((n) => expectBg[n] === false)]);
        // ③ 松散列表项间空行（行4）保持塌缩 12px、不挂 plain-text；项行保持正常行高
        const h4 = await page.evaluate(() => window.__s35lineH(4));
        const h3 = await page.evaluate(() => window.__s35lineH(3));
        const p4 = await page.evaluate(() => window.__s35plain(4));
        console.log(`  空行4高度=${h4}px 项行3高度=${h3}px 空行plain=${p4}`);
        checks35.push(['松散列表项间空行：保持塌缩（≤15px）且不挂 plain-text',
          h4 != null && h4 <= 15 && p4 === false]);
        checks35.push(['列表项行：正常行高（≈27px，未被塌缩误伤）', h3 != null && h3 >= 25 && h3 <= 32]);
        // ④ 活动列表行排版 = 渲染态（预览字族 + 16px + 行高1.7 + 正文色）+ 行内粗体嵌套
        //    + gfm cm-variable-2 token（默认主题海军蓝）必须中和为正文色
        const t = await page.evaluate(() => {
          const ln = window.__s35lineEl(2);
          if (!ln) return null;
          const cs = getComputedStyle(ln);
          const bold = Array.from(ln.querySelectorAll('span'))
            .some((s) => (s.className || '').indexOf('wysiwyg-bold') >= 0);
          return {
            plain: (ln.className || '').indexOf('wysiwyg-plain-text') >= 0,
            ff: cs.fontFamily, fs: cs.fontSize, lh: cs.lineHeight, color: cs.color, bold,
            tokens: Array.from(ln.querySelectorAll('span[class*="cm-"]'))
              .map((s) => getComputedStyle(s).color),
          };
        });
        console.log('  行2 排版: ' + JSON.stringify(t));
        checks35.push(['活动列表行：plain-text 行类 + 预览字族', t && t.plain === true && t.ff.indexOf('Segoe UI') >= 0]);
        checks35.push(['活动列表行：字号 16px + 行高 27.2px（=16×1.7，与渲染态一致）',
          t && t.fs === '16px' && t.lh === '27.2px']);
        checks35.push(['活动列表行：正文色 --text-primary（#22262e）',
          t && t.color === PRIMARY]);
        checks35.push(['活动列表行：行内 **加粗** 渲染化（与批次 A 一致）', t && t.bold === true]);
        checks35.push(['活动列表行：gfm 列表 token span（cm-variable-2 等）无海军蓝（=正文色/透明）',
          t && Array.isArray(t.tokens) && t.tokens.length > 0
          && t.tokens.every((c) => c === PRIMARY || c === TRANSPARENT)]);
        // ⑤ 光标块内移动（行5）：灰底跟随
        await page.evaluate(() => window.__s35cursor(5, 2));
        await sleep35(150);
        const b2 = await page.evaluate(() => ({ bg5: window.__s35bg(5), bg2: window.__s35bg(2), bg3: window.__s35bg(3) }));
        console.log('  光标移到行5: ' + JSON.stringify(b2));
        checks35.push(['灰底随光标在块内移动（行5 有底、行2/3 无底）',
          b2.bg5 === true && b2.bg2 === false && b2.bg3 === false]);
        // ⑥ 点围栏遮罩（行7）：代码块整块灰盒（容器观感）+ 源文行不挂 plain-text
        const fp = await page.evaluate(() => window.__s35maskPoint(7));
        if (!fp) {
          console.log('  ⚠ 围栏遮罩定位失败');
          fail++;
        } else {
          await page.mouse.click(fp.x, fp.y);
          await sleep35(250);
          const f = await page.evaluate(() => ({
            activeIdx: window.__s35ed._wysiwygActiveIdx,
            bg6: window.__s35bg(6), bg7: window.__s35bg(7), bg8: window.__s35bg(8),
            p6: window.__s35plain(6), p7: window.__s35plain(7), p8: window.__s35plain(8),
          }));
          console.log('  点围栏后: ' + JSON.stringify(f));
          checks35.push(['代码块：灰盒=整块（行7 有底；开/闭围栏行 6/8 同挂灰底在盒内，2026-10-18 新口径）',
            f.activeIdx === 2 && f.bg6 === true && f.bg7 === true && f.bg8 === true]);
          checks35.push(['代码块：源文行不挂 plain-text（保持等宽源文 + 语法色）',
            f.p6 === false && f.p7 === false && f.p8 === false]);
          // ⑦ 进尾段落块：单行灰底 + plain-text（围栏块撤底）
          await page.evaluate(() => window.__s35cursor(9, 1));
          await sleep35(250);
          const g = await page.evaluate(() => ({
            activeIdx: window.__s35ed._wysiwygActiveIdx,
            bg9: window.__s35bg(9), bg7: window.__s35bg(7),
            p9: window.__s35plain(9),
          }));
          console.log('  进尾段落后: ' + JSON.stringify(g));
          checks35.push(['段落块：光标行灰底 + plain-text（原代码块撤底）',
            g.activeIdx === 3 && g.bg9 === true && g.bg7 === false && g.p9 === true]);
        }
      }
      for (const [label, ok] of checks35) {
        console.log(`  ${ok ? '✓' : '✗'} ${label}`);
        if (!ok) fail++;
      }
    }
  }

  // ---------- S36：列表回车新行光标位置（2026-10-14 用户反馈：光标落到新行的下一行） ----------
  {
    console.log('\n=== S36：列表回车新行光标位置 ===');
    const p36 = await page.evaluate(() => window.__runListEnterCursor());
    if (p36.err) {
      console.log('  ⚠ 场景失败: ' + p36.err);
      fail++;
    } else {
      const sleep36 = (ms) => new Promise(r => setTimeout(r, ms));
      const checks36 = [];
      // 点列表遮罩进块（真实点击），光标置到第二项（行4）末尾，模拟「编辑到行尾按回车」
      await page.mouse.click(p36.maskPoint.x, p36.maskPoint.y);
      await sleep36(250);
      const len4 = await page.evaluate(() => window.__s36lineLen(4));
      await page.evaluate(({ n, ch }) => window.__s36cursor(n, ch), { n: 4, ch: len4 });
      const st0 = await page.evaluate(() => window.__s36state());
      console.log('  回车前: ' + JSON.stringify(st0));
      // 真实 Enter（trusted 键盘事件，走 continuelist 续行）
      await page.keyboard.press('Enter');
      await sleep36(80);
      const st1 = await page.evaluate(() => window.__s36state());
      console.log('  回车后 80ms: ' + JSON.stringify(st1));
      await sleep36(400);
      const st2 = await page.evaluate(() => window.__s36state());
      console.log('  回车后 480ms（含 250ms 防抖刷新）: ' + JSON.stringify(st2));
      // 断言：新行 = 行5（'- ' 续行），光标 80ms/480ms 都停在行5（新行本身，不是其下一行）
      checks36.push(['回车后 80ms：光标在新行（行5）且新行是续行标记 "- "',
        st1.cursor.line === 5 && st1.lines[1] === '- ']);
      checks36.push(['回车后 480ms（防抖刷新后）：光标仍在新行（行5），未被挪到下一行',
        st2.cursor.line === 5 && st2.lines[1] === '- ']);
      for (const [label, ok] of checks36) {
        console.log(`  ${ok ? '✓' : '✗'} ${label}`);
        if (!ok) fail++;
      }
    }
  }

  // ---------- S37：幽灵 Enter 吞除窗（2026-10-14 用户反馈：列表回车后光标落新行的下一行） ----------
  {
    console.log('\n=== S37：幽灵 Enter 吞除窗（WebView2 中文 IME 残影键） ===');
    const p37 = await page.evaluate(() => window.__runListEnterGhost());
    if (p37.err) {
      console.log('  ⚠ 场景失败: ' + p37.err);
      fail++;
    } else {
      const sleep37 = (ms) => new Promise(r => setTimeout(r, ms));
      const checks37 = [];
      // 点列表遮罩进块，光标置到第二项（行3）末尾
      await page.mouse.click(p37.maskPoint.x, p37.maskPoint.y);
      await sleep37(250);
      await page.evaluate(({ n, ch }) => window.__s37cursor(n, ch), { n: 3, ch: p37.line3Len });
      const s0 = await page.evaluate(() => window.__s37state());
      console.log('  幽灵键前: ' + JSON.stringify({ cursor: s0.cursor, lineCount: s0.lineCount }));
      // ① 幽灵 Enter：compositionend 后立刻（窗口内）按 Enter → 必须被吞（不产生新行）
      const g = await page.evaluate(() => window.__s37ghost());
      await page.keyboard.press('Enter'); // 距 compositionend 仅一次往返（<250ms 窗口内）
      await sleep37(80);
      const s1 = await page.evaluate(() => window.__s37state());
      console.log('  幽灵 Enter 后 80ms: ' + JSON.stringify({ cursor: s1.cursor, lineCount: s1.lineCount, tsSet: g.tsSet }));
      checks37.push(['组合刚结束的幽灵 Enter 被吞：行数不变、光标不动',
        g.tsSet === true && s1.lineCount === s0.lineCount
        && s1.cursor.line === s0.cursor.line && s1.cursor.ch === s0.cursor.ch]);
      // ② 真实 Enter：窗口外（+350ms）按 Enter → 正常续行，光标停在新行（不是新行下面一行）
      await sleep37(350);
      await page.keyboard.press('Enter');
      await sleep37(80);
      const s2 = await page.evaluate(() => window.__s37state());
      console.log('  真实 Enter 后 80ms: ' + JSON.stringify({ cursor: s2.cursor, lineCount: s2.lineCount, newLine: s2.lines[4] }));
      checks37.push(['窗口外真实 Enter：续行 "- " 生成，光标在新行（行4）而非其下一行',
        s2.lineCount === s0.lineCount + 1 && s2.lines[4] === '- '
        && s2.cursor.line === 4 && s2.cursor.ch === 2]);
      for (const [label, ok] of checks37) {
        console.log(`  ${ok ? '✓' : '✗'} ${label}`);
        if (!ok) fail++;
      }
    }
  }

  // ---------- S38：全格式点击/换行矩阵（2026-10-14 用户要求：模拟点击全格式回归） ----------
  {
    console.log('\n=== S38：全格式点击/换行矩阵 ===');
    const p38 = await page.evaluate(() => window.__runAllFormats());
    if (p38.err) {
      console.log('  ⚠ 场景失败: ' + p38.err);
      fail++;
    } else {
      const sleep38 = (ms) => new Promise(r => setTimeout(r, ms));
      const c38 = [];
      const chk38 = (label, ok, extra) => {
        console.log(`  ${ok ? '✓' : '✗'} ${label}` + (extra ? '  ' + extra : ''));
        if (!ok) fail++;
      };
      const allToksOk = (info) => Array.isArray(info.toks) && info.toks.length > 0 && info.toks.every(t => t.ok);
      const spanOf = (info, cls) => (info.spans || []).find(s => s.cls.indexOf(cls) !== -1);
      // 初始：光标在行0（标题）→ 标题块活动，其余 10 块全部渲染遮罩
      //（紧凑列表逐项切块后块表 = 11 块：ul 2 项 + ol 2 项 + task 2 项各拆单项）
      const masked0 = await page.evaluate(() => window.__s38maskedBlocks());
      const h0 = await page.evaluate(() => window.__s38spanInfo(0));
      chk38('初始：10 个块渲染遮罩（标题块活动）', masked0.length === 10, JSON.stringify(masked0));
      const hts1 = spanOf(h0, 'wysiwyg-heading-text-1');
      chk38('标题行：正文 span 渲染尺寸 32px + 粗体 700（对齐渲染态 h1）',
        !!hts1 && hts1.fs === '32px' && hts1.fw === '700', JSON.stringify(hts1));
      chk38('标题行：token 色继承（gfm cm-header 蓝被中和）', allToksOk(h0),
        'toks=' + JSON.stringify((h0.toks || []).map(t => t.color)));
      chk38('标题行：挂 plain-text 行类', h0.plain === true);
      // ① 点段落遮罩：标题恢复渲染 + 段落进渲染样式编辑（内联全家族）
      const ptPara = await page.evaluate(() => window.__s38maskPoint(2));
      chk38('段落块有渲染遮罩（可点）', !!ptPara);
      if (ptPara) {
        await page.mouse.click(ptPara.x, ptPara.y);
        await sleep38(250);
        const m1 = await page.evaluate(() => ({ m0: window.__s38masked(0), m2: window.__s38masked(2) }));
        chk38('点段落后：标题块恢复渲染遮罩、段落源文态', m1.m0 === true && m1.m2 === false, JSON.stringify(m1));
        const pi = await page.evaluate(() => window.__s38spanInfo(2));
        const b = spanOf(pi, 'wysiwyg-bold'), it = spanOf(pi, 'wysiwyg-italic'),
          hl = spanOf(pi, 'wysiwyg-highlight'), st = spanOf(pi, 'wysiwyg-strike');
        chk38('段落：加粗 span 字重 700', !!b && b.fw === '700', JSON.stringify(b));
        chk38('段落：斜体 span 斜体', !!it && it.fst === 'italic', JSON.stringify(it));
        chk38('段落：高亮 span 非透明底', !!hl && hl.bg !== 'rgba(0, 0, 0, 0)', JSON.stringify(hl));
        chk38('段落：删除线 span line-through', !!st && (st.deco || '').indexOf('line-through') !== -1, JSON.stringify(st));
        chk38('段落：token 色继承（cm-variable-2 等被中和）', allToksOk(pi),
          'toks=' + JSON.stringify((pi.toks || []).map(t => t.color)));
        chk38('段落：plain-text 行类', pi.plain === true);
        // ② 点标题二遮罩（光标去其他行）：段落恢复渲染
        const ptH2 = await page.evaluate(() => window.__s38maskPoint(4));
        chk38('标题二块有渲染遮罩（可点）', !!ptH2);
        if (ptH2) {
          await page.mouse.click(ptH2.x, ptH2.y);
          await sleep38(250);
          const m2 = await page.evaluate(() => ({ m2: window.__s38masked(2), m4: window.__s38masked(4) }));
          chk38('点标题二后：段落恢复渲染遮罩、标题二源文态', m2.m2 === true && m2.m4 === false, JSON.stringify(m2));
          const h2i = await page.evaluate(() => window.__s38spanInfo(4));
          const hts2 = spanOf(h2i, 'wysiwyg-heading-text-2');
          chk38('标题二：正文 span 24px + 粗体', !!hts2 && hts2.fs === '24px' && hts2.fw === '700', JSON.stringify(hts2));
          // ③ 再次点段落遮罩：重新在渲染样式下编辑
          const ptPara2 = await page.evaluate(() => window.__s38maskPoint(2));
          chk38('段落块再次有渲染遮罩（可再次点击）', !!ptPara2);
          if (ptPara2) {
            await page.mouse.click(ptPara2.x, ptPara2.y);
            await sleep38(250);
            const pi2 = await page.evaluate(() => window.__s38spanInfo(2));
            chk38('再次点段落：内联装饰重新挂全（可再编辑）',
              !!spanOf(pi2, 'wysiwyg-bold') && !!spanOf(pi2, 'wysiwyg-highlight') && allToksOk(pi2));
          }
          // ④ 段落行尾 Enter：新空行、光标在新行（段落不续前缀）
          const paraLine = await page.evaluate(() => window.__s38find('加粗文字'));
          await page.evaluate(({ n, ch }) => window.__s38cursor(n, ch), { n: paraLine, ch: await page.evaluate((n) => window.__s38lineLen(n), paraLine) });
          await page.keyboard.press('Enter');
          await sleep38(120);
          const se1 = await page.evaluate(() => window.__s38state());
          chk38('段落 Enter：新空行生成、光标停在新行（合理换行）',
            se1.lines[paraLine + 1] === '' && se1.cursor.line === paraLine + 1 && se1.cursor.ch === 0,
            JSON.stringify({ cursor: se1.cursor, next: se1.lines[paraLine + 1] }));
        }
      }
      // ⑤ 无序列表：装饰 + Enter 续行
      const ul2 = await page.evaluate(() => window.__s38find('无序项二'));
      const ptUl = await page.evaluate((n) => window.__s38maskPoint(n), ul2);
      chk38('无序列表块有渲染遮罩（可点）', !!ptUl);
      if (ptUl) {
        await page.mouse.click(ptUl.x, ptUl.y);
        await sleep38(250);
        // 逐项切块契约（2026-10-21）：点某项只解罩该项，兄弟项保持渲染遮罩
        const mUl = await page.evaluate((n) => ({ a: window.__s38masked(n - 1), b: window.__s38masked(n) }), ul2);
        chk38('点列表项后：仅点击项源文态、兄弟项保持遮罩', mUl.a === true && mUl.b === false, JSON.stringify(mUl));
        const iA = await page.evaluate((n) => window.__s38spanInfo(n), ul2 - 1);
        const iB = await page.evaluate((n) => window.__s38spanInfo(n), ul2);
        chk38('列表项：圆点符号渲染化（wysiwyg-list-bullet）', !!spanOf(iB, 'wysiwyg-list-bullet'));
        chk38('列表项：正文预览字族 span + plain-text', !!spanOf(iB, 'wysiwyg-list-text') && iB.plain === true);
        chk38('列表项：行内 == 高亮渲染化', !!spanOf(iB, 'wysiwyg-highlight'));
        chk38('列表项：token 色继承', allToksOk(iB));
        chk38('兄弟项保持遮罩（无 wysiwyg 装饰 span）', (iA.spans || []).length === 0);
        await page.evaluate(({ n, ch }) => window.__s38cursor(n, ch), { n: ul2, ch: await page.evaluate((n) => window.__s38lineLen(n), ul2) });
        await page.keyboard.press('Enter');
        await sleep38(120);
        const se2 = await page.evaluate(() => window.__s38state());
        chk38('列表 Enter：续行 "- "、光标停在新行',
          se2.lines[ul2 + 1] === '- ' && se2.cursor.line === ul2 + 1 && se2.cursor.ch === 2,
          JSON.stringify({ cursor: se2.cursor, next: se2.lines[ul2 + 1] }));
      }
      // ⑥ 有序列表
      const ol2 = await page.evaluate(() => window.__s38find('有序项二'));
      const ptOl = await page.evaluate((n) => window.__s38maskPoint(n), ol2);
      chk38('有序列表块有渲染遮罩（可点）', !!ptOl);
      if (ptOl) {
        await page.mouse.click(ptOl.x, ptOl.y);
        await sleep38(250);
        const iO = await page.evaluate((n) => window.__s38spanInfo(n), ol2);
        chk38('有序项：序号 span（wysiwyg-ol-marker）+ 斜体渲染化', !!spanOf(iO, 'wysiwyg-ol-marker') && !!spanOf(iO, 'wysiwyg-italic'));
        chk38('有序项：token 色继承 + plain-text', allToksOk(iO) && iO.plain === true);
        await page.evaluate(({ n, ch }) => window.__s38cursor(n, ch), { n: ol2, ch: await page.evaluate((n) => window.__s38lineLen(n), ol2) });
        await page.keyboard.press('Enter');
        await sleep38(120);
        const se3 = await page.evaluate(() => window.__s38state());
        chk38('有序列表 Enter：续行 "3. "、光标停在新行',
          se3.lines[ol2 + 1] === '3. ' && se3.cursor.line === ol2 + 1 && se3.cursor.ch === 3,
          JSON.stringify({ cursor: se3.cursor, next: se3.lines[ol2 + 1] }));
      }
      // ⑦ 引用块（2026-10-25 分段口径：点击进块 → 光标行源文、兄弟行渲染遮罩）
      const q2 = await page.evaluate(() => window.__s38find('引用第二行'));
      const ptQ = await page.evaluate((n) => window.__s38maskPoint(n), q2);
      chk38('引用块有渲染遮罩（可点）', !!ptQ);
      if (ptQ) {
        await page.mouse.click(ptQ.x, ptQ.y);
        await sleep38(250);
        const cur38 = await page.evaluate(() => window.__s38state());
        const cLine = cur38.cursor.line;
        const iQ = await page.evaluate((n) => window.__s38spanInfo(n), cLine);
        chk38('引用行：> 24px 槽（光标行源码）+ 正文 span（次级色）',
          !!spanOf(iQ, 'wysiwyg-quote-slot') && !!spanOf(iQ, 'wysiwyg-quote-text'),
          'cursor=' + cLine);
        const qt = spanOf(iQ, 'wysiwyg-quote-text');
        // 高亮 == 若在光标行则连带查询；否则由兄弟行渲染遮罩断言覆盖（该行 == 已渲染进遮罩）
        chk38('引用行：内联 == 高亮渲染化（光标行为含 == 行时）',
          (cLine === q2) ? !!spanOf(iQ, 'wysiwyg-highlight') : true,
          'cursor=' + cLine + ' q2=' + q2);
        // 兄弟行（非光标行）必须是渲染遮罩：无源码装饰 span、无 quote 行类
        const sib = cLine === q2 ? q2 - 1 : q2;
        const iSib = await page.evaluate((n) => window.__s38spanInfo(n), sib);
        chk38('引用块：兄弟行（非光标行）= 渲染遮罩（无 wysiwyg 源码装饰 span）',
          !!(iSib && (iSib.spans || []).length === 0),
          'sib=' + sib);
        // 引用正文必须 = 渲染态 blockquote 的次级色（CM5 会把 cm-quote 与 wysiwyg-quote-text
        // 合并成同一个 span，token 中和规则若命中它会把次级色洗成主色 → 与渲染态不一致）
        const secRgb = await page.evaluate(() => {
          const probe = document.createElement('span');
          probe.style.color = 'var(--text-secondary)';
          document.body.appendChild(probe);
          const c = getComputedStyle(probe).color;
          probe.remove();
          return c;
        });
        chk38('引用行：正文/前缀 = 次级色（光标行，与渲染态 blockquote 一致）',
          !!qt && qt.color === secRgb,
          'quote=' + (qt && qt.color) + ' secondary=' + secRgb);
        await page.evaluate(({ n, ch }) => window.__s38cursor(n, ch), { n: cLine, ch: await page.evaluate((n) => window.__s38lineLen(n), cLine) });
        await sleep38(50);
        await page.keyboard.press('Enter');
        await sleep38(250);
        const se4 = await page.evaluate(() => window.__s38state());
        chk38('引用 Enter：续行 "> "、光标停在新行',
          se4.lines[cLine + 1] === '> ' && se4.cursor.line === cLine + 1 && se4.cursor.ch === 2,
          JSON.stringify({ cursor: se4.cursor, next: se4.lines[cLine + 1], line0: se4.lines[cLine] }));
      }
      // ⑧ 任务列表
      const t2 = await page.evaluate(() => window.__s38find('已完成任务'));
      const ptT = await page.evaluate((n) => window.__s38maskPoint(n), t2);
      chk38('任务列表块有渲染遮罩（可点）', !!ptT);
      if (ptT) {
        await page.mouse.click(ptT.x, ptT.y);
        await sleep38(250);
        const iT = await page.evaluate((n) => window.__s38spanInfo(n), t2);
        const iT0 = await page.evaluate((n) => window.__s38spanInfo(n), t2 - 1);
        const box = spanOf(iT, 'wysiwyg-task-prefix'), box0 = spanOf(iT0, 'wysiwyg-task-prefix');
        // 逐项切块契约：点击项（[x] 勾选态）解罩渲染化；兄弟项（[ ]）保持遮罩、无 span
        chk38('任务行：复选框渲染化（[x] 勾选态；兄弟 [ ] 项保持遮罩）',
          !!box && box.cls.indexOf('checked') !== -1 && box0 == null,
          JSON.stringify({ box: box && box.cls, box0: box0 && box0.cls }));
        await page.evaluate(({ n, ch }) => window.__s38cursor(n, ch), { n: t2, ch: await page.evaluate((n) => window.__s38lineLen(n), t2) });
        await page.keyboard.press('Enter');
        await sleep38(120);
        const se5 = await page.evaluate(() => window.__s38state());
        chk38('任务列表 Enter：续行 "- [ ] "、光标停在新行',
          se5.lines[t2 + 1] === '- [ ] ' && se5.cursor.line === t2 + 1 && se5.cursor.ch === 6,
          JSON.stringify({ cursor: se5.cursor, next: se5.lines[t2 + 1] }));
      }
      // ⑨ 下划线段落
      const u2 = await page.evaluate(() => window.__s38find('下划线文字'));
      const ptU = await page.evaluate((n) => window.__s38maskPoint(n), u2);
      chk38('下划线段落块有渲染遮罩（可点）', !!ptU);
      if (ptU) {
        await page.mouse.click(ptU.x, ptU.y);
        await sleep38(250);
        const iU = await page.evaluate((n) => window.__s38spanInfo(n), u2);
        const uSpan = spanOf(iU, 'wysiwyg-underline');
        chk38('下划线：<u> 文本渲染化（text-decoration: underline，标签透明）',
          !!uSpan && (uSpan.deco || '').indexOf('underline') !== -1, JSON.stringify(uSpan));
        // gfm 不给 <u> HTML 挂 token 类 → 该行可能无 cm-* span（无 token 可中和，属正常）
        chk38('下划线：token 色继承（若有）+ plain-text',
          (iU.toks || []).every(t => t.ok) && iU.plain === true);
        await page.evaluate(({ n, ch }) => window.__s38cursor(n, ch), { n: u2, ch: await page.evaluate((n) => window.__s38lineLen(n), u2) });
        await page.keyboard.press('Enter');
        await sleep38(120);
        const se6 = await page.evaluate(() => window.__s38state());
        chk38('下划线段落 Enter：新空行、光标停在新行（不续 <u> 前缀）',
          se6.lines[u2 + 1] === '' && se6.cursor.line === u2 + 1 && se6.cursor.ch === 0,
          JSON.stringify({ cursor: se6.cursor, next: se6.lines[u2 + 1] }));
      }
      // ⑩ 标题 Enter 合理响应：新空行（标题不续 #）
      const hLine = await page.evaluate(() => window.__s38find('标题一格式测试'));
      const ptH = await page.evaluate((n) => window.__s38maskPoint(n), hLine);
      chk38('标题块有渲染遮罩（可点）', !!ptH);
      if (ptH) {
        await page.mouse.click(ptH.x, ptH.y);
        await sleep38(250);
        const ih = await page.evaluate((n) => window.__s38spanInfo(n), hLine);
        chk38('再次点标题：装饰重新挂全（可再编辑）', !!spanOf(ih, 'wysiwyg-heading-text-1') && allToksOk(ih));
        await page.evaluate(({ n, ch }) => window.__s38cursor(n, ch), { n: hLine, ch: await page.evaluate((n) => window.__s38lineLen(n), hLine) });
        await page.keyboard.press('Enter');
        await sleep38(120);
        const se7 = await page.evaluate(() => window.__s38state());
        chk38('标题 Enter：新空行、光标停在新行（标题不续 # 前缀）',
          se7.lines[hLine + 1] === '' && se7.cursor.line === hLine + 1 && se7.cursor.ch === 0
          && (se7.lines[hLine] || '').indexOf('# ') === 0,
          JSON.stringify({ cursor: se7.cursor, next: se7.lines[hLine + 1] }));
      }
    }
  }

  // ---------- S39：列表回车幽灵键双通道（2026-10-15 用户复现：列表回车后光标落新行的下一行） ----------
  // 机制：真实 Enter（extraKeys → 列表续行）之后，WebView2 IME 幽灵可能走两条通道到达：
  //   a) input 通道——beforeinput insertLineBreak（CM5 只在 input 事件读 DOM → 裸换行进模型，
  //      列表下多一条空行、光标落新行下一行 = 用户截图）→ 输入域 beforeinput 守卫取消；
  //   b) keydown 通道——重复投递的 Enter keydown（组合超 250ms 后窗①失效）→ 窗②（150ms +
  //      组合 10s 内）吞除。
  // 对照组证明不误吞：400ms 间隔的真人双 Enter（空项退出列表）、无 IME 上下文的快速双 Enter。
  console.log('\n=== S39：列表回车幽灵键双通道（input/keydown + 双 Enter 对照） ===');
  {
    // 注：测试文档列表与正文之间本有一条空行（复刻用户截图：列表下方还有内容），
    // 预期数组必须包含它——它随续行插入整体下移，不是幽灵产物
    const expectContinue = ['# 2025-120-131-12', '', '- 32333223', '- ', '', '下一行正文内容。'];
    const expectExit = ['# 2025-120-131-12', '', '- 32333223', '', '', '', '下一行正文内容。'];
    const same = (a, b) => Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);
    const runS39 = async (variant) => {
      const init = await page.evaluate(() => window.__runGhostEnter2026());
      if (init.err) { console.log('  ⚠ 场景失败: ' + init.err); fail++; return null; }
      const mp = await page.evaluate(() => window.__s39maskPoint());
      if (!mp) { console.log('  ⚠ 列表遮罩定位失败'); fail++; return null; }
      await page.mouse.click(mp.x, mp.y);
      await new Promise(r => setTimeout(r, 250));
      const afterClick = await page.evaluate(() => window.__s39state());
      s39Push(`[${variant}] 点遮罩进块：光标在列表行行末`, afterClick.cursor.line === 2 && afterClick.cursor.ch === 10,
        JSON.stringify(afterClick.cursor));
      if (variant === 'input' || variant === 'keydown' || variant === 'slow') {
        // 模拟 IME 选字提交（真实 DOM compositionend → _lastCompositionEnd）
        await page.evaluate(() => window.__s39compositionEnd());
        await new Promise(r => setTimeout(r, 600)); // 组合窗 250ms 外（用户选字后又输入了一段）
      }
      await page.keyboard.press('Enter'); // 真实 Enter → 列表续行
      await new Promise(r => setTimeout(r, variant === 'slow' ? 400 : (variant === 'clean' ? 80 : 30)));
      let prevented = null;
      if (variant === 'input') {
        const g = await page.evaluate(() => window.__s39dispatchGhostInput('insertLineBreak'));
        prevented = g.prevented;
      } else {
        await page.keyboard.press('Enter'); // 幽灵 keydown（a/b 外变体=真人第二下）
      }
      await new Promise(r => setTimeout(r, 300));
      const st = await page.evaluate(() => window.__s39state());
      st.prevented = prevented;
      return st;
    };
    const s39Push = (label, ok, extra) => {
      const pass = !!ok;
      if (!pass) fail++;
      console.log(`  ${pass ? '✓' : '✗'} ${label}` + (extra !== undefined ? '  ' + extra : ''));
    };
    // a) input 通道幽灵（用户复现形态）
    const stA = await runS39('input');
    if (stA) {
      console.log('  input 通道后: ' + JSON.stringify(stA));
      s39Push('[input] 幽灵 beforeinput 被守卫取消（defaultPrevented）', stA.prevented === true);
      s39Push('[input] 文档 = 续行 "- " 恰好一条、无多余空行', same(stA.lines, expectContinue), JSON.stringify(stA.lines));
      s39Push('[input] 光标停在续行（"- " ch2），不是下一行', stA.cursor.line === 3 && stA.cursor.ch === 2, JSON.stringify(stA.cursor));
    }
    // b) keydown 通道幽灵（窗②）
    const stB = await runS39('keydown');
    if (stB) {
      console.log('  keydown 通道后: ' + JSON.stringify(stB));
      s39Push('[keydown] 重复投递 Enter（+30ms，组合 10s 内）被窗②吞除', same(stB.lines, expectContinue), JSON.stringify(stB.lines));
      s39Push('[keydown] 光标停在续行', stB.cursor.line === 3 && stB.cursor.ch === 2, JSON.stringify(stB.cursor));
    }
    // c) 对照：400ms 间隔真人双 Enter（第一下续行、第二下空项退出列表 = 标准行为）
    const stC = await runS39('slow');
    if (stC) {
      console.log('  慢双 Enter 后: ' + JSON.stringify(stC));
      s39Push('[slow] 400ms 间隔真人第二 Enter 不被误吞（空项退出：前缀删 + 新行）', same(stC.lines, expectExit), JSON.stringify(stC.lines));
      s39Push('[slow] 光标在退出后的空行（ch0）', stC.cursor.line === 4 && stC.cursor.ch === 0, JSON.stringify(stC.cursor));
    }
    // d) 对照：无 IME 上下文的快速双 Enter（窗②需组合 10s 内 → 不吞）
    const stD = await runS39('clean');
    if (stD) {
      console.log('  无 IME 快双 Enter 后: ' + JSON.stringify(stD));
      s39Push('[clean] 无 IME 上下文快速双 Enter（+80ms）不被误吞', same(stD.lines, expectExit), JSON.stringify(stD.lines));
    }
  }

  // ---------- S40：块内回车续行保持活动块（2026-10-15 用户反馈：提示块按一次回车就退出编辑渲染） ----------
  // 期望：第一次回车 = 续行留在编辑态（光标在新行、块不重遮、可继续输入）；
  // 第二次回车（空行）= 退出块、块恢复渲染（光标到块外）。
  // 段落对照：回车后新空行属新段落（不在旧块内）→ 旧段恢复渲染是正确行为。
  console.log('\n=== S40：块内回车续行保持活动块（alert/list/quote/para） ===');
  {
    const s40Push = (label, ok, extra) => {
      const pass = !!ok;
      if (!pass) fail++;
      console.log(`  ${pass ? '✓' : '✗'} ${label}` + (extra !== undefined ? '  ' + extra : ''));
    };
    const sameL = (a, b) => Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);
    const runS40 = async (kind) => {
      const init = await page.evaluate((k) => window.__runQuoteEnter2026(k), kind);
      if (init.err) { console.log(`  ⚠ [${kind}] 场景失败: ` + init.err); fail++; return null; }
      const st0 = await page.evaluate(() => window.__s40state());
      await page.keyboard.press('Enter');
      await new Promise(r => setTimeout(r, 100));
      const st1 = await page.evaluate(() => window.__s40state());
      await new Promise(r => setTimeout(r, 500));
      const st2 = await page.evaluate(() => window.__s40state());
      let typed = null;
      let cont2 = null;
      if (kind === 'alert') {
        // 决定性验证：续行上能继续输入（用户「没法正常换行」的直接反证）
        await page.keyboard.type('继续内容');
        await new Promise(r => setTimeout(r, 100));
        typed = await page.evaluate(() => window.__s40state());
        // 非空续行再回车 → 又一条续行（仍保持活动）；之后空行回车才退出
        await page.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 100));
        cont2 = await page.evaluate(() => window.__s40state());
      }
      await page.keyboard.press('Enter'); // 空行回车 → 退出块
      await new Promise(r => setTimeout(r, 600));
      const st3 = await page.evaluate(() => window.__s40state());
      return { st0, st1, st2, typed, cont2, st3 };
    };

    // a) 用户场景：> [!CAUTION] 提示块
    const A = await runS40('alert');
    if (A) {
      console.log('  alert Enter#1 后: ' + JSON.stringify(A.st1));
      s40Push('[alert] 就绪：活动块 0、光标行末', A.st0.activeIdx === 0 && A.st0.marks.length === 0, JSON.stringify(A.st0));
      s40Push('[alert] Enter#1：续行 "> " 生成、光标停新行', sameL(A.st1.lines, ['> [!CAUTION]', '> 注意内容', '> ']) && A.st1.cursor.line === 2 && A.st1.cursor.ch === 2);
      s40Push('[alert] Enter#1：块保持活动（源码态，不重遮）', A.st1.activeIdx === 0 && A.st1.marks.length === 0, 'activeIdx=' + A.st1.activeIdx + ' marks=' + JSON.stringify(A.st1.marks));
      s40Push('[alert] +600ms（防抖刷新后）：仍保持活动', A.st2.activeIdx === 0 && A.st2.marks.length === 0 && sameL(A.st2.lines, A.st1.lines));
      if (A.typed) {
        s40Push('[alert] 续行上继续输入生效（能正常换行编辑）', A.typed.lines[2] === '> 继续内容' && A.typed.activeIdx === 0, JSON.stringify(A.typed.lines));
      }
      if (A.cont2) {
        s40Push('[alert] 非空续行再回车：又续一条 "> "、仍保持活动', A.cont2.lines[3] === '> ' && A.cont2.cursor.line === 3 && A.cont2.cursor.ch === 2
          && A.cont2.activeIdx === 0 && A.cont2.marks.length === 0, JSON.stringify({ lines: A.cont2.lines, activeIdx: A.cont2.activeIdx }));
      }
      // 注：mask 标记的 to = 末行行号（含），块 [0,3)（3 行）→ to=2
      s40Push('[alert] 空行回车：退出块、块恢复渲染、光标到块外', A.st3.activeIdx === -1 && A.st3.cursor.line === 4 && A.st3.cursor.ch === 0
        && sameL(A.st3.lines, ['> [!CAUTION]', '> 注意内容', '> 继续内容', '', '']) && A.st3.marks.some(m => m.from === 0 && m.to === 2), JSON.stringify({ lines: A.st3.lines, cursor: A.st3.cursor, marks: A.st3.marks }));
    }
    // b) 列表
    const B = await runS40('list');
    if (B) {
      console.log('  list Enter#1 后: ' + JSON.stringify(B.st1));
      // 逐项切块契约（2026-10-21）：回车续行 = 新项块（光标行源文态可继续输入）；
      // 旧项重遮回渲染——与段落 Enter「旧段恢复渲染」同口径（用户不再在旧项行上）。
      s40Push('[list] Enter#1：续行 "- "、光标新行、新项块活动（旧项重遮，同段落口径）', sameL(B.st1.lines, ['- 32333223', '- ']) && B.st1.cursor.line === 1 && B.st1.cursor.ch === 2
        && B.st1.activeIdx === 1 && B.st1.marks.length === 1 && B.st1.marks[0].from === 0 && B.st1.marks[0].to === 0);
      s40Push('[list] +600ms：仍保持活动（光标行 = 活动项块，不重遮）',
        B.st2.activeIdx === 1 && B.st2.marks.length === 1 && B.st2.marks[0].from === 0 && B.st2.marks[0].to === 0);
      s40Push('[list] 空行回车：退出列表、块恢复渲染', B.st3.activeIdx === -1 && B.st3.cursor.line === 2 && B.st3.cursor.ch === 0
        && sameL(B.st3.lines, ['- 32333223', '', '']) && B.st3.marks.some(m => m.from === 0 && m.to === 0),
        JSON.stringify({ lines: B.st3.lines, cursor: B.st3.cursor, activeIdx: B.st3.activeIdx, marks: B.st3.marks }));
    }
    // c) 普通引用
    const C = await runS40('quote');
    if (C) {
      s40Push('[quote] Enter#1：续行 "> "、块保持活动', sameL(C.st1.lines, ['> 引用文字', '> ']) && C.st1.cursor.line === 1 && C.st1.cursor.ch === 2
        && C.st1.activeIdx === 0 && C.st1.marks.length === 0, JSON.stringify(C.st1.lines));
      s40Push('[quote] 空行回车：退出引用、块恢复渲染', C.st3.activeIdx === -1 && C.st3.cursor.line === 2 && C.st3.cursor.ch === 0
        && sameL(C.st3.lines, ['> 引用文字', '', '']) && C.st3.marks.some(m => m.from === 0 && m.to === 0),
        JSON.stringify({ lines: C.st3.lines, cursor: C.st3.cursor, activeIdx: C.st3.activeIdx, marks: C.st3.marks }));
    }
    // d) 段落对照：回车后新空行属新段落 → 旧段恢复渲染（正确）
    const D = await runS40('para');
    if (D) {
      s40Push('[para] Enter#1：新空行生成、旧段恢复渲染（新空行独立成段，正确行为）',
        sameL(D.st1.lines, ['普通段落文字。', '']) && D.st1.cursor.line === 1 && D.st1.activeIdx === -1
        && D.st1.marks.some(m => m.from === 0 && m.to === 0), JSON.stringify({ lines: D.st1.lines, cursor: D.st1.cursor, activeIdx: D.st1.activeIdx, marks: D.st1.marks }));
    }
  }

  // ---------- S41：列表编辑态块级排版对齐渲染态（2026-10-15 用户反馈：编辑时「变小、变密、缩进不同」） ----------
  // 实测口径：渲染态 ol/ul padding-left:24px + li margin-bottom:4px；编辑态行类补
  // 12px 缩进（序号左缘对齐）+ 4px padding-bottom（项间距）；字号/行高行类本已同参。
  console.log('\n=== S41：列表编辑态对齐渲染态（ol/ul/task） ===');
  {
    const s41Push = (label, ok, extra) => {
      const pass = !!ok;
      if (!pass) fail++;
      console.log(`  ${pass ? '✓' : '✗'} ${label}` + (extra !== undefined ? '  ' + extra : ''));
    };
    const px = (v) => parseFloat(v);
    const runS41 = async (kind) => {
      const init = await page.evaluate((k) => window.__runListType2026(k), kind);
      if (init.err) { console.log(`  ⚠ [${kind}] 场景失败: ` + init.err); fail++; return null; }
      const rendered = await page.evaluate(() => window.__s41rendered());
      if (rendered.err) { console.log(`  ⚠ [${kind}] 渲染态未量到: ` + rendered.err); fail++; return null; }
      const mp = await page.evaluate(() => window.__s41maskPoint());
      if (!mp) { console.log(`  ⚠ [${kind}] 遮罩未定位`); fail++; return null; }
      await page.mouse.click(mp.x, mp.y);
      await new Promise(r => setTimeout(r, 300));
      const active = await page.evaluate(() => window.__s41active());
      return { rendered, active };
    };
    const OL = await runS41('ol');
    if (OL) {
      console.log('  ol 渲染态: ' + JSON.stringify(OL.rendered) + '  编辑态: ' + JSON.stringify(OL.active));
      const r = OL.rendered, a = OL.active;
      s41Push('[ol] 渲染态基准：ol 缩进 24px + li 项距 4px', px(r.padLeft) === 24 && px(r.liGap) === 4, JSON.stringify({ pad: r.padLeft, gap: r.liGap }));
      s41Push('[ol] 编辑态字号 = 渲染态', a.rows[0] && a.rows[0].fontSize === r.fontSize, a.rows[0] ? a.rows[0].fontSize + ' vs ' + r.fontSize : '无行');
      s41Push('[ol] 编辑态序号 24px 右对齐槽（槽左=行基准 32、槽右缘=正文起点，复刻渲染 outside marker）',
        a.rows[0] && px(a.rows[0].padLeft) === 32 && a.rows[0].markX === 32 && a.rows[0].markRight != null && a.rows[0].textX != null && Math.abs(a.rows[0].markRight - a.rows[0].textX) < 1,
        a.rows[0] ? 'padLeft=' + a.rows[0].padLeft + ' 槽=[' + a.rows[0].markX + ',' + a.rows[0].markRight + '] 正文=' + a.rows[0].textX : '');
      s41Push('[ol] 编辑态正文 x = 渲染态（2026-10-16 起 marker 槽口径，差 <1px）',
        a.rows[0] && a.rows[0].textX != null && r.textX != null && Math.abs(a.rows[0].textX - r.textX) < 1,
        a.rows[0] && r.textX != null ? 'textX=' + a.rows[0].textX + ' vs ' + r.textX : '');
      s41Push('[ol] 编辑态项距 = 渲染态（27.2+4≈31.2，不再密集）', a.pitch != null && r.pitch != null && Math.abs(a.pitch - r.pitch) <= 1.5, 'pitch=' + a.pitch + ' vs ' + r.pitch);
      s41Push('[ol] 编辑态行 padding-bottom 4px（计入行盒高，滚动测量不失真）', a.rows[0] && px(a.rows[0].padBottom) === 4);
      s41Push('[ol] 编辑态首行 padding-top 0（S43 新口径 2026-10-17：遮罩 padding-top 已归零，首行不补顶距）', a.rows[0] && px(a.rows[0].padTop) === 0, 'padTop=' + (a.rows[0] && a.rows[0].padTop));
    }
    const UL = await runS41('ul');
    if (UL) {
      const r = UL.rendered, a = UL.active;
      s41Push('[ul] 编辑态缩进 45px（32+13，「- 」≈11px 补差）+ 项距 = 渲染态', a.rows[0] && px(a.rows[0].padLeft) === 45 && a.pitch != null && r.pitch != null && Math.abs(a.pitch - r.pitch) <= 1.5,
        JSON.stringify({ pad: a.rows[0] && a.rows[0].padLeft, pitch: a.pitch, rPitch: r.pitch, markX: a.rows[0] && a.rows[0].markX, rTextX: r.textX }));
      s41Push('[ul] 编辑态正文 x ≈ 渲染态（差 ≤5px）', a.rows[0] && a.rows[0].textX != null && r.textX != null && Math.abs(a.rows[0].textX - r.textX) <= 5,
        'textX=' + (a.rows[0] && a.rows[0].textX) + ' vs ' + r.textX);
      const dot = await page.evaluate(() => {
        const sp = document.querySelector('pre.CodeMirror-line .wysiwyg-list-bullet');
        if (!sp) return null;
        const cs = getComputedStyle(sp, '::before');
        return { w: cs.width, h: cs.height, radius: cs.borderRadius, bg: cs.backgroundColor };
      });
      s41Push('[ul] 圆点为 6px 画圆（与渲染 disc marker 同形，非 • 字符）', dot && dot.w === '6px' && dot.h === '6px' && dot.radius !== '0px', JSON.stringify(dot));
    }
    const TK = await runS41('task');
    if (TK) {
      const r = TK.rendered, a = TK.active;
      s41Push('[task] 渲染态 padding 0（复选框贴行首）→ 编辑态不加缩进（保持行基准 32px）', px(r.padLeft) === 0 && a.rows[0] && px(a.rows[0].padLeft) === 32,
        '渲染 pad=' + r.padLeft + ', 编辑 pad=' + (a.rows[0] && a.rows[0].padLeft));
      s41Push('[task] 编辑态项距 = 渲染态', a.pitch != null && r.pitch != null && Math.abs(a.pitch - r.pitch) <= 1.5, 'pitch=' + a.pitch + ' vs ' + r.pitch);
    }
  }

  // ---------- S42：纯数字串编辑态不得漏出下划线（2026-10-15 用户截图） ----------
  // 根因：gfm 模式 gitHubSpice 把 7–40 位十六进制串认成 SHA → cm-link token →
  // codemirror.css .cm-link { text-decoration: underline } 在编辑态漏出；渲染器
  // （remark）不识别 → 编辑/渲染不一致。修复 = mode 配置 gitHubSpice:false +
  // 编辑态 cm- token 的 text-decoration 统一中和。
  // 本应用渲染态口径：.preview-content a { text-decoration:none }（链接只有主题色、
  // 无下划线）→ 编辑态 URL/显式链接 span 也不得带下划线；<u> 下划线 / ~~ 删除线保留。
  console.log('\n=== S42：纯数字列表项编辑态无下划线（链接同渲染口径） ===');
  {
    const s42Push = (label, ok, extra) => {
      const pass = !!ok;
      if (!pass) fail++;
      console.log(`  ${pass ? '✓' : '✗'} ${label}` + (extra !== undefined ? '  ' + extra : ''));
    };
    const init = await page.evaluate(() => window.__runDigitUnderline2026());
    if (init.err) {
      console.log('  ⚠ S42 场景失败: ' + init.err);
      fail++;
    } else {
      const rendered = await page.evaluate(() => window.__s42rendered());
      if (rendered.err) { console.log('  ⚠ S42 渲染态未量到: ' + rendered.err); fail++; }
      else {
        s42Push('[渲染] 数字 li 与 URL <a> 均无下划线（本应用链接口径 text-decoration:none）',
          rendered.li0 === 'none' && rendered.a === 'none', JSON.stringify(rendered));
        // 逐项切块（2026-10-21）：每项独立成块 → 逐项点击遮罩、逐项量编辑态
        const clickItem = async (lineNo) => {
          const m = await page.evaluate((n) => window.__s42maskPointFor(n), lineNo);
          if (!m) return false;
          await page.mouse.click(m.x, m.y);
          await new Promise(r => setTimeout(r, 300));
          return true;
        };
        const digitSpans = [];
        for (const n of [0, 1, 2]) {
          if (!(await clickItem(n))) { s42Push('[编辑] 数字项遮罩未定位（行 ' + n + '）', false); continue; }
          const active = await page.evaluate(() => window.__s42active());
          const row = active.rows.find((r) => r.line === n);
          digitSpans.push(row ? row.spans : null);
        }
        const digitsClean = digitSpans.length === 3 && digitSpans.every((spans) =>
          !!spans && spans.length > 0 && spans.every((s) => (s.deco || 'none') === 'none' && (s.cls || '').indexOf('cm-link') === -1));
        s42Push('[编辑] 纯数字项 span 无下划线、无 cm-link token（gitHubSpice 已关，逐项点入）',
          digitsClean, JSON.stringify(digitSpans));
        const urlLine = await page.evaluate(() => window.__s42find('https://example.com/x'));
        if (urlLine >= 0 && (await clickItem(urlLine))) {
          const active = await page.evaluate(() => window.__s42active());
          const urlRow = active.rows.find((r) => r.line === urlLine);
          s42Push('[编辑] URL 项 span 无下划线（与渲染 <a> 口径一致）',
            !!urlRow && urlRow.spans.every((s) => (s.deco || 'none') === 'none'),
            JSON.stringify(urlRow && urlRow.spans));
        } else { s42Push('[编辑] URL 项遮罩未定位', false); }
        const linkLine = await page.evaluate(() => window.__s42find('点我'));
        if (linkLine >= 0 && (await clickItem(linkLine))) {
          const active = await page.evaluate(() => window.__s42active());
          const linkRow = active.rows.find((r) => r.line === linkLine);
          const linkSpan = linkRow ? linkRow.spans.find((s) => /点我/.test(s.txt)) : null;
          s42Push('[编辑] 显式链接文本主题色、无下划线（wysiwyg-inline-link 不重申 underline）',
            !!linkSpan && (linkSpan.deco || 'none') === 'none' && linkSpan.cls.indexOf('wysiwyg-inline-link') !== -1,
            JSON.stringify(linkSpan));
        } else { s42Push('[编辑] 链接项遮罩未定位', false); }
      }
    }
  }

  // ---------- S43：点块进编辑块下方内容不得跳（2026-10-15 用户截图：「向上动一下」） ----------
  // 根因：遮罩高度含渲染元素自身 margin-bottom（ul/ol/p = 14px；> *:last-child 清零
  // 被 block-edit-btn 占了 last-child 位而失效）+ 遮罩 padding 1+2 + border-bottom 1；
  // 编辑态行盒没有这些 → 活动块比遮罩矮 17px、首行高 1px → 点入后下方整体上跳。
  // 修复 = 块边缘行（wysiwyg-block-edge-bottom）给 14px 边距族末行补 底距 14px
  // （2026-10-17 新口径：遮罩盒模型归零后，遮罩底缘 = 内容 + 14px mb（BFC 内收），
  // 首行不再补顶距）。断言：活动块底 vs 遮罩底、块下段落行顶（遮罩态 vs 活动态）
  // 两处差 <0.5px。
  console.log('\n=== S43：点块进编辑块下方内容不跳（块高逐像素等高） ===');
  {
    const s43Push = (label, ok, extra) => {
      const pass = !!ok;
      if (!pass) fail++;
      console.log(`  ${pass ? '✓' : '✗'} ${label}` + (extra !== undefined ? '  ' + extra : ''));
    };
    const init = await page.evaluate(() => window.__runBlockJump2026());
    if (init.err) {
      console.log('  ⚠ S43 场景失败: ' + init.err);
      fail++;
    } else if (init.maskState.err) {
      console.log('  ⚠ S43 遮罩态未量到: ' + init.maskState.err);
      fail++;
    } else if (!init.maskPoint) {
      console.log('  ⚠ S43 遮罩未定位');
      fail++;
    } else {
      await page.mouse.click(init.maskPoint.x, init.maskPoint.y);
      await new Promise(r => setTimeout(r, 300));
      const a = await page.evaluate(() => window.__s43active());
      const m = init.maskState;
      const dBottom = a.listBottom != null ? Math.abs(a.listBottom - m.maskBottom) : null;
      const dPara = (a.paraTop != null && m.paraTop != null) ? Math.abs(a.paraTop - m.paraTop) : null;
      s43Push('[列表] 活动块底 = 遮罩底（差 <0.5px，14px margin 由块边缘行底距补齐）',
        dBottom != null && dBottom < 0.5, '遮罩底=' + m.maskBottom + ' 活动底=' + a.listBottom + ' Δ=' + (dBottom == null ? '?' : dBottom.toFixed(3)));
      s43Push('[列表] 块下段落行顶不跳（遮罩态 vs 活动态，差 <0.5px）',
        dPara != null && dPara < 0.5, '遮罩态=' + m.paraTop + ' 活动态=' + a.paraTop + ' Δ=' + (dPara == null ? '?' : dPara.toFixed(3)));
      // 逐项切块（2026-10-21）：非末项块底 = 项间距 4px；14px 底边归属末项（下面点末项验证）
      const firstEdge = a.edges[0];
      s43Push('[列表] 首项边缘行类挂上且补齐生效（2026-10-21 逐项：padTop 0 / 非末项底 4px = 项间距）',
        !!firstEdge && parseFloat(firstEdge.padTop) === 0 && parseFloat(firstEdge.padBottom) === 4,
        JSON.stringify(a.edges));
      // [S44] 圆点垂直居中锚定行盒（2026-10-15 用户截图「点入编辑黑点往上移一点点」）：
      // 真机 WebView2 里内联 span 字体盒按基线放置，与渲染 disc（行盒中心）差 1px；
      // 修复 = .wysiwyg-list-bullet 改 inline-block + 盒高 1.7em（=行盒高）+
      // vertical-align:top（盒顶=行盒顶）→ ::before top:50% 严格=行盒中心。
      // 断言：bullet 盒顶/盒高与行盒一致（引擎无关的确定性几何）。
      {
        const b = a.bullet;
        if (!b || b.spanH == null) {
          s43Push('[圆点] bullet 盒存在（wysiwyg-list-bullet span）', false);
        } else {
          const lineH = parseFloat(b.lineHeight);
          const lineTop = b.preTop + parseFloat(b.padTop || '0px');
          s43Push('[圆点] bullet 盒顶 = 行盒顶（Δ<0.5px，vertical-align:top）',
            Math.abs(b.spanTop - lineTop) < 0.5,
            `span=${b.spanTop.toFixed(3)} line=${lineTop.toFixed(3)}`);
          s43Push('[圆点] bullet 盒高 = 行盒高（Δ<0.5px，1.7em）',
            Math.abs(b.spanH - lineH) < 0.5,
            `span=${b.spanH.toFixed(3)} line=${lineH} display=${b.display} vAlign=${b.vAlign}`);
        }
      }
      // 末项：14px 底边归属末项（遮罩盒模型 = 内容 + 14px mb），且末项下方段落行顶不跳
      const lastPt = await page.evaluate(() => window.__s43lastMaskPoint());
      if (lastPt) {
        await page.mouse.click(lastPt.x, lastPt.y);
        await new Promise(r => setTimeout(r, 300));
        const a2 = await page.evaluate(() => window.__s43active());
        const e2 = a2.edges[0];
        s43Push('[列表] 末项块底 = 遮罩底（差 <0.5px）',
          a2.listBottom != null && Math.abs(a2.listBottom - lastPt.maskBottom) < 0.5,
          '遮罩底=' + lastPt.maskBottom + ' 活动底=' + a2.listBottom);
        s43Push('[列表] 末项底边 14px（2026-10-17 口径：列表底距归末项）',
          !!e2 && parseFloat(e2.padBottom) === 14, JSON.stringify(a2.edges));
        const dPara2 = (a2.paraTop != null && m.paraTop != null) ? Math.abs(a2.paraTop - m.paraTop) : null;
        s43Push('[列表] 末项下段落行顶不跳（遮罩态 vs 点末项后）',
          dPara2 != null && dPara2 < 0.5, '遮罩态=' + m.paraTop + ' 活动态=' + a2.paraTop + ' Δ=' + (dPara2 == null ? '?' : dPara2.toFixed(3)));
      } else {
        s43Push('[列表] 末项遮罩未定位（逐项切块后应存在）', false);
      }
      // 段落块同口径（14px 边距族的另一成员）
      const paraInit = await page.evaluate(() => {
        const mask = Array.from(document.querySelectorAll('.wysiwyg-block-mask.preview-content')).find(function (x) {
          return x.querySelector('p');
        });
        if (!mask) return null;
        const r = mask.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + 10, maskBottom: r.bottom };
      });
      if (!paraInit) { console.log('  ⚠ S43 段落遮罩未定位（跳过段落块断言）'); }
      else {
        await page.mouse.click(paraInit.x, paraInit.y);
        await new Promise(r => setTimeout(r, 300));
        const p = await page.evaluate(() => {
          const wrap = document.querySelector('.CodeMirror');
          const lineEls = wrap.querySelectorAll('pre.CodeMirror-line');
          let paraBottom = null;
          for (const el of lineEls) {
            const c = (el.className || '').toString();
            if (c.indexOf('wysiwyg-para-line') !== -1) paraBottom = el.getBoundingClientRect().bottom;
          }
          const edges = Array.from(lineEls).filter((l) => (l.className || '').toString().indexOf('wysiwyg-block-edge-bottom') !== -1)
            .map((l) => getComputedStyle(l).paddingBottom);
          return { paraBottom, edges };
        });
        const dP = p.paraBottom != null ? Math.abs(p.paraBottom - paraInit.maskBottom) : null;
        s43Push('[段落] 活动段底 = 遮罩底（差 <0.5px）',
          dP != null && dP < 0.5, '遮罩底=' + paraInit.maskBottom + ' 活动底=' + p.paraBottom + ' Δ=' + (dP == null ? '?' : dP.toFixed(3)));
        s43Push('[段落] 边缘行补齐生效（2026-10-17 新口径：末行 padBottom 14px）',
          p.edges.length > 0 && p.edges.every((v) => parseFloat(v) === 14), JSON.stringify(p.edges));
      }
    }
  }

  // ---------- S45：disc 与画圆逐像素同位（2026-10-15 用户第二组截图：编辑态黑点比
  // 渲染态高 1px）。根因：disc marker 绘制位=行顶+0.906em（基线锚定字形位，Edge154
  // 逐像素实测=用户真机），非行盒几何中心（0.85em）；Playwright Chromium 绘在 0.85em
  // → 用自带浏览器校准在真机必偏。修复=画圆 top: calc(0.906em - 3px)。
  // 验证：浏览器截图 → canvas 提取两态圆点中心，逐像素 Δ<0.5px。 ----------
  console.log('\n=== S45：disc↔画圆逐像素同位（截图级，Edge/WebView2 校准） ===');
  {
    const s45Push = (label, ok, extra) => {
      const pass = !!ok;
      if (!pass) fail++;
      console.log(`  ${pass ? '✓' : '✗'} ${label}` + (extra !== undefined ? '  ' + extra : ''));
    };
    const scanDots = async (clip) => {
      const shot = await page.screenshot({ clip });
      const b64 = shot.toString('base64');
      return page.evaluate(async (src) => {
        const im = new Image();
        im.src = 'data:image/png;base64,' + src;
        await im.decode();
        const W = im.width, H = im.height;
        const cv = document.createElement('canvas');
        cv.width = W; cv.height = H;
        const cx = cv.getContext('2d');
        cx.drawImage(im, 0, 0);
        const d = cx.getImageData(0, 0, W, H).data;
        const lum = (x, y) => { const i = (y * W + x) * 4; return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; };
        const seen = new Set();
        const dots = [];
        for (let y = 0; y < H; y++) for (let x = 30; x < 120; x++) {
          if (seen.has(y * W + x) || lum(x, y) > 150) continue;
          const q = [[x, y]]; seen.add(y * W + x);
          let minx = x, maxx = x, miny = y, maxy = y, cnt = 0;
          while (q.length) {
            const p = q.pop(); cnt++;
            if (p[0] < minx) minx = p[0]; if (p[0] > maxx) maxx = p[0];
            if (p[1] < miny) miny = p[1]; if (p[1] > maxy) maxy = p[1];
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const nx = p[0] + dx, ny = p[1] + dy;
              if (nx < 30 || ny < 0 || nx >= 120 || ny >= H) continue;
              const k = ny * W + nx;
              if (seen.has(k) || lum(nx, ny) > 150) continue;
              seen.add(k); q.push([nx, ny]);
            }
          }
          const w = maxx - minx + 1, h = maxy - miny + 1;
          if (w >= 4 && w <= 9 && h >= 4 && h <= 9 && cnt / (w * h) > 0.55) {
            dots.push(+((miny + maxy) / 2).toFixed(1));
          }
        }
        return dots.sort((a, b) => a - b);
      }, b64);
    };
    try {
      await page.evaluate(() => window.__runListType2026('ul'));
      await new Promise(r => setTimeout(r, 500));
      // 逐项切块（2026-10-21）：渲染侧 li 分散在各项片段遮罩里，跨遮罩收集
      const rendGeo = await page.evaluate(() => {
        const lis = Array.from(document.querySelectorAll('.wysiwyg-block-mask.preview-content ol li, .wysiwyg-block-mask.preview-content ul li'));
        if (!lis.length) return null;
        const first = lis[0].closest('.wysiwyg-block-mask').getBoundingClientRect();
        return { tops: lis.map((li) => li.getBoundingClientRect().top), x: first.x };
      });
      if (!rendGeo || !rendGeo.tops.length) { s45Push('S45 场景初始化（遮罩态）', false); }
      else {
        const rendClipY = Math.max(0, rendGeo.tops[0] - 10);
        const rendH = Math.ceil(rendGeo.tops[rendGeo.tops.length - 1] - rendGeo.tops[0] + 60);
        const rendDots = await scanDots({ x: 0, y: rendClipY, width: 350, height: rendH });
        // 逐项点入：每项活动行的源文态圆点 vs 该项渲染态圆点（窗口内首个圆点 = 活动行源文圆点，
        // 下方遮罩兄弟项的圆点是渲染圆点、按顺序与 rendDots 对齐，不影响首点比较）
        const maskPts = await page.evaluate(() => Array.from(document.querySelectorAll('.wysiwyg-block-mask.preview-content ol, .wysiwyg-block-mask.preview-content ul'))
          .map((m) => { const r = m.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 12 }; }));
        let n = 0, maxD = null, bad = false;
        for (let i = 0; i < maskPts.length && i < rendGeo.tops.length; i++) {
          await page.mouse.click(maskPts[i].x, maskPts[i].y);
          await new Promise(r => setTimeout(r, 300));
          // 基准 = **行盒顶**（pre 顶 + padding-top；渲染侧 li top 也是行盒顶：li 无 padding）
          const actTop = await page.evaluate(() => {
            const wrap = document.querySelector('.CodeMirror');
            const isM = (l) => !!(l.parentElement && l.parentElement.classList && l.parentElement.classList.contains('CodeMirror-measure'));
            const pres = [...wrap.querySelectorAll('pre.CodeMirror-line')]
              .filter((l) => !isM(l) && (l.className || '').toString().indexOf('wysiwyg-list-line') !== -1);
            if (!pres.length) return null;
            const p = pres[pres.length - 1];
            const r = p.getBoundingClientRect();
            return r.top + parseFloat(getComputedStyle(p).paddingTop || '0');
          });
          if (actTop == null) { bad = true; break; }
          const actClipY = Math.max(0, actTop - 10);
          const actDots = await scanDots({ x: 0, y: actClipY, width: 350, height: 100 });
          if (rendDots[i] == null || actDots[0] == null) { bad = true; break; }
          const dR = rendDots[i] + rendClipY - rendGeo.tops[i];
          const dA = actDots[0] + actClipY - actTop;
          const d = Math.abs(dR - dA);
          n++;
          if (maxD === null || d > maxD) maxD = d;
        }
        s45Push('两态圆点相对本行行顶逐像素同位（逐项点入，Δ<0.5px，' + n + ' 行）',
          !bad && n >= 2 && maxD !== null && maxD < 0.5,
          '渲染=' + JSON.stringify(rendDots) + ' maxΔ=' + (maxD === null ? '?' : maxD.toFixed(2)));
      }
    } catch (e) {
      s45Push('S45 场景执行', false, String(e && e.message || e).slice(0, 120));
    }
  }

  // ---------- S46：列表逐行点击光标落该行（2026-10-16 用户反馈 #2）+ 列表块无「编辑」按钮（#1） ----------
  // 修复前：点列表行按整块纵向比例估算源码行——分母含遮罩底 padding、行数含松散列表空行，
  // 点中间项恒偏上一行（harness 实测：5 项列表点第 3 项落第 2 项；3 项列表点第 2 项上半
  // 落第 1 项 = 用户报的「光标开始会在列表的第一行，要再点一下才过去」）。
  // 修复：点 <li> 内走 data-source-line 精确落行（remark 插件标注的块切片内行号）。
  // 每行点击前重建编辑器（列表块须处于「有遮罩、非活动」态；点一下即解罩）。
  {
    console.log('\n=== S46：列表逐行点击光标落该行 + 列表块无编辑按钮 ===');
    const s46Push = (label, ok, extra) => {
      const pass = !!ok;
      if (!pass) fail++;
      console.log(`  ${pass ? '✓' : '✗'} ${label}` + (extra !== undefined ? '  ' + extra : ''));
    };
    const LIST_LINES = [2, 3, 4, 5, 6]; // 5 项列表的源码行号（0-based，列表自 line 2 起）
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.__s44setup());
      await new Promise(r => setTimeout(r, 150));
      const pre = await page.evaluate(() => window.__s44read());
      const pt = await page.evaluate((n) => window.__s44liPoint(n), i + 1);
      if (!pt) {
        s46Push('li#' + (i + 1) + ' 遮罩定位', false, '列表遮罩/项未物化');
        continue;
      }
      s46Push(`点第 ${i + 1} 项前：5 项各成块且有遮罩、无「编辑」按钮（#1）`,
        pre && pre.maskedItems === 5 && pre.listBtn === false,
        'maskedItems=' + (pre && pre.maskedItems) + ' listBtn=' + (pre && pre.listBtn));
      await page.mouse.click(pt.x, pt.y);
      await new Promise(r => setTimeout(r, 300));
      const st = await page.evaluate((n) => window.__s44read(n), i + 1);
      const expected = LIST_LINES[i];
      s46Push(`点第 ${i + 1} 项（${pt.text}）：一次点击即解罩该项 + 光标精确落该行（line ${expected}）、其余 4 项保持遮罩`,
        !!st && st.listMasked === false && st.maskedItems === 4 && st.cursorLine === expected && st.lineText === '- 列表项' + '一二三四五'[i],
        'cursor=' + (st && JSON.stringify(st.cursorLine)) + ' 期望=' + expected + ' 行文=' + (st && st.lineText) + ' maskedItems=' + (st && st.maskedItems));
    }
    // 松散列表（多段 li）：点第二段落 → 落该段自身行（<p> 标注比 <li> 更精确），而非项首行
    await page.evaluate(() => window.__s44setupLoose());
    await new Promise(r => setTimeout(r, 300));
    const lp = await page.evaluate(() => window.__s44loosePoint());
    if (!lp) {
      s46Push('松散列表第二段落定位', false, '未物化');
    } else {
      await page.mouse.click(lp.x, lp.y);
      await new Promise(r => setTimeout(r, 300));
      const st = await page.evaluate(() => window.__s44read());
      s46Push('松散列表点第二段落：光标落该段自身行（line ' + lp.expectLine + '，非项首行 ' + lp.itemLine + '）',
        !!st && st.cursorLine === lp.expectLine, 'cursor=' + (st && st.cursorLine) + ' 期望=' + lp.expectLine);
    }
  }

  // ---------- S48：混合列表黑点归位（2026-10-16 用户反馈 #3，按 CommonMark 规范） ----------
  // 用户场景：无序列表下多次回车空行再输任务列表。CommonMark：空行只使列表变松散，
  // 同型列表从不因空行断开 → 合并为一个 contains-task-list（空行不可见=规范行为，用户
  // 确认按规范来、不拆块）。回归点：任务样式 ul padding:0 后，普通项原生 outside disc
  // 相对 li 边框缘定位 → 黑点偏左 24px（用户截图「黑点与左侧距离异常」）。CSS 修复 =
  // ::before 画圆（38–44px，与正常 ul disc 同位）。断言三处一致 + 几何。 ----------
  console.log('\n=== S48：混合列表黑点归位（CommonMark：空行不拆列表） ===');
  {
    const s48Push = (label, ok, extra) => {
      const pass = !!ok;
      if (!pass) fail++;
      console.log(`  ${pass ? '✓' : '✗'} ${label}` + (extra !== undefined ? '  ' + extra : ''));
    };
    // 某 li 行的填充圆点扫描（截图 → canvas → 连通域：4–9px、填充率>55% 才算点）
    const scanDotX = async (n) => {
      const rr = await page.evaluate((s) => {
        const li = document.querySelector('#reading > ul > li:nth-of-type(' + s + ')');
        if (!li) return null;
        li.scrollIntoView({ block: 'center' });
        const r = li.getBoundingClientRect();
        return { top: r.top, h: r.height };
      }, n);
      if (!rr) return null;
      const shot = await page.screenshot({ clip: { x: 0, y: Math.max(0, rr.top - 4), width: 200, height: Math.ceil(rr.h) + 8 } });
      const b64 = shot.toString('base64');
      return page.evaluate(async (src) => {
        const im = new Image();
        im.src = 'data:image/png;base64,' + src;
        await im.decode();
        const W = im.width, H = im.height;
        const cv = document.createElement('canvas');
        cv.width = W; cv.height = H;
        const cx = cv.getContext('2d');
        cx.drawImage(im, 0, 0);
        const d = cx.getImageData(0, 0, W, H).data;
        const lum = (x, y) => { const i = (y * W + x) * 4; return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; };
        const seen = new Set();
        const dots = [];
        for (let y = 0; y < H; y++) for (let x = 0; x < 150; x++) {
          if (seen.has(y * W + x) || lum(x, y) > 150) continue;
          const q = [[x, y]]; seen.add(y * W + x);
          let minx = x, maxx = x, miny = y, maxy = y, cnt = 0;
          while (q.length) {
            const p = q.pop(); cnt++;
            if (p[0] < minx) minx = p[0]; if (p[0] > maxx) maxx = p[0];
            if (p[1] < miny) miny = p[1]; if (p[1] > maxy) maxy = p[1];
            for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
              const nx = p[0] + dx, ny = p[1] + dy;
              if (nx < 0 || ny < 0 || nx >= 150 || ny >= H) continue;
              const k = ny * W + nx;
              if (seen.has(k) || lum(nx, ny) > 150) continue;
              seen.add(k); q.push([nx, ny]);
            }
          }
          const w = maxx - minx + 1, h = maxy - miny + 1;
          if (w >= 4 && w <= 9 && h >= 4 && h <= 9 && cnt / (w * h) > 0.55) {
            dots.push({ x: +((minx + maxx) / 2).toFixed(1), w, h });
          }
        }
        return dots;
      }, b64);
    };
    try {
      // ① 参照：正常 ul 的 disc（黑点应处的位置）
      const normal = await page.evaluate(() => window.__s48setup('normal'));
      if (!normal) {
        s48Push('S48 参照场景初始化（正常 ul）', false);
      } else {
        const refDots = [];
        for (let i = 1; i <= 3; i++) {
          refDots.push(await scanDotX(i));
        }
        const refX = refDots.filter(Boolean).map((d) => d[0] && d[0].x).filter((v) => v != null);
        s48Push('参照：正常 ul 黑点 x≈40.5（像素扫描 38–43 区间）',
          refX.length === 3 && refX.every((x) => x >= 38 && x <= 42.5), JSON.stringify(refX));
        // ② 合并列表（用户场景：ul + 空行×2 + 任务列表）
        const merged = await page.evaluate(() => window.__s48setup('merged'));
        s48Push('块表 = 单个列表块 [0,6)（CommonMark：空行只松散、不拆列表、无独立 gap 块）',
          JSON.stringify(merged.blocks) === JSON.stringify([[0, 6]]), JSON.stringify(merged.blocks));
        s48Push('阅读态 = 单个 contains-task-list（普通项与任务项合并，空行被吸收为项距）',
          merged.ulCls === 'contains-task-list', merged.ulCls);
        // ③ 普通项黑点 x 与正常 ul disc 像素同位（旧实现偏左 24px 的回归点）
        const mDots1 = await scanDotX(1);
        const mDots2 = await scanDotX(2);
        const mX = [mDots1, mDots2].filter(Boolean).map((d) => d[0] && d[0].x).filter((v) => v != null);
        s48Push('普通项黑点 x 与正常 ul disc 同位（Δ≤1px；复选框列不受干扰）',
          refX.length === 3 && mX.length === 2 && mX.every((x) => Math.abs(x - refX[0]) <= 1),
          'normal=' + JSON.stringify(refX) + ' merged=' + JSON.stringify(mX));
        // ④ 复选框 / 正文对齐 / 任务行无黑点
        s48Push('任务项复选框 x=32（行基线，不被普通项 24px 槽拉走）',
          merged.lis[2] && merged.lis[2].cbX != null && Math.abs(merged.lis[2].cbX - 32) < 1, 'cbX=' + (merged.lis[2] && merged.lis[2].cbX));
        s48Push('普通项正文 x=56、任务项文本 x=56（两类正文对齐）',
          merged.lis[0] && merged.lis[0].textX != null && Math.abs(merged.lis[0].textX - 56) < 1 &&
          merged.lis[2] && merged.lis[2].textX != null && Math.abs(merged.lis[2].textX - 56) < 1,
          JSON.stringify({ p0: merged.lis[0] && merged.lis[0].textX, t2: merged.lis[2] && merged.lis[2].textX }));
        const taskDots = await scanDotX(3);
        s48Push('任务行无黑点（复选框不是点，不被误绘/误扫）',
          Array.isArray(taskDots) && taskDots.length === 0, JSON.stringify(taskDots));
      }
    } catch (e) {
      s48Push('S48 场景执行', false, String(e && e.message || e).slice(0, 120));
    }
  }

  // ---------- S49：跨块选区（2026-10-16 用户反馈「用鼠标选中和全选都只能选中当前编辑
  // 的一小块，没法跨块去选中」） ----------
  // 根因：遮罩 = CM5 replacedWith → 强制 atomic。① inclusiveLeft:true 把 Ctrl+A 锚点
  // {0,0} 钳到首块末（42/47 字符丢首块）；② 遮罩 mousedown stopPropagation → 从遮罩
  // 起拖 CM 收不到按下（只跳光标）；③ CM 不给 widget 画选框 + cursorActivity 切活动块
  // → 视觉上只剩当前块高亮。修复：两端非包含 + 遮罩选区着色类 + 遮罩 mousedown 点击/
  // 拖拽分流（4px 阈值，拖拽期冻结活动块同步）。
  console.log('\n=== S49：跨块选区（Ctrl+A 全篇 / 拖拽跨块 / 遮罩起拖） ===');
  {
    const s49Push = (label, ok, extra) => {
      const pass = !!ok;
      if (!pass) fail++;
      console.log(`  ${pass ? '✓' : '✗'} ${label}` + (extra !== undefined ? '  ' + extra : ''));
    };
    // 从 p1 到 p2 的真实鼠标拖拽（10 步，模拟人手拖动）
    const drag49 = async (p1, p2, steps = 10) => {
      await page.mouse.move(p1.x, p1.y);
      await page.mouse.down();
      for (let i = 1; i <= steps; i++) {
        await page.mouse.move(p1.x + ((p2.x - p1.x) * i) / steps, p1.y + ((p2.y - p1.y) * i) / steps);
        await page.waitForTimeout(15);
      }
      await page.mouse.up();
      await page.waitForTimeout(60);
    };
    try {
      const setup = await page.evaluate(() => window.__s49setup());
      // 逐项切块（2026-10-21）：紧列表拆 2 项 → 6 块 / 5 遮罩（p 块仍 idx 1）
      s49Push('S49 初始化（6 块 / p 块活动 / 5 遮罩）',
        !!setup && setup.lines === 10 && setup.len === 47 && setup.activeIdx === 1, JSON.stringify(setup));
      if (setup) {
        // ① Ctrl+A：模型选区必须覆盖全篇（含首块；修复前锚点被钳到首块末，42/47 字符）
        await page.keyboard.press('Control+a');
        await page.waitForTimeout(80);
        let sel = await page.evaluate(() => window.__s49sel());
        const r0 = (sel.ranges[0] || {});
        s49Push('Ctrl+A 全选 = 全篇（含首块；修复前丢首块 42/47）',
          r0.from && r0.from.line === 0 && r0.from.ch === 0 && r0.to && r0.to.line === 9 && r0.to.ch === 5 && sel.selLen === 47,
          JSON.stringify(sel.ranges) + ' selLen=' + sel.selLen + '/47');
        const selMasks1 = (sel.masks || []).filter((m) => m.selected).length;
        s49Push('全选时 5 个遮罩块全部挂选中着色类（跨块选区视觉；逐项后 4→5）',
          (sel.masks || []).length === 5 && selMasks1 === 5,
          'masks=' + (sel.masks || []).length + ' selected=' + selMasks1);

        // ② 从活动块（Ctrl+A 后 head 在 quote → 活动块已切到 quote，行 9 为真实行）
        //    向上拖到 p 遮罩（行 2）：CM 原生拖选路径，head 被 skipAtomic 钳到各遮罩
        //    边界逐块跨越（两端非包含后端点能落在遮罩边缘）
        const c1 = await page.evaluate(() => window.__s49point('line9'));
        const c2 = await page.evaluate(() => window.__s49point('line2'));
        s49Push('S49 拖点取位（quote 行 / p 行）', !!c1 && !!c2, JSON.stringify({ c1, c2 }));
        if (c1 && c2) {
          // 先普通点击折叠选区（有选区时 mousedown 走 CM leftButtonStartDrag 文本拖放，
          // 不是拖选；点真实行由 CM 自己处理，光标落点击处）
          await page.mouse.click(c1.x, c1.y);
          await page.waitForTimeout(80);
          await drag49(c1, c2);
          sel = await page.evaluate(() => window.__s49sel());
          const r1 = (sel.ranges[0] || {});
          const spans1 = r1.from && r1.from.line <= 2 && r1.to && r1.to.line >= 7;
          s49Push('活动块起拖到 p 遮罩：选区跨块（head 到 quote 末、覆盖 p 块边界）',
            spans1 && sel.selLen >= 25, // (2,x)→(9,5) 全距=37 字符（含 6 个换行），钳位后 ≥25
            JSON.stringify(sel.ranges) + ' selLen=' + sel.selLen);
          const selMasks2 = (sel.masks || []).filter((m) => m.selected).length;
          s49Push('拖选覆盖的遮罩挂着色类（≥2：ul/p2 必被整块覆盖）', selMasks2 >= 2,
            'selected=' + selMasks2 + ' ' + JSON.stringify((sel.masks || []).map((m) => m.selected)));
        }

        // ③ 从遮罩起拖（h1 遮罩，行 0）向下拖到 p2 遮罩（行 7）：修复前 stopPropagation
        //    让 CM 收不到 mousedown → 只跳光标、selLen=0；现 mousedown 点击行为同步执行
        //    （h1 块激活）后升级为拖选——anchor 取遮罩块首 (0,0)，head 向下经 coordsChar
        //    推进、被各遮罩 skipAtomic 钳到边界（向下拖钳到块首，CM 钳位方向依 head 移动
        //    方向 bias）逐块跨越。路径上的 p/ul 遮罩整块被选区覆盖 → 着色类。
        //    注：被拖到的终点遮罩 head 钳在其块首，自身不被覆盖（CM atomic 单元语义）
        const c3 = await page.evaluate(() => window.__s49point('h1Mask'));
        const c4 = await page.evaluate(() => window.__s49point('p2Mask'));
        s49Push('S49 拖点取位（h1 遮罩 / p2 遮罩）', !!c3 && !!c4, JSON.stringify({ c3, c4 }));
        if (c3 && c4) {
          await drag49(c3, c4);
          sel = await page.evaluate(() => window.__s49sel());
          const r2 = (sel.ranges[0] || {});
          const spans2 = r2.from && r2.from.line <= 3 && r2.to && r2.to.line >= 5;
          s49Push('遮罩起拖产生跨块选区（修复前只跳光标 selLen=0）',
            spans2 && sel.selLen >= 20, // (0,0)→(7,0) 全距=35 字符（含 6 换行），钳位后 ≥20
            JSON.stringify(sel.ranges) + ' selLen=' + sel.selLen);
          const selMasks3 = (sel.masks || []).filter((m) => m.selected).length;
          s49Push('遮罩起拖：路径上 p/ul 遮罩整块覆盖挂着色类（≥2）', selMasks3 >= 2,
            'selected=' + selMasks3 + ' ' + JSON.stringify((sel.masks || []).map((m) => m.selected)));
        }

        // ④ 普通点击（不动）行为保持：点 ul 遮罩第一个 <li> → ul 块激活 + 光标落该行行尾
        const c5 = await page.evaluate(() => window.__s49point('ulLi'));
        s49Push('S49 点击取位（ul 首项）', !!c5, JSON.stringify(c5));
        if (c5) {
          await page.mouse.click(c5.x, c5.y);
          await page.waitForTimeout(120);
          sel = await page.evaluate(() => window.__s49sel());
          const rc = (sel.ranges[0] || {});
          s49Push('点击遮罩仍走原行为（ul 块激活 + 光标落行尾 + 无选区）',
            sel.activeIdx === 2 && rc.from && rc.from.line === 4 && rc.from.ch === 6 && sel.selLen === 0,
            'activeIdx=' + sel.activeIdx + ' sel=' + JSON.stringify(sel.ranges) + ' selLen=' + sel.selLen);
        }

        // ⑤ 跨块选区上打字：Ctrl+A + 输入 → 整篇替换、遮罩干净重挂（atomic 标记随
        //    区间被消费而清除，250ms 防抖刷新按新块表重挂）
        await page.keyboard.press('Control+a');
        await page.waitForTimeout(50);
        await page.keyboard.type('X');
        await page.waitForTimeout(450);
        const after = await page.evaluate(() => {
          const ed = window.__s49ed;
          return { value: ed.cm.getValue(), marks: ed._wysiwygMarks.size, activeIdx: ed._wysiwygActiveIdx };
        });
        s49Push('跨块选区上打字整篇替换 + 遮罩重挂（无残留原子标记/崩溃）',
          after.value === 'X' && after.marks === 0 && after.activeIdx === 0, JSON.stringify(after));
      }
    } catch (e) {
      s49Push('S49 场景执行', false, String(e && e.message || e).slice(0, 120));
    }
  }

  // ---------- S50：有序列表 IME 输入（2026-10-16 用户截图「有序列表输入时会出现
  // 这种情况」：列表项被打散成每字一行的竖排 + 光标逃逸）。根因：WebView2 输入经
  // IPC 投递，WYSIWYG 防抖刷新（computeWysiwygBlocks+重挂遮罩）阻塞主线程时，幽灵
  // insertLineBreak（input 通道）可在 Enter keydown 后 300ms+ 才到达 → 原 300ms 守卫
  // 窗外泄漏 → 裸换行进模型、光标逃出列表，逐字+逐幽灵换行 = 每字一行。修复 = 守卫
  // 窗口 300→2000ms（editor-core + harness 同步）。本场景：IME 上屏 + 选字确认 Enter
  // + **400ms 延迟幽灵**（旧窗口必漏）→ 必须被吞、文档逐字成行不打散；普通 Enter
  // 续行不受影响（防过度吞除）。
  console.log('\n=== S50：有序列表输入幽灵换行（WebView2 IME 延迟幽灵） ===');
  {
    const s50Push = (label, ok, extra) => {
      const pass = !!ok;
      if (!pass) fail++;
      console.log(`  ${pass ? '✓' : '✗'} ${label}` + (extra !== undefined ? '  ' + extra : ''));
    };
    try {
      const setup = await page.evaluate(() => {
        const DOC = ['1. 第一项内容', '2. 第二项内容', '', '段落内容测试。'].join('\n');
        const { cm, ed } = window.__makeWysiwygEditor(DOC);
        ed.setWysiwygActiveBlock(0); // 列表块活动
        cm.setCursor(1, cm.getLine(1).length); // 第二项行尾
        cm.focus();
        window.__s50ed = ed;
        return { lines: cm.lineCount() };
      });
      s50Push('S50 初始化（有序列表 2 项 / 列表块活动）', !!setup && setup.lines === 4, JSON.stringify(setup));
      if (setup) {
        // ① Enter 列表续行 → "3. "（正常路径，防抖窗口前无 IME 上下文）
        await page.keyboard.press('Enter');
        await page.waitForTimeout(100);
        let v = await page.evaluate(() => window.__s50ed.cm.getValue());
        s50Push('Enter 列表续行 "3. "（正常路径）',
          v === '1. 第一项内容\n2. 第二项内容\n3. \n\n段落内容测试。', JSON.stringify(v));

        // ② IME 上屏 + 选字确认 Enter + 400ms 延迟幽灵 insertLineBreak（旧 300ms 窗口
        //    在此必漏 → 修复后必须吞）
        await page.evaluate(() => {
          const ed = window.__s50ed;
          const cm = ed.cm;
          const input = cm.getInputField();
          cm.replaceSelection('啊', 'end'); // IME 候选上屏（= compositionend 后 CM 读 DOM）
          input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '啊' }));
        });
        await page.keyboard.press('Enter'); // 选字确认 Enter（format.js 窗①应吞，不续行）
        await page.waitForTimeout(400); // 幽灵延迟 400ms 到达（> 旧窗口 300ms）
        const ghost = await page.evaluate(() => {
          const ed = window.__s50ed;
          const input = ed.cm.getInputField();
          const e = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertLineBreak', data: '\n' });
          input.dispatchEvent(e);
          if (!e.defaultPrevented) ed.cm.replaceSelection('\n', 'end', '+insert'); // 未吞 = 模拟 CM 读到 DOM 换行（泄漏路径）
          return { canceled: e.defaultPrevented };
        });
        await page.waitForTimeout(300);
        const s50a = await page.evaluate(() => {
          const ed = window.__s50ed;
          const cm = ed.cm;
          return { value: cm.getValue(), cursor: cm.getCursor(), activeIdx: ed._wysiwygActiveIdx };
        });
        s50Push('400ms 延迟幽灵换行被吞（旧 300ms 窗口在此泄漏）', ghost.canceled === true, JSON.stringify(ghost));
        // 逐项切块（2026-10-21）：光标在 "3. 啊" 行 = 第三项块（idx 2）活动
        s50Push('文档完好（无裸换行、光标留在 "3. 啊" 行、光标项块仍活动 idx 2）',
          s50a.value === '1. 第一项内容\n2. 第二项内容\n3. 啊\n\n段落内容测试。' &&
          s50a.cursor.line === 2 && s50a.cursor.ch === 4 && s50a.activeIdx === 2,
          JSON.stringify(s50a).slice(0, 200));

        // ③ 连续 IME 输入（每字后跟一个 400ms 延迟幽灵）→ 整行成文，不逐字打散
        for (const ch of ['手', '动', '阀']) {
          await page.evaluate((c) => {
            const ed = window.__s50ed;
            const input = ed.cm.getInputField();
            ed.cm.replaceSelection(c, 'end');
            input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: c }));
          }, ch);
          await page.keyboard.press('Enter');
          await page.waitForTimeout(400);
          await page.evaluate(() => {
            const ed = window.__s50ed;
            const input = ed.cm.getInputField();
            const e = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertLineBreak', data: '\n' });
            input.dispatchEvent(e);
            if (!e.defaultPrevented) ed.cm.replaceSelection('\n', 'end', '+insert');
          });
          await page.waitForTimeout(100);
        }
        const s50b = await page.evaluate(() => {
          const ed = window.__s50ed;
          const cm = ed.cm;
          return { value: cm.getValue(), cursor: cm.getCursor(), activeIdx: ed._wysiwygActiveIdx };
        });
        s50Push('连续 IME 输入 + 逐字延迟幽灵：列表项一行成文（修复前打散竖排每字一行）',
          s50b.value === '1. 第一项内容\n2. 第二项内容\n3. 啊手动阀\n\n段落内容测试。' &&
          s50b.cursor.line === 2 && s50b.cursor.ch === 7 && s50b.activeIdx === 2,
          JSON.stringify(s50b).slice(0, 200));

        // ④ 输入停顿后的普通 Enter 仍正常续行 "4. "（守卫不过度吞合法换行：
        //    距上次 compositionend 已 >250ms、距上次 Enter keydown 已 >150ms）
        await page.waitForTimeout(300);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(100);
        v = await page.evaluate(() => window.__s50ed.cm.getValue());
        s50Push('普通 Enter 仍续行 "4. "（守卫不过度吞除）',
          v === '1. 第一项内容\n2. 第二项内容\n3. 啊手动阀\n4. \n\n段落内容测试。', JSON.stringify(v));
      }
    } catch (e) {
      s50Push('S50 场景执行', false, String(e && e.message || e).slice(0, 120));
    }
  }

  // ---------- S51：有序/任务列表 编辑态 vs 渲染态 像素一致（2026-10-17 用户截图「点击
  // 有序列表进入编辑态时，数字会往右移动一点……任务列表也存在这个问题……保证编辑态和
  // 渲染态的样式完全一致」）。两处根因（探针像素实测）：
  // ① ol 序号槽 padding-right = 4.4px：右对齐锚点 = 56−4.4 = 51.6，落在渲染态原生 outside
  //    marker 锚点窗口（整墨迹 L1 扫描最优窗口 4.36–4.42px，6 个 preL 小数相位下不变）。4px → 数字整字偏右 1px。
  // ② 任务框 ::before left:-2ch 按等宽字口径估算「- 」宽，预览比例字体 2ch=17.25px ≠
  //    实宽 10.8px → 框左漂 6.4px；且「[x]」比「[ ]」宽 2.95px → 勾选行正文右漂 4px。
  //    修：bullet 字符进固定 24px 前缀槽（框画在槽左缘 32px）+「空格+[ ]」零宽槽
  //    （正文恒 56px）。⚠️ CM5 会按 token 拆装饰 span → 24px 类只能钉 bullet 单字符。
  // 断言 = 逐行像素剖面（截图→canvas→列墨迹计数）：序号墨迹右缘逐像素相等（Edge）、
// 「2」行左缘逐像素相等（Edge，其余左缘 Δ≤1px）、正文首墨 x Δ=0。
  console.log('\n=== S51：有序/任务列表 编辑态 vs 渲染态 像素一致 ===');
  {
    const s51Push = (label, ok, extra) => {
      const pass = !!ok;
      if (!pass) fail++;
      console.log(`  ${pass ? '✓' : '✗'} ${label}` + (extra !== undefined ? '  ' + extra : ''));
    };
    // 行区域列墨迹剖面：pre 左缘起 120px 宽（坐标原点=行内容基准 32px 所在 pre 左缘）
    const lineProfile = async (rect, thr) => {
      const clip = { x: Math.floor(rect.x), y: Math.floor(rect.y - 1), width: 120, height: Math.ceil(rect.h) + 2 };
      const shot = await page.screenshot({ clip });
      return page.evaluate((arg) => {
        const im = new Image();
        im.src = 'data:image/png;base64,' + arg.src;
        return new Promise((resolve) => {
          im.onload = () => {
            const W = im.width, H = im.height;
            const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
            const cx = cv.getContext('2d', { willReadFrequently: true });
            cx.drawImage(im, 0, 0);
            const d = cx.getImageData(0, 0, W, H).data;
            const prof = [];
            for (let x = 0; x < W; x++) {
              let ink = 0;
              for (let y = 0; y < H; y++) {
                const i = (y * W + x) * 4;
                if (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < arg.t) ink++;
              }
              prof.push(ink);
            }
            resolve(prof);
          };
          im.onerror = () => resolve([]);
        });
      }, { src: shot.toString('base64'), t: thr });
    };
    const inkRange = (prof, from, to) => {
      const c = [];
      for (let x = from; x < to && x < prof.length; x++) if (prof[x] > 0) c.push(x);
      return c.length ? [c[0], c[c.length - 1]] : null;
    };
    const textInkX = (prof) => { for (let x = 53; x < prof.length; x++) if (prof[x] > 0) return x; return null; };
    const near = (a, b, d) => a != null && b != null && Math.abs(a - b) <= d;
    try {
      // 逐行滚动→即时量 rect→截图（防 scrollIntoView 后陈旧坐标扫错行，探针 v2 教训）
      // 逐项切块（2026-10-21）：每项片段遮罩各含 1 个 li → 跨遮罩按文档序收集；
      // cx/cy = li 中心（驱动逐项点入编辑态用）
      const scanRenderLines = async () => page.evaluate(async () => {
        const ed = window.__s51ed;
        const nodes = [];
        ed._wysiwygMarks.forEach((mark) => {
          const node = mark && mark.replacedWith;
          if (node && (node.querySelector(':scope > ul') || node.querySelector(':scope > ol'))) nodes.push(node);
        });
        // 文档序：FOLLOWING=0x04（b 在 a 之后 → a 先）。⚠️ 曾误用 PRECEDING(0x02) 位 →
        // 逆序收集，点项 n 恒落镜像项（S46/S51 回归根因，2026-10-21 修）。
        nodes.sort((a, b) => (a.compareDocumentPosition(b) & 4) ? -1 : 1);
        const pre = nodes[0].closest('pre.CodeMirror-line');
        nodes[0].scrollIntoView({ block: 'center' });
        await new Promise((r) => setTimeout(r, 80));
        const pr = pre.getBoundingClientRect();
        const out = [];
        nodes.forEach((node) => {
          Array.from(node.querySelectorAll(':scope > ul > li, :scope > ol > li')).forEach((li) => {
            const b = li.getBoundingClientRect();
            out.push({
              x: pr.left, y: b.top, w: 120, h: b.height,
              cb: li.querySelector('input[type="checkbox"]') ? li.querySelector('input[type="checkbox"]').getBoundingClientRect().left - pr.left : null,
            });
          });
        });
        return out;
      });
      // 逐项切块（2026-10-21）：第 n 项片段遮罩中心——按**当前滚动位置**现算
      //（渲染态量得的坐标在后续滚动换位后已陈旧，直接复用会点空/点错项）。
      // 定位按**行号查块表**取对应遮罩（marks 按块索引为键）：不能对「过滤后的遮罩数组」
      // 按项号索引——活动项无遮罩，过滤数组缺项恒错位一项（点项 2 落到项 3，S51 回归根因
      // 之一；另一根因是文档序误用 PRECEDING 位致逆序，已修）。活动项（已解罩）兜底：
      // 点其源文行 pre 右缘 → CM 光标落行尾（与遮罩点击「光标落行尾」同口径，不污染墨迹）。
      const itemMaskPoint = async (n) => page.evaluate((lineNo) => {
        const ed = window.__s51ed;
        const cm = ed.cm;
        const blks = ed._wysiwygBlocks || [];
        const idx = blks.findIndex((b) => b.start <= lineNo && lineNo < b.end);
        let node = null;
        if (idx >= 0 && ed._wysiwygMarks) {
          const mk = ed._wysiwygMarks.get(idx);
          node = mk && mk.replacedWith;
        }
        let target = node, atRight = false;
        if (!target) {
          target = cm.getWrapperElement().querySelectorAll('pre.CodeMirror-line')[lineNo];
          atRight = true;
        }
        if (!target) return null;
        if (target.getBoundingClientRect().top > window.innerHeight) target.scrollIntoView({ block: 'center' });
        const r = target.getBoundingClientRect();
        if (atRight) return { x: r.x + r.width - 8, y: r.y + 8 };
        // x 取 60px（正文区）：避开行首复选框（点中会触发勾选，不是点入编辑）
        return { x: r.x + Math.min(60, r.width / 2), y: r.y + 8 };
      }, n);
      // 编辑态行几何：真实鼠标点该项遮罩 → 该行源文态 → 滚动居中 + 二次读 rect
      const clickItemAndRect = async (pt, n) => {
        await page.mouse.click(pt.x, pt.y);
        await page.waitForTimeout(150);
        await page.evaluate((lineNo) => {
          const pre = window.__s51ed.cm.getWrapperElement().querySelectorAll('pre.CodeMirror-line')[lineNo];
          pre.scrollIntoView({ block: 'center' });
        }, n);
        await page.waitForTimeout(60);
        return page.evaluate((lineNo) => {
          const pre = window.__s51ed.cm.getWrapperElement().querySelectorAll('pre.CodeMirror-line')[lineNo];
          const b = pre.getBoundingClientRect();
          return { x: b.left, y: b.top, w: 120, h: b.height };
        }, n);
      };
      const scanEditLines = async (count) => {
        const out = [];
        for (let i = 0; i < count; i++) {
          const r = await page.evaluate((n) => {
            const ed = window.__s51ed;
            const cm = ed.cm;
            const pre = cm.getWrapperElement().querySelectorAll('pre.CodeMirror-line')[n];
            pre.scrollIntoView({ block: 'center' });
            const b = pre.getBoundingClientRect();
            return { x: b.left, y: b.top, w: 120, h: b.height };
          }, i);
          await page.waitForTimeout(60);
          const r2 = await page.evaluate((n) => {
            const pre = window.__s51ed.cm.getWrapperElement().querySelectorAll('pre.CodeMirror-line')[n];
            const b = pre.getBoundingClientRect();
            return { x: b.left, y: b.top, w: 120, h: b.height };
          }, i);
          out.push(r2);
        }
        return out;
      };

      // ===== ① 有序列表：序号墨迹 + 正文起点 =====
      await page.evaluate(() => {
        const { ed } = window.__makeWysiwygEditor('1. 第一项内容\n2. 第二项内容\n3. 第三项内容');
        window.__s51ed = ed;
        ed.setWysiwygActiveBlock(-1); // 渲染态
      });
      await page.waitForTimeout(200);
      const olR = await scanRenderLines();
      const olRender = [];
      for (const r of olR) olRender.push(await lineProfile(r, 150));
      // 编辑态：逐项点遮罩 → 该行源文态（光标落行尾 = 正文右侧，不污染序号/正文墨迹）
      const olEdit = [];
      for (let i = 0; i < 3; i++) {
        const pt = await itemMaskPoint(i);
        if (!pt) { s51Push('S51 ol 第 ' + (i + 1) + ' 项遮罩未定位', false); olEdit.push([]); continue; }
        const r3 = await clickItemAndRect(pt, i);
        olEdit.push(await lineProfile(r3, 150));
      }
      const olOk = [];
      for (let i = 0; i < 3; i++) {
        const R = inkRange(olRender[i], 24, 52), E = inkRange(olEdit[i], 24, 52);
        // 2026-10-18 复测（padding-right 4.4px，锚点 = 51.6 ∈ 原生锚点窗口 4.36–4.42px）：右缘
        // （period 墨迹右列）与「2」行左缘（实心墨、无光标）须两态逐像素相等——4px 时「1/2」左缘恒 +1px（用户「数字会往右偏一点」）、
        // 5px 时恒 −1px（用户「往左移动一点」），宽松 Δ≤1 均漏判、严格逐行相等才捕获。「1」行（光标行底色使细笔 AA 移 ±1 列）与「3」左缘细尖（Y 相位跨阈值）留 Δ≤1。
        olOk.push(R && E && (isEdgeDriver ? E[1] === R[1] : near(R[1], E[1], 1)) &&
          ((i === 1 && isEdgeDriver) ? E[0] === R[0] : near(R[0], E[0], 1)) && textInkX(olRender[i]) === textInkX(olEdit[i]) && textInkX(olEdit[i]) !== null);
      }
      s51Push('有序序号墨迹 编辑态≡渲染态（右缘逐像素 +「2」行左缘逐像素；4px 时「1/2」左缘恒 +1px = 用户「往右偏一点」、5px 时 −1px =「往左移动一点」，严格相等均捕获）',
        olOk.every(Boolean),
        'render=' + olRender.map((p) => JSON.stringify(inkRange(p, 24, 52))).join(',') + ' edit=' + olEdit.map((p) => JSON.stringify(inkRange(p, 24, 52))).join(','));
      s51Push('有序正文首墨 x 两态相同（=56；槽宽恒 24px 保证）',
        olRender.every((p, i) => textInkX(p) === textInkX(olEdit[i])) && textInkX(olEdit[0]) === 56,
        'render=' + JSON.stringify(olRender.map(textInkX)) + ' edit=' + JSON.stringify(olEdit.map(textInkX)));

      // ===== ② 任务列表：复选框 + 正文起点（勾选/未勾选） =====
      await page.evaluate(() => {
        const { ed } = window.__makeWysiwygEditor('- [ ] 任务一内容\n- [x] 任务二内容\n- [ ] 任务三内容');
        window.__s51ed = ed;
        ed.setWysiwygActiveBlock(-1); // 渲染态
      });
      await page.waitForTimeout(200);
      const tkGeo = await scanRenderLines(); // 含 cb：渲染 input 左缘（相对 pre 左缘）
      const tkRender = [];
      for (const r of tkGeo) tkRender.push(await lineProfile(r, 150)); // 正文墨迹
      // ③ 用的**渲染态**纵向几何必须在此刻（遮罩还在）取：切到编辑态后遮罩被卸载，
      // _wysiwygMarks.get(0) 取不到 → TypeError。
      // 口径：框顶边 = input rect 顶；正文顶边 = 行内首个非空文本节点首行 rect 顶。
      // 该取值函数在页面上下文注册一次，渲染态/编辑态共用（避免两份拷贝漂移）。
      await page.evaluate(() => {
        window.__s51FirstTextTop = (root) => {
          const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          let n;
          while ((n = w.nextNode())) {
            if (!(n.textContent || '').trim()) continue;
            const r = document.createRange();
            r.selectNodeContents(n);
            const rects = r.getClientRects();
            if (rects.length) return rects[0].top;
          }
          return null;
        };
      });
      const tkVertRender = await page.evaluate(async () => {
        const ed = window.__s51ed;
        // 逐项切块（2026-10-21）：跨片段遮罩取第二个 li
        const nodes = [];
        ed._wysiwygMarks.forEach((mark) => {
          const node = mark && mark.replacedWith;
          if (node && (node.querySelector(':scope > ul') || node.querySelector(':scope > ol'))) nodes.push(node);
        });
        // 文档序：FOLLOWING=0x04（b 在 a 之后 → a 先）。⚠️ 曾误用 PRECEDING(0x02) 位 →
        // 逆序收集，点项 n 恒落镜像项（S46/S51 回归根因，2026-10-21 修）。
        nodes.sort((a, b) => (a.compareDocumentPosition(b) & 4) ? -1 : 1);
        const lis = [];
        nodes.forEach((node) => Array.from(node.querySelectorAll(':scope > ul > li, :scope > ol > li')).forEach((li) => lis.push(li)));
        const li = lis[1];
        li.scrollIntoView({ block: 'center' });
        await new Promise((r) => setTimeout(r, 60));
        const cb = li.querySelector('input[type="checkbox"]');
        return { box: cb.getBoundingClientRect().top, txt: window.__s51FirstTextTop(li) };
      });
      // 编辑态：逐项点遮罩 → 该行源文态。光标落行尾 = 正文右侧（框在行首 24px 槽），
      // 不污染框/正文墨迹（旧整块口径的光标放第 3 行问题同解）。
      const tkEditGeo = [];
      const tkSpans = [];
      const tkEdit = [];
      for (let i = 0; i < 3; i++) {
        const pt = await itemMaskPoint(i);
        if (!pt) { s51Push('S51 task 第 ' + (i + 1) + ' 项遮罩未定位', false); tkEditGeo.push({ x: 0, y: 0, w: 120, h: 0 }); tkEdit.push([]); tkSpans.push({ prefix: 0, zero: 0, slotL: null, slotW: null, textL: null }); continue; }
        const r3 = await clickItemAndRect(pt, i);
        tkEditGeo.push(r3);
        // ⚠️ 截图必须在本行仍为源文态时进行（下一轮点击会把本行重遮回渲染片段）
        tkEdit.push(await lineProfile(r3, 150));
        // DOM 守卫：每行恰一个 24px 前缀槽（CM5 token 拆分成两个槽 → 双框/正文跳 80）
        tkSpans.push(await page.evaluate((n) => {
          const pre = window.__s51ed.cm.getWrapperElement().querySelectorAll('pre.CodeMirror-line')[n];
          const sp = pre.querySelector('span.wysiwyg-task-prefix');
          const pr = pre.getBoundingClientRect();
          const t = pre.querySelector('span.wysiwyg-list-text');
          return {
            prefix: pre.querySelectorAll('span.wysiwyg-task-prefix').length,
            zero: pre.querySelectorAll('span.wysiwyg-task-box-zero').length,
            slotL: sp ? sp.getBoundingClientRect().left - pr.left : null,
            slotW: sp ? sp.getBoundingClientRect().width : null,
            textL: t ? t.getBoundingClientRect().left - pr.left : null,
          };
        }, i));
      }
      s51Push('任务行恰 1 个 24px 前缀槽 + ≥1 个零宽槽（CM5 按 token 拆分下 24px 类只钉 bullet）',
        tkSpans.every((s) => s.prefix === 1 && s.zero >= 1) && tkSpans.every((s) => near(s.textL, 56, 0.5)),
        JSON.stringify(tkSpans));
      // 勾选行：框填充墨迹（渲染 = input 绿底，编辑 = ::before 绿底）
      const R1 = inkRange(tkRender[1], 28, 52), E1 = inkRange(tkEdit[1], 28, 52);
      s51Push('任务复选框（勾选行）编辑态≡渲染态（Δ≤1px；修复前框左漂 6.4px）',
        near(R1 && R1[0], E1 && E1[0], 1) && near(R1 && R1[1], E1 && E1[1], 1),
        'render=' + JSON.stringify(R1) + ' edit=' + JSON.stringify(E1));
      // 未勾选行：渲染 input rect vs 编辑 24px 槽（槽左缘=框左缘、框宽 16px）
      for (const i of [0, 2]) {
        s51Push(`任务复选框（未勾选行${i + 1}）编辑 24px 槽 ≡ 渲染 input rect（Δ≤1px；修复前框左漂 6.4px）`,
          tkGeo[i].cb != null && near(tkSpans[i].slotL, tkGeo[i].cb, 1) && near(tkSpans[i].slotW, 24, 0.5),
          'render cb=' + tkGeo[i].cb + ' edit 槽=[' + tkSpans[i].slotL + ',' + (tkSpans[i].slotL + tkSpans[i].slotW) + ']');
      }
      s51Push('任务正文首墨 x 两态相同（逐行 Δ≤1；修复前勾选行右漂 4px）',
        tkRender.every((p, i) => near(textInkX(p), textInkX(tkEdit[i]), 1)),
        'render=' + JSON.stringify(tkRender.map(textInkX)) + ' edit=' + JSON.stringify(tkEdit.map(textInkX)));

      // ===== ③ 任务复选框**纵向**几何：编辑态≡渲染态（2026-10-18 用户「点击任务列表进入编辑态
      // 时左边的方框会往上移动」）。原 S51 只量横向 x，纵向偏移完全漏测（也因此该缺陷长期潜伏）。
      // 判据 = 「框顶边 − 同行正文顶边」，两态必须相等：
      //   · 用 DOM 几何（getBoundingClientRect + computed ::before top）而非像素扫描——扫描口径
      //     受 scrollIntoView 后陈旧 rect 影响，实测两态恒等（-2/-2）而漏判过真实 2px 偏移；
      //   · 编辑态框顶 = 槽 rect 顶 + computed ::before top（伪元素不在 rect 内）；
      //   · 两态同取「差值」，消掉行盒高度差（渲染 li 27.2px vs 编辑 pre 31.2~44.2px）。
      // 修复前实测（旧 top:0.3em=4.8px）：框顶−正文顶 编辑态 1.80px / 渲染态 4.00px，
      // 差 2.2px（= 4.8px 与 7px 之差），本断言判红；改 7px 后两态同为 4.00px。
      // 逐项切块（2026-10-21）：前缀槽只存在于源文态行 → 先点第 2 项遮罩
      const ptV = await itemMaskPoint(1);
      if (ptV) { await page.mouse.click(ptV.x, ptV.y); await page.waitForTimeout(150); }
      const tkVertGeo = await page.evaluate(() => {
        const ed = window.__s51ed;
        const pre = ed.cm.getWrapperElement().querySelectorAll('pre.CodeMirror-line')[1];
        pre.scrollIntoView({ block: 'center' });
        const slot = pre.querySelector('span.wysiwyg-task-prefix');
        const cs = getComputedStyle(slot, '::before');
        const body = pre.querySelector('span.wysiwyg-list-text') || pre;
        return {
          box: slot.getBoundingClientRect().top + parseFloat(cs.top || '0'),
          txt: window.__s51FirstTextTop(body),
        };
      });
      const tkBoxTopR = tkVertRender.box;
      const tkTxtTopR = tkVertRender.txt;
      const tkBoxTopE = tkVertGeo.box;
      const tkTxtTopE = tkVertGeo.txt;
      const tkVertOk = tkBoxTopR != null && tkBoxTopE != null && tkTxtTopR != null && tkTxtTopE != null &&
        Math.abs((tkBoxTopR - tkTxtTopR) - (tkBoxTopE - tkTxtTopE)) <= 0.5;
      s51Push('任务复选框纵向位置 编辑态≡渲染态（框顶−正文顶 两态相等 Δ≤0.5px；修复前编辑态框上浮 2.2px = 用户「方框往上移动」）',
        tkVertOk,
        'render=' + (tkBoxTopR - tkTxtTopR).toFixed(2) + ' edit=' + (tkBoxTopE - tkTxtTopE).toFixed(2));

      // ===== ⑤ 编辑态框样式 ≡ 渲染态（2026-10-15 用户「鼠标移到勾选框时显示小手；勾选前后样式
      // 与渲染态完全一致」）。渲染态 = input[checkbox]（appearance:none + 1.5px 边 + 3px 圆角 +
      // hover 变 success 边色 + 未勾选 opacity .7 + 0.15s transition + checked 对勾 5×9/2px）。
      // 编辑态 = 槽的 ::before/::after 复刻。逐像素判据：16×16 框区域逐列 min-lum 剖面（未勾选）
      // + 白墨最大连通域盒偏移 Δ≤1（勾选对勾）+ computed 口径相等（cursor/opacity/transition/hover）。
      // ⚠️ 每次截图同 scanRenderLines/scanEditLines 口径：先把被测框滚动到视口中央 → 等稳定 →
      // 即时取新 rect → 框周围 20×20 条带截图（clip 只依赖框坐标，不拼行盒 rect）。
      // 套件前面场景已把页面滚走，直接取 rect（可能为视口外负值）拼 clip 会让 16×16 采样区
      // 越界 → 整条剖面 NaN（2026-10-15 实测教训）。
      // 逐项切块（2026-10-21）：edit 态前缀槽只存在于源文态行 → pt = 该项遮罩中心，
      // 先点入再量（render 态 input 恒在遮罩内，pt 忽略）
      const box16 = async (idx, kind, pt) => {
        if (kind === 'edit' && pt) {
          await page.mouse.click(pt.x, pt.y);
          await page.waitForTimeout(150);
        }
        await page.evaluate(({ idx, kind }) => {
          const ed = window.__s51ed;
          const el = kind === 'render'
            ? ed.cm.getWrapperElement().querySelectorAll('.wysiwyg-block-mask input[type="checkbox"]')[idx]
            : ed.cm.getWrapperElement().querySelectorAll('pre.CodeMirror-line')[idx].querySelector('span.wysiwyg-task-prefix');
          el.scrollIntoView({ block: 'center' });
        }, { idx, kind });
        await page.waitForTimeout(120);
        const g = await page.evaluate(({ idx, kind }) => {
          const ed = window.__s51ed;
          if (kind === 'render') {
            const ir = ed.cm.getWrapperElement().querySelectorAll('.wysiwyg-block-mask input[type="checkbox"]')[idx].getBoundingClientRect();
            return { boxL: ir.left, boxT: ir.top };
          }
          const slot = ed.cm.getWrapperElement().querySelectorAll('pre.CodeMirror-line')[idx].querySelector('span.wysiwyg-task-prefix');
          const sr = slot.getBoundingClientRect();
          return { boxL: sr.left, boxT: sr.top + parseFloat(getComputedStyle(slot, '::before').top || '0') };
        }, { idx, kind });
        const clip = { x: Math.max(0, Math.floor(g.boxL) - 2), y: Math.max(0, Math.floor(g.boxT) - 2), width: 20, height: 20 };
        const shot = await page.screenshot({ clip });
        const b64 = shot.toString('base64');
        const px = await page.evaluate(async ({ b64, bx, by }) => {
          const im = new Image();
          im.src = 'data:image/png;base64,' + b64;
          await im.decode();
          const W = im.width, H = im.height;
          const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
          const cx = cv.getContext('2d'); cx.drawImage(im, 0, 0);
          const d = cx.getImageData(0, 0, W, H).data;
          const lum = (x, y) => { const i = (y * W + x) * 4; return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; };
          const x0 = Math.round(bx), y0 = Math.round(by);
          const colMin = [];
          for (let x = 0; x < 16; x++) {
            let m = 255;
            for (let y = 0; y < 16; y++) m = Math.min(m, lum(x0 + x, y0 + y));
            colMin.push(Math.round(m));
          }
          // 白墨：内区 [2,14)² 排除圆角外白底，取最大连通域 = 对勾
          const isW = (x, y) => x >= 2 && x < 14 && y >= 2 && y < 14 && lum(x0 + x, y0 + y) > 240;
          const seen = new Set(); let best = null;
          for (let x = 2; x < 14; x++) for (let y = 2; y < 14; y++) {
            if (seen.has(y * 16 + x) || !isW(x, y)) continue;
            const q = [[x, y]]; seen.add(y * 16 + x);
            let a = x, b = x, c = y, dd = y, n = 0;
            while (q.length) {
              const p = q.pop(); n++;
              if (p[0] < a) a = p[0]; if (p[0] > b) b = p[0];
              if (p[1] < c) c = p[1]; if (p[1] > dd) dd = p[1];
              for (const [dx2, dy2] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const nx = p[0] + dx2, ny = p[1] + dy2;
                if (seen.has(ny * 16 + nx) || !isW(nx, ny)) continue;
                seen.add(ny * 16 + nx); q.push([nx, ny]);
              }
            }
            if (!best || n > best.count) best = { lx: a, ty: c, w: b - a + 1, h: dd - c + 1, count: n };
          }
          return { colMin, white: best && best.count > 3 ? best : null };
        }, { b64, bx: g.boxL - clip.x, by: g.boxT - clip.y });
        return { boxL: g.boxL, boxT: g.boxT, px };
      };
      // —— 渲染态：computed 口径 + 16×16 框区域（行 0 未勾选 / 行 1 勾选）+ hover 边色 ——
      // 鼠标先归位视口左上角：滚动换位后旧鼠标点会压到新滚入中央的框上（:hover 变边色），
      // 未勾选剖面必须在**非 hover** 态采。
      await page.mouse.move(5, 5);
      await page.evaluate(() => window.__s51ed.setWysiwygActiveBlock(-1));
      await page.waitForTimeout(200);
      const tbRcs = await page.evaluate(() => {
        const ins = window.__s51ed.cm.getWrapperElement().querySelectorAll('.wysiwyg-block-mask input[type="checkbox"]');
        const csU = getComputedStyle(ins[0]), csC = getComputedStyle(ins[1]);
        return { cursor: csU.cursor, opU: csU.opacity, opC: csC.opacity, tr: csU.transition, borderU: csU.borderTopColor };
      });
      const tbR0 = await box16(0, 'render');
      await page.mouse.move(tbR0.boxL + 8, tbR0.boxT + 8);
      await page.waitForTimeout(300); // 等 0.15s transition 收敛
      const tbRHover = await page.evaluate(() =>
        getComputedStyle(window.__s51ed.cm.getWrapperElement().querySelectorAll('.wysiwyg-block-mask input[type="checkbox"]')[0]).borderTopColor);
      await page.mouse.move(5, 5); // 归位：box16(1) 滚动换位后旧鼠标点不得压到新框上
      const tbRBox = { u: tbR0.px, c: (await box16(1, 'render')).px };
      // —— 编辑态：computed 口径 + 16×16 框区域（框顶 = 槽顶 + ::before top）+ hover 边色 ——
      // 逐项切块（2026-10-21）：前缀槽只存在于源文态行 → 逐项点入现读；
      // 光标落点击行行尾（正文右侧），不污染行首 20×20 框区域
      const tbE0 = await box16(0, 'edit', await itemMaskPoint(0));
      const tbE0cs = await page.evaluate(() => {
        const slot = window.__s51ed.cm.getWrapperElement().querySelectorAll('pre.CodeMirror-line')[0].querySelector('span.wysiwyg-task-prefix');
        const csB = getComputedStyle(slot, '::before');
        return { cursor: getComputedStyle(slot).cursor, opU: csB.opacity, tr: csB.transition };
      });
      await page.mouse.move(tbE0.boxL + 8, tbE0.boxT + 8);
      await page.waitForTimeout(300); // 等 0.15s transition 收敛
      const tbEHover = await page.evaluate(() =>
        getComputedStyle(window.__s51ed.cm.getWrapperElement().querySelectorAll('pre.CodeMirror-line')[0].querySelector('span.wysiwyg-task-prefix'), '::before').borderTopColor);
      await page.mouse.move(5, 5); // 归位：box16(1) 滚动换位后旧鼠标点不得压到新框上
      const tbE1 = await box16(1, 'edit', await itemMaskPoint(1));
      const tbE1cs = await page.evaluate(() => {
        const slot = window.__s51ed.cm.getWrapperElement().querySelectorAll('pre.CodeMirror-line')[1].querySelector('span.wysiwyg-task-prefix');
        return { opC: getComputedStyle(slot, '::before').opacity };
      });
      const tbEcs = { cursor: tbE0cs.cursor, opU: tbE0cs.opU, opC: tbE1cs.opC, tr: tbE0cs.tr };
      const tbEBox = { u: tbE0.px, c: tbE1.px };
      s51Push('复选框编辑态小手光标 ≡ 渲染态（cursor:pointer；修复前编辑态槽为 text 光标）',
        tbRcs.cursor === 'pointer' && tbEcs.cursor === tbRcs.cursor,
        'render=' + tbRcs.cursor + ' edit=' + tbEcs.cursor);
      s51Push('复选框 hover 边框变色 ≡ 渲染态（→success 色；修复前编辑态无 hover 规则）',
        tbRHover !== tbRcs.borderU && tbRHover === tbEHover,
        'render=' + tbRHover + ' edit=' + tbEHover + ' (未 hover 时 ' + tbRcs.borderU + ')');
      s51Push('复选框未勾选 opacity ≡ 渲染态（0.7 淡化；修复前编辑态无淡化）+ transition 同参',
        tbEcs.opU === tbRcs.opU && tbEcs.opC === tbRcs.opC && tbEcs.tr === tbRcs.tr,
        'render op=' + tbRcs.opU + '/' + tbRcs.opC + ' edit op=' + tbEcs.opU + '/' + tbEcs.opC +
        ' transition=' + (tbEcs.tr === tbRcs.tr ? '一致' : 'render[' + tbRcs.tr + '] edit[' + tbEcs.tr + ']'));
      let profMax = 0;
      for (let x = 0; x < 16; x++) profMax = Math.max(profMax, Math.abs(tbRBox.u.colMin[x] - tbEBox.u.colMin[x]));
      s51Push('复选框未勾选框 16×16 墨迹剖面 编辑≡渲染（逐列 min-lum Δ≤6）',
        profMax <= 6, 'maxΔ=' + profMax);
      const tbCwOk = tbRBox.c.white && tbEBox.c.white &&
        near(tbRBox.c.white.lx, tbEBox.c.white.lx, 1) && near(tbRBox.c.white.ty, tbEBox.c.white.ty, 1) &&
        near(tbRBox.c.white.w, tbEBox.c.white.w, 1) && near(tbRBox.c.white.h, tbEBox.c.white.h, 1);
      s51Push('复选框对勾白墨盒 编辑≡渲染（框外缘相对偏移 Δ≤1px；修复前编辑态对勾高约 2px 且 1.5px 细笔）',
        !!tbCwOk, 'render=' + JSON.stringify(tbRBox.c.white) + ' edit=' + JSON.stringify(tbEBox.c.white));

      // ===== ④ 编辑态勾选（2026-10-18 用户「任务列表编辑态时，勾选框不能勾选」）：活动块里
      // 复选框是 .wysiwyg-task-prefix 的 ::before（无 DOM 节点），源文态此前**没有勾选入口**
      // （渲染态入口 = 遮罩内真 input[type=checkbox]）。修复 = wrapper capture mousedown 拦截
      // → _wysiwygToggleTaskLine 回写源码（与渲染态共用口径）→ change 钩子重挂 checked 装饰。
      // 真实鼠标点第 1 行框（非光标行，避免光标态干扰），验证源码字符/checked 类/正文落点；
      // 再点一次验证反向。槽位几何两态不变，两次点击同一点。
      // 逐项切块（2026-10-21）：先点第 1 项遮罩确保该行源文态（前缀槽才存在）
      const ptB = await itemMaskPoint(0);
      if (ptB) { await page.mouse.click(ptB.x, ptB.y); await page.waitForTimeout(150); }
      const boxPt = await page.evaluate(() => {
        const ed = window.__s51ed;
        const pre = ed.cm.getWrapperElement().querySelectorAll('pre.CodeMirror-line')[0];
        pre.scrollIntoView({ block: 'center' });
        const slot = pre.querySelector('span.wysiwyg-task-prefix');
        const r = slot.getBoundingClientRect();
        const top = parseFloat(getComputedStyle(slot, '::before').top || '0');
        return { x: r.left + 8, y: r.top + top + 8, src0: ed.cm.getLine(0) };
      });
      s51Push('编辑态勾选：点框前源码为未勾选态（场景前提）',
        boxPt.src0 === '- [ ] 任务一内容', 'src=' + JSON.stringify(boxPt.src0));
      await page.mouse.click(boxPt.x, boxPt.y);
      await page.waitForTimeout(150);
      const afterT1 = await page.evaluate(() => {
        const ed = window.__s51ed;
        const pre = ed.cm.getWrapperElement().querySelectorAll('pre.CodeMirror-line')[0];
        const slot = pre.querySelector('span.wysiwyg-task-prefix');
        const t = pre.querySelector('span.wysiwyg-list-text');
        const pr = pre.getBoundingClientRect();
        return {
          src: ed.cm.getLine(0),
          checked: slot ? slot.className.indexOf('checked') !== -1 : null,
          textL: t ? t.getBoundingClientRect().left - pr.left : null,
          cursor: ed.cm.getCursor(),
        };
      });
      s51Push('编辑态勾选：点框即回写源码 [ ]→[x] + checked 装饰刷新 + 光标落该行正文起点（修复前点框无勾选入口、光标落透明 bullet）',
        afterT1.src === '- [x] 任务一内容' && afterT1.checked === true &&
        afterT1.cursor.line === 0 && afterT1.cursor.ch === 6,
        'src=' + JSON.stringify(afterT1.src) + ' checked=' + afterT1.checked +
        ' cursor=' + JSON.stringify(afterT1.cursor));
      s51Push('编辑态勾选后正文落点不变（=56px；勾选态框宽不得漂移正文）',
        near(afterT1.textL, 56, 0.5), 'textL=' + afterT1.textL);
      await page.mouse.click(boxPt.x, boxPt.y);
      await page.waitForTimeout(150);
      const afterT2 = await page.evaluate(() => window.__s51ed.cm.getLine(0));
      s51Push('编辑态再点一次反勾 [x]→[ ]（双向可勾）',
        afterT2 === '- [ ] 任务一内容', 'src=' + JSON.stringify(afterT2));
    } catch (e) {
      s51Push('S51 场景执行', false, String(e && e.message || e).slice(0, 120));
    }
  }

  // ---------- S52：IME 组合文本落进「固定 24px 前缀槽」不得竖排（2026-10-18 真机 CDP dump 定位）。
  // 根因链（真机实测，Input.imeSetComposition 复现）：中文 IME 组合期浏览器把拼音插进光标处最近的
  // 文本容器。**空列表项**（`1. ` / `- [ ] ` 且正文为空）时该行没有可承载的文本节点，组合字符被并进
  // **固定 24px 的前缀槽**（.wysiwyg-ol-marker / .wysiwyg-task-prefix）；槽内容宽仅 19px 且继承行盒
  // pre-wrap → 逐字折行，marker 盒高 27.19 → 108.75px（=4 行），即用户截图「拼音竖排、字间有点」。
  // 有正文的行组合文本落在自动宽正文 span，从不进前缀槽 → 用户口径「先输点内容再打拼音就正常」。
  // ⚠️ 旧注释曾把成因写成零宽槽（.wysiwyg-ol-space）——2026-10-17 的 nowrap 改动因此无效
  // （真机实测：把 ol-space 加宽到 1px，marker 仍 108.75px 竖排）。本场景锚定真实落点。
  // 无头环境无真实 IME，直接向前缀槽文本节点塞组合文本（含 `'` 分隔符），布局行为与组合期一致。
  console.log('\n=== S52：IME 组合文本落入 24px 前缀槽不得竖排（ol-marker / task-prefix） ===');
  {
    const s52Push = (label, ok, extra) => {
      const pass = !!ok;
      if (!pass) fail++;
      console.log(`  ${pass ? '✓' : '✗'} ${label}` + (extra !== undefined ? '  ' + extra : ''));
    };
    try {
      const r = await page.evaluate(() => {
        const out = {};
        const COMP = "a's'd'f"; // 真实微软拼音组合串（含音节分隔符 `'`）
        const seed = (span, lineNode) => {
          const cs = getComputedStyle(span);
          const lineH0 = lineNode.getBoundingClientRect().height;
          // 模拟组合期：浏览器把组合文本作为文本节点插进该 24px 槽
          span.appendChild(document.createTextNode(COMP));
          const rect = span.getBoundingClientRect();
          return {
            nowrap: cs.whiteSpace === 'nowrap',
            // task-prefix 的盒高被 height:1.7em 钉住 → 取 scrollHeight 才能看出内容折了几行
            slotH: Math.max(rect.height, span.scrollHeight),
            lineH0,
            lineH2: lineNode.getBoundingClientRect().height,
          };
        };
        // ① 空有序列表项：组合文本落 .wysiwyg-ol-marker（真机 dump 实测落点）
        {
          const { cm, ed } = window.__makeWysiwygEditor('1. \n');
          window.__s52ed = ed;
          ed.setWysiwygActiveBlock(0);
          cm.setCursor(0, cm.getLine(0).length);
          cm.focus();
          const pre = cm.getWrapperElement().querySelector('pre.CodeMirror-line');
          const marker = pre && pre.querySelector('span.wysiwyg-ol-marker');
          if (!marker) return { olErr: '未找到 span.wysiwyg-ol-marker' };
          out.ol = seed(marker, pre);
        }
        // ② 任务行空项：组合文本落 .wysiwyg-task-prefix（同族固定 24px 槽）
        {
          const ed = window.__s52ed;
          ed.cm.setValue('- [ ] \n');
          ed.setWysiwygActiveBlock(0);
          ed.cm.setCursor(0, 0);
          ed.cm.focus();
          const pre = ed.cm.getWrapperElement().querySelector('pre.CodeMirror-line');
          const pfx = pre && pre.querySelector('span.wysiwyg-task-prefix');
          if (!pfx) return { ol: out.ol, tkErr: '未找到 span.wysiwyg-task-prefix' };
          out.tk = seed(pfx, pre);
        }
        return out;
      });
      if (r.olErr) { s52Push('OL 24px 前缀槽组合文本', false, r.olErr); }
      else if (r.ol) {
        s52Push('OL .wysiwyg-ol-marker 带 white-space:nowrap（固定 24px 槽不可换行）',
          r.ol.nowrap === true, 'nowrap=' + r.ol.nowrap);
        s52Push("OL 24px marker 槽内组合文本 \"a's'd'f\" 不竖排（盒高 ≤1.6 行高；修复前 108.75px = 4 行）",
          r.ol.slotH <= r.ol.lineH0 * 1.6,
          'slotH=' + r.ol.slotH.toFixed(2) + ' lineH=' + r.ol.lineH0.toFixed(2));
        s52Push('OL 行盒高不被组合文本撑高（修复前 27.19→108.75）',
          Math.abs(r.ol.lineH2 - r.ol.lineH0) < 1.5,
          'before=' + r.ol.lineH0.toFixed(2) + ' after=' + r.ol.lineH2.toFixed(2));
      }
      if (r.tkErr) { s52Push('任务 24px 前缀槽组合文本', false, r.tkErr); }
      else if (r.tk) {
        s52Push('任务 .wysiwyg-task-prefix 带 white-space:nowrap（同族修复）',
          r.tk.nowrap === true, 'nowrap=' + r.tk.nowrap);
        s52Push('任务 24px 前缀槽内组合文本不竖排（scrollHeight 27→82 修复）',
          r.tk.slotH <= r.tk.lineH0 * 1.6,
          'slotH=' + r.tk.slotH.toFixed(2) + ' lineH=' + r.tk.lineH0.toFixed(2));
      }
    } catch (e) {
      s52Push('S52 场景执行', false, String(e && e.message || e).slice(0, 120));
    }
  }

  // ---------- S53：空列表项 IME 上屏后 Enter 必须续行（2026-10-19 用户反馈「有序列表
  // 按回车没有新增一行，比如第一行是序号 1，行尾按回车，应该新增一行、序号是 2，但现在是直接
  // 跳出有序列表了」）。根因：空列表项（"1. " / "- " / "- [ ] "）是列表行里唯一「正文没有文本
  // 节点」的行（前缀槽固定 24px、源空格槽零宽），Chromium 把拼音组合串塞进前缀槽自己的文本节点
  // → 上屏后 CM 读 DOM 得到 "1.中国 "（分隔空格被挤到行尾）→ 不再是合法列表项
  // （continuelist 的 listRE 要求标记后必须有 \s）→ Enter 落到普通 newlineAndIndent = 退出列表。
  // 修复 = format.js _recordBareListMarkerForIme（组合前记下纯标记行）/ _repairImeDamagedListPrefix
  // （上屏后把丢掉的空格补回标记之后）。本场景驱动输入域原生 compositionstart/end（harness 已按
  // 生产接线挂好，调用的是 format.js 真实方法）+ 把模型置为损坏形态，断言修复结果与 Enter 续行。
  console.log('\n=== S53：空列表项 IME 上屏破坏前缀的修复（Enter 续行） ===');
  {
    const s53Push = (label, ok, extra) => {
      const pass = !!ok;
      if (!pass) fail++;
      console.log(`  ${pass ? '✓' : '✗'} ${label}` + (extra !== undefined ? '  ' + extra : ''));
    };
    // 驱动一次完整流程：建文档 → 组合开始 → 模型变损坏形态 → 组合结束 → 等修复 → 取模型
    const s53Drive = (doc, damaged) => page.evaluate(([d, bad]) => {
      const { cm, ed } = window.__makeWysiwygEditor(d);
      ed.setWysiwygActiveBlock(0);
      cm.setCursor(0, cm.getLine(0).length);
      cm.focus();
      window.__s53ed = ed;
      const input = cm.getInputField();
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'zhongguo' }));
      cm.setValue(bad);            // 模拟 IME 上屏后 CM 读 DOM 得到的损坏行
      cm.setCursor(0, cm.getLine(0).length);
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中国' }));
      return { value: cm.getValue() };
    }, [doc, damaged]);

    try {
      await s53Drive('1. ', '1.中国 ');
      await page.waitForTimeout(400);   // 修复轮询窗（80ms 一拍，上限 10 拍）
      const v1 = await page.evaluate(() => window.__s53ed.cm.getValue());
      s53Push('空 OL 项 IME 上屏后前缀被修回 "1. 中国"（修复前 "1.中国 "）',
        v1 === '1. 中国', JSON.stringify(v1));

      await page.keyboard.press('Enter');
      await page.waitForTimeout(300);
      const after1 = await page.evaluate(() => window.__s53ed.cm.getValue());
      s53Push('修复后 Enter 续出下一项 "2. "（修复前退出列表 → "\\n"）',
        after1 === '1. 中国\n2. ', JSON.stringify(after1));

      await s53Drive('1. 已有', '1.已有中国 ');
      await page.waitForTimeout(400);
      const v2 = await page.evaluate(() => window.__s53ed.cm.getValue());
      s53Push('有正文的 OL 项不被误改（该行组合串本就落在正文 span）',
        v2 === '1.已有中国 ', JSON.stringify(v2));

      await s53Drive('- ', '-中国 ');
      await page.waitForTimeout(400);
      const v3 = await page.evaluate(() => window.__s53ed.cm.getValue());
      s53Push('空 UL 项同样被修回 "- 中国"（该形态也不是合法列表项）',
        v3 === '- 中国', JSON.stringify(v3));

      // 关键防误伤：组合前该行**已有正文**（非纯标记行）→ format.js 不该动它。
      // 这里模拟「组合前是 '- abc'、上屏后模型被写成 '- abc中国 '」的形态，必须原样保留。
      const v3b = await page.evaluate(() => {
        const { cm, ed } = window.__makeWysiwygEditor('- abc');
        ed.setWysiwygActiveBlock(0);
        cm.setCursor(0, cm.getLine(0).length);
        cm.focus();
        window.__s53ed = ed;
        const input = cm.getInputField();
        input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: 'zhongguo' }));
        cm.setValue('- abc中国 ');
        cm.setCursor(0, cm.getLine(0).length);
        input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中国' }));
        return cm.getValue();
      });
      void v3b;
      await page.waitForTimeout(400);
      const v3b2 = await page.evaluate(() => window.__s53ed.cm.getValue());
      s53Push('组合前已有正文的 UL 项不被改动（非纯标记行 → 不记录、不修复）',
        v3b2 === '- abc中国 ', JSON.stringify(v3b2));

      await s53Drive('', '中国');
      await page.waitForTimeout(400);
      const v4 = await page.evaluate(() => window.__s53ed.cm.getValue());
      s53Push('普通段落不被误改', v4 === '中国', JSON.stringify(v4));
    } catch (e) {
      s53Push('S53 场景执行', false, String(e && e.message || e).slice(0, 120));
    }
  }

  // ---------- S54：块间间隙 = 阅读模式 + 点击行缝不出现新行（2026-10-17 用户两项要求） ----------
  {
    console.log('\n=== S54：WYSIWYG 块间间隙 ≡ 阅读模式 + 点击行缝不出现新行 ===');
    const s54Push = (label, ok, extra) => {
      const pass = !!ok;
      if (!pass) fail++;
      console.log(`  ${pass ? '✓' : '✗'} ${label}` + (extra !== undefined ? '  ' + extra : ''));
    };
    // ⚠️ 驱动顺序：A 全程（建/量/点/量）完成后再建 B——makeEditor 复用同一 host，
    // 建 B 会清掉 A 的 CM DOM（A 的点击坐标/遮罩随之失效）。
    const setupA = await page.evaluate(() => window.__gapClickA2026());
    if (setupA.err) {
      s54Push('S54 文档A 初始化', false, setupA.err);
    } else {
      // ① 间隙对齐：逐项切块（2026-10-21）后，同列表相邻项块间隙 = 4px（项间距，
      // 片段几何与整块遮罩逐像素等价），不同列表/块之间 = 14px（margin 折叠值）
      const wA = setupA.wysGaps, rA = setupA.readGaps;
      const pairsA = setupA.blocks || [];
      let intra = 0, inter = 0; const badGap = []; const interGaps = [];
      wA.forEach((g, i) => {
        if (g == null) return;
        const cont = pairsA[i] && pairsA[i + 1] && pairsA[i + 1][0] === pairsA[i][1]; // 同列表相邻项（行间无空行）
        if (cont) { intra++; if (Math.abs(g - 4) > 1) badGap.push(g); }
        else { inter++; interGaps.push(g); if (Math.abs(g - 14) > 1) badGap.push(g); }
      });
      const gapPairsRA = rA.filter((g) => g != null);
      s54Push('文档A：WYSIWYG 间隙 = 跨块 14px / 列表内项距 4px（逐项口径，= 整块遮罩的 li 间距）',
        intra >= 4 && inter >= 4 && badGap.length === 0,
        'intra=' + intra + ' inter=' + inter + ' bad=' + JSON.stringify(badGap) + ' wys=' + JSON.stringify(wA));
      s54Push('文档A：阅读模式同文档间隙全部 = 14px（对照口径）',
        gapPairsRA.length >= 4 && gapPairsRA.every((g) => Math.abs(g - 14) <= 1), JSON.stringify(rA));
      s54Push('文档A：WYSIWYG 跨列表间隙 ≡ 阅读模式间隙（逐对 Δ≤1px；列表内项距阅读态无对应物）',
        interGaps.length === gapPairsRA.length && interGaps.every((g, i) => Math.abs(g - gapPairsRA[i]) <= 1),
        'wys=' + JSON.stringify(interGaps) + ' read=' + JSON.stringify(gapPairsRA));
      // ② 点击行缝（文档A，14px mb 区）：不产生新行、不展开、无提示；光标落上一块
      if (setupA.click && setupA.click.x != null) {
        await page.evaluate((v) => { window.__gapClickAValue = v; }, setupA.value);
        await page.mouse.click(setupA.click.x, setupA.click.y);
        await page.waitForTimeout(300);
        const a = await page.evaluate(() => window.__gapClickA2026After());
        s54Push('文档A：点击行缝不产生新行（行数不变）且文档值不变',
          a.err == null && a.lineCount === setupA.lineCount && a.valueChanged === false,
          `lines=${setupA.lineCount}→${a.lineCount} ${a.err || ''}`);
        s54Push('文档A：点击行缝无「输入 / 可插入内容…」提示出现', a.err == null && (a.hints || 0) === 0, 'hints=' + a.hints);
        // 逐项切块（2026-10-21）：点击点（14px 缝中点）落在任务列表末项片段遮罩内
        //（末项保留 14px mb 折叠区）→ 光标落任务列表（行 1-2），非下方 ol
        s54Push('文档A：点击行缝光标落上一列表块内（遮罩接管，非空行；逐项后=任务列表行 1-2）',
          a.err == null && a.cursor && a.cursor.line >= 1 && a.cursor.line <= 2, JSON.stringify(a.cursor));
        // 2026-10-21 口径：相对间隙（活动块底→下一块顶）点击前后一致 = 解罩块高=遮罩高、
        // 块下内容不跳（绝对底缘对比会被点击引发的块间空行光标行塌回整体位移干扰）
        s54Push('文档A：S43 新口径——点击后相对间隙 = 点击前（Δ<0.5px，块下内容不跳）',
          a.err == null && a.gapNext2 != null && setupA.gapNext1 != null &&
          Math.abs(a.gapNext2 - setupA.gapNext1) < 0.5,
          `点击前=${setupA.gapNext1} 点击后=${a.gapNext2}`);
      } else {
        s54Push('文档A：行缝点击点未定位', false);
      }
    }
    // ③ 文档B（段落→标题，空行本体 X=10px 可点击）：点击空行 = 光标落空行但
    //    行不展开（无「新行」观感）、无提示、行数/值不变
    const setupB = await page.evaluate(() => window.__gapClickB2026());
    if (setupB.err) {
      s54Push('S54 文档B 初始化', false, setupB.err);
    } else {
      // 2026-10-21 口径：本场景光标落在块间空行（行 1，为保持无活动块所必需），
      // 空行按修订口径呈全高（光标行灰底同态）而非塌缩 X=10px → 间隙 = 段落 mb(14)
      // + 光标行全高(blankHBefore)，harness = 14+15=29（阅读模式 24 为无光标态基准）。
      // 无光标态的 WYSIWYG≡阅读模式 等价性由文档A [14,14,14,14] 断言守护。
      s54Push('文档B：WYSIWYG 间隙（光标在块间空行）= 段落 mb 14 + 光标行全高（2026-10-21 口径）',
        setupB.wysGap != null && setupB.blankHBefore != null && Math.abs(setupB.wysGap - (14 + setupB.blankHBefore)) <= 1,
        `wys=${setupB.wysGap} 期望=14+${setupB.blankHBefore}`);
      s54Push('文档B：阅读模式同口径 = 24px', setupB.readGap != null && Math.abs(setupB.readGap - 24) <= 1, 'read=' + setupB.readGap);
      if (setupB.click && setupB.click.x != null) {
        await page.evaluate((v) => { window.__gapClickBValue = v; }, setupB.value);
        await page.mouse.click(setupB.click.x, setupB.click.y);
        await page.waitForTimeout(300);
        const b = await page.evaluate(() => window.__gapClickB2026After());
        s54Push('文档B：点击空行本体不产生新行（行数不变）且文档值不变',
          b.err == null && b.lineCount === setupB.lineCount && b.valueChanged === false,
          `lines=${setupB.lineCount}→${b.lineCount} ${b.err || ''}`);
        s54Push('文档B：点击空行本体光标落到该空行（行本身，非新行）',
          b.err == null && b.cursor && b.cursor.line === 1, JSON.stringify(b.cursor));
        s54Push('文档B：空行点击后不产生新行、高度 <20px（光标行全高，2026-10-21 口径）且无提示',
          b.err == null && b.blankHAfter != null && b.blankHAfter < 20 && (b.hints || 0) === 0,
          `h=${setupB.blankHBefore}→${b.blankHAfter} hints=${b.hints}`);
      } else {
        s54Push('文档B：空行点击点未定位', false);
      }
    }
  }

  // ---------- S55：空任务项回车退出列表不得整页跳到文档顶（2026-10-18 真机用户反馈） ----------
  // 用户精确流程：① 末任务项（有文本）按回车 → 续出新空项；② 空项再按回车 → 列表退出
  //（标记移除）光标离开块 → 块重遮罩。修复前 _restoreWysiwygAnchor 在 operation 内
  // refresh → 行高计算错乱 → 垃圾 delta 过视口守卫 → scrollTo 负值被 operation 末钳到 0。
  {
    console.log('\n=== S55：空任务项回车退出列表（页面不得跳到文档顶） ===');
    const s55Push = (label, ok, extra) => {
      const pass = !!ok;
      if (!pass) fail++;
      console.log(`  ${pass ? '✓' : '✗'} ${label}` + (extra !== undefined ? '  ' + extra : ''));
    };
    const setup = await page.evaluate(() => window.__runEnterExit2026());
    if (setup.err) {
      s55Push('S55 初始化', false, setup.err);
    } else {
      // ① 末任务项（有文本）按回车 → 续出新空任务项
      await page.keyboard.press('Enter');
      await page.waitForTimeout(600);
      const m1 = await page.evaluate(() => window.__s55state());
      s55Push('末项按回车续出新空任务项（光标在新行、行 = "- [ ] "）',
        m1.err == null && m1.lastLine === '"- [ ] "', 'cursor=' + JSON.stringify(m1.cursor) + ' last=' + m1.lastLine);
      // ② 空项再按回车 → 列表退出（标记移除）→ 光标离开块 → 块重遮罩 → 锚点补偿
      await page.keyboard.press('Enter');
      await page.waitForTimeout(800); // 越过 setTimeout(0) 延迟补偿 + 250ms 块表防抖
      const m2 = await page.evaluate(() => window.__s55state());
      s55Push('空项按回车退出列表（末行标记移除 = 空行）', m2.err == null && m2.lastLine === '""', 'last=' + m2.lastLine);
      s55Push('退出后块恢复渲染态（activeIdx=-1）', m2.err == null && m2.activeIdx === -1, 'activeIdx=' + m2.activeIdx);
      s55Push('退出后页面不跳顶（scrollTop 未钳到 0 且位移 <150px）',
        m2.err == null && m2.scrollTop > 0 && Math.abs(m2.scrollTop - m1.scrollTop) < 150,
        `scrollTop=${m1.scrollTop}→${m2.scrollTop}`);
      s55Push('退出后光标仍在编辑器视口内（输入行可见，未被甩出视口）',
        m2.err == null && m2.cursorVisibleInWrapper === true, 'cursor=' + JSON.stringify(m2.cursor));
    }
  }

  // ---------- S56：标题输入字号稳定（2026-10-19 用户反馈 #2）+ 空行标题不得误遮 ----------
  // 根因①：IME 组合文本以裸文本节点进输入域 DOM、落在装饰 span 外 → 组合期按基准字号渲染；
  // 根因②：compositionend 后 CM5 readFromDOMSoon 80ms 才读 DOM → span 重挂再晚 80ms。
  // 修复：compositionstart 给 pre 挂类（基准字号抬到标题尺寸）+ compositionend 立即读 DOM。
  {
    console.log('\n=== S56：标题输入字号稳定（IME 组合期 + 上屏后立即重挂装饰） ===');
    const s56Push = (label, ok, extra) => {
      const pass = !!ok;
      if (!pass) fail++;
      console.log(`  ${pass ? '✓' : '✗'} ${label}` + (extra !== undefined ? '  ' + extra : ''));
    };
    for (const level of [1, 6]) {
      // harness --wysiwyg-text-size=16px → h1 正文 32px / h6 正文 14.4px / 基准 16px
      const targetFs = level === 1 ? '32px' : '14.4px';
      const st = await page.evaluate((lv) => window.__s56Start({ level: lv, doc: 'A' }), level);
      if (st.err) { s56Push(`S56 初始化 h${level}`, false, st.err); continue; }
      // ① 直输「# 」后标题文本已按标题尺寸（活动行装饰 span 生效）
      const p0 = await page.evaluate(() => window.__s56State());
      s56Push(`h${level}：直输「# 」后标题文本已按 ${targetFs} 显示（活动行装饰生效）`,
        p0.err == null && p0.lastGlyphFs === targetFs, `lastGlyph=${p0.lastGlyphFs}`);
      // ② IME 组合中：组合文本必须已是标题尺寸（挂类抬基准字号，无基准字号空帧）
      const i1 = await page.evaluate(() => window.__s56ImeStart('测试'));
      if (i1.err) { s56Push(`h${level} IME 组合`, false, i1.err); continue; }
      await page.waitForTimeout(120); // 留一帧让浏览器绘制组合期状态
      const p1 = await page.evaluate(() => window.__s56State());
      s56Push(`h${level}：组合期组合文本保持 ${targetFs}（不缩/胀到基准 16px）`,
        p1.err == null && p1.lastGlyphFs === targetFs, `lastGlyph=${p1.lastGlyphFs}`);
      s56Push(`h${level}：组合期 pre 挂 wysiwyg-ime-heading-${level}`,
        p1.err == null && p1.imeClass === `wysiwyg-ime-heading-${level}`, p1.imeClass || '(未挂类)');
      // ③ 上屏（compositionend+input）：模型立即拿到文本、装饰 span 同任务重挂（无 16px 空帧）
      const i2 = await page.evaluate(() => window.__s56ImeEnd('测试'));
      if (i2.err) { s56Push(`h${level} IME 上屏`, false, i2.err); continue; }
      const p2 = await page.evaluate(() => window.__s56State());
      s56Push(`h${level}：上屏后模型立即拿到组合文本（80ms 空窗消除）`,
        p2.err == null && p2.modelLine === JSON.stringify((level === 1 ? '# ' : '###### ') + '大标题' + '测试'),
        'model=' + p2.modelLine);
      s56Push(`h${level}：上屏后字号立即保持 ${targetFs}（装饰 span 同任务重挂）`,
        p2.err == null && p2.lastGlyphFs === targetFs, `lastGlyph=${p2.lastGlyphFs}`);
      s56Push(`h${level}：compositionend 后组合期类已摘（原 span 接管）`,
        p2.err == null && p2.imeClass == null, p2.imeClass || '类已摘 ✓');
      // ④ 防抖重切后：行仍是源码态、块仍活动、字号不变
      await page.waitForTimeout(450); // 越过 250ms 防抖重切
      const p3 = await page.evaluate(() => window.__s56State());
      s56Push(`h${level}：防抖重切后标题行仍源码态且活动（activeIdx=${st.line}）、字号不变`,
        p3.err == null && p3.isRealLine === true && p3.activeIdx === st.line && p3.lastGlyphFs === targetFs,
        `real=${p3.isRealLine} activeIdx=${p3.activeIdx} lastGlyph=${p3.lastGlyphFs}`);
    }
    // ⑤ 空行标题：两段落间空行直输「# 标题」→ 防抖重切后不得被误遮成渲染态
    //（修复前：新表索引撞旧 marks → 光标新块误判已遮罩 → 重遮、字号 16px→渲染尺寸跳变）
    for (const level of [1, 6]) {
      const b = await page.evaluate((lv) => window.__s56BlankRun(lv), level);
      if (b.err) { s56Push(`S56 空行标题 h${level} 初始化`, false, b.err); continue; }
      await page.waitForTimeout(450); // 越过 250ms 防抖重切
      const p = await page.evaluate(() => window.__s56State());
      s56Push(`空行标题 h${level}：重切后标题块保持源码态（未被误遮、块仍活动）`,
        p.err == null && p.isRealLine === true && p.activeIdx === 1,
        `real=${p.isRealLine} activeIdx=${p.activeIdx} model=${p.modelLine}`);
    }
  }

  // ---------- S57：用户三问文档（2026-10-20 真机截图：① 顶部 ul 进编辑态黑点左移
  //  ② 渲染态与阅读模式样式不一致 ③ 任务列表+下方 ul 编辑态多一空行）----------
  // doc = 真机原样 21 行（ul3/ol4/任务5+ul4 合并块）。回归点：
  //  ① 普通 ul 黑点改固定画圆（原生 disc 由引擎字体度量摆放，WebView2+DPI 缩放下相对
  //     固定画圆右漂约 2px → 遮罩→活动态黑点左移）→ 遮罩态/活动态 dot 必须同 x；
  //  ② 遮罩态 dot 与阅读模式 dot 同位，且顶部列表 dot 与任务混合列表 dot 同竖线
  //     （旧实现原生 disc 与固定圆两种机制在真机引擎上分叉）；
  //  ③ 块内空行（合并块行 14）活动态取 0 → 任务末行→ul 首行行距 = 遮罩/阅读 li 间距
  //     （旧实现走类默认 12px = 「ul 段上方多出来一行空白」）。
  {
    console.log('\n=== S57：用户三问文档（普通 ul 固定画圆 + 块内列表空行 0） ===');
    const s57Push = (label, ok, extra) => {
      const pass = !!ok;
      if (!pass) fail++;
      console.log(`  ${pass ? '✓' : '✗'} ${label}` + (extra !== undefined ? '  ' + extra : ''));
    };
    // dot 口径说明：布局级测量（li/span rect + ::before 计算值）——四态「同位」的对齐
    // 回归；像素级绘制（6px 圆、纵向 0.938em 锚、38–44px 区间）由 S45/S48 场景负责。
    // 激活走 setWysiwygActiveBlock + setCursor（S49 同款口径）：块活动后的装饰/遮罩
    // 状态与真实点击一致，而点击落位精度由 S44/S46 场景单独覆盖（且程序化激活无
    // 坐标竞态——遮罩物化存在 250ms 防抖，点击坐标在防抖窗口内会漂移）。
    const st = await page.evaluate(() => window.__s57setup());
    await page.waitForTimeout(450); // 遮罩物化（refresh + 250ms 块表防抖）后再量
    if (st.err) {
      s57Push('S57 文档初始化', false, st.err);
    } else {
      // 逐项切块（2026-10-21）：两个紧列表拆逐项块；任务+ul 合并块含空行（松散）→ 不拆
      s57Push('块表 = ul 逐项[0,1)[1,2)[2,3) + ol 逐项[4,5)…[7,8) + 任务+ul 松散合并块[9,19)（CommonMark：空行只松散、不拆块）',
        JSON.stringify(st.blocks) === JSON.stringify([[0, 1], [1, 2], [2, 3], [4, 5], [5, 6], [6, 7], [7, 8], [9, 19]]), JSON.stringify(st.blocks));
      // ① 遮罩态（初始光标在块间空行，三块全遮罩）：黑点布局左缘
      const mTop = await page.evaluate(() => window.__s57maskDot('ul', { li: 0 }));
      const mMerged = await page.evaluate(() => window.__s57maskDot('ul', { task: true, li: 5 }));
      const mGap = await page.evaluate(() => window.__s57mergedMaskGap());
      const rTop = await page.evaluate(() => window.__s57readDot('top'));
      const rMerged = await page.evaluate(() => window.__s57readDot('merged'));
      s57Push('遮罩态：顶部 ul 黑点为固定 6px 画圆（左缘 38–44px，32px 行基线 ul.x+6）',
        !!(mTop && mTop.w === 6 && mTop.left >= 38 && mTop.left <= 44), JSON.stringify(mTop));
      s57Push('遮罩态：顶部 ul 与任务混合列表普通项黑点同竖线（Δ≤0.5px，两种机制已统一为固定圆）',
        !!(mTop && mMerged && Math.abs(mMerged.left - mTop.left) <= 0.5),
        'top=' + (mTop && mTop.left) + ' merged=' + (mMerged && mMerged.left));
      s57Push('渲染态 ≡ 阅读模式：顶部列表黑点同位（Δ≤0.5px）',
        !!(mTop && rTop && Math.abs(rTop.left - mTop.left) <= 0.5),
        'mask=' + (mTop && mTop.left) + ' read=' + (rTop && rTop.left));
      s57Push('渲染态 ≡ 阅读模式：混合列表普通项黑点同位（Δ≤0.5px）',
        !!(mMerged && rMerged && Math.abs(rMerged.left - mMerged.left) <= 0.5),
        'mask=' + (mMerged && mMerged.left) + ' read=' + (rMerged && rMerged.left));
      // ② 激活顶部 ul（块 0）→ 活动态：黑点与遮罩态同位（真机旧实现此处左移约 2px）
      await page.evaluate(() => {
        window.__s57ed.setWysiwygActiveBlock(0);
        window.__s57cm.setCursor(0, 1);
        window.__s57cm.focus();
      });
      await page.waitForTimeout(450);
      const aTop = await page.evaluate(() => window.__s57activeDot(0));
      s57Push('编辑态：顶部 ul 黑点与遮罩态同位（Δ≤0.5px，不再「进编辑态左移」）',
        !!(aTop && mTop && Math.abs(aTop.left - mTop.left) <= 0.5),
        'mask=' + (mTop && mTop.left) + ' active=' + (aTop && aTop.left));
      // ③ 激活合并块（块 7 = 松散列表不拆、仍为单块，光标落 ul 段首行 15）：块内空行取 0 → 行距 = 遮罩/阅读
      await page.evaluate(() => {
        window.__s57ed.setWysiwygActiveBlock(7);
        window.__s57cm.setCursor(15, 1);
        window.__s57cm.focus();
      });
      await page.waitForTimeout(450);
      const g = await page.evaluate(() => window.__s57gaps());
      const aMerged = await page.evaluate(() => window.__s57activeDot(15));
      const rList = (st.lists || []).find((l) => (l.cls || '').indexOf('contains-task-list') !== -1);
      const readGap = rList ? rList.li4to5 : null;
      s57Push('编辑态：任务末行→ul 首行行距 = 遮罩态 li 间距（Δ≤1px，块内空行 0，不再多一行空白）',
        !!(g && mGap != null && Math.abs(g.gap13to15 - mGap) <= 1),
        `mask=${mGap} active=${g && g.gap13to15} 空行高=${g && g.line14h}`);
      s57Push('编辑态：任务末行→ul 首行行距 ≡ 阅读模式（Δ≤1px）',
        !!(g && readGap != null && Math.abs(g.gap13to15 - readGap) <= 1),
        `read=${readGap} active=${g && g.gap13to15}`);
      s57Push('编辑态：ul 段黑点与遮罩态同位（Δ≤0.5px）',
        !!(aMerged && mMerged && Math.abs(aMerged.left - mMerged.left) <= 0.5),
        'mask=' + (mMerged && mMerged.left) + ' active=' + (aMerged && aMerged.left));
      // ④ 光标进出块内空行（行 14）：进入=恢复全高（光标与提示需可见，inline 0px 必须清除）；
      //    离开=按间隙表恢复 0px。gap 表只在输入防抖重算，纯光标移动靠 cursorActivity 同步；
      //    CM 行高缓存由 250ms 防抖重建（含 refresh）刷新 → 等待越过防抖窗口。
      await page.evaluate(() => { window.__s57cm.focus(); window.__s57cm.setCursor(14, 0); });
      await page.waitForTimeout(450);
      const gIn = await page.evaluate(() => window.__s57gaps());
      s57Push('光标进入块内空行：行恢复全高（≥12px，inline 0px 已清除，光标与提示可见）',
        !!(gIn && gIn.line14h >= 12 && gIn.line14h < 40), 'line14h=' + (gIn && gIn.line14h));
      await page.evaluate(() => { window.__s57cm.setCursor(15, 1); });
      await page.waitForTimeout(450);
      const gOut = await page.evaluate(() => window.__s57gaps());
      s57Push('光标离开块内空行：按间隙表恢复 0px（与遮罩/阅读行距一致，不再多一行空白）',
        !!(gOut && gOut.line14h !== null && gOut.line14h < 1),
        'line14h=' + (gOut && gOut.line14h));
    }
  }

  // ---------- S58：行内标记零宽（2026-10-20 用户截图 demo.md：无序列表渲染态与编辑态差异巨大） ----------
  // 根因：活动态标记 span 旧为「透明保留宽度」（2026-10-14 设计）——每对 ** 留 14.6px
  // 空隙、token 密集行编辑态可见宽度远大于渲染态甚至被撑多折一行。修复：口径同
  // .wysiwyg-ol-space 零宽（inline-block + width:0 + nowrap）；字符仍在 DOM，光标测量
  // 与编辑语义不变（本场景 ④⑤ 钉住）。列表符号/任务前缀各有专槽，不受波及（③ 钉住）。
  // 2026-10-21 用户要求「光标行显示源码」后口径拆分：零宽只约束**非光标行**（渲染化
  // 外观），光标行标记恢复真宽+次级色（JS 行类 wysiwyg-inline-cursor-line 载体，光标
  // 跟随——S61 钉住；2026-07-13 起从 activeline addon 换载，选区期间不再丢源码）。
  {
    console.log('\n=== S58：行内标记零宽（渲染态 ≡ 编辑态可见宽度） ===');
    const s58Push = (label, ok, extra) => {
      const pass = !!ok;
      if (!pass) fail++;
      console.log(`  ${pass ? '✓' : '✗'} ${label}` + (extra !== undefined ? '  ' + extra : ''));
    };
    const r = await page.evaluate(async () => {
      // demo.md「软件特色功能速览」同款行（bold 密集 + 代码 token），松散列表
      const doc = ['# 富列表', '',
        '- ⚡ **极速轻量**：基于 Rust + Tauri v2（系统原生 WebView），安装包约 **7MB**、内存占用 **< 50MB**，双击一秒即开。',
        '  ',
        '- 👁️ **实时预览**：左边写、右边渲染，滚动自动同步，无需切换窗口。',
        '  ',
        '- 📐 快捷键按 `Ctrl+P` 打开。', '', '段落尾。'].join('\n');
      const { cm, ed } = window.__makeWysiwygEditor(doc);
      await new Promise((res) => setTimeout(res, 300));
      const out = {};
      // 遮罩态先行量（活动化会撤罩）：每 li 盒高 → 行数 = h/27.2
      out.maskLiH = Array.from(document.querySelectorAll('div.wysiwyg-block-mask ul li'))
        .map((li) => Math.round(li.getBoundingClientRect().height * 10) / 10);
      // ⚠️ 光标落行 6（行内代码项）而非行 2（2026-10-21 用户要求「光标行显示源码」后）：
      // 光标行标记恢复真宽+次级色（styles.css wysiwyg-inline-cursor-line 规则），行 2 作为
      // 非光标行才保持「零宽 ≡ 渲染态」口径（折行一致性断言的对象）；光标行可见性由
      // markerW6 与 S61 钉住。
      // ⚠️ 这里**故意**用 setCursor 直接落进遮罩（程序化路径，等价跳转行号）：光标被 CM
      // 钳到遮罩块末行（行 6），JS 行类按钳后的光标行号直挂（天然无误挂）；addon 的
      // 底色仍可能按视觉行误挂遮罩起始行，靠 wysiwyg.js 失步守卫重放选区自愈（守卫失效
      // 只影响底色条，不影响标记样式）。
      cm.setCursor(6, 1);
      ed.renderWysiwygMasks();
      cm.refresh();
      await new Promise((res) => setTimeout(res, 450)); // 装饰重挂 + 行高缓存刷新
      const preOf = (n) => {
        const h = cm.getLineHandle(n);
        for (const lv of cm.display.view) {
          if (lv && lv.line === h) {
            const el = lv.node;
            return el.tagName === 'PRE' ? el : (el.querySelector ? el.querySelector('pre.CodeMirror-line') : null);
          }
        }
        return null;
      };
      const pre2 = preOf(2);
      const pre6 = preOf(6);
      if (!pre2 || !pre6) return { err: '活动行 pre 未找到' };
      const mSpans = (pre) => Array.from(pre.querySelectorAll('span'))
        .filter((s) => String(s.className).includes('wysiwyg-inline-marker'));
      const w = (el) => Math.round(el.getBoundingClientRect().width * 100) / 100;
      const m2 = mSpans(pre2), m6 = mSpans(pre6);
      out.markerW = m2.map(w); // 行 2 = 非光标行 → 零宽口径
      out.markerW6 = m6.map(w); // 行 6 = 光标行 → 真宽口径（显示源码）
      out.boldW = (pre2.querySelector('.wysiwyg-bold') || { getBoundingClientRect: () => ({ width: 0 }) }).getBoundingClientRect().width;
      out.codeW = (pre6.querySelector('.wysiwyg-inline-code') || { getBoundingClientRect: () => ({ width: 0 }) }).getBoundingClientRect().width;
      const bullet = pre2.querySelector('.wysiwyg-list-bullet');
      out.bulletW = bullet ? w(bullet) : null;
      out.preH2 = Math.round(pre2.getBoundingClientRect().height * 10) / 10;
      // 编辑语义：光标进 ** 内插字 → 模型落字、粗体对数不变（行内 3 对 = 6 个 *）
      const before = cm.getLine(2);
      cm.setCursor(2, 8);
      cm.replaceRange('X', { line: 2, ch: 8 });
      await new Promise((res) => setTimeout(res, 400));
      const after = cm.getLine(2);
      out.edit = { inserted: after.slice(0, 13) === before.slice(0, 8) + 'X' + before.slice(8, 12),
        stars: (after.match(/\*/g) || []).length, beforeStars: (before.match(/\*/g) || []).length };
      // 光标坐标：零宽标记内（ch5 = 两 * 之间）与相邻文本（ch7）均有限
      const c1 = cm.cursorCoords({ line: 2, ch: 5 });
      const c2 = cm.cursorCoords({ line: 2, ch: 7 });
      out.caretFinite = !!(c1 && c2 && isFinite(c1.left) && isFinite(c2.left));
      return out;
    });
    if (r.err) {
      s58Push('S58 初始化', false, r.err);
    } else {
      s58Push('活动态非光标行行内标记 span 零宽（** / ` 不再留空隙）',
        !!(r.markerW || []).length && r.markerW.every((x) => x < 0.5),
        'maxW=' + Math.max(0, ...(r.markerW || [0])) + ' 个数=' + (r.markerW || []).length);
      s58Push('活动态光标行标记 span 恢复真宽（2026-10-21：光标行显示源码）',
        !!(r.markerW6 || []).length && r.markerW6.every((x) => x > 0.5),
        'minW=' + Math.min(99, ...(r.markerW6 || [99])) + ' 个数=' + (r.markerW6 || []).length);
      s58Push('文本段渲染化不受影响（bold / inline-code span 宽度 > 0）',
        !!(r.boldW > 20 && r.codeW > 20), 'bold=' + r.boldW + ' code=' + r.codeW);
      s58Push('列表符号不受波及（.wysiwyg-list-bullet 宽度保持 5–9px 真宽）',
        !!(r.bulletW != null && r.bulletW >= 5 && r.bulletW <= 9), 'bulletW=' + r.bulletW);
      // 折行一致性：长项（行 2，非块末行）活动态行数 = 遮罩 li 行数
      const linesOf = (h) => Math.max(1, Math.round((h - 4) / 27.2));
      s58Push('长项折行数活动态 ≡ 渲染态（不再被标记宽撑多折行）',
        !!(r.preH2 != null && r.maskLiH && r.maskLiH[0] != null &&
          linesOf(r.preH2) === Math.max(1, Math.round(r.maskLiH[0] / 27.2))),
        'activePreH=' + r.preH2 + ' maskLiH=' + (r.maskLiH || [])[0]);
      s58Push('编辑语义：标记内插字落模型、* 计数不变',
        !!(r.edit && r.edit.inserted && r.edit.stars === r.edit.beforeStars),
        JSON.stringify(r.edit));
      s58Push('光标坐标：零宽标记内/相邻文本均有限', r.caretFinite === true);
    }
  }

  // ---------- S59：引用块活动态 = 渲染态几何复现 + > 只在光标行（2026-10-20 用户要求） ----------
  // 渲染 blockquote = 淡色盒（accent-subtle）+ 连续 4px accent 左竖条 + 每层 24px 缩进
  // （border 4 + padding 20）+ 次级色正文 + 盒 padding 12/12。活动态逐行复现：
   // 每层 "> "（> 连同其后空格进槽，不得零宽单独成 span——行尾 caret 锚定写乱模型，
   // 见 JS 注释）→ 24px 槽（竖条画槽 ::before，逐行顶满 = 连续）；
  // > 字符默认透明，仅光标行可见（cursorActivity 管理）。
  // 底缘口径：遮罩节点高 = 渲染盒高 + 16（盒自身 margin-bottom 16 被遮罩 BFC 内收；
  // 有「编辑」按钮占 last-child 位，> *:last-child 清零不命中盒）→ 活动态末行
  // padding-bottom 28px（12 盒 padB + 16）逐像素对齐遮罩底缘（嵌套末行 40px）。
  // 已知残差（如实声明）：渲染软换行会把多个源行并进一个 <p>（源 2 行可渲染成 1 行），
  // 活动态逐源行渲染 → 底缘残差 = 行数差×27.2（0 或 1 行高），容差 27.5。
  // 顶缘/正文 x 用文档 A 上方放段落锚定块（两态等高）而非标题（标题块两态高度本就
  // 不同，与引用无关）；所有纵向坐标为 scroller 相对（文档空间）。
  {
    console.log('\n=== S59：引用块活动态 = 渲染态 + > 只在光标行 ===');
    const s59Push = (label, ok, extra) => {
      const pass = !!ok;
      if (!pass) fail++;
      console.log(`  ${pass ? '✓' : '✗'} ${label}` + (extra !== undefined ? '  ' + extra : ''));
    };
    const r = await page.evaluate(async () => {
      // ⚠️ 所有纵向坐标用当前编辑器 scroller 相对（文档空间）：setCursor 自动滚动会
      // 污染视口 y（2026-10-20 实测：同一行 pre 的视口 top 遮罩态/活动态差 10px = 滚动量）；
      // 页面上有多个编辑器，scroller 必须限定在当前 cm 的 wrapper 内
      let curSc = null;
      const setSc = (cm) => { curSc = cm.getWrapperElement().querySelector('.CodeMirror-scroll'); };
      const docY = (el) => el.getBoundingClientRect().y - curSc.getBoundingClientRect().y + curSc.scrollTop;
      const docBottom = (el) => el.getBoundingClientRect().bottom - curSc.getBoundingClientRect().y + curSc.scrollTop;
      // 文档 A：简单引用（2 源行）——上方段落锚定块（两态等高）；目标 = 遮罩节点
      //（= 渲染盒 + BFC 内收的 16px 盒 mb）
      const docA = ['段落锚定文字，上方块两态等高。', '', '> 第一行引用文字，测试样式对齐。', '> 第二行引用，继续对齐检查。'].join('\n');
      const a = {};
      {
        const { cm, ed } = window.__makeWysiwygEditor(docA);
        setSc(cm);
        await new Promise((res) => setTimeout(res, 300));
        const bq = document.querySelector('div.wysiwyg-block-mask blockquote');
        const maskNode = bq ? bq.closest('div.wysiwyg-block-mask') : null;
        const p = bq ? bq.querySelector('p') : null;
        let firstCharX = null;
        if (p && p.firstChild) {
          const rg = document.createRange();
          rg.setStart(p.firstChild, 0); rg.setEnd(p.firstChild, 1);
          firstCharX = rg.getBoundingClientRect().x;
        }
        a.mask = { boxTop: maskNode ? +docY(maskNode).toFixed(1) : null, boxH: maskNode ? +maskNode.getBoundingClientRect().height.toFixed(1) : null, firstCharX: firstCharX != null ? +firstCharX.toFixed(1) : null };
        a.subtle = getComputedStyle(bq).backgroundColor;
        cm.setCursor(2, 1);
        ed.renderWysiwygMasks();
        cm.refresh();
        await new Promise((res) => setTimeout(res, 450));
        const preOf = (n) => {
          const h = cm.getLineHandle(n);
          for (const lv of cm.display.view) {
            if (lv && lv.line === h) {
              const el = lv.node;
              return el.tagName === 'PRE' ? el : (el.querySelector ? el.querySelector('pre.CodeMirror-line') : null);
            }
          }
          return null;
        };
        const p2 = preOf(2), p3 = preOf(3);
        if (!p2 || !p3) return { err: 'A 活动行 pre 未找到' };
        const textX = (pre) => {
          const t = pre.querySelector('.wysiwyg-quote-text');
          return t ? t.getBoundingClientRect().x : null;
        };
        const slotColor = (pre) => {
          const s = pre.querySelector('[class*="wysiwyg-quote-slot"]');
          return s ? getComputedStyle(s).color : null;
        };
        const barOf = (pre) => {
          const s = pre.querySelector('[class*="wysiwyg-quote-slot"]');
          if (!s) return null;
          const cs = getComputedStyle(s, '::before');
          const sr = s.getBoundingClientRect();
          return { x: +(sr.x).toFixed(1), w: cs.width, top: cs.top, h: cs.height, bg: cs.backgroundColor };
        };
        const segOf = (cls) => {
          const n = cm.getWrapperElement().querySelector('.wysiwyg-quote-seg-' + cls);
          if (!n) return null;
          const nr = n.getBoundingClientRect();
          return { top: +docY(n).toFixed(1), h: +nr.height.toFixed(1), x: +nr.x.toFixed(1) };
        };
        const preBg = getComputedStyle(p2).backgroundColor;
        const preBgImage = getComputedStyle(p2).backgroundImage;
        // 2026-10-25 分段口径：激活后 = 光标行 2 源码（首行，> 槽可见）+ 行 3 下段渲染遮罩。
        // 非光标行不再是源码 pre（无 .wysiwyg-quote-slot）——它被 seg-bottom widget 替换。
        a.active = {
          preTop: +docY(p2).toFixed(1),
          blockBottom: segOf('bottom') ? +docBottom(cm.getWrapperElement().querySelector('.wysiwyg-quote-seg-bottom')).toFixed(1) : +docBottom(p3).toFixed(1),
          textX: textX(p2), slotColor2: slotColor(p2), slotColor3: slotColor(p3),
          bar2: barOf(p2), bar3: barOf(p3), preBg, preBgImage,
          preCls: p2.className,
          segBot: segOf('bottom'),
          hasSegTop: !!segOf('top'),
          segBotHasBlockquote: !!cm.getWrapperElement().querySelector('.wysiwyg-quote-seg-bottom blockquote'),
        };
        // 光标移到行 3（setCursor → cursorActivity → sync → 分段重划：行3 成光标行源码、
        // 行2 成上段渲染遮罩——分段点击映射已由 S83 专测，这里验证程序化光标移动同样收敛）
        cm.focus();
        cm.setCursor(3, 2);
        await new Promise((res) => setTimeout(res, 300));
        a.swap = { slot2: slotColor(preOf(2)), slot3: slotColor(preOf(3)), segTop: !!cm.getWrapperElement().querySelector('.wysiwyg-quote-seg-top'), segBot: !!cm.getWrapperElement().querySelector('.wysiwyg-quote-seg-bottom') };
        // 离开块（上方段落，块恢复遮罩）再重进（光标落行 3）：旧光标行 2 的 > 必须已清、
        // 仅新光标行 3 显示（cursorActivity 的 prev/next 差分 + 行类挂行对象不随遮罩重渲丢失）
        cm.setCursor(0, 1);
        await new Promise((res) => setTimeout(res, 450));
        cm.focus();
        cm.setCursor(3, 2);
        await new Promise((res) => setTimeout(res, 300));
        const lp2 = preOf(2), lp3 = preOf(3);
        a.left = lp2 && lp3 ? { slot2: slotColor(lp2), slot3: slotColor(lp3) } : { err: '重进后 pre 未找到' };
        // 编辑语义：删掉行 2 的 "> " → 该行退出引用（250ms 防抖后行类撤除）
        cm.setCursor(2, 0);
        cm.replaceRange('', { line: 2, ch: 0 }, { line: 2, ch: 2 });
        await new Promise((res) => setTimeout(res, 600));
        const p2b = preOf(2);
        a.dequote = {
          line: cm.getLine(2).slice(0, 8),
          preCls: p2b ? p2b.className : null,
          bg: p2b ? getComputedStyle(p2b).backgroundColor : null,
        };
      }
      // 文档 B：嵌套引用——双层竖条 + 二层正文缘 x
      const docB = ['# 引用', '', '> 第一行引用文字，测试样式对齐。', '> 第二行引用，继续对齐检查。', '> > 嵌套引用行。', '', '段落尾。'].join('\n');
      const b = {};
      {
        const { cm, ed } = window.__makeWysiwygEditor(docB);
        await new Promise((res) => setTimeout(res, 300));
        const bq = document.querySelector('div.wysiwyg-block-mask blockquote');
        const maskNode = bq ? bq.closest('div.wysiwyg-block-mask') : null;
        const br = bq ? bq.getBoundingClientRect() : null;
        const p = bq ? bq.querySelector('p') : null;
        const nb = bq ? bq.querySelector('blockquote') : null;
        const firstCharX = (el) => {
          if (!el || !el.firstChild) return null;
          const rg = document.createRange();
          rg.setStart(el.firstChild, 0); rg.setEnd(el.firstChild, 1);
          return +rg.getBoundingClientRect().x.toFixed(1);
        };
        b.mask = {
          boxTop: maskNode ? +docY(maskNode).toFixed(1) : null, boxH: maskNode ? +maskNode.getBoundingClientRect().height.toFixed(1) : null,
          textX1: firstCharX(p), textX2: firstCharX(nb && nb.querySelector('p')),
          innerTextX: firstCharX(nb && nb.querySelector('p')),
        };
        cm.setCursor(2, 1);
        ed.renderWysiwygMasks();
        cm.refresh();
        await new Promise((res) => setTimeout(res, 450));
        const preOf = (n) => {
          const h = cm.getLineHandle(n);
          for (const lv of cm.display.view) {
            if (lv && lv.line === h) {
              const el = lv.node;
              return el.tagName === 'PRE' ? el : (el.querySelector ? el.querySelector('pre.CodeMirror-line') : null);
            }
          }
          return null;
        };
        const textX = (pre) => {
          const t = pre.querySelector('.wysiwyg-quote-text');
          return t ? +t.getBoundingClientRect().x.toFixed(1) : null;
        };
        const p2 = preOf(2), p4 = preOf(4);
        if (!p2) return { err: 'B 活动行 pre 未找到' };
        // 2026-10-25 分段口径：B 激活后光标行 2 源码；行 4（嵌套行）为 seg-bottom 渲染遮罩——
        // 块底取 seg-bottom widget 底（源码 preOf(4) 已被替换，无法作几何基准）
        const segBottom = cm.getWrapperElement().querySelector('.wysiwyg-quote-seg-bottom');
        const segInner = segBottom ? segBottom.querySelector('blockquote > blockquote') : null;
        const segInnerP = segInner && segInner.querySelector('p');
        b.active = {
          preTop: +docY(p2).toFixed(1),
          blockBottom: segBottom ? +docBottom(segBottom).toFixed(1) : +docBottom(p4).toFixed(1),
          textX1: textX(p2),
          segHasBottom: !!segBottom,
          innerTextX: segInnerP ? +segInnerP.getBoundingClientRect().x.toFixed(1) : null,
          innerBorder: segInner ? getComputedStyle(segInner).borderLeftWidth : null,
          innerX: segInner ? +segInner.getBoundingClientRect().x.toFixed(1) : null,
        };
      }
      return { a, b };
    });
    if (r.err) {
      s59Push('S59 初始化', false, r.err);
    } else {
      const A = r.a, B = r.b;
      // —— 文档 A：几何 ——
      s59Push('A 顶缘对齐：活动块首行顶 = 遮罩节点顶（Δ≤1px，文档空间）',
        !!(A.active.preTop != null && A.mask.boxTop != null && Math.abs(A.active.preTop - A.mask.boxTop) <= 1),
        `mask=${A.mask.boxTop} active=${A.active.preTop}`);
      s59Push('A 正文缘 x ≡ 渲染内容缘（Δ≤1px，= 行基准+24px）',
        !!(A.active.textX != null && A.mask.firstCharX != null && Math.abs(A.active.textX - A.mask.firstCharX) <= 1),
        `mask=${A.mask.firstCharX} active=${A.active.textX}`);
      // 2026-10-28 S86：光标行底色 = 渲染盒单层同构 2 层背景（竖条+底色、透明 bg）——
      // 兼容旧平色口径（preBg === subtle）与新渐变口径（2 层 linear-gradient）
      s59Push('A 淡色背景盒：活动行 pre 背景 = 渲染盒背景（accent-subtle 平色或 S86 同构 2 层背景）',
        !!(A.subtle && (A.active.preBg === A.subtle
          || ((A.active.preBg === 'rgba(0, 0, 0, 0)') && (A.active.preBgImage.match(/linear-gradient/g) || []).length === 2))),
        `active=${A.active.preBg}/${(A.active.preBgImage || '').slice(0, 40)} mask=${A.subtle}`);
      const barOk = (bar) => !!(bar && bar.w === '4px' && bar.top === '0px' && bar.x >= 31.5 && bar.x <= 32.5);
      s59Push('A 光标行竖条：4px 连续竖条（x=32，top:0/满高；非光标行 = 渲染遮罩无槽）',
        barOk(A.active.bar2) && A.active.bar3 == null,
        JSON.stringify({ b2: A.active.bar2, b3: A.active.bar3 }));
      // 底缘容差（渲染软换行可把 2 源行并 1 行：残差 = 1 行高 27.2；目标含 BFC 内收 16px）
      s59Push('A 底缘残差有界（|活动底 − 遮罩底| ≤ 27.5px：0 或软换行并行的 1 行高）',
        !!(A.active.blockBottom != null && A.mask.boxTop != null && A.mask.boxH != null &&
          Math.abs(A.active.blockBottom - (A.mask.boxTop + A.mask.boxH)) <= 27.5),
        `active底=${A.active.blockBottom} 遮罩底=${A.mask.boxTop != null && A.mask.boxH != null ? +(A.mask.boxTop + A.mask.boxH).toFixed(1) : null}`);
      // —— > 只在光标行（2026-10-25 分段口径：非光标行 = 渲染遮罩，无 > 槽；仅光标行源码）——
      s59Push('A 分段：激活后非光标行（行3）渲染遮罩（seg-bottom + blockquote）、光标行（行2）源码 > 显色',
        !!(A.active.slotColor2 && A.active.slotColor2 !== 'rgba(0, 0, 0, 0)'
          && A.active.slotColor3 == null && A.active.segBot && A.active.hasSegTop === false),
        JSON.stringify({ slot2: A.active.slotColor2, slot3: A.active.slotColor3, segBot: !!A.active.segBot }));
      s59Push('A 光标移到行3：行3 成光标行（源码 > 显色）、行2 成上段渲染遮罩（seg-top 出现）',
        !!(A.swap && A.swap.slot3 && A.swap.slot3 !== 'rgba(0, 0, 0, 0)' && A.swap.slot2 == null && A.swap.segTop === true),
        JSON.stringify(A.swap));
      s59Push('A 离开块再重进（光标行3）：新光标行3 源码 > 显色、分段遮罩（行2 上段 / 无下段）正常',
        !!(A.left && !A.left.err && A.left.slot3 && A.left.slot3 !== 'rgba(0, 0, 0, 0)'),
        JSON.stringify(A.left));
      s59Push('A 编辑语义：删掉行首 "> " 后该行退出引用（行类撤除、背景消失）',
        !!(A.dequote && A.dequote.line.indexOf('>') !== 0 && A.dequote.preCls &&
          A.dequote.preCls.indexOf('wysiwyg-quote-line') === -1 &&
          (A.dequote.bg === 'rgba(0, 0, 0, 0)' || A.dequote.bg === 'transparent')),
        JSON.stringify(A.dequote));
      // —— 文档 B：嵌套 ——
      s59Push('B 顶缘对齐：活动块首行顶 = 渲染盒顶（Δ≤1px，文档空间）',
        !!(B.active.preTop != null && B.mask.boxTop != null && Math.abs(B.active.preTop - B.mask.boxTop) <= 1),
        `mask=${B.mask.boxTop} active=${B.active.preTop}`);
      // B 底缘：2026-10-25 口径修正——接缝规则改子选择器（嵌套盒 padT 12 保留）后，
      // 残差 = 光标行拆出 1 源行（渲染软换行把行 2-3 并 1 段）= 1 行高 27.2，与 A 同模型
      s59Push('B 底缘残差有界（|活动底 − 遮罩底| ≤ 27.5px：光标行拆行残差，0 或 1 行高）',
        !!(B.active.blockBottom != null && B.mask.boxTop != null && B.mask.boxH != null &&
          Math.abs(B.active.blockBottom - (B.mask.boxTop + B.mask.boxH)) <= 27.5),
        `active底=${B.active.blockBottom} 遮罩底=${B.mask.boxTop != null && B.mask.boxH != null ? +(B.mask.boxTop + B.mask.boxH).toFixed(1) : null}`);
      s59Push('B 嵌套：一层正文缘 ≡ 渲染（Δ≤1px，光标行源码）',
        !!(B.active.textX1 != null && B.mask.textX1 != null && Math.abs(B.active.textX1 - B.mask.textX1) <= 1),
        `mask=${B.mask.textX1} active=${B.active.textX1}`);
      s59Push('B 嵌套：非光标行（行4 嵌套）渲染遮罩（seg-bottom 存在，内层 blockquote 与渲染同构）',
        !!(B.active.segHasBottom && B.active.innerTextX != null && B.mask.innerTextX != null
          && Math.abs(B.active.innerTextX - B.mask.innerTextX) <= 2),
        JSON.stringify({ segInnerX: B.active.innerTextX, maskInnerX: B.mask.innerTextX }));
      s59Push('B 嵌套竖条：渲染遮罩内层 blockquote 左 border-left-width 4px（与渲染 border 同位）',
        !!(B.active.innerBorder === '4px'),
        B.active.innerBorder);
    }
    // —— 文档 C：CJK 输入回归（2026-10-20 实测：行尾零宽 span 让 Chromium caret 锚定
    // 写乱 contenteditable DOM 差分，"> " 续行键入 CJK 后源空格被挤到行尾、模型变
    // ">继续内容 "；空格随 > 进 24px 槽后行尾 caret 锚定稳定，必须走真实键盘通道）——
    await page.evaluate(() => {
      const { cm } = window.__makeWysiwygEditor('> [!NOTE]\n> 注意内容');
      window.__s59cm = cm;
    });
    await new Promise((res) => setTimeout(res, 300));
    await page.evaluate(() => { const cm = window.__s59cm; cm.focus(); cm.setCursor(1, 6); });
    await new Promise((res) => setTimeout(res, 200));
    await page.keyboard.press('Enter');
    await new Promise((res) => setTimeout(res, 700));
    await page.keyboard.type('继续内容');
    await new Promise((res) => setTimeout(res, 250));
    const C = await page.evaluate(() => {
      const cm = window.__s59cm;
      const cur = cm.getCursor();
      return { lines: cm.getValue().split('\n'), caret: { line: cur.line, ch: cur.ch } };
    });
    s59Push('C CJK 输入：续行 "> " 上键入中文 → 模型 "> 继续内容"（源空格不被挤到行尾）',
      !!(C.lines[2] === '> 继续内容' && C.caret.line === 2 && C.caret.ch === 6),
      JSON.stringify(C.lines));
  }

  // ---------- S60：[TOC] 块遮罩：不允许编辑、点击无反应、「编辑」改「删除」（2026-10-21 用户要求） ----------
  // TOC 由整篇标题生成、无编辑意义 → 遮罩内任何点击（含目录链接）无反应（不进编辑/不跳转）；
  // 右上「编辑」按钮改为「删除」，点击删除 [TOC] 源行（块前后各一空行时连删前导换行，
  // 不留连续两个空行）。删除可 Ctrl+Z 撤销。
  console.log('\n=== S60：[TOC] 块不编辑、点击无反应、右上「删除」按钮 ===');
  {
    const s60Push = (label, ok, extra) => {
      const pass = !!ok;
      if (!pass) fail++;
      console.log(`  ${pass ? '✓' : '✗'} ${label}` + (extra !== undefined ? '  ' + extra : ''));
    };
    const doc60 = '# 甲\n\n正文一。\n\n[TOC]\n\n## 乙\n\n正文二。';
    await page.evaluate((d) => {
      const { cm, ed } = window.__makeWysiwygEditor(d);
      window.__s60cm = cm;
      window.__s60ed = ed;
    }, doc60);
    // [TOC] 遮罩走异步 pass（harness mock 为微任务），留足防抖 + 行高缓存时间
    await new Promise((res) => setTimeout(res, 500));
    const st0 = await page.evaluate(() => {
      const cm = window.__s60cm, ed = window.__s60ed;
      const mask = cm.getWrapperElement().querySelector('.wysiwyg-block-mask .toc');
      const mnode = mask ? mask.closest('.wysiwyg-block-mask') : null;
      const btn = mnode ? mnode.querySelector('button.block-edit-btn') : null;
      const a = mnode ? mnode.querySelector('.toc-list a') : null;
      const rect = (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
      const c = cm.getCursor();
      return {
        hasToc: !!mask,
        btnText: btn ? btn.textContent : null,
        hasTocDeleteAttr: !!(btn && btn.getAttribute('data-toc-delete')),
        btnPt: btn ? rect(btn) : null,
        aPt: a ? rect(a) : null,
        cur: { line: c.line, ch: c.ch },
        lines: cm.getValue().split('\n'),
        activeIdx: ed._wysiwygActiveIdx,
      };
    });
    // 按钮文案：真实 app 为译文「删除」，harness 的 t() 是透传 mock（返回键名 deleteToc）——
    // 两者都合法，关键是不得是「编辑」键
    const btnTextOk = (st0.btnText === '删除' || st0.btnText === 'deleteToc')
      && st0.btnText !== '编辑' && st0.btnText !== 'editBlock';
    s60Push('TOC 遮罩渲染且挂「删除」按钮（data-toc-delete，非「编辑」）',
      st0.hasToc && st0.hasTocDeleteAttr && btnTextOk,
      JSON.stringify({ btnText: st0.btnText, attr: st0.hasTocDeleteAttr }));
    // 点 TOC 条目（真实鼠标点击，走 mousedown 守卫）→ 无反应：不撤罩、光标不动、块表不变
    if (st0.aPt) {
      await page.mouse.click(st0.aPt.x, st0.aPt.y);
      await new Promise((res) => setTimeout(res, 450));
      const st1 = await page.evaluate(() => {
        const cm = window.__s60cm, ed = window.__s60ed;
        const c = cm.getCursor();
        return {
          cur: { line: c.line, ch: c.ch },
          activeIdx: ed._wysiwygActiveIdx,
          tocMaskStill: !!cm.getWrapperElement().querySelector('.wysiwyg-block-mask .toc'),
          lines: cm.getValue().split('\n'),
        };
      });
      s60Push('点 TOC 条目：无反应（不撤罩、光标不动、内容/块表不变）',
        st1.tocMaskStill && st1.cur.line === st0.cur.line && st1.cur.ch === st0.cur.ch
        && st1.activeIdx === st0.activeIdx && st1.lines.join('\n') === st0.lines.join('\n'),
        JSON.stringify({ cur: st1.cur, activeIdx: st1.activeIdx, maskStill: st1.tocMaskStill }));
    }
    // 点删除按钮 → [TOC] 源行删除、遮罩消失、无连续空行、光标保持有效
    if (st0.btnPt) {
      await page.mouse.click(st0.btnPt.x, st0.btnPt.y);
      await new Promise((res) => setTimeout(res, 700));
      const st2 = await page.evaluate(() => {
        const cm = window.__s60cm;
        const c = cm.getCursor();
        return {
          lines: cm.getValue().split('\n'),
          cur: { line: c.line, ch: c.ch },
          tocMaskGone: !cm.getWrapperElement().querySelector('.wysiwyg-block-mask .toc'),
        };
      });
      s60Push('删除按钮：[TOC] 源行删除、遮罩消失、无连续空行残留',
        st2.tocMaskGone && st2.lines.join('\n') === '# 甲\n\n正文一。\n\n## 乙\n\n正文二。',
        JSON.stringify(st2.lines));
      // 光标语义（CM5 replaceRange）：删除区间未覆盖当前选区时选区保持原位（本场景点击前
      // 光标在 (0,0)、删除区间 [1,0..3,0) 在其后 → 光标不动），只要仍有效且在删除前行
      s60Push('删除后光标保持原位且有效（CM5 选区语义：未被删除区间覆盖则不动）',
        st2.cur.line === st0.cur.line && st2.cur.ch === st0.cur.ch
        && st2.cur.line < st2.lines.length,
        JSON.stringify(st2.cur));
    }
  }

  // ---------- S61：光标行显示源码（2026-10-21 用户要求：基础文本格式编辑时，光标所在行
  // 其中行内格式要显示源码） ----------
  // 载体（2026-07-13 换）：JS 行类 wysiwyg-inline-cursor-line（syncWysiwygActiveBlock 每
  // 次 cursorActivity 同步到光标行，'text' 域落 pre）；styles.css 同特异性规则把该行的
  // 行内标记 span 从零宽透明恢复为真宽 + 次级色（rgb(102,109,121)），非光标行维持零宽
  // （S58 口径）。原 activeline addon 载体弃用：addon 对非空选区清掉全部活动行（选中时
  // 源码消失）且存 handle 可与光标失步（S66 专项回归）。addon 仍提供光标行底色。
  // 固有代价（如实声明）：光标行标记占真宽 → 贴近折行处的行可多折一行（+27.2px），
  // 光标进出时下方内容位移（Typora 同款）。本场景短行：护栏 = 行数不超过遮罩 +1。
  console.log('\n=== S61：光标行行内格式显示源码（真宽+次级色、光标跟随） ===');
  {
    const s61Push = (label, ok, extra) => {
      const pass = !!ok;
      if (!pass) fail++;
      console.log(`  ${pass ? '✓' : '✗'} ${label}` + (extra !== undefined ? '  ' + extra : ''));
    };
    const r = await page.evaluate(async () => {
      // 与用户截图「基础文本格式」同构：每行一种行内格式（粗体/斜体/删除线/代码/高亮）
      const doc = ['## 基础文本格式', '',
        '- **粗体文本**：用 **text** 包裹',
        '- *斜体文本*：用 *text* 包裹',
        '- 删除线：用 ~~text~~ 包裹',
        '- 行内代码：用 `code` 包裹',
        '- 高亮标记：用 ==text== 包裹'].join('\n');
      const { cm, ed } = window.__makeWysiwygEditor(doc);
      await new Promise((res) => setTimeout(res, 300));
      const out = {};
      // 遮罩态先行量：每 li 盒高（行数参照）
      out.maskLiH = Array.from(document.querySelectorAll('div.wysiwyg-block-mask ul li'))
        .map((li) => Math.round(li.getBoundingClientRect().height * 10) / 10);
      // ⚠️ 顺序必须先活动化块（撤罩）再 setCursor：光标直接落进遮罩（atomic）行会被
      // CM 的 reCheckSelection 钳到块末行（实测 setCursor(4,1) → 落 (6,20)）。与
      // 编辑按钮同一顺序（setWysiwygActiveBlock 撤罩 → setSelection 落行）。
      const listIdx = ed._wysiwygBlocks.findIndex((b) => b.start <= 4 && 4 < b.end);
      if (listIdx < 0) return { err: '列表块未找到' };
      ed.setWysiwygActiveBlock(listIdx);
      cm.setCursor(4, 1);
      cm.refresh();
      await new Promise((res) => setTimeout(res, 450)); // 装饰重挂 + 行高缓存刷新
      const preOf = (n) => {
        const h = cm.getLineHandle(n);
        for (const lv of cm.display.view) {
          if (lv && lv.line === h) {
            const el = lv.node;
            return el.tagName === 'PRE' ? el : (el.querySelector ? el.querySelector('pre.CodeMirror-line') : null);
          }
        }
        return null;
      };
      const wrapOf = (n) => {
        const pre = preOf(n);
        return pre && pre.parentElement ? pre.parentElement : null;
      };
      const mSpans = (pre) => Array.from(pre.querySelectorAll('span'))
        .filter((s) => String(s.className).includes('wysiwyg-inline-marker'));
      const w = (el) => Math.round(el.getBoundingClientRect().width * 100) / 100;
      const info = (n) => {
        const pre = preOf(n), wrap = wrapOf(n);
        if (!pre) return { err: 'line ' + n + ' pre 未找到' };
        const ms = mSpans(pre);
        const cs = ms.map((s) => getComputedStyle(s).color);
        return {
          // 新载体（2026-07-13）：JS 行类落 pre（标记样式判定用）；旧 addon wrap 类
          // 仍在（光标行底色 + 失步守卫载体），一并读出供参考
          curLine: String(pre.className).includes('wysiwyg-inline-cursor-line'),
          active: !!(wrap && wrap.className.includes('CodeMirror-activeline')),
          widths: ms.map(w),
          colors: cs,
          preH: Math.round(pre.getBoundingClientRect().height * 10) / 10,
        };
      };
      out.l4 = info(4); // 光标行（删除线 ~~）
      out.l2 = info(2); // 非光标行（粗体 **）
      out.l4TextW = w((preOf(4) && preOf(4).querySelector('.wysiwyg-strike')) || { getBoundingClientRect: () => ({ width: 0 }) });
      // 光标移到行 2 → 可见性应跟随（行 2 显源码、行 4 回零宽）
      cm.setCursor(2, 1);
      await new Promise((res) => setTimeout(res, 450));
      out.afterMove = { l2: info(2), l4: info(4) };
      return out;
    });
    if (r.err || !r.l4 || r.l4.err || r.l2.err) {
      s61Push('S61 初始化', false, (r.err || (r.l4 && r.l4.err) || (r.l2 && r.l2.err) || '未知'));
    } else {
      s61Push('光标行（删除线）：~~ 标记 span 恢复真宽且为次级色 rgb(102,109,121)',
        r.l4.widths.length >= 2 && r.l4.widths.every((x) => x > 0.5)
        && r.l4.colors.every((c) => c === 'rgb(102, 109, 121)'),
        JSON.stringify({ widths: r.l4.widths, color: r.l4.colors[0] }));
      s61Push('光标行 pre 挂 wysiwyg-inline-cursor-line；非光标行不挂（JS 行类载体随光标）',
        r.l4.curLine === true && r.l2.curLine === false,
        JSON.stringify({ l4: r.l4.curLine, l2: r.l2.curLine, addonWrap: { l4: r.l4.active, l2: r.l2.active } }));
      // 逐项切块（2026-10-21）：S61 列表为紧凑列表 → 行 2 是**兄弟项**（独立块、渲染遮罩），
      // 非「活动块内非光标行」→ 无内联标记 span（遮罩行契约：widths 恒空，S58/S66 同口径）。
      // 活动块内非光标行的零宽透明口径由 S58（松散列表整块活动）钉住，不在此重复。
      s61Push('非光标行（粗体）：兄弟项保持渲染遮罩（无内联标记、非光标行类）',
        r.l2.widths.length === 0 && r.l2.curLine === false,
        JSON.stringify({ widths: r.l2.widths, curLine: r.l2.curLine }));
      s61Push('文本段渲染化不受影响（删除线文本 span 宽度 > 0）', r.l4TextW > 5, 'strikeW=' + r.l4TextW);
      // 逐项切块（2026-10-21）：光标移到行 2 → 项①激活（源码、真宽标记），项③（行 4）
      // 重新遮罩（遮罩行契约：无内联标记 span，非「回零宽」）
      s61Push('光标移到粗体行后：可见性跟随（新光标行真宽、旧光标行重遮无标记）',
        !!(r.afterMove && r.afterMove.l2 && r.afterMove.l4)
        && r.afterMove.l2.curLine === true && r.afterMove.l4.curLine === false
        && r.afterMove.l2.widths.length && r.afterMove.l2.widths.every((x) => x > 0.5)
        && r.afterMove.l4.widths.length === 0,
        JSON.stringify({ l2w: r.afterMove.l2.widths, l4w: r.afterMove.l4.widths, l2cls: r.afterMove.l2.curLine, l4cls: r.afterMove.l4.curLine }));
      // 几何护栏：短行光标行行数 = 遮罩行数（无标记宽撑折）；长行场景允许多折 ≤1 行
      const liLines = (h) => Math.max(1, Math.round(h / 27.2));
      const linesOf = (h) => Math.max(1, Math.round((h - 4) / 27.2));
      s61Push('几何护栏：光标行行数 ≤ 遮罩行数 + 1（短行实测应相等）',
        linesOf(r.l4.preH) <= liLines(r.maskLiH[2]) + 1,
        'activePreH=' + r.l4.preH + ' maskLiH=' + r.maskLiH[2]);
    }
  }

  // ---------- S62：未闭合裸 HTML 容器块（demo.md 折叠区块审计，2026-07-13） ----------
  // remark 按 CommonMark 遇空行断 HTML 块 → WYSIWYG 块表碎片化（details 壳 + 独立 ul +
  // 裸露 </details> 源码行），而阅读模式 rehype-raw/parse5 全串重解析把内容并进同一元素。
  // 修复：renderMarkdownBlocks 把未闭合容器块并到闭标签行（白名单按管线实测）。
  // 断言：① 块表单块覆盖整个 details 区域 ② 遮罩=单个含列表的折叠框 ③ 遮罩几何≡阅读态
  // ④ 编辑态进入后可见完整源码（含 </details> 行，可编辑）。
  console.log('\n=== S62：未闭合裸 HTML 容器块合并（details 遮罩 ≡ 阅读、可编辑完整源码） ===');
  {
    const s62Push = (label, ok, extra) => {
      const pass = !!ok;
      if (!pass) fail++;
      console.log(`  ${pass ? '✓' : '✗'} ${label}` + (extra !== undefined ? '  ' + extra : ''));
    };
    const doc62 = '# T\n\n<details>\n<summary>点击展开</summary>\n\n<ul>\n<li>甲</li>\n<li>乙</li>\n</ul>\n\n</details>\n\n尾部正文。';
    const r62 = await page.evaluate(async (d) => {
      const { cm, ed } = window.__makeWysiwygEditor(d);
      window.__s62cm = cm; window.__s62ed = ed;
      cm.options.viewportMargin = 100000;
      cm.refresh();
      await new Promise((res) => setTimeout(res, 500));
      const lines = cm.getValue().split('\n');
      const blocks = ed._wysiwygBlocks || [];
      const dStart = lines.findIndex((l) => l.trim() === '<details>');
      const dEnd = lines.findIndex((l) => l.trim() === '</details>');
      const covered = blocks.filter((b) => b.start <= dStart && dStart < b.end);
      const db = covered.length === 1 ? covered[0] : null;
      const out = { dStart, dEnd, blockCount: blocks.length, spans: blocks.map((b) => [b.start, b.end]) };
      if (!db) return out;
      out.span = [db.start, db.end];
      out.coversClose = db.end > dEnd;
      const mk = ed._wysiwygMarks.get(blocks.indexOf(db));
      const det = mk && mk.replacedWith ? mk.replacedWith.querySelector('details') : null;
      out.mask = det ? {
        liCount: det.querySelectorAll('li').length,
        open: det.open,
        ulInside: !!det.querySelector('ul'),
        strayUlSiblings: mk.replacedWith.querySelectorAll(':scope > ul').length,
        h: Math.round(det.getBoundingClientRect().height * 10) / 10,
      } : null;
      // 阅读态对照（同款 post-process：展开 details）
      const reading = document.getElementById('reading');
      reading.style.fontSize = '16px'; reading.style.lineHeight = '1.7';
      reading.innerHTML = window.UnifiedRenderer.renderMarkdown(d, ed.settings);
      if (window.RenderPost) { window.RenderPost.normalizeDetails(reading); window.RenderPost.enableCheckboxes(reading); }
      await new Promise((res) => setTimeout(res, 200));
      const rd = reading.querySelector('details');
      out.reading = rd ? {
        liCount: rd.querySelectorAll('li').length,
        ulInside: !!rd.querySelector('ul'),
        h: Math.round(rd.getBoundingClientRect().height * 10) / 10,
        detBorder: getComputedStyle(rd).borderLeftColor,
        detPad: getComputedStyle(rd).padding,
        sumColor: getComputedStyle(rd.querySelector('summary')).color,
      } : null;
      out.maskStyles = det ? {
        detBorder: getComputedStyle(det).borderLeftColor,
        detPad: getComputedStyle(det).padding,
        sumColor: getComputedStyle(det.querySelector('summary')).color,
      } : null;
      // 编辑态：撤罩后可见完整源码（含闭标签行）
      ed.setWysiwygActiveBlock(blocks.indexOf(db));
      cm.setCursor(dEnd, 0);
      cm.refresh();
      await new Promise((res) => setTimeout(res, 450));
      out.activeVisible = {
        closeLine: (cm.getLine(dEnd) || '').trim(),
        openLine: (cm.getLine(dStart) || '').trim(),
        maskGone: !cm.getWrapperElement().querySelector('.wysiwyg-block-mask details'),
      };
      return out;
    }, doc62);
    if (!r62.span) {
      s62Push('S62 初始化', false, JSON.stringify(r62));
    } else {
      s62Push('块表单块覆盖整个 details 区域（含闭标签行，非碎片三块）',
        r62.span[0] === r62.dStart && r62.coversClose,
        'span=' + JSON.stringify(r62.span) + ' blocks=' + JSON.stringify(r62.spans));
      s62Push('遮罩=单个折叠框且列表在框内（无框外独立 ul、无裸露闭标签）',
        !!(r62.mask && r62.mask.liCount === 2 && r62.mask.ulInside && r62.mask.open && r62.mask.strayUlSiblings === 0),
        JSON.stringify(r62.mask));
      s62Push('遮罩几何 ≡ 阅读态（高度差 ≤3px、边框/内边距/summary 色相同）',
        !!(r62.mask && r62.reading && r62.maskStyles)
        && Math.abs(r62.mask.h - r62.reading.h) <= 3
        && r62.maskStyles.detBorder === r62.reading.detBorder
        && r62.maskStyles.detPad === r62.reading.detPad
        && r62.maskStyles.sumColor === r62.reading.sumColor,
        JSON.stringify({ maskH: r62.mask && r62.mask.h, readH: r62.reading && r62.reading.h }));
      s62Push('编辑态：撤罩后完整源码可见（含 </details> 行，可编辑）',
        !!(r62.activeVisible && r62.activeVisible.maskGone
          && r62.activeVisible.closeLine === '</details>' && r62.activeVisible.openLine === '<details>'),
        JSON.stringify(r62.activeVisible));
    }
  }

  // ---------- S63：孤闭合标签行（demo.md 尾部 </p> 审计，2026-07-13） ----------
  // 阅读模式：孤立 </p> 渲染为空（不可见）；修复前 WYSIWYG 遮罩被跳过 → 源码行裸露。
  // 修复：纯孤闭合标签行块输出零高度占位（同 ref 定义口径），遮罩盖行且不可见。
  console.log('\n=== S63：孤闭合标签行零高度隐藏遮罩（不裸露源码） ===');
  {
    const s63Push = (label, ok, extra) => {
      const pass = !!ok;
      if (!pass) fail++;
      console.log(`  ${pass ? '✓' : '✗'} ${label}` + (extra !== undefined ? '  ' + extra : ''));
    };
    const doc63 = '# T\n\n<p align="center">\n\n行A<br>\n\n行B\n\n</p>\n\n尾部正文。';
    const r63 = await page.evaluate(async (d) => {
      const { cm, ed } = window.__makeWysiwygEditor(d);
      window.__s63cm = cm; window.__s63ed = ed;
      cm.options.viewportMargin = 100000;
      cm.refresh();
      await new Promise((res) => setTimeout(res, 500));
      const lines = cm.getValue().split('\n');
      const closeLine = lines.findIndex((l) => l.trim() === '</p>');
      const blocks = ed._wysiwygBlocks || [];
      const cb = blocks.find((b) => b.start <= closeLine && closeLine < b.end);
      const out = { closeLine, spans: blocks.map((b) => [b.start, b.end]) };
      if (!cb) return out;
      out.cbHtml = cb.html;
      const mi = blocks.indexOf(cb);
      const mk = ed._wysiwygMarks.get(mi);
      const mnode = mk && mk.replacedWith ? mk.replacedWith : null;
      out.mask = mnode ? {
        h: Math.round(mnode.getBoundingClientRect().height * 100) / 100,
        hasHiddenDiv: !!mnode.querySelector('.wysiwyg-block-hidden'),
        hasBtn: !!mnode.querySelector('button'),
      } : null;
      // 源码行不得以可见文本裸露：行内容被遮罩替换（pre 内只剩遮罩 chrome 文本，
      // 如编辑按钮键名「editBlock」），原始 `</p>` 文本必须消失
      const preOf = (n) => {
        const h = cm.getLineHandle(n);
        for (const lv of cm.display.view) {
          if (lv && lv.line === h) return lv.node && lv.node.tagName === 'PRE' ? lv.node : (lv.node || null);
        }
        return null;
      };
      const pre = preOf(closeLine);
      out.closeLinePre = pre ? pre.textContent.trim() : '(no node)';
      // 阅读态：无 </p> 文本、顶层块 = h1 + 空p + p + p + p（5 个）
      const reading = document.getElementById('reading');
      reading.style.fontSize = '16px'; reading.style.lineHeight = '1.7';
      reading.innerHTML = window.UnifiedRenderer.renderMarkdown(d, ed.settings);
      out.reading = {
        childTags: Array.from(reading.children).map((c) => c.tagName.toLowerCase()),
        hasCloseText: reading.textContent.includes('</p>'),
      };
      return out;
    }, doc63);
    if (!r63.cbHtml) {
      s63Push('S63 初始化', false, JSON.stringify(r63));
    } else {
      s63Push('`</p>` 块输出零高度占位（wysiwyg-block-hidden，同 ref 定义口径）',
        r63.cbHtml === '<div class="wysiwyg-block-hidden"></div>',
        'html=' + r63.cbHtml);
      s63Push('遮罩存在且零高度、可点编辑按钮（源码行不裸露：`</p>` 文本消失）',
        !!(r63.mask && r63.mask.h < 1 && r63.mask.hasHiddenDiv && r63.mask.hasBtn)
        && typeof r63.closeLinePre === 'string' && r63.closeLinePre.indexOf('</p>') < 0,
        JSON.stringify({ mask: r63.mask, closeLinePre: r63.closeLinePre }));
      s63Push('阅读态对齐：无 </p> 文本（孤闭合标签不可见）',
        !!(r63.reading && !r63.reading.hasCloseText),
        JSON.stringify(r63.reading && r63.reading.childTags));
    }
  }

  // ---------- S64：公式 guard 反引号状态失同步（demo.md L963 \`` 审计，2026-07-13） ----------
  // 转义表行的 \``（字面反引号）不得翻转 guard 的 inBacktick 状态，否则其后整篇
  // 「反引号内 $...$」被误判为数学占位 → 占位落在 <code> 内被转义后 restore 匹配
  // 不到 → 阅读/遮罩残留 <!--MATHBLOCK_N--> 字面垃圾（修复前 demo.md L1034 实测）。
  console.log('\n=== S64：guard 转义反引号不翻转状态（反引号内 $...$ 无 MATHBLOCK 垃圾） ===');
  {
    const s64Push = (label, ok, extra) => {
      const pass = !!ok;
      if (!pass) fail++;
      console.log(`  ${pass ? '✓' : '✗'} ${label}` + (extra !== undefined ? ' ' + extra : ''));
    };
    const doc64 = '# T\n\n| 转义写法 | 显示效果 |\n| --- | --- |\n| ``\\` `` | \\` 字面反引号 |\n\n除 `$...$` 行内公式外。';
    const r64 = await page.evaluate(async (d) => {
      const { cm, ed } = window.__makeWysiwygEditor(d);
      cm.options.viewportMargin = 100000;
      cm.refresh();
      await new Promise((res) => setTimeout(res, 500));
      const lines = cm.getValue().split('\n');
      const mathLine = lines.findIndex((l) => l.indexOf('行内公式外') >= 0);
      const blocks = ed._wysiwygBlocks || [];
      const mb = blocks.find((b) => b.start <= mathLine && mathLine < b.end);
      const out = { mathLine, hasBlock: !!mb };
      if (!mb) return out;
      const mi = blocks.indexOf(mb);
      const mk = ed._wysiwygMarks.get(mi);
      const mnode = mk && mk.replacedWith ? mk.replacedWith : null;
      out.maskHtml = mnode ? mnode.innerHTML : null;
      const maskP = mnode ? mnode.querySelector('p') : null;
      const reading = document.getElementById('reading');
      reading.style.fontSize = '16px'; reading.style.lineHeight = '1.7';
      const fullHtml = window.UnifiedRenderer.renderMarkdown(d, ed.settings);
      reading.innerHTML = fullHtml;
      const readP = Array.from(reading.children).find((c) => c.getAttribute('data-source-line') === String(mathLine + 1));
      out.fullHtmlHasGarbage = fullHtml.indexOf('MATHBLOCK') >= 0;
      out.maskHasGarbage = out.maskHtml ? out.maskHtml.indexOf('MATHBLOCK') >= 0 : null;
      out.readPHasPlainMath = !!(readP && readP.textContent.indexOf('$...$') >= 0);
      // 两模式同跑 RenderPost 后处理（与 app 的 render() 同链）再比几何
      if (window.RenderPost) { window.RenderPost.processMath(mnode || reading); window.RenderPost.processMath(reading); }
      await new Promise((res) => setTimeout(res, 300));
      const h = (n) => (n ? Math.round(n.getBoundingClientRect().height * 100) / 100 : null);
      out.heights = { maskP: h(maskP), readP: h(readP) };
      out.maskPText = maskP ? maskP.textContent.slice(0, 60) : null;
      return out;
    }, doc64);
    if (!r64.hasBlock) {
      s64Push('S64 初始化', false, JSON.stringify(r64));
    } else {
      s64Push('阅读态渲染无 MATHBLOCK 垃圾（占位未漏进最终 HTML）',
        r64.fullHtmlHasGarbage === false, '');
      s64Push('遮罩渲染无 MATHBLOCK 垃圾（块切片与全文同一 guard）',
        r64.maskHasGarbage === false, '');
      s64Push('反引号内 $...$ 保持原样文本（未误判为数学占位）',
        r64.readPHasPlainMath === true, 'maskPText=' + JSON.stringify(r64.maskPText));
      const hm = r64.heights && r64.heights.maskP, hr = r64.heights && r64.heights.readP;
      s64Push('遮罩 ≡ 阅读几何（同链后处理，含 KaTeX 还原）',
        hm != null && hr != null && Math.abs(hm - hr) <= 1,
        JSON.stringify(r64.heights));
    }
  }

  // ---------- S65：普通文字段落不挂块级「编辑」按钮（2026-07-13 用户要求） ----------
  // 点文字经 mousedown 点击映射直接落光标编辑（与列表/标题同款口径）→ 普通文字
  // （渲染恰为单个 <p> 且无 img/.katex）不挂按钮、挂 no-btn 补回 14px 底边距；
  // 表格（源码入口=按钮）/ 图片段（点图开灯箱）/ 公式段保守保留按钮。
  console.log('\n=== S65：普通文字无编辑按钮（表格/图片/公式保留；点文字即编辑） ===');
  {
    const s65Push = (label, ok, extra) => {
      const pass = !!ok;
      if (!pass) fail++;
      console.log(`  ${pass ? '✓' : '✗'} ${label}` + (extra !== undefined ? ' ' + extra : ''));
    };
    const doc65 = '# T\n\n普通段落一。\n\n普通段落二，含 `代码` 与 **加粗**。\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n![图](https://example.com/img.png)\n\n$E = mc^2$ 公式段。';
    const r65 = await page.evaluate(async (d) => {
      const { cm, ed } = window.__makeWysiwygEditor(d);
      window.__s65cm = cm; window.__s65ed = ed;
      cm.options.viewportMargin = 100000;
      cm.refresh();
      await new Promise((res) => setTimeout(res, 600));
      const blocks = ed._wysiwygBlocks || [];
      const maskOf = (line) => {
        const bi = blocks.findIndex((b) => b.start <= line && line < b.end);
        if (bi < 0) return null;
        const mk = ed._wysiwygMarks.get(bi);
        return mk && mk.replacedWith ? { idx: bi, node: mk.replacedWith } : null;
      };
      const info = (m) => m ? {
        btn: !!m.node.querySelector('button.block-edit-btn'),
        noBtn: m.node.classList.contains('wysiwyg-mask-no-btn'),
        h: Math.round(m.node.getBoundingClientRect().height * 100) / 100,
        pt: (() => { const r = m.node.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })(),
      } : null;
      const p1 = info(maskOf(2)), p2 = info(maskOf(4)), tb = info(maskOf(6)),
            img = info(maskOf(10)), math = info(maskOf(12));
      const reading = document.getElementById('reading');
      reading.style.fontSize = '16px'; reading.style.lineHeight = '1.7';
      reading.innerHTML = window.UnifiedRenderer.renderMarkdown(d, ed.settings);
      if (window.RenderPost) window.RenderPost.processMath(reading);
      const readP1 = Array.from(reading.children).find((c) => c.getAttribute('data-source-line') === '3');
      const readP1h = readP1 ? Math.round(readP1.getBoundingClientRect().height * 100) / 100 : null;
      return { p1, p2, tb, img, math, readP1h };
    }, doc65);
    if (!r65.p1) {
      s65Push('S65 初始化', false, JSON.stringify(r65));
    } else {
      s65Push('普通段落（一）无编辑按钮且挂 no-btn（14px 底边距补回）',
        r65.p1.btn === false && r65.p1.noBtn === true, JSON.stringify(r65.p1));
      s65Push('普通段落（二，含行内代码/加粗）无编辑按钮',
        !!(r65.p2 && r65.p2.btn === false && r65.p2.noBtn === true), JSON.stringify(r65.p2));
      s65Push('表格保留编辑按钮（整表源码入口）',
        !!(r65.tb && r65.tb.btn === true), JSON.stringify(r65.tb));
      s65Push('图片段保留编辑按钮（点图开灯箱，点不到源码）',
        !!(r65.img && r65.img.btn === true), JSON.stringify(r65.img));
      s65Push('公式段保留编辑按钮（公式非普通文字）',
        !!(r65.math && r65.math.btn === true), JSON.stringify(r65.math));
      // 高度回归护栏：no-btn 遮罩 = 内容 27.2 + 14px 底边距补回（与有按钮时同高；
      // 若 no-btn 缺失会矮 14px）
      s65Push('普通段落遮罩高度 = 阅读段高 + 14px 补回（no-btn 生效，渲染↔源码不跳动）',
        r65.p1.h != null && r65.readP1h != null && Math.abs(r65.p1.h - (r65.readP1h + 14)) <= 1,
        JSON.stringify({ mask: r65.p1.h, read: r65.readP1h }));
      // 点普通段落文字（真实点击）→ 光标落到该行、撤罩出源码（点行即编辑，无需按钮）
      if (r65.p1.pt) {
        await page.mouse.click(r65.p1.pt.x, r65.p1.pt.y);
        await new Promise((res) => setTimeout(res, 500));
        const st2 = await page.evaluate(() => {
          const cm = window.__s65cm, ed = window.__s65ed;
          if (!cm || !ed) return { missing: true };
          const c = cm.getCursor();
          const blocks = ed._wysiwygBlocks || [];
          const bi = blocks.findIndex((b) => b.start <= 2 && 2 < b.end);
          const mk = bi >= 0 ? ed._wysiwygMarks.get(bi) : null;
          return {
            cur: { line: c.line, ch: c.ch },
            line2: cm.getValue().split('\n')[2],
            // 点中的块（第 2 行）撤罩：其 mark 失效；其余块遮罩不受影响
            p1MaskGone: bi < 0 || !mk,
          };
        });
        s65Push('点普通段落文字：光标落该行、撤罩出源码（点行即编辑）',
          !!(st2 && !st2.missing && st2.cur.line === 2 && st2.p1MaskGone && st2.line2 === '普通段落一。'),
          JSON.stringify(st2));
      }
    }
  }

  // ---------- S66：光标行源码——选中期间保持 + 离开行即回渲染（2026-07-13 用户反馈） ----------
  // ① 鼠标选中一段文字时编辑态源码不得消失（旧 activeline addon 对非空选区清掉全部
  //    活动行 → 选区期间光标行回渲染外观）；② 光标离开当前行（同列表另一行）应立即回
  //    渲染态（旧载体失步：demo.md <ins> 行光标离开整个列表才回渲染态）。
  // 新载体 = JS 行类 wysiwyg-inline-cursor-line（cursorActivity 每次同步到光标行）。
  console.log('\n=== S66：选中保持源码 + 离开行即回渲染（demo.md 行内样式节同款列表） ===');
  {
    const s66Push = (label, ok, extra) => {
      const pass = !!ok;
      if (!pass) fail++;
      console.log(`  ${pass ? '✓' : '✗'} ${label}` + (extra !== undefined ? ' ' + extra : ''));
    };
    const doc66 = [
      '- <u>下划线文本</u>：用 `<u>` 标签',
      '- <ins>插入内容</ins>：用 `<ins>` 标签（带下划线，表示新增内容）',
      '- ==高亮标记==：用 `==文本==` 语法（也支持原生 `<mark>` 标签）',
    ].join('\n');
    const lineInfo66 = () => page.evaluate(() => {
      const cm = window.__s66cm, ed = window.__s66ed;
      const preOf = (n) => {
        const h = cm.getLineHandle(n);
        for (const lv of cm.display.view) {
          if (lv && lv.line === h) {
            const el = lv.node;
            return el.tagName === 'PRE' ? el : (el.querySelector ? el.querySelector('pre.CodeMirror-line') : null);
          }
        }
        return null;
      };
      const mSpans = (pre) => Array.from(pre.querySelectorAll('span'))
        .filter((s) => String(s.className).includes('wysiwyg-inline-marker'));
      const w = (el) => Math.round(el.getBoundingClientRect().width * 100) / 100;
      const info = (n) => {
        const pre = preOf(n);
        if (!pre) return { err: 'line ' + n + ' 未物化' };
        const ms = mSpans(pre);
        return {
          curLine: String(pre.className).includes('wysiwyg-inline-cursor-line'),
          widths: ms.map(w),
          rect: (() => { const r = pre.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })(),
        };
      };
      const c = cm.getCursor();
      const sel = cm.listSelections()[0];
      return {
        l0: info(0), l1: info(1), l2: info(2),
        cur: { line: c.line, ch: c.ch },
        selEmpty: sel ? sel.empty() : null,
        activeIdx: ed._wysiwygActiveIdx,
      };
    });
    const r0 = await page.evaluate(async (d) => {
      const { cm, ed } = window.__makeWysiwygEditor(d);
      window.__s66cm = cm; window.__s66ed = ed;
      cm.options.viewportMargin = 100000;
      cm.refresh();
      await new Promise((res) => setTimeout(res, 400));
      // 进入列表块（与 S61 同序：先撤罩再落光标）
      const listIdx = ed._wysiwygBlocks.findIndex((b) => b.start <= 1 && 1 < b.end);
      if (listIdx < 0) return { err: '列表块未找到' };
      ed.setWysiwygActiveBlock(listIdx);
      cm.setCursor(1, 10);
      cm.refresh();
      await new Promise((res) => setTimeout(res, 450));
      return { ok: true };
    }, doc66);
    if (r0.err) {
      s66Push('S66 初始化', false, r0.err);
    } else {
      const st0 = await lineInfo66();
      // 逐项切块（2026-10-21）：只有光标行（第 2 项）源文态；兄弟项保持渲染遮罩
      //（无 wysiwyg 内联标记 span，widths 为空）
      s66Push('进入 <ins> 行：该行标记真宽（源码），兄弟项保持渲染遮罩（无内联标记）',
        st0.l1.widths.length >= 2 && st0.l1.widths.every((x) => x > 0.5)
        && st0.l0.widths.length === 0
        && st0.l2.widths.length === 0
        && st0.l1.curLine === true && st0.l0.curLine === false,
        JSON.stringify({ l0: st0.l0.widths, l1: st0.l1.widths, l2: st0.l2.widths }));
      // ① 同行内真实拖选（mousedown→move→读中途→mouseup）：选中期间源码保持
      if (st0.l1.rect) {
        const sy = st0.l1.rect.y + st0.l1.rect.h / 2;
        await page.mouse.move(st0.l1.rect.x + 30, sy);
        await page.mouse.down();
        await page.mouse.move(st0.l1.rect.x + 250, sy, { steps: 6 });
        await new Promise((res) => setTimeout(res, 250));
        const mid = await lineInfo66();
        await page.mouse.up();
        await new Promise((res) => setTimeout(res, 450));
        const post = await lineInfo66();
        s66Push('拖选中途（非空选区）：光标行源码保持（旧 addon 此时清行=用户反馈①）',
          !!(mid.l1 && mid.selEmpty === false
            && mid.l1.widths.length >= 2 && mid.l1.widths.every((x) => x > 0.5)),
          JSON.stringify({ selEmpty: mid.selEmpty, l1w: mid.l1 && mid.l1.widths, cur: mid.cur }));
        s66Push('拖选释放后：选区保留、光标行源码保持',
          !!(post.l1 && post.selEmpty === false
            && post.l1.widths.length >= 2 && post.l1.widths.every((x) => x > 0.5)
            && post.l1.curLine === true),
          JSON.stringify({ selEmpty: post.selEmpty, l1w: post.l1 && post.l1.widths, cls: post.l1 && post.l1.curLine }));
      }
      // ② 光标移到同列表另一行 → <ins> 行立即回渲染（零宽）、新行显源码
      if (st0.l2.rect) {
        await page.mouse.click(st0.l2.rect.x + 50, st0.l2.rect.y + st0.l2.rect.h / 2);
        await new Promise((res) => setTimeout(res, 500));
        const st1 = await lineInfo66();
        s66Push('点同列表下一行：<ins> 行立即回渲染（重遮、无内联标记）、新行显源码（用户反馈②）',
          !!(st1.l1 && st1.l2
            && st1.l1.widths.length === 0
            && st1.l2.widths.length >= 2 && st1.l2.widths.every((x) => x > 0.5)
            && st1.l1.curLine === false && st1.l2.curLine === true
            && st1.cur.line === 2),
          JSON.stringify({ cur: st1.cur, l1w: st1.l1 && st1.l1.widths, l2w: st1.l2 && st1.l2.widths, cls: { l1: st1.l1 && st1.l1.curLine, l2: st1.l2 && st1.l2.curLine } }));
        // 跨行拖选（行0 → 行2）：拖选起始行源码保持，释放后头行（行2）显源码
        await page.mouse.move(st1.l0.rect.x + 30, st1.l0.rect.y + st1.l0.rect.h / 2);
        await page.mouse.down();
        await page.mouse.move(st1.l2.rect.x + 100, st1.l2.rect.y + st1.l2.rect.h / 2, { steps: 8 });
        await new Promise((res) => setTimeout(res, 250));
        const mid2 = await lineInfo66();
        await page.mouse.up();
        await new Promise((res) => setTimeout(res, 450));
        const post2 = await lineInfo66();
        s66Push('跨行拖选：中途起始行源码保持；释放后头行（行2）源码、其余回渲染（重遮、无内联标记）',
          !!(mid2.l0 && mid2.l0.widths.length && mid2.l0.widths.every((x) => x > 0.5)
            && post2.l2 && post2.l2.widths.length >= 2 && post2.l2.widths.every((x) => x > 0.5)
            && post2.l0 && post2.l0.widths.length === 0
            && post2.l2.curLine === true && post2.l0.curLine === false),
          JSON.stringify({ mid2l0: mid2.l0 && mid2.l0.widths, post2l0: post2.l0 && post2.l0.widths, post2l2: post2.l2 && post2.l2.widths }));
      }
    }
  }

  // ---------- S67：代码块编辑态整块灰盒（2026-10-18 用户要求：上下围栏都在灰框内）——
  // 盒内每行（开围栏/内容/闭围栏）排版同参，盒总高 = 渲染态 pre 高 + 2×代码行高 ----------
  {
    console.log('\n=== S67：代码块编辑态整块灰盒（上下围栏在灰框内）===');
    const cb = await page.evaluate(() => window.__runCodeBox());
    if (cb.err || !cb.render) {
      console.log('  ⚠ 场景失败: ' + (cb.err || '无渲染态测量'));
      fail++;
    } else {
      console.log('  ' + JSON.stringify(cb));
      const checks67 = [];
      const r = cb.render;
      const insetCount = (s) => (s && s.shadow ? (s.shadow.match(/inset/g) || []).length : 0);
      checks67.push([`渲染态 pre 盒基准：四边 padding 16px + border 1px + 圆角 6px`,
        r.padT === '16px' && r.padB === '16px' && r.padL === '16px' && r.padR === '16px'
        && r.border.indexOf('1px') === 0 && r.radius === '6px']);
      checks67.push([`渲染态基准：代码字号 14.4px（0.9×16 预览字号）/ .code-line 行盒 ${r.codeLineH}px（行高 1.8）`,
        r.codeFs === '14.4px' && r.codeLineH > 20]);
      const c1 = cb.lines && cb.lines.c1, cMid = cb.lines && cb.lines.cMid, cLast = cb.lines && cb.lines.cLast;
      checks67.push([`编辑态内容行：wysiwyg-code-line 行类 + 字号/行盒/字族 = 渲染态（${c1 && c1.fs} / ${c1 && c1.lh} vs ${r.codeFs} / ${r.codeLineH}）`,
        c1 && c1.cls === true && c1.fs === r.codeFs && Math.abs(+c1.lh.replace('px', '') - r.codeLineH) < 0.5 && c1.ff === r.codeFf
        && cMid && cMid.cls === true && cLast && cLast.cls === true]);
      checks67.push([`编辑态内距 = 行留白 + 渲染态分解（左右 65px=32行留白+1border+16pre+16hljs；首顶/末底 29px=1border+16pre+12hljs）`,
        c1 && c1.padTLR === '29px/65px/65px/0px' && c1.padTop === true
        && cMid && cMid.padTLR === '0px/65px/65px/0px'
        && cLast && cLast.padTLR === '0px/65px/65px/29px' && cLast.padBottom === true]);
      const open = cb.lines && cb.lines.open, close = cb.lines && cb.lines.close;
      // 2026-10-22：闭围栏行加 16px 块底槽位（wysiwyg-code-slot-bottom，盒底↔下一块间距
      // ≡ 渲染态 16px 底边距槽，见 S78）→ 闭围栏行高 = 代码行高 + 16px
      checks67.push([`围栏行在灰盒内（开/闭两行同挂灰底 + 代码排版行类；开=first 角、闭=last 角；闭围栏行含 16px 底槽）`,
        open && open.bg === true && open.cls === true && open.first === true && open.lastCls === false
        && close && close.bg === true && close.cls === true && close.first === false && close.lastCls === true
        && close.slot === true && close.padB === '16px'
        && open.h != null && Math.abs(open.h - r.codeLineH) < 0.5
        && Math.abs(close.h - (r.codeLineH + 16)) < 0.5]);
      // 2026-10-21：底色/描边/圆角全部移到 ::before 内缩盒（旧 inset shadow 全行宽，
      // 编辑态灰盒比渲染态 pre 左右各宽一段行留白——用户截图反馈），linebackground 自身底色置空
      checks67.push([`灰盒底色 = 渲染态 --code-bg（::before 内缩盒；linebackground 自身底色已置空）`,
        cb.shadowFirst && cb.shadowFirst.before.bg === r.bg && cb.shadowMid && cb.shadowMid.before.bg === r.bg
        && cb.shadowLast && cb.shadowLast.before.bg === r.bg
        && cb.shadowFirst.bg === 'rgba(0, 0, 0, 0)' && cb.shadowMid.bg === 'rgba(0, 0, 0, 0)' && cb.shadowLast.bg === 'rgba(0, 0, 0, 0)']);
      checks67.push([`灰盒描边（::before border，与 pre border 同色）：首/末行三边、中间行两边`,
        cb.shadowFirst.before.bl === '1px' && cb.shadowFirst.before.br === '1px'
        && cb.shadowMid.before.bl === '1px' && cb.shadowMid.before.br === '1px'
        && cb.shadowMid.before.bt === '0px' && cb.shadowMid.before.bb === '0px'
        && cb.shadowLast.before.bt === '0px' && cb.shadowLast.before.bb === '1px'
        && cb.shadowFirst.before.bt === '1px']);
      checks67.push([`灰盒圆角：首行上角 6px / 末行下角 6px（::before，与 pre 同角）`,
        cb.shadowFirst.before.rtl === '6px' && cb.shadowLast.before.rbl === '6px'
        && cb.shadowMid.before.rtl === '0px' && cb.shadowMid.before.rbl === '0px']);
      // 2026-10-21 核心修复断言：编辑态灰盒横向范围 = 渲染态 pre 横向范围（逐缘 Δ<0.5px），
      // 文本 x 两态对位（旧实现盒 = 整行宽含行留白、文本偏左一整段行留白）
      const bf = cb.shadowFirst && cb.shadowFirst.before;
      const px = (v) => parseFloat(v);
      const boxX = bf ? +(bf.lbX + px(bf.left)).toFixed(2) : null;
      const boxW = bf ? +(bf.lbW - px(bf.left) - px(bf.right)).toFixed(2) : null;
      checks67.push([`核心(横)：灰盒 x/宽 = 渲染态 pre x/宽（${boxX}/${boxW} vs ${r.preX}/${r.preW}，内缩=${bf ? bf.left + '/' + bf.right : 'n/a'}）`,
        boxX != null && Math.abs(boxX - r.preX) < 0.5 && Math.abs(boxW - r.preW) < 0.5]);
      checks67.push([`核心(横)：编辑态代码首文本 x = 渲染态（${cb.editTextX} vs ${r.textX}）`,
        cb.editTextX != null && r.textX != null && Math.abs(cb.editTextX - r.textX) < 0.5]);
      checks67.push([`核心(横)：::before 内缩 = 行留白（left/right 相等，= 行基准留白）`,
        bf && bf.left === bf.right && px(bf.left) > 0 && px(bf.left) < 100]);
      // 2026-10-22 口径更新：块总高（行高之和）= 渲染态 pre 高 + 2×代码行高 + 16px 底槽
      //（闭围栏行槽位在盒外，盒绘制高仍 = pre 高 + 2×代码行高，见 S78 盒底↔下一块间距断言）
      checks67.push([`核心(纵)：块总高 = 渲染态 pre 高 + 2×代码行高 + 16px 底槽（${cb.boxH}px vs ${r.preH}+2×${r.codeLineH}+16，Δ=${cb.boxDelta}px）`,
        cb.boxDelta != null && Math.abs(cb.boxDelta - 16) < 0.5]);
      checks67.push([`背景层覆盖 pre padding 区（盒缘与 16px 内距对齐，Δ<0.5px）`,
        cb.bgGeom && Math.abs(cb.bgGeom.bgH - cb.bgGeom.preH) < 0.5
        && Math.abs(cb.bgGeom.topGap) < 0.5]);
      for (const [label, ok] of checks67) {
        console.log(`  ${ok ? '✓' : '✗'} ${label}`);
        if (!ok) fail++;
      }
    }
  }

  // ---------- S68：嵌套列表两态一致（2026-10-17 用户截图：列表有嵌套子项时渲染态与
  // 编辑态不一样）——各层文本 x / 圆点形态 / 有序括号 marker 对齐渲染态 ----------
  {
    console.log('\n=== S68：嵌套列表两态一致（每层 +24px + marker 按层）===');
    const nl = await page.evaluate(() => window.__runNestedList());
    if (nl.err || !nl.renderUl) {
      console.log('  ⚠ 场景失败: ' + (nl.err || '无渲染态测量'));
      fail++;
    } else {
      console.log('  ' + JSON.stringify(nl));
      const checks68 = [];
      const xClose = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= (tol == null ? 0.5 : tol);
      // ① 渲染态基准：li 文本 x = 56 + 24×(层-1)（逐项切块后，ul/ol 均激活「含嵌套子项」
      // 的第二项块：ul = 第二项/子项A/子项B/更深层，ol = 然后/子步骤一/子步骤二）
      const ulX = nl.renderUl.map((r) => r.x), olX = nl.renderOl.map((r) => r.x);
      checks68.push([`渲染态基准：ul 各层文本 x = 56/80/104（实测 ${ulX.join(',')}）`,
        ulX.length === 4 && xClose(ulX[0], 56) && xClose(ulX[1], 80) && xClose(ulX[3], 104)]);
      checks68.push([`渲染态基准：ol 各层文本 x = 56/80（实测 ${olX.join(',')}）`,
        olX.length === 3 && xClose(olX[0], 56) && xClose(olX[1], 80)]);
      // ② 编辑态 ul：各层文本 x = 渲染态；lvl 行类；圆点形态 disc/circle/square
      const eUl = nl.editUl;
      checks68.push([`编辑态 ul：各层文本 x 对齐渲染态（${eUl.map((r) => r.textX).join(',')} vs ${ulX.join(',')}）`,
        eUl.length === ulX.length && eUl.every((r, i) => xClose(r.textX, ulX[i]))]);
      const rA = eUl.find((r) => r.text === '- 嵌套子项'), rC = eUl.find((r) => r.text === '- 更深层嵌');
      checks68.push([`编辑态 ul：二级/三级行挂 lvl-2/lvl-3 行类`,
        rA && rA.lvlCls.join(',') === 'lvl-2' && rC && rC.lvlCls.join(',') === 'lvl-3']);
      const b1 = eUl[0] && eUl[0].bullet, b2 = rA && rA.bullet, b3 = rC && rC.bullet;
      checks68.push([`编辑态 ul 圆点：各层同实心 disc（Edge 16px 下渲染 disc/circle/square 同为 ~6px 实心点）`,
        b1 && b1.bg !== 'rgba(0, 0, 0, 0)' && b1.radius === '50%' && b1.w === '6px'
        && b2 && b2.bg !== 'rgba(0, 0, 0, 0)' && b2.radius === '50%' && b2.w === '6px'
        && b3 && b3.bg !== 'rgba(0, 0, 0, 0)' && b3.radius === '50%' && b3.w === '6px']);
      // ③ 编辑态 ol：各层文本 x；二级「N)」：数字槽 padding 9.228px + 点 span 零宽 + ::after「)」
      const eOl = nl.editOl;
      checks68.push([`编辑态 ol：各层文本 x 对齐渲染态（${eOl.map((r) => r.textX).join(',')} vs ${olX.join(',')}）`,
        eOl.length === olX.length && eOl.every((r, i) => xClose(r.textX, olX[i]))]);
      const s1 = eOl.find((r) => r.text === '1. 子步骤');
      checks68.push([`编辑态 ol 二级：lvl-2 行类 + 数字槽 padding-right 9.228px + 点 span 零宽 + ::after「)」`,
        s1 && s1.lvlCls.join(',') === 'lvl-2' && s1.paren
        && s1.paren.width === '0px' && s1.paren.afterContent === '")"'
        && s1.olMarkPadR === '9.228px']);
      const o1 = eOl[0];
      checks68.push([`编辑态 ol 一级：无括号槽、保持源「N.」（padding-right 4.4px）`,
        o1 && !o1.paren && o1.olMarkPadR === '4.4px']);
      for (const [label, ok] of checks68) {
        console.log(`  ${ok ? '✓' : '✗'} ${label}`);
        if (!ok) fail++;
      }
    }
  }

  // ---------- S69：块间空行光标行灰底 + 连续回车不跳顶（2026-10-21 真机用户报
  // demo.md「图片上方回车新增行无灰色指示 + 输入时页面乱跳到目录位置」）----------
  {
    console.log('\n=== S69：块间空行光标行灰底 + 连续回车不跳顶 ===');
    const g = await page.evaluate(() => window.__runGapCursor2026());
    if (g.err) {
      console.log('  ⚠ 场景失败: ' + g.err);
      fail++;
    } else {
      console.log('  ' + JSON.stringify(g));
      const a = g.a || {}, a2 = g.a2 || {}, b = g.b || {}, c = g.c || {};
      const checks69 = [];
      // 阈值 10px：harness 用基础字体（全高空行 15px），真机预览字体 16px 下为 27.2px；
      // 「未塌缩」的口径由 blank===false + inlineLH 为空承担（塌缩态 inline 行高=0px）
      checks69.push([`光标在块间空行：光标行灰底（active-block）+ 全高（${a.h}px ≥ 10）+ 无空行类/无提示 + activeIdx=-1`,
        a.gray === true && a.h != null && a.h >= 10 && a.blank === false && a.hint === false && a.activeIdx === -1 && a.cursorLine === g.gapLine]);
      checks69.push([`光标离开块间空行：收回塌缩（高 ${a2.h}px < 20 或 inline 间隙恢复）+ 灰底撤销`,
        a2.gray === false && ((a2.h != null && a2.h < 20) || !!(a2.inlineLH && a2.inlineLH !== ''))]);
      checks69.push([`块间空行连续 4×Enter：Enter 全部生效（+${b.lineCountDelta} 行）`,
        b.lineCountDelta === 4]);
      // 阈值口径（2026-10-21 定案）：真实跳变检测器 = spikes（单步 ≥60px）+ 累计漂移
      // <120 + 光标留视口；max|Δ| 放宽到 150——首个 Enter 的一次性锚定收敛（旧空行
      // 塌回 + 新行结构重定位）实测可达 ~53px，属合法行为，不应与「乱跳」混淆。
      checks69.push([`块间空行连续 4×Enter：无跳顶（max|Δtop|=${b.maxDelta}px < 150；${b.topBefore}→${b.topAfter}；尖峰 ${b.spikes} 次）+ 光标留在视口内`,
        b.maxDelta != null && b.maxDelta < 150
        && Math.abs((b.topAfter || 0) - (b.topBefore || 0)) < 120
        && b.spikes === 0 && b.cursorVisible === true]);
      checks69.push([`refresh×3：TOC 遮罩行记录行高保持实测值（${c.recTocBefore}→${c.recTocAfter}px，Δ≤5）+ scrollTop 不动（Δ≤20）`,
        c.recTocBefore != null && c.recTocAfter != null
        && Math.abs(c.recTocAfter - c.recTocBefore) <= 5
        && Math.abs((c.topAfterRefresh || 0) - (c.topBeforeRefresh || 0)) <= 20]);
      for (const [label, ok] of checks69) {
        console.log(`  ${ok ? '✓' : '✗'} ${label}`);
        if (!ok) fail++;
      }
    }
  }

  // ---------- S70：定义列表（dl/dt/dd）两态一致 + dd 行精确落行（2026-10-18 用户截图：
  // 编辑态冒号裸露/无缩进/dt 不加粗，点 dd 行光标落 dt 行）----------
  {
    console.log('\n=== S70：定义列表编辑态 = 渲染态 + dd 行精确落行 ===');
    const dl = await page.evaluate(() => window.__runDefList());
    if (dl.err) {
      console.log('  ⚠ 场景失败: ' + dl.err);
      fail++;
    } else {
      console.log('  ' + JSON.stringify(dl));
      const r = dl.render || {}, e = dl.edit || {};
      const checks70 = [];
      checks70.push([`渲染态基准：dt 粗 600 + 顶距 8px；dd 左缩进 24px + 底距 8px + 次级色（≠dt 色）`,
        r.dtWeight === '600' && r.dtMt === '8px'
        && r.ddMl === '24px' && r.ddMb === '8px'
        && r.ddColor && r.dtColor && r.ddColor !== r.dtColor]);
      // 文档行号（0-based）：5=TizuMark(dt) / 6=: 基于 Tauri…(dd)；点击点在 dd 行上半，
      // 比例估算（分母=遮罩整高）在此位置会误落 dt 行——精确落行断言光标=6
      checks70.push([`点 dd 行上半：光标精确落 dd 源行（行 ${dl.cursorLine}，非 dt 行 5）+ 活动块=TizuMark 项 + 块解罩`,
        dl.cursorLine === 6 && dl.unmasked === true && dl.activeIdx === 2]);
      checks70.push([`编辑态 dt 行：wysiwyg-dt-line 行类 + 粗 600 + 块首顶距 8px + 无 para-line`,
        e.dtCls === true && e.dtWeight === '600' && e.dtPadT === '8px' && e.dtPara === false]);
      checks70.push([`编辑态 dd 行：wysiwyg-dd-line 行类 + 左缩进 56px（行基准 32 + 24，同渲染 dd 相对 dt +24）+ 块末底距 16px + 颜色=渲染态 dd 色 + 无 para-line`,
        e.ddCls === true && e.ddPadL === '56px' && e.ddPadB === '16px'
        && e.ddColor === r.ddColor && e.ddPara === false]);
      // 2026-10-22 用户要求「定义列表编辑态要把 : 显示出来，参考标题的编辑态显示方式」：
      // 冒号由透明改次级色可见（同标题 # 前缀口径），span 真实宽度保留不变
      checks70.push([`编辑态 “: ” 前缀次级色可见 span（= --text-secondary rgb(102,109,121)，真实宽度保留，光标测量不受影响）`,
        e.colon && e.colon.color === 'rgb(102, 109, 121)' && e.colon.w > 5]);
      const ddxGap = r.dtX != null && r.ddX != null ? +(r.ddX - r.dtX).toFixed(2) : null;
      const eddGap = e.dtX != null && e.ddX != null ? +(e.ddX - e.dtX).toFixed(2) : null;
      checks70.push([`编辑态缩进差 = 渲染态缩进差（dd 相对 dt 均 +24px：${eddGap} vs ${ddxGap}）`,
        ddxGap === 24 && eddGap === 24]);
      checks70.push([`核心：编辑块高 = 渲染遮罩高（${e.blockH}px vs ${r.maskH}px，Δ=${dl.hDelta}px，折叠口径 8 顶 + 16 底）`,
        dl.hDelta != null && Math.abs(dl.hDelta) < 0.5]);
      for (const [label, ok] of checks70) {
        console.log(`  ${ok ? '✓' : '✗'} ${label}`);
        if (!ok) fail++;
      }
    }
  }

  // ---------- S71：切块页面位移（2026-10-21 用户反馈「点击某一行进入编辑态，再点击其他
  // 行时，页面会往下移动一段距离」）：① h1–h6 活动态源行高 = 遮罩高（逐像素）；
  // ② 点标题块进编辑态再点定义列表块：参照行顶边全程不动 + 标题行顶边落回遮罩顶边
  //（点击锚点只补偿结构位移——旧口径把行顶钉到点击点，点行中部整页下移半个行高）----------
  {
    console.log('\n=== S71：切块页面位移（标题块高补齐 + 点击锚点只补偿结构位移）===');
    const bs = await page.evaluate(() => window.__runBlockSwitch());
    if (bs.err) {
      console.log('  ⚠ 场景失败: ' + bs.err);
      fail++;
    } else {
      console.log('  matrix: ' + JSON.stringify(bs.matrix));
      console.log('  refTops: ' + JSON.stringify(bs.refTops)
        + '  h2maskTop=' + bs.h2maskTop + '  h2lineTop=' + bs.h2lineTop);
      const checks71 = [];
      for (const row of (bs.matrix || [])) {
        checks71.push([`标题 h${row.lvl}：活动态源行高 = 遮罩高（${row.src}px vs ${row.mask}px，Δ=${row.delta}px）`,
          row.delta != null && Math.abs(row.delta) < 0.5]);
      }
      checks71.push([`切块位移：参照段落行顶边全程不动（点标题→点定义列表，maxShift=${bs.maxRefShift}px）`,
        bs.maxRefShift != null && bs.maxRefShift < 0.5]);
      checks71.push([`点击锚点：标题行顶边落回撤罩前遮罩顶边（${bs.h2lineTop}px vs ${bs.h2maskTop}px，不再钉到点击点）`,
        bs.h2lineTop != null && bs.h2maskTop != null && Math.abs(bs.h2lineTop - bs.h2maskTop) < 0.5]);
      for (const [label, ok] of checks71) {
        console.log(`  ${ok ? '✓' : '✗'} ${label}`);
        if (!ok) fail++;
      }
    }
  }

  // ---------- S72：列表按项显示源码（2026-10-21 用户反馈「光标在高亮标记这一行，插入内容
  // 这一行也展示源码了，应该只显示光标所在行或者所在块的源码」）：点紧凑列表某项 → 只该
  // 项源码，兄弟项保持渲染态；几何不跳（参照行顶不动 + 源行顶落回 li 顶）；li-mid 底距；
  // ol 逐项片段序号不回位 1 ----------
  {
    console.log('\n=== S72：列表按项显示源码（紧凑列表点某项只该项源码）===');
    const li = await page.evaluate(() => window.__runListItem());
    if (li.err) {
      console.log('  ⚠ 场景失败: ' + li.err);
      fail++;
    } else {
      console.log('  initial: ' + JSON.stringify(li.initial));
      console.log('  lines3: ' + JSON.stringify(li.lines3) + '  active3=' + JSON.stringify(li.active3));
      console.log('  lines1: ' + JSON.stringify(li.lines1) + '  active1=' + JSON.stringify(li.active1));
      const checks72 = [];
      const ini = li.initial || {};
      // ① 紧凑列表逐项切块：4 个项遮罩 + first/middle/middle/last 标签
      const itemBlocks = (ini.blocks || []).filter((b) => b[2]);
      checks72.push([`紧凑列表按项切块：4 项 → 4 个逐项块（first/middle/middle/last），共 ${itemBlocks.length} 个`,
        itemBlocks.length === 4
        && itemBlocks.map((b) => b[3]).join(',') === 'first,middle,middle,last'
        && itemBlocks.map((b) => [b[0], b[1]]).join('|') === '2,3|3,4|4,5|5,6']);
      checks72.push([`渲染态：4 个项各自一个遮罩（liMaskCount=${ini.liMaskCount}）`,
        ini.liMaskCount === 4]);
      // ② 点项③ → 只项③源码（①②④保持渲染态）
      checks72.push([`点项③（==高亮标记==）：只该项源码，①②④保持渲染遮罩`,
        li.onlyItem3Source === true && li.active3.cursor.line === 4]);
      checks72.push([`非末项片段挂 li-mid（项间距底缘 4px），末项不挂（列表底距 14px 归末项）`,
        li.liMidOnNonLast === true]);
      checks72.push([`几何不变量：项③源行顶落回撤罩前 li 顶（Δ=${li.src3TopDelta}px < 0.5）`,
        li.src3TopDelta != null && li.src3TopDelta < 0.5]);
      // ③ 切项① → 项③重遮、参照段落行顶全程不动
      checks72.push([`切项①：只项①源码，项③重新遮罩，光标落项①行`,
        li.onlyItem1Source === true && li.active1.cursor.line === 2]);
      checks72.push([`几何不变量：切项全程参照段落行顶不动（maxRefShift=${li.maxRefShift}px < 0.5）`,
        li.maxRefShift != null && li.maxRefShift < 0.5]);
      // ④ ol 逐项片段序号：第 2 项片段 <ol start="2">
      checks72.push([`ol 逐项片段序号不回位 1（第 2 项片段 start="${li.olStart}"，文本「${li.olText}」）`,
        li.olStart === '2' && li.olText === '然后做那件事情']);
      for (const [label, ok] of checks72) {
        console.log(`  ${ok ? '✓' : '✗'} ${label}`);
        if (!ok) fail++;
      }
    }
  }

  // ---------- S73：WYSIWYG details 折叠（2026-10-21 用户反馈「折叠区块，在实时预览时，
  // 没法折叠展开」）：点 summary → 原地折叠/展开（与阅读模式同口径：纯 DOM 瞬态、不回写
  // 源码、重渲染后 normalizeDetails 恢复展开）；不撤罩、不动光标；折叠/展开后遮罩行盒
  // 变高 → cm.refresh() 重测几何，块下段落行顶随高度差精确移动、再展开逐像素回位 ----------
  {
    console.log('\n=== S73：WYSIWYG details 折叠（点 summary 原地折叠/展开）===');
    const d73doc = ['# T', '', '<details>', '<summary>点击展开</summary>', '', '<ul>', '<li>甲</li>', '<li>乙</li>', '</ul>', '', '</details>', '', '尾部参照段落。'].join('\n');
    const d73setup = await page.evaluate((d) => {
      const { cm, ed } = window.__makeWysiwygEditor(d);
      window.__d73cm = cm; window.__d73ed = ed;
      cm.options.viewportMargin = 100000;
      cm.refresh();
      return new Promise((res) => setTimeout(() => {
        cm.setCursor({ line: cm.lineCount() - 1, ch: 0 }, { scroll: false });
        setTimeout(() => res(null), 400);
      }, 400));
    }, d73doc);
    if (d73setup) {
      console.log('  ⚠ 场景失败: ' + d73setup);
      fail++;
    } else {
      const d73state = () => page.evaluate(() => {
        const cm = window.__d73cm, ed = window.__d73ed;
        const dm = Array.from(cm.getWrapperElement().querySelectorAll('.wysiwyg-block-mask')).find((m) => m.querySelector('details'));
        const det = dm && dm.querySelector('details');
        const refH = cm.getLineHandle(cm.lineCount() - 1);
        let refPre = null;
        for (const lv of cm.display.view) if (lv && lv.line === refH) {
          const el = lv.node; refPre = el.tagName === 'PRE' ? el : el.querySelector('pre.CodeMirror-line');
        }
        return {
          stillMasked: !!dm,
          maskH: dm ? Math.round(dm.getBoundingClientRect().height * 100) / 100 : null,
          open: det ? det.open : null,
          refTop: refPre ? Math.round(refPre.getBoundingClientRect().top * 100) / 100 : null,
          cursor: cm.getCursor(),
          activeIdx: ed._wysiwygActiveIdx,
          value: cm.getValue(),
        };
      });
      const d73clickSummary = async () => {
        const pt = await page.evaluate(() => {
          const cm = window.__d73cm;
          const dm = Array.from(cm.getWrapperElement().querySelectorAll('.wysiwyg-block-mask')).find((m) => m.querySelector('details'));
          const sum = dm && dm.querySelector('summary');
          if (!sum) return null;
          const r = sum.getBoundingClientRect();
          return { x: r.x + Math.min(40, r.width / 2), y: r.y + r.height / 2 };
        });
        if (!pt) return false;
        await page.mouse.click(pt.x, pt.y);
        await page.waitForTimeout(250);
        return true;
      };
      const s0 = await d73state();
      await d73clickSummary();
      const s1 = await d73state();
      await d73clickSummary();
      const s2 = await d73state();
      // 编辑他处 → 防抖重渲染 → normalizeDetails 恢复展开（与阅读模式同口径）
      await page.evaluate(async () => {
        const cm = window.__d73cm;
        const last = cm.lineCount() - 1;
        cm.focus();
        cm.replaceRange(' X', { line: last, ch: cm.getLine(last).length });
        await new Promise((res) => setTimeout(res, 600));
      });
      const s3 = await d73state();
      const d73src = s0.value; // 折叠/展开全程源码不得被改写
      const refDeltaErr = s0.refTop != null && s1.refTop != null
        ? Math.abs((s0.refTop - s1.refTop) - (s0.maskH - s1.maskH)) : null;
      const checks73 = [];
      checks73.push([`遮罩态：details 渲染为展开（normalizeDetails 统一 open），参照行顶 ${s0.refTop}px`,
        s0.open === true && s0.stillMasked === true && s0.maskH != null && s0.maskH > 60]);
      checks73.push([`点 summary → 原地折叠：open=false，遮罩高缩到 summary 行（${s0.maskH}→${s1.maskH}px），块不撤罩、光标不动、活动块不变`,
        s1.open === false && s1.stillMasked === true && s1.maskH != null && s1.maskH < s0.maskH - 40
        && JSON.stringify(s1.cursor) === JSON.stringify(s0.cursor) && s1.activeIdx === s0.activeIdx]);
      checks73.push([`折叠后块下段落行顶随高度差精确上移（行顶Δ与遮罩高差之差=${refDeltaErr == null ? 'n/a' : refDeltaErr.toFixed(2)}px < 0.5）：toggle 后 refresh 重测几何`,
        refDeltaErr != null && refDeltaErr < 0.5]);
      checks73.push([`再点 → 展开，遮罩高/参照行顶逐像素回位（Δ=${Math.abs(s2.maskH - s0.maskH).toFixed(2)}/${Math.abs(s2.refTop - s0.refTop).toFixed(2)}px < 0.5）`,
        s2.open === true && Math.abs(s2.maskH - s0.maskH) < 0.5 && Math.abs(s2.refTop - s0.refTop) < 0.5]);
      checks73.push([`折叠/展开全程不回写源码；编辑他处重渲染后恢复展开（与阅读模式同口径）`,
        s1.value === d73src && s2.value === d73src && s3.value === d73src + ' X' && s3.open === true && s3.stillMasked === true]);
      console.log('  state0: ' + JSON.stringify(s0));
      console.log('  state1: ' + JSON.stringify(s1));
      console.log('  state2: ' + JSON.stringify(s2));
      for (const [label, ok] of checks73) {
        console.log(`  ${ok ? '✓' : '✗'} ${label}`);
        if (!ok) fail++;
      }
    }
  }

  // ---------- S74：WYSIWYG 代码块编辑态语法色 ≡ 渲染态（2026-10-21 用户截图反馈「代码块
  // 编辑态文字高亮颜色与渲染态不一样，改为一样的」）：编辑态围栏 token（CM 内层模式
  // cm-keyword/cm-def/…）重映射到 GitHub hljs 色板（styles.css wysiwyg-code-line span.cm-*
  // 规则）——keyword/def/comment/number/string/基色 与渲染态遮罩 hljs span 逐色相等；
  // 围栏标志行保持次级色（不被评论灰覆盖） ----------
  {
    console.log('\n=== S74：WYSIWYG 代码块编辑态语法色 ≡ 渲染态 ===');
    const s74doc = [
      '# T', '', '```javascript', '// 二分查找 - 经典算法实现',
      'function binarySearch(arr, target) {', '  let left = 0;',
      '  let right = arr.length - 1;', '  while (left <= right) {',
      '    const mid = Math.floor((left + right) / 2);', '    const s = "字符串";',
      '  }', '  return -1;', '}', '```', '', '尾部段落。',
    ].join('\n');
    const s74 = await page.evaluate(async (d) => {
      const { cm, ed } = window.__makeWysiwygEditor(d);
      cm.options.viewportMargin = 100000;
      cm.refresh();
      await new Promise((res) => setTimeout(res, 400));
      cm.setCursor({ line: 5, ch: 4 }, { scroll: false });
      await new Promise((res) => setTimeout(res, 500));
      const getPre = (n) => {
        const h = cm.getLineHandle(n);
        for (const lv of cm.display.view) if (lv && lv.line === h) {
          const el = lv.node;
          return el.tagName === 'PRE' ? el : el.querySelector('pre.CodeMirror-line');
        }
        return null;
      };
      const pick = (n, cls) => {
        const pre = getPre(n);
        const el = Array.from(pre.querySelectorAll('span')).find((s) => String(s.className).split(' ').includes(cls));
        return el ? getComputedStyle(el).color : null;
      };
      const edit = {
        keyword: pick(4, 'cm-keyword'),
        def: pick(4, 'cm-def'),
        comment: pick(3, 'cm-comment'),
        number: pick(5, 'cm-number'),
        string: pick(9, 'cm-string'),
        base: getComputedStyle(getPre(5)).color,
        fence: (function () {
          const el = getPre(2).querySelector('[class*="wysiwyg-code-fence"]');
          return el ? getComputedStyle(el).color : null;
        })(),
      };
      cm.setCursor({ line: cm.lineCount() - 1, ch: 0 }, { scroll: false });
      await new Promise((res) => setTimeout(res, 600));
      const mask = cm.getWrapperElement().querySelector('.wysiwyg-block-mask pre');
      if (!mask) return { err: '撤罩后未找到代码遮罩' };
      const findHljs = (cls) => {
        const el = Array.from(mask.querySelectorAll('span')).find((s) => String(s.className).split(' ').includes(cls));
        return el ? getComputedStyle(el).color : null;
      };
      return {
        edit,
        render: {
          keyword: findHljs('hljs-keyword'),
          def: findHljs('function_'),
          comment: findHljs('hljs-comment'),
          number: findHljs('hljs-number'),
          string: findHljs('hljs-string'),
          base: getComputedStyle(mask.querySelector('.hljs') || mask).color,
        },
      };
    }, s74doc);
    if (s74.err) {
      console.log('  ⚠ 场景失败: ' + s74.err);
      fail++;
    } else {
      console.log('  edit: ' + JSON.stringify(s74.edit));
      console.log('  render: ' + JSON.stringify(s74.render));
      const checks74 = [
        [`keyword（function/let/const…）≡ .hljs-keyword（${s74.edit.keyword}）`,
          s74.edit.keyword !== null && s74.edit.keyword === s74.render.keyword],
        [`函数名/声明名 ≡ .hljs-title.function_（${s74.edit.def}）`,
          s74.edit.def === s74.render.def],
        [`代码注释 ≡ .hljs-comment（${s74.edit.comment}）`,
          s74.edit.comment === s74.render.comment],
        [`数字 ≡ .hljs-number（${s74.edit.number}）`,
          s74.edit.number === s74.render.number],
        [`字符串 ≡ .hljs-string（${s74.edit.string}）`,
          s74.edit.string === s74.render.string],
        [`普通文本基色 ≡ .hljs 基色（${s74.edit.base}）`,
          s74.edit.base === s74.render.base],
        [`围栏标志行保持次级色、未被评论灰覆盖（${s74.edit.fence} ≠ ${s74.edit.comment}）`,
          s74.edit.fence !== null && s74.edit.fence !== s74.edit.comment],
      ];
      for (const [label, ok] of checks74) {
        console.log(`  ${ok ? '✓' : '✗'} ${label}`);
        if (!ok) fail++;
      }
    }
  }

  // ---------- S76：WYSIWYG details 交互与观感（2026-10-22 用户要求：① 折叠区块不允许点击
  // 文字进入编辑态，需点后面的编辑按钮进入；② 进入编辑态要在灰色块中编辑（参考代码块）；
  // ③ 小三角 hover 显示小手——阅读模式与 WYSIWYG 遮罩共用 preview-content，一条规则覆盖）
  // ----------
  {
    console.log('\n=== S76：WYSIWYG details（点文字不进编辑态 / 编辑按钮进灰盒 / 小三角小手）===');
    const s76doc = ['# T', '', '<details>', '<summary>点击展开：快捷键一览</summary>', '', '<ul>', '<li>保存文档</li>', '<li>查找内容</li>', '</ul>', '', '</details>', '', '尾部参照段落。'].join('\n');
    const s76setup = await page.evaluate((d) => {
      const { cm, ed } = window.__makeWysiwygEditor(d);
      window.__s76cm = cm; window.__s76ed = ed;
      cm.options.viewportMargin = 100000;
      cm.refresh();
      return new Promise((res) => setTimeout(() => {
        cm.setCursor({ line: cm.lineCount() - 1, ch: 0 }, { scroll: false });
        setTimeout(() => res(null), 400);
      }, 400));
    }, s76doc);
    if (s76setup) {
      console.log('  ⚠ 场景失败: ' + s76setup);
      fail++;
    } else {
      const s76state = () => page.evaluate(() => {
        const cm = window.__s76cm, ed = window.__s76ed;
        const dm = Array.from(cm.getWrapperElement().querySelectorAll('.wysiwyg-block-mask')).find((m) => m.querySelector('details'));
        const det = dm && dm.querySelector('details');
        const sum = dm && dm.querySelector('summary');
        const refH = cm.getLineHandle(cm.lineCount() - 1);
        let refPre = null;
        for (const lv of cm.display.view) if (lv && lv.line === refH) {
          const el = lv.node; refPre = el.tagName === 'PRE' ? el : el.querySelector('pre.CodeMirror-line');
        }
        // 活动块源行行类（仅当 details 块是活动块时有意义）
        const lines = [];
        for (let n = 0; n < cm.lineCount(); n++) {
          const h = cm.getLineHandle(n);
          if (!h || !h.bgClass) continue;
          const cls = String(h.bgClass);
          let preCls = '';
          let pEl = null;
          for (const lv of cm.display.view) if (lv && lv.line === h) {
            const el = lv.node;
            const p = el && el.tagName === 'PRE' ? el : (el && el.querySelector ? el.querySelector('pre.CodeMirror-line') : null);
            if (p) { preCls = String(p.className || ''); pEl = p; }
            break;
          }
          if (cls.indexOf('cm-wysiwyg-code-box') >= 0 || preCls.indexOf('wysiwyg-details-line') >= 0) {
            lines.push({
              n,
              box: cls.indexOf('cm-wysiwyg-code-box') >= 0,
              first: cls.indexOf('cm-wysiwyg-active-first') >= 0,
              last: cls.indexOf('cm-wysiwyg-active-last') >= 0,
              dLine: preCls.indexOf('wysiwyg-details-line') >= 0,
              padL: pEl ? getComputedStyle(pEl).paddingLeft : null,
            });
          }
        }
        return {
          stillMasked: !!dm,
          open: det ? det.open : null,
          summaryCursor: sum ? getComputedStyle(sum).cursor : null,
          refTop: refPre ? Math.round(refPre.getBoundingClientRect().top * 100) / 100 : null,
          cursor: cm.getCursor(),
          activeIdx: ed._wysiwygActiveIdx,
          lines,
        };
      });
      const s76pt = async (sel) => page.evaluate((s) => {
        const cm = window.__s76cm;
        const dm = Array.from(cm.getWrapperElement().querySelectorAll('.wysiwyg-block-mask')).find((m) => m.querySelector('details'));
        const el = dm && dm.querySelector(s);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + Math.min(60, r.width / 2), y: r.y + r.height / 2 };
      }, sel);
      const s76click = async (pt) => {
        if (!pt) return false;
        await page.mouse.click(pt.x, pt.y);
        await page.waitForTimeout(300);
        return true;
      };
      const a0 = await s76state();
      // ① 点 details 正文（li 文字）：不进编辑态
      const pBody = await s76pt('details ul li');
      await s76click(pBody);
      const a1 = await s76state();
      // ② 点 summary：原地折叠/展开 + 小手
      const pSum = await s76pt('summary');
      await s76click(pSum);
      const a2 = await s76state();
      // ③ 点编辑按钮：进编辑态（灰盒）
      const pBtn = await s76pt('button.block-edit-btn');
      await s76click(pBtn);
      const a3 = await s76state();
      const checks76 = [];
      checks76.push([`小三角小手：summary 计算 cursor=pointer（WYSIWYG 遮罩与阅读预览共用 preview-content）`,
        a0.summaryCursor === 'pointer']);
      checks76.push([`点 details 正文文字：不进编辑态（仍遮罩、光标/活动块不变、无灰盒行）`,
        a1.stillMasked === true && JSON.stringify(a1.cursor) === JSON.stringify(a0.cursor)
        && a1.activeIdx === a0.activeIdx && a1.lines.length === 0]);
      checks76.push([`点 summary：原地折叠（open=false），块不撤罩、光标不动（S73 口径保持）`,
        a2.open === false && a2.stillMasked === true && JSON.stringify(a2.cursor) === JSON.stringify(a0.cursor)]);
      const boxLines = a3.lines || [];
      const firstLine = boxLines.find((l) => l.first), lastLine = boxLines.find((l) => l.last);
      const nonBlank = boxLines.filter((l) => l.dLine);
      checks76.push([`点编辑按钮：进编辑态且整块灰盒（details 块 7 个非空行全挂 code-box 背景，首/末行挂角类）`,
        a3.stillMasked === false && boxLines.length >= 7
        && boxLines.every((l) => l.box === true) && !!firstLine && !!lastLine]);
      checks76.push([`灰盒内编辑：非空源行挂 wysiwyg-details-line（左右内距 44px=32+12，源码不贴盒竖边）`,
        nonBlank.length >= 7 && nonBlank.every((l) => l.padL === '44px')]);
      console.log('  state0: ' + JSON.stringify(a0));
      console.log('  state1(点正文): ' + JSON.stringify(a1));
      console.log('  state2(点summary): ' + JSON.stringify(a2));
      console.log('  state3(编辑按钮): lines=' + JSON.stringify(boxLines));
      for (const [label, ok] of checks76) {
        console.log(`  ${ok ? '✓' : '✗'} ${label}`);
        if (!ok) fail++;
      }
    }
  }

  // ---------- S78：相邻代码块 渲染态≡编辑态 间距（2026-10-22 用户要求「两个代码块挨着，
  // 第一个进编辑态后底部与第二个紧密相连，不方便编辑和查看」）：渲染态遮罩是 flow-root BFC、
  // 含 pre 的 16px 底边距槽（两遮罩间 16px 白槽）；编辑态活动块原无此槽 → 灰盒底缘贴下一块。
  // 修法：闭围栏行挂 16px 底槽 + 灰盒 ::before 底缘上移 16px → 编辑态盒底↔下一块 ≡ 渲染态
  // 16px；灰盒绘制高不变（= pre 高 + 2×代码行高） ----------
  // ---------- S79：WYSIWYG details 编辑态 Enter 语义（2026-10-22 用户报「会车时下面的
  // </details> 会跑出灰色框去；从末尾点击回车会跳出折叠列表编辑态，在折叠列表下方新增一行——
  // 应该是正常的在灰色框中新增行」）：
  // ① 末内容行行尾回车 → 新空行在块内、</details> 恒留在灰盒内（不跑出盒）；
  // ② </details> 闭标签行回车（=「从末尾」）→ 新行插在闭标签**之前**（块内灰盒内），
  //    编辑态不丢（activeIdx 不变）、</details> 行不被劈开、块外不新增行。
  // 实现 = format.js _handleTableEnter 钩 _wysiwygEnterOnDetailsCloseLine（wysiwyg.js） ----------
  {
    console.log('\n=== S79：WYSIWYG 容器块编辑态 Enter（块末结构行回车不出盒）===');
    const s79doc = ['# T', '', '<details>', '<summary>点击展开：快捷键一览</summary>', '', '<ul>', '<li>保存文档</li>', '<li>查找内容</li>', '</ul>', '', '</details>', '', '尾部参照段落。'].join('\n');
    const s79setup = await page.evaluate((d) => {
      const { cm, ed } = window.__makeWysiwygEditor(d);
      window.__s79cm = cm; window.__s79ed = ed;
      cm.options.viewportMargin = 100000;
      cm.refresh();
      return new Promise((res) => setTimeout(() => {
        cm.setCursor({ line: cm.lineCount() - 1, ch: 0 }, { scroll: false });
        setTimeout(() => res(null), 400);
      }, 400));
    }, s79doc);
    if (s79setup) {
      console.log('  ⚠ 场景失败: ' + s79setup);
      fail++;
    } else {
      const s79state = () => page.evaluate(() => {
        const cm = window.__s79cm, ed = window.__s79ed;
        const lines = [];
        for (let n = 0; n < cm.lineCount(); n++) {
          const h = cm.getLineHandle(n);
          const cls = String((h && h.bgClass) || '');
          lines.push({ n, text: cm.getLine(n), box: cls.indexOf('cm-wysiwyg-code-box') >= 0,
            first: cls.indexOf('cm-wysiwyg-active-first') >= 0, last: cls.indexOf('cm-wysiwyg-active-last') >= 0,
            act: cls.indexOf('cm-wysiwyg-active-block') >= 0 });
        }
        return { lineCount: cm.lineCount(), cursor: cm.getCursor(), activeIdx: ed._wysiwygActiveIdx,
          blocks: ed._wysiwygBlocks.map((b) => [b.start, b.end]), lines };
      });
      const s79focusCursor = (line, ch) => page.evaluate((p) => {
        const cm = window.__s79cm;
        cm.focus();
        cm.setCursor({ line: p.line, ch: p.ch }, { scroll: false });
        return cm.getCursor();
      }, { line, ch });
      const detIdx = await page.evaluate(() => {
        const cm = window.__s79cm, ed = window.__s79ed;
        return ed._wysiwygBlocks.findIndex((b) => /^\s*<details[\s>]/.test(cm.getLine(b.start) || ''));
      });
      // 进入编辑态（与 S76 同 API），光标落末内容行（</ul>）行尾
      const lastContent = await page.evaluate((i) => {
        const cm = window.__s79cm, ed = window.__s79ed;
        ed.setWysiwygActiveBlock(i);
        const b = ed._wysiwygBlocks[i];
        let last = -1;
        for (let n = b.start; n < b.end; n++) {
          const t = (cm.getLine(n) || '').trim();
          if (t && t !== '</details>') last = n;
        }
        cm.focus();
        cm.setCursor({ line: last, ch: cm.getLineHandle(last).text.length }, { scroll: false });
        return last;
      }, detIdx);
      await page.waitForTimeout(800);
      const e0 = await s79state();
      const checks79 = [];
      checks79.push([`前置：details 块编辑态整块灰盒（块表边界含 </details> 行）`,
        e0.activeIdx === detIdx && e0.blocks[detIdx][1] === 11
        && e0.lines.slice(2, 11).every((l) => l.box === true)]);
      // ① 末内容行（</ul>）行尾回车：新空行在块内，</details> 不出盒
      await page.keyboard.press('Enter');
      await page.waitForTimeout(800);
      const a1 = await s79state();
      const close1 = a1.lines.findIndex((l) => (l.text || '').trim() === '</details>');
      checks79.push([`① 末内容行回车：新空行插在 </details> 前（块内），</details> 行仍在灰盒内`,
        close1 === 11 && (a1.lines[close1 - 1].text || '') === ''
        && a1.lines[close1].box === true && a1.activeIdx === detIdx]);
      // ② </details> 闭标签行行尾回车（=「从末尾」）：新行插闭标签前，不出盒、不跳出编辑态
      await s79focusCursor(close1, (a1.lines[close1].text || '').length);
      await page.waitForTimeout(300);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(800);
      const a2 = await s79state();
      const close2 = a2.lines.findIndex((l) => (l.text || '').trim() === '</details>');
      checks79.push([`② </details> 行回车：新空行插在闭标签**前**（块外不新增行），闭标签行完整未劈开`,
        close2 === 12 && a2.lineCount === a1.lineCount + 1
        && (a2.lines[close2 - 1].text || '') === ''
        && (a2.lines[close2 + 1].text || '') === ''
        && a2.lines[close2].text === '</details>']);
      checks79.push([`② 编辑态保持（activeIdx 不变、非 -1），新行与 </details> 行均在灰盒内，光标落新行行首`,
        a2.activeIdx === detIdx && a2.lines[close2 - 1].box === true && a2.lines[close2].box === true
        && a2.cursor.line === close2 - 1 && a2.cursor.ch === 0]);
      // ③ 块外普通段落回车不受钩子影响（正常换行）
      const tail = a2.lines.findIndex((l) => (l.text || '') === '尾部参照段落。');
      await s79focusCursor(tail, (a2.lines[tail].text || '').length);
      await page.waitForTimeout(300);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(800);
      const a3 = await s79state();
      checks79.push([`③ 块外段落回车：正常换行（新空行在段落后、光标落新行），钩子无误伤`,
        a3.lineCount === a2.lineCount + 1 && (a3.lines[tail + 1].text || '') === ''
        && a3.cursor.line === tail + 1]);
      // —— Part B：围栏块（代码 + mermaid 图表）：2026-10-25 用户要求「末尾的 ``` 像普通
      // 内容一样可编辑，在 ``` 后面回车应在 ``` 下面增加一行」（口径同日最终确认：新行在
      // ``` **下方**，代码块**跳出灰盒**重新遮罩）→ 闭围栏行不拦截，回车走默认换行，
      // 新行落围栏下方（块外），代码块经正常活动块切换重新遮罩、光标行挂光标行底色。
      // 另回归「代码块内输入时 ``` 闪出灰盒」：块内增行使闭围栏行号下移，250ms 防抖窗口
      // 内块表由 _wysiwygPatchBlockTableForChange 即时修补（免重解析）→ 灰盒/装饰不按
      // 陈旧范围走，闭围栏始终在盒内。
      // ——
      const s79bDoc = ['# T', '', '```js', 'const a = 1;', '```', '', '```mermaid', 'graph TD', '    A[开始] --> B[结束]', '```', '', '尾部参照段落。'].join('\n');
      await page.evaluate((d) => {
        const { cm, ed } = window.__makeWysiwygEditor(d);
        window.__s79cm = cm; window.__s79ed = ed;
        cm.options.viewportMargin = 100000;
        cm.refresh();
        cm.setCursor({ line: cm.lineCount() - 1, ch: 0 }, { scroll: false });
      }, s79bDoc);
      await page.waitForTimeout(800);
      const s79bFocusFenceLine = (idx, line) => page.evaluate((p) => {
        const cm = window.__s79cm, ed = window.__s79ed;
        ed.setWysiwygActiveBlock(p.idx);
        cm.focus();
        cm.setCursor({ line: p.line, ch: cm.getLineHandle(p.line).text.length }, { scroll: false });
      }, { idx, line });
      // ④ 代码块（js 围栏）末内容行（闭围栏上一行）回车 → 闭围栏下移：
      // 防抖窗口内即时采样，闭围栏必须已在灰盒内（修复前：陈旧范围下闭围栏露在盒外，
      // 250ms 防抖后才收回 = 用户看到的「闪一下又恢复」）
      const jsIdx = await page.evaluate(() => {
        const cm = window.__s79cm, ed = window.__s79ed;
        return ed._wysiwygBlocks.findIndex((b) => /^\s{0,3}`{3,}js\b/.test(cm.getLine(b.start) || ''));
      });
      const jsb = await page.evaluate((i) => {
        const ed = window.__s79ed;
        const b = ed._wysiwygBlocks[i];
        return [b.start, b.end];
      }, jsIdx);
      const jsbCount0 = (await s79state()).lineCount;
      await s79bFocusFenceLine(jsIdx, jsb[1] - 2); // 末内容行行尾
      await page.waitForTimeout(300);
      await page.keyboard.press('Enter');
      // 立即采样（250ms 防抖窗口内）
      const c1 = await s79state();
      const fenceC1 = c1.lines.findIndex((l, n) => n > jsb[0] && /^```$/.test(l.text || ''));
      checks79.push([`④ 代码块内末内容行回车：250ms 防抖窗口内即时采样，闭围栏已在灰盒内（无闪出盒窗口）`,
        fenceC1 === jsb[1] && c1.lines[fenceC1].box === true
        && c1.lines[fenceC1 - 1].box === true
        && c1.activeIdx === jsIdx && c1.cursor.line === fenceC1 - 1 && c1.cursor.ch === 0
        && c1.lineCount === jsbCount0 + 1]);
      await page.waitForTimeout(800);
      const c1l = await s79state();
      checks79.push([`④ 防抖收敛后：围栏块表边界扩一行（闭围栏下移入块），灰盒全块稳定`,
        c1l.blocks[jsIdx][0] === jsb[0] && c1l.blocks[jsIdx][1] === jsb[1] + 1
        && c1l.lines[c1l.blocks[jsIdx][0]].box === true
        && c1l.lines[c1l.blocks[jsIdx][1] - 1].box === true]);
      // ⑤ 代码块闭围栏行行尾回车：新行落 ``` 下方（块外），代码块跳出灰盒重新遮罩，
      // 光标落新行行首（块间空行光标行底色）
      await s79bFocusFenceLine(jsIdx, c1l.blocks[jsIdx][1] - 1); // 闭围栏行行尾
      await page.waitForTimeout(300);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(800);
      const b1 = await s79state();
      const fence1 = b1.lines.findIndex((l, n) => n > jsb[0] && /^```$/.test(l.text || ''));
      checks79.push([`⑤ 代码块闭围栏行行尾回车：新空行在 \`\`\` **下方**（块外），代码块重新遮罩（灰盒撤）、光标落新行行首`,
        fence1 === jsb[1] && b1.lines[fence1].text === '```'
        && (b1.lines[fence1 + 1].text || '') === ''
        && b1.lines[fence1 + 1].act === true
        && b1.activeIdx !== jsIdx && b1.lines[jsb[0]].box === false && b1.lines[fence1].box === false
        && b1.cursor.line === fence1 + 1 && b1.cursor.ch === 0
        && b1.lineCount === c1l.lineCount + 1]);
      // ⑥ mermaid 图表块闭围栏行行尾回车（同一口径）
      const mIdx = await page.evaluate(() => {
        const cm = window.__s79cm, ed = window.__s79ed;
        return ed._wysiwygBlocks.findIndex((b) => /^\s{0,3}`{3,}mermaid\b/.test(cm.getLine(b.start) || ''));
      });
      const mb = await page.evaluate((i) => {
        const ed = window.__s79ed;
        const b = ed._wysiwygBlocks[i];
        return [b.start, b.end];
      }, mIdx);
      const mbCount = (await s79state()).lineCount;
      await s79bFocusFenceLine(mIdx, mb[1] - 1);
      await page.waitForTimeout(300);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(800);
      const b2 = await s79state();
      const fence2 = b2.lines.findIndex((l, n) => n > mb[0] && /^```$/.test(l.text || ''));
      checks79.push([`⑥ mermaid 图表闭围栏行行尾回车：新空行在 \`\`\` **下方**（块外），图表块重新遮罩、光标落新行行首（同口径）`,
        fence2 === mb[1] - 1 && b2.lines[fence2].text === '```'
        && (b2.lines[fence2 + 1].text || '') === ''
        && b2.lines[fence2 + 1].act === true
        && b2.activeIdx !== mIdx && b2.lines[mb[0]].box === false && b2.lines[fence2].box === false
        && b2.cursor.line === fence2 + 1 && b2.cursor.ch === 0
        && b2.lineCount === mbCount + 1]);
      console.log('  edit态: lastContent=' + lastContent + ' active=' + e0.activeIdx + ' blocks=' + JSON.stringify(e0.blocks));
      console.log('  ①后: </details>@' + close1 + ' cursor=' + JSON.stringify(a1.cursor) + ' active=' + a1.activeIdx);
      console.log('  ②后: </details>@' + close2 + ' cursor=' + JSON.stringify(a2.cursor) + ' active=' + a2.activeIdx);
      console.log('  ③后: cursor=' + JSON.stringify(a3.cursor) + ' active=' + a3.activeIdx);
      console.log('  ④后(js 块内回车): 闭围栏@' + fenceC1 + ' cursor=' + JSON.stringify(c1.cursor) + ' active=' + c1.activeIdx + ' blocks=' + JSON.stringify(c1l.blocks));
      console.log('  ⑤后(js 闭围栏回车): 闭围栏@' + fence1 + ' cursor=' + JSON.stringify(b1.cursor) + ' active=' + b1.activeIdx);
      console.log('  ⑥后(mermaid): 闭围栏@' + fence2 + ' cursor=' + JSON.stringify(b2.cursor) + ' active=' + b2.activeIdx);
      for (const [label, ok] of checks79) {
        console.log(`  ${ok ? '✓' : '✗'} ${label}`);
        if (!ok) fail++;
      }
    }
  }

  // ---------- S80：WYSIWYG HTML 容器块（<center>/<div>…）整块灰盒（2026-10-25 用户要求：
  // 「居中显示等具有编辑按钮的，编辑时是编辑整块源码的，都在灰色块中进行编辑」）。
  // 块首行为 CommonMark 原始 HTML 块标签（isHtmlBlockContainerLine 收口口径）→ 同代码块/
  // 折叠区块：整块源行进灰盒（code-box 背景 + 首/末角类）+ 源行 wysiwyg-html-block-line
  // 左右 12px 内距（与 details-line 共享声明，44px=32+12）。普通段落不受影响（仅光标行底色）。
  // ----------
  {
    console.log('\n=== S80：WYSIWYG HTML 容器块（<center>/<div>）整块灰盒（点遮罩/编辑按钮进编辑 / 普通段落不受影响）===');
    const s80doc = ['# T', '', '<center>', '居中显示的文本', '</center>', '', '<div class="note">', 'div 块内容', '</div>', '', '尾部参照段落。'].join('\n');
    const s80setup = await page.evaluate((d) => {
      const { cm, ed } = window.__makeWysiwygEditor(d);
      window.__s80cm = cm; window.__s80ed = ed;
      cm.options.viewportMargin = 100000;
      cm.refresh();
      return new Promise((res) => setTimeout(() => {
        cm.setCursor({ line: cm.lineCount() - 1, ch: 0 }, { scroll: false });
        setTimeout(() => res(null), 400);
      }, 400));
    }, s80doc);
    if (s80setup) {
      console.log('  ⚠ 场景失败: ' + s80setup);
      fail++;
    } else {
      const s80state = () => page.evaluate(() => {
        const cm = window.__s80cm, ed = window.__s80ed;
        const masks = Array.from(cm.getWrapperElement().querySelectorAll('.wysiwyg-block-mask'));
        const cmMask = masks.find((m) => m.querySelector('center'));
        const divMask = masks.find((m) => m.querySelector('div.note'));
        // 灰盒行 / 容器行类（box 背景或 html-block-line 行类之一）
        const lines = [];
        for (let n = 0; n < cm.lineCount(); n++) {
          const h = cm.getLineHandle(n);
          if (!h || !h.bgClass) continue;
          const cls = String(h.bgClass);
          let preCls = '';
          let pEl = null;
          for (const lv of cm.display.view) if (lv && lv.line === h) {
            const el = lv.node;
            const p = el && el.tagName === 'PRE' ? el : (el && el.querySelector ? el.querySelector('pre.CodeMirror-line') : null);
            if (p) { preCls = String(p.className || ''); pEl = p; }
            break;
          }
          if (cls.indexOf('cm-wysiwyg-code-box') >= 0 || preCls.indexOf('wysiwyg-html-block-line') >= 0) {
            lines.push({
              n,
              box: cls.indexOf('cm-wysiwyg-code-box') >= 0,
              first: cls.indexOf('cm-wysiwyg-active-first') >= 0,
              last: cls.indexOf('cm-wysiwyg-active-last') >= 0,
              hLine: preCls.indexOf('wysiwyg-html-block-line') >= 0,
              text: h.text,
              padL: pEl ? getComputedStyle(pEl).paddingLeft : null,
            });
          }
        }
        // 普通（非盒）活动行：仅光标行底色、无 code-box
        const plainActive = [];
        for (let n = 0; n < cm.lineCount(); n++) {
          const h = cm.getLineHandle(n);
          if (!h || !h.bgClass) continue;
          const cls = String(h.bgClass);
          if (cls.indexOf('cm-wysiwyg-active-block') >= 0 && cls.indexOf('cm-wysiwyg-code-box') < 0) {
            plainActive.push({ n, text: h.text });
          }
        }
        return {
          centerMasked: !!cmMask,
          divMasked: !!divMask,
          centerHasBtn: !!(cmMask && cmMask.querySelector('button.block-edit-btn')),
          cursor: cm.getCursor(),
          activeIdx: ed._wysiwygActiveIdx,
          centerIdx: ed._wysiwygBlocks.findIndex((b) => (cm.getLine(b.start) || '').trim() === '<center>'),
          divIdx: ed._wysiwygBlocks.findIndex((b) => (cm.getLine(b.start) || '').trim() === '<div class="note">'),
          centerRange: (function () { const i = ed._wysiwygBlocks.findIndex((b) => (cm.getLine(b.start) || '').trim() === '<center>'); const b = ed._wysiwygBlocks[i]; return b ? [b.start, b.end] : null; })(),
          divRange: (function () { const i = ed._wysiwygBlocks.findIndex((b) => (cm.getLine(b.start) || '').trim() === '<div class="note">'); const b = ed._wysiwygBlocks[i]; return b ? [b.start, b.end] : null; })(),
          lines,
          plainActive,
        };
      });
      const s80pt = async (kind) => page.evaluate((k) => {
        const cm = window.__s80cm;
        const masks = Array.from(cm.getWrapperElement().querySelectorAll('.wysiwyg-block-mask'));
        let el = null;
        const cmMask = masks.find((m) => m.querySelector('center'));
        const divMask = masks.find((m) => m.querySelector('div.note'));
        if (k === 'centerBody') el = cmMask && cmMask.querySelector('center');
        else if (k === 'divBtn') el = divMask && divMask.querySelector('button.block-edit-btn');
        else if (k === 'para') el = null;
        if (k === 'para') {
          const ph = cm.getLineHandle(cm.lineCount() - 1);
          for (const lv of cm.display.view) if (lv && lv.line === ph) {
            const p = lv.node && lv.node.tagName === 'PRE' ? lv.node : lv.node && lv.node.querySelector && lv.node.querySelector('pre.CodeMirror-line');
            if (p) { el = p; break; }
          }
        }
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + Math.min(80, r.width / 2), y: r.y + r.height / 2 };
      }, kind);
      const s80click = async (pt) => {
        if (!pt) return false;
        await page.mouse.click(pt.x, pt.y);
        await page.waitForTimeout(400);
        return true;
      };
      const s80remask = async () => {
        await page.evaluate(() => { const ed = window.__s80ed; try { ed.setWysiwygActiveBlock(-1); } catch (_) {} });
        await page.waitForTimeout(400);
      };
      const a0 = await s80state();
      const checks80 = [];
      checks80.push([`前置：<center> 块挂「编辑」按钮（遮罩侧容器块口径），两容器块均遮罩`,
        a0.centerMasked === true && a0.divMasked === true && a0.centerHasBtn === true && a0.lines.length === 0]);
      // ① 点 <center> 遮罩正文：整块进编辑态 + 整块灰盒
      const pC = await s80pt('centerBody');
      await s80click(pC);
      const a1 = await s80state();
      const cLines = (a1.lines || []).filter((l) => a1.centerRange && l.n >= a1.centerRange[0] && l.n < a1.centerRange[1]);
      const cFirst = cLines.find((l) => l.text === '<center>');
      const cLast = cLines.find((l) => l.text === '</center>');
      checks80.push([`① 点 <center> 遮罩正文：撤罩进编辑态，整块 3 行全挂 code-box 灰盒（首行上角、末行下角）`,
        a1.centerMasked === false && a1.activeIdx === a1.centerIdx && cLines.length === 3
        && cLines.every((l) => l.box === true)
        && cFirst && cFirst.first === true && cLast && cLast.last === true]);
      checks80.push([`① 灰盒内源行挂 wysiwyg-html-block-line（左右内距 44px=32+12，源码不贴盒竖边）`,
        cLines.length === 3 && cLines.every((l) => l.hLine === true && l.padL === '44px')]);
      // ② 点 <div> 块编辑按钮：同口径整块灰盒（另一容器标签、按钮入口）
      await s80remask();
      const pD = await s80pt('divBtn');
      await s80click(pD);
      const a2 = await s80state();
      const dLines = (a2.lines || []).filter((l) => a2.divRange && l.n >= a2.divRange[0] && l.n < a2.divRange[1]);
      const dFirst = dLines.find((l) => l.text === '<div class="note">');
      const dLast = dLines.find((l) => l.text === '</div>');
      checks80.push([`② 点 <div> 块编辑按钮：整块 3 行全挂 code-box 灰盒（首行上角、末行下角）+ 行内距 44px`,
        a2.divMasked === false && a2.activeIdx === a2.divIdx && dLines.length === 3
        && dLines.every((l) => l.box === true && l.hLine === true && l.padL === '44px')
        && dFirst && dFirst.first === true && dLast && dLast.last === true]);
      // ③ 普通段落不受影响：仅光标行底色、无灰盒
      await s80remask();
      const pP = await s80pt('para');
      await s80click(pP);
      const a3 = await s80state();
      checks80.push([`③ 点普通段落：仅光标行底色（cm-wysiwyg-active-block），无 code-box 灰盒、无 html-block-line`,
        a3.lines.length === 0 && a3.plainActive.length === 1 && a3.plainActive[0].text === '尾部参照段落。']);
      console.log('  state0: ' + JSON.stringify({ centerMasked: a0.centerMasked, divMasked: a0.divMasked, centerHasBtn: a0.centerHasBtn, centerIdx: a0.centerIdx, divIdx: a0.divIdx }));
      console.log('  ①后(center): active=' + a1.activeIdx + ' lines=' + JSON.stringify(cLines));
      console.log('  ②后(div): active=' + a2.activeIdx + ' lines=' + JSON.stringify(dLines));
      console.log('  ③后(段落): active=' + a3.activeIdx + ' plainActive=' + JSON.stringify(a3.plainActive) + ' boxLines=' + a3.lines.length);
      for (const [label, ok] of checks80) {
        console.log(`  ${ok ? '✓' : '✗'} ${label}`);
        if (!ok) fail++;
      }
    }
  }

  // ---------- S81：① 定义列表不挂「编辑」按钮（2026-10-25 用户要求，点行即编辑同列表口径）；
  // ② WYSIWYG 遮罩双钮（复制+编辑）：hover 编辑按钮时复制按钮不消失（复制钮显示触发由
  // pre:hover 扩展为遮罩 hover，与编辑钮同口径）。
  // ----------
  {
    console.log('\n=== S81：定义列表无编辑按钮 + 代码块双钮 hover（编辑钮上复制钮不消失）===');
    const s81doc = ['# T', '', '术语A', ': 定义A', '', '```js', 'const a = 1;', '```', '', '尾部参照段落。'].join('\n');
    const s81setup = await page.evaluate((d) => {
      const { cm, ed } = window.__makeWysiwygEditor(d);
      window.__s81cm = cm; window.__s81ed = ed;
      cm.options.viewportMargin = 100000;
      cm.refresh();
      return new Promise((res) => setTimeout(() => {
        cm.setCursor({ line: cm.lineCount() - 1, ch: 0 }, { scroll: false });
        setTimeout(() => res(null), 400);
      }, 400));
    }, s81doc);
    if (s81setup) {
      console.log('  ⚠ 场景失败: ' + s81setup);
      fail++;
    } else {
      const s81masks = () => page.evaluate(() => {
        const cm = window.__s81cm;
        const masks = Array.from(cm.getWrapperElement().querySelectorAll('.wysiwyg-block-mask'));
        const dlMask = masks.find((m) => m.querySelector('dl'));
        const codeMask = masks.find((m) => m.querySelector('pre'));
        const copyBtn = codeMask && codeMask.querySelector('.copy-btn');
        const editBtn = codeMask && codeMask.querySelector('.block-edit-btn');
        const dlEl = dlMask && dlMask.querySelector('dl');
        const dlLast = dlMask && dlMask.lastElementChild;
        return {
          dlMasked: !!dlMask,
          dlHasEditBtn: !!(dlMask && dlMask.querySelector('.block-edit-btn')),
          dlNoBtnCls: !!(dlMask && dlMask.className.indexOf('wysiwyg-mask-no-btn-dl') >= 0),
          dlMarginBottom: dlEl ? getComputedStyle(dlEl).marginBottom : null,
          dlLastMarginBottom: dlLast ? getComputedStyle(dlLast).marginBottom : null,
          codeMasked: !!codeMask,
          copyPresent: !!copyBtn,
          editPresent: !!editBtn,
          copyOpacity: copyBtn ? getComputedStyle(copyBtn).opacity : null,
          editOpacity: editBtn ? getComputedStyle(editBtn).opacity : null,
        };
      });
      const s81hover = async (which) => {
        const pt = await page.evaluate((w) => {
          const cm = window.__s81cm;
          const masks = Array.from(cm.getWrapperElement().querySelectorAll('.wysiwyg-block-mask'));
          const codeMask = masks.find((m) => m.querySelector('pre'));
          const el = codeMask && codeMask.querySelector(w);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }, which);
        if (!pt) return false;
        await page.mouse.move(pt.x, pt.y);
        await page.waitForTimeout(400); // 等 0.2s 过渡完成
        return true;
      };
      const a0 = await s81masks();
      const checks81 = [];
      checks81.push([`前置：定义列表块渲染 <dl> 遮罩，且无「编辑」按钮（挂 no-btn-dl 类、dl 底距补回 16px）`,
        a0.dlMasked === true && a0.dlHasEditBtn === false && a0.dlNoBtnCls === true
        && a0.dlMarginBottom === '16px' && a0.dlLastMarginBottom === '16px']);
      // 遮罩未 hover：双钮默认隐藏
      const a1 = await s81masks();
      checks81.push([`未 hover：复制钮与编辑钮均隐藏（opacity 0）`,
        a1.copyOpacity === '0' && a1.editOpacity === '0']);
      // hover 编辑按钮（pre 之外）：复制钮保持显示（2026-10-25 用户报障的修复点）
      const okEdit = await s81hover('.block-edit-btn');
      const a2 = await s81masks();
      checks81.push([`hover 编辑按钮：复制钮仍显示（opacity 1，不再随 pre 失 hover 淡出）、编辑钮显示`,
        okEdit && a2.copyOpacity === '1' && a2.editOpacity === '1']);
      // hover 复制按钮：双钮显示（原口径保持）
      const okCopy = await s81hover('.copy-btn');
      const a3 = await s81masks();
      checks81.push([`hover 复制按钮：双钮均显示（原 pre:hover 口径不回归）`,
        okCopy && a2.copyOpacity === '1' && a3.copyOpacity === '1' && a3.editOpacity === '1']);
      // 移出遮罩：双钮隐藏
      await page.mouse.move(5, 5);
      await page.waitForTimeout(400);
      const a4 = await s81masks();
      checks81.push([`移出遮罩：双钮隐藏（opacity 0）`,
        a4.copyOpacity === '0' && a4.editOpacity === '0']);
      console.log('  state0: ' + JSON.stringify(a0));
      console.log('  hover编辑钮后: ' + JSON.stringify({ copy: a2.copyOpacity, edit: a2.editOpacity }));
      console.log('  hover复制钮后: ' + JSON.stringify({ copy: a3.copyOpacity, edit: a3.editOpacity }));
      for (const [label, ok] of checks81) {
        console.log(`  ${ok ? '✓' : '✗'} ${label}`);
        if (!ok) fail++;
      }
    }
  }

  {
    console.log('\n=== S78：相邻代码块 渲染态≡编辑态 间距（块底 16px 槽位）===');
    const s78doc = ['### HTML / CSS', '', '```html', '<!DOCTYPE html>', '<html lang="zh-CN">', '<head>', '  <meta charset="UTF-8">', '  <title>示例页面</title>', '</head>', '<body>', '  <div class="wrap"></div>', '  <script>console.log(1);</script>', '</body>', '</html>', '```', '', '```css', '.container {', '  display: grid;', '  gap: 16px;', '}', '```', '', '尾部参照段落。'].join('\n');
    const s78setup = await page.evaluate((d) => {
      const { cm, ed } = window.__makeWysiwygEditor(d);
      window.__s78cm = cm; window.__s78ed = ed;
      cm.options.viewportMargin = 100000;
      cm.refresh();
      return new Promise((res) => setTimeout(() => {
        cm.setCursor({ line: cm.lineCount() - 1, ch: 0 }, { scroll: false });
        setTimeout(() => res(null), 400);
      }, 400));
    }, s78doc);
    if (s78setup) {
      console.log('  ⚠ 场景失败: ' + s78setup);
      fail++;
    } else {
      const s78masks = () => page.evaluate(() => {
        const cm = window.__s78cm;
        // 视口归零：CM 内部滚动器在进编辑态时可能自动滚动（光标跟随），归零后
        // 参照行顶边才是纯文档空间位移（否则混入视口滚动量，非块高差）
        cm.scrollTo(null, 0);
        const masks = Array.from(cm.getWrapperElement().querySelectorAll('.wysiwyg-block-mask'));
        const hm = masks.find((m) => m.textContent.indexOf('DOCTYPE') >= 0);
        const cm2 = masks.find((m) => m.textContent.indexOf('display: grid') >= 0);
        const hp = hm && hm.querySelector('pre'), cp = cm2 && cm2.querySelector('pre');
        const refH = cm.getLineHandle(cm.lineCount() - 1);
        let refPre = null;
        for (const lv of cm.display.view) if (lv && lv.line === refH) {
          const el = lv.node; refPre = el.tagName === 'PRE' ? el : el.querySelector('pre.CodeMirror-line');
        }
        const codeLine = hm && hm.querySelector('.code-line');
        return {
          htmlPreH: hp ? Math.round(hp.getBoundingClientRect().height * 100) / 100 : null,
          codeLineH: codeLine ? Math.round(codeLine.getBoundingClientRect().height * 100) / 100 : null,
          renderGap: (hp && cp) ? Math.round((cp.getBoundingClientRect().top - hp.getBoundingClientRect().bottom) * 100) / 100 : null,
          refTop: refPre ? Math.round(refPre.getBoundingClientRect().top * 100) / 100 : null,
        };
      });
      const m0 = await s78masks();
      // 进编辑态：点第一个代码块的「编辑」按钮（产品入口）
      const pBtn = await page.evaluate(() => {
        const cm = window.__s78cm;
        const masks = Array.from(cm.getWrapperElement().querySelectorAll('.wysiwyg-block-mask'));
        const hm = masks.find((m) => m.textContent.indexOf('DOCTYPE') >= 0);
        const btn = hm && hm.querySelector('button.block-edit-btn');
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      });
      if (pBtn) {
        await page.mouse.click(pBtn.x, pBtn.y);
        await page.waitForTimeout(300);
      }
      const e1 = await page.evaluate(() => {
        const cm = window.__s78cm, ed = window.__s78ed;
        cm.scrollTo(null, 0); // 同 s78masks：文档空间口径
        const bIdx = (ed._wysiwygBlocks || []).findIndex((b) => /^```/.test(cm.getLine(b.start) || ''));
        if (bIdx < 0) return { err: '未找到围栏块' };
        const b = ed._wysiwygBlocks[bIdx];
        const last = b.end - 1;
        const lineEl = (n) => {
          const h = cm.getLineHandle(n);
          for (const lv of cm.display.view) if (lv && lv.line === h) {
            const el = lv.node;
            const pre = el.tagName === 'PRE' ? el : (el.querySelector ? el.querySelector('pre.CodeMirror-line') : null);
            const bg = el.querySelector ? el.querySelector('div.CodeMirror-linebackground') : null;
            return { pre, bg };
          }
          return { pre: null, bg: null };
        };
        const first = lineEl(b.start), close = lineEl(last);
        if (!close.pre || !close.bg) return { err: '编辑态行未渲染' };
        const cs = getComputedStyle(close.pre);
        const pb = getComputedStyle(close.bg, '::before');
        const lbR = close.bg.getBoundingClientRect();
        const fFirst = lineEl(b.start);
        const lbFirst = fFirst.bg ? fFirst.bg.getBoundingClientRect() : null;
        const masks = Array.from(cm.getWrapperElement().querySelectorAll('.wysiwyg-block-mask'));
        const cp = masks.find((m) => m.textContent.indexOf('display: grid') >= 0);
        const cPre = cp && cp.querySelector('pre');
        const refH = cm.getLineHandle(cm.lineCount() - 1);
        let refPre = null;
        for (const lv of cm.display.view) if (lv && lv.line === refH) {
          const el = lv.node; refPre = el.tagName === 'PRE' ? el : el.querySelector('pre.CodeMirror-line');
        }
        const beforeTop = lbFirst ? parseFloat(getComputedStyle(fFirst.bg, '::before').top) : 0;
        const boxTop = lbFirst ? lbFirst.top + beforeTop : null;
        const boxBottom = lbR.top + lbR.height - 16; // ::before bottom:16px
        return {
          activeIdx: ed._wysiwygActiveIdx,
          slotCls: (close.pre.className || '').indexOf('wysiwyg-code-slot-bottom') >= 0,
          closePadB: cs.paddingBottom,
          beforeBottom: pb.bottom,
          drawnH: (boxTop != null) ? Math.round((boxBottom - boxTop) * 100) / 100 : null,
          editGap: cPre ? Math.round((cPre.getBoundingClientRect().top - boxBottom) * 100) / 100 : null,
          refTop: refPre ? Math.round(refPre.getBoundingClientRect().top * 100) / 100 : null,
        };
      });
      if (e1.err) {
        console.log('  ⚠ 场景失败: ' + e1.err);
        fail++;
      } else {
        console.log('  render: ' + JSON.stringify(m0));
        console.log('  edit: ' + JSON.stringify(e1));
        const drawnDelta = (e1.drawnH != null && m0.htmlPreH != null && m0.codeLineH != null)
          ? +(e1.drawnH - (m0.htmlPreH + 2 * m0.codeLineH)).toFixed(2) : null;
        const refShift = (m0.refTop != null && e1.refTop != null) ? +(e1.refTop - m0.refTop).toFixed(2) : null;
        const checks78 = [];
        checks78.push([`渲染态基准：两代码块遮罩间间距 = 16px（pre 底边距槽，BFC 内收）（${m0.renderGap}px）`,
          m0.renderGap != null && Math.abs(m0.renderGap - 16) < 0.5]);
        checks78.push([`编辑态槽位：闭围栏行挂 wysiwyg-code-slot-bottom + 底内距 16px + 灰盒 ::before 底缘上移 16px`,
          e1.slotCls === true && e1.closePadB === '16px' && e1.beforeBottom === '16px']);
        checks78.push([`核心(纵)：灰盒绘制高不变 = 渲染态 pre 高 + 2×代码行高（${e1.drawnH}px vs ${m0.htmlPreH}+2×${m0.codeLineH}px，Δ=${drawnDelta}px）`,
          drawnDelta != null && Math.abs(drawnDelta) < 0.5]);
        checks78.push([`核心(间距)：编辑态灰盒底↔下一代码块 = 渲染态 16px（${e1.editGap}px）——不再紧密相连`,
          e1.editGap != null && Math.abs(e1.editGap - 16) < 0.5]);
        console.log(`  （信息）参照段落行顶位移 = ${refShift}px（= 活动块比遮罩多两行围栏行高 2×${m0.codeLineH}px 的块高增长；编辑按钮入口无点击锚点，若从遮罩点击进入则 S71 点击锚点保持被点行不动）`);
        for (const [label, ok] of checks78) {
          console.log(`  ${ok ? '✓' : '✗'} ${label}`);
          if (!ok) fail++;
        }
      }
    }
  }

  {
    console.log('\n=== S83：引用/提示块 编辑态「渲染分段 + 光标行源码」（非光标行渲染态 + 光标行源码）===');
    // 文档：引用块（4 行）+ 空白 + callout（3 行）+ 空白 + 参照段落
    const s83doc = ['# T', '', '> 引首行一。', '> 引首行二。', '> 引中行。', '> 引末行。', '',
      '> [!NOTE]', '> 提示行一。', '> 提示行二。', '> 提示行三。', '', '尾部参照段落。'].join('\n');
    const s83setup = await page.evaluate((d) => {
      const { cm, ed } = window.__makeWysiwygEditor(d);
      window.__s83cm = cm; window.__s83ed = ed;
      cm.options.viewportMargin = 100000;
      cm.refresh();
      return new Promise((res) => setTimeout(() => {
        cm.setCursor({ line: cm.lineCount() - 1, ch: 0 }, { scroll: false });
        setTimeout(() => res(null), 400);
      }, 400));
    }, s83doc);
    if (s83setup) {
      console.log('  ⚠ 场景失败: ' + s83setup);
      fail++;
    } else {
      const s83read = () => page.evaluate(() => {
        const cm = window.__s83cm, ed = window.__s83ed;
        const cur = cm.getCursor('head').line;
        const hcur = cm.getLineHandle(cur);
        let curPreCls = null;
        let curPreText = null;
        for (const lv of cm.display.view) {
          if (!lv || lv.line !== hcur) continue;
          const el = lv.node;
          const pre = el.tagName === 'PRE' ? el : el.querySelector('pre.CodeMirror-line');
          if (pre) { curPreCls = pre.className || ''; curPreText = pre.textContent || ''; }
        }
        const segEls = Array.from(cm.getWrapperElement().querySelectorAll('.wysiwyg-quote-seg-top, .wysiwyg-quote-seg-bottom'));
        const segs = segEls.map((el) => {
          const r = el.getBoundingClientRect();
          const box = el.querySelector('blockquote, .alert');
          const br = box ? box.getBoundingClientRect() : null;
          return {
            cls: /seg-top/.test(el.className) ? 'top' : 'bot',
            txt: (el.textContent || '').slice(0, 40),
            hasAlert: !!el.querySelector('.alert'),
            titleHidden: (() => {
              const t = el.querySelector('.alert-title');
              return t ? getComputedStyle(t).display === 'none' : null;
            })(),
            // 2026-10-25：几何（节点含 16px 底槽 BFC；盒 = 可视背景盒）——接缝/间距断言用
            y: r.y, h: r.height,
            boxY: br ? br.y : null, boxH: br ? br.height : null,
          };
        });
        // 全块掩码（非活动块）rect 取位：data-block-index
        const masks = Array.from(cm.getWrapperElement().querySelectorAll('.wysiwyg-block-mask'));
        const rects = masks.map((m) => {
          const r = m.getBoundingClientRect();
          return { idx: parseInt(m.getAttribute('data-block-index'), 10), x: r.x, y: r.y, w: r.width, h: r.height };
        });
        // 2026-10-25 用户「引用块、提示块的编辑按钮去掉 + 编辑态不适用灰色代码框 + 与渲染态
        // 完全一致」断言字段：各遮罩编辑按钮在否 / 活动灰底行类数 / 光标行 pre 背景计算式 /
        // 活动块源文行总高（heightAtLine 口径，渲染态与编辑态同一测法直接可比）
        const btnByIdx = {};
        for (const m of masks) btnByIdx[parseInt(m.getAttribute('data-block-index'), 10)] = !!m.querySelector('.block-edit-btn');
        const grayBgCount = cm.getWrapperElement().querySelectorAll('div.CodeMirror-linebackground.cm-wysiwyg-active-block').length;
        let curPreStyle = null;
        if (curPreCls != null) {
          for (const lv of cm.display.view) {
            if (!lv || lv.line !== hcur) continue;
            const el = lv.node;
            const pre = el.tagName === 'PRE' ? el : el.querySelector('pre.CodeMirror-line');
            if (!pre) continue;
            const s = getComputedStyle(pre);
            const pb = getComputedStyle(pre, '::before');
            const pr = pre.getBoundingClientRect();
            // 2026-10-25：光标行 active-line 底色（codemirror.css #e8f2ff）须对引用行透明。
            // 光标行 DOM：div.CodeMirror-activeline > [linebackground, 0 宽 gutter-background, pre]
            // —— linebackground 前边还隔着 gutter 垫底 div，须向前遍历找 activeline-background。
            let lb = pre.previousElementSibling, lineBg = 'NO-ACTIVELINE-LB';
            while (lb) {
              if (/activeline-background/.test(lb.className || '')) { lineBg = getComputedStyle(lb).backgroundColor; break; }
              lb = lb.previousElementSibling;
            }
            curPreStyle = {
              bg: s.backgroundColor,
              bgImage: s.backgroundImage,
              bgSize: s.backgroundSize,
              bgPos: s.backgroundPosition,
              boxShadow: s.boxShadow,
              y: pr.y,
              h: pr.height,
              barH: pb.height,
              barColor: pb.backgroundColor,
              edgeTop: pre.className.indexOf('wysiwyg-block-edge-top') >= 0,
              edgeBottom: pre.className.indexOf('wysiwyg-block-edge-bottom') >= 0,
              lineBg,
            };
            break;
          }
        }
        let blockH = null;
        const ai = ed._wysiwygActiveIdx;
        const ab = (ai != null && ai >= 0 && ed._wysiwygBlocks) ? ed._wysiwygBlocks[ai] : null;
        if (ab) {
          try { blockH = cm.heightAtLine(Math.min(ab.end, cm.lineCount() - 1)) - cm.heightAtLine(ab.start); } catch (_) { /* 忽略 */ }
        }
        return {
          activeIdx: ed._wysiwygActiveIdx,
          cur,
          segMarks: (ed._wysiwygSegMarks || []).length,
          segState: ed._wysiwygSegState,
          segs,
          curPreCls,
          curPreHasGt: (curPreText || '').indexOf('>') >= 0,
          calloutCur: (curPreCls || '').indexOf('wysiwyg-callout-cursor-line') >= 0,
          alertCur: (curPreCls || '').indexOf('wysiwyg-callout-note') >= 0,
          btnByIdx,
          grayBgCount,
          curPreStyle,
          blockH,
          blocks: (ed._wysiwygBlocks || []).map((b) => [b.start, b.end]),
          rects,
        };
      });
      const s83clickAt = async (rect, fy) => {
        const x = rect.x + Math.min(rect.w - 6, 40);
        const y = rect.y + Math.max(2, rect.h * fy);
        await page.mouse.click(x, y);
        await page.waitForTimeout(150);
      };
      const s83checks = [];
      const r0 = await s83read();
      // 前置：初始光标在末行（参照段落），它活动（源码态）；引用块与 callout 均为整块掩码
      const r0q = r0.blocks.findIndex((b) => b[0] === 2);
      const r0a = r0.blocks.findIndex((b) => b[0] === 7);
      const r0p = r0.blocks.findIndex((b) => b[0] === 12);
      s83checks.push([`前置：引用块与 callout 均为整块掩码（块 1/2 的 data-block-index 掩码存在），参照段落活动`,
        r0.rects.some((m) => m.idx === r0q) && r0.rects.some((m) => m.idx === r0a)
        && !r0.rects.some((m) => m.idx === r0p) && r0.activeIdx === r0p]);
       // 2026-10-25：引用/提示块整块掩码不挂「编辑」按钮（用户要求去掉）
       s83checks.push([`前置：引用块/callout 整块掩码无「编辑」按钮`,
         r0.btnByIdx[r0q] === false && r0.btnByIdx[r0a] === false]);
      // 点引用块掩码上部 → 激活：光标行=块首行源码（> 可见）、下段渲染遮罩、无上段
      const rq = r0.rects.find((m) => m.idx === r0q);
      const qMaskH0 = r0.rects.find((m) => m.idx === r0q);
      if (rq) { await s83clickAt(rq, 0.15); const r1 = await s83read();
        s83checks.push([`点引用块上部：激活（光标块首行 2、上段空、下段渲染遮罩 3-5）`,
          r1.activeIdx === r0q && r1.cur === 2 && r1.segMarks === 1 && r1.segs.length === 1 && r1.segs[0].cls === 'bot'
          && r1.segs[0].txt.indexOf('引首行二') >= 0 && r1.segs[0].txt.indexOf('引末行') >= 0
          && r1.curPreHasGt === true]);
        // 2026-10-28 S86：光标行底色 = 渲染盒单层同构背景（竖条 + 底色 2 层、右缘 668
        // inset；旧基规则纯色通宽 → 用户截图「蓝底铺到最右」）。无 inset 内环 / 无 #e8f2ff
        // active-line 垫底口径不变
        s83checks.push([`活动态无灰底行（cm-wysiwyg-active-block 不挂引用块）`, r1.grayBgCount === 0]);
        s83checks.push([`光标行底色=渲染盒单层平色（2 层背景：竖条+底色、右缘 668 inset；无 inset 内环、无 #e8f2ff active-line 垫底）`,
          r1.curPreStyle && r1.curPreStyle.bgImage.indexOf('linear-gradient') >= 0
          && r1.curPreStyle.bgSize.indexOf('calc(100% - 64px)') >= 0
          && r1.curPreStyle.bgPos.indexOf('32px') >= 0
          && r1.curPreStyle.boxShadow === 'none'
          && r1.curPreStyle.lineBg === 'rgba(0, 0, 0, 0)']);
        // 2026-10-25：接缝与块下间距（渲染态短行并排成 1 段、编辑态光标行独立成行 →
        // 块总高 = 渲染盒高 + 拆出行高，不做总高等值断言；断言用户可见不变量：
        // ① 光标行↔下段盒无缝 ② 块盒底→下一盒顶 = 16px（与渲染态同间距，块下内容不跳）
        const r1seam = r1.segs.find((s) => s.cls === 'bot');
        const r1next = r1.rects.find((m) => m.idx === r0q + 1);
        s83checks.push([`引用块编辑态（首行光标）：光标行↔下段无缝 + 块盒底→下一盒顶 16px（渲染态同间距）`,
          r1seam && r1.curPreStyle && r1next
          && Math.abs(r1seam.y - (r1.curPreStyle.y + r1.curPreStyle.h)) <= 1
          && Math.abs(r1next.y - (r1seam.boxY + r1seam.boxH) - 16) <= 1]);
      } else { s83checks.push(['截取引用块掩码 rect', false]); }
      // 点下段上部约 1/3 → 光标映射到段内行 3（源码），上段出现（2 渲染）、下段缩为 4-5
      const r2 = await s83read();
      const rb = r2.segMarks ? r2.segs.find((s) => s.cls === 'bot') : null;
      // 用 rects 里引用块整盖 rect 不好的话，直接点当前光标行下一行区域不可靠；改用下段节点的 rect。
      const segRect = await page.evaluate(() => {
        const cm = window.__s83cm;
        const el = cm.getWrapperElement().querySelector('.wysiwyg-quote-seg-bottom');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      });
      s83checks.push([`下段渲染遮罩存在（读 rect 可点）`, !!segRect && rb && rb.txt.indexOf('引首行二') >= 0]);
      if (segRect) {
        await s83clickAt(segRect, 0.2);
        const r3 = await s83read();
        s83checks.push([`点下段上部：光标映射段内行 3（源码 > 可见）、上段 2 渲染、下段 4-5 渲染`,
          r3.activeIdx === r0q && r3.cur === 3 && r3.segState && r3.segState.cur === 3
          && r3.segs.some((s) => s.cls === 'top' && s.txt.indexOf('引首行一') >= 0)
          && r3.segs.some((s) => s.cls === 'bot' && s.txt.indexOf('引末行') >= 0 && s.txt.indexOf('引首行二') < 0)
          && r3.curPreHasGt === true]);
        // 2026-10-25：中间行口径——同样无灰底/平色底；接缝与块下间距（光标行居中：
        // 上段盒底↔光标行顶、光标行底↔下段顶均无缝；下段盒底→下一盒顶 = 16px）
        const r3top = r3.segs.find((s) => s.cls === 'top');
        const r3bot = r3.segs.find((s) => s.cls === 'bot');
        const r3next = r3.rects.find((m) => m.idx === r0q + 1);
        s83checks.push([`中间行：无灰底 + 渲染盒单层平色（右缘 668 inset）+ 无 active-line 垫底 + 上下接缝无缝 + 下段盒底→下一盒顶 16px`,
          r3.grayBgCount === 0
          && r3.curPreStyle && r3.curPreStyle.bgImage.indexOf('linear-gradient') >= 0
          && r3.curPreStyle.bgSize.indexOf('calc(100% - 64px)') >= 0
          && r3.curPreStyle.lineBg === 'rgba(0, 0, 0, 0)'
          && r3top && r3bot && r3next
          && Math.abs(r3top.boxY + r3top.boxH - r3.curPreStyle.y) <= 1
          && Math.abs(r3.curPreStyle.y + r3.curPreStyle.h - r3bot.y) <= 1
          && Math.abs(r3next.y - (r3bot.boxY + r3bot.boxH) - 16) <= 1]);
        // 光标移到块末行（点下段下部）→ 末行=边缘行：底色不铺 margin 区、竖条收在盒底
        // 布局已变（上段出现）→ 重测下段 rect 再点（陈旧 rect 会点偏）
        const segRect2 = await page.evaluate(() => {
          const cm = window.__s83cm;
          const el = cm.getWrapperElement().querySelector('.wysiwyg-quote-seg-bottom');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        });
        if (!segRect2) { s83checks.push(['重测下段 rect（末行点击前）', false]); }
        await s83clickAt(segRect2 || segRect, 0.85);
        const r3b = await s83read();
        if (r3b.cur === 5) {
          const ps = r3b.curPreStyle || {};
          // 底色高：单背景 background-size「宽 高」是空格分隔（split(',') 无逗号 → 恒
          // undefined 是旧断言恒挂的根因）；getComputedStyle 对 calc 返回原式（parseFloat
          // 误取 100）→ 先按 calc(100% - 16px) 字符串口径判，否则取末位 token 解析 px
          const bgSizeStr = (ps.bgSize || '').trim();
          const bgH = bgSizeStr.indexOf('calc(100% - 16px)') >= 0
            ? (ps.h - 16)
            : (parseFloat(bgSizeStr.split(/\s+/).pop()) || 0);
          const barH = parseFloat(ps.barH) || 0;
          s83checks.push([`末行光标：边缘底距类 + 底色/竖条收在盒底（=行高-16px margin）+ 无 active-line 垫底`,
            ps.edgeBottom === true
            && ps.h > 0 && Math.abs(bgH - (ps.h - 16)) <= 2
            && Math.abs(barH - (ps.h - 16)) <= 2
            && ps.lineBg === 'rgba(0, 0, 0, 0)']);
          // 块底口径：末行=盒底，16px margin 内嵌于行底距（pre 底→下一盒顶 = 16px 视觉间距）
          const r3bnext = r3b.rects.find((m) => m.idx === r0q + 1);
          const r3btop = r3b.segs.find((s) => s.cls === 'top');
          s83checks.push([`末行光标：上段↔光标行无缝 + 行底→下一盒顶 16px（渲染态同间距）`,
            r3btop && r3bnext
            && Math.abs(r3btop.boxY + r3btop.boxH - ps.y) <= 1
            && Math.abs(r3bnext.y - (ps.y + ps.h) - 0) <= 1]);
        } else {
          s83checks.push([`末行光标定位（实际光标行 ${r3b.cur}）`, false]);
        }
        // 分段状态对齐（idempotent：状态 cur 已更新）
        const r4 = await s83read();
        s83checks.push([`分段状态对齐（idempotent：状态 cur 已更新）`, !!r4.segState && r4.segState.cur == r3b.cur]);
        // 幂等：同一状态再读一次 → 不重建（状态 cur 保持在末行，不回落）
        const r5 = await s83read();
        s83checks.push([`幂等：状态未变不重建分段（cur 保持末行 ${r3b.cur}）`, r5.segState && r5.segState.cur === r3b.cur]);
      }
      // callout：点 callout 掩码上部 → 激活（光标行 7 带 callout-note 类、下段渲染 alert、标题隐藏）
      const r6 = await s83read();
      const ra = r6.rects.find((m) => m.idx === r0a);
      if (ra) { await s83clickAt(ra, 0.15); const r7 = await s83read();
        const bot = r7.segs.find((s) => s.cls === 'bot');
        s83checks.push([`点 callout 上部：激活（光标行 7 源码带 > + callout-note 类型类；下段渲染 .alert、标题隐藏）`,
          r7.activeIdx === r0a && r7.cur === 7 && r7.calloutCur === true && r7.alertCur === true
          && bot && bot.hasAlert === true && bot.titleHidden === true && r7.curPreHasGt === true]);
        // 2026-10-25：callout 光标行底色 = 渲染 .alert 平色（--alert-note-bg，明暗自适应），
        // 无灰底/无渐变/无 inset 内环；块总高与渲染态等高（顶缘行口径）
        s83checks.push([`callout 光标行底色 = 渲染 .alert 平色（56,132,255 色系、无渐变、无内环、无灰底、无 active-line 垫底）`,
          r7.curPreStyle && r7.curPreStyle.bg.indexOf('56, 132, 255') >= 0
          && r7.curPreStyle.bgImage === 'none'
          && r7.curPreStyle.boxShadow === 'none'
          && r7.curPreStyle.lineBg === 'rgba(0, 0, 0, 0)'
          && r7.grayBgCount === 0]);
        // 接缝与块下间距（同引用口径：光标行↔下段无缝 + 块盒底→下一盒顶 16px）
        const r7bot = r7.segs.find((s) => s.cls === 'bot');
        const r7next = r7.rects.find((m) => m.idx === r0a + 1);
        s83checks.push([`callout 编辑态（首行光标）：光标行↔下段无缝 + 块盒底→下一盒顶 16px（渲染态同间距）`,
          r7bot && r7.curPreStyle && r7next
          && Math.abs(r7bot.y - (r7.curPreStyle.y + r7.curPreStyle.h)) <= 1
          && Math.abs(r7next.y - (r7bot.boxY + r7bot.boxH) - 16) <= 1]);
      } else { s83checks.push(['截取 callout 掩码 rect', false]); }
      // 点击非活动块（参照段落）→ 退活：分段清空、引用/callout 整块重遮罩
      const r8 = await s83read();
      const rp = r8.rects.find((m) => m.idx === r8.blocks.findIndex((b) => b[0] === 12));
      if (rp) { await s83clickAt(rp, 0.5); const r9 = await s83read();
        s83checks.push([`点参照段落：退活（分段清空 segMarks=0、引用/callout 整块重遮罩）`,
          r9.activeIdx === r8.blocks.findIndex((b) => b[0] === 12)
          && r9.segMarks === 0 && r9.segState === null && r9.segs.length === 0
          && r9.rects.some((m) => m.idx === r0q) && r9.rects.some((m) => m.idx === r0a)]);
      } else { s83checks.push(['截取段落掩码 rect', false]); }
      for (const [label, ok, extra] of s83checks) {
        console.log(`  ${ok ? '✓' : '✗'} ${label}` + (extra !== undefined ? '  ' + extra : ''));
        if (!ok) fail++;
      }
    }
  }

  {
    console.log('\n=== S84：在引用块内插入引用块 = 原位嵌套（嵌套引用块，2026-10-25 用户反馈）===');
    // 用户流程：引用块内回车（续行 `> `）→ 通过 / 插入引用块（= insertLinePrefix('> ')）→
    // 输入内容 → 回车 → 再 / 插入引用块。修复前无选区分支「上一行非空 → 插无前缀空行」把引用块
    // 拆成两块：新块成为空行分隔、外层+1 级的独立嵌套盒（用户截图：一排独立盒、末次插入成空盒）；
    // 修复后行首原位加一级 `> `，新行归属当前引用块（单块、真嵌套）。
    const s84doc = ['# T', '', '> 引首行一。', '> 引首行二。', '', '尾部参照段落。'].join('\n');
    const s84setup = await page.evaluate((d) => {
      const { cm, ed } = window.__makeWysiwygEditor(d);
      window.__s84cm = cm; window.__s84ed = ed;
      cm.options.viewportMargin = 100000;
      cm.refresh();
      return new Promise((res) => setTimeout(() => res(null), 400));
    }, s84doc);
    if (s84setup) {
      console.log('  ⚠ 场景失败: ' + s84setup);
      fail++;
    } else {
      const s84checks = [];
      const s84state = () => page.evaluate(() => {
        const cm = window.__s84cm;
        const cur = cm.getCursor('head');
        return { line: cm.getLine(cur.line), ch: cur.ch, curLine: cur.line, n: cm.lineCount(), val: cm.getValue() };
      });
      // 光标进引用块末行（行 3，S59 C 同一激活口径：setCursor + focus）
      await page.evaluate(() => { const cm = window.__s84cm; cm.focus(); cm.setCursor({ line: 3, ch: cm.getLine(3).length }); });
      await page.waitForTimeout(300);
      // 回车 → 续行 `> `（行 4）
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
      let st = await s84state();
      s84checks.push(['回车续行：新行 4 = `> `（光标 ch2、总行数 7）', st.curLine === 4 && st.line === '> ' && st.ch === 2 && st.n === 7]);
      // / 插入引用块 = insertLinePrefix('> ') → 原位嵌套 `> > `（不插空行拆块）
      await page.evaluate(() => { window.__s84ed.insertLinePrefix('> '); });
      await page.waitForTimeout(250);
      st = await s84state();
      s84checks.push(['S84 核心：插入引用 = 行 4 原位嵌套 `> > `（总行数仍 7、未插空行）', st.curLine === 4 && st.line === '> > ' && st.ch === 4 && st.n === 7]);
      await page.keyboard.type('嵌套内容');
      await page.waitForTimeout(250);
      st = await s84state();
      s84checks.push(['输入内容：行 4 = `> > 嵌套内容`', st.line === '> > 嵌套内容']);
      // 二次回车 → 续行保留层级 `> > `（行 5）→ 再插入引用 → `> > > `
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
      st = await s84state();
      s84checks.push(['二次回车续行：行 5 = `> > `（保留层级、光标 ch4、总行数 8）', st.curLine === 5 && st.line === '> > ' && st.ch === 4 && st.n === 8]);
      await page.evaluate(() => { window.__s84ed.insertLinePrefix('> '); });
      await page.waitForTimeout(250);
      st = await s84state();
      s84checks.push(['S84 末态：行 5 = `> > > `（第三层嵌套）', st.curLine === 5 && st.line === '> > > ' && st.ch === 6]);
      s84checks.push(['S84 核心：全文源码 = 单层引用块内含两级嵌套（无空行分裂）',
        st.val === '# T\n\n> 引首行一。\n> 引首行二。\n> > 嵌套内容\n> > > \n\n尾部参照段落。']);
      await page.waitForTimeout(400);
      const blk = await page.evaluate(() => {
        const ed = window.__s84ed;
        const b = (ed._wysiwygBlocks || []).find((x) => x.start === 2);
        return b ? { start: b.start, end: b.end } : null;
      });
      s84checks.push(['块表：行 2-5 同一引用块（start 2、end 6）', !!blk && blk.start === 2 && blk.end === 6]);
      // 退活（光标进段落）→ 引用块整块重遮罩：嵌套盒 = 外层 blockquote 内含内层
      await page.evaluate(() => { const cm = window.__s84cm; cm.focus(); cm.setCursor({ line: 7, ch: 0 }); });
      await page.waitForTimeout(600);
      const nest = await page.evaluate(() => {
        const bqs = [...document.querySelectorAll('div.wysiwyg-block-mask blockquote')];
        const outer = bqs.find((b) => b.textContent.includes('引首行一'));
        if (!outer) return null;
        const inner = outer.querySelector('blockquote');
        return inner ? { hasInner: true, innerHasContent: inner.textContent.includes('嵌套内容') } : { hasInner: false };
      });
      s84checks.push(['S84 渲染态：嵌套盒（外层 blockquote 内含内层、内层含嵌套内容）',
        !!nest && nest.hasInner === true && nest.innerHasContent === true]);
      for (const [label, ok, extra] of s84checks) {
        console.log(`  ${ok ? '✓' : '✗'} ${label}` + (extra !== undefined ? '  ' + extra : ''));
        if (!ok) fail++;
      }
    }
  }

  {
    console.log('\n=== S85：嵌套引用光标行 = 渲染嵌套盒同构 + IME 组合竖排修复（2026-10-28 用户反馈）===');
    // ① 编辑态：9 行三级嵌套引用、光标在三级中间行 → 光标行多层背景（逐层底色 + 全高竖条）
    //    与渲染嵌套盒同构（逐层 accent-subtle 叠色 + 边框 32/56/80 连续）；> 标记保留
    //    （用户口径：只在光标行显示）= 编辑态与渲染态唯一有意差异。
    // ② IME：空三级续行 `> > > ` 上拼音组合串落进槽文本节点（与列表 2026-10-18 竖排同源）
    //    → 组合期挂 wysiwyg-ime-quote 类（_wysiwygImeCompositionStart，同标题字号 wiring）
    //    使槽 nowrap = 组合文本单行（槽 scrollHeight ≈ height、不折行撑高）；组合期结束
    //    摘类恢复 pre-wrap（常驻 nowrap 会丢行尾键入的槽内空格，S84 实测）；上屏模型干净
    //    （`> > > ` + "阿斯蒂芬" → `> > > 阿斯蒂芬`）→ 无需 JS 修复。
    const s85doc = [
      '> 阿斯蒂芬撒s',
      '> 阿斯顿发射点',
      '> 阿斯蒂芬',
      '> > 阿三发射点法发',
      '> > 阿斯蒂芬',
      '> > 阿斯蒂芬',
      '> > > 阿斯顿发射点',
      '> > > 阿斯蒂芬',
      '> > > 阿斯蒂芬',
      '',
      '参照段。',
    ].join('\n');
    const s85checks = [];
    const s85setup = await page.evaluate((d) => {
      const { cm, ed } = window.__makeWysiwygEditor(d);
      window.__s85cm = cm; window.__s85ed = ed;
      cm.options.viewportMargin = 100000;
      cm.refresh();
      return new Promise((res) => setTimeout(() => res(null), 400));
    }, s85doc);
    if (s85setup) {
      console.log('  ⚠ 场景失败: ' + s85setup);
      fail++;
    } else {
      // 遮罩点击进块（用户路径：遮罩 mousedown → 纵比行映射 → 激活 + 分段）
      await page.evaluate(() => { const cm = window.__s85cm; cm.focus(); cm.setCursor({ line: 10, ch: 0 }); });
      await page.waitForTimeout(400);
      const s85mask = await page.evaluate(() => {
        const m = document.querySelector('.wysiwyg-block-mask[data-block-index="0"]');
        if (!m) return null;
        const r = m.getBoundingClientRect();
        return { x: r.x, y: r.y, h: r.height };
      });
      let entered = false;
      if (s85mask) {
        // 纵比 0.7 → 行 5（span+1 半区口径，本机实测）；再点下段 0.1 → 行 6（三级中间行）
        await page.mouse.click(s85mask.x + 40, s85mask.y + 0.7 * s85mask.h);
        await page.waitForTimeout(500);
        const s85bot = await page.evaluate(() => {
          const m = document.querySelector('.wysiwyg-block-mask.wysiwyg-quote-seg-bottom');
          if (!m) return null;
          const r = m.getBoundingClientRect();
          return { x: r.x, y: r.y, h: r.height };
        });
        if (s85bot) {
          await page.mouse.click(s85bot.x + 40, s85bot.y + 0.1 * s85bot.h);
          await page.waitForTimeout(500);
          entered = true;
        }
      }
      s85checks.push(['遮罩点击进块（两级点击落到三级中间行）', entered === true]);
      const s85geo = await page.evaluate(() => {
        const cm = window.__s85cm;
        const cur = cm.getCursor('head');
        const handle = cm.getLineHandle(cur.line);
        let node = null;
        for (const lv of cm.display.view) { if (lv && lv.line === handle) { node = lv.node; break; } }
        const pre = node && (node.querySelector('pre') || node);
        if (!pre) return { found: false, curLine: cur.line };
        const cs = getComputedStyle(pre);
        const slots = [...pre.querySelectorAll('.wysiwyg-quote-slot')];
        return {
          found: true, curLine: cur.line,
          cls: pre.className,
          bgLayers: (cs.backgroundImage.match(/linear-gradient\(/g) || []).length,
          bgPos: cs.backgroundPosition,
          slotWs: slots.map((s) => getComputedStyle(s).whiteSpace),
        };
      });
      s85checks.push(['光标落行 6（三级中间行 `> > > 阿斯顿发射点`）', s85geo.found === true && s85geo.curLine === 6]);
      s85checks.push(['光标行类：quote-line + cursor-line + nested + lvl-3',
        s85geo.cls.includes('wysiwyg-quote-line') && s85geo.cls.includes('wysiwyg-quote-cursor-line')
        && s85geo.cls.includes('wysiwyg-quote-nested') && s85geo.cls.includes('wysiwyg-quote-lvl-3')]);
      s85checks.push(['S85 核心：光标行背景 = 6 层（3 层 × 竖条 + 底色，渲染嵌套盒同构）', s85geo.bgLayers === 6]);
      s85checks.push(['层位 32/56/80（与渲染盒 border 位置逐像素同位）',
        s85geo.bgPos.includes('32px') && s85geo.bgPos.includes('56px') && s85geo.bgPos.includes('80px')]);
      s85checks.push(['槽常态 white-space: pre-wrap（nowrap 仅限组合期挂类，防行尾键入丢空格）',
        s85geo.slotWs.length === 3 && s85geo.slotWs.every((w) => w === 'pre-wrap')]);
      // 证据截图：嵌套光标行编辑态（多层叠色 + 连续竖条）
      const s85shot = path.join(root, 'screenshots', 's85-nested-edit.png');
      fs.mkdirSync(path.dirname(s85shot), { recursive: true });
      await page.screenshot({ path: s85shot });
      console.log('  截图: ' + path.relative(root, s85shot));
      // —— IME：空三级续行上组合（DOM 模拟真实 Chromium 行为：组合串落进末槽文本节点）——
      await page.evaluate(() => {
        const cm = window.__s85cm;
        cm.replaceRange('> > > ', { line: 9, ch: 0 }, { line: 9, ch: 0 }); // 空行 9 → 空三级续行（块 [0,10)）
        cm.focus();
        cm.setCursor({ line: 10, ch: 0 }); // 参照段（无遮罩行）
      });
      await page.waitForTimeout(400);
      await page.evaluate(() => { const cm = window.__s85cm; cm.focus(); cm.setCursor({ line: 9, ch: 6 }); });
      await page.waitForTimeout(500);
      const s85ime = await page.evaluate(() => {
        const cm = window.__s85cm;
        const input = cm.getInputField();
        const handle = cm.getLineHandle(9);
        let node = null;
        for (const lv of cm.display.view) { if (lv && lv.line === handle) { node = lv.node; break; } }
        const pre = node && (node.querySelector('pre') || node);
        const slots = pre ? [...pre.querySelectorAll('.wysiwyg-quote-slot')] : [];
        const last = slots[slots.length - 1];
        if (!last) return { ok: false };
        input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
        const tn = last.lastChild; // 组合前末槽文本节点 "> "（实测口径：组合串落进槽内）
        tn.textContent = tn.textContent + "a's'd'f";
        return { ok: true, slotScrollH: last.scrollHeight, slotH: last.clientHeight,
          slotText: last.textContent,
          preCls: pre.className, slotWs: getComputedStyle(last).whiteSpace };
      });
      s85checks.push(['IME 组合落点：末槽文本节点 `> a\'s\'d\'f`（与列表竖排同源）',
        s85ime.ok === true && s85ime.slotText === "> a's'd'f"]);
      s85checks.push(['S85 核心：组合期挂 wysiwyg-ime-quote → 槽 nowrap（_wysiwygImeCompositionStart 接线）',
        s85ime.ok === true && s85ime.preCls.includes('wysiwyg-ime-quote') && s85ime.slotWs === 'nowrap']);
      s85checks.push(['S85 核心：组合期槽未被折行撑高（scrollH ≈ height，单行右溢；修复前 3 行）',
        s85ime.ok === true && s85ime.slotScrollH <= s85ime.slotH + 2]);
      const s85imeShot = path.join(root, 'screenshots', 's85-nest-ime-composing.png');
      fs.mkdirSync(path.dirname(s85imeShot), { recursive: true });
      await page.screenshot({ path: s85imeShot });
      console.log('  截图: ' + path.relative(root, s85imeShot));
      // 提交上屏 → 模型应干净（无需 JS 修复）
      await page.evaluate(() => {
        const cm = window.__s85cm;
        const input = cm.getInputField();
        const handle = cm.getLineHandle(9);
        let node = null;
        for (const lv of cm.display.view) { if (lv && lv.line === handle) { node = lv.node; break; } }
        const pre = node && (node.querySelector('pre') || node);
        const slots = pre ? [...pre.querySelectorAll('.wysiwyg-quote-slot')] : [];
        const last = slots[slots.length - 1];
        if (!last) return;
        last.textContent = '> 阿斯蒂芬';
        input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '阿斯蒂芬' }));
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '阿斯蒂芬', inputType: 'insertText' }));
      });
      await page.waitForTimeout(1200);
      const s85model = await page.evaluate(() => {
        const cm = window.__s85cm;
        const cur = cm.getCursor('head');
        const handle = cm.getLineHandle(cur.line);
        let node = null;
        for (const lv of cm.display.view) { if (lv && lv.line === handle) { node = lv.node; break; } }
        const pre = node && (node.querySelector('pre') || node);
        return { line9: cm.getLine(9), curLine: cur.line, ch: cur.ch,
          preCls: pre ? pre.className : '' };
      });
      s85checks.push(['上屏模型干净：行 9 = `> > > 阿斯蒂芬`、光标 ch10（无需 JS 修复）',
        s85model.line9 === '> > > 阿斯蒂芬' && s85model.curLine === 9 && s85model.ch === 10]);
      s85checks.push(['组合期结束摘类（wysiwyg-ime-quote 撤除、槽恢复 pre-wrap）',
        s85model.preCls && !s85model.preCls.includes('wysiwyg-ime-quote')]);
      for (const [label, ok, extra] of s85checks) {
        console.log(`  ${ok ? '✓' : '✗'} ${label}` + (extra !== undefined ? '  ' + extra : ''));
        if (!ok) fail++;
      }
    }
  }

  // === S86：嵌套续行末行（用户①「嵌套换行中间空白」）+ 顶缘嵌套（2026-10-28 用户反馈）===
  // 文档 = 用户截图场景：lvl2 两行 + lvl3 一行 + lvl2 末行（光标）；块 = 行 2-5。
  // 修复链：① seg-top 嵌套开口（open-N 类 → 层级 2..N 盒清底）消 16px 白缝
  //         ② 末行（edge-bottom + lvl-2）4 层底缘阶梯背景（替代纯色通宽 + 40px 通用边缘距）
  //         ③ 分级边缘距（顶 12N / 底 28N）带高 = 渲染盒 + margin 同高
  // 单层光标行「蓝底铺到最右」（用户②）由 S83 更新的 lvl-1 inset 断言覆盖。
  console.log('\n=== S86：嵌套续行末行 = 嵌套盒底缘延续（开口段 + 底缘阶梯 + 分级边缘距，2026-10-28 用户反馈①）===');
  const s86doc = [
    '# T',
    '',
    '> > sadfsafsafs',
    '> > asdfasfsf',
    '> > > asfsafs',
    '> > asdfsafd',
    '',
    '参照段。',
  ].join('\n');
  const s86checks = [];
  const s86setup = await page.evaluate((d) => {
    const { cm, ed } = window.__makeWysiwygEditor(d);
    window.__s86cm = cm; window.__s86ed = ed;
    cm.options.viewportMargin = 100000;
    cm.refresh();
    return new Promise((res) => setTimeout(() => {
      cm.setCursor({ line: 7, ch: 0 }, { scroll: false });
      setTimeout(() => res(null), 400);
    }, 400));
  }, s86doc);
  if (s86setup) {
    console.log('  ⚠ 场景失败: ' + s86setup);
    fail++;
  } else {
    await page.evaluate(() => { const cm = window.__s86cm; cm.focus(); cm.setCursor({ line: 7, ch: 0 }); });
    await page.waitForTimeout(300);
    // 两级点击进末行（同 S85 口径）：全块遮罩纵比公式 = from + floor(ratio×(to−from))，
    // 末行只在 ratio→1 可达（含 16px 底槽时不可达）→ 先 0.5 落行 3、再点下段 0.75 → 末行 5
    const s86mask = await page.evaluate(() => {
      const m = [...document.querySelectorAll('.wysiwyg-block-mask')].find((x) => (x.textContent || '').indexOf('sadfsafsafs') >= 0);
      if (!m) return null;
      const r = m.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    let cur1 = -1, cur2 = -1;
    if (s86mask) {
      await page.mouse.click(s86mask.x + 40, s86mask.y + 0.5 * s86mask.h);
      await page.waitForTimeout(400);
      cur1 = await page.evaluate(() => window.__s86cm.getCursor('head').line);
      const s86bot = await page.evaluate(() => {
        const el = document.querySelector('.wysiwyg-quote-seg-bottom');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      });
      if (s86bot) {
        await page.mouse.click(s86bot.x + 40, s86bot.y + 0.75 * s86bot.h);
        await page.waitForTimeout(400);
        cur2 = await page.evaluate(() => window.__s86cm.getCursor('head').line);
      }
    }
    s86checks.push(['遮罩点击进块（两级点击落到末行 lvl-2 = 用户截图光标行）', cur1 >= 2 && cur1 < 5 && cur2 === 5]);
    // ① 末行（edge-bottom + lvl-2）几何
    const s86geo = await page.evaluate(() => {
      const cm = window.__s86cm;
      const cur = cm.getCursor('head');
      const handle = cm.getLineHandle(cur.line);
      let node = null;
      for (const lv of cm.display.view) { if (lv && lv.line === handle) { node = lv.node; break; } }
      const pre = node && (node.querySelector('pre') || node);
      if (!pre) return { found: false, curLine: cur.line };
      const cs = getComputedStyle(pre);
      const r = pre.getBoundingClientRect();
      const segTop = document.querySelector('.wysiwyg-quote-seg-top');
      let seam = null, innerBoxBottom = null;
      if (segTop) {
        const sr = segTop.getBoundingClientRect();
        const outer = segTop.querySelector('blockquote');
        const inner = outer && outer.querySelector('blockquote');
        innerBoxBottom = inner ? inner.getBoundingClientRect().bottom : null;
        seam = { segBottom: sr.bottom, innerBoxBottom, innerPb: inner ? getComputedStyle(inner).paddingBottom : null };
      }
      const refHandle = cm.getLineHandle(cm.lineCount() - 1);
      let refPre = null;
      for (const lv of cm.display.view) { if (lv && lv.line === refHandle) { const el = lv.node; refPre = el.tagName === 'PRE' ? el : el.querySelector('pre'); break; } }
      return {
        found: true, curLine: cur.line, lineText: cm.getLine(cur.line),
        cls: pre.className,
        bgLayers: (cs.backgroundImage.match(/linear-gradient/g) || []).length,
        bgSize: cs.backgroundSize, bgPos: cs.backgroundPosition,
        padB: cs.paddingBottom, preH: r.height, preBottom: r.bottom,
        segCls: segTop ? segTop.className : '', seam,
        refTop: refPre ? refPre.getBoundingClientRect().y : null,
      };
    });
    s86checks.push(['光标落行 5（末行 `> > asdfsafd`，edge-bottom + lvl-2）',
      s86geo.found === true && s86geo.curLine === 5
      && s86geo.cls.includes('wysiwyg-quote-nested') && s86geo.cls.includes('wysiwyg-quote-lvl-2')
      && s86geo.cls.includes('wysiwyg-block-edge-bottom')]);
    s86checks.push(['S86 核心：seg-top 挂 wysiwyg-quote-seg-open-2（嵌套开口方向 = 光标层级）',
      s86geo.segCls.includes('wysiwyg-quote-seg-open-2')]);
    const s86seamOk = s86geo.seam && s86geo.seam.innerBoxBottom !== null
      && s86geo.seam.innerPb === '16px'
      && Math.abs(s86geo.seam.segBottom - s86geo.seam.innerBoxBottom) <= 1;
    s86checks.push(['S86 核心：上段无白条（seg-top 底 = lvl2 盒底；深侧开口盒 16px 内距吸收闭合 lvl3 盒 margin，底色连续到接缝）',
      !!s86seamOk,
      JSON.stringify({ ok: s86seamOk, seam: s86geo.seam })]);
    s86checks.push(['S86 核心：末行背景 = 4 层底缘阶梯（2 层 × 竖条 + 底色，外盒收 16、内盒收 44）',
      s86geo.bgLayers === 4
      && s86geo.bgSize.includes('calc(100% - 16px)') && s86geo.bgSize.includes('calc(100% - 44px)')
      && s86geo.bgSize.includes('calc(100% - 64px)') && s86geo.bgSize.includes('calc(100% - 108px)')
      && s86geo.bgPos.includes('32px') && s86geo.bgPos.includes('56px')]);
    s86checks.push(['S86 核心：末行底距 = 56px（28×2，替代旧通用 40px）', s86geo.padB === '56px']);
    s86checks.push(['末行带底 → 参照段无缝（16px 盒底距内嵌带内，块下内容不跳）',
      s86geo.refTop !== null && Math.abs(s86geo.refTop - s86geo.preBottom) <= 1]);
    const s86shot = path.join(root, 'screenshots', 's86-nested-lastline.png');
    fs.mkdirSync(path.dirname(s86shot), { recursive: true });
    await page.screenshot({ path: s86shot });
    console.log('  截图: ' + path.relative(root, s86shot));
    // ② 顶缘对照：光标到块首行（lvl-2 edge-top）→ 层顶 12d、seg-bottom 开口
    const s86top = await page.evaluate(() => {
      const el = document.querySelector('.wysiwyg-quote-seg-top');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });
    if (s86top) {
      await page.mouse.click(s86top.x + 40, s86top.y + 0.15 * s86top.h);
      await page.waitForTimeout(400);
    }
    const s86topGeo = await page.evaluate(() => {
      const cm = window.__s86cm;
      const cur = cm.getCursor('head');
      const handle = cm.getLineHandle(cur.line);
      let node = null;
      for (const lv of cm.display.view) { if (lv && lv.line === handle) { node = lv.node; break; } }
      const pre = node && (node.querySelector('pre') || node);
      if (!pre) return { found: false, curLine: cur.line };
      const cs = getComputedStyle(pre);
      const segBot = document.querySelector('.wysiwyg-quote-seg-bottom');
      let innerBoxTop = null;
      if (segBot) {
        const sr = segBot.getBoundingClientRect();
        const outer = segBot.querySelector('blockquote');
        const inner = outer && outer.querySelector('blockquote');
        innerBoxTop = inner ? { box: inner.getBoundingClientRect().top, mask: sr.top } : null;
      }
      return {
        found: true, curLine: cur.line, cls: pre.className,
        bgSize: cs.backgroundSize, bgPos: cs.backgroundPosition, padT: cs.paddingTop,
        segBotCls: segBot ? segBot.className : '', innerBoxTop,
      };
    });
    s86checks.push(['顶缘对照：光标到块首行（行 2，edge-top + lvl-2）',
      s86topGeo.found === true && s86topGeo.curLine === 2
      && s86topGeo.cls.includes('wysiwyg-block-edge-top') && s86topGeo.cls.includes('wysiwyg-quote-lvl-2')]);
    s86checks.push(['顶缘对照：内层（lvl2）层顶 = 12px（盒 d 顶 = 12d）、高度收 12px',
      s86topGeo.bgPos.includes('56px 12px')
      && s86topGeo.bgSize.includes('calc(100% - 12px)')]);
    s86checks.push(['顶缘对照：seg-bottom 挂 open-2（lvl2 盒清顶：盒顶 = 段顶，与带内 lvl2 层无缝连续）',
      s86topGeo.segBotCls.includes('wysiwyg-quote-seg-open-2')
      && s86topGeo.padT === '24px'
      && s86topGeo.innerBoxTop && Math.abs(s86topGeo.innerBoxTop.box - s86topGeo.innerBoxTop.mask) <= 1]);
    const s86topShot = path.join(root, 'screenshots', 's86-nested-firstline.png');
    fs.mkdirSync(path.dirname(s86topShot), { recursive: true });
    await page.screenshot({ path: s86topShot });
    console.log('  截图: ' + path.relative(root, s86topShot));
    for (const [label, ok, extra] of s86checks) {
      console.log(`  ${ok ? '✓' : '✗'} ${label}` + (extra !== undefined ? '  ' + extra : ''));
      if (!ok) fail++;
    }
  }

  if (errors.length) {
    console.log('\n页面错误:');
    for (const e of errors) console.log('  ' + e);
    fail++;
  }
  console.log(fail === 0 ? '\n全部一致 ✓' : `\n${fail} 项不一致 ✗`);
  process.exitCode = fail === 0 ? 0 : 1;
} finally {
  await browser.close();
}
