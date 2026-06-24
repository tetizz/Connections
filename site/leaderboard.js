/* ============================================================
   leaderboard.js — auto-submit + display global leaderboard
   ------------------------------------------------------------
   Talks to the Cloudflare Worker (configurable URL below).
   On a successful search, the chain is auto-submitted.
   The leaderboard is loaded and rendered into #leaderboard-list.
   ============================================================ */

window.Leaderboard = (() => {
  const WORKER_URL = String(
    window.CONNECTIONS_CACHE_API || "https://connections-cache.tetizz.workers.dev"
  ).replace(/\/+$/, "");
  const LB_CACHE_KEY = "chess-connections:leaderboard:v2";
  const LB_CACHE_TTL = 30 * 1000;

  /** Auto-submit a found chain. Fire-and-forget; never blocks the UI. */
  async function submit(start, target, length, path) {
    try {
      await fetch(WORKER_URL + "/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        body: JSON.stringify({ start, target, length, path }),
      });
    } catch (e) {
      // worker not deployed yet, or offline — fail silently
      console.debug("leaderboard submit skipped:", e.message);
    }
  }

  /** Load + render the leaderboard into #leaderboard-list. */
  async function load() {
    const el = document.getElementById("leaderboard-list");
    if (!el) return;
    const cached = readCached();
    if (cached) render(el, cached);
    else el.innerHTML = '<div class="lb-loading">loading…</div>';
    try {
      const res = await fetch(WORKER_URL + "/leaderboard?limit=25", {
        headers: { "Accept": "application/json" },
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const { entries } = await res.json();
      writeCached(entries);
      render(el, entries);
    } catch (e) {
      el.innerHTML =
        '<div class="lb-empty">leaderboard isn\'t live yet — ' +
        'it activates once the worker is deployed.</div>';
    }
  }

  function render(el, entries) {
    if (!entries || entries.length === 0) {
      el.innerHTML =
        '<div class="lb-empty">no entries yet — be the first to find a connection!</div>';
      return;
    }
    const medals = ["🥇", "🥈", "🥉"];
    el.innerHTML = entries.map((e, i) => {
      const rank = i < 3 ? medals[i] : `<span class="lb-rank-num">${i + 1}</span>`;
      const pathStr = e.path && e.path.length
        ? e.path.join(" → ")
        : `${e.start} → ${e.target}`;
      const connections = scoreOf(e);
      const steps = Number.isFinite(e.steps)
        ? e.steps
        : Math.max(0, (e.path?.length || 1) - 1);
      const ago = timeAgo(e.ts);
      return `
        <div class="lb-row${i < 3 ? " lb-row--top" : ""}">
          <div class="lb-rank">${rank}</div>
          <div class="lb-main">
            <div class="lb-path">${esc(pathStr)}</div>
            <div class="lb-meta">${connections} middle connection${connections === 1 ? "" : "s"} · ${steps} link${steps === 1 ? "" : "s"} · ${ago}</div>
          </div>
        </div>`;
    }).join("");
  }

  function scoreOf(entry) {
    if (Number.isFinite(entry.connections)) return entry.connections;
    if (Array.isArray(entry.path) && entry.path.length >= 2) {
      return Math.max(0, entry.path.length - 2);
    }
    const length = Number(entry.length);
    return Number.isFinite(length) ? Math.max(0, length) : 0;
  }

  function readCached() {
    try {
      const cached = JSON.parse(localStorage.getItem(LB_CACHE_KEY) || "null");
      if (!cached || Date.now() - cached.ts > LB_CACHE_TTL) return null;
      return cached.entries;
    } catch {
      return null;
    }
  }

  function writeCached(entries) {
    try {
      localStorage.setItem(LB_CACHE_KEY, JSON.stringify({ ts: Date.now(), entries }));
    } catch {
      // best-effort only
    }
  }

  function timeAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);

  return { submit, load };
})();
