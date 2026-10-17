import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import savedRoutes from "../../site/saved-routes.js";


const fullRoute = {
  target: "Hikaru",
  display: "Hikaru Nakamura",
  found: true,
  length: 3,
  path: ["Trixize1234", "MadPotato", "LucasMito", "Hikaru"],
  hops: [
    {
      from: "Trixize1234",
      to: "MadPotato",
      url: "https://www.chess.com/game/live/165127805622",
    },
    {
      from: "MadPotato",
      to: "LucasMito",
      url: "https://www.chess.com/game/live/1315436574",
    },
    {
      from: "LucasMito",
      to: "Hikaru",
      url: "https://www.chess.com/game/live/109459898005",
    },
  ],
};

test("the browser loads the saved-route index before the app", () => {
  const html = readFileSync(
    fileURLToPath(new URL("../../site/index.html", import.meta.url)),
    "utf8",
  );
  const routesIndex = html.indexOf('src="saved-routes.js');
  const appIndex = html.indexOf('src="app.js');

  assert.notEqual(routesIndex, -1);
  assert.notEqual(appIndex, -1);
  assert.ok(routesIndex < appIndex);
});

test("an initial shorter server result remains marked as an improvement at terminal completion", () => {
  const app = readFileSync(
    fileURLToPath(new URL("../../site/app.js", import.meta.url)),
    "utf8",
  );

  assert.match(app, /let improvedByServer = false;/);
  assert.match(app, /improvedByServer = true;/);
  assert.match(app, /if \(!isCurrent\(\) \|\| improved \|\| improvedByServer\) return;/);
});

test("the configured start gets the complete saved route", () => {
  const route = savedRoutes.precomputedChain(
    { start: "trixize1234", chains: [fullRoute] },
    "TRIXIZE1234",
    "HIKARU",
  );

  assert.deepEqual(route.path, [
    "trixize1234",
    "madpotato",
    "lucasmito",
    "hikaru",
  ]);
  assert.equal(route.length, 3);
  assert.equal(route.display, "Hikaru Nakamura");
  assert.deepEqual(route.hops.map((hop) => hop.url), fullRoute.hops.map((hop) => hop.url));
});

test("an arbitrary player already on a saved route gets the exact proof suffix", () => {
  const route = savedRoutes.precomputedChain(
    { start: "trixize1234", chains: [fullRoute] },
    "madpotato",
    "hikaru",
  );

  assert.deepEqual(route.path, ["madpotato", "lucasmito", "hikaru"]);
  assert.equal(route.length, 2);
  assert.deepEqual(route.hops, [
    {
      from: "madpotato",
      to: "lucasmito",
      url: "https://www.chess.com/game/live/1315436574",
    },
    {
      from: "lucasmito",
      to: "hikaru",
      url: "https://www.chess.com/game/live/109459898005",
    },
  ]);
});

test("negative, mismatched, and malformed saved entries never become fast paths", () => {
  const negative = { ...fullRoute, found: false };
  const wrongTarget = { ...fullRoute, target: "magnuscarlsen" };
  const cyclicPath = {
    ...fullRoute,
    path: ["trixize1234", "madpotato", "trixize1234", "hikaru"],
    hops: [
      fullRoute.hops[0],
      {
        from: "madpotato",
        to: "trixize1234",
        url: "https://www.chess.com/game/live/2",
      },
      {
        from: "trixize1234",
        to: "hikaru",
        url: "https://www.chess.com/game/live/3",
      },
    ],
  };
  const brokenProof = {
    ...fullRoute,
    hops: [
      fullRoute.hops[0],
      { ...fullRoute.hops[1], to: "someone-else" },
      fullRoute.hops[2],
    ],
  };
  const unsafeProof = {
    ...fullRoute,
    hops: [
      fullRoute.hops[0],
      { ...fullRoute.hops[1], url: "https://www.chess.com/game/member/fake" },
      fullRoute.hops[2],
    ],
  };
  const ambiguousProof = {
    ...fullRoute,
    hops: [
      fullRoute.hops[0],
      { ...fullRoute.hops[1], url: "https://www.chess.com/game/live/2?redirect=1" },
      fullRoute.hops[2],
    ],
  };
  const savedData = {
    start: "trixize1234",
    chains: [negative, wrongTarget, cyclicPath, brokenProof, unsafeProof, ambiguousProof],
  };

  assert.equal(savedRoutes.precomputedChain(savedData, "trixize1234", "hikaru"), null);
  assert.equal(savedRoutes.precomputedChain(savedData, "madpotato", "hikaru"), null);
  assert.equal(savedRoutes.bridgeSuffixesFor(savedData, "not valid!").size, 0);
});

test("the shortest validated suffix wins when saved routes overlap", () => {
  const shorter = {
    target: "hikaru",
    found: true,
    path: ["madpotato", "hikaru"],
    hops: [{
      from: "madpotato",
      to: "hikaru",
      url: "https://www.chess.com/game/live/2",
    }],
  };

  const route = savedRoutes.precomputedChain(
    { chains: [fullRoute, shorter] },
    "madpotato",
    "hikaru",
  );

  assert.deepEqual(route.path, ["madpotato", "hikaru"]);
  assert.equal(route.length, 1);
});

test("only a complete, proof-aligned, strictly shorter route may replace the saved route", () => {
  const equalLength = {
    ...fullRoute,
    path: ["trixize1234", "one", "two", "hikaru"],
    hops: [
      { from: "trixize1234", to: "one", url: "https://www.chess.com/game/live/10" },
      { from: "one", to: "two", url: "https://www.chess.com/game/live/11" },
      { from: "two", to: "hikaru", url: "https://www.chess.com/game/live/12" },
    ],
  };
  const longer = {
    ...equalLength,
    path: ["trixize1234", "one", "two", "three", "hikaru"],
    hops: [
      ...equalLength.hops.slice(0, 2),
      { from: "two", to: "three", url: "https://www.chess.com/game/live/13" },
      { from: "three", to: "hikaru", url: "https://www.chess.com/game/live/14" },
    ],
  };
  const shorter = {
    ...fullRoute,
    path: ["trixize1234", "one", "hikaru"],
    hops: [
      { from: "trixize1234", to: "one", url: "https://www.chess.com/game/live/15" },
      { from: "one", to: "hikaru", url: "https://www.chess.com/game/live/16" },
    ],
  };
  const malformedShorter = {
    ...shorter,
    hops: [{ ...shorter.hops[0], to: "someone-else" }, shorter.hops[1]],
  };

  assert.equal(savedRoutes.isStrictlyShorter(equalLength, fullRoute), false);
  assert.equal(savedRoutes.isStrictlyShorter(longer, fullRoute), false);
  assert.equal(savedRoutes.isStrictlyShorter(malformedShorter, fullRoute), false);
  assert.equal(savedRoutes.isStrictlyShorter(shorter, fullRoute), true);
});


// This oracle deliberately does not call the route module's validation or graph helpers.
function independentlyAdmittedEdges(data) {
  const edges = new Map();
  const clean = value => typeof value === "string" && /^[a-z0-9_-]{1,50}$/i.test(value.trim())
    ? value.trim().toLowerCase() : "";
  for (const chain of data.chains || []) {
    const path = Array.isArray(chain.path) ? chain.path.map(clean) : [];
    if (chain.found !== true || path.length < 2 || path.some(node => !node)
      || new Set(path).size !== path.length || clean(chain.target) !== path.at(-1)
      || !Array.isArray(chain.hops) || chain.hops.length !== path.length - 1) continue;
    const valid = chain.hops.every((hop, index) => {
      const match = typeof hop.url === "string" && hop.url.trim().match(/^https:\/\/www\.chess\.com\/game\/live\/([1-9]\d*)$/i);
      return clean(hop.from) === path[index] && clean(hop.to) === path[index + 1]
        && match && Number.isSafeInteger(Number(match[1]));
    });
    if (!valid) continue;
    for (let index = 0; index < chain.hops.length; index++) {
      if (!edges.has(path[index])) edges.set(path[index], new Map());
      if (!edges.has(path[index + 1])) edges.set(path[index + 1], new Map());
      if (!edges.get(path[index]).has(path[index + 1])) {
        edges.get(path[index]).set(path[index + 1], chain.hops[index].url.trim());
      }
    }
  }
  return edges;
}

function independentDistance(edges, start, target) {
  const queue = [[start, 0]], seen = new Set([start]);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const [node, distance] = queue[cursor];
    for (const next of edges.get(node)?.keys() || []) {
      if (next === target) return distance + 1;
      if (!seen.has(next)) { seen.add(next); queue.push([next, distance + 1]); }
    }
  }
  return null;
}

function proofChain(path, firstGame = 100) {
  return { target: path.at(-1), found: true, path,
    hops: path.slice(1).map((to, index) => ({ from: path[index], to,
      url: `https://www.chess.com/game/live/${firstGame + index}` })) };
}

function assertShortestRoutesForAllPairs(data) {
  const edges = independentlyAdmittedEdges(data);
  let admittedPairs = 0;
  for (const start of edges.keys()) for (const target of edges.keys()) {
    if (start === target) continue;
    const distance = independentDistance(edges, start, target);
    const route = savedRoutes.precomputedChain(data, start, target);
    if (distance === null) { assert.equal(route, null, `${start} -> ${target}: directed unreachable`); continue; }
    admittedPairs++;
    assert.ok(route, `${start} -> ${target}: missing saved graph route`);
    assert.equal(route.length, distance, `${start} -> ${target}: minimum edge count`);
    assert.equal(route.path[0], start);
    assert.equal(route.path.at(-1), target);
    assert.equal(route.hops.length, distance);
    assert.equal(new Set(route.path).size, route.path.length);
    route.hops.forEach((hop, index) => {
      assert.equal(hop.from, route.path[index]);
      assert.equal(hop.to, route.path[index + 1]);
      assert.equal(hop.url, edges.get(hop.from)?.get(hop.to), "every returned edge retains its original proof");
    });
  }
  assert.ok(admittedPairs > 0);
}

test("actual root chains expose every shortest directed union route, including internal targets", () => {
  const data = JSON.parse(readFileSync(new URL("../../data/chains.json", import.meta.url), "utf8"));
  assertShortestRoutesForAllPairs(data);
  const direct = savedRoutes.precomputedChain(data, "FredAlsup", "PianoSkater");
  assert.deepEqual(direct.path, ["fredalsup", "pianoskater"]);
  assert.equal(direct.length, 1);
  assert.equal(direct.hops[0].url, "https://www.chess.com/game/live/63496054537");
  assert.equal(savedRoutes.precomputedChain(data, "pianoskater", "fredalsup"), null);
});

test("union joins separate admitted chains and chooses fewer links rather than an existing longer suffix", () => {
  const data = { chains: [proofChain(["alpha", "longone", "longtwo", "omega"], 200),
    proofChain(["alpha", "bridge"], 210), proofChain(["elsewhere", "bridge", "omega"], 220)] };
  assertShortestRoutesForAllPairs(data);
  assert.deepEqual(savedRoutes.precomputedChain(data, "alpha", "omega").path, ["alpha", "bridge", "omega"]);
  assert.deepEqual(savedRoutes.bridgeSuffixesFor(data, "omega").get("alpha").path, ["alpha", "bridge", "omega"]);
});

test("equal length union ties are deterministic and preserve first admitted proof order", () => {
  const data = { chains: [proofChain(["alpha", "zulu", "omega"], 300),
    proofChain(["alpha", "beta", "omega"], 310)] };
  for (let count = 0; count < 3; count++) {
    const route = savedRoutes.precomputedChain(data, "alpha", "omega");
    assert.deepEqual(route.path, ["alpha", "zulu", "omega"]);
    assert.deepEqual(route.hops.map(hop => hop.url), data.chains[0].hops.map(hop => hop.url));
  }
});

test("rich proof metadata survives normalization without input or returned-route aliasing", () => {
  const rich = proofChain(["Alpha", "Bridge", "Omega"], 400);
  rich.hops[0].white = { username: "Alpha", rating: 2123 };
  rich.hops[0].time_control = "180+2";
  rich.hops[0].proof = { labels: ["verified", "public"] };
  const data = { chains: [rich] }, before = structuredClone(data);
  const route = savedRoutes.precomputedChain(data, "alpha", "omega");
  assert.deepEqual(route.hops[0].white, rich.hops[0].white);
  assert.deepEqual(route.hops[0].proof, rich.hops[0].proof);
  assert.equal(route.hops[0].time_control, "180+2");
  route.path[0] = "changed";
  route.hops[0].white.rating = 1;
  route.hops[0].proof.labels.push("changed");
  assert.deepEqual(data, before, "route mutations must never rewrite source proofs");
  const again = savedRoutes.precomputedChain(data, "alpha", "omega");
  assert.equal(again.path[0], "alpha");
  assert.equal(again.hops[0].white.rating, 2123);
  assert.deepEqual(again.hops[0].proof.labels, ["verified", "public"]);
  const suffixes = savedRoutes.bridgeSuffixesFor(data, "omega");
  suffixes.get("alpha").hops[1].url = "changed";
  assert.equal(suffixes.get("bridge").hops[0].url, rich.hops[1].url, "separate returned suffixes must not share hop objects");
});

test("one invalid edge excludes the WHOLE chain, including otherwise valid prefix edges", () => {
  const badProof = proofChain(["alpha", "bridge", "omega"], 500);
  badProof.hops[1].url += "?redirect=1";
  const mismatchedTarget = { ...proofChain(["alpha", "bridge"], 510), target: "someoneelse" };
  const cyclic = proofChain(["alpha", "bridge", "alpha", "omega"], 520);
  const badAlignment = proofChain(["alpha", "bridge", "omega"], 530);
  badAlignment.hops[1].from = "someoneelse";
  for (const invalid of [badProof, mismatchedTarget, cyclic, badAlignment, { ...badProof, found: false }]) {
    const data = { chains: [invalid, proofChain(["bridge", "safe"], 540)] };
    assert.equal(savedRoutes.precomputedChain(data, "alpha", "bridge"), null);
    assert.equal(savedRoutes.precomputedChain(data, "alpha", "safe"), null);
    assert.deepEqual(savedRoutes.precomputedChain(data, "bridge", "safe").path, ["bridge", "safe"]);
  }
});


test("duplicate union edges retain the first proof and internal targets use their own display", () => {
  const first = proofChain(["alpha", "bridge", "omega"], 600);
  first.display = "Omega display";
  const duplicate = proofChain(["alpha", "bridge", "omega"], 610);
  const data = { chains: [first, duplicate] };
  const internal = savedRoutes.precomputedChain(data, "alpha", "bridge");
  assert.equal(internal.display, "bridge");
  assert.equal(internal.hops[0].url, first.hops[0].url);
  assert.equal(savedRoutes.precomputedChain(data, "alpha", "omega").display, "Omega display");
});
