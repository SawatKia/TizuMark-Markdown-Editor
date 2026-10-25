// 主题切换 mermaid 分批重渲染 + loading 提示测试。
// 根因：rerenderMermaid 一次性 mermaid.run(全部节点) 是同步 CPU 密集任务（layout 计算），
// 图表多时阻塞主线程造成明显卡顿。修复：每帧一批（BATCH=3）+ rAF 让步，图表 >6 显示 pane-loading。
const test = require('node:test');
const assert = require('node:assert');
const { buildEnv, cleanup, waitForEditor } = require('./helpers/app-env.cjs');

function fakeMermaid() {
  return {
    runs: [],
    initialize() {},
    async run({ nodes }) {
      this.runs.push(nodes.map((n) => n.textContent));
    },
  };
}

async function makeEditorWithMermaid(nodeCount) {
  const { w } = await buildEnv();
  const ed = await waitForEditor(w);
  w.mermaid = fakeMermaid(); // 注入 fake mermaid（构造期 rerenderMermaid 因 mermaid 未定义已跳过）
  const frag = w.document.createDocumentFragment();
  for (let i = 0; i < nodeCount; i++) {
    const c = w.document.createElement('div');
    c.className = 'mermaid-container';
    c.textContent = 'graph LR; A-->B' + i;
    frag.appendChild(c);
  }
  ed.preview.appendChild(frag);
  return { w, ed, mermaid: w.mermaid };
}

test('图表少（3）：按 BATCH=2 分 2 批完成，不显示 loading', async () => {
  const { w, ed, mermaid } = await makeEditorWithMermaid(3);
  try {
    let begins = 0;
    const ob = ed._beginPaneLoad.bind(ed);
    ed._beginPaneLoad = () => { begins++; ob(); };
    await ed.rerenderMermaid();
    assert.strictEqual(mermaid.runs.length, 2, '3 个图表按 BATCH=2 分 2 批');
    assert.strictEqual(begins, 0, '图表少（≤6）不应显示 loading');
    let total = 0;
    for (const batch of mermaid.runs) {
      assert.ok(batch.length <= 2, '每批不得超过 2 个节点');
      total += batch.length;
    }
    assert.strictEqual(total, 3, '分批不得丢节点');
  } finally { cleanup(w); }
});

test('图表多（8）：分批渲染，每批 ≤2，总节点不丢', async () => {
  const { w, ed, mermaid } = await makeEditorWithMermaid(8);
  try {
    await ed.rerenderMermaid();
    assert.ok(mermaid.runs.length >= 4, '8 个图表应至少分 4 批（BATCH=2）');
    let total = 0;
    for (const batch of mermaid.runs) {
      assert.ok(batch.length <= 2, '每批不得超过 2 个节点');
      total += batch.length;
    }
    assert.strictEqual(total, 8, '分批不得丢节点');
  } finally { cleanup(w); }
});

test('图表多（8）：显示 loading 并在完成后隐藏（_beginPaneLoad/_endPaneLoad 对称）', async () => {
  const { w, ed } = await makeEditorWithMermaid(8);
  try {
    let begins = 0;
    let ends = 0;
    const ob = ed._beginPaneLoad.bind(ed);
    const oe = ed._endPaneLoad.bind(ed);
    ed._beginPaneLoad = () => { begins++; ob(); };
    ed._endPaneLoad = () => { ends++; oe(); };
    await ed.rerenderMermaid();
    assert.ok(begins >= 1, '图表多时应显示 loading');
    assert.strictEqual(begins, ends, 'loading 开始/结束必须对称');
    // hidePaneLoading 有 180ms 最小显示时长，需等它完成再断言隐藏
    await new Promise((r) => setTimeout(r, 220));
    assert.ok(w.document.getElementById('pane-loading').classList.contains('hidden'), '完成后应隐藏 loading');
  } finally { cleanup(w); }
});

test('toggleTheme 切换太快时遮罩有最小显示时长（不一闪而过）', async () => {
  const { w, ed } = await makeEditorWithMermaid(2); // 图表少，渲染快
  try {
    const start = Date.now();
    await ed.toggleTheme();
    const duration = Date.now() - start;
    // 最小显示 300ms + 淡出 320ms ≈ 620ms；留 50ms 余量
    assert.ok(duration >= 570, '总时长应 ≥ 最小显示(300ms)+淡出(320ms)，实际 ' + duration + 'ms');
  } finally { cleanup(w); }
});

test('toggleTheme 点击即全局 loading：遮罩固定切换前主题色，完成后淡出隐藏', async () => {
  const { w, ed } = await makeEditorWithMermaid(2);
  try {
    const overlay = w.document.getElementById('loading-overlay');
    // toggleTheme 是 async：调用后同步段立即固定旧主题色并显示遮罩，之后双 rAF 再改主题
    const p = ed.toggleTheme();
    assert.ok(!overlay.classList.contains('hidden'), '点击应立即显示全局 loading');
    assert.notStrictEqual(overlay.style.backgroundColor, '', '遮罩应固定切换前主题色（避免瞬间跳变）');
    await p;
    assert.strictEqual(overlay.style.backgroundColor, '', '完成后应清除固定色');
    assert.ok(overlay.classList.contains('hidden'), '淡出后应隐藏遮罩');
    assert.ok(ed.isDark, '主题应已切换');
  } finally { cleanup(w); }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-24 用户反馈：WYSIWYG（实时预览）下切换暗色/明亮，图表颜色不变。
// 根因：rerenderMermaid 只重建 #preview 里的 .mermaid-container，而 WYSIWYG 的图表挂在
// CM 的块遮罩 widget 内（不在 #preview），从不被重渲染 → 配色恒为首次渲染时的主题。
// 修复：新增 _rerenderWysiwygMermaid，就地重置遮罩内容器（清 data-processed/回填源码）
// 后按新主题分批 run，并回填 mermaidCache。
// ─────────────────────────────────────────────────────────────────────────────
function fakeMermaidWithSvg() {
  return {
    runs: [],
    lastInit: null,
    initialize(opts) { this.lastInit = opts; },
    async run({ nodes }) {
      this.runs.push(nodes.map((n) => n.textContent));
      nodes.forEach((n) => {
        n.innerHTML = '<svg class="fake-theme-svg"></svg>';
        n.setAttribute('data-processed', 'true');
      });
    },
  };
}

// 在 CM 容器里造一个「已渲染过旧主题」的遮罩图表容器
function makeMaskMermaid(w, cm, code) {
  const c = w.document.createElement('div');
  c.className = 'mermaid-container';
  c.setAttribute('data-code', code);
  c.setAttribute('data-processed', 'true'); // mermaid 的已渲染标记
  c.innerHTML = '<svg class="old-theme-svg"></svg>';
  cm.getWrapperElement().appendChild(c);
  return c;
}

test('WYSIWYG：切主题重渲染遮罩内图表（清 data-processed、回填源码、按新主题 run）', async () => {
  const { w } = await buildEnv();
  const ed = await waitForEditor(w);
  try {
    const mermaid = fakeMermaidWithSvg();
    w.mermaid = mermaid;
    ed.viewMode = 'wysiwyg';
    ed.isDark = true;
    const a = makeMaskMermaid(w, ed.cm, 'graph LR; A-->B');
    const b = makeMaskMermaid(w, ed.cm, 'graph RL; C-->D');

    await ed.rerenderMermaid();

    // 两个容器都被重跑，且喂回去的是 data-code 里的源码（不是旧 SVG 文本）
    const fed = mermaid.runs.flat().sort();
    assert.deepStrictEqual(fed, ['graph LR; A-->B', 'graph RL; C-->D'], '应以 data-code 源码重渲染');
    assert.ok(!a.innerHTML.includes('old-theme-svg'), '旧主题 SVG 必须被清掉');
    assert.ok(a.querySelector('svg.fake-theme-svg'), '应换成新主题渲染结果');
    assert.strictEqual(b.getAttribute('data-code'), 'graph RL; C-->D', 'data-code 不得被破坏');
    // initialize 必须用深色主题（与首次渲染同一安全等级，重渲染不降级）
    assert.strictEqual(mermaid.lastInit.theme, 'dark', '深色主题应传 theme:dark');
    assert.strictEqual(mermaid.lastInit.securityLevel, 'strict', 'securityLevel 不得降级为 loose');
    // 缓存回填：后续遮罩重建（打字/滚动）直接命中，不重复渲染
    const cached = ed._mermaidCache.get('dark::graph LR; A-->B');
    assert.ok(cached && cached.includes('fake-theme-svg'), '应回填 dark::源码 的缓存');
  } finally { cleanup(w); }
});

test('WYSIWYG：明亮主题重渲染传 theme:default，缓存键为 light::源码', async () => {
  const { w } = await buildEnv();
  const ed = await waitForEditor(w);
  try {
    const mermaid = fakeMermaidWithSvg();
    w.mermaid = mermaid;
    ed.viewMode = 'wysiwyg';
    ed.isDark = false;
    makeMaskMermaid(w, ed.cm, 'pie title 占比');

    await ed.rerenderMermaid();

    assert.strictEqual(mermaid.lastInit.theme, 'default', '明亮主题应传 theme:default');
    assert.ok(ed._mermaidCache.get('light::pie title 占比'), '缓存键应为 light::源码');
    assert.strictEqual(ed._mermaidCache.get('dark::pie title 占比'), undefined, '不得写入错误主题的缓存');
  } finally { cleanup(w); }
});

test('WYSIWYG：遮罩内无图表时不影响 #preview 路径（两条路径互不干扰）', async () => {
  const { w } = await buildEnv();
  const ed = await waitForEditor(w);
  try {
    const mermaid = fakeMermaidWithSvg();
    w.mermaid = mermaid;
    ed.viewMode = 'wysiwyg'; // 遮罩里没有图表
    const c = w.document.createElement('div');
    c.className = 'mermaid-container';
    c.textContent = 'graph TD; X-->Y';
    ed.preview.appendChild(c);

    await ed.rerenderMermaid();
    const fed = mermaid.runs.flat();
    assert.deepStrictEqual(fed, ['graph TD; X-->Y'], '#preview 的图表仍应被重渲染');
  } finally { cleanup(w); }
});

test('接线断言：rerenderMermaid 在 WYSIWYG 下必调 _rerenderWysiwygMermaid（防回归）', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(require('./helpers/app-env.cjs').ROOT, 'src', 'modules', 'theme.js'), 'utf8');
  assert.ok(/_rerenderWysiwygMermaid\s*\(gen\)/.test(src), 'theme.js 必须有 _rerenderWysiwygMermaid 调用');
  assert.ok(/if \(this\.viewMode === 'wysiwyg'\) await this\._rerenderWysiwygMermaid\(gen\)/.test(src),
    'WYSIWYG 分支必须无条件执行（不得 return 跳过 #preview 路径）');
  assert.ok(/removeAttribute\('data-processed'\)/.test(src),
    '重渲染前必须清 data-processed，否则 mermaid.run 直接跳过该节点');
});

// 2026-10-25 审查发现：三条 mermaid 渲染路径的 securityLevel 曾不一致 ——
// 首次渲染（preview-post.js）与 WYSIWYG 重渲染（theme.js:211）都是 'strict'，
// 而 #preview 的重渲染（theme.js:141）单独写成 'loose'。
// 后果不是安全问题那么远，而是「切一次主题就换一套渲染规则」：宽松模式才解析图内 HTML 标签，
// 于是含标签的图在切主题后外观会变。上面那些用例只走 WYSIWYG 路径（lastInit 来自 211 行），
// 101 行这条 #preview 路径从没被断言过 securityLevel，所以不一致一直没被发现。
// 口径：应用内（首次渲染 / #preview 重渲染 / WYSIWYG 重渲染）一律 'strict'；
// 只有导出（export.js）保留 'loose' —— 导出要完整保真，不参与预览一致性。
test('#preview 重渲染：securityLevel 与首次渲染一致为 strict（不因切主题换渲染规则）', async () => {
  const { w } = await buildEnv();
  const ed = await waitForEditor(w);
  try {
    const mermaid = fakeMermaidWithSvg();
    w.mermaid = mermaid;
    ed.viewMode = 'wysiwyg'; // 遮罩里不放图表 → 只走 #preview 分支
    ed.isDark = true;
    const c = w.document.createElement('div');
    c.className = 'mermaid-container';
    c.textContent = 'graph TD; P-->Q';
    ed.preview.appendChild(c);

    await ed.rerenderMermaid();

    assert.ok(mermaid.lastInit, '应调用 mermaid.initialize');
    assert.strictEqual(mermaid.lastInit.securityLevel, 'strict',
      '#preview 重渲染不得降级为 loose（否则切主题后含 HTML 标签的图外观会变）');
    assert.strictEqual(mermaid.lastInit.theme, 'dark', '深色主题应传 theme:dark');
  } finally { cleanup(w); }
});

test('接线断言：应用内 mermaid 初始化一律 strict，只有导出路径允许 loose', () => {
  const fs = require('fs');
  const path = require('path');
  const { ROOT } = require('./helpers/app-env.cjs');
  const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

  for (const f of ['src/modules/theme.js', 'src/modules/preview-post.js']) {
    const src = read(f);
    const levels = [...src.matchAll(/securityLevel\s*:\s*'([a-z]+)'/g)].map((m) => m[1]);
    assert.ok(levels.length > 0, `${f} 应至少有一处 mermaid.initialize`);
    assert.ok(levels.every((l) => l === 'strict'), `${f} 内的 securityLevel 必须全为 strict，实得 ${levels.join('/')}`);
  }
  // 导出路径故意保留 loose（保真优先），这里明确记下这条例外，避免下次又"统一"掉
  const exp = read('src/modules/export.js');
  assert.ok(/securityLevel\s*:\s*'loose'/.test(exp), '导出路径应保留 loose（保真），不要跟着改成 strict');
});
