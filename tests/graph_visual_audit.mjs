// Reads the actual fixture SVG. The expected curves are the d1d5960 builders;
// this does not alter the renderer, timers, motion preference, or Replay state.
export function readGraphAppearance() {
  const numbers = value => (String(value || '').match(/-?\d*\.?\d+(?:e[+-]?\d+)?/gi) || []).map(Number);
  const sameNumbers = (actual, expected) => actual.length === expected.length && actual.every((value, i) => Math.abs(value - expected[i]) < 0.001);
  const position = node => {
    const pair = numbers(node?.getAttribute('transform'));
    return {x: pair[0], y: pair[1]};
  };
  function inspect() {
    const svg = document.querySelector('#graph');
    if (!svg) return {kind: 'none', nodes: 0, edges: 0};
    const tree = svg.classList.contains('is-tree-graph');
    const nodes = [...svg.querySelectorAll('.node')];
    const edges = [...svg.querySelectorAll('.edge-line')];
    const glows = [...svg.querySelectorAll('.edge-glow')];
    const byId = new Map(nodes.map(node => [node.dataset.treeNodeId, node]));
    const refs = [...svg.querySelectorAll('path, line, polyline, polygon')].flatMap(node => {
      const style = getComputedStyle(node);
      return ['start', 'mid', 'end'].flatMap(part => {
        const value = node.getAttribute(`marker-${part}`) || style.getPropertyValue(`marker-${part}`);
        return value && value !== 'none' ? [`${node.tagName}:${part}:${value}`] : [];
      });
    });
    const triangles = [...svg.querySelectorAll('polygon, path')].filter(node => {
      if (node.tagName.toLowerCase() === 'polygon') return numbers(node.getAttribute('points')).length === 6;
      const d = node.getAttribute('d') || '';
      return /z\s*$/i.test(d) && !/[achqstv]/i.test(d) && numbers(d).length === 6;
    }).map(node => ({tag: node.tagName, id: node.id, class: node.getAttribute('class')}));
    let partialEdges = 0, undrawnEdges = 0, completeEdges = 0, oldCurves = 0;
    for (const [i, edge] of edges.entries()) {
      const length = edge.getTotalLength();
      const offset = Math.abs(parseFloat(getComputedStyle(edge).strokeDashoffset) || 0);
      if (offset > 0.25 && offset < length - 0.25) partialEdges++;
      if (offset >= length - 0.25) undrawnEdges++;
      if (offset <= 0.25) completeEdges++;
      let a, b, expected, command;
      if (tree) {
        const [from, to] = String(edge.dataset.treeEdge || '').split('|');
        a = position(byId.get(from)); b = position(byId.get(to));
        const dx = Math.max(1, b.x - a.x);
        const bow = Math.abs(b.y - a.y) < 8 ? Math.min(12, Math.max(5, dx * 0.025)) : 0;
        expected = [a.x, a.y, a.x + Math.max(42, (b.x - a.x) * 0.46), a.y - bow, b.x - Math.max(42, (b.x - a.x) * 0.34), b.y - bow, b.x, b.y];
        command = 'C';
      } else {
        a = position(nodes[i]); b = position(nodes[i + 1]);
        const compact = matchMedia('(max-width: 620px)').matches;
        expected = compact ? [a.x, a.y, a.x + 28, (a.y + b.y) / 2, b.x + 28, (a.y + b.y) / 2, b.x, b.y]
          : [a.x, a.y, (a.x + b.x) / 2, a.y - 28, b.x, b.y];
        command = compact ? 'C' : 'Q';
      }
      const d = edge.getAttribute('d') || '';
      if (new RegExp(`^M\\s.+\\s${command}\\s`).test(d) && sameNumbers(numbers(d), expected)) oldCurves++;
    }
    const visible = node => Number(getComputedStyle(node).opacity) >= 0.99;
    return {
      kind: tree ? 'tree' : 'normal', nodes: nodes.length, edges: edges.length,
      glows: glows.length, alignedGlows: edges.filter((edge, i) => edge.getAttribute('d') === glows[i]?.getAttribute('d')).length,
      oldCurves, markerDefinitions: svg.querySelectorAll('marker').length, markerReferences: refs, triangles,
      partialEdges, undrawnEdges, completeEdges, hiddenNodes: nodes.filter(node => !visible(node)).length,
      movingGlyphs: [...svg.querySelectorAll('.traveller, .edge-spark, .tree-rider')].filter(node => Number(getComputedStyle(node).opacity) > 0.02).length,
      nodeOrder: nodes.map(node => node.dataset.profileUser),
      proofs: [...document.querySelectorAll('#cards a.card__proof')].map(link => link.href),
      hint: document.querySelector('#graph-hint')?.textContent.trim(),
      labels: [...svg.querySelectorAll('.node__label')].map(label => ({text: label.textContent, renderedHeight: label.getBoundingClientRect().height})),
    };
  }
  return inspect();
}

export function isRestoredGraph(state, edges) {
  return state.edges === edges && state.glows === edges && state.alignedGlows === edges && state.oldCurves === edges
    && state.markerDefinitions === 0 && state.markerReferences.length === 0 && state.triangles.length === 0;
}
