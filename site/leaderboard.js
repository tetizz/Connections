/* ============================================================
   leaderboard.js — auto-submit + display global leaderboard
   ------------------------------------------------------------
   Talks to the Cloudflare Worker (configurable URL below).
   On a successful search, the chain is auto-submitted.
   The leaderboard is loaded and rendered into #leaderboard-list.
   ============================================================ */

window.Leaderboard = (() => {
  const WORKER_URL = String(
    window.CONNECTIONS_CACHE_API || "https://tetizz-connections-api.pages.dev"
  ).replace(/\/+$/, "");
  const BLOCKED_USERNAMES = new Set([String.fromCharCode(108, 111, 117, 105, 115, 95, 102, 108, 111, 121, 100)]);
  let activeCategory = "connectors";
  let tabsWired = false;
  let initialLoadObserver = null;
  let loadGeneration = 0;
  let profileController = null;

  /** Submit a found chain and report whether the server accepted it. */
  async function submit(start, target, length, path, hops = [], range = "auto", serverSearchId = undefined) {
    try {
      const response = await fetch(WORKER_URL + "/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        keepalive: true,
        body: JSON.stringify({ start, target, length, path, hops, range, ...(serverSearchId ? { serverSearchId } : {}) }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || data?.ok !== true) {
        return { ok: false, status: response.status, error: data?.error || `HTTP ${response.status}` };
      }
      return { ...data, status: response.status };
    } catch (e) {
      console.debug("leaderboard submit skipped:", e.message);
      return { ok: false, error: e.message || "Submission unavailable" };
    }
  }

  /** Load + render the leaderboard into #leaderboard-list. */
  async function load(category = activeCategory) {
    initialLoadObserver?.disconnect();
    initialLoadObserver = null;
    const generation = ++loadGeneration;
    profileController?.abort();
    profileController = null;
    activeCategory = category || "connectors";
    wireTabs();
    setActiveTab(activeCategory);
    const el = document.getElementById("leaderboard-list");
    if (!el) return;
    el.setAttribute("aria-busy", "true");
    el.innerHTML = '<div class="lb-loading" role="status">Loading leaderboard…</div>';
    try {
      const url = new URL(WORKER_URL + "/leaderboard");
      url.searchParams.set("limit", "10");
      url.searchParams.set("category", activeCategory);
      const res = await fetch(url.toString(), {
        headers: { "Accept": "application/json" },
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const { entries, category: returnedCategory } = await res.json();
      if (generation !== loadGeneration) return;
      activeCategory = returnedCategory || activeCategory;
      setActiveTab(activeCategory);
      render(el, entries, activeCategory, generation);
    } catch (e) {
      if (generation !== loadGeneration) return;
      el.innerHTML =
        '<div class="lb-empty" role="status"><p>Couldn\'t load the leaderboard. Try again.</p>' +
        '<button class="setting__btn" type="button" data-leaderboard-retry>Try again</button></div>';
    } finally {
      if (generation === loadGeneration) el.setAttribute("aria-busy", "false");
    }
  }

  function render(el, entries, category, generation) {
    if (!entries || entries.length === 0) {
      el.innerHTML =
        `<div class="lb-empty" role="status">No ${esc(categoryLabel(category).toLowerCase())} yet.</div>`;
      return;
    }
    const top = entries
      .filter((entry) => entry?.username)
      .filter((entry) => !entryHasBlockedUser(entry))
      .slice(0, 10);
    if (!top.length) {
      el.innerHTML =
        `<div class="lb-empty" role="status">No ${esc(categoryLabel(category).toLowerCase())} yet.</div>`;
      return;
    }
    renderRows(el, top, new Map(), category);
    const controller = new AbortController();
    profileController = controller;
    const timeout = setTimeout(() => controller.abort(), 5000);
    loadProfiles([...new Set(top.map(entry => entry.username))], controller.signal)
      .then(profiles => {
        if (generation !== loadGeneration || controller.signal.aborted) return;
        renderRows(el, top, profiles, category);
      })
      .finally(() => {
        clearTimeout(timeout);
        if (profileController === controller) profileController = null;
      });
  }

  function renderRows(el, top, profiles, category) {
    const focusedRow = el.contains(document.activeElement)
      ? document.activeElement.closest("button[data-profile-user]")
      : null;
    const focusedUsername = focusedRow?.getAttribute("data-profile-user");
    el.innerHTML = top.map((e, i) => {
      const profile = profiles.get(e.username) || {};
      const rankClass = i === 0 ? " is-gold" : i === 1 ? " is-silver" : i === 2 ? " is-bronze" : "";
      const title = profile.title ? `<span class="lb-title">${esc(profile.title)}</span>` : "";
      const avatar = profile.avatar
        ? `<img class="lb-avatar" src="${esc(profile.avatar)}" alt="${esc(e.username)} profile photo" width="42" height="42" crossorigin="anonymous" referrerpolicy="no-referrer" loading="lazy" decoding="async">`
        : `<span class="lb-avatar lb-avatar--fallback">${esc((e.username[0] || "?").toUpperCase())}</span>`;
      const examples = Array.isArray(e.examples) && e.examples.length
        ? e.examples.map((example) => `${example.start} → ${example.target}`).join(" · ")
        : "submitted chains";
      const ago = timeAgo(e.latestTs || e.ts);
      const metric = metricForEntry(e, category);
      return `
        <button class="lb-row${i < 3 ? " lb-row--top" : ""}" type="button" style="--row-index:${i}"
                data-profile-trigger data-profile-user="${esc(e.username)}" title="Open ${esc(e.username)} profile">
          <div class="lb-rank${rankClass}"><span>${i + 1}</span></div>
          ${avatar}
          <div class="lb-main">
            <div class="lb-path">${title}${esc(displayName(profile, e.username))}</div>
            <div class="lb-meta">${esc(metric.meta)} · ${esc(examples)} · ${ago}</div>
          </div>
          <div class="lb-score">
            <strong>${esc(metric.value)}</strong>
            <small>${esc(metric.label)}</small>
          </div>
        </button>`;
    }).join("");
    if (focusedUsername) {
      [...el.querySelectorAll("button[data-profile-user]")]
        .find(row => row.getAttribute("data-profile-user") === focusedUsername)
        ?.focus({ preventScroll: true });
    }
  }

  function wireTabs() {
    if (tabsWired) return;
    tabsWired = true;
    document.getElementById("leaderboard-list")?.addEventListener("click", event => {
      if (event.target.closest("[data-leaderboard-retry]")) load(activeCategory);
    });
    document.getElementById("leaderboard-tabs")?.addEventListener("click", (event) => {
      const tab = event.target.closest("[data-category]");
      if (!tab) return;
      load(tab.dataset.category);
    });
    document.getElementById("leaderboard-tabs")?.addEventListener("keydown", (event) => {
      const current = event.target.closest("[role='tab'][data-category]");
      if (!current) return;
      const tabs = [...document.querySelectorAll("#leaderboard-tabs [role='tab'][data-category]")];
      const index = tabs.indexOf(current);
      if (index < 0) return;
      let next = null;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") next = tabs[(index + 1) % tabs.length];
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = tabs[(index - 1 + tabs.length) % tabs.length];
      else if (event.key === "Home") next = tabs[0];
      else if (event.key === "End") next = tabs[tabs.length - 1];
      if (!next) return;
      event.preventDefault();
      next.focus();
      load(next.dataset.category);
    });
  }

  function init() {
    wireTabs();
    setActiveTab(activeCategory);
    const section = document.querySelector(".leaderboard-section");
    const panel = document.getElementById("leaderboard-list");
    if (!panel) return;
    panel.innerHTML = '<div class="lb-loading" role="status">Leaderboard loads as you reach it.</div>';
    if (!section || typeof IntersectionObserver !== "function") {
      load();
      return;
    }
    initialLoadObserver = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      initialLoadObserver?.disconnect();
      initialLoadObserver = null;
      load();
    }, { rootMargin: "160px 0px" });
    initialLoadObserver.observe(section);
  }

  function setActiveTab(category) {
    let activeTab = null;
    document.querySelectorAll("#leaderboard-tabs [role='tab'][data-category]").forEach((tab) => {
      const active = tab.dataset.category === category;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", String(active));
      tab.tabIndex = active ? 0 : -1;
      if (active) activeTab = tab;
    });
    const panel = document.getElementById("leaderboard-list");
    if (panel && activeTab?.id) panel.setAttribute("aria-labelledby", activeTab.id);
    const heading = document.getElementById("lb-heading");
    const sub = document.getElementById("lb-sub");
    if (heading) heading.textContent = categoryLabel(category);
    if (sub) sub.textContent = categoryDescription(category);
  }

  function metricForEntry(entry, category) {
    const plainNumber = (value) => {
      const number = Number(value);
      return Number.isFinite(number) ? String(Math.round(number)) : "0";
    };
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
        value: plainNumber(unique),
        label: "players",
        meta: `${Number(entry.count || 0)} successful connection${Number(entry.count || 0) === 1 ? "" : "s"}`,
      };
    }
    if (category === "searched") {
      const count = Number(entry.count || 0);
      return {
        value: plainNumber(count),
        label: "searches",
        meta: "starts and targets counted",
      };
    }
    if (category === "recent") {
      return {
        value: plainNumber(entry.length || entry.count || 0),
        label: "middle",
        meta: `${entry.username} → ${entry.target}`,
      };
    }
    const count = Number(entry.count || 0);
    return {
      value: plainNumber(count),
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

  function categoryDescription(category) {
    return {
      connectors: "People with the most completed connections.",
      fastest: "Completed chains ranked by search time.",
      top_targets: "Targets reached by the most unique players.",
      searched: "Players that appear most often in searches.",
      recent: "Newest completed discoveries.",
    }[category] || "Latest leaderboard results.";
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

  function cleanUsername(value) {
    return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  }

  function isBlockedUsername(username) {
    return BLOCKED_USERNAMES.has(cleanUsername(username));
  }

  function entryHasBlockedUser(entry) {
    if (isBlockedUsername(entry?.username) || isBlockedUsername(entry?.target)) return true;
    if (Array.isArray(entry?.path) && entry.path.some(isBlockedUsername)) return true;
    if (Array.isArray(entry?.examples)) {
      return entry.examples.some((example) =>
        isBlockedUsername(example?.start) || isBlockedUsername(example?.target) ||
        (Array.isArray(example?.path) && example.path.some(isBlockedUsername)));
    }
    return false;
  }

  async function loadProfiles(usernames, signal) {
    const profiles = new Map();
    let cursor = 0;
    const worker = async () => {
      while (cursor < usernames.length && !signal.aborted) {
        const username = usernames[cursor++];
        try {
          const res = await fetch(`${WORKER_URL}/profile?username=${encodeURIComponent(username)}`, {
            headers: { "Accept": "application/json" }, signal,
          });
          if (!res.ok) throw new Error("HTTP " + res.status);
          const data = await res.json();
          profiles.set(username, data.profile || { username, url: `https://www.chess.com/member/${username}` });
        } catch {
          profiles.set(username, { username, url: `https://www.chess.com/member/${username}` });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, usernames.length) }, worker));
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

  return { submit, load, init };
})();
