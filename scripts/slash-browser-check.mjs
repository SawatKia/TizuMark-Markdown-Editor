// 无头浏览器验证：slash 命令面板防屏幕溢出（真实 Chromium + 真实 CM5 布局测量）。
// 背景：2026-10-13 用户报「在文档最下面输入 / 时面板被挡住显示不出来」——
// 面板恒在光标下方定位，底部打开时伸出视口被裁。修复为「下方放不下翻到光标上方 +
// 右缘左移」。jsdom 侧已验证翻转数学（stub 坐标），本脚本验证真实布局下的行为。
// 用法：node scripts/slash-browser-check.mjs
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

// playwright 解析（与 wysiwyg-browser-check.mjs 同模式）
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
const url = pathToFileURL(path.join(root, '_slash_check.html')).href;

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
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('页面异常: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true);

  const bottom = await page.evaluate(() => window.__run('bottom'));
  const mid = await page.evaluate(() => window.__run('mid'));
  const right = await page.evaluate(() => window.__run('right'));
  if (process.env.SLASH_DEBUG) console.log('DEBUG bottom:', JSON.stringify(bottom), '\nDEBUG mid:', JSON.stringify(mid), '\nDEBUG right:', JSON.stringify(right));

  const checks = [
    [`页面无异常: ${JSON.stringify(errors)}`, errors.length === 0],
    [`底部输入：面板完整落在视口内（不被屏幕底裁掉）: ${JSON.stringify(bottom.panel)}`,
      bottom.visible === true],
    [`底部输入：面板翻转到光标上方: ${JSON.stringify({ top: bottom.panel.top, curTop: bottom.coords && bottom.coords.top })}`,
      !!bottom.coords && bottom.panel.top < bottom.coords.top],
    [`中部输入：面板仍在光标下方（不回归）: ${JSON.stringify({ top: mid.panel.top, curBottom: mid.coords && mid.coords.bottom })}`,
      !!mid.coords && mid.panel.top > mid.coords.bottom && mid.panel.top - mid.coords.bottom <= 12],
    [`中部输入：面板可见: ${JSON.stringify(mid.panel)}`, mid.visible === true],
    [`右缘输入：面板不超出屏幕右缘（左移）: ${JSON.stringify({ right: right.panel.right, vw: right.viewport.vw })}`,
      right.panel.right <= right.viewport.vw + 1],
  ];
  for (const [label, ok] of checks) {
    console.log((ok ? '  ✓ ' : '  ✗ ') + label);
    if (!ok) fail++;
  }
} finally {
  await browser.close();
}
console.log(fail === 0 ? '\n全部一致 ✓' : `\n${fail} 项不一致 ✗`);
process.exit(fail === 0 ? 0 : 1);
