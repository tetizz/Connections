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

function assertDirectionalOutput(svg, radius, expectedCenters) {
  const all = descendants(svg);
  const lines = all.filter(node => node.tag === 'path' && hasClass(node, 'edge-line'));
  const nodes = all.filter(node => hasClass(node, 'node'));
  assert.equal(lines.length, expectedCenters.length - 1);
  assert.equal(nodes.length, expectedCenters.length);
  for (const [index, line] of lines.entries()) {
    const reference = line.attrs['marker-end'];
    assert.match(reference || '', /^url\(#.+\)$/, 'each winner-to-loser edge must end in an SVG arrowhead');
    assert.equal(line.attrs['marker-start'], undefined, 'direction must point toward the next player only');
    const marker = all.find(node => node.tag === 'marker' && node.attrs.id === reference.slice(5, -1));
    assert.ok(marker, 'marker reference must resolve to a definition in this SVG');
    assert.equal(marker.attrs.orient, 'auto');
    assert.ok(Number(marker.attrs.markerWidth) > 0 && Number(marker.attrs.markerHeight) > 0);
    assert.ok(descendants(marker).some(node => node.tag === 'path' || node.tag === 'polygon'), 'marker must contain visible arrow geometry');
    const coords = numbers(line.attrs.d);
    const start = coords.slice(0, 2), end = coords.slice(-2);
    const a = expectedCenters[index], b = expectedCenters[index + 1];
    assert.ok(Math.hypot(start[0] - a.x, start[1] - a.y) >= radius + 2, 'source endpoint must clear the avatar circle');
    assert.ok(Math.hypot(end[0] - b.x, end[1] - b.y) >= radius + 2, 'destination arrow tip must clear the avatar circle');
    const finalControl = coords.slice(-4, -2);
    const towardDestination = (end[0] - finalControl[0]) * (b.x - end[0])
      + (end[1] - finalControl[1]) * (b.y - end[1]);
    assert.ok(towardDestination > 0, 'terminal tangent and arrowhead must point toward the destination center');
    assert.ok(Math.hypot(end[0] - b.x, end[1] - b.y) < Math.hypot(end[0] - a.x, end[1] - a.y), 'path end must approach the destination, not the source');
    const glow = all.filter(node => hasClass(node, 'edge-glow'))[index];
    assert.equal(glow.attrs.d, line.attrs.d, 'glow and animated visible edge must retain the same path');
  }
  assert.ok(all.some(node => node.tag === 'clipPath'), 'avatar clipping must remain present');
  assert.ok(all.some(node => node.tag === 'linearGradient'), 'existing edge gradient must remain present');
}

for (const compact of [false, true]) {
  test(`normal ${compact ? 'compact' : 'wide'} graph emits directional arrowheads outside avatar clipping`, () => {
    const f = fixture(compact);
    f.context.renderGraph({ found: true, path: ['alpha', 'omega'], hops: [] });
    assertDirectionalOutput(f.svg, 32, compact ? [{ x: 150, y: 64 }, { x: 150, y: 196 }] : [{ x: 128, y: 196 }, { x: 912, y: 196 }]);
    assert.equal(f.animations(), 1);
  });
}

test('tree graph emits parent-to-child arrowheads outside avatar clipping', () => {
  const f = fixture();
  f.context.renderGraph({ tree: true, found: true, root: 'alpha', chains: [], branchCount: 1, targetCount: 1 });
  assertDirectionalOutput(f.svg, 28, [f.graph.positions.get('alpha'), f.graph.positions.get('omega')]);
  assert.equal(f.animations(), 1);
});

test('dense wide normal graph keeps all 17 arrowheads pointing toward their destinations', () => {
  const f = fixture();
  const path = Array.from({ length: 18 }, (_, index) => `player${index}`);
  f.context.renderGraph({ found: true, path, hops: [] });
  const centers = path.map((_, index) => ({ x: 128 + (784 / 17) * index, y: 196 }));
  assertDirectionalOutput(f.svg, 32, centers);
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
    assertDirectionalOutput(f.svg, 28, [f.graph.positions.get('alpha'), f.graph.positions.get('omega')]);
    assert.equal(f.animations(), 1);
  });
}

test('normal phone graph keeps its vertical layout without tree width or sideways hint', () => {
  const f = fixture(true);
  f.context.renderGraph({ found: true, path: ['alpha', 'omega'], hops: [] });
  assert.equal(f.svg.style.properties.has('--tree-graph-width'), false);
  assert.equal(f.svg.style.properties.get('--chain-graph-height'), '420px');
  assert.doesNotMatch(f.context.$('#graph-hint').textContent, /Swipe sideways/);
  assertDirectionalOutput(f.svg, 32, [{ x: 150, y: 64 }, { x: 150, y: 196 }]);
  assert.equal(f.animations(), 1);
});
