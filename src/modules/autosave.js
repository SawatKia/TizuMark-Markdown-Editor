// 自动保存与恢复：把未保存的标签内容周期性快照到应用数据目录（app_data_dir/autosave），
// 意外关闭/丢弃后可从「恢复自动保存」对话框选择某个版本另存到新位置。
// 经 mixin 挂到 MarkdownEditor.prototype，方法内 this 指向编辑器实例。
// 只复用既有 IPC 命令（app_data_dir / ensure_dir / write_file / read_file / list_dir / remove_path），
// 不新增 Rust 命令。
(function () {
  'use strict';
  const { dialogSave } = TMConst;

  const SAVE_INTERVAL_MS = 5000;           // 编辑后多久落一次快照（节流，非防抖：持续输入也会定期落盘）
  const NEW_VERSION_GAP_MS = 5 * 60 * 1000; // 距本版本文件创建超过该时长，再落盘时新开一个版本
  const MAX_VERSIONS_PER_DOC = 20;          // 单文档保留的版本上限，超出删最旧
  const CLEANUP_INTERVAL_MS = 6 * 3600 * 1000;
  const DAY_MS = 24 * 3600 * 1000;
  const SEP = '__';

  function newDocId() {
    return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  // 版本文件名：<docId>__<创建时间戳>.json（docId 仅含字母数字，故以 __ 拆分无歧义）
  function snapshotFileName(docId, ts) {
    return docId + SEP + ts + '.json';
  }

  function parseSnapshotName(name) {
    const m = /^([A-Za-z0-9]+)__(\d+)\.json$/.exec(name || '');
    return m ? { docId: m[1], ts: Number(m[2]) } : null;
  }

  function isExpired(mtime, now, retentionDays) {
    const days = Number(retentionDays);
    if (!Number.isFinite(days) || days <= 0) return false;
    return now - mtime > days * DAY_MS;
  }

  function normalizeRetentionDays(v, fallback = 30) {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n < 1) return fallback;
    return Math.min(n, 3650);
  }

  // 恢复另存时的默认文件名：原文件名加 -recovered 后缀，避免默认覆盖原文件
  function recoveredDefaultPath(info) {
    const base = (info.filePath || info.name || 'untitled.md');
    const m = /^(.*?)(\.[^./\\]+)?$/.exec(base);
    const stem = m[1] || base;
    const ext = m[2] || '.md';
    return stem + '-recovered' + ext;
  }

  const mixin = {
      initAutosave() {
        this._autosaveTimer = null;
        this._autosaveBusy = false;
        const btn = document.getElementById('btn-autosave-recover');
        if (btn) btn.addEventListener('click', () => this.showAutosaveDialog());
        const menu = document.getElementById('btn-autosave-recover-menu');
        if (menu) menu.addEventListener('click', () => {
          const m = document.getElementById('file-menu');
          if (m) m.classList.add('hidden');
          this.showAutosaveDialog();
        });
        const closeX = document.getElementById('autosave-close-x');
        if (closeX) closeX.addEventListener('click', () => this.hideAutosaveDialog());
        const pvBack = document.getElementById('autosave-preview-back');
        if (pvBack) pvBack.addEventListener('click', () => this.closeAutosavePreview());
        const pvRecover = document.getElementById('autosave-preview-recover');
        if (pvRecover) pvRecover.addEventListener('click', () => {
          if (this._autosavePreviewing) this.recoverAutosave(this._autosavePreviewing.info, this._autosavePreviewing.entry);
        });
        const done = document.getElementById('autosave-done');
        if (done) done.addEventListener('click', () => this.hideAutosaveDialog());
        // 启动清理一次，之后长时间运行（托盘常驻）定期清理
        this.cleanupAutosave().catch(() => {});
        setInterval(() => { this.cleanupAutosave().catch(() => {}); }, CLEANUP_INTERVAL_MS);
      },
      async _autosaveDir() {
        if (this._autosaveDirPath) return this._autosaveDirPath;
        const base = await TauriApi.appDataDir();
        if (!base) throw new Error('app_data_dir unavailable');
        const sep = base.includes('\\') ? '\\' : '/';
        const dir = base.replace(/[\\/]+$/, '') + sep + 'autosave';
        await TauriApi.ensureDir({ path: dir });
        this._autosaveDirPath = dir;
        this._autosaveSep = sep;
        return dir;
      },
      // 编辑后调用：节流安排一次快照（已有待执行定时器则忽略）
      scheduleAutosave() {
        if (this._autosaveTimer) return;
        this._autosaveTimer = setTimeout(() => {
          this._autosaveTimer = null;
          this.flushAutosave().catch(() => {});
        }, SAVE_INTERVAL_MS);
      },
      // 立即为所有「有未保存修改」的标签落快照；关闭标签/退出前调用，确保丢弃前留有最新版本
      async flushAutosave(tabs) {
        if (this._autosaveFlushing) { this._autosavePending = true; return; }
        this._autosaveFlushing = true;
        try {
          const list = tabs || this.tabs;
          for (const tab of list) {
            if (!tab || tab.kind === 'image' || !tab.isModified) continue;
            if (tab._autosavedContent === tab.content) continue;
            try { await this._writeAutosave(tab); } catch (e) { console.warn('[TizuMark] autosave failed:', e); }
          }
        } finally {
          this._autosaveFlushing = false;
          if (this._autosavePending) { this._autosavePending = false; this.scheduleAutosave(); }
        }
      },
      async _writeAutosave(tab) {
        const dir = await this._autosaveDir();
        const now = Date.now();
        if (!tab._autosaveId) tab._autosaveId = newDocId();
        const isNewVersion = !tab._autosaveFile || now - tab._autosaveFileTs > NEW_VERSION_GAP_MS;
        if (isNewVersion) {
          tab._autosaveFile = snapshotFileName(tab._autosaveId, now);
          tab._autosaveFileTs = now;
        }
        const content = tab.content;
        const payload = JSON.stringify({
          v: 1,
          docId: tab._autosaveId,
          name: tab.name,
          filePath: tab.filePath || null,
          savedAt: now,
          content,
        });
        await TauriApi.writeFile({ path: dir + this._autosaveSep + tab._autosaveFile, content: payload });
        tab._autosavedContent = content;
        if (isNewVersion) await this._pruneVersions(tab._autosaveId);
      },
      async _listAutosaveEntries() {
        const dir = await this._autosaveDir();
        const res = await TauriApi.listDir({ path: dir });
        const entries = res && res.entries ? res.entries : (Array.isArray(res) ? res : []);
        return entries.filter(e => !e.is_dir && parseSnapshotName(e.name));
      },
      async _pruneVersions(docId) {
        const entries = (await this._listAutosaveEntries())
          .filter(e => parseSnapshotName(e.name).docId === docId)
          .sort((a, b) => parseSnapshotName(b.name).ts - parseSnapshotName(a.name).ts);
        for (const e of entries.slice(MAX_VERSIONS_PER_DOC)) {
          try { await TauriApi.removePath({ path: e.path }); } catch (_) {}
        }
      },
      // 按「保留天数」设置删除过期版本（以文件最后修改时间为准）
      async cleanupAutosave() {
        const days = normalizeRetentionDays(this.settings && this.settings.autoSaveRetentionDays);
        const now = Date.now();
        const entries = await this._listAutosaveEntries();
        for (const e of entries) {
          if (e.mtime && isExpired(e.mtime, now, days)) {
            try { await TauriApi.removePath({ path: e.path }); } catch (_) {}
          }
        }
      },
      async showAutosaveDialog() {
        const dlg = document.getElementById('autosave-dialog');
        if (!dlg) return;
        const kp = dlg.querySelector('.dialog');
        if (kp && typeof window.resetDialog === 'function') window.resetDialog(kp);
        dlg.classList.remove('hidden');
        // 把当前未落盘的最新修改也纳入列表
        try { await this.flushAutosave(); } catch (_) {}
        await this.renderAutosaveList();
      },
      hideAutosaveDialog() {
        const dlg = document.getElementById('autosave-dialog');
        if (dlg) dlg.classList.add('hidden');
        this.closeAutosavePreview();
      },
      // 预览某个版本的内容（只读纯文本），确认无误后再恢复
      showAutosavePreview(entry, info) {
        const pane = document.getElementById('autosave-preview-pane');
        const list = document.getElementById('autosave-list');
        if (!pane || !list) return;
        this._autosavePreviewing = { entry, info };
        document.getElementById('autosave-preview-text').textContent = info.content;
        const lines = info.content ? info.content.split(/\r\n|\r|\n/).length : 0;
        const when = new Date(entry.mtime || info.savedAt || Date.now()).toLocaleString();
        document.getElementById('autosave-preview-meta').textContent =
          `${info.name || this.t('untitled')} · ${when} · ` + this.t('autosavePreviewStats', { lines, chars: info.content.length });
        list.classList.add('hidden');
        pane.classList.remove('hidden');
      },
      closeAutosavePreview() {
        this._autosavePreviewing = null;
        const pane = document.getElementById('autosave-preview-pane');
        const list = document.getElementById('autosave-list');
        if (pane) pane.classList.add('hidden');
        if (list) list.classList.remove('hidden');
      },
      async renderAutosaveList() {
        const listEl = document.getElementById('autosave-list');
        if (!listEl) return;
        listEl.textContent = '';
        let entries = [];
        try {
          entries = await this._listAutosaveEntries();
        } catch (e) {
          console.warn('[TizuMark] list autosave failed:', e);
        }
        entries.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
        if (entries.length === 0) {
          const empty = document.createElement('div');
          empty.className = 'autosave-empty';
          empty.textContent = this.t('autosaveEmpty');
          listEl.appendChild(empty);
          return;
        }
        for (const e of entries) {
          // 元数据在 JSON 里，逐个读取；读取失败的损坏文件直接跳过
          let info = null;
          try { info = JSON.parse(await TauriApi.readFile({ path: e.path })); } catch (_) { continue; }
          if (!info || typeof info.content !== 'string') continue;
          listEl.appendChild(this._buildAutosaveRow(e, info));
        }
        if (!listEl.firstChild) {
          const empty = document.createElement('div');
          empty.className = 'autosave-empty';
          empty.textContent = this.t('autosaveEmpty');
          listEl.appendChild(empty);
        }
      },
      _buildAutosaveRow(entry, info) {
        const row = document.createElement('div');
        row.className = 'autosave-row';
        const meta = document.createElement('div');
        meta.className = 'autosave-meta';
        const title = document.createElement('div');
        title.className = 'autosave-title';
        title.textContent = info.name || this.t('untitled');
        const sub = document.createElement('div');
        sub.className = 'autosave-sub';
        const when = new Date(entry.mtime || info.savedAt || Date.now()).toLocaleString();
        const kb = Math.max(1, Math.round(info.content.length / 1024));
        sub.textContent = `${when} · ${kb} KB` + (info.filePath ? ` · ${info.filePath}` : '');
        const preview = document.createElement('div');
        preview.className = 'autosave-preview';
        preview.textContent = info.content.slice(0, 120).replace(/\s+/g, ' ');
        meta.append(title, sub, preview);

        meta.addEventListener('click', () => this.showAutosavePreview(entry, info));
        const actions = document.createElement('div');
        actions.className = 'autosave-actions';
        const view = document.createElement('button');
        view.className = 'dialog-btn';
        view.textContent = this.t('autosavePreview');
        view.addEventListener('click', () => this.showAutosavePreview(entry, info));
        const recover = document.createElement('button');
        recover.className = 'dialog-btn dialog-btn-primary';
        recover.textContent = this.t('autosaveRecover');
        recover.addEventListener('click', () => this.recoverAutosave(info, entry));
        const del = document.createElement('button');
        del.className = 'dialog-btn';
        del.textContent = this.t('autosaveDelete');
        del.addEventListener('click', async () => {
          try { await TauriApi.removePath({ path: entry.path }); } catch (_) {}
          row.remove();
          const listEl = document.getElementById('autosave-list');
          if (listEl && !listEl.firstChild) this.renderAutosaveList();
        });
        actions.append(view, recover, del);
        row.append(meta, actions);
        return row;
      },
      // 选择新位置保存恢复的内容，并在新标签中打开
      async recoverAutosave(info, entry) {
        try {
          const path = await dialogSave({
            defaultPath: recoveredDefaultPath(info),
            filters: [
              { name: 'Markdown', extensions: ['md'] },
              { name: this.t('allFiles'), extensions: ['*'] },
            ],
          });
          if (!path) return;
          await TauriApi.writeFile({ path, content: info.content });
          this.hideAutosaveDialog();
          await this.openFilePath(path);
          this.showToast(this.t('autosaveRecovered'), 'success');
        } catch (error) {
          this.setStatus(`${this.t('saveFailed')}: ${error}`);
        }
      },
  };

  const api = {
    mixin,
    helpers: { snapshotFileName, parseSnapshotName, isExpired, normalizeRetentionDays, recoveredDefaultPath },
  };
  window.TMAutosave = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
