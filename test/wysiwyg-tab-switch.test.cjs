// 所见即所得 × 标签页切换的行为回归（2026-10-12 真机反馈 #3 + 二报告崩溃场景）：
//   - 所见即所得下切走再切回，必须走 beginWysiwygPreRender 预渲染管线：
//     块表按新文档重算、内容不丢、视图模式保持 wysiwyg、会话模式记录正确；
//   - 切回后输入触发全量增量刷新（_refreshWysiwygFullIncremental）不崩；
//   - 应用初始可能有多个 tab（untitled + 使用说明等），索引一律按 tab 名定位，禁用硬编码序号。
//
// 真浏览器端到端（loading 覆盖层 / 遮罩可见性）在 scripts/wysiwyg-browser-check.mjs。

const test = require('node:test');
const assert = require('node:assert');
const { withEditor, delay } = require('./helpers/app-env.cjs');

const MD_A = ['# A', '', '段落 A 一。', '', '## A2', '', '段落 A 二。'].join('\n');
const MD_B = ['# B', '', '段落 B 一。', '', '段落 B 二。'].join('\n');
const BLOCKS_A = 4; // h1 / p / h2 / p
const BLOCKS_B = 3; // h1 / p / p

async function openFileTab(ed, name, md, filePath) {
  await ed.addTab(name, md, filePath, 'markdown');
  // addTab 内部的 switchTab 会对未 _loaded 的 filePath tab 触发 ensureTabLoaded 读盘；
  // 测试环境无该文件——读盘失败会把 tab.content 清空（ensureTabLoaded 的懒加载兜底）。
  // 按名置 _loaded=true 模拟「真实已打开的文件 tab」（内容以传入为准）。
  const tab = ed.tabs.find((t) => t.name === name);
  if (tab) tab._loaded = true;
  return tab;
}

test('所见即所得下 切走→切回：预渲染管线重算块表、内容不丢、模式保持', async () => {
  await withEditor({}, async (w, ed) => {
    const errors = [];
    const origErr = w.console.error;
    w.console.error = (...a) => errors.push(a.map((x) => (x && x.message ? x.message : String(x))).join(' '));
    try {
      const tabA = await openFileTab(ed, 'A.md', MD_A, 'C:/tmp/wt/A.md');
      await delay(120);
      assert.strictEqual(ed.activeTab, tabA, '切到 A 后 A 应为活动 tab');

      ed.setViewMode('wysiwyg');
      await delay(500); // 50ms 预渲染 + 50ms 遮罩
      assert.strictEqual(ed.viewMode, 'wysiwyg', '进入所见即所得后模式应为 wysiwyg');
      assert.strictEqual((ed._wysiwygBlocks || []).length, BLOCKS_A, 'A 的块表应为 ' + BLOCKS_A + ' 块');
      assert.strictEqual(ed._sessionMdViewMode, 'wysiwyg', 'md 文件进入 wysiwyg 应记录会话模式（后续标签切换沿用）');

      await openFileTab(ed, 'B.md', MD_B, 'C:/tmp/wt/B.md');
      await delay(500);
      assert.strictEqual(ed.viewMode, 'wysiwyg', '切到 B 仍应保持 wysiwyg（会话模式）');
      assert.strictEqual((ed._wysiwygBlocks || []).length, BLOCKS_B, 'B 的块表应为 ' + BLOCKS_B + ' 块（按 B 的内容重算，不得残留 A 的块表）');
      assert.strictEqual(tabA.content, MD_A, '切走后 A 的内容必须原样保存（tab.content）');

      const idxA = ed.tabs.findIndex((t) => t.name === 'A.md');
      await ed.switchTab(idxA);
      await delay(500);
      assert.strictEqual(ed.viewMode, 'wysiwyg', '切回 A 后模式应保持 wysiwyg');
      assert.strictEqual(ed.cm.getValue(), MD_A, '切回 A 后编辑器内容必须是 A 的源码（不得清空/串档）');
      assert.strictEqual((ed._wysiwygBlocks || []).length, BLOCKS_A, '切回 A 后块表必须按 A 重算（预渲染管线消费，不得为空）');
      assert.strictEqual((ed._wysiwygBlocks || [])[0].start, 0, '块表首块应从第 0 行开始');

      // 连续切换 ×2（用户「大量」报错场景的往返压力）
      const idxB = ed.tabs.findIndex((t) => t.name === 'B.md');
      await ed.switchTab(idxB);
      await delay(300);
      await ed.switchTab(idxA);
      await delay(300);
      assert.strictEqual(ed.viewMode, 'wysiwyg', '连续切换后模式仍应保持 wysiwyg');
      assert.strictEqual((ed._wysiwygBlocks || []).length, BLOCKS_A, '连续切换后块表仍应为 A 的 ' + BLOCKS_A + ' 块');

      // 切回后输入：全量增量刷新路径（_refreshWysiwygFullIncremental）不崩、块表跟随
      const line = ed.cm.lineCount() - 1;
      ed.cm.replaceRange(' 追加。', { line, ch: ed.cm.getLine(line).length });
      await delay(500); // 250ms 防抖 + 增量刷新
      assert.strictEqual(ed.viewMode, 'wysiwyg', '输入后模式不变');
      assert.ok(ed.cm.getValue().includes('追加。'), '输入内容必须保留');
      assert.ok((ed._wysiwygBlocks || []).length >= BLOCKS_A, '输入后块表仍应完整');

      const fatal = errors.filter((e) => /预渲染失败|全量增量刷新失败|reading 'start'|reading 'end'/.test(e));
      assert.deepStrictEqual(fatal, [], '切换/输入过程出现管线错误：' + JSON.stringify(fatal.slice(0, 3)));
    } finally {
      w.console.error = origErr;
    }
  });
});

test('所见即所得下切回非 wysiwyg 会话（源码模式文档）：不触发预渲染、视图按目标模式', async () => {
  // 会话模式未记录（首个 md 文档直接以源码模式打开）时，切标签目标 = settings.defaultView，
  // 不得误入 wysiwyg 预渲染管线。
  await withEditor({}, async (w, ed) => {
    await openFileTab(ed, 'C.md', MD_A, 'C:/tmp/wt/C.md');
    await delay(120);
    ed.setViewMode('edit');
    await delay(100);
    assert.strictEqual(ed.viewMode, 'edit', '前置：源码模式');
    // setViewMode 对带路径 md 会写会话记忆（_sessionMdViewMode）——清掉以模拟「无会话记忆」
    ed._sessionMdViewMode = null;

    await openFileTab(ed, 'D.md', MD_B, 'C:/tmp/wt/D.md');
    await delay(300);
    // 会话模式未记录 → 目标 = settings.defaultView（默认 'preview'），不得误入 wysiwyg 预渲染管线
    assert.strictEqual(ed.viewMode, 'preview', '会话模式未记录时切标签应按 defaultView（preview）落位，实际 ' + ed.viewMode);
    assert.ok(!ed._wysiwygPreRendering, '不应有在飞的 wysiwyg 预渲染');
  });
});
