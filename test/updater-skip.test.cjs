// 更新提示「跳过此版本」（2026-10-21）：更新对话框新增按钮，点击后记住该远程版本号并落盘，
// 自动检查（启动 5s 后）再遇同版本静默不弹窗；更高版本仍提示。
// 断言重点：
//   - skipUpdateVersion 写 settings.skippedUpdateVersion 并经 saveSettings 落盘 localStorage
//   - 自动 checkUpdate(false)：已跳过版本 → 不弹窗、不置 pendingUpdate；未跳过/更高版本 → 正常弹窗
//   - 手动 checkUpdate(true)：已跳过版本仍展示「可用」态（用户主动查询，跳过只抑制自动弹窗）
//   - 「跳过此版本」按钮仅在 available 态可见
//   - skippedUpdateVersion 走 settings 默认值 + 类型校验自愈（存了非字符串自动回默认）
const test = require('node:test');
const assert = require('node:assert');
const { buildEnv, cleanup, waitForEditor } = require('./helpers/app-env.cjs');

async function makeEditor(remoteVersion) {
  const { w } = await buildEnv({
    invokeImpl: (cmd) => {
      if (cmd === 'plugin:updater|check') {
        return remoteVersion ? { version: remoteVersion, body: '', rid: 'rid-1' } : null;
      }
      return undefined;
    },
  });
  await waitForEditor(w);
  return { w, ed: w.editor };
}

const isDialogOpen = (w) => !w.document.getElementById('update-dialog').classList.contains('hidden');

test('skip: 点击跳过此版本 → 版本写入 settings 并落盘，弹框关闭，成功提示含版本号', async () => {
  const { w, ed } = await makeEditor(null);
  try {
    const toasts = [];
    ed.showToast = (msg) => toasts.push(String(msg));
    ed.showUpdateDialog();
    ed.pendingUpdate = { version: '1.2.5', body: '', rid: 'rid-1' };

    ed.skipUpdateVersion();

    assert.strictEqual(ed.settings.skippedUpdateVersion, '1.2.5', '应记住被跳过的版本号');
    const saved = JSON.parse(w.localStorage.getItem('tizumark-settings'));
    assert.strictEqual(saved.skippedUpdateVersion, '1.2.5', '应随 saveSettings 落盘 localStorage');
    assert.ok(!isDialogOpen(w), '弹框应关闭');
    const expected = ed.t('updateVersionSkipped', { ver: '1.2.5' });
    assert.ok(toasts.some((t) => t.includes(expected)), '成功提示应含跳过的版本文案');
  } finally { cleanup(w); }
});

test('skip: 自动检查遇到已跳过版本 → 静默不弹窗、不置 pendingUpdate', async () => {
  const { w, ed } = await makeEditor('1.2.5');
  try {
    ed.settings.skippedUpdateVersion = '1.2.5';
    await ed.checkUpdate(false); // 模拟启动 5s 后的自动检查
    assert.ok(!isDialogOpen(w), '已跳过版本的自动检查不应弹窗');
    assert.strictEqual(ed.pendingUpdate, null, '不应置 pendingUpdate');
  } finally { cleanup(w); }
});

test('skip: 自动检查遇到更高（未跳过）版本 → 正常弹窗并可更新', async () => {
  const { w, ed } = await makeEditor('1.2.6');
  try {
    ed.settings.skippedUpdateVersion = '1.2.5'; // 跳过的是 1.2.5
    await ed.checkUpdate(false);
    assert.ok(isDialogOpen(w), '更高版本应正常弹窗');
    assert.strictEqual(ed.pendingUpdate && ed.pendingUpdate.version, '1.2.6');
  } finally { cleanup(w); }
});

test('skip: 手动「检查更新」遇到已跳过版本 → 仍展示可用态（主动查询不受静默影响）', async () => {
  const { w, ed } = await makeEditor('1.2.5');
  try {
    ed.settings.skippedUpdateVersion = '1.2.5';
    await ed.checkUpdate(true);
    assert.ok(isDialogOpen(w), '手动检查应打开弹框');
    const avail = w.document.getElementById('update-state-available');
    assert.ok(!avail.classList.contains('hidden'), '应展示「发现新版本」态');
    assert.strictEqual(
      w.document.getElementById('update-new-version').textContent, '1.2.5',
      '应显示被跳过的新版本号（用户可主动更新）'
    );
  } finally { cleanup(w); }
});

test('skip: 「跳过此版本」按钮仅在 available 态可见', async () => {
  const { w, ed } = await makeEditor(null);
  try {
    const btn = w.document.getElementById('update-skip-version');
    assert.ok(btn, '按钮应存在');
    ed.showUpdateState('checking');
    assert.ok(btn.classList.contains('hidden'), 'checking 态应隐藏');
    ed.showUpdateState('available');
    assert.ok(!btn.classList.contains('hidden'), 'available 态应可见');
    ed.showUpdateState('latest');
    assert.ok(btn.classList.contains('hidden'), 'latest 态应隐藏');
  } finally { cleanup(w); }
});

test('skip: settings 默认值与类型校验（存了非字符串自动回默认空串）', async () => {
  const { w, ed } = await makeEditor(null);
  try {
    assert.strictEqual(ed.settings.skippedUpdateVersion, '', '默认应为空串');
    ed.settings.skippedUpdateVersion = '1.2.5';
    ed.saveSettings();
    assert.strictEqual(ed.loadSettings().skippedUpdateVersion, '1.2.5', '落盘后重读应还原');
    // 手工污染 localStorage（模拟旧版本残留/畸形写入）：非字符串应被类型校验重置为空串
    const raw = JSON.parse(w.localStorage.getItem('tizumark-settings'));
    raw.skippedUpdateVersion = 125;
    w.localStorage.setItem('tizumark-settings', JSON.stringify(raw));
    assert.strictEqual(ed.loadSettings().skippedUpdateVersion, '', '非字符串应回默认空串');
  } finally { cleanup(w); }
});
