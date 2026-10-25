// Mermaid 自动配色：仅对「无任何样式」的流程图追加 style 语句；有样式 / 非流程图 / 关闭开关均原样返回
const { test } = require('node:test');
const assert = require('node:assert');
const { autoStyleMermaid, extractFlowchartNodeIds } = require('../src/modules/preview-post.js');

const styledExample = `graph TD
    subgraph Client [Web Client]
        Layer1["1. Presentation<br/>(React Components)"]
        Layer2["2. Hook"]
        Layer1 -->|Invokes/Selects| Layer2
    end
    style Layer1 fill:#a0c4ff,stroke:#333,stroke-width:1px
`;

test('已有 style / classDef / class / ::: 的图完全不介入', () => {
  assert.strictEqual(autoStyleMermaid(styledExample, true), styledExample);
  const cd = 'flowchart LR\n  A --> B\n  classDef x fill:#f00\n  class A x';
  assert.strictEqual(autoStyleMermaid(cd, true), cd);
  const inline = 'graph TD\n  A:::foo --> B';
  assert.strictEqual(autoStyleMermaid(inline, true), inline);
});

test('非流程图 / 关闭开关：原样返回', () => {
  const seq = 'sequenceDiagram\n  A->>B: hi';
  assert.strictEqual(autoStyleMermaid(seq, true), seq);
  const g = 'graph TD\n  A --> B';
  assert.strictEqual(autoStyleMermaid(g, false), g);
});

test('无样式流程图：每个节点追加调色板 style，且不产生多余节点', () => {
  const src = `graph TD
    subgraph Client [Web Client]
        Layer1["1. Presentation<br/>(Components, Pages)"]
        Layer2["2. Hook"]
        Layer1 -->|Invokes/Selects| Layer2
    end
    Layer2 -- reads data --> Layer3[(Store)]
    Layer3 -- yes --- Layer4{Ok?}
    Layer4 -.-> Layer5((End)) & Layer6
`;
  assert.deepStrictEqual(extractFlowchartNodeIds(src), ['Layer1', 'Layer2', 'Layer3', 'Layer4', 'Layer5', 'Layer6']);
  const out = autoStyleMermaid(src, true);
  assert.ok(out.startsWith(src.trimEnd()));
  for (const id of ['Layer1', 'Layer2', 'Layer3', 'Layer4', 'Layer5', 'Layer6']) {
    assert.match(out, new RegExp('style ' + id + ' fill:#[0-9a-f]{6},stroke:#333,stroke-width:1px'));
  }
  assert.doesNotMatch(out, /style (reads|data|yes|Client) /);
});

test('简单流程图：A[开始] --> B[结束]', () => {
  const out = autoStyleMermaid('graph TD\n    A[开始] --> B[结束]\n', true);
  assert.match(out, /style A fill:#a0c4ff/);
  assert.match(out, /style B fill:#bdb2ff/);
});
