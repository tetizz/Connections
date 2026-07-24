import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import worker, { __test, SearchJobObject } from "../src/index.js";

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

  async list(options = {}) {
    const prefix = String(options.prefix || "");
    const limit = Math.max(1, Number(options.limit || 1000));
    const keys = [...this.values.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort()
      .slice(0, limit)
      .map((name) => ({ name }));
    return { keys, cursor: "", list_complete: true };
  }
}

class MemoryAlarmStorage {
  constructor() {
    this.values = new Map();
    this.alarms = [];
  }

  async get(key) {
    return this.values.get(key);
  }

  async put(key, value) {
    this.values.set(key, structuredClone(value));
  }

  async deleteAll() {
    this.values.clear();
  }

  async setAlarm(timestamp) {
    this.alarms.push(Number(timestamp));
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

test("a local chunk budget continues immediately instead of pretending Chess.com asked us to wait", async () => {
  const kv = new MemoryKV();
  const env = { GAMES_CACHE: kv };
  globalThis.fetch = async () => response({ archives: [] });
  const search = {
    ...__test.initialSearchState("alpha", "omega"),
    activeSide: "forward",
    activeFrontier: ["alpha", "beta", "gamma", "delta"],
    forwardFrontier: [],
  };
  const stats = { fetched: 0, requests: 0, cached: 0, expanded: 0 };

  const result = await __test.advanceServerSearch(
    env,
    { start: "alpha", target: "omega", range: "auto", refreshCached: false },
    search,
    stats,
    async () => {},
    { expansionBudget: 4, concurrency: 1, timeBudgetMs: 5000 },
  );

  assert.equal(result.status, "running");
  assert.equal(result.pauseMs, 0);
  assert.match(result.progress, /continuing/i);
  assert.equal(stats.requests, 3);
  assert.equal(stats.expanded, 3);
  assert.equal(search.activeCursor, 3);
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

test("a timed-out edge lookup aborts its archive fetch instead of overlapping a retry", async () => {
  let monthlyCalls = 0;
  let abortedCalls = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith("/games/archives")) {
      return response({
        archives: [
          "https://api.chess.com/pub/player/alpha/games/2026/05",
          "https://api.chess.com/pub/player/alpha/games/2026/06",
          "https://api.chess.com/pub/player/alpha/games/2026/07",
        ],
      });
    }
    monthlyCalls++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(response({ games: [] })), 250);
      options.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        abortedCalls++;
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    });
  };

  await assert.rejects(
    __test.withAbortTimeout(
      (signal) => __test.fetchGames({ username: "alpha", archiveLimit: 3, signal }),
      25,
    ),
    (error) => error?.name === "AbortError",
  );
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(monthlyCalls, 1);
  assert.equal(abortedCalls, 1);
});

test("hop enrichment never starts a live archive request", async () => {
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    throw new Error("hop enrichment must stay cache-only");
  };
  const hop = {
    from: "alpha",
    to: "omega",
    url: "https://www.chess.com/game/live/123",
  };

  const enriched = await __test.enrichHopsFromCache(
    { GAMES_CACHE: new MemoryKV() },
    [hop],
    6,
    { fetched: 0, requests: 0, cached: 0, expanded: 0 },
  );

  assert.equal(enriched.length, 1);
  assert.equal(enriched[0].from, hop.from);
  assert.equal(enriched[0].to, hop.to);
  assert.equal(enriched[0].url, hop.url);
  assert.equal(fetchCalls, 0);
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

test("health identifies the deployed continuous-search release", async () => {
  const result = await worker.fetch(
    new Request("https://worker.test/health"),
    { GAMES_CACHE: new MemoryKV() },
    {},
  );
  const body = await result.json();

  assert.equal(result.status, 200);
  assert.equal(body.release, "2026-07-24-continuous-search-v5");
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

test("a range-verified graph hint avoids a wide live crawl and remains an upper bound", async () => {
  const kv = new MemoryKV();
  const now = Date.now();
  const endTime = Math.floor(now / 1000) - 60;
  const proofMonth = new Date(endTime * 1000);
  const archiveUrl = (username) =>
    `https://api.chess.com/pub/player/${username}/games/${proofMonth.getUTCFullYear()}/` +
    `${String(proofMonth.getUTCMonth() + 1).padStart(2, "0")}`;
  await kv.put("games:alpha:recent:6", JSON.stringify({
    schema: 2,
    ts: now,
    games: [{
      white: "alpha",
      black: "connector",
      whiteResult: "win",
      blackResult: "resigned",
      url: "https://www.chess.com/game/live/100",
      timeClass: "rapid",
      endTime,
    }],
  }));
  await kv.put("graph:index:v2", JSON.stringify({
    version: 1,
    updatedAt: now,
    nodes: {
      connector: {
        w: [["middle", "https://www.chess.com/game/live/101"]],
        l: [],
        ts: now,
      },
      middle: {
        w: [["omega", "https://www.chess.com/game/live/102"]],
        l: [["connector", "https://www.chess.com/game/live/101"]],
        ts: now,
      },
      omega: {
        w: [],
        l: [["middle", "https://www.chess.com/game/live/102"]],
        ts: now,
      },
    },
  }));

  const requested = [];
  const proofPlayers = {
    101: ["connector", "middle"],
    102: ["middle", "omega"],
  };
  globalThis.fetch = async (url) => {
    const text = String(url);
    requested.push(text);
    if (text.endsWith("/games/archives")) {
      const username = text.split("/player/")[1].split("/games/")[0];
      return response({ archives: [archiveUrl(username)] });
    }
    const id = Number(text.split("/callback/live/game/")[1]);
    const [winner, loser] = proofPlayers[id] || [];
    assert.ok(winner && loser, text);
    return response({
      game: {
        id,
        isLiveGame: true,
        isFinished: true,
        type: "chess",
        colorOfWinner: "white",
        endTime,
        typeName: "Rapid",
        pgnHeaders: {
          White: winner,
          Black: loser,
          Result: "1-0",
        },
      },
      players: {
        top: { username: winner, color: "white", isComputer: false },
        bottom: { username: loser, color: "black", isComputer: false },
      },
    });
  };
  const stats = { fetched: 0, requests: 0, cached: 0, expanded: 0 };
  const result = await __test.tryFastLaneConnection(
    { GAMES_CACHE: kv },
    {
      start: "alpha",
      target: "omega",
      range: "auto",
      chain: null,
    },
    stats,
  );

  assert.equal(result.source, "verified-graph-hint");
  assert.deepEqual(result.chain.path, ["alpha", "connector", "middle", "omega"]);
  assert.equal(result.chain.hops.length, 3);
  assert.equal(stats.requests, 4);
  assert.equal(requested.length, 4);
  assert.ok(stats.requests <= 5, `expected <=5 proof requests, got ${stats.requests}`);
  assert.equal(__test.shouldKeepCheckingFastLane(result), true);
  assert.equal(__test.shouldKeepCheckingFastLane({
    source: result.source,
    chain: {
      path: ["alpha", "connector", "omega"],
      hops: result.chain.hops.slice(0, 2),
    },
  }), false);
});

test("a graph hint fails closed when an exact game proves the wrong winner", async () => {
  const kv = new MemoryKV();
  const now = Date.now();
  const endTime = Math.floor(now / 1000) - 60;
  const requested = [];
  await kv.put("graph:index:v2", JSON.stringify({
    version: 1,
    updatedAt: now,
    nodes: {
      connector: {
        w: [["middle", "https://www.chess.com/game/live/201"]],
        l: [],
        ts: now,
      },
      middle: {
        w: [["omega", "https://www.chess.com/game/live/202"]],
        l: [["connector", "https://www.chess.com/game/live/201"]],
        ts: now,
      },
      omega: {
        w: [],
        l: [["middle", "https://www.chess.com/game/live/202"]],
        ts: now,
      },
    },
  }));
  globalThis.fetch = async (url) => {
    const text = String(url);
    requested.push(text);
    if (text.endsWith("/games/archives")) {
      return response({
        archives: ["https://api.chess.com/pub/player/connector/games/2026/07"],
      });
    }
    const id = Number(text.split("/callback/live/game/")[1]);
    return response({
      game: {
        id,
        isLiveGame: true,
        isFinished: true,
        type: "chess",
        colorOfWinner: "black",
        endTime,
        typeName: "Rapid",
        pgnHeaders: { White: "connector", Black: "middle", Result: "0-1" },
      },
      players: {
        top: { username: "connector", color: "white", isComputer: false },
        bottom: { username: "middle", color: "black", isComputer: false },
      },
    });
  };

  const result = await __test.tryVerifiedGraphRouteHint(
    { GAMES_CACHE: kv },
    {
      job: { start: "alpha", target: "omega", range: "auto" },
      stats: { fetched: 0, requests: 0, cached: 0, expanded: 0 },
      startEdges: {
        beatenByMe: new Map([[
          "connector",
          ["https://www.chess.com/game/live/200"],
        ]]),
        beatMe: new Map(),
      },
      startGames: [],
      savedStepLimit: Number.POSITIVE_INFINITY,
    },
  );

  assert.equal(result, null);
  assert.equal(
    requested.some((url) => /\/games\/\d{4}\/\d{2}$/.test(url)),
    false,
    "a rejected graph hint must not fan out into monthly archive downloads",
  );
});

test("concurrent edge fills preserve the proof graph until one deterministic rebuild", async () => {
  const kv = new MemoryKV();
  const now = Date.now();
  const originalGraph = {
    version: 1,
    updatedAt: now,
    nodes: {
      warmed: {
        w: [["target", "https://www.chess.com/game/live/900"]],
        l: [],
        ts: now,
      },
    },
  };
  const edges = (opponent, gameId) => ({
    beatenByMe: new Map([[opponent, [`https://www.chess.com/game/live/${gameId}`]]]),
    beatMe: new Map(),
  });
  await kv.put("graph:index:v2", JSON.stringify(originalGraph));

  await Promise.all([
    __test.putEdgesCache(
      kv,
      "alpha:recent:6",
      { username: "alpha", archiveLimit: 6 },
      edges("alpha-recent", 901),
      now + 1,
    ),
    __test.putEdgesCache(
      kv,
      "beta:recent:2",
      { username: "beta", archiveLimit: 2 },
      edges("beta-recent", 902),
      now + 2,
    ),
    __test.putEdgesCache(
      kv,
      "beta:all",
      { username: "beta", archiveLimit: Number.POSITIVE_INFINITY },
      edges("beta-all", 903),
      now + 3,
    ),
  ]);

  assert.deepEqual(
    JSON.parse(await kv.get("graph:index:v2")),
    originalGraph,
    "independent live cache fills must not overwrite the scheduled graph snapshot",
  );

  const count = await __test.rebuildGraphIndex({ GAMES_CACHE: kv });
  const rebuilt = JSON.parse(await kv.get("graph:index:v2"));

  assert.equal(count, 2);
  assert.deepEqual(Object.keys(rebuilt.nodes).sort(), ["alpha", "beta"]);
  assert.deepEqual(rebuilt.nodes.alpha.w, [
    ["alpha-recent", "https://www.chess.com/game/live/901"],
  ]);
  assert.deepEqual(rebuilt.nodes.beta.w, [
    ["beta-all", "https://www.chess.com/game/live/903"],
  ]);
});

test("graph rebuild selection is not trapped in the first 900 lexicographic keys", () => {
  const edgeKeys = Array.from({ length: 900 }, (_, index) => ({
    name: `edges:a${String(index).padStart(4, "0")}:recent:6`,
  }));
  edgeKeys.push({
    name: "edges:hikaru:recent:2",
    metadata: { ts: Date.now() },
  });

  const plans = __test.selectGraphCachePlans(edgeKeys, []);

  assert.equal(plans.length, 900);
  assert.equal(plans.some((plan) => plan.username === "hikaru"), true);
});

test("a longer graph hint is skipped when a shorter verified lane is already loaded", async () => {
  const kv = new MemoryKV();
  const now = Date.now();
  await kv.put("fastlane:v2:auto:omega", JSON.stringify({
    target: "omega",
    range: "auto",
    updatedAt: now,
    fragments: [{
      target: "omega",
      range: "auto",
      path: ["alpha", "saved-one", "saved-two", "omega"],
      hops: [
        { from: "alpha", to: "saved-one", url: "https://www.chess.com/game/live/301" },
        { from: "saved-one", to: "saved-two", url: "https://www.chess.com/game/live/302" },
        { from: "saved-two", to: "omega", url: "https://www.chess.com/game/live/303" },
      ],
      length: 3,
      savedAt: now,
    }],
  }));
  await kv.put("games:alpha:recent:6", JSON.stringify({
    schema: 2,
    ts: now,
    games: [{
      white: "alpha",
      black: "connector",
      whiteResult: "win",
      blackResult: "resigned",
      url: "https://www.chess.com/game/live/310",
      timeClass: "rapid",
      endTime: Math.floor(now / 1000) - 60,
    }],
  }));
  await kv.put("graph:index:v2", JSON.stringify({
    version: 1,
    updatedAt: now,
    nodes: {
      connector: {
        w: [["middle-one", "https://www.chess.com/game/live/311"]],
        l: [],
        ts: now,
      },
      "middle-one": {
        w: [["middle-two", "https://www.chess.com/game/live/312"]],
        l: [["connector", "https://www.chess.com/game/live/311"]],
        ts: now,
      },
      "middle-two": {
        w: [["omega", "https://www.chess.com/game/live/313"]],
        l: [["middle-one", "https://www.chess.com/game/live/312"]],
        ts: now,
      },
      omega: {
        w: [],
        l: [["middle-two", "https://www.chess.com/game/live/313"]],
        ts: now,
      },
    },
  }));
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    throw new Error("a non-improving graph route must not be verified");
  };

  const result = await __test.tryFastLaneConnection(
    { GAMES_CACHE: kv },
    { start: "alpha", target: "omega", range: "auto", chain: null },
    { fetched: 0, requests: 0, cached: 0, expanded: 0 },
  );

  assert.deepEqual(result.chain.path, ["alpha", "saved-one", "saved-two", "omega"]);
  assert.equal(requests, 0);
});

test("exact live-game proofs verify winners without scanning monthly archives", async () => {
  const endTime = Math.floor(Date.now() / 1000) - 60;
  const month = new Date(endTime * 1000);
  const archiveUrl =
    `https://api.chess.com/pub/player/alpha/games/${month.getUTCFullYear()}/` +
    `${String(month.getUTCMonth() + 1).padStart(2, "0")}`;
  const requestedUrls = [];
  globalThis.fetch = async (url) => {
    requestedUrls.push(String(url));
    if (String(url).endsWith("/games/archives")) {
      return response({ archives: [archiveUrl] });
    }
    assert.equal(String(url), "https://www.chess.com/callback/live/game/123456");
    return response({
      game: {
        id: 123456,
        isLiveGame: true,
        isFinished: true,
        type: "chess",
        colorOfWinner: "black",
        endTime,
        typeName: "Rapid",
        pgnHeaders: {
          White: "Omega",
          Black: "Alpha",
          Result: "0-1",
          Opening: "Scotch Game",
        },
      },
      players: {
        top: { username: "Alpha", color: "black", isComputer: false },
        bottom: { username: "Omega", color: "white", isComputer: false },
      },
    });
  };
  const stats = { fetched: 0, requests: 0, cached: 0, expanded: 0 };

  const verified = await __test.verifyLiveGameProof({ GAMES_CACHE: new MemoryKV() }, {
    from: "alpha",
    to: "omega",
    url: "https://www.chess.com/game/live/123456",
  }, 6, stats);

  assert.deepEqual(verified, {
    from: "alpha",
    to: "omega",
    url: "https://www.chess.com/game/live/123456",
    timeClass: "rapid",
    endTime,
    result: "win",
    color: "black",
    opening: "Scotch Game",
  });
  assert.equal(stats.requests, 2);
  assert.equal(stats.fetched, 2);
  assert.equal(requestedUrls.some((url) => /\/games\/\d{4}\/\d{2}/.test(url)), false);
});

test("live-game proof verification rejects unsafe, losing, stale, and unfinished claims", async () => {
  const gameId = 123456;
  const basePayload = {
    game: {
      id: gameId,
      isLiveGame: true,
      isFinished: true,
      type: "chess",
      colorOfWinner: "white",
      endTime: Math.floor(Date.now() / 1000) - 60,
      typeName: "Blitz",
      pgnHeaders: {
        White: "omega",
        Black: "alpha",
        Result: "1-0",
      },
    },
    players: {
      top: { username: "alpha", color: "black", isComputer: false },
      bottom: { username: "omega", color: "white", isComputer: false },
    },
  };
  let payload = basePayload;
  globalThis.fetch = async () => response(payload);

  assert.equal(await __test.verifyLiveGameProof({ GAMES_CACHE: new MemoryKV() }, {
    from: "alpha",
    to: "omega",
    url: "https://evil.example/game/live/123456",
  }, 6), null);
  assert.equal(await __test.verifyLiveGameProof({ GAMES_CACHE: new MemoryKV() }, {
    from: "alpha",
    to: "omega",
    url: "https://www.chess.com/game/daily/123456",
  }, 6), null);
  assert.equal(await __test.verifyLiveGameProof({ GAMES_CACHE: new MemoryKV() }, {
    from: "alpha",
    to: "omega",
    url: "https://www.chess.com/game/live/123456",
  }, 6), null);

  payload = {
    ...basePayload,
    game: { ...basePayload.game, colorOfWinner: "black", isFinished: false },
  };
  assert.equal(await __test.verifyLiveGameProof({ GAMES_CACHE: new MemoryKV() }, {
    from: "alpha",
    to: "omega",
    url: "https://www.chess.com/game/live/123456",
  }, 6), null);

  payload = {
    ...basePayload,
    game: {
      ...basePayload.game,
      colorOfWinner: "black",
      endTime: 1167609600,
      pgnHeaders: {
        White: "omega",
        Black: "alpha",
        Result: "0-1",
      },
    },
  };
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/games/archives")) {
      return response({
        archives: ["https://api.chess.com/pub/player/alpha/games/2026/07"],
      });
    }
    return response(payload);
  };
  assert.equal(await __test.verifyLiveGameProof({ GAMES_CACHE: new MemoryKV() }, {
    from: "alpha",
    to: "omega",
    url: "https://www.chess.com/game/live/123456",
  }, 2), null);
});

test("live-game proof URL parsing cannot be used for outbound request forgery", async () => {
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return response({});
  };
  const unsafeUrls = [
    "http://www.chess.com/game/live/123456",
    "https://user@www.chess.com/game/live/123456",
    "https://www.chess.com:444/game/live/123456",
    "https://www.chess.com.evil.example/game/live/123456",
    "https://www.chess.com/callback/live/game/123456",
    "https://www.chess.com/game/daily/123456",
    "https://www.chess.com/game/live/123456/extra",
    "https://www.chess.com/game/live/123456?redirect=https://evil.example",
    "https://www.chess.com/game/live/123456#fragment",
    "https://www.chess.com/game/live/%2F123456",
    "https://www.chess.com/game/live/0",
    "https://www.chess.com/game/live/999999999999999999999999",
  ];

  for (const url of unsafeUrls) {
    assert.equal(await __test.verifyLiveGameProof({ GAMES_CACHE: new MemoryKV() }, {
      from: "alpha",
      to: "omega",
      url,
    }, Infinity), null, url);
  }
  assert.equal(requests, 0);
});

test("invalid exact-game responses fail closed and archive verification remains the fallback", async () => {
  const env = { GAMES_CACHE: new MemoryKV() };
  const proof = {
    from: "alpha",
    to: "omega",
    url: "https://www.chess.com/game/live/123456",
  };
  const basePayload = {
    game: {
      id: 123456,
      isLiveGame: true,
      isFinished: true,
      type: "chess",
      colorOfWinner: "black",
      endTime: Math.floor(Date.now() / 1000) - 60,
      typeName: "Rapid",
      pgnHeaders: { White: "omega", Black: "alpha", Result: "0-1" },
    },
    players: {
      top: { username: "alpha", color: "black", isComputer: false },
      bottom: { username: "omega", color: "white", isComputer: false },
    },
  };
  const invalidPayloads = [
    { ...basePayload, game: { ...basePayload.game, id: 999999 } },
    { ...basePayload, game: { ...basePayload.game, type: "chess960" } },
    { ...basePayload, game: { ...basePayload.game, pgnHeaders: undefined } },
    {
      ...basePayload,
      game: {
        ...basePayload.game,
        pgnHeaders: { White: "omega", Black: "alpha" },
      },
    },
    {
      ...basePayload,
      players: {
        ...basePayload.players,
        top: { ...basePayload.players.top, isComputer: true },
      },
    },
    {
      ...basePayload,
      players: {
        top: { username: "alpha", color: "black" },
        bottom: { username: "omega", color: "white", isComputer: false },
      },
    },
    {
      ...basePayload,
      game: {
        ...basePayload.game,
        pgnHeaders: { White: "alpha", Black: "omega", Result: "0-1" },
      },
    },
  ];
  for (const payload of invalidPayloads) {
    globalThis.fetch = async () => response(payload);
    assert.equal(
      await __test.verifyLiveGameProof({ GAMES_CACHE: new MemoryKV() }, proof, Infinity),
      null,
    );
  }
  globalThis.fetch = async () => new Response("x".repeat(256001), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  assert.equal(
    await __test.verifyLiveGameProof({ GAMES_CACHE: new MemoryKV() }, proof, Infinity),
    null,
  );

  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    if (String(url).includes("/callback/live/game/")) {
      return response({ error: "unavailable" }, 503);
    }
    if (String(url).endsWith("/games/archives")) {
      return response({
        archives: ["https://api.chess.com/pub/player/alpha/games/2026/07"],
      });
    }
    return response({
      games: [{
        rules: "chess",
        white: { username: "omega", result: "resigned" },
        black: { username: "alpha", result: "win" },
        url: proof.url,
        time_class: "rapid",
        end_time: Math.floor(Date.now() / 1000) - 60,
      }],
    });
  };
  const verified = await __test.verifyPathHops(
    env,
    ["alpha", "omega"],
    6,
    { fetched: 0, requests: 0, cached: 0, expanded: 0 },
    { proofHops: [proof] },
  );
  assert.deepEqual(verified.map((hop) => [hop.from, hop.to]), [["alpha", "omega"]]);
  assert.equal(requested.some((url) => url.includes("/callback/live/game/")), true);
  assert.equal(requested.some((url) => /\/games\/\d{4}\/\d{2}/.test(url)), true);
});

test("submit rate limiting happens before any supplied proof fetch", async () => {
  const kv = new MemoryKV();
  await kv.put("leaderboard:ratelimit:unknown", JSON.stringify({
    startedAt: Date.now(),
    count: 30,
  }));
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return response({});
  };

  const submitted = await worker.fetch(
    new Request("https://worker.test/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        start: "alpha",
        target: "omega",
        range: "auto",
        length: 0,
        path: ["alpha", "omega"],
        hops: [{
          from: "alpha",
          to: "omega",
          url: "https://www.chess.com/game/live/123456",
        }],
      }),
    }),
    { GAMES_CACHE: kv },
    {},
  );

  assert.equal(submitted.status, 429);
  assert.equal(requests, 0);
});

test("legacy pair routes are selected for verified background migration", async () => {
  const kv = new MemoryKV();
  const now = Date.now();
  await kv.put("search:pair:alpha:magnuscarlsen:auto", JSON.stringify({
    start: "alpha",
    target: "magnuscarlsen",
    range: "auto",
    chain: {
      target: "magnuscarlsen",
      found: true,
      length: 1,
      path: ["alpha", "magnuscarlsen"],
      hops: [{
        from: "alpha",
        to: "magnuscarlsen",
        url: "https://www.chess.com/game/live/123456",
      }],
    },
    savedAt: now,
  }));

  const routes = await __test.legacyPairWarmRoutes({ GAMES_CACHE: kv });

  assert.equal(routes.length, 1);
  assert.equal(routes[0].source, "legacy-pair");
  assert.deepEqual(routes[0].path, ["alpha", "magnuscarlsen"]);
  assert.equal(routes[0].hops[0].url, "https://www.chess.com/game/live/123456");
});

test("unverified analytics shortcuts cannot suppress legacy warm candidates", async () => {
  const kv = new MemoryKV();
  const now = Date.now();
  await kv.put("search:pair:alpha:magnuscarlsen:auto", JSON.stringify({
    start: "alpha",
    target: "magnuscarlsen",
    range: "auto",
    chain: {
      target: "magnuscarlsen",
      found: true,
      length: 2,
      path: ["alpha", "beta", "magnuscarlsen"],
      hops: [
        {
          from: "alpha",
          to: "beta",
          url: "https://www.chess.com/game/live/123456",
        },
        {
          from: "beta",
          to: "magnuscarlsen",
          url: "https://www.chess.com/game/live/123457",
        },
      ],
    },
    savedAt: now,
  }));
  await kv.put("analytics:events", JSON.stringify([{
    id: "unverified-shortcut",
    ts: now + 1,
    outcome: "found",
    start: "alpha",
    target: "magnuscarlsen",
    range: "auto",
    path: ["alpha", "magnuscarlsen"],
    hops: [{
      from: "alpha",
      to: "magnuscarlsen",
      url: "https://www.chess.com/game/live/999999",
    }],
  }]));

  const routes = (await __test.warmVerificationRoutes({ GAMES_CACHE: kv }))
    .filter((route) => route.start === "alpha" && route.target === "magnuscarlsen");

  assert.equal(routes.length, 2);
  assert.equal(routes[0].source, "legacy-pair");
  assert.equal(routes[1].source, "analytics");
  assert.deepEqual(routes[0].path, ["alpha", "beta", "magnuscarlsen"]);
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

test("background search drains consecutive local chunks without a browser poll", async () => {
  const kv = new MemoryKV();
  const env = { GAMES_CACHE: kv };
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => response({ archives: [] });

  try {
    const running = searchJob({
      id: "background-drain",
      status: "running",
      stats: { fetched: 0, requests: 0, cached: 0, expanded: 0 },
      search: {
        ...__test.initialSearchState("alpha", "omega"),
        profileChecked: true,
        fastLaneChecked: true,
        activeSide: "forward",
        activeFrontier: ["alpha", "beta", "gamma", "delta"],
        activeCursor: 0,
        activeNextFrontier: [],
        forwardFrontier: [],
        backwardFrontier: [],
      },
      processingToken: "",
      processingUntil: 0,
    });

    await kv.put(`search:job:${running.id}`, JSON.stringify(running));
    await __test.runSearchJob(env, running);

    const finished = JSON.parse(await kv.get(`search:job:${running.id}`));
    assert.equal(finished.status, "not_found");
    assert.equal(finished.stats.requests, 4);
    assert.equal(finished.stats.expanded, 4);
    assert.doesNotMatch(finished.progress, /waiting/i);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a Durable Object alarm resumes an active search without a browser poll", async () => {
  const storage = new MemoryAlarmStorage();
  const kv = new MemoryKV();
  const object = new SearchJobObject({ storage }, { GAMES_CACHE: kv });
  const running = searchJob({
    id: "alarm-resume",
    status: "running",
    stats: { fetched: 0, requests: 0, cached: 0, expanded: 0 },
    search: {
      ...__test.initialSearchState("alpha", "omega"),
      profileChecked: true,
      fastLaneChecked: true,
      activeSide: "forward",
      activeFrontier: ["alpha", "beta", "gamma", "delta"],
      activeCursor: 0,
      activeNextFrontier: [],
      forwardFrontier: [],
      backwardFrontier: [],
    },
    processingToken: "",
    processingUntil: 0,
  });

  globalThis.fetch = async () => response({ archives: [] });
  await object.writeJob(running);
  storage.alarms.length = 0;
  await object.alarm();

  const finished = await object.readJob();
  assert.equal(finished.status, "not_found");
  assert.equal(finished.stats.requests, 4);
  assert.equal(finished.stats.expanded, 4);
  assert.ok(storage.alarms.some((timestamp) => timestamp > Date.now() + 60_000));
});

test("a real retry pause schedules a Durable Object wake-up instead of waiting for a poll", async () => {
  const storage = new MemoryAlarmStorage();
  const object = new SearchJobObject({ storage }, { GAMES_CACHE: new MemoryKV() });
  const pauseUntil = Date.now() + 45_000;
  const paused = searchJob({
    id: "alarm-pause",
    status: "running",
    processingToken: "",
    processingUntil: pauseUntil,
  });

  await object.writeJob(paused);
  assert.equal(storage.alarms.at(-1), pauseUntil);

  await object.alarm();
  const stillPaused = await object.readJob();
  assert.equal(stillPaused.status, "running");
  assert.equal(stillPaused.processingUntil, pauseUntil);
  assert.equal(storage.alarms.at(-1), pauseUntil);
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
