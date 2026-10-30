import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../site/app.js', import.meta.url), 'utf8');
const from = source.indexOf('  function renderGraph(');
const to = source.indexOf('  function treeGraphSignature(', from);
assert.ok(from > 0 && to > from);

function element(tag = 'div', attrs = {}) {
  const properties = new Map();
  return {
    tag, attrs: { ...attrs }, children: [], dataset: {},
    style: { properties, setProperty(key, value) { properties.set(key, String(value)); } },
    classList: { add() {}, remove() {}, contains() { return false; } },
    setAttribute(key, value) { this.attrs[key] = String(value); },
    appendChild(child) { this.children.push(child); return child; },
    addEventListener() {}, querySelectorAll() { return []; },
    set innerHTML(value) { this.children = []; },
  };
}
const descendants = node => [node, ...node.children.flatMap(descendants)];
const hasClass = (node, name) => String(node.attrs.class || '').split(/\s+/).includes(name);
const numbers = text => String(text).match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi).map(Number);

function fixture(compact = false) {
  const svg = element('svg'), hint = element();
  const graph = {
    width: 600, height: 680,
    nodes: [
      { id: 'alpha', username: 'alpha', depth: 0, children: ['omega'] },
      { id: 'omega', username: 'omega', depth: 1, children: [], isTarget: true },
    ],
    edges: [{ from: 'alpha', to: 'omega', depth: 1 }],
    positions: new Map([['alpha', { x: 100, y: 150 }], ['omega', { x: 460, y: 330 }]]),
  };
  let animations = 0;
  const context = vm.createContext({
    window: {}, location: { hostname: 'localhost' }, state: {},
    COMPACT_GRAPH_MEDIA: { matches: compact, addEventListener() {} },
    performance: { now: () => 0 },
    $: selector => selector === '#graph' ? svg : hint,
    el: element, hideGraphExplorer() {}, updateGraphSummary() {},
    nameOf: String, titleOf: () => '', avatarOf: () => '',
    compactGraphLabel: String, pieceFor: () => 'piece',
    loadGraphImagesWhenVisible() {}, animateGraph() { animations++; },
    preloadTreeProfiles() {}, animateTreeGraph() { animations++; },
    treeGraphSignature: () => 'fixture', buildMergedChainTree: () => graph,
  });
  vm.runInContext(source.slice(from, to), context);
  return { svg, graph, context, animations: () => animations };
}

function assertCurvedLineOutput(svg, expectedCenters, layout) {
  const all = descendants(svg);
  const lines = all.filter(node => node.tag === 'path' && hasClass(node, 'edge-line'));
  const nodes = all.filter(node => hasClass(node, 'node'));
  assert.equal(lines.length, expectedCenters.length - 1);
  assert.equal(nodes.length, expectedCenters.length);
  assert.equal(all.some(node => node.tag === 'marker'), false, 'curved-line graphs must not define floating arrowhead markers');
  for (const [index, line] of lines.entries()) {
    for (const attribute of ['marker-start', 'marker-mid', 'marker-end']) {
      assert.equal(line.attrs[attribute], undefined, 'winner-to-loser curves must remain line-only');
    }
    assert.match(line.attrs.d, /^M .+ [QC] /, 'keep the existing curved animated paths');
    const coords = numbers(line.attrs.d);
    const a = expectedCenters[index], b = expectedCenters[index + 1];
    const original = layout === 'wide'
      ? [a.x, a.y, (a.x + b.x) / 2, a.y - 28, b.x, b.y]
      : layout === 'compact'
        ? [a.x, a.y, a.x + 28, (a.y + b.y) / 2, b.x + 28, (a.y + b.y) / 2, b.x, b.y]
        : [100, 150, 265.6, 150, 337.6, 330, 460, 330];
    assert.deepEqual(coords, original, 'keep the d1d5960 center-to-center curve and its original controls');
    const glow = all.filter(node => hasClass(node, 'edge-glow'))[index];
    assert.equal(glow.attrs.d, line.attrs.d, 'glow and animated visible edge must retain the same path');
  }
  assert.ok(all.some(node => node.tag === 'clipPath'), 'avatar clipping must remain present');
  assert.ok(all.some(node => node.tag === 'linearGradient'), 'existing edge gradient must remain present');
}

for (const compact of [false, true]) {
  test(`normal ${compact ? 'compact' : 'wide'} graph keeps winner-to-loser curves without arrowheads`, () => {
    const f = fixture(compact);
    const chain = { found: true, path: ['alpha', 'omega'], hops: [
      { from: 'alpha', to: 'omega', url: 'https://www.chess.com/game/live/123' },
    ] };
    const proofBefore = JSON.stringify(chain);
    f.context.renderGraph(chain);
    assertCurvedLineOutput(f.svg, compact ? [{ x: 150, y: 64 }, { x: 150, y: 196 }] : [{ x: 128, y: 196 }, { x: 912, y: 196 }], compact ? 'compact' : 'wide');
    assert.deepEqual(descendants(f.svg).filter(node => hasClass(node, 'node')).map(node => node.attrs['data-profile-user']), chain.path);
    assert.equal(JSON.stringify(chain), proofBefore, 'visual restoration must preserve route order and proof links');
    assert.equal(f.context.$('#graph-hint').textContent, 'Every link is a real win from a real game. 1 link in total.');
    assert.equal(f.animations(), 1);
  });
}

test('tree graph keeps parent-to-child curves without arrowheads', () => {
  const f = fixture();
  f.context.renderGraph({ tree: true, found: true, root: 'alpha', chains: [], branchCount: 1, targetCount: 1 });
  assertCurvedLineOutput(f.svg, [f.graph.positions.get('alpha'), f.graph.positions.get('omega')], 'tree');
  assert.equal(f.animations(), 1);
});

test('dense wide normal graph retains the original fixed bow on all 17 links', () => {
  const f = fixture();
  const path = Array.from({ length: 18 }, (_, index) => `player${index}`);
  f.context.renderGraph({ found: true, path, hops: [] });
  const centers = path.map((_, index) => ({ x: 128 + (784 / 17) * index, y: 196 }));
  assertCurvedLineOutput(f.svg, centers, 'wide');
  assert.equal(f.animations(), 1);
});

for (const compact of [false, true]) {
  test(`tree ${compact ? 'phone' : 'desktop'} publishes its actual width and appropriate exploration hint`, () => {
    const f = fixture(compact);
    f.context.renderGraph({ tree: true, found: true, root: 'alpha', chains: [], branchCount: 1, targetCount: 1 });
    assert.equal(f.svg.style.properties.get('--tree-graph-width'), `${f.graph.width}px`);
    const hint = f.context.$('#graph-hint').textContent;
    if (compact) assert.match(hint, /Swipe sideways to explore the tree\./);
    else assert.doesNotMatch(hint, /Swipe sideways/);
    assertCurvedLineOutput(f.svg, [f.graph.positions.get('alpha'), f.graph.positions.get('omega')], 'tree');
    assert.equal(f.animations(), 1);
  });
}

test('normal phone graph keeps its vertical layout without tree width or sideways hint', () => {
  const f = fixture(true);
  f.context.renderGraph({ found: true, path: ['alpha', 'omega'], hops: [] });
  assert.equal(f.svg.style.properties.has('--tree-graph-width'), false);
  assert.equal(f.svg.style.properties.get('--chain-graph-height'), '420px');
  assert.doesNotMatch(f.context.$('#graph-hint').textContent, /Swipe sideways/);
  assertCurvedLineOutput(f.svg, [{ x: 150, y: 64 }, { x: 150, y: 196 }], 'compact');
  assert.equal(f.animations(), 1);
});
