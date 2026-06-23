/* ============================================================
   leaderboard.js — auto-submit + display global leaderboard
   ------------------------------------------------------------
   Talks to the Cloudflare Worker (configurable URL below).
   On a successful search, the chain is auto-submitted.
   The leaderboard is loaded and rendered into #leaderboard-list.
   ============================================================ */

window.Leaderboard = (() => {
  // Worker URL — set this after deploying (see README).
  // Defaults to a sensible placeholder so the site degrades gracefully
  // (shows "leaderboard coming soon" until configured).
  const WORKER_URL = "https://chess-connections-leaderboard.tetizz.workers.dev";

  const inDev = () =>
    location.hostname === "localhost" || location.hostname === "127.0.0.1";

  /** Auto-submit a found chain. Fire-and-forget; never blocks the UI. */
  async function submit(start, target, length, path) {
    try {
      await fetch(WORKER_URL + "/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
    el.innerHTML = '<div class="lb-loading">loading…</div>';
    try {
      const res = await fetch(WORKER_URL + "/leaderboard?limit=25");
      if (!res.ok) throw new Error("HTTP " + res.status);
      const { entries } = await res.json();
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
      const ago = timeAgo(e.ts);
      return `
        <div class="lb-row${i < 3 ? " lb-row--top" : ""}">
          <div class="lb-rank">${rank}</div>
          <div class="lb-main">
            <div class="lb-path">${esc(pathStr)}</div>
            <div class="lb-meta">${e.length} step${e.length === 1 ? "" : "s"} · ${ago}</div>
          </div>
        </div>`;
    }).join("");
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
