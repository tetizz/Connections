/**
 * Chess Connections leaderboard Worker
 * ------------------------------------
 * Stores chain results in Cloudflare KV, dedupes by (start,target)
 * keeping the shortest chain, rate-limits by IP, serves a global board.
 *
 * Endpoints:
 *   POST /submit   { start, target, length, path }  -> stores it
 *   GET  /leaderboard?limit=50                       -> ranked entries
 *   GET  /health                                      -> { ok: true }
 */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: CORS });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    // ---- GET /health ----
    if (url.pathname === "/health") {
      return json({ ok: true, ts: Date.now() });
    }

    // ---- GET /leaderboard ----
    if (url.pathname === "/leaderboard" && request.method === "GET") {
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 200);
      const list = await env.LEADERBOARD.get("entries", "json") || [];
      // sort: shortest chain first, then most recent
      list.sort((a, b) =>
        a.length !== b.length ? a.length - b.length : b.ts - a.ts);
      return json({ entries: list.slice(0, limit), total: list.length });
    }

    // ---- POST /submit ----
    if (url.pathname === "/submit" && request.method === "POST") {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";

      // rate limit: 1 submission per IP per 10 seconds
      const lastSubmit = parseInt(
        await env.LEADERBOARD.get(`ratelimit:${ip}`) || "0", 10);
      if (Date.now() - lastSubmit < 10000) {
        return json({ error: "too soon, wait a moment" }, 429);
      }

      let body;
      try { body = await request.json(); }
      catch { return json({ error: "bad json" }, 400); }

      const start = String(body.start || "").toLowerCase().trim().slice(0, 40);
      const target = String(body.target || "").toLowerCase().trim().slice(0, 40);
      const length = parseInt(body.length, 10);
      const path = Array.isArray(body.path) ? body.path.slice(0, 10) : [];
      if (!start || !target || !Number.isFinite(length) || length < 1 || length > 9) {
        return json({ error: "missing fields" }, 400);
      }

      // load existing entries, dedupe by (start,target) keeping shortest
      const list = await env.LEADERBOARD.get("entries", "json") || [];
      const key = `${start}|${target}`;
      const existingIdx = list.findIndex(e =>
        `${e.start}|${e.target}` === key);

      const entry = {
        start, target, length,
        path: path.map(p => String(p).toLowerCase().slice(0, 40)),
        ts: Date.now(),
      };

      if (existingIdx >= 0) {
        // only overwrite if this chain is shorter (or equal, newer)
        if (length <= list[existingIdx].length) {
          list[existingIdx] = entry;
        } else {
          return json({ ok: true, deduped: true, message: "already have a shorter one" });
        }
      } else {
        list.push(entry);
      }

      // cap total stored entries to prevent runaway growth
      if (list.length > 1000) {
        list.sort((a, b) => a.length - b.length);
        list.length = 1000;
      }

      await env.LEADERBOARD.put("entries", JSON.stringify(list));
      await env.LEADERBOARD.put(`ratelimit:${ip}`, String(Date.now()));

      return json({ ok: true, entry });
    }

    return json({ error: "not found" }, 404);
  },
};
