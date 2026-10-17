(function exposeSavedRoutes(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SavedRoutes = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";

  const USERNAME_RE = /^[a-z0-9_-]{1,50}$/;
  const PROOF_URL_RE = /^https:\/\/www\.chess\.com\/game\/live\/([1-9]\d*)$/i;

  function username(value) {
    if (typeof value !== "string") return "";
    const clean = value.trim().toLowerCase();
    return USERNAME_RE.test(clean) ? clean : "";
  }

  function proofUrl(value) {
    if (typeof value !== "string") return "";
    const clean = value.trim();
    const match = clean.match(PROOF_URL_RE);
    if (!match) return "";
    const gameId = Number(match[1]);
    return Number.isSafeInteger(gameId) && gameId > 0 ? clean : "";
  }

  function routeStepCount(chain) {
    if (!chain?.found || !Array.isArray(chain.path) || !Array.isArray(chain.hops)) return null;
    const path = chain.path.map(username);
    if (
      path.length < 2 ||
      path.some((node) => !node) ||
      new Set(path).size !== path.length ||
      chain.hops.length !== path.length - 1
    ) {
      return null;
    }
    for (let index = 0; index < chain.hops.length; index++) {
      const hop = chain.hops[index];
      if (
        username(hop?.from) !== path[index] ||
        username(hop?.to) !== path[index + 1] ||
        !proofUrl(hop?.url)
      ) {
        return null;
      }
    }
    return path.length - 1;
  }

  function isStrictlyShorter(candidate, baseline) {
    const candidateSteps = routeStepCount(candidate);
    const baselineSteps = routeStepCount(baseline);
    return candidateSteps != null && baselineSteps != null && candidateSteps < baselineSteps;
  }

  function bridgeSuffixesFor(savedData, targetValue) {
    const target = username(targetValue);
    const suffixes = new Map();
    if (!target) return suffixes;
    const outgoing = new Map();
    const incoming = new Map();
    let display = target;

    for (const chain of Array.isArray(savedData?.chains) ? savedData.chains : []) {
      if (routeStepCount(chain) == null) continue;
      const path = chain.path.map(username);
      const chainTarget = username(chain.target);
      if (chainTarget !== path[path.length - 1]) continue;
      if (chainTarget === target && display === target && typeof chain.display === "string" && chain.display.trim()) {
        display = chain.display.trim();
      }

      for (let index = 0; index < chain.hops.length; index++) {
        const from = path[index];
        const to = path[index + 1];
        if (!outgoing.has(from)) outgoing.set(from, new Map());
        if (outgoing.get(from).has(to)) continue;
        const hop = { ...chain.hops[index], from, to, url: proofUrl(chain.hops[index].url) };
        outgoing.get(from).set(to, hop);
        if (!incoming.has(to)) incoming.set(to, []);
        incoming.get(to).push(from);
      }
    }

    // Each admitted edge carries a proof from a fully validated saved route.
    // Reverse BFS finds the fewest known wins, including internal targets and
    // connections made by joining proof edges from different saved routes.
    const distance = new Map([[target, 0]]);
    const queue = [target];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const node = queue[cursor];
      for (const previous of incoming.get(node) || []) {
        if (distance.has(previous)) continue;
        distance.set(previous, distance.get(node) + 1);
        queue.push(previous);
      }
    }

    for (const start of queue.slice(1)) {
      const path = [start];
      const hops = [];
      let node = start;
      while (node !== target) {
        // Source order breaks equal-length ties and keeps the first proof.
        const hop = Array.from(outgoing.get(node).values()).find(
          (edge) => distance.get(edge.to) === distance.get(node) - 1,
        );
        hops.push(copyProof(hop));
        node = hop.to;
        path.push(node);
      }
      suffixes.set(start, {
        target,
        display,
        found: true,
        length: hops.length,
        path,
        hops,
        source: "saved-route",
      });
    }
    return suffixes;
  }

  function copyProof(value) {
    if (Array.isArray(value)) return value.map(copyProof);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copyProof(item)]));
    }
    return value;
  }

  function precomputedChain(savedData, startValue, targetValue) {
    const start = username(startValue);
    if (!start) return null;
    return bridgeSuffixesFor(savedData, targetValue).get(start) || null;
  }

  return {
    bridgeSuffixesFor,
    isStrictlyShorter,
    precomputedChain,
    routeStepCount,
  };
});
