// 自动保存/恢复：纯函数 + 用内存假文件系统驱动 mixin（不依赖 DOM / app.js）
const { test } = require('node:test');
const assert = require('node:assert');

const DAY = 24 * 3600 * 1000;
const files = new Map(); // path -> { content, mtime }
let saveDialogResult = null;

global.window = {};
global.TMConst = { dialogSave: async () => saveDialogResult };
global.TauriApi = {
  appDataDir: async () => 'C:\\data',
  ensureDir: async () => {},
  writeFile: async ({ path, content }) => { files.set(path, { content, mtime: Date.now() }); },
  readFile: async ({ path }) => files.get(path).content,
  listDir: async ({ path }) => ({
    entries: [...files.entries()]
      .filter(([p]) => p.startsWith(path + '\\'))
      .map(([p, f]) => ({ name: p.slice(path.length + 1), path: p, is_dir: false, mtime: f.mtime })),
    truncated: false,
  }),
  removePath: async ({ path }) => { files.delete(path); },
  renamePath: async ({ from, to }) => { files.set(to, files.get(from)); files.delete(from); },
};
const { mixin, helpers } = require('../src/modules/autosave.js');

function makeEditor(extra = {}) {
  const ed = Object.assign({ settings: { autoSaveRetentionDays: 30 }, tabs: [] }, mixin, extra);
  ed.t = (k) => k;
  return ed;
}
function makeTab(content, savedContent = '') {
  return { name: 'a.md', filePath: 'C:\\docs\\a.md', kind: 'markdown', content, savedContent, get isModified() { return this.content !== this.savedContent; } };
}

test('helpers: 文件名往返 / 过期判定 / 天数归一化 / 恢复默认文件名', () => {
  const n = helpers.snapshotFileName('tabc1', 123);
  assert.deepStrictEqual(helpers.parseSnapshotName(n), { docId: 'tabc1', ts: 123, recoveredAt: 0 });
  const rn = helpers.recoveredFileName(n, 456);
  assert.strictEqual(rn, 'tabc1__123__r456.json');
  assert.deepStrictEqual(helpers.parseSnapshotName(rn), { docId: 'tabc1', ts: 123, recoveredAt: 456 });
  assert.strictEqual(helpers.recoveredFileName(rn, 789), 'tabc1__123__r789.json', '重复恢复只更新时间戳');
  assert.strictEqual(helpers.parseSnapshotName('x.md'), null);
  assert.strictEqual(helpers.isExpired(0, 31 * DAY, 30), true);
  assert.strictEqual(helpers.isExpired(DAY, 30 * DAY, 30), false);
  assert.strictEqual(helpers.normalizeRetentionDays('abc'), 30);
  assert.strictEqual(helpers.normalizeRetentionDays(0), 30);
  assert.strictEqual(helpers.normalizeRetentionDays(7.9), 7);
  assert.strictEqual(helpers.recoveredDefaultPath({ filePath: 'C:\\d\\a.md' }), 'C:\\d\\a-recovered.md');
  assert.strictEqual(helpers.recoveredDefaultPath({ name: 'Untitled1' }), 'Untitled1-recovered.md');
});

test('flushAutosave: 只快照有未保存修改的标签；同版本窗口内覆盖同一文件', async () => {
  files.clear();
  const ed = makeEditor();
  const dirty = makeTab('hello', '');
  const clean = makeTab('same', 'same');
  ed.tabs = [dirty, clean];
  await ed.flushAutosave();
  assert.strictEqual(files.size, 1);
  const [[p, f]] = [...files.entries()];
  assert.ok(p.startsWith('C:\\data\\autosave\\'));
  const snap = JSON.parse(f.content);
  assert.strictEqual(snap.content, 'hello');
  assert.strictEqual(snap.filePath, 'C:\\docs\\a.md');

  dirty.content = 'hello world';
  await ed.flushAutosave();
  assert.strictEqual(files.size, 1, '5 分钟内应覆盖同一版本文件');
  assert.strictEqual(JSON.parse(files.get(p).content).content, 'hello world');

  await new Promise(r => setTimeout(r, 3)); // 文件名含毫秒时间戳，避免与首个版本同毫秒
  dirty._autosaveFileTs -= 6 * 60 * 1000; // 超过版本间隔 → 新版本
  dirty.content = 'hello world!';
  await ed.flushAutosave();
  assert.strictEqual(files.size, 2);
});

test('版本数超过上限时删最旧的', async () => {
  files.clear();
  const ed = makeEditor();
  const tab = makeTab('x');
  for (let i = 0; i < 23; i++) {
    tab.content = 'v' + i;
    if (tab._autosaveFileTs) tab._autosaveFileTs -= 10 * 60 * 1000;
    await ed.flushAutosave([tab]);
    await new Promise(r => setTimeout(r, 2)); // 保证时间戳文件名不同
  }
  assert.strictEqual(files.size, 20);
  const contents = [...files.values()].map(f => JSON.parse(f.content).content);
  assert.ok(contents.includes('v22') && !contents.includes('v0'));
});

test('cleanupAutosave: 按保留天数删除过期版本，天数可配置', async () => {
  files.clear();
  const ed = makeEditor();
  const dir = 'C:\\data\\autosave\\';
  files.set(dir + 'tone__1.json', { content: '{}', mtime: Date.now() - 40 * DAY });
  files.set(dir + 'ttwo__2.json', { content: '{}', mtime: Date.now() - 10 * DAY });
  files.set(dir + 'tnew__3.json', { content: '{}', mtime: Date.now() });
  await ed.cleanupAutosave();
  assert.deepStrictEqual([...files.keys()].sort(), [dir + 'tnew__3.json', dir + 'ttwo__2.json']);
  ed.settings.autoSaveRetentionDays = 5;
  await ed.cleanupAutosave();
  assert.deepStrictEqual([...files.keys()], [dir + 'tnew__3.json']);
});

test('recoverAutosave: 另存到用户选择的新位置并打开', async () => {
  files.clear();
  let opened = null; let toast = null;
  const ed = makeEditor({
    hideAutosaveDialog() {}, openFilePath: async (p) => { opened = p; },
    showToast: (m) => { toast = m; }, setStatus() {},
  });
  saveDialogResult = 'D:\\new\\b.md';
  await ed.recoverAutosave({ name: 'a.md', filePath: 'C:\\docs\\a.md', content: 'recovered text' });
  assert.strictEqual(files.get('D:\\new\\b.md').content, 'recovered text');
  assert.strictEqual(opened, 'D:\\new\\b.md');
  assert.strictEqual(toast, 'autosaveRecovered');

  files.clear(); opened = null;
  saveDialogResult = null; // 用户取消
  await ed.recoverAutosave({ name: 'a.md', content: 'x' });
  assert.strictEqual(files.size, 0);
  assert.strictEqual(opened, null);
});

test('recoverAutosave: 恢复成功后快照改名打上恢复时间戳；取消则不改名', async () => {
  files.clear();
  const dir = 'C:\\data\\autosave\\';
  const entry ={ name: 'tone__5.json', path: dir + 'tone__5.json', mtime: Date.now() };
  files.set(entry.path, { content: '{}', mtime: Date.now() });
  const ed = makeEditor({ hideAutosaveDialog() {}, openFilePath: async () => {}, showToast() {}, setStatus() {} });
  saveDialogResult = null;
  await ed.recoverAutosave({ name: 'a.md', content: 'x' }, entry);
  assert.deepStrictEqual([...files.keys()], [entry.path], '取消不改名');
  saveDialogResult = 'D:\\new\\a.md';
  await ed.recoverAutosave({ name: 'a.md', content: 'x' }, entry);
  const names = [...files.keys()].filter(k => k.startsWith(dir)).map(k => k.slice(dir.length));
  assert.strictEqual(names.length, 1);
  assert.match(names[0], /^tone__5__r\d+\.json$/);
});

test('cleanupAutosave: 已恢复版本按「恢复时间 + 已恢复保留天数」单独计期', async () => {
  files.clear();
  const ed = makeEditor();
  ed.settings.autoSaveRecoveredRetentionDays = 7;
  const dir = 'C:\\data\\autosave\\';
  const now = Date.now();
  // 已恢复 10 天前：超过 7 天 → 删（即便 mtime 很新、也不受 30 天影响）
  files.set(dir + 'ta__1__r' + (now - 10 * DAY) + '.json', { content: '{}', mtime: now });
  // 已恢复 2 天前：保留（即便文件本身 mtime 很旧）
  files.set(dir + 'tb__2__r' + (now - 2 * DAY) + '.json', { content: '{}', mtime: now - 40 * DAY });
  // 未恢复且 mtime 40 天前：按 30 天规则删
  files.set(dir + 'tc__3.json', { content: '{}', mtime: now - 40 * DAY });
  await ed.cleanupAutosave();
  assert.deepStrictEqual([...files.keys()].map(k => k.slice(dir.length)), ['tb__2__r' + (now - 2 * DAY) + '.json']);
  ed.settings.autoSaveRecoveredRetentionDays = 1;
  await ed.cleanupAutosave();
  assert.strictEqual(files.size, 0);
});
