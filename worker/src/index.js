/**
 * Chess Connections Cloudflare Worker
 * -----------------------------------
 * - GET /games?key=username:recent:N caches sanitized Chess.com game rows.
 * - POST /submit stores found chains for the global leaderboard.
 * - GET /leaderboard ranks middle players by how often they connect chains.
 */

const CHESS_API = "https://api.chess.com/pub/player/";
const TTL_SECONDS = 7 * 24 * 60 * 60;
const KV_RETENTION_SECONDS = 30 * 24 * 60 * 60;
const MAX_LEADERBOARD_ENTRIES = 1000;
const ARCHIVE_CONCURRENCY = 4;
const SUBMIT_WINDOW_SECONDS = 60;
const MAX_SUBMITS_PER_WINDOW = 30;
const CHESS_RATE_LIMIT_KEY = "games:ratelimit:chesscom";
const RATE_LIMIT_COOLDOWN_SECONDS = 90;
const FETCH_RETRIES = 2;
const FETCH_BACKOFF_MS = 450;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Accept, Content-Type",
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

    if (url.pathname === "/submit" && request.method === "POST") {
      return handleSubmit(request, env);
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

function parseGameCacheKey(key) {
  const normalized = key.toLowerCase();
  const match = normalized.match(/^([a-z0-9_-]{2,50}):recent:(\d{1,2})$/);
  if (!match) return null;
  const archiveLimit = Math.max(1, Math.min(12, Number(match[2])));
  return { username: match[1], archiveLimit };
}

async function fetchGames({ username, archiveLimit }) {
  const archiveData = await fetchJSON(`${CHESS_API}${username}/games/archives`);
  const archives = Array.isArray(archiveData.archives) ? archiveData.archives : [];
  const selectedArchives = archives.slice(-archiveLimit);
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
        range: `recent:${parsed.archiveLimit}`,
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
    error: "Chess.com rate limited the shared cache. Try again shortly.",
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
