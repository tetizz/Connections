/* ============================================================
   Chess Connections — app.js
   - Loads a precomputed showcase (data/chains.json)
   - Lets the visitor enter their own username + target and runs
     the BFS search live in the browser (engine.js)
   - Saves the username in localStorage for next visit
   - Renders results as an animated node graph + hop cards
   ============================================================ */

(() => {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const DATA_BASE = new URL("./data/", document.baseURI).href;
  const LS_KEY = "chess-connections:username";
  const LS_THEME_KEY = "chess-connections:theme";
  const LS_RANGE_KEY = "chess-connections:range";
  const LS_RANGE_MIGRATION_KEY = "chess-connections:instant-range-default";
  const LS_ACTIVE_JOB_KEY = "chess-connections:active-search-job:v1";
  const INTRO_COMPLETE_KEY = "chess-connections:intro-complete:v1";
  const CHAIN_PARAM = "chain";
  const SHORT_CHAIN_PARAM = "c";
  const LEGACY_SHARE_PARAM = "share";
  const DEFAULT_TARGET = "magnuscarlsen";
  const AUTO_SEARCH_DEPTH = 5;
  const LEGACY_DEPTH_KEY = "chess-connections:depth";
  const CHESS_LEADERBOARDS_URL = "https://api.chess.com/pub/leaderboards";
  const SUGGEST_MIN_CHARS = 2;
  const SUGGEST_LIMIT = 10;
  const OWNER_ANALYTICS_LIMIT = 30;
  let introCompletedThisSession = false;
  const QUICK_TARGET_GROUPS = [
    {
      id: "rapid",
      label: "Rapid",
      source: "live_rapid",
      icon: "rapid",
    },
    {
      id: "blitz",
      label: "Blitz",
      source: "live_blitz",
      icon: "blitz",
    },
    {
      id: "bullet",
      label: "Bullet",
      source: "live_bullet",
      icon: "bullet",
    },
  ];

  const state = {
    chains: null,
    players: null,
    activeTarget: null,
    currentChain: null,
    profilePromises: new Map(),
    profilePopoverToken: 0,
    suggest: {
      items: [],
      activeIndex: -1,
      field: "start",
      focused: false,
      timer: null,
      controller: null,
      seq: 0,
    },
    ownerCode: "",
    queueTimer: null,
  };

  // ---------- small utils ----------
  const $ = (sel) => document.querySelector(sel);
  const el = (tag, attrs = {}, children = []) => {
    const n = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    for (const c of [].concat(children)) {
      if (c == null) continue;
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return n;
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
  const plainNumber = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? String(Math.round(number)) : "";
  };
  const connectionCount = (path = []) => Math.max(0, path.length - 2);
  const stepText = (count) => `${count} step${count === 1 ? "" : "s"}`;

  const titleOf = (u) => state.players?.[u.toLowerCase()]?.title || null;
  const nameOf = (u) => {
    const p = state.players?.[u.toLowerCase()];
    return p?.name || p?.username || u;
  };
  const avatarOf = (u) => state.players?.[u.toLowerCase()]?.avatar || null;
  const cleanUsernameInput = (value) =>
    String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");

  // ---------- data load ----------
  async function loadShowcase() {
    try {
      const [chainsRes, playersRes] = await Promise.all([
        fetch(DATA_BASE + "chains.json"),
        fetch(DATA_BASE + "players.json"),
      ]);
      if (!chainsRes.ok) throw new Error("chains.json " + chainsRes.status);
      state.chains = await chainsRes.json();
      state.players = playersRes.ok ? await playersRes.json() : {};
    } catch (e) {
      console.error(e);
      $("#graph-hint").textContent =
        "no example loaded yet — try the search above to see your own connection";
      return;
    }
    renderShowcaseTabs();
    // show an example chain so the page isn't blank on first visit
    const first =
      state.chains.chains.find((c) => c.found && c.target === DEFAULT_TARGET) ||
      state.chains.chains.find((c) => c.found) ||
      state.chains.chains[0];
    if (first) selectTarget(first.target);
  }

  function renderShowcaseTabs() {
    // we keep a lightweight showcase selector below the search for quick swaps
    // (built dynamically only if showcase chains exist)
    if (!state.chains?.chains?.length) return;
    // default the search target to the first found showcase target
    if (!$("#search-target").value) {
      const first =
        state.chains.chains.find((c) => c.found && c.target === DEFAULT_TARGET) ||
        state.chains.chains.find((c) => c.found);
      if (first) $("#search-target").value = first.target;
    }
  }

  // ---------- Chess.com leaderboard quick targets ----------
  function renderQuickTargetsLoading() {
    const wrap = $("#quick-target-groups");
    if (!wrap) return;
    wrap.innerHTML = `
      <div class="quick-targets__empty" role="status">
        <strong>Loading live rankings...</strong>
        <span>Pulling the current Rapid, Blitz, and Bullet top 10 from Chess.com.</span>
      </div>
    `;
  }

  function renderLeaderboardUnavailable(error) {
    const wrap = $("#quick-target-groups");
    if (!wrap) return;
    wrap.innerHTML = `
      <div class="quick-targets__empty" role="status">
        <strong>Live rankings unavailable.</strong>
        <span>Retry in a moment. You can still type any Chess.com username into Connect to.</span>
      </div>
    `;
  }

  function renderQuickTargets(groups) {
    const wrap = $("#quick-target-groups");
    if (!wrap) return;
    const playableGroups = groups.filter((group) => group.players?.length);
    if (!playableGroups.length) {
      renderLeaderboardUnavailable();
      return;
    }
    const active = ($("#search-target")?.value || DEFAULT_TARGET).trim().toLowerCase();
    wrap.innerHTML = playableGroups.map((group, groupIndex) => `
      <section class="quick-group" style="--group-index:${groupIndex}" aria-label="${esc(group.label)} targets">
        <div class="quick-group__title">
          <span class="quick-group__icon quick-group__icon--${esc(group.id)}" aria-hidden="true">${quickIcon(group.icon)}</span>
          <span>${esc(group.label)}</span>
          <small>top 10 live</small>
        </div>
        <div class="quick-group__players">
          ${group.players.map((player, index) => quickTargetButton(player, index, active)).join("")}
        </div>
        ${group.players.length > 5 ? `<button class="quick-more" type="button" data-group="${esc(group.id)}">Show 5 more</button>` : ""}
      </section>
    `).join("");
  }

  function quickTargetButton(player, index, active) {
    const username = player.username.toLowerCase();
    const display = player.display || player.username;
    const title = player.title ? `<span class="quick-player__title">${esc(player.title)}</span>` : "";
    const rank = Number.isFinite(player.rank) ? `<span class="quick-player__rank">#${player.rank}</span>` : "";
    const score = Number.isFinite(player.score) ? `<span>${plainNumber(player.score)}</span>` : "";
    const avatar = player.avatar
      ? `<img class="quick-player__photo" src="${esc(player.avatar)}" alt="${esc(display)} profile photo" width="34" height="34" referrerpolicy="no-referrer" loading="lazy" decoding="async">`
      : `<span>${esc((display[0] || "?").toUpperCase())}</span>`;
    return `
      <button class="chip quick-player${username === active ? " is-active" : ""}" type="button"
              data-target="${esc(username)}" data-display="${esc(display)}" style="--player-index:${index}"${index >= 5 ? " hidden" : ""}>
        <span class="quick-player__avatar" data-profile-trigger data-profile-user="${esc(username)}" title="Open ${esc(display)} profile">${avatar}</span>
        <span class="quick-player__body">
          <span class="quick-player__name">${rank}<strong>${esc(display)}</strong></span>
          <span class="quick-player__meta">${title}${score}</span>
        </span>
      </button>
    `;
  }

  function quickIcon(kind) {
    const icons = {
      rapid: "assets/icon-rapid.svg",
      blitz: "assets/icon-blitz.svg",
      bullet: "assets/icon-bullet.svg",
    };
    const src = icons[kind] || icons.rapid;
    return `<img class="quick-group__image-icon" src="${src}" width="16" height="16" alt="" aria-hidden="true" loading="lazy" decoding="async">`;
  }

  async function loadLeaderboardTargets() {
    renderQuickTargetsLoading();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6500);
    try {
      const res = await fetch(CHESS_LEADERBOARDS_URL, {
        headers: { "Accept": "application/json" },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`leaderboards ${res.status}`);
      const data = await res.json();
      renderQuickTargets(buildLeaderboardTargetGroups(data));
    } catch (error) {
      renderLeaderboardUnavailable(error);
    } finally {
      clearTimeout(timeout);
      setActiveChip($("#search-target")?.value || DEFAULT_TARGET);
    }
  }

  function buildLeaderboardTargetGroups(data) {
    return QUICK_TARGET_GROUPS.map((group) => {
      const rows = Array.isArray(data?.[group.source]) ? data[group.source] : [];
      const players = rows
        .slice(0, 10)
        .map(normalizeQuickPlayer)
        .filter(Boolean);
      return {
        ...group,
        players,
      };
    });
  }

  function normalizeQuickPlayer(player) {
    const username = String(player?.username || "").trim().toLowerCase();
    if (!username) return null;
    const normalized = {
      username,
      display: player.name || player.display || player.username,
      title: player.title || "",
      rank: Number.isFinite(player.rank) ? player.rank : null,
      score: Number.isFinite(player.score) ? player.score : null,
      tag: player.tag || "",
      avatar: player.avatar || "",
      url: player.url || `https://www.chess.com/member/${encodeURIComponent(player.username || username)}`,
    };
    if (state.players) {
      state.players[username] = {
        ...(state.players[username] || {}),
        username,
        avatar: normalized.avatar || state.players[username]?.avatar,
        title: normalized.title || state.players[username]?.title,
        name: normalized.display || state.players[username]?.name,
        url: normalized.url || state.players[username]?.url,
      };
    }
    return normalized;
  }

  // ---------- username autocomplete ----------
  function suggestConfig(field = state.suggest.field || "start") {
    return field === "target"
      ? { field: "target", input: "#search-target", box: "#target-suggest" }
      : { field: "start", input: "#search-start", box: "#username-suggest" };
  }

  function scheduleUsernameSuggest(value, field = "start") {
    clearTimeout(state.suggest.timer);
    state.suggest.field = field;
    state.suggest.focused = true;
    const query = cleanUsernameInput(value);
    if (query.length < SUGGEST_MIN_CHARS) {
      hideUsernameSuggest();
      return;
    }
    renderUsernameSuggest(query, localUsernameSuggestions(query), { loading: true }, field);
    state.suggest.timer = setTimeout(() => loadUsernameSuggestions(query, field), 180);
  }

  async function loadUsernameSuggestions(query, field = state.suggest.field) {
    const config = suggestConfig(field);
    const input = $(config.input);
    if (!input || cleanUsernameInput(input.value) !== query) return;
    state.suggest.controller?.abort();
    const seq = ++state.suggest.seq;
    const controller = new AbortController();
    state.suggest.controller = controller;
    const remote = await fetchUsernameSuggestions(query, controller.signal).catch(() => []);
    if (seq !== state.suggest.seq || state.suggest.field !== field || cleanUsernameInput(input.value) !== query) return;
    renderUsernameSuggest(query, mergeUsernameSuggestions(remote, localUsernameSuggestions(query)), {}, field);
  }

  async function fetchUsernameSuggestions(query, signal) {
    const remoteBase = String(window.CONNECTIONS_CACHE_API || "").replace(/\/+$/, "");
    if (!/^https?:\/\//.test(remoteBase)) return [];
    const res = await fetch(`${remoteBase}/suggest?query=${encodeURIComponent(query)}&limit=${SUGGEST_LIMIT}`, {
      headers: { "Accept": "application/json" },
      signal,
    });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data.suggestions) ? data.suggestions.map(normalizeSuggestion).filter(Boolean) : [];
  }

  function localUsernameSuggestions(query) {
    const q = query.toLowerCase();
    const all = Object.values(state.players || {})
      .map((player) => normalizeSuggestion(player))
      .filter(Boolean)
      .filter((player) => player.username.includes(q) || String(player.name || "").toLowerCase().includes(q));
    return all
      .sort((a, b) => suggestionScore(b, q) - suggestionScore(a, q) || a.username.localeCompare(b.username))
      .slice(0, SUGGEST_LIMIT);
  }

  function mergeUsernameSuggestions(...groups) {
    const merged = new Map();
    for (const group of groups) {
      for (const item of group || []) {
        if (!item?.username) continue;
        const current = merged.get(item.username);
        merged.set(item.username, {
          ...(current || {}),
          ...item,
          avatar: item.avatar || current?.avatar || "",
          title: item.title || current?.title || "",
          name: item.name || current?.name || "",
          country: item.country || current?.country || "",
        });
      }
    }
    return [...merged.values()].slice(0, SUGGEST_LIMIT);
  }

  function normalizeSuggestion(item) {
    const username = cleanUsernameInput(item?.username);
    if (!username) return null;
    return {
      username,
      name: String(item?.name || item?.display || ""),
      title: String(item?.title || ""),
      avatar: String(item?.avatar || ""),
      country: countryCode(item?.country || ""),
      url: String(item?.url || `https://www.chess.com/member/${username}`),
      followers: Number.isFinite(item?.followers) ? item.followers : null,
      status: String(item?.status || ""),
      score: Number.isFinite(item?.score) ? item.score : null,
      rank: Number.isFinite(item?.rank) ? item.rank : null,
    };
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

  function renderUsernameSuggest(query, items, options = {}, field = state.suggest.field) {
    const config = suggestConfig(field);
    const box = $(config.box);
    const input = $(config.input);
    if (!box || !input || !state.suggest.focused || state.suggest.field !== field || query.length < SUGGEST_MIN_CHARS) return;
    state.suggest.items = items.slice(0, SUGGEST_LIMIT);
    state.suggest.activeIndex = state.suggest.items.length ? 0 : -1;
    input.setAttribute("aria-expanded", "true");
    for (const other of ["start", "target"]) {
      if (other !== field) {
        const otherConfig = suggestConfig(other);
        const otherBox = $(otherConfig.box);
        const otherInput = $(otherConfig.input);
        if (otherBox) otherBox.hidden = true;
        otherInput?.setAttribute("aria-expanded", "false");
      }
    }
    box.hidden = false;
    box.innerHTML = `
      <div class="username-suggest__panel">
        ${options.loading ? `<div class="username-suggest__status">Searching players...</div>` : ""}
        ${state.suggest.items.length ? state.suggest.items.map((item, index) => usernameSuggestionRow(item, index)).join("") : usernameSuggestEmpty(query)}
        <button class="username-suggest__all" type="button" data-exact="${esc(query)}">Use exact username "${esc(query)}"</button>
      </div>
    `;
  }

  function usernameSuggestionRow(item, index) {
    const display = item.name || item.username;
    const avatar = item.avatar
      ? `<img src="${esc(item.avatar)}" alt="${esc(display)} profile photo" referrerpolicy="no-referrer" loading="lazy" decoding="async">`
      : `<span>${esc((display[0] || "?").toUpperCase())}</span>`;
    const title = item.title ? `<span class="username-suggest__title">${esc(item.title)}</span>` : "";
    const country = countryFlagIcon(item.country);
    return `
      <button class="username-suggest__row${index === state.suggest.activeIndex ? " is-active" : ""}" type="button"
              role="option" aria-selected="${index === state.suggest.activeIndex ? "true" : "false"}"
              data-index="${index}" data-username="${esc(item.username)}">
        <span class="username-suggest__avatar">${avatar}</span>
        <span class="username-suggest__body">
          <span class="username-suggest__name">${title}<strong>${esc(display)}</strong>${country}</span>
          <span class="username-suggest__handle">@${esc(item.username)}</span>
        </span>
      </button>
    `;
  }

  function usernameSuggestEmpty(query) {
    return `
      <div class="username-suggest__empty">
        <strong>No matching player yet.</strong>
        <span>Press Enter to check ${esc(query)} directly.</span>
      </div>
    `;
  }

  function moveUsernameSuggest(delta) {
    if (!state.suggest.items.length) return;
    const config = suggestConfig();
    state.suggest.activeIndex = (state.suggest.activeIndex + delta + state.suggest.items.length) % state.suggest.items.length;
    $(config.box)?.querySelectorAll(".username-suggest__row").forEach((row, index) => {
      const active = index === state.suggest.activeIndex;
      row.classList.toggle("is-active", active);
      row.setAttribute("aria-selected", active ? "true" : "false");
      if (active) row.scrollIntoView({ block: "nearest" });
    });
  }

  function selectUsernameSuggestion(username, field = state.suggest.field) {
    const value = cleanUsernameInput(username);
    if (!value) return;
    if (field === "target") {
      $("#search-target").value = value;
      setActiveChip(value);
      hideUsernameSuggest();
      $(".search__btn")?.focus();
      return;
    }
    $("#search-start").value = value;
    $("#setting-username").value = value;
    hideUsernameSuggest();
    $("#search-target")?.focus();
  }

  function hideUsernameSuggest() {
    clearTimeout(state.suggest.timer);
    state.suggest.controller?.abort();
    state.suggest.items = [];
    state.suggest.activeIndex = -1;
    for (const field of ["start", "target"]) {
      const config = suggestConfig(field);
      const box = $(config.box);
      const input = $(config.input);
      if (box) {
        box.hidden = true;
        box.innerHTML = "";
      }
      input?.setAttribute("aria-expanded", "false");
    }
  }

  function countryFlagIcon(country) {
    return flagIcon(country, "username-suggest__flag");
  }

  function flagIcon(country, className = "flag-icon") {
    const code = countryCode(country).toLowerCase();
    if (!/^[a-z]{2}$/.test(code)) return "";
    const label = code.toUpperCase();
    const safeClass = esc(className);
    return `
      <span class="${safeClass}" title="${esc(label)}">
        <img src="https://flagcdn.com/w20/${esc(code)}.png"
             srcset="https://flagcdn.com/w40/${esc(code)}.png 2x"
             alt="${esc(label)} flag"
             loading="lazy"
             decoding="async"
             referrerpolicy="no-referrer"
             onerror="if(this.nextElementSibling)this.nextElementSibling.hidden=false; this.remove();">
        <span class="${safeClass}-code" hidden>${esc(label)}</span>
      </span>
    `;
  }

  // ---------- render a chain (shared by showcase + live search) ----------
  function selectTarget(target) {
    state.activeTarget = target;
    setActiveChip(target);
    const chain = state.chains?.chains.find((c) => c.target === target);
    if (chain) {
      renderChain({
        target: chain.target,
        display: chain.display || nameOf(chain.target),
        found: chain.found,
        length: chain.length,
        path: chain.path,
        hops: chain.hops,
      });
    }
  }

  function renderChain(chain) {
    state.currentChain = chain;
    $("#target-name").textContent = chain.display || chain.target;
    $("#chain-length").textContent = chain.found ? chain.length : "—";
    renderQualityBadge(chain);
    renderGraph(chain);
    renderCards(chain);
    updateShareButton(chain);
  }

  function renderQualityBadge(chain) {
    const badge = $("#quality-badge");
    if (!badge) return;
    const quality = qualityFromChain(chain);
    if (!chain?.found || !quality) {
      badge.hidden = true;
      return;
    }
    badge.hidden = false;
    badge.querySelector("strong").textContent = `${quality.label} · ${quality.score}`;
    badge.title = `${quality.proofs || 0} proof game${quality.proofs === 1 ? "" : "s"}${Number.isFinite(quality.ageDays) ? ` · newest proof ${quality.ageDays}d old` : ""}`;
  }

  function qualityFromChain(chain) {
    if (chain?.quality) return chain.quality;
    if (!chain?.found || !Array.isArray(chain.hops)) return null;
    const proofs = chain.hops.filter((hop) => hop?.url).length;
    const dated = chain.hops.filter((hop) => isValidProofTime(hop?.endTime)).length;
    const steps = Math.max(0, (chain.path || []).length - 1);
    let score = 100 - Math.max(0, steps - 1) * 7;
    if (dated < proofs) score -= 6;
    if (proofs < steps) score -= 18;
    score = Math.max(0, Math.min(100, Math.round(score)));
    return {
      score,
      label: score >= 86 ? "Excellent" : score >= 72 ? "Strong" : score >= 56 ? "Good" : "Needs fresher proof",
      proofs,
      ageDays: null,
      source: "browser",
    };
  }

  function updateShareButton(chain) {
    const btn = $("#copy-share");
    const imageBtn = $("#save-share-image");
    if (!btn) return;
    if (!chain?.found || !Array.isArray(chain.path) || !chain.path.length) {
      btn.hidden = true;
      if (imageBtn) imageBtn.hidden = true;
      delete btn.dataset.shareUrl;
      return;
    }
    btn.hidden = false;
    if (imageBtn) imageBtn.hidden = false;
    btn.dataset.shareUrl = buildLongShareUrl(chain);
    btn.classList.remove("is-copied");
    btn.lastChild.textContent = " Copy link";
  }

  function buildLongShareUrl(chain) {
    const url = new URL(location.href);
    url.searchParams.set(CHAIN_PARAM, encodeSharePayload(chain));
    url.searchParams.delete(SHORT_CHAIN_PARAM);
    url.searchParams.delete(LEGACY_SHARE_PARAM);
    url.searchParams.set("v", "chain");
    return url.toString();
  }

  function buildShortShareUrl(id) {
    const url = new URL(location.href);
    url.searchParams.set(SHORT_CHAIN_PARAM, id);
    url.searchParams.delete(CHAIN_PARAM);
    url.searchParams.delete(LEGACY_SHARE_PARAM);
    url.searchParams.delete("v");
    return url.toString();
  }

  function encodeSharePayload(chain) {
    return base64UrlEncode(JSON.stringify(sharePayload(chain)));
  }

  function sharePayload(chain) {
    const players = {};
    for (const username of chain.path || []) {
      const key = String(username || "").toLowerCase();
      if (!key || !state.players?.[key]) continue;
      players[key] = state.players[key];
    }
    const payload = {
      v: 1,
      target: chain.target,
      display: chain.display || nameOf(chain.target),
      found: true,
      length: chain.length,
      path: chain.path,
      hops: chain.hops,
      quality: qualityFromChain(chain),
      players,
      ts: Date.now(),
    };
    return payload;
  }

  function decodeSharePayload(value) {
    try {
      const parsed = JSON.parse(base64UrlDecode(value || ""));
      if (parsed?.v !== 1 || !Array.isArray(parsed.path) || !Array.isArray(parsed.hops)) return null;
      if (parsed.path.length < 2 || parsed.hops.length !== parsed.path.length - 1) return null;
      const path = parsed.path.map((u) => String(u || "").trim().toLowerCase()).filter(Boolean).slice(0, 12);
      const hops = parsed.hops.slice(0, 11).map((hop, index) => ({
        from: String(hop?.from || path[index] || "").trim().toLowerCase(),
        to: String(hop?.to || path[index + 1] || "").trim().toLowerCase(),
        url: String(hop?.url || ""),
      })).filter((hop) => hop.from && hop.to);
      if (path.length < 2 || hops.length !== path.length - 1) return null;
      return {
        target: String(parsed.target || path[path.length - 1]).trim().toLowerCase(),
        display: String(parsed.display || parsed.target || path[path.length - 1]),
        found: true,
        length: Number.isFinite(parsed.length) ? parsed.length : hops.length,
        path,
        hops,
        quality: parsed.quality || null,
        players: parsed.players && typeof parsed.players === "object" ? parsed.players : {},
      };
    } catch {
      return null;
    }
  }

  async function loadSharedChainFromUrl() {
    const params = new URL(location.href).searchParams;
    let shared = null;
    const shortId = params.get(SHORT_CHAIN_PARAM);
    if (shortId) {
      shared = await fetchShortSharedChain(shortId);
    }
    if (!shared) {
      shared = decodeSharePayload(params.get(CHAIN_PARAM) || params.get(LEGACY_SHARE_PARAM));
    }
    if (!shared) return false;
    state.players = state.players || {};
    for (const [username, profile] of Object.entries(shared.players || {})) {
      const key = username.toLowerCase();
      state.players[key] = {
        ...(state.players[key] || {}),
        ...metaShape({ username: key, ...profile }),
      };
    }
    $("#search-start").value = shared.path[0] || "";
    $("#search-target").value = shared.target;
    renderChain(shared);
    showStatus("done", `loaded a shared chain to ${shared.display || shared.target}.`);
    return true;
  }

  async function fetchShortSharedChain(id) {
    const remoteBase = workerBase();
    if (!remoteBase || !id) return null;
    try {
      const res = await fetch(`${remoteBase}/share?id=${encodeURIComponent(id)}`, {
        headers: { "Accept": "application/json" },
      });
      if (!res.ok) return null;
      const data = await res.json();
      return decodeShareObject(data.share);
    } catch {
      return null;
    }
  }

  function decodeShareObject(parsed) {
    if (!parsed || typeof parsed !== "object") return null;
    const path = Array.isArray(parsed.path)
      ? parsed.path.map((u) => String(u || "").trim().toLowerCase()).filter(Boolean).slice(0, 12)
      : [];
    const hops = Array.isArray(parsed.hops)
      ? parsed.hops.slice(0, 11).map((hop, index) => ({
          from: String(hop?.from || path[index] || "").trim().toLowerCase(),
          to: String(hop?.to || path[index + 1] || "").trim().toLowerCase(),
          url: String(hop?.url || ""),
        })).filter((hop) => hop.from && hop.to)
      : [];
    if (path.length < 2 || hops.length !== path.length - 1) return null;
    return {
      target: String(parsed.target || path[path.length - 1]).trim().toLowerCase(),
      display: String(parsed.display || parsed.target || path[path.length - 1]),
      found: true,
      length: Number.isFinite(parsed.length) ? parsed.length : hops.length,
      path,
      hops,
      quality: parsed.quality || null,
      players: parsed.players && typeof parsed.players === "object" ? parsed.players : {},
    };
  }

  function base64UrlEncode(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function base64UrlDecode(value) {
    const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  async function copyShareLink() {
    const btn = $("#copy-share");
    let url = btn?.dataset.shareUrl;
    if (!btn || !url) return;
    const chain = state.currentChain;
    btn.disabled = true;
    btn.lastChild.textContent = " Creating link";
    try {
      url = await createShortShareUrl(chain) || url;
      btn.dataset.shareUrl = url;
    } finally {
      btn.disabled = false;
    }
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    btn.classList.add("is-copied");
    btn.lastChild.textContent = " Copied";
    setTimeout(() => {
      btn.classList.remove("is-copied");
      btn.lastChild.textContent = " Copy link";
    }, 1600);
  }

  async function saveShareImage() {
    const chain = state.currentChain;
    if (!chain?.found || !Array.isArray(chain.path)) return;
    const btn = $("#save-share-image");
    if (btn) {
      btn.disabled = true;
      btn.lastChild.textContent = " Saving";
    }
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 1400;
      canvas.height = 760;
      const ctx = canvas.getContext("2d");
      drawShareBackground(ctx, canvas);
      const quality = qualityFromChain(chain);
      ctx.fillStyle = "#f6efe2";
      ctx.font = "800 56px Inter, system-ui, sans-serif";
      ctx.fillText("Chess Connections", 80, 98);
      ctx.font = "600 28px Inter, system-ui, sans-serif";
      ctx.fillStyle = "rgba(246,239,226,.72)";
      ctx.fillText(`${nameOf(chain.path[0])} to ${nameOf(chain.path[chain.path.length - 1])}`, 82, 142);
      drawSharePill(ctx, `${chain.hops.length} proof game${chain.hops.length === 1 ? "" : "s"}`, 82, 182);
      drawSharePill(ctx, `${quality.label} ${quality.score}`, 330, 182);
      await drawShareChain(ctx, chain);
      ctx.fillStyle = "rgba(246,239,226,.56)";
      ctx.font = "600 22px Inter, system-ui, sans-serif";
      ctx.fillText("Every link is a real Chess.com live win.", 82, 690);
      const url = canvas.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = url;
      a.download = `connections-${chain.path[0]}-${chain.path[chain.path.length - 1]}.png`;
      a.click();
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.lastChild.textContent = " Save image";
      }
    }
  }

  function drawShareBackground(ctx, canvas) {
    const gradient = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, "#151a15");
    gradient.addColorStop(0.55, "#080b09");
    gradient.addColorStop(1, "#1d211a");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = "rgba(240,201,119,.18)";
    ctx.lineWidth = 2;
    ctx.strokeRect(34, 34, canvas.width - 68, canvas.height - 68);
    ctx.fillStyle = "rgba(201,155,75,.10)";
    ctx.beginPath();
    ctx.arc(1130, 110, 260, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawSharePill(ctx, text, x, y) {
    ctx.font = "800 20px Inter, system-ui, sans-serif";
    const width = Math.ceil(ctx.measureText(text).width + 34);
    roundRect(ctx, x, y - 28, width, 44, 22);
    ctx.fillStyle = "rgba(240,201,119,.18)";
    ctx.fill();
    ctx.strokeStyle = "rgba(240,201,119,.36)";
    ctx.stroke();
    ctx.fillStyle = "#f0c977";
    ctx.fillText(text, x + 17, y);
  }

  async function drawShareChain(ctx, chain) {
    const nodes = chain.path;
    const startX = 110;
    const endX = 1290;
    const y = 410;
    const step = nodes.length > 1 ? (endX - startX) / (nodes.length - 1) : 0;
    ctx.lineWidth = 6;
    ctx.strokeStyle = "rgba(240,201,119,.52)";
    ctx.beginPath();
    nodes.forEach((_, index) => {
      const x = startX + step * index;
      if (index === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    for (let i = 0; i < nodes.length; i++) {
      const username = nodes[i];
      const x = startX + step * i;
      await drawShareNode(ctx, username, x, y);
    }
  }

  async function drawShareNode(ctx, username, x, y) {
    ctx.save();
    ctx.fillStyle = "#0d100e";
    ctx.strokeStyle = "#f0c977";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(x, y, 48, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    const img = await loadDrawableImage(avatarOf(username));
    if (img) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, 42, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(img, x - 42, y - 42, 84, 84);
      ctx.restore();
    } else {
      ctx.fillStyle = "#f0c977";
      ctx.font = "900 38px Inter, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText((nameOf(username)[0] || "?").toUpperCase(), x, y + 1);
    }
    ctx.fillStyle = "#f6efe2";
    ctx.font = "800 20px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(compactGraphLabel(nameOf(username), 14), x, y + 82);
    ctx.restore();
  }

  function loadDrawableImage(src) {
    return new Promise((resolve) => {
      if (!src) return resolve(null);
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.referrerPolicy = "no-referrer";
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = src;
      setTimeout(() => resolve(null), 1800);
    });
  }

  function roundRect(ctx, x, y, width, height, radius) {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + width, y, x + width, y + height, radius);
    ctx.arcTo(x + width, y + height, x, y + height, radius);
    ctx.arcTo(x, y + height, x, y, radius);
    ctx.arcTo(x, y, x + width, y, radius);
    ctx.closePath();
  }

  async function createShortShareUrl(chain) {
    const remoteBase = workerBase();
    if (!remoteBase || !chain?.found) return "";
    try {
      const res = await fetch(`${remoteBase}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(sharePayload(chain)),
      });
      if (!res.ok) return "";
      const data = await res.json();
      return data.id ? buildShortShareUrl(data.id) : "";
    } catch {
      return "";
    }
  }

  function submitLeaderboardChain(start, target, chain) {
    if (!window.Leaderboard || !chain?.found || !Array.isArray(chain.path)) return;
    window.Leaderboard.submit(start, target, connectionCount(chain.path), chain.path, chain.hops || [])
      .then(() => window.Leaderboard && window.Leaderboard.load());
  }

  function workerBase() {
    const remoteBase = String(window.CONNECTIONS_CACHE_API || "").replace(/\/+$/, "");
    return /^https?:\/\//.test(remoteBase) ? remoteBase : "";
  }

  function newSearchEventId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    if (window.crypto?.getRandomValues) {
      const values = new Uint32Array(2);
      window.crypto.getRandomValues(values);
      return `search-${Date.now().toString(36)}-${values[0].toString(36)}${values[1].toString(36)}`;
    }
    return `search-${Date.now().toString(36)}-${String(performance.now()).replace(/[^0-9]/g, "").slice(0, 10)}`;
  }

  function recordSearchEvent(outcome, detail = {}) {
    const remoteBase = workerBase();
    if (!remoteBase) return;
    const payload = {
      searchId: detail.searchId,
      jobId: detail.jobId || detail.searchId,
      outcome,
      start: detail.start,
      target: detail.target,
      depth: detail.depth,
      range: detail.range,
      length: Number.isFinite(detail.length) ? detail.length : null,
      steps: Number.isFinite(detail.steps) ? detail.steps : null,
      path: Array.isArray(detail.path) ? detail.path : [],
      durationMs: Number.isFinite(detail.durationMs) ? detail.durationMs : null,
      requests: Number.isFinite(detail.requests) ? detail.requests : null,
      cached: Number.isFinite(detail.cached) ? detail.cached : null,
      error: detail.error || "",
      quality: detail.quality || null,
    };
    fetch(`${remoteBase}/analytics/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {});
  }

  async function loadOwnerAnalytics() {
    const remoteBase = workerBase();
    const codeInput = $("#owner-code");
    const status = $("#owner-status");
    const wrap = $("#owner-analytics");
    const btn = $("#owner-load");
    const filters = $("#owner-filters");
    const code = String(codeInput?.value || "").trim();
    if (!remoteBase || !codeInput || !status || !wrap || !btn) return;
    if (!code) {
      status.hidden = false;
      status.textContent = "Enter the owner code first.";
      wrap.hidden = true;
      if (filters) filters.hidden = true;
      return;
    }

    btn.disabled = true;
    status.hidden = false;
    status.textContent = "Loading recent searches...";
    try {
      const url = new URL(`${remoteBase}/analytics`);
      url.searchParams.set("limit", OWNER_ANALYTICS_LIMIT);
      const outcome = String($("#owner-filter-outcome")?.value || "").trim();
      const username = String($("#owner-filter-username")?.value || "").trim();
      const target = cleanUsernameInput($("#owner-filter-target")?.value || "");
      const range = String($("#owner-filter-range")?.value || "").trim();
      if (outcome) url.searchParams.set("outcome", outcome);
      if (username) url.searchParams.set("username", username);
      if (target) url.searchParams.set("target", target);
      const from = ownerRangeStart(range);
      if (from) url.searchParams.set("from", from);
      const res = await fetch(url.toString(), {
        headers: {
          "Accept": "application/json",
          "X-Owner-Code": code,
        },
      });
      if (res.status === 401 || res.status === 403) {
        throw new Error("Wrong owner code.");
      }
      if (!res.ok) throw new Error("Analytics are unavailable right now.");
      const data = await res.json();
      renderOwnerAnalytics(data);
      state.ownerCode = code;
      if (filters) filters.hidden = false;
      status.hidden = false;
      const total = Number(data.total || 0);
      status.textContent = `${plainNumber(total)} matching search${total === 1 ? "" : "es"}.`;
    } catch (error) {
      wrap.hidden = true;
      if (filters) filters.hidden = true;
      status.hidden = false;
      status.textContent = error.message || "Could not load analytics.";
    } finally {
      btn.disabled = false;
    }
  }

  function renderOwnerAnalytics(data) {
    const wrap = $("#owner-analytics");
    if (!wrap) return;
    const events = Array.isArray(data?.events) ? data.events : [];
    wrap.hidden = false;
    if (!events.length) {
      wrap.innerHTML = `<div class="owner-summary"><span>No matching searches.</span></div>`;
      return;
    }
    wrap.innerHTML = `
      <div class="owner-summary">
        <span>Last ${events.length} matching searches</span>
        <span>${esc(new Date(data.generatedAt || Date.now()).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))}</span>
      </div>
      ${events.map(ownerEventRow).join("")}
    `;
  }

  function ownerEventRow(event) {
    const outcome = String(event.outcome || "search").replace(/_/g, "-");
    const path = Array.isArray(event.path) && event.path.length > 1
      ? `<div class="owner-event__chain">${esc(event.path.join(" -> "))}</div>`
      : "";
    const range = event.range ? String(event.range).replace(/_/g, " ") : "range n/a";
    const place = [event.country, event.device].filter(Boolean).join(" · ") || "visitor";
    const when = Number.isFinite(event.ts) ? timeAgo(event.ts) : "just now";
    const duration = Number.isFinite(event.durationMs) ? `${(event.durationMs / 1000).toFixed(event.durationMs < 10000 ? 1 : 0)}s` : "";
    const requests = Number.isFinite(event.requests) ? `${event.requests} requests` : "";
    const cached = Number.isFinite(event.cached) ? `${event.cached} reused` : "";
    const cacheRate = Number.isFinite(event.requests) || Number.isFinite(event.cached)
      ? `${cacheHitRate(event)} cache hit`
      : "";
    const quality = event.quality?.label ? `${event.quality.label} ${event.quality.score}` : "";
    const stats = [duration, requests, cached, cacheRate, quality].filter(Boolean).join(" · ");
    const error = event.error ? `<div class="owner-event__chain">${esc(event.error)}</div>` : "";
    return `
      <div class="owner-event">
        <div class="owner-event__top">
          <span class="owner-event__path">${esc(event.start || "?")} -> ${esc(event.target || "?")}</span>
          <span class="owner-event__status is-${esc(outcome)}">${esc(statusText(event.outcome))}</span>
        </div>
        <div class="owner-event__meta">
          <span>${esc(when)} · ${esc(range)}${stats ? ` · ${esc(stats)}` : ""}</span>
          <span>${esc(place)}</span>
        </div>
        ${path}
        ${error}
      </div>
    `;
  }

  function ownerRangeStart(range) {
    const now = Date.now();
    if (range === "24h") return now - 24 * 60 * 60 * 1000;
    if (range === "7d") return now - 7 * 24 * 60 * 60 * 1000;
    if (range === "30d") return now - 30 * 24 * 60 * 60 * 1000;
    return null;
  }

  function cacheHitRate(event) {
    const requests = Number(event.requests || 0);
    const cached = Number(event.cached || 0);
    const total = requests + cached;
    if (!total) return "0%";
    return `${Math.round((cached / total) * 100)}%`;
  }

  function statusText(value) {
    return String(value || "search")
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  function precomputedChain(start, target) {
    if (!state.chains?.chains?.length) return null;
    if ((state.chains.start || "").toLowerCase() !== start) return null;
    return state.chains.chains.find((c) => c.found && c.target.toLowerCase() === target) || null;
  }

  function bridgeSuffixesFor(target) {
    const suffixes = new Map();
    for (const chain of state.chains?.chains || []) {
      if (!chain.found || chain.target.toLowerCase() !== target) continue;
      for (let i = 0; i < chain.path.length - 1; i++) {
        const node = chain.path[i].toLowerCase();
        const path = chain.path.slice(i).map((u) => u.toLowerCase());
        const hops = chain.hops.slice(i).map((hop) => ({
          from: hop.from.toLowerCase(),
          to: hop.to.toLowerCase(),
          url: hop.url,
        }));
        const suffix = {
          target: chain.target.toLowerCase(),
          display: chain.display || nameOf(chain.target),
          found: true,
          length: hops.length,
          path,
          hops,
          source: "saved-bridge",
        };
        const current = suffixes.get(node);
        if (!current || suffix.length < current.length) suffixes.set(node, suffix);
      }
    }
    return suffixes;
  }

  function parseSearchMode(range) {
    if (range === "auto") {
      return {
        key: "auto",
        archiveLimit: 6,
        bridgeLimit: 2,
        label: "automatic search",
        crawlLabel: "automatic recent search",
        instantOnly: false,
      };
    }
    if (range === "instant") {
      return {
        key: "instant",
        archiveLimit: 2,
        bridgeLimit: 2,
        label: "instant bridge",
        crawlLabel: "latest 2 months",
        instantOnly: true,
      };
    }
    if (range === "all") {
      return {
        key: "all",
        archiveLimit: Infinity,
        bridgeLimit: 2,
        label: "full history",
        crawlLabel: "full history",
        instantOnly: false,
      };
    }
    const archiveLimit = parseInt(range, 10) || 6;
    return {
      key: String(archiveLimit),
      archiveLimit,
      bridgeLimit: Math.min(archiveLimit, 2),
      label: `latest ${archiveLimit} months`,
      crawlLabel: `latest ${archiveLimit} months`,
      instantOnly: false,
    };
  }

  async function quickBridge(start, target, targetDisplay, engine, label, logLine) {
    const suffixes = bridgeSuffixesFor(target);
    const suffixFromStart = suffixes.get(start);
    if (suffixFromStart) {
      logLine(`instant bridge: ${start} is already on a saved route to ${target}`);
      return {
        ...suffixFromStart,
        display: suffixFromStart.display || targetDisplay || target,
      };
    }

    logLine(`instant bridge: checking ${start}'s ${label} for direct wins and known connectors`);
    const { beatenByMe } = await engine.edges(start);

    const directUrls = beatenByMe.get(target);
    if (directUrls?.length) {
      return {
        target,
        display: targetDisplay || target,
        found: true,
        length: 1,
        path: [start, target],
        hops: [{ from: start, to: target, url: directUrls[0] }],
        source: "direct-recent-win",
      };
    }

    if (!suffixes.size) return null;

    let best = null;
    for (const [opponent, urls] of beatenByMe) {
      const suffix = suffixes.get(opponent);
      if (!suffix || !urls?.length) continue;
      const hops = [{ from: start, to: opponent, url: urls[0] }, ...suffix.hops];
      const candidate = {
        target,
        display: suffix.display || targetDisplay || target,
        found: true,
        length: hops.length,
        path: [start, ...suffix.path],
        hops,
        source: "recent-bridge",
      };
      if (!best || candidate.length < best.length) best = candidate;
    }
    return best;
  }

  async function hydratePlayers(path, engine) {
    state.players = state.players || {};
    await Promise.all([...new Set(path)].map(async (u) => {
      if (state.players[u]) return;
      const m = await fetchProfile(u).catch(() => null);
      if (!m && engine) {
        const direct = await engine.fetchJSON(engine.API + u).catch(() => null);
        if (direct) state.players[u] = metaShape(direct);
      }
    }));
  }

  // ---------- graph ----------
  function renderGraph(chain) {
    const svg = $("#graph");
    svg.innerHTML = "";
    svg.setAttribute("viewBox", "0 0 1040 420");

    const defs = el("defs");
    const grad = el("linearGradient", { id: "edge-grad", x1: "0", y1: "0", x2: "1", y2: "0" });
    grad.appendChild(el("stop", { offset: "0%", "stop-color": "#496a46" }));
    grad.appendChild(el("stop", { offset: "50%", "stop-color": "#b4833a" }));
    grad.appendChild(el("stop", { offset: "100%", "stop-color": "#415d75" }));
    defs.appendChild(grad);
    const clip = el("clipPath", { id: "clip" });
    clip.appendChild(el("circle", { r: 32, cx: 0, cy: 0 }));
    defs.appendChild(clip);
    svg.appendChild(defs);

    if (!chain.found) {
      const t = el("text", {
        x: 520, y: 180, "text-anchor": "middle",
        fill: "#63685f", "font-size": "18", "font-family": "Inter, sans-serif",
      });
      t.textContent = `couldn't find a connection to ${chain.display || chain.target} within ${state.chains?.max_depth || 4} steps.`;
      svg.appendChild(t);
      $("#graph-hint").textContent =
        "try a different target, or pick someone who plays a lot of games.";
      return;
    }

    const nodes = chain.path;
    const n = nodes.length;
    const PAD = 128, W = 1040;
    const usable = W - PAD * 2;
    const stepX = n > 1 ? usable / (n - 1) : 0;
    const y = 196;
    const positions = nodes.map((_, i) => ({ x: PAD + stepX * i, y }));

    const edgesGroup = el("g");
    for (let i = 0; i < n - 1; i++) {
      const a = positions[i], b = positions[i + 1];
      const midX = (a.x + b.x) / 2;
      const d = `M ${a.x} ${a.y} Q ${midX} ${a.y - 28} ${b.x} ${b.y}`;
      edgesGroup.appendChild(el("path", { class: "edge-glow", d }));
      edgesGroup.appendChild(el("path", { class: "edge-line", d }));
    }
    svg.appendChild(edgesGroup);

    const nodesGroup = el("g");
    nodes.forEach((u, i) => {
      const pos = positions[i];
      const isStart = i === 0;
      const isTarget = i === n - 1;
      const g = el("g", {
        class: "node" + (isStart ? " is-start" : "") + (isTarget ? " is-target" : ""),
        transform: `translate(${pos.x}, ${pos.y})`,
        "data-profile-user": u,
        tabindex: "0",
        role: "button",
        "aria-label": `${nameOf(u)} profile`,
      });
      g.appendChild(el("ellipse", { class: "node__shadow", cx: 0, cy: 42, rx: 34, ry: 8 }));
      g.appendChild(el("circle", { class: "node__pulse", r: 34 }));
      g.appendChild(el("circle", { class: "node__ring", r: 32 }));

      const av = avatarOf(u);
      if (av) {
        const img = el("image", {
          class: "node__img", href: av,
          x: -32, y: -32, width: 64, height: 64,
          "clip-path": "url(#clip)", preserveAspectRatio: "xMidYMid slice",
        });
        img.addEventListener("error", () => {
          const fb = el("text", { class: "node__icon", x: 0, y: 0 });
          fb.textContent = pieceFor(isStart, isTarget);
          if (img.parentNode) g.replaceChild(fb, img);
        });
        g.appendChild(img);
      } else {
        const ic = el("text", { class: "node__icon", x: 0, y: 0 });
        ic.textContent = pieceFor(isStart, isTarget);
        g.appendChild(ic);
      }

      const label = el("text", { class: "node__label", x: 0, y: 58 });
      label.textContent = compactGraphLabel(nameOf(u), n > 7 ? 11 : 15);
      g.appendChild(label);

      const title = titleOf(u);
      if (title) {
        const ttag = el("text", { class: "node__title", x: 0, y: 76 });
        ttag.textContent = title + (isTarget ? " · TARGET" : "");
        g.appendChild(ttag);
      } else if (isTarget) {
        const ttag = el("text", { class: "node__title", x: 0, y: 76 });
        ttag.textContent = "TARGET";
        g.appendChild(ttag);
      } else if (isStart) {
        const ttag = el("text", { class: "node__title", x: 0, y: 76 });
        ttag.textContent = "YOU";
        g.appendChild(ttag);
      }
      nodesGroup.appendChild(g);
    });
    svg.appendChild(nodesGroup);

    const spark = el("circle", { class: "edge-spark", cx: positions[0].x, cy: positions[0].y, r: 4 });
    svg.appendChild(spark);

    const traveller = el("text", { class: "traveller", x: positions[0].x, y: positions[0].y });
    traveller.textContent = "♞";
    svg.appendChild(traveller);

    $("#graph-hint").textContent =
      `every arrow is a real win from a real game. ${n - 1} link${n - 1 === 1 ? "" : "s"} in total.`;

    animateGraph(svg, traveller, spark);
  }

  const pieceFor = (isStart, isTarget) => (isTarget ? "♚" : "♟");

  function compactGraphLabel(label, max) {
    const value = String(label || "");
    if (value.length <= max) return value;
    return `${value.slice(0, Math.max(1, max - 3))}...`;
  }

  // ---------- animations ----------
  async function animateGraph(svg, traveller, spark) {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const nodes = Array.from(svg.querySelectorAll(".node"));
    const lines = Array.from(svg.querySelectorAll(".edge-line"));
    const glows = Array.from(svg.querySelectorAll(".edge-glow"));

    lines.forEach((p) => {
      const len = p.getTotalLength();
      p.style.strokeDasharray = len;
      p.style.strokeDashoffset = len;
      p.style.transition = "none";
    });
    glows.forEach((p) => {
      const len = p.getTotalLength();
      p.style.strokeDasharray = len;
      p.style.strokeDashoffset = len;
      p.style.opacity = 0;
      p.style.transition = "none";
    });
    nodes.forEach((node) => {
      node.style.opacity = 0;
      node.style.removeProperty("transform");
      node.style.removeProperty("transform-box");
      node.style.removeProperty("transform-origin");
      node.style.transition = "none";
    });
    [traveller, spark].forEach((marker) => {
      if (!marker) return;
      marker.style.opacity = 0;
      marker.style.transition = "none";
    });

    if (reduced) {
      lines.forEach((p) => (p.style.strokeDashoffset = 0));
      glows.forEach((p) => {
        p.style.strokeDashoffset = 0;
        p.style.opacity = 0.1;
      });
      nodes.forEach((node) => {
        node.style.opacity = 1;
        node.style.removeProperty("transform");
      });
      return;
    }

    await revealNode(nodes[0]);
    await pulse(nodes[0]);
    for (let i = 0; i < lines.length; i++) {
      await travelPath(lines[i], glows[i], traveller, spark);
      await revealNode(nodes[i + 1]);
      await pulse(nodes[i + 1]);
    }
    [traveller, spark].forEach((marker) => {
      if (!marker) return;
      marker.style.transition = "opacity .3s ease";
      marker.style.opacity = 0;
    });
  }

  function revealNode(node, delay = 0) {
    return new Promise((resolve) => {
      setTimeout(() => {
        node.style.removeProperty("transform");
        node.style.transition = "opacity .35s ease";
        node.style.opacity = 1;
        setTimeout(resolve, 350);
      }, delay);
    });
  }

  function pulse(node) {
    const ring = node.querySelector(".node__pulse");
    if (!ring) return Promise.resolve();
    return new Promise((resolve) => {
      ring.style.transition = "none";
      ring.setAttribute("r", 30);
      ring.style.opacity = 0.9;
      void ring.getBoundingClientRect();
      ring.style.transition = "r .7s ease-out, opacity .7s ease-out";
      ring.setAttribute("r", 52);
      ring.style.opacity = 0;
      setTimeout(resolve, 700);
    });
  }

  function travelPath(path, glow, traveller, spark) {
    return new Promise((resolve) => {
      const len = path.getTotalLength();
      const dur = 760;
      const start = performance.now();
      if (glow) {
        glow.style.opacity = 0.11;
        glow.style.strokeDasharray = len;
        glow.style.strokeDashoffset = len;
      }
      function frame(now) {
        const t = Math.min(1, (now - start) / dur);
        const e = easeInOutCubic(t);
        const point = path.getPointAtLength(len * e);
        path.style.strokeDashoffset = len * (1 - e);
        if (glow) glow.style.strokeDashoffset = len * (1 - e);
        traveller.setAttribute("x", point.x);
        traveller.setAttribute("y", point.y);
        traveller.style.opacity = 1;
        if (spark) {
          spark.setAttribute("cx", point.x);
          spark.setAttribute("cy", point.y);
          spark.style.opacity = t < 0.96 ? 1 : 0;
        }
        if (t < 1) {
          requestAnimationFrame(frame);
        } else {
          path.style.strokeDashoffset = 0;
          if (glow) {
            glow.style.strokeDashoffset = 0;
            glow.style.opacity = 0.08;
          }
          resolve();
        }
      }
      requestAnimationFrame(frame);
    });
  }

  function easeInOutCubic(t) {
    return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }

  // ---------- hop cards ----------
  function renderCards(chain) {
    const wrap = $("#cards");
    wrap.innerHTML = "";
    if (!chain.found) {
      wrap.innerHTML = `<p style="color:var(--text-faint)">no connection found for ${esc(chain.display || chain.target)}.</p>`;
      return;
    }
    chain.hops.forEach((hop, i) => {
      const card = document.createElement("div");
      card.className = "card";

      const avatars = document.createElement("div");
      avatars.className = "card__avatars";
      avatars.appendChild(avatarEl(hop.from));
      const arrow = document.createElement("span");
      arrow.className = "card__arrow";
      arrow.textContent = "→";
      avatars.appendChild(arrow);
      avatars.appendChild(avatarEl(hop.to));

      const body = document.createElement("div");
      body.className = "card__body";
      const line = document.createElement("div");
      line.className = "card__line";
      const wt = titleOf(hop.from), lt = titleOf(hop.to);
      line.innerHTML =
        (wt ? `<span class="card__title-tag">${esc(wt)}</span>` : "") +
        `<span class="winner">${esc(nameOf(hop.from))}</span> beat ` +
        (lt ? `<span class="card__title-tag">${esc(lt)}</span>` : "") +
        `<span class="loser">${esc(nameOf(hop.to))}</span>`;
      body.appendChild(line);
      const details = proofDetails(hop, i, chain.hops.length);
      if (details.length) {
        const sub = document.createElement("div");
        sub.className = "card__sub";
        sub.innerHTML = details.map(esc).join(" · ");
        body.appendChild(sub);
      }
      const proof = document.createElement("a");
      proof.className = "card__proof";
      proof.href = hop.url;
      proof.target = "_blank";
      proof.rel = "noopener";
      proof.innerHTML = `Open game <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3z" fill="currentColor"/></svg>`;

      card.appendChild(avatars);
      card.appendChild(body);
      card.appendChild(proof);
      wrap.appendChild(card);
    });

    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          setTimeout(() => e.target.classList.add("in"),
            Array.from(wrap.children).indexOf(e.target) * 90);
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.15 });
    wrap.querySelectorAll(".card").forEach((c) => io.observe(c));
    requestAnimationFrame(() => {
      wrap.querySelectorAll(".card").forEach((card, index) => {
        setTimeout(() => card.classList.add("in"), index * 80);
      });
    });
  }

  function proofDetails(hop, index, total) {
    const details = [`proof ${index + 1} of ${total}`];
    if (hop.timeClass) details.push(hop.timeClass);
    if (isValidProofTime(hop.endTime)) details.push(proofDate(hop.endTime));
    if (hop.color) details.push(`${hop.color} win`);
    if (hop.opening) details.push(compactGraphLabel(String(hop.opening).replace(/^https?:\/\/www\.chess\.com\/openings\//, ""), 42));
    return details;
  }

  function proofDate(seconds) {
    const date = new Date(seconds * 1000);
    if (!Number.isFinite(date.getTime())) return "";
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  function isValidProofTime(seconds) {
    return Number.isFinite(seconds) && seconds >= 1167609600;
  }

  function avatarEl(username) {
    const av = avatarOf(username);
    const title = titleOf(username);
    if (av) {
      const img = document.createElement("img");
      img.className = "card__avatar" + (title ? " is-titled" : "");
      img.src = av;
      img.alt = nameOf(username);
      img.dataset.profileUser = username.toLowerCase();
      img.dataset.profileTrigger = "";
      img.referrerPolicy = "no-referrer";
      img.addEventListener("error", () => {
        const fb = document.createElement("div");
        fb.className = "card__avatar-fallback";
        fb.textContent = (nameOf(username)[0] || "?").toUpperCase();
        fb.dataset.profileUser = username.toLowerCase();
        fb.dataset.profileTrigger = "";
        fb.tabIndex = 0;
        img.replaceWith(fb);
      });
      return img;
    }
    const fb = document.createElement("div");
    fb.className = "card__avatar-fallback";
    fb.textContent = (nameOf(username)[0] || "?").toUpperCase();
    fb.dataset.profileUser = username.toLowerCase();
    fb.dataset.profileTrigger = "";
    fb.tabIndex = 0;
    return fb;
  }

  async function openGraphExplorer(username) {
    const key = cleanUsernameInput(username);
    const panel = $("#graph-explorer");
    if (!panel || !key || !state.currentChain?.found) return;
    const profile = await fetchProfile(key).catch(() => state.players?.[key] || { username: key });
    const neighbors = chainNeighbors(key);
    const avatar = profile?.avatar
      ? `<img src="${esc(profile.avatar)}" alt="${esc(nameOf(key))} profile photo" referrerpolicy="no-referrer">`
      : esc((nameOf(key)[0] || "?").toUpperCase());
    panel.hidden = false;
    panel.innerHTML = `
      <div class="graph-explorer__head">
        <button class="graph-explorer__avatar" type="button" data-profile-trigger data-profile-user="${esc(key)}">${avatar}</button>
        <div>
          <h3>${esc(nameOf(key))}</h3>
          <p>${esc(explorerProfileLine(profile, neighbors.length))}</p>
        </div>
        <button class="graph-explorer__close" type="button" data-explorer-close aria-label="Close explorer">Close</button>
      </div>
      <div class="graph-explorer__list">
        ${neighbors.length ? neighbors.map(explorerNeighborRow).join("") : `<div class="graph-explorer__row"><strong>No proof neighbors in this chain.</strong><small>Try a longer route.</small></div>`}
      </div>
    `;
  }

  function chainNeighbors(username) {
    const hops = state.currentChain?.hops || [];
    return hops
      .filter((hop) => hop.from === username || hop.to === username)
      .map((hop) => {
        const other = hop.from === username ? hop.to : hop.from;
        return {
          other,
          direction: hop.from === username ? "beat" : "lost to",
          hop,
        };
      });
  }

  function explorerNeighborRow(item) {
    const details = proofDetails(item.hop, 0, 1).slice(1).join(" · ");
    return `
      <div class="graph-explorer__row">
        <button type="button" data-profile-trigger data-profile-user="${esc(item.other)}">
          <strong>${esc(item.direction)} ${esc(nameOf(item.other))}</strong>
          <small>${esc(details || "proof game")}</small>
        </button>
        <a class="card__proof" href="${esc(item.hop.url)}" target="_blank" rel="noopener">Open game</a>
      </div>
    `;
  }

  function explorerProfileLine(profile, neighborCount) {
    const parts = [];
    if (profile?.title) parts.push(profile.title);
    if (profile?.stats?.rapid?.rating) parts.push(`Rapid ${plainNumber(profile.stats.rapid.rating)}`);
    if (profile?.stats?.blitz?.rating) parts.push(`Blitz ${plainNumber(profile.stats.blitz.rating)}`);
    if (profile?.stats?.bullet?.rating) parts.push(`Bullet ${plainNumber(profile.stats.bullet.rating)}`);
    parts.push(`${neighborCount} proof neighbor${neighborCount === 1 ? "" : "s"}`);
    return parts.join(" · ");
  }

  async function fetchProfile(username) {
    const key = String(username || "").trim().toLowerCase();
    if (!key) return null;
    const existing = state.players?.[key];
    if (existing?.profileComplete) return existing;
    if (state.profilePromises.has(key)) return state.profilePromises.get(key);

    const promise = (async () => {
      const remoteBase = String(window.CONNECTIONS_CACHE_API || "").replace(/\/+$/, "");
      let profile = null;
      if (/^https?:\/\//.test(remoteBase)) {
        try {
          const res = await fetch(`${remoteBase}/profile?username=${encodeURIComponent(key)}`, {
            headers: { "Accept": "application/json" },
          });
          if (res.ok) {
            const data = await res.json();
            profile = data.profile || null;
          }
        } catch {
          // fall through to Chess.com direct lookup
        }
      }
      if (!profile) {
        try {
          const res = await fetch(`https://api.chess.com/pub/player/${encodeURIComponent(key)}`, {
            headers: { "Accept": "application/json" },
          });
          if (res.ok) profile = await res.json();
        } catch {
          profile = null;
        }
      }
      const shaped = metaShape({ username: key, ...(profile || {}) });
      state.players = state.players || {};
      state.players[key] = {
        ...(state.players[key] || {}),
        ...shaped,
        profileComplete: true,
      };
      return state.players[key];
    })();

    state.profilePromises.set(key, promise);
    return promise;
  }

  function renderProfilePopover(profile, username, anchor) {
    const pop = $("#profile-popover");
    if (!pop || !anchor) return;
    const display = profile?.name || profile?.username || username;
    const handle = profile?.username || username;
    const title = profile?.title ? `<span class="profile-popover__title">${esc(profile.title)}</span> ` : "";
    const avatar = profile?.avatar
      ? `<img src="${esc(profile.avatar)}" alt="${esc(display)} profile photo" referrerpolicy="no-referrer">`
      : `<span>${esc((display[0] || "?").toUpperCase())}</span>`;
    const joined = profile?.joined ? `<span>Joined ${esc(formatProfileDate(profile.joined))}</span>` : `<span>Joined unavailable</span>`;
    const countryFlag = profile?.country ? flagIcon(profile.country, "profile-popover__flag") : "";
    const country = countryFlag
      ? `<span class="profile-popover__identity-flag" title="${esc(profile.country.toUpperCase())}">${countryFlag}</span>`
      : "";
    const followers = Number.isFinite(profile?.followers)
      ? `<span>${plainNumber(profile.followers)} followers</span>`
      : "";
    const online = profile?.lastOnline ? `<span>Seen ${esc(timeAgo(profile.lastOnline * 1000))}</span>` : "";
    const location = profile?.location ? `<span>${esc(profile.location)}</span>` : "";
    const fide = Number.isFinite(profile?.fide) ? `<span>FIDE ${plainNumber(profile.fide)}</span>` : "";
    const status = profile?.status
      ? `<span class="profile-popover__status${String(profile.status).toLowerCase() === "premium" ? " is-premium" : ""}">${esc(profileStatusLabel(profile.status))}</span>`
      : "";
    const url = profile?.url || `https://www.chess.com/member/${encodeURIComponent(handle)}`;
    const stats = renderProfileStats(profile?.stats);
    const recentGames = renderProfileRecentGames(profile?.recentGames);

    pop.innerHTML = `
      <div class="profile-popover__top">
        <span class="profile-popover__avatar">${avatar}</span>
        <span class="profile-popover__main">
          <strong>${title}${esc(display)}</strong>
          <small><span>@${esc(handle)}</span>${country}</small>
        </span>
      </div>
      <div class="profile-popover__meta">${followers}${joined}${online}${location}${fide}${status}</div>
      ${stats}
      ${recentGames}
      <a class="profile-popover__open" href="${esc(url)}" target="_blank" rel="noopener">Open Chess.com profile</a>
    `;
    pop.hidden = false;
    positionProfilePopover(pop, anchor);
  }

  function positionProfilePopover(pop, anchor) {
    const rect = anchor.getBoundingClientRect();
    const popRect = pop.getBoundingClientRect();
    const gap = 12;
    const maxLeft = window.innerWidth - popRect.width - gap;
    const left = Math.max(gap, Math.min(maxLeft, rect.left + rect.width / 2 - popRect.width / 2));
    let top = rect.bottom + gap;
    if (top + popRect.height > window.innerHeight - gap) {
      top = Math.max(gap, rect.top - popRect.height - gap);
    }
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }

  async function showProfilePopover(username, anchor) {
    const key = String(username || "").trim().toLowerCase();
    if (!key || !anchor) return;
    const token = ++state.profilePopoverToken;
    const pop = $("#profile-popover");
    if (pop) {
      pop.hidden = false;
      pop.innerHTML = `<div class="profile-popover__loading">Loading ${esc(key)}...</div>`;
      positionProfilePopover(pop, anchor);
    }
    const profile = await fetchProfile(key);
    if (token !== state.profilePopoverToken || $("#profile-popover")?.hidden) return;
    if (!profile) return;
    renderProfilePopover(profile, key, anchor);
  }

  function hideProfilePopover() {
    state.profilePopoverToken++;
    const pop = $("#profile-popover");
    if (pop) {
      pop.hidden = true;
      pop.innerHTML = "";
    }
  }

  function formatProfileDate(seconds) {
    const date = new Date(seconds * 1000);
    if (!Number.isFinite(date.getTime())) return "";
    return date.toLocaleDateString(undefined, { month: "short", year: "numeric" });
  }

  function profileStatusLabel(status) {
    return String(status || "")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  function renderProfileStats(stats) {
    const modes = [
      ["rapid", "Rapid"],
      ["blitz", "Blitz"],
      ["bullet", "Bullet"],
    ];
    const cells = modes.map(([key, label]) => {
      const stat = stats?.[key];
      if (!stat?.rating) {
        return `<div class="profile-stat"><span>${label}</span><strong>--</strong><small>No rating</small></div>`;
      }
      const games = Number.isFinite(stat.games) ? `${plainNumber(stat.games)} games` : "rated";
      const best = Number.isFinite(stat.best) ? `best ${plainNumber(stat.best)}` : games;
      return `
        <div class="profile-stat">
          <span>${label}</span>
          <strong>${plainNumber(stat.rating)}</strong>
          <small>${esc(best)}</small>
        </div>
      `;
    }).join("");
    return `<div class="profile-stats" aria-label="Player ratings">${cells}</div>`;
  }

  function renderProfileRecentGames(games) {
    const rows = Array.isArray(games) ? games.slice(0, 5) : [];
    if (!rows.length) return "";
    return `
      <div class="profile-games" aria-label="Recent public games">
        <span class="profile-games__title">Recent games</span>
        ${rows.map((game) => {
          const result = String(game.result || "game").replace(/_/g, " ");
          const tone = result === "win" ? " is-win" : result === "loss" ? " is-loss" : "";
          const when = isValidProofTime(game.endTime) ? timeAgo(game.endTime * 1000) : "";
          const label = result === "win" ? "Beat" : result === "loss" ? "Lost to" : "Drew";
          const url = String(game.url || "");
          const body = `
            <span class="profile-game__result${tone}">${esc(label)}</span>
            <strong>${esc(game.opponent || "opponent")}</strong>
            <small>${esc([game.timeClass, when].filter(Boolean).join(" · "))}</small>
          `;
          return url
            ? `<a class="profile-game" href="${esc(url)}" target="_blank" rel="noopener">${body}</a>`
            : `<div class="profile-game">${body}</div>`;
        }).join("")}
      </div>
    `;
  }

  async function runServerSearchFlow({ start, target, range, analyticsBase, mode, btn, status, logEl, knownChain = null }) {
    const remoteBase = workerBase();
    if (!remoteBase) return false;

    let lastMessage = "";
    const logLine = (msg) => {
      if (!logEl || msg === lastMessage) return;
      lastMessage = msg;
      const div = document.createElement("div");
      div.className = "log__line";
      div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
      logEl.appendChild(div);
      while (logEl.children.length > 12) logEl.removeChild(logEl.firstChild);
      logEl.scrollTop = logEl.scrollHeight;
    };

    try {
      btn.disabled = true;
      status.hidden = false;
      status.className = "search__status is-working";
      logEl.hidden = false;
      logEl.innerHTML = "";
      showStatus("working", "starting server search...");
      logLine(`queued ${start} -> ${target} (${mode.label})`);

      const res = await fetch(`${remoteBase}/search/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({
          start,
          target,
          range,
          searchId: analyticsBase.searchId,
          knownChain,
        }),
      });
      if (!res.ok) throw new Error(`job start failed (${res.status})`);
      const data = await res.json();
      const job = data.job;
      if (!job?.id) throw new Error("job start failed");
      saveActiveJob({ id: job.id, start, target, range, searchId: analyticsBase.searchId });
      renderSearchQueue(job);
      let showedInstantChain = false;
      let instantChainKey = "";
      if (job.chain?.found) {
        if (["found", "not_found", "timeout", "failed"].includes(job.status)) {
          clearActiveJob(job.id);
          finishSearchQueue(job);
          await applyServerChain(job, analyticsBase);
          return true;
        }
        showedInstantChain = true;
        instantChainKey = chainKey(job.chain.path || []);
        await applyServerChain(job, analyticsBase, {
          checking: false,
          recordOutcome: "saved",
          submit: true,
        });
        logLine("loaded saved connection instantly; checking for a shorter route");
        showStatus("done",
          `✓ loaded saved connection — ${esc(start)} connects to ${esc(target)} in ` +
          `${stepText((job.chain.path || []).length - 1)}. Checking newer games in the background.`);
        btn.disabled = false;
        pollServerSearchJob(job.id, { analyticsBase, logLine, background: true })
          .then(async (finished) => {
            clearActiveJob(job.id);
            if (state.activeSearchId !== analyticsBase.searchId) return;
            finishSearchQueue(finished);
            if (finished?.chain?.found) {
              const finalChainKey = chainKey(finished.chain.path || []);
              await applyServerChain(finished, analyticsBase, {
                recordOutcome: finalChainKey === instantChainKey ? "saved" : "found",
                scroll: finalChainKey !== instantChainKey,
              });
            }
          })
          .catch((error) => {
            logLine(`shorter-route check paused: ${error.message}`);
          })
          .finally(() => {
            if (state.activeSearchId === analyticsBase.searchId) btn.disabled = false;
          });
        return true;
      }
      const finished = await pollServerSearchJob(job.id, { analyticsBase, logLine });
      clearActiveJob(job.id);
      finishSearchQueue(finished);
      if (finished?.chain?.found) {
        const finalChainKey = chainKey(finished.chain.path || []);
        await applyServerChain(finished, analyticsBase, {
          recordOutcome: showedInstantChain && finalChainKey === instantChainKey ? "saved" : "found",
        });
      } else {
        const outcome = finished?.outcome || (finished?.status === "timeout" ? "timeout" : "not_found");
        showStatus(outcome === "timeout" ? "error" : "error",
          finished?.progress || "no connection found in this search.");
        renderChain({
          target,
          display: target,
          found: false,
          length: null,
          path: [],
          hops: [],
        });
        recordSearchEvent(outcome, {
          ...analyticsBase,
          jobId: finished?.id,
          durationMs: finished?.durationMs,
          requests: finished?.stats?.requests,
          cached: finished?.stats?.cached,
          error: finished?.error || finished?.progress || "",
        });
      }
      return true;
    } catch (error) {
      logLine(`server search unavailable: ${error.message}`);
      return false;
    } finally {
      btn.disabled = false;
    }
  }

  async function pollServerSearchJob(id, { analyticsBase = null, logLine = null, background = false } = {}) {
    const remoteBase = workerBase();
    if (!remoteBase || !id) return null;
    let job = null;
    for (let attempt = 0; attempt < 360; attempt++) {
      const res = await fetch(`${remoteBase}/search/job?id=${encodeURIComponent(id)}`, {
        headers: { "Accept": "application/json" },
      });
      if (!res.ok) throw new Error(`job poll failed (${res.status})`);
      const data = await res.json();
      job = data.job;
      if (!job) throw new Error("job missing");
      if (!background) showServerJobProgress(job);
      if (logLine) logLine(job.progress || statusText(job.status));
      if (["found", "not_found", "timeout", "failed"].includes(job.status)) return job;
      await new Promise((resolve) => setTimeout(resolve, attempt < 12 ? 350 : 900));
    }
    return {
      id,
      status: "timeout",
      outcome: "timeout",
      progress: "Search is still running. Keep this tab open and it will keep checking.",
      start: analyticsBase?.start,
      target: analyticsBase?.target,
    };
  }

  function showServerJobProgress(job) {
    const status = $("#search-status");
    if (!status || !job) return;
    const stats = job.stats || {};
    renderSearchQueue(job);
    status.hidden = false;
    status.className = "search__status is-working";
    status.innerHTML =
      `<span class="spinner"></span>${esc(job.progress || "searching...")}` +
      `<span class="counters">checked <b>${Number(stats.expanded || 0)}</b> players · ` +
      `${Number(stats.requests || 0)} requests · ${Number(stats.cached || 0)} reused</span>`;
  }

  function renderSearchQueue(job, resumed = false) {
    const panel = $("#search-queue");
    if (!panel || !job) return;
    const stats = job.stats || {};
    const created = Number(job.createdAt || Date.now());
    panel.hidden = false;
    panel.classList.remove("is-complete");
    $("#queue-state").textContent = resumed ? "Resumed" : statusText(job.status || "running");
    $("#queue-job").textContent = compactJobId(job.id);
    $("#queue-checked").textContent = plainNumber(stats.expanded || 0);
    $("#queue-requests").textContent = plainNumber(stats.requests || 0);
    $("#queue-cached").textContent = plainNumber(stats.cached || 0);
    $("#queue-elapsed").textContent = elapsedText(created);
    $("#queue-message").textContent = job.progress || "Search is running.";
    clearInterval(state.queueTimer);
    if (["queued", "running"].includes(job.status)) {
      state.queueTimer = setInterval(() => {
        const elapsed = $("#queue-elapsed");
        if (elapsed) elapsed.textContent = elapsedText(created);
      }, 1000);
    }
  }

  function finishSearchQueue(job) {
    const panel = $("#search-queue");
    if (!panel) return;
    clearInterval(state.queueTimer);
    state.queueTimer = null;
    if (job) {
      renderSearchQueue(job);
      $("#queue-state").textContent = statusText(job.status || "done");
      $("#queue-message").textContent = job.progress || "Search complete.";
      panel.classList.add("is-complete");
    }
  }

  function compactJobId(id) {
    const text = String(id || "");
    return text.length > 16 ? `${text.slice(0, 8)}…${text.slice(-5)}` : text || "—";
  }

  function elapsedText(startMs) {
    const seconds = Math.max(0, Math.round((Date.now() - startMs) / 1000));
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
  }

  async function applyServerChain(job, analyticsBase, options = {}) {
    const {
      checking = false,
      recordOutcome = "found",
      submit = true,
      scroll = true,
    } = options;
    const chain = job.chain;
    state.players = state.players || {};
    for (const [username, profile] of Object.entries(job.players || {})) {
      const key = username.toLowerCase();
      state.players[key] = {
        ...(state.players[key] || {}),
        ...metaShape({ username: key, ...profile }),
        profileComplete: Boolean(profile?.stats),
      };
    }
    await hydratePlayers(chain.path || [], {
      fetchJSON: (url) => fetch(url, { headers: { "Accept": "application/json" } }).then((res) => res.json()),
      API: "https://api.chess.com/pub/player/",
    });
    if (checking) {
      showStatus("working",
        `loaded saved connection instantly — checking newer games for a shorter route.`);
    } else {
      showStatus("done",
        `${job.progress && /saved connection/i.test(job.progress) ? "✓" : "✓ found it"} — ` +
        `${esc(job.start)} connects to ${esc(job.target)} in ${stepText((chain.path || []).length - 1)}. ` +
        `checked ${Number(job.stats?.expanded || 0)} players, made ${Number(job.stats?.requests || 0)} requests` +
        (Number(job.stats?.cached || 0) ? `, reused ${Number(job.stats.cached)}` : "") + ".");
    }
    setActiveChip(job.target);
    renderChain(chain);
    if (submit) submitLeaderboardChain(job.start, job.target, chain);
    recordSearchEvent(recordOutcome, {
      ...analyticsBase,
      jobId: job.id,
      length: chain.length,
      steps: Math.max(0, (chain.path || []).length - 1),
      path: chain.path || [],
      durationMs: job.durationMs,
      requests: job.stats?.requests,
      cached: job.stats?.cached,
      quality: qualityFromChain(chain),
    });
    if (scroll) document.querySelector(".graph-section").scrollIntoView({ behavior: "smooth" });
  }

  function saveActiveJob(job) {
    try {
      localStorage.setItem(LS_ACTIVE_JOB_KEY, JSON.stringify({ ...job, ts: Date.now() }));
    } catch {
      // Non-critical.
    }
  }

  function clearActiveJob(id = "") {
    try {
      const current = JSON.parse(localStorage.getItem(LS_ACTIVE_JOB_KEY) || "null");
      if (!id || !current?.id || current.id === id) localStorage.removeItem(LS_ACTIVE_JOB_KEY);
    } catch {
      localStorage.removeItem(LS_ACTIVE_JOB_KEY);
    }
  }

  async function resumeActiveSearchJob() {
    let record = null;
    try {
      record = JSON.parse(localStorage.getItem(LS_ACTIVE_JOB_KEY) || "null");
    } catch {
      clearActiveJob();
    }
    if (!record?.id || Date.now() - Number(record.ts || 0) > 2 * 60 * 60 * 1000) {
      clearActiveJob();
      return;
    }
    $("#search-start").value = record.start || $("#search-start").value;
    $("#search-target").value = record.target || $("#search-target").value;
    showStatus("working", "resuming search...");
    renderSearchQueue({
      id: record.id,
      status: "running",
      progress: "Resuming saved backend job.",
      createdAt: record.ts,
      stats: { expanded: 0, requests: 0, cached: 0 },
    }, true);
    try {
      const job = await pollServerSearchJob(record.id, {
        analyticsBase: {
          searchId: record.searchId || record.id,
          start: record.start,
          target: record.target,
          range: record.range,
          depth: AUTO_SEARCH_DEPTH,
        },
      });
      clearActiveJob(record.id);
      finishSearchQueue(job);
      if (job?.chain?.found) {
        await applyServerChain(job, {
          searchId: record.searchId || record.id,
          start: record.start,
          target: record.target,
          range: record.range,
          depth: AUTO_SEARCH_DEPTH,
        });
      }
    } catch {
      clearActiveJob(record.id);
    }
  }

  function warmSharedCaches() {
    const remoteBase = workerBase();
    if (!remoteBase) return;
    fetch(`${remoteBase}/search/warm`, {
      method: "POST",
      headers: { "Accept": "application/json" },
      keepalive: true,
    }).catch(() => {});
  }

  // ---------- live search ----------
  async function runSearch(startRaw, targetRaw, range) {
    const start = startRaw.trim().toLowerCase();
    const target = targetRaw.trim().toLowerCase();
    const status = $("#search-status");
    const logEl = $("#search-log");
    const btn = $(".search__btn");
    const mode = parseSearchMode(range);
    const depth = AUTO_SEARCH_DEPTH;

    if (!start || !target) {
      showStatus("error", "put in both usernames first.");
      return;
    }
    if (start === target) {
      showStatus("error", "those are the same player — pick two different ones.");
      return;
    }
    const searchStartedAt = performance.now();
    const analyticsBase = { searchId: newSearchEventId(), start, target, depth, range };
    state.activeSearchId = analyticsBase.searchId;
    recordSearchEvent("started", analyticsBase);

    // remember the username for next time
    localStorage.setItem(LS_KEY, start);
    localStorage.setItem(LS_RANGE_KEY, range);
    $("#setting-username").value = start;

    const savedChain = precomputedChain(start, target);
    if (savedChain) {
      showStatus("done", `loaded the saved ${savedChain.display || target} chain instantly.`);
      const renderedChain = {
        target: savedChain.target,
        display: savedChain.display || nameOf(savedChain.target),
        found: savedChain.found,
        length: savedChain.length,
        path: savedChain.path,
        hops: savedChain.hops,
      };
      renderChain(renderedChain);
      submitLeaderboardChain(start, target, renderedChain);
      recordSearchEvent("saved", {
        ...analyticsBase,
        length: renderedChain.length,
        steps: Math.max(0, renderedChain.path.length - 1),
        path: renderedChain.path,
        durationMs: performance.now() - searchStartedAt,
      });
      document.querySelector(".graph-section").scrollIntoView({ behavior: "smooth" });
      const handledByServer = await runServerSearchFlow({
        start,
        target,
        range,
        analyticsBase,
        mode,
        btn,
        status,
        logEl,
        knownChain: renderedChain,
      });
      if (handledByServer) return;
      return;
    }

    const handledByServer = await runServerSearchFlow({
      start,
      target,
      range,
      analyticsBase,
      mode,
      btn,
      status,
      logEl,
    });
    if (handledByServer) return;

    btn.disabled = true;
    status.hidden = false;
    status.className = "search__status is-working";
    logEl.hidden = false;
    logEl.innerHTML = "";

    const cache = new window.GameCache();
    const quickOptions = mode.instantOnly ? { fetchTimeout: 6500, maxRetries: 1 } : {};
    const engine = new window.ChessChain(cache, {
      archiveLimit: mode.archiveLimit,
      ...quickOptions,
    });
    const bridgeEngine = new window.ChessChain(cache, {
      archiveLimit: mode.bridgeLimit,
      fetchTimeout: 6500,
      maxRetries: 1,
    });

    // prominent running log of users scanned + API calls
    let lastScanMsg = "";
    const logLine = (msg) => {
      const div = document.createElement("div");
      div.className = "log__line";
      div.textContent = msg;
      logEl.appendChild(div);
      // keep only the last 12 lines
      while (logEl.children.length > 12) logEl.removeChild(logEl.firstChild);
      logEl.scrollTop = logEl.scrollHeight;
    };
    const attachProgress = (activeEngine) => {
      activeEngine.onProgress = (msg, stats) => {
      // status line: current action + counters
        status.innerHTML =
          `<span class="spinner"></span>${esc(msg)}` +
          `<span class="counters">scanned <b>${stats.fetched}</b> users · ` +
          `${stats.apiCalls} requests · ${stats.cached} reused</span>`;
        // log significant events (filter out only the high-frequency
        // per-node progress lines to keep the log readable)
        const isPerNodeLine = /^  (forward|backward) \d+\/\d+ expanded/.test(msg);
        if (!isPerNodeLine) {
          if (msg !== lastScanMsg) {
            lastScanMsg = msg;
            logLine(`[${new Date().toLocaleTimeString()}] ${msg}  ` +
              `(scanned ${stats.fetched} users total)`);
          }
        }
      };
    };
    attachProgress(engine);
    attachProgress(bridgeEngine);
    showStatus("working", "looking up the players…");
    logLine(`connecting ${start} → ${target}  (${mode.label}${mode.instantOnly ? "" : ", automatic search"})`);

    try {
      // check both players exist + grab their info for the display
      const [startMeta, targetMeta] = await Promise.all([
        engine.fetchJSON(engine.API + start).catch(() => null),
        engine.fetchJSON(engine.API + target).catch(() => null),
      ]);
      if (!startMeta) {
        showStatus("error", `couldn't find "${esc(start)}" on chess.com — check the spelling?`);
        recordSearchEvent("not_found", {
          ...analyticsBase,
          durationMs: performance.now() - searchStartedAt,
        });
        return;
      }
      if (!targetMeta) {
        showStatus("error", `couldn't find "${esc(target)}" on chess.com — check the spelling?`);
        recordSearchEvent("not_found", {
          ...analyticsBase,
          durationMs: performance.now() - searchStartedAt,
        });
        return;
      }
      state.players = state.players || {};
      state.players[start] = metaShape(startMeta);
      state.players[target] = metaShape(targetMeta);

      showStatus("working", "checking instant bridge…");
      let bridged = null;
      try {
        bridged = await quickBridge(
          start, target, targetMeta.name || target, bridgeEngine, bridgeEngine._archiveLabel(), logLine);
      } catch (bridgeError) {
        logLine(`instant bridge skipped: ${bridgeError.message}`);
        if (mode.instantOnly) {
          showStatus("error",
            `instant bridge timed out for ${esc(start)} → ${esc(target)}. ` +
            `Chess.com did not answer the small recent-games check fast enough; try again or switch to Recent fast.`);
          renderChain({
            target, display: targetMeta.name || target,
            found: false, length: null, path: [], hops: [],
          });
          recordSearchEvent("timeout", {
            ...analyticsBase,
            durationMs: performance.now() - searchStartedAt,
            requests: bridgeEngine.stats.apiCalls,
            cached: bridgeEngine.stats.cached,
          });
          return;
        }
      }
      if (bridged) {
        await hydratePlayers(bridged.path, bridgeEngine);
        const bridgeWork = bridgeEngine.stats.apiCalls
          ? `made ${bridgeEngine.stats.apiCalls} quick requests` +
            (bridgeEngine.stats.cached ? `, reused ${bridgeEngine.stats.cached}` : "")
          : bridgeEngine.stats.cached
            ? `reused ${bridgeEngine.stats.cached} previous result${bridgeEngine.stats.cached === 1 ? "" : "s"}`
          : "used the saved bridge index";
        showStatus("done",
          `✓ found it fast — ${esc(start)} connects to ${esc(target)} in ${stepText(bridged.length)}. ` +
          `checked ${esc(mode.instantOnly ? mode.label : "the instant bridge first")} and ${bridgeWork}.`);
        setActiveChip(target);
        renderChain(bridged);
        submitLeaderboardChain(start, target, bridged);
        recordSearchEvent("found", {
          ...analyticsBase,
          length: bridged.length,
          steps: Math.max(0, bridged.path.length - 1),
          path: bridged.path,
          durationMs: performance.now() - searchStartedAt,
          requests: bridgeEngine.stats.apiCalls,
          cached: bridgeEngine.stats.cached,
        });
        document.querySelector(".graph-section").scrollIntoView({ behavior: "smooth" });
        return;
      }

      if (mode.instantOnly) {
        showStatus("error",
          `no instant bridge found for ${esc(start)} → ${esc(target)}. ` +
          `I only checked ${esc(mode.crawlLabel)} for a direct win or a known connector; ` +
          `switch to Recent fast or Full slow for a wider crawl.`);
        renderChain({
          target, display: targetMeta.name || target,
          found: false, length: null, path: [], hops: [],
        });
        recordSearchEvent("not_found", {
          ...analyticsBase,
          durationMs: performance.now() - searchStartedAt,
          requests: bridgeEngine.stats.apiCalls,
          cached: bridgeEngine.stats.cached,
        });
        return;
      }

      showStatus("working", "no instant bridge yet; widening the search…");
      logLine(`no instant bridge found; continuing with ${mode.crawlLabel}`);
      const result = await engine.findChain(start, target, depth);

      if (!result) {
        showStatus("error",
          `no connection found in this search. ` +
          (Number.isFinite(mode.archiveLimit)
            ? `Fast mode only checked the ${esc(mode.crawlLabel)}. Try Full slow if you want a deeper crawl. `
            : "") +
          `(looked through ${engine.stats.fetched} players)`);
        renderChain({
          target, display: targetMeta.name || target,
          found: false, length: null, path: [], hops: [],
        });
        recordSearchEvent("not_found", {
          ...analyticsBase,
          durationMs: performance.now() - searchStartedAt,
          requests: engine.stats.apiCalls,
          cached: engine.stats.cached,
        });
        return;
      }

      // grab avatars/titles for the players in between
      await hydratePlayers(result.path.slice(1, -1), engine);

      showStatus("done",
        `✓ found it — ${esc(start)} connects to ${esc(target)} in ${stepText(result.path.length - 1)}. ` +
        `looked at ${engine.stats.fetched} players, made ${engine.stats.apiCalls} requests` +
        (engine.stats.cached ? `, reused ${engine.stats.cached}` : "") + ".");
      setActiveChip(target);

      const renderedChain = {
        target,
        display: targetMeta.name || target,
        found: true,
        length: result.path.length - 1,
        path: result.path,
        hops: result.hops,
      };
      renderChain(renderedChain);
      submitLeaderboardChain(start, target, renderedChain);
      recordSearchEvent("found", {
          ...analyticsBase,
          length: renderedChain.length,
          steps: Math.max(0, renderedChain.path.length - 1),
          path: renderedChain.path,
          durationMs: performance.now() - searchStartedAt,
          requests: engine.stats.apiCalls,
          cached: engine.stats.cached,
        });
      document.querySelector(".graph-section").scrollIntoView({ behavior: "smooth" });
    } catch (e) {
      console.error(e);
      showStatus("error", `something went wrong: ${esc(e.message)}`);
      recordSearchEvent("error", {
        ...analyticsBase,
        durationMs: performance.now() - searchStartedAt,
      });
    } finally {
      btn.disabled = false;
      const est = await cache.estimate();
      if (est) {
        const info = $("#cache-info");
        info.hidden = false;
        info.textContent = est.remote
          ? "Large game histories stay out of this browser."
          : "Game history is not being stored in this browser.";
      }
    }
  }

  function metaShape(p) {
    return {
      username: p.username,
      avatar: p.avatar,
      title: p.title,
      name: p.name,
      url: p.url,
      country: countryCode(p.country),
      followers: p.followers,
      joined: p.joined,
      lastOnline: p.lastOnline || p.last_online,
      status: p.status,
      location: p.location,
      fide: p.fide,
      stats: p.stats,
      recentGames: Array.isArray(p.recentGames) ? p.recentGames : [],
      profileComplete: Boolean(p.profileComplete || p.stats),
    };
  }

  function timeAgo(ts) {
    const value = Number(ts);
    if (!Number.isFinite(value)) return "";
    const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
    if (seconds < 60) return "just now";
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d ago`;
    return formatProfileDate(Math.floor(value / 1000));
  }

  function countryCode(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    return raw.includes("/") ? raw.split("/").pop() : raw;
  }

  function chainKey(path) {
    return Array.isArray(path)
      ? path.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean).join(">")
      : "";
  }

  function showStatus(kind, msg) {
    const status = $("#search-status");
    status.hidden = false;
    status.className = "search__status" +
      (kind === "error" ? " is-error" : kind === "working" ? " is-working" : "");
    if (kind === "working") {
      status.innerHTML = `<span class="spinner"></span>${esc(msg)}`;
    } else {
      status.textContent = msg;
    }
  }

  function applyTheme(theme) {
    const next = theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem(LS_THEME_KEY, next);

    const btn = $("#theme-toggle");
    if (!btn) return;
    const isDark = next === "dark";
    btn.setAttribute("aria-pressed", String(isDark));
    btn.setAttribute("aria-label", isDark ? "Switch to light mode" : "Switch to dark mode");
    btn.title = isDark ? "Switch to light mode" : "Switch to dark mode";
  }

  // ---------- first-run intro ----------
  function introComplete() {
    if (introCompletedThisSession) return true;
    try {
      return localStorage.getItem(INTRO_COMPLETE_KEY) === "1";
    } catch (_) {
      return false;
    }
  }

  function openIntroGate() {
    const gate = $("#intro-gate");
    if (!gate) return;
    gate.hidden = false;
    requestAnimationFrame(() => $("#intro-start")?.focus());
  }

  function closeIntroGate() {
    const gate = $("#intro-gate");
    if (gate) gate.hidden = true;
  }

  function completeIntroGate() {
    introCompletedThisSession = true;
    try {
      localStorage.setItem(INTRO_COMPLETE_KEY, "1");
    } catch (_) {
      // If storage is blocked, treat this tab as introduced and keep going.
    }
    closeIntroGate();
    $("#search-start")?.focus();
  }

  // ---------- settings modal ----------
  function openSettings() {
    const modal = $("#settings-modal");
    modal.hidden = false;
    // populate fields from current state / storage
    $("#setting-username").value = localStorage.getItem(LS_KEY) || "";
    refreshCacheSize();
    const ownerStatus = $("#owner-status");
    const ownerAnalytics = $("#owner-analytics");
    const ownerFilters = $("#owner-filters");
    if (ownerStatus) {
      ownerStatus.hidden = true;
      ownerStatus.textContent = "";
    }
    if (ownerFilters && !state.ownerCode) ownerFilters.hidden = true;
    if (ownerAnalytics) {
      ownerAnalytics.hidden = true;
      ownerAnalytics.innerHTML = "";
    }
  }
  function closeSettings() {
    $("#settings-modal").hidden = true;
  }
  async function refreshCacheSize() {
    const el = $("#setting-cache-size");
    const cache = new window.GameCache();
    const est = await cache.estimate();
    el.textContent = est?.remote ? "Game data ready" : "Game data unavailable";
  }

  $("#settings-open").addEventListener("click", openSettings);
  $("#settings-close").addEventListener("click", closeSettings);
  $("#theme-toggle").addEventListener("click", () => {
    const current = document.documentElement.dataset.theme || "dark";
    applyTheme(current === "dark" ? "light" : "dark");
  });
  $("#intro-start")?.addEventListener("click", completeIntroGate);
  $("#settings-modal").addEventListener("click", (e) => {
    if (e.target.id === "settings-modal") closeSettings(); // click backdrop
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#settings-modal").hidden) closeSettings();
  });
  $("#owner-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    loadOwnerAnalytics();
  });
  $("#owner-filter-apply")?.addEventListener("click", () => {
    loadOwnerAnalytics();
  });

  // persist username typed in settings
  $("#setting-username").addEventListener("change", (e) => {
    const v = e.target.value.trim();
    if (v) {
      localStorage.setItem(LS_KEY, v);
      $("#search-start").value = v;
    } else {
      localStorage.removeItem(LS_KEY);
      $("#search-start").value = "";
    }
  });
  // clear cache button
  $("#setting-clear-cache").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "clearing…";
    try {
      const cache = new window.GameCache();
      await cache.clear();
      localStorage.removeItem(LS_KEY);
      localStorage.removeItem(LS_RANGE_KEY);
      localStorage.removeItem(LEGACY_DEPTH_KEY);
      $("#search-start").value = "";
      $("#setting-username").value = "";
      btn.textContent = "local prefs cleared";
      refreshCacheSize();
      setTimeout(() => { btn.disabled = false; btn.textContent = "clear saved data"; }, 1500);
    } catch (err) {
      btn.textContent = "clear saved data";
      btn.disabled = false;
    }
  });

  // ---------- wire up ----------
  $("#replay").addEventListener("click", () => {
    const svg = $("#graph");
    const traveller = svg.querySelector(".traveller");
    const spark = svg.querySelector(".edge-spark");
    if (svg.querySelector(".node") && traveller) animateGraph(svg, traveller, spark);
  });
  $("#copy-share")?.addEventListener("click", copyShareLink);
  $("#save-share-image")?.addEventListener("click", saveShareImage);
  $("#graph")?.addEventListener("click", (event) => {
    const node = event.target.closest(".node[data-profile-user]");
    if (!node) return;
    openGraphExplorer(node.dataset.profileUser);
  });

  $("#search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    hideUsernameSuggest();
    runSearch($("#search-start").value, $("#search-target").value, $("#search-range").value);
  });

  function wireSuggestInput(selector, field) {
    const input = $(selector);
    if (!input) return;
    input.addEventListener("focus", (e) => {
      scheduleUsernameSuggest(e.target.value, field);
    });
    input.addEventListener("input", (e) => {
      scheduleUsernameSuggest(e.target.value, field);
    });
    input.addEventListener("keydown", (e) => {
      const config = suggestConfig(field);
      if ($(config.box)?.hidden || state.suggest.field !== field) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        moveUsernameSuggest(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        moveUsernameSuggest(-1);
      } else if (e.key === "Enter" && state.suggest.activeIndex >= 0) {
        e.preventDefault();
        selectUsernameSuggestion(state.suggest.items[state.suggest.activeIndex]?.username, field);
      } else if (e.key === "Escape") {
        e.preventDefault();
        hideUsernameSuggest();
      }
    });
  }

  wireSuggestInput("#search-start", "start");
  wireSuggestInput("#search-target", "target");

  ["#username-suggest", "#target-suggest"].forEach((selector) => {
    const box = $(selector);
    const field = selector === "#target-suggest" ? "target" : "start";
    box?.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });
    box?.addEventListener("click", (event) => {
      const row = event.target.closest("[data-username], [data-exact]");
      if (!row) return;
      selectUsernameSuggestion(row.dataset.username || row.dataset.exact, field);
    });
  });

  $(".quick-targets")?.addEventListener("click", (event) => {
    const profileTrigger = event.target.closest("[data-profile-trigger][data-profile-user]");
    if (profileTrigger) {
      event.preventDefault();
      event.stopPropagation();
      hideUsernameSuggest();
      showProfilePopover(profileTrigger.dataset.profileUser, profileTrigger);
      return;
    }

    const more = event.target.closest(".quick-more[data-group]");
    if (more) {
      const group = more.closest(".quick-group");
      group?.querySelectorAll(".quick-player[hidden]").forEach((player) => {
        player.hidden = false;
      });
      group?.classList.add("is-expanded");
      more.hidden = true;
      return;
    }

    const chip = event.target.closest(".chip[data-target]");
    if (!chip) return;
    $("#search-target").value = chip.dataset.target;
    setActiveChip(chip.dataset.target);
    if (!introComplete()) {
      openIntroGate();
      return;
    }
    if ($("#search-start").value) {
      $("#search-form").requestSubmit();
    } else {
      $("#search-start").focus();
    }
  });

  $("#search-target").addEventListener("input", (e) => {
    setActiveChip(e.target.value.trim().toLowerCase());
  });

  document.addEventListener("click", (event) => {
    if (!event.target.closest(".search__field--username, .search__field--target")) {
      state.suggest.focused = false;
      hideUsernameSuggest();
    }
    if (event.target.closest("[data-explorer-close]")) {
      const panel = $("#graph-explorer");
      if (panel) panel.hidden = true;
      return;
    }
    const target = event.target.closest("[data-profile-trigger][data-profile-user]");
    if (target) {
      hideUsernameSuggest();
      showProfilePopover(target.dataset.profileUser, target);
      return;
    }
    if (!event.target.closest("#profile-popover")) hideProfilePopover();
  });

  function setActiveChip(target) {
    const wanted = (target || "").toLowerCase();
    document.querySelectorAll(".chip").forEach((chip) => {
      chip.classList.toggle("is-active", chip.dataset.target === wanted);
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    applyTheme(localStorage.getItem(LS_THEME_KEY) || document.documentElement.dataset.theme || "dark");
    // only restore the username if they saved one before
    // (don't pre-fill with any default)
    const saved = localStorage.getItem(LS_KEY);
    if (saved) $("#search-start").value = saved;
    localStorage.removeItem(LEGACY_DEPTH_KEY);
    localStorage.setItem(LS_RANGE_KEY, "auto");
    localStorage.setItem(LS_RANGE_MIGRATION_KEY, "1");
    $("#search-range").value = "auto";
    $("#search-target").value = $("#search-target").value || DEFAULT_TARGET;
    if (!introComplete()) openIntroGate();
    warmSharedCaches();
    loadShowcase().then(async () => {
      const sharedLoaded = await loadSharedChainFromUrl();
      loadLeaderboardTargets();
      if (!sharedLoaded) resumeActiveSearchJob();
    });
    // load the global leaderboard in the background
    if (window.Leaderboard) window.Leaderboard.load();
  });
})();
