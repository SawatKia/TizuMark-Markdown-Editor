// Markdown 行内格式化与表格编辑
// 从 src/app.js 拆分而来：方法体原样搬运，经 mixin 挂到 MarkdownEditor.prototype，
// 因此方法内的 this 仍指向编辑器实例，模块之间可继续用 this.xxx() 互调。
(function () {
  'use strict';

  // —— IME 上屏污染列表前缀的识别（见 _repairImeDamagedListPrefix）——
  // 纯列表标记行：可带缩进与尾空格，标记后没有正文（空列表项）。
  const IME_BARE_LIST_RE = /^(\s*)(?:\d{1,9}[.)]|[-*+])(\s*)$/;
  // 被污染形态：标记与正文之间丢掉了必需的源空格（如 "1.中国 "）。markdown 列表要求标记后
  // 必须有空白，故这种行不再是合法列表项；正文以 \S 开头保证只匹配「真的少了空格」的行。
  // 尾随的 \s* 捕获的就是被挤到行尾的那个源空格——复原时丢掉它、把分隔空格补回标记之后。
  const IME_DAMAGED_LIST_RE = /^(\s*)((?:\d{1,9}[.)]|[-*+]))(\S.*?)(\s*)$/;

  const mixin = {
      wrapSelection(before, after) {
        const sel = this.cm.getSelection();
        if (sel) {
          this.cm.replaceSelection(before + sel + after);
        } else {
          const cursor = this.cm.getCursor();
          this.cm.replaceRange(before + after, cursor);
          this.cm.setCursor({ line: cursor.line, ch: cursor.ch + before.length });
        }
        this.cm.focus();
      },
      insertAtCursor(text, cursorOffset) {
        const cursor = this.cm.getCursor();
        const prevLine = cursor.line > 0 ? this.cm.getLine(cursor.line - 1) : '';
        const needNewline = cursor.line > 0 && prevLine.trim() !== '';
        const prefix = needNewline ? '\n' : '';
        const addedLines = needNewline ? 1 : 0;
        this.cm.replaceRange(prefix + text, cursor);
        if (cursorOffset !== undefined) {
          this.cm.setCursor({ line: cursor.line + addedLines, ch: cursor.ch + cursorOffset });
        } else {
          this.cm.setCursor({ line: cursor.line + addedLines, ch: cursor.ch + text.length });
        }
        this.cm.focus();
      },
      insertImageBlock(text) {
        const cursor = this.cm.getCursor();
        const line = this.cm.getLine(cursor.line);
        const afterText = line.slice(cursor.ch);
        const prevLine = cursor.line > 0 ? this.cm.getLine(cursor.line - 1) : '';
        let prefix = '';
        let addedLines = 0;
        if (cursor.ch > 0 || (cursor.line > 0 && prevLine.trim() !== '')) {
          prefix = '\n';
          addedLines = 1;
        }
        this.cm.replaceRange(prefix + text + '\n' + afterText, cursor, { line: cursor.line, ch: line.length });
        this.cm.setCursor({ line: cursor.line + addedLines + 1, ch: 0 });
        this.cm.focus();
      },
      handleTaskCheckboxToggle(checkbox) {
        // 通过 li 的 data-source-line 反查源码行（remark plugin 给所有节点标注，1-based）
        const li = checkbox.closest('li');
        if (!li) return;
        const lineAttr = li.getAttribute('data-source-line');
        if (!lineAttr) return;
        const lineNum = parseInt(lineAttr, 10) - 1;  // 转 0-based
        if (isNaN(lineNum) || lineNum < 0 || lineNum >= this.cm.lineCount()) return;
        const lineText = this.cm.getLine(lineNum);
        // 匹配任务列表行：可选 > 前缀（引用块嵌套）+ 前缀（- * + 或 数字.）+ [ ] / [x] + 可选内容
        const taskRe = /^(\s*(?:>\s*)*(?:[*+-]|\d+[.)])\s+)\[([ xX])\](\s.*)?$/;
        const m = lineText.match(taskRe);
        if (!m) return;
        // 按源码标记取反作为目标态（与即将发生的原生 click 默认切换结果一致）。
        // 这里【不】手动设置 checkbox.checked：不 preventDefault，原生默认行为会把
        // checkbox 切到 newChecked 并自己重绘 :checked 样式；若我们抢先设了 checked，
        // 原生默认行为会在事件末尾再翻一次，反而错。
        const sourceChecked = m[2] === 'x' || m[2] === 'X';
        const newChecked = !sourceChecked;
        const newMark = newChecked ? 'x' : ' ';
        const newLine = m[1] + '[' + newMark + ']' + (m[3] || '');
        const cursor = this.cm.getCursor();
        // 预览 checkbox 已由原生 click 默认行为即时切到 newChecked（浏览器自绘，必然有响应）；
        // 抑制整篇重渲染，避免重复重建把即时勾选态覆盖 / 引发预览或编辑器跳动。
        this._suppressNextPreviewRerender = true;
        // 同时取消任何已排队的防抖重建（如打字 / setValue 触发的待执行 300ms 定时器）：
        // 否则勾选后那个遗留定时器仍会到期并整篇重建 preview，覆盖即时勾选并引发跳动/“看似没反应”。
        clearTimeout(this.debounceTimer);
        // 取消任何在途的滚动同步调度：用户刚滚动到勾选框、点击间隔 < 100ms 时，
        // 上一次滚动留下的 throttle 尾随 _syncPreviewToEditor / debounce _resumeScroll 会在
        // 本函数设的抑制窗口外补跑，越权把编辑器滚到别处。一并清掉，避免越权同步。
        this._scrollThrottleTimer = null;
        this._scrollThrottlePending = null;
        clearTimeout(this._scrollDebounceTimer);
        this._scrollDebounceTimer = null;
        // 记录编辑器滚动位置：cm.replaceRange/cm.setCursor 在某些 WebView 下会让 CodeMirror
        // 内部滚动编辑器（即便 setCursor scroll:false）。_canScroll 双标志只挡「滚动同步」、
        // 挡不住 CM 自身滚动，表现为「点完勾选框编辑器跳到别处」。故显式捕获并在变更后还原。
        const edScrollTop = this.cm.getScrollInfo().top;
        // 临时关闭滚动同步：cm.replaceRange/cm.setCursor 可能让编辑器自动滚动，
        // 触发 _syncEditorToPreview 把预览滚到光标行（任务列表某行），导致上方 H3「任务列表」
        // 被滚出视野顶部——表现为「点完之后预览框根本没有渲染出来」。
        // _resumeScroll 会在 100ms 后自动恢复 _canScroll 标志，不影响正常滚动同步。
        const prevCanScroll = { editor: this._canScroll.editor, preview: this._canScroll.preview };
        this._canScroll.editor = false;
        this._canScroll.preview = false;
        this.cm.replaceRange(newLine, { line: lineNum, ch: 0 }, { line: lineNum, ch: lineText.length });
        this.cm.setCursor(cursor, { scroll: false });  // 保持光标位置不跳动且不让编辑器自动滚动
        if (typeof edScrollTop === 'number') {
          this.cm.scrollTo(0, edScrollTop); // 立即还原编辑器滚动，消除 CM 内部滚动导致的跳动
          // 兜住 CM 在 operation 收尾时的异步滚动（下一帧），避免长时间错位闪烁
          if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => { if (typeof edScrollTop === 'number') this.cm.scrollTo(0, edScrollTop); });
          }
        }
        setTimeout(() => {
          // 安全网：若 CM 在变更后异步（rAF/operation 收尾）调整了编辑器滚动，再还原一次；
          // 此时 _canScroll.editor 仍为 false，scrollTo 触发的滚动事件被同步处理器忽略，不会联动预览。
          if (typeof edScrollTop === 'number') this.cm.scrollTo(0, edScrollTop);
          if (this._canScroll) {
            this._canScroll.editor = prevCanScroll.editor;
            this._canScroll.preview = prevCanScroll.preview;
          }
        }, 120);
        // activeTab.content 由 change 事件同步；预览 DOM 已就地更新，无需重渲染.
      },
      insertLinePrefix(prefix, ordered = false) {
        const cm = this.cm;
        // 有选区（跨行 / 多选区）：对选区覆盖的每一行逐行加前缀，用 operation 包裹保证一次 undo 撤销整批
        if (cm.somethingSelected()) {
          cm.operation(() => {
            const selections = cm.listSelections();
            const newSelections = [];
            for (const sel of selections) {
              const startLine = Math.min(sel.anchor.line, sel.head.line);
              const endLine = Math.max(sel.anchor.line, sel.head.line);
              let n = 1;
              for (let ln = startLine; ln <= endLine; ln++) {
                const text = cm.getLine(ln);
                // 单行替换不增删行，行号在循环中保持有效
                const linePrefix = ordered ? (n++) + '. ' : prefix;
                cm.replaceRange(linePrefix + text, { line: ln, ch: 0 }, { line: ln, ch: text.length });
              }
              // 选中整批改动行（行首到末行行尾），让用户直观看到加前缀后的范围
              const lastLineText = cm.getLine(endLine);
              newSelections.push({
                anchor: { line: startLine, ch: 0 },
                head: { line: endLine, ch: lastLineText.length },
              });
            }
            cm.setSelections(newSelections);
          });
          cm.focus();
          return;
        }
        // 无选区：原单行行为（含上一行非空时自动换行再加前缀）
        const cursor = cm.getCursor();
        const line = cm.getLine(cursor.line);
        const prevLine = cursor.line > 0 ? cm.getLine(cursor.line - 1) : '';
        const needNewline = cursor.line > 0 && prevLine.trim() !== '';
        const newLine = needNewline ? '\n' : '';
        cm.replaceRange(newLine + prefix + line, { line: cursor.line, ch: 0 }, { line: cursor.line, ch: line.length });
        cm.setCursor({ line: cursor.line + (needNewline ? 1 : 0), ch: prefix.length + cursor.ch });
        cm.focus();
      },
      // 标题快捷键：智能设置 / 切换标题层级（替代原先的「行首盲目加 #」）。
      // - 行首已是标题（^#{1,6}\s*）：目标层级不同 → 原位替换旧的 # 前缀（如 ## 标题 + Ctrl+3 → ### 标题）；
      //   目标层级相同 → 取消标题（移除 # 前缀回到正文，Typora 式 toggle）。
      // - 行首无标题标记：沿用 insertLinePrefix 的插入行为（含上一行非空时自动换行）。
      // 多行选区：对选区内每一行分别执行「替换 / 取消 / 追加」，不触发换行逻辑，整体一次 undo。
      applyHeadingLevel(level) {
        const cm = this.cm;
        const prefix = '#'.repeat(level) + ' ';
        const HEADING_RE = /^(#{1,6})\s*/;
  
        if (cm.somethingSelected()) {
          cm.operation(() => {
            const selections = cm.listSelections();
            const newSelections = [];
            for (const sel of selections) {
              const startLine = Math.min(sel.anchor.line, sel.head.line);
              const endLine = Math.max(sel.anchor.line, sel.head.line);
              for (let ln = startLine; ln <= endLine; ln++) {
                const text = cm.getLine(ln);
                const m = text.match(HEADING_RE);
                if (m) {
                  const newPrefix = m[1].length === level ? '' : prefix;
                  cm.replaceRange(newPrefix, { line: ln, ch: 0 }, { line: ln, ch: m[0].length });
                } else {
                  cm.replaceRange(prefix + text, { line: ln, ch: 0 }, { line: ln, ch: text.length });
                }
              }
              const lastLineText = cm.getLine(endLine);
              newSelections.push({
                anchor: { line: startLine, ch: 0 },
                head: { line: endLine, ch: lastLineText.length },
              });
            }
            cm.setSelections(newSelections);
          });
          cm.focus();
          return;
        }
  
        // 无选区：单行
        const cursor = cm.getCursor();
        const line = cm.getLine(cursor.line);
        const m = line.match(HEADING_RE);
        if (m) {
          const newPrefix = m[1].length === level ? '' : prefix;
          const delta = newPrefix.length - m[0].length;
          cm.replaceRange(newPrefix, { line: cursor.line, ch: 0 }, { line: cursor.line, ch: m[0].length });
          const newCh = Math.max(0, Math.min(cursor.ch + delta, (newPrefix + line.slice(m[0].length)).length));
          cm.setCursor({ line: cursor.line, ch: newCh });
          cm.focus();
          return;
        }
        // 无标题标记 → 沿用原有插入行为（含上一行非空时自动换行）
        this.insertLinePrefix(prefix);
      },
      // —— IME 组合串落在列表前缀槽上、把前缀写坏的修复 ——
      // 用户反馈（2026-10-19）：「有序列表按回车没有新增一行，比如第一行是序号 1，行尾按回车，
      // 应该新增一行、序号是 2，但现在是直接跳出有序列表了」。
      // 成因（真机 CDP 复现，用 Input.insertText 模拟输入法上屏）：空列表项（"1. " / "- " /
      // "- [ ] "）是列表行里唯一「正文没有文本节点」的行——前缀槽固定 24px、源空格槽零宽
      // （styles.css 的 .wysiwyg-ol-marker / .wysiwyg-ol-space），Chromium 找不到能承载组合串的
      // 正文文本节点，就把拼音组合串塞进前缀槽**自己的文本节点**（组合期实测 DOM：
      // <span class="wysiwyg-ol-marker">1.zhongguo</span>）。上屏时 CM 读 DOM 差分，
      // 源里 marker 与正文之间那个分隔空格被挤到行尾 → 模型变成 "1.中国 "，不再是合法列表项
      // （continuelist 的 listRE 要求标记后必须有 \s）→ Enter 落到普通 newlineAndIndent 分支
      // = 退出列表，而不是续出 "2. "。只有空的有序列表项会中招：空无序项 "- "、空任务项
      // "- [ ] "、以及有正文的行（组合串落在正文 span）都正常。
      // 修法：组合开始前记下「这行是否只有列表标记」，上屏后若这行变成「标记直接贴上内容」，
      // 把丢掉的空格补回标记之后、并同步右移光标，使其重新成为合法列表项。
      _recordBareListMarkerForIme() {
        this._imeBareMarker = null;
        const cm = this.cm;
        if (!cm) return;
        const pos = cm.getCursor();
        const text = cm.getLine(pos.line);
        // 只有「纯列表标记（可带缩进/尾空格）」才需要修——有正文的行组合串落在正文 span，天然安全
        if (!IME_BARE_LIST_RE.test(text)) return;
        this._imeBareMarker = { line: pos.line };
      },
      // 组合结束后修复被 IME 写坏的列表前缀（配合 _recordBareListMarkerForIme）。
      // 只修「组合前是纯标记空项、且上屏后标记直接贴上非空格字符」的行，其余一律不动。
      _repairImeDamagedListPrefix() {
        const cm = this.cm;
        const keep = this._imeBareMarker;
        this._imeBareMarker = null;
        if (!cm || !keep) return;
        // CM 读 DOM 是防抖的（codemirror.js readFromDOMSoon 80ms 后才 updateFromDOM），
        // compositionend 当下模型里可能还是旧文本 → 轮询到模型更新为止（上限 ~800ms，够用且不失控）。
        let tries = 0;
        const apply = () => {
          tries++;
          if (keep.line < cm.lineCount()) {
            const line = cm.getLine(keep.line);
            const m = IME_DAMAGED_LIST_RE.exec(line);
            if (m) {
              const indent = m[1], marker = m[2], body = m[3];
              // 行尾的尾随空白（m[4]）就是被挤到行尾的那个源空格：复原时直接丢掉，
              // 只把标记后的分隔空格补回去，还原成 "1. 中国"（而不是 "1. 中国 "）。
              const fixed = indent + marker + ' ' + body;
              const pos = cm.getCursor();
              const pivot = indent.length + marker.length;   // 标记右缘：光标在此之后才需要右移
              cm.operation(() => {
                cm.replaceRange(fixed, { line: keep.line, ch: 0 }, { line: keep.line, ch: line.length });
                if (pos.line === keep.line && pos.ch > pivot) cm.setCursor({ line: keep.line, ch: pos.ch + 1 });
              });
              return;
            }
          }
          if (tries < 10) setTimeout(apply, 80);
        };
        setTimeout(apply, 80);
      },
      // 表格行内按 Enter 自动补充表格结构
      // 表格行内 Enter：整理整段表格（对齐/补齐分隔行/统一列数）并在当前行下方插入等列空白行。
      // 整理规则（用户反馈）：① 缺分隔行→自动补齐；② 分隔行数量不足→补全；
      // ③ 分隔行不规范（如 |--|）→规范为 | --- |；④ 各行列数不统一→缺失行补空白格；
      // ⑤ 单元格不规范（如 |内容 |）→规范为 | 内容 |。
      _handleTableEnter(cm) {
        // 先记录本笔 keydown Enter（即使下面被吞掉也记录）：输入域级幽灵换行守卫
        //（editor-core beforeinput）用这个时间戳识别「同一次按键的重复投递」——合法
        // keydown Enter 已被 extraKeys preventDefault，浏览器不会再为它投递 beforeinput，
        // 故紧随其后的 insertLineBreak 一律是幽灵。
        const now = Date.now();
        const sincePrevEnter = this._lastEnterKeydownAt ? now - this._lastEnterKeydownAt : Infinity;
        this._lastEnterKeydownAt = now;
        // WebView2/Chromium 中文 IME 时序怪癖：compositionend 可能先于「选字确认的
        // Enter」keydown 到达（此刻 isComposing=false）——该 Enter 是 IME 确认键的残影，
        // 不是用户想换行。若当真处理：列表行会多出一条续行，用户真正的 Enter 又再续一行
        // → 用户看到「光标在新起那行的下一行」（2026-10-14 用户反馈「列表按回车新起一行
        // 没问题，但光标回到新行的下一行」的根因）。与表格格编辑同一规则（wysiwyg.js
        // L1215-1224）：组合刚结束 250ms 内的 Enter 一律吞掉；用户真正的换行 Enter 在
        // 更晚按下，正常生效。extraKeys 处理器返回 undefined = 键被消费（codemirror.js
        // doHandleBinding：bound(cm) != Pass → preventDefault），不产生换行。
        if (this._lastCompositionEnd && now - this._lastCompositionEnd < 250) return;
        // 窗②（2026-10-15 用户复现）：用户选字提交后又继续输入（距 compositionend 已超
        // 250ms、窗①失效）再按 Enter——WebView2 的幽灵可能是「本笔 Enter 按键的重复
        // 投递」，紧随真实 Enter keydown 数十 ms 之后到达。若放行：真实 Enter 已续出列表
        // 行，幽灵又续/插一行 → 光标落在「新行的下一行」（截图：空 bullet 行 + 其下空行，
        // 光标在空行）。人为连按两次 Enter 间隔 ≥80ms，且此处还要求「组合 10s 内刚结束」
        // 双条件，避免误吞无 IME 上下文的快速输入。
        if (sincePrevEnter < 150 && this._lastCompositionEnd && now - this._lastCompositionEnd < 10000) return;
        const TABLE_ROW_RE = /^\|.*\|\s*$/;
        const TABLE_SEPARATOR_RE = /^\|\s*[-:][-:\s]*\|/;
        const pos = cm.getCursor();
        const line = cm.getLine(pos.line);
        // 非表格行或分隔行 → 走正常换行/列表延续
        if (!TABLE_ROW_RE.test(line) || TABLE_SEPARATOR_RE.test(line)) {
          this._newlineAndIndent(cm);
          return;
        }
        // 有选区 → 交回原有逻辑
        if (cm.somethingSelected()) {
          this._newlineAndIndent(cm);
          return;
        }
        // 计算列数
        const colCount = (line.match(/\|/g) || []).length - 1;
        if (colCount < 1) {
          this._newlineAndIndent(cm);
          return;
        }
        // 空表格行（去除 | 与空白后无内容）→ 退出表格：删除本行
        const stripped = line.replace(/\|/g, '').trim();
        if (stripped === '') {
          const nextLine = cm.getLine(pos.line + 1);
          if (nextLine !== undefined) {
            cm.replaceRange('', { line: pos.line, ch: 0 }, { line: pos.line + 1, ch: 0 });
          } else {
            // 最后一行：清空内容
            cm.replaceRange('', { line: pos.line, ch: 0 }, { line: pos.line, ch: line.length });
          }
          cm.setCursor({ line: pos.line, ch: 0 });
          return;
        }
        // 正常表格行 → 整理整段表格 + 在当前行下方插入等列空白新行
        cm.operation(() => {
          const res = this._normalizeTableBlock(cm, pos.line, TABLE_ROW_RE, TABLE_SEPARATOR_RE, pos.line);
          if (!res) { this._newlineAndIndent(cm); return; }
          cm.setCursor({ line: res.newRowLine, ch: 2 });
        });
      },
      // 在光标所在表格行下方插入等列空白行（同时整理整段表格），光标置于新行第一格。
      // 默认无键位，可在「自定义快捷键」中为 addTableRow 绑定（用户反馈：表格加行）。
      _addTableRow(cm) {
        if (!cm) return;
        const pos = cm.getCursor();
        const line = cm.getLine(pos.line);
        const TABLE_ROW_RE = /^\|.*\|\s*$/;
        const TABLE_SEPARATOR_RE = /^\|\s*[-:][-:\s]*\|/;
        if (!TABLE_ROW_RE.test(line) || TABLE_SEPARATOR_RE.test(line)) return; // 不在表格数据行 → 不操作
        const colCount = (line.match(/\|/g) || []).length - 1;
        if (colCount < 1) return;
        cm.operation(() => {
          const res = this._normalizeTableBlock(cm, pos.line, TABLE_ROW_RE, TABLE_SEPARATOR_RE, pos.line);
          if (res) cm.setCursor({ line: res.newRowLine, ch: 2 });
        });
        cm.focus();
      },
      // 在光标所在列右侧插入空白列（跨整段表格），光标置于新列首格。
      // 默认无键位，可在「自定义快捷键」中为 addTableColumn 绑定（用户反馈：表格加列）。
      _addTableColumn(cm) {
        if (!cm) return;
        const pos = cm.getCursor();
        const line = cm.getLine(pos.line);
        const TABLE_ROW_RE = /^\|.*\|\s*$/;
        const TABLE_SEPARATOR_RE = /^\|\s*[-:][-:\s]*\|/;
        if (!TABLE_ROW_RE.test(line)) return; // 不在表格行 → 不操作
        const colIdx = this._cursorColumnIndex(line, pos.ch); // 光标所在列（0 起）
        if (colIdx < 0) return;
        // 扩展表格块范围
        let start = pos.line, end = pos.line;
        while (start - 1 >= 0 && TABLE_ROW_RE.test(cm.getLine(start - 1))) start--;
        while (end + 1 <= cm.lastLine() && TABLE_ROW_RE.test(cm.getLine(end + 1))) end++;
        cm.operation(() => {
          let curStarts = null;
          for (let i = start; i <= end; i++) {
            const l = cm.getLine(i);
            const isSep = TABLE_SEPARATOR_RE.test(l);
            const cells = this._splitCells(l);
            const insertIdx = Math.min(colIdx + 1, cells.length); // 插到光标列右侧
            cells.splice(insertIdx, 0, isSep ? '---' : '');
            const { text, starts } = this._buildRow(cells);
            cm.replaceRange(text, { line: i, ch: 0 }, { line: i, ch: l.length });
            if (i === pos.line) curStarts = starts;
          }
          if (curStarts) {
            const target = Math.min(colIdx + 1, curStarts.length - 1);
            cm.setCursor({ line: pos.line, ch: curStarts[target] });
          }
        });
        cm.focus();
      },
      // 返回光标所在列的 0 起索引；越界时回落到最近列。
      _cursorColumnIndex(line, ch) {
        let pipes = 0;
        for (let i = 0; i < ch && i < line.length; i++) {
          if (line[i] === '|') pipes++;
        }
        // 首个 | 开启第 0 列，故列索引 = 其前的 | 数 - 1
        return Math.max(0, pipes - 1);
      },
      // 整理光标所在表格块：补齐/规范分隔行、统一单元格对齐与列数；可选在 blankAfterLine
      // 指定的原始数据行下方追加一条等列空白行。返回 { newRowLine }（追加行的绝对行号；未追加为 -1）。
      _normalizeTableBlock(cm, cursorLine, TABLE_ROW_RE, TABLE_SEPARATOR_RE, blankAfterLine) {
        let start = cursorLine, end = cursorLine;
        while (start - 1 >= 0 && TABLE_ROW_RE.test(cm.getLine(start - 1))) start--;
        while (end + 1 <= cm.lastLine() && TABLE_ROW_RE.test(cm.getLine(end + 1))) end++;
        const raws = [];
        for (let i = start; i <= end; i++) {
          const t = cm.getLine(i);
          raws.push({ text: t, isSep: TABLE_SEPARATOR_RE.test(t), origLine: i });
        }
        let colCount = 0;
        for (const r of raws) if (!r.isSep) colCount = Math.max(colCount, this._splitCells(r.text).length);
        if (colCount === 0) return null;
        const hasSep = raws.some((r) => r.isSep);
        const out = [];
        let newRowLine = -1;
        let pendingBlank = false; // 标记：在当前数据行之后（跨过紧随的分隔行）插入空白行
        const pushBlank = () => {
          const blankIdx = out.length;
          out.push(this._buildRow(Array(colCount).fill('')).text);
          newRowLine = start + blankIdx;
        };
        for (let i = 0; i < raws.length; i++) {
          const r = raws[i];
          if (r.isSep) {
            out.push(this._buildRow(this._normalizeSepCells(r.text, colCount)).text);
            if (pendingBlank) { pushBlank(); pendingBlank = false; }
            continue;
          }
          const cells = this._splitCells(r.text);
          while (cells.length < colCount) cells.push('');
          out.push(this._buildRow(cells).text);
          // 缺分隔行 → 在首行（表头/首数据行）下方补齐，必须在空白行逻辑之前，
          // 否则会出现「表头→空白→分隔」的非法顺序
          if (!hasSep && i === 0 && !r.isSep) {
            out.push(this._buildRow(Array(colCount).fill('---')).text);
            // 光标恰在首行 → 空白行紧随补齐的分隔行之后（即光标行正下方）
            if (blankAfterLine != null && r.origLine === blankAfterLine) pushBlank();
          } else if (blankAfterLine != null && r.origLine === blankAfterLine) {
            // 光标行：下一行是分隔行则延后到分隔行之后（保持 表头→分隔→正文 顺序）；
            // 否则（下一行是数据行或已到段尾）立即插在光标行正下方。
            const next = raws[i + 1];
            if (next && next.isSep) {
              pendingBlank = true; // 待下一轮遇到分隔行时 flush
            } else {
              pushBlank(); // 光标行正下方
            }
          }
        }
        if (pendingBlank) pushBlank();
        const newText = out.join('\n');
        cm.replaceRange(newText, { line: start, ch: 0 }, { line: end, ch: cm.getLine(end).length });
        return { newRowLine };
      },
      // 把表格行拆分为单元格数组（去首尾 | 并按 | 切分、trim）。
      _splitCells(text) {
        let t = text.trim();
        if (t.startsWith('|')) t = t.slice(1);
        if (t.endsWith('|')) t = t.slice(0, -1);
        return t.split('|').map((c) => c.trim());
      },
      // 把单元格数组组装为标准表格行，返回 { text, starts }；starts[k] 为第 k 列内容起始 ch。
      _buildRow(cells) {
        let text = '| ';
        const starts = [];
        for (let k = 0; k < cells.length; k++) {
          starts.push(text.length);
          text += cells[k];
          if (k < cells.length - 1) text += ' | ';
        }
        text += ' |';
        return { text, starts };
      },
      // 规范分隔行单元格：保留对齐标记（:-- / --: / :-:），不足列数补 ---。
      _normalizeSepCells(sepText, colCount) {
        const cells = this._splitCells(sepText);
        while (cells.length < colCount) cells.push('---');
        return cells.map((c) => {
          const t = c.trim();
          const left = t.startsWith(':');
          const right = t.endsWith(':');
          let s = '---';
          if (left) s = ':' + s;
          if (right) s = s + ':';
          return s;
        });
      },
      _newlineAndIndent(cm) {
        const cmdName = 'newlineAndIndentContinueMarkdownList';
        if (CodeMirror.commands[cmdName]) {
          cm.execCommand(cmdName);
        } else {
          cm.execCommand('newlineAndIndent');
        }
      },
      insertBlock(text, cursorOffset) {
        const cursor = this.cm.getCursor();
        const line = this.cm.getLine(cursor.line);
        const needNewline = line.trim() !== '';
        const prefix = needNewline ? '\n\n' : '';
        const addedLines = needNewline ? 2 : 0;
        // 尾随换行只在该插入点之后还有内容时才补：光标在文末行末补换行会多留一条空源码行，
        // 该空行在 WYSIWYG 下坍缩成 12px 空白并被活动块底色刷成灰条（用户报「多出来一行灰色空白行」）。
        const hasTail = cursor.ch < line.length || cursor.line < this.cm.lastLine();
        const suffix = hasTail ? '\n' : '';
        this.cm.replaceRange(prefix + text + suffix, cursor);
        if (cursorOffset !== undefined) {
          const before = text.substring(0, cursorOffset);
          const lastNewline = before.lastIndexOf('\n');
          const targetLine = cursor.line + addedLines + (before.split('\n').length - 1);
          const targetCh = lastNewline === -1 ? cursorOffset : (cursorOffset - lastNewline - 1);
          this.cm.setCursor({ line: targetLine, ch: targetCh });
        } else {
          const lines = text.split('\n');
          this.cm.setCursor({ line: cursor.line + addedLines + lines.length - 1, ch: lines[lines.length - 1].length });
        }
        this.cm.focus();
      },
      // 在光标所在行下方插入空行（不截断当前行），光标跳转到新加的空行（行首）。
      insertLineBelow() {
        const cm = this.cm;
        if (!cm) return;
        const lineNo = cm.getCursor().line;
        const lineLen = cm.getLine(lineNo).length;
        cm.operation(() => {
          // 在行尾追加换行 → 当前行光标后文本留在原行，不截断；下方生成一个新的空行。
          cm.replaceRange('\n', { line: lineNo, ch: lineLen });
          // 光标跳转到新加的空行（原行下方，列 0）。
          cm.setCursor({ line: lineNo + 1, ch: 0 });
        });
      },
      // 在光标所在行上方插入空行：原行整体下移，光标跳转到新加的空行（行首）。
      insertLineAbove() {
        const cm = this.cm;
        if (!cm) return;
        const lineNo = cm.getCursor().line;
        cm.operation(() => {
          // 在当前行行首插入换行 → 原行整体下移，上方生成一个新的空行。
          cm.replaceRange('\n', { line: lineNo, ch: 0 });
          // 新加的空行即原 lineNo（原文本已下移到 lineNo+1），光标跳转到新行行首。
          cm.setCursor({ line: lineNo, ch: 0 });
        });
      },
  };

  const api = { mixin };
  window.TMFormat = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
