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
