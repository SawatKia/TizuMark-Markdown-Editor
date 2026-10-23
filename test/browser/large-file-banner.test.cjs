/**
 * 无头浏览器回归测试：大文档提示条「不再提醒」按钮
 *
 * 为什么用真实浏览器（而非 jsdom）：
 *   本测试验证「点击不再提醒 → 本次会话内再次打开大文件不再弹横幅」这一端到端交互，
 *   依赖真实 DOM 事件、真实 classList 切换和真实 MarkdownEditor 实例（app.js 在
 *   DOMContentLoaded 时 new MarkdownEditor()）。jsdom 无法实例化 app.js（会拉起
 *   CodeMirror / Tauri），故用系统 Chrome 通过 dev-server(1420) 加载真实应用验证。
 *
 * 运行：由 scripts/run-tests.cjs 的 browser/ 分支自动拉起 dev-server(1420) + NODE_PATH 后执行。
 *   （也可手动：NODE_PATH=<managed node_modules> node test/browser/large-file-banner.test.cjs，需 dev-server 在 1420）
 */
'use strict';
const fs = require('fs');

const CHROME_PATH = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = 'http://localhost:1420/';

// 浏览器测试是本地范式：依赖系统 Chrome + 本机 node_modules 中的 puppeteer-core。
// CI（ubuntu）或缺少该环境的机器上直接运行时应优雅跳过，而非崩溃。
try {
  require('puppeteer-core');
} catch (_) {
  console.log('SKIP: puppeteer-core 不可用（浏览器回归测试需系统 Chrome + puppeteer-core，属本地范式）。');
  process.exit(0);
}
if (!fs.existsSync(CHROME_PATH)) {
  console.log('SKIP: 未找到系统 Chrome：' + CHROME_PATH);
  console.log('      设置 CHROME_PATH 环境变量指向本机 Chrome 可执行文件即可运行本测试。');
  process.exit(0);
}

const puppeteer = require('puppeteer-core');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const page = await browser.newPage();
  let failed = 0;
  const assert = (name, cond) => {
    if (cond) { console.log('  ✓ ' + name); }
    else { console.log('  ✗ ' + name); failed++; }
  };

  try {
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForFunction("window.editor && window.editor.preview", { timeout: 30000 });

    // 1) 横幅与按钮初始存在
    const hasBtn = await page.evaluate(() => !!document.getElementById('large-file-banner-dont-remind'));
    assert('存在「不再提醒」按钮', hasBtn);

    // 2) 初始会话标志为 false → showLargeFileNotice 应显示横幅
    //    注意：构造函数默认 viewMode='preview'，而 showLargeFileNotice 对纯预览模式
    //    直接 hide 后 return（注释见 src/app.js），故必须切到 edit 才能覆盖提示路径。
    const showsInitially = await page.evaluate(() => {
      const ed = window.editor;
      ed.viewMode = 'edit';
      ed._largeFileNoticeSessionSuppressed = false;
      ed._largeFileNoticeDismissed = false;
      ed._largeFileNoticeKey = null;
      const banner = document.getElementById('large-file-banner');
      banner.classList.add('hidden');
      ed.showLargeFileNotice('perf-banner', 50000, 1024 * 1024 * 8);
      return !banner.classList.contains('hidden');
    });
    assert('未点「不再提醒」时打开大文件会显示横幅', showsInitially);

    // 3) 点击「不再提醒」→ 会话标志置 true 且横幅隐藏
    const afterClick = await page.evaluate(() => {
      const ed = window.editor;
      ed._largeFileNoticeSessionSuppressed = false;
      ed._largeFileNoticeDismissed = false;
      const banner = document.getElementById('large-file-banner');
      banner.classList.remove('hidden');
      document.getElementById('large-file-banner-dont-remind').click();
      return { suppressed: ed._largeFileNoticeSessionSuppressed, hidden: banner.classList.contains('hidden') };
    });
    assert('点击「不再提醒」后会话标志置 true', afterClick.suppressed === true);
    assert('点击「不再提醒」后横幅立即隐藏', afterClick.hidden === true);

    // 4) 会话标志为 true 后，再次打开大文件不再弹（本次应用运行期间）
    const staysHidden = await page.evaluate(() => {
      const ed = window.editor;
      ed.viewMode = 'edit';
      const banner = document.getElementById('large-file-banner');
      // 前置：真实流程里打开文档前横幅已被 hideLargeFileNotice 置为隐藏
      // （见 src/controllers/preview-controller.js 非截断分支），故从 hidden 起步。
      banner.classList.add('hidden');
      ed.showLargeFileNotice('perf-banner', 60000, 1024 * 1024 * 9);
      return banner.classList.contains('hidden');
    });
    assert('点过「不再提醒」后再次打开大文件不再弹横幅', staysHidden);

    // 5) 「不再提醒」必须是会话级：重新实例化（模拟重启）后标志复位为 false 仍可弹
    const resetsOnRestart = await page.evaluate(() => {
      const ed = window.editor;
      ed.viewMode = 'edit';
      // 模拟应用重启：标志回到初始 false（构造函数里初始化为 false）
      ed._largeFileNoticeSessionSuppressed = false;
      const banner = document.getElementById('large-file-banner');
      banner.classList.add('hidden');
      ed.showLargeFileNotice('perf-banner', 50000, 1024 * 1024 * 8);
      return !banner.classList.contains('hidden');
    });
    assert('模拟重启（标志复位）后打开大文件仍会提醒', resetsOnRestart);

    // 6) 纯预览模式走虚拟滚动可拖到任意位置，产品约定不弹横幅（src/app.js early-return 分支）
    const previewSuppressed = await page.evaluate(() => {
      const ed = window.editor;
      ed.viewMode = 'preview';
      ed._largeFileNoticeSessionSuppressed = false;
      ed._largeFileNoticeDismissed = false;
      ed._largeFileNoticeKey = null;
      const banner = document.getElementById('large-file-banner');
      banner.classList.remove('hidden');
      ed.showLargeFileNotice('perf-banner', 50000, 1024 * 1024 * 8);
      return banner.classList.contains('hidden');
    });
    assert('纯预览模式不弹横幅（虚拟滚动可查看全文）', previewSuppressed);

  } catch (e) {
    console.error('测试执行异常：', e);
    failed++;
  } finally {
    await browser.close();
  }

  console.log(failed === 0 ? '\nlarge-file-banner 浏览器测试全部通过 ✓' : `\nlarge-file-banner 浏览器测试失败 ${failed} 项`);
  process.exit(failed === 0 ? 0 : 1);
})();
