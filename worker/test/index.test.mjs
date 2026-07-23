import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import worker, { __test } from "../src/index.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

class MemoryKV {
  constructor() {
    this.values = new Map();
  }

  async get(key, options) {
    const value = this.values.get(key);
    if (value == null) return null;
    if (options === "json" || options?.type === "json") return JSON.parse(value);
    return value;
  }

  async put(key, value) {
    this.values.set(key, String(value));
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
