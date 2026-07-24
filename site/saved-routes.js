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

    for (const chain of Array.isArray(savedData?.chains) ? savedData.chains : []) {
      if (!chain?.found || username(chain.target) !== target) continue;
      if (!Array.isArray(chain.path) || !Array.isArray(chain.hops)) continue;

      const path = chain.path.map(username);
      if (
        path.length < 2 ||
        path.some((node) => !node) ||
        new Set(path).size !== path.length ||
        path[path.length - 1] !== target ||
        chain.hops.length !== path.length - 1
      ) {
        continue;
      }

      const hops = [];
      let valid = true;
      for (let index = 0; index < chain.hops.length; index++) {
        const hop = chain.hops[index];
        const from = username(hop?.from);
        const to = username(hop?.to);
        const url = proofUrl(hop?.url);
        if (from !== path[index] || to !== path[index + 1] || !url) {
          valid = false;
          break;
        }
        hops.push({ from, to, url });
      }
      if (!valid) continue;

      for (let index = 0; index < path.length - 1; index++) {
        const node = path[index];
        const suffixHops = hops.slice(index);
        const suffix = {
          target,
          display: typeof chain.display === "string" && chain.display.trim()
            ? chain.display.trim()
            : target,
          found: true,
          length: suffixHops.length,
          path: path.slice(index),
          hops: suffixHops,
          source: "saved-route",
        };
        const current = suffixes.get(node);
        if (!current || suffix.length < current.length) suffixes.set(node, suffix);
      }
    }

    return suffixes;
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
