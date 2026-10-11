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
// 启动：优先 playwright 自带浏览器；版本与本机 ms-playwright 缓存不匹配时退回缓存可执行文件
let browser;
try {
  browser = await pw.chromium.launch({ headless: true });
} catch (e) {
  const exe = findChromium();
  if (!exe) throw e;
  browser = await pw.chromium.launch({ headless: true, executablePath: exe });
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
    [`空行提示类已挂: ${r.hintClass}`, r.hintClass],
    [`空行提示文案 = ${r.hintText}（应为 "emptyLineHint"）`, typeof r.hintText === 'string' && r.hintText.includes('emptyLineHint')],
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
    // 硬底线：被点中的源码行必须留在视口内——这才是「不乱跳」；像素级回到点击点只是锦上添花
    [`每次点击后目标源码行都在视口内（${off} ≤ top < ${off + 600}）: ${inView}`, inView],
    [`点击锚定精确到亚像素（最大偏差 ${a.maxGap}px，应 < 8）`, a.maxGap < 8],
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

  // ---------- S14：块「编辑」按钮（全块挂载 / hover 显现 / 代码块让位 / 点击解罩落块首，2026-10-12 #4） ----------
  await page.evaluate(() => window.__runEditBtn());
  const bt = await page.evaluate(() => window.__RESULT_BTN);
  console.log('\n=== S14：块「编辑」按钮（hover 显现 + 点击解罩落块首）===');
  console.log('  ' + JSON.stringify(bt));
  const checks14 = [
    [`每个遮罩块均挂编辑按钮: ${bt.btnMasks}/${bt.totalMasks}`, bt.allHaveBtn === true],
    [`按钮默认隐藏（opacity 0，hover 显现）: ${bt.defaultOpacity}`, bt.defaultOpacity === '0'],
    [`代码块内让位复制按钮（right=76px）: ${bt.codeOffsetOk}`, bt.codeOffsetOk === true],
    [`普通块 right=10px: ${bt.plainOffset}`, bt.plainOffset === true],
    [`点击编辑按钮：解罩 + 光标落块首行: ${JSON.stringify(bt.click)}`,
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
    [`编辑按钮进多行列表：旧行撤光 + 只有光标行（块首行 12）灰底（块内其余行无底、单行四角全圆）: ${JSON.stringify(hl.inList)}`,
      hl.inList && hl.inList.cursorLine === 12 && hl.inList.line2 === false && hl.inList.line12 === true &&
      hl.inList.line13 === false && hl.inList.rows === 1 && hl.inList.singleLineAllCorners === true],
    [`灰底随光标在块内移动（行 13 有底、行 12 撤底）: ${JSON.stringify(hl.inListFollow)}`,
      hl.inListFollow && hl.inListFollow.line13 === true && hl.inListFollow.line12 === false &&
      hl.inListFollow.rows === 1 && hl.inListFollow.singleLineAllCorners === true],
    [`移到块间空行：全部撤光 + 角类清除（块重新遮罩）: ${JSON.stringify(hl.onBlank)}`,
      hl.onBlank && hl.onBlank.activeIdx === -1 && hl.onBlank.line12 === false && hl.onBlank.line13 === false &&
      hl.onBlank.noBgDiv === true],
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
      // 可以编辑；表头格仍是列拖把手，真拖动超阈值才取消编辑进拖拽）
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
      checks31.push(['初始：ul 活动行 = 3 个•圆点 + 条目文字（含嵌套），其余 4 块遮罩',
        initial.bullets === 3 && initial.listTexts.join('|') === '无序条目一|无序条目二|嵌套条目' &&
        initial.masks === 4 && initial.activeIdx === 0]);
      let r = await page.evaluate(() => window.__s31rects());
      if (!r.ol) {
        checks31.push(['ol 块：未找到遮罩（场景异常）', false]);
      } else {
        await page.mouse.click(r.ol.x, r.ol.y);
        await new Promise(rr => setTimeout(rr, 200));
        const st = await read();
        console.log('  点 ol 后: ' + JSON.stringify(st));
        checks31.push(['点 ol：数字序号 1./2. 原样渲染 + 条目文字（预览字族）',
          st.olMarkers.join('|') === '1.|2.' && st.listTexts.join('|') === '有序条目一|有序条目二' &&
          st.bullets === 0 && st.masks === 4]);
      }
      r = await page.evaluate(() => window.__s31rects());
      if (!r.task) {
        checks31.push(['task 块：未找到遮罩（场景异常）', false]);
      } else {
        await page.mouse.click(r.task.x, r.task.y);
        await new Promise(rr => setTimeout(rr, 200));
        const st = await read();
        console.log('  点 task 后: ' + JSON.stringify(st));
        checks31.push(['点 task：2 圆点 + 2 复选框（1 勾选）+ 任务文字（含框后源空格间距）',
          st.bullets === 2 && st.taskBoxes === 2 && st.taskChecked === 1 &&
          st.listTexts.join('|') === ' 未完成任务| 已完成任务' && st.masks === 4]);
      }
      r = await page.evaluate(() => window.__s31rects());
      if (!r.code) {
        checks31.push(['code 块：未找到遮罩（场景异常）', false]);
      } else {
        await page.mouse.click(r.code.x, r.code.y);
        await new Promise(rr => setTimeout(rr, 200));
        const st = await read();
        console.log('  点 code 后: ' + JSON.stringify(st));
        checks31.push(['点 code：上下围栏灰显（```js / ```）+ 整块灰盒 4 行',
          st.fences.join('|') === '```js|```' && st.activeBoxLines === 4 &&
          st.listTexts.length === 0 && st.masks === 4]);
        // 行内编辑：代码块内输入 → 装饰稳定（围栏不变）
        await page.keyboard.type('X');
        await new Promise(rr => setTimeout(rr, 150));
        const stE = await read();
        checks31.push(['代码块内输入：围栏装饰稳定（仍 2 段灰显）',
          stE.fences.join('|') === '```js|```' && stE.masks === 4]);
      }
      r = await page.evaluate(() => window.__s31rects());
      if (r.para) {
        await page.mouse.click(r.para.x, r.para.y);
        await new Promise(rr => setTimeout(rr, 250));
        const stP = await read();
        console.log('  点段落后: ' + JSON.stringify(stP));
        checks31.push(['点段落：列表/代码装饰全清（无残留 span）',
          stP.bullets === 0 && stP.taskBoxes === 0 && stP.olMarkers.length === 0 &&
          stP.fences.length === 0 && stP.masks === 4]);
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
    console.log('\n=== S32：底部行滚动余量（底部无行时也能上滚一段） ===');
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
      checks34.push(['引用：前缀 span + 正文 span + 行内粗体（引用内嵌套）',
        has(l3, 'wysiwyg-quote-prefix') && has(l3, 'wysiwyg-quote-text') && has(l3, 'wysiwyg-bold')]);
      // ④ 切到嵌套引用行：外层 > 画左竖条
      await page.evaluate(() => window.__s34cursor(4, 0));
      await new Promise(r => setTimeout(r, 150));
      const l4 = await page.evaluate(() => window.__s34classes(4));
      console.log('  行4（活动嵌套引用行）: ' + JSON.stringify(l4));
      checks34.push(['嵌套引用：外层 > 带竖条 span（wysiwyg-quote-bar）',
        has(l4, 'wysiwyg-quote-bar') && has(l4, 'wysiwyg-quote-prefix')]);
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
  {
    console.log('\n=== S35：光标行单行灰底 + 编辑态排版对齐渲染态 ===');
    const p35 = await page.evaluate(() => window.__runPlainTextDecor2026());
    if (p35.err) {
      console.log('  ⚠ 场景失败: ' + p35.err);
      fail++;
    } else {
      const checks35 = [];
      const sleep35 = (ms) => new Promise(r => setTimeout(r, ms));
      // ① 点列表遮罩（行2）进块：只有光标行（行2）灰底，块内行1/3 无底
      const mp = await page.evaluate(() => window.__s35maskPoint(2));
      if (!mp) {
        console.log('  ⚠ 列表遮罩定位失败');
        fail++;
      } else {
        await page.mouse.click(mp.x, mp.y);
        await sleep35(250);
        const b = await page.evaluate(() => ({
          activeIdx: window.__s35ed._wysiwygActiveIdx,
          cursorLine: window.__s35ed.cm.getCursor().line,
          bg1: window.__s35bg(1), bg2: window.__s35bg(2), bg3: window.__s35bg(3),
        }));
        console.log('  点列表后: ' + JSON.stringify(b));
        // 光标落哪行由遮罩竖向比例决定（点击点=遮罩中心）：断言「只有光标行灰底」
        const expectBg = { 1: b.bg1, 2: b.bg2, 3: b.bg3 };
        const others = [1, 2, 3].filter((n) => n !== b.cursorLine);
        checks35.push(['列表块：只有光标行灰底（块内其余行无底）',
          b.activeIdx === 1 && b.cursorLine >= 1 && b.cursorLine <= 3 &&
          expectBg[b.cursorLine] === true && others.every((n) => expectBg[n] === false)]);
        // ② 光标块内移动（行1）：灰底跟随
        await page.evaluate(() => window.__s35cursor(1, 5));
        await sleep35(150);
        const b2 = await page.evaluate(() => ({ bg1: window.__s35bg(1), bg2: window.__s35bg(2) }));
        console.log('  光标移到行1: ' + JSON.stringify(b2));
        checks35.push(['灰底随光标在块内移动（行1 有底、行2 撤底）', b2.bg1 === true && b2.bg2 === false]);
        // ③ 活动列表行排版 = 渲染态（预览字族 + 16px + 行高1.7 + 正文色）+ 行内粗体嵌套
        const t = await page.evaluate(() => {
          const ln = window.__s35lineEl(1);
          if (!ln) return null;
          const cs = getComputedStyle(ln);
          const bold = Array.from(ln.querySelectorAll('span'))
            .some((s) => (s.className || '').indexOf('wysiwyg-bold') >= 0);
          return {
            plain: (ln.className || '').indexOf('wysiwyg-plain-text') >= 0,
            ff: cs.fontFamily, fs: cs.fontSize, lh: cs.lineHeight, color: cs.color, bold,
          };
        });
        console.log('  行1 排版: ' + JSON.stringify(t));
        checks35.push(['活动列表行：plain-text 行类 + 预览字族', t && t.plain === true && t.ff.indexOf('Segoe UI') >= 0]);
        checks35.push(['活动列表行：字号 16px + 行高 27.2px（=16×1.7，与渲染态一致）',
          t && t.fs === '16px' && t.lh === '27.2px']);
        checks35.push(['活动列表行：正文色 --text-primary（#22262e）',
          t && t.color === 'rgb(34, 38, 46)']);
        checks35.push(['活动列表行：行内 **加粗** 渲染化（与批次 A 一致）', t && t.bold === true]);
        // ④ 点围栏遮罩（行6）：代码块整块灰盒（容器观感）+ 源文行不挂 plain-text
        const fp = await page.evaluate(() => window.__s35maskPoint(6));
        if (!fp) {
          console.log('  ⚠ 围栏遮罩定位失败');
          fail++;
        } else {
          await page.mouse.click(fp.x, fp.y);
          await sleep35(250);
          const f = await page.evaluate(() => ({
            activeIdx: window.__s35ed._wysiwygActiveIdx,
            bg5: window.__s35bg(5), bg6: window.__s35bg(6), bg7: window.__s35bg(7),
            p5: window.__s35plain(5), p6: window.__s35plain(6), p7: window.__s35plain(7),
          }));
          console.log('  点围栏后: ' + JSON.stringify(f));
          checks35.push(['代码块：整块灰盒（首/中/末行均有底）',
            f.activeIdx === 2 && f.bg5 === true && f.bg6 === true && f.bg7 === true]);
          checks35.push(['代码块：源文行不挂 plain-text（保持等宽源文）',
            f.p5 === false && f.p6 === false && f.p7 === false]);
          // ⑤ 进尾段落块：单行灰底 + plain-text（围栏块撤底）
          await page.evaluate(() => window.__s35cursor(8, 2));
          await sleep35(250);
          const g = await page.evaluate(() => ({
            activeIdx: window.__s35ed._wysiwygActiveIdx,
            bg8: window.__s35bg(8), bg5: window.__s35bg(5),
            p8: window.__s35plain(8),
          }));
          console.log('  进尾段落后: ' + JSON.stringify(g));
          checks35.push(['段落块：光标行灰底 + plain-text（原代码块撤底）',
            g.activeIdx === 3 && g.bg8 === true && g.bg5 === false && g.p8 === true]);
        }
      }
      for (const [label, ok] of checks35) {
        console.log(`  ${ok ? '✓' : '✗'} ${label}`);
        if (!ok) fail++;
      }
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
