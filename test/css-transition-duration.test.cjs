// CSS transition 时长必须逐个属性书写（2026-10-25 审查发现，一类系统性缺陷）。
//
// 缺陷是什么：`transition: background-color, color, box-shadow 0.15s ease;`
// 在规范里是**三个** <single-transition> 组成的列表，时长属于「每一项自己」，缺省即 0s
// —— 所以上面这句只有 box-shadow 真的在过渡，background-color / color 是 0s 瞬变。
// 观感上是「底色啪一下跳、阴影慢慢爬」，很难一眼看出是书写错误。
//
// 为什么要有这条测试：同一写法在 styles.css 里曾散落 13 处（.window-btn / .dropdown-item /
// .context-menu-item / .tab / .find-btn / .scroll-top-btn / .dialog-btn / .shortcut-* …），
// 2026-10-25 一次性改成逐属性写法。只修不锁，下一个人复制粘贴旧模板就会回潮。
//
// 判定口径（宁可漏报不可误报）：
//   · 跳过 `transition: none/inherit/initial/unset`；
//   · 跳过注释里的示例文本（先剥 /* */，含跨行注释）；
//   · 逗号按**括号深度**切分 —— 否则 cubic-bezier(0.4, 0, 0.2, 1) 会被切碎，
//     把合法的逐属性写法误判成缺陷（第一版扫描脚本就栽在这里）；
//   · 每个「纯属性名」分段都必须自带时长，否则算缺陷。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// 剥掉 CSS 注释（含跨行），保留换行以便行号仍然对得上
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
}

// 按顶层逗号切分（跳过括号内的逗号）
function splitTopLevel(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

const hasDuration = (seg) => /(^|\s)[0-9.]+m?s(\s|$)/.test(seg);
const isBareProperty = (seg) => /^[a-zA-Z-]+$/.test(seg);

// 返回违规清单：[{ line, selector, value, missing }]
function findBadTransitions(src) {
  const lines = stripComments(src).split(/\r?\n/);
  const bad = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /transition\s*:\s*([^;]+);?/.exec(lines[i]);
    if (!m) continue;
    const value = m[1].trim();
    if (/^(none|inherit|initial|unset)\b/.test(value)) continue;
    const segs = splitTopLevel(value);
    if (segs.length < 2) continue; // 单属性：书写方式本身就是逐项的
    const missing = segs.filter((s) => !hasDuration(s) && isBareProperty(s));
    if (!missing.length) continue;

    // 向上回溯所属选择器，报错时能直接定位
    let selector = '(未定位)';
    for (let j = i - 1; j >= 0 && j >= i - 40; j--) {
      const t = lines[j].trim();
      if (!t) continue;
      if (t === '}') {
        let depth = 0;
        for (let k = j; k >= 0; k--) {
          const u = lines[k].trim();
          if (u === '}') depth++;
          else if (u.endsWith('{')) { depth--; if (depth === 0) { selector = u.slice(0, -1).trim(); break; } }
        }
        break;
      }
      if (t.endsWith('{')) { selector = t.slice(0, -1).trim(); break; }
    }
    bad.push({ line: i + 1, selector, value, missing });
  }
  return bad;
}

test('styles.css：多属性 transition 必须逐项带时长（只有末项带时长的写法会让其余属性变 0s 瞬变）', () => {
  const file = path.join(ROOT, 'src', 'styles.css');
  const src = fs.readFileSync(file, 'utf8');
  const bad = findBadTransitions(src);

  const detail = bad
    .map((b) => `  L${b.line} ${b.selector}\n      transition: ${b.value}\n      无时长的项: ${b.missing.join(', ')}`)
    .join('\n');

  assert.deepStrictEqual(bad.map((b) => `${b.line}:${b.selector}`), [],
    `以下 transition 里有属性没拿到时长（缺省 0s = 瞬变）：\n${detail}\n\n` +
    '修法：把每一项都写全，例如\n' +
    '  transition: background-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease;');
});

test('扫描器自检：能识别缺陷写法，且不误伤 cubic-bezier 的合法写法', () => {
  const bad = findBadTransitions('.x { transition: background-color, color, box-shadow 0.15s ease; }');
  assert.strictEqual(bad.length, 1, '只有末项带时长的写法必须被判为缺陷');
  assert.deepStrictEqual(bad[0].missing, ['background-color', 'color'], '应精确指出没时长的项');

  // cubic-bezier(...) 内部有逗号 —— 逐属性写法不能被切坏
  const okCubic = findBadTransitions(
    '.y { transition: background-color 0.3s cubic-bezier(0.4, 0, 0.2, 1), color 0.3s cubic-bezier(0.4, 0, 0.2, 1); }'
  );
  assert.deepStrictEqual(okCubic, [], 'cubic-bezier 的逗号不能被当成分段符');

  // 单属性 / none / 注释里的示例都不算缺陷
  assert.deepStrictEqual(findBadTransitions('.z { transition: opacity 0.15s ease; }'), []);
  assert.deepStrictEqual(findBadTransitions('.z { transition: none; }'), []);
  assert.deepStrictEqual(
    findBadTransitions('/* 例：transition: a, b, c 0.2s */\n.w { color: red; }'),
    [],
    '注释里的示例文本不应被当成真实声明'
  );
});
