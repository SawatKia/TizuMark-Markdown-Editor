// 图片 / 图表查看器的鼠标绑定：默认值、解析校验、事件匹配、持久化
const { test } = require('node:test');
const assert = require('node:assert');

global.window = {};
global.TMConst = { Tab: class {}, dialogSave: async () => null };
const store = new Map();
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
};
const { mixin } = require('../src/modules/shortcuts.js');
const ed = () => { store.clear(); return Object.assign({ t: (k) => k }, mixin); };
const ev = (type, o = {}) => Object.assign({ type, button: 0, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false }, o);

test('默认：滚轮缩放 / 中键拖动平移 / 双击重置', () => {
  const e = ed();
  assert.deepStrictEqual(e.getViewerBindings(), { zoom: 'Wheel', pan: 'Middle', reset: 'DoubleClick' });
  assert.ok(e.viewerBindingMatches('zoom', ev('wheel')));
  assert.ok(e.viewerBindingMatches('pan', ev('mousedown', { button: 1 })));
  assert.ok(!e.viewerBindingMatches('pan', ev('mousedown', { button: 0 })), '左键默认不平移');
  assert.ok(e.viewerBindingMatches('reset', ev('dblclick')));
});

test('修饰键必须完全一致', () => {
  const e = ed();
  e.saveViewerBindings({ zoom: 'Ctrl+Wheel', pan: 'Left', reset: 'DoubleClick' });
  assert.ok(e.viewerBindingMatches('zoom', ev('wheel', { ctrlKey: true })));
  assert.ok(!e.viewerBindingMatches('zoom', ev('wheel')));
  assert.ok(!e.viewerBindingMatches('zoom', ev('wheel', { ctrlKey: true, shiftKey: true })));
  assert.ok(e.viewerBindingMatches('pan', ev('mousedown', { button: 0 })));
});

test('各动作只接受合法触发方式', () => {
  const e = ed();
  assert.ok(e._validViewerBinding('zoom', 'Alt+Wheel'));
  assert.ok(!e._validViewerBinding('zoom', 'Left'));
  assert.ok(e._validViewerBinding('pan', 'Right'));
  assert.ok(!e._validViewerBinding('pan', 'Wheel'));
  assert.ok(e._validViewerBinding('reset', 'Middle'));
  assert.ok(!e._validViewerBinding('reset', 'Left'));
  assert.ok(!e._validViewerBinding('zoom', 'Meta+Wheel'));
});

test('持久化往返；损坏或非法值回落默认', () => {
  const e = ed();
  e.saveViewerBindings({ zoom: 'Shift+Wheel', pan: 'Right', reset: 'Middle' });
  const e2 = Object.assign({ t: (k) => k }, mixin);
  assert.deepStrictEqual(e2.loadViewerBindings(), { zoom: 'Shift+Wheel', pan: 'Right', reset: 'Middle' });
  store.set('tizumark-viewer-bindings', '{bad');
  assert.deepStrictEqual(e2.loadViewerBindings(), { zoom: 'Wheel', pan: 'Middle', reset: 'DoubleClick' });
  store.set('tizumark-viewer-bindings', JSON.stringify({ zoom: 'Left', pan: 'Wheel', reset: 'x' }));
  assert.deepStrictEqual(e2.loadViewerBindings(), { zoom: 'Wheel', pan: 'Middle', reset: 'DoubleClick' });
});

test('formatViewerBinding：修饰键 + 本地化按键名', () => {
  const e = ed();
  assert.strictEqual(e.formatViewerBinding('Ctrl+Shift+Wheel'), 'Ctrl+Shift+vbWheel');
  assert.strictEqual(e.formatViewerBinding('bogus'), '');
});
