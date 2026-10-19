// 长图导出「Error parsing CSS component value, unexpected EOF」vendor 补丁守卫（2026-10-22）
// 背景：html2canvas 1.4.1 的 DocumentCloner 向每个元素插入 ::before/::after 伪元素克隆；
// 被替换元素（INPUT/SELECT/TEXTAREA/IFRAME）的子节点浏览器不做布局，伪元素
// getComputedStyle 全为空串 → 样式容器构建时 CSS 分词器抛 unexpected EOF。
// 任务列表复选框 <input type=checkbox> 即触发源：任何含任务项的文档导出 PNG 长图必崩。
// 修复只存在于 gitignore 的 vendor 副本 src/lib/html2canvas.min.js——由 ensure-vendor
// 从 node_modules 确定性再生后自动重打（applyTizuMarkHtml2CanvasPatch，幂等 marker +
// 锚点丢失 exit 1，同 CM5 补丁先例）。本测试守住补丁链路不静默丢失。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

test('vendor 补丁①：ensure-vendor 含 html2canvas 补丁重打步骤且被调用', () => {
  const vendor = fs.readFileSync(path.join(ROOT, 'scripts', 'ensure-vendor.mjs'), 'utf8');
  assert.match(
    vendor,
    /function applyTizuMarkHtml2CanvasPatch\(\) \{/,
    'ensure-vendor 缺 html2canvas 补丁重打步骤（vendor 再生会抹掉导出长图修复）'
  );
  assert.match(
    vendor,
    /applyTizuMarkHtml2CanvasPatch\(\);\s*\n/,
    'ensure-vendor 的 html2canvas 补丁步骤未被调用'
  );
});

test('vendor 补丁②：两个补丁项均有幂等 marker（守卫 + 文件头注记）', () => {
  const vendor = fs.readFileSync(path.join(ROOT, 'scripts', 'ensure-vendor.mjs'), 'utf8');
  assert.ok(
    vendor.includes("marker: 'n&&!(_B(A)||tn(A)||en(A)||An(A))&&r.insertBefore(n,r.firstChild)'"),
    'ensure-vendor html2canvas 守卫补丁项缺 marker（已打则跳过、锚点丢失则 exit 1 的前提）'
  );
  assert.ok(
    vendor.includes("marker: '本地补丁（2026-10-22'"),
    'ensure-vendor html2canvas 文件头注记补丁项缺 marker'
  );
});

test('vendor 补丁③：锚点丢失时 exit 1（静默跳过 = 修复悄悄消失）', () => {
  const vendor = fs.readFileSync(path.join(ROOT, 'scripts', 'ensure-vendor.mjs'), 'utf8');
  const fn = vendor.slice(vendor.indexOf('function applyTizuMarkHtml2CanvasPatch()'));
  const end = fn.indexOf('}\n\napplyTizuMarkHtml2CanvasPatch();');
  assert.notStrictEqual(end, -1, '无法定位 applyTizuMarkHtml2CanvasPatch 函数体');
  assert.match(
    fn.slice(0, end),
    /if \(bad > 0\) \{[\s\S]{0,200}process\.exit\(1\);/,
    'ensure-vendor html2canvas 补丁锚点丢失时未 exit 1（静默跳过 = 修复悄悄消失）'
  );
});

test('vendor 补丁④：工作区 vendor 副本当前已含守卫（补丁缺失 = 含任务项文档导出长图必崩）', () => {
  const f = path.join(ROOT, 'src', 'lib', 'html2canvas.min.js');
  assert.ok(fs.existsSync(f), 'src/lib/html2canvas.min.js 缺失（先 npm install 触发 ensure-vendor）');
  const lib = fs.readFileSync(f, 'utf8');
  assert.ok(
    lib.includes('n&&!(_B(A)||tn(A)||en(A)||An(A))&&r.insertBefore(n,r.firstChild)'),
    'vendor 副本缺伪元素插入守卫（导出长图 EOF 崩溃未修复）'
  );
  assert.ok(
    !lib.includes('n&&r.insertBefore(n,r.firstChild)'),
    'vendor 副本含未守卫的原文（补丁未应用干净）'
  );
});
