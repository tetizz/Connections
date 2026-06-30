/**
 * Chess Connections Cloudflare Worker
 * -----------------------------------
 * - GET /games?key=username:recent:N caches sanitized Chess.com game rows.
 * - POST /search/start starts a resumable server-side chain search job.
 * - GET /search/job?id=... returns job progress or the final chain.
 * - POST /search/warm prefetches top Chess.com targets and fast-lane route fragments.
 * - POST /share stores a short shareable result; GET /share?id=... reads it.
 * - POST /submit stores found chains for the global leaderboard.
 * - GET /leaderboard ranks middle players by how often they connect chains.
 * - GET /suggest?query=name returns cached username suggestions.
 */

const CHESS_API = "https://api.chess.com/pub/player/";
const TTL_SECONDS = 7 * 24 * 60 * 60;
const PROFILE_TTL_SECONDS = 7 * 24 * 60 * 60;
const KV_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const MAX_LEADERBOARD_ENTRIES = 1000;
const MAX_SUGGESTIONS = 10;
const TITLED_GROUPS = ["GM", "IM", "FM", "NM", "WGM", "WIM", "WFM", "CM", "WCM"];
const ARCHIVE_CONCURRENCY = 4;
const SUBMIT_WINDOW_SECONDS = 60;
const MAX_SUBMITS_PER_WINDOW = 30;
const MAX_ANALYTICS_EVENTS = 120;
const MAX_ANALYTICS_LIMIT = 50;
const MAX_ANALYTICS_EVENTS_PER_WINDOW = 80;
const ANALYTICS_EVENTS_KEY = "analytics:events";
const CHESS_RATE_LIMIT_KEY = "games:ratelimit:chesscom";
const GRAPH_INDEX_KEY = "graph:index:v1";
const GRAPH_INDEX_NODE_LIMIT = 900;
const GRAPH_INDEX_EDGE_LIMIT = 24;
const GRAPH_INDEX_WARM_KEY_LIMIT = 900;
const GRAPH_BRIDGE_CONNECTOR_LIMIT = 120;
const SEARCH_MAX_DEPTH = 1000000;
const SEARCH_MAX_EXPANSIONS = Number.MAX_SAFE_INTEGER;
const SEARCH_FRONTIER_LIMIT = 1000;
const SEARCH_CHUNK_EXPANSIONS = 512;
const SEARCH_CHUNK_TIME_MS = 5000;
const SEARCH_EXPANSION_CONCURRENCY = 64;
const SEARCH_BACKGROUND_TIME_MS = 120000;
const SEARCH_LEASE_MS = 10000;
const SEARCH_VISITED_LIMIT = 8000;
const SEARCH_NEXT_FRONTIER_LIMIT = 800;
const SEARCH_CACHE_EDGE_LOOKUP_TIMEOUT_MS = 350;
const SEARCH_FRESH_EDGE_LOOKUP_TIMEOUT_MS = 2500;
const SEARCH_FRESH_EDGE_REQUEST_LIMIT = 80;
const SEARCH_FRESH_EDGE_REQUESTS_PER_CHUNK = 12;
const SEARCH_EDGE_MAP_LIMIT = 80;
const EDGE_CACHE_MAX_BYTES = 45000;
const GAME_CACHE_SEARCH_MAX_BYTES = 250000;
const CACHED_SHORTER_CHECK_REQUESTS = 12;
const CACHED_SHORTER_CHECK_EXPANSIONS = 96;
const CACHED_SHORTER_CHECK_CHUNK_EXPANSIONS = 24;
const CACHED_SHORTER_CHECK_CONCURRENCY = 16;
const CACHED_SHORTER_CHECK_TIME_MS = 4500;
const VISIBLE_SHORTER_CHECK_MIN_STEPS = 4;
const STARTUP_CACHE_BFS_EXPANSIONS = 600;
const STARTUP_CACHE_BFS_TIME_MS = 1600;
const STARTUP_CACHE_BFS_FRONTIER_LIMIT = 500;
const PAIR_CHAIN_TTL_SECONDS = 30 * 24 * 60 * 60;
const START_NO_WINS_TTL_SECONDS = 30 * 60;
const SHARE_TTL_SECONDS = 90 * 24 * 60 * 60;
const SHARE_ID_LENGTH = 8;
const SEARCH_JOB_TTL_SECONDS = 2 * 60 * 60;
const SEARCH_PUBLIC_JOB_TTL_SECONDS = SEARCH_JOB_TTL_SECONDS;
const SEARCH_DURABLE_READ_TIMEOUT_MS = 700;
const SEARCH_DURABLE_WRITE_TIMEOUT_MS = 2500;
const SEARCH_WINDOW_SECONDS = 60;
const MAX_SEARCH_JOBS_PER_WINDOW = 48;
const WARM_STATUS_KEY = "warm:leaderboard-targets";
const WARM_INTERVAL_SECONDS = 6 * 60 * 60;
const WARM_PLAYER_LIMIT = 36;
const WARM_ROUTE_LIMIT = 500;
const WARM_VERIFY_ROUTE_LIMIT = 12;
const WARM_VERIFY_TIME_MS = 22000;
const FAST_LANE_FRAGMENT_LIMIT = 200;
const START_LANE_FRAGMENT_LIMIT = 300;
const COMMON_WARM_TARGETS = ["magnuscarlsen", "hikaru", "danielnaroditsky", "fabianocaruana", "gothamchess"];
const BLOCKED_USERNAMES = new Set([String.fromCharCode(108, 111, 117, 105, 115, 95, 102, 108, 111, 121, 100)]);
const RATE_LIMIT_COOLDOWN_SECONDS = 90;
const FETCH_RETRIES = 2;
const FETCH_BACKOFF_MS = 450;
const FETCH_TIMEOUT_MS = 7000;
const SEARCH_STALE_LEASE_MS = 6000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Accept, Content-Type, X-Owner-Code",
};

export class SearchJobObject {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    let body = {};
    if (request.method !== "GET") {
      try {
        body = await request.json();
      } catch {
        body = {};
      }
    }
    if (url.pathname === "/read") {
      return json({ job: searchJobShape(await this.state.storage.get("job")) }, 200, "no-store");
    }
    if (url.pathname === "/write") {
      const shaped = searchJobShape(body.job);
      if (!shaped) return json({ error: "invalid job" }, 400, "no-store");
      await this.state.storage.put("job", shaped);
      return json({ job: shaped }, 200, "no-store");
    }
    if (url.pathname === "/update") {
      const current = searchJobShape(await this.state.storage.get("job"));
      if (!current) return json({ job: null }, 200, "no-store");
      const next = searchJobShape({
        ...current,
        ...(body.patch || {}),
        stats: body.patch?.stats || current.stats,
        updatedAt: Date.now(),
      });
      if (!next) return json({ job: null }, 200, "no-store");
      await this.state.storage.put("job", next);
      return json({ job: next }, 200, "no-store");
    }
    if (url.pathname === "/claim") {
      const current = searchJobShape(await this.state.storage.get("job"));
      if (!current || !isActiveSearchStatus(current.status)) return json({ job: null }, 200, "no-store");
      const token = cleanAnalyticsId(body.token);
      if (!token) return json({ job: current }, 200, "no-store");
      if (Number(current.processingUntil || 0) > Date.now() && current.processingToken !== token) {
        return json({ job: current }, 200, "no-store");
      }
      const next = searchJobShape({
        ...current,
        status: "running",
        processingToken: token,
        processingUntil: Date.now() + Math.max(1000, Number(body.leaseMs) || SEARCH_LEASE_MS),
        updatedAt: Date.now(),
      });
      await this.state.storage.put("job", next);
      return json({ job: next }, 200, "no-store");
    }
    if (url.pathname === "/update-owned") {
      const current = searchJobShape(await this.state.storage.get("job"));
      const token = cleanAnalyticsId(body.token);
      if (!current || current.processingToken !== token) return json({ job: null }, 200, "no-store");
      const patch = body.patch || {};
      const next = searchJobShape({
        ...current,
        ...patch,
        processingToken: patch.processingToken ?? token,
        stats: patch.stats || current.stats,
        updatedAt: Date.now(),
      });
      if (!next) return json({ job: null }, 200, "no-store");
      await this.state.storage.put("job", next);
      return json({ job: next }, 200, "no-store");
    }
    return json({ error: "not found" }, 404, "no-store");
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, service: "connections-cache", ts: Date.now() });
    }

    if (url.pathname === "/games" && request.method === "GET") {
      return handleGames(url, env);
    }

    if (url.pathname === "/leaderboard" && request.method === "GET") {
      return handleLeaderboard(url, env);
    }

    if (url.pathname === "/profile" && request.method === "GET") {
      return handleProfile(url, env);
    }

    if (url.pathname === "/suggest" && request.method === "GET") {
      return handleSuggest(url, env);
    }

    if (url.pathname === "/search/start" && request.method === "POST") {
      return handleSearchStart(request, env, ctx);
    }

    if (url.pathname === "/search/job" && request.method === "GET") {
      return handleSearchJob(url, env, ctx);
    }

    if (url.pathname === "/search/warm" && (request.method === "GET" || request.method === "POST")) {
      return handleWarm(url, request, env, ctx);
    }

    if (url.pathname === "/share" && request.method === "POST") {
      return handleShareCreate(request, env);
    }

    if (url.pathname === "/share" && request.method === "GET") {
      return handleShareRead(url, env);
    }

    if (url.pathname === "/submit" && request.method === "POST") {
      return handleSubmit(request, env);
    }

    if (url.pathname === "/analytics/event" && request.method === "POST") {
      return handleAnalyticsEvent(request, env);
    }

    if (url.pathname === "/analytics" && request.method === "GET") {
      return handleAnalytics(url, request, env);
    }

    return json({ error: "not found" }, 404);
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(warmLeaderboardTargets(env).catch((error) => {
      console.warn(JSON.stringify({
        event: "scheduled_warm_failed",
        scheduledTime: controller?.scheduledTime || Date.now(),
        message: error?.message || String(error),
      }));
    }));
  },
};

async function handleGames(url, env) {
  const key = url.searchParams.get("key") || "";
  const parsed = parseGameCacheKey(key);
  if (!parsed) return json({ error: "Invalid cache key" }, 400);

  const kvKey = `games:${key.toLowerCase()}`;
  const cached = await env.GAMES_CACHE.get(kvKey, { type: "json", cacheTtl: 60 });
  const cachedGames = Array.isArray(cached?.games) ? cached.games : null;
  const cachedAt = Number.isFinite(cached?.ts) ? cached.ts : 0;
  const cacheAge = Date.now() - cachedAt;

  if (cachedGames && cacheAge < TTL_SECONDS * 1000) {
    return json({ source: "cloudflare-kv", key, games: cached.games });
  }

  const activeLimit = await readRateLimit(env.GAMES_CACHE);
  if (activeLimit && cachedGames) {
    return staleGames(key, cachedGames, activeLimit.retryAfter);
  }
  if (activeLimit) {
    return rateLimited(key, activeLimit.retryAfter);
  }

  try {
    const games = await fetchGames(parsed);
    await putGamesCache(env.GAMES_CACHE, kvKey, parsed, games);
    return json({ source: "chess.com", key, games });
  } catch (error) {
    if (isRateLimitError(error)) {
      const retryAfter = await rememberRateLimit(env.GAMES_CACHE, error.retryAfter);
      if (cachedGames) return staleGames(key, cachedGames, retryAfter);
      return rateLimited(key, retryAfter);
    }

    console.warn(JSON.stringify({
      event: "games_upstream_error",
      key,
      message: error?.message || String(error),
    }));
    if (cachedGames) return staleGames(key, cachedGames, 60, "upstream-error");
    return json({
      error: "Chess.com is unavailable right now. Try again shortly.",
      key,
    }, 502, "no-store");
  }
}

async function handleLeaderboard(url, env) {
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);
  const category = cleanLeaderboardCategory(url.searchParams.get("category"));
  const chains = normalizeEntries(await env.GAMES_CACHE.get("leaderboard:entries", "json") || []);
  const events = normalizeAnalyticsEvents(await env.GAMES_CACHE.get(ANALYTICS_EVENTS_KEY, "json") || []);
  const entries = leaderboardForCategory(category, chains, events);
  return json({
    category,
    entries: entries.slice(0, limit),
    total: entries.length,
    chainTotal: chains.length,
  }, 200, "no-store");
}

async function handleProfile(url, env) {
  const username = cleanUsername(url.searchParams.get("username"));
  if (!username) return json({ error: "Invalid username" }, 400);
  if (isBlockedUsername(username)) return json({ error: "Profile unavailable" }, 404, "no-store");

  const kvKey = `profile:${username}`;
  const cached = await env.GAMES_CACHE.get(kvKey, { type: "json", cacheTtl: 60 });
  const cachedProfile = cached?.profile && typeof cached.profile === "object"
    ? cached.profile
    : null;
  const cachedAt = Number.isFinite(cached?.ts) ? cached.ts : 0;

  if (cachedProfile && cachedProfile.stats && Array.isArray(cachedProfile.recentGames) &&
      Date.now() - cachedAt < PROFILE_TTL_SECONDS * 1000) {
    return json({ source: "cloudflare-kv", profile: cachedProfile });
  }

  try {
    const profile = await fetchProfileDetails(username, env);
    await env.GAMES_CACHE.put(kvKey, JSON.stringify({ ts: Date.now(), profile }), {
      expirationTtl: KV_RETENTION_SECONDS,
      metadata: { username, type: "profile" },
    });
    return json({ source: "chess.com", profile });
  } catch (error) {
    console.warn(JSON.stringify({
      event: "profile_upstream_error",
      username,
      message: error?.message || String(error),
    }));
    if (cachedProfile) {
      return json({ source: "cloudflare-kv-stale", profile: cachedProfile, stale: true }, 200, "public, max-age=60");
    }
    return json({
      error: "Chess.com profile is unavailable right now.",
      username,
    }, 502, "no-store");
  }
}

async function handleSuggest(url, env) {
  const query = cleanPartialUsername(url.searchParams.get("query"));
  const parsedLimit = parseInt(url.searchParams.get("limit") || "6", 10);
  const limit = Math.max(1, Math.min(MAX_SUGGESTIONS, Number.isFinite(parsedLimit) ? parsedLimit : 6));
  if (query.length < 2) {
    return json({ query, suggestions: [] }, 200, "public, max-age=30");
  }

  const seen = new Map();
  const add = (profile, source = "cloudflare") => {
    const suggestion = suggestionShape(profile, source);
    if (isBlockedUsername(suggestion?.username)) return;
    if (!suggestion || !matchesSuggestion(suggestion, query)) return;
    const existing = seen.get(suggestion.username);
    if (!existing || suggestionScore(suggestion, query) > suggestionScore(existing, query)) {
      seen.set(suggestion.username, suggestion);
    }
  };

  const entries = normalizeEntries(await env.GAMES_CACHE.get("leaderboard:entries", "json") || []);
  for (const entry of entries) {
    for (const username of entry.path || []) {
      if (seen.size >= limit * 3) break;
      if (username.includes(query)) add({ username }, "recent chain");
    }
  }

  await addProfilesFromKV(env, query, seen, limit * 3);
  await addLeaderboardSuggestions(query, seen, limit * 3);
  await addTitledSuggestions(env, query, seen, limit * 4);

  const missingProfiles = [...seen.values()]
    .filter((item) => !item.avatar && !item.name && !item.profileComplete)
    .slice(0, limit);
  await runThrottled(missingProfiles.map((item) => async () => {
    const profile = await readOrFetchProfile(env, item.username);
    if (profile) add(profile, item.source || "cloudflare");
  }), 2);

  if (query.length >= 3 && !seen.has(query)) {
    const exact = await readOrFetchProfile(env, query);
    if (exact && !isBlockedUsername(query)) add(exact, "exact match");
  }

  const suggestions = [...seen.values()]
    .filter((item) => matchesSuggestion(item, query))
    .filter((item) => !isBlockedUsername(item.username))
    .sort((a, b) => suggestionScore(b, query) - suggestionScore(a, query) || a.username.localeCompare(b.username))
    .slice(0, limit);

  return json({ query, suggestions }, 200, "public, max-age=45");
}

async function handleSearchStart(request, env, ctx) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rateLimitKey = `search:ratelimit:${ip}`;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }

  const start = cleanUsername(body?.start);
  const target = cleanUsername(body?.target);
  const range = cleanRange(body?.range) || "auto";
  const id = cleanAnalyticsId(body?.searchId || body?.jobId || body?.id) || crypto.randomUUID();
  if (!start || !target || start === target) return json({ error: "missing fields" }, 400);

  const existing = await readSearchJob(env, id);
  if (existing && !["expired", "failed"].includes(existing.status)) {
    return json({ ok: true, job: publicSearchJob(existing), reused: true }, 200, "no-store");
  }

  const requestPair = pairChainShape({
    start,
    target,
    range,
    chain: body?.knownChain,
    players: body?.knownPlayers || {},
    savedAt: Date.now(),
    checkedAt: null,
  }, start, target, range);

  const [storedPair, graphIndexPair, analyticsPair] = await Promise.all([
    readPairChain(env, start, target, range).catch(() => null),
    readGraphIndexPair(env, start, target, range).catch(() => null),
    readExactAnalyticsPair(env, start, target, range).catch(() => null),
  ]);
  const cachedPair = bestPairChain([
    storedPair,
    graphIndexPair,
    analyticsPair,
    requestPair,
  ]);
  const promoteCachedPair = promoteStartupCachedPairs(env, {
    id,
    start,
    target,
    range,
    storedPair,
    requestPair,
    cachedPair,
  }).catch((error) => {
    console.warn(JSON.stringify({
      event: "startup_pair_promotion_failed",
      start,
      target,
      message: error?.message || String(error),
    }));
  });
  if (ctx?.waitUntil) ctx.waitUntil(promoteCachedPair);
  else await promoteCachedPair;
  if (!cachedPair) {
    const submitWindow = await readSubmitWindow(env.GAMES_CACHE, rateLimitKey);
    if (submitWindow.count >= MAX_SEARCH_JOBS_PER_WINDOW) {
      return json({
        error: "too many searches, wait a moment",
        retryAfter: Math.max(1, SEARCH_WINDOW_SECONDS - Math.floor((Date.now() - submitWindow.startedAt) / 1000)),
      }, 429, "no-store");
    }
    await env.GAMES_CACHE.put(rateLimitKey, JSON.stringify({
      startedAt: submitWindow.startedAt,
      count: submitWindow.count + 1,
    }), { expirationTtl: SEARCH_WINDOW_SECONDS * 2 });
  }

  const shouldRefreshCachedPair = Boolean(
    cachedPair?.chain?.found &&
    chainStepCount(cachedPair.chain) >= VISIBLE_SHORTER_CHECK_MIN_STEPS
  );
  const job = searchJobShape({
    id,
    start,
    target,
    range,
    status: cachedPair ? "found" : "queued",
    progress: cachedPair
      ? "Loaded saved connection instantly."
      : "Queued",
    stats: { fetched: 0, requests: 0, cached: 0, expanded: 0 },
    chain: cachedPair?.chain,
    players: cachedPair?.players || {},
    refreshCached: Boolean(cachedPair),
    cachedAt: cachedPair?.savedAt || null,
    search: initialSearchState(start, target),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await writeSearchJob(env, job);
  if (ctx?.waitUntil && cachedPair && shouldRefreshCachedPair) {
    ctx.waitUntil(refreshCachedPairInBackground(env, job).catch((error) => {
      console.warn(JSON.stringify({
        event: "cached_pair_refresh_failed",
        jobId: job.id,
        start: job.start,
        target: job.target,
        message: error?.message || String(error),
      }));
    }));
  } else if (ctx?.waitUntil && cachedPair) {
    ctx.waitUntil(refreshCachedPairInBackground(env, job).catch((error) => {
      console.warn(JSON.stringify({
        event: "cached_pair_refresh_failed",
        jobId: job.id,
        start: job.start,
        target: job.target,
        message: error?.message || String(error),
      }));
    }));
  } else if (!cachedPair && ctx?.waitUntil) {
    ctx.waitUntil(kickSearchJobChunk(env, job.id).catch((error) => {
      console.warn(JSON.stringify({
        event: "search_start_background_failed",
        jobId: job.id,
        start: job.start,
        target: job.target,
        message: error?.message || String(error),
      }));
    }));
  }

  return json({ ok: true, job: publicSearchJob(job) }, 202, "no-store");
}

async function tryStartupFastLane(env, { id, start, target, range }) {
  const startedAt = Date.now();
  const stats = { fetched: 0, requests: 0, cached: 0, expanded: 0 };
  const job = searchJobShape({
    id,
    start,
    target,
    range,
    status: "running",
    progress: "Checking fast lanes.",
    stats,
    search: initialSearchState(start, target),
    createdAt: startedAt,
    updatedAt: startedAt,
  });
  if (!job) return null;

  const fastLane = await tryCachedRouteLanes(env, job, stats, Number.POSITIVE_INFINITY);
  const base = {
    ...job,
    stats,
    processingUntil: 0,
    processingToken: "",
    startedAt,
    durationMs: Date.now() - startedAt,
    updatedAt: Date.now(),
  };
  if (fastLane?.notFound) {
    return {
      job: searchJobShape({
        ...base,
        status: "not_found",
        outcome: "not_found",
        progress: fastLane.progress || "No connection found in this search.",
      }),
    };
  }
  if (!fastLane?.chain?.path?.length) return null;

  const targetProfile = await readOrFetchProfile(env, target).catch(() => null);
  const chain = {
    target,
    display: targetProfile?.name || targetProfile?.username || target,
    found: true,
    length: Math.max(0, fastLane.chain.path.length - 1),
    path: fastLane.chain.path,
    hops: cleanHopList(fastLane.chain.hops),
    quality: routeQuality(fastLane.chain, stats, fastLane.source || "startup-fast-lane"),
  };
  return {
    job: searchJobShape({
      ...base,
      status: "found",
      outcome: "found",
      progress: fastLane.source === "direct-recent-win" || fastLane.source === "direct-cached-win"
        ? `Found a direct win from ${start} to ${target}.`
        : `Found ${start} to ${target} through a warmed route.`,
      chain,
      players: targetProfile ? { [target]: targetProfile } : {},
    }),
  };
}

function bestPairChain(candidates) {
  let best = null;
  for (const candidate of candidates || []) {
    if (!candidate?.chain?.found) continue;
    if (!best || isPairShorterThan(candidate, best) || isPairFresherTie(candidate, best)) {
      best = candidate;
    }
  }
  return best;
}

function isPairShorterThan(candidate, current) {
  const candidateSteps = chainStepCount(candidate?.chain);
  const currentSteps = chainStepCount(current?.chain);
  if (!Number.isFinite(candidateSteps)) return false;
  if (!Number.isFinite(currentSteps)) return true;
  return candidateSteps < currentSteps;
}

function isPairFresherTie(candidate, current) {
  const candidateSteps = chainStepCount(candidate?.chain);
  const currentSteps = chainStepCount(current?.chain);
  if (!Number.isFinite(candidateSteps) || candidateSteps !== currentSteps) return false;
  const candidateTs = Number(candidate?.checkedAt || candidate?.savedAt || 0);
  const currentTs = Number(current?.checkedAt || current?.savedAt || 0);
  return candidateTs > currentTs;
}

async function promoteStartupCachedPairs(env, pairs) {
  const {
    id,
    start,
    target,
    range,
    storedPair,
    requestPair,
    cachedPair,
  } = pairs;
  if (!cachedPair?.chain?.found) return;
  if (storedPair?.chain?.found && !isPairShorterThan(cachedPair, storedPair)) return;
  await writeStartupPair(env, {
    id,
    start,
    target,
    range,
    pair: cachedPair,
    cached: cachedPair === requestPair ? 0 : 2,
    fragments: cachedPair !== requestPair,
  });
}

async function writeStartupPair(env, { id, start, target, range, pair, cached = 0, fragments = false }) {
  if (!pair?.chain?.found) return;
  const job = {
    id,
    start,
    target,
    range,
    status: "found",
    chain: pair.chain,
    players: pair.players || {},
    stats: { fetched: 0, requests: 0, cached, expanded: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await writePairChain(env, job);
  if (fragments) await writeFastLaneFragments(env, job);
}

async function handleSearchJob(url, env, ctx) {
  const id = cleanAnalyticsId(url.searchParams.get("id"));
  if (!id) return json({ error: "missing id" }, 400, "no-store");
  const minExpanded = cleanNonNegativeNumber(url.searchParams.get("minExpanded"), SEARCH_MAX_EXPANSIONS) || 0;
  const minCached = cleanNonNegativeNumber(url.searchParams.get("minCached"), 100000) || 0;
  try {
    let job = await readSearchJob(env, id);
    if (!job) {
      const publicJob = await readPublicSearchJob(env, id);
      if (publicJob) {
        if (ctx?.waitUntil && isActiveSearchStatus(publicJob.status)) {
          ctx.waitUntil(kickSearchJobChunk(env, id).catch((error) => {
            console.warn(JSON.stringify({
              event: "public_search_poll_kick_failed",
              jobId: id,
              message: error?.message || String(error),
            }));
          }));
        }
        return json({ ok: true, job: publicJob }, 200, "no-store");
      }
      return json({ error: "job not found" }, 404, "no-store");
    }
    if (isStaleForClient(job, minExpanded, minCached)) {
      job = await readSearchJobAtLeast(env, id, minExpanded, minCached) || job;
    }
    job = await recoverStaleSearchLease(env, id, job) || job;
    if (isActiveSearchStatus(job.status) &&
        Date.now() >= Number(job.processingUntil || 0)) {
      if (ctx?.waitUntil) {
        ctx.waitUntil(kickSearchJobChunk(env, id).catch((error) => {
          console.warn(JSON.stringify({
            event: "search_poll_kick_failed",
            jobId: id,
            message: error?.message || String(error),
          }));
        }));
        return json({ ok: true, job: publicSearchJob(job) }, 200, "no-store");
      }
      job = await kickSearchJobChunk(env, id) || await readSearchJob(env, id) || job;
    }
    return json({ ok: true, job: publicSearchJob(job) }, 200, "no-store");
  } catch (error) {
    console.warn(JSON.stringify({
      event: "search_job_poll_failed",
      jobId: id,
      message: error?.message || String(error),
    }));
    const publicJob = await readPublicSearchJob(env, id).catch(() => null);
    if (publicJob) return json({ ok: true, job: publicJob, warning: "snapshot" }, 200, "no-store");
    const kvJob = await env.GAMES_CACHE.get(`search:job:${id}`, { type: "json" })
      .then((record) => publicSearchJob(searchJobShape(record)))
      .catch(() => null);
    if (kvJob) return json({ ok: true, job: kvJob, warning: "kv-snapshot" }, 200, "no-store");
    return json({
      ok: true,
      warning: "pending-snapshot",
      job: {
        id,
        start: "",
        target: "",
        range: "auto",
        status: "running",
        outcome: "started",
        progress: "Search is still running.",
        error: "",
        stats: { fetched: 0, requests: 0, cached: minCached, expanded: minExpanded },
        chain: null,
        players: {},
        refreshCached: false,
        cachedAt: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        durationMs: null,
        quality: null,
      },
    }, 200, "no-store");
  }
}

async function recoverStaleSearchLease(env, id, job) {
  if (!job || !isActiveSearchStatus(job.status)) return job;
  const processingUntil = Number(job.processingUntil || 0);
  const updatedAt = Number(job.updatedAt || job.createdAt || 0);
  if (updatedAt && Date.now() - updatedAt < SEARCH_STALE_LEASE_MS) return job;
  const search = searchStateShape(job.search, job.start, job.target);
  const stats = { ...(job.stats || {}) };
  let progress = job.progress || "Resuming search.";
  if (search.activeSide && search.activeCursor >= search.activeFrontier.length) {
    const next = uniqueUsernameList(search.activeNextFrontier, SEARCH_NEXT_FRONTIER_LIMIT);
    if (search.activeSide === "forward") search.forwardFrontier = next;
    if (search.activeSide === "backward") search.backwardFrontier = next;
    search.activeSide = "";
    search.activeFrontier = [];
    search.activeCursor = 0;
    search.activeNextFrontier = [];
    search.bestMeeting = "";
    search.bestMeetingLength = 0;
    search.depth += 1;
    const candidates = Object.keys(search.forwardVisited || {}).length + Object.keys(search.backwardVisited || {}).length;
    progress = `Checked ${stats.expanded || 0} players, ${candidates} candidates`;
  } else if (search.activeSide && search.activeCursor < search.activeFrontier.length) {
    const skipped = Math.min(
      SEARCH_CHUNK_EXPANSIONS,
      search.activeFrontier.length - search.activeCursor,
    );
    search.activeCursor += skipped;
    stats.expanded = Number(stats.expanded || 0) + skipped;
  }
  return updateSearchJob(env, id, {
    processingUntil: 0,
    processingToken: "",
    stats,
    search,
    progress,
  });
}

async function kickSearchJobChunk(env, id) {
  const job = await readSearchJob(env, id);
  if (!job || !isActiveSearchStatus(job.status)) return job;
  const cachedShorterCheck = Boolean(job.refreshCached && job.chain?.found);
  return runSearchJobChunk(env, id, {
    expansionBudget: cachedShorterCheck ? CACHED_SHORTER_CHECK_CHUNK_EXPANSIONS : SEARCH_CHUNK_EXPANSIONS,
    timeBudgetMs: cachedShorterCheck ? CACHED_SHORTER_CHECK_TIME_MS : SEARCH_CHUNK_TIME_MS,
    concurrency: cachedShorterCheck ? CACHED_SHORTER_CHECK_CONCURRENCY : SEARCH_EXPANSION_CONCURRENCY,
  });
}

async function readSearchJobAtLeast(env, id, minExpanded, minCached) {
  let best = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const job = await readSearchJob(env, id);
    if (job && (!best || Number(job.stats?.expanded || 0) > Number(best.stats?.expanded || 0))) best = job;
    if (!isStaleForClient(job, minExpanded, minCached)) return job;
    await delay(180);
  }
  return best;
}

function isStaleForClient(job, minExpanded, minCached) {
  if (!job || !isActiveSearchStatus(job.status)) return false;
  const stats = job.stats || {};
  return Number(stats.expanded || 0) < minExpanded || Number(stats.cached || 0) < minCached;
}

async function runSearchJob(env, queuedJob) {
  const deadline = Date.now() + SEARCH_BACKGROUND_TIME_MS;
  let job = await readSearchJob(env, queuedJob.id);
  while (job && isActiveSearchStatus(job.status) && Date.now() < deadline) {
    const cachedShorterCheck = Boolean(job.refreshCached && job.chain?.found);
    const nextJob = await runSearchJobChunk(env, queuedJob.id, {
      expansionBudget: cachedShorterCheck ? CACHED_SHORTER_CHECK_CHUNK_EXPANSIONS : SEARCH_CHUNK_EXPANSIONS,
      timeBudgetMs: cachedShorterCheck ? CACHED_SHORTER_CHECK_TIME_MS : SEARCH_CHUNK_TIME_MS,
      concurrency: cachedShorterCheck ? CACHED_SHORTER_CHECK_CONCURRENCY : SEARCH_EXPANSION_CONCURRENCY,
    });
    if (!nextJob || Number(nextJob.processingUntil || 0) > Date.now()) break;
    job = nextJob;
  }
}

async function refreshCachedPairInBackground(env, cachedJob) {
  const shaped = searchJobShape(cachedJob);
  if (!shaped?.chain?.found || !shouldRunShorterBfs(shaped)) return;
  const search = initialSearchState(shaped.start, shaped.target);
  search.profileChecked = true;
  search.fastLaneChecked = true;
  const refreshJob = searchJobShape({
    ...shaped,
    id: cleanAnalyticsId(`refresh-${shaped.id}`) || crypto.randomUUID(),
    status: "running",
    progress: "Checking cached graph for a shorter route.",
    stats: { fetched: 0, requests: 0, cached: 0, expanded: 0 },
    search,
    refreshCached: true,
    processingUntil: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  if (!refreshJob) return;
  await writeSearchJob(env, refreshJob);
  let job = refreshJob;
  while (job && isActiveSearchStatus(job.status) && Number(job.stats?.expanded || 0) < CACHED_SHORTER_CHECK_EXPANSIONS) {
    job = await runSearchJobChunk(env, refreshJob.id, {
      expansionBudget: CACHED_SHORTER_CHECK_CHUNK_EXPANSIONS,
      timeBudgetMs: CACHED_SHORTER_CHECK_TIME_MS,
      concurrency: CACHED_SHORTER_CHECK_CONCURRENCY,
    }) || await readSearchJob(env, refreshJob.id);
  }
}

async function runSearchJobChunk(env, id, options = {}) {
  const expansionBudget = Math.max(1, Math.min(SEARCH_CHUNK_EXPANSIONS, Number(options.expansionBudget) || SEARCH_CHUNK_EXPANSIONS));
  const timeBudgetMs = Math.max(1000, Math.min(SEARCH_CHUNK_TIME_MS, Number(options.timeBudgetMs) || SEARCH_CHUNK_TIME_MS));
  const ownerToken = cleanAnalyticsId(options.ownerToken) || crypto.randomUUID();
  let job = await readSearchJob(env, id);
  if (!job || !isActiveSearchStatus(job.status)) return job;
  if (Number(job.processingUntil || 0) > Date.now()) return job;
  job = await claimSearchJob(env, id, ownerToken, SEARCH_LEASE_MS);
  if (!job || job.processingToken !== ownerToken) return job;

  const startedAt = job.startedAt || Date.now();
  const stats = job.searchInitialized
    ? { ...(job.stats || {}) }
    : { fetched: 0, requests: 0, cached: 0, expanded: 0 };
  const search = searchStateShape(job.search, job.start, job.target);
  const progress = async (message, patch = {}) => {
    const nextJob = await updateOwnedSearchJob(env, id, ownerToken, {
      status: "running",
      progress: message,
      startedAt,
      processingUntil: Date.now() + SEARCH_LEASE_MS,
      stats: { ...stats },
      search,
      ...patch,
    });
    if (!nextJob) throw new Error("search lease lost");
    job = nextJob;
  };

  await progress(job.progress || "Checking players");
  try {
    if (!search.profileChecked) {
      const [startProfile, targetProfile] = await Promise.all([
        readOrFetchProfile(env, job.start),
        readOrFetchProfile(env, job.target),
      ]);
      if (!startProfile || !targetProfile) {
        await completeSearchJob(env, job, {
          status: "not_found",
          outcome: "not_found",
          progress: "One of those players could not be found.",
          stats,
          search,
          processingUntil: 0,
          processingToken: "",
          durationMs: Date.now() - startedAt,
        }, ownerToken);
        return readSearchJob(env, id);
      }
      search.profileChecked = true;
      await progress("Searching recent wins");
    }

    if (!search.fastLaneChecked) {
      const fastLane = await tryFastLaneConnection(env, job, stats);
      search.fastLaneChecked = true;
      if (fastLane?.notFound) {
        await completeSearchJob(env, job, {
          status: "not_found",
          outcome: "not_found",
          progress: fastLane.progress || "No connection found in this search.",
          stats,
          search,
          processingUntil: 0,
          processingToken: "",
          durationMs: Date.now() - startedAt,
        }, ownerToken);
        return readSearchJob(env, id);
      }
      if (fastLane?.chain) {
        const cachedChain = job.chain?.found ? job.chain : null;
        const fastLaneIsShorter = !cachedChain || chainStepCount(fastLane.chain) < chainStepCount(cachedChain);
        if (!fastLaneIsShorter) {
          if (!shouldRunShorterBfs(job)) {
            await completeSearchJob(env, job, {
              status: "found",
              outcome: "found",
              progress: "Saved connection is still the best route found.",
              chain: cachedChain,
              players: job.players || {},
              stats,
              search,
              processingUntil: 0,
              processingToken: "",
              durationMs: Date.now() - startedAt,
            }, ownerToken);
            return readSearchJob(env, id);
          }
        } else {
        const players = {};
        await runThrottled(fastLane.chain.path.map((username) => async () => {
          const profile = await readOrFetchProfile(env, username);
          if (profile) players[username] = profile;
        }), 3);
        const targetProfile = players[job.target] || await readOrFetchProfile(env, job.target) || {};
        const chain = {
          target: job.target,
          display: targetProfile.name || targetProfile.username || job.target,
          found: true,
          length: Math.max(0, fastLane.chain.path.length - 1),
          path: fastLane.chain.path,
          hops: fastLane.chain.hops,
          quality: routeQuality(fastLane.chain, stats, fastLane.source),
        };
        await completeSearchJob(env, job, {
          status: "found",
          outcome: "found",
          progress: fastLane.source === "direct-recent-win"
            ? `Found a direct recent win from ${job.start} to ${job.target}.`
            : `Found ${job.start} to ${job.target} through a warmed route.`,
          chain,
          players,
          stats,
          search,
          processingUntil: 0,
          processingToken: "",
          durationMs: Date.now() - startedAt,
        }, ownerToken);
        return readSearchJob(env, id);
        }
      }
      if (job.chain?.found) {
        if (!shouldRunShorterBfs(job)) {
          await completeSearchJob(env, job, {
            status: "found",
            outcome: "found",
            progress: "Saved connection is still the best route found.",
            chain: job.chain,
            players: job.players || {},
            stats,
            search,
            processingUntil: 0,
            processingToken: "",
            durationMs: Date.now() - startedAt,
          }, ownerToken);
          return readSearchJob(env, id);
        }
        await progress("Saved route loaded. Searching wider graph for a shorter route.", { search });
      } else {
        await progress("Fast lanes checked. Searching wider graph.", { search });
      }
    }

    const result = await advanceServerSearch(env, job, search, stats, progress, {
      expansionBudget,
      timeBudgetMs,
      concurrency: Number(options.concurrency) || SEARCH_EXPANSION_CONCURRENCY,
      chunkStartedAt: Date.now(),
    });

    if (result?.status === "running") {
      if (job.chain?.found && job.refreshCached && Number(stats.expanded || 0) >= CACHED_SHORTER_CHECK_EXPANSIONS) {
        await completeSearchJob(env, job, {
          status: "found",
          outcome: "found",
          progress: "Saved connection is still the best route found.",
          chain: job.chain,
          players: job.players || {},
          stats,
          search,
          processingUntil: 0,
          processingToken: "",
          durationMs: Date.now() - startedAt,
        }, ownerToken);
        return readSearchJob(env, id);
      }
      return updateOwnedSearchJob(env, id, ownerToken, {
        status: "running",
        progress: result.progress,
        stats,
        search,
        processingUntil: 0,
        processingToken: "",
        startedAt,
      });
    }

    if (result?.status === "timeout") {
      await completeSearchJob(env, job, {
        status: "timeout",
        outcome: "timeout",
        progress: result.progress || "Search reached the automatic limit before proving a connection.",
        stats,
        search,
        processingUntil: 0,
        processingToken: "",
        durationMs: Date.now() - startedAt,
      }, ownerToken);
      return readSearchJob(env, id);
    }

    if (!result || result.status === "not_found") {
      if (job.chain?.found) {
        await completeSearchJob(env, job, {
          status: "found",
          outcome: "found",
          progress: "Saved connection is still the best route found.",
          chain: job.chain,
          players: job.players || {},
          stats,
          search,
          processingUntil: 0,
          processingToken: "",
          durationMs: Date.now() - startedAt,
        }, ownerToken);
        return readSearchJob(env, id);
      }
      await completeSearchJob(env, job, {
        status: "not_found",
        outcome: "not_found",
        progress: result?.progress || "No connection found in this search.",
        stats,
        search,
        processingUntil: 0,
        processingToken: "",
        durationMs: Date.now() - startedAt,
      }, ownerToken);
      return readSearchJob(env, id);
    }

    const chainResult = result.chain;
    if (!chainResult) {
      await completeSearchJob(env, job, {
        status: "not_found",
        outcome: "not_found",
        progress: "No connection found in this search.",
        stats,
        search,
        processingUntil: 0,
        processingToken: "",
        durationMs: Date.now() - startedAt,
      }, ownerToken);
      return readSearchJob(env, id);
    }

    const players = {};
    await runThrottled(chainResult.path.map((username) => async () => {
      const profile = await readOrFetchProfile(env, username);
      if (profile) players[username] = profile;
    }), 3);
    const targetProfile = players[job.target] || await readOrFetchProfile(env, job.target) || {};

    const cachedChain = job.chain?.found ? job.chain : null;
    const chain = {
      target: job.target,
      display: targetProfile.name || targetProfile.username || job.target,
      found: true,
      length: Math.max(0, chainResult.path.length - 1),
      path: chainResult.path,
      hops: await enrichHopsFromCache(env, chainResult.hops, archiveLimitForRange(job.range), stats),
    };
    chain.quality = routeQuality(chain, stats, cachedChain ? "shorter-check" : "fresh-search");
    const useCached = cachedChain && chainStepCount(cachedChain) <= chainStepCount(chain);
    const finalChain = useCached ? cachedChain : chain;
    const finalPlayers = useCached ? { ...players, ...(job.players || {}) } : { ...(job.players || {}), ...players };

    await completeSearchJob(env, job, {
      status: "found",
      outcome: "found",
      progress: useCached
        ? "Saved connection is still the best route found."
        : cachedChain
          ? `Found a shorter connection for ${job.start} to ${job.target}.`
          : `Found ${job.start} to ${job.target}.`,
      chain: finalChain,
      players: finalPlayers,
      stats,
      search,
      processingUntil: 0,
      processingToken: "",
      durationMs: Date.now() - startedAt,
    }, ownerToken);
    return readSearchJob(env, id);
  } catch (error) {
    if (error?.message === "search lease lost") return readSearchJob(env, id);
    await failSearchJob(env, id, error, ownerToken);
    return readSearchJob(env, id);
  }
}

function shouldRunShorterBfs(job) {
  if (!job?.refreshCached || !job.chain?.found) return false;
  const savedSteps = chainStepCount(job.chain);
  return Number.isFinite(savedSteps) && savedSteps > 2;
}

async function advanceServerSearch(env, job, search, stats, progress, options = {}) {
  const archiveLimit = archiveLimitForRange(job.range);
  const expansionBudget = Math.max(1, Number(options.expansionBudget) || SEARCH_CHUNK_EXPANSIONS);
  const expansionConcurrency = Math.max(1, Math.min(SEARCH_EXPANSION_CONCURRENCY, Number(options.concurrency) || SEARCH_EXPANSION_CONCURRENCY));
  const chunkStartedAt = Number(options.chunkStartedAt) || Date.now();
  const deadline = chunkStartedAt + (Number(options.timeBudgetMs) || SEARCH_CHUNK_TIME_MS);
  const forwardVisited = visitedObjectToMap(search.forwardVisited);
  const backwardVisited = visitedObjectToMap(search.backwardVisited);
  const edgesCache = new Map();
  let processed = 0;
  let freshRequestsThisChunk = 0;
  let meeting = cleanUsername(search.bestMeeting);
  let meetingLength = meeting ? cleanNonNegativeNumber(search.bestMeetingLength, SEARCH_MAX_DEPTH * 2 + 2) || Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY;

  const syncSearch = () => {
    search.forwardVisited = visitedMapToObject(forwardVisited);
    search.backwardVisited = visitedMapToObject(backwardVisited);
    search.bestMeeting = meeting || "";
    search.bestMeetingLength = Number.isFinite(meetingLength) ? meetingLength : 0;
  };
  const totalVisited = () => forwardVisited.size + backwardVisited.size;
  const considerMeeting = (candidate) => {
    const cleanCandidate = cleanUsername(candidate);
    if (!cleanCandidate) return;
    const chain = reconstructServerPath(cleanCandidate, forwardVisited, backwardVisited);
    const steps = chain?.path?.length ? chain.path.length - 1 : Number.POSITIVE_INFINITY;
    if (steps < meetingLength) {
      meeting = cleanCandidate;
      meetingLength = steps;
    }
  };
  const getEdges = async (username) => {
    const key = username.toLowerCase();
    if (edgesCache.has(key)) return edgesCache.get(key);
    const cachedShorterCheck = Boolean(job.refreshCached && job.chain?.found);
    const refreshArchiveLimit = cachedShorterCheck
      ? Math.min(2, Number.isFinite(archiveLimit) ? archiveLimit : 2)
      : archiveLimit;
    const mayRefreshKnownRoute = cachedShorterCheck &&
      Number(stats.requests || 0) < CACHED_SHORTER_CHECK_REQUESTS &&
      (key === job.start || key === job.target);
    let edges = null;
    if (mayRefreshKnownRoute) {
      edges = await readOrFetchEdges(env, { username: key, archiveLimit: refreshArchiveLimit, forceFresh: true }, stats);
    } else {
      const cached = await readCachedExpansionEdges(env, { username: key, archiveLimit }, stats);
      edges = cached.edges;
      const canFetchFresh =
        !cachedShorterCheck &&
        cached.source === "miss" &&
        freshRequestsThisChunk < SEARCH_FRESH_EDGE_REQUESTS_PER_CHUNK &&
        Number(stats.requests || 0) < SEARCH_FRESH_EDGE_REQUEST_LIMIT;
      if (canFetchFresh) {
        freshRequestsThisChunk++;
        try {
          edges = await readOrFetchEdges(env, { username: key, archiveLimit }, stats);
        } catch (error) {
          if (!isRateLimitError(error) && !isMissingArchivesError(error)) throw error;
        }
      }
    }
    if (!edges) edges = { beatenByMe: new Map(), beatMe: new Map() };
    edgesCache.set(key, edges);
    return edges;
  };
  const beginLayer = async () => {
    const forwardCount = search.forwardFrontier.length;
    const backwardCount = search.backwardFrontier.length;
    if (!forwardCount && !backwardCount) return false;
    const expandForward = forwardCount > 0 && (!backwardCount || forwardCount <= backwardCount);
    const side = expandForward ? "forward" : "backward";
    const source = expandForward ? search.forwardFrontier : search.backwardFrontier;
    const selected = uniqueUsernameList(source, SEARCH_FRONTIER_LIMIT);
    if (!selected.length) return false;

    search.activeSide = side;
    search.activeFrontier = selected;
    search.activeCursor = 0;
    search.activeNextFrontier = [];
    if (side === "forward") search.forwardFrontier = [];
    else search.backwardFrontier = [];

    syncSearch();
    await progress(`Step ${search.depth + 1}: checking ${selected.length} players`, { depth: search.depth });
    return true;
  };
  const finishLayer = async () => {
    const next = uniqueUsernameList(search.activeNextFrontier, SEARCH_NEXT_FRONTIER_LIMIT);
    if (search.activeSide === "forward") search.forwardFrontier = next;
    if (search.activeSide === "backward") search.backwardFrontier = next;
    search.activeSide = "";
    search.activeFrontier = [];
    search.activeCursor = 0;
    search.activeNextFrontier = [];
    meeting = null;
    meetingLength = Number.POSITIVE_INFINITY;
    search.depth += 1;
    syncSearch();
    await progress(`Checked ${stats.expanded} players, ${totalVisited()} candidates`, { depth: search.depth });
  };

  while (processed < expansionBudget && Date.now() < deadline) {
    if (!search.activeSide) {
      const startedLayer = await beginLayer();
      if (!startedLayer) {
        syncSearch();
        return { status: "not_found", progress: "No connection found in this search." };
      }
    }

    if (search.activeCursor >= search.activeFrontier.length) {
      if (meeting) {
        syncSearch();
        return { status: "found", chain: reconstructServerPath(meeting, forwardVisited, backwardVisited) };
      }
      await finishLayer();
      continue;
    }

    const remainingBudget = Math.min(
      expansionBudget - processed,
      search.activeFrontier.length - search.activeCursor,
    );
    const batchSize = Math.max(1, Math.min(expansionConcurrency, remainingBudget));
    const batch = search.activeFrontier.slice(search.activeCursor, search.activeCursor + batchSize).filter(Boolean);
    search.activeCursor += batch.length;
    if (!batch.length) continue;
    stats.expanded += batch.length;
    processed += batch.length;

    const edgeBatch = await runThrottled(batch.map((node) => async () => {
      try {
        return { node, edges: await withTimeout(getEdges(node), SEARCH_FRESH_EDGE_LOOKUP_TIMEOUT_MS) };
      } catch {
        return { node, edges: { beatenByMe: new Map(), beatMe: new Map() } };
      }
    }), expansionConcurrency);

    for (const item of edgeBatch) {
      if (!item?.node || !item.edges) continue;
      const node = item.node;
      const edges = item.edges;
      if (search.activeSide === "forward") {
        for (const [opponent, urls] of edges.beatenByMe) {
          if (forwardVisited.has(opponent)) continue;
          if (backwardVisited.has(opponent)) {
            forwardVisited.set(opponent, { prev: node, hopUrl: urls[0] });
            considerMeeting(opponent);
            continue;
          }
          if (forwardVisited.size < SEARCH_VISITED_LIMIT && search.activeNextFrontier.length < SEARCH_NEXT_FRONTIER_LIMIT) {
            forwardVisited.set(opponent, { prev: node, hopUrl: urls[0] });
            search.activeNextFrontier.push(opponent);
          }
        }
      } else {
        for (const [opponent, urls] of edges.beatMe) {
          if (backwardVisited.has(opponent)) continue;
          if (forwardVisited.has(opponent)) {
            backwardVisited.set(opponent, { next: node, hopUrl: urls[0] });
            considerMeeting(opponent);
            continue;
          }
          if (backwardVisited.size < SEARCH_VISITED_LIMIT && search.activeNextFrontier.length < SEARCH_NEXT_FRONTIER_LIMIT) {
            backwardVisited.set(opponent, { next: node, hopUrl: urls[0] });
            search.activeNextFrontier.push(opponent);
          }
        }
      }
    }

    if (meeting && search.activeCursor >= search.activeFrontier.length) {
      syncSearch();
      return { status: "found", chain: reconstructServerPath(meeting, forwardVisited, backwardVisited) };
    }

    if (search.activeCursor >= search.activeFrontier.length) {
      await finishLayer();
    }
  }

  syncSearch();
  return {
    status: "running",
    progress: search.activeSide
      ? `Step ${search.depth + 1}: checking ${search.activeFrontier.length} players`
      : `Checked ${stats.expanded} players, ${totalVisited()} candidates`,
  };
}

async function completeSearchJob(env, job, patch, ownerToken = "") {
  const preparedPatch = { ...patch };
  if (preparedPatch.chain?.found) {
    preparedPatch.chain = {
      ...preparedPatch.chain,
      quality: preparedPatch.chain.quality || routeQuality(preparedPatch.chain, preparedPatch.stats || job.stats, "fresh-search"),
    };
  }
  const update = {
    ...preparedPatch,
    updatedAt: Date.now(),
  };
  const next = ownerToken
    ? await updateOwnedSearchJob(env, job.id, ownerToken, update)
    : await updateSearchJob(env, job.id, update);
  if (ownerToken && !next) return;
  const completed = next || { ...job, ...preparedPatch };
  if (completed?.status === "found" && completed.chain?.found) {
    await writePairChain(env, completed);
    await writeFastLaneFragments(env, completed);
  }
  const event = searchJobAnalyticsEvent(completed);
  if (event) await saveAnalyticsEvent(env, event);
}

async function failSearchJob(env, id, error, ownerToken = "") {
  const patch = {
    status: isRateLimitError(error) ? "timeout" : "failed",
    outcome: isRateLimitError(error) ? "timeout" : "error",
    progress: isRateLimitError(error)
      ? "Chess.com is throttling requests right now."
      : "Search failed before it could finish.",
    error: error?.message || String(error),
    processingUntil: 0,
    processingToken: "",
    updatedAt: Date.now(),
  };
  const job = ownerToken
    ? await updateOwnedSearchJob(env, id, ownerToken, patch)
    : await updateSearchJob(env, id, patch);
  if (ownerToken && !job) return;
  const event = searchJobAnalyticsEvent(job);
  if (event) await saveAnalyticsEvent(env, event);
  console.warn(JSON.stringify({
    event: "search_job_failed",
    id,
    message: error?.message || String(error),
  }));
}

async function findServerChain(env, start, target, range, stats, progress) {
  const archiveLimit = archiveLimitForRange(range);
  const forwardVisited = new Map([[start, { prev: null, hopUrl: null }]]);
  const backwardVisited = new Map([[target, { next: null, hopUrl: null }]]);
  const forwardFrontier = [start];
  const backwardFrontier = [target];
  const edgesCache = new Map();

  const totalVisited = () => forwardVisited.size + backwardVisited.size;
  const getEdges = async (username) => {
    const key = username.toLowerCase();
    if (edgesCache.has(key)) return edgesCache.get(key);
    const edges = await readOrFetchEdges(env, { username: key, archiveLimit }, stats);
    edgesCache.set(key, edges);
    return edges;
  };

  for (let depth = 0; depth < SEARCH_MAX_DEPTH; depth++) {
    const expandForward = forwardFrontier.length <= backwardFrontier.length;
    const frontier = expandForward ? forwardFrontier : backwardFrontier;
    if (!frontier.length) break;

    const selectedFrontier = frontier.slice(0, SEARCH_FRONTIER_LIMIT);
    await progress(`Step ${depth + 1}: checking ${selectedFrontier.length} players`, { depth });

    let meeting = null;
    let cursor = 0;
    const nextFrontier = [];
    const expandOne = async () => {
      while (!meeting && cursor < selectedFrontier.length && stats.expanded < SEARCH_MAX_EXPANSIONS) {
        const node = selectedFrontier[cursor++];
        stats.expanded++;
        const edges = await getEdges(node);
        if (expandForward) {
          for (const [opponent, urls] of edges.beatenByMe) {
            if (forwardVisited.has(opponent)) continue;
            forwardVisited.set(opponent, { prev: node, hopUrl: urls[0] });
            if (backwardVisited.has(opponent)) {
              meeting = { node: opponent };
              return;
            }
            nextFrontier.push(opponent);
          }
        } else {
          for (const [opponent, urls] of edges.beatMe) {
            if (backwardVisited.has(opponent)) continue;
            backwardVisited.set(opponent, { next: node, hopUrl: urls[0] });
            if (forwardVisited.has(opponent)) {
              meeting = { node: opponent };
              return;
            }
            nextFrontier.push(opponent);
          }
        }
      }
    };

    await Promise.all(Array.from({ length: ARCHIVE_CONCURRENCY }, expandOne));
    await progress(`Checked ${stats.expanded} players, ${totalVisited()} candidates`);
    if (meeting) return reconstructServerPath(meeting.node, forwardVisited, backwardVisited);
    if (stats.expanded >= SEARCH_MAX_EXPANSIONS) break;

    if (expandForward) {
      forwardFrontier.length = 0;
      for (const node of nextFrontier) forwardFrontier.push(node);
    } else {
      backwardFrontier.length = 0;
      for (const node of nextFrontier) backwardFrontier.push(node);
    }
  }

  return null;
}

function reconstructServerPath(mid, forwardVisited, backwardVisited) {
  const hops = [];
  let current = mid;
  let guard = 0;
  while (forwardVisited.get(current)?.prev && guard++ < 10000) {
    const info = forwardVisited.get(current);
    hops.unshift({ from: info.prev, to: current, url: info.hopUrl });
    current = info.prev;
  }
  current = mid;
  guard = 0;
  while (backwardVisited.get(current)?.next && guard++ < 10000) {
    const info = backwardVisited.get(current);
    hops.push({ from: current, to: info.next, url: info.hopUrl });
    current = info.next;
  }
  const path = hops.length ? [hops[0].from, ...hops.map((hop) => hop.to)] : [];
  return path.length >= 2 ? { path, hops } : null;
}

async function tryFastLaneConnection(env, job, stats) {
  const exact = await readExactFastLanePair(env, job.start, job.target, job.range);
  const savedStepLimit = job.chain?.found ? chainStepCount(job.chain) : Number.POSITIVE_INFINITY;
  if (exact?.chain?.found && chainStepCount(exact.chain) < savedStepLimit) {
    stats.cached = Number(stats.cached || 0) + 1;
    return {
      source: "exact-fast-lane",
      chain: {
        path: exact.chain.path,
        hops: exact.chain.hops,
      },
    };
  }

  const cachedRoute = await tryCachedRouteLanes(env, job, stats, savedStepLimit);
  if (cachedRoute) return cachedRoute;

  const primedGraphRoute = await tryPrimedGraphIndexPair(env, job, stats, savedStepLimit);
  if (primedGraphRoute) return primedGraphRoute;

  const startGames = job.chain?.found
    ? (await readCachedGames(env, {
        username: job.start,
        archiveLimit: Math.min(6, archiveLimitForRange(job.range) || 6),
      }, stats) || [])
    : await readOrFetchGames(env, {
        username: job.start,
        archiveLimit: Math.min(6, archiveLimitForRange(job.range) || 6),
      }, stats);
  const edges = edgesFromGames(job.start, startGames);
  const directUrls = edges.beatenByMe.get(job.target);
  if (directUrls?.length) {
    const hops = await enrichHopsFromGames([
      { from: job.start, to: job.target, url: directUrls[0] },
    ], startGames);
    return {
      source: "direct-recent-win",
      chain: { path: [job.start, job.target], hops },
    };
  }

  const fragments = await readFastLaneFragments(env, job.target, job.range);
  let best = null;
  for (const fragment of fragments) {
    const connector = fragment.path?.[0];
    if (!connector || connector === job.start || connector === job.target) continue;
    const urls = edges.beatenByMe.get(connector);
    if (!urls?.length) continue;
    const candidateSteps = fragment.path.length;
    if (candidateSteps >= savedStepLimit) continue;
    const firstHop = (await enrichHopsFromGames([
      { from: job.start, to: connector, url: urls[0] },
    ], startGames))[0];
    const path = [job.start, ...fragment.path];
    const tailHops = await enrichHopsFromCache(env, fragment.hops, archiveLimitForRange(job.range), stats);
    const hops = [firstHop, ...tailHops];
    if (new Set(path).size !== path.length || hops.length !== path.length - 1) continue;
    const candidate = {
      source: "fast-lane",
      chain: { path, hops },
    };
    if (!best || candidate.chain.path.length < best.chain.path.length) best = candidate;
  }
  const hinted = await tryLeaderboardRouteHint(env, job, stats);
  if (hinted?.path?.length && (!best || hinted.path.length < best.chain.path.length)) {
    return { source: "known-route", chain: hinted };
  }
  return best;
}

async function tryCachedRouteLanes(env, job, stats, savedStepLimit) {
  const results = await Promise.allSettled([
    readExactAnalyticsPair(env, job.start, job.target, job.range),
    readStartLanePair(env, job.start, job.target, job.range),
    readCachedFastLanePair(env, job.start, job.target, job.range),
    readGraphIndexPair(env, job.start, job.target, job.range),
    readCachedBfsPair(env, job.start, job.target, job.range),
  ]);
  const best = bestPairChain(results
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value));
  if (!best?.chain?.found || chainStepCount(best.chain) >= savedStepLimit) return null;
  stats.cached = Number(stats.cached || 0) + 2;
  return {
    source: best.chain.quality?.source || "cached-route",
    chain: {
      path: best.chain.path,
      hops: best.chain.hops,
    },
  };
}

async function tryPrimedGraphIndexPair(env, job, stats, savedStepLimit) {
  const archiveLimit = Math.min(6, archiveLimitForRange(job.range) || 6);
  const startGames = await readOrFetchGames(env, { username: job.start, archiveLimit }, stats).catch(() => null);
  const startEdges = startGames ? edgesFromGames(job.start, startGames) : null;
  if (startEdges) {
    await putEdgesCache(env.GAMES_CACHE, cacheKeyFromParsed({ username: job.start, archiveLimit }), { username: job.start, archiveLimit }, startEdges)
      .catch(() => {});
  }
  if (startEdges && edgeMapSize(startEdges.beatenByMe) === 0) {
    await writeStartNoWins(env, job.start, job.range).catch(() => {});
    return {
      notFound: true,
      progress: `${job.start} has no recent wins to trace from.`,
    };
  }
  await readOrFetchEdges(env, { username: job.target, archiveLimit }, stats).catch(() => null);
  const graphBridge = await tryGraphIndexBridgeFromStart(env, {
    start: job.start,
    target: job.target,
    range: job.range,
    startEdges,
    startGames: startGames || [],
    savedStepLimit,
  });
  if (graphBridge) {
    stats.cached = Number(stats.cached || 0) + 2;
    return graphBridge;
  }
  const pair = await readGraphIndexPair(env, job.start, job.target, job.range);
  if (!pair?.chain?.found || chainStepCount(pair.chain) >= savedStepLimit) return null;
  return {
    source: "graph-index",
    chain: {
      path: pair.chain.path,
      hops: pair.chain.hops,
    },
  };
}

async function tryGraphIndexBridgeFromStart(env, { start, target, range, startEdges, startGames, savedStepLimit }) {
  const cleanStart = cleanUsername(start);
  const cleanTarget = cleanUsername(target);
  if (!cleanStart || !cleanTarget || !startEdges) return null;

  const directUrls = startEdges.beatenByMe.get(cleanTarget);
  if (directUrls?.length && 1 < savedStepLimit) {
    const hops = await enrichHopsFromGames([
      { from: cleanStart, to: cleanTarget, url: directUrls[0] },
    ], startGames || []);
    return {
      source: "direct-recent-win",
      chain: { path: [cleanStart, cleanTarget], hops },
    };
  }

  const graph = graphIndexShape(await env.GAMES_CACHE.get(GRAPH_INDEX_KEY, { type: "json" }));
  if (!graph.nodes?.[cleanTarget]) return null;
  let best = null;
  let scanned = 0;
  for (const [connector, urls] of startEdges.beatenByMe) {
    if (scanned++ >= GRAPH_BRIDGE_CONNECTOR_LIMIT) break;
    if (connector === cleanStart || connector === cleanTarget || !graph.nodes?.[connector]) continue;
    const tail = graphIndexBfs(graph, connector, cleanTarget);
    if (!tail?.path?.length) continue;
    const path = [cleanStart, ...tail.path];
    if (new Set(path).size !== path.length) continue;
    const steps = path.length - 1;
    if (steps >= savedStepLimit) continue;
    const firstHop = (await enrichHopsFromGames([
      { from: cleanStart, to: connector, url: urls?.[0] },
    ], startGames || []))[0];
    const hops = cleanHopList([firstHop, ...cleanHopList(tail.hops)]);
    if (hops.length !== steps) continue;
    const candidate = {
      source: "graph-bridge",
      chain: { path, hops },
    };
    if (!best || candidate.chain.path.length < best.chain.path.length) best = candidate;
    if (best && best.chain.path.length <= 3) break;
  }
  return best;
}

function edgeMapSize(map) {
  return map instanceof Map ? map.size : 0;
}

async function tryLeaderboardRouteHint(env, job, stats) {
  const entries = normalizeEntries(await env.GAMES_CACHE.get("leaderboard:entries", "json") || []);
  const candidates = entries
    .filter((entry) => entry.start === job.start && entry.target === job.target && entry.path.length >= 2)
    .sort((a, b) => a.steps - b.steps || b.ts - a.ts)
    .slice(0, 3);
  for (const entry of candidates) {
    const storedHops = cleanHopList(entry.hops);
    if (storedHops.length === entry.path.length - 1) {
      return { path: entry.path, hops: storedHops };
    }
    const verifiedHops = await verifyPathHops(env, entry.path, archiveLimitForRange(job.range), stats);
    if (verifiedHops?.length === entry.path.length - 1) {
      const chain = {
        target: entry.target,
        display: entry.target,
        found: true,
        length: Math.max(0, entry.path.length - 1),
        path: entry.path,
        hops: verifiedHops,
      };
      await writePairChain(env, {
        id: `hint-${entry.pathKey}`.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80),
        start: entry.start,
        target: entry.target,
        range: job.range,
        status: "found",
        chain,
        players: {},
        stats,
      });
      await writeFastLaneFragments(env, {
        id: `hint-${entry.pathKey}`.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80),
        start: entry.start,
        target: entry.target,
        range: job.range,
        status: "found",
        chain,
        players: {},
        stats,
      });
      return { path: entry.path, hops: verifiedHops };
    }
  }
  return null;
}

async function verifyPathHops(env, path, archiveLimit, stats = null, options = {}) {
  const cleanPath = Array.isArray(path) ? path.map(cleanUsername).filter(Boolean).slice(0, 12) : [];
  if (cleanPath.length < 2 || new Set(cleanPath).size !== cleanPath.length) return null;
  const limit = Math.min(Number.isFinite(archiveLimit) ? archiveLimit : 12, 12);
  const hops = await runThrottled(cleanPath.slice(0, -1).map((from, index) => async () => {
    const to = cleanPath[index + 1];
    try {
      const cachedHop = await findCachedHop(env, from, to);
      if (cachedHop) return cachedHop;
      const games = await readOrFetchGames(env, { username: from, archiveLimit: limit }, stats);
      const urls = edgesFromGames(from, games).beatenByMe.get(to);
      if (urls?.length) return (await enrichHopsFromGames([{ from, to, url: urls[0] }], games))[0] || null;
      if (options.allowDeep) return findDeepHop(env, from, to, stats);
      return null;
    } catch {
      return null;
    }
  }), 3);
  return hops.every(Boolean) ? cleanHopList(hops) : null;
}

async function verifyPathHopsFromCache(env, path) {
  const cleanPath = Array.isArray(path) ? path.map(cleanUsername).filter(Boolean).slice(0, 12) : [];
  if (cleanPath.length < 2 || new Set(cleanPath).size !== cleanPath.length) return null;
  const hops = await runThrottled(cleanPath.slice(0, -1).map((from, index) => async () => {
    const to = cleanPath[index + 1];
    try {
      return await findCachedHop(env, from, to);
    } catch {
      return null;
    }
  }), 3);
  return hops.every(Boolean) ? cleanHopList(hops) : null;
}

async function findDeepHop(env, from, to, stats = null) {
  for (const username of [from, to]) {
    try {
      const games = await readOrFetchGames(env, { username, archiveLimit: Infinity }, stats);
      const urls = edgesFromGames(from, games).beatenByMe.get(to);
      if (urls?.length) return (await enrichHopsFromGames([{ from, to, url: urls[0] }], games))[0] || null;
    } catch {
      // Keep deep verification opportunistic. A missing/rate-limited archive
      // should not break the search or scheduled warmer.
    }
  }
  return null;
}

async function findCachedHop(env, from, to) {
  const [fromKeys, toKeys] = await Promise.all([
    listGameCacheKeys(env, from),
    listGameCacheKeys(env, to),
  ]);
  const keys = [...new Set([...fromKeys, ...toKeys])]
    .sort((a, b) => cacheRangePriority(a) - cacheRangePriority(b));
  for (const key of keys) {
    const record = await env.GAMES_CACHE.get(key, { type: "json", cacheTtl: 60 });
    const games = Array.isArray(record?.games) ? record.games : [];
    const urls = edgesFromGames(from, games).beatenByMe.get(to);
    if (urls?.length) {
      return (await enrichHopsFromGames([{ from, to, url: urls[0] }], games))[0] || null;
    }
  }
  return null;
}

async function listGameCacheKeys(env, username) {
  const listed = await env.GAMES_CACHE.list({ prefix: `games:${username}:`, limit: 20 });
  return (listed.keys || []).map((key) => key.name).filter(Boolean);
}

function cacheRangePriority(key) {
  if (key.endsWith(":recent:12")) return 0;
  if (key.endsWith(":recent:6")) return 1;
  if (key.endsWith(":all")) return 2;
  if (key.endsWith(":recent:2")) return 3;
  return 4;
}

async function enrichHopsFromCache(env, hops, archiveLimit, stats = null) {
  const cleanHops = cleanHopList(hops);
  const byFrom = new Map();
  for (const hop of cleanHops) {
    if (!byFrom.has(hop.from)) byFrom.set(hop.from, []);
    byFrom.get(hop.from).push(hop);
  }
  const enriched = new Map();
  await runThrottled([...byFrom.entries()].map(([username, userHops]) => async () => {
    const games = await readOrFetchGames(env, {
      username,
      archiveLimit: Math.min(Number.isFinite(archiveLimit) ? archiveLimit : 12, 12),
    }, stats);
    for (const hop of await enrichHopsFromGames(userHops, games)) {
      enriched.set(`${hop.from}>${hop.to}>${hop.url}`, hop);
    }
  }), 2);
  return cleanHops.map((hop) => enriched.get(`${hop.from}>${hop.to}>${hop.url}`) || hop);
}

async function enrichHopsFromGames(hops, games) {
  return cleanHopList(hops).map((hop) => {
    const game = (games || []).find((item) => item.url === hop.url);
    return game ? { ...hop, ...proofDetailsFromGame(game, hop.from, hop.to) } : hop;
  });
}

function proofDetailsFromGame(game, winner, loser) {
  const winnerIsWhite = game.white === winner;
  const loserIsWhite = game.white === loser;
  const color = winnerIsWhite ? "white" : loserIsWhite ? "black" : "";
  return {
    timeClass: String(game.timeClass || "").slice(0, 20),
    endTime: cleanProofTimestamp(game.endTime),
    result: "win",
    color,
    opening: String(game.opening || "").slice(0, 90),
  };
}

function edgesFromGames(username, games) {
  const beatenByMe = new Map();
  const beatMe = new Map();
  for (const game of games || []) {
    if (game.timeClass === "daily") continue;
    if (game.white === username) {
      if (game.whiteResult === "win" && game.black) pushEdge(beatenByMe, game.black, game.url);
      if (game.blackResult === "win" && game.black) pushEdge(beatMe, game.black, game.url);
    } else if (game.black === username) {
      if (game.blackResult === "win" && game.white) pushEdge(beatenByMe, game.white, game.url);
      if (game.whiteResult === "win" && game.white) pushEdge(beatMe, game.white, game.url);
    }
  }
  return { beatenByMe, beatMe };
}

function pushEdge(map, key, url) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(url);
}

async function readOrFetchEdges(env, parsed, stats = null) {
  const key = cacheKeyFromParsed(parsed);
  if (!parsed.forceFresh) {
    const cachedEdges = await readCachedEdges(env, parsed, stats);
    if (cachedEdges) return cachedEdges;
  }
  const games = await readOrFetchGames(env, parsed, stats);
  const edges = edgesFromGames(parsed.username, games);
  await putEdgesCache(env.GAMES_CACHE, key, parsed, edges);
  return edges;
}

async function readCachedOrBuildEdges(env, parsed, stats = null) {
  const cachedEdges = await readCachedEdges(env, parsed, stats);
  if (cachedEdges) return cachedEdges;
  const games = await readCachedGames(env, parsed, stats);
  if (!games) return { beatenByMe: new Map(), beatMe: new Map() };
  const edges = edgesFromGames(parsed.username, games);
  await putEdgesCache(env.GAMES_CACHE, cacheKeyFromParsed(parsed), parsed, edges);
  return edges;
}

async function readCachedExpansionEdges(env, parsed, stats = null) {
  const cachedEdges = await readCachedEdges(env, parsed, stats);
  if (cachedEdges) return { edges: cachedEdges, source: "edge-cache" };
  const games = await readCachedGames(env, parsed, stats);
  if (!games) return { edges: null, source: "miss" };
  const edges = edgesFromGames(parsed.username, games);
  await putEdgesCache(env.GAMES_CACHE, cacheKeyFromParsed(parsed), parsed, edges);
  return { edges, source: "game-cache" };
}

async function readOrFetchGames(env, parsed, stats = null) {
  const key = cacheKeyFromParsed(parsed);
  const kvKey = `games:${key}`;
  const cached = await env.GAMES_CACHE.get(kvKey, { type: "json", cacheTtl: 60 });
  const cachedGames = Array.isArray(cached?.games) ? cached.games : null;
  const cachedAt = Number.isFinite(cached?.ts) ? cached.ts : 0;
  if (!parsed.forceFresh && cachedGames && Date.now() - cachedAt < TTL_SECONDS * 1000) {
    if (stats) stats.cached++;
    return cachedGames;
  }

  const activeLimit = await readRateLimit(env.GAMES_CACHE);
  if (activeLimit && cachedGames) {
    if (stats) stats.cached++;
    return cachedGames;
  }
  if (activeLimit) {
    throw new UpstreamHTTPError(429, `${CHESS_API}${parsed.username}/games/archives`, activeLimit.retryAfter);
  }

  try {
    if (stats) stats.requests++;
    const games = await fetchGames(parsed);
    if (stats) stats.fetched++;
    await putGamesCache(env.GAMES_CACHE, kvKey, parsed, games);
    return games;
  } catch (error) {
    if (isRateLimitError(error)) {
      await rememberRateLimit(env.GAMES_CACHE, error.retryAfter);
      if (cachedGames) {
        if (stats) stats.cached++;
        return cachedGames;
      }
    }
    throw error;
  }
}

async function readCachedGames(env, parsed, stats = null) {
  const key = cacheKeyFromParsed(parsed);
  const kvKey = `games:${key}`;
  const raw = await env.GAMES_CACHE.get(kvKey, { cacheTtl: 60 });
  if (!raw || raw.length > GAME_CACHE_SEARCH_MAX_BYTES) return null;
  let cached;
  try {
    cached = JSON.parse(raw);
  } catch {
    return null;
  }
  const cachedGames = Array.isArray(cached?.games) ? cached.games : null;
  if (!cachedGames) return null;
  if (stats) stats.cached = Number(stats.cached || 0) + 1;
  return cachedGames;
}

async function readCachedEdges(env, parsed, stats = null) {
  const key = cacheKeyFromParsed(parsed);
  const raw = await env.GAMES_CACHE.get(edgeCacheKey(key), { cacheTtl: 60 });
  if (!raw || raw.length > EDGE_CACHE_MAX_BYTES) return null;
  let cached;
  try {
    cached = JSON.parse(raw);
  } catch {
    return null;
  }
  const cachedAt = Number.isFinite(cached?.ts) ? cached.ts : 0;
  if (!cached || Date.now() - cachedAt >= TTL_SECONDS * 1000) return null;
  const edges = deserializeEdges(cached.edges);
  if (!edges) return null;
  if (stats) stats.cached = Number(stats.cached || 0) + 1;
  return edges;
}

function cacheKeyFromParsed(parsed) {
  return Number.isFinite(parsed.archiveLimit)
    ? `${parsed.username}:recent:${parsed.archiveLimit}`
    : `${parsed.username}:all`;
}

function edgeCacheKey(key) {
  return `edges:${String(key || "").toLowerCase()}`;
}

function serializeEdges(edges) {
  return {
    beatenByMe: serializeEdgeMap(edges?.beatenByMe),
    beatMe: serializeEdgeMap(edges?.beatMe),
  };
}

function serializeEdgeMap(map) {
  return [...(map instanceof Map ? map.entries() : [])]
    .slice(0, SEARCH_EDGE_MAP_LIMIT)
    .map(([username, urls]) => [username, Array.isArray(urls) ? urls.slice(0, 3) : []]);
}

function deserializeEdges(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    beatenByMe: deserializeEdgeMap(raw.beatenByMe),
    beatMe: deserializeEdgeMap(raw.beatMe),
  };
}

function deserializeEdgeMap(rows) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const username = cleanUsername(row?.[0]);
    const urls = Array.isArray(row?.[1]) ? row[1].map(cleanUrl).filter(Boolean) : [];
    if (username && urls.length) map.set(username, urls);
    if (map.size >= SEARCH_EDGE_MAP_LIMIT) break;
  }
  return map;
}

function graphIndexShape(raw) {
  const rawNodes = raw?.nodes && typeof raw.nodes === "object" ? raw.nodes : {};
  const nodes = {};
  for (const [rawUsername, rawNode] of Object.entries(rawNodes)) {
    const username = cleanUsername(rawUsername);
    if (!username || !rawNode || typeof rawNode !== "object") continue;
    nodes[username] = {
      w: cleanGraphRows(rawNode.w),
      l: cleanGraphRows(rawNode.l),
      ts: Number.isFinite(rawNode.ts) ? rawNode.ts : 0,
    };
    if (Object.keys(nodes).length >= GRAPH_INDEX_NODE_LIMIT) break;
  }
  return {
    version: 1,
    updatedAt: Number.isFinite(raw?.updatedAt) ? raw.updatedAt : 0,
    nodes,
  };
}

function cleanGraphRows(rows) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const username = cleanUsername(row?.[0]);
    const url = cleanUrl(row?.[1]);
    if (!username || !url || seen.has(username)) continue;
    seen.add(username);
    out.push([username, url]);
    if (out.length >= GRAPH_INDEX_EDGE_LIMIT) break;
  }
  return out;
}

function graphRowsFromMap(map) {
  const rows = [];
  for (const [username, urls] of map instanceof Map ? map.entries() : []) {
    const clean = cleanUsername(username);
    const url = cleanUrl(Array.isArray(urls) ? urls[0] : "");
    if (clean && url) rows.push([clean, url]);
    if (rows.length >= GRAPH_INDEX_EDGE_LIMIT) break;
  }
  return rows;
}

async function upsertGraphIndex(envOrKv, username, edges, ts = Date.now()) {
  const kv = envOrKv?.GAMES_CACHE || envOrKv;
  const clean = cleanUsername(username);
  if (!kv || !clean || !edges) return;
  try {
    const graph = graphIndexShape(await kv.get(GRAPH_INDEX_KEY, { type: "json" }));
    graph.nodes[clean] = {
      w: graphRowsFromMap(edges.beatenByMe),
      l: graphRowsFromMap(edges.beatMe),
      ts,
    };
    trimGraphIndex(graph);
    await kv.put(GRAPH_INDEX_KEY, JSON.stringify({
      version: 1,
      updatedAt: Date.now(),
      nodes: graph.nodes,
    }), {
      expirationTtl: KV_RETENTION_SECONDS,
      metadata: { type: "graph-index" },
    });
  } catch (error) {
    console.warn(JSON.stringify({
      event: "graph_index_update_failed",
      username: clean,
      message: error?.message || String(error),
    }));
  }
}

function trimGraphIndex(graph) {
  const entries = Object.entries(graph.nodes || {});
  if (entries.length <= GRAPH_INDEX_NODE_LIMIT) return;
  entries
    .sort((a, b) => Number(b[1]?.ts || 0) - Number(a[1]?.ts || 0))
    .slice(GRAPH_INDEX_NODE_LIMIT)
    .forEach(([username]) => {
      delete graph.nodes[username];
    });
}

async function rebuildGraphIndex(env) {
  const [edgeKeys, gameKeys] = await Promise.all([
    listKvKeys(env, "edges:", GRAPH_INDEX_WARM_KEY_LIMIT),
    listKvKeys(env, "games:", GRAPH_INDEX_WARM_KEY_LIMIT),
  ]);
  const nodes = {};
  await runThrottled(edgeKeys.map((key) => async () => {
    const cached = await env.GAMES_CACHE.get(key.name, { type: "json", cacheTtl: 60 });
    const username = cleanUsername(key.name.replace(/^edges:/, "").split(":")[0]);
    const edges = deserializeEdges(cached?.edges);
    if (!username || !edges) return;
    nodes[username] = {
      w: graphRowsFromMap(edges.beatenByMe),
      l: graphRowsFromMap(edges.beatMe),
      ts: Number.isFinite(cached?.ts) ? cached.ts : Date.now(),
    };
  }), 12);
  await runThrottled(gameKeys.map((key) => async () => {
    const cacheName = key.name.replace(/^games:/, "");
    const username = cleanUsername(cacheName.split(":")[0]);
    if (!username || nodes[username]) return;
    const cached = await env.GAMES_CACHE.get(key.name, { type: "json", cacheTtl: 60 });
    const games = Array.isArray(cached?.games) ? cached.games : null;
    if (!games) return;
    const edges = edgesFromGames(username, games);
    const ts = Number.isFinite(cached?.ts) ? cached.ts : Date.now();
    await putEdgesCache(env.GAMES_CACHE, cacheName, { username, archiveLimit: archiveLimitFromCacheName(cacheName) }, edges, ts, false);
    nodes[username] = {
      w: graphRowsFromMap(edges.beatenByMe),
      l: graphRowsFromMap(edges.beatMe),
      ts,
    };
  }), 12);
  const graph = graphIndexShape({ version: 1, updatedAt: Date.now(), nodes });
  trimGraphIndex(graph);
  await env.GAMES_CACHE.put(GRAPH_INDEX_KEY, JSON.stringify({
    version: 1,
    updatedAt: Date.now(),
    nodes: graph.nodes,
  }), {
    expirationTtl: KV_RETENTION_SECONDS,
    metadata: { type: "graph-index" },
  });
  return Object.keys(graph.nodes).length;
}

async function readGraphIndexNodeCount(env) {
  const graph = graphIndexShape(await env.GAMES_CACHE.get(GRAPH_INDEX_KEY, { type: "json" }));
  return Object.keys(graph.nodes).length;
}

function archiveLimitFromCacheName(cacheName) {
  const parts = String(cacheName || "").split(":");
  if (parts[1] === "recent") {
    const limit = Number(parts[2]);
    return Number.isFinite(limit) ? limit : 6;
  }
  return parts[1] === "all" ? Infinity : 6;
}

function archiveLimitForRange(range) {
  if (range === "auto") return 6;
  if (range === "instant") return 2;
  if (range === "6") return 6;
  if (range === "12") return 12;
  if (range === "all") return Infinity;
  return 6;
}

async function handleWarm(url, request, env, ctx) {
  const statusOnly = url.searchParams.get("status") === "1";
  const indexOnly = url.searchParams.get("index") === "1";
  const graphStatusOnly = url.searchParams.get("graph") === "1";
  const force = url.searchParams.get("force") === "1";
  const status = await env.GAMES_CACHE.get(WARM_STATUS_KEY, { type: "json" });
  if (statusOnly) {
    const graphNodes = await readGraphIndexNodeCount(env);
    return json({ ok: true, status: publicWarmStatus({ ...status, graphNodes }) }, 200, "no-store");
  }
  if (graphStatusOnly) {
    const graph = graphIndexShape(await env.GAMES_CACHE.get(GRAPH_INDEX_KEY, { type: "json" }));
    const start = cleanUsername(url.searchParams.get("start"));
    const target = cleanUsername(url.searchParams.get("target"));
    return json({
      ok: true,
      graph: {
        nodes: Object.keys(graph.nodes).length,
        updatedAt: graph.updatedAt,
        hasStart: start ? Boolean(graph.nodes[start]) : null,
        hasTarget: target ? Boolean(graph.nodes[target]) : null,
      },
    }, 200, "no-store");
  }
  if (indexOnly) {
    if (!ownerAuthorized(request, env)) return json({ error: "unauthorized" }, 401, "no-store");
    const graphNodes = await rebuildGraphIndex(env);
    await env.GAMES_CACHE.put(WARM_STATUS_KEY, JSON.stringify({
      ...(status || {}),
      status: "ready",
      updatedAt: Date.now(),
      graphNodes,
    }), { expirationTtl: KV_RETENTION_SECONDS, metadata: { type: "warm" } });
    return json({ ok: true, graphNodes, status: publicWarmStatus({ ...status, status: "ready", updatedAt: Date.now(), graphNodes }) }, 200, "no-store");
  }
  if (force && !ownerAuthorized(request, env)) {
    return json({ error: "unauthorized" }, 401, "no-store");
  }
  const age = Date.now() - (Number.isFinite(status?.updatedAt) ? status.updatedAt : 0);
  if (!force && status?.status === "queued" && age < 5 * 60 * 1000) {
    return json({ ok: true, status: publicWarmStatus(status), skipped: true }, 200, "no-store");
  }
  if (!force && status?.status === "ready" && age < WARM_INTERVAL_SECONDS * 1000) {
    return json({ ok: true, status: publicWarmStatus(status), skipped: true }, 200, "no-store");
  }

  const next = {
    status: "queued",
    updatedAt: Date.now(),
    warmed: Number.isFinite(status?.warmed) ? status.warmed : 0,
    fragments: Number.isFinite(status?.fragments) ? status.fragments : 0,
    graphNodes: Number.isFinite(status?.graphNodes) ? status.graphNodes : 0,
    errors: 0,
  };
  await env.GAMES_CACHE.put(WARM_STATUS_KEY, JSON.stringify(next), {
    expirationTtl: KV_RETENTION_SECONDS,
    metadata: { type: "warm" },
  });

  const warmPromise = warmLeaderboardTargets(env).catch((error) => {
    console.warn(JSON.stringify({
      event: "warm_failed",
      message: error?.message || String(error),
    }));
    return env.GAMES_CACHE.put(WARM_STATUS_KEY, JSON.stringify({
      status: "failed",
      updatedAt: Date.now(),
      error: error?.message || String(error),
      warmed: 0,
      fragments: 0,
      errors: 1,
    }), { expirationTtl: KV_RETENTION_SECONDS, metadata: { type: "warm" } });
  });
  if (ctx?.waitUntil) ctx.waitUntil(warmPromise);
  else await warmPromise;

  return json({ ok: true, status: publicWarmStatus(next) }, 202, "no-store");
}

async function warmLeaderboardTargets(env) {
  const startedAt = Date.now();
  const players = new Set(COMMON_WARM_TARGETS);
  const data = await fetchJSON("https://api.chess.com/pub/leaderboards");
  for (const key of ["live_rapid", "live_blitz", "live_bullet"]) {
    for (const row of (Array.isArray(data?.[key]) ? data[key] : []).slice(0, 10)) {
      const username = cleanUsername(row?.username);
      if (username) players.add(username);
      if (players.size >= WARM_PLAYER_LIMIT) break;
    }
  }

  let warmed = 0;
  let errors = 0;
  await runThrottled([...players].slice(0, WARM_PLAYER_LIMIT).map((username) => async () => {
    try {
      await readOrFetchProfile(env, username);
      await readOrFetchGames(env, { username, archiveLimit: 2 });
      warmed++;
    } catch {
      errors++;
    }
  }), 2);
  const fragments = await warmFastLaneFragments(env).catch((error) => {
    console.warn(JSON.stringify({
      event: "warm_fragments_failed",
      message: error?.message || String(error),
    }));
    errors++;
    return 0;
  });
  const graphNodes = await rebuildGraphIndex(env).catch((error) => {
    console.warn(JSON.stringify({
      event: "warm_graph_index_failed",
      message: error?.message || String(error),
    }));
    errors++;
    return 0;
  });

  await env.GAMES_CACHE.put(WARM_STATUS_KEY, JSON.stringify({
    status: "ready",
    updatedAt: Date.now(),
    startedAt,
    warmed,
    fragments,
    graphNodes,
    errors,
  }), {
    expirationTtl: KV_RETENTION_SECONDS,
    metadata: { type: "warm" },
  });
}

function publicWarmStatus(status) {
  const updatedAt = Number.isFinite(status?.updatedAt) ? status.updatedAt : Date.now();
  const graphNodes = Number.isFinite(status?.graphNodes) ? status.graphNodes : 0;
  const staleQueued = String(status?.status || "").toLowerCase() === "queued" &&
    graphNodes > 0 &&
    Date.now() - updatedAt > 5 * 60 * 1000;
  return {
    status: staleQueued ? "ready" : String(status?.status || "queued"),
    updatedAt,
    warmed: Number.isFinite(status?.warmed) ? status.warmed : 0,
    fragments: Number.isFinite(status?.fragments) ? status.fragments : 0,
    graphNodes,
    errors: Number.isFinite(status?.errors) ? status.errors : 0,
  };
}

async function warmFastLaneFragments(env) {
  const [pairKeys, shareKeys] = await Promise.all([
    listKvKeys(env, "search:pair:", WARM_ROUTE_LIMIT),
    listKvKeys(env, "share:", WARM_ROUTE_LIMIT),
  ]);
  const leaderboardEntries = normalizeEntries(await env.GAMES_CACHE.get("leaderboard:entries", "json") || [])
    .filter((entry) => cleanHopList(entry.hops).length === entry.path.length - 1)
    .slice(0, WARM_ROUTE_LIMIT);
  let fragments = 0;
  await runThrottled(pairKeys.map((key) => async () => {
    const record = await env.GAMES_CACHE.get(key.name, { type: "json", cacheTtl: 60 });
    const shaped = searchJobShape({
      id: `warm-${key.name}`.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80),
      start: record?.start,
      target: record?.target,
      range: record?.range,
      status: "found",
      chain: record?.chain,
      players: record?.players || {},
      stats: { fetched: 0, requests: 0, cached: 0, expanded: 0 },
    });
    if (shaped?.chain?.found) {
      await writeFastLaneFragments(env, shaped);
      fragments += Math.max(0, shaped.chain.path.length - 1);
    }
  }), 3);
  await runThrottled(shareKeys.map((key) => async () => {
    const record = shareRecordShape(await env.GAMES_CACHE.get(key.name, { type: "json", cacheTtl: 60 }));
    if (!record?.chain?.found) return;
    const shaped = searchJobShape({
      id: `warm-${key.name}`.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80),
      start: record.start,
      target: record.target,
      range: "auto",
      status: "found",
      chain: record.chain,
      players: record.players || {},
      stats: { fetched: 0, requests: 0, cached: 0, expanded: 0 },
    });
    if (shaped?.chain?.found) {
      await writePairChain(env, shaped);
      await writeFastLaneFragments(env, shaped);
      fragments += Math.max(0, shaped.chain.path.length - 1);
    }
  }), 3);
  await runThrottled(leaderboardEntries.map((entry) => async () => {
    const shaped = searchJobShape({
      id: `warm-${entry.pathKey}`.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80),
      start: entry.start,
      target: entry.target,
      range: "auto",
      status: "found",
      chain: {
        target: entry.target,
        display: entry.target,
        found: true,
        length: entry.steps,
        path: entry.path,
        hops: entry.hops,
      },
      players: {},
      stats: { fetched: 0, requests: 0, cached: 0, expanded: 0 },
    });
    if (shaped?.chain?.found) {
      await writePairChain(env, shaped);
      await writeFastLaneFragments(env, shaped);
      fragments += Math.max(0, shaped.chain.path.length - 1);
    }
  }), 3);
  const unverifiedRoutes = await warmVerificationRoutes(env);
  const verifyDeadline = Date.now() + WARM_VERIFY_TIME_MS;
  for (const entry of unverifiedRoutes) {
    if (Date.now() >= verifyDeadline) break;
    const stats = { fetched: 0, requests: 0, cached: 0, expanded: 0 };
    const hops = await verifyPathHops(env, entry.path, 12, stats, { allowDeep: true });
    if (hops?.length !== entry.path.length - 1) continue;
    const shaped = searchJobShape({
      id: `warm-verified-${entry.pathKey}`.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80),
      start: entry.start,
      target: entry.target,
      range: "auto",
      status: "found",
      chain: {
        target: entry.target,
        display: entry.target,
        found: true,
        length: entry.steps,
        path: entry.path,
        hops,
      },
      players: {},
      stats,
    });
    if (shaped?.chain?.found) {
      await writePairChain(env, shaped);
      await writeFastLaneFragments(env, shaped);
      fragments += Math.max(0, shaped.chain.path.length - 1);
    }
  }
  return fragments;
}

async function warmVerificationRoutes(env) {
  const leaderboardRoutes = normalizeEntries(await env.GAMES_CACHE.get("leaderboard:entries", "json") || [])
    .filter((entry) => cleanHopList(entry.hops).length !== entry.path.length - 1)
    .map((entry) => ({
      source: "leaderboard",
      start: entry.start,
      target: entry.target,
      path: entry.path,
      steps: entry.steps,
      ts: entry.ts,
      pathKey: entry.pathKey || chainKey(entry.path),
    }));
  const analyticsRoutes = normalizeAnalyticsEvents(await env.GAMES_CACHE.get(ANALYTICS_EVENTS_KEY, "json") || [])
    .filter((event) =>
      ["found", "saved"].includes(event.outcome) &&
      Array.isArray(event.path) &&
      event.path.length >= 2 &&
      cleanHopList(event.hops).length !== event.path.length - 1)
    .map((event) => {
      const path = normalizePath(event.start, event.target, event.path);
      return {
        source: "analytics",
        start: event.start,
        target: event.target,
        path,
        steps: Math.max(0, path.length - 1),
        ts: event.ts,
        pathKey: chainKey(path),
      };
    });
  const byPair = new Map();
  for (const route of [...leaderboardRoutes, ...analyticsRoutes]) {
    if (!route.start || !route.target || !Array.isArray(route.path) || route.path.length < 2) continue;
    const key = `${route.start}|${route.target}`;
    const current = byPair.get(key);
    if (!current || route.steps < current.steps || (route.steps === current.steps && route.ts > current.ts)) {
      byPair.set(key, route);
    }
  }
  return [...byPair.values()]
    .sort((a, b) => a.steps - b.steps || b.ts - a.ts)
    .slice(0, WARM_VERIFY_ROUTE_LIMIT);
}

async function listKvKeys(env, prefix, max) {
  const keys = [];
  let cursor;
  do {
    const limit = Math.max(1, Math.min(1000, max - keys.length));
    const page = await env.GAMES_CACHE.list({ prefix, limit, cursor });
    keys.push(...(page.keys || []));
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor && keys.length < max);
  return keys.slice(0, max);
}

async function handleShareCreate(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }

  const share = shareRecordShape(body);
  if (!share) return json({ error: "invalid share" }, 400, "no-store");
  const id = await shareIdForRecord(share);
  const record = {
    ...share,
    id,
    createdAt: Date.now(),
  };
  await env.GAMES_CACHE.put(`share:${id}`, JSON.stringify(record), {
    expirationTtl: SHARE_TTL_SECONDS,
    metadata: {
      type: "share",
      start: share.start,
      target: share.target,
    },
  });
  const shareJob = searchJobShape({
    id: `share-${id}`,
    start: share.start,
    target: share.target,
    range: "auto",
    status: "found",
    chain: share.chain,
    players: share.players || {},
    stats: { fetched: 0, requests: 0, cached: 0, expanded: 0 },
  });
  if (shareJob?.chain?.found) {
    await writePairChain(env, shareJob);
    await writeFastLaneFragments(env, shareJob);
  }
  return json({ ok: true, id, share: publicShareRecord(record) }, 200, "no-store");
}

async function handleShareRead(url, env) {
  const id = cleanShareId(url.searchParams.get("id") || url.searchParams.get("c"));
  if (!id) return json({ error: "missing id" }, 400, "no-store");
  const record = shareRecordShape(await env.GAMES_CACHE.get(`share:${id}`, { type: "json", cacheTtl: 60 }));
  if (!record) return json({ error: "share not found" }, 404, "no-store");
  const upgraded = await upgradeShareRecord(env, record).catch(() => record);
  return json({ ok: true, id, share: publicShareRecord({ ...upgraded, id }) }, 200, "public, max-age=60");
}

async function upgradeShareRecord(env, record) {
  const shaped = shareRecordShape(record);
  if (!shaped?.chain?.found) return record;
  const currentPair = pairChainShape({
    start: shaped.start,
    target: shaped.target,
    range: "auto",
    chain: shaped.chain,
    players: shaped.players,
    savedAt: shaped.ts,
    checkedAt: shaped.ts,
  }, shaped.start, shaped.target, "auto");
  const savedPair = await readPairChain(env, shaped.start, shaped.target, "auto");
  const bestBeforeCachedBfs = bestPairChain([currentPair, savedPair]);
  const bestBeforeSteps = chainStepCount(bestBeforeCachedBfs?.chain);
  const cachedBfsPair = Number.isFinite(bestBeforeSteps) && bestBeforeSteps <= 2
    ? null
    : await readCachedBfsPair(env, shaped.start, shaped.target, "auto").catch(() => null);
  const best = bestPairChain([currentPair, savedPair, cachedBfsPair]);
  if (!best?.chain?.found || !isPairShorterThan(best, currentPair)) return record;

  const players = { ...shaped.players, ...(best.players || {}) };
  await writePairChain(env, {
    id: cleanAnalyticsId(`share-${shaped.start}-${shaped.target}`) || crypto.randomUUID(),
    start: shaped.start,
    target: shaped.target,
    range: "auto",
    status: "found",
    chain: best.chain,
    players,
    stats: { fetched: 0, requests: 0, cached: 2, expanded: 0 },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return {
    ...record,
    start: shaped.start,
    target: shaped.target,
    chain: best.chain,
    players,
    ts: best.savedAt || shaped.ts,
  };
}

function shareRecordShape(value) {
  if (!value || typeof value !== "object") return null;
  const rawChain = value.chain && typeof value.chain === "object"
    ? value.chain
    : value;
  const target = cleanUsername(rawChain.target || value.target);
  const chain = chainShape(rawChain, target);
  if (!chain?.found || !target || !Array.isArray(chain.path) || chain.path.length < 2) return null;
  const start = cleanUsername(value.start || chain.path[0]);
  const normalizedPath = normalizePath(start, target, chain.path);
  if (normalizedPath.length < 2 || normalizedPath[0] !== start || normalizedPath[normalizedPath.length - 1] !== target) {
    return null;
  }
  const hops = chain.hops.length === normalizedPath.length - 1
    ? chain.hops
    : [];
  if (hops.length !== normalizedPath.length - 1) return null;
  return {
    v: 1,
    start,
    target,
    chain: {
      ...chain,
      target,
      length: Math.max(0, normalizedPath.length - 1),
      path: normalizedPath,
      hops,
      quality: qualityShape(chain.quality || value.quality),
    },
    players: cleanSharePlayers(value.players || rawChain.players),
    ts: Number.isFinite(value.ts) ? value.ts : Date.now(),
  };
}

function cleanSharePlayers(value) {
  const players = {};
  if (!value || typeof value !== "object") return players;
  for (const [rawUsername, rawProfile] of Object.entries(value)) {
    const username = cleanUsername(rawUsername);
    if (!username || !rawProfile || typeof rawProfile !== "object") continue;
    players[username] = {
      username,
      avatar: cleanHttpUrl(rawProfile.avatar),
      title: String(rawProfile.title || "").slice(0, 12),
      name: String(rawProfile.name || "").slice(0, 80),
      url: cleanHttpUrl(rawProfile.url),
      country: cleanCountry(countryFromProfile(rawProfile.country)),
      followers: cleanNonNegativeNumber(rawProfile.followers, 100000000),
      joined: cleanNonNegativeNumber(rawProfile.joined, 4102444800),
      lastOnline: cleanNonNegativeNumber(rawProfile.lastOnline || rawProfile.last_online, 4102444800),
      status: String(rawProfile.status || "").slice(0, 24),
      location: String(rawProfile.location || "").slice(0, 80),
      fide: cleanNonNegativeNumber(rawProfile.fide, 4000),
    };
  }
  return players;
}

function publicShareRecord(record) {
  const shaped = shareRecordShape(record);
  if (!shaped) return null;
  return {
    v: 1,
    id: cleanShareId(record?.id),
    target: shaped.target,
    display: shaped.chain.display,
    length: shaped.chain.length,
    path: shaped.chain.path,
    hops: shaped.chain.hops,
    players: shaped.players,
    quality: shaped.chain.quality,
    ts: shaped.ts,
  };
}

async function shareIdForRecord(record) {
  const canonical = JSON.stringify({
    start: record.start,
    target: record.target,
    path: record.chain.path,
    hops: record.chain.hops.map((hop) => ({ from: hop.from, to: hop.to, url: hop.url })),
  });
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return base64UrlBytes(new Uint8Array(digest)).slice(0, SHARE_ID_LENGTH);
}

async function handleSubmit(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rateLimitKey = `leaderboard:ratelimit:${ip}`;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }

  const start = cleanUsername(body.start);
  const target = cleanUsername(body.target);
  const submittedLength = parseInt(body.length, 10);
  const path = Array.isArray(body.path)
    ? body.path.slice(0, 12).map(cleanUsername).filter(Boolean)
    : [];
  const normalizedPath = normalizePath(start, target, path);
  const submittedHops = cleanHopList(body.hops);
  const hops = submittedHops.length === normalizedPath.length - 1 ? submittedHops : [];
  const steps = Math.max(0, normalizedPath.length - 1);
  const length = connectionCount(normalizedPath, submittedLength);
  const pathKey = chainKey(normalizedPath);

  if (!start || !target || start === target || normalizedPath.length < 2 ||
      !Number.isFinite(length) || length < 0 || length > 10) {
    return json({ error: "missing fields" }, 400);
  }
  if (isBlockedUsername(start) || isBlockedUsername(target) || pathHasBlockedUser(normalizedPath)) {
    return json({ ok: true, skipped: true }, 200, "no-store");
  }

  const entries = normalizeEntries(await env.GAMES_CACHE.get("leaderboard:entries", "json") || []);
  const key = `${start}|${target}`;
  const entry = {
    start,
    target,
    length,
    connections: length,
    steps,
    path: normalizedPath,
    hops,
    pathKey,
    ts: Date.now(),
  };
  const samePairEntries = entries.filter((item) => `${item.start}|${item.target}` === key);
  const bestSamePair = samePairEntries.sort(comparePairRoutes)[0] || null;

  if (bestSamePair && !isBetterPairRoute(entry, bestSamePair)) {
    if (entry.pathKey === bestSamePair.pathKey &&
        hops.length === normalizedPath.length - 1 &&
        cleanHopList(bestSamePair.hops).length !== hops.length) {
      const nextEntries = entries.map((item) => item.pathKey === bestSamePair.pathKey
        ? { ...item, hops, ts: Date.now() }
        : item);
      await env.GAMES_CACHE.put("leaderboard:entries", JSON.stringify(nextEntries));
      await cacheSubmittedRoute(env, start, target, normalizedPath, hops, steps, pathKey);
      return json({
        ok: true,
        deduped: true,
        reason: "same-chain-proof-updated",
        entry: { ...bestSamePair, hops },
      }, 200, "no-store");
    }
    return json({
      ok: true,
      deduped: true,
      reason: "existing-route-is-shorter",
      entry: bestSamePair,
    }, 200, "no-store");
  }

  const submitWindow = await readSubmitWindow(env.GAMES_CACHE, rateLimitKey);
  if (submitWindow.count >= MAX_SUBMITS_PER_WINDOW) {
    return json({
      error: "too many submissions, wait a moment",
      retryAfter: Math.max(1, SUBMIT_WINDOW_SECONDS - Math.floor((Date.now() - submitWindow.startedAt) / 1000)),
    }, 429);
  }

  const replaced = samePairEntries.length;
  const nextEntries = entries.filter((item) => `${item.start}|${item.target}` !== key);
  nextEntries.push(entry);

  nextEntries.sort((a, b) => b.length - a.length || b.steps - a.steps || b.ts - a.ts);
  if (nextEntries.length > MAX_LEADERBOARD_ENTRIES) nextEntries.length = MAX_LEADERBOARD_ENTRIES;

  await env.GAMES_CACHE.put("leaderboard:entries", JSON.stringify(nextEntries));
  await env.GAMES_CACHE.put(rateLimitKey, JSON.stringify({
    startedAt: submitWindow.startedAt,
    count: submitWindow.count + 1,
  }), { expirationTtl: SUBMIT_WINDOW_SECONDS * 2 });

  await cacheSubmittedRoute(env, start, target, normalizedPath, hops, steps, pathKey);

  return json({ ok: true, entry, replaced }, 200, "no-store");
}

function comparePairRoutes(a, b) {
  if (a.steps !== b.steps) return a.steps - b.steps;
  const aProofs = cleanHopList(a.hops).length;
  const bProofs = cleanHopList(b.hops).length;
  if (aProofs !== bProofs) return bProofs - aProofs;
  return b.ts - a.ts;
}

function isBetterPairRoute(candidate, current) {
  if (!current) return true;
  return comparePairRoutes(candidate, current) < 0;
}

async function cacheSubmittedRoute(env, start, target, path, hops, steps, pathKey) {
  if (cleanHopList(hops).length !== path.length - 1) return;
  const chain = {
    target,
    display: target,
    found: true,
    length: steps,
    path,
    hops,
  };
  const submitJob = searchJobShape({
    id: `submit-${pathKey}`.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80),
    start,
    target,
    range: "auto",
    status: "found",
    chain,
    players: {},
    stats: { fetched: 0, requests: 0, cached: 0, expanded: 0 },
  });
  if (submitJob?.chain?.found) {
    await writePairChain(env, submitJob);
    await writeFastLaneFragments(env, submitJob);
  }
}

async function handleAnalyticsEvent(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const rateLimitKey = `analytics:ratelimit:${ip}`;

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }

  const event = analyticsEventShape(body, request);
  if (!event) return json({ error: "missing fields" }, 400);

  const submitWindow = await readSubmitWindow(env.GAMES_CACHE, rateLimitKey);
  if (submitWindow.count >= MAX_ANALYTICS_EVENTS_PER_WINDOW) {
    return json({
      error: "too many events, wait a moment",
      retryAfter: Math.max(1, SUBMIT_WINDOW_SECONDS - Math.floor((Date.now() - submitWindow.startedAt) / 1000)),
    }, 429);
  }

  await saveAnalyticsEvent(env, event);
  await env.GAMES_CACHE.put(rateLimitKey, JSON.stringify({
    startedAt: submitWindow.startedAt,
    count: submitWindow.count + 1,
  }), { expirationTtl: SUBMIT_WINDOW_SECONDS * 2 });

  return json({ ok: true }, 200, "no-store");
}

async function handleAnalytics(url, request, env) {
  if (!ownerAuthorized(request, env)) return json({ error: "unauthorized" }, 401, "no-store");

  const parsedLimit = parseInt(url.searchParams.get("limit") || "30", 10);
  const limit = Math.max(1, Math.min(MAX_ANALYTICS_LIMIT, Number.isFinite(parsedLimit) ? parsedLimit : 30));
  const outcome = analyticsOutcomeFilter(url.searchParams.get("outcome"));
  const username = cleanPartialUsername(url.searchParams.get("username"));
  const target = cleanUsername(url.searchParams.get("target"));
  const from = cleanTimestampMs(url.searchParams.get("from"));
  const to = cleanTimestampMs(url.searchParams.get("to"));
  const allEvents = normalizeAnalyticsEvents(await env.GAMES_CACHE.get(ANALYTICS_EVENTS_KEY, "json") || []);
  const events = allEvents.filter((event) => {
    if (outcome && event.outcome !== outcome) return false;
    if (target && event.target !== target) return false;
    if (from && event.ts < from) return false;
    if (to && event.ts > to) return false;
    if (username) {
      const haystack = [event.start, event.target, ...(Array.isArray(event.path) ? event.path : [])]
        .join(" ");
      if (!haystack.includes(username)) return false;
    }
    return true;
  });
  return json({
    events: events.slice(0, limit),
    total: events.length,
    storedTotal: allEvents.length,
    filters: { outcome, username, target, from, to },
    generatedAt: Date.now(),
  }, 200, "no-store");
}

async function saveAnalyticsEvent(env, event) {
  if (!event) return;
  const shapedEvent = normalizeAnalyticsEvents([event])[0] || event;
  const events = normalizeAnalyticsEvents(await env.GAMES_CACHE.get(ANALYTICS_EVENTS_KEY, "json") || []);
  const existingIndex = events.findIndex((item) => item.id === shapedEvent.id);
  if (existingIndex >= 0) {
    const existing = events[existingIndex];
    events.splice(existingIndex, 1);
    events.unshift({ ...existing, ...shapedEvent, firstTs: existing.firstTs || existing.ts || shapedEvent.ts });
  } else {
    events.unshift(shapedEvent);
  }
  if (events.length > MAX_ANALYTICS_EVENTS) events.length = MAX_ANALYTICS_EVENTS;

  await env.GAMES_CACHE.put(ANALYTICS_EVENTS_KEY, JSON.stringify(events), {
    expirationTtl: KV_RETENTION_SECONDS,
    metadata: { type: "analytics" },
  });
  if (["found", "saved"].includes(shapedEvent.outcome) && shapedEvent.path.length >= 2 && shapedEvent.hops.length === shapedEvent.path.length - 1) {
    await cacheSubmittedRoute(
      env,
      shapedEvent.start,
      shapedEvent.target,
      shapedEvent.path,
      shapedEvent.hops,
      shapedEvent.path.length - 1,
      chainKey(shapedEvent.path),
    );
  }
}

async function readSearchJob(env, id) {
  const durable = await durableSearchJobRequest(env, id, "read", {}, { timeoutMs: SEARCH_DURABLE_READ_TIMEOUT_MS });
  if (durable.used && durable.job) return durable.job;
  const record = await env.GAMES_CACHE.get(`search:job:${id}`, { type: "json" });
  return searchJobShape(record);
}

async function writeSearchJob(env, job) {
  const shaped = searchJobShape(job);
  const durable = await durableSearchJobRequest(env, shaped.id, "write", { job: shaped }, { timeoutMs: SEARCH_DURABLE_WRITE_TIMEOUT_MS });
  if (durable.used && durable.job) {
    await writePublicSearchJob(env, durable.job);
    return durable.job;
  }
  await env.GAMES_CACHE.put(`search:job:${shaped.id}`, JSON.stringify(shaped), {
    expirationTtl: SEARCH_JOB_TTL_SECONDS,
    metadata: { type: "search-job", start: shaped.start, target: shaped.target },
  });
  await writePublicSearchJob(env, shaped);
  return shaped;
}

async function updateSearchJob(env, id, patch) {
  const durable = await durableSearchJobRequest(env, id, "update", { patch }, { timeoutMs: SEARCH_DURABLE_WRITE_TIMEOUT_MS });
  if (durable.used && durable.job) {
    await writePublicSearchJob(env, durable.job);
    return durable.job;
  }
  const current = await readSearchJob(env, id);
  if (!current) return null;
  return writeSearchJob(env, {
    ...current,
    ...patch,
    stats: patch.stats || current.stats,
    updatedAt: Date.now(),
  });
}

async function claimSearchJob(env, id, token, leaseMs) {
  const durable = await durableSearchJobRequest(env, id, "claim", { token, leaseMs }, { timeoutMs: SEARCH_DURABLE_WRITE_TIMEOUT_MS });
  if (durable.used && durable.job) {
    await writePublicSearchJob(env, durable.job);
    return durable.job;
  }
  if (durable.used && !durable.timedOut) return durable.job;
  const current = await readSearchJob(env, id);
  if (!current || !isActiveSearchStatus(current.status)) return null;
  if (Number(current.processingUntil || 0) > Date.now() && current.processingToken !== token) return current;
  return writeSearchJob(env, {
    ...current,
    status: "running",
    processingToken: token,
    processingUntil: Date.now() + leaseMs,
    updatedAt: Date.now(),
  });
}

async function updateOwnedSearchJob(env, id, token, patch) {
  const durable = await durableSearchJobRequest(env, id, "update-owned", { token, patch }, { timeoutMs: SEARCH_DURABLE_WRITE_TIMEOUT_MS });
  if (durable.used && durable.job) {
    await writePublicSearchJob(env, durable.job);
    return durable.job;
  }
  if (durable.used && !durable.timedOut) return durable.job;
  const current = await readSearchJob(env, id);
  if (!current || current.processingToken !== token) return null;
  return writeSearchJob(env, {
    ...current,
    ...patch,
    processingToken: patch.processingToken ?? token,
    stats: patch.stats || current.stats,
    updatedAt: Date.now(),
  });
}

async function readPublicSearchJob(env, id) {
  const cleanId = cleanAnalyticsId(id);
  if (!cleanId) return null;
  const record = await env.GAMES_CACHE.get(`search:public:${cleanId}`, { type: "json", cacheTtl: 5 });
  return publicSearchJobShape(record);
}

async function writePublicSearchJob(env, job) {
  const publicJob = publicSearchJob(job);
  if (!publicJob?.id) return null;
  await env.GAMES_CACHE.put(`search:public:${publicJob.id}`, JSON.stringify(publicJob), {
    expirationTtl: SEARCH_PUBLIC_JOB_TTL_SECONDS,
    metadata: { type: "search-public-job", start: publicJob.start, target: publicJob.target },
  });
  return publicJob;
}

async function durableSearchJobRequest(env, id, action, payload = {}, options = {}) {
  const cleanId = cleanAnalyticsId(id);
  if (!cleanId || !env.SEARCH_JOBS) return { used: false, job: null };
  const stub = env.SEARCH_JOBS.getByName(cleanId);
  const controller = new AbortController();
  const timeoutMs = Math.max(500, Number(options.timeoutMs) || SEARCH_DURABLE_WRITE_TIMEOUT_MS);
  const fetchPromise = stub.fetch(`https://search-job/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(payload),
    signal: controller.signal,
  }).catch((error) => ({ searchJobRequestError: error }));
  const timeoutPromise = delay(timeoutMs).then(() => {
    controller.abort();
    return { searchJobRequestTimedOut: true };
  });
  const res = await Promise.race([fetchPromise, timeoutPromise]);
  if (res?.searchJobRequestTimedOut) return { used: true, job: null, timedOut: true };
  if (res?.searchJobRequestError) {
    return {
      used: true,
      job: null,
      timedOut: res.searchJobRequestError?.name === "AbortError",
    };
  }
  try {
    if (!res.ok) return { used: true, job: null };
    const data = await res.json();
    return { used: true, job: searchJobShape(data.job) };
  } catch {
    return { used: true, job: null };
  }
}

async function readPairChain(env, start, target, range) {
  const key = pairChainKey(start, target, range);
  const record = await env.GAMES_CACHE.get(key, { type: "json", cacheTtl: 60 });
  return pairChainShape(record, start, target, range);
}

async function writePairChain(env, job) {
  const shaped = searchJobShape(job);
  if (!shaped?.chain?.found) return null;
  await clearStartNoWins(env, shaped.start, shaped.range).catch(() => {});
  const key = pairChainKey(shaped.start, shaped.target, shaped.range);
  const current = await readPairChain(env, shaped.start, shaped.target, shaped.range);
  const currentSteps = chainStepCount(current?.chain);
  const nextSteps = chainStepCount(shaped.chain);
  const keepCurrent = current?.chain?.found && currentSteps < nextSteps;
  const record = keepCurrent
    ? {
        ...current,
        checkedAt: Date.now(),
      }
    : {
        start: shaped.start,
        target: shaped.target,
        range: shaped.range,
        chain: shaped.chain,
        players: shaped.players || {},
        savedAt: current?.savedAt || Date.now(),
        checkedAt: Date.now(),
      };
  await env.GAMES_CACHE.put(key, JSON.stringify(record), {
    expirationTtl: PAIR_CHAIN_TTL_SECONDS,
    metadata: {
      type: "pair-chain",
      start: shaped.start,
      target: shaped.target,
      range: shaped.range,
    },
  });
  return pairChainShape(record, shaped.start, shaped.target, shaped.range);
}

function startNoWinsKey(start, range) {
  return `search:nowins:${cleanRange(range) || "auto"}:${cleanUsername(start)}`;
}

async function readStartNoWins(env, start, range) {
  const cleanStart = cleanUsername(start);
  if (!cleanStart) return null;
  const record = await env.GAMES_CACHE.get(startNoWinsKey(cleanStart, range), { type: "json", cacheTtl: 60 });
  const ts = Number(record?.ts || 0);
  if (record?.start !== cleanStart || Date.now() - ts >= START_NO_WINS_TTL_SECONDS * 1000) return null;
  return record;
}

async function writeStartNoWins(env, start, range) {
  const cleanStart = cleanUsername(start);
  if (!cleanStart) return null;
  const record = {
    start: cleanStart,
    range: cleanRange(range) || "auto",
    ts: Date.now(),
  };
  await env.GAMES_CACHE.put(startNoWinsKey(cleanStart, range), JSON.stringify(record), {
    expirationTtl: START_NO_WINS_TTL_SECONDS,
    metadata: { type: "start-no-wins", start: cleanStart, range: record.range },
  });
  return record;
}

async function clearStartNoWins(env, start, range) {
  const cleanStart = cleanUsername(start);
  if (!cleanStart) return;
  const ranges = [...new Set([cleanRange(range) || "auto", "auto"])];
  await Promise.all(ranges.map((item) => env.GAMES_CACHE.delete(startNoWinsKey(cleanStart, item))));
}

async function writeFastLaneFragments(env, job) {
  const shaped = searchJobShape(job);
  if (!shaped?.chain?.found || !Array.isArray(shaped.chain.path) || shaped.chain.path.length < 2) return;
  const ranges = [...new Set([shaped.range, "auto"].filter(Boolean))];
  for (const range of ranges) {
    const key = fastLaneKey(shaped.target, range);
    const existing = await readFastLaneFragmentsForKey(env, key);
    const next = new Map(existing.map((fragment) => [fragment.path[0], fragment]));
    for (let i = 0; i < shaped.chain.path.length - 1; i++) {
      const path = shaped.chain.path.slice(i);
      const hops = cleanHopList(shaped.chain.hops.slice(i));
      if (path.length < 2 || hops.length !== path.length - 1) continue;
      const connector = path[0];
      const fragment = {
        target: shaped.target,
        range,
        path,
        hops,
        length: Math.max(0, path.length - 1),
        quality: shaped.chain.quality || routeQuality({ path, hops }, shaped.stats, "fast-lane"),
        savedAt: Date.now(),
      };
      const current = next.get(connector);
      if (!current || fragment.length < current.length || fragment.savedAt > current.savedAt) {
        next.set(connector, fragment);
      }
    }
    const fragments = [...next.values()]
      .map(fastLaneFragmentShape)
      .filter(Boolean)
      .sort((a, b) => a.length - b.length || b.savedAt - a.savedAt)
      .slice(0, FAST_LANE_FRAGMENT_LIMIT);
    await env.GAMES_CACHE.put(key, JSON.stringify({ target: shaped.target, range, fragments, updatedAt: Date.now() }), {
      expirationTtl: PAIR_CHAIN_TTL_SECONDS,
      metadata: { type: "fast-lane", target: shaped.target, range },
    });
  }
  await writeStartLaneFragments(env, shaped);
}

async function readFastLaneFragments(env, target, range) {
  const cleanTarget = cleanUsername(target);
  const ranges = [...new Set([cleanRange(range) || "auto", "auto", "6", "instant"])];
  const fragmentsByRange = await Promise.all(ranges.map((candidateRange) =>
    readFastLaneFragmentsForKey(env, fastLaneKey(cleanTarget, candidateRange)).catch(() => [])
  ));
  const fragments = fragmentsByRange.flat();
  const unique = new Map();
  for (const fragment of fragments) {
    if (!fragment || fragment.target !== cleanTarget) continue;
    const connector = fragment.path[0];
    const current = unique.get(connector);
    if (!current || fragment.length < current.length || fragment.savedAt > current.savedAt) {
      unique.set(connector, fragment);
    }
  }
  return [...unique.values()].sort((a, b) => a.length - b.length || b.savedAt - a.savedAt).slice(0, FAST_LANE_FRAGMENT_LIMIT);
}

async function writeStartLaneFragments(env, job) {
  const shaped = searchJobShape(job);
  if (!shaped?.chain?.found || !Array.isArray(shaped.chain.path) || shaped.chain.path.length < 2) return;
  const ranges = [...new Set([shaped.range, "auto"].filter(Boolean))];
  const fullHops = cleanHopList(shaped.chain.hops);
  for (const range of ranges) {
    const key = startLaneKey(shaped.start, range);
    const existing = await readStartLaneFragmentsForKey(env, key);
    const next = new Map(existing.map((fragment) => [fragment.target, fragment]));
    for (let i = 1; i < shaped.chain.path.length; i++) {
      const path = shaped.chain.path.slice(0, i + 1);
      const hops = fullHops.slice(0, i);
      if (path.length < 2 || hops.length !== path.length - 1) continue;
      const target = path[path.length - 1];
      const fragment = {
        target,
        range,
        path,
        hops,
        length: Math.max(0, path.length - 1),
        quality: shaped.chain.quality || routeQuality({ path, hops }, shaped.stats, "start-lane"),
        savedAt: Date.now(),
      };
      const current = next.get(target);
      if (!current || fragment.length < current.length || fragment.savedAt > current.savedAt) {
        next.set(target, fragment);
      }
    }
    const fragments = [...next.values()]
      .map(fastLaneFragmentShape)
      .filter(Boolean)
      .sort((a, b) => a.length - b.length || b.savedAt - a.savedAt)
      .slice(0, START_LANE_FRAGMENT_LIMIT);
    await env.GAMES_CACHE.put(key, JSON.stringify({ start: shaped.start, range, fragments, updatedAt: Date.now() }), {
      expirationTtl: PAIR_CHAIN_TTL_SECONDS,
      metadata: { type: "start-lane", start: shaped.start, range },
    });
  }
}

async function readStartLaneFragments(env, start, range) {
  const cleanStart = cleanUsername(start);
  const ranges = [...new Set([cleanRange(range) || "auto", "auto", "6", "instant"])];
  const fragmentsByRange = await Promise.all(ranges.map((candidateRange) =>
    readStartLaneFragmentsForKey(env, startLaneKey(cleanStart, candidateRange)).catch(() => [])
  ));
  const fragments = fragmentsByRange.flat();
  const unique = new Map();
  for (const fragment of fragments) {
    if (!fragment || fragment.path?.[0] !== cleanStart) continue;
    const current = unique.get(fragment.target);
    if (!current || fragment.length < current.length || fragment.savedAt > current.savedAt) {
      unique.set(fragment.target, fragment);
    }
  }
  return [...unique.values()].sort((a, b) => a.length - b.length || b.savedAt - a.savedAt).slice(0, START_LANE_FRAGMENT_LIMIT);
}

async function readStartLaneFragmentsForKey(env, key) {
  const record = await env.GAMES_CACHE.get(key, { type: "json", cacheTtl: 60 });
  const fragments = Array.isArray(record?.fragments) ? record.fragments : [];
  return fragments.map(fastLaneFragmentShape).filter(Boolean);
}

async function readExactFastLanePair(env, start, target, range) {
  const cleanStart = cleanUsername(start);
  const cleanTarget = cleanUsername(target);
  if (!cleanStart || !cleanTarget || cleanStart === cleanTarget) return null;
  const fragments = await readFastLaneFragments(env, cleanTarget, range);
  const exact = fragments
    .filter((fragment) =>
      fragment?.target === cleanTarget &&
      fragment.path?.[0] === cleanStart &&
      fragment.path[fragment.path.length - 1] === cleanTarget &&
      cleanHopList(fragment.hops).length === fragment.path.length - 1)
    .sort((a, b) => a.length - b.length || b.savedAt - a.savedAt)[0];
  if (!exact) return null;
  const chain = {
    target: cleanTarget,
    display: cleanTarget,
    found: true,
    length: Math.max(0, exact.path.length - 1),
    path: exact.path,
    hops: cleanHopList(exact.hops),
    quality: exact.quality || routeQuality({ path: exact.path, hops: exact.hops }, { cached: 1, requests: 0, expanded: 0 }, "fast-lane"),
  };
  return pairChainShape({
    start: cleanStart,
    target: cleanTarget,
    range,
    chain,
    players: {},
    savedAt: exact.savedAt || Date.now(),
    checkedAt: Date.now(),
  }, cleanStart, cleanTarget, range);
}

async function readExactAnalyticsPair(env, start, target, range) {
  const cleanStart = cleanUsername(start);
  const cleanTarget = cleanUsername(target);
  if (!cleanStart || !cleanTarget || cleanStart === cleanTarget) return null;
  const events = normalizeAnalyticsEvents(await env.GAMES_CACHE.get(ANALYTICS_EVENTS_KEY, "json") || []);
  const candidates = events
    .filter((event) =>
      ["found", "saved"].includes(event.outcome) &&
      event.start === cleanStart &&
      event.target === cleanTarget &&
      Array.isArray(event.path) &&
      event.path.length >= 2)
    .sort((a, b) => (a.path.length - b.path.length) || b.ts - a.ts)
    .slice(0, 3);
  for (const event of candidates) {
    const path = normalizePath(cleanStart, cleanTarget, event.path);
    const storedHops = cleanHopList(event.hops);
    const hops = storedHops.length === path.length - 1
      ? storedHops
      : await verifyPathHopsFromCache(env, path);
    if (hops?.length !== path.length - 1) continue;
    const chain = {
      target: cleanTarget,
      display: cleanTarget,
      found: true,
      length: Math.max(0, path.length - 1),
      path,
      hops,
      quality: event.quality || routeQuality({ path, hops }, { cached: 2, requests: 0, expanded: 0 }, "saved"),
    };
    return pairChainShape({
      start: cleanStart,
      target: cleanTarget,
      range,
      chain,
      players: {},
      savedAt: event.ts || Date.now(),
      checkedAt: Date.now(),
    }, cleanStart, cleanTarget, range);
  }
  return null;
}

async function readStartLanePair(env, start, target, range) {
  const cleanStart = cleanUsername(start);
  const cleanTarget = cleanUsername(target);
  if (!cleanStart || !cleanTarget || cleanStart === cleanTarget) return null;
  const prefixes = await readStartLaneFragments(env, cleanStart, range);
  const exact = prefixes
    .filter((fragment) => fragment.target === cleanTarget && fragment.path[fragment.path.length - 1] === cleanTarget)
    .sort((a, b) => a.length - b.length || b.savedAt - a.savedAt)[0];
  if (exact) {
    return startLanePairShape({
      start: cleanStart,
      target: cleanTarget,
      range,
      path: exact.path,
      hops: exact.hops,
      source: "start-lane",
      savedAt: exact.savedAt,
    });
  }

  const suffixes = await readFastLaneFragments(env, cleanTarget, range);
  let best = null;
  for (const prefix of prefixes) {
    const hub = prefix.target;
    if (!hub || hub === cleanStart || hub === cleanTarget) continue;
    for (const suffix of suffixes) {
      if (suffix.path?.[0] !== hub) continue;
      const path = [...prefix.path, ...suffix.path.slice(1)];
      if (new Set(path).size !== path.length || path[0] !== cleanStart || path[path.length - 1] !== cleanTarget) continue;
      const hops = [...cleanHopList(prefix.hops), ...cleanHopList(suffix.hops)];
      if (hops.length !== path.length - 1) continue;
      const candidate = {
        start: cleanStart,
        target: cleanTarget,
        range,
        path,
        hops,
        source: "start-lane-bridge",
        savedAt: Math.max(Number(prefix.savedAt) || 0, Number(suffix.savedAt) || 0, Date.now()),
      };
      if (!best || candidate.path.length < best.path.length) best = candidate;
    }
  }
  return best ? startLanePairShape(best) : null;
}

function startLanePairShape({ start, target, range, path, hops, source, savedAt }) {
  const cleanHops = cleanHopList(hops);
  const chain = {
    target,
    display: target,
    found: true,
    length: Math.max(0, path.length - 1),
    path,
    hops: cleanHops,
    quality: routeQuality({ path, hops: cleanHops }, { cached: 2, requests: 0, expanded: 0 }, source),
  };
  return pairChainShape({
    start,
    target,
    range,
    chain,
    players: {},
    savedAt: savedAt || Date.now(),
    checkedAt: Date.now(),
  }, start, target, range);
}

async function readCachedBfsPair(env, start, target, range) {
  const cleanStart = cleanUsername(start);
  const cleanTarget = cleanUsername(target);
  if (!cleanStart || !cleanTarget || cleanStart === cleanTarget) return null;

  const archiveLimit = Math.min(6, archiveLimitForRange(range) || 6);
  const stats = { cached: 0, requests: 0, expanded: 0 };
  const deadline = Date.now() + STARTUP_CACHE_BFS_TIME_MS;
  const forwardVisited = new Map([[cleanStart, { prev: null, hopUrl: null }]]);
  const backwardVisited = new Map([[cleanTarget, { next: null, hopUrl: null }]]);
  let forwardFrontier = [cleanStart];
  let backwardFrontier = [cleanTarget];
  let depth = 0;
  let bestMeeting = null;
  let bestMeetingLength = Number.POSITIVE_INFINITY;

  const considerCachedMeeting = (candidate) => {
    const cleanCandidate = cleanUsername(candidate);
    if (!cleanCandidate) return;
    const chain = reconstructServerPath(cleanCandidate, forwardVisited, backwardVisited);
    const steps = chainStepCount(chain);
    if (steps < bestMeetingLength) {
      bestMeeting = cleanCandidate;
      bestMeetingLength = steps;
    }
  };

  const getEdges = async (username) => {
    return await readCachedEdges(env, { username, archiveLimit }, stats) || { beatenByMe: new Map(), beatMe: new Map() };
  };

  while (
    depth < SEARCH_MAX_DEPTH &&
    stats.expanded < STARTUP_CACHE_BFS_EXPANSIONS &&
    Date.now() < deadline &&
    (forwardFrontier.length || backwardFrontier.length)
  ) {
    const expandForward = forwardFrontier.length > 0 && (!backwardFrontier.length || forwardFrontier.length <= backwardFrontier.length);
    const source = uniqueUsernameList(expandForward ? forwardFrontier : backwardFrontier, STARTUP_CACHE_BFS_FRONTIER_LIMIT);
    if (!source.length) break;
    if (expandForward) forwardFrontier = [];
    else backwardFrontier = [];

    const nextFrontier = [];
    let cursor = 0;
    while (cursor < source.length && stats.expanded < STARTUP_CACHE_BFS_EXPANSIONS && Date.now() < deadline) {
      const remaining = Math.min(
        source.length - cursor,
        STARTUP_CACHE_BFS_EXPANSIONS - stats.expanded,
        SEARCH_EXPANSION_CONCURRENCY,
      );
      const batch = source.slice(cursor, cursor + remaining);
      cursor += batch.length;
      stats.expanded += batch.length;

      const edgeBatch = await runThrottled(batch.map((node) => async () => {
        try {
          return { node, edges: await withTimeout(getEdges(node), SEARCH_CACHE_EDGE_LOOKUP_TIMEOUT_MS) };
        } catch {
          return { node, edges: { beatenByMe: new Map(), beatMe: new Map() } };
        }
      }), SEARCH_EXPANSION_CONCURRENCY);

      for (const item of edgeBatch) {
        if (!item?.node || !item.edges) continue;
        const node = item.node;
        const edges = item.edges;
        if (expandForward) {
          for (const [opponent, urls] of edges.beatenByMe) {
            if (forwardVisited.has(opponent)) continue;
            forwardVisited.set(opponent, { prev: node, hopUrl: urls[0] });
            if (backwardVisited.has(opponent)) {
              considerCachedMeeting(opponent);
              continue;
            }
            if (nextFrontier.length < SEARCH_NEXT_FRONTIER_LIMIT) nextFrontier.push(opponent);
          }
        } else {
          for (const [opponent, urls] of edges.beatMe) {
            if (backwardVisited.has(opponent)) continue;
            backwardVisited.set(opponent, { next: node, hopUrl: urls[0] });
            if (forwardVisited.has(opponent)) {
              considerCachedMeeting(opponent);
              continue;
            }
            if (nextFrontier.length < SEARCH_NEXT_FRONTIER_LIMIT) nextFrontier.push(opponent);
          }
        }
      }
    }

    if (bestMeeting) {
      return cachedBfsPairShape({ start: cleanStart, target: cleanTarget, range, meeting: bestMeeting, forwardVisited, backwardVisited });
    }

    if (expandForward) forwardFrontier = nextFrontier;
    else backwardFrontier = nextFrontier;
    depth++;
  }

  return null;
}

function cachedBfsPairShape({ start, target, range, meeting, forwardVisited, backwardVisited }) {
  const chain = reconstructServerPath(meeting, forwardVisited, backwardVisited);
  if (!chain || chain.path[0] !== start || chain.path[chain.path.length - 1] !== target) return null;
  if (new Set(chain.path).size !== chain.path.length) return null;
  const hops = cleanHopList(chain.hops);
  if (hops.length !== chain.path.length - 1) return null;
  return pairChainShape({
    start,
    target,
    range,
    chain: {
      target,
      display: target,
      found: true,
      length: Math.max(0, chain.path.length - 1),
      path: chain.path,
      hops,
      quality: routeQuality({ path: chain.path, hops }, { cached: 2, requests: 0, expanded: 0 }, "cached-bfs"),
    },
    players: {},
    savedAt: Date.now(),
    checkedAt: Date.now(),
  }, start, target, range);
}

async function readGraphIndexPair(env, start, target, range) {
  const cleanStart = cleanUsername(start);
  const cleanTarget = cleanUsername(target);
  if (!cleanStart || !cleanTarget || cleanStart === cleanTarget) return null;
  const graph = graphIndexShape(await env.GAMES_CACHE.get(GRAPH_INDEX_KEY, { type: "json" }));
  const chain = graphIndexBfs(graph, cleanStart, cleanTarget);
  if (!chain) return null;
  return pairChainShape({
    start: cleanStart,
    target: cleanTarget,
    range,
    chain: {
      target: cleanTarget,
      display: cleanTarget,
      found: true,
      length: Math.max(0, chain.path.length - 1),
      path: chain.path,
      hops: cleanHopList(chain.hops),
      quality: routeQuality(chain, { cached: 2, requests: 0, expanded: 0 }, "graph-index"),
    },
    players: {},
    savedAt: graph.updatedAt || Date.now(),
    checkedAt: Date.now(),
  }, cleanStart, cleanTarget, range);
}

function graphIndexBfs(graph, start, target) {
  const nodes = graph?.nodes;
  if (!nodes?.[start] || !nodes?.[target]) return null;
  const forwardVisited = new Map([[start, { prev: null, hopUrl: null }]]);
  const backwardVisited = new Map([[target, { next: null, hopUrl: null }]]);
  let forwardFrontier = [start];
  let backwardFrontier = [target];
  let bestMeeting = null;
  let bestMeetingLength = Number.POSITIVE_INFINITY;

  const considerGraphMeeting = (candidate) => {
    const cleanCandidate = cleanUsername(candidate);
    if (!cleanCandidate) return;
    const chain = reconstructServerPath(cleanCandidate, forwardVisited, backwardVisited);
    const steps = chainStepCount(chain);
    if (steps < bestMeetingLength) {
      bestMeeting = cleanCandidate;
      bestMeetingLength = steps;
    }
  };

  for (let depth = 0; depth < SEARCH_MAX_DEPTH; depth++) {
    const expandForward = forwardFrontier.length > 0 && (!backwardFrontier.length || forwardFrontier.length <= backwardFrontier.length);
    const frontier = expandForward ? forwardFrontier : backwardFrontier;
    if (!frontier.length) break;
    const next = [];
    for (const node of frontier.slice(0, SEARCH_FRONTIER_LIMIT * 4)) {
      const rows = expandForward ? nodes[node]?.w : nodes[node]?.l;
      for (const row of Array.isArray(rows) ? rows : []) {
        const opponent = cleanUsername(row?.[0]);
        const url = cleanUrl(row?.[1]);
        if (!opponent || !url) continue;
        if (expandForward) {
          if (forwardVisited.has(opponent)) continue;
          forwardVisited.set(opponent, { prev: node, hopUrl: url });
          if (backwardVisited.has(opponent)) {
            considerGraphMeeting(opponent);
            continue;
          }
        } else {
          if (backwardVisited.has(opponent)) continue;
          backwardVisited.set(opponent, { next: node, hopUrl: url });
          if (forwardVisited.has(opponent)) {
            considerGraphMeeting(opponent);
            continue;
          }
        }
        next.push(opponent);
        if (next.length >= SEARCH_NEXT_FRONTIER_LIMIT) break;
      }
      if (next.length >= SEARCH_NEXT_FRONTIER_LIMIT) break;
    }
    if (bestMeeting) return reconstructServerPath(bestMeeting, forwardVisited, backwardVisited);
    if (expandForward) forwardFrontier = uniqueUsernameList(next, SEARCH_NEXT_FRONTIER_LIMIT);
    else backwardFrontier = uniqueUsernameList(next, SEARCH_NEXT_FRONTIER_LIMIT);
  }
  return null;
}

async function readCachedFastLanePair(env, start, target, range) {
  const cleanStart = cleanUsername(start);
  const cleanTarget = cleanUsername(target);
  if (!cleanStart || !cleanTarget || cleanStart === cleanTarget) return null;
  const archiveLimit = Math.min(6, archiveLimitForRange(range) || 6);
  const stats = { cached: 0, requests: 0, expanded: 0 };
  const startGames = await readCachedGames(env, { username: cleanStart, archiveLimit }, stats);
  if (!startGames) return null;
  const edges = edgesFromGames(cleanStart, startGames);
  const directUrls = edges.beatenByMe.get(cleanTarget);
  if (directUrls?.length) {
    const hops = await enrichHopsFromGames([
      { from: cleanStart, to: cleanTarget, url: directUrls[0] },
    ], startGames);
    return cachedFastLanePairShape({
      start: cleanStart,
      target: cleanTarget,
      range,
      source: "direct-cached-win",
      path: [cleanStart, cleanTarget],
      hops,
      savedAt: Date.now(),
    });
  }

  const fragments = await readFastLaneFragments(env, cleanTarget, range);
  let best = null;
  for (const fragment of fragments) {
    const connector = fragment.path?.[0];
    if (!connector || connector === cleanStart || connector === cleanTarget) continue;
    const urls = edges.beatenByMe.get(connector);
    if (!urls?.length) continue;
    const firstHop = (await enrichHopsFromGames([
      { from: cleanStart, to: connector, url: urls[0] },
    ], startGames))[0];
    const tailHops = cleanHopList(fragment.hops);
    const path = [cleanStart, ...fragment.path];
    const hops = [firstHop, ...tailHops];
    if (new Set(path).size !== path.length || hops.length !== path.length - 1) continue;
    const candidate = {
      start: cleanStart,
      target: cleanTarget,
      range,
      source: "cached-fast-lane",
      path,
      hops,
      savedAt: Math.max(Number(fragment.savedAt) || 0, Date.now()),
    };
    if (!best || candidate.path.length < best.path.length) best = candidate;
  }
  return best ? cachedFastLanePairShape(best) : null;
}

function cachedFastLanePairShape({ start, target, range, source, path, hops, savedAt }) {
  const chain = {
    target,
    display: target,
    found: true,
    length: Math.max(0, path.length - 1),
    path,
    hops: cleanHopList(hops),
    quality: routeQuality({ path, hops }, { cached: 2, requests: 0, expanded: 0 }, source),
  };
  return pairChainShape({
    start,
    target,
    range,
    chain,
    players: {},
    savedAt: savedAt || Date.now(),
    checkedAt: Date.now(),
  }, start, target, range);
}

async function readFastLaneFragmentsForKey(env, key) {
  const record = await env.GAMES_CACHE.get(key, { type: "json", cacheTtl: 60 });
  const fragments = Array.isArray(record?.fragments) ? record.fragments : [];
  return fragments.map(fastLaneFragmentShape).filter(Boolean);
}

function fastLaneKey(target, range) {
  return `fastlane:${cleanRange(range) || "auto"}:${cleanUsername(target)}`;
}

function startLaneKey(start, range) {
  return `startlane:${cleanRange(range) || "auto"}:${cleanUsername(start)}`;
}

function fastLaneFragmentShape(value) {
  if (!value || typeof value !== "object") return null;
  const target = cleanUsername(value.target);
  const path = Array.isArray(value.path) ? value.path.slice(0, 12).map(cleanUsername).filter(Boolean) : [];
  const hops = cleanHopList(value.hops);
  if (!target || path.length < 2 || path[path.length - 1] !== target || hops.length !== path.length - 1) return null;
  return {
    target,
    range: cleanRange(value.range) || "auto",
    path,
    hops,
    length: Math.max(0, path.length - 1),
    quality: qualityShape(value.quality),
    savedAt: Number.isFinite(value.savedAt) ? value.savedAt : Date.now(),
  };
}

function pairChainKey(start, target, range) {
  return `search:pair:${cleanUsername(start)}:${cleanUsername(target)}:${cleanRange(range) || "auto"}`;
}

function pairChainShape(record, start, target, range) {
  if (!record || typeof record !== "object") return null;
  const chain = chainShape(record.chain, target);
  if (!chain?.found || !Array.isArray(chain.path) || chain.path.length < 2) return null;
  const normalizedStart = cleanUsername(start || record.start);
  const normalizedTarget = cleanUsername(target || record.target || chain.target);
  const normalizedRange = cleanRange(range || record.range) || "auto";
  const path = normalizePath(normalizedStart, normalizedTarget, chain.path);
  const hops = Array.isArray(chain.hops)
    ? chain.hops.filter((hop) => hop.from && hop.to && path.includes(hop.from) && path.includes(hop.to))
    : [];
  if (!normalizedStart || !normalizedTarget || path[0] !== normalizedStart || path[path.length - 1] !== normalizedTarget) {
    return null;
  }
  return {
    start: normalizedStart,
    target: normalizedTarget,
    range: normalizedRange,
    chain: {
      ...chain,
      target: normalizedTarget,
      length: Math.max(0, path.length - 1),
      path,
      hops: hops.length === path.length - 1 ? hops : chain.hops,
    },
    players: record.players && typeof record.players === "object" ? record.players : {},
    savedAt: Number.isFinite(record.savedAt) ? record.savedAt : Date.now(),
    checkedAt: Number.isFinite(record.checkedAt) ? record.checkedAt : null,
  };
}

function chainShape(rawChain, target) {
  if (!rawChain || typeof rawChain !== "object") return null;
  const normalizedTarget = cleanUsername(rawChain.target || target);
  const path = Array.isArray(rawChain.path) ? rawChain.path.slice(0, 12).map(cleanUsername).filter(Boolean) : [];
  const hops = cleanHopList(rawChain.hops);
  return {
    target: normalizedTarget,
    display: String(rawChain.display || normalizedTarget).slice(0, 80),
    found: Boolean(rawChain.found),
    length: Number.isFinite(rawChain.length) ? Math.max(0, Math.min(12, rawChain.length)) : Math.max(0, path.length - 1),
    path,
    hops,
    quality: qualityShape(rawChain.quality),
  };
}

function searchJobShape(job) {
  if (!job || typeof job !== "object") return null;
  const id = cleanAnalyticsId(job.id);
  const start = cleanUsername(job.start);
  const target = cleanUsername(job.target);
  if (!id || !start || !target || start === target) return null;
  const status = ["queued", "running", "found", "not_found", "timeout", "failed", "expired"].includes(job.status)
    ? job.status
    : "queued";
  const stats = job.stats && typeof job.stats === "object" ? job.stats : {};
  const chain = job.chain && typeof job.chain === "object"
    ? {
        target: cleanUsername(job.chain.target || target),
        display: String(job.chain.display || job.chain.target || target).slice(0, 80),
        found: Boolean(job.chain.found),
        length: Number.isFinite(job.chain.length) ? Math.max(0, Math.min(12, job.chain.length)) : null,
        path: Array.isArray(job.chain.path) ? job.chain.path.slice(0, 12).map(cleanUsername).filter(Boolean) : [],
        hops: cleanHopList(job.chain.hops),
        quality: qualityShape(job.chain.quality),
      }
    : null;
  const players = job.players && typeof job.players === "object" ? job.players : {};
  return {
    id,
    start,
    target,
    range: cleanRange(job.range) || "auto",
    depth: Number.isFinite(job.depth) ? Math.max(1, Math.min(SEARCH_MAX_DEPTH, job.depth)) : SEARCH_MAX_DEPTH,
    status,
    outcome: analyticsOutcomeFilter(job.outcome) || statusToOutcome(status),
    progress: String(job.progress || "").slice(0, 180),
    error: String(job.error || "").slice(0, 240),
    stats: {
      fetched: cleanNonNegativeNumber(stats.fetched, 100000) || 0,
      requests: cleanNonNegativeNumber(stats.requests, 100000) || 0,
      cached: cleanNonNegativeNumber(stats.cached, 100000) || 0,
      expanded: cleanNonNegativeNumber(stats.expanded, 100000) || 0,
    },
    chain,
    players,
    createdAt: Number.isFinite(job.createdAt) ? job.createdAt : Date.now(),
    startedAt: Number.isFinite(job.startedAt) ? job.startedAt : null,
    updatedAt: Number.isFinite(job.updatedAt) ? job.updatedAt : Date.now(),
    processingUntil: Number.isFinite(job.processingUntil) ? Math.max(0, job.processingUntil) : 0,
    processingToken: cleanAnalyticsId(job.processingToken),
    refreshCached: Boolean(job.refreshCached),
    cachedAt: Number.isFinite(job.cachedAt) ? job.cachedAt : null,
    durationMs: cleanNonNegativeNumber(job.durationMs, 10 * 60 * 1000),
    searchInitialized: Boolean(job.search && typeof job.search === "object"),
    search: searchStateShape(job.search, start, target),
  };
}

function publicSearchJob(job) {
  const shaped = searchJobShape(job);
  if (!shaped) return null;
  return {
    id: shaped.id,
    start: shaped.start,
    target: shaped.target,
    range: shaped.range,
    status: shaped.status,
    outcome: shaped.outcome,
    progress: shaped.progress,
    error: shaped.error,
    stats: shaped.stats,
    chain: shaped.chain,
    players: shaped.players,
    refreshCached: shaped.refreshCached,
    cachedAt: shaped.cachedAt,
    createdAt: shaped.createdAt,
    updatedAt: shaped.updatedAt,
    durationMs: shaped.durationMs,
    quality: shaped.chain?.quality || null,
  };
}

function publicSearchJobShape(job) {
  if (!job || typeof job !== "object") return null;
  const id = cleanAnalyticsId(job.id);
  const start = cleanUsername(job.start);
  const target = cleanUsername(job.target);
  if (!id || !start || !target) return null;
  const stats = job.stats && typeof job.stats === "object" ? job.stats : {};
  return {
    id,
    start,
    target,
    range: cleanRange(job.range) || "auto",
    status: isActiveSearchStatus(job.status) || ["found", "not_found", "timeout", "failed", "expired"].includes(job.status)
      ? job.status
      : "running",
    outcome: analyticsOutcomeFilter(job.outcome) || statusToOutcome(job.status),
    progress: String(job.progress || "").slice(0, 180),
    error: String(job.error || "").slice(0, 240),
    stats: {
      fetched: cleanNonNegativeNumber(stats.fetched, 100000) || 0,
      requests: cleanNonNegativeNumber(stats.requests, 100000) || 0,
      cached: cleanNonNegativeNumber(stats.cached, 100000) || 0,
      expanded: cleanNonNegativeNumber(stats.expanded, 100000) || 0,
    },
    chain: job.chain && typeof job.chain === "object" ? publicSearchJob({ ...job, start, target }).chain : null,
    players: job.players && typeof job.players === "object" ? job.players : {},
    refreshCached: Boolean(job.refreshCached),
    cachedAt: Number.isFinite(job.cachedAt) ? job.cachedAt : null,
    createdAt: Number.isFinite(job.createdAt) ? job.createdAt : Date.now(),
    updatedAt: Number.isFinite(job.updatedAt) ? job.updatedAt : Date.now(),
    durationMs: cleanNonNegativeNumber(job.durationMs, 10 * 60 * 1000),
    quality: qualityShape(job.quality) || qualityShape(job.chain?.quality),
  };
}

function cleanHopList(value) {
  return Array.isArray(value) ? value.slice(0, 11).map((hop) => ({
    from: cleanUsername(hop?.from),
    to: cleanUsername(hop?.to),
    url: cleanUrl(hop?.url),
    timeClass: String(hop?.timeClass || "").slice(0, 20),
    endTime: cleanProofTimestamp(hop?.endTime),
    result: String(hop?.result || "").slice(0, 20),
    color: ["white", "black"].includes(String(hop?.color || "").toLowerCase()) ? String(hop.color).toLowerCase() : "",
    opening: String(hop?.opening || "").slice(0, 90),
  })).filter((hop) => hop.from && hop.to && hop.url) : [];
}

function routeQuality(chain, stats = {}, source = "fresh-search") {
  const steps = chainStepCount(chain);
  const hops = cleanHopList(chain?.hops);
  const requests = cleanNonNegativeNumber(stats?.requests, 100000) || 0;
  const cached = cleanNonNegativeNumber(stats?.cached, 100000) || 0;
  const proofs = hops.filter((hop) => hop.url).length;
  const datedProofs = hops.filter((hop) => cleanProofTimestamp(hop.endTime)).length;
  const newest = hops.reduce((max, hop) => Math.max(max, cleanProofTimestamp(hop.endTime) || 0), 0);
  const ageDays = newest ? Math.max(0, Math.round((Date.now() / 1000 - newest) / 86400)) : null;
  let score = 100;
  score -= Math.max(0, steps - 1) * 7;
  score -= Math.min(18, Math.floor(requests / 25));
  score += Math.min(8, Math.floor(cached / 20));
  if (proofs < Math.max(0, steps)) score -= 18;
  if (datedProofs < proofs) score -= 6;
  if (source === "saved" || source === "fast-lane") score += 3;
  if (Number.isFinite(ageDays)) score -= Math.min(18, Math.floor(ageDays / 45));
  score = Math.max(0, Math.min(100, Math.round(score)));
  return {
    score,
    label: qualityLabel(score),
    source: String(source || "fresh-search").slice(0, 32),
    proofs,
    ageDays,
  };
}

function qualityLabel(score) {
  if (score >= 86) return "Excellent";
  if (score >= 72) return "Strong";
  if (score >= 56) return "Good";
  return "Needs fresher proof";
}

function qualityShape(value) {
  if (!value || typeof value !== "object") return null;
  const score = cleanNonNegativeNumber(value.score, 100);
  if (!Number.isFinite(score)) return null;
  return {
    score,
    label: ["Excellent", "Strong", "Good", "Needs fresher proof"].includes(value.label)
      ? value.label
      : qualityLabel(score),
    source: String(value.source || "").slice(0, 32),
    proofs: cleanNonNegativeNumber(value.proofs, 20),
    ageDays: cleanNonNegativeNumber(value.ageDays, 100000),
  };
}

function isActiveSearchStatus(status) {
  return status === "queued" || status === "running";
}

function initialSearchState(start, target) {
  return {
    profileChecked: false,
    fastLaneChecked: false,
    depth: 0,
    forwardVisited: { [start]: { prev: "", hopUrl: "" } },
    backwardVisited: { [target]: { next: "", hopUrl: "" } },
    forwardFrontier: [start],
    backwardFrontier: [target],
    activeSide: "",
    activeFrontier: [],
    activeCursor: 0,
    activeNextFrontier: [],
    bestMeeting: "",
    bestMeetingLength: 0,
  };
}

function searchStateShape(state, start, target) {
  const base = initialSearchState(start, target);
  if (!state || typeof state !== "object") return base;
  const forwardVisited = cleanVisitedObject(state.forwardVisited, "forward");
  const backwardVisited = cleanVisitedObject(state.backwardVisited, "backward");
  if (!forwardVisited[start]) forwardVisited[start] = { prev: "", hopUrl: "" };
  if (!backwardVisited[target]) backwardVisited[target] = { next: "", hopUrl: "" };
  const activeSide = ["forward", "backward"].includes(state.activeSide) ? state.activeSide : "";
  return {
    profileChecked: Boolean(state.profileChecked),
    fastLaneChecked: Boolean(state.fastLaneChecked),
    depth: cleanNonNegativeNumber(state.depth, SEARCH_MAX_DEPTH + 1) || 0,
    forwardVisited,
    backwardVisited,
    forwardFrontier: cleanUsernameList(state.forwardFrontier, SEARCH_NEXT_FRONTIER_LIMIT),
    backwardFrontier: cleanUsernameList(state.backwardFrontier, SEARCH_NEXT_FRONTIER_LIMIT),
    activeSide,
    activeFrontier: activeSide ? cleanUsernameList(state.activeFrontier, SEARCH_FRONTIER_LIMIT) : [],
    activeCursor: cleanNonNegativeNumber(state.activeCursor, SEARCH_FRONTIER_LIMIT) || 0,
    activeNextFrontier: activeSide ? cleanUsernameList(state.activeNextFrontier, SEARCH_NEXT_FRONTIER_LIMIT) : [],
    bestMeeting: activeSide ? cleanUsername(state.bestMeeting) : "",
    bestMeetingLength: activeSide ? cleanNonNegativeNumber(state.bestMeetingLength, SEARCH_MAX_DEPTH * 2 + 2) || 0 : 0,
  };
}

function cleanUsernameList(value, max) {
  if (!Array.isArray(value)) return [];
  return uniqueUsernameList(value.map(cleanUsername).filter(Boolean), max);
}

function uniqueUsernameList(value, max) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(value) ? value : []) {
    const username = cleanUsername(item);
    if (!username || seen.has(username)) continue;
    seen.add(username);
    out.push(username);
    if (out.length >= max) break;
  }
  return out;
}

function cleanVisitedObject(value, side) {
  const out = {};
  if (!value || typeof value !== "object") return out;
  for (const [rawUsername, rawInfo] of Object.entries(value)) {
    const username = cleanUsername(rawUsername);
    if (!username) continue;
    const info = rawInfo && typeof rawInfo === "object" ? rawInfo : {};
    out[username] = side === "forward"
      ? {
          prev: cleanUsername(info.prev),
          hopUrl: cleanUrl(info.hopUrl),
        }
      : {
          next: cleanUsername(info.next),
          hopUrl: cleanUrl(info.hopUrl),
        };
    if (Object.keys(out).length >= SEARCH_VISITED_LIMIT) break;
  }
  return out;
}

function visitedObjectToMap(value) {
  const map = new Map();
  for (const [username, info] of Object.entries(value || {})) {
    map.set(username, { ...info });
  }
  return map;
}

function visitedMapToObject(map) {
  const out = {};
  for (const [username, info] of map.entries()) {
    const key = cleanUsername(username);
    if (!key) continue;
    out[key] = {
      prev: cleanUsername(info?.prev),
      next: cleanUsername(info?.next),
      hopUrl: cleanUrl(info?.hopUrl),
    };
    if (Object.keys(out).length >= SEARCH_VISITED_LIMIT) break;
  }
  return out;
}

function searchJobAnalyticsEvent(job) {
  const shaped = searchJobShape(job);
  if (!shaped) return null;
  return {
    id: shaped.id,
    jobId: shaped.id,
    ts: Date.now(),
    outcome: shaped.outcome,
    start: shaped.start,
    target: shaped.target,
    depth: shaped.depth,
    range: shaped.range,
    length: shaped.chain?.length ?? null,
    steps: Array.isArray(shaped.chain?.path) && shaped.chain.path.length >= 2
      ? shaped.chain.path.length - 1
      : null,
    path: Array.isArray(shaped.chain?.path) ? shaped.chain.path : [],
    hops: cleanHopList(shaped.chain?.hops),
    durationMs: shaped.durationMs,
    expanded: shaped.stats.expanded,
    requests: shaped.stats.requests,
    cached: shaped.stats.cached,
    error: shaped.error,
    quality: shaped.chain?.quality || null,
    country: "",
    device: "server",
  };
}

function statusToOutcome(status) {
  if (status === "found") return "found";
  if (status === "not_found") return "not_found";
  if (status === "timeout") return "timeout";
  if (status === "failed") return "error";
  return "started";
}

function analyticsEventShape(body, request) {
  const start = cleanUsername(body?.start);
  const target = cleanUsername(body?.target);
  if (!start || !target || start === target) return null;
  const id = cleanAnalyticsId(body?.searchId || body?.id) || crypto.randomUUID();

  const rawPath = Array.isArray(body?.path)
    ? body.path.slice(0, 12).map(cleanUsername).filter(Boolean)
    : [];
  const path = rawPath.length >= 2 ? normalizePath(start, target, rawPath) : [];
  const rawDepth = parseInt(body?.depth, 10);
  const rawSteps = parseInt(body?.steps, 10);
  const rawLength = parseInt(body?.length, 10);
  const steps = path.length >= 2
    ? path.length - 1
    : Number.isFinite(rawSteps)
      ? Math.max(0, Math.min(12, rawSteps))
      : null;
  const length = path.length >= 2
    ? connectionCount(path, rawLength)
    : Number.isFinite(rawLength)
      ? Math.max(0, Math.min(10, rawLength))
      : null;
  const hops = cleanHopList(body?.hops);

  return {
    id,
    ts: Date.now(),
    outcome: analyticsOutcome(body?.outcome),
    start,
    target,
    depth: Number.isFinite(rawDepth) ? Math.max(1, Math.min(5, rawDepth)) : null,
    range: cleanRange(body?.range),
    length,
    steps,
    path,
    hops: hops.length === path.length - 1 ? hops : [],
    jobId: cleanAnalyticsId(body?.jobId || body?.searchId || body?.id),
    durationMs: cleanNonNegativeNumber(body?.durationMs, 10 * 60 * 1000),
    expanded: cleanNonNegativeNumber(body?.expanded, 100000),
    requests: cleanNonNegativeNumber(body?.requests, 100000),
    cached: cleanNonNegativeNumber(body?.cached, 100000),
    error: String(body?.error || "").slice(0, 240),
    quality: qualityShape(body?.quality),
    country: cleanCountry(request.cf?.country),
    device: deviceLabel(request.headers.get("User-Agent") || ""),
  };
}

function normalizeAnalyticsEvents(events) {
  if (!Array.isArray(events)) return [];
  return events
    .map((event) => {
      const start = cleanUsername(event?.start);
      const target = cleanUsername(event?.target);
      if (!start || !target || start === target) return null;
      const path = Array.isArray(event.path)
        ? event.path.slice(0, 12).map(cleanUsername).filter(Boolean)
        : [];
      const normalizedPath = path.length >= 2 ? normalizePath(start, target, path) : [];
      const hops = cleanHopList(event.hops);
      return {
        id: cleanAnalyticsId(event.id) || crypto.randomUUID(),
        ts: Number.isFinite(event.ts) ? event.ts : Date.now(),
        firstTs: Number.isFinite(event.firstTs) ? event.firstTs : null,
        outcome: analyticsOutcome(event.outcome),
        start,
        target,
        depth: Number.isFinite(event.depth) ? Math.max(1, Math.min(5, event.depth)) : null,
        range: cleanRange(event.range),
        length: Number.isFinite(event.length) ? Math.max(0, Math.min(10, event.length)) : null,
        steps: Number.isFinite(event.steps) ? Math.max(0, Math.min(12, event.steps)) : null,
        path: normalizedPath,
        hops: hops.length === normalizedPath.length - 1 ? hops : [],
        jobId: cleanAnalyticsId(event.jobId) || "",
        durationMs: cleanNonNegativeNumber(event.durationMs, 10 * 60 * 1000),
        expanded: cleanNonNegativeNumber(event.expanded, 100000),
        requests: cleanNonNegativeNumber(event.requests, 100000),
        cached: cleanNonNegativeNumber(event.cached, 100000),
        error: String(event.error || "").slice(0, 240),
        quality: qualityShape(event.quality),
        country: cleanCountry(event.country),
        device: deviceLabel(event.device || ""),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_ANALYTICS_EVENTS);
}

function cleanAnalyticsId(value) {
  const clean = String(value || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  return clean.length >= 8 ? clean : "";
}

function analyticsOutcome(value) {
  const clean = String(value || "started").toLowerCase().replace(/-/g, "_");
  return ["started", "saved", "found", "not_found", "timeout", "error"].includes(clean)
    ? clean
    : "started";
}

function analyticsOutcomeFilter(value) {
  const clean = String(value || "").toLowerCase().replace(/-/g, "_");
  return ["started", "saved", "found", "not_found", "timeout", "error"].includes(clean)
    ? clean
    : "";
}

function cleanNonNegativeNumber(value, max) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(max, Math.round(number))) : null;
}

function cleanProofTimestamp(value) {
  const seconds = cleanNonNegativeNumber(value, 4102444800);
  return Number.isFinite(seconds) && seconds >= 1167609600 ? seconds : null;
}

function cleanRange(value) {
  const clean = String(value || "").toLowerCase().trim().replace(/[^a-z0-9_-]/g, "");
  return ["auto", "instant", "6", "12", "all"].includes(clean) ? clean : "";
}

function cleanLeaderboardCategory(value) {
  const clean = String(value || "connectors").toLowerCase().trim().replace(/[^a-z_]/g, "");
  return ["connectors", "fastest", "top_targets", "searched", "recent"].includes(clean)
    ? clean
    : "connectors";
}

function isBlockedUsername(username) {
  return BLOCKED_USERNAMES.has(cleanUsername(username));
}

function pathHasBlockedUser(path) {
  return Array.isArray(path) && path.some(isBlockedUsername);
}

function cleanTimestampMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const ms = number < 10000000000 ? number * 1000 : number;
  return ms > 0 && ms < 4102444800000 ? Math.round(ms) : null;
}

function cleanCountry(value) {
  const clean = String(value || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2);
  return /^[A-Z]{2}$/.test(clean) ? clean : "";
}

function cleanUrl(value) {
  const text = String(value || "").trim();
  return /^https:\/\/www\.chess\.com\/game\//i.test(text) ? text.slice(0, 240) : "";
}

function cleanHttpUrl(value) {
  const text = String(value || "").trim();
  return /^https?:\/\//i.test(text) ? text.slice(0, 300) : "";
}

function cleanShareId(value) {
  const clean = String(value || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  return clean.length >= 8 ? clean : "";
}

function countryFromProfile(value) {
  const text = String(value || "");
  return text.includes("/") ? text.split("/").pop() : text;
}

function base64UrlBytes(bytes) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function deviceLabel(value) {
  const text = String(value || "").toLowerCase();
  if (!text) return "";
  if (text.includes("tablet") || text.includes("ipad")) return "tablet";
  if (text.includes("mobi") || text.includes("iphone") || text.includes("android")) return "mobile";
  if (["desktop", "mobile", "tablet", "server"].includes(text)) return text;
  return "desktop";
}

function ownerAuthorized(request, env) {
  const expected = String(env.OWNER_CODE || "");
  const provided = String(request.headers.get("X-Owner-Code") || "");
  return Boolean(expected) && safeEqual(provided, expected);
}

function safeEqual(leftValue, rightValue) {
  const left = String(leftValue || "");
  const right = String(rightValue || "");
  const max = Math.max(left.length, right.length, 1);
  let diff = left.length ^ right.length;
  for (let i = 0; i < max; i++) {
    diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function parseGameCacheKey(key) {
  const normalized = key.toLowerCase();
  const allMatch = normalized.match(/^([a-z0-9_-]{2,50}):all$/);
  if (allMatch) return { username: allMatch[1], archiveLimit: Infinity };
  const match = normalized.match(/^([a-z0-9_-]{2,50}):recent:(\d{1,2})$/);
  if (!match) return null;
  const archiveLimit = Math.max(1, Math.min(12, Number(match[2])));
  return { username: match[1], archiveLimit };
}

async function fetchGames({ username, archiveLimit }) {
  let archiveData;
  try {
    archiveData = await fetchJSON(`${CHESS_API}${username}/games/archives`);
  } catch (error) {
    if (isMissingArchivesError(error)) return [];
    throw error;
  }
  const archives = Array.isArray(archiveData.archives) ? archiveData.archives : [];
  const selectedArchives = Number.isFinite(archiveLimit)
    ? archives.slice(-archiveLimit)
    : archives;
  const results = await runThrottled(
    selectedArchives.map((archiveUrl) => async () => {
      try {
        return await fetchJSON(archiveUrl);
      } catch (error) {
        if (isRateLimitError(error)) throw error;
        return { games: [] };
      }
    }),
    ARCHIVE_CONCURRENCY,
  );

  const games = [];
  for (const data of results) {
    for (const game of data.games || []) {
      if (game.rules !== "chess") continue;
      games.push({
        white: (game.white?.username || "").toLowerCase(),
        black: (game.black?.username || "").toLowerCase(),
        whiteResult: game.white?.result,
        blackResult: game.black?.result,
        url: game.url,
        timeClass: game.time_class,
        endTime: cleanProofTimestamp(game.end_time),
        opening: game.eco || game.eco_url || "",
      });
    }
  }
  return games;
}

function profileShape(data, fallbackUsername) {
  const username = cleanUsername(data?.username || fallbackUsername);
  const countryUrl = typeof data?.country === "string" ? data.country : "";
  const country = countryUrl ? countryUrl.split("/").pop() : "";
  return {
    username,
    name: String(data?.name || ""),
    title: String(data?.title || ""),
    avatar: String(data?.avatar || ""),
    url: String(data?.url || `https://www.chess.com/member/${username}`),
    country,
    location: String(data?.location || ""),
    fide: Number.isFinite(data?.fide) ? data.fide : null,
    playerId: Number.isFinite(data?.player_id) ? data.player_id : null,
    isStreamer: Boolean(data?.is_streamer),
    twitchUrl: String(data?.twitch_url || ""),
    followers: Number.isFinite(data?.followers) ? data.followers : null,
    joined: Number.isFinite(data?.joined) ? data.joined : null,
    lastOnline: Number.isFinite(data?.last_online) ? data.last_online : null,
    status: String(data?.status || ""),
  };
}

async function fetchProfileDetails(username, env = null) {
  const data = await fetchJSON(`${CHESS_API}${username}`);
  const profile = profileShape(data, username);
  try {
    const stats = await fetchJSON(`${CHESS_API}${username}/stats`);
    profile.stats = statsShape(stats);
  } catch {
    profile.stats = {};
  }
  if (env) {
    try {
      profile.recentGames = await fetchRecentProfileGames(env, username);
    } catch {
      profile.recentGames = [];
    }
  }
  return profile;
}

async function fetchRecentProfileGames(env, username) {
  const games = await readOrFetchGames(env, { username, archiveLimit: 2 });
  return games
    .filter((game) => game.white === username || game.black === username)
    .sort((a, b) => (b.endTime || 0) - (a.endTime || 0))
    .slice(0, 5)
    .map((game) => recentGameShape(game, username))
    .filter(Boolean);
}

function recentGameShape(game, username) {
  const isWhite = game.white === username;
  const opponent = isWhite ? game.black : game.white;
  if (!opponent) return null;
  const mine = isWhite ? game.whiteResult : game.blackResult;
  const theirs = isWhite ? game.blackResult : game.whiteResult;
  const result = mine === "win"
    ? "win"
    : theirs === "win"
      ? "loss"
      : "draw";
  return {
    opponent,
    result,
    color: isWhite ? "white" : "black",
    timeClass: String(game.timeClass || ""),
    url: String(game.url || ""),
    endTime: cleanProofTimestamp(game.endTime),
  };
}

function statsShape(stats) {
  return {
    rapid: gameStatShape(stats?.chess_rapid),
    blitz: gameStatShape(stats?.chess_blitz),
    bullet: gameStatShape(stats?.chess_bullet),
  };
}

function gameStatShape(stat) {
  if (!stat || typeof stat !== "object") return null;
  const record = stat.record || {};
  const games = ["win", "loss", "draw"].reduce((sum, key) =>
    sum + (Number.isFinite(record[key]) ? record[key] : 0), 0);
  return {
    rating: Number.isFinite(stat.last?.rating) ? stat.last.rating : null,
    best: Number.isFinite(stat.best?.rating) ? stat.best.rating : null,
    games: games || null,
    wins: Number.isFinite(record.win) ? record.win : null,
    losses: Number.isFinite(record.loss) ? record.loss : null,
    draws: Number.isFinite(record.draw) ? record.draw : null,
  };
}

function suggestionShape(data, source = "cloudflare") {
  const username = cleanUsername(data?.username);
  if (!username) return null;
  return {
    username,
    name: String(data?.name || data?.display || ""),
    title: String(data?.title || ""),
    avatar: String(data?.avatar || ""),
    url: String(data?.url || `https://www.chess.com/member/${username}`),
    country: String(data?.country || ""),
    followers: Number.isFinite(data?.followers) ? data.followers : null,
    status: String(data?.status || ""),
    source: "",
    score: Number.isFinite(data?.score) ? data.score : null,
    rank: Number.isFinite(data?.rank) ? data.rank : null,
  };
}

async function readOrFetchProfile(env, username) {
  const cached = await readCachedProfile(env, username);
  if (cached) return cached;
  try {
    const data = await fetchJSON(`${CHESS_API}${username}`);
    const profile = profileShape(data, username);
    await env.GAMES_CACHE.put(`profile:${username}`, JSON.stringify({ ts: Date.now(), profile }), {
      expirationTtl: KV_RETENTION_SECONDS,
      metadata: { username, type: "profile" },
    });
    return profile;
  } catch {
    return null;
  }
}

async function readCachedProfile(env, username) {
  const cached = await env.GAMES_CACHE.get(`profile:${username}`, { type: "json", cacheTtl: 60 });
  return cached?.profile && typeof cached.profile === "object" ? cached.profile : null;
}

async function addProfilesFromKV(env, query, seen, maxCandidates) {
  let cursor;
  let pages = 0;
  do {
    const listed = await env.GAMES_CACHE.list({ prefix: "profile:", limit: 1000, cursor });
    for (const key of listed.keys || []) {
      const username = cleanUsername(key.name.replace(/^profile:/, ""));
      if (!username || !username.includes(query)) continue;
      const profile = await readCachedProfile(env, username);
      if (isBlockedUsername(username)) continue;
      seen.set(username, suggestionShape(profile || { username }, "cloudflare cache"));
      if (seen.size >= maxCandidates) return;
    }
    cursor = listed.cursor;
    pages++;
  } while (cursor && pages < 3 && seen.size < maxCandidates);
}

async function addLeaderboardSuggestions(query, seen, maxCandidates) {
  if (seen.size >= maxCandidates) return;
  try {
    const data = await fetchJSON("https://api.chess.com/pub/leaderboards");
    const groups = [
      ["live_rapid", "Rapid leaderboard"],
      ["live_blitz", "Blitz leaderboard"],
      ["live_bullet", "Bullet leaderboard"],
    ];
    for (const [key, source] of groups) {
      const rows = Array.isArray(data?.[key]) ? data[key] : [];
      for (const row of rows.slice(0, 25)) {
        if (isBlockedUsername(row.username)) continue;
        const item = suggestionShape({
          username: row.username,
          name: row.name,
          title: row.title,
          avatar: row.avatar,
          url: row.url,
          score: row.score,
          rank: row.rank,
        }, source);
        if (!item || isBlockedUsername(item.username) || !matchesSuggestion(item, query)) continue;
        seen.set(item.username, item);
        if (seen.size >= maxCandidates) return;
      }
    }
  } catch {
    // Suggestions are best-effort; cached/profile matches still work.
  }
}

async function addTitledSuggestions(env, query, seen, maxCandidates) {
  if (seen.size >= maxCandidates) return;
  for (const title of TITLED_GROUPS) {
    const players = await readTitledPlayers(env, title);
    for (const username of players) {
      const key = cleanUsername(username);
      if (!key || isBlockedUsername(key) || !key.includes(query) || seen.has(key)) continue;
      const item = suggestionShape({ username: key, title }, "");
      if (item) seen.set(item.username, item);
      if (seen.size >= maxCandidates) return;
    }
  }
}

async function readTitledPlayers(env, title) {
  const key = `titled:${title.toLowerCase()}`;
  try {
    const cached = await env.GAMES_CACHE.get(key, { type: "json", cacheTtl: 300 });
    if (Array.isArray(cached?.players)) return cached.players;
  } catch {
    // Continue to live fetch.
  }
  try {
    const data = await fetchJSON(`https://api.chess.com/pub/titled/${title}`);
    const players = Array.isArray(data?.players) ? data.players.map(cleanUsername).filter(Boolean) : [];
    await env.GAMES_CACHE.put(key, JSON.stringify({ ts: Date.now(), players }), {
      expirationTtl: KV_RETENTION_SECONDS,
      metadata: { title, type: "titled" },
    });
    return players;
  } catch {
    return [];
  }
}

function matchesSuggestion(item, query) {
  return item.username.includes(query) || String(item.name || "").toLowerCase().includes(query);
}

function suggestionScore(item, query) {
  let score = 0;
  if (item.username === query) score += 1000;
  if (item.username.startsWith(query)) score += 500;
  if (String(item.name || "").toLowerCase().startsWith(query)) score += 250;
  if (item.avatar) score += 60;
  if (item.title) score += 30;
  if (Number.isFinite(item.rank)) score += Math.max(0, 30 - item.rank);
  if (Number.isFinite(item.followers)) score += Math.min(40, Math.log10(item.followers + 1) * 8);
  return score;
}

async function fetchJSON(url) {
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response;
    try {
      response = await fetch(url, {
        headers: {
          "Accept": "application/json",
          "User-Agent": "chess-connections-cache/1.0",
        },
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeout);
      if (attempt < FETCH_RETRIES && error?.name === "AbortError") {
        await delay(FETCH_BACKOFF_MS * (attempt + 1));
        continue;
      }
      throw error;
    }
    clearTimeout(timeout);
    if (response.ok) {
      return response.json();
    }

    const retryAfter = parseRetryAfter(response.headers);
    const canRetry =
      attempt < FETCH_RETRIES &&
      (response.status >= 500 || (response.status === 429 && retryAfter <= 2));

    if (!canRetry) {
      throw new UpstreamHTTPError(response.status, url, retryAfter);
    }

    await delay(retryAfter ? retryAfter * 1000 : FETCH_BACKOFF_MS * (attempt + 1));
  }

  throw new Error(`Failed to fetch ${url}`);
}

async function runThrottled(tasks, concurrency) {
  const results = new Array(tasks.length);
  let next = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]();
    }
  });
  await Promise.all(workers);
  return results;
}

function cleanUsername(value) {
  return String(value || "").toLowerCase().trim().replace(/[^a-z0-9_-]/g, "").slice(0, 40);
}

function cleanPartialUsername(value) {
  return String(value || "").toLowerCase().trim().replace(/[^a-z0-9_-]/g, "").slice(0, 50);
}

function normalizePath(start, target, path) {
  const clean = path.filter(Boolean);
  if (!clean.length) return [start, target];
  if (clean[0] !== start) clean.unshift(start);
  if (clean[clean.length - 1] !== target) clean.push(target);
  return clean.slice(0, 12);
}

function chainKey(path) {
  return path.map(cleanUsername).filter(Boolean).join(">");
}

function chainStepCount(chain) {
  return Array.isArray(chain?.path) && chain.path.length >= 2
    ? chain.path.length - 1
    : Number.POSITIVE_INFINITY;
}

function connectionCount(path, fallback) {
  if (Array.isArray(path) && path.length >= 2) return Math.max(0, path.length - 2);
  if (Number.isFinite(fallback)) return Math.max(0, Math.min(10, fallback));
  return 0;
}

function normalizeEntries(entries) {
  if (!Array.isArray(entries)) return [];
  const normalized = entries
    .map((entry) => {
      const start = cleanUsername(entry.start);
      const target = cleanUsername(entry.target);
      const path = normalizePath(start, target, Array.isArray(entry.path)
        ? entry.path.slice(0, 12).map(cleanUsername).filter(Boolean)
        : []);
      const steps = Math.max(0, path.length - 1);
      const length = connectionCount(path, parseInt(entry.length, 10));
      const submittedHops = cleanHopList(entry.hops);
      const hops = submittedHops.length === path.length - 1 ? submittedHops : [];
      if (!start || !target || start === target || path.length < 2 ||
          isBlockedUsername(start) || isBlockedUsername(target) || pathHasBlockedUser(path)) return null;
      return {
        start,
        target,
        length,
        connections: length,
        steps,
        path,
        hops,
        pathKey: chainKey(path),
        ts: Number.isFinite(entry.ts) ? entry.ts : Date.now(),
      };
    })
    .filter(Boolean);
  const unique = new Map();
  for (const entry of normalized) {
    const current = unique.get(entry.pathKey);
    if (!current || isBetterStoredEntry(entry, current)) {
      unique.set(entry.pathKey, entry);
    }
  }
  const uniquePairs = new Map();
  for (const entry of unique.values()) {
    const pairKey = `${entry.start}|${entry.target}`;
    const current = uniquePairs.get(pairKey);
    if (!current || isBetterPairRoute(entry, current)) {
      uniquePairs.set(pairKey, entry);
    }
  }
  return [...uniquePairs.values()];
}

function isBetterStoredEntry(candidate, current) {
  if (candidate.length !== current.length) return candidate.length > current.length;
  if (candidate.steps !== current.steps) return candidate.steps > current.steps;
  return candidate.ts < current.ts;
}

async function readSubmitWindow(kv, key) {
  const now = Date.now();
  const raw = await kv.get(key);
  if (!raw) return { startedAt: now, count: 0 };
  try {
    const parsed = JSON.parse(raw);
    if (Number.isFinite(parsed.startedAt) &&
        Number.isFinite(parsed.count) &&
        now - parsed.startedAt < SUBMIT_WINDOW_SECONDS * 1000) {
      return parsed;
    }
  } catch {
    // Old deployments stored a timestamp string. Treat that as expired so
    // legitimate quick-target submissions are not blocked after deploy.
  }
  return { startedAt: now, count: 0 };
}

function connectorLeaderboard(chains) {
  const players = new Map();
  for (const chain of chains) {
    const middlePlayers = [...new Set(chain.path.slice(1, -1))];
    for (const username of middlePlayers) {
      const current = players.get(username) || {
        username,
        count: 0,
        latestTs: 0,
        examples: [],
      };
      current.count++;
      current.latestTs = Math.max(current.latestTs, chain.ts);
      if (current.examples.length < 3) {
        current.examples.push({
          start: chain.start,
          target: chain.target,
          steps: chain.steps,
        });
      }
      players.set(username, current);
    }
  }

  return [...players.values()].sort((a, b) =>
    b.count - a.count ||
    b.latestTs - a.latestTs ||
    a.username.localeCompare(b.username));
}

function leaderboardForCategory(category, chains, events) {
  if (category === "fastest") return fastestLeaderboard(events);
  if (category === "top_targets") return topTargetsLeaderboard(events);
  if (category === "searched") return searchedLeaderboard(events);
  if (category === "recent") return recentDiscoveriesLeaderboard(chains, events);
  return connectorLeaderboard(chains).map((entry) => ({ ...entry, category: "connectors" }));
}

function fastestLeaderboard(events) {
  const rows = events
    .filter((event) => ["found", "saved"].includes(event.outcome) && Number.isFinite(event.durationMs) && event.durationMs > 0)
    .map((event) => eventLeaderboardRow(event, "fastest"))
    .filter(Boolean);
  return dedupeLeaderboardRowsByPair(rows)
    .sort((a, b) => a.durationMs - b.durationMs || (a.steps || 99) - (b.steps || 99) || b.latestTs - a.latestTs);
}

function topTargetsLeaderboard(events) {
  const targets = new Map();
  for (const event of events.filter((item) => ["found", "saved"].includes(item.outcome))) {
    if (isBlockedUsername(event.start) || isBlockedUsername(event.target) || pathHasBlockedUser(event.path)) continue;
    const current = targets.get(event.target) || {
      category: "top_targets",
      username: event.target,
      target: event.target,
      count: 0,
      uniqueStarts: new Set(),
      latestTs: 0,
      examples: [],
    };
    current.count++;
    current.uniqueStarts.add(event.start);
    current.latestTs = Math.max(current.latestTs, event.ts);
    if (current.examples.length < 3) current.examples.push({ start: event.start, target: event.target, steps: event.steps });
    targets.set(event.target, current);
  }
  return [...targets.values()]
    .map((entry) => ({ ...entry, uniqueStarts: entry.uniqueStarts.size }))
    .sort((a, b) => b.uniqueStarts - a.uniqueStarts || b.count - a.count || b.latestTs - a.latestTs);
}

function searchedLeaderboard(events) {
  const players = new Map();
  for (const event of events) {
    if (isBlockedUsername(event.start) || isBlockedUsername(event.target) || pathHasBlockedUser(event.path)) continue;
    for (const username of [event.start, event.target]) {
      if (!username || isBlockedUsername(username)) continue;
      const current = players.get(username) || {
        category: "searched",
        username,
        count: 0,
        latestTs: 0,
        examples: [],
      };
      current.count++;
      current.latestTs = Math.max(current.latestTs, event.ts);
      if (current.examples.length < 3) current.examples.push({ start: event.start, target: event.target, steps: event.steps });
      players.set(username, current);
    }
  }
  return [...players.values()].sort((a, b) => b.count - a.count || b.latestTs - a.latestTs);
}

function recentDiscoveriesLeaderboard(chains, events) {
  const eventRows = events
    .filter((event) => ["found", "saved"].includes(event.outcome) && Array.isArray(event.path) && event.path.length >= 2)
    .map((event) => eventLeaderboardRow(event, "recent"))
    .filter(Boolean);
  const chainRows = chains.map((chain) => ({
    category: "recent",
    username: chain.start,
    target: chain.target,
    count: chain.length,
    steps: chain.steps,
    length: chain.length,
    path: chain.path,
    latestTs: chain.ts,
    examples: [{ start: chain.start, target: chain.target, steps: chain.steps }],
  }));
  return dedupeLeaderboardRowsByPair([...eventRows, ...chainRows]).sort((a, b) => b.latestTs - a.latestTs);
}

function eventLeaderboardRow(event, category) {
  const start = cleanUsername(event.start);
  const target = cleanUsername(event.target);
  const path = normalizePath(start, target, Array.isArray(event.path)
    ? event.path.slice(0, 12).map(cleanUsername).filter(Boolean)
    : []);
  if (!start || !target || start === target || path.length < 2 ||
      isBlockedUsername(start) || isBlockedUsername(target) || pathHasBlockedUser(path)) return null;
  const steps = Math.max(0, path.length - 1);
  const length = connectionCount(path, parseInt(event.length, 10));
  return {
    category,
    username: start,
    target,
    count: category === "fastest" ? event.durationMs : length,
    durationMs: event.durationMs,
    steps,
    length,
    path,
    latestTs: Number.isFinite(event.ts) ? event.ts : Date.now(),
    quality: event.quality,
    examples: [{ start, target, steps }],
  };
}

function dedupeLeaderboardRowsByPair(rows) {
  const pairs = new Map();
  for (const row of rows) {
    const key = `${row.username}|${row.target}`;
    const current = pairs.get(key);
    if (!current || isBetterLeaderboardRow(row, current)) pairs.set(key, row);
  }
  return [...pairs.values()];
}

function isBetterLeaderboardRow(candidate, current) {
  if (candidate.steps !== current.steps) return candidate.steps < current.steps;
  const candidateProofs = cleanHopList(candidate.hops).length;
  const currentProofs = cleanHopList(current.hops).length;
  if (candidateProofs !== currentProofs) return candidateProofs > currentProofs;
  if (Number.isFinite(candidate.durationMs) && Number.isFinite(current.durationMs) &&
      candidate.durationMs !== current.durationMs) {
    return candidate.durationMs < current.durationMs;
  }
  return candidate.latestTs > current.latestTs;
}

async function putGamesCache(kv, kvKey, parsed, games) {
  try {
    const ts = Date.now();
    await kv.put(kvKey, JSON.stringify({ ts, games }), {
      expirationTtl: KV_RETENTION_SECONDS,
      metadata: {
        username: parsed.username,
        range: Number.isFinite(parsed.archiveLimit) ? `recent:${parsed.archiveLimit}` : "all",
      },
    });
    await putEdgesCache(kv, cacheKeyFromParsed(parsed), parsed, edgesFromGames(parsed.username, games), ts);
  } catch (error) {
    console.warn(JSON.stringify({
      event: "games_cache_write_failed",
      key: kvKey,
      message: error?.message || String(error),
    }));
  }
}

async function putEdgesCache(kv, key, parsed, edges, ts = Date.now(), updateIndex = true) {
  try {
    await kv.put(edgeCacheKey(key), JSON.stringify({
      ts,
      edges: serializeEdges(edges),
    }), {
      expirationTtl: KV_RETENTION_SECONDS,
      metadata: {
        username: parsed.username,
        range: Number.isFinite(parsed.archiveLimit) ? `recent:${parsed.archiveLimit}` : "all",
        type: "edges",
      },
    });
    if (updateIndex) await upsertGraphIndex(kv, parsed.username, edges, ts);
  } catch (error) {
    console.warn(JSON.stringify({
      event: "edges_cache_write_failed",
      key,
      message: error?.message || String(error),
    }));
  }
}

function staleGames(key, games, retryAfter, reason = "rate-limited") {
  return json({
    source: "cloudflare-kv-stale",
    key,
    games,
    stale: true,
    reason,
    retryAfter,
  }, 200, "public, max-age=30, stale-while-revalidate=300");
}

function rateLimited(key, retryAfter) {
  return json({
    error: "Chess.com rate limited this request. Try again shortly.",
    key,
    retryAfter,
  }, 429, "no-store", {
    "Retry-After": String(retryAfter),
  });
}

async function readRateLimit(kv) {
  try {
    const record = await kv.get(CHESS_RATE_LIMIT_KEY, { type: "json", cacheTtl: 5 });
    if (!record || !Number.isFinite(record.until)) return null;
    const retryAfter = Math.ceil((record.until - Date.now()) / 1000);
    return retryAfter > 0 ? { retryAfter } : null;
  } catch {
    return null;
  }
}

async function rememberRateLimit(kv, retryAfter) {
  const seconds = clampRetryAfter(retryAfter);
  const record = { until: Date.now() + seconds * 1000 };
  try {
    await kv.put(CHESS_RATE_LIMIT_KEY, JSON.stringify(record), {
      expirationTtl: seconds,
    });
  } catch (error) {
    console.warn(JSON.stringify({
      event: "rate_limit_cache_write_failed",
      message: error?.message || String(error),
    }));
  }
  return seconds;
}

function parseRetryAfter(headers) {
  const value = headers.get("Retry-After");
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return 0;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

function clampRetryAfter(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return RATE_LIMIT_COOLDOWN_SECONDS;
  return Math.max(15, Math.min(300, Math.ceil(seconds)));
}

function isRateLimitError(error) {
  return error instanceof UpstreamHTTPError && error.status === 429;
}

function isMissingArchivesError(error) {
  return error instanceof UpstreamHTTPError &&
    (error.status === 404 || error.status === 410) &&
    /\/games\/archives$/i.test(error.url || "");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(promise, ms) {
  let timeoutId;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("operation timed out")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

class UpstreamHTTPError extends Error {
  constructor(status, url, retryAfter = 0) {
    super(`HTTP ${status} on ${url}`);
    this.name = "UpstreamHTTPError";
    this.status = status;
    this.url = url;
    this.retryAfter = retryAfter;
  }
}

function json(body, status = 200, cacheControl = null, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...CORS,
      ...extraHeaders,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl || (status === 200 ? "public, max-age=60" : "no-store"),
    },
  });
}
