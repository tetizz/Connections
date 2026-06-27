/**
 * Chess Connections Cloudflare Worker
 * -----------------------------------
 * - GET /games?key=username:recent:N caches sanitized Chess.com game rows.
 * - POST /search/start starts a resumable server-side chain search job.
 * - GET /search/job?id=... returns job progress or the final chain.
 * - POST /search/warm prefetches top Chess.com targets into shared storage.
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
const SEARCH_MAX_DEPTH = 5;
const SEARCH_MAX_EXPANSIONS = 120;
const SEARCH_FRONTIER_LIMIT = 80;
const SEARCH_CHUNK_EXPANSIONS = 36;
const SEARCH_START_EXPANSIONS = 10;
const SEARCH_START_TIME_MS = 2800;
const SEARCH_CHUNK_TIME_MS = 6500;
const SEARCH_BACKGROUND_TIME_MS = 24000;
const SEARCH_LEASE_MS = 12000;
const SEARCH_VISITED_LIMIT = 8000;
const SEARCH_NEXT_FRONTIER_LIMIT = 1600;
const PAIR_CHAIN_TTL_SECONDS = 30 * 24 * 60 * 60;
const SHARE_TTL_SECONDS = 90 * 24 * 60 * 60;
const SHARE_ID_LENGTH = 8;
const SEARCH_JOB_TTL_SECONDS = 2 * 60 * 60;
const SEARCH_WINDOW_SECONDS = 60;
const MAX_SEARCH_JOBS_PER_WINDOW = 16;
const WARM_STATUS_KEY = "warm:leaderboard-targets";
const WARM_INTERVAL_SECONDS = 6 * 60 * 60;
const WARM_PLAYER_LIMIT = 36;
const COMMON_WARM_TARGETS = ["magnuscarlsen", "hikaru", "danielnaroditsky", "fabianocaruana", "gothamchess"];
const RATE_LIMIT_COOLDOWN_SECONDS = 90;
const FETCH_RETRIES = 2;
const FETCH_BACKOFF_MS = 450;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Accept, Content-Type, X-Owner-Code",
};

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
      return handleSearchJob(url, env);
    }

    if (url.pathname === "/search/warm" && (request.method === "GET" || request.method === "POST")) {
      return handleWarm(url, env, ctx);
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
  const chains = normalizeEntries(await env.GAMES_CACHE.get("leaderboard:entries", "json") || []);
  const entries = connectorLeaderboard(chains);
  return json({
    entries: entries.slice(0, limit),
    total: entries.length,
    chainTotal: chains.length,
  }, 200, "no-store");
}

async function handleProfile(url, env) {
  const username = cleanUsername(url.searchParams.get("username"));
  if (!username) return json({ error: "Invalid username" }, 400);

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
    if (exact) add(exact, "exact match");
  }

  const suggestions = [...seen.values()]
    .filter((item) => matchesSuggestion(item, query))
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
  const range = cleanRange(body?.range) || "instant";
  const id = cleanAnalyticsId(body?.searchId || body?.jobId || body?.id) || crypto.randomUUID();
  if (!start || !target || start === target) return json({ error: "missing fields" }, 400);

  const existing = await readSearchJob(env, id);
  if (existing && !["expired", "failed"].includes(existing.status)) {
    return json({ ok: true, job: publicSearchJob(existing), reused: true }, 200, "no-store");
  }

  const storedPair = await readPairChain(env, start, target, range);
  const requestPair = pairChainShape({
    start,
    target,
    range,
    chain: body?.knownChain,
    players: body?.knownPlayers || {},
    savedAt: Date.now(),
    checkedAt: null,
  }, start, target, range);
  const cachedPair = storedPair || requestPair;
  if (!storedPair && requestPair) {
    await writePairChain(env, {
      id,
      start,
      target,
      range,
      status: "found",
      chain: requestPair.chain,
      players: requestPair.players || {},
      stats: { fetched: 0, requests: 0, cached: 0, expanded: 0 },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
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

  const job = searchJobShape({
    id,
    start,
    target,
    range,
    status: cachedPair ? "running" : "queued",
    progress: cachedPair
      ? "Loaded saved connection instantly. Checking for a shorter route."
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

  const initialJob = cachedPair
    ? job
    : await runSearchJobChunk(env, job.id, {
        expansionBudget: SEARCH_START_EXPANSIONS,
        timeBudgetMs: SEARCH_START_TIME_MS,
      }) || job;

  return json({ ok: true, job: publicSearchJob(initialJob) }, initialJob.status === "found" ? 200 : 202, "no-store");
}

async function handleSearchJob(url, env) {
  const id = cleanAnalyticsId(url.searchParams.get("id"));
  if (!id) return json({ error: "missing id" }, 400, "no-store");
  let job = await readSearchJob(env, id);
  if (!job) return json({ error: "job not found" }, 404, "no-store");
  if (isActiveSearchStatus(job.status) && Date.now() >= Number(job.processingUntil || 0)) {
    job = await runSearchJobChunk(env, id, {
      expansionBudget: SEARCH_CHUNK_EXPANSIONS,
      timeBudgetMs: SEARCH_CHUNK_TIME_MS,
    }) || await readSearchJob(env, id) || job;
  }
  return json({ ok: true, job: publicSearchJob(job) }, 200, "no-store");
}

async function runSearchJob(env, queuedJob) {
  const deadline = Date.now() + SEARCH_BACKGROUND_TIME_MS;
  let job = await readSearchJob(env, queuedJob.id);
  while (job && isActiveSearchStatus(job.status) && Date.now() < deadline) {
    job = await runSearchJobChunk(env, queuedJob.id, {
      expansionBudget: SEARCH_CHUNK_EXPANSIONS,
      timeBudgetMs: SEARCH_CHUNK_TIME_MS,
    });
  }
}

async function runSearchJobChunk(env, id, options = {}) {
  const chunkStartedAt = Date.now();
  const expansionBudget = Math.max(1, Math.min(SEARCH_CHUNK_EXPANSIONS, Number(options.expansionBudget) || SEARCH_CHUNK_EXPANSIONS));
  const timeBudgetMs = Math.max(1000, Math.min(SEARCH_CHUNK_TIME_MS, Number(options.timeBudgetMs) || SEARCH_CHUNK_TIME_MS));
  let job = await readSearchJob(env, id);
  if (!job || !isActiveSearchStatus(job.status)) return job;
  if (Number(job.processingUntil || 0) > Date.now()) return job;

  const startedAt = job.startedAt || Date.now();
  const stats = job.searchInitialized
    ? { ...(job.stats || {}) }
    : { fetched: 0, requests: 0, cached: 0, expanded: 0 };
  const search = searchStateShape(job.search, job.start, job.target);
  const progress = async (message, patch = {}) => {
    job = await updateSearchJob(env, id, {
      status: "running",
      progress: message,
      startedAt,
      processingUntil: Date.now() + SEARCH_LEASE_MS,
      stats: { ...stats },
      search,
      ...patch,
    }) || job;
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
          durationMs: Date.now() - startedAt,
        });
        return readSearchJob(env, id);
      }
      search.profileChecked = true;
      await progress("Searching recent wins");
    }

    const result = await advanceServerSearch(env, job, search, stats, progress, {
      expansionBudget,
      timeBudgetMs,
      chunkStartedAt,
    });

    if (result?.status === "running") {
      return updateSearchJob(env, id, {
        status: "running",
        progress: result.progress,
        stats,
        search,
        processingUntil: 0,
        startedAt,
      });
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
          durationMs: Date.now() - startedAt,
        });
        return readSearchJob(env, id);
      }
      await completeSearchJob(env, job, {
        status: "not_found",
        outcome: "not_found",
        progress: result?.progress || "No connection found in this search.",
        stats,
        search,
        processingUntil: 0,
        durationMs: Date.now() - startedAt,
      });
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
        durationMs: Date.now() - startedAt,
      });
      return readSearchJob(env, id);
    }

    const players = {};
    await runThrottled(chainResult.path.map((username) => async () => {
      const profile = await readOrFetchProfile(env, username);
      if (profile) players[username] = profile;
    }), 3);
    const targetProfile = players[job.target] || await readOrFetchProfile(env, job.target) || {};

    const chain = {
      target: job.target,
      display: targetProfile.name || targetProfile.username || job.target,
      found: true,
      length: Math.max(0, chainResult.path.length - 1),
      path: chainResult.path,
      hops: chainResult.hops,
    };
    const cachedChain = job.chain?.found ? job.chain : null;
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
      durationMs: Date.now() - startedAt,
    });
    return readSearchJob(env, id);
  } catch (error) {
    await failSearchJob(env, id, error);
    return readSearchJob(env, id);
  }
}

async function advanceServerSearch(env, job, search, stats, progress, options = {}) {
  const archiveLimit = archiveLimitForRange(job.range);
  const expansionBudget = Math.max(1, Number(options.expansionBudget) || SEARCH_CHUNK_EXPANSIONS);
  const chunkStartedAt = Number(options.chunkStartedAt) || Date.now();
  const deadline = chunkStartedAt + (Number(options.timeBudgetMs) || SEARCH_CHUNK_TIME_MS);
  const forwardVisited = visitedObjectToMap(search.forwardVisited);
  const backwardVisited = visitedObjectToMap(search.backwardVisited);
  const edgesCache = new Map();
  let processed = 0;
  let meeting = null;

  const syncSearch = () => {
    search.forwardVisited = visitedMapToObject(forwardVisited);
    search.backwardVisited = visitedMapToObject(backwardVisited);
  };
  const totalVisited = () => forwardVisited.size + backwardVisited.size;
  const freshUsers = job.refreshCached && Array.isArray(job.chain?.path)
    ? new Set(job.chain.path.map(cleanUsername).filter(Boolean))
    : new Set();
  const getEdges = async (username) => {
    const key = username.toLowerCase();
    if (edgesCache.has(key)) return edgesCache.get(key);
    const games = await readOrFetchGames(env, {
      username: key,
      archiveLimit,
      forceFresh: freshUsers.has(key) || (job.refreshCached && (key === job.start || key === job.target)),
    }, stats);
    const edges = edgesFromGames(key, games);
    edgesCache.set(key, edges);
    return edges;
  };
  const beginLayer = async () => {
    if (search.depth >= SEARCH_MAX_DEPTH || stats.expanded >= SEARCH_MAX_EXPANSIONS) return false;
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
    search.depth += 1;
    syncSearch();
    await progress(`Checked ${stats.expanded} players, ${totalVisited()} candidates`, { depth: search.depth });
  };

  while (processed < expansionBudget && Date.now() < deadline && stats.expanded < SEARCH_MAX_EXPANSIONS) {
    if (!search.activeSide) {
      const startedLayer = await beginLayer();
      if (!startedLayer) {
        syncSearch();
        return { status: "not_found", progress: "No connection found in this search." };
      }
    }

    if (search.activeCursor >= search.activeFrontier.length) {
      await finishLayer();
      continue;
    }

    const node = search.activeFrontier[search.activeCursor++];
    if (!node) continue;
    stats.expanded++;
    processed++;

    const edges = await getEdges(node);
    if (search.activeSide === "forward") {
      for (const [opponent, urls] of edges.beatenByMe) {
        if (forwardVisited.has(opponent)) continue;
        if (backwardVisited.has(opponent)) {
          forwardVisited.set(opponent, { prev: node, hopUrl: urls[0] });
          meeting = opponent;
          break;
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
          meeting = opponent;
          break;
        }
        if (backwardVisited.size < SEARCH_VISITED_LIMIT && search.activeNextFrontier.length < SEARCH_NEXT_FRONTIER_LIMIT) {
          backwardVisited.set(opponent, { next: node, hopUrl: urls[0] });
          search.activeNextFrontier.push(opponent);
        }
      }
    }

    if (meeting) {
      syncSearch();
      return { status: "found", chain: reconstructServerPath(meeting, forwardVisited, backwardVisited) };
    }

    if (search.activeCursor >= search.activeFrontier.length) {
      await finishLayer();
    } else if (processed % 6 === 0) {
      syncSearch();
      await progress(`Step ${search.depth + 1}: checking ${search.activeFrontier.length} players`, { depth: search.depth });
    }
  }

  syncSearch();
  if (stats.expanded >= SEARCH_MAX_EXPANSIONS || search.depth >= SEARCH_MAX_DEPTH) {
    return { status: "not_found", progress: "No connection found in this search." };
  }
  return {
    status: "running",
    progress: search.activeSide
      ? `Step ${search.depth + 1}: checking ${search.activeFrontier.length} players`
      : `Checked ${stats.expanded} players, ${totalVisited()} candidates`,
  };
}

async function completeSearchJob(env, job, patch) {
  const next = await updateSearchJob(env, job.id, {
    ...patch,
    updatedAt: Date.now(),
  });
  const completed = next || { ...job, ...patch };
  if (completed?.status === "found" && completed.chain?.found) {
    await writePairChain(env, completed);
  }
  const event = searchJobAnalyticsEvent(completed);
  if (event) await saveAnalyticsEvent(env, event);
}

async function failSearchJob(env, id, error) {
  const job = await updateSearchJob(env, id, {
    status: isRateLimitError(error) ? "timeout" : "failed",
    outcome: isRateLimitError(error) ? "timeout" : "error",
    progress: isRateLimitError(error)
      ? "Chess.com is throttling requests right now."
      : "Search failed before it could finish.",
    error: error?.message || String(error),
    processingUntil: 0,
    updatedAt: Date.now(),
  });
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
    const games = await readOrFetchGames(env, { username: key, archiveLimit }, stats);
    const edges = edgesFromGames(key, games);
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

function cacheKeyFromParsed(parsed) {
  return Number.isFinite(parsed.archiveLimit)
    ? `${parsed.username}:recent:${parsed.archiveLimit}`
    : `${parsed.username}:all`;
}

function archiveLimitForRange(range) {
  if (range === "instant") return 2;
  if (range === "6") return 6;
  if (range === "12") return 12;
  if (range === "all") return Infinity;
  return 6;
}

async function handleWarm(url, env, ctx) {
  const force = url.searchParams.get("force") === "1";
  const status = await env.GAMES_CACHE.get(WARM_STATUS_KEY, { type: "json", cacheTtl: 60 });
  const age = Date.now() - (Number.isFinite(status?.updatedAt) ? status.updatedAt : 0);
  if (!force && status && age < WARM_INTERVAL_SECONDS * 1000) {
    return json({ ok: true, status: publicWarmStatus(status), skipped: true }, 200, "no-store");
  }

  const next = {
    status: "queued",
    updatedAt: Date.now(),
    warmed: Number.isFinite(status?.warmed) ? status.warmed : 0,
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

  await env.GAMES_CACHE.put(WARM_STATUS_KEY, JSON.stringify({
    status: "ready",
    updatedAt: Date.now(),
    startedAt,
    warmed,
    errors,
  }), {
    expirationTtl: KV_RETENTION_SECONDS,
    metadata: { type: "warm" },
  });
}

function publicWarmStatus(status) {
  return {
    status: String(status?.status || "queued"),
    updatedAt: Number.isFinite(status?.updatedAt) ? status.updatedAt : Date.now(),
    warmed: Number.isFinite(status?.warmed) ? status.warmed : 0,
    errors: Number.isFinite(status?.errors) ? status.errors : 0,
  };
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
  return json({ ok: true, id, share: publicShareRecord(record) }, 200, "no-store");
}

async function handleShareRead(url, env) {
  const id = cleanShareId(url.searchParams.get("id") || url.searchParams.get("c"));
  if (!id) return json({ error: "missing id" }, 400, "no-store");
  const record = shareRecordShape(await env.GAMES_CACHE.get(`share:${id}`, { type: "json", cacheTtl: 60 }));
  if (!record) return json({ error: "share not found" }, 404, "no-store");
  return json({ ok: true, id, share: publicShareRecord({ ...record, id }) }, 200, "public, max-age=60");
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
  const steps = Math.max(0, normalizedPath.length - 1);
  const length = connectionCount(normalizedPath, submittedLength);
  const pathKey = chainKey(normalizedPath);

  if (!start || !target || start === target || normalizedPath.length < 2 ||
      !Number.isFinite(length) || length < 0 || length > 10) {
    return json({ error: "missing fields" }, 400);
  }

  const entries = normalizeEntries(await env.GAMES_CACHE.get("leaderboard:entries", "json") || []);
  const key = `${start}|${target}`;
  const duplicatePath = entries.find((entry) => entry.pathKey === pathKey);
  if (duplicatePath) {
    return json({
      ok: true,
      deduped: true,
      reason: "same-chain",
      entry: duplicatePath,
    }, 200, "no-store");
  }

  const submitWindow = await readSubmitWindow(env.GAMES_CACHE, rateLimitKey);
  if (submitWindow.count >= MAX_SUBMITS_PER_WINDOW) {
    return json({
      error: "too many submissions, wait a moment",
      retryAfter: Math.max(1, SUBMIT_WINDOW_SECONDS - Math.floor((Date.now() - submitWindow.startedAt) / 1000)),
    }, 429);
  }

  const existingIndex = entries.findIndex((entry) => `${entry.start}|${entry.target}` === key);
  const entry = {
    start,
    target,
    length,
    connections: length,
    steps,
    path: normalizedPath,
    pathKey,
    ts: Date.now(),
  };

  if (existingIndex >= 0) {
    if (length > entries[existingIndex].length ||
        (length === entries[existingIndex].length && steps >= entries[existingIndex].steps)) {
      entries[existingIndex] = entry;
    } else {
      return json({ ok: true, deduped: true, message: "already have a chain with more connections" }, 200, "no-store");
    }
  } else {
    entries.push(entry);
  }

  entries.sort((a, b) => b.length - a.length || b.steps - a.steps || b.ts - a.ts);
  if (entries.length > MAX_LEADERBOARD_ENTRIES) entries.length = MAX_LEADERBOARD_ENTRIES;

  await env.GAMES_CACHE.put("leaderboard:entries", JSON.stringify(entries));
  await env.GAMES_CACHE.put(rateLimitKey, JSON.stringify({
    startedAt: submitWindow.startedAt,
    count: submitWindow.count + 1,
  }), { expirationTtl: SUBMIT_WINDOW_SECONDS * 2 });

  return json({ ok: true, entry }, 200, "no-store");
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
  const allEvents = normalizeAnalyticsEvents(await env.GAMES_CACHE.get(ANALYTICS_EVENTS_KEY, "json") || []);
  const events = allEvents.filter((event) => {
    if (outcome && event.outcome !== outcome) return false;
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
    filters: { outcome, username },
    generatedAt: Date.now(),
  }, 200, "no-store");
}

async function saveAnalyticsEvent(env, event) {
  if (!event) return;
  const events = normalizeAnalyticsEvents(await env.GAMES_CACHE.get(ANALYTICS_EVENTS_KEY, "json") || []);
  const existingIndex = events.findIndex((item) => item.id === event.id);
  if (existingIndex >= 0) {
    const existing = events[existingIndex];
    events.splice(existingIndex, 1);
    events.unshift({ ...existing, ...event, firstTs: existing.firstTs || existing.ts || event.ts });
  } else {
    events.unshift(event);
  }
  if (events.length > MAX_ANALYTICS_EVENTS) events.length = MAX_ANALYTICS_EVENTS;

  await env.GAMES_CACHE.put(ANALYTICS_EVENTS_KEY, JSON.stringify(events), {
    expirationTtl: KV_RETENTION_SECONDS,
    metadata: { type: "analytics" },
  });
}

async function readSearchJob(env, id) {
  const record = await env.GAMES_CACHE.get(`search:job:${id}`, { type: "json" });
  return searchJobShape(record);
}

async function writeSearchJob(env, job) {
  const shaped = searchJobShape(job);
  await env.GAMES_CACHE.put(`search:job:${shaped.id}`, JSON.stringify(shaped), {
    expirationTtl: SEARCH_JOB_TTL_SECONDS,
    metadata: { type: "search-job", start: shaped.start, target: shaped.target },
  });
  return shaped;
}

async function updateSearchJob(env, id, patch) {
  const current = await readSearchJob(env, id);
  if (!current) return null;
  return writeSearchJob(env, {
    ...current,
    ...patch,
    stats: patch.stats || current.stats,
    updatedAt: Date.now(),
  });
}

async function readPairChain(env, start, target, range) {
  const key = pairChainKey(start, target, range);
  const record = await env.GAMES_CACHE.get(key, { type: "json", cacheTtl: 60 });
  return pairChainShape(record, start, target, range);
}

async function writePairChain(env, job) {
  const shaped = searchJobShape(job);
  if (!shaped?.chain?.found) return null;
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

function pairChainKey(start, target, range) {
  return `search:pair:${cleanUsername(start)}:${cleanUsername(target)}:${cleanRange(range) || "instant"}`;
}

function pairChainShape(record, start, target, range) {
  if (!record || typeof record !== "object") return null;
  const chain = chainShape(record.chain, target);
  if (!chain?.found || !Array.isArray(chain.path) || chain.path.length < 2) return null;
  const normalizedStart = cleanUsername(start || record.start);
  const normalizedTarget = cleanUsername(target || record.target || chain.target);
  const normalizedRange = cleanRange(range || record.range) || "instant";
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
  const hops = Array.isArray(rawChain.hops) ? rawChain.hops.slice(0, 11).map((hop) => ({
    from: cleanUsername(hop?.from),
    to: cleanUsername(hop?.to),
    url: cleanUrl(hop?.url),
  })).filter((hop) => hop.from && hop.to) : [];
  return {
    target: normalizedTarget,
    display: String(rawChain.display || normalizedTarget).slice(0, 80),
    found: Boolean(rawChain.found),
    length: Number.isFinite(rawChain.length) ? Math.max(0, Math.min(12, rawChain.length)) : Math.max(0, path.length - 1),
    path,
    hops,
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
        hops: Array.isArray(job.chain.hops) ? job.chain.hops.slice(0, 11).map((hop) => ({
          from: cleanUsername(hop?.from),
          to: cleanUsername(hop?.to),
          url: String(hop?.url || ""),
        })).filter((hop) => hop.from && hop.to) : [],
      }
    : null;
  const players = job.players && typeof job.players === "object" ? job.players : {};
  return {
    id,
    start,
    target,
    range: cleanRange(job.range) || "instant",
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
  };
}

function isActiveSearchStatus(status) {
  return status === "queued" || status === "running";
}

function initialSearchState(start, target) {
  return {
    profileChecked: false,
    depth: 0,
    forwardVisited: { [start]: { prev: "", hopUrl: "" } },
    backwardVisited: { [target]: { next: "", hopUrl: "" } },
    forwardFrontier: [start],
    backwardFrontier: [target],
    activeSide: "",
    activeFrontier: [],
    activeCursor: 0,
    activeNextFrontier: [],
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
    depth: cleanNonNegativeNumber(state.depth, SEARCH_MAX_DEPTH + 1) || 0,
    forwardVisited,
    backwardVisited,
    forwardFrontier: cleanUsernameList(state.forwardFrontier, SEARCH_NEXT_FRONTIER_LIMIT),
    backwardFrontier: cleanUsernameList(state.backwardFrontier, SEARCH_NEXT_FRONTIER_LIMIT),
    activeSide,
    activeFrontier: activeSide ? cleanUsernameList(state.activeFrontier, SEARCH_FRONTIER_LIMIT) : [],
    activeCursor: cleanNonNegativeNumber(state.activeCursor, SEARCH_FRONTIER_LIMIT) || 0,
    activeNextFrontier: activeSide ? cleanUsernameList(state.activeNextFrontier, SEARCH_NEXT_FRONTIER_LIMIT) : [],
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
    durationMs: shaped.durationMs,
    requests: shaped.stats.requests,
    cached: shaped.stats.cached,
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
    jobId: cleanAnalyticsId(body?.jobId || body?.searchId || body?.id),
    durationMs: cleanNonNegativeNumber(body?.durationMs, 10 * 60 * 1000),
    requests: cleanNonNegativeNumber(body?.requests, 100000),
    cached: cleanNonNegativeNumber(body?.cached, 100000),
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
        jobId: cleanAnalyticsId(event.jobId) || "",
        durationMs: cleanNonNegativeNumber(event.durationMs, 10 * 60 * 1000),
        requests: cleanNonNegativeNumber(event.requests, 100000),
        cached: cleanNonNegativeNumber(event.cached, 100000),
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
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(max, Math.round(number))) : null;
}

function cleanRange(value) {
  const clean = String(value || "").toLowerCase().trim().replace(/[^a-z0-9_-]/g, "");
  return ["instant", "6", "12", "all"].includes(clean) ? clean : "";
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
  const archiveData = await fetchJSON(`${CHESS_API}${username}/games/archives`);
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
        endTime: Number.isFinite(game.end_time) ? game.end_time : null,
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
    endTime: Number.isFinite(game.endTime) ? game.endTime : null,
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
        const item = suggestionShape({
          username: row.username,
          name: row.name,
          title: row.title,
          avatar: row.avatar,
          url: row.url,
          score: row.score,
          rank: row.rank,
        }, source);
        if (!item || !matchesSuggestion(item, query)) continue;
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
      if (!key || !key.includes(query) || seen.has(key)) continue;
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
    const response = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "chess-connections-cache/1.0",
      },
    });
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
      if (!start || !target || start === target || path.length < 2) return null;
      return {
        start,
        target,
        length,
        connections: length,
        steps,
        path,
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
  return [...unique.values()];
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

async function putGamesCache(kv, kvKey, parsed, games) {
  try {
    await kv.put(kvKey, JSON.stringify({ ts: Date.now(), games }), {
      expirationTtl: KV_RETENTION_SECONDS,
      metadata: {
        username: parsed.username,
        range: Number.isFinite(parsed.archiveLimit) ? `recent:${parsed.archiveLimit}` : "all",
      },
    });
  } catch (error) {
    console.warn(JSON.stringify({
      event: "games_cache_write_failed",
      key: kvKey,
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
