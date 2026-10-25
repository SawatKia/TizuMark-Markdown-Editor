// 文件搜索模块 (VSCode 风格 Ctrl+P，合并自 PR #36)
// 扫描工作区目录，提供模糊文件名搜索和键盘导航。
// IPC 统一走 TauriApi（ADR-1）：listDir 由 src/modules/tauri-api.js 收敛，禁止裸 invoke。

let __fs_dialog, __fs_inputEl, __fs_listEl;
let __fs_allFiles = [];
let __fs_filteredFiles = [];
let __fs_selectedIndex = -1;
let __fs_workspaceFolder = null;
// 扫描代次令牌：避免旧扫描（被用户新操作打断/取消）回写陈旧结果覆盖新列表。
let __fs_scanToken = 0;
// Ctrl+P 检索范围：按文件名搜全部「笔记类」文件。不跳过任何子目录（含 node_modules/.git/dist
// 等），递归交给 Rust 端一次性原生遍历（search_files 命令），避免逐目录 IPC 串行卡死。
// 扩展名限制保留（仅 .md/.markdown/.txt），maxResults 兜底防止病态目录树失控。
const FS_EXTENSIONS = ['md', 'markdown', 'txt'];
const FS_MAX_RESULTS = 50000;

const FILE_ICON = '<svg class="fs-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" /><path d="M14 2v5a1 1 0 0 0 1 1h5" /></svg>';

function initFileSearch() {
  __fs_dialog = document.getElementById('file-search-dialog');
  __fs_inputEl = document.getElementById('file-search-input');
  __fs_listEl = document.getElementById('file-search-list');
  if (!__fs_dialog || !__fs_inputEl || !__fs_listEl) return;

  const closeBtn = document.getElementById('file-search-close');
  if (closeBtn) closeBtn.addEventListener('click', fsCloseDialog);

  // 关闭交互：X 按钮、输入框 ESC、点击面板以外的任意区域均可关闭弹框（VSCode 命令面板风格）。
  // 遮罩层 pointer-events:none，点击空白处会穿透到下方（编辑器），因此用 document 级 mousedown 监听：
  // 若按下位置不在面板内（__fs_dialog 不含 target）则关闭；面板内（输入/列表/标题栏拖动/X）不关闭。
  document.addEventListener('mousedown', (e) => {
    if (!isFsOpen()) return;
    if (__fs_dialog.contains(e.target)) return; // 面板内交互不触发关闭
    fsCloseDialog();
  });

  // 阻止所有键盘事件冒泡到编辑器
  __fs_dialog.addEventListener('keydown', (e) => { e.stopPropagation(); });

  __fs_inputEl.addEventListener('input', () => {
    fsApplyFilter();
  });

  __fs_inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); fsCloseDialog(); return; }
    const len = __fs_filteredFiles.length;
    if (!len) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      __fs_selectedIndex = __fs_selectedIndex < 0 ? 1 : (__fs_selectedIndex + 1) % len;
      fsRenderList(); fsScrollToSelected(); return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      __fs_selectedIndex = __fs_selectedIndex < 0 ? len - 1 : (__fs_selectedIndex - 1 + len) % len;
      fsRenderList(); fsScrollToSelected(); return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const idx = __fs_selectedIndex >= 0 ? __fs_selectedIndex : 0;
      if (__fs_filteredFiles[idx]) fsOpenFile(__fs_filteredFiles[idx]);
      return;
    }
  });

  // 标题栏拖动 + 缩放统一交由 dialog-drag-resize.js（在 initDialogsDragResize 中遍历所有 .dialog-overlay 接入），
  // 不再自写拖动逻辑，保证一套逻辑复用所有弹框。

  // 实时性：对话框已打开时，若应用窗口重新获得焦点（例如在别处/文件树新建了文件后切回），
  // 重新扫描工作区，让新建文件即时出现在列表里。
  const onFsRefocus = () => { fsRescan(); };
  window.addEventListener('focus', onFsRefocus);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) onFsRefocus(); });
}

// 标题栏拖动 + 缩放统一交由 dialog-drag-resize.js（在 initDialogsDragResize 中遍历所有 .dialog-overlay 接入），
// 不再自写拖动逻辑，保证一套逻辑复用所有弹框。

function isFsOpen() {
  return !!__fs_dialog && !__fs_dialog.classList.contains('hidden');
}

let __fs_rescanTimer = null;
// 窗口重新聚焦时去抖重扫，让新建/改名后的文件出现在列表中（不监听全时段，仅在对话框打开时生效）。
function fsRescan() {
  if (!isFsOpen() || !__fs_workspaceFolder) return;
  if (__fs_rescanTimer) clearTimeout(__fs_rescanTimer);
  __fs_rescanTimer = setTimeout(() => {
    if (isFsOpen()) fsScanWorkspace(__fs_workspaceFolder);
  }, 300);
}

function fsScrollToSelected() {
  const items = __fs_listEl.querySelectorAll('.file-search-item');
  if (items[__fs_selectedIndex]) items[__fs_selectedIndex].scrollIntoView({ block: 'nearest' });
}

// 依据当前输入框内容过滤并渲染。扫描完成或用户实时输入都走这里，
// 保证「扫描期间输入的文字」在扫描结束后不会被丢弃（旧实现会覆盖成未过滤的前 50 项）。
function fsApplyFilter() {
  const q = (__fs_inputEl ? __fs_inputEl.value : '').trim().toLowerCase();
  if (!q) {
    __fs_filteredFiles = __fs_allFiles.slice(0, 50);
  } else {
    __fs_filteredFiles = __fs_allFiles.filter(f =>
      f.name.toLowerCase().includes(q) ||
      (f.relativePath || '').toLowerCase().includes(q)
    );
  }
  __fs_selectedIndex = -1;
  fsRenderList();
}

// 模块级函数无 this：经 window.editor.t 取当前语言文案，编辑器未就绪时回退中文
function __fsT(key, fallback) {
  try { return (window.editor && window.editor.t) ? window.editor.t(key) : fallback; } catch (_) { return fallback; }
}

function fsRenderList() {
  if (!__fs_listEl) return;
  if (!__fs_filteredFiles.length) {
    const msg = (__fs_inputEl && __fs_inputEl.value.trim())
      ? __fsT('fileSearchNoMatch', '未找到匹配的文件')
      : __fsT('fileSearchNoDocs', '当前工作区没有 .md / .markdown / .txt 文件');
    __fs_listEl.innerHTML = `<div class="file-search-empty">${msg}</div>`;
    return;
  }
  __fs_listEl.innerHTML = __fs_filteredFiles.map((f, i) => {
    const cls = i === __fs_selectedIndex ? 'file-search-item selected' : 'file-search-item';
    return `<div class="${cls}" data-index="${i}">
      ${FILE_ICON}
      <span>${f.name}</span>
      <span class="fs-path">${f.relativePath || ''}</span>
    </div>`;
  }).join('');

  __fs_listEl.querySelectorAll('.file-search-item').forEach(el => {
    el.addEventListener('click', () => {
      const idx = parseInt(el.dataset.index, 10);
      if (__fs_filteredFiles[idx]) fsOpenFile(__fs_filteredFiles[idx]);
    });
    el.addEventListener('mouseenter', () => {
      const idx = parseInt(el.dataset.index, 10);
      if (idx !== __fs_selectedIndex) { __fs_selectedIndex = idx; fsRenderList(); }
    });
  });
}

function fsOpenFile(file) {
  if (window.editor && window.editor.openFilePath) {
    window.editor.openFilePath(file.path);
  }
  fsCloseDialog();
}

function fsCloseDialog() {
  if (__fs_dialog) __fs_dialog.classList.add('hidden');
  if (__fs_inputEl) __fs_inputEl.value = '';
  if (__fs_listEl) __fs_listEl.innerHTML = '';
  __fs_selectedIndex = -1;
  if (window.editor && window.editor.cm) window.editor.cm.focus();
}

// 旧实现：前端逐目录递归 + 每目录一次 listDir IPC，node_modules 等巨型目录会卡死。
// 现改为一次 search_files 命令（Rust 端原生遍历，不跳过任何子目录，按扩展名 + 上限过滤）。
async function fsScanWorkspace(dir) {
  const token = ++__fs_scanToken;     // 新扫描代次：打断任何进行中的旧扫描
  __fs_allFiles = [];
  __fs_filteredFiles = [];
  if (__fs_listEl) __fs_listEl.innerHTML = '<div class="file-search-empty">' + __fsT('fileSearchScanning', '正在扫描文件…') + '</div>';

  // 命令缺失（极旧构建）时回退到前端递归扫描，保证不整体失效。
  if (typeof TauriApi === 'undefined' || typeof TauriApi.searchFiles !== 'function') {
    const mdFiles = [];
    await fsScanDirLegacy(dir, mdFiles, dir, 0, token);
    if (token !== __fs_scanToken) return;
    mdFiles.sort((a, b) => a.name.localeCompare(b.name));
    __fs_allFiles = mdFiles;
    fsApplyFilter();
    return;
  }

  try {
    const entries = await TauriApi.searchFiles({
      path: dir,
      maxResults: FS_MAX_RESULTS,
    });
    if (token !== __fs_scanToken) return; // 已被更新的扫描取代，丢弃本次结果
    __fs_allFiles = (entries || [])
      .map(e => ({ name: e.name, path: e.path, relativePath: e.relativePath || e.path }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (e) {
    if (token !== __fs_scanToken) return;
    __fs_allFiles = [];
  }
  // 关键：依据用户当前已输入的文字过滤，而不是覆盖成未过滤的前 50 项
  fsApplyFilter();
}

// 仅作命令缺失时的降级扫描：前端逐目录递归，不跳过任何子目录（与 Rust 端语义一致），
// 但加深度/结果数上限防止病态树跑不死。因只在极旧构建触发，性能非首要。
async function fsScanDirLegacy(dirPath, result, rootDir, depth, token) {
  if (depth > 25 || result.length >= FS_MAX_RESULTS) return;
  try {
    const listing = await TauriApi.listDir({ path: dirPath });
    if (token !== __fs_scanToken) return;
    const entries = Array.isArray(listing)
      ? listing
      : (listing && Array.isArray(listing.entries) ? listing.entries : []);
    for (const entry of entries) {
      if (entry.is_dir) continue;
      const relativePath = entry.path.startsWith(rootDir)
        ? entry.path.slice(rootDir.length).replace(/^[/\\]/, '')
        : entry.name;
      result.push({ name: entry.name, path: entry.path, relativePath });
    }
    for (const entry of entries) {
      if (entry.is_dir) {
        await fsScanDirLegacy(entry.path, result, rootDir, depth + 1, token);
        if (token !== __fs_scanToken) return;
      }
    }
  } catch (e) {}
}

function openFileSearchDialog() {
  if (!__fs_dialog) initFileSearch();
  if (!__fs_dialog) return;
  __fs_dialog.classList.remove('hidden');
  // 浮动面板定位：首次显示在顶部居中（VS Code 命令面板风格）；已拖动过则保持上次位置并夹取在视口内。
  const panel = document.getElementById('fs-panel');
  if (panel) {
    const w = panel.offsetWidth || 520;
    const vw = window.innerWidth || 1200;
    const vh = window.innerHeight || 800;
    let left = panel.style.left ? parseInt(panel.style.left, 10) : Math.max(12, Math.round((vw - w) / 2));
    let top = panel.style.top ? parseInt(panel.style.top, 10) : Math.max(12, Math.round(vh * 0.12));
    left = Math.max(0, Math.min(left, vw - 80));
    top = Math.max(0, Math.min(top, vh - 40));
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
  }
  if (__fs_inputEl) { __fs_inputEl.value = ''; __fs_inputEl.focus(); }

  const ws = window.editor && window.editor.workspaceFolder;
  if (ws && ws !== __fs_workspaceFolder) {
    __fs_workspaceFolder = ws;
    fsScanWorkspace(ws);
  } else if (ws) {
    fsScanWorkspace(ws);
  } else {
    const tab = window.editor && window.editor.activeTab;
    if (tab && tab.filePath) {
      const dir = tab.filePath.replace(/[/\\][^/\\]*$/, '');
      __fs_workspaceFolder = dir;
      fsScanWorkspace(dir);
    } else {
      __fs_allFiles = [];
      __fs_filteredFiles = [];
      fsRenderList();
    }
  }
}
