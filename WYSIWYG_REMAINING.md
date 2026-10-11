# TizuMark 所见即所得（WYSIWYG）模式 — 剩余开发任务

> 用途：本文件记录「所见即所得」模式的**剩余未开发项**，供换设备后继续开发时对照。
> 状态时间：2026-10-11。已完成的根因修复见 `git log`。

## 1. 这是什么

TizuMark 是 Tauri v2 桌面 Markdown 编辑器，有三种视图：**阅读（preview）/ 源码（source+CM5）/ 所见即所得（wysiwyg）**。
所见即所得 = 在 CM5 编辑区里，把每个 Markdown **块**用渲染后的 HTML 盖住（markText + replacedWith），光标所在块恢复成可编辑的源码态。用户看到的是渲染效果，点哪一行就在哪一行编辑源码。

## 2. 关键文件（改这里）

| 文件 | 职责 |
|---|---|
| `src/modules/wysiwyg.js` | 核心遮罩模块：块划分、maskWysiwygBlock、点击锚定、滚动锚定、异步 pass 调度（flush） |
| `src/modules/render-post.js` | **渲染后处理共享管线（RenderPost）**：两模式唯一共享后处理入口，2026-10-11 起新增 |
| `src/modules/empty-hint.js` | 空行占位提示（"输入 / 可插入内容…"） |
| `src/unified-renderer.js` | `renderMarkdownBlocks` 逐块渲染（与阅读模式同源，remark 切块） |
| `src/controllers/preview-controller.js` | 阅读模式 render()：整篇单遍编排 RenderPost 各 stage（含代际检查/滚动恢复） |
| `src/modules/preview-post.js` | Process* 系列预览后处理函数（RenderPost 各 stage 的底层实现；processMermaid 内含串行化+id 唯一化） |
| `src/modules/code-block.js` | 代码高亮 + 行号 + 复制按钮 |
| `scripts/wysiwyg-browser-check.mjs` + `_wysiwyg_compare.html` | 无头浏览器对比测试（真 Chromium，17 场景 80+ 项；harness 带 TauriApi mock + mermaid） |
| `test/wysiwyg-blocks.test.cjs` / `test/view-mode-wysiwyg.test.cjs` / `test/wysiwyg-async-pass.test.cjs` | jsdom 回归 |

## 3. 已完成的里程碑

- 渲染与阅读模式一致：remark 切块、white-space:normal、空列表项消除
- 遮罩后处理已接 **KaTeX 公式 + 代码高亮 + 复选框解禁**（见 `_postProcessWysiwygNode`）
- 点击锚定根治：偏差 1637px → 0.5px（scroll:false + operation 后执行 + scrollIntoView）
- 虚拟模式滚动锚定：漂移 395px → 0.38px
- 表格单元格点击定位、任务复选框渲染态切换、IME 防吞字

### 2026-10-08 —「与阅读模式完全一致」专项（R1/R2/R3/R4 全部完成）

- **R1 图片**：`_wysiwygPostProcessAsync` 调 `ImageProcessor.processImages`（与阅读模式同一纯函数 + 同一 `_imageBase64Cache`），`getRenderGeneration` 用 `_wysiwygMaskGen` 防止遮罩重建后旧请求写脏 DOM。
- **R2 Mermaid**：`_wysiwygPostProcessAsync` 调 `PreviewPost.processMermaid`（同一 `_mermaidCache`，命中缓存近乎同步）；就绪后经 `_wysiwygRefreshAfterMaskChange` 刷新 CM 并做滚动补偿，SVG 撑高不冲走视口。
- **R3 后处理链**：`_postProcessWysiwygNode` 与阅读模式 `render()` 同序补跑 复选框解禁 → details 展开 → emoji → KaTeX → 缩写 → 标题锚点 id → 复制按钮 → 代码高亮（行号开关读 `#preview` 的 `code-line-numbers` 类）。`[TOC]` 由 `_wysiwygReplaceToc` 调 Rust `generate_toc`（内容键控缓存）。
- **R4 复制按钮**：遮罩 mousedown 对 `button.copy-btn` 放行（不 preventDefault），点击走原生复制。
- **行号**：`applyWysiwygEditorChrome` 进入所见即所得强制 `lineNumbers:false`，离开按设置恢复；`settings.js` 的 applySettings 也走该入口，设置变更不会把行号改回来。
- **排版一致**：`_wysiwygMaskTypography` 把 `#preview` 的**计算值**（font-size/line-height/font-family/`--font-code-preview`）逐项内联到遮罩，并同步 `code-line-numbers/code-wrap/code-no-scroll` 类——阅读模式的字号行高是内联样式（16px/1.7），遮罩若只靠 CSS 会继承 CM 的 14px。
- **CSS 一致**：遮罩去掉灰底（`color-mix` → `transparent`）；wysiwyg 模式下 CM 每行加 32px 左右留白，与阅读模式 `#preview` 的 32px padding 对齐；`maxWidth` 设置生效时对 `.CodeMirror-lines` 做同款居中。
- **交互一致**：`misc-ui.js` 抽出 `handlePreviewLinkClick(link)`（预览点击监听器与遮罩共用）；wysiwyg 下 `#锚点` 走 `_wysiwygScrollToAnchor`（块偏移 + data-source-line 还原绝对行号，虚拟模式回退按 headingToId 扫源码），目标行滚到视口中部 + 闪显；遮罩内图片/mermaid 点击分别走 `showImageLightbox`/`showLightbox(svg)`。
- 已知差异（保留）：脚注/缩写**定义行跨块**时逐块渲染拿不到别块定义（unified-renderer `renderMarkdownBlocks` 注释记录的边界）；缩写定义单独成块时整块被遮罩为不可见（与阅读模式一致），定义与使用同块时缩写正常还原。

### 2026-10-09 — 快速滚动闪源码 / 落点漂移（全量预渲染 + 全量视图驻留）

- **根因**：CM5 只对视口内行实测高度，视口外行按源文估计（`estimateHeight`）——WYSIWYG 遮罩行远高于源文，远跳首落点偏（实测 -425px）；且 lineWrapping 编辑器的 `cm.refresh()` 会调 `estimateLineHeights` 把所有实测高度重置回估计值。
- **设计（≤10000 行，全量模式）**：
  - 入口 = **后台全量预渲染**：`setViewMode('wysiwyg')` 被 theme.js 拦截，当前视图保持、模式按钮显示「渲染中」spinner（`_setWysiwygButtonRendering`，i18n key `viewModeWysiwygRendering`）；让出主线程的 setTimeout 跑 `precomputeWysiwygBlocksFull()`（`maxBlocks:Infinity` 全块渲染 html），完成且期间源文/标签/模式未变才切 viewMode + applyViewMode；预渲染结果在 applyViewMode **之后**写入（其内部 clearWysiwygMasks 会清掉未消费结果），由 50ms 遮罩计时器 `renderWysiwygMasks` 消费。
  - **全量视图驻留**：进入后直接写 `cm.options.viewportMargin = lineCount + 100`（**绕过 setOption**——viewportMargin 选项处理器自带 `cm.refresh()`，会多一次全量重渲染），整篇恒渲染、行高恒实测：任意位置远跳精确落位（≤0.5px），任何 `refresh()`（切模式/输入）在同一次全量视图重渲中重测回正——几何自愈。离开所见即所得用 `setOption('viewportMargin', 10)` 恢复默认。
  - **输入停顿** = `_refreshWysiwygFullIncremental`（250ms 防抖）：仅解析模式重切块边界（渲染器新增 `skipHtml` 选项），源文未变的块**复用旧 markText 标记**（CM 标记编辑后自动跟随文本，省去重跑昂贵后处理），变化/新增/分裂/合并块单 operation 重挂；块索引位移同步遮罩节点 `data-block-index`。
  - 批量 DOM（全量挂/撤遮罩、空行挂类、离开清理）一律单 `cm.operation`——万行文档进出不卡数秒。
  - 取消路径：切别的模式 / 切标签（`syncViewModeToTab`）/ 打开文件（clearWysiwygMasks）都调 `_cancelWysiwygPreRender`（代数递增 + 清定时器 + 按钮还原 + 作废已存的切换锚点）。
- **设计（>10000 行，虚拟模式）**：方向感知增强预取（`WYSIWYG_PREFETCH_MARGIN=200`，向下滚动下方 ×2 / 向上滚动上方 ×2，尾随侧保持 60），用户到达前遮罩已就绪。
- **验收实测**（无头 Chromium，8 场景 48 项全绿，2026-10-09 同日三个修复后）：3000 行全量重建 ~0.7–2.4s（机器负载相关）、任意位置首跳误差 ≤0.3px、`cm.refresh()` 后 0.41px 自愈；10400 行虚拟模式窗口遮罩 24–27 个；点击锚定 0.41px；滚动锚定漂移 0px；点击落点（场景 8）中部点击落中部带、底边点击落块末两行。
- **回归守卫**：`test/view-mode-wysiwyg.test.cjs` 新增第 14 节 9 用例（上限常量 / cm.options 直写 / setViewMode 拦截与取消 / 预渲染消费时序 / 增量刷新与源文本键 / 方向预取 / 单 operation 批量 / spinner + 三语言 i18n）；`test/view-mode.test.cjs` 三模式循环测试更新为异步预渲染契约（toggle 后预渲染在飞 → 完成后才切模式）。

**2026-10-09 真机反馈三个修复（同日）**：

1. **增量刷新重复源文本崩溃**：`_refreshWysiwygFullIncremental` 以块源文本做同一性匹配，两个块源文本相同（重复段落/列表行）且其一被删/改写时，同源队列提前取空 → `shift()` 得 `undefined` 当新索引 → `Cannot set properties of undefined (setting 'html')`（用户编辑重复行密集的 RELEASE_NOTES.md 即崩）。修复：取空前判队列空 + `!nb` 双守卫，取不到的旧遮罩降级为撤掉重挂。回归用例：`view-mode.test.cjs`「同一源文本的重复块被删时 srcQueue 取空降级不崩」。
2. **每次点击往下滚一段**：点击锚定 `_applyWysiwygClickAnchor` 旧实现 `scrollIntoView(pos, margin=click.y)`——`click.y` 是**窗口坐标**而 `scrollIntoView` 的 margin 相对**编辑器视口顶**，真机编辑器上方有工具栏+标签栏（约 100px+），基准错位使目标行恒落在点击点下方「一个工具栏高」处；且 margin 带内的行完全不补偿。harness 里编辑器贴窗口顶、基准巧合重合，所以历次 0.41px 校准都测不出。修复：改「事后测量 + 差值补偿」（与 `_restoreWysiwygAnchor` 光标锚点同机制）——点击位置先减 `wrapper.getBoundingClientRect().top` 换算为视口内坐标，行顶用 `charCoords(pos,'window').top - wrapTop` 测（⚠️ 不能用 'local'——CM5 的 'local' 是文档内容空间 `heightAtLine+padding`，不是视口相对坐标），`cm.scrollTo(info.left, info.top + delta)` 精确放回点击处（结构级变化守卫：|delta| > vh 放弃）。场景 3 现下移编辑器 140px 模拟真机工具栏（旧实现此条件下量出 ≈140px 偏差，修复后 0.91px），回归可测。
3. **点击成块内容光标落错行（「经常出现新增一行」）**：用户截图所见即所得下列表遮罩 + 下方空行出现「输入 / 可插入内容…」提示。排查结论（无头 Chromium 真实鼠标审计，`_wysiwyg_compare.html` `__clickLandingSetup` + 驱动场景 8）：
   - **根因（主）**：CM5 会把落在 `replacedWith` 标记区间**内部**的 `setSelection` 位置**钳制到标记首/末端**（实测：9 行列表块 [4,12]，setSelection(7) 光标到 12、setSelection(11) 也到 12、setSelection(6,ch0) 到 4）。原实现先 `setSelection(点击比例行)` 再靠 setSelection 操作内的 cursorActivity 撤遮罩——位置被钳制时标记还在，光标恒落到块首/块尾行；用户点不准反复点，点进块与块之间 12px 压缩空行，光标落空行 → 空行提示（纯 CSS 显示，不插入内容）显现，观感即「新增一行」。
   - **修复**：mousedown 两个分支（表格/普通比例映射）落光标前先 `setWysiwygActiveBlock(wysiwygBlockIndexAt(目标行))` 撤掉目标块标记——目标行先成为真实源码行再落光标，CM5 无从钳制。活动块索引按**目标行**查（增量刷新后闭包 idx 可能已位移）。实测：块中部点击 line 7/8（中部带内，修复前恒 12/4）、底边点击 line 11（块末两行内）。
   - **空行提示本身**：点空行光标落空行 + 显示提示是编辑器标准行为（提示纯显示、不插行），不修改；主修复后点击落准、误点空行概率大降。
   - **回归**：驱动新增**场景 8 点击落点**（真实 `page.mouse.click` 命中测试，每次点击前全新编辑器防污染）：块中部点击落中部带 [start+⌊n/3⌋, end-1-⌊n/3⌋]、点击块已撤遮罩成活动块、底边点击落块末两行。守护：`view-mode-wysiwyg.test.cjs`「点击遮罩块须先撤遮罩再落光标」。

### 2026-10-11 — 四缺陷根因修复 + RenderPost 共享后处理管线（用户真机反馈：目录/图片/长代码滚动/图表）

用户反馈所见即所得下 ① [TOC] 目录没加载 ② 有些图片没加载 ③ 长代码块不能滚动 ④ Mermaid 图表没加载，且要求「渲染逻辑和最终结果应与阅读模式完全一样、可复用」。

**根因（先红后绿，全部经无头 Chromium 实测确认）**：

1. **异步 pass 调用时机（①④② 共性）**：CM5 `markText({replacedWith})` 返回时 widget 节点**尚未接入 DOM**（`isConnected === false`）——`cursorActivity` 在 `setSelection` 的 operation **内部**同步触发（maskWysiwygBlock 的 markText 加入同一 op），挂遮罩当场调异步 pass 时节点没连上，`processImages`/`processMermaid`/`_wysiwygReplaceToc` 全部 early-return。`cm.refresh()` 也救不了：视口外行不物化。修复 = **延迟 flush**：`maskWysiwygBlock` 把节点登记进 `_wysiwygPendingAsync` + `_scheduleWysiwygAsyncFlush()`（setTimeout 0 去重），`flushWysiwygAsyncPasses()` 只对 `isConnected` 节点跑 pass、未落定的留待下次；`renderWysiwygMasks`（`cm.refresh()` 后）与 `updateWysiwygViewportMasks`（operation 后）各显式 flush 一次（全量模式 refresh 物化全文 → 首帧就绪；虚拟模式靠滚动物化 → 滚动落定即补跑）。
2. **代数粒度（② 图片）**：`getRenderGeneration` 旧用**全局** `_wysiwygMaskGen`——`setWysiwygActiveBlock` 是「先重挂旧活动块、后撤新活动块」，撤后全局代数 +1 把刚启动的图片读盘判成过期。修复 = **节点级代数** `_wysiwygNodeGen`（node→gen Map）：`_dropWysiwygMaskNode`（unmask + 两处 mark.clear）只对**该节点** +1 并移出 pending；`clearWysiwygMasks` 重置全部。
3. **codeScroll 条件写反 + 选择器错（③）**：阅读模式判据是「设置**开启**（`codeScroll !== false`，默认 true）才设 overflowY」，wysiwyg 手抄成 `=== false`（默认走 else，长代码被 `max-height:300px` 裁死）；且选择器写成 `.code-block-scroll`（真实类是 `.code-scroll`，code-block.js 生成）。
4. **Mermaid 并发 id 碰撞（④ 叠加）**：mermaid v11 内部 per-diagram id = `mermaid-<Date.now()>`（`next=()=>Date.now()`，不确定），批量挂遮罩同毫秒并发 `run()` → 后渲染的图拿到已被占用的 id 静默跳过。修复（`preview-post.js`，阅读模式同样受益）：容器 id 加模块级自增序列 `mermaidIdSeq` + `mermaidRunQueue` promise 链把 `mermaid.run` 串行化（并发 ≤1）。
5. **TOC 多段（① 叠加）**：`_wysiwygReplaceToc` 旧只取节点内**第一个** `<p>`，块内 [TOC] 段前有别的段落时永远匹配不上。修复：`querySelectorAll('p')` 过滤「内容恰为 [TOC]」逐个替换（与阅读模式整篇正则替换对齐）；每个 p 替换前查 `isConnected`；invoke 失败清 `_wysiwygToc` 可重试。

**RenderPost 共享管线（用户「完全一样可以复用」的结构性落实）**：新增 `src/modules/render-post.js`（`window.RenderPost`），后处理 stage 收敛为两模式**唯一共享入口**——同步：`normalizeDetails / enableCheckboxes / processEmoji / processMath / processAbbreviations / processHeadings / addCopyButtons / processCodeBlocks`；异步：`prepareImages / runMermaid / applyCodeScrollOverflow`（codeScroll 条件唯一来源）。阅读模式 `preview-controller.render()` 与所见即所得 `_postProcessWysiwygNode` / `_wysiwygPostProcessAsync` 都改为编排这些 stage（阅读=整篇单遍含代际检查，遮罩=单块+DOM 落定后 flush）；[TOC] 因依赖整篇内容（Rust `generate_toc`）仍是两模式各自的整篇级替换。契约：故障隔离 + 幂等 + 不持模式状态。

**验证**：浏览器 12 场景全绿（新增 S9 [TOC] 6 项 / S10 图片重挂回归 / S11 长代码滚动条双模式对照 + codeScroll=false / S12 mermaid 3 图渲染+重挂恢复；harness 加 TauriApi mock + mermaid 依赖 + 场景 5 阅读侧走 RenderPost 全链）；jsdom 新增 `test/wysiwyg-async-pass.test.cjs` 4 用例（TOC 非首段替换、TOC invoke 失败重试、flush 只跑已连接节点 + `_dropWysiwygMaskNode` 代数/pending 语义、mermaid 串行化 + id 唯一）；`view-mode-wysiwyg.test.cjs` / `code-block-scroll.test.cjs` 静态断言更新到 RenderPost 契约。

**CM5 widget 时序探针结论**（探针文件已删，结论入 §5）：`replacedWith` 节点在 `markText` 返回后（自动 op 提交）、显式 `cm.operation` 返回后都**可能未连接**；视口外行 `cm.refresh()` 后仍不连接（滚动物化才连）——**凡依赖节点 DOM 的子 pass 必须等落定**（本仓实现 = pending + flush）。

### 2026-10-12 — 六项真机反馈 + 卡死回归修复 + 跳转修复

**卡死回归（用户：「点击所见即所得，软件卡住没反应」）**：2026-10-11 RenderPost 改造时 `_wysiwygPostProcessAsync` 丢了存在性守卫，每个块的 3 个 no-op promise 完成都触发 `_wysiwygRefreshAfterMaskChange()`（内含 `cm.refresh()` 全量重测）→ 299 块 demo.md 886 次 refresh / 65 秒主线程占满。修复 = `querySelector('img')` / `code.language-mermaid` / [TOC] 段存在性判断后才启动 pass 链（20 次 / 1.8 秒）。坑记录见 §5.7（refresh 风暴）。

**六项反馈（截图 + 编号问题）**：

1. **阅读模式隐藏 ref 定义行、所见即所得却露出**：根因 = 阅读模式整篇渲染时 remark 把「纯 `[label]: url` 定义行」块解析成空节点（无 html），而逐块渲染（wysiwyg 路径）该块 html 为 `''` → maskWysiwygBlock 按「渲染失败」保留源码态。修复（`unified-renderer.js`）：`renderMarkdownBlocks` 对「渲染结果为空且块内容全是 ref 定义行」的块输出 `<div class="wysiwyg-block-hidden">` 占位（CSS `height:0; overflow:hidden` 塌缩），**仅隐藏定义行**；跨块 `[text][ref]` 引用还原不在本批做（见 R12）。渲染失败的块仍保持源码可见（占位只认「空 html + 纯定义行」双条件）。
2. **进所见即所得先看到全屏源码、几秒后才渲染**：`beginWysiwygPreRender` 期间调 `_beginPaneLoad()`（`#pane-loading` 覆盖层，引用计数）；预渲染完成/取消/失败各路径 `_endPaneLoad()`。
3. **所见即所得下切标签再切回只显示源码**：`theme.js syncViewModeToTab` 原来对 wysiwyg 目标要么 no-op、要么靠 50ms 计时器做同步全量 precompute（大文档数秒源码裸奔）。现改为路由到 `beginWysiwygPreRender()`（loading 覆盖 + 异步 precompute + 缓存块消费），空文档 / >10000 行走原 applyViewMode 回退；`renderWysiwygMasks` 顶部加 `_wysiwygPreRendering` 守卫（预渲染在飞时跳过，防止消费到旧块表）。
4. **大块内容要有编辑按钮（参考代码块复制按钮）**：`maskWysiwygBlock` 给**每个**遮罩节点挂 `button.block-edit-btn`（hover 显现，右上；代码块块内让位到复制按钮左侧 `right:76px`）。点击 = mousedown 拦截 → `mark.find()` 取块区间（**撤罩前先取**）→ `setWysiwygActiveBlock` 解罩 + 光标落块首行。`context-menu.js` 两处 `closest('.copy-btn, .block-edit-btn')` 放行。
5. **正在编辑的块要明显区分**：`cm-wysiwyg-active-block` 行背景（`var(--accent-muted)` + 圆角），`_applyWysiwygActiveHighlight` 统一挂/撤（`addLineClass` background）；挂点 = `setWysiwygActiveBlock` 两路 / `renderWysiwygMasks` 尾 / 增量刷新 250ms 尾 / `clearWysiwygMasks` 撤光。（⚠️ 2026-10-13 发现该批的 CSS 选择器写错层级——bgClass 实际落在 `div.CodeMirror-linebackground`，规则选 `pre` 从未生效；已修正选择器并加左侧主题色竖条，见 R13/§5.12。）
6. **配色方案**：`default` 改为**白底 + 蓝色主题色 `#2563EB`**（accent 家族 hover `#1e55d0` / pressed `#1946ac` / subtle 0.07 / muted 0.15，TOC 渐变同族）；旧暖灰风格优化后独立为 `classic`（经典/Classic/Clásico）。`settings.js` 选项表新增 classic；`data-color-scheme` 值透传（export.js 原样拷贝，自动兼容）。深色模式 classic 与 default 共用现有 dark 变量块。

**2026-10-12 二报告（用户 dev 实跑反馈）**：

- **切标签回文档报大量 `预渲染失败... reading 'start'`**：用户页面 Vite HMR **混载了两版 wysiwyg.js**（栈里两帧 `?t=` 时间戳不同 = 新旧模块共存），旧版 `_refreshWysiwygFullIncremental` 闭包 + 新版数据互串。当前代码经 jsdom 双文件标签往返切换探针验证**无此路径**（内容保存、预渲染、块表全对）。双保险：`precomputeWysiwygBlocksFull` 返回前 `filter` 掉缺 start/end 的畸形条目（防御 undefined 元素进入下游 `.start` 读取）。**处置：dev 页 Ctrl+F5 硬刷新清混载模块**。
- **所见即所得下点大纲/目录跳不到对应内容（用户问是不是问题——是）**：CM5 对 `replacedWith` 标记区间内的 `setSelection` 钳制到标记边缘、`heightAtLine` 量到整块遮罩。三个跳转入口统一「先解罩目标块再定位」：`layout.js _jumpToHeadingLine`（面包屑点击）、`wysiwyg.js _wysiwygScrollToAnchor`（TOC/#锚点）、`find.js jumpToMatch`（全局搜索跨文件跳转；遮罩未挂完时等块表就绪 ≤2s）——目标块恢复源码态（即活动块），落点精确。

**本批验证**：浏览器 harness 12 → **17 场景**（新增 S13 ref 定义行塌缩 / S14 编辑按钮全块+点击解罩 / S15 活动块高亮挂撤 / S16 预渲染 loading+切标签重算 / S17 跳转解罩含 clamp 复现），17 场景 80+ 项全绿；jsdom 新增 `test/wysiwyg-blocks.test.cjs` +3（refdef 占位 / 定义行贴段合并 / 块表 start/end 合法性）、`test/view-mode-wysiwyg.test.cjs` +9（刷新风暴守卫 / refdef 渲染器+CSS / loading 配对 / 切标签预渲染路由 / 编辑按钮 / 活动高亮 / 配色方案 / 三入口跳转 / precompute 防御 filter）、`test/wysiwyg-tab-switch.test.cjs` 新建 2 用例（wysiwyg 下切走→切回预渲染管线行为回归 + 无会话记忆时不误入 wysiwyg）。⚠️ 期间踩「bundle 陈旧」坑（unified-renderer.js 改动未重建 `src/lib/unified-bundle.js` 导致 harness 测到旧渲染器），见 §6 验证段警告。

### 2026-10-13 — 活动块背景两轮修正 + Phase 2 表格单元格就地编辑

- **活动块高亮「从未绘制」bug**：2026-10-11 #5 的高亮 CSS 选 `pre.CodeMirror-line.<cls>`，但 CM5
  `addLineClass('background')` 的类实际落在独立的 **`div.CodeMirror-linebackground`**（行包裹层内
  绝对定位背景层）——规则从未匹配，背景一直没显示（旧静态测试只查 Line 对象的 `bgClass` 属性，
  查不到 CSS 是否生效，一直绿灯）。修正选择器后，用户又反馈第一版「太丑」（accent-muted 15% 底 +
  3px 竖条太压迫），减重为 **accent-subtle 浅底 + 2px 竖条 + 圆角 4px**。坑见 §5.12。
- **Phase 2 = R5 表格单元格就地源码编辑**（设计调研见 R13，用户拍板「Phase 2 执行、Phase 3 暂缓」）：
  点渲染表格格子 → 该格 contenteditable 显示**原始源码文本**（无损回写），整表保持遮罩；
  Enter/失焦/Tab 提交（纯函数 `editTableRowCell` 重建整行：保留首尾竖线风格、格内裸 `|` 自动转义
  `\|`），立即重渲本块遮罩；Tab/Shift+Tab 行内环绕切格；Esc 取消。关键坑：① 提交后遮罩必重建、
  旧 DOM 离场 → 「提交后找格」一律按 `(rowIdx, colIdx)` 在新节点重定位；② 三处守卫
  （setWysiwygActiveBlock / unmaskWysiwygBlock 本块 / clearWysiwygMasks）先提交在编格；
  ③ 提交后光标移到块后首行，不得留在 replacedWith 区间（CM clamp 会把下次击键写进块边缘）；
  ④ `_wysiwygEndCellEdit` 首行即清状态（replaceRange → cursorActivity → 撤/挂遮罩的重入守卫靠它）。
- **验证**：jsdom 纯函数 7 用例 + 静态接线 + 浏览器 harness **17 → 18 场景**（新增 S18 单元格编辑
  端到端 5 项；场景 1 的表格点击断言同步更新为「进就地编辑」契约），全量回归 141/141 文件通过。

### 2026-10-13（二）— loading 持留修复 + 活动块背景第三轮（整块灰盒）

- **切换所见即所得「loading 完之后什么都不显示，等几秒才出来」**：预渲染管线在**预渲染完成**时就
  `_endPaneLoad()` 撤 loading 层，但此时 `applyViewMode` 的 50ms 计时器还没跑——之后
  `renderWysiwygMasks` 还要**同步**挂全部遮罩（挂块 + cm.refresh + 冲刷异步 pass，大文档数秒），
  这段空窗里主区露源码/空白。修复：loading 层改为**持留到遮罩挂完**——`beginWysiwygPreRender`
  打开时记 `_wysiwygPreRenderLoadOpen/_wysiwygPreRenderLoadGen`（按代配对），释放统一走
  `_wysiwygReleasePreRenderLoad()`（gen 不匹配不释放，防新一代预渲染的 loading 被旧路径吃掉），
  释放点恰好其一：① `renderWysiwygMasks` 的 `finally`（挂完才放，含所有提前返回路径）；
  ② 预渲染中止（期间切标签/模式）；③ `_cancelWysiwygPreRender`（必须在 gen 推进**前**调用）；
  ④ `theme.js applyViewMode` 离开 wysiwyg 时（快切模式会清掉 50ms 计时器，renderWysiwygMasks
  永不执行——不收尾则覆盖层残留）。实测（harness S19，1282 行/481 块）：挂载与释放同一 tick
  （518ms），loading 全程覆盖。
- **活动块背景第三轮**：逐行圆角 + 蓝底被用户否掉（「左边一个个的小圆角不好看」），按参考图
  （代码块灰盒）改为 **`--code-bg` 灰底 + 逐行无圆角 + 仅首/末行圆角**（first/last 行类），
  多行块 = 一整块圆角矩形编辑区。细节见 R13「背景设计」与 S15。

### 2026-10-13（三）— 格编辑 NotFoundError 修复 + 表格行/列操作（增行/增列/拖拽换位）

- **格编辑提交报 `NotFoundError: Failed to execute 'appendChild' … moved in a "blur" event
  handler`（codemirror.js:1928）**：单元格失焦/活动块切换触发的提交是 `replaceRange` +
  重挂遮罩（清标记→行 DOM 重建→新标记），而 **blur 常由 CM 自己的 mousedown 同步触发、
  cursorActivity→setWysiwygActiveBlock 也运行在 CM operation 内**——在这些上下文里同步
  重建行 DOM，CM 操作收尾时还要移动已被毁掉的节点 → 抛错。修复：格编辑提交在
  **blur 监听**与 **setWysiwygActiveBlock 守卫**里一律 `setTimeout(0)` 延迟到下一 tick
  （状态先被其他路径清掉则 no-op）；**必须保持同步**的只有一处——`unmaskWysiwygBlock`
  对「在编格所在表块」的守卫（撤罩即销毁编辑格 DOM，先提交才能保住文本）。坑见 §5.15。
- **表格行/列操作（用户要求：hover 出增行/增列，拖动行列换位，参考 Typora 截图）**：
  渲染表格被包进 `wysiwyg-table-wrap`（定位锚；div/button 不在 S1 结构标签集，同构判据
  不受影响）：① **hover 表格** → 右缘「＋」增列、下缘「＋」增行，点击 = 纯函数
  （`addTableColumn`/`addTableRow`）重建整块回写 → **自动进入新格编辑**（无缝续输）；
  ② **行左缘点阵把手**（首格左 16px 区）拖行、**表头格**按下移动超 4px 拖列（不动手 =
  普通格编辑）——拖拽期间**实时重排 DOM**（虚线描边半透明），释放按纯函数
  （`moveTableRow`/`moveTableColumn`，分隔行恒居第 2 行、对齐标记随列走）回写整块。
  结构变更行数可能变 → 不能走单元格单行提交：`_wysiwygCommitTableBlock` 整块 replaceRange
  后**立即重算块表**（全量增量 / 非全量视口重挂两路）+ 清 250ms 输入防抖。
- **验证**：jsdom 纯函数 8 用例（增行/增列/移动行列 + 风格保留 + 越界兜底）+ 静态接线
  （工具注入/路由/拖拽阈值/延迟提交契约）+ 浏览器 harness **19 → 20 场景**（新增 S20：
  工具注入 + 增行增列自动格编辑 + 行拖拽/列拖拽回写 + 块表一致性，端到端 8 项），全量回归通过。

### 2026-10-13（四）— 表格工具/格编辑三项真机 UX 修复（用户截图反馈：按钮点不到、点格全选、一输入就失焦）

- **A. 增行/增列「＋」点不到、鼠标一移就消失**：按钮定位在 wrap 盒子外
  （`left:100%`/`top:100%` + 6px 间隙），且**下缘按钮落在下方块内容区**——CM 相邻行同为
  `z-index:2`、段落后于表格行 → 段落整行 DOM 压在按钮上层，既截获点击、又让 CSS `:hover`
  在空隙处丢失。纯 CSS `:hover`/`:has(:hover)` 治不了（hover 丢失时选择器不成立）。修复三件套：
  ① **JS 托管 hover 状态类**（`wysiwyg-table-tools-hover`）：离开 wrap 延迟 200ms 才隐藏
  （给鼠标跨隙到按钮的时间），期间进入按钮则取消隐藏；② **按钮恒 `display:flex`、用
  `opacity:0/pointer-events:none` 隐藏**（旧 `display:none` 无法被 hover 命中），悬停类驱动
  `opacity:1/pointer-events:auto`；③ **悬停期把表格所在 CM 行 `z-index` 抬到 3**（压过相邻行 2，
  让按钮/悬停桥浮到下方块内容之上）——选择器须含 `.CodeMirror` 前缀，否则被 codemirror.css 的
  `.CodeMirror pre.CodeMirror-line{z-index:2}`（特异性更高）压住。坑见 §5.16/17。
- **B1. 点格选中整格文字（应光标进格）**：`_wysiwygStartCellEditOn` 原用
  `range.selectNodeContents(cell)` 显式全选。改为**光标落位**：点击路径传点击坐标
  （`{x:ev.clientX,y:ev.clientY}`）→ 原生 `document.caretRangeFromPoint` 把光标落到点击处
  （可定位到格内任意位置）；Tab/增行增列路径（无坐标）→ 折叠到格内文末。落点不在格内则兜底文末。
- **B2. 一输入文字就失焦、只能输一点**：格 keydown 处理器对 `Enter` 一律
  `preventDefault()+blur()`（当作「提交格子」），**未查 `e.isComposing`**——中文输入法组合期内
  按 Enter 是「确认拼音/选字」，被误当提交 → 焦点丢失、只能输入一个字。代码里 `st.composing`
  （compositionstart/end 维护）一直跟踪却从未在 keydown 里用过。修复：keydown 处理器开头加
  `if (e.isComposing || st.composing) return;`（`e.isComposing` 覆盖确认键，`st.composing`
  兜底个别浏览器确认键 isComposing 为假但组合未结束）。
- **A2. 按钮离表格很远（用户第二张截图：增行「＋」漂到空行提示条正中、增列「＋」漂到
  编辑器最右缘）**：`wysiwyg-table-wrap` 是块级 div，默认撑满遮罩 = **CM 行整宽**（真机
  937px），而表格网格是**内容宽**（250px、左对齐）——`.preview-content table` 的
  `display:block; width:100%` 只把「表格盒」撑满，内部网格仍按列内容收缩。按钮相对 wrap
  定位 → 增列 `left:100%` 飞到行右缘、增行 `left:50%` 漂到行水平中心（空行提示条里）。
  **无头 harness 没暴露**：测试量的是 `table` 元素盒（被撑满整行，与按钮位置自洽），
  量不到可见网格。修复：`.wysiwyg-table-wrap { width: fit-content; max-width: 100% }`
  （收窄到网格宽，超宽表 max-width 兜底、表格内部 overflow-x 滚动仍生效）；S23 改为用
  **首/末格 cell rect 量可见网格**并加回归断言（wrap≈网格宽、按钮紧贴网格边缘、离整行
  中心/右缘 >100px）。坑见 §5.18。
- **验证**：浏览器 harness **20 → 23 场景**。新增 **S21（格编辑真实 I/O 诊断）**：真实
  `page.mouse.click` + `page.keyboard.type`（合成 dispatchEvent 不走真实输入管线，复现不了
  「一输入就失焦」），断言真实点击后焦点在格内、选区折叠（不再全选）、输入逐字追加不丢焦点；
  **S22（IME 组合期不中断）**：合成 compositionstart → Enter 必须被忽略（不提交/不 blur/源码
  不变），compositionend 后 Enter 恢复提交语义；**S23（增行/增列真实鼠标可达）**：真实
  `page.mouse.move` 沿「表格边缘→按钮」分步滑动、每步断言按钮保持 `opacity:1`（跨隙不消失）+
  悬停期行 z-index 抬升，真实点击断言增行/增列。S20 的「默认隐藏」判据同步改为
  `opacity:0 && pointer-events:none`。全量回归通过。

### 2026-10-13（五）— 格编辑「光标丢失」根因（Enter 提交后焦点掉 body）+ 拖拽把手移到表格外（用户参考图）

- **B2 残留：格内输入完光标丢失**。前一轮的 isComposing 修复只解决了「组合期 Enter 误提交」，
  真机残留的另一半是**提交路径本身不补焦点**：Enter 提交 = `cell.blur()`，而
  `_wysiwygEndCellEdit` 提交后只做了 `cm.setSelection(块后行)`、**从未 `cm.focus()`** →
  焦点从格上 blur 后掉到 `document.body`（编辑器完全失焦，用户视角「输入完光标没了」）。
  无头 S21 之前没断言提交后焦点，故一直绿灯。修复：`_wysiwygRestoreEditorFocus(endLine)`——
  **下一 tick 判定**恢复：仅当 `document.activeElement === body` 且无在拖状态才
  `cm.setSelection(块后行) + cm.focus()`；点另一格/点源码行的路径下一 tick 焦点已被新格或
  CM 输入域接走 → 自动跳过，不干扰用户点击。提交与 Esc 取消两路都接。S21 新增断言
  （Enter 后 `activeElement` 非 body、在 `.CodeMirror` 内、内容已回写），**Edge
  （WebView2 同引擎）实测确认修复**（修复前 `activeTag:BODY`，修复后 `TEXTAREA`）。
- **拖拽把手移到表格外（用户参考图：行把手=表格外左缘点阵；列把手=表上方蓝色胶囊；
  hover 某行/列 → 出现该行把手/该列整列浅蓝高亮+右缘蓝线+胶囊）**。把手从 td/th 伪元素
  改为 **wrap 上的真实元素**（`.wysiwyg-table-row-handle` / `.wysiwyg-table-col-pill`，
  JS 随悬停行/列移动定位）——伪元素方案有两个坑（均 2026-10-13 实测）：
  ① **裁剪**：`.preview-content table { display:block; overflow-x:auto }` 且表格盒只有网格宽
  （wrap fit-content）——伸到表盒外的伪元素（行把手 `left:-16px` / 胶囊 `top:-20px`）被
  table 滚动容器裁剪，`getComputedStyle` 显示已渲染但**看不见也命中不到**
  （`elementFromPoint` 落 PRE）；② **hover 循环依赖**：行把手盒在 tr 盒之外、而又是
  `tr:hover` 的产物——指针从格子移向把手 → `:hover` 失效 → 把手消失 → 拖拽永远启动不了。
  JS 托管后（mousemove 命中格 → 该行挂 `wysiwyg-row-hover` 类 + 把手移到该行中线；
  命中列 → 整列挂 `wysiwyg-col-hover` + 胶囊移到该列表头中心；指针停在把手/胶囊上 →
  维持；离开 wrap → 清）两坑皆免。行把手不出现在表头行（表头不可拖拽）。
  拖拽入口 `_wysiwygTableDragStart` 加两分支（把手/胶囊按下 → 按元素几何反查行/列下标 →
  `_wysiwygBeginTableDrag` + preventDefault 抑制兼容 mousedown）；原有「首格左 16px 区 /
  表头格 + 4px 阈值」路径保留（S20 合成事件与用户习惯兼容）。胶囊 `height:20px` 底边恰好
  贴表顶（无「格→胶囊」移动断口）；行把手右缘贴格左缘同理。坑见 §5.19/20。
- **验证**：浏览器 harness **23 → 24 场景**。S21 补 Enter 提交焦点回归 4 项；新增
  **S24（表格外拖拽把手）**：真实鼠标 hover 行 → 行把手元素 `display:block`、几何在表格外
  （`left:-16px`、右缘贴格左缘、`elementFromPoint` = 把手元素）+ 行高亮；**真实按住把手
  拖动**（`mouse.down/move/up`）→ 源码行序变化（a2 移到底部）；hover 列 → 整列 4 格挂类 +
  胶囊 `display:flex`、蓝底 `#2563EB`、`top:-20px` 底边贴表顶、`elementFromPoint` = 胶囊；
  **真实按胶囊拖动** → 源码列序变化（B 列移到 C 后）。Edge（WebView2 引擎）同步验证
  Enter 焦点回归 + 行拖拽。全量回归通过（jsdom 141/141、wysiwyg 24 场景、slash 6/6）。

### 2026-10-13（六）— 七条真机反馈：顶部裁剪 / 边缘邻近触发 / 悬停-拖动两档视觉 / 光标丢失根因（参考图对齐）

- **第 1 条：表格在文档最顶部时拉手被裁剪**。表格为文档首行 → 表上方 22px 列轨被滚动
  容器顶缘裁掉。修复：`.editor-container.wysiwyg-mode .CodeMirror-lines { padding-top: 24px; }`
  （wysiwyg 模式内容顶部留白 24px，仅编辑器作用域，阅读模式不受影响）。
- **第 2/3 条：边缘邻近触发（架构重做）**。上一版 = 单元格悬停（移到任意格上同时亮出
  行把手 + 列胶囊）——与参考图不符（用户要「移到某行左边一点 → 出该行拉手」「移到某列
  上边一点 → 出该列拉手」）。重做为**轨道 + 握点**两层：
  - **轨道**（`.wysiwyg-table-row-handle` 行轨 / `.wysiwyg-table-col-pill` 列轨，常驻透明
    命中区）：行轨 = 表左缘外 20px × 表全高；列轨 = 表上方 22px × 表全宽（底边贴表顶）。
    轨道**常驻**是关键：gutter 在 wrap 盒外，事件按 DOM 树冒泡——鼠标在 gutter 时目标
    必须是 wrap 的 DOM 后代，wrap 才收得到 mousemove/pointerdown（轨道随悬停显示则
    gutter 里没有可命中元素，触发永远不成立）。
  - **握点**（`.wysiwyg-table-row-grip` / `.wysiwyg-table-col-grip`，可见小把手，
    `opacity 0/1`）：JS 定位到悬停行中线（top = 行中心 - 8）/ 悬停列中心。
  - mousemove 边缘判定：顶 gutter（在列轨内）→ 该列握点；左 gutter（在行轨内）→ 该行
    握点；停在单元格上 → 都隐藏（两轨几何不相交，任一时刻至多亮一个）。
  - 拖拽入口改**坐标判定**（轨道是全高/全宽命中区，按元素盒反查行/列会恒命中首行/中列）：
    行轨按按下点 y 反查行（跳过表头），列轨按 x 反查列；「首格左 16px 区 / 表头格 +
    4px 阈值」旧路径保留（S20 合成事件兼容）。
  - **mousedown 顶部总守卫**：轨道常驻后 gutter 按下的 mousedown 目标是轨道 span（非
    单元格），单元格分支的拖拽守卫罩不住它——落到「点击映射源码行」分支会在拖拽中途
    撤罩表格块 + 挪光标。遮罩 mousedown 处理器开头：`if (self._wysiwygTableDrag) { preventDefault; return; }`。
- **第 6 条：只有拖动才蓝色高亮（悬停-拖动两档视觉）**。悬停态 = 灰点阵握点（无底色、
  无行/列高亮）；拖动超 4px 阈值 → 轨道挂 `.wysiwyg-dragging` → 握点变蓝底胶囊
  （`.track.wysiwyg-dragging .grip { background: var(--accent-color) }`）+ 被拖行浅蓝底 /
  被拖列浅蓝底 + 右缘蓝线。悬停高亮有两个来源都要堵：① 上一版自己加的 hover 规则
  （已删，`wysiwyg-row-hover`/`wysiwyg-col-hover` 类保留作纯状态标记）；② **阅读模式的
  `.preview-content tbody tr:hover` 漏进遮罩**（遮罩带 preview-content 类）——豁免规则
  `.editor-container.wysiwyg-mode .wysiwyg-block-mask tbody tr:hover { background-color: transparent }`
  （特异性 (0,4,2) 压过基础规则 (0,2,2)）。拖动态高亮选择器加 `table` 前缀抬特异性，
  压过斑马纹（`tr:nth-child(even)` 底色）与 th 默认底色，否则拖斑马行会显斑马色。
- **第 7 条根因：WebView2/Chromium IME「残影 Enter」**。中文输入法下 `compositionend`
  可能先于选字确认 Enter 的 keydown 到达（到达时 `isComposing=false` 且
  `st.composing=false`）→ 旧守卫放行 → 确认 Enter 被当提交 → 回写 + 重渲 + 焦点跳出格
  = 用户「输入完马上失去光标，像被回写」。修复：compositionend 记
  `st.lastCompositionEnd = Date.now()`；keydown 里 Enter 距该时刻 <250ms → 只
  `preventDefault()`（挡原生换行）不提交；真实提交 Enter（>250ms 后）不受影响。
  双保险：提交路径 `setSelection` 后同步 `cm.focus()` 一次（该代码恒在独立 tick 运行），
  加上一轮 `_wysiwygRestoreEditorFocus` 延迟恢复。
- **第 4/5 条（右缘/下缘 ＋ 增列/增行按钮）确认无需改动**（S23 10/10 复验通过）。
- **验证**：S24 重做为 18 项断言（停在单元格上 → 两握点都隐藏；行 gutter → 灰行握点
  （opacity 1、无底色、右缘贴格左缘、定位行中线）+ 行不高亮 + 列握点不出现；列 gutter
  对称；**拖动中读**（被拖行浅蓝底 / 握点蓝底；被拖列浅蓝 + inset 右线 / 握点蓝底）；
  真实拖行/拖列成功且源码变化）。Edge（WebView2 引擎）抽查 9/9（Enter 焦点 + gutter
  真实拖行）。全量回归：wysiwyg 24 场景全绿、jsdom 141/141、slash 6/6。坑见 §5.21/22。

### 2026-10-13（七）— 五条真机反馈：拖动胶囊跟随 / 表头行可拖 / 握点美化 / 边缘条带增行增列

- **#1 拖动中蓝胶囊跟随指针（行/列同款）**。旧实现由 wrap 的 mousemove 把握点重定位到
  「指针下那行/列的中心」——离散跳格，且指针斜移进表格区时 mousemove 兜底分支把握点
  **隐藏** → 用户看到「变蓝的块不跟小手走 / 消失」。修复：`_wysiwygTableDragMove` 里用
  **pointermove 连续定位**握点（行拖跟 y、列拖跟 x，clamp 到轨道范围），wrap 的
  mousemove 开头 `if (this._wysiwygTableDrag && moved) return;` 让位——视觉写入只留
  拖拽状态机一路（两路并写会打架）。行/列握点 CSS 本就同规则，加高后两档视觉完全一致。
- **#2 表头行也可拖**。`setRowHover` 去掉 `parentElement.tagName !== 'THEAD'` 排除；
  mousemove 左 gutter 反查与拖拽入口行轨分支的 `for` 都改从 `i=0` 起。语义 =
  moveTableRow 既有纯函数（行序列下标 0 = 表头，拖走后落到首位的数据行升为新表头，
  分隔行恒在源码第 2 行，结构不变）。**两个 thead DOM 坑**（本轮新增）：① tr 离开
  thead 被 `before/after` 移到 tbody 行位置时，浏览器自动把它收进 tbody（tr 只能属于
  thead/tbody/tfoot）→ thead 空壳；恢复（`_wysiwygTableRestoreDom`）时表头行（idx 0）
  不在 thead 内必须显式 `thead.appendChild(dragTr)` 归位（insertBefore 回不去 thead）。
  ② 原位无效释放（to===from）不能直接 return——拖拽中 thead 可能已空，也要走恢复。
- **#3 握点美化（加高）**：握点高 16px → **26px**（列握点 26px 居中于 22px 列轨，
  `top:-2px`），点阵 10px → **12px**（⋮⋮ 2×3 点阵，对齐参考图），圆角 4 → 5px；
  JS 行握点定位偏移同步 `-8 → -13`（行中心 - 13）。
- **#4 增行/增列改「边缘条带」**（参考有道云笔记截图）：右缘一条**通高竖条**
  （16px 宽 × 表全高，离表 6px）= 增列；下缘一条**通宽横条**（22px 高 × 表全宽，
  离表 6px）= 增行；浅灰底（`--bg-secondary`）+ 细边框（`--border-color`）+ 居中「＋」
  （`--text-secondary`）。`.wysiwyg-table-add-col { left:100%; top:0; width:16px;
  height:100%; margin-left:6px }` / `.wysiwyg-table-add-row { top:100%; left:0;
  width:100%; height:22px; margin-top:6px }`。旧小按钮的主题色 `:hover` 反馈移除
  （参考图为中性灰条带）。
- **#5 条带只在鼠标移到表格右边/下边一点时显示**：条带自身即悬停触发区——**透明态也恒
  `pointer-events:auto`**（opacity 0 只是视觉隐藏），显隐由 **per-strip 悬停类** JS 托管
  （`wysiwyg-table-add-col-hover` / `wysiwyg-table-add-row-hover`，`armStripHover`：
  mouseenter 立显 / mouseleave 200ms 宽限后隐，宽限同悬停桥、覆盖 6px 间隙穿越）。
  鼠标在表格本体上 / 间隙里都不显示。旧 `wysiwyg-table-tools-hover` 保留作**悬停桥**
  （行 z-index 抬 3 + 伪元素桥接命中区，保证下缘条带不被下一行 z-index:2 压住而
  永远命中不到）。代价（与参考应用一致）：下缘 22px 命中带内点击 = 增行，条带悬停
  显形可作视觉提示。
- **验证**：S23 重写为 12 项（悬停表格本体/间隙中部条带隐藏、移到条带上显示 +
  per-strip 类 + 行 z=3、真实点击增行/增列成功）；S24 扩到 23 项，新增：
  「拖动中蓝胶囊跟随小手（握点中心 ≈ 指针 y，**测点选第 2 行中线 +9px** 非行中心——
  旧吸附实现会差 9px 失败**）**」「表头行左缘出灰握点（定位表头中线）」「真实拖表头
  成功（a3 行升新表头、A1 行居末）」。S20 隐藏态判据改 `opacity:0 + pointer-events:auto`
  （条带恒可命中）。Edge（WebView2 引擎）复验 9/9。全量回归：wysiwyg 24 场景全绿、
  jsdom 141/141、slash 6/6。坑见 §5.23/24。

### 2026-10-13（八）— 三条真机反馈：条带宽度统一 / 表格四周留白 / 蓝胶囊尺寸

- **#1 增列/增行条带宽度一致、改小一点、长度不变**：增行横条 22px → **16px**（与增列
  竖条 16px 统一）；长度不变（横条通宽、竖条与表格同高）。
- **#2 表格上下左右增加留白，增行条带不遮挡下一行内容**：`.wysiwyg-table-wrap` 加
  `padding-top: 22px; padding-bottom: 32px`（padding 计入 wrap 盒 = 该行 CM 行高，下一行
  整体下移；**必须用 padding 而非 margin**——margin 会折叠出盒、推不动下一行且条带仍悬
  在盒外）。上下留白 = 条带/轨道的家：
  - 增列竖条 `top:22px; bottom:32px`（与表格同高，不再通 wrap 全高）；
  - 增行横条 `bottom:6px; height:16px`（落 wrap 下留白内：表下 10px 间隙 + 16px 条带 +
    6px 底隙，条带底缘 ≤ 下一行顶缘 - 6px）；
  - 列轨道 `top:-22px → top:0`（收进上留白区，不再伸到上一行上）；
  - 行轨道 `top:22px; bottom:32px`（只覆盖表格行区，不再通 wrap 全高）。
  左右留白 = CM 行自身 32px padding（左缘行轨 20px / 右缘竖条 22px 都在空白带内）。
  **下缘悬停桥（::after）删除**：横条已收进盒内，从表格滑向横条全程在 wrap 命中区；
  若保留（`top:100%` 伸入下一行），悬停表格时会把下一行首行抢成表格命中区（点击落不进
  下方段落）。右缘桥（::before，26px 跨 6px 间隙）保留。
  **握点定位基准改轨道 rect**：握点 offsetParent = 轨道（非 wrap）——wrap 加留白后
  `setRowHover`/`setColHover` 从 `wr.top/wr.left` 改 `kr.top/kr.left`（否则整体偏移
  上留白 22px）。
- **#3 拖动蓝胶囊宽度窄一点、高度 = 行高**：CSS 拖动态胶囊 `width: 16px; padding: 0`
  （窄于悬停态 auto 宽 ~20px）；JS 进拖动态时按行高设 inline height（行拖 = 被拖行、
  列拖 = 首行实测高度），结束态清除回落悬停态 26px。跟随 clamp 自动用新高度（读
  `getBoundingClientRect().height`）。
- **验证**：S23 扩到 16 项（新增：条带宽度一致均 16px、wrap 高 = 表高 + 54px、
  横条底缘 ≤ 下一行顶缘 - 4px、竖条与表格同高）；S24 扩到 26 项（新增：行/列拖蓝胶囊
  定宽 16px + 高度 = 行高）。Edge（WebView2 引擎）复验 9/9。全量回归：wysiwyg 24 场景
  全绿、jsdom 141/141、slash 6/6。坑见 §5.25。

### 2026-10-13（九）— 真机反馈：拖动要出蓝色落点指示线（对齐参考图）

- **#1 行拖没有蓝色指示线**：参考图语义 = 淡蓝背景 = 被拖行（留在原位）、蓝色横线
  = 要拖动到的位置（行间/表底缘）。**实现大改：拖拽中不再实时重排 DOM**（原来每帧把
  被拖行搬到目标位）——被拖行/列原地淡蓝高亮，蓝线随指针移动标出落点，释放时按
  `st.target`（move 中按指针 vs 其余行/列中线算出的插入下标）**一次换位**提交
  （`moveTableRow/moveTableColumn(src, st.idx, st.target)`）。
- **#2 列拖按钮样式不对**：同解——被拖列原地淡蓝高亮 + 蓝色**竖线**标落点（列间/
  表右缘）；**移除被拖列原「右缘蓝线」（inset box-shadow）**——参考图只有一条落点
  蓝线，双蓝线会混淆。
- **落点指示线**（`.wysiwyg-table-drop-line`，wrap 上真实元素，`pointer-events:none`、
  默认 `opacity:0`、`z-index:6` 压住单元格）：行拖横线 `left:0; width:100%; height:3px`
  （通表宽），列拖竖线 `top:22px; bottom:32px; width:3px`（通表高 = 留白内表体区）。
  JS 定位：行 = `others[target].top`（target = 末位时 = 表格底缘）− wrap 顶缘 − 1.5；
  列 = `others[target].left`（末位 = 表格右缘）− wrap 左缘 − 1.5。结束态
  `_wysiwygEndTableDragState` 隐藏并清形态类。
- **连带简化**：拖拽期不动 DOM → 表头行拖拽的「thead 自动收养」坑不再触发（DOM 恒
  完整）；`_wysiwygTableRestoreDom` 保留作 no-op 兜底。释放读 DOM 序的旧逻辑删除
  （拖拽中 DOM 恒为原序，读了必错）。
- **#3 列拖胶囊样式不对（用户对照参考图打回）**：参考图的列拖胶囊 = **宽横胶囊**
  （宽 ≈ 被拖列宽、高 26px、单排横白点、全圆角），不是行拖那款 16px 细竖条（之前
  反馈 #3 的「定宽 16px + 行高」只适用于行拖，误套到了列拖）。改法：CSS 拖动态拆成
  两条规则（行拖保留 16px 细条；列拖去定宽、`border-radius:13px` 全圆角、
  `letter-spacing:2px`）；JS 进列拖动态时按**被拖列表头格实测宽**设 inline width
  （最小 36px 兜底）、height 固定 26px、点阵文本换单排横点 `⋯×n`（n 按列宽 1–6）；
  跟随 clamp 改按胶囊半宽（宽胶囊不探出表格左右缘）；结束态清 inline 尺寸 + 文本
  回落 `⋮⋮` 竖点阵。
- **验证**：S24 扩到 34 项（新增 8 项：行落点线 = 横线通表宽/在表底缘/中途折返移到第
  3 行顶缘/拖行中 DOM 序不变/释放后线隐藏、列落点线 = 竖线通表高/在表右缘、被拖列
  仅浅蓝底无 inset 阴影；列拖胶囊 = 宽横胶囊宽 ≈ 被拖列宽 + 高 26px）。Edge
  （WebView2 引擎）复验 9/9（含真实拖行）。全量回归：wysiwyg 24 场景全绿、jsdom 全量、
  slash 6/6。坑见 §5.26/27。

### 2026-10-13（十）— 真机反馈四条：行/列拖按钮样式一致 / 表头可编辑 / 条带紧贴 / 顶部空白收窄

- **#1 拖动行和拖动列的按钮样式要一致**（对照参考图）：两种拖拽胶囊统一为**同一
  风格** = 厚 26px + 全圆角（`border-radius:13px`）+ 单排白点沿拖动轴——行拖 =
  竖胶囊（26px 宽 × 被拖行行高、单排竖点 `⋮`，JS 进拖动态换 textContent）；列拖 =
  横胶囊（宽 = 被拖列宽 × 26px、单排横点 `⋯×n`，九已做）。行轨道加宽 20px → 26px
  （`left:-26px`），26px 行胶囊不再探进表格左缘。
- **#2 表头也要可以编辑**：表头格是列拖把手（pointerdown 即起列拖态），旧实现
  mousedown 一律被拖拽守卫吞掉 → 表头格点不进编辑。改法 = **两层守卫都加例外**：
  ① 遮罩 mousedown **顶部总守卫**（`if (self._wysiwygTableDrag) { … return; }`）对
  「本表头格自身启动的列拖态」（`cellEl === st.trs[0].children[st.idx]`）放行；
  ② 单元格分支守卫同款放行。普通点击 → 进格编辑（`_wysiwygStartCellEdit` 本就通用：
  rowIdx 0 = 表头行 = 块首行）；真拖动超阈值 → `_wysiwygTableDragMove` 阈值块原有
  `_wysiwygEndCellEdit(false)` 先取消编辑再进拖拽。
- **#3 新增列、新增行按钮紧贴表格边框**：增列竖条 `margin-left:6px → 0`（左缘 = 表
  右缘）；增行横条 `bottom:6px → 16px`（顶缘 = 表底缘，下留白 32 - 条带 16）；右缘
  悬停桥 ::before 宽 26px → 16px（无间隙可桥，宽度 = 竖条）。
- **#4 表格顶部大面积空白**：wrap `padding-top:22px → 12px`（下留白 32px 不变）；
  连带：列轨道 `height:22px → 12px`、行轨道 `top:22px → 12px`、落点竖线
  `top:22px → 12px`。列握点 26px 高 → **中心 ≈ 表顶缘**（`top:-2px` 不变：下半贴
  表头行顶缘、上半在留白内；距 wrap 顶 2px，表格在文档最顶时最多裁 2px，与改造前
  一致——编辑器内容区自带 24px padding-top 兜底）。
- **验证**：S23 扩到 19 项（新增 3 项：横条顶缘 = 表底缘 ±1.5 / 竖条左缘 = 表右缘
  ±1.5 / 表底缘与表右缘紧贴处条带即显；wrap 高断言 54px → 44px；条带中心采样点
  右缘+14 → +8）；S24 扩到 37 项（新增：行拖胶囊 26px 宽竖胶囊、行/列胶囊厚度一致
  26px、列握点骑跨表顶缘（中心 ≈ 表顶缘）、**表头格普通点击进格编辑 + Esc 恢复**
  真实鼠标 2 项）。Edge（WebView2 引擎）复验 9/9。全量回归：wysiwyg 24 场景全绿、
  jsdom 全量、slash 6/6。坑见 §5.26/27/28。

## 4. 剩余任务清单（按优先级）

### P0 — 核心渲染缺口

（R1–R4 已于 2026-10-08 完成，见 §3。）

### P1 — 交互完善

**R5. 表格就地编辑：单元格源码编辑 + 行/列操作 ✅（2026-10-13 完成，Phase 2 + 行/列扩展）**
- 实现（格编辑）：点渲染表格的格子 → 该格 `contenteditable` 显示**原始源码文本**（无损：
  `**`/`\|` 可见可改），整张表保持遮罩、表格块**不**成为活动块。Enter/失焦/Tab = 提交（纯函数
  `editTableRowCell` 重建整行回写源码行，保留首尾竖线风格、格内裸 `|` 自动转义 `\|`），立即重渲
  本块遮罩（勾选框同模式，不等 250ms 防抖）；Tab/Shift+Tab 行内环绕切格；Esc 取消恢复。
- 实现（行/列，同日用户要求扩展）：hover 表 → 右缘「＋」增列 / 下缘「＋」增行（点击后自动进新格
  编辑）；行左缘把手拖行、表头格拖列（实时重排 DOM，释放回写）；纯函数 `addTableRow/addTableColumn/
  moveTableRow/moveTableColumn` + `_wysiwygCommitTableBlock` 整块回写（行数可能变 → 回写后立即
  重算块表 + 清输入防抖）。
- 关键设计：① 单元格↔源码行映射 = `tr` 序号（tr0=表头=块首行，其后越过分隔行顺延）+ 列序，
  与 mask 节点 `data-block-index` 组合，不依赖渲染 HTML 的额外属性；② 提交后遮罩必重建 →
  旧 DOM 节点离场，所有「提交后找格」的路径（Tab/点另一格/增行增列后自动编辑）按
  `(rowIdx, colIdx[, blockIdx])` 在新节点重定位；③ 提交守卫按**调用上下文**分同步/延迟：
  `unmaskWysiwygBlock` 本块守卫 + `clearWysiwygMasks` 必须同步（撤罩销毁编辑格 DOM），
  `setWysiwygActiveBlock`/blur 的提交必须延迟下一 tick（运行在 CM operation 内，见 §5.15）；
  ④ 提交后光标移到块后首行，绝不留在 `replacedWith` 区间内。
- 验证：jsdom 纯函数 15 用例（切分/转义/越界/无竖线风格 + 增行/增列/移动行列 8 用例）+ 静态
  接线（含延迟提交契约）+ 浏览器 S18 端到端 5 项 + **S20 行/列操作 8 项**。
- 未做（后续可选）：删除行/列（增行/增列已有；删除走「编辑」按钮整块源码）；表格列宽拖动；
  渲染态真内联（编辑渲染 DOM 而非源码文本）= Phase 3（暂缓）。

**R6. 格式/插入工具栏按钮在 wysiwyg 下的源码式对接**
- 现状：工具栏加粗/斜体/标题/列表/插入链接等按钮，在源码态（活动块）应天然可用（CM 文本即源码）；但光标落在**遮罩态块**时文本不可直接编辑，按钮需先定位目标块再对源码操作。
- 目标：按钮在 wysiwyg 下行为正确——要么先让光标进入对应块（撤遮罩），要么直接对块切片文本做 markdown 包裹。
- 文件：对应工具栏按钮处理（见 `src/modules/toolbar*.js` / `src/index.html` 的按钮 id）。
- 验证：目前多数按钮在源码模式已实现，重点测 wysiwyg 下光标在遮罩块时的表现（可能报错或无效）。

**R7. 空行提示 i18n 翻译补全**
- 现状：`emptyLineHint` 文案 key 已用，需确认各语言（en/zh）翻译齐全且切语言时刷新 CSS 变量。
- 文件：`src/modules/i18n.js` 的 `emptyLineHint` key；`empty-hint.js:42` 读 `this.t(HINT_KEY)`。

**R13. 所见即所得编辑模型设计调研（2026-10-13，用户要求参考 Typora / 有道云笔记）**

> 用户原话要点：① 哪些内容编辑时应显示源码修改、哪些可直接在渲染后的内容上修改；
> ② 显示源码修改时，**正在修改的这一整块**必须有明显背景，表示正在编辑哪部分。
> ⚠️ 网络调研不可用，以下基于两款产品的既知行为 + TizuMark 当前实现的精确核对。

**参考产品行为**

- **Typora**：整篇渲染、无源码/预览分栏。文本类内容（段落、标题、加粗/斜体/行内代码、
  链接文字、引用文字、列表项、表格单元格）全部**在渲染结果上直接点击编辑**——语法符号
  隐藏但保留（`Ctrl+Shift+M` 可整篇切换源码显示）。**代码块**渲染时带语法高亮，点击块内
  该块**单独**转为源码编辑态（原始文本 + 明显的边框/底色盒，文档其余部分保持渲染），
  点块外/Esc 恢复渲染态。**公式**同理：点击渲染好的 KaTeX 进入 LaTeX 源码编辑（同型背景盒）。
  脚注定义在文末就地编辑。图片是「选中 + 上下文菜单」（缩放/复制），**不**内联编辑 markdown
  语法。原生 HTML 块只能整篇源码视图里改。
- **有道云笔记（markdown 模式）**：同为「先渲染、点击块进入编辑」。文本/标题/列表/表格/引用/
  任务项在渲染内容上直接改；**代码块/公式/Mermaid 在独立编辑容器内显示源码，容器带明显
  背景色 + 边框**标示正在编辑；任务复选框点击切换；链接文字内联改。
- **两产品一致点（= 用户要求的设计基线）**：文本类内联编辑；**结构化/语法类（代码、公式、
  图表、图片语法、HTML）显示源码编辑**；源码编辑态的块有**与渲染内容明显不同的背景/边框**。

**TizuMark 现状（2026-10-13 核对）**

当前是**块级整体源码编辑**：光标进入某块 → 整块撤遮罩变源码（`setWysiwygActiveBlock`），
移出 → 整块重新渲染。活动块（= 正在编辑的源码块）已有 `cm-wysiwyg-active-block` 行背景
（`--accent-muted` + 圆角，2026-10-12 批 ⑤，harness S15 验证挂/撤）。
与参考产品的差距 = 文本类块编辑时用户看到的是 `**加粗**`、`# 标题` 这类源码，而不是渲染结果。

**块类型 × 编辑方式矩阵（建议）**

| 块类型 | 建议编辑方式 | 理由 | 现状 |
| --- | --- | --- | --- |
| 段落（含加粗/斜体/行内代码/删除线） | **渲染态内联编辑**（Phase 3） | Typora/有道均如此；源码符号干扰阅读 | ✗ 整块源码 |
| 标题 h1–h6 | **渲染态内联编辑**（Phase 3） | 同上 | ✗ 整块源码 |
| 列表项（有序/无序/嵌套） | **渲染态内联编辑**（Phase 3） | 同上 | ✗ 整块源码 |
| 任务列表复选框 | 渲染态点击切换 | — | ✓ 已实现 |
| 表格单元格 | **单元格 contenteditable + 失焦回写**（Phase 2，= R5） | 两产品均格内编辑 | ✅ 就地源码编辑（2026-10-13） |
| 引用文字 | **渲染态内联编辑**（Phase 3） | 同上 | ✗ 整块源码 |
| 链接（文字/URL） | 渲染态改文字 + URL 弹层（Phase 3 附属） | Typora 同型 | ✗ 整块源码 |
| 代码块（围栏） | **显示源码编辑 + 明显背景** | 语法高亮/缩进是源码属性，渲染结果不可逆 | ✓ 整块源码（活动块高亮已增强） |
| 公式（$$ 展示 / $ 行内成块） | **显示源码编辑 + 明显背景** | LaTeX ↔ 渲染不可逆 | ✓ 整块源码 |
| Mermaid | **显示源码编辑 + 明显背景** | 同上 | ✓ 整块源码 |
| 图片（markdown 语法行） | **显示源码编辑 + 明显背景**（或后续给图片选中+菜单） | 路径/尺寸/标题无法从渲染结果完整还原；Typora 也不内联改语法 | ✓ 整块源码 |
| 原生 HTML / `<details>` | **显示源码编辑 + 明显背景** | 渲染是黑盒 | ✓ 整块源码 |
| ref 定义行 | 保持隐藏；块「编辑」按钮 → 源码编辑（已有） | 2026-10-12 决策 | ✓ |
| 分隔线 / frontmatter | 显示源码编辑 | 单行语法 | ✓ 整块源码 |

**「正在修改的块」背景设计（用户硬要求）✅ 已落地（三轮，2026-10-13）**

- 第一轮（同日早）：修复选择器 bug（bgClass 落在 `div.CodeMirror-linebackground`，旧规则选
  `pre` 从未绘制）+ 加粗信号（accent-muted 15% 底 + 3px 竖条）。
- 第二轮（用户反馈「太丑」）：减重为 accent-subtle 浅底 + 2px 竖条 + 圆角 4px。
- 第三轮（用户反馈「左边一个个的小圆角不好看，要其他颜色、看起来像一块编辑」，参考图 =
  代码块灰盒）：改为**代码块同色 `--code-bg` 灰底（六套配色/明暗自适应）+ 逐行无圆角 +
  仅块首行上缘/末行下缘圆角**（JS 对首/末行额外挂 `cm-wysiwyg-active-first/-last` 行类）
  → 多行块读作**一整块圆角矩形编辑区**，无主题色竖条（`styles.css` `.cm-wysiwyg-active-*`；
  harness S15 断言：底色 = 代码块 pre 的 computed 底色、单行块四角全圆、多行块首行仅上角/
  末行仅下角/中间行无角）。
- 代码/公式/图表等「显示源码编辑」块进入源码态时同享此高亮（活动块=源码态，统一机制）；
  表格单元格编辑仍用**格级**高亮（accent-subtle 浅底 + 1px accent 描边，`.wysiwyg-cell-editing`）。
- 退出：光标移出即撤（现有机制）。

**实施路径（受当前架构约束：CM5 mask = 整块粒度，光标恒在真实源码行）**

- **Phase 1（小，当前架构内）✅ 2026-10-13 已实施**（含第二轮美化）：见上「背景设计」。
- **Phase 2（中）✅ 2026-10-13 已实施**：R5 表格单元格就地源码编辑（实现/设计/验证细节见 R5）。
  设计取舍：单元格显示**原始源码文本**（无损回写、与 CM5 单一数据源架构一致），渲染态真内联
  （编辑渲染 DOM）留给 Phase 3。
- **Phase 3（大，核心架构项）⏸ 暂缓（2026-10-13 用户决策）**：文本类块（段落/标题/列表/引用/
  链接）渲染态内联编辑。需要「渲染 HTML ↔ markdown 源码」双向映射（Typora 用自研
  contenteditable 引擎：每块独立 DOM，核心是 markdown 解析/序列化；实现路径 = 遮罩节点
  contenteditable + 编辑结束按块 diff 重新解析回源码行）。工作量与回归风险显著高于 Phase 1/2，
  单独立项评估后再排期。
- 架构取舍备忘：CM5 mask 方案的优点是单一数据源（光标永远在真实源码行上，无回写错漏）、
  滚动/搜索/跳转/锚点全复用现有机制；内联编辑的收益是文本块的 Typora 式观感，代价是
  每类内联元素（加粗/斜体/行内代码/链接/emoji/缩写）都要做「渲染 DOM 编辑 → 源码文本」
  的无损回写。Phase 3 启动前先对「段落 + 标题 + 列表」三类做技术原型验证回写保真度。

### P2 — 健壮性 / 边界

**R8. 超大文档（~18k 行）虚拟遮罩边界**
- 现状：行数 > `WYSIWYG_FULL_RENDER_MAX_LINES`（10000）进入虚拟模式（块 html 被 skipped，滚动时按视口渲染）；2026-10-09 起虚拟模式已有方向感知增强预取（快速滚动零闪现）。
- 验证：极端行数下滚动锚定补偿是否仍 0.38px 量级、滚动不卡。
- 入口：`src/modules/wysiwyg.js` 顶部常量 + `updateWysiwygViewportMasks` + `_ensureWysiwygScrollHook`（120ms debounce）。

**R9. 多标签/文件切换时的状态清理**
- 现状：`_wysiwygMarks` / `_wysiwygVirtual` / `_wysiwygActiveIdx` 等挂在实例上。
- 目标：切 tab / 打开新文件时这些状态正确重置，`clearWysiwygMasks` 已清理 marks，但虚拟标志/缓存需确认。
- 入口：`renderWysiwygMasks` 开头 `clearWysiwygMasks`；tab 切换处调用时机。

**R10. 进入/退出 wysiwyg 保持滚动位置**
- 现状：渲染态块与原源码块高度不同，切换模式滚动位置会跳。
- 目标：切换前后用滚动锚定（同 §3 已有方案）保持视口内容不动。
- 入口：`setViewMode` / `applyViewMode`（src/modules/theme.js）。

**R11. undo 栈在遮罩重建下不打断**
- 现状：输入防抖是 250ms 后 `refreshWysiwygBlocks`（全量重算块表 + 重挂遮罩），可能打断 CM 原生 undo 栈。
- 验证：wysiwyg 下连续编辑 + Ctrl+Z 是否逐字符回退；若被打断需让重算仅动 marks 不动 doc。

**R12. 跨块 `[text][ref]` 引用还原（2026-10-12 用户决策：本批只隐藏定义行，此功能后置）**
- 现状：ref 定义行单独成块时整块塌缩隐藏（阅读模式同款行为）；但**引用处** `[text][ref]` 与定义不同块时，逐块渲染拿不到别块定义 → 引用处显示字面 `[text][ref]`（阅读模式整篇渲染可还原，两模式不一致的已知边界，与 §3 已记录的脚注/缩写跨块边界同类）。
- 目标：`renderMarkdownBlocks` 预扫全文 ref 定义（`label → url/title` 表），逐块渲染时注入该表，使引用处跨块可还原。
- 入口：`unified-renderer.js` `renderMarkdownBlocks`（remark 的 `remark-reference` / link 插件链；或渲染前对切片文本做引用替换预 pass）。
- 坑：定义行隐藏后块表仍含该块（行号映射依赖），只藏视觉不删块；title 三形态（"..." '...' (...)）。

## 5. 改 wysiwyg 前必读的关键约束（踩过的坑）

1. **遮罩用 markText + replacedWith，不能用 addLineWidget**——后者不隐藏源码行，渲染与源码重复显示。
2. 遮罩节点**必须带 `preview-content` 类**，否则标题/表格/列表无样式（排版 CSS 作用域是 `.preview-content xxx`）。
3. 遮罩节点**不能设 pointer-events:none**——点击穿透到空白，CM 坐标映射拿不到有效位置，块点不进去。改为遮罩自己 mousedown 接管。
4. **CM5 滚动三坑**（锚定/补偿都用过，详见 `.workbuddy/memory/MEMORY.md`「编辑器行为」）：
   - `setSelection` 默认 `ensureCursorVisible` 会抢先滚动 → 必须 `{scroll:false}`；
   - cursorActivity 在 setSelection 的 operation 内触发，此时滚动被 CM 记 pending 冲掉 → 精确锚定必须在 setSelection 返回后做；
   - `scrollTo` 在 refresh 后 DOM 高度未落定时被 clamp → 用 `scrollIntoView`（margin 语义=行精确落在距视口顶 margin 处）。
5. **`renderMarkdown` 只产结构 HTML**：KaTeX/highlight/图片/mermaid/emoji/缩写等都是预览端独立 pass，遮罩里不补跑就露源码。现已全接且**收敛到 `modules/render-post.js`（RenderPost 共享管线）**：阅读模式 `render()` 与遮罩 `_postProcessWysiwygNode`（同步 stage）/ `_wysiwygPostProcessAsync`（异步 stage）编排同一组 stage；新增后处理步骤必须加进 RenderPost 并让两模式都调，**不许再各写一份**（2026-10-11 四缺陷的根因就是两份手抄逻辑漂移）。节点级代数 `_wysiwygNodeGen`（node→gen Map，`_dropWysiwygMaskNode` 时 +1）防旧请求写脏重建后的 DOM；[TOC] 是整篇级例外（Rust `generate_toc`，见 render-post.js 文件头）。
6. **CM5 `replacedWith` widget 落定时机（2026-10-11 探针实测）**：`markText` 返回后、显式 `cm.operation` 返回后，widget 节点都可能 `isConnected === false`；`cursorActivity` 在 `setSelection` 的 operation **内部**同步触发（maskWysiwygBlock 的 markText 加入同一 op）；视口外行 `cm.refresh()` 后**仍不连接**（只有滚动物化才连）。所以**凡是依赖节点已在 DOM 的子 pass（图片读盘/mermaid/TOC 替换/scrollHeight 测量）不能紧跟 markText 同步调**——本仓模式：登记 `_wysiwygPendingAsync` → 0 计时器 + 显式 flush 点（`renderWysiwygMasks` refresh 后、`updateWysiwygViewportMasks` operation 后）→ `flushWysiwygAsyncPasses` 只跑 `isConnected` 的。pass 必须幂等（重复 flush 安全）。
7. **异步 pass 的 then 刷新回调必须有存在性守卫（2026-10-11 真机卡死回归）**：RenderPost 各 stage 对「无内容可处理」返回已 resolve 的 promise，**then 回调照样执行**——`_wysiwygPostProcessAsync` 里若对每个块无条件链 `.then(() => _wysiwygRefreshAfterMaskChange())`（内含 `cm.refresh()` 全量重测），大文档几百块 × 3 pass = 刷新风暴（实测 demo.md 299 块：886 次 refresh / 65 秒主线程占满，「点击所见即所得卡住没反应」）。加 `querySelector('img')` / `code.language-mermaid` / [TOC] 段存在性判断后 20 次 / 1.8 秒。**凡「promise 完成 → cm.refresh」的链，只有块里真有该内容才允许启动**。
7. **`data-source-line` 是块切片内相对行号**，不是整篇行号——回写源码须加 `block.start`（复选框回写已处理，其他回写逻辑要照做）。
8. 遮罩后处理 `b.html` 缓存的是未后处理结构 HTML，每次挂遮罩都要重跑后处理（RenderPost 各 stage 幂等，可重复）。
9. **`cm.setOption('viewportMargin', n)` 的选项处理器自带 `cm.refresh()`**（codemirror.js 同步触发）——扩视口必须直接写 `cm.options.viewportMargin`，否则多一次全量重渲染（万行文档 ~1.8s）。
10. **headless fullPage 截图伪影**：Playwright fullPage（captureBeyondViewport）不绘制原视口（默认 720px）以下 overflow 容器的内容，截图会「下半片空白」但 DOM 正常——整页截图先 `setViewportSize` 到整页高度再普通截图（驱动场景 5 已处理）。
11. **全量模式增量刷新靠块源文本同一性**：`b.src`（块切片源码 join）是 diff 键——凡是从新源码重渲染了块 html 的地方（`setWysiwygActiveBlock` 旧块回遮罩、任务复选框切换）必须同步 `b.src = this._wysiwygBlockSource(b)`，否则下次增量刷新误判「源未变」保留过期遮罩。
12. **`addLineClass(line,'background',cls)` 的类不在 `pre.CodeMirror-line` 上**（2026-10-13 浏览器诊断发现）：CM5 把它渲染到**独立的 `div.CodeMirror-linebackground`**（行包裹层 `position:relative` div 内的绝对定位背景层，`left/right:0` 满行宽，z-index:0，与 `pre` 是兄弟）。CSS 要命中它必须选 `div.CodeMirror-linebackground.<cls>`——旧活动块高亮规则选的是 `pre.CodeMirror-line.<cls>`，**从未真正绘制**（静态测试只查 Line 对象的 `bgClass` 属性，查不到 CSS 是否生效，故一直绿灯）。给行类写 CSS 前先在 harness 里查该类的实际 DOM 落点（`getComputedStyle` + `querySelector`）。
13. **任何会 `maskWysiwygBlock`/`clearWysiwygMasks` 重建遮罩的操作，都会让旧遮罩节点整体离场**（2026-10-13 表格格编辑踩坑）：提交回写后「还要找那个 DOM 元素」的代码（Tab 切格、点另一格）若持有旧节点引用，拿到的是**已 detached 的节点**（`isConnected===false`），操作静默失效。模式：先记住 `(blockIdx, rowIdx, colIdx)` 逻辑坐标，重建后从 `mark.replacedWith` 新节点按坐标重定位；且**结束编辑的方法首行就清状态**（`_wysiwygCellEditing=null`），因为回写会触发 `cursorActivity` → 撤/挂遮罩 → 重入守卫，状态不清会递归/误判。
14. **异步管线里的 loading 层（引用计数 `_beginPaneLoad/_endPaneLoad`）必须在「昂贵的同步步骤完成后」释放，且按代（gen）配对**（2026-10-13 切所见即所得「loading 后空白数秒」踩坑）：预渲染完成 ≠ 用户可见——`applyViewMode` 的 50ms 计时器之后 `renderWysiwygMasks` 还要同步挂全部遮罩（数秒），早撤 loading 就露空窗。释放点设计成「恰好其一」（挂完 finally / 中止 / 取消 / 离开模式），并用 `_wysiwygPreRenderLoadGen` 与当前代比对：新一代预渲染启动后，旧路径的迟到释放必须 no-op（`_beginPaneLoad` 是引用计数，错配 = 提前撤罩或覆盖层永久残留）。新增此类「异步准备 + 同步落地」管线时照抄该模式。
15. **格编辑提交（replaceRange + 清标记重挂遮罩 = 重建整行 DOM）绝不能在 CM 自己的事件处理/operation 上下文里同步执行**（2026-10-13 用户报 `NotFoundError: appendChild … moved in a "blur" event handler`，codemirror.js:1928）：两条隐形入口——① 点源码区/其他行时 **CM 的 mousedown 处理器内 `setSelection` 会让编辑格失焦，blur 事件同步触发**（在 CM operation 里）；② **`cursorActivity`（setSelection 内）→ `setWysiwygActiveBlock`** 也在 operation 里，其「先提交在编格」守卫同步提交同样中招。提交会 `mark.clear()`（CM 拆掉 widget、重建行 DOM）+ `markText`（再挂），CM 外层操作收尾时还要移动这些节点 → 抛错。规则：**在 blur 监听与 setWysiwygActiveBlock 守卫里一律 `setTimeout(0)` 延迟提交**（触发时状态已被别的清掉则 no-op）；唯一保持同步的是 `unmaskWysiwygBlock` 对「在编格所在块」的守卫——撤罩本身就销毁编辑格 DOM，必须先提交保住文本（该路径只从非 CM-operation 上下文到达：遮罩内的点击被我们的 mousedown 接管，CM 光标无法落入被遮罩块内部）。新增任何「在格编辑期间可能发生」的同步操作前，先问：它会在 CM operation 里跑吗？
16. **浮层控件（hover 才现的按钮/把手）定位在宿主盒子外 + 落在相邻块内容区时，纯 CSS `:hover` 不可靠**（2026-10-13 表格「＋」点不到踩坑）：两层坑叠加——① 按钮在宿主外有 6px 空隙，鼠标穿过空隙 `:hover` 丢失、按钮在点击落定前消失；② **CM 相邻行同为 `z-index:2`、后行（下方块）压前行（表格行）上层**，下缘按钮/桥被下方块 DOM 截获 hover 与点击。`:has(:hover)` 也救不了（hover 丢失时选择器不成立）。正解：**JS 托管 hover 状态类**（mouseleave 延迟 200ms 隐藏、进入按钮取消）+ **按钮恒 `display:flex` 用 `opacity/pointer-events` 显隐**（`display:none` 无法被 hover 命中）+ **悬停期把宿主所在 CM 行 z-index 抬高**（压过相邻行）。新增此类「盒外浮层」前先想：鼠标从宿主到控件的路径上，`:hover` 会不会断？该处 DOM 会不会被相邻块压在下面？
17. **给 CM 行（`pre.CodeMirror-line`）写 z-index/定位覆盖时，选择器特异性必须压过 codemirror.css 的 `.CodeMirror pre.CodeMirror-line`（(0,2,1)）**（2026-10-13 抬表格行 z-index 踩坑）：写 `.CodeMirror-line.<cls>`（(0,2,0)）会被压住、`getComputedStyle` 里 z-index 仍是 2、静默失效。要写 `.CodeMirror .CodeMirror-line.<cls>`（(0,3,0)）才赢。凡是对 CM 自带元素加覆盖类，先 `getComputedStyle` 核对计算值真的变了（别只看「规则写进去了」）。
18. **`display:block; width:100%` 的表格：元素盒 ≠ 可见网格**（2026-10-13 用户截图「增行/增列按钮离表格很远」踩坑）：`.preview-content table` 是 `display:block`（表格盒）包一个匿名表格网格——盒被 `width:100%` 撑满整行，**网格仍按列内容收缩、左对齐**（真机 937px 行里只画 250px 表格）。任何相对表格定位的浮层（wrap 按钮、标注等）都会漂到「行宽」而非「表格宽」的位置；无头测试若只量 `table.getBoundingClientRect()`（盒）会自洽通过、真机才暴露。规则：① 相对表格定位的容器必须 `width: fit-content`（收窄到网格）；② 量表格几何用**首格/末格 cell 的 rect**（可见网格），不要用 table 元素盒；③ 写几何断言时同时断言「相对行宽的位置差 > 阈值」（如按钮离整行中心 >100px），防「盒=行宽」假自洽。
19. **滚动容器裁剪「盒外伪元素」+ 伪元素把手的 hover 循环依赖**（2026-10-13 表格外拖拽把手踩坑，两个叠加的坑）：① `.preview-content table { display:block; overflow-x:auto }` 且（§5.18 收窄后）表格盒只有网格宽——**任何 `position:absolute` 的伪元素/子元素一旦盒子伸出 table 盒（行把手 `left:-16px`、胶囊 `top:-20px`）就被 table 裁剪**：`getComputedStyle` 里 content/left 一切正常、看起来「渲染了」，实际看不见也命中不到（`document.elementFromPoint` 落到下层 `pre`），且**静态 CSS 断言查不出**（计算样式不反映裁剪）。② 即便不被裁剪，「把手盒在宿主盒之外、而又是 `:hover` 的产物」是循环依赖：指针从格子移向把手的瞬间 `:hover` 失效 → 把手消失 → 命中掉到下层 → 拖拽永远启动不了（+ 按钮坑的 §5.16 空隙问题的盒外版本）。规则：**表格外浮层做成宿主 wrap（overflow:visible）上的真实元素，JS 按悬停目标实时定位**；几何/命中断言必须用 `elementFromPoint`（计算样式查不出裁剪与命中）；hover 状态一律 JS 类托管。
20. **contenteditable 提交路径的「焦点归宿」**（2026-10-13 用户「格内输入完光标丢失」根因）：格编辑提交 = `cell.blur()`——blur 后焦点默认掉 `document.body`，若提交代码只 `cm.setSelection(...)` 不 `cm.focus()`，编辑器整体失焦（用户视角「光标没了」），且无头测试若只断言「格还在不在/文本对不对」断不出焦点归宿。规则：① 任何「从可编辑元素离开」的路径，都要显式决定焦点去哪（回 CM 输入域 / 新编辑元素）；② 焦点恢复用**下一 tick + 条件判定**（仅当 `activeElement === body` 才恢复）——点别处的路径下一 tick 焦点已被接走，同步恢复会覆盖用户刚点的位置；③ 测试必须真实按键（`page.keyboard`）后断言 `document.activeElement` 的归宿，不能只看 DOM 文本。
21. **宿主盒外 gutter 的命中区必须是「常驻 DOM 子节点」（边缘邻近触发的鸡生蛋问题）**（2026-10-13 表格边缘拉手踩坑）：gutter（表左缘外/表上方）在 wrap 盒**外**——鼠标在那儿时，事件目标若是下层元素（`pre.CodeMirror-line` 等、不在 wrap 子树内），wrap 的 mousemove/pointerdown **根本不会触发**（事件冒泡按 DOM 树走，不看几何包含）。因此 gutter 里必须**常驻**一个 wrap 的 DOM 后代作命中区（轨道：`display:block` + `pointer-events:auto` 的透明元素），可见把手做它的**子元素**（JS 定位 + opacity 显隐）。把命中元素做成「随悬停才显示」（display:none）→ 鼠标进 gutter 时目标掉下层 → 事件收不到 → 「移到行左边一点出把手」永远不成立，且静态断言/计算样式都查不出（元素没渲染谈不上裁剪）。配套两坑：① 轨道是全高/全宽命中区时，**拖拽入口必须按按下点坐标反查行/列**，不能按元素盒几何（会恒命中首行/中列）；② gutter 按下后 mousedown 目标是轨道 span（非单元格）——单元格分支的拖拽守卫罩不住，**处理器顶部要有 `if (this._wysiwygTableDrag) { preventDefault; return; }` 总守卫**，否则拖拽中途被「点击映射源码行」分支撤罩 + 挪光标。
22. **IME 组合事件时序不保证「组合期包住确认键」**（2026-10-13 用户「输入完马上丢光标，像被回写」根因）：WebView2/Chromium 下 `compositionend` 可能**先于**选字确认 Enter 的 keydown 到达——keydown 时 `event.isComposing=false` 且自维护的 `st.composing=false`，两个守卫都放行 → 确认 Enter 被当「提交格子」→ 回写重渲 + 焦点跳出格。只判 `isComposing`/组合标志不够，要**时间窗**：compositionend 记录 `Date.now()`，其后 250ms 内的 Enter 只 `preventDefault()`（挡原生换行）不提交。窗口要够小（>250ms 的真实提交 Enter 不受影响）、够大（覆盖合成事件与 keydown 的到达间隔）。另：任何「从 contenteditable 提交」的路径，`setSelection` 后应**同步**补一次 `cm.focus()`（与 §5.20 的延迟恢复互为双保险）——延迟恢复只兜「焦点掉 body」，同步补焦让正常路径第一时间有光标。
23. **「跟随」型拖拽视觉必须单路写入（2026-10-13 反馈 #1「变蓝的块不跟小手走」）**：wrap 的 mousemove（悬停路径，高频）与 window 的 pointermove（拖拽状态机）若**两路都写**同一个视觉位置会打架——悬停路径的兜底分支（指针移离命中区时「清除悬停」）还会在拖拽中途把视觉元素**隐藏**（指针斜移进表格区即触发）。规则：拖拽越过阈值后，该视觉元素的定位**只归拖拽状态机**（pointermove，带 clamp），悬停路径开头 `if (drag && drag.moved) return;` 让位。验证「跟随」时测点必须选**非行/列中心**（如行中心 +9px）——吸附到中心的旧实现在行中心测点上同样「通过」（自洽陷阱）。
24. **thead 行拖拽的 DOM 结构坑（2026-10-13 反馈 #2「表头行可拖」）**：`tr` 被 `before/after` 从 thead 移到 tbody 行位置时，浏览器自动把它收进 tbody（tr 只能属于 thead/tbody/tfoot）→ thead 变空壳，且 `insertBefore` **无法**把它放回 thead（放回须 `thead.appendChild`）。两个必备动作：① DOM 恢复时对表头行（idx 0）判 `dragTr.parentElement !== thead` → 显式 appendChild 归位；② **原位无效释放（to===from）不能直接 return**——拖拽中结构可能已坏，同样要走恢复。Markdown 语义：表头「可移动」，但源码首行恒为表头（分隔行恒在第 2 行）——拖走后落到首位的数据行自动升为新表头（moveTableRow 按行序列下标，0 = 表头）。
25. **wrap 加 padding 后，盒内绝对定位子元素一律以「轨道/条带自身 rect」为基准（2026-10-13 反馈 #2 留白改造）**：握点（`span`）的 offsetParent 是**轨道**（`.wysiwyg-table-row-handle` / `.wysiwyg-table-col-pill`），不是 wrap——wrap 加上下留白 padding 后，若 JS 仍拿 `wrap.getBoundingClientRect()` 算握点 top/left，整体偏移上留白 22px（行握点集体错位）。规则：定位公式统一 `(目标rect.top - 轨道rect.top + …)`。**下缘悬停桥（::after）随条带收进盒内必须删除**：旧 ::after `top:100%; height:28px` 伸入下一行，悬停表格时（tools-hover 期间 pointer-events:auto）会把下一行首行前 28px 抢成表格的命中区 → 点击落不进下方段落；右缘桥（::before）保留（竖条仍在盒外 6px 间隙，需跨隙连续悬停）。另注意：条带收进 wrap 盒后，「表下留白区」点击映射到表格源码行（光标进表格块），不再是下方段落——这是留白属于表格行的必然结果。
26. **拖拽「实时重排 DOM」会让落点指示线无处可画（2026-10-13 反馈 #1/#2 落点线改造）**：旧实现每帧把被拖行/列 `before/after` 搬到目标位（DOM 实时换位）——这样「被拖项」与「落点」是同一个位置，独立蓝线要么不存在（用户反馈）要么与被拖项重叠成双蓝线。改参考图语义（被拖项原地淡蓝高亮 + 蓝线标落点）必须**停掉实时重排**：① move 里只算 `st.target`（指针 vs 其余行/列中线的插入下标）+ 定位蓝线，**不碰 DOM**；② up 里终位**只信 `st.target`**——此时 DOM 恒为原序，读 `indexOf(dragTr)` 必然恒等于原下标（静默 no-op，用户怎么拖都不生效，且测试若断言「拖完 DOM 序变了」会自洽通过假实现）；③ 蓝线元素放 wrap 上（真实子元素、`pointer-events:none`、默认 opacity 0），行=横线通表宽（`left:0;width:100%`）、列=竖线通表高（`top:22px;bottom:32px` = 留白内表体区），定位基准 = wrap rect（线在 wrap 直接子级，offsetParent=wrap，与 §5.25 的「轨道基准」区分开）；④ 拖拽期不动 DOM 的附带收益：thead 自动收养坑（§5.24）不再触发，`_wysiwygTableRestoreDom` 降为 no-op 兜底；⑤ 视觉断言三件套：线位置（行拖=表底缘/列拖=表右缘、中途折返=目标行顶缘）+ 拖拽中 `domOrder` 与拖前相等（防实时重排回归）+ 释放后线 opacity=0。
27. **行拖/列拖胶囊先「各自对参考图」、后「统一风格」（2026-10-13 两轮打回）**：第一轮
  列拖胶囊误套行拖的 16px 细竖条被打回（改宽横胶囊：宽 = 被拖列宽 × 26px、单排横白
  点 ⋯、全圆角 13px）；第二轮用户要求**行/列拖按钮样式一致** → 行拖也从 16px 细条改
  26px 厚竖胶囊（单排竖点 ⋮），两款胶囊 = 同一风格（厚 26px + 全圆角 + 单排白点沿
  拖动轴）、只是方向不同。教训：① 列拖宽度来源 = 被拖列**表头格实测宽**（拖拽中 DOM
  不动、随时可量），最小 36px 兜底防窄列；② 点阵是文本字符不是 CSS 背景——拖动态换
  `textContent`（悬停 ⋮⋮ → 行拖 ⋮ / 列拖 ⋯×n），**结束态必须还原**（连同 inline
  width/height 一起清，否则下次悬停残留拖动态胶囊）；③ 宽胶囊跟随 clamp 要按**半宽**
  收（`max(gw/2, min(trackW-gw/2, x))`），否则指针贴表格缘时胶囊探出表外；④ 行轨道
  要加宽到胶囊厚度（20px → 26px）否则行胶囊探进表格左缘；⑤ 行/列胶囊尺寸断言分开
  写 + 加一条「厚度一致」联合断言（S24 现为 37 项）。
28. **给「单元格自身启动的拖态」加例外时，两层 mousedown 守卫都要改（2026-10-13 表头
  可编辑）**：遮罩 mousedown 有两层拖拽守卫——① 顶部总守卫（吞掉拖拽中的整个
  mousedown，防落到「点击映射源码行」分支撤罩挪光标）② 单元格分支守卫。表头格普通
  点击要进格编辑，只改分支守卫不够（总守卫先 return）——两层都要加「本表头格自身
  启动的列拖态」例外（`cellEl === st.trs[0].children[st.idx]`）；且拖动超阈值时
  `_wysiwygTableDragMove` 阈值块已有 `_wysiwygEndCellEdit(false)` 负责取消编辑，
  例外不会让拖拽被编辑污染。另：S24 harness 的 `hd.gridTop` = **首数据行顶**（grid
  网格），不是表顶（thead 顶）——断言「表顶缘」一律用 `ths[x].top`（曾把列握点骑跨
  表顶缘的断言写错基准，握点 cy 与 gridTop 差 45px 判 fail）。

## 6. 本地验证命令

```bash
# 无头浏览器对比（真实 CM5 + 真实渲染管线 + TauriApi mock + mermaid；playwright 已全局安装，
# 脚本按 PLAYWRIGHT_MODULE → 本地依赖 → 用户全局 npm 目录 解析，版本不匹配回退缓存可执行文件）
node scripts/wysiwyg-browser-check.mjs
# 结果：23 场景 120+ 项全绿（渲染同构、空行提示、点击锚定 0.4px、表格格就地编辑、复选框、
#       KaTeX/高亮/emoji/缩写/标题锚点/复制按钮/details 对齐、行号隐藏、
#       字号/行高/字体族/边距/底色与阅读模式一致、>10000 行虚拟遮罩、IME 守卫、
#       滚动锚定 0px、场景 6 全量模式 3000 行快速滚动首跳 ≤0.3px + refresh 自愈、
#       场景 7 按钮点击后台预渲染时序、场景 8 点击落点、
#       S9 [TOC] 目录遮罩/阅读同构 + 重挂注入、S10 图片加载 + 光标移动重挂回归、
#       S11 长代码块按需滚动条双模式对照 + codeScroll=false 撑开、
#       S12 Mermaid 遮罩内 3 图渲染 vs 阅读 + 重挂恢复、
#       S13 ref 定义行塌缩占位（与阅读模式不显示对齐）、
#       S14 块「编辑」按钮全块挂载 + hover 显现 + 代码块让位 + 点击解罩落块首、
#       S15 活动块背景整块灰盒（代码块同色 + 首/末行圆角）挂/撤、
#       S16 预渲染管线 loading 配对 + 在飞守卫 + 切标签内容替换重算、
#       S17 跳转解罩（多行块行定位 clamp 复现 + 修复落点 + 锚点 #id）、
#       S18 表格单元格就地源码编辑（进格/失焦提交转义回写/重渲光标落位/Tab 切格/Esc 取消）、
#       S19 大文档 loading 持留至遮罩挂完（挂载/释放同一 tick，无 loading 后空窗）、
#       S20 表格行/列操作（工具注入/增行增列自动格编辑/行拖拽/列拖拽回写/块表一致）、
#       S21 格编辑真实 I/O（真实鼠标点击进格→选区折叠不全选 + 真实键盘逐字输入不丢焦点）、
#       S22 格编辑 IME 组合期不中断（compositionstart→Enter 被忽略不提交，组合结束 Enter 恢复提交）、
#       S23 增行/增列「＋」真实鼠标可达（分步滑过 6px 空隙按钮不消失 + 悬停期行 z-index 抬升 + 真实点击增行增列）、
#       S24 表格外拖拽把手（边缘邻近触发：左 gutter 出灰行握点/顶 gutter 出灰列握点/格上无，
#         悬停零高亮；拖动中超阈值 → 握点蓝底胶囊 + 被拖行/列浅蓝高亮；真实按住拖动换位）、
#       Edge（WebView2 同引擎）抽查：node scripts/_edge-spot-check.mjs（Enter 焦点 + gutter 真实拖行）、
#       场景 5 输出 demo.md 整篇双栏截图）

# jsdom 单测（全套或单文件；run-tests.cjs 按文件起子进程隔离 jsdom）
node scripts/run-tests.cjs
node scripts/run-tests.cjs "wysiwyg"   # 例：wysiwyg 相关（blocks/view-mode/async-pass）
```

> ⚠️ **渲染器改动必须重建 bundle**（2026-10-12 真实踩坑）：app/dev/harness 加载的都是
> `src/lib/unified-bundle.js`（预打包产物，**不进 git**），不是 `src/unified-renderer.js` 源文件。
> `npm test` / `npm run dev` 的 pretest/dev 钩子会自动 `node scripts/build-renderer.mjs`，
> 但**直接跑 `node scripts/run-tests.cjs` 不重建**（只校验存在性）——改了 unified-renderer.js
> 后直接跑浏览器 harness 会拿到陈旧 bundle，现象是「jsdom 直测源文件全绿、浏览器侧新行为
> 不生效」，极易误判成产品 bug。手动重建：`node scripts/build-renderer.mjs`。

## 7. 真机验收清单（每改一项逐项看）

- [ ] 所见即所得左侧**无行号**（切回源码模式行号按设置恢复）
- [ ] 遮罩正文**字号/行高/字体与阅读模式一致**（无「一大一小」跳变）
- [ ] 遮罩**无灰色块底**，左右留白与阅读模式一致
- [ ] 打开含数学公式的 md，遮罩块内公式已渲染（非 `$$...$$` 源码）
- [ ] 代码块已语法高亮，复制按钮可点
- [ ] **长代码块出现滚动条可滚**（>300px 裁高；「代码块滚动条」设置关闭时高度撑开无滚动——与阅读模式同判据）
- [ ] 图片正常显示（本地相对路径；光标移动遮罩重挂后图片仍在）
- [ ] Mermaid 图表渲染为 SVG，点击可放大（多图批量不互相吞——id 碰撞已修）
- [ ] [TOC] 段落渲染为目录（含块内 [TOC] 前有其他段落的情况；与阅读模式目录同构）
- [ ] 点击渲染块内链接/锚点，跳到对应源码行（无大跳动）
- [ ] 点击渲染块，光标行停在点击位置附近（无大跳动）
- [ ] 滚动长文档，视口内容不漂移
- [ ] 任务复选框可点击切换
- [ ] 中英文输入不吞字
- [ ] 含 `[label]: url` 定义行的文档：阅读模式与所见即所得都**不显示定义行**（2026-10-12）
- [ ] 点「所见即所得」/ 所见即所得下切标签：显示 **loading 覆盖层**，不出现「全屏源码数秒」（2026-10-12）
- [ ] 每个渲染块 hover 右上角出现**「编辑」按钮**，点击后该块变源码态且光标落在块首（代码块让位于复制按钮左侧）（2026-10-12）
- [ ] 正在编辑的块显示为**一整块灰底编辑区**（代码块同色、首/末行圆角，像参考图灰盒），移出后收回（2026-10-13 三轮修正）
- [ ] 点「所见即所得」/ 大文档切标签：loading 层**持续到渲染内容出现**，不出现「loading 消失后空白/源码数秒」（2026-10-13）
- [ ] 改表格单元格内容（含点表格外提交/点另一格）**不再报 `NotFoundError`**（提交延迟出 CM operation，2026-10-13）
- [ ] 表格 hover 出**增行/增列「＋」**（右缘/下缘），点击后源码即时更新并**自动进入新格编辑**（2026-10-13）
- [ ] 表格**行可拖动换位**（左缘把手）、**列可拖动换位**（表头格，拖动超阈值才生效、普通点击仍进格编辑）（2026-10-13）
- [ ] 点渲染表格的**格子**：该格就地变为可编辑（显示源码文本 + 浅色底 + 描边），整表其余保持渲染；改完回车/点别处自动写回；Tab 切下一格；Esc 取消（2026-10-13）
- [ ] 点表格**格子**：光标落在**点击处**（不再整格全选文字），可直接继续输入（2026-10-13 四）
- [ ] 表格格内**中文输入**：敲拼音 + 回车选字**不丢焦点**、可连续输入多字（Enter 确认拼音≠提交格子，2026-10-13 四）
- [ ] 表格 hover 出的**增行/增列「＋」能点到**：鼠标从表格滑到按钮（跨越 6px 空隙）按钮不消失、点击生效（下缘按钮不被下方块挡住，2026-10-13 四）
- [ ] 增行/增列「＋」**紧贴表格右缘/下缘**（窄表格时不漂到行中心/编辑器右缘；宽表格超行宽时内部滚动、按钮在行右缘，2026-10-13 四-A2）
- [ ] 格内输入后**光标不丢失**（中文输入完按 Enter 选字/提交后焦点回到编辑器，可继续敲下一格或段落，2026-10-13 五）
- [ ] 鼠标移到表格某**行左边一点**（左 gutter）→ 只出现该行**灰色**点阵握点（无底色、行**不**高亮、列握点不出现）；移到某**列上边一点**（顶 gutter）→ 只出现该列灰色握点；**停在单元格上 → 都不出现**（2026-10-13 六）
- [ ] **按住行握点拖动** → 握点变蓝底胶囊（**26px 厚竖胶囊×行高、单排竖点**）+ 被拖行浅蓝高亮（留在原位）+ **蓝色落点横线**，松手后整行换位（源码行序变化）；**按住列握点拖动** → 蓝底胶囊（**横胶囊：宽 ≈ 被拖列宽、高 26px、一排横点**，与行拖胶囊同风格：厚 26px+全圆角+单排白点，参考图）+ 被拖列浅蓝高亮 + **蓝色落点竖线**，松手后整列换位（源码列序变化）——蓝色高亮**只在拖动时**（2026-10-13 六，九改落点线，十统一行/列胶囊风格）
- [ ] 表格在**文档最顶部**时，表上方列握点完整可见（不被滚动容器顶缘裁掉）（2026-10-13 六）
- [ ] 表格格内**中文 IME 输入**：拼音选字确认后光标不丢（残影 Enter 不再误触发回写）（2026-10-13 六）
- [ ] **拖动行/列时蓝胶囊跟随鼠标连续移动**（不跳格、指针斜移也不消失）；行拖/列拖胶囊样式一致（2026-10-13 七）
- [ ] 鼠标移到**表头行**左边一点 → 同样出灰色握点，**按住拖动可移走表头**（落到首位的数据行升为新表头，表格结构不变）（2026-10-13 七）
- [ ] 增行/增列按钮 = **右缘通高竖条 / 下缘通宽横条**（浅灰底+细边框+居中＋），**只有鼠标移到表格右边/下边一点才显示**（悬停表格本体/间隙里不显示）（2026-10-13 七）
- [ ] 拖拽握点**更高更大**（26px 高、12px 点阵，接近参考图比例）（2026-10-13 七）
- [ ] 增行/增列条带**宽度一致**（均 16px，较之前更小）、长度不变（横条通宽 / 竖条与表格同高）（2026-10-13 八）
- [ ] 表格**四周有留白**（上 22px / 下 32px + 左右 CM 行 32px padding）；**增行横条落在下留白内，不遮挡下一行内容**（2026-10-13 八）
- [ ] 拖动蓝胶囊**宽度窄一点**（定宽 16px）、**高度 = 行高**（行拖 = 被拖行高、列拖 = 首行高）（2026-10-13 八）
- [ ] 拖动行/列时**被拖项留在原位淡蓝高亮（不实时换位）**，**蓝色落点指示线**（行拖=横线通表宽 / 列拖=竖线通表高）随指针移动标出要拖动到的位置（行间/表底缘、列间/表右缘）；松手后线消失、按落点换位（对齐参考图，2026-10-13 九）
- [ ] **表头格普通点击进格编辑**（显示原始源码文本，Enter/失焦提交回写表头行，Esc 恢复；真拖动超阈值才取消编辑进列拖拽）（2026-10-13 十）
- [ ] **增行/增列条带紧贴表格边框**（无间隙：竖条左缘=表右缘、横条顶缘=表底缘），悬停表格本体不显、移到表缘即显（2026-10-13 十）
- [ ] **表格顶部留白收窄**（上留白 12px，顶部不再大面积空白；列握点中心 ≈ 表顶缘、表格在文档最顶时最多裁 2px）（2026-10-13 十）
- [ ] 设置→配色方案：默认=白底蓝、经典=旧暖灰；导出 md 的 data-color-scheme 透传正确（2026-10-12）
- [ ] 所见即所得下点面包屑标题 / 目录锚点 / 全局搜索结果：目标块先解罩、跳点准确（2026-10-12）

## 8. 推送与远程同步约定（2026-10-07 起）

- **只推 gitee（origin）**：`git push origin master`。本机 `origin` 已切到 SSH（`git@gitee.com:tizu/TizuMark-Markdown-Editor.git`），因本机无 gitee HTTPS 凭据。
- gitee 已配置到 github 的**镜像自动同步**：推 gitee 后由 gitee 自动同步到 `git@github.com:tizuio/TizuMark-Markdown-Editor.git`，**不再手动推 github**。
- 切换电脑后：任选 gitee / github 一端 clone 即可，两者内容一致。
- 分叉根因备忘：本地曾因「重建 git 基线」产生孤儿根提交 `20bec86` 并误带 `.git-broken-20261006` junk；已用 commit-tree 在 github master(64964fd) 上重建 C1/C2/C3 干净线性历史并快进推送，junk 已剔除。
