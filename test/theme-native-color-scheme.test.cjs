// 原生 color-scheme 跟随应用主题（2026-10-25 用户反馈「亮色主题下鼠标是白色，白底上看不到」）。
//
// 根因：index.html 的 <meta name="color-scheme" content="light dark"> 只声明「两套都支持」，
// 实际用哪套由 UA 按**系统**的 prefers-color-scheme 决定。应用主题与 OS 主题不一致时，
// 浏览器原生 UI（滚动条、原生表单控件、文本 I/插入符指针）会按 OS 那套渲染：
// 应用选亮色而 OS 是暗色 → 原生指针被渲染成浅色，在白色正文上几乎不可见。
//
// 契约：applyThemeMode / toggleTheme 都必须把 documentElement 的 color-scheme 显式写成
// 应用当前明暗（dark/light），让 UA 不再与 OS 主题打架。
const test = require('node:test');
const assert = require('node:assert');
const { buildEnv, cleanup, waitForEditor } = require('./helpers/app-env.cjs');

const scheme = (w) => w.document.documentElement.style.getPropertyValue('color-scheme').trim();

test('applyThemeMode：亮色 → color-scheme: light，暗色 → dark', async () => {
  const { w } = await buildEnv();
  const ed = await waitForEditor(w);
  try {
    ed.settings.themeMode = 'light';
    await ed.applyThemeMode();
    assert.strictEqual(ed.isDark, false, 'themeMode=light 应得到亮色');
    assert.strictEqual(scheme(w), 'light', '亮色应用必须显式声明 color-scheme: light（否则 OS 暗色时原生指针变浅色）');

    ed.settings.themeMode = 'dark';
    await ed.applyThemeMode();
    assert.strictEqual(ed.isDark, true, 'themeMode=dark 应得到暗色');
    assert.strictEqual(scheme(w), 'dark', '暗色应用必须显式声明 color-scheme: dark');
  } finally { cleanup(w); }
});

test('toggleTheme：切换后 color-scheme 跟着翻转', async () => {
  const { w } = await buildEnv();
  const ed = await waitForEditor(w);
  try {
    ed.settings.themeMode = 'light';
    await ed.applyThemeMode();
    assert.strictEqual(scheme(w), 'light');

    await ed.toggleTheme();
    assert.strictEqual(ed.isDark, true);
    assert.strictEqual(scheme(w), 'dark', '切到暗色后 color-scheme 必须同步为 dark');

    await ed.toggleTheme();
    assert.strictEqual(ed.isDark, false);
    assert.strictEqual(scheme(w), 'light', '切回亮色后 color-scheme 必须同步为 light');
  } finally { cleanup(w); }
});

test('接线：主题只经 _applyThemeToDom 一个出口落到 DOM（不再两处各抄一份）', () => {
  const fs = require('fs');
  const path = require('path');
  const { ROOT } = require('./helpers/app-bundle.cjs');
  const src = fs.readFileSync(path.join(ROOT, 'src', 'modules', 'theme.js'), 'utf8');
  const count = (re) => (src.match(re) || []).length;

  assert.strictEqual(count(/setAttribute\('data-theme'/g), 1,
    'data-theme 只应在 _applyThemeToDom 里写一次（两处各写一份是「切主题后状态不一致」的根源）');
  assert.strictEqual(count(/_syncNativeColorScheme\(\)/g), 2,
    '应只有 1 处定义 + 1 处调用（调用点在 _applyThemeToDom 内）');
  assert.strictEqual(count(/_applyThemeToDom\(\)/g), 3,
    '应只有 1 处定义 + 2 处调用（applyThemeMode / toggleTheme）');
  // 结构：定义体里必须同时含 data-theme 与 color-scheme 同步
  const body = src.slice(src.indexOf('_applyThemeToDom() {'), src.indexOf('_applyThemeToDom() {') + 900);
  assert.match(body, /setAttribute\('data-theme'/, '_applyThemeToDom 应设 data-theme');
  assert.match(body, /_syncNativeColorScheme\(\)/, '_applyThemeToDom 应同步原生 color-scheme');
  assert.match(body, /setOption\('theme'/, '_applyThemeToDom 应设 CodeMirror 主题');
});
