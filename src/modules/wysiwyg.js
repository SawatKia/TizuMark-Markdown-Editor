// 所见即所得核心：块级遮罩（Typora 式「光标进块显源码，移开即恢复渲染」）。
//
// 原理（单一数据源，不做 DOM→MD 逆序列化）：
//   文本层始终是 CM 里的真实 Markdown（唯一真相）；渲染结果只是**替换源码文本的视图**
//   （markText + replacedWith，CM 自动 collapsed 隐藏块内其余源码行）。
//   光标所在块撤掉替换、显源码；移开后按最新源码重渲染并替换。
//   因为从不把渲染 DOM 反推成 Markdown，公式/图表/callout 永不损坏。
//
// 块划分：首选 UnifiedRenderer.renderMarkdownBlocks —— 用 remark 解析器的 node.position
// 切块（与阅读模式同一套解析），逐块渲染才与阅读模式一致。手写行级切块器 splitBlocks
// 仅作渲染器不可用时的回退（它对 CommonMark 边界有系统性偏差，曾把 `1.` 独立行 +
// 缩进内容拆成两块，渲染出「只剩序号的空列表项」，2026-10-07 真机反馈）。
//
// 块高抖动（用户明确要求必须消除）：
//   切换块时「渲染态高度 ↔ 源码态高度」变化会让视口内容位移。
//   做法：切换前后同步测量光标的视口 y（cursorCoords 'window'），差值回滚 scrollTop，
//   全程同帧无 rAF（异步补偿本身就是可见跳动）。
(function () {
  'use strict';

  const MASK_CLASS = 'wysiwyg-block-mask';
  // 所见即所得下「块间空行」塌缩类：Typora 式段落间距。
  // 空行若按全高渲染，块与块之间会出现一整行空白（2026-10-07 真机反馈「间隔了很多空行」）；
  // 光标所在空行例外（要显示光标与占位提示），见 syncWysiwygActiveBlock。
  const BLANK_CLASS = 'cm-wysiwyg-blank';
  // 活动块（光标所在块、源码态）行高亮类：与渲染态块明显区分（2026-10-11 用户反馈 #5）。
  // 行号制跟踪（_wysiwygActiveLines）：编辑会使行号位移，输入防抖刷新重算块表后重新附着。
  const ACTIVE_CLASS = 'cm-wysiwyg-active-block';
  // 活动块「整块一体」观感（2026-10-13 用户反馈 #2：逐行小圆角不好看，要像一整块编辑区）：
  // 底色只挂 ACTIVE_CLASS（每行一条、连续无角），首/末行各额外挂一个类，CSS 只在首行上缘、
  // 末行下缘做圆角 → 多行块看起来是一个圆角矩形，而非一排各自带角的小条。
  const ACTIVE_FIRST_CLASS = 'cm-wysiwyg-active-first';
  const ACTIVE_LAST_CLASS = 'cm-wysiwyg-active-last';
  // 大文档虚拟遮罩：块数超过 maxBlocks 时渲染器只切边界不渲染（skipped），
  // 遮罩按视口 ±margin 行按需挂载（阶段3 计划项「大文档整合」的落地形式）
  const WYSIWYG_MAX_BLOCKS = 80;
  const WYSIWYG_VIEWPORT_MARGIN = 60;
  // 全量预渲染 + 全量视图驻留：行数 ≤ 该值时，进入所见即所得先在后台一次性渲染全部块（模式按钮
  // 显示「渲染中」），并把整篇文档设为 CM 视口——所有行恒渲染、行高恒实测、不释放不重估，几何自愈，
  // 根治快速滚动时的源码闪现与落点漂移（2026-10-09 用户实测需求）。超过该值仍走虚拟按需 + 增强预取。
  const WYSIWYG_FULL_RENDER_MAX_LINES = 10000;
  // 虚拟模式（>上限的大文档）增强预取边距（行）：沿滚动方向加大遮罩窗口，
  // 让用户到达之前遮罩已就绪（快速滚动零源码闪现）；尾随方向保持原边距防新露区闪
  const WYSIWYG_PREFETCH_MARGIN = 200;

  // ---- 块级行解析（不依赖 mdast：mdast-util-from-markdown 只是 remark 的传递依赖，
  //      把它提升为直接依赖需重打 unified-bundle，而那属于「构建」动作，需用户授权。
  //      故用行级状态机自研，语义与 CommonMark 块级结构对齐，且可独立单测。） ----

  const RE = {
    heading: /^#{1,6}(\s|$)/,
    fence: /^(`{3,}|~{3,})/,
    hr: /^(\s*)(-\s*|\*\s*|_\s*){3,}$/,
    ul: /^(\s*)([-*+])(\s+)/,
    ol: /^(\s*)(\d{1,9})([.)])(\s+)/,
    task: /^(\s*)([-*+])(\s+)\[[ xX]\]\s+/,
    quote: /^(\s*)>/,
    table: /^\s*\|/,
    // setext 标题：上一行文本 + 本行 === / ---
    setext: /^(\s*)(=+|-+)\s*$/,
    // 缩进代码块：4 空格 / 制表符
    indentedCode: /^(\t| {4,})\S/,
  };

  function isBlank(s) { return (s || '').trim() === ''; }

  // 判断「列表能否延续到下一行」：下一个非空行是同级/更深缩进的列表项、或是列表的续行（缩进内容）
  function listContinues(nextLine) {
    if (isBlank(nextLine)) return false;
    return RE.ul.test(nextLine) || RE.ol.test(nextLine) || RE.task.test(nextLine) ||
           /^\s{2,}\S/.test(nextLine);
  }

  // 切分顶层块。返回 [{ start, end, lines }]，start/end 为 0-based 开区间 [start, end)。
  // 规则要点：
  //   - 空行只作分隔，不归属任何块（故块内不含空行）
  //   - 围栏吃到闭合围栏为止，内部 # / | / 空行都不切
  //   - 表格连续 | 行归一块
  //   - 列表（无序/有序/任务/嵌套）连续行归一块
  //   - 引用（含 callout、嵌套）连续 > 行归一块
  //   - 水平线 / 标题 / 分割线各自成块
  //   - 文档开头的 --- ... --- 视为 front matter 一块
  function splitBlocks(lines) {
    const arr = lines || [];
    const total = arr.length;
    const blocks = [];
    let i = 0;

    // front matter：首行 --- 且能找到闭合 ---
    if (total && arr[0].trim() === '---') {
      let close = -1;
      for (let k = 1; k < total; k++) {
        if (arr[k].trim() === '---') { close = k; break; }
      }
      if (close > 0) {
        blocks.push({ start: 0, end: close + 1, lines: arr.slice(0, close + 1) });
        i = close + 1;
      }
    }

    while (i < total) {
      if (isBlank(arr[i])) { i++; continue; }
      const start = i;
      const cur = arr[i];
      const curTrim = cur.trim();

      // 1) 围栏代码块
      const fence = curTrim.match(RE.fence);
      if (fence) {
        const marker = fence[1][0];
        const closeRe = new RegExp('^\\s*' + marker + '{3,}\\s*$');
        i++;
        while (i < total && !closeRe.test(arr[i])) i++;
        if (i < total) i++; // 含闭合行
        blocks.push({ start, end: i, lines: arr.slice(start, i) });
        continue;
      }

      // 2) 水平线（须在块首，避免把 setext 的 --- 误判）
      if (RE.hr.test(cur) && RE.hr.test(curTrim)) {
        i++;
        blocks.push({ start, end: i, lines: arr.slice(start, i) });
        continue;
      }

      // 3) ATX 标题：单行
      if (RE.heading.test(cur)) {
        i++;
        blocks.push({ start, end: i, lines: arr.slice(start, i) });
        continue;
      }

      // 4) 表格：连续 | 行（含分隔行）
      if (RE.table.test(cur)) {
        i++;
        while (i < total && RE.table.test(arr[i]) && !isBlank(arr[i])) i++;
        blocks.push({ start, end: i, lines: arr.slice(start, i) });
        continue;
      }

      // 5) 引用块 / callout：连续 > 行（允许 callout 内含空行？否——空行即分隔）
      if (RE.quote.test(cur)) {
        i++;
        while (i < total && (RE.quote.test(arr[i]) || (isBlank(arr[i]) && i + 1 < total && RE.quote.test(arr[i + 1])))) {
          if (isBlank(arr[i])) i++; // 吃掉 callout 中的空行
          i++;
        }
        blocks.push({ start, end: i, lines: arr.slice(start, i) });
        continue;
      }

      // 6) 列表（无序/有序/任务/嵌套）：连续列表行 + 其缩进续行
      if (RE.ul.test(cur) || RE.ol.test(cur) || RE.task.test(cur)) {
        i++;
        while (i < total) {
          if (isBlank(arr[i])) {
            // 空行后若仍是列表项则属同一块（松散列表），否则结束
            let k = i;
            while (k < total && isBlank(arr[k])) k++;
            const cont = k < total && (RE.ul.test(arr[k]) || RE.ol.test(arr[k]) || RE.task.test(arr[k]));
            if (!cont) break;
            i = k;
            continue;
          }
          if (RE.ul.test(arr[i]) || RE.ol.test(arr[i]) || RE.task.test(arr[i]) || listContinues(arr[i])) { i++; continue; }
          break;
        }
        blocks.push({ start, end: i, lines: arr.slice(start, i) });
        continue;
      }

      // 7) setext 标题（文本行 + 下一行 === / ---）
      if (i + 1 < total && !isBlank(cur) && RE.setext.test(arr[i + 1]) && !RE.hr.test(arr[i + 1].trim() + '  -')) {
        // 仅当下一行是纯 === 或 ---（不含其它内容）
        if (/^\s*=+\s*$/.test(arr[i + 1]) || /^\s*-{3,}\s*$/.test(arr[i + 1])) {
          i += 2;
          blocks.push({ start, end: i, lines: arr.slice(start, i) });
          continue;
        }
      }

      // 8) 缩进代码块
      if (RE.indentedCode.test(cur)) {
        i++;
        while (i < total && (isBlank(arr[i]) || /^\s{4,}/.test(arr[i]) || arr[i].trim() === '')) {
          if (isBlank(arr[i])) {
            let k = i;
            while (k < total && isBlank(arr[k])) k++;
            if (k < total && /^\s{4,}/.test(arr[k])) { i = k; continue; }
            break;
          }
          i++;
        }
        blocks.push({ start, end: i, lines: arr.slice(start, i) });
        continue;
      }

      // 9) 兜底：普通段落，吃到下一个块起点或空行为止
      i++;
      while (i < total && !isBlank(arr[i]) &&
             !RE.heading.test(arr[i]) && !RE.fence.test(arr[i].trim()) &&
             !RE.table.test(arr[i]) && !RE.quote.test(arr[i]) &&
             !(RE.ul.test(arr[i]) || RE.ol.test(arr[i]) || RE.task.test(arr[i])) &&
             !RE.hr.test(arr[i])) {
        i++;
      }
      blocks.push({ start, end: i, lines: arr.slice(start, i) });
    }

    return blocks;
  }

  // ---------- 表格行纯函数（Phase 2 单元格就地编辑 / R5，2026-10-13） ----------
  // 把 markdown 表格行切成单元格源码数组。单元格内 \| 视为字面竖线不切分；
  // 记录原行首/行尾是否有竖线（重建时保留原有写法，不强行加/去外管）。
  // 返回 { cells, hasLeading, hasTrailing }；cells 已 trim（remark 忽略单元格首尾空白）。
  function splitTableRow(rowText) {
    let s = String(rowText == null ? '' : rowText).trim();
    let hasLeading = false, hasTrailing = false;
    if (s.charAt(0) === '|') { hasLeading = true; s = s.slice(1); }
    if (s.length > 0 && s.charAt(s.length - 1) === '|') { hasTrailing = true; s = s.slice(0, -1); }
    const cells = [];
    let cur = '';
    for (let i = 0; i < s.length; i++) {
      const c = s.charAt(i);
      if (c === '\\' && i + 1 < s.length && s.charAt(i + 1) === '|') { cur += '\\|'; i++; continue; }
      if (c === '|') { cells.push(cur); cur = ''; continue; }
      cur += c;
    }
    cells.push(cur);
    for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim();
    return { cells: cells, hasLeading: hasLeading, hasTrailing: hasTrailing };
  }

  // 把第 colIdx 个单元格回写进表格行：保留行首/行尾竖线风格，新文本中裸 | 自动转义为 \|
  // （先解旧转义再整体转义：原 \| 保持 \|，新敲的 | 变 \|）。
  // 返回新行文本；colIdx 越界时原样返回（调用方视为回写失败，不破坏原行）。
  function editTableRowCell(rowText, colIdx, newText) {
    const t = String(rowText == null ? '' : rowText);
    const info = splitTableRow(t);
    if (!isFinite(colIdx) || colIdx < 0 || colIdx >= info.cells.length) return t;
    let txt = String(newText == null ? '' : newText).replace(/[\r\n]+/g, ' ').trim();
    txt = txt.replace(/\\\|/g, '|').replace(/\|/g, '\\|');
    info.cells[colIdx] = txt;
    const joined = info.cells.join(' | ');
    return (info.hasLeading ? '| ' : '') + joined + (info.hasTrailing ? ' |' : '');
  }

  // ---------- 表格结构纯函数（2026-10-13 用户要求：增行/增列/拖拽换位） ----------
  // tableText = 表格块的源码文本（行 0 = 表头行，行 1 = 分隔行，其余 = 数据行）。
  // 与 editTableRowCell 同一风格约定：保留首/尾竖线风格，竖线用 ' | ' 连接，
  // 空单元格写作空格（remark 按 trim 解析为空）。所有函数对畸形输入返回 null（增列/增行）
  // 或原样返回（移动），由调用方兜底，不破坏原文。

  // 解析表格结构：{ lines, colCount, hasLeading, hasTrailing, dataLines }；非法返回 null
  function parseTableStructure(tableText) {
    const lines = String(tableText == null ? '' : tableText).split('\n');
    if (lines.length < 2) return null;
    const head = splitTableRow(lines[0]);
    const colCount = head.cells.length;
    if (colCount === 0) return null;
    return {
      lines: lines, colCount: colCount,
      hasLeading: head.hasLeading, hasTrailing: head.hasTrailing,
      dataLines: lines.slice(2),
    };
  }

  // 按单元格数组 + 行风格重建表格行（格内裸 | 自动转义，与 editTableRowCell 同规则）
  function buildTableLine(cells, style) {
    const esc = (t) => String(t == null ? '' : t)
      .replace(/\\\|/g, '|').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').trim();
    const joined = cells.map(esc).join(' | ');
    return (style.hasLeading ? '| ' : '') + joined + (style.hasTrailing ? ' |' : '');
  }

  // 末尾增一空行（格数与表头一致）；返回新表格文本
  function addTableRow(tableText) {
    const t = parseTableStructure(tableText);
    if (!t) return null;
    const empty = [];
    for (let i = 0; i < t.colCount; i++) empty.push('');
    return t.lines.concat(buildTableLine(empty, t)).join('\n');
  }

  // 末尾增一空列（每行 +1 格，分隔行补 '---'）；返回新表格文本
  function addTableColumn(tableText) {
    const t = parseTableStructure(tableText);
    if (!t) return null;
    const out = t.lines.map((ln, i) => {
      const info = splitTableRow(ln);
      const cells = info.cells.slice(0, t.colCount);
      while (cells.length < t.colCount) cells.push(i === 1 ? '---' : '');
      cells.push(i === 1 ? '---' : '');
      return buildTableLine(cells, t);
    });
    return out.join('\n');
  }

  // 移动一行：fromIdx/toIdx 为「行序列」下标（0 = 表头行，1 = 首个数据行；分隔行不计位，
  // 恒在源码第 2 行）；越界/同位 = 原样返回。返回新表格文本
  function moveTableRow(tableText, fromIdx, toIdx) {
    const t = parseTableStructure(tableText);
    if (!t) return null;
    const rows = [t.lines[0]].concat(t.dataLines);
    if (!isFinite(fromIdx) || !isFinite(toIdx) ||
        fromIdx < 0 || fromIdx >= rows.length || toIdx < 0 || toIdx >= rows.length ||
        fromIdx === toIdx) return String(tableText);
    const moved = rows.splice(fromIdx, 1)[0];
    rows.splice(toIdx, 0, moved);
    return rows[0] + '\n' + t.lines[1] + '\n' + rows.slice(1).join('\n');
  }

  // 移动一列：fromIdx/toIdx 为列下标（0 起）；每行（含分隔行，对齐标记随列移动）同步换位；
  // 越界/同位 = 原样返回。返回新表格文本
  function moveTableColumn(tableText, fromIdx, toIdx) {
    const t = parseTableStructure(tableText);
    if (!t) return null;
    if (!isFinite(fromIdx) || !isFinite(toIdx) ||
        fromIdx < 0 || fromIdx >= t.colCount || toIdx < 0 || toIdx >= t.colCount ||
        fromIdx === toIdx) return String(tableText);
    const out = t.lines.map((ln, i) => {
      const info = splitTableRow(ln);
      const cells = info.cells.slice(0, t.colCount);
      while (cells.length < t.colCount) cells.push(i === 1 ? '---' : '');
      const moved = cells.splice(fromIdx, 1)[0];
      cells.splice(toIdx, 0, moved);
      return buildTableLine(cells, t);
    });
    return out.join('\n');
  }

  // 行内语法渲染化 span 扫描（2026-10-14 用户要求，Typora 式行内）：对活动块的一行源文
  // 单遍扫描产品支持的行内语法，返回 [{ from, to, cls }] text marker 段表：
  //   标记段（** / * / _ / ` / [ ] (url) / ~~ / == / <u></u>）→ wysiwyg-inline-marker
  //     （透明、**保留真实宽度**——光标测量精准，2026-10-14 列表符号 width:0 裁掉
  //      ::before 的教训同此：绝不用 width:0/overflow:hidden）
  //   文本段 → wysiwyg-bold / wysiwyg-italic / wysiwyg-inline-code / wysiwyg-strike /
  //     wysiwyg-highlight / wysiwyg-underline / wysiwyg-inline-link
  //     （观感对齐 preview-content 对应元素）
  // 优先级：行内代码 > 链接 > 粗体 > 斜体 > 删除线 > 高亮 > 下划线；按位置顺序消费、
  // 不重叠（MVP 不做嵌套，如 **a `b` c** 整段按粗体；<u>**x**</u> 整段按下划线）。
  // 图片行 ![]() 不解析（图片活动态是独立机制）；下划线变体加词内守卫（snake_case
  // 不误判）；<u> 为渲染器放行的原生 HTML 标签（unified-renderer L1514），仅单标签
  // 成对、不含嵌套标签/换行的行内形态参与装饰。围栏块/表格/frontmatter 由调用方
  // 排除。删除任一标记字符 → 不再成对 → change 钩子重算即自动去样式。
  function parseWysiwygInlineSpans(text) {
    const spans = [];
    if (text == null) return spans;
    const s = String(text);
    const push = (from, to, cls) => { if (to > from) spans.push({ from: from, to: to, cls: cls }); };
    const reCode = /``([^`\n]+)``|`([^`\n]+)`/;
    const reLink = /\[([^\[\]\n]+)\]\(([^()\n]*)\)/;
    const reBoldStar = /\*\*([^*\n]+)\*\*/;
    const reBoldUnder = /__([^_\n]+)__/;
    const reItStar = /\*([^*\n]+)\*/;
    const reItUnder = /_([^_\n]+)_/;
    const reStrike = /~~([^~\n]+)~~/;
    const reHighlight = /==([^=\n]+)==/;
    const reUnderline = /^<u>([^<\n]+)<\/u>/;
    // 下划线变体词内守卫：前/后邻接字母数字下划线即视为标识符（snake_case），不成语法
    const isWordish = (ch) => !!ch && /[A-Za-z0-9_]/.test(ch);
    let i = 0;
    while (i < s.length) {
      let m = null;
      let kind = null;
      const c = s.charAt(i);
      if (c === '`') {
        m = reCode.exec(s.slice(i));
        if (m) kind = 'code';
      } else if (c === '[') {
        if (i > 0 && s.charAt(i - 1) === '!') { i++; continue; } // 图片行保持源码
        m = reLink.exec(s.slice(i));
        if (m) kind = 'link';
      } else if (c === '*') {
        m = reBoldStar.exec(s.slice(i));
        if (m) kind = 'bold';
        else { m = reItStar.exec(s.slice(i)); if (m) kind = 'ital'; }
      } else if (c === '_') {
        // 词内守卫：开/闭 `_` 紧邻字母数字下划线 → 标识符（snake_case），不成语法
        if (!isWordish(s.charAt(i - 1))) {
          const bM = reBoldUnder.exec(s.slice(i));
          const tM = bM ? null : reItUnder.exec(s.slice(i));
          const picked = bM || tM;
          if (picked && !isWordish(s.charAt(i + picked[0].length))) {
            m = picked;
            kind = bM ? 'bold' : 'ital';
          }
        }
        if (!m) { i++; continue; }
      } else if (c === '~') {
        m = reStrike.exec(s.slice(i));
        if (m) kind = 'strike';
      } else if (c === '=') {
        m = reHighlight.exec(s.slice(i));
        if (m) kind = 'highlight';
      } else if (c === '<') {
        m = reUnderline.exec(s.slice(i));
        if (m) kind = 'underline';
      }
      if (!m) { i++; continue; }
      const start = i;
      const end = i + m[0].length;
      if (kind === 'code') {
        const tick = (m[1] !== undefined) ? 2 : 1;
        push(start, start + tick, 'wysiwyg-inline-marker');
        push(start + tick, end - tick, 'wysiwyg-inline-code');
        push(end - tick, end, 'wysiwyg-inline-marker');
      } else if (kind === 'link') {
        push(start, start + 1, 'wysiwyg-inline-marker');
        push(start + 1, start + 1 + m[1].length, 'wysiwyg-inline-link');
        push(start + 1 + m[1].length, end, 'wysiwyg-inline-marker');
      } else if (kind === 'underline') {
        // 开/闭标签宽度不对称（<u> 3 字符 / </u> 4 字符），不走对称 tick 分支
        push(start, start + 3, 'wysiwyg-inline-marker');
        push(start + 3, end - 4, 'wysiwyg-underline');
        push(end - 4, end, 'wysiwyg-inline-marker');
      } else {
        const tick = (kind === 'ital') ? 1 : 2;
        const cls = 'wysiwyg-' + (kind === 'ital' ? 'italic' : kind === 'strike' ? 'strike' : kind === 'highlight' ? 'highlight' : 'bold');
        push(start, start + tick, 'wysiwyg-inline-marker');
        push(start + tick, end - tick, cls);
        push(end - tick, end, 'wysiwyg-inline-marker');
      }
      i = end;
    }
    return spans;
  }
  const mixin = {
    // 把整篇源码切成顶层块：[{ start, end, html? }]，end 为 0-based 开区间。
    //
    // ⚠️ 首选 remark 解析器切块（UnifiedRenderer.renderMarkdownBlocks）：与阅读模式
    // 同一套解析，逐块渲染才可能与阅读模式完全一致。手写 splitBlocks 与 CommonMark
    // 边界有系统性偏差（实测 `1.` 独立行 + 缩进内容被拆开 → 渲染出「只剩序号的空列表项」，
    // 2026-10-07 真机反馈「带有序号的空行」），仅作渲染器不可用时的回退。
    // parseOnly：只切块边界不渲染 html（skipHtml）——全量模式输入后的增量刷新只需新块边界，
    // 未变块的 markText 标记由 CM 自动跟随文本（marker.find() 实时位置），仅重挂变化块。
    computeWysiwygBlocks(parseOnly) {
      const cm = this.cm;
      if (!cm || !cm.lineCount) return [];
      if (typeof UnifiedRenderer !== 'undefined' && UnifiedRenderer.renderMarkdownBlocks) {
        const blocks = UnifiedRenderer.renderMarkdownBlocks(cm.getValue(), {
          softBreaks: this.settings.softBreaks,
          tabSize: this.settings.tabSize,
          extendedSyntax: this.settings.extendedSyntax,
          skipHtml: !!parseOnly,
          maxBlocks: parseOnly ? undefined : WYSIWYG_MAX_BLOCKS,
        });
        if (blocks) return blocks; // [{ start, end, html }]
      }
      const lines = [];
      for (let i = 0; i < cm.lineCount(); i++) lines.push(cm.getLine(i));
      return splitBlocks(lines);
    },

    // 全量预渲染（后台步骤）：全部块边界 + 全部块 html 一次渲染完成（唯一昂贵步骤，
    // 1–3 秒量级）。返回带 html 的块表；解析失败等异常返回 null 由调用方兜底。
    precomputeWysiwygBlocksFull() {
      const cm = this.cm;
      if (!cm || !cm.lineCount || cm.lineCount() === 0) return null;
      let blocks = null;
      if (typeof UnifiedRenderer !== 'undefined' && UnifiedRenderer.renderMarkdownBlocks) {
        blocks = UnifiedRenderer.renderMarkdownBlocks(cm.getValue(), {
          softBreaks: this.settings.softBreaks,
          tabSize: this.settings.tabSize,
          extendedSyntax: this.settings.extendedSyntax,
          maxBlocks: Infinity, // 一块不跳：全量预渲染
        });
      }
      if (!blocks) {
        // 回退切块器（无 html，遮罩时按需渲染）
        const lines = [];
        for (let i = 0; i < cm.lineCount(); i++) lines.push(cm.getLine(i));
        blocks = splitBlocks(lines);
      }
      // 防御：滤掉畸形条目（缺 start/end 的 undefined 元素会让下游读 .start 抛
      // "Cannot read properties of undefined"；HMR 混载旧模块时实测出现过，2026-10-12）
      blocks = blocks.filter((b) => b && typeof b.start === 'number' && typeof b.end === 'number' && b.end > b.start);
      // 块源文本 = 增量刷新的同一性键（源未变 → 标记/高度可保留）
      for (const b of blocks) b.src = this._wysiwygBlockSource(b);
      return blocks;
    },

    // 块的源文本切片（同一性键）
    _wysiwygBlockSource(b) {
      const cm = this.cm;
      if (!cm || !b) return '';
      const total = cm.lineCount();
      const end = Math.min(b.end, total);
      const parts = [];
      for (let i = b.start; i < end; i++) parts.push(cm.getLine(i));
      return parts.join('\n');
    },

    // 光标所在块的索引；不在任何块内（空行/文档尾）返回 -1
    wysiwygBlockIndexAt(line) {
      const blocks = this._wysiwygBlocks || [];
      for (let k = 0; k < blocks.length; k++) {
        if (line >= blocks[k].start && line < blocks[k].end) return k;
      }
      return -1;
    },

    // 遮罩点击专用：块表可能滞后于输入（change 后的 250ms 防抖刷新未触发），实时行号
    // 查旧表会漏块返回 -1 → setWysiwygActiveBlock(-1) 会撤掉当前活动块 → 整篇瞬间全遮罩
    // 闪一下（防抖后才自愈）。-1 时先同步轻切块（parseOnly：只切边界不渲染 HTML，廉价），
    // 用最新块表再查；防抖刷新随后照常跑（结果相同，幂等）。
    _wysiwygBlockIndexAtFresh(line) {
      let idx = this.wysiwygBlockIndexAt(line);
      if (idx < 0) {
        try { this._wysiwygBlocks = this.computeWysiwygBlocks(true) || this._wysiwygBlocks; } catch (_) { /* 保留旧表 */ }
        idx = this.wysiwygBlockIndexAt(line);
      }
      return idx;
    },

    // ---------------- 渲染 ----------------

    // 渲染单个块的最新源码为 HTML；失败返回 ''（调用方据此保持源码态）
    renderWysiwygBlockHtml(start, end) {
      const cm = this.cm;
      const lines = [];
      const total = cm.lineCount();
      for (let i = start; i < end && i < total; i++) lines.push(cm.getLine(i));
      const src = lines.join('\n');
      if (!src.trim()) return '';
      try {
        if (typeof UnifiedRenderer === 'undefined' || !UnifiedRenderer.renderMarkdown) return '';
        return UnifiedRenderer.renderMarkdown(src, {
          softBreaks: this.settings.softBreaks,
          tabSize: this.settings.tabSize,
          extendedSyntax: this.settings.extendedSyntax,
        }) || '';
      } catch (err) {
        console.error('[wysiwyg] 块渲染失败，保持源码态:', err);
        return '';
      }
    },

    // 给单个块盖遮罩（已存在则先撤掉重建）
    //
    // ⚠️ 三点踩坑史（2026-10-06 真机反馈后定型）：
    //   1) **不能用 addLineWidget**：只在行下方「附加」，不隐藏源码行 → 源码与渲染重复显示。
    //      必须 markText + replacedWith，把源码文本**真正替换**掉。
    //   2) 遮罩节点必须带 `preview-content` 类：预览排版 CSS 的作用域是 `.preview-content xxx`
    //      （styles.css 1801 起），不带该类则标题/表格/列表全部无样式，渲染完全走形。
    //   3) **不能设 pointer-events:none**：那是 overlay 时代的写法；文本已被替换，
    //      pointer-events:none 会让点击穿透到空白，CM 的坐标映射拿不到有效位置 → 点不进块。
    //      改为遮罩自己 mousedown 接管，按点击纵向比例估算目标源码行，确定性可控。
    maskWysiwygBlock(idx) {
      const cm = this.cm;
      if (!cm || !this._wysiwygBlocks) return;
      const b = this._wysiwygBlocks[idx];
      if (!b) return;
      if (!this._wysiwygMarks) this._wysiwygMarks = new Map();
      this.unmaskWysiwygBlock(idx);

      // 有缓存 html（remark 切块时已逐块渲染）直接用；否则现渲染（回退路径/旧块内容已变）
      const html = (!b.skipped && b.html !== undefined) ? b.html : this.renderWysiwygBlockHtml(b.start, b.end);
      if (!html) return;

      const total = cm.lineCount();
      const lastLine = Math.min(b.end - 1, total - 1);
      if (lastLine < b.start) return;
      const from = { line: b.start, ch: 0 };
      const to = { line: lastLine, ch: cm.getLine(lastLine).length };
      if (to.line === from.line && to.ch <= from.ch) return;

      const node = document.createElement('div');
      node.className = MASK_CLASS + ' preview-content';
      node.innerHTML = html;
      node.setAttribute('data-block-index', String(idx));
      node.setAttribute('contenteditable', 'false');
      this._wysiwygMaskTypography(node);
      this._postProcessWysiwygNode(node);
      this._addWysiwygEditButton(node);
      this._addWysiwygTableTools(node);

      let mark = null;
      const self = this;
      // 点击接管：把点击处的纵向比例映射到块内源码行，让光标落在用户点的那一行附近。
      // marker.find() 拿的是 CM 维护的实时位置（编辑后自动跟shift），故块划分变化也不会错位。
      node.addEventListener('mousedown', (ev) => {
        ev.stopPropagation();
        // 表格拖拽进行中（pointerdown 先启动：行/列把手轨道、首格左缘区、表头格）：
        // mousedown 是同一次按下的伴随事件，必须吞掉——落到下方「按点击纵比映射源码行」
        // 会撤罩表格块 + 挪光标，拖拽半途表格变源码（2026-10-13 轨道常驻后 gutter 按下
        // 的目标是轨道 span，非单元格，单元格分支的守卫罩不住它）。
        // 例外（2026-10-13 反馈 #2：表头也要可以编辑）：从表头格自身启动的列拖态放行
        // 到下方单元格分支进格编辑；指针真超阈值移动时 _wysiwygTableDragMove 阈值块
        // 只取消「本次按下才触发」的格编辑（按下前已存在的合法编辑保留到释放时提交，
        // 见 _wysiwygBeginTableDrag 的 cellEditAtDown 与 _wysiwygTableDragUp）。
        if (self._wysiwygTableDrag) {
          const cEl = ev.target && ev.target.closest ? ev.target.closest('td,th') : null;
          const stNow = self._wysiwygTableDrag;
          const ownHeader = cEl && stNow && stNow.kind === 'col' && stNow.trs && stNow.trs[0] &&
            cEl === stNow.trs[0].children[stNow.idx];
          if (!ownHeader) { ev.preventDefault(); return; }
        }
        // 正在编辑的本格：mousedown 交给浏览器原生文本选择（2026-10-14 用户要求：单元格
        // 文字也要支持选中）。必须在 preventDefault 之前 return——preventDefault 会杀死
        // 原生选择；不提交、不重进编辑（重进会先提交+重落光标，反把拖选打断）。
        // CSS 侧配合：.wysiwyg-cell-editing 恢复 user-select:text（遮罩节点默认 none）。
        const hitCell = ev.target && ev.target.closest ? ev.target.closest('td,th') : null;
        if (hitCell && self._wysiwygCellEditing && hitCell === self._wysiwygCellEditing.cell) return;
        // 代码块复制按钮：放行 click（拦截 mousedown 会吞掉 click、光标被拽到源码行，
        // 复制按钮点不动）。按钮自身已阻止冒泡，这里只需不 preventDefault。
        if (ev.target && ev.target.closest && ev.target.closest('button.copy-btn')) return;
        // 块编辑按钮（2026-10-11 用户反馈 #4）：显式「进入本块编辑」入口——先取标记
        // 实时位置（撤遮罩后 mark 失效），再撤遮罩并把光标定位到块首行。
        const editBtnEl = ev.target && ev.target.closest ? ev.target.closest('button.block-edit-btn') : null;
        if (editBtnEl) {
          ev.preventDefault();
          try {
            const r = mark && mark.find ? mark.find() : null;
            if (r) {
              // 先解罩目标块再落光标（与点击定位同一 CM5 clamp 问题）；活动块索引按「目标行」查
              //（Fresh：防抖窗口内的点击块表滞后，-1 会误撤当前活动块 → 整篇遮罩闪烁）
              self.setWysiwygActiveBlock(self._wysiwygBlockIndexAtFresh(r.from.line));
              cm.setSelection({ line: r.from.line, ch: 0 }, { line: r.from.line, ch: 0 }, { scroll: false, origin: '*mouse' });
              try { cm.scrollIntoView({ line: r.from.line, ch: 0 }, 40); } catch (_) { }
              cm.focus();
            }
          } catch (_) { /* 标记已失效则忽略本次点击 */ }
          return;
        }
        ev.preventDefault();
        try {
          // 格编辑中 + 按下点在本格以外的任何处（另一格 / 表 wrap 留白 / 另一块遮罩 /
          // 图片 / 图表 / 工具按钮 / 链接 / 复选框）：先提交本格失焦（2026-10-14 用户要求：
          // 点击其他行或空白处时单元格失去焦点）。settle=false：不挪光标、不抢焦点、不补
          // 空行——光标/焦点由下方各分支接管（另一格 → 新格接管；另一块 → 点击映射落光标；
          // 表 wrap 留白 → 焦点自然归 body）。点本格已在上方 return（原生文本选择）。
          // 下方分支自带的 commit-first（_wysiwygTableAdd/_wysiwygStartCellEdit）此刻为 no-op。
          if (self._wysiwygCellEditing) self._wysiwygEndCellEdit(true, false);
          // 图片：打开灯箱（与阅读模式一致）。src 未就绪（相对路径/裂图）时落到行定位，
          // 方便直接编辑图片这一行。
          const imgEl = ev.target && ev.target.closest ? ev.target.closest('img') : null;
          if (imgEl) {
            const imgSrc = imgEl.getAttribute('src');
            if (imgSrc && /^(data:|https?:|blob:)/.test(imgSrc) && self.showImageLightbox) {
              self.showImageLightbox(imgSrc);
              return;
            }
          }
          // Mermaid 图表：打开图表查看器（与阅读模式一致，锚点取容器内 svg）
          const mermaidEl = ev.target && ev.target.closest ? ev.target.closest('.mermaid-container') : null;
          if (mermaidEl) {
            const svg = mermaidEl.querySelector('svg');
            if (svg && self.showLightbox) self.showLightbox(svg, 'svg');
            return;
          }
          // 表格工具按钮：右下「＋」增行 / 右缘「＋」增列（2026-10-13 用户要求，Typora 式）
          // → 纯函数重建整块回写（行数可能变）→ 自动格编辑新格
          const toolBtn = ev.target && ev.target.closest ? ev.target.closest('.wysiwyg-table-add-row, .wysiwyg-table-add-col') : null;
          if (toolBtn) {
            ev.preventDefault();
            const maskNodeNow = toolBtn.closest('.' + MASK_CLASS);
            if (maskNodeNow) self._wysiwygTableAdd(toolBtn.classList.contains('wysiwyg-table-add-row') ? 'row' : 'col', maskNodeNow);
            return;
          }
          // 表格单元格：点格子 → **该格就地源码编辑**（Phase 2 / R5，2026-10-13，
          // 参考 Typora/有道云笔记「渲染态格内编辑」）。整张表保持遮罩（只有格在编辑），
          // 不再走旧行为「点表格整块变源码」——整块源码入口保留在块右上「编辑」按钮。
          // 格内链接 + Ctrl/Cmd = 跟随链接（落到下方链接分支）；其余点格一律进单元格编辑。
          const cellEl = ev.target && ev.target.closest ? ev.target.closest('td,th') : null;
          if (cellEl && !(cellEl.closest('a') && (ev.ctrlKey || ev.metaKey))) {
            // 行拖拽 / 顶 gutter 列拖拽已在 pointerdown（先于 mousedown）启动：不启动格编辑。
            // 例外（2026-10-13 反馈 #2：表头也要可以编辑）：表头格是列拖拽把手，但普通
            // 点击（不动）仍应进格编辑——从本表头格自身启动的列拖态放行；指针真超阈值
            // 移动时 _wysiwygTableDragMove 阈值块会先 _wysiwygEndCellEdit(false) 取消
            // 「本次按下才触发」的格编辑再进入拖拽；按下前已存在的格编辑保留（释放时提交，
            // 2026-10-14 用户反馈：改完格内容立即拖行/列不得丢内容）。
            const dragSt = self._wysiwygTableDrag;
            if (dragSt) {
              const isOwnHeaderDrag = dragSt.kind === 'col' && dragSt.trs && dragSt.trs[0] &&
                cellEl === dragSt.trs[0].children[dragSt.idx];
              if (!isOwnHeaderDrag) return;
            }
            const trNow = cellEl.closest('tr');
            const tableNow = cellEl.closest('table');
            const trsNow = tableNow ? Array.from(tableNow.querySelectorAll('tr')) : [];
            // 传点击坐标（viewport）→ 光标落到点击处而非整格全选（用户反馈 #3）
            self._wysiwygStartCellEdit(cellEl,
              trNow ? trsNow.indexOf(trNow) : -1,
              trNow ? Array.from(trNow.children).indexOf(cellEl) : -1,
              { x: ev.clientX, y: ev.clientY });
            return;
          }
          // 表格块遮罩内的其余点击（wrap 上/下留白等杂点）：吞掉不动作——单元格/行列拖
          // 轨道/增行增列条带/块编辑按钮都已在上方分支派完；再落入下方「按纵向比例映射
          // 源码行」会整表撤罩变源码态。整表源码的唯一入口 = 块右上「编辑」按钮
          // （2026-10-14 用户要求：只有点编辑按钮才进源码编辑模式）。
          if (node.querySelector && node.querySelector('.wysiwyg-table-wrap')) return;
          // 链接：与阅读模式同一分派（页内锚点滚动 / 外链系统浏览器 / .md 开 tab）
          const linkEl = ev.target && ev.target.closest ? ev.target.closest('a') : null;
          if (linkEl && self.handlePreviewLinkClick) {
            self.handlePreviewLinkClick(linkEl);
            return;
          }
          // 任务复选框：渲染态直接切换（与阅读模式行为一致，阶段2 计划项）。
          // 渲染 HTML 带 data-source-line（勾选框同步的同一机制），可精确回写源码行。
          const box = ev.target && ev.target.closest ? ev.target.closest('input[type="checkbox"]') : null;
          if (box && !box.disabled) {
            self.toggleWysiwygTaskCheckbox(box);
            return;
          }
          const r = mark && mark.find ? mark.find() : null;
          if (!r) return;

          // ⚠️ 定位光标前必须先 setWysiwygActiveBlock 撤掉本块遮罩（2026-10-09 实测）：
          //    CM5 对落在 replacedWith 标记区间**内部**的 setSelection 位置会钳制到标记
          //    首/末端——先落光标后撤遮罩（原实现走 cursorActivity 撤遮罩），光标恒落到
          //    块首/块尾行，点块中间永远点不准；撤掉标记后目标行才是真实源码行。
          //    活动块索引按「目标行」查（增量刷新后闭包 idx 可能已位移，行→块才是准的）。

          // 其余块：按点击纵向比例映射到块内源码行
          //（表格格点击已在上方路由到 _wysiwygStartCellEdit 就地编辑，不再整块变源码）
          const rect = node.getBoundingClientRect();
          let target = r.from.line;
          if (rect.height > 0 && r.to.line > r.from.line) {
            const ratio = Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height));
            target = r.from.line + Math.floor(ratio * (r.to.line - r.from.line));
          }
          const line = Math.min(Math.max(target, 0), cm.lineCount() - 1);
          // Fresh：输入后 250ms 防抖窗口内点遮罩时块表行号滞后 → 旧表漏块 -1 → 误撤
          // 当前活动块（整篇瞬间全遮罩闪烁）；-1 时同步轻切块（parseOnly）再查。
          self.setWysiwygActiveBlock(self._wysiwygBlockIndexAtFresh(line));
          // 点击锚定：撤遮罩后把该源码行放回点击时的屏幕位置，杜绝点击后视口乱跳
          self._wysiwygClickAnchor = { y: ev.clientY, line };
          // 同上：scroll:false，避免 ensureCursorVisible 抢先滚动导致锚定失效
          cm.setSelection({ line, ch: cm.getLine(line).length },
            { line, ch: cm.getLine(line).length }, { scroll: false, origin: '*mouse' });
          cm.focus();
          self._applyWysiwygClickAnchor();
        } catch (_) { /* 标记已失效则忽略本次点击 */ }
      });

      // 表格行/列拖拽换位（2026-10-13 用户要求，Typora 式）：pointerdown 先于 mousedown，
      // 行拖拽从首格左侧 16px 把手区启动（直接 preventDefault，不触发格编辑）；
      // 列拖拽从表头格按下启动、移动超 4px 阈值才真正进入拖拽（不动 = 普通格编辑）。
      node.addEventListener('pointerdown', (ev) => {
        const grabbed = self._wysiwygTableDragStart(ev);
        if (grabbed) ev.preventDefault();
      });

      try {
        mark = cm.markText(from, to, {
          replacedWith: node,
          clearWhenEmpty: false,
          inclusiveLeft: true,
          atomic: false,
        });
        this._wysiwygMarks.set(idx, mark);
        // 异步 pass（图片 / Mermaid / TOC / 代码块滚动条）不得在 markText 返回瞬间跑：
        // CM5 的 replacedWith 是 collapsed 标记的 widget，markText 返回时显示更新尚未把
        // widget 插进行 DOM（2026-10-11 harness 实测：自动/显式 operation 两种路径此刻
        // node.isConnected 均为 false）→ 旧实现在这里同步调 _wysiwygPostProcessAsync，
        // isConnected 守卫把所有批量挂遮罩的异步 pass 全部静默跳过（TOC/图片/图表缺失根因）。
        // 改为登记待跑 + 等 DOM 落定后由 flushWysiwygAsyncPasses 统一执行。
        // 就绪后高度变化用「测前测后 + 滚动补偿」保持视口（SVG/图片撑高不得冲走用户正在看的内容）。
        this._wysiwygNodeGen = this._wysiwygNodeGen || new Map();
        this._wysiwygMaskGen = (this._wysiwygMaskGen || 0) + 1;
        this._wysiwygNodeGen.set(node, this._wysiwygMaskGen);
        this._wysiwygPendingAsync = this._wysiwygPendingAsync || new Set();
        this._wysiwygPendingAsync.add(node);
        this._scheduleWysiwygAsyncFlush();
      } catch (_) { /* 区间非法则放弃该块遮罩 */ }
    },

    // 块右上「编辑」按钮（hover 显示，样式对齐代码块复制按钮，2026-10-11 用户反馈 #4）：
    // 大块内容的显式编辑入口，点击撤遮罩并定位块首行（见 mousedown 接管）。
    // 放在遮罩节点上而非 RenderPost：属所见即所得专属 chrome，阅读模式无「编辑块」概念。
    // 所有渲染块统一挂（用户确认）；纯空占位块（引用定义）也挂，点了直接进该行编辑。
    _addWysiwygEditButton(node) {
      if (!node || node.querySelector('button.block-edit-btn')) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'block-edit-btn';
      btn.textContent = this.t ? this.t('editBlock') : '编辑';
      btn.title = btn.textContent;
      node.appendChild(btn);
    },

    // 遮罩排版同步：所见即所得的渲染态必须与阅读模式「完全一致」，而阅读模式的字体/字号/
    // 行高/代码字体是 applySettings 以**内联样式**写在 #preview 上的（字号 16px、行高 1.7、
    // 预览字体栈、--font-code-preview），CSS 变量只承载字重。遮罩节点不在 #preview 子树里，
    // 若只靠 .preview-content 的 CSS，字号会继承 CodeMirror 的 14px、字体族/代码字体丢失——
    // 与阅读模式肉眼可辨（2026-10-08 用户截图反馈）。故逐项复制 #preview 的**计算值**。
    _wysiwygMaskTypography(node) {
      try {
        if (!this.preview) return;
        const cs = getComputedStyle(this.preview);
        if (cs && cs.fontSize) node.style.fontSize = cs.fontSize;
        if (cs && cs.lineHeight) node.style.lineHeight = cs.lineHeight;
        if (cs && cs.fontFamily) node.style.fontFamily = cs.fontFamily;
        const codeFont = this.preview.style.getPropertyValue('--font-code-preview');
        if (codeFont) node.style.setProperty('--font-code-preview', codeFont);
        // 代码块行号/换行/滚动条的显示由 #preview 上的类控制（CSS 作用域 .preview-content.xxx），
        // 遮罩同带 preview-content 类，需同步同类才吃到同样式
        for (const cls of ['code-line-numbers', 'code-wrap', 'code-no-scroll']) {
          node.classList.toggle(cls, this.preview.classList.contains(cls));
        }
      } catch (_) { /* 排版同步失败不阻断遮罩 */ }
    },

    // 遮罩节点补跑预览后处理，保证与阅读模式渲染完全一致。
    // ⚠️ renderMarkdown 只产出结构 HTML：后处理走 RenderPost 共享管线（modules/render-post.js）——
    //    与阅读模式 render() 同 stage 同顺序（复选框 → details → emoji → 数学 → 缩写 →
    //    标题锚点 → 复制按钮 → 代码高亮；复制按钮必须在代码高亮之前，按钮才落在 pre 上），
    //    只是容器不同（阅读=整篇 preview，遮罩=单块节点）；异步 stage（图片/mermaid/滚动条）
    //    在 _wysiwygPostProcessAsync 里 DOM 落定后补跑。
    // 缓存的 b.html 同样是未后处理的结构 HTML（后处理只作用于 DOM），所以每次遮罩都要重跑；
    // 各 stage 均幂等（KaTeX 渲染过的节点被 walker 跳过，code-scroll 包裹过的块被跳过）。
    _postProcessWysiwygNode(node) {
      const postOpts = {
        t: (k) => (this.t ? this.t(k) : k),
        isDark: !!this.isDark,
        escapeHtml: (s) => (this.escapeHtml ? this.escapeHtml(s) : String(s == null ? '' : s)),
        escapeAttr: (s) => (this.escapeAttr ? this.escapeAttr(s) : String(s == null ? '' : s)),
        headingToId: (s) => (this.headingToId ? this.headingToId(s) : String(s == null ? '' : s)),
        mermaidCache: this._mermaidCache,
      };
      // 与阅读模式同 stage（RenderPost 共享管线，故障隔离 + 幂等，见其文件头注释）
      RenderPost.enableCheckboxes(node);
      RenderPost.normalizeDetails(node);
      RenderPost.processEmoji(node);
      RenderPost.processMath(node);
      RenderPost.processAbbreviations(node, postOpts);
      RenderPost.processHeadings(node, postOpts);
      RenderPost.addCopyButtons(node, postOpts);
      RenderPost.processCodeBlocks(node, {
        hljs: (typeof window !== 'undefined' ? window.hljs : undefined),
        cache: (this._wysiwygHljsCache = this._wysiwygHljsCache || new Map()),
        // 行号开关与阅读模式同源：看 #preview 的 code-line-numbers 类（同一设置写入）
        lineNumbers: !!(this.preview && this.preview.classList.contains('code-line-numbers')),
      });
    },

    // 异步 pass 调度：maskWysiwygBlock 登记待跑节点后，等「DOM 落定」再统一执行。
    // setTimeout(0) 保证在触发挂遮罩的 CM operation 结束（显示更新已把 widget 插进行 DOM）
    // 之后运行；同一 tick 内多次挂遮罩只排一个计时器。
    _scheduleWysiwygAsyncFlush() {
      if (this._wysiwygAsyncFlushTimer != null) return;
      const self = this;
      this._wysiwygAsyncFlushTimer = setTimeout(() => {
        self._wysiwygAsyncFlushTimer = null;
        self.flushWysiwygAsyncPasses();
      }, 0);
    },

    // 异步 pass 统一冲刷：只处理「节点已入 DOM」的待跑遮罩。未物化的（虚拟模式下
    // 视口±预取窗口外的块，CM 尚未把该行渲染进 DOM）留在待跑集里，由下一次冲刷
    //（滚动触发的 updateWysiwygViewportMasks 收尾）捡回——2026-10-11 探针实测：
    // 视口外行的 widget 连 cm.refresh() 之后都未入 DOM，只有该行真正物化后才 isConnected。
    // 各 pass 均幂等（已加载图片走前缀跳过、已换容器的 mermaid 无 code 可查），重复冲刷廉价。
    flushWysiwygAsyncPasses() {
      const cm = this.cm;
      if (!cm || this.viewMode !== 'wysiwyg') return;
      const pending = this._wysiwygPendingAsync;
      if (!pending || pending.size === 0) return;
      const due = [];
      pending.forEach((node) => { if (node && node.isConnected) due.push(node); });
      for (const node of due) {
        pending.delete(node);
        try { this._wysiwygPostProcessAsync(node); } catch (_) { /* 单块失败不影响他块 */ }
      }
    },

    // 遮罩异步 pass：图片读盘转 base64、Mermaid 渲染、[TOC] 目录、代码块滚动条。
    // 与阅读模式 render() 的异步部分对齐；全部 fire-and-forget，失败静默降级（保持源码/原文）。
    _wysiwygPostProcessAsync(node, idx) {
      const cm = this.cm;
      if (!node || !cm || typeof node.isConnected !== 'boolean' || !node.isConnected) return;
      // 节点级代数：本节点的 pass 只在「本节点标记被撤」时过期（unmask/clear 时 +1）。
      // 旧实现用全局 _wysiwygMaskGen，而 setWysiwygActiveBlock 是「先重挂旧活动块、后撤新
      // 活动块」——撤后全局代数 +1，把刚启动的图片读盘 pass 判成过期（2026-10-11 harness
      // 实测：光标移动后重挂块的图片恒停在占位/原始路径）。
      this._wysiwygNodeGen = this._wysiwygNodeGen || new Map();
      const gen = this._wysiwygNodeGen.get(node) || 1;
      const settled = () => {
        // 本遮罩已重建（代数变化）或节点已摘除：不再动 DOM
        return (this._wysiwygNodeGen.get(node) === gen) && node.isConnected;
      };
      // ⚠️ 存在性守卫必须保留在编排层（2026-10-11 真机卡死回归）：RenderPost 各 stage 对
      // 「无内容可处理」返回已 resolve 的 promise，then 回调仍会执行——若无守卫，每个
      // 纯文本块的三个 pass 都会触发一次 _wysiwygRefreshAfterMaskChange（coordsChar +
      // cm.refresh 全量重测 + scrollTo），大文档几百块 × 3 = 主线程被刷新风暴占满，
      // 「点击所见即所得软件卡住没反应」。只有块里真有对应内容的才启动 pass + 刷新。
      const hasImg = node.querySelector && node.querySelector('img') != null;
      const hasMmd = node.querySelector && node.querySelector('code.language-mermaid') != null;
      const hasToc = node.querySelectorAll
        && Array.from(node.querySelectorAll('p')).some((p) => /^\[TOC\]$/i.test((p.textContent || '').trim()));
      // 图片：相对路径 → 本地读盘 base64（RenderPost 共享 stage；与阅读模式同一纯函数、同一缓存）
      if (hasImg) {
        RenderPost.prepareImages(node, {
          activeTab: this.activeTab,
          imageCache: (this._imageBase64Cache = this._imageBase64Cache || new Map()),
          tauri: (typeof TauriApi !== 'undefined' ? TauriApi : undefined),
          getCachedImageURL: (u) => (this.getCachedImageURL ? this.getCachedImageURL(u) : u),
          getRenderGeneration: () => (this._wysiwygNodeGen ? this._wysiwygNodeGen.get(node) || 0 : 0),
        }).then(() => { if (settled()) this._wysiwygRefreshAfterMaskChange(); })
          .catch((e) => console.warn('[wysiwyg] Images error:', e));
      }
      // Mermaid：RenderPost 共享 stage + 同一 mermaidCache（命中缓存时近乎同步；
      // 串行化/id 唯一化在 processMermaid 内部）
      if (hasMmd) {
        RenderPost.runMermaid(node, {
          t: (k) => (this.t ? this.t(k) : k),
          isDark: !!this.isDark,
          escapeHtml: (s) => (this.escapeHtml ? this.escapeHtml(s) : String(s == null ? '' : s)),
          escapeAttr: (s) => (this.escapeAttr ? this.escapeAttr(s) : String(s == null ? '' : s)),
          headingToId: (s) => (this.headingToId ? this.headingToId(s) : String(s == null ? '' : s)),
          mermaidCache: this._mermaidCache,
        }).then(() => {
          if (settled()) this._wysiwygRefreshAfterMaskChange();
        }).catch((e) => console.warn('[wysiwyg] Mermaid error:', e));
      }
      // [TOC]：阅读模式用 Rust generate_toc 生成整篇目录替换 [TOC] 段，遮罩同款
      //（整篇级 stage，不经 RenderPost，见其文件头注释）
      if (hasToc) {
        this._wysiwygReplaceToc(node).then(() => { if (settled()) this._wysiwygRefreshAfterMaskChange(); });
      }
      // 代码块滚动条：RenderPost 共享 stage（条件唯一来源，与阅读模式同一函数）。
      // 本 pass 由 flush 在 DOM 落定后调用，scrollHeight 读取强制同步回流，高度是准的。
      RenderPost.applyCodeScrollOverflow(node, { codeScroll: this.settings && this.settings.codeScroll });
    },

    // 遮罩内容高度变化（公式/图片/Mermaid/TOC 就绪）后：刷新 CM 测量并补偿滚动，
    // 让视口内容不漂移（与阅读模式「内容长高」的自然观感一致，而不是被推走）。
    // ⚠️ 格编辑进行中禁止 cm.refresh()：refresh → regChange(全区间) → resetView →
    //    patchDisplay 重建全部行 DOM，遮罩 widget（含正在编辑的 contenteditable 格）被
    //    重新 appendChild 移挂——Chromium 对被移动的聚焦元素必触发 blur，格的 blur 处理器
    //    随即登记「下一 tick 提交」→ 正在打的字被回写、cm.focus() 把光标跳到表后
    //    （用户反馈「输入文字时失去焦点、打到一半跳到别处」的真凶：图片/Mermaid/TOC
    //    异步加载恰好在打字途中完成）。改为登记待刷新，格编辑结束后补跑（见
    //    _wysiwygEndCellEdit 末尾 _wysiwygFlushPendingMaskRefresh），几何补偿不丢。
    _wysiwygRefreshAfterMaskChange() {
      try {
        const cm = this.cm;
        if (!cm) return;
        if (this._wysiwygCellEditing) {
          this._wysiwygPendingRefreshAfterCellEdit = true;
          return;
        }
        const wrapper = cm.getWrapperElement();
        const topY = wrapper.getBoundingClientRect().top + 2;
        const anchor = cm.coordsChar({ left: 0, top: topY }, 'window');
        if (!anchor) { cm.refresh(); return; }
        const before = cm.charCoords(anchor, 'window').top;
        cm.refresh();
        const after = cm.charCoords(anchor, 'window').top;
        const delta = after - before;
        if (delta && Math.abs(delta) < (wrapper.clientHeight || 1e9)) {
          const info = cm.getScrollInfo();
          cm.scrollTo(info.left, info.top + delta);
        }
      } catch (_) { /* 刷新失败无妨，下次输入会重建遮罩 */ }
    },

    // [TOC] 段替换：与阅读模式 render() 的替换规则对齐——阅读模式是对整篇 HTML 用正则
    // 匹配**所有**「内容恰为 [TOC]」的 <p> 并逐个换成 toc-wrapper + Rust 目录 HTML；
    // 旧实现只取节点内第一个 <p>，当块内另有段落排在 [TOC] 段前时永远匹配不上
    // （2026-10-11 用户反馈「目录没加载出来」的成因之一）。
    // TOC 依赖整篇内容，按内容缓存 promise，遮罩频繁重建不重复 invoke；
    // invoke 失败时清缓存可重试（真实 app 中 Rust 侧同步返回字符串，不会 reject，此为防御）。
    _wysiwygReplaceToc(node) {
      if (!node || !node.querySelectorAll) return Promise.resolve();
      const ps = Array.from(node.querySelectorAll('p'))
        .filter((p) => /^\[TOC\]$/i.test((p.textContent || '').trim()));
      if (ps.length === 0) return Promise.resolve();
      if (typeof TauriApi === 'undefined' || typeof TauriApi.generateToc !== 'function') return Promise.resolve();
      const cm = this.cm;
      if (!cm) return Promise.resolve();
      const content = cm.getValue();
      if (!this._wysiwygToc || this._wysiwygToc.value !== content) {
        this._wysiwygToc = { value: content, promise: TauriApi.generateToc({ content }) };
      }
      return this._wysiwygToc.promise.then((tocHtml) => {
        if (!tocHtml) return;
        for (const p of ps) {
          if (!p.isConnected) continue;
          const line = p.getAttribute('data-source-line');
          const wrap = document.createElement('div');
          wrap.className = 'toc-wrapper';
          if (line) wrap.setAttribute('data-source-line', line);
          wrap.innerHTML = tocHtml;
          p.replaceWith(wrap);
        }
      }).catch((e) => {
        this._wysiwygToc = null; // 失败不缓存：下次挂遮罩按新内容重试，保持 [TOC] 原文
        console.warn('[wysiwyg] TOC error:', e);
      });
    },

    // 所见即所得的编辑器外壳同步：
    //   1) 行号——所见即所得下隐藏（与阅读模式一致，无编辑 gutter），离开时按设置恢复；
    //   2) 最大宽度——设置 maxWidth 时与阅读模式同款居中（阅读模式是 #preview 内联
    //      max-width + margin:0 auto，遮罩在 CM 行流里，对 .CodeMirror-lines 做等价处理）。
    // 在 renderWysiwygMasks（进入）/ clearWysiwygMasks（离开）/ applySettings（设置变更）调用。
    applyWysiwygEditorChrome() {
      const cm = this.cm;
      if (!cm) return;
      const on = this.viewMode === 'wysiwyg';
      try {
        cm.setOption('lineNumbers', on ? false : !!(this.settings && this.settings.lineNumbers));
      } catch (_) { /* 切换失败不阻断 */ }
      let linesEl = null;
      try {
        const wrapper = cm.getWrapperElement();
        linesEl = wrapper ? wrapper.querySelector('.CodeMirror-lines') : null;
      } catch (_) {}
      if (linesEl) {
        const inset = on && this.settings && this.settings.maxWidth;
        linesEl.style.maxWidth = inset ? this.settings.maxWidth + 'px' : '';
        linesEl.style.marginLeft = inset ? 'auto' : '';
        linesEl.style.marginRight = inset ? 'auto' : '';
      }
    },

    // 所见即所得下的 #锚点 跳转（TOC 链接 / 文中交叉引用）：目标标题在某个遮罩节点里，
    // 优先用「块偏移 + data-source-line」还原绝对行号；遮罩未渲染（大文档虚拟模式）时
    // 回退为按 headingToId 匹配源码标题行。定位后复用点击锚定机制，滚动行为与点遮罩一致。
    _wysiwygScrollToAnchor(id) {
      const cm = this.cm;
      if (!cm || !id) return;
      let line = null;
      let target = null;
      try {
        const el = document.getElementById ? document.getElementById(id)
          : (document.querySelector && (typeof CSS !== 'undefined' ? document.querySelector(`#${CSS.escape(id)}`) : null));
        if (el) {
          target = el;
          const mask = el.closest ? el.closest('.' + MASK_CLASS) : null;
          if (mask) {
            const idx = parseInt(mask.getAttribute('data-block-index'), 10);
            const block = (this._wysiwygBlocks && isFinite(idx)) ? this._wysiwygBlocks[idx] : null;
            let el2 = el;
            let srcLine = null;
            while (el2 && el2 !== document) {
              const v = el2.getAttribute && el2.getAttribute('data-source-line');
              if (v) { srcLine = parseInt(v, 10); break; }
              el2 = el2.parentNode;
            }
            if (srcLine && block) line = block.start + Math.max(0, srcLine - 1);
          }
        }
      } catch (_) {}
      if (line == null) {
        // 回退：源码里找 id 匹配的标题行（虚拟模式/目标块未渲染时兜底）
        try {
          const toId = this.headingToId || ((t) => t);
          const n = cm.lineCount();
          for (let i = 0; i < n; i++) {
            const m = cm.getLine(i).match(/^ {0,3}(#{1,6})\s+(.*)$/);
            if (m && toId(m[2].trim()) === id) { line = i; break; }
          }
        } catch (_) {}
      }
      if (line == null || line < 0 || line >= cm.lineCount()) return;
      // 目标标题在遮罩块内：先解罩该块（恢复源码态）。否则 CM5 把光标 clamp 到遮罩
      // 边缘、滚动落在整块遮罩上——表现为「所见即所得下点目录跳不到对应内容」
      //（2026-10-12 真机反馈；与面包屑跳转同一成因）。
      try {
        const aIdx = this.wysiwygBlockIndexAt(line);
        if (aIdx >= 0 && this._wysiwygMarks && this._wysiwygMarks.has(aIdx)) this.setWysiwygActiveBlock(aIdx);
      } catch (_) { /* 解罩失败不阻塞跳转 */ }
      try {
        cm.operation(() => {
          cm.setSelection({ line, ch: 0 }, { line, ch: cm.getLine(line).length }, { scroll: false });
          cm.focus();
        });
        // 目标行滚到视口中部（与阅读模式锚点跳转观感一致），再闪显
        this._wysiwygScrollLineToCenter(line);
        if (target && target.isConnected) {
          target.classList.add('footnote-flash');
          setTimeout(() => target.classList.remove('footnote-flash'), 1300);
        }
      } catch (_) { /* 定位失败静默 */ }
    },

    // 把指定源码行滚动到编辑视口垂直中部（scrollIntoView 的 margin 语义做不到「居中」，
    // 用 charCoords 实测 + scrollTo 精确补偿）
    _wysiwygScrollLineToCenter(line) {
      try {
        const cm = this.cm;
        if (!cm) return;
        const info = cm.getScrollInfo();
        const top = cm.charCoords({ line, ch: 0 }, 'local').top;
        const bottom = cm.charCoords({ line, ch: cm.getLine(line).length }, 'local').bottom;
        const h = Math.max(1, bottom - top);
        // 视口高用 scroller 元素实测（CM5 scrollInfo 的可视高度字段各版本不一）
        let scroller = null;
        try { scroller = cm.getScrollerElement ? cm.getScrollerElement() : null; } catch (_) {}
        const viewportH = (scroller && scroller.clientHeight) || 600;
        cm.scrollTo(info.left, Math.max(0, top - (viewportH - h) / 2));
      } catch (_) {}
    },

    // 撤掉单个块的遮罩（该块回到源码态）
    unmaskWysiwygBlock(idx) {      if (!this._wysiwygMarks) return;
      // 本块内有格正在源码编辑：先提交，撤遮罩不得静默丢掉正在编辑的内容
      if (this._wysiwygCellEditing && this._wysiwygCellEditing.blockIdx === idx) this._wysiwygEndCellEdit(true);
      const mark = this._wysiwygMarks.get(idx);
      if (!mark) return;
      try { mark.clear(); } catch (_) { /* 已销毁 */ }
      this._wysiwygMarks.delete(idx);
      // 遮罩已换：让旧节点上未完成的异步 pass（图片/Mermaid/TOC）感知过期，停写 DOM
      this._dropWysiwygMaskNode(mark.replacedWith);
    },

    // 作废单个遮罩节点：节点代数 +1（在飞 pass 的代际检查判过期停写）+ 移出待跑冲刷集。
    // 只影响本节点——绝不牵连其他块（全局代数曾让「撤 A 块」作废「刚挂的 B 块」的 pass）。
    _dropWysiwygMaskNode(node) {
      if (!node) return;
      if (this._wysiwygNodeGen) this._wysiwygNodeGen.set(node, (this._wysiwygNodeGen.get(node) || 0) + 1);
      if (this._wysiwygPendingAsync) this._wysiwygPendingAsync.delete(node);
    },

    // 渲染态点击任务复选框：按 data-source-line 精确回写源码行并翻转 [ ]/[x]。
    // ⚠️ data-source-line 是渲染管线写入的「渲染输入（即块切片）内 1-based 行号」，
    // 不是整篇文档行号——必须加上所在块的起始行才是真实源码行（整篇渲染时块起点为 0，二者恰好一致，
    // 阅读模式的勾选框同步因此不受影响；逐块渲染时漏加偏移会勾错行）。
    toggleWysiwygTaskCheckbox(box) {
      const cm = this.cm;
      if (!cm || !box) return;
      // 所在块：从遮罩节点的 data-block-index 取当前块表（重划分后 mask 会重建，索引即时有效）
      const maskNode = box.closest ? box.closest('.' + MASK_CLASS) : null;
      const idx = maskNode ? parseInt(maskNode.getAttribute('data-block-index'), 10) : NaN;
      const block = (this._wysiwygBlocks && isFinite(idx)) ? this._wysiwygBlocks[idx] : null;

      let el = box;
      let srcLine = null;
      while (el && el !== document) {
        const v = el.getAttribute && el.getAttribute('data-source-line');
        if (v) { srcLine = parseInt(v, 10); break; }
        el = el.parentNode;
      }
      if (!srcLine || !isFinite(srcLine)) return;
      const n = (block ? block.start : 0) + srcLine - 1;
      if (n < 0 || n >= cm.lineCount()) return;
      const m = cm.getLine(n).match(/^(\s*(?:[-*+]|\d{1,9}[.)])\s+\[)([ xX])(\])/);
      if (!m) return;
      cm.replaceRange(m[2] === ' ' ? 'x' : ' ',
        { line: n, ch: m[1].length }, { line: n, ch: m[1].length + 1 }, '+wysiwygTask');
      // 立即重渲染该块，不等 250ms 防抖（replaceRange 已同步触发 change → refreshWysiwygBlocks 重算块表）
      const blockIdx = this.wysiwygBlockIndexAt(n);
      const b = this._wysiwygBlocks && this._wysiwygBlocks[blockIdx];
      if (b) {
        b.html = this.renderWysiwygBlockHtml(b.start, b.end);
        b.src = this._wysiwygBlockSource(b); // 源文本键同步，全量增量刷新才判得出变化
        this.maskWysiwygBlock(blockIdx);
      }
    },

    // ---------------- 表格单元格就地源码编辑（Phase 2 / R5，2026-10-13） ----------------
    // 单元格 contenteditable 显示**该格原始源码**（无损：用户直接编辑源文本，** / \| 等可见可改；
    // 渲染态真内联编辑属 Phase 3 暂缓项）。Enter/失焦/Tab = 提交（纯函数重建整行回写源码行 +
    // 立即重渲本块遮罩）；Esc = 取消（恢复渲染内容，不回写）。同一时刻至多一个格在编辑。
    // ⚠️ 提交会重建遮罩（旧 DOM 节点离场）：所有「提交后还要找格」的路径（Tab 切格 / 点另一格）
    //    必须按 (rowIdx, colIdx) 在新遮罩节点上重新定位，不得持有旧节点引用。
    // clickPoint = {x, y}（viewport 坐标）：点击路径传入用于「光标落到点击处」；
    // Tab/增行增列路径不传 → 光标落到格内文末。
    _wysiwygStartCellEdit(cellEl, rowIdx, colIdx, clickPoint) {
      const cm = this.cm;
      if (!cm || !cellEl) return;
      // 已有格在编辑（点另一格 / Tab 切格）：先提交（settle=false：不挪光标/不补行/不抢焦点，
      // 新格焦点直接接管）；提交若重建了遮罩，本格的旧 DOM 已离场，按 (rowIdx, colIdx) 重新定位
      if (this._wysiwygCellEditing) this._wysiwygEndCellEdit(true, false);
      let cell = cellEl;
      if (!cell.isConnected && isFinite(rowIdx) && isFinite(colIdx) && rowIdx >= 0) {
        const mk = this._wysiwygMarks && this._wysiwygMarks.get(this._wysiwygLastCellEditBlockIdx);
        const node = mk && mk.replacedWith;
        const trs = node ? Array.from(node.querySelectorAll('tr')) : [];
        const tr = trs[rowIdx];
        cell = tr ? tr.children[colIdx] : null;
        if (!cell) return;
      }
      this._wysiwygStartCellEditOn(cell, clickPoint);
    },

    // 按 (rowIdx, colIdx) 在遮罩节点上定位目标格并进入编辑（Tab 导航用：提交后遮罩可能已重建）。
    // blockIdx 缺省 = 上次格编辑的块（Tab 场景）；增行/增列回写后块索引可能位移，须显式传新索引。
    _wysiwygStartCellEditAt(rowIdx, colIdx, blockIdx) {
      // 已有格在编辑（Tab/Enter 切格）：先提交（settle=false：见 _wysiwygEndCellEdit 注释）——
      // 状态被新格覆盖后旧格的 blur 守卫（st.cell !== cell）变 no-op，不在此提交则旧格
      // 已输入的内容丢失（2026-10-14 修复）。
      if (this._wysiwygCellEditing) this._wysiwygEndCellEdit(true, false);
      const bi = isFinite(blockIdx) ? blockIdx : this._wysiwygLastCellEditBlockIdx;
      const mk = this._wysiwygMarks && this._wysiwygMarks.get(bi);
      const node = mk && mk.replacedWith;
      if (!node) return;
      const trs = Array.from(node.querySelectorAll('tr'));
      const tr = trs[rowIdx];
      const cell = tr ? tr.children[colIdx] : null;
      if (cell) this._wysiwygStartCellEditOn(cell);
    },

    _wysiwygStartCellEditOn(cell, clickPoint) {
      const cm = this.cm;
      if (!cm || !cell) return;
      const maskNode = cell.closest ? cell.closest('.' + MASK_CLASS) : null;
      const idx = maskNode ? parseInt(maskNode.getAttribute('data-block-index'), 10) : NaN;
      const block = (this._wysiwygBlocks && isFinite(idx)) ? this._wysiwygBlocks[idx] : null;
      if (!block) return;
      const tableEl = cell.closest('table');
      const tr = cell.closest('tr');
      if (!tableEl || !tr) return;
      const trs = Array.from(tableEl.querySelectorAll('tr'));
      const rIdx = trs.indexOf(tr);
      if (rIdx < 0) return;
      // 行映射：tr 0 = 表头行（= 块首行），其后 tbody 行越过分隔行顺延（与原点击定位同规则）
      const line = block.start + rIdx + (rIdx > 0 ? 1 : 0);
      if (line < 0 || line >= cm.lineCount()) return;
      const col = Array.from(tr.children).indexOf(cell);
      const info = splitTableRow(cm.getLine(line));
      if (col < 0 || col >= info.cells.length) return; // 渲染格数与源码格数不符（畸形表）：不启动
      const self = this;
      this._wysiwygCellEditing = {
        cell: cell, tableEl: tableEl, tr: tr, rowIdx: rIdx, blockIdx: idx,
        line: line, colIdx: col, origSource: info.cells[col], origHtml: cell.innerHTML,
        composing: false,
        lastCompositionEnd: 0,
      };
      // 格编辑已立 → 重遮罩旧活动块（2026-10-14 用户截图「点表格后下面一行还是源码态」）：
      // 遮罩 mousedown 接管后 CM 光标/cursorActivity 不再变化，点格前处于源码态的块
      // （如表格下方的标题）无人失焦重渲，只能在此显式补上。必须在状态立起之后调用
      // （见 _wysiwygReMaskActiveForCellEdit 注释里的 reCheckSelection 钳制连锁）。
      this._wysiwygReMaskActiveForCellEdit(idx);
      cell.classList.add('wysiwyg-cell-editing');
      cell.setAttribute('contenteditable', 'true');
      cell.textContent = info.cells[col]; // 显示原始源码文本（无损）
      // Enter=提交 / Tab·Shift+Tab=行内切格（环绕）/ Esc=取消；失焦=提交；IME 组合期延迟提交
      cell.addEventListener('keydown', (e) => {
        const st = self._wysiwygCellEditing;
        if (!st || st.cell !== cell) return;
        // IME 组合期（中文/日文输入）：此时的 Enter/数字键是「确认拼音/选字」，
        // 不是提交格子。必须整体放行给 IME，否则 preventDefault+blur 会让焦点丢失、
        // 只能输入一个字（2026-10-13 用户反馈「一输入文字光标就失去焦点」）。
        // e.isComposing 覆盖确认键；st.composing（compositionstart/end 维护）兜底
        // 个别浏览器确认键 isComposing 为假但组合未结束的情况。
        if (e.isComposing || st.composing) return;
        // WebView2/Chromium 中文 IME 时序怪癖：compositionend 可能先于「选字确认的
        // Enter」keydown 到达（此刻 isComposing=false、st.composing 已清）——该 Enter
        // 是 IME 确认键的残影，不是用户想提交。若当提交处理：格子被回写重渲染、
        // 焦点跳出格（用户 2026-10-13 反馈「输入完马上失去光标，像被回写了一样」）。
        // 组合刚结束 250ms 内的 Enter 一律只吞掉（preventDefault 防止往格内插换行），
        // 不提交；用户真正的提交 Enter 在更晚按下，正常生效。
        if (e.key === 'Enter' && st.lastCompositionEnd && Date.now() - st.lastCompositionEnd < 250) {
          e.preventDefault();
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          // Enter = 移到下一格（2026-10-14 用户要求）：提交本格后进入同行右邻格；
          // 无右邻 → 进入下一行首格；无下一行（末行）= 提交并把焦点还给编辑器
          // （光标落表后行，见 _wysiwygCellEditEndLine）。切格走 _wysiwygStartCellEditAt：
          // 先提交本格（遮罩重建后在新遮罩上按坐标重新定位目标格）。
          const n = st.tr.children.length;
          let nr = st.rowIdx, nc = st.colIdx + 1;
          if (nc >= n) { nr = st.rowIdx + 1; nc = 0; }
          const trsNow = Array.from(st.tableEl.querySelectorAll('tr'));
          if (nr < trsNow.length) {
            self._wysiwygStartCellEditAt(nr, nc);
          } else {
            cell.blur(); // 末行：提交并回编辑器（原行为）
          }
        } else if (e.key === 'Tab') {
          e.preventDefault();
          const n = st.tr.children.length;
          const ni = (st.colIdx + (e.shiftKey ? -1 : 1) + n) % n;
          self._wysiwygStartCellEditAt(st.rowIdx, ni);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          self._wysiwygEndCellEdit(false);
        }
      });
      cell.addEventListener('blur', () => {
        const st = self._wysiwygCellEditing;
        if (!st || st.cell !== cell) return;
        // 提交一律延迟到下一 tick，不得在 blur 里同步 replaceRange + 重挂遮罩：
        // ① blur 常由 CM 自己的 mousedown 同步触发（点源码区 → setSelection 在 CM operation
        //    内），此刻同步重建行 DOM 会毁掉 CM 操作还要移动的节点 → NotFoundError
        //    （appendChild: node no longer a child, "Perhaps it was moved in a blur event
        //    handler"，codemirror.js:1928，2026-10-13 用户报「改单元格内容时出现报错」）；
        // ② IME 组合中（拼音未上屏）浏览器失焦即丢弃组合，立即读文本会读到半截。
        // 计时器触发时若状态已被其他路径先清（点另一格同步提交 / 遮罩清理守卫），则为 no-op。
        setTimeout(() => {
          const st2 = self._wysiwygCellEditing;
          if (!st2 || st2.cell !== cell) return;
          // blur 后焦点又被搬回本格（CM patchDisplay 的 restoreSelection / 焦点保持机制）：
          // 视为从未真正失焦，继续编辑不提交（防「打字到一半被误提交、光标跳走」）
          try { if (document.activeElement === cell) return; } catch (_) { }
          self._wysiwygEndCellEdit(true);
        }, 0);
      });
      cell.addEventListener('compositionstart', () => {
        const st = self._wysiwygCellEditing;
        if (st && st.cell === cell) st.composing = true;
      });
      cell.addEventListener('compositionend', () => {
        const st = self._wysiwygCellEditing;
        // 记录组合结束时刻：紧随其后的 isComposing=false 的 Enter 是 IME 确认键残影
        // （WebView2 时序怪癖），keydown 里按 250ms 窗口识别（见上）。
        if (st && st.cell === cell) { st.composing = false; st.lastCompositionEnd = Date.now(); }
      });
      cell.focus();
      // 光标落位（2026-10-13 用户反馈「点格应光标进格，而非选中整格文字」）：
      // 点击路径 → 落到点击处（原生 caretRangeFromPoint，可把光标定位到格内任意位置）；
      // Tab/增行增列路径（无点击坐标）→ 落到格内文末。不再 selectNodeContents 全选——
      // 全选会让首次击键整格替换，与 mousedown 的 preventDefault 叠加在 WebView2 上易丢焦点。
      try {
        const sel = window.getSelection();
        let placed = false;
        if (clickPoint && typeof document.caretRangeFromPoint === 'function') {
          const r = document.caretRangeFromPoint(clickPoint.x, clickPoint.y);
          if (r && cell.contains(r.startContainer)) {
            sel.removeAllRanges();
            sel.addRange(r);
            placed = true;
          }
        }
        if (!placed) {
          const r = document.createRange();
          r.selectNodeContents(cell);
          r.collapse(false); // 折叠到文末 → 光标在格内末尾
          sel.removeAllRanges();
          sel.addRange(r);
        }
      } catch (_) { /* 选区失败忽略，仍给焦点 */ }
    },

    // 格编辑结束后光标的落位行 = 块后首行。
    // ⚠️ 块是文档最后块时（b.end == lineCount）clamp 会把光标落到块**最后一行**——仍在
    //    replacedWith 区间内 → 块被判定活动块撤遮罩，表格变源码态（2026-10-14 用户报：
    //    「表格下面的一行一旦输入内容，表格就会变成源码格式」：提交后光标就在表上）。
    //    先在块后补一个空行（新行索引 = 原 b.end）再落光标：空行不属于任何块，
    //    其上的输入形成新段落块，表格保持渲染态。
    _wysiwygCellEditEndLine(b) {
      const cm = this.cm;
      if (!cm) return -1;
      const base = b ? b.end : cm.lineCount() - 1;
      if (b && base >= cm.lineCount()) {
        try {
          const last = cm.lineCount() - 1;
          const ch = cm.getLine(last).length;
          cm.replaceRange('\n', { line: last, ch }, { line: last, ch }, '+wysiwygTableCell');
          return base; // 新空行索引 = 原 b.end
        } catch (_) { /* 失败保持原 clamp */ }
      }
      return Math.min(base, cm.lineCount() - 1);
    },

    // 结束单元格编辑。commit=true 提交回写（Enter/失焦/切格/遮罩清理路径）；false 取消恢复。
    // settle=false = 表格内切格（Tab/Enter/点另一格/增行增列）：提交（或取消）本身照做
    // （回写 + 重挂遮罩），但**不**把光标挪到块后行、不补空行、不抢焦点——光标/焦点由
    // 目标格的 _wysiwygStartCellEditOn 直接接管。切格时挪光标会触发活动块判定（表格先
    // 撤罩再重挂一轮），表格是文档最后块时补空行还会造成用户没请求过的文档变更。
    // ⚠️ 首行即清状态：本方法内 replaceRange → cursorActivity → setWysiwygActiveBlock →
    //    unmask/maskWysiwygBlock 会重入 unmaskWysiwygBlock 的单元格守卫，状态先清则重入为 no-op。
    // 格编辑启动时把旧活动块（源码态）重新遮罩（2026-10-14 用户反馈：点表格格后，
    // 点格前正在编辑的块——如表格下方的标题——仍保持源码态+高亮，没「失去焦点」）。
    // ⚠️ 必须在 _wysiwygCellEditing 立起之后调用：markText(replacedWith) 是 atomic
    // 标记，落在被遮区间内的 CM 光标会被 reCheckSelection 钳到块末行（仍在块内）并
    // 触发 cursorActivity → syncWysiwygActiveBlock 会把刚遮的块重新判活动解罩（活动块
    // 是表格块时更会触发解罩守卫连带自动提交格编辑）；sync 里的格编辑守卫拦下连锁。
    _wysiwygReMaskActiveForCellEdit(tableIdx) {
      const cm = this.cm;
      const prev = this._wysiwygActiveIdx;
      if (!cm || prev == null || prev < 0 || prev === tableIdx) return;
      const b = this._wysiwygBlocks && this._wysiwygBlocks[prev];
      if (!b) {
        this._wysiwygActiveIdx = -1;
        this._applyWysiwygActiveHighlight();
        return;
      }
      // 旧块可能刚被编辑过：缓存 html 过期，重渲（与 setWysiwygActiveBlock 的 prev 处理一致）
      if (b.html !== undefined) { b.html = this.renderWysiwygBlockHtml(b.start, b.end); b.src = this._wysiwygBlockSource(b); }
      this._wysiwygActiveIdx = -1;
      this.maskWysiwygBlock(prev);
      this._applyWysiwygActiveHighlight();
    },

    _wysiwygEndCellEdit(commit, settle) {
      if (settle === undefined) settle = true;
      const st = this._wysiwygCellEditing;
      if (!st) return;
      this._wysiwygCellEditing = null;
      this._wysiwygLastCellEditBlockIdx = st.blockIdx;
      const cm = this.cm;
      let text = '';
      try { text = (st.cell.textContent || '').trim(); } catch (_) { st.cell = null; }
      let changed = !!(commit && cm && text !== st.origSource);
      if (changed) {
        try { changed = editTableRowCell(cm.getLine(st.line), st.colIdx, text) !== cm.getLine(st.line); }
        catch (_) { changed = false; }
      }
      if (!changed) {
        // 取消 / 无变化：恢复渲染内容（遮罩若已重建，节点已离场，忽略即可）
        try {
          if (st.cell && st.cell.isConnected) {
            st.cell.classList.remove('wysiwyg-cell-editing');
            st.cell.removeAttribute('contenteditable');
            st.cell.innerHTML = st.origHtml;
          }
        } catch (_) { /* 忽略 */ }
        // Esc 取消后焦点同样不得掉在 body 上（见 _wysiwygRestoreEditorFocus）
        // 切格（settle=false）跳过：光标/焦点由新格接管，不补空行
        if (settle) {
          const bC = this._wysiwygBlocks && this._wysiwygBlocks[this.wysiwygBlockIndexAt(st.line)];
          const endLineC = cm ? this._wysiwygCellEditEndLine(bC) : st.line;
          this._wysiwygRestoreEditorFocus(endLineC);
        }
        // 挂起的遮罩刷新同样在取消路径补跑（见提交路径末尾注释）
        if (this._wysiwygPendingRefreshAfterCellEdit) {
          this._wysiwygPendingRefreshAfterCellEdit = false;
          this._wysiwygRefreshAfterMaskChange();
        }
        return;
      }
      // 提交：重建整行回写源码行（保留首尾竖线风格，格内裸 | 自动转义）
      try {
        const cur = cm.getLine(st.line);
        cm.replaceRange(editTableRowCell(cur, st.colIdx, text),
          { line: st.line, ch: 0 }, { line: st.line, ch: cur.length }, '+wysiwygTableCell');
      } catch (_) { return; }
      // 立即重渲染该块遮罩（与勾选框同模式，不等 250ms 防抖）
      const blockIdx = this.wysiwygBlockIndexAt(st.line);
      const b = this._wysiwygBlocks && this._wysiwygBlocks[blockIdx];
      if (b) {
        b.html = this.renderWysiwygBlockHtml(b.start, b.end);
        b.src = this._wysiwygBlockSource(b); // 源文本键同步：否则全量增量刷新误判「源未变」
        this.maskWysiwygBlock(blockIdx);
      }
      // 切格（settle=false）到此为止：回写 + 重挂遮罩已完成，光标/焦点由新格接管。
      if (settle) {
        // 光标移到块后首行：光标不得留在 replacedWith 区间内（CM 会钳制到标记边缘，
        // 下次击键会写进块边缘），落在表后空行 = 非活动块，高亮自然收回；
        // 块是文档最后块时先补空行（见 _wysiwygCellEditEndLine）
        const endLine = this._wysiwygCellEditEndLine(b);
        try {
          cm.setSelection({ line: endLine, ch: 0 }, { line: endLine, ch: 0 },
            { scroll: false, origin: '+wysiwygTableCell' });
          // 同步补焦点：提交路径（Enter/失焦）格 blur 后焦点会掉 body——只挪选区不补
          // 焦点，用户看到的即「输入完光标没了」（2026-10-13 反馈 B2 残留）。本提交代码
          // 始终运行在独立 tick（blur 延迟 / 点击路径在 CM mousedown 之前），可直接
          // cm.focus()，光标立即落在块后行可见；若随后用户点了别处，新焦点自然接管。
          try { cm.focus(); } catch (_) { /* 忽略 */ }
        } catch (_) { /* 忽略 */ }
        // 下一 tick 兜底：同步路径未接住（如焦点被中间事件带走）时按 activeElement
        // 判定恢复；焦点已被新格/CM 输入域接走则自动跳过。
        this._wysiwygRestoreEditorFocus(endLine);
      }
      // 格编辑期间被挂起的遮罩刷新（图片/Mermaid/TOC 异步 pass 恰在打字中完成）：
      // 此刻补跑 cm.refresh()，几何补偿不丢。挂起标志在状态清空后置 false 再调用，
      // 避免重入时又判「编辑中」再挂起。
      if (this._wysiwygPendingRefreshAfterCellEdit) {
        this._wysiwygPendingRefreshAfterCellEdit = false;
        this._wysiwygRefreshAfterMaskChange();
      }
    },

    // 格编辑结束后把焦点还给编辑器（下一 tick 判定）。
    // 延迟 + 条件判定是为了不干扰其他路径已接走的焦点：
    //   · Enter 提交 / Esc 取消 → blur 后焦点掉 body → 命中，光标回落到块后行并聚焦 CM；
    //   · 点另一格 / 点源码行 / 点块编辑按钮 → 下一 tick 焦点已在新格或 CM 输入域 → 跳过。
    // 拖拽进行中不抢焦点（行/列移动后 st.line 可能已位移，避免光标落到错行）。
    _wysiwygRestoreEditorFocus(endLine) {
      const cm = this.cm;
      if (!cm) return;
      setTimeout(() => {
        if (this._wysiwygTableDrag) return;
        let ae = null;
        try { ae = document.activeElement; } catch (_) { return; }
        if (ae && ae !== document.body) return;
        try {
          const l = Math.min(endLine, cm.lineCount() - 1);
          cm.setSelection({ line: l, ch: 0 }, { line: l, ch: 0 },
            { scroll: false, origin: '+wysiwygTableCell' });
          cm.focus();
        } catch (_) { /* 忽略 */ }
      }, 0);
    },

    // ---------------- 表格行/列操作（2026-10-13 用户要求，Typora 式） ----------------
    // hover 表 → 右缘「＋」增列、下缘「＋」增行；行左缘/表头格出拖拽把手换位行列。
    // 结构变更（行数可能变）整块回写：纯函数重建 → 整块 replaceRange → 立即重算块表
    // + 重挂变化块（_wysiwygCommitTableBlock，不能走单元格单行提交路径）。表格 DOM 被
    // 包进 wysiwyg-table-wrap 锚（div/button 不在 S1 结构标签集，同构判据不受影响；
    // wrap 内不含 tr，单元格编辑的 tr 下标不受影响）。
    _addWysiwygTableTools(node) {
      const self = this; // 闭包（mousemove 拖拽让位等）里读编辑器状态
      const tableEl = node && node.querySelector ? node.querySelector('table') : null;
      if (!tableEl || tableEl.parentElement !== node) return;
      const wrap = document.createElement('div');
      wrap.className = 'wysiwyg-table-wrap';
      node.insertBefore(wrap, tableEl);
      wrap.appendChild(tableEl);
      const mkBtn = (cls, title) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = cls;
        b.textContent = '+';
        b.title = title;
        wrap.appendChild(b);
        return b;
      };
      const colBtn = mkBtn('wysiwyg-table-add-col', '添加列');
      const rowBtn = mkBtn('wysiwyg-table-add-row', '添加行');
      // 行/列拖拽「轨道 + 握点」（2026-10-13 用户参考图 2/3/6，边缘邻近触发）：
      // 必须是 wrap 上的真实元素（不能是 td/th 伪元素——table 盒只有网格宽且是滚动容器，
      // 伸到表盒外会被裁剪：不可见/不可命中，2026-10-13 实测 elementFromPoint=PRE）。
      // 轨道 = 整段 gutter 命中区，常驻（透明）：行轨 = 表左缘外 26px × 表全高；列轨 =
      // 表上方 12px（= wrap 上留白）× 表全宽。常驻是关键：gutter 在 wrap 盒外，鼠标到
      // gutter 时目标元素
      // 必须是 wrap 的 DOM 后代，wrap 的 mousemove/pointerdown 才会触发（冒泡按 DOM 树，
      // 不看几何包含）——若轨道随悬停才显示，gutter 里收不到事件，「移到行左边一点」
      // 永远不会亮出把手。握点 = 可见小把手（灰色点阵），JS 定位到悬停行中线 / 列中心。
      // 视觉态：悬停 = 灰点阵（无底色、无行/列高亮）；拖动（超 4px 阈值）= 握点变蓝底
      // 胶囊（轨道挂 wysiwyg-dragging）+ 被拖行/列浅蓝高亮。
      const GRIP = '\u22EE\u22EE'; // ⋮⋮ 点阵
      const rowTrackEl = document.createElement('span');
      rowTrackEl.className = 'wysiwyg-table-row-handle';
      wrap.appendChild(rowTrackEl);
      const rowGripEl = document.createElement('span');
      rowGripEl.className = 'wysiwyg-table-row-grip';
      rowGripEl.textContent = GRIP;
      rowTrackEl.appendChild(rowGripEl);
      const colTrackEl = document.createElement('span');
      colTrackEl.className = 'wysiwyg-table-col-pill';
      wrap.appendChild(colTrackEl);
      const colGripEl = document.createElement('span');
      colGripEl.className = 'wysiwyg-table-col-grip';
      colGripEl.textContent = GRIP;
      colTrackEl.appendChild(colGripEl);
      // 落点指示线（2026-10-13 反馈 #1/#2：淡蓝背景 = 被拖行/列、蓝色线 = 要拖动到的
      // 位置）：行拖 = 横线（表通宽）、列拖 = 竖线（表通高）。只在拖动态显示，JS 定位
      // 到插入目标前的分界处（末尾 = 表格底缘/右缘）。pointer-events:none 不拦命中。
      const dropLineEl = document.createElement('div');
      dropLineEl.className = 'wysiwyg-table-drop-line';
      wrap.appendChild(dropLineEl);
      // hover 状态 JS 托管（2026-10-13 用户反馈 #3「增行/增列点不到，鼠标一移就消失」）：
      // 按钮定位在表格右/下缘之外（left:100%/top:100% + 6px），而 CM 相邻行同为 z-index:2、
      // 段落后于表格行 → 下方块内容压在按钮上层，CSS :hover 既会因空隙丢失、点击也被
      // 段落 DOM 截获。改由 JS 维护「工具悬停」类：离开 wrap 后延迟 200ms 才隐藏（给鼠标
      // 跨隙到按钮的时间），期间进入按钮则取消隐藏；同时给表格行加类抬 z-index 至 3，
      // 让按钮/悬停桥压到下方块内容之上（行 DOM 可能被 CM 重建，故每次现查）。
      let hideTimer = null;
      const showTools = () => {
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        wrap.classList.add('wysiwyg-table-tools-hover');
        const line = wrap.closest ? wrap.closest('.CodeMirror-line') : null;
        if (line) line.classList.add('wysiwyg-table-line-hover');
      };
      const doHideTools = () => {
        wrap.classList.remove('wysiwyg-table-tools-hover');
        const line = wrap.closest ? wrap.closest('.CodeMirror-line') : null;
        if (line) line.classList.remove('wysiwyg-table-line-hover');
      };
      const scheduleHideTools = () => {
        if (hideTimer) clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
          hideTimer = null;
          if (wrap.matches(':hover')) return; // 仍在 wrap/桥上 → 不藏
          doHideTools();
        }, 200);
      };
      wrap.addEventListener('mouseenter', showTools);
      wrap.addEventListener('mouseleave', scheduleHideTools);
      Array.from(wrap.querySelectorAll('button')).forEach((b) => {
        b.addEventListener('mouseenter', showTools);
        b.addEventListener('mouseleave', scheduleHideTools);
      });
      // 2026-10-13 反馈 #4/#5：增行/增列改为「边缘条带」（右缘竖条 / 下缘横条，见 CSS），
      // 显示条件 = 鼠标移到表格右边/下边一点——条带自身即悬停区（透明时也恒可命中），
      // 鼠标在表格本体上不再显示按钮。200ms 宽限（条带隐藏宽限，防指针快速划过时闪烁）。
      const armStripHover = (stripEl, cls) => {
        let timer = null;
        const show = () => {
          if (timer) { clearTimeout(timer); timer = null; }
          wrap.classList.add(cls);
        };
        const armHide = () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => { timer = null; wrap.classList.remove(cls); }, 200);
        };
        stripEl.addEventListener('mouseenter', show);
        stripEl.addEventListener('mouseleave', armHide);
      };
      armStripHover(colBtn, 'wysiwyg-table-add-col-hover');
      armStripHover(rowBtn, 'wysiwyg-table-add-row-hover');
      // 边缘邻近悬停（2026-10-13 用户参考图 2/3）：鼠标移到某行左边一点（左 gutter）→
      // 亮出该行握点；移到某列上边一点（顶 gutter）→ 亮出该列握点；停在单元格上 →
      // 都不亮（只有拖动才高亮，见用户第 6 条）。两轨互不相交（行轨 x<表左缘，列轨
      // y<表顶缘），故任一时刻至多亮一个握点。CSS 无法跨行选「同列」，列悬停仍由 JS
      // 给整列挂 wysiwyg-col-hover 类（仅作状态标记，无样式——高亮只在拖动态）。
      // 带缓存避免 mousemove 高频重复挂类/重定位。
      let colHoverIdx = -1;
      const setColHover = (i) => {
        if (i === colHoverIdx) return;
        colHoverIdx = i;
        const rows = tableEl.querySelectorAll('tr');
        for (const tr of rows) {
          const cells = tr.children;
          for (let k = 0; k < cells.length; k++) {
            if (cells[k]) cells[k].classList.toggle('wysiwyg-col-hover', k === i);
          }
        }
        // 列握点定位到该列中心。握点的 offsetParent = 列轨（非 wrap）——wrap 加了上下
        // 留白 padding 后必须以列轨 rect 为基准（2026-10-13 反馈 #2 留白改造），
        // 否则握点整体偏移上留白 24px
        if (i >= 0 && rows[0] && rows[0].children[i]) {
          const kr = colTrackEl.getBoundingClientRect();
          const hr = rows[0].children[i].getBoundingClientRect();
          colGripEl.style.left = (hr.left - kr.left + hr.width / 2) + 'px';
          colGripEl.style.opacity = '1';
        } else {
          colGripEl.style.opacity = '0';
        }
      };
      // 行悬停类 + 行握点定位。握点 = 行轨内的可见小把手（灰点阵），JS 移到悬停行中线
      // （top = 行中心 - 实测握点高/2，悬停态 16px）。表头行同样出握点（2026-10-13 反馈 #2：
      // 表头行可拖拽——拖走后落到首位的数据行升为新表头）。
      let rowHoverTr = null;
      const setRowHover = (tr) => {
        if (tr === rowHoverTr) return;
        if (rowHoverTr) { try { rowHoverTr.classList.remove('wysiwyg-row-hover'); } catch (_) { } }
        rowHoverTr = tr;
        if (rowHoverTr) {
          try { rowHoverTr.classList.add('wysiwyg-row-hover'); } catch (_) { }
          // 行握点的 offsetParent = 行轨（top:24px，wrap 上留白之下）——以行轨 rect
          // 为基准定位（2026-10-13 反馈 #2 留白改造）
          const kr = rowTrackEl.getBoundingClientRect();
          const rr = rowHoverTr.getBoundingClientRect();
          // 按实测把手高居中（悬停态 16px → -8；按下/拖动态高 = 行高 → -行高/2）
          const gh = rowGripEl.getBoundingClientRect().height || 16;
          rowGripEl.style.top = (rr.top - kr.top + rr.height / 2 - gh / 2) + 'px';
          rowGripEl.style.opacity = '1';
        } else {
          rowGripEl.style.opacity = '0';
        }
      };
      wrap.addEventListener('mousemove', (e) => {
        // 拖拽进行中：握点由 _wysiwygTableDragMove 按指针连续定位（跟随小手），
        // 这里若再按「指针下行/列中心」重定位，两路写入会打架（胶囊跳动/消失）。
        if (self._wysiwygTableDrag && self._wysiwygTableDrag.moved) return;
        const t = e.target;
        const inRowTrack = !!(t && t.closest && t.closest('.wysiwyg-table-row-handle'));
        const inColTrack = !!(t && t.closest && t.closest('.wysiwyg-table-col-pill'));
        const firstRow = tableEl.querySelector('tr');
        const cells0 = firstRow ? firstRow.children : [];
        if (!cells0.length) { setRowHover(null); setColHover(-1); return; }
        const fr = cells0[0].getBoundingClientRect();
        const gridLeft = fr.left, gridTop = fr.top;
        const gridRight = cells0[cells0.length - 1].getBoundingClientRect().right;
        // 顶 gutter（列轨）→ 该列握点
        if (inColTrack && e.clientY < gridTop && e.clientY >= gridTop - 24 && e.clientX >= gridLeft && e.clientX < gridRight) {
          let ci = -1;
          for (let i = 0; i < cells0.length; i++) {
            const cr = cells0[i].getBoundingClientRect();
            if (e.clientX >= cr.left && e.clientX < cr.right) { ci = i; break; }
          }
          setRowHover(null); setColHover(ci); return;
        }
        // 左 gutter（行轨）→ 该行握点。i 从 0 起：表头行也可拖拽（2026-10-13 反馈 #2，
        // 顶部行拖走后落到首位的数据行升为新表头——moveTableRow 按此语义回写）
        if (inRowTrack && e.clientX < gridLeft && e.clientX >= gridLeft - 24) {
          const trsAll = Array.from(tableEl.querySelectorAll('tr'));
          let tr = null;
          for (let i = 0; i < trsAll.length; i++) {
            const br = trsAll[i].getBoundingClientRect();
            if (e.clientY >= br.top && e.clientY < br.bottom) { tr = trsAll[i]; break; }
          }
          setColHover(-1); setRowHover(tr); return;
        }
        // 停在单元格上或其它位置 → 两握点都隐藏（悬停不高亮）
        setRowHover(null); setColHover(-1);
      });
      wrap.addEventListener('mouseleave', () => { setRowHover(null); setColHover(-1); });
    },

    // 整表块回写（增行/增列/行/列换位）。行数可能变 → 旧块表行号整体位移：
    // replaceRange 后立即重算块表 + 重挂变化块，并清 250ms 输入防抖避免重复解析。
    _wysiwygCommitTableBlock(blockIdx, newSource, origin) {
      const cm = this.cm;
      const b = this._wysiwygBlocks && this._wysiwygBlocks[blockIdx];
      if (!cm || !b) return false;
      const cur = this._wysiwygBlockSource(b);
      if (cur === newSource) return true;
      const lastLine = Math.min(b.end - 1, cm.lineCount() - 1);
      if (lastLine < b.start) return false;
      try {
        cm.replaceRange(newSource,
          { line: b.start, ch: 0 }, { line: lastLine, ch: cm.getLine(lastLine).length },
          origin || '+wysiwygTableStruct');
      } catch (_) { return false; }
      if (this._wysiwygMaskTimer) { clearTimeout(this._wysiwygMaskTimer); this._wysiwygMaskTimer = null; }
      if (this._wysiwygFull) {
        this._refreshWysiwygFullIncremental();
      } else {
        this._wysiwygBlocks = this.computeWysiwygBlocks();
        this._wysiwygVirtual = !!(this._wysiwygBlocks[0] && this._wysiwygBlocks[0].skipped);
        this._ensureWysiwygScrollHook();
        this._wysiwygActiveIdx = this._wysiwygCellEditing ? -1 : this._wysiwygActiveIdxFromCursor();
        if (this._wysiwygMarks) {
          for (const idx of Array.from(this._wysiwygMarks.keys())) this.unmaskWysiwygBlock(idx);
        }
        this.updateWysiwygViewportMasks();
        this.updateWysiwygBlankLines();
        this._applyWysiwygActiveHighlight();
      }
      return true;
    },

    // ＋增行/增列：纯函数重建整块回写 → 自动进入新格的格编辑（Typora 式无缝续输）
    _wysiwygTableAdd(kind, maskNode) {
      const cm = this.cm;
      const idx = maskNode ? parseInt(maskNode.getAttribute('data-block-index'), 10) : NaN;
      const b = (this._wysiwygBlocks && isFinite(idx)) ? this._wysiwygBlocks[idx] : null;
      if (!cm || !b) return;
      // 增行/增列后紧接着进新格编辑：旧格提交用 settle=false（光标由新格接管）
      if (this._wysiwygCellEditing) this._wysiwygEndCellEdit(true, false);
      const src = this._wysiwygBlockSource(b);
      const newSrc = (kind === 'row' ? addTableRow : addTableColumn)(src);
      if (!newSrc || newSrc === src) return;
      const startLine = b.start; // 增行/增列不改块首行，回写后按首行找新块索引
      if (!this._wysiwygCommitTableBlock(idx, newSrc, kind === 'row' ? '+wysiwygTableAddRow' : '+wysiwygTableAddCol')) return;
      const newIdx = this.wysiwygBlockIndexAt(startLine);
      const nb = (newIdx >= 0 && this._wysiwygBlocks) ? this._wysiwygBlocks[newIdx] : null;
      if (!nb) return;
      const rows = this._wysiwygBlockSource(nb).split('\n');
      const lastInfo = splitTableRow(rows[rows.length - 1]);
      if (!lastInfo.cells.length) return;
      // 新格 = 新增行/列的第一个单元格（2026-10-14 用户要求：光标要在新增行的第一个单元格）：
      // 增行 = 新末行首格（tr 序 rows.length-2、第 0 列）；增列 = 新末列表头格（第 0 行、末列）
      const tRow = (kind === 'row') ? rows.length - 2 : 0;
      const tCol = (kind === 'row') ? 0 : lastInfo.cells.length - 1;
      this._wysiwygStartCellEditAt(tRow, tCol, newIdx);
    },

    // 行/列拖拽入口（pointerdown，先于 mousedown）：
    // 行拖拽 = 表格外左缘行把手（wrap 上真实元素）或首格左侧 16px 区按下
    //   → 返回 true（preventDefault 抑制兼容 mousedown → 不触格编辑/光标定位）；
    // 列拖拽 = 表上方蓝色胶囊（wrap 上真实元素）或表头格按下
    //   → 返回 true（胶囊非单元格，不动手 = 无事发生；表头格不动手 = 普通格编辑，
    //     移动超 4px 阈值才真正进入拖拽）。
    _wysiwygTableDragStart(ev) {
      if (!ev || ev.button !== 0) return false;
      const wrap = ev.target && ev.target.closest ? ev.target.closest('.wysiwyg-table-wrap') : null;
      if (!wrap) return false;
      const tableEl = wrap.querySelector('table');
      // 行轨道（wrap 上常驻真实元素，覆盖整条左 gutter）：按 = 按下点 y 所在的那行。
      // 轨道是全高命中区（非单行小把手），故按坐标而非元素盒定位行。
      const rowTrackEl = ev.target && ev.target.closest ? ev.target.closest('.wysiwyg-table-row-handle') : null;
      if (rowTrackEl && tableEl) {
        const trsAll = Array.from(tableEl.querySelectorAll('tr'));
        let idx = -1;
        for (let i = 0; i < trsAll.length; i++) { // 表头行也可拖（反馈 #2）
          const br = trsAll[i].getBoundingClientRect();
          if (ev.clientY >= br.top && ev.clientY < br.bottom) { idx = i; break; }
        }
        if (idx >= 0) {
          this._wysiwygBeginTableDrag({
            kind: 'row', wrap: wrap, tableEl: tableEl, trs: trsAll, idx: idx,
            startX: ev.clientX, startY: ev.clientY, moved: false,
          });
          return true;
        }
      }
      // 列轨道（wrap 上常驻真实元素，覆盖整条顶 gutter）：按 = 按下点 x 所在的那列
      const colTrackEl = ev.target && ev.target.closest ? ev.target.closest('.wysiwyg-table-col-pill') : null;
      if (colTrackEl && tableEl) {
        const trsAll = Array.from(tableEl.querySelectorAll('tr'));
        const headerCells = trsAll[0] ? Array.from(trsAll[0].children) : [];
        let cidx = -1;
        for (let i = 0; i < headerCells.length; i++) {
          const cr = headerCells[i].getBoundingClientRect();
          if (ev.clientX >= cr.left && ev.clientX < cr.right) { cidx = i; break; }
        }
        if (cidx >= 0) {
          this._wysiwygBeginTableDrag({
            kind: 'col', wrap: wrap, tableEl: tableEl, trs: trsAll, idx: cidx,
            startX: ev.clientX, startY: ev.clientY, moved: false,
          });
          return true;
        }
      }
      const cell = ev.target && ev.target.closest ? ev.target.closest('td,th') : null;
      if (!tableEl || !cell) return false;
      const tr = cell.closest('tr');
      const trs = tr ? Array.from(tableEl.querySelectorAll('tr')) : [];
      const rIdx = tr ? trs.indexOf(tr) : -1;
      if (rIdx < 0) return false;
      const isHeader = !!(tr.parentElement && tr.parentElement.tagName === 'THEAD');
      const cIdx = Array.from(tr.children).indexOf(cell);
      const cellRect = cell.getBoundingClientRect();
      // 行把手在表格外左缘（2026-10-13 参考图）：点击区 = [格左缘-16, 格左缘+16)，
      // 下界防止行左侧整条空白 gutter 都被误判成行拖拽。
      const dxRow = ev.clientX - cellRect.left;
      if (!isHeader && cIdx === 0 && dxRow < 16 && dxRow >= -16) {
        this._wysiwygBeginTableDrag({
          kind: 'row', wrap: wrap, tableEl: tableEl, trs: trs, idx: rIdx,
          startX: ev.clientX, startY: ev.clientY, moved: false,
        });
        return true;
      }
      if (isHeader && cIdx >= 0) {
        this._wysiwygBeginTableDrag({
          kind: 'col', wrap: wrap, tableEl: tableEl, trs: trs, idx: cIdx,
          startX: ev.clientX, startY: ev.clientY, moved: false,
        });
        return false;
      }
      return false;
    },

    // 进入拖拽跟踪：登记 window 监听（move/up/cancel/Esc）；按下即变蓝
    // （_wysiwygTablePressVisual，用户反馈「按下鼠标时就要变蓝」），超 4px 阈值才动
    // 拖拽语义（高亮/落点线/取消格编辑）。
    // st.target = 落点（被拖元素在新序列中的下标，move 中按指针计算，up 时提交）——
    // 2026-10-13 反馈 #1/#2 起拖拽中不再实时重排 DOM（被拖行/列原地淡蓝高亮 + 蓝线
    // 指示落点，对齐参考图），终位以 st.target 为准。
    _wysiwygBeginTableDrag(st) {
      const self = this;
      st.maskNode = st.wrap && st.wrap.closest ? st.wrap.closest('.' + MASK_CLASS) : null;
      st.target = st.idx;
      // 按下时刻已存在的格编辑（用户完成的合法编辑）：4px 阈值处**不取消**，释放时
      // 源码重建前提交回写（2026-10-14 用户反馈：改完格内容立即拖行/列内容丢失）。
      // 本次按下才触发的格编辑（表头格按下、不动=误点击）仍是阈值处取消恢复。
      st.cellEditAtDown = this._wysiwygCellEditing;
      this._wysiwygTableDrag = st;
      st.onMove = (e) => self._wysiwygTableDragMove(e);
      st.onUp = (e) => self._wysiwygTableDragUp(e);
      st.onKey = (e) => { if (e.key === 'Escape') self._wysiwygTableDragCancel(); };
      window.addEventListener('pointermove', st.onMove);
      window.addEventListener('pointerup', st.onUp);
      window.addEventListener('pointercancel', st.onUp);
      window.addEventListener('keydown', st.onKey);
      // 按下即变蓝（用户反馈：拖动手按下鼠标时把手就要变蓝，不等拖动阈值）：
      // 把手进拖拽视觉态（蓝底圆角矩形 + 白点阵 + inline 尺寸），但拖拽语义
      // （取消格编辑、被拖行/列高亮、落点线）仍超 4px 阈值才生效——点击不动仍是点击。
      self._wysiwygTablePressVisual(st);
    },

    // 把手按下/拖拽视觉态：轨道挂 .wysiwyg-dragging（CSS 让把手变蓝底圆角矩形、
    // 点变白），并设 inline 尺寸：行拖 = 竖条（宽 16px、高 = 被拖行实测行高）；
    // 列拖 = 横条（宽 = 被拖列宽、最小 26px、高 16px CSS）。点阵文本恒保持未按下
    // 态的 ⋮⋮ 2×3 点阵（2026-10-14 用户反馈：按下/拖动只变背景蓝，不换成单排
    // 竖点/横点）。pointerdown 即调用（按下即变蓝）；结束态清除回落悬停态。
    _wysiwygTablePressVisual(st) {
      try {
        const track = st.wrap && st.wrap.querySelector(
          st.kind === 'row' ? '.wysiwyg-table-row-handle' : '.wysiwyg-table-col-pill');
        if (!track) return;
        track.classList.add('wysiwyg-dragging');
        const grip = track.querySelector('span');
        if (!grip) return;
        // ⋮⋮ 点阵不变，只由 CSS 加蓝底
        if (st.kind === 'row') {
          // 行拖 = 16px 宽竖条 × 行高（与列拖横条同厚 16px）
          const refRow = st.trs[st.idx];
          if (refRow) {
            const rh = refRow.getBoundingClientRect().height;
            if (rh > 0) {
              grip.style.height = rh + 'px';
              // 高度变了（16 → 行高），立刻按行中线重新居中（拖动跟随接管前不偏位）
              const trackRect = track.getBoundingClientRect();
              const rowRect = refRow.getBoundingClientRect();
              grip.style.top = (rowRect.top - trackRect.top + rowRect.height / 2 - rh / 2) + 'px';
            }
          }
        } else {
          const hc = st.trs[0] ? st.trs[0].children[st.idx] : null;
          const cw = hc ? hc.getBoundingClientRect().width : 0;
          grip.style.width = Math.max(26, Math.round(cw)) + 'px';
        }
      } catch (_) { }
    },

    _wysiwygTableDragMove(e) {
      const st = this._wysiwygTableDrag;
      if (!st || !st.tableEl || !st.tableEl.isConnected) return;
      if (!st.moved) {
        if (Math.abs(e.clientX - st.startX) < 4 && Math.abs(e.clientY - st.startY) < 4) return;
        st.moved = true;
        // 本次按下触发的格编辑（表头格按下不动=误点击）：先取消恢复，再真正进入拖拽。
        // 按下前已存在的格编辑（用户改完内容的合法编辑）不在此取消——取消即内容丢失，
        // 改到释放时源码重建前提交回写（_wysiwygTableDragUp，2026-10-14 用户反馈）。
        if (this._wysiwygCellEditing && this._wysiwygCellEditing !== st.cellEditAtDown) this._wysiwygEndCellEdit(false);
        try { document.body.classList.add('wysiwyg-table-dragging'); } catch (_) { }
        if (st.kind === 'row') {
          try { st.trs[st.idx].classList.add('wysiwyg-table-dragging-row'); } catch (_) { }
        } else {
          st.dragCells = Array.from(st.tableEl.querySelectorAll('tr')).map((tr) => tr.children[st.idx]);
          for (const c of st.dragCells) { if (c) c.classList.add('wysiwyg-table-dragging-col'); }
        }
        // 握点变蓝已提前到按下即刻（_wysiwygTablePressVisual）；这里只补拖拽语义：
        // 取消格编辑、被拖行/列浅蓝高亮、落点线随 move 出现。
      }
      // 拖动态：蓝胶囊跟随指针（2026-10-13 反馈 #1：变蓝的块要跟小手一起移动，
      // 行/列同款）。wrap 的 mousemove 拖拽中已让位（不重写回行/列中心），这里按
      // pointermove 连续定位：行拖 = 跟 y（clamp 到行轨），列拖 = 跟 x（clamp 到列轨）。
      try {
        if (st.wrap && st.wrap.isConnected) {
          const trackEl = st.wrap.querySelector(
            st.kind === 'row' ? '.wysiwyg-table-row-handle' : '.wysiwyg-table-col-pill');
          const gripEl = trackEl ? trackEl.querySelector('span') : null;
          if (gripEl) {
            const tr = trackEl.getBoundingClientRect();
            if (st.kind === 'row') {
              const gh = gripEl.getBoundingClientRect().height || 26;
              let top = e.clientY - tr.top - gh / 2;
              top = Math.max(0, Math.min(tr.height - gh, top));
              gripEl.style.top = top + 'px';
            } else {
              // 列拖胶囊是宽横胶囊（2026-10-13 参考图）：按半宽 clamp，胶囊不探出表格
              const gw = gripEl.getBoundingClientRect().width || 20;
              let left = e.clientX - tr.left;
              left = Math.max(gw / 2, Math.min(tr.width - gw / 2, left));
              gripEl.style.left = left + 'px';
            }
          }
        }
      } catch (_) { }
      // 落点计算（2026-10-13 反馈 #1/#2：拖拽中**不再实时重排 DOM**——被拖行/列原地
      // 淡蓝高亮，蓝线指示要拖动到的位置，对齐参考图；释放时按 st.target 一次换位提交）。
      // target = 插入到 others[target] 之前（others = 除被拖项外的原序），末尾 = others.length。
      const trs = Array.from(st.tableEl.querySelectorAll('tr'));
      if (st.kind === 'row') {
        const dragTr = trs.indexOf(st.trs[st.idx]) >= 0 ? st.trs[st.idx] : trs[st.idx];
        const others = trs.filter((t) => t !== dragTr);
        let target = others.length;
        for (let i = 0; i < others.length; i++) {
          const r = others[i].getBoundingClientRect();
          if (e.clientY < r.top + r.height / 2) { target = i; break; }
        }
        st.target = target;
      } else {
        if (!st.dragCells || !st.dragCells[0]) return;
        const headerCells = Array.from(st.trs[0].children);
        const others = headerCells.filter((c) => c !== st.dragCells[0]);
        let target = others.length;
        for (let i = 0; i < others.length; i++) {
          const r = others[i].getBoundingClientRect();
          if (e.clientX < r.left + r.width / 2) { target = i; break; }
        }
        st.target = target;
      }
      // 蓝线定位：行拖横线在 others[target] 顶缘（末尾 = 表格底缘）、列拖竖线在
      // others[target] 左缘（末尾 = 表格右缘），相对 wrap 盒（含上下留白 padding）
      try {
        if (st.wrap && st.wrap.isConnected) {
          const lineEl = st.wrap.querySelector('.wysiwyg-table-drop-line');
          if (lineEl) {
            const wr = st.wrap.getBoundingClientRect();
            if (st.kind === 'row') {
              const all = Array.from(st.tableEl.querySelectorAll('tr'));
              const dragTr = all.indexOf(st.trs[st.idx]) >= 0 ? st.trs[st.idx] : all[st.idx];
              const others = all.filter((t) => t !== dragTr);
              const boundary = st.target < others.length
                ? others[st.target].getBoundingClientRect().top
                : st.tableEl.getBoundingClientRect().bottom;
              lineEl.className = 'wysiwyg-table-drop-line wysiwyg-drop-line-row';
              lineEl.style.left = ''; // 清上一次列拖残留的 inline left（inline 压过 CSS left:0，
                                      // 无提交的拖拽不重建遮罩时残留会让横线从表格右缘起飞）
              lineEl.style.top = (boundary - wr.top - 1) + 'px'; /* 线厚 2px，居中 = 边界 - 1 */
            } else {
              const headerCells = Array.from(st.trs[0].children);
              const others = headerCells.filter((c) => c !== st.dragCells[0]);
              const boundary = st.target < others.length
                ? others[st.target].getBoundingClientRect().left
                : st.tableEl.getBoundingClientRect().right;
              lineEl.className = 'wysiwyg-table-drop-line wysiwyg-drop-line-col';
              lineEl.style.top = ''; // 清上一次行拖残留的 inline top（同理防竖线串位）
              lineEl.style.left = (boundary - wr.left - 1) + 'px'; /* 线厚 2px，居中 = 边界 - 1 */
            }
            lineEl.style.opacity = '1';
          }
        }
      } catch (_) { }
    },

    _wysiwygTableDragUp() {
      const st = this._wysiwygTableDrag;
      if (!st) return;
      const connected = !!(st.tableEl && st.tableEl.isConnected);
      this._wysiwygEndTableDragState();
      if (!st.moved || !connected) {
        // 行/列轨道单击（拖拽未真正发生）或遮罩已失效 + 格仍在编辑：提交失焦
        // （2026-10-14 用户要求：点其他行/空白处单元格失去焦点）。
        // 例外：表头格普通点击——列拖态是表头格 pointerdown 的既有副产物（表头格兼列拖
        // 把手，不动手 = 普通格编辑，反馈 #2），此刻的格编辑是合法点击进的，不得提交。
        // 但真拖过（moved）+ 遮罩已失效时格节点可能已离场，必须立即提交，否则内容丢失。
        const plainHeaderClick = st.kind === 'col' && st.trs && st.trs[0] &&
          !!(this._wysiwygCellEditing && st.trs[0].children[st.idx] === this._wysiwygCellEditing.cell);
        if (this._wysiwygCellEditing && (st.moved || !plainHeaderClick)) this._wysiwygEndCellEdit(true, false);
        return;
      }
      // 拖拽前已存在的格编辑（合法编辑，阈值块未取消）：先提交回写再做源码重建，
      // 内容才不会在重建中丢失（2026-10-14 用户反馈：改完格内容立即拖行/列丢改动；
      // 「先点别处再拖」不丢正是因为 blur 提交已先行）。误触格编辑（表头格按下）
      // 已在阈值块取消，不会到这里。
      // 提交会重挂本块遮罩、旧表格节点离场：st.maskNode 仅剩 data-block-index 属性
      // 可读（detached 节点属性不丢），st.tableEl 供 _wysiwygTableRestoreDom 的
      // 原位释放兜底（作用于离场节点，无害空操作）。
      if (this._wysiwygCellEditing) this._wysiwygEndCellEdit(true, false);
      // 终位 = move 中按指针算出的落点 st.target（被拖项在新序列中的下标）。
      // 2026-10-13 反馈 #1/#2 起拖拽中不再实时重排 DOM，这里不能读 DOM 序（恒为原序）。
      const to = (typeof st.target === 'number' && isFinite(st.target)) ? st.target : st.idx;
      // 无效换位（原位释放）直接返回：拖拽期不动 DOM，无需恢复（保留调用兜底：
      // 若未来重引入中途 DOM 变更，空 thead 等坏结构在此恢复）
      if (to < 0 || to === st.idx) {
        this._wysiwygTableRestoreDom(st);
        return;
      }
      const idx = st.maskNode ? parseInt(st.maskNode.getAttribute('data-block-index'), 10) : NaN;
      const b = (this._wysiwygBlocks && isFinite(idx)) ? this._wysiwygBlocks[idx] : null;
      if (!b) return;
      const src = this._wysiwygBlockSource(b);
      const newSrc = (st.kind === 'row') ? moveTableRow(src, st.idx, to) : moveTableColumn(src, st.idx, to);
      if (newSrc && newSrc !== src) {
        this._wysiwygCommitTableBlock(idx, newSrc, '+wysiwygTableMove');
      } else {
        this._wysiwygTableRestoreDom(st);
      }
    },

    _wysiwygTableDragCancel() {
      const st = this._wysiwygTableDrag;
      if (!st) return;
      const connected = !!(st.tableEl && st.tableEl.isConnected);
      this._wysiwygEndTableDragState();
      if (connected && st.moved) this._wysiwygTableRestoreDom(st);
      // 取消拖拽时若格仍在编辑（轨道单击未超阈值即取消）：提交失焦（同 dragUp 注释）
      if (this._wysiwygCellEditing) this._wysiwygEndCellEdit(true, false);
    },

    _wysiwygTableRestoreDom(st) {
      try {
        if (st.kind === 'row') {
          const trs = Array.from(st.tableEl.querySelectorAll('tr'));
          const dragTr = trs.indexOf(st.trs[st.idx]) >= 0 ? st.trs[st.idx] : null;
          if (!dragTr) return;
          // 表头行（idx 0）：拖拽中离开 thead 会被浏览器自动收进 tbody，
          // 恢复时显式归位 thead（否则留下空 thead + tbody 首行无表头样式的坏结构）
          const thead = st.tableEl.querySelector('thead');
          if (st.idx === 0 && thead && dragTr.parentElement !== thead) {
            thead.appendChild(dragTr);
          } else {
            const others = trs.filter((t) => t !== dragTr);
            dragTr.parentNode.insertBefore(dragTr, others[st.idx] || null);
          }
          dragTr.classList.remove('wysiwyg-table-dragging-row');
        } else {
          if (!st.dragCells) return;
          const rows = Array.from(st.tableEl.querySelectorAll('tr'));
          for (let i = 0; i < rows.length; i++) {
            const cell = st.dragCells[i];
            if (!cell) continue;
            const others = Array.from(rows[i].children).filter((c) => c !== cell);
            rows[i].insertBefore(cell, others[st.idx] || null);
            cell.classList.remove('wysiwyg-table-dragging-col');
          }
        }
      } catch (_) { /* 节点已离场则忽略 */ }
    },

    _wysiwygEndTableDragState() {
      const st = this._wysiwygTableDrag;
      this._wysiwygTableDrag = null;
      if (st) {
        if (st.onMove) window.removeEventListener('pointermove', st.onMove);
        if (st.onUp) window.removeEventListener('pointerup', st.onUp);
        if (st.onUp) window.removeEventListener('pointercancel', st.onUp);
        if (st.onKey) window.removeEventListener('keydown', st.onKey);
        // 握点退出拖动态（提交路径遮罩已重建、旧节点离场，remove 为无害空操作）；
        // 同步清除拖动态的 inline 尺寸（行拖行高胶囊 / 列拖宽横胶囊），回落悬停态
        // ⋮⋮ 点阵（按下不再换点阵文本，textContent 复位为防御性兜底）
        try {
          if (st.wrap && st.wrap.isConnected) {
            const hEls = st.wrap.querySelectorAll('.wysiwyg-dragging');
            for (const el of hEls) {
              el.classList.remove('wysiwyg-dragging');
              const g = el.querySelector('span');
              if (g) {
                g.style.height = '';
                g.style.width = '';
                g.style.top = ''; // 防御：hover 路径本会重写定位，清掉防未来路径漏定位
                g.style.left = '';
                g.textContent = '\u22EE\u22EE';
              }
            }
            // 落点指示线隐藏（2026-10-13 反馈 #1/#2：只在拖动态可见）
            // ⚠️ 必须连 inline 坐标一起清：无提交的拖拽（原位释放/取消）不重建遮罩，同一
            // drop-line 元素存活到下一次拖拽；行拖/列拖各写各的轴（top/left），残留的
            // inline 会压过 CSS left:0/top:24px 让另一方向的线串位（2026-10-14 用户截图
            // 「线跑右边去了」：列拖残留 left=表宽 → 行拖横线从表右缘起飞向右延伸）
            const lineEl = st.wrap.querySelector('.wysiwyg-table-drop-line');
            if (lineEl) {
              lineEl.style.opacity = '0';
              lineEl.style.left = '';
              lineEl.style.top = '';
              lineEl.className = 'wysiwyg-table-drop-line';
            }
          }
        } catch (_) { }
      }
      try { document.body.classList.remove('wysiwyg-table-dragging'); } catch (_) { }
    },

    // 活动块高亮：只给「光标所在行」加底色（2026-10-14 用户要求：列表/引用/段落等块
    // 原来整块灰底、编辑态与渲染态观感差距大 → 改为仅光标行灰底、随光标在块内移动跟随，
    // 块内其余行保持无底色的源文态；配合活动块源文态装饰，编辑态整体贴近渲染态）。
    // 容器块（代码围栏 / 表格）例外，保持「整块灰盒」：渲染态本身就是容器盒，编辑态也应
    // 是盒（灰盒观感是代码块活动态的既有设计）。先撤旧行号集合（编辑后行号可能已位移）
    // 再按当前活动块重挂；_wysiwygActiveIdx 为 -1（光标在块间空行）或光标不在块内时只撤不挂。
    // 调用点：setWysiwygActiveBlock（含同块光标移动路径 = 底色跟随光标）/
    // renderWysiwygMasks / refreshWysiwygBlocks / _refreshWysiwygFullIncremental /
    // clearWysiwygMasks（撤光）。
    _applyWysiwygActiveHighlight() {
      const cm = this.cm;
      if (!cm) return;
      if (this._wysiwygActiveLines) {
        for (const n of this._wysiwygActiveLines) {
          try {
            const h = cm.getLineHandle(n);
            if (h) {
              cm.removeLineClass(h, 'background', ACTIVE_CLASS);
              cm.removeLineClass(h, 'background', ACTIVE_FIRST_CLASS);
              cm.removeLineClass(h, 'background', ACTIVE_LAST_CLASS);
            }
          } catch (_) { /* 行已不存在 */ }
        }
      }
      this._wysiwygActiveLines = null;
      const idx = this._wysiwygActiveIdx;
      const b = (idx != null && idx >= 0 && this._wysiwygBlocks) ? this._wysiwygBlocks[idx] : null;
      if (!b) return;
      const total = cm.lineCount();
      if (b.start >= total) return;
      const last = Math.min(b.end, total) - 1;
      // 容器块整块灰盒；其余块只光标行（选区头行，钳进块内）
      const first = cm.getLine(b.start);
      const wholeBlock = RE.fence.test((first || '').trim()) || RE.table.test(first || '');
      let lo = b.start, hi = last;
      if (!wholeBlock) {
        let head = null;
        try { head = cm.getCursor('head'); } catch (_) { /* 忽略 */ }
        if (head && head.line >= b.start && head.line <= last) { lo = hi = head.line; }
      }
      this._wysiwygActiveLines = [];
      for (let n = lo; n <= hi; n++) {
        this._wysiwygActiveLines.push(n);
        try {
          const h = cm.getLineHandle(n);
          if (!h) continue;
          cm.addLineClass(h, 'background', ACTIVE_CLASS);
          // 单行：同一行挂三个类 = 四角全圆；容器整块：首行仅上角、末行仅下角
          if (n === lo) cm.addLineClass(h, 'background', ACTIVE_FIRST_CLASS);
          if (n === hi) cm.addLineClass(h, 'background', ACTIVE_LAST_CLASS);
        } catch (_) { /* 忽略 */ }
      }
    },

    // ---------------- WYSIWYG 活动块源文态装饰（2026-10-14 用户要求，Typora 式） ----------------
    // 活动块处于未遮罩（源文行）态，按块类型把每行拆若干 text marker 段做「渲染化」显示：
    //   标题（单行）       ：# 前缀小灰 + 正文渲染尺寸/字重（.wysiwyg-heading-*)，h1–h6
    //   列表（ul/ol/task） ：• 圆点 / 数字序号 / ☐☑ 复选框 + 正文预览字族（.wysiwyg-list-*）。
    //                       源字符（-/*/+、[ ]/[x]）宽度收 0 并由 ::before 画出渲染符号
    //                       （光标仍按源字符定位，编辑语义不变：删掉标记字符即退出列表）
    //   代码块（围栏）     ：首行 ```lang / 末行 ``` 灰显（.wysiwyg-code-fence）——
    //                       「编辑态与渲染态的区别就是上下多了三个 `」；灰盒复用活动高亮
    //                       （--code-bg + 首末行圆角，与渲染代码盒同色同角）
    //   引用（> 前缀）     ：> 前缀灰显 + 最外层 > 画左竖条（::before）+ 正文预览字体
    //                       （.wysiwyg-quote-*；删掉 > 即退出引用，与预览 blockquote 观感对齐）
    //   行内语法（通用）   ：粗体/斜体/行内代码/删除线/高亮/链接——标记字符透明（保留宽度）、
    //                       文本段渲染化（.wysiwyg-inline-* / -bold / -italic 等，parseWysiwygInlineSpans
    //                       单遍扫描）；可嵌套在标题/列表/引用的块级 span 内。围栏（代码内容）、
    //                       表格（格编辑是独立机制）、frontmatter 不参与
    //   正文排版（通用）   ：非容器块（段落/列表/引用/标题）逐行挂 .wysiwyg-plain-text 行类——
    //                       预览字族 + 渲染字号（--wysiwyg-text-size，同步「预览字号」设置）+
    //                       行高 1.7 + --text-primary，编辑态整体与渲染态遮罩同观感（2026-10-14
    //                       用户要求「编辑时样式要与渲染时的一样」）
    // 先清后挂幂等（markText 不触发 change，无循环）；调用点：setWysiwygActiveBlock（切块）、
    // change 钩子（行内编辑）、renderWysiwygMasks / 防抖 / 全量增量刷新尾、clearWysiwygMasks（清）。
    // 按当前行文本现判类型：行不再符合语法（用户删掉 # / - / 围栏）→ 仅清不挂。
    _wysiwygApplyActiveDecor(idx) {
      const cm = this.cm;
      if (this._wysiwygActiveDecor) {
        for (const m of this._wysiwygActiveDecor) {
          try { m.clear(); } catch (_) { /* 已销毁 */ }
        }
        this._wysiwygActiveDecor = null;
      }
      if (!cm || !this._wysiwygBlocks) return;
      // 正文排版行类同样先清后挂（行号可能已位移）
      if (this._wysiwygPlainLines) {
        for (const n of this._wysiwygPlainLines) {
          try {
            const h = cm.getLineHandle(n);
            if (h) cm.removeLineClass(h, 'text', 'wysiwyg-plain-text');
          } catch (_) { /* 行已不存在 */ }
        }
        this._wysiwygPlainLines = null;
      }
      this._syncWysiwygTextSize();
      if (idx == null || idx < 0 || idx >= this._wysiwygBlocks.length) return;
      const b = this._wysiwygBlocks[idx];
      if (!b) return;
      if (b.start >= cm.lineCount()) return;
      const first = cm.getLine(b.start);
      const markers = [];
      const add = (lineNo, from, to, cls) => {
        if (to <= from) return;
        try {
          markers.push(cm.markText({ line: lineNo, ch: from }, { line: lineNo, ch: to }, { className: cls }));
        } catch (_) { /* 忽略单段失败 */ }
      };
      if (b.end - b.start === 1 && RE.heading.test(first)) {
        // —— 标题：# 前缀小灰 + 正文渲染尺寸 ——
        const m = /^#{1,6}(?=\s|$)/.exec(first);
        if (m) {
          const level = m[0].length;
          add(b.start, 0, m[0].length, 'wysiwyg-heading-hash wysiwyg-heading-hash-' + level);
          add(b.start, m[0].length, first.length, 'wysiwyg-heading-text wysiwyg-heading-text-' + level);
        }
      } else if (RE.fence.test(first.trim())) {
        // —— 代码块：围栏行灰显（语法标志），盒由活动高亮提供 ——
        add(b.start, 0, first.length, 'wysiwyg-code-fence');
        const last = Math.min(b.end, cm.lineCount()) - 1;
        if (last > b.start) {
          const lastLine = cm.getLine(last);
          if (/^(`{3,}|~{3,})\s*$/.test(lastLine.trim())) add(last, 0, lastLine.length, 'wysiwyg-code-fence');
        }
      } else if ((RE.ul.test(first) || RE.ol.test(first) || RE.task.test(first)) &&
                 !RE.hr.test(first.trim())) {
        // —— 列表：逐行处理（含嵌套缩进行、续行）——
        for (let lineNo = b.start; lineNo < b.end; lineNo++) {
          if (lineNo >= cm.lineCount()) break;
          const line = cm.getLine(lineNo);
          if (line.trim() === '') continue;
          const taskM = RE.task.exec(line);
          const ulM = taskM ? null : RE.ul.exec(line);
          const olM = (taskM || ulM) ? null : RE.ol.exec(line);
          let textStart = line.length;
          if (taskM) {
            const bulletAt = taskM[1].length;
            // 任务行圆点字符只透明、不画 •（渲染预览里任务项 list-style:none，只有复选框）
            add(lineNo, bulletAt, bulletAt + 1, 'wysiwyg-list-bullet wysiwyg-task-bullet');
            const boxAt = bulletAt + 1 + taskM[3].length;
            add(lineNo, boxAt, boxAt + 3,
              'wysiwyg-task-box' + (/[xX]/.test(line.charAt(boxAt + 1)) ? ' checked' : ''));
            textStart = boxAt + 3;
          } else if (ulM) {
            const bulletAt = ulM[1].length;
            add(lineNo, bulletAt, bulletAt + 1, 'wysiwyg-list-bullet');
            textStart = bulletAt + 1 + ulM[3].length;
          } else if (olM) {
            const numAt = olM[1].length;
            add(lineNo, numAt, numAt + olM[2].length + 1, 'wysiwyg-ol-marker');
            textStart = numAt + olM[2].length + 1 + olM[4].length;
          } else {
            // 续行（缩进延续）：正文段从首个非空白字符起（前导缩进保留）
            textStart = line.match(/^\s*/)[0].length;
          }
          add(lineNo, textStart, line.length, 'wysiwyg-list-text');
        }
      } else if (RE.quote.test(first.trimStart())) {
        // —— 引用：> 前缀灰显 + 最外层 > 左竖条 + 正文预览字体（逐行，含嵌套 >）——
        for (let lineNo = b.start; lineNo < b.end && lineNo < cm.lineCount(); lineNo++) {
          const line = cm.getLine(lineNo);
          if (!line || line.trim() === '') continue; // callout 内空行不装饰
          const qm = /^(\s*(?:>[ \t]?)+)/.exec(line);
          if (!qm) continue;
          add(lineNo, 0, qm[1].length, 'wysiwyg-quote-prefix');
          const gtAt = line.indexOf('>');
          if (gtAt >= 0) add(lineNo, gtAt, gtAt + 1, 'wysiwyg-quote-bar');
          add(lineNo, qm[1].length, line.length, 'wysiwyg-quote-text');
        }
      }
      // —— 行内语法（2026-10-14 用户要求，Typora 式）：围栏/表格/frontmatter 之外的块，
      //    逐行 parseWysiwygInlineSpans 挂「标记透明 + 文本渲染」span（可嵌套在上面的
      //    块级 span 内，markText 允许重叠）。行不再成对 → 下次重算自动去样式。
      const isFenceBlock = RE.fence.test(first.trim());
      const isTableBlock = !isFenceBlock && RE.table.test(first);
      const isFrontmatter = b.start === 0 && (first || '').trim() === '---';
      if (!isFenceBlock && !isTableBlock && !isFrontmatter) {
        for (let lineNo = b.start; lineNo < b.end && lineNo < cm.lineCount(); lineNo++) {
          const line = cm.getLine(lineNo);
          if (!line) continue;
          const sps = parseWysiwygInlineSpans(line);
          for (let k = 0; k < sps.length; k++) add(lineNo, sps[k].from, sps[k].to, sps[k].cls);
        }
        // —— 正文排版对齐渲染态（2026-10-14 用户要求：编辑时样式要与渲染时一样）：
        //    围栏/表格/frontmatter 之外的块（段落/列表/引用/标题）逐行挂「预览字族 +
        //    渲染字号/行高/颜色」行类（与遮罩 .wysiwyg-block-mask.preview-content 同参：
        //    --font-preview、行高 1.7、--text-primary、字号=用户「预览字号」设置，
        //    经 --wysiwyg-text-size 同步）。标题/列表符号/行内 span 的 em 系尺寸以此为
        //    基准，挂上后即与渲染态同字号；行高一致也使块「渲染↔源文」切换高度不变。
        this._wysiwygPlainLines = [];
        for (let lineNo = b.start; lineNo < b.end && lineNo < cm.lineCount(); lineNo++) {
          try {
            // 块内空行（松散列表项间空行等）不挂：本类行高 1.7 特异性高于空行塌缩规则
            //（.CodeMirror .cm-wysiwyg-blank .CodeMirror-line 12px），挂了会把空行撑回
            // 全高 → 列表编辑态「多出来很多空白行」（2026-10-14 用户截图）
            if ((cm.getLine(lineNo) || '').trim() === '') continue;
            const h = cm.getLineHandle(lineNo);
            if (h) {
              cm.addLineClass(h, 'text', 'wysiwyg-plain-text');
              this._wysiwygPlainLines.push(lineNo);
            }
          } catch (_) { /* 忽略 */ }
        }
      }
      this._wysiwygActiveDecor = markers.length ? markers : null;
    },

    // 编辑态正文字号同步：渲染态遮罩复制 #preview 的计算字号（用户「预览字号」设置，
    // 默认 16px，含缩放），活动块源文行必须同字号才「编辑=渲染」。把当前值写到 CM
    // 容器变量 --wysiwyg-text-size（.wysiwyg-plain-text 消费）；仅在变化时写，避免
    // 每次光标移动都触发样式重算。harness 无 #preview 时回落 settings/16px。
    _syncWysiwygTextSize() {
      try {
        const cm = this.cm;
        if (!cm || !cm.getWrapperElement) return;
        let size = '';
        try {
          if (this.preview && window.getComputedStyle) {
            const cs = getComputedStyle(this.preview);
            if (cs && cs.fontSize) size = cs.fontSize;
          }
        } catch (_) { /* 预览元素不可用 */ }
        if (!size && this.settings && this.settings.previewFontSize) size = this.settings.previewFontSize + 'px';
        if (!size) return;
        const wrap = cm.getWrapperElement();
        if (wrap && wrap.style.getPropertyValue('--wysiwyg-text-size') !== size) {
          wrap.style.setProperty('--wysiwyg-text-size', size);
        }
      } catch (_) { /* 不阻断装饰 */ }
    },

    // change 钩子：编辑交叠活动块时按当前行文本重算装饰。CM 标记随编辑自动扩缩，
    // 但语法变化（# 增减、- 删除/添加、围栏开关、勾选态翻转、换行拆分）须整体重算。
    // IME 组合期顺延到 compositionend 后的防抖刷新尾，不打断输入。
    _ensureWysiwygActiveDecorHook() {
      if (this._wysiwygActiveDecorHooked || !this.cm) return;
      this._wysiwygActiveDecorHooked = true;
      const self = this;
      this.cm.on('change', (cm, c) => {
        if (self.viewMode !== 'wysiwyg' || self._wysiwygComposing) return;
        if (!c || !c.from || !c.to) return;
        const idx = self._wysiwygActiveIdx;
        if (idx == null || idx < 0) return;
        const b = self._wysiwygBlocks && self._wysiwygBlocks[idx];
        if (!b) return;
        if (c.from.line < b.end && c.to.line >= b.start) self._wysiwygApplyActiveDecor(idx);
      });
    },

    // ---------------- 活动块切换（增量） ----------------

    // 跨块时只处理「旧块恢复遮罩 + 新块撤遮罩」两个块。
    // ⚠️ 绝不可在此做全量重建：曾因每次光标移动触达都全量 clear+重渲染所有块，
    //    造成严重抖动与卡顿（2026-10-06 真机反馈）。
    setWysiwygActiveBlock(idx) {
      // 有格正在源码编辑（表格块仍是遮罩态，不在 prev/idx 里）：登记**下一 tick** 提交。
      // 本方法常由 cursorActivity 调起（CM 的 mousedown operation 内），同步 replaceRange
      // + 重挂遮罩会毁掉 CM 操作还要移动的节点 → NotFoundError（2026-10-13 用户报
      // 「改表格单元格内容时出现报错」）。需要同步提交的场景不受影响：若新活动块正是
      // 在编格所在的表块，unmaskWysiwygBlock 的守卫会在撤罩前同步提交（编辑格 DOM 将被
      // 撤罩销毁），此处的延迟提交届时为 no-op（状态已被守卫清掉）。
      if (this._wysiwygCellEditing) {
        const self = this;
        const cell = this._wysiwygCellEditing.cell;
        setTimeout(() => {
          const st2 = self._wysiwygCellEditing;
          if (!st2 || st2.cell !== cell) return;
          // 延迟 tick 里焦点仍在原格：cursorActivity 是误触发（如 CM 内部刷新带来的
          // 光标事件），继续编辑不提交（防打字到一半被提交、光标跳走）
          try { if (document.activeElement === cell) return; } catch (_) { }
          self._wysiwygEndCellEdit(true);
        }, 0);
      }
      const prev = this._wysiwygActiveIdx;
      if (prev === idx) {
        // ⚠️ 点击锚定必须在这里也消费掉，不能随同 idx 直接 return。
        // 残留的 _wysiwygClickAnchor 会污染下一次普通光标移动：
        // _captureWysiwygAnchor 见它存在而跳过采样，_restoreWysiwygAnchor 却拿陈旧点击
        // 坐标做滚动 → 视口跳到无关位置（2026-10-07 真机反馈「点击后屏幕乱跳」的成因之一）。
        this._restoreWysiwygAnchor();
        // 行号可能已位移（同块内编辑）：高亮跟着重挂，保证底色始终盖在当前块上
        this._applyWysiwygActiveHighlight();
        return;
      }
      this._captureWysiwygAnchor();
      if (prev >= 0) {
        // 旧块刚被编辑过，缓存 html 过期，需重渲
        const b = this._wysiwygBlocks && this._wysiwygBlocks[prev];
        if (b && b.html !== undefined) { b.html = this.renderWysiwygBlockHtml(b.start, b.end); b.src = this._wysiwygBlockSource(b); }
        this.maskWysiwygBlock(prev);
      }
      this.unmaskWysiwygBlock(idx);
      this._wysiwygActiveIdx = idx;
      this._restoreWysiwygAnchor();
      // 活动块源文态装饰（Typora 式：标题#/列表符号/代码围栏）：清旧 + 按新活动块重挂
      // （普通段落等无装饰块为纯清理，no-op）
      this._wysiwygApplyActiveDecor(idx);
      // 撤旧块（prev）行的高亮、给新活动块行挂高亮（一次调用同时完成两端）
      this._applyWysiwygActiveHighlight();
    },

    // 按光标行现算活动块（供结构刷新路径调用：拖拽提交/增行增列重渲、防抖重算、全量
    // 增量刷新）。**已挂遮罩的块不得「激活」**：光标可能正被 reCheckSelection 钳在
    // 某遮罩块内（格编辑期间被钳到旧活动块末行），现算激活它会解罩回源码态
    // （2026-10-14 用户截图「点表格后下面一行还是源代码状态」的重犯路径之一）。
    _wysiwygActiveIdxFromCursor() {
      const cm = this.cm;
      if (!cm) return -1;
      const bi = this.wysiwygBlockIndexAt(cm.getCursor().line);
      if (bi >= 0 && this._wysiwygMarks && this._wysiwygMarks.has(bi)) return -1;
      return bi;
    },

    syncWysiwygActiveBlock() {
      if (this.viewMode !== 'wysiwyg' || !this.cm) return;
      // 格编辑进行中：焦点在格内 contenteditable，任何 CM 块都不该保持源码态。进格编辑
      // 重遮罩旧块时，被钳制光标（reCheckSelection 推到块末行、仍在块内）会触发本同步——
      // 必须在此拦下，否则刚遮的块被重新解罩回源码态（2026-10-14 用户截图「点表格后
      // 下面一行还是源代码状态」的连锁一环）。收尾 settle 在状态清空后才落光标，
      // 届时本守卫不再拦，活动块照常按光标行现算。
      if (this._wysiwygCellEditing) { this._restoreWysiwygAnchor(); return; }
      if (!this._wysiwygBlocks) this._wysiwygBlocks = this.computeWysiwygBlocks();
      const line = this.cm.getCursor().line;
      // 光标落在空行：该行临时恢复全高（光标与「输入 / 可插入内容…」提示需要可见），
      // 离开后由下一次 cursorActivity / 防抖刷新收回塌缩态
      const prevCur = this._wysiwygBlankCurLine;
      if (prevCur != null && prevCur !== line) {
        const blanks = this._wysiwygBlankLines;
        this._setWysiwygBlankClass(prevCur, !!(blanks && blanks.has(prevCur)));
      }
      if (this._isWysiwygBlankLine(line)) {
        this._setWysiwygBlankClass(line, false);
        this._wysiwygBlankCurLine = line;
      } else {
        this._wysiwygBlankCurLine = null;
      }
      let activeIdx = this.wysiwygBlockIndexAt(line);
      if (activeIdx < 0) {
        // 块表滞后输入 250ms（防抖刷新未跑）：Enter 续行后的新行 = 活动块 end 的紧邻下一行，
        // 旧表里没有它 → 朴素现算 -1 会把**当前正在编辑的块**立即重遮成渲染态，且防抖刷新的
        // _wysiwygActiveIdxFromCursor 守卫（marks.has → -1）会把重遮固化——活动块再也回不来
        //（2026-10-15 用户反馈：「提示块里按一次回车就退出编辑渲染了，没法正常换行」；
        // 列表/段落/普通引用同一机制，harness 四类型实测复现）。
        // 紧邻活动块末端的行：同步轻切块（parseOnly，与遮罩点击同一机制）按最新表再查——
        // 新行重切后仍在块内（列表/引用续行）→ 保持活动块继续编辑；真在块外（段落/标题
        // 回车后的新空行、用户离开块）→ 照旧 -1、块恢复渲染。只查紧邻行，远处行（真离开）
        // 不做同步重算，省大文档按键开销。
        const pb = this._wysiwygActiveIdx >= 0 ? this._wysiwygBlocks[this._wysiwygActiveIdx] : null;
        if (pb && line === pb.end) activeIdx = this._wysiwygBlockIndexAtFresh(line);
      }
      this.setWysiwygActiveBlock(activeIdx);
    },

    // ---------------- 抖动补偿（同步） ----------------

    // 块在「渲染态 ↔ 源码态」切换时高度会变，锚点行上方/下方内容随之位移。
    // 做法：**同步**测量光标前后视口 y 的差值并回滚滚动。
    // ⚠️ 不用 rAF：异步补偿本身就是一次可见跳动（曾经错误的写法）。
    // cm.refresh() 同步完成重排后立即测量，本帧内即修正，肉眼无跳。
    //
    // ⚠️ 点击场景不能用本机制（2026-10-07 真机反馈「点击屏幕乱跳」）：
    //    点击时 setCursor 落进**被遮罩块内部的隐藏行**，capture 在隐藏行上取
    //    cursorCoords 得到垃圾值 → 差值要么巨大被放弃（无补偿=可见跳动）、要么错误滚动。
    //    点击走 _wysiwygClickAnchor（把点击的源码行放回点击时的屏幕 y），见下方。
    _captureWysiwygAnchor() {
      const cm = this.cm;
      this._wysiwygAnchorY = null;
      if (!cm || this._wysiwygClickAnchor) return; // 点击场景走点击锚定
      try {
        const c = cm.cursorCoords(null, 'window');
        if (c && typeof c.top === 'number' && isFinite(c.top)) this._wysiwygAnchorY = c.top;
      } catch (_) { /* 量不到就不补偿 */ }
    },

    // 点击锚定的真正执行点：必须由 mousedown handler 在 setSelection 返回之后调用。
    // 此时 CM 的 operation 已结束、DOM 已完成重排，滚动不会被 pending 机制冲掉。
    // ⚠️ 旧实现 scrollIntoView(pos, margin=click.y) 有两处缺陷（2026-10-09 真机「每次点击
    //    都往下滚一段」）：1) scrollIntoView 的 margin 相对**编辑器视口顶**，click.y 是
    //    **窗口坐标**——真机编辑器上方有工具栏+标签栏（约 100px+），基准错位使目标行恒落在
    //    点击点下方「一个工具栏高」处（harness 里编辑器贴窗口顶、基准巧合重合，测不出来）；
    //    2) margin 带内的行完全不做补偿，撤遮罩后行下移多少就停多少。
    //    现改「事后测量 + 差值补偿」（与 _restoreWysiwygAnchor 光标锚点同机制）：点击位置
    //    先换算为编辑器视口内坐标，再把被点源码行顶边精确放回点击处。
    _applyWysiwygClickAnchor() {
      const cm = this.cm;
      const click = this._wysiwygClickAnchor;
      this._wysiwygClickAnchor = null;
      if (!click || !cm) return;
      try {
        const pos = { line: Math.min(Math.max(click.line, 0), cm.lineCount() - 1), ch: 0 };
        const wrapper = cm.getWrapperElement();
        const vh = wrapper ? wrapper.clientHeight : 0;
        // click.y 是窗口坐标，换算成相对编辑器视口顶的位置。
        // ⚠️ 行位置也必须用同一基准：charCoords 的 'window' 坐标减 wrapper 顶。
        //    不能用 'local'——CM5 的 'local' 是文档内容空间（heightAtLine+padding），
        //    不是视口相对坐标，差值会是文档级大数被结构守卫误弃。
        const wrapTop = (wrapper && wrapper.getBoundingClientRect) ? wrapper.getBoundingClientRect().top : 0;
        const localY = click.y - wrapTop;
        const c = cm.charCoords(pos, 'window');
        if (!c || !isFinite(c.top)) return;
        const delta = c.top - wrapTop - localY; // >0：行顶已下移过点击处
        if (!delta || !isFinite(delta)) return;
        // 差值过大说明发生了结构级变化，此时补偿反而更糟，放弃
        if (vh && Math.abs(delta) > vh) return;
        const info = cm.getScrollInfo();
        cm.scrollTo(info.left, info.top + delta);
      } catch (_) { /* 已销毁等，忽略 */ }
    },

    _restoreWysiwygAnchor() {
      const cm = this.cm;
      // 点击场景：这里**不消费** click 锚点，滚动交给 _applyWysiwygClickAnchor。
      // ⚠️ 本方法由 cursorActivity 调起，而 cursorActivity 在 setSelection 的 operation 内部
      //    同步触发——此刻 DOM 尚未重排，CM 会把滚动记为 pending，等 operation 结束时按那时
      //    已变化的布局再应用，锚定必被冲掉（实测落点 505 而点击处是 337，差 168px）。
      //    必须等 setSelection 返回（operation 结束、DOM 已更新）后滚才有效。
      if (this._wysiwygClickAnchor) { this._wysiwygAnchorY = null; return; }
      const before = this._wysiwygAnchorY;
      this._wysiwygAnchorY = null;
      if (before == null || !cm) return;
      try {
        cm.refresh();
        const after = cm.cursorCoords(null, 'window').top;
        const delta = after - before;
        if (!delta || !isFinite(delta)) return;
        // 差值过大说明发生了结构级变化，此时补偿反而更糟，放弃
        const wrapper = cm.getWrapperElement && cm.getWrapperElement();
        const vh = wrapper ? wrapper.clientHeight : 0;
        if (vh && Math.abs(delta) > vh) return;
        const info = cm.getScrollInfo();
        cm.scrollTo(info.left, info.top + delta);
      } catch (_) { /* 已销毁等，忽略 */ }
    },

    // ---------------- 整体重建 / 清理 ----------------

    // 全量重建：仅在进入模式、切标签、打开文件时调用。
    // 输入过程中禁止调用本方法（每次按键全量重渲染 = 卡顿，见 setWysiwygActiveBlock 注释）。
    // finally 释放预渲染 loading 层：经预渲染管线进入时，loading 必须盖到「遮罩挂完」
    //（挂块 + refresh + 冲刷异步 pass 是数秒同步步骤），否则露「loading 消失 → 源码/空白
    // 数秒 → 才渲染」（2026-10-13 反馈 #1）。所有提前返回路径（在飞守卫/非 wysiwyg/空文档/
    // 空块表）同样在此释放，保证引用计数配对、覆盖层不残留。
    renderWysiwygMasks() {
      const cm = this.cm;
      if (!cm) { this._wysiwygReleasePreRenderLoad(); return; }
      try {
        // 后台预渲染在飞时不得前台现算块表（全量同步预渲染会露数秒源码、且与后台重复劳动）：
        // 预渲染完成时会再走一次 applyViewMode → 本方法携缓存块表重入（_wysiwygPreRendering 已置 false）。
        if (this._wysiwygPreRendering) return;
        // 先取走后台预渲染的块表快照（clearWysiwygMasks 会清掉未消费的结果）
        const preBlocks = this._wysiwygPreRenderedBlocks;
        const preValue = this._wysiwygPreRenderedValue;
        this._wysiwygPreRenderedBlocks = null;
        this._wysiwygPreRenderedValue = null;
        this.clearWysiwygMasks();
        if (this.viewMode !== 'wysiwyg') return;
        if (!cm.lineCount || cm.lineCount() === 0) return;
        // 进入/停留在所见即所得：编辑器外壳按阅读模式对齐（去行号、maxWidth 居中）
        this.applyWysiwygEditorChrome();

        // 全量预渲染：行数 ≤ 上限 → 整篇文档成为 CM 视口（所有行恒渲染 + 恒实测高度、
        // 不释放不重估、几何自愈）；超限 → 虚拟模式（视口 ± 增强预取按需挂遮罩）
        const full = cm.lineCount() <= WYSIWYG_FULL_RENDER_MAX_LINES;
        this._wysiwygFull = full;

        // 块表：优先复用后台预渲染结果（昂贵步骤已完成、且预渲染期间源文未变）；
        // 否则全量模式前台全量渲染（单一同步任务：遮罩就绪后浏览器一次成帧，
        // 不露源码中间态），虚拟模式保持原逻辑
        let blocks = (preBlocks && preValue != null && cm.getValue() === preValue) ? preBlocks : null;
        if (!blocks) blocks = full ? this.precomputeWysiwygBlocksFull() : this.computeWysiwygBlocks();
        this._wysiwygBlocks = blocks || [];
        this._wysiwygMarks = this._wysiwygMarks || new Map();
        if (this._wysiwygBlocks.length === 0) return;
        // 大文档：块数超限 → 渲染器跳过逐块渲染（skipped），滚动时按视口按需渲染
        this._wysiwygVirtual = !full && !!(this._wysiwygBlocks[0] && this._wysiwygBlocks[0].skipped);
        this._ensureWysiwygScrollHook();
        this._ensureWysiwygTableClickGuard();
        this._ensureWysiwygTableTypeGuard();
        this._ensureWysiwygActiveDecorHook();

        this._wysiwygActiveIdx = this.wysiwygBlockIndexAt(cm.getCursor().line);
        if (full) {
          this._enterWysiwygFullView();
        } else {
          this.updateWysiwygViewportMasks();
        }
        try { cm.refresh(); } catch (_) { /* ignore */ }
        // refresh 后全量模式所有行已物化（viewportMargin=行数+100）：立刻冲刷异步 pass，
        // 不等 0-timer——TOC/图片/图表在首帧渲染时即就绪（阅读模式进入后也是首帧就绪）。
        this.flushWysiwygAsyncPasses();
        this.updateWysiwygBlankLines();
        this._applyWysiwygActiveHighlight();
        this._wysiwygApplyActiveDecor(this._wysiwygActiveIdx);
      } finally {
        this._wysiwygReleasePreRenderLoad();
      }
    },

    // 全量视图驻留：挂全部非活动块遮罩（单 operation 批量 DOM），并把视口扩到整篇
    // （直接写 cm.options，不走 setOption——viewportMargin 选项处理器自带 cm.refresh()，
    // 会多一次全量重渲染；下方显式 cm.refresh() 统一完成全量渲染 + 高度实测）。
    // 所有行恒渲染、行高恒实测：CM refresh() 内部 estimateLineHeights（重置回源文估计）
    // 会在同一次全量视图重渲中被重测回正——几何自愈（2026-10-09 实测：任意位置
    // 首跳落点误差 ≤0.5px，refresh 后不漂移）。
    _enterWysiwygFullView() {
      const cm = this.cm;
      if (!cm) return;
      try { cm.options.viewportMargin = cm.lineCount() + 100; } catch (_) { /* 失败退回默认视口 */ }
      try {
        cm.operation(() => {
          for (let k = 0; k < this._wysiwygBlocks.length; k++) {
            if (k === this._wysiwygActiveIdx) continue;
            this.maskWysiwygBlock(k);
          }
        });
      } catch (e) { console.error('[wysiwyg] 全量遮罩挂载失败:', e); }
    },

    // 输入停止后补齐：重算块划分并对非活动块刷新渲染结果。
    // 输入期间只更新行索引缓存（极廉价），把昂贵的渲染推迟到这里。
    refreshWysiwygBlocks() {
      if (this.viewMode !== 'wysiwyg' || !this.cm) return;
      if (this._wysiwygMaskTimer) clearTimeout(this._wysiwygMaskTimer);
      const self = this;
      this._wysiwygMaskTimer = setTimeout(() => {
        self._wysiwygMaskTimer = null;
        if (self.viewMode !== 'wysiwyg') return;
        // IME 组合期间重排会打断输入法导致吞字：顺延到 compositionend（那里会再调本方法）
        if (self._wysiwygComposing) {
          self.refreshWysiwygBlocks();
          return;
        }
        // 全量模式：只重切块边界（仅解析、轻）+ 仅重挂源文变化的块——万行文档
        // 每次输入停顿全量重挂（逐块重跑后处理）会卡数秒
        if (self._wysiwygFull) {
          self._refreshWysiwygFullIncremental();
          return;
        }
        // 块重划分（含解析）推迟到此处统一做；索引会位移，活动块按光标行现算。
        // 格编辑中例外：光标被钳在旧活动块末行，现算会把已遮罩的旧块重新判活动
        // （解罩回源码态）；格编辑期恒 -1 = 全部遮罩（2026-10-14 同批修复）。
        self._wysiwygBlocks = self.computeWysiwygBlocks();
        self._wysiwygActiveIdx = self._wysiwygCellEditing ? -1 : self._wysiwygActiveIdxFromCursor();
        self._wysiwygVirtual = !!(self._wysiwygBlocks[0] && self._wysiwygBlocks[0].skipped);
        self._ensureWysiwygScrollHook();
        // 全部撤掉再按视口重挂（非虚拟模式窗口=全文，等效于全量重挂）
        if (self._wysiwygMarks) {
          for (const idx of Array.from(self._wysiwygMarks.keys())) self.unmaskWysiwygBlock(idx);
        }
        self.updateWysiwygViewportMasks();
        self.updateWysiwygBlankLines();
        self._applyWysiwygActiveHighlight();
        self._wysiwygApplyActiveDecor(self._wysiwygActiveIdx);
      }, 250);
    },

    // 全量模式增量刷新：重切块边界（仅解析），源文未变的块保留旧 markText 标记
    //（CM 标记在编辑后自动跟随文本，marker.find() 为实时位置；节点、实测行高不动），
    // 仅重挂变化/新增/分裂/合并的块——零闪烁、无全量重渲染（2026-10-09）。
    _refreshWysiwygFullIncremental() {
      const cm = this.cm;
      if (!cm) return;
      const oldBlocks = this._wysiwygBlocks || [];
      const newBlocks = this.computeWysiwygBlocks(true) || [];
      // 行数可能变化：重设全量视图驻留
      try { cm.options.viewportMargin = cm.lineCount() + 100; } catch (_) { /* 忽略 */ }
      // 源文本 → 新块索引队列（同源多块按文档顺序匹配）
      const srcQueue = new Map();
      for (let i = 0; i < newBlocks.length; i++) {
        const b = newBlocks[i];
        b.src = this._wysiwygBlockSource(b);
        if (!srcQueue.has(b.src)) srcQueue.set(b.src, []);
        srcQueue.get(b.src).push(i);
      }
      const nextMarks = new Map(); // 新块索引 → 复用的旧标记
      for (const [oi, mark] of Array.from(this._wysiwygMarks || [])) {
        const ob = oldBlocks[oi];
        // 同一源文本可能对应多个块（重复段落/列表项），队列按文档顺序消费；
        // 其中一块被删/改写后队列会提前取空——取不到就撤掉该旧遮罩走重挂，
        // 绝不能拿 undefined 当新索引（2026-10-09 真机：重复行文档编辑即崩）
        const queue = ob ? srcQueue.get(ob.src) : undefined;
        if (!ob || !queue || !queue.length) continue;
        const ni = queue.shift();
        const nb = newBlocks[ni];
        if (!nb) continue;
        nb.html = (ob.html !== undefined) ? ob.html : nb.html; // 复用缓存 html
        nextMarks.set(ni, mark);
        // 块索引位移：同步遮罩节点上的块号，点击映射才落对块
        if (ni !== oi) {
          try { if (mark.replacedWith) mark.replacedWith.setAttribute('data-block-index', String(ni)); } catch (_) { /* 忽略 */ }
        }
      }
      // 未匹配旧遮罩撤除（源文变化/分裂/合并/删除）
      const keptSet = new Set(nextMarks.values());
      this._wysiwygBlocks = newBlocks;
      // 格编辑中例外（同 refreshWysiwygBlocks 注释）；_wysiwygActiveIdxFromCursor
      // 在此以旧 marks 判定（swap 在下方 operation 内），被钳光标落在旧遮罩块 → -1
      this._wysiwygActiveIdx = this._wysiwygCellEditing ? -1 : this._wysiwygActiveIdxFromCursor();
      try {
        cm.operation(() => {
          for (const mark of Array.from(this._wysiwygMarks.values())) {
            if (!keptSet.has(mark)) {
              try { mark.clear(); } catch (_) { /* 已销毁 */ }
              this._dropWysiwygMaskNode(mark.replacedWith);
            }
          }
          this._wysiwygMarks = nextMarks;
          // 重挂缺口的块（变化/新增/分裂/合并；活动块保持源码态）
          for (let k = 0; k < newBlocks.length; k++) {
            if (k === this._wysiwygActiveIdx || nextMarks.has(k)) continue;
            this.maskWysiwygBlock(k);
          }
        });
      } catch (e) { console.error('[wysiwyg] 全量增量刷新失败:', e); }
      this.updateWysiwygBlankLines();
      this._applyWysiwygActiveHighlight();
      this._wysiwygApplyActiveDecor(this._wysiwygActiveIdx);
    },

    // 视口受限遮罩：小文档（≤ maxBlocks）遮全部非活动块；大文档只遮视口 ± 边距内的块，
    // 滚动时由 scroll 钩子增量挂/撤——超大文档（如 18k 行）不可能整篇挂遮罩。
    updateWysiwygViewportMasks() {
      const cm = this.cm;
      if (this.viewMode !== 'wysiwyg' || !cm || !this._wysiwygBlocks) return;
      const blocks = this._wysiwygBlocks;
      const active = this._wysiwygActiveIdx;
      let lo = 0;
      let hi = cm.lineCount();
      if (this._wysiwygVirtual) {
        const vp = cm.getViewport();
        // 增强预取：沿滚动方向加大遮罩窗口（双余量），用户到达前遮罩已就绪
        //（快速滚动零源码闪现）；尾随方向保持原余量防新露区闪
        let above = WYSIWYG_VIEWPORT_MARGIN;
        let below = WYSIWYG_VIEWPORT_MARGIN;
        try {
          const top = cm.getScrollInfo().top;
          if (this._wysiwygLastScrollTop != null) {
            if (top > this._wysiwygLastScrollTop) { above = WYSIWYG_PREFETCH_MARGIN; below = WYSIWYG_PREFETCH_MARGIN * 2; }
            else if (top < this._wysiwygLastScrollTop) { above = WYSIWYG_PREFETCH_MARGIN * 2; below = WYSIWYG_PREFETCH_MARGIN; }
          }
          this._wysiwygLastScrollTop = top;
        } catch (_) { /* 读不到滚动位置退回默认余量 */ }
        lo = Math.max(0, vp.from - above);
        hi = Math.min(cm.lineCount(), vp.to + below);
      }
      const inWindow = (b) => b.end > lo && b.start < hi;

      // —— 滚动锚定 ——
      // 挂/撤遮罩会改变文档高度（渲染态块 ≠ 源码态块高度），不补偿则视口内容漂移，
      // 用户感知为「滚动/点击时到处乱跳」（2026-10-07 真机反馈，大文档虚拟模式最明显）。
      // 做法：更新前取视口顶行及其窗口位置，更新 + refresh 后把该行滚回原位。
      let anchor = null;
      if (this._wysiwygVirtual) {
        try {
          const wrapTop = cm.getWrapperElement().getBoundingClientRect().top;
          const topChar = cm.coordsChar({ left: 0, top: wrapTop + 2 }, 'window');
          if (topChar && typeof topChar.line === 'number' && topChar.line >= 0) {
            anchor = { line: topChar.line, winTop: cm.charCoords(topChar, 'window').top };
          }
        } catch (_) { /* 量不到就不补偿 */ }
      }

      // 撤窗外 + 挂窗内（单 operation 批量：逐块独立操作 = 多次 display 更新）
      cm.operation(() => {
        // 撤掉窗外遮罩
        for (const [idx, mark] of Array.from(this._wysiwygMarks)) {
          const b = blocks[idx];
          if (!b || !inWindow(b)) {
            try { mark.clear(); } catch (_) { /* 已销毁 */ }
            this._wysiwygMarks.delete(idx);
            this._dropWysiwygMaskNode(mark.replacedWith);
          }
        }
        // 挂上窗内缺失遮罩（skipped 块在 mask 时按需渲染切片）
        for (let k = 0; k < blocks.length; k++) {
          if (k === active || this._wysiwygMarks.has(k)) continue;
          if (!inWindow(blocks[k])) continue;
          this.maskWysiwygBlock(k);
        }
      });
      // 显式冲刷异步 pass：operation 已结束、widget 已入 DOM。既覆盖本批新挂的遮罩，
      // 也捡回此前挂上但行未物化、此刻随视口滚动新物化的待跑节点。
      this.flushWysiwygAsyncPasses();

      if (anchor) {
        try {
          // 格编辑进行中不 refresh（同 _wysiwygRefreshAfterMaskChange 的守卫：refresh 会
          // 重建行 DOM、打掉聚焦中的格），滚动锚定补偿一并跳过——下轮滚动会重新锚定。
          if (this._wysiwygCellEditing) return;
          cm.refresh();
          // 迭代收敛：markText 后 CM 的高度重算与滚动落定存在时序差，单次 scrollTo
          // 常被部分 clamp（实测残留 80~120px）。每轮量一次残差、滚一次，2px 内收敛；
          // 残差不收敛（连续同值）说明 DOM 高度尚未落定，继续也无益，随即放弃。
          let prevDelta = Infinity;
          for (let i = 0; i < 6; i++) {
            const c = cm.charCoords({ line: anchor.line, ch: 0 }, 'window');
            const delta = c && isFinite(c.top) ? c.top - anchor.winTop : 0;
            if (!delta || !isFinite(delta) || Math.abs(delta) < 2) break;
            if (delta === prevDelta) break;        // 滚了但没效果，DOM 未落定
            prevDelta = delta;
            const info = cm.getScrollInfo();
            // 大位移（一次性滚到远处、顶部渲染块撤掉造成结构级位移）直接一步补偿：
            // CM 会把 scrollTop 钳制在可滚动范围内不会越界，循环复测残差直至收敛
            //（旧的「delta > 视口高即放弃」会让视口停在错误位置，远距跳转时露出别处内容）。
            this._wysiwygAnchorRestoring = true;
            try { cm.scrollTo(info.left, info.top + delta); }
            finally { const self = this; setTimeout(() => { self._wysiwygAnchorRestoring = false; }, 0); }
          }
        } catch (_) { /* 忽略 */ }
      }
    },

    // 表格源码态点击守卫（幂等，2026-10-14 用户要求：点表格右侧/下方空白不得让表格变
    // 源码态，只有块右上「编辑」按钮可进源码模式）：点在表格网格同高的行背景（网格左/右
    // 空白）或表格末行之下时，CM 坐标映射会把光标落到表格源码行 → 表格块被判活动块撤罩
    // → 表格变源码。capture 阶段拦截：点击映射行落在某个**已挂遮罩**表格块区间内即
    // preventDefault（CM 的 onMouseDown 先查 defaultPrevented，见 codemirror.js 的
    // signalDOMEvent——不挪光标，表格保持渲染态）。遮罩内部点击（格/轨道/条带/按钮）
    // 由遮罩自己的 mousedown 派发，此处先行排除；表格已是源码态（无遮罩）时不拦，
    // 正常编辑源码行。
    _ensureWysiwygTableClickGuard() {
      if (this._wysiwygTableClickGuarded || !this.cm) return;
      this._wysiwygTableClickGuarded = true;
      const self = this;
      const wrapper = this.cm.getWrapperElement ? this.cm.getWrapperElement() : null;
      if (!wrapper) return;
      wrapper.addEventListener('mousedown', (ev) => {
        if (self.viewMode !== 'wysiwyg' || !ev || ev.button !== 0) return;
        const t = ev.target;
        if (!t || !t.closest) return;
        if (t.closest('.' + MASK_CLASS)) return;     // 遮罩自行派发点击
        if (t.closest('.CodeMirror-gutter')) return; // 行号 gutter 无表格
        const cm = self.cm;
        if (!cm || !cm.coordsChar) return;
        let pos = null;
        try { pos = cm.coordsChar({ left: ev.clientX, top: ev.clientY }); } catch (_) { return; }
        if (!pos || !isFinite(pos.line)) return;
        const idx = self.wysiwygBlockIndexAt(pos.line);
        if (idx < 0) return;
        const mk = self._wysiwygMarks && self._wysiwygMarks.get(idx);
        const maskNode = mk && mk.replacedWith;
        if (!maskNode || !maskNode.querySelector || !maskNode.querySelector('.wysiwyg-table-wrap')) return;
        // 格编辑中点表格外空白（本守卫吞掉区）：同样先提交失焦（2026-10-14 用户要求：
        // 点空白处单元格失去焦点）；光标仍不动，表格块保持渲染态
        if (self._wysiwygCellEditing) self._wysiwygEndCellEdit(true, false);
        ev.preventDefault(); // 光标不动：表格块保持遮罩（渲染）态
      }, true);
    },

    // 表下输入守卫（2026-10-14 用户要求 #1 根因修复）：GFM 里表格最后一行**之下紧邻**
    // 的非空文本行（中间没有空行）会被解析成表格的一行——用户在表格正下方空行上输入
    // 内容，块表重算就把该行吸进表格、光标行落入表格块 → 判活动块撤罩 →「表格下面
    // 的一行一旦输入内容，表格就会变成源码格式」。检测「已挂遮罩表格块的末行之下的
    // （原为空白）行被插入非空白文本」，把输入整体下移一行：空行留在表格与文本之间
    // （保持分隔），表格保持渲染态，文本成为独立块。
    // 返回 true = 已下移。
    _wysiwygPushTypedLineBelowTable(L) {
      const cm = this.cm;
      if (!cm || this.viewMode !== 'wysiwyg' || !isFinite(L)) return false;
      const blocks = this._wysiwygBlocks;
      if (!blocks || !blocks.length) return false;
      let bi = -1, above = null;
      for (let i = 0; i < blocks.length; i++) {
        if (blocks[i].end === L) { above = blocks[i]; bi = i; break; }
        if (blocks[i].start > L) break;
      }
      if (!above) return false;
      const mk = this._wysiwygMarks && this._wysiwygMarks.get(bi);
      const node = mk && mk.replacedWith;
      if (!node || !node.querySelector || !node.querySelector('.wysiwyg-table-wrap')) return false;
      const line = cm.getLine(L);
      if (!line || line.trim() === '') return false;
      try {
        cm.replaceRange('\n', { line: L, ch: 0 }, { line: L, ch: 0 }, '+wysiwygTableTypeGuard');
        cm.setSelection({ line: L + 1, ch: line.length }, { line: L + 1, ch: line.length }, { scroll: false });
      } catch (_) { return false; }
      return true;
    },

    // 表下输入守卫接线（幂等）：
    // · change：直接输入/粘贴路径（纯插入、单行、原行空白、上方是已挂遮罩表格末行）→ 下移；
    // · compositionend：中文输入——组合期 change（*compose 拼音串）跳过（组合中移文字
    //   会打断输入法），compositionend 时文字已落定在该空行上，此时下移。
    // 防抖重算（250ms）在下移之后的稳定结构上运行，表格块边界不再扩张。
    _ensureWysiwygTableTypeGuard() {
      if (this._wysiwygTableTypeGuarded || !this.cm) return;
      this._wysiwygTableTypeGuarded = true;
      const self = this;
      this.cm.on('change', (cm, c) => {
        // CM5 change 事件参数 = 单个 change 对象 {from, to, text, removed, origin}
        if (self.viewMode !== 'wysiwyg' || self._wysiwygComposing) return;
        if (!c || !c.from || !c.to || !Array.isArray(c.text)) return;
        // 仅纯插入（零宽替换 from==to）：CM5 对零宽插入也报告 removed=['']（长度 1），
        // 不能按 removed 判「未删内容」，须按 from/to 同点判
        if (c.from.line !== c.to.line || c.from.ch !== c.to.ch) return;
        const L = c.from.line;
        const ins = c.text.join('');
        if (ins.trim() === '') return; // 纯空白不构成表格行，无需下移
        const lineNow = cm.getLine(L);
        // 插入前的行内容（同行纯插入：从当前行内容中挖掉新插文本，它落在 [from.ch, from.ch+len)）
        const before = lineNow.slice(0, c.from.ch) + lineNow.slice(c.from.ch + ins.length);
        if (before.trim() !== '') return; // 该行原本有内容（不是分隔空行）
        self._wysiwygPushTypedLineBelowTable(L);
      });
      this.cm.on('compositionend', () => {
        const cm = self.cm;
        if (self.viewMode !== 'wysiwyg' || !cm) return;
        const cur = cm.getCursor();
        self._wysiwygPushTypedLineBelowTable(cur.line);
      });
    },

    // scroll 钩子（幂等）：虚拟模式下滚动时增量更新视口内遮罩
    _ensureWysiwygScrollHook() {
      if (this._wysiwygScrollHooked || !this.cm) return;
      this._wysiwygScrollHooked = true;
      let t = null;
      const self = this;
      this.cm.on('scroll', () => {
        if (self.viewMode !== 'wysiwyg' || !self._wysiwygVirtual) return;
        if (self._wysiwygAnchorRestoring) return; // 滚动锚定的恢复性滚动，不再触发更新
        if (t) clearTimeout(t);
        t = setTimeout(() => { t = null; self.updateWysiwygViewportMasks(); }, 120);
      });
    },

    // ---------------- 全量预渲染（≤ WYSIWYG_FULL_RENDER_MAX_LINES 行） ----------------

    // 全量预渲染入口（Q9a，2026-10-09 用户确认）：由 theme.js setViewMode('wysiwyg')
    // 拦截调用。当前视图保持不动，模式按钮显示「渲染中」，后台（让出一帧后的
    // setTimeout）完成全部块 html 的昂贵渲染；完成后才切换到所见即所得视图并挂遮罩——
    // 全程不露源码中间态。返回 true = 预渲染已启动（调用方须立即中止同步切换流程）。
    beginWysiwygPreRender() {
      const cm = this.cm;
      if (!cm || !cm.lineCount || cm.lineCount() === 0) return false;
      if (cm.lineCount() > WYSIWYG_FULL_RENDER_MAX_LINES) return false;
      if (this._wysiwygPreRendering) return true; // 已在飞，不重启
      // 切换前快照：滚动锚点（复制 setViewMode 的取值逻辑，此刻视图仍是旧模式）
      const tab = this.activeTab;
      const modeAtStart = this.viewMode;
      if (tab) {
        if (this.preview) tab.previewScrollTop = this.preview.scrollTop;
        if (modeAtStart === 'edit') {
          try {
            const si = cm.getScrollInfo();
            tab.scrollPos = { top: si.top, left: si.left };
            this._pendingSwitchAnchorLine = cm.lineAtHeight(si.top, 'local') + 1;
          } catch (_) { /* 忽略 */ }
        } else if (this.preview && modeAtStart === 'preview') {
          try { this._pendingSwitchAnchorLine = this._lineAtPreviewTop(this.preview.scrollTop); } catch (_) { /* 忽略 */ }
        }
      } else {
        this._pendingSwitchAnchorLine = null;
      }
      this._wysiwygPreRendering = true;
      // 面板 loading 层：预渲染期间主区仍是旧视图，盖住它，否则用户看到「全是源码过几秒
      // 才渲染出来」（2026-10-11 用户反馈 #2）。复用引用计数的 _beginPaneLoad/_endPaneLoad
      //（与切标签的 loading 嵌套安全）；harness 等无此函数的环境静默跳过。
      // ⚠️ loading 层**不在预渲染完成时释放**：applyViewMode 的 50ms 计时器之后，
      // renderWysiwygMasks 还要挂全部遮罩（挂块 + refresh + 冲刷异步 pass，大文档数秒的
      // 同步步骤）——早放则「loading 消失 → 数秒源码/空白 → 才渲染」（2026-10-13 用户
      // 反馈 #1）。持有标志按代（gen）配对：释放点 = renderWysiwygMasks 挂完（finally）/
      // 中止 / 取消 / 离开所见即所得，四处恰好其一（见 _wysiwygReleasePreRenderLoad）。
      if (typeof this._beginPaneLoad === 'function') this._beginPaneLoad();
      this._wysiwygPreRenderLoadOpen = true;
      const valueAtStart = cm.getValue(); // 完成后校验源文未变
      this._wysiwygPreRenderedValue = valueAtStart;
      this._wysiwygPreRenderTab = tab || null;
      this._wysiwygPreRenderMode = modeAtStart;
      this._wysiwygPreRenderGen = (this._wysiwygPreRenderGen || 0) + 1;
      const gen = this._wysiwygPreRenderGen;
      this._wysiwygPreRenderLoadGen = gen; // 本代预渲染持有 loading 层（释放时按代配对）
      this._setWysiwygButtonRendering(true);
      const self = this;
      // 先让按钮 spinner 绘一帧再跑昂贵同步步骤（wysiwyg.js 禁用 rAF，用 setTimeout）
      this._wysiwygPreRenderTimer = setTimeout(() => {
        self._wysiwygPreRenderTimer = null;
        if (!self._wysiwygPreRendering || self._wysiwygPreRenderGen !== gen) return; // 已取消
        let blocks = null;
        try { blocks = self.precomputeWysiwygBlocksFull(); }
        catch (e) { console.error('[wysiwyg] 预渲染失败，退回前台渲染:', e); }
        if (!self._wysiwygPreRendering || self._wysiwygPreRenderGen !== gen) return; // 渲染中又被取消
        if (self.activeTab !== self._wysiwygPreRenderTab || self.viewMode !== self._wysiwygPreRenderMode) {
          // 期间切了标签 / 改了模式：放弃本次进入，不切视图
          self._wysiwygPreRendering = false;
          self._wysiwygReleasePreRenderLoad(); // 不进入所见即所得，loading 层在此收尾
          self._setWysiwygButtonRendering(false);
          return;
        }
        self._wysiwygPreRendering = false;
        // 注意：此处**不**释放 loading 层——applyViewMode 的 50ms 计时器之后 renderWysiwygMasks
        // 还要挂全部遮罩（数秒同步步骤），早放会露「源码/空白数秒」（2026-10-13 反馈 #1）；
        // 由 renderWysiwygMasks 的 finally 在挂完后释放。
        self._setWysiwygButtonRendering(false);
        // 执行真正的模式切换（applyViewMode 的 50ms 计时器会消费预渲染块表挂遮罩）
        self.viewMode = 'wysiwyg';
        const t = self.activeTab;
        if (t && t.filePath && window.FileTypes && window.FileTypes.classifyFile(t.filePath) === 'markdown') {
          self._sessionMdViewMode = 'wysiwyg';
        }
        self.applyViewMode();
        // 预渲染结果在 applyViewMode 内部 clearWysiwygMasks 之后写入、
        // 50ms 计时器 renderWysiwygMasks 消费之前落位，时序恰好
        self._wysiwygPreRenderedBlocks = blocks;
        self._wysiwygPreRenderedValue = valueAtStart;
      }, 50);
      return true;
    },

    // 取消在飞的全量预渲染（用户抢先切到别的模式 / 切标签 / 离开所见即所得）
    // 释放本代预渲染持有的 loading 层（beginWysiwygPreRender 里 _beginPaneLoad 的配对收尾）。
    // 按代（gen）配对：只有「当前代」的持有才能释放——若期间已启动新一代预渲染（gen 已推进），
    // 旧路径的迟到释放不得消费新 loading 层（_beginPaneLoad 是引用计数，错配会提前撤罩或残留）。
    // 释放点恰好其一：renderWysiwygMasks 挂完（finally）/ 预渲染中止 / 取消 / 离开所见即所得。
    _wysiwygReleasePreRenderLoad() {
      if (!this._wysiwygPreRenderLoadOpen) return;
      if (this._wysiwygPreRenderLoadGen !== this._wysiwygPreRenderGen) return;
      this._wysiwygPreRenderLoadOpen = false;
      if (typeof this._endPaneLoad === 'function') this._endPaneLoad();
    },

    _cancelWysiwygPreRender() {
      if (!this._wysiwygPreRendering) return;
      this._wysiwygPreRendering = false;
      this._wysiwygReleasePreRenderLoad(); // 必须在 gen 推进前：本代持有的 loading 层在此收尾
      this._wysiwygPreRenderGen = (this._wysiwygPreRenderGen || 0) + 1;
      if (this._wysiwygPreRenderTimer) {
        clearTimeout(this._wysiwygPreRenderTimer);
        this._wysiwygPreRenderTimer = null;
      }
      this._wysiwygPreRenderedBlocks = null;
      this._wysiwygPreRenderedValue = null;
      // 预渲染开始时保存的切换锚点一并作废（切标签等路径下，残留锚点会被
      // 新视图的 50ms 计时器消费，导致滚动落到无关位置）
      this._pendingSwitchAnchorLine = null;
      this._setWysiwygButtonRendering(false);
    },

    // 模式按钮「渲染中」指示：spinner 类 + 文案替换（完成后还原）
    _setWysiwygButtonRendering(on) {
      let btn = null;
      try { btn = document.getElementById('btn-view-wysiwyg'); } catch (_) { return; }
      if (!btn || !btn.classList) return;
      btn.classList.toggle('wysiwyg-rendering', !!on);
      const span = btn.querySelector ? btn.querySelector('span') : null;
      if (!span) return;
      if (on) {
        if (this._wysiwygBtnText == null) this._wysiwygBtnText = span.textContent;
        span.textContent = this.t ? this.t('viewModeWysiwygRendering') : '渲染中…';
      } else if (this._wysiwygBtnText != null) {
        span.textContent = this._wysiwygBtnText;
        this._wysiwygBtnText = null;
      }
    },

    // ---------------- 块间空行塌缩 ----------------

    _isWysiwygBlankLine(n) {
      const cm = this.cm;
      if (!cm || n < 0 || n >= cm.lineCount()) return false;
      return cm.getLine(n).trim() === '';
    },

    _setWysiwygBlankClass(n, on) {
      const cm = this.cm;
      if (!cm || n == null || n < 0 || n >= cm.lineCount()) return;
      try {
        const h = cm.getLineHandle(n);
        if (on) cm.addLineClass(h, 'wrap', BLANK_CLASS);
        else cm.removeLineClass(h, 'wrap', BLANK_CLASS);
      } catch (_) { /* 行已销毁 */ }
    },

    // 全量重算空行塌缩集合（diff 增量挂类，避免整篇 addLineClass 重刷）。
    // 调用时机：进入模式的全量重建 + 输入后的防抖补齐。光标所在空行不塌缩。
    updateWysiwygBlankLines() {
      const cm = this.cm;
      if (this.viewMode !== 'wysiwyg' || !cm) return;
      const curLine = cm.getCursor().line;
      const next = new Set();
      const total = cm.lineCount();
      for (let i = 0; i < total; i++) {
        if (i !== curLine && cm.getLine(i).trim() === '') next.add(i);
      }
      const prev = this._wysiwygBlankLines;
      // 单 operation 批量挂/摘类：全量模式下空行可达数千，逐行独立操作 =
      // 数千次全视口 display 更新（万行文档进入/离开时卡数秒，2026-10-09 实测风险）
      cm.operation(() => {
        if (prev) {
          for (const i of prev) if (!next.has(i)) this._setWysiwygBlankClass(i, false);
          for (const i of next) if (!prev.has(i)) this._setWysiwygBlankClass(i, true);
        } else {
          for (const i of next) this._setWysiwygBlankClass(i, true);
        }
      });
      this._wysiwygBlankLines = next;
      this._wysiwygBlankCurLine = this._isWysiwygBlankLine(curLine) ? curLine : null;
    },

    clearWysiwygMasks() {
      // 有格正在源码编辑：先提交回写（切模式/切标签不得丢内容）；
      // 提交内部会重挂一次遮罩，本方法随后的整体清理把它一并撤掉
      if (this._wysiwygCellEditing) this._wysiwygEndCellEdit(true);
      // 在飞的全量预渲染作废（离开所见即所得 / 切标签 / 打开文件）
      this._cancelWysiwygPreRender();
      if (this._wysiwygMaskTimer) {
        clearTimeout(this._wysiwygMaskTimer);
        this._wysiwygMaskTimer = null;
      }
      const cm = this.cm;
      // 单 operation 批量撤遮罩 + 撤空行类：全量模式下遮罩可达数千、空行数千，
      // 逐块独立操作 = 数千次 display 更新（万行文档离开模式卡数秒，2026-10-09）
      try {
        cm.operation(() => {
          // 活动块源文态装饰（text marker：标题/列表/代码围栏）同批清（2026-10-14；
          // 离开模式/换文档后作废）
          if (this._wysiwygActiveDecor) {
            for (const m of this._wysiwygActiveDecor) {
              try { m.clear(); } catch (_) { /* 已销毁，忽略 */ }
            }
            this._wysiwygActiveDecor = null;
          }
          if (this._wysiwygMarks) {
            for (const mark of Array.from(this._wysiwygMarks.values())) {
              try { mark.clear(); } catch (_) { /* 已销毁，忽略 */ }
            }
          }
          if (this._wysiwygBlankLines) {
            for (const i of this._wysiwygBlankLines) this._setWysiwygBlankClass(i, false);
          }
          if (this._wysiwygBlankCurLine != null) this._setWysiwygBlankClass(this._wysiwygBlankCurLine, false);
          // 活动块高亮同批撤掉（离开模式/换文档后旧行号一律作废；首/末行角类一并撤）
          if (this._wysiwygActiveLines) {
            for (const n of this._wysiwygActiveLines) {
              try {
                const h = cm.getLineHandle(n);
                if (h) {
                  cm.removeLineClass(h, 'background', ACTIVE_CLASS);
                  cm.removeLineClass(h, 'background', ACTIVE_FIRST_CLASS);
                  cm.removeLineClass(h, 'background', ACTIVE_LAST_CLASS);
                }
              } catch (_) { /* 行已不存在 */ }
            }
          }
          // 正文排版行类同批撤（2026-10-14：编辑态=渲染态的字号/字族/行高/颜色）
          if (this._wysiwygPlainLines) {
            for (const n of this._wysiwygPlainLines) {
              try {
                const h = cm.getLineHandle(n);
                if (h) cm.removeLineClass(h, 'text', 'wysiwyg-plain-text');
              } catch (_) { /* 行已不存在 */ }
            }
          }
        });
      } catch (_) {
        if (this._wysiwygMarks) {
          for (const mark of Array.from(this._wysiwygMarks.values())) {
            try { mark.clear(); } catch (_) { /* 已销毁，忽略 */ }
          }
        }
      }
      this._wysiwygBlankLines = null;
      this._wysiwygBlankCurLine = null;
      this._wysiwygActiveLines = null;
      this._wysiwygPlainLines = null;
      this._wysiwygClickAnchor = null;
      this._wysiwygVirtual = false;
      // 离开全量视图驻留：恢复 CM 默认视口余量（整篇驻留只服务于所见即所得；
      // setOption 会触发一次小视口 refresh，成本可忽略）
      this._wysiwygFull = false;
      try {
        if (this.cm && this.cm.options && this.cm.options.viewportMargin > 10) this.cm.setOption('viewportMargin', 10);
      } catch (_) { /* 忽略 */ }
      // 预渲染块表在此清空：renderWysiwygMasks 顶部先取走快照再调本方法，
      // 其余清理路径（切模式/切标签）顺带作废未消费的预渲染结果
      this._wysiwygPreRenderedBlocks = null;
      this._wysiwygPreRenderedValue = null;
      this._wysiwygMarks = new Map();
      this._wysiwygBlocks = [];
      this._wysiwygActiveIdx = -1;
      this._wysiwygAnchorY = null;
      // 全量重建：所有旧遮罩节点一并作废——节点代数表/待跑冲刷集整体清空，
      // 在飞异步 pass 的代际检查随即判过期停写；挂起的冲刷计时器也一并取消
      this._wysiwygNodeGen = new Map();
      this._wysiwygPendingAsync = new Set();
      if (this._wysiwygAsyncFlushTimer != null) {
        clearTimeout(this._wysiwygAsyncFlushTimer);
        this._wysiwygAsyncFlushTimer = null;
      }
      // 编辑器外壳（行号/最大宽度）随模式同步：离开所见即所得时恢复行号、撤掉居中内缩
      this.applyWysiwygEditorChrome();
    },
  };
  const api = {
    mixin, MASK_CLASS, splitBlocks, splitTableRow, editTableRowCell,
    parseTableStructure, buildTableLine, addTableRow, addTableColumn, moveTableRow, moveTableColumn,
  };
  // 互斥式导出：浏览器 <script> 挂 window，node require 走 module.exports。
  // splitBlocks / splitTableRow / editTableRowCell 是纯函数，测试直接 require 本文件
  // 验证切分/回写行为（无需 DOM/CM）。
  if (typeof window !== 'undefined' && typeof module === 'undefined') {
    window.TMWysiwyg = api;
  } else if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})();
