/**
 * Chess Connections Cloudflare Worker
 * -----------------------------------
 * - GET /games?key=username:recent:N caches sanitized Chess.com game rows.
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
const RATE_LIMIT_COOLDOWN_SECONDS = 90;
const FETCH_RETRIES = 2;
const FETCH_BACKOFF_MS = 450;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Accept, Content-Type, X-Owner-Code",
};

export default {
  async fetch(request, env) {
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

  if (cachedProfile && cachedProfile.stats && Date.now() - cachedAt < PROFILE_TTL_SECONDS * 1000) {
    return json({ source: "cloudflare-kv", profile: cachedProfile });
  }

  try {
    const profile = await fetchProfileDetails(username);
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

  const events = normalizeAnalyticsEvents(await env.GAMES_CACHE.get(ANALYTICS_EVENTS_KEY, "json") || []);
  events.unshift(event);
  if (events.length > MAX_ANALYTICS_EVENTS) events.length = MAX_ANALYTICS_EVENTS;

  await env.GAMES_CACHE.put(ANALYTICS_EVENTS_KEY, JSON.stringify(events), {
    expirationTtl: KV_RETENTION_SECONDS,
    metadata: { type: "analytics" },
  });
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
  const events = normalizeAnalyticsEvents(await env.GAMES_CACHE.get(ANALYTICS_EVENTS_KEY, "json") || []);
  return json({
    events: events.slice(0, limit),
    total: events.length,
    generatedAt: Date.now(),
  }, 200, "no-store");
}

function analyticsEventShape(body, request) {
  const start = cleanUsername(body?.start);
  const target = cleanUsername(body?.target);
  if (!start || !target || start === target) return null;

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
    id: crypto.randomUUID(),
    ts: Date.now(),
    outcome: analyticsOutcome(body?.outcome),
    start,
    target,
    depth: Number.isFinite(rawDepth) ? Math.max(1, Math.min(5, rawDepth)) : null,
    range: cleanRange(body?.range),
    length,
    steps,
    path,
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
        id: String(event.id || crypto.randomUUID()).slice(0, 80),
        ts: Number.isFinite(event.ts) ? event.ts : Date.now(),
        outcome: analyticsOutcome(event.outcome),
        start,
        target,
        depth: Number.isFinite(event.depth) ? Math.max(1, Math.min(5, event.depth)) : null,
        range: cleanRange(event.range),
        length: Number.isFinite(event.length) ? Math.max(0, Math.min(10, event.length)) : null,
        steps: Number.isFinite(event.steps) ? Math.max(0, Math.min(12, event.steps)) : null,
        path: normalizedPath,
        country: cleanCountry(event.country),
        device: deviceLabel(event.device || ""),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, MAX_ANALYTICS_EVENTS);
}

function analyticsOutcome(value) {
  const clean = String(value || "started").toLowerCase().replace(/-/g, "_");
  return ["started", "saved", "found", "not_found", "timeout", "error"].includes(clean)
    ? clean
    : "started";
}

function cleanRange(value) {
  const clean = String(value || "").toLowerCase().trim().replace(/[^a-z0-9_-]/g, "");
  return ["instant", "6", "12", "all"].includes(clean) ? clean : "";
}

function cleanCountry(value) {
  const clean = String(value || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2);
  return /^[A-Z]{2}$/.test(clean) ? clean : "";
}

function deviceLabel(value) {
  const text = String(value || "").toLowerCase();
  if (!text) return "";
  if (text.includes("tablet") || text.includes("ipad")) return "tablet";
  if (text.includes("mobi") || text.includes("iphone") || text.includes("android")) return "mobile";
  if (["desktop", "mobile", "tablet"].includes(text)) return text;
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

async function fetchProfileDetails(username) {
  const data = await fetchJSON(`${CHESS_API}${username}`);
  const profile = profileShape(data, username);
  try {
    const stats = await fetchJSON(`${CHESS_API}${username}/stats`);
    profile.stats = statsShape(stats);
  } catch {
    profile.stats = {};
  }
  return profile;
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
