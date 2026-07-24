import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import worker, { __test } from "../src/index.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

class MemoryKV {
  constructor({ strictCacheTtl = false } = {}) {
    this.values = new Map();
    this.strictCacheTtl = strictCacheTtl;
  }

  async get(key, options) {
    if (this.strictCacheTtl &&
        Number(options?.cacheTtl || 0) > 0 &&
        Number(options.cacheTtl) < 30) {
      throw new Error("cacheTtl must be at least 30 seconds");
    }
    const value = this.values.get(key);
    if (value == null) return null;
    if (options === "json" || options?.type === "json") return JSON.parse(value);
    return value;
  }

  async put(key, value) {
    this.values.set(key, String(value));
  }

  async delete(key) {
    this.values.delete(key);
  }

  async list() {
    return { keys: [], cursor: "" };
  }
}

function response(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function searchJob(overrides = {}) {
  const now = Date.now();
  return __test.searchJobShape({
    id: "lease-test",
    start: "alpha",
    target: "omega",
    range: "auto",
    status: "running",
    stats: { fetched: 1, requests: 2, cached: 3, expanded: 4 },
    search: {
      ...__test.initialSearchState("alpha", "omega"),
      activeSide: "forward",
      activeFrontier: ["alpha", "beta"],
      activeCursor: 1,
    },
    createdAt: now - 100000,
    updatedAt: now - 100000,
    processingToken: "owner-token",
    processingUntil: now - 1000,
    ...overrides,
  });
}

test("username normalization accepts handles and profile URLs without inventing usernames", () => {
  assert.equal(__test.cleanUsername("  @Some_Player  "), "some_player");
  assert.equal(
    __test.cleanUsername("https://www.chess.com/member/Some-Player/?ref=share"),
    "some-player",
  );
  assert.equal(
    __test.cleanUsername("https://api.chess.com/pub/player/Some-Player/?ref=share"),
    "some-player",
  );
  assert.equal(__test.cleanUsername("Some Player"), "");
  assert.equal(__test.cleanUsername("https://example.com/member/some-player"), "");
});

test("lease recovery leaves a valid owner untouched", async () => {
  const kv = new MemoryKV();
  const env = { GAMES_CACHE: kv };
  const job = searchJob({ processingUntil: Date.now() + 60000 });
  await kv.put(`search:job:${job.id}`, JSON.stringify(job));

  const recovered = await __test.recoverStaleSearchLease(env, job.id, job);

  assert.equal(recovered.processingToken, "owner-token");
  assert.equal(recovered.search.activeCursor, 1);
  assert.equal(recovered.stats.expanded, 4);
});

test("stale lease recovery retries the same frontier instead of skipping nodes", async () => {
  const kv = new MemoryKV();
  const env = { GAMES_CACHE: kv };
  const job = searchJob();
  await kv.put(`search:job:${job.id}`, JSON.stringify(job));

  const recovered = await __test.recoverStaleSearchLease(env, job.id, job);

  assert.equal(recovered.processingToken, "");
  assert.equal(recovered.processingUntil, 0);
  assert.equal(recovered.search.activeCursor, 1);
  assert.deepEqual(recovered.search.activeFrontier, ["alpha", "beta"]);
  assert.equal(recovered.stats.expanded, 4);
});

test("transient edge failures keep the player pending instead of proving no connection", async () => {
  const kv = new MemoryKV();
  const env = { GAMES_CACHE: kv };
  globalThis.fetch = async () => response({ error: "temporary" }, 503);
  const search = __test.initialSearchState("alpha", "omega");
  const stats = { fetched: 0, requests: 0, cached: 0, expanded: 0 };

  const result = await __test.advanceServerSearch(
    env,
    { start: "alpha", target: "omega", range: "auto", refreshCached: false },
    search,
    stats,
    async () => {},
    { expansionBudget: 1, concurrency: 1, timeBudgetMs: 5000 },
  );

  assert.equal(result.status, "running");
  assert.equal(search.activeCursor, 0);
  assert.deepEqual(search.activeFrontier, ["alpha"]);
  assert.equal(stats.expanded, 0);
});

test("deferred searches preserve a bounded retry pause", () => {
  assert.equal(__test.searchPauseUntil(90000, 1000), 91000);
  assert.equal(__test.searchPauseUntil(999999, 1000), 301000);
  assert.equal(__test.searchPauseUntil(0, 1000), 0);
});

test("archive retrieval rejects transient monthly failures instead of caching partial games", async () => {
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    if (String(url).endsWith("/games/archives")) {
      return response({ archives: ["https://api.chess.com/pub/player/alpha/games/2026/07"] });
    }
    return response({ error: "temporary" }, 503);
  };

  await assert.rejects(
    __test.fetchGames({ username: "alpha", archiveLimit: 1 }),
    (error) => error?.status === 503,
  );
  assert.equal(calls, 4);
});

test("missing profiles return 404 while transient profile failures remain upstream errors", async () => {
  const env = { GAMES_CACHE: new MemoryKV() };
  globalThis.fetch = async () => response({ code: 0, message: "Not Found" }, 404);
  const missing = await worker.fetch(
    new Request("https://worker.test/profile?username=definitely-missing"),
    env,
    {},
  );
  assert.equal(missing.status, 404);

  globalThis.fetch = async () => response({ error: "temporary" }, 503);
  const unavailable = await worker.fetch(
    new Request("https://worker.test/profile?username=temporary-user"),
    env,
    {},
  );
  assert.equal(unavailable.status, 502);
});

test("search-start rate limits expose the JSON retry delay as Retry-After", async () => {
  const kv = new MemoryKV();
  await kv.put("search:ratelimit:unknown", JSON.stringify({
    startedAt: Date.now(),
    count: 48,
  }));
  const limited = await worker.fetch(
    new Request("https://worker.test/search/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        start: "alpha",
        target: "omega",
        searchId: "rate-limit-test",
      }),
    }),
    { GAMES_CACHE: kv },
    { waitUntil() {} },
  );
  const body = await limited.json();

  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Retry-After"), String(body.retryAfter));
  assert.ok(body.retryAfter >= 1);
});

test("health identifies the deployed reliability release", async () => {
  const result = await worker.fetch(
    new Request("https://worker.test/health"),
    { GAMES_CACHE: new MemoryKV() },
    {},
  );
  const body = await result.json();

  assert.equal(result.status, 200);
  assert.equal(body.release, "2026-07-24-random-search-v2");
});

test("unknown jobs return 404 with strict KV cache TTL rules", async () => {
  const result = await worker.fetch(
    new Request("https://worker.test/search/job?id=unknown-job"),
    { GAMES_CACHE: new MemoryKV({ strictCacheTtl: true }) },
    {},
  );

  assert.equal(result.status, 404);
  assert.equal((await result.json()).error, "job not found");
});

test("the shared Chess.com cooldown prevents another upstream request", async () => {
  const kv = new MemoryKV({ strictCacheTtl: true });
  await kv.put("games:ratelimit:chesscom", JSON.stringify({
    until: Date.now() + 60000,
  }));
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    return response({ games: [] });
  };

  const result = await worker.fetch(
    new Request("https://worker.test/games?key=alpha:recent:6"),
    { GAMES_CACHE: kv },
    {},
  );

  assert.equal(result.status, 429);
  assert.equal(fetches, 0);
});

test("client knownChain hints are not trusted or promoted", async () => {
  const kv = new MemoryKV();
  const result = await worker.fetch(
    new Request("https://worker.test/search/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        start: "alpha",
        target: "omega",
        searchId: "untrusted-known-chain",
        knownChain: {
          target: "omega",
          found: true,
          length: 1,
          path: ["alpha", "omega"],
          hops: [{
            from: "alpha",
            to: "omega",
            url: "https://www.chess.com/game/live/1",
          }],
        },
      }),
    }),
    { GAMES_CACHE: kv },
    {},
  );
  const body = await result.json();

  assert.equal(result.status, 202);
  assert.equal(body.job.status, "queued");
  assert.equal(body.job.chain, null);
  assert.equal(kv.values.has("search:pair:v2:alpha:omega:auto"), false);
});

test("client submissions without cached proof cannot poison route caches", async () => {
  const kv = new MemoryKV();
  globalThis.fetch = async () => response({ archives: [] });
  const result = await worker.fetch(
    new Request("https://worker.test/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        start: "alpha",
        target: "omega",
        length: 1,
        path: ["alpha", "omega"],
        hops: [{
          from: "alpha",
          to: "omega",
          url: "https://www.chess.com/game/live/1",
        }],
      }),
    }),
    { GAMES_CACHE: kv },
    {},
  );
  const body = await result.json();

  assert.equal(result.status, 202);
  assert.equal(body.skipped, true);
  assert.equal(kv.values.has("leaderboard:entries"), false);
  assert.equal(kv.values.has("search:pair:v2:alpha:omega:auto"), false);
});

test("all-history proof cannot leak into an auto-range submitted route", async () => {
  const kv = new MemoryKV();
  const oldGame = {
    white: "alpha",
    black: "omega",
    whiteResult: "win",
    blackResult: "resigned",
    url: "https://www.chess.com/game/live/2007",
    timeClass: "rapid",
    endTime: 1167609600,
  };
  await kv.put("games:alpha:all", JSON.stringify({
    schema: 2,
    ts: Date.now(),
    games: [oldGame],
  }));
  globalThis.fetch = async () => response({ archives: [] });
  const submit = (range) => worker.fetch(
    new Request("https://worker.test/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        start: "alpha",
        target: "omega",
        range,
        length: 0,
        path: ["alpha", "omega"],
        hops: [{
          from: "alpha",
          to: "omega",
          url: oldGame.url,
        }],
      }),
    }),
    { GAMES_CACHE: kv },
    {},
  );

  const auto = await submit("auto");
  assert.equal(auto.status, 202);
  assert.equal(kv.values.has("search:pair:v2:alpha:omega:auto"), false);

  const all = await submit("all");
  assert.equal(all.status, 200);
  assert.equal(kv.values.has("search:pair:v2:alpha:omega:all"), true);
});

test("caller-owned job ids cannot be reused for another pair", async () => {
  const kv = new MemoryKV();
  const startRequest = (start, target) => worker.fetch(
    new Request("https://worker.test/search/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        start,
        target,
        searchId: "fixed-pair-id",
      }),
    }),
    { GAMES_CACHE: kv },
    {},
  );

  assert.equal((await startRequest("alpha", "omega")).status, 202);
  const mismatch = await startRequest("beta", "theta");
  assert.equal(mismatch.status, 409);
});

test("saved routes stay active so the client can receive a shorter connection", async () => {
  const kv = new MemoryKV();
  await kv.put("search:pair:v2:alpha:omega:auto", JSON.stringify({
    start: "alpha",
    target: "omega",
    range: "auto",
    chain: {
      target: "omega",
      found: true,
      length: 2,
      path: ["alpha", "beta", "omega"],
      hops: [
        { from: "alpha", to: "beta", url: "https://www.chess.com/game/live/10" },
        { from: "beta", to: "omega", url: "https://www.chess.com/game/live/11" },
      ],
    },
    players: {},
    savedAt: Date.now(),
    checkedAt: Date.now(),
  }));

  const result = await worker.fetch(
    new Request("https://worker.test/search/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        start: "alpha",
        target: "omega",
        range: "auto",
        searchId: "shorter-route-check",
      }),
    }),
    { GAMES_CACHE: kv },
    {},
  );
  const body = await result.json();

  assert.equal(result.status, 202);
  assert.equal(body.job.status, "running");
  assert.equal(body.job.chain.found, true);
});

test("direct wins beat longer exact fast-lane routes", async () => {
  const kv = new MemoryKV();
  const now = Date.now();
  await kv.put("fastlane:v2:auto:omega", JSON.stringify({
    target: "omega",
    range: "auto",
    updatedAt: now,
    fragments: [{
      target: "omega",
      range: "auto",
      path: ["alpha", "beta", "omega"],
      hops: [
        { from: "alpha", to: "beta", url: "https://www.chess.com/game/live/10" },
        { from: "beta", to: "omega", url: "https://www.chess.com/game/live/11" },
      ],
      length: 2,
      savedAt: now,
    }],
  }));
  await kv.put("games:alpha:recent:6", JSON.stringify({
    schema: 2,
    ts: now,
    games: [{
      white: "alpha",
      black: "omega",
      whiteResult: "win",
      blackResult: "resigned",
      url: "https://www.chess.com/game/live/12",
      timeClass: "rapid",
      endTime: 2000000000,
    }],
  }));

  const result = await __test.tryFastLaneConnection(
    { GAMES_CACHE: kv },
    {
      start: "alpha",
      target: "omega",
      range: "auto",
      chain: null,
    },
    { fetched: 0, requests: 0, cached: 0, expanded: 0 },
  );

  assert.notEqual(result.source, "exact-fast-lane");
  assert.deepEqual(result.chain.path, ["alpha", "omega"]);
});

test("all-history analytics routes are isolated from instant searches", async () => {
  const kv = new MemoryKV();
  await kv.put("analytics:events", JSON.stringify([{
    id: "old-all-route",
    ts: Date.now(),
    outcome: "found",
    start: "alpha",
    target: "omega",
    range: "all",
    path: ["alpha", "omega"],
    hops: [{
      from: "alpha",
      to: "omega",
      url: "https://www.chess.com/game/live/1",
      endTime: 1167609600,
    }],
  }]));

  const result = await worker.fetch(
    new Request("https://worker.test/search/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        start: "alpha",
        target: "omega",
        range: "instant",
        searchId: "instant-range-isolation",
      }),
    }),
    { GAMES_CACHE: kv },
    {},
  );
  const body = await result.json();

  assert.equal(result.status, 202);
  assert.equal(body.job.status, "queued");
  assert.equal(body.job.chain, null);
});

test("legacy lossy edge caches cannot hide a bridge present in complete games", async () => {
  const kv = new MemoryKV();
  const alphaGames = Array.from({ length: 80 }, (_, index) => ({
    white: "alpha",
    black: `player${String(index).padStart(3, "0")}`,
    whiteResult: "win",
    blackResult: "checkmated",
    url: `https://www.chess.com/game/live/${index + 1}`,
    timeClass: "blitz",
    endTime: index + 1,
  }));
  alphaGames.push({
    white: "alpha",
    black: "beta",
    whiteResult: "win",
    blackResult: "resigned",
    url: "https://www.chess.com/game/live/1001",
    timeClass: "rapid",
    endTime: 1001,
  });
  const omegaGames = [{
    white: "beta",
    black: "omega",
    whiteResult: "win",
    blackResult: "resigned",
    url: "https://www.chess.com/game/live/1002",
    timeClass: "rapid",
    endTime: 1002,
  }];
  await kv.put("games:alpha:recent:6", JSON.stringify({
    schema: 2,
    ts: Date.now(),
    games: alphaGames,
  }));
  await kv.put("games:omega:recent:6", JSON.stringify({
    schema: 2,
    ts: Date.now(),
    games: omegaGames,
  }));
  await kv.put("edges:alpha:recent:6", JSON.stringify({
    schema: 1,
    ts: Date.now(),
    edges: {
      beatenByMe: alphaGames.slice(0, 80).map((game) => [game.black, [game.url]]),
      beatMe: [],
    },
  }));

  for (let run = 0; run < 2; run++) {
    const search = __test.initialSearchState("alpha", "omega");
    const stats = { fetched: 0, requests: 0, cached: 0, expanded: 0 };
    const result = await __test.advanceServerSearch(
      { GAMES_CACHE: kv },
      { start: "alpha", target: "omega", range: "auto", refreshCached: false },
      search,
      stats,
      async () => {},
      { expansionBudget: 8, concurrency: 1, timeBudgetMs: 5000 },
    );

    assert.equal(result.status, "found");
    assert.deepEqual(result.chain.path, ["alpha", "beta", "omega"]);
    assert.equal(stats.requests, 0);
  }
});

test("found search jobs preserve paths deeper than the former 12-node limit", () => {
  const path = ["alpha", ...Array.from({ length: 12 }, (_, index) => `node${index}`), "omega"];
  const hops = path.slice(0, -1).map((from, index) => ({
    from,
    to: path[index + 1],
    url: `https://www.chess.com/game/live/${2000 + index}`,
  }));
  const shaped = __test.searchJobShape({
    id: "deep-path",
    start: "alpha",
    target: "omega",
    range: "auto",
    status: "found",
    chain: {
      target: "omega",
      found: true,
      length: path.length - 1,
      path,
      hops,
    },
  });

  assert.equal(shaped.chain.path.length, path.length);
  assert.equal(shaped.chain.path.at(-1), "omega");
  assert.equal(shaped.chain.hops.length, hops.length);
});

test("deep verified routes survive submit and analytics normalization", async () => {
  const kv = new MemoryKV();
  const path = ["alpha", ...Array.from({ length: 12 }, (_, index) => `deep${index}`), "omega"];
  const hops = path.slice(0, -1).map((from, index) => ({
    from,
    to: path[index + 1],
    url: `https://www.chess.com/game/live/${3000 + index}`,
  }));
  for (const [index, hop] of hops.entries()) {
    await kv.put(`games:${hop.from}:recent:6`, JSON.stringify({
      schema: 2,
      ts: Date.now(),
      games: [{
        white: hop.from,
        black: hop.to,
        whiteResult: "win",
        blackResult: "resigned",
        url: hop.url,
        timeClass: "rapid",
        endTime: 2000000000 + index,
      }],
    }));
  }

  const submitted = await worker.fetch(
    new Request("https://worker.test/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        start: "alpha",
        target: "omega",
        range: "auto",
        length: path.length - 2,
        path,
        hops,
      }),
    }),
    { GAMES_CACHE: kv },
    {},
  );
  assert.equal(submitted.status, 200);
  const pair = JSON.parse(kv.values.get("search:pair:v2:alpha:omega:auto"));
  assert.equal(pair.chain.path.length, path.length);
  assert.equal(pair.chain.path.at(-1), "omega");

  const analytics = await worker.fetch(
    new Request("https://worker.test/analytics/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "deep-analytics-event",
        outcome: "found",
        start: "alpha",
        target: "omega",
        range: "auto",
        length: path.length - 2,
        steps: path.length - 1,
        path,
        hops,
      }),
    }),
    { GAMES_CACHE: kv },
    {},
  );
  assert.equal(analytics.status, 200);
  const events = JSON.parse(kv.values.get("analytics:events"));
  assert.equal(events[0].path.length, path.length);
  assert.equal(events[0].steps, path.length - 1);
});
