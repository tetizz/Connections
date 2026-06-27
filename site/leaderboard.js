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
  let activeCategory = "connectors";
  let tabsWired = false;

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
  async function load(category = activeCategory) {
    activeCategory = category || "connectors";
    wireTabs();
    setActiveTab(activeCategory);
    const el = document.getElementById("leaderboard-list");
    if (!el) return;
    el.innerHTML = '<div class="lb-loading">loading…</div>';
    try {
      const url = new URL(WORKER_URL + "/leaderboard");
      url.searchParams.set("limit", "10");
      url.searchParams.set("category", activeCategory);
      const res = await fetch(url.toString(), {
        headers: { "Accept": "application/json" },
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const { entries, category: returnedCategory } = await res.json();
      activeCategory = returnedCategory || activeCategory;
      setActiveTab(activeCategory);
      await render(el, entries, activeCategory);
    } catch (e) {
      el.innerHTML =
        '<div class="lb-empty">leaderboard isn\'t live yet — ' +
        'it activates once the worker is deployed.</div>';
    }
  }

  async function render(el, entries, category) {
    if (!entries || entries.length === 0) {
      el.innerHTML =
        `<div class="lb-empty">no ${esc(categoryLabel(category).toLowerCase())} yet.</div>`;
      return;
    }
    const top = entries.filter((entry) => entry?.username).slice(0, 10);
    if (!top.length) {
      el.innerHTML =
        `<div class="lb-empty">no ${esc(categoryLabel(category).toLowerCase())} yet.</div>`;
      return;
    }
    const profiles = await loadProfiles([...new Set(top.flatMap((e) => [e.username, e.target]).filter(Boolean))]);
    el.innerHTML = top.map((e, i) => {
      const profile = profiles.get(e.username) || {};
      const rankClass = i === 0 ? " is-gold" : i === 1 ? " is-silver" : i === 2 ? " is-bronze" : "";
      const title = profile.title ? `<span class="lb-title">${esc(profile.title)}</span>` : "";
      const avatar = profile.avatar
        ? `<img class="lb-avatar" src="${esc(profile.avatar)}" alt="${esc(e.username)} profile photo" referrerpolicy="no-referrer" loading="lazy">`
        : `<span class="lb-avatar lb-avatar--fallback">${esc((e.username[0] || "?").toUpperCase())}</span>`;
      const examples = Array.isArray(e.examples) && e.examples.length
        ? e.examples.map((example) => `${example.start} → ${example.target}`).join(" · ")
        : "submitted chains";
      const ago = timeAgo(e.latestTs || e.ts);
      const metric = metricForEntry(e, category);
      const quality = e.quality?.label ? ` · ${e.quality.label}` : "";
      return `
        <button class="lb-row${i < 3 ? " lb-row--top" : ""}" type="button" style="--row-index:${i}"
                data-profile-trigger data-profile-user="${esc(e.username)}" title="Open ${esc(e.username)} profile">
          <div class="lb-rank${rankClass}"><span>${i + 1}</span></div>
          ${avatar}
          <div class="lb-main">
            <div class="lb-path">${title}${esc(displayName(profile, e.username))}</div>
            <div class="lb-meta">${esc(metric.meta)} · ${esc(examples)} · ${ago}${esc(quality)}</div>
          </div>
          <div class="lb-score">
            <strong>${esc(metric.value)}</strong>
            <small>${esc(metric.label)}</small>
          </div>
        </button>`;
    }).join("");
  }

  function wireTabs() {
    if (tabsWired) return;
    tabsWired = true;
    document.getElementById("leaderboard-tabs")?.addEventListener("click", (event) => {
      const tab = event.target.closest("[data-category]");
      if (!tab) return;
      load(tab.dataset.category);
    });
  }

  function setActiveTab(category) {
    document.querySelectorAll("[data-category]").forEach((tab) => {
      tab.classList.toggle("is-active", tab.dataset.category === category);
    });
  }

  function metricForEntry(entry, category) {
    if (category === "fastest") {
      return {
        value: durationLabel(entry.durationMs || entry.count),
        label: "time",
        meta: `${Number(entry.steps || 0)} step${Number(entry.steps || 0) === 1 ? "" : "s"} to ${entry.target || "target"}`,
      };
    }
    if (category === "top_targets") {
      const unique = Number(entry.uniqueStarts || entry.count || 0);
      return {
        value: unique.toLocaleString(),
        label: "players",
        meta: `${Number(entry.count || 0)} successful connection${Number(entry.count || 0) === 1 ? "" : "s"}`,
      };
    }
    if (category === "searched") {
      const count = Number(entry.count || 0);
      return {
        value: count.toLocaleString(),
        label: "searches",
        meta: "starts and targets counted",
      };
    }
    if (category === "recent") {
      return {
        value: Number(entry.length || entry.count || 0).toLocaleString(),
        label: "middle",
        meta: `${entry.username} → ${entry.target}`,
      };
    }
    const count = Number(entry.count || 0);
    return {
      value: count.toLocaleString(),
      label: "chains",
      meta: `${count} chain${count === 1 ? "" : "s"}`,
    };
  }

  function categoryLabel(category) {
    return {
      connectors: "Top connectors",
      fastest: "Fastest chains",
      top_targets: "Top targets",
      searched: "Most searched",
      recent: "Recent discoveries",
    }[category] || "Leaderboard";
  }

  function durationLabel(ms) {
    const number = Number(ms || 0);
    if (!Number.isFinite(number) || number <= 0) return "—";
    if (number < 1000) return `${Math.round(number)}ms`;
    if (number < 60000) return `${(number / 1000).toFixed(number < 10000 ? 1 : 0)}s`;
    return `${Math.floor(number / 60000)}m`;
  }

  function displayName(profile, username) {
    return profile.name || profile.username || username;
  }

  async function loadProfiles(usernames) {
    const profiles = new Map();
    await Promise.all(usernames.map(async (username) => {
      const key = username.toLowerCase();
      try {
        const res = await fetch(`${WORKER_URL}/profile?username=${encodeURIComponent(username)}`, {
          headers: { "Accept": "application/json" },
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        profiles.set(username, data.profile || { username, url: `https://www.chess.com/member/${username}` });
      } catch {
        profiles.set(username, { username, url: `https://www.chess.com/member/${username}` });
      }
    }));
    return profiles;
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
