// Edge（msedge channel，真机 WebView2 同引擎）抽查：
// 1) 格编辑：真实点击进格 → 输入 → Enter 提交 → 焦点回编辑器（不掉 body）+ 回写源码
// 2) 行拖拽：真实鼠标从左 gutter 按下拖动 → 拖动中高亮/蓝握点 → 源码行换位
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
let pw;
try {
  pw = process.env.PLAYWRIGHT_MODULE ? require(process.env.PLAYWRIGHT_MODULE) : require('playwright');
} catch (_) {
  try {
    pw = require(path.join(root, 'node_modules', 'playwright'));
  } catch (_) {
    const globalDir = process.env.APPDATA
      ? path.join(process.env.APPDATA, 'npm', 'node_modules', 'playwright')
      : null;
    if (globalDir) pw = require(globalDir);
  }
}
const browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('file:///' + path.join(root, '_wysiwyg_compare.html').replace(/\\/g, '/'));
await page.waitForTimeout(800);

let fail = 0;
const check = (label, ok, extra) => { console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? ' | ' + extra : ''}`); if (!ok) fail++; };
const cmGetLine = (n) => page.evaluate((i) => {
  const el = document.querySelector('.CodeMirror');
  const cm = el && el.CodeMirror;
  return cm ? cm.getLine(i) : null;
}, n);

// ---------- 1) 格编辑 + Enter 焦点 ----------
console.log('=== Edge 抽查 1：格编辑 Enter 提交焦点 ===');
const io = await page.evaluate(() => window.__runCellEditRealIO());
if (io.err) { console.log('  ⚠ ' + io.err); fail++; }
await page.mouse.click(io.rect.x + io.rect.w / 2, io.rect.y + io.rect.h / 2);
await page.waitForTimeout(150);
const s1 = await page.evaluate(() => window.__cellState());
check('真实点击进格编辑', s1.activeIsCell && s1.cellEditable === 'true', JSON.stringify(s1));
await page.keyboard.type('ok');
await page.waitForTimeout(100);
const s2 = await page.evaluate(() => window.__cellState());
check('输入保持格内焦点', s2.activeIsCell && s2.cellEditable === 'true' && /ok/.test(s2.cellText || ''), JSON.stringify(s2));
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
const s3 = await page.evaluate(() => {
  const el = document.querySelector('.CodeMirror');
  const cm = el && el.CodeMirror;
  const ae = document.activeElement;
  return { ...window.__cellState(), row25: cm ? cm.getLine(25) : null, inCM: !!(el && ae && (ae === el || ae === el.querySelector('textarea') || el.contains(ae))) };
});
check('Enter 提交后焦点回编辑器（不掉 body）', s3.inCM && s3.activeTag !== 'BODY', JSON.stringify(s3));
check('内容已回写源码行（含 ok）', !!(s3.row25 && s3.row25.includes('ok')), s3.row25);

// ---------- 2) 左 gutter 真实拖行 ----------
console.log('=== Edge 抽查 2：左 gutter 真实拖行 ===');
const hd = await page.evaluate(() => window.__runTableHandles());
if (hd.err) { console.log('  ⚠ ' + hd.err); fail++; }
await page.mouse.move(hd.rowHandle.x, hd.rowHandle.y);
await page.waitForTimeout(150);
let hs = await page.evaluate(() => window.__handleState());
check('gutter hover 出灰色行握点（Edge 引擎）', hs.rowGrip && hs.rowGrip.opacity === '1' && hs.rowGrip.background === 'rgba(0, 0, 0, 0)', JSON.stringify(hs.rowGrip));
check('悬停行不高亮（Edge 引擎）', !hs.rowBg || hs.rowBg === 'rgba(0, 0, 0, 0)', String(hs.rowBg));
await page.mouse.down();
await page.mouse.move(hd.rowHandle.x, hd.rowDragTo.y, { steps: 8 });
await page.waitForTimeout(100);
hs = await page.evaluate(() => window.__handleState());
check('拖动中被拖行浅蓝高亮（Edge 引擎）', !!(hs.dragRowBg && hs.dragRowBg !== 'rgba(0, 0, 0, 0)'), String(hs.dragRowBg));
check('拖动中握点蓝底胶囊（Edge 引擎）', !!(hs.rowTrack && hs.rowTrack.dragging && hs.rowGrip && hs.rowGrip.background === 'rgb(37, 99, 235)'), JSON.stringify({ dragging: hs.rowTrack && hs.rowTrack.dragging, bg: hs.rowGrip && hs.rowGrip.background }));
await page.mouse.up();
await page.waitForTimeout(300);
const after = await page.evaluate(() => window.__tableSourceLines());
const firstCell = (ls) => (ls || []).slice(2).map((l) => (l.split('|')[1] || '').trim());
check('真实拖行成功（首行移到底部 a3,a4,a2）', JSON.stringify(firstCell(after)) === JSON.stringify(['a3', 'a4', 'a2']), JSON.stringify(after));
check('无页面异常', errors.length === 0, errors.slice(0, 3).join(' | '));

console.log(fail === 0 ? '\nEdge 抽查全部通过 ✓' : `\nEdge 抽查 ${fail} 项失败 ✗`);
await browser.close();
process.exit(fail === 0 ? 0 : 1);
