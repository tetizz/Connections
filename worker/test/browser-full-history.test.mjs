import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../../site/engine.js", import.meta.url), "utf8");
const months = Array.from({ length: 7 }, (_, index) => `2026/${String(index + 1).padStart(2, "0")}`);
const archive = (username, month) => `https://api.chess.com/pub/player/${username}/games/${month}`;
const winningGame = {
  rules: "chess", time_class: "blitz", url: "https://www.chess.com/game/live/123456789",
  white: { username: "alpha", result: "win" }, black: { username: "omega", result: "resigned" },
};

function fixture({ options = {}, direct = true, failMonth = "", malformedMonth = "", malformedIndex = false } = {}) {
  const requested = [], logs = [], stored = [];
  const context = vm.createContext({
    window: {}, AbortController, setTimeout, clearTimeout, queueMicrotask, console,
    fetch: async raw => {
      const url = String(raw);
      requested.push(url);
      const username = new URL(url).pathname.split("/")[3];
      if (url.endsWith("/archives")) {
        return Response.json(malformedIndex ? {} : { archives: months.map(month => archive(username, month)) });
      }
      const month = url.slice(-7);
      if (month === failMonth) return Response.json({ error: "Unavailable" }, { status: 503 });
      if (month === malformedMonth) return Response.json({ error: "Unavailable archive" });
      return Response.json({ games: direct && username === "alpha" && month === months[0] ? [winningGame] : [] });
    },
  });
  vm.runInContext(source, context, { filename: "actual-browser-engine.js" });
  const cache = { get: async () => null, set: async (...args) => stored.push(args) };
  const engine = new context.window.ChessChain(cache, { maxRetries: 1, ...options });
  engine.onProgress = message => logs.push(message);
  return { engine, requested, logs, stored };
}

test("browser search reads all advertised months and finds an older direct win", async () => {
  const f = fixture();
  const result = await f.engine.findChain("alpha", "omega", 8);
  assert.deepEqual(Array.from(result.path), ["alpha", "omega"]);
  assert.ok(f.requested.includes(archive("alpha", months[0])));
  assert.equal(f.requested.filter(url => /\/games\/2026\/\d\d$/.test(url)).length, 7);
});

test("legacy recent-month options cannot silently downgrade a browser search", async () => {
  for (const archiveLimit of [2, 6]) {
    const f = fixture({ options: { archiveLimit } });
    const result = await f.engine.findChain("alpha", "omega", 8);
    assert.ok(result, "Every browser search must include the older available win");
    assert.deepEqual(Array.from(result.path), ["alpha", "omega"]);
    assert.equal(f.engine._cacheKey("ALPHA"), "alpha:all");
    assert.equal(f.engine._archiveLabel(), "full history");
    assert.ok(f.requested.includes(archive("alpha", months[0])));
  }
});

test("the local default does not stop at the former three-layer depth limit", async () => {
  const f = fixture();
  const path = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "omega"];
  f.engine.edges = async username => {
    const index = path.indexOf(username);
    return {
      beatenByMe: new Map(index < path.length - 1 ? [[path[index + 1], [`https://www.chess.com/game/live/${index + 100}`]]] : []),
      beatMe: new Map(index > 0 ? [[path[index - 1], [`https://www.chess.com/game/live/${index + 99}`]]] : []),
    };
  };
  const result = await f.engine.findChain("alpha", "omega");
  assert.deepEqual(Array.from(result.path), path);
  assert.equal(result.hops.length, 6);
});

test("an exhausted local search does not claim that no connection exists globally", async () => {
  const f = fixture({ direct: false });
  assert.equal(await f.engine.findChain("alpha", "omega", 8), null);
  assert.doesNotMatch(f.logs.join("\n"), /no connection exists|shortest possible|shortest verified/i);
  assert.match(f.logs.join("\n"), /no connection found in this search/i);
});

test("failed or malformed monthly archives never become cached complete histories", async () => {
  for (const failure of [{ failMonth: months[0] }, { malformedMonth: months[0] }]) {
    const f = fixture({ ...failure, direct: false });
    await assert.rejects(f.engine.findChain("alpha", "omega", 8), /Could not read 1 of 7 game archives/);
    assert.equal(f.engine._gamesCache.size, 0);
    assert.equal(f.engine._edgesCache.size, 0);
    assert.equal(f.stored.length, 0);
    assert.doesNotMatch(f.logs.join("\n"), /no connection found|no connection exists/i);
  }
});

test("a malformed archive index is not an empty game history", async () => {
  const f = fixture({ malformedIndex: true });
  await assert.rejects(f.engine.findChain("alpha", "omega", 8), /archive index/i);
  assert.equal(f.engine._gamesCache.size, 0);
  assert.equal(f.stored.length, 0);
});
