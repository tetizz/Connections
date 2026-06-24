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
  const LB_CACHE_KEY = "chess-connections:leaderboard:v4";
  const PROFILE_CACHE_KEY = "chess-connections:leaderboard-profiles:v1";
  const LB_CACHE_TTL = 30 * 1000;
  const PROFILE_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;

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
    if (cached) await render(el, cached);
    else el.innerHTML = '<div class="lb-loading">loading…</div>';
    try {
      const res = await fetch(WORKER_URL + "/leaderboard?limit=10", {
        headers: { "Accept": "application/json" },
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const { entries } = await res.json();
      writeCached(entries);
      await render(el, entries);
    } catch (e) {
      el.innerHTML =
        '<div class="lb-empty">leaderboard isn\'t live yet — ' +
        'it activates once the worker is deployed.</div>';
    }
  }

  async function render(el, entries) {
    if (!entries || entries.length === 0) {
      el.innerHTML =
        '<div class="lb-empty">no connector scores yet — find a chain with a middle player.</div>';
      return;
    }
    const top = entries.filter((entry) => entry?.username).slice(0, 10);
    if (!top.length) {
      el.innerHTML =
        '<div class="lb-empty">no connector scores yet — find a chain with a middle player.</div>';
      return;
    }
    const profiles = await loadProfiles(top.map((e) => e.username));
    el.innerHTML = top.map((e, i) => {
      const profile = profiles.get(e.username) || {};
      const rankClass = i === 0 ? " is-gold" : i === 1 ? " is-silver" : i === 2 ? " is-bronze" : "";
      const profileUrl = profile.url || `https://www.chess.com/member/${encodeURIComponent(e.username)}`;
      const title = profile.title ? `<span class="lb-title">${esc(profile.title)}</span>` : "";
      const avatar = profile.avatar
        ? `<img class="lb-avatar" src="${esc(profile.avatar)}" alt="${esc(e.username)} profile photo" referrerpolicy="no-referrer" loading="lazy">`
        : `<span class="lb-avatar lb-avatar--fallback">${esc((e.username[0] || "?").toUpperCase())}</span>`;
      const examples = Array.isArray(e.examples) && e.examples.length
        ? e.examples.map((example) => `${example.start} → ${example.target}`).join(" · ")
        : "submitted chains";
      const ago = timeAgo(e.latestTs || e.ts);
      const count = Number(e.count) || 0;
      return `
        <a class="lb-row${i < 3 ? " lb-row--top" : ""}" href="${esc(profileUrl)}" target="_blank" rel="noopener">
          <div class="lb-rank${rankClass}"><span>${i + 1}</span></div>
          ${avatar}
          <div class="lb-main">
            <div class="lb-path">${title}${esc(e.username)}</div>
            <div class="lb-meta">${count} chain${count === 1 ? "" : "s"} · ${esc(examples)} · ${ago}</div>
          </div>
        </a>`;
    }).join("");
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

  async function loadProfiles(usernames) {
    const cache = readProfileCache();
    const profiles = new Map();
    await Promise.all(usernames.map(async (username) => {
      const key = username.toLowerCase();
      const cached = cache[key];
      if (cached && Date.now() - cached.ts < PROFILE_CACHE_TTL) {
        profiles.set(username, cached.profile);
        return;
      }
      try {
        const res = await fetch(`https://api.chess.com/pub/player/${encodeURIComponent(username)}`, {
          headers: { "Accept": "application/json" },
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        const profile = {
          username: data.username || username,
          name: data.name || "",
          title: data.title || "",
          avatar: data.avatar || "",
          url: data.url || `https://www.chess.com/member/${username}`,
        };
        cache[key] = { ts: Date.now(), profile };
        profiles.set(username, profile);
      } catch {
        profiles.set(username, { username, url: `https://www.chess.com/member/${username}` });
      }
    }));
    writeProfileCache(cache);
    return profiles;
  }

  function readProfileCache() {
    try {
      return JSON.parse(localStorage.getItem(PROFILE_CACHE_KEY) || "{}");
    } catch {
      return {};
    }
  }

  function writeProfileCache(cache) {
    try {
      localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(cache));
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
