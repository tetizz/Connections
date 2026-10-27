/* ============================================================
   Chess Connections — app.js
   - Searches each requested pair using verified game histories
   - Starts durable full-history searches and resumes their live progress
   - Saves the username in localStorage for next visit
   - Renders results as an animated node graph + hop cards
   ============================================================ */

(() => {
  "use strict";

  // Element-scoped failed URLs suppress only redundant final-batch retries.
  const failedAvatarURLs = new WeakMap();

  const SVG_NS = "http://www.w3.org/2000/svg";
  const DATA_BASE = new URL("./data/", document.baseURI).href;
  const LS_KEY = "chess-connections:username";
  const LS_THEME_KEY = "chess-connections:theme";
  const LS_RANGE_KEY = "chess-connections:range";
  const LS_RANGE_MIGRATION_KEY = "chess-connections:instant-range-default";
  const LS_ACTIVE_JOB_KEY = "chess-connections:active-search-job:v3:full-history-search";
  const SEARCH_POLICY_VERSION = "fresh-search-v2";
  const LS_VERIFIED_ROUTES_KEY = "chess-connections:verified-routes:v1";
  const LS_TOP_TRACE_KEY = "chess-connections:top-player-jobs:v1";
  const CHAIN_PARAM = "chain";
  const SHORT_CHAIN_PARAM = "c";
  const LEGACY_SHARE_PARAM = "share";
  const DEFAULT_TARGET = "magnuscarlsen";
  const LEGACY_DEPTH_KEY = "chess-connections:depth";
  const CHESS_LEADERBOARDS_URL = "https://api.chess.com/pub/leaderboards";
  const SUGGEST_MIN_CHARS = 2;
  const SUGGEST_LIMIT = 10;
  const USERNAME_MAX_LENGTH = 50;
  const REQUEST_TIMEOUT_MS = 10000;
  const SERVER_SEARCH_HARD_LIMIT_MS = 6 * 60 * 1000;
  const SERVER_POLL_RETRY_LIMIT = 5;
  const TERMINAL_SEARCH_STATUSES = new Set(["found", "not_found", "timeout", "failed", "expired"]);
  const OWNER_ANALYTICS_LIMIT = 30;
  const TOP_TRACE_BATCH_LIMIT = 30;
  const TOP_TRACE_CONCURRENCY = 6;
  const TOP_TRACE_POLL_INTERVAL_MS = 140;
  const TOP_TRACE_HARD_LIMIT_MS = 240000;
  const TOP_TRACE_SUBMIT_LIMIT = 30;
  const TOP_TRACE_SUBMIT_CONCURRENCY = 4;
  const BLOCKED_USERNAMES = new Set([String.fromCharCode(108, 111, 117, 105, 115, 95, 102, 108, 111, 121, 100)]);
  const COMPACT_GRAPH_MEDIA = window.matchMedia("(max-width: 620px)");
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
    chains: { chains: [] },
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
    searchJobs: new Map(),
    activeSearchOwner: "",
    quickTargetGroups: [],
    topTraceRunId: 0,
    topTraceResults: [],
    topTraceSubmittedKeys: new Set(),
    dialogReturnFocus: new WeakMap(),
    profilePopoverAnchor: null,
    graphImageObserver: null,
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
  const FOCUSABLE_SELECTOR = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");

  function focusableElements(container) {
    if (!container) return [];
    return [...container.querySelectorAll(FOCUSABLE_SELECTOR)]
      .filter((node) => (
        !node.closest("[hidden]")
        && node.getAttribute("aria-hidden") !== "true"
        && node.getClientRects().length > 0
      ));
  }

  function rememberDialogFocus(dialog) {
    if (!dialog || dialog.hidden === false) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement) state.dialogReturnFocus.set(dialog, active);
  }

  function restoreDialogFocus(dialog, fallback) {
    const target = state.dialogReturnFocus.get(dialog);
    state.dialogReturnFocus.delete(dialog);
    if (target instanceof HTMLElement && target.isConnected) target.focus();
    else fallback?.focus();
  }

  function trapDialogFocus(event, dialog) {
    if (event.key !== "Tab" || !dialog || dialog.hidden) return false;
    const focusable = focusableElements(dialog);
    if (!focusable.length) {
      event.preventDefault();
      return true;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
    return true;
  }

  const titleOf = (u) => state.players?.[u.toLowerCase()]?.title || null;
  const nameOf = (u) => {
    const p = state.players?.[u.toLowerCase()];
    return p?.name || p?.username || u;
  };
  const avatarOf = (u) => state.players?.[u.toLowerCase()]?.avatar || null;
  const cleanUsernameInput = (value) => {
    let input = String(value || "").trim();
    if (!input) return "";

    const profileUrl = input.match(
      /^(?:https?:\/\/)?(?:www\.)?chess\.com\/member\/([^/?#\s]+)(?:[/?#].*)?$/i
    );
    const apiUrl = input.match(
      /^(?:https?:\/\/)?api\.chess\.com\/pub\/player\/([^/?#\s]+)(?:[/?#].*)?$/i
    );
    if (profileUrl || apiUrl) {
      try {
        input = decodeURIComponent((profileUrl || apiUrl)[1]);
      } catch {
        return "";
      }
    } else if (input.startsWith("@")) {
      input = input.slice(1);
    }

    const username = input.trim().toLowerCase();
    return username.length <= USERNAME_MAX_LENGTH && /^[a-z0-9_-]+$/.test(username)
      ? username
      : "";
  };
  const usernameInputError = (value, label) => {
    const input = String(value || "").trim();
    if (!input) return `put in ${label} first.`;
    return `“${input.slice(0, 80)}” is not a valid Chess.com username. ` +
      "Use the handle, @handle, or a Chess.com member link.";
  };
  const isBlockedUsername = (username) => BLOCKED_USERNAMES.has(cleanUsernameInput(username));
  const pathHasBlockedUser = (path) => Array.isArray(path) && path.some(isBlockedUsername);

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function retryAfterMs(response) {
    const value = String(response?.headers?.get("Retry-After") || "").trim();
    if (!value) return 0;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, Math.min(5000, Math.ceil(seconds * 1000)));
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, Math.min(5000, date - Date.now())) : 0;
  }

  async function fetchJsonWithRetry(url, init = {}, options = {}) {
    const attempts = Math.max(1, Number(options.attempts) || 1);
    const timeoutMs = Math.max(1000, Number(options.timeoutMs) || REQUEST_TIMEOUT_MS);
    let lastError = null;

    for (let attempt = 0; attempt < attempts; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        const contentType = String(response.headers.get("Content-Type") || "");
        const data = contentType.includes("json")
          ? await response.json().catch(() => null)
          : null;
        if (response.ok) return { data, response };

        const error = new Error(data?.error || `HTTP ${response.status}`);
        error.status = response.status;
        error.retryAfterMs = retryAfterMs(response);
        error.retryable = response.status === 408 || response.status === 425 ||
          response.status === 429 || response.status >= 500;
        if (response.status === 429 && options.stopOnRateLimit) {
          error.retryable = false;
          error.retryAfterMs = Math.max(error.retryAfterMs,Math.min(300000,Math.max(0,Number(data?.retryAfter || 0)*1000)));
        }
        throw error;
      } catch (error) {
        const normalized = error?.name === "AbortError"
          ? Object.assign(new Error("request timed out"), { retryable: true })
          : error;
        if (normalized && normalized.status == null && normalized.retryable == null) {
          normalized.retryable = true;
        }
        lastError = normalized;
        if (!normalized?.retryable || attempt === attempts - 1) throw normalized;
        const delay = normalized.retryAfterMs ||
          Math.min(1200, 180 * (2 ** attempt));
        await wait(delay);
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError || new Error("request failed");
  }

  // ---------- data load ----------
  async function loadPlayerMetadata() {
    state.chains = { chains: [] };
    try {
      const response = await fetch(DATA_BASE + "players.json");
      state.players = response.ok ? await response.json() : {};
    } catch {
      state.players = {};
    }
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
    state.quickTargetGroups = [];
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
    state.quickTargetGroups = Array.isArray(groups) ? groups : [];
    if (!wrap) return;
    const playableGroups = groups.filter((group) => group.players?.length);
    if (!playableGroups.length) {
      renderLeaderboardUnavailable();
      return;
    }
    const active = ($("#search-target")?.value || DEFAULT_TARGET).trim().toLowerCase();
    const hasHiddenTargets = playableGroups.some((group) => group.players.length > 5);
    wrap.innerHTML = `${playableGroups.map((group, groupIndex) => `
      <section class="quick-group" style="--group-index:${groupIndex}" aria-label="${esc(group.label)} targets">
        <div class="quick-group__title">
          <span class="quick-group__icon quick-group__icon--${esc(group.id)}" aria-hidden="true">${quickIcon(group.icon)}</span>
          <span>${esc(group.label)}</span>
          <small>top 10 live</small>
        </div>
        <div class="quick-group__players">
          ${group.players.map((player, index) => quickTargetButton(player, index, active)).join("")}
        </div>
      </section>
    `).join("")}${hasHiddenTargets ? '<button class="quick-more quick-more--all" type="button" data-show-all-targets>See more</button>' : ""}`;
  }

  function quickTargetButton(player, index, active) {
    const username = player.username.toLowerCase();
    const display = player.display || player.username;
    const title = player.title ? `<span class="quick-player__title">${esc(player.title)}</span>` : "";
    const rank = Number.isFinite(player.rank) ? `<span class="quick-player__rank">#${player.rank}</span>` : "";
    const score = Number.isFinite(player.score) ? `<span>${plainNumber(player.score)}</span>` : "";
    const avatar = player.avatar
      ? `<img class="quick-player__photo" src="${esc(player.avatar)}" alt="${esc(display)} profile photo" width="34" height="34" crossorigin="anonymous" referrerpolicy="no-referrer" loading="lazy" decoding="async">`
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

  function loadLeaderboardTargetsWhenVisible() {
    const section = $(".quick-targets");
    renderQuickTargetsLoading();
    if (!section || typeof IntersectionObserver !== "function") {
      loadLeaderboardTargets();
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      loadLeaderboardTargets();
    }, { rootMargin: "80px 0px" });
    observer.observe(section);
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

  function topTraceCandidates() {
    const seen = new Map();
    const add = (player, source, priority) => {
      const username = cleanUsernameInput(player?.username || player);
      if (!username || isBlockedUsername(username)) return;
      const current = seen.get(username);
      const slot = {
        source,
        rank: Number(player?.rank || 99),
        score: Number(player?.score || player?.rating || 0),
      };
      const next = {
        ...(typeof player === "object" ? player : {}),
        username,
        display: player?.display || player?.name || username,
        source,
        priority,
        slots: [slot],
        slotCount: 1,
      };
      const slots = [...(current?.slots || []), slot];
      const sourceLabel = [...new Set(slots.map((item) => item.source).filter(Boolean))].join(" + ") || source;
      if (!current || priority < current.priority) {
        seen.set(username, {
          ...(current || {}),
          ...next,
          source: sourceLabel,
          slots,
          slotCount: slots.length,
          priority,
        });
      } else {
        seen.set(username, {
          ...current,
          avatar: current.avatar || next.avatar || "",
          title: current.title || next.title || "",
          score: Number.isFinite(current.score) ? current.score : next.score,
          rank: Number.isFinite(current.rank) ? current.rank : next.rank,
          display: current.display || next.display || username,
          source: sourceLabel,
          slots,
          slotCount: slots.length,
        });
      }
    };
    (state.quickTargetGroups || []).forEach((group, groupIndex) => {
      for (const player of (group.players || []).slice(0, 10)) {
        const rank = Number(player.rank || 99);
        add(player, group.label, rank * 10 + groupIndex);
      }
    });
    return [...seen.values()]
      .sort((a, b) => a.priority - b.priority || String(a.username).localeCompare(String(b.username)))
      .slice(0, TOP_TRACE_BATCH_LIMIT);
  }

  function topTraceLeaderboardSlotCount() {
    return (state.quickTargetGroups || []).reduce((total, group) =>
      total + Math.min(10, Array.isArray(group.players) ? group.players.length : 0), 0);
  }

  function topTraceFoundSlotCount(items) {
    return (items || []).reduce((total, item) => {
      if (!(item.status === "found" && item.job?.chain?.found)) return total;
      return total + Math.max(1, Number(item.player?.slotCount) || 1);
    }, 0);
  }

  function topTraceProgress(results) {
    const list = results || [];
    const found = list.filter(item => item.job?.chain?.found).length;
    const proven = list.filter(item => item.job?.shortestVerified === true).length;
    const checking = list.filter(item => ["queued", "running"].includes(item.status)).length;
    const unfinished = list.filter(item => ["paused", "error", "failed", "timeout"].includes(item.status)).length;
    return { checked: list.length - checking, found, proven, checking, unfinished, total: list.length };
  }

  function saveTopTraceBatch(start, results, options = {}) {
    try {
      if (options.batchId && state.topTraceActiveBatchId && options.batchId !== state.topTraceActiveBatchId) return;
      const signature = JSON.stringify([start, options.batchId || "", results.map(item => [item.player?.username, item.status, item.job?.id,
        item.job?.shortestVerified === true, item.retryAt || 0, serverChainIdentity(item.job?.chain)])]);
      if (state.topTracePersistedSignature === signature && Date.now() - Number(state.topTracePersistedAt || 0) < 10000) return;
      localStorage.setItem(LS_TOP_TRACE_KEY, JSON.stringify({ start, policyVersion: SEARCH_POLICY_VERSION,
        batchId: options.batchId, startedAt: options.startedAt || Date.now(), ts: Date.now(), results: results.map(item => ({ player: item.player, status: item.status,
          ms: item.ms, steps: item.steps, searchId: item.searchId, error: item.error, retryAt: item.retryAt, pollFailures: item.pollFailures,
          job: item.job ? { id: item.job.id, start: item.job.start, target: item.job.target,
            status: item.job.status, policyVersion: item.job.policyVersion, range: item.job.range,
            chain: item.job.chain, shortestVerified: item.job.shortestVerified,
            stats: item.job.stats, progress: item.job.progress, createdAt: item.job.createdAt } : null })) }));
      state.topTracePersistedSignature = signature;
      state.topTracePersistedAt = Date.now();
    } catch { /* Backend jobs continue even when browser storage is unavailable. */ }
  }

  async function resumeTopPlayersTrace() {
    try {
      const record = JSON.parse(localStorage.getItem(LS_TOP_TRACE_KEY) || "null");
      const foreground = JSON.parse(localStorage.getItem(LS_ACTIVE_JOB_KEY) || "null");
      if (!record || record.policyVersion !== SEARCH_POLICY_VERSION || !Array.isArray(record.results) ||
          !cleanUsernameInput(record.start) || Date.now() - Number(record.ts || 0) > 7 * 24 * 60 * 60 * 1000 ||
          Number(foreground?.ts || 0) > Number(record.startedAt || record.ts || 0) ||
          !record.results.some(item => !["found", "not_found"].includes(item.status))) return false;
      void runTopPlayersTrace(record);
      return true;
    } catch { return false; }
  }

  async function runTopPlayersTrace(savedBatch = null) {
    const startRaw = savedBatch?.start || $("#search-start")?.value || "";
    const start = cleanUsernameInput(startRaw);
    const btn = $("#trace-top-players");
    if (!btn) return;
    if (!start) {
      showStatus("error", usernameInputError(startRaw, "your username"));
      $("#search-start")?.focus();
      return;
    }
    $("#search-start").value = start;
    localStorage.setItem(LS_KEY, start);
    $("#setting-username").value = start;
    const candidates = savedBatch?.results?.length ? savedBatch.results.map(item => item.player)
      : topTraceCandidates().filter(player => player.username !== start);
    if (!candidates.length) {
      showStatus("error", "live leaderboard targets are still loading.");
      return;
    }
    resetSearchQueue();
    state.topTraceOpenedBranch = null;
    state.latestTopTraceTree = null;
    const runId = ++state.topTraceRunId;
    const batchStartedAt = Number(savedBatch?.startedAt || savedBatch?.ts || Date.now());
    const batchId = savedBatch?.batchId || `${start}:${batchStartedAt}:${Math.random().toString(36).slice(2)}`;
    state.topTraceActiveBatchId = batchId;
    state.activeSearchOwner = `top-players:${runId}`;
    const results = candidates.map((player, index) => {
      if (savedBatch?.results?.[index]) return savedBatch.results[index];
      const preview = savedVerifiedRoute(start, player.username);
      return { player, status: "queued", ms: null, steps: preview ? preview.path.length - 1 : null,
        job: preview ? { start, target: player.username, chain: preview, status: "queued", policyVersion: SEARCH_POLICY_VERSION } : null };
    });
    state.topTraceResults = results;
    btn.disabled = true;
    saveTopTraceBatch(start, results, { batchId, startedAt: batchStartedAt });
    showStatus("working", savedBatch ? "resuming full searches to top players..." : "starting full searches to top players...");
    let renderedTreeIdentity = "";
    const showProgressTree = () => {
      const identity = results.filter(item => item.job?.chain?.found)
        .map(item => `${item.player.username}:${serverChainIdentity(item.job.chain)}`).sort().join("|");
      if (!identity || identity === renderedTreeIdentity) return;
      renderedTreeIdentity = identity;
      void renderTopTraceCurrentTree(start, results, { scroll: false, progressive: true });
    };
    let dispatching = true;
    const update = (index, item) => {
      results[index] = item;
      saveTopTraceBatch(start, results, { batchId, startedAt: batchStartedAt });
      if (runId !== state.topTraceRunId) return;
      showProgressTree();
      const progress = topTraceProgress(results);
      const accepted = results.filter(row => row.job?.id).length;
      if (dispatching) {
        showStatus("working", `Starting full top-player searches: ${plainNumber(accepted)} of ${plainNumber(results.length)} accepted by the server. Accepted searches keep running after you leave.`);
        return;
      }
      showStatus("working", `Full top-player searches: ${plainNumber(progress.found)} routes found, ${plainNumber(progress.proven)} shortest verified, ${plainNumber(progress.checking)} still checking.`);
    };
    let cursor = 0;
    const dispatchWorker = async () => {
      // Accept every target before polling can wait on any one route. A later
      // foreground search only detaches this UI; accepted jobs keep running.
      while (cursor < results.length) {
        const index = cursor++;
        const previous = results[index];
        if (savedBatch && ((previous.status === "found" && previous.job?.shortestVerified === true) ||
            (previous.status === "not_found" && previous.job?.incomplete !== true))) continue;
        update(index, { ...previous, status: "queued" });
        const next = await traceTopCandidate(start, previous.player, runId, {
          existing: previous, startOnly: true, onUpdate: item => update(index, item),
        });
        update(index, next);
      }
    };
    const pollWorker = async (indices) => {
      while (cursor < indices.length && runId === state.topTraceRunId) {
        const index = indices[cursor++];
        const previous = results[index];
        if (!previous.job?.id || !["queued", "running"].includes(previous.job.status)) continue;
        update(index, { ...previous, status: "running" });
        const next = await traceTopCandidate(start, previous.player, runId, {
          existing: previous, pollOnce: true, onUpdate: item => update(index, item),
        });
        update(index, next);
      }
    };
    try {
      showProgressTree();
      await Promise.all(Array.from({ length: Math.min(TOP_TRACE_CONCURRENCY, results.length) }, dispatchWorker));
      if (runId !== state.topTraceRunId) return;
      dispatching = false;
      const pendingIndices = () => results.map((item, index) => ({ item, index }))
        .filter(({ item }) => item.status !== "paused" && item.job?.id && ["queued", "running"].includes(item.job.status))
        .map(({ index }) => index);
      while (runId === state.topTraceRunId) {
        const pending = pendingIndices();
        if (!pending.length) break;
        const ready = pending.filter(index => Number(results[index].retryAt || 0) <= Date.now());
        cursor = 0;
        // A worker handles one snapshot per target, never a whole search. Every
        // ready target gets its turn before another snapshot round begins.
        await Promise.all(Array.from({ length: Math.min(TOP_TRACE_CONCURRENCY, ready.length) }, () => pollWorker(ready)));
        if (runId !== state.topTraceRunId || !pendingIndices().length) break;
        const retryAt = Math.min(...pendingIndices().map(index => Number(results[index].retryAt || 0)));
        const gap = retryAt > Date.now() ? Math.min(5000, Math.max(1000, retryAt - Date.now())) : 5000;
        await wait(gap);
      }
      if (runId !== state.topTraceRunId) return;
      const progress = topTraceProgress(results);
      if (progress.found) await renderTopTraceCurrentTree(start, results, { scroll: true, progressive: Boolean(progress.unfinished || progress.checking) });
      if (progress.unfinished || progress.checking) {
        showStatus("working", `${plainNumber(progress.found)} top-player routes found; ${plainNumber(progress.proven)} shortest verified. Live updates paused for ${plainNumber(progress.unfinished + progress.checking)} searches. Saved server jobs keep their progress; reload to resume updates.`);
      } else if (!progress.found) {
        showStatus("error", "The full top-player searches finished without a verified route. Open a target to inspect its search.");
      }
    } finally {
      if (runId === state.topTraceRunId) btn.disabled = false;
    }
  }

  async function traceTopCandidate(start, player, runId, options = {}) {
    const target = cleanUsernameInput(player?.username);
    const started = performance.now();
    const id = options.existing?.searchId || newSearchEventId();
    const result = { player, status: "paused", ms: null, steps: null, job: options.existing?.job || null, searchId: id, retryAt: options.existing?.retryAt || 0, pollFailures: options.existing?.pollFailures || 0 };
    const remoteBase = workerBase();
    if (!remoteBase || !target || start === target) return { ...result, status: "skipped", ms: 0 };
    let job = options.existing?.job || null;
    let lastValidJob = null;
    const update = () => {
      const current = { ...result, status: ["queued", "running"].includes(job?.status) ? "running" : job?.status || "paused",
        ms: Math.round(performance.now() - started), steps: job?.chain?.found ? job.chain.path.length - 1 : null, job };
      if (job?.chain?.found) rememberVerifiedRoute(job);
      options.onUpdate?.(current);
      return current;
    };
    const validate = (next, expectedId = null) => {
      if (!next?.id) throw Object.assign(new Error("The search service returned no job."), { code: "SEARCH_PROTOCOL_ERROR" });
      if (next.policyVersion !== SEARCH_POLICY_VERSION) throw Object.assign(new Error("This job belongs to an older search policy. Start a fresh search."), { code: "SEARCH_POLICY_EXPIRED" });
      if (next.start !== start || next.target !== target || (expectedId && next.id !== expectedId)) {
        throw Object.assign(new Error("The search response does not match the requested player pair."), { code: "SEARCH_PROTOCOL_ERROR" });
      }
      if (next.chain?.found && (window.SavedRoutes?.routeStepCount(next.chain) == null ||
          next.chain.path[0] !== start || next.chain.path.at(-1) !== target || pathHasBlockedUser(next.chain.path))) {
        throw Object.assign(new Error("The route proof does not match the requested players."), { code: "SEARCH_PROTOCOL_ERROR" });
      }
      lastValidJob = next;
      return next;
    };
    try {
      if (!job?.id || TERMINAL_SEARCH_STATUSES.has(job.status)) {
        const { data } = await fetchJsonWithRetry(`${remoteBase}/search/start`, {
          method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json" },
          body: JSON.stringify({ start, target, range: "all", searchId: id }),
        }, { attempts: 3, timeoutMs: 12000, stopOnRateLimit: true });
        job = validate(data?.job);
      } else validate(job);
      const initial = update();
      if (options.startOnly) return initial;
      let pollAttempt = 0;
      while (["queued", "running"].includes(job.status) && performance.now() - started < TOP_TRACE_HARD_LIMIT_MS && runId === state.topTraceRunId) {
        if (pollAttempt++ > 0) await wait(Math.min(1800, TOP_TRACE_POLL_INTERVAL_MS + pollAttempt * 75));
        const { data } = await fetchJsonWithRetry(`${remoteBase}/search/job?id=${encodeURIComponent(job.id)}`, {
          headers: { "Accept": "application/json" },
        }, { attempts: options.pollOnce ? 1 : 3, timeoutMs: options.pollOnce ? 7000 : 12000, stopOnRateLimit: true });
        if (runId !== state.topTraceRunId) return { ...update(), status: "cancelled" };
        job = validate(data?.job, job.id);
        result.retryAt = 0;
        result.pollFailures = 0;
        const snapshot = update();
        if (options.pollOnce) return job.chain?.found && TERMINAL_SEARCH_STATUSES.has(job.status) && job.shortestVerified !== true
          ? { ...snapshot, status: "paused" } : snapshot;
      }
      const current = update();
      if (["queued", "running", "paused"].includes(job.status)) return { ...current, status: runId === state.topTraceRunId ? "paused" : "cancelled" };
      if (job.chain?.found && job.shortestVerified !== true) return { ...current, status: "paused" };
      return { ...current, status: job.chain?.found ? "found" : job.status || "not_found" };
    } catch (error) {
      if (options.pollOnce && lastValidJob && !["SEARCH_POLICY_EXPIRED", "SEARCH_PROTOCOL_ERROR"].includes(error?.code)) {
        const failures = Number(result.pollFailures || 0) + 1;
        return { ...result, job: lastValidJob, status: failures < SERVER_POLL_RETRY_LIMIT ? "running" : "paused", pollFailures: failures,
          retryAt: Date.now() + Math.max(1000, Number(error?.retryAfterMs || 0), Math.min(30000, 3000 * 2 ** (failures - 1))),
          error: error?.status === 429 ? "The API is cooling down; this search will retry after the cooldown." : "Live updates paused briefly; this saved search will retry." };
      }
      return { ...result, job: error?.code === "SEARCH_POLICY_EXPIRED" ? null : lastValidJob, status: "paused", ms: Math.round(performance.now() - started),
        error: error?.status === 429 ? "The API is cooling down; this saved search can resume later." : error.message || "Search updates paused." };
    }
  }

  function sortedTopTraceResults(results) {
    return [...(results || [])].sort((a, b) => {
      const aFound = Boolean(a.job?.chain?.found);
      const bFound = Boolean(b.job?.chain?.found);
      if (aFound !== bFound) return aFound ? -1 : 1;
      const aSteps = Number.isFinite(a.steps) ? a.steps : 999;
      const bSteps = Number.isFinite(b.steps) ? b.steps : 999;
      if (aSteps !== bSteps) return aSteps - bSteps;
      const aMs = Number.isFinite(a.ms) ? a.ms : 999999;
      const bMs = Number.isFinite(b.ms) ? b.ms : 999999;
      return aMs - bMs;
    });
  }

  function topTraceStepCount(chain) {
    if (Array.isArray(chain?.path)) return Math.max(0, chain.path.length - 1);
    if (Number.isFinite(chain?.length)) return chain.length;
    return 999;
  }

  async function renderTopTraceCurrentTree(start, results, options = {}) {
    const { scroll = false, progressive = false } = options;
    const foundItems = sortedTopTraceResults(results)
      .filter((item) => item.job?.chain?.found)
      .filter((item) => !pathHasBlockedUser(item.job?.chain?.path))
    const found = foundItems.map((item) => ({
        ...item.job.chain,
        target: item.job.target,
        display: item.player?.display || item.job.target,
        source: item.player?.source || "live",
        slotCount: Math.max(1, Number(item.player?.slotCount) || 1),
        slots: item.player?.slots || [],
        serverSearchId: item.job.id,
        shortestVerified: item.job.shortestVerified === true,
      }));
    if (!found.length) return;
    const root = cleanUsernameInput(start || found[0].path?.[0]);
    const targets = found.map((chain) => chain.target);
    const shortest = found.reduce((best, chain) => !best || topTraceStepCount(chain) < topTraceStepCount(best) ? chain : best, null);
    // A player can occupy several leaderboard slots. Count the deduplicated
    // targets in this batch, independent of whether live rankings have loaded.
    const targetCount = results.length;
    const foundSlotCount = found.length;
    if (!progressive) void hydrateTopTracePlayers(foundItems).catch(() => {});
    const tree = {
      tree: true, found: true, root,
      target: shortest?.target || targets[0],
      display: `${foundSlotCount} of ${targetCount} top players`,
      branchCount: found.length, targetCount, foundSlotCount, length: found.length,
      path: shortest?.path || found[0].path, hops: shortest?.hops || found[0].hops, chains: found,
    };
    state.latestTopTraceTree = tree;
    const preserveBranch = state.topTraceOpenedBranch && !state.currentChain?.tree &&
      state.currentChain?.target === state.topTraceOpenedBranch;
    if (preserveBranch) {
      const selected = found.find(branch => branch.target === state.topTraceOpenedBranch);
      if (selected && (serverChainIdentity(selected) !== serverChainIdentity(state.currentChain) ||
          selected.shortestVerified !== state.currentChain.shortestVerified)) {
        renderChain({ ...selected, length: selected.path.length - 1 });
      }
    } else {
      $("#search-target").value = tree.target || $("#search-target").value;
      setActiveChip($("#search-target").value);
      renderChain(tree);
    }
    if (!progressive) submitTopTraceLeaderboardBranches(root, found);
    showStatus(progressive ? "working" : "done",
      `${progressive ? "building" : "✓ built"} a top-player tree — ${esc(root)} has verified routes to ${plainNumber(foundSlotCount)} of ${plainNumber(targetCount)} top players.`);
    if (scroll && !preserveBranch) document.querySelector(".graph-section").scrollIntoView({ behavior: "smooth" });
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
    if (!username || isBlockedUsername(username)) return null;
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
    // Keep the exact typed handle selected by default. Suggestions only take
    // over after the visitor explicitly moves through them with the arrow keys
    // or clicks one.
    state.suggest.activeIndex = -1;
    input.setAttribute("aria-expanded", "true");
    input.removeAttribute("aria-activedescendant");
    for (const other of ["start", "target"]) {
      if (other !== field) {
        const otherConfig = suggestConfig(other);
        const otherBox = $(otherConfig.box);
        const otherInput = $(otherConfig.input);
        if (otherBox) otherBox.hidden = true;
        otherInput?.setAttribute("aria-expanded", "false");
        otherInput?.removeAttribute("aria-activedescendant");
      }
    }
    box.hidden = false;
    box.innerHTML = `
      <div class="username-suggest__panel">
        ${options.loading ? `<div class="username-suggest__status">Searching players...</div>` : ""}
        ${state.suggest.items.length ? state.suggest.items.map((item, index) => usernameSuggestionRow(item, index, field)).join("") : usernameSuggestEmpty(query)}
        <button class="username-suggest__all" type="button" data-exact="${esc(query)}">Use exact username "${esc(query)}"</button>
      </div>
    `;
  }

  function usernameSuggestionRow(item, index, field) {
    const display = item.name || item.username;
    const avatar = item.avatar
      ? `<img src="${esc(item.avatar)}" alt="${esc(display)} profile photo" referrerpolicy="no-referrer" loading="lazy" decoding="async">`
      : `<span>${esc((display[0] || "?").toUpperCase())}</span>`;
    const title = item.title ? `<span class="username-suggest__title">${esc(item.title)}</span>` : "";
    const country = countryFlagIcon(item.country);
    return `
      <button class="username-suggest__row${index === state.suggest.activeIndex ? " is-active" : ""}" id="username-suggest-option-${esc(field)}-${index}" type="button"
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
    if (state.suggest.activeIndex < 0) {
      state.suggest.activeIndex = delta > 0 ? 0 : state.suggest.items.length - 1;
    } else {
      state.suggest.activeIndex =
        (state.suggest.activeIndex + delta + state.suggest.items.length) % state.suggest.items.length;
    }
    $(config.box)?.querySelectorAll(".username-suggest__row").forEach((row, index) => {
      const active = index === state.suggest.activeIndex;
      row.classList.toggle("is-active", active);
      row.setAttribute("aria-selected", active ? "true" : "false");
      if (active) row.scrollIntoView({ block: "nearest" });
    });
    const input = $(config.input);
    if (input) input.setAttribute("aria-activedescendant", `username-suggest-option-${config.field}-${state.suggest.activeIndex}`);
  }

  function selectUsernameSuggestion(username, field = state.suggest.field) {
    const value = cleanUsernameInput(username);
    if (!value) return;
    if (isBlockedUsername(value)) {
      hideUsernameSuggest();
      showStatus("error", "that player is not available.");
      return;
    }
    if (field === "target") {
      $("#search-target").value = value;
      setActiveChip(value);
      hideUsernameSuggest();
      $("#trace-chain")?.focus();
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
      input?.removeAttribute("aria-activedescendant");
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
        <img src="https://flagcdn.com/w40/${esc(code)}.png"
             srcset="https://flagcdn.com/w80/${esc(code)}.png 2x"
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
    if (!chain?.tree && pathHasBlockedUser(chain?.path)) {
      showStatus("error", "that chain is not available.");
      return;
    }
    state.currentChain = chain;
    const backToTree = $("#top-tree-back");
    if (backToTree) backToTree.hidden = !(state.topTraceOpenedBranch && !chain.tree && state.latestTopTraceTree?.found);
    $("#target-name").textContent = chain.display || chain.target;
    $("#chain-length").textContent = chain.tree && chain.targetCount
      ? `${chain.foundSlotCount || chain.branchCount}/${chain.targetCount}`
      : chain.tree ? chain.branchCount : chain.found ? chain.length : "—";
    $(".graph-length-label").textContent = chain.tree ? "found" : "recorded wins";
    renderGraph(chain, { preserveTreeProgress: true });
    renderCards(chain);
    updateShareButton(chain);
  }

  function showAllTopPlayers() {
    if (!state.latestTopTraceTree?.found) return;
    state.topTraceOpenedBranch = null;
    const backToTree = $("#top-tree-back");
    if (backToTree) backToTree.hidden = true;
    $("#search-target").value = state.latestTopTraceTree.target;
    setActiveChip(state.latestTopTraceTree.target);
    renderChain(state.latestTopTraceTree);
    $("#replay")?.focus();
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
    if (chain?.tree || !chain?.found || !Array.isArray(chain.path) || !chain.path.length) {
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
      const encoded = params.get(CHAIN_PARAM) || params.get(LEGACY_SHARE_PARAM);
      const decoded = decodeSharePayload(encoded);
      if (decoded) {
        shared = await verifyLongSharedChain(decoded);
        if (!shared) {
          showStatus("error", "This shared chain could not be verified.");
          return true;
        }
      }
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

  async function verifyLongSharedChain(shared) {
    const remoteBase = workerBase();
    if (!remoteBase || !shared?.found) return null;
    try {
      const res = await fetch(`${remoteBase}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(shared),
      });
      if (!res.ok) return null;
      const data = await res.json();
      return decodeShareObject(data.share);
    } catch {
      return null;
    }
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
      ctx.fillStyle = "#f6efe2";
      ctx.font = "800 56px Inter, system-ui, sans-serif";
      ctx.fillText("Chess Connections", 80, 98);
      ctx.font = "600 28px Inter, system-ui, sans-serif";
      ctx.fillStyle = "rgba(246,239,226,.72)";
      ctx.fillText(`${nameOf(chain.path[0])} to ${nameOf(chain.path[chain.path.length - 1])}`, 82, 142);
      drawSharePill(ctx, `${chain.hops.length} proof game${chain.hops.length === 1 ? "" : "s"}`, 82, 182);
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

  function submitLeaderboardChain(
    start,
    target,
    chain,
    range = $("#search-range")?.value || "auto",
    serverSearchId = undefined,
  ) {
    if (!window.Leaderboard || !chain?.found || !Array.isArray(chain.path)) return;
    if (isBlockedUsername(start) || isBlockedUsername(target) || pathHasBlockedUser(chain.path)) return;
    window.Leaderboard.submit(
      start,
      target,
      connectionCount(chain.path),
      chain.path,
      chain.hops || [],
      range,
      serverSearchId,
    )
      .then(result => result?.ok && !result.skipped && window.Leaderboard?.load()).catch(() => {});
  }

  async function hydrateTopTracePlayers(items) {
    const usernames = new Set();
    state.players = state.players || {};
    for (const item of items || []) {
      for (const [username, profile] of Object.entries(item.job?.players || {})) {
        const key = cleanUsernameInput(username);
        if (!key) continue;
        state.players[key] = {
          ...(state.players[key] || {}),
          ...metaShape({ username: key, ...profile }),
          profileComplete: Boolean(profile?.stats),
        };
      }
      for (const username of item.job?.chain?.path || []) {
        const key = cleanUsernameInput(username);
        if (key) usernames.add(key);
      }
    }
    const missing = [...usernames].filter((username) => {
      const player = state.players?.[username];
      return !player?.avatar || !player?.name || !player?.profileComplete;
    });
    await Promise.all(missing.map((username) => fetchProfile(username).catch(() => null)));
  }

  function preloadTreeProfiles(nodes) {
    const usernames = [...new Set((nodes || [])
      .map((node) => cleanUsernameInput(node?.username))
      .filter(Boolean))]
      .filter((username) => {
        const player = state.players?.[username];
        return !player?.profileComplete || !player?.avatar || !player?.name;
      });
    let cursor = 0;
    const worker = async () => {
      while (cursor < usernames.length) {
        const username = usernames[cursor++];
        await fetchProfile(username).then(() => refreshGraphProfileNodes(username)).catch(() => null);
      }
    };
    const count = Math.min(6, usernames.length);
    for (let i = 0; i < count; i++) worker();
  }

  async function submitTopTraceLeaderboardBranches(start, branches) {
    if (!window.Leaderboard || !Array.isArray(branches) || !branches.length) return;
    const queue = [];
    const seen = new Set();
    for (const branch of branches) {
      if (queue.length >= TOP_TRACE_SUBMIT_LIMIT) break;
      const path = Array.isArray(branch.path) ? branch.path : [];
      const key = chainKey(path);
      const target = cleanUsernameInput(branch.target || path[path.length - 1]);
      if (!key || !target || isBlockedUsername(target) || pathHasBlockedUser(path) ||
          seen.has(key) || state.topTraceSubmittedKeys.has(key)) continue;
      seen.add(key);
      queue.push({ branch, path, key, target });
    }
    let submitted = 0;
    let cursor = 0;
    const worker = async () => {
      while (cursor < queue.length) {
        const item = queue[cursor++];
        state.topTraceSubmittedKeys.add(item.key);
        try {
          const outcome = await window.Leaderboard.submit(
            start,
            item.target,
            connectionCount(item.path),
            item.path,
            item.branch.hops || [],
            "all",
            item.branch.serverSearchId,
          );
          if (outcome?.ok && !outcome.skipped) submitted++;
          else state.topTraceSubmittedKeys.delete(item.key);
        } catch {
          state.topTraceSubmittedKeys.delete(item.key);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(TOP_TRACE_SUBMIT_CONCURRENCY, queue.length) }, worker));
    if (submitted && window.Leaderboard) {
      try {
        await window.Leaderboard.load("connectors");
      } catch {
        // keep the graph usable even if the leaderboard reload fails
      }
    }
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
      hops: Array.isArray(detail.hops) ? detail.hops : [],
      durationMs: Number.isFinite(detail.durationMs) ? detail.durationMs : null,
      expanded: Number.isFinite(detail.expanded) ? detail.expanded : null,
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
    const tools = $("#owner-tools");
    const code = String(codeInput?.value || "").trim();
    if (!remoteBase || !codeInput || !status || !wrap || !btn) return;
    if (!code) {
      status.hidden = false;
      status.textContent = "Enter the owner code first.";
      wrap.hidden = true;
      if (filters) filters.hidden = true;
      if (tools) tools.hidden = true;
      return;
    }

    btn.disabled = true;
    status.hidden = false;
    status.textContent = "Loading owner debug settings...";
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
      if (tools) tools.hidden = false;
      status.hidden = false;
      const total = Number(data.total || 0);
      status.textContent = `${plainNumber(total)} matching event${total === 1 ? "" : "s"}.`;
      loadOwnerWarmStatus("status").catch(() => {});
    } catch (error) {
      state.ownerCode = "";
      wrap.hidden = true;
      if (filters) filters.hidden = true;
      if (tools) tools.hidden = true;
      status.hidden = false;
      status.textContent = error.message || "Could not load analytics.";
    } finally {
      btn.disabled = false;
    }
  }

  async function loadOwnerWarmStatus(mode = "status") {
    const remoteBase = workerBase();
    const panel = $("#owner-tools");
    const stateEl = $("#owner-warm-state");
    const metrics = $("#owner-warm-metrics");
    const runBtn = $("#owner-warm-run");
    const graphBtn = $("#owner-graph-rebuild");
    const speedBtn = $("#owner-speed-check");
    const refreshBtn = $("#owner-warm-refresh");
    if (!remoteBase || !panel || !stateEl || !metrics || !state.ownerCode) return;

    const action = mode === true ? "warm" : mode;
    const isBusy = action === "warm" || action === "graph";
    panel.hidden = false;
    stateEl.textContent = action === "warm" ? "Warming" : action === "graph" ? "Rebuilding" : "Checking";
    metrics.innerHTML = `
      <span><strong>...</strong> players</span>
      <span><strong>...</strong> fragments</span>
      <span><strong>...</strong> graph nodes</span>
      <span><strong>...</strong> issues</span>
      <span><strong>...</strong> updated</span>`;
    if (runBtn) runBtn.disabled = true;
    if (graphBtn) graphBtn.disabled = true;
    if (speedBtn) speedBtn.disabled = true;
    if (refreshBtn) refreshBtn.disabled = true;

    try {
      const url = new URL(`${remoteBase}/search/warm`);
      if (action === "warm") url.searchParams.set("force", "1");
      else if (action === "graph") url.searchParams.set("index", "1");
      else url.searchParams.set("status", "1");
      const res = await fetch(url.toString(), {
        method: isBusy ? "POST" : "GET",
        headers: { "Accept": "application/json", "X-Owner-Code": state.ownerCode },
      });
      if (!res.ok) throw new Error("Cache status unavailable.");
      const data = await res.json();
      renderOwnerWarmStatus({
        ...(data?.status || data || {}),
        graphNodes: data?.graphNodes ?? data?.status?.graphNodes,
      });
    } catch (error) {
      stateEl.textContent = "Unavailable";
      metrics.innerHTML = `
        <span class="owner-warm-metric--wide"><strong>Could not load</strong> ${esc(error.message || "Try again.")}</span>`;
    } finally {
      if (runBtn) runBtn.disabled = false;
      if (graphBtn) graphBtn.disabled = false;
      if (speedBtn) speedBtn.disabled = false;
      if (refreshBtn) refreshBtn.disabled = false;
    }
  }

  const OWNER_SPEED_CASES = [
    { label: "direct cached", start: "polish_fighter3000", target: "magnuscarlsen" },
    { label: "two step", start: "ghandeevam2003", target: "magnuscarlsen" },
    { label: "saved route", start: "knightmaneuver_12", target: "hikaru" },
    { label: "no wins", start: "thechesswebsite", target: "hikaru" },
  ];

  async function runOwnerSpeedCheck() {
    const remoteBase = workerBase();
    const wrap = $("#owner-speed");
    const btn = $("#owner-speed-check");
    if (!remoteBase || !wrap || !state.ownerCode) return;
    wrap.hidden = false;
    wrap.innerHTML = `
      <div class="owner-speed__head">
        <strong>Speed check</strong>
        <span>Running ${plainNumber(OWNER_SPEED_CASES.length)} checks...</span>
      </div>`;
    if (btn) btn.disabled = true;
    const rows = [];
    for (const test of OWNER_SPEED_CASES) {
      const id = `owner-speed-${crypto.randomUUID()}`;
      const started = performance.now();
      try {
        const res = await fetch(`${remoteBase}/search/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json" },
          body: JSON.stringify({
            start: test.start,
            target: test.target,
            range: "auto",
            searchId: id,
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const ms = Math.round(performance.now() - started);
        const job = data?.job || {};
        rows.push({
          ...test,
          ms,
          status: job.status || "unknown",
          steps: Array.isArray(job.chain?.path) ? Math.max(0, job.chain.path.length - 1) : null,
        });
      } catch (error) {
        rows.push({ ...test, ms: Math.round(performance.now() - started), status: "error", error: error.message || "failed" });
      }
      renderOwnerSpeedRows(wrap, rows);
    }
    if (btn) btn.disabled = false;
  }

  function renderOwnerSpeedRows(wrap, rows) {
    const best = rows.length ? Math.min(...rows.map((row) => row.ms)) : 0;
    const worst = rows.length ? Math.max(...rows.map((row) => row.ms)) : 0;
    wrap.innerHTML = `
      <div class="owner-speed__head">
        <strong>Speed check</strong>
        <span>Best ${plainNumber(best)}ms · worst ${plainNumber(worst)}ms</span>
      </div>
      <div class="owner-speed__rows">
        ${rows.map(ownerSpeedRow).join("")}
      </div>`;
  }

  function ownerSpeedRow(row) {
    const ok = row.status === "found" || row.status === "not_found" || row.status === "running";
    const detail = row.error
      ? row.error
      : `${row.status}${Number.isFinite(row.steps) ? ` · ${row.steps} step${row.steps === 1 ? "" : "s"}` : ""}`;
    return `
      <div class="owner-speed__row ${ok ? "is-ok" : "is-bad"}">
        <span>${esc(row.label)}</span>
        <strong>${plainNumber(row.ms)}ms</strong>
        <small>${esc(detail)}</small>
      </div>`;
  }

  function renderOwnerWarmStatus(status) {
    const stateEl = $("#owner-warm-state");
    const metrics = $("#owner-warm-metrics");
    if (!stateEl || !metrics) return;
    const rawState = String(status?.status || "queued").toLowerCase();
    const label = rawState === "ready"
      ? "Ready"
      : rawState === "failed"
        ? "Needs attention"
        : rawState === "queued"
          ? "Queued"
          : "Warming";
    stateEl.textContent = label;
    metrics.innerHTML = `
      <span><strong>${plainNumber(status?.warmed || 0)}</strong> players</span>
      <span><strong>${plainNumber(status?.fragments || 0)}</strong> fragments</span>
      <span><strong>${plainNumber(status?.graphNodes || 0)}</strong> graph nodes</span>
      <span><strong>${plainNumber(status?.errors || 0)}</strong> issues</span>
      <span><strong>${esc(timeAgo(status?.updatedAt) || "unknown")}</strong> updated</span>`;
  }

  function renderOwnerAnalytics(data) {
    const wrap = $("#owner-analytics");
    if (!wrap) return;
    const events = Array.isArray(data?.events) ? data.events : [];
    wrap.hidden = false;
    if (!events.length) {
      wrap.innerHTML = `
        <div class="owner-empty">
          <strong>No matching events.</strong>
          <span>Change the filters or run a search, then refresh this panel.</span>
        </div>`;
      return;
    }
    const summary = ownerSummary(events);
    wrap.innerHTML = `
      <div class="owner-summary">
        <div>
          <span>Owner timeline</span>
          <strong>${plainNumber(events.length)} matching event${events.length === 1 ? "" : "s"}</strong>
        </div>
        <span>Updated ${esc(new Date(data.generatedAt || Date.now()).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))}</span>
      </div>
      <div class="owner-metrics">
        <span><strong>${plainNumber(summary.found)}</strong> found</span>
        <span><strong>${plainNumber(summary.problem)}</strong> issues</span>
        <span><strong>${summary.avgDuration}</strong> avg</span>
        <span><strong>${summary.cacheRate}</strong> cache</span>
      </div>
      ${events.map(ownerEventRow).join("")}
    `;
  }

  function ownerSummary(events) {
    const found = events.filter((event) => ["found", "saved"].includes(event.outcome)).length;
    const problem = events.filter((event) => ["not_found", "timeout", "error", "failed"].includes(event.outcome)).length;
    const durations = events.map((event) => Number(event.durationMs)).filter((value) => Number.isFinite(value) && value > 0);
    const avgMs = durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : 0;
    const requests = events.reduce((sum, event) => sum + Number(event.requests || 0), 0);
    const cached = events.reduce((sum, event) => sum + Number(event.cached || 0), 0);
    const cacheTotal = requests + cached;
    return {
      found,
      problem,
      avgDuration: avgMs ? `${(avgMs / 1000).toFixed(avgMs < 10000 ? 1 : 0)}s` : "0s",
      cacheRate: cacheTotal ? `${Math.round((cached / cacheTotal) * 100)}%` : "0%",
    };
  }

  function ownerEventRow(event) {
    const outcome = String(event.outcome || "search").replace(/_/g, "-");
    const path = Array.isArray(event.path) && event.path.length > 1
      ? `<div class="owner-event__chain">${esc(event.path.join(" -> "))}</div>`
      : "";
    const range = event.range ? String(event.range).replace(/_/g, " ") : "auto";
    const place = [event.country, event.device].filter(Boolean).join(" · ") || "visitor";
    const when = Number.isFinite(event.ts) ? timeAgo(event.ts) : "just now";
    const duration = Number.isFinite(event.durationMs) ? `${(event.durationMs / 1000).toFixed(event.durationMs < 10000 ? 1 : 0)}s` : "";
    const checked = Number.isFinite(event.expanded) ? `${event.expanded} checked` : "";
    const requests = Number.isFinite(event.requests) ? `${event.requests} requests` : "";
    const cached = Number.isFinite(event.cached) ? `${event.cached} reused` : "";
    const cacheRate = Number.isFinite(event.requests) || Number.isFinite(event.cached)
      ? `${cacheHitRate(event)} cache hit`
      : "";
    const stats = [duration, checked, requests, cached, cacheRate].filter(Boolean);
    const error = event.error ? `<div class="owner-event__chain">${esc(event.error)}</div>` : "";
    return `
      <div class="owner-event">
        <div class="owner-event__top">
          <span class="owner-event__path">${esc(event.start || "?")} -> ${esc(event.target || "?")}</span>
          <span class="owner-event__status is-${esc(outcome)}">${esc(statusText(event.outcome))}</span>
        </div>
        <div class="owner-event__meta">
          <span>${esc(when)} · ${esc(range)}</span>
          <span>${esc(place)}</span>
        </div>
        ${stats.length ? `<div class="owner-event__stats">${stats.map((item) => `<span>${esc(item)}</span>`).join("")}</div>` : ""}
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
    return window.SavedRoutes?.precomputedChain(state.chains, start, target) || null;
  }

  function bridgeSuffixesFor(target) {
    return window.SavedRoutes?.bridgeSuffixesFor(state.chains, target) || new Map();
  }

  function parseSearchMode() {
    return { key: "all", archiveLimit: Infinity, bridgeLimit: Infinity,
      label: "full-history search", crawlLabel: "full history", instantOnly: false };
  }

  function savedVerifiedRoute(start, target) {
    try {
      const stored = JSON.parse(localStorage.getItem(LS_VERIFIED_ROUTES_KEY) || "[]");
      const records = Array.isArray(stored) ? stored : [];
      const matches = records.filter(record => record?.serverVerified === true &&
        record.start === start && record.target === target &&
        window.SavedRoutes?.routeStepCount(record.chain) != null &&
        record.chain.path[0] === start && record.chain.path.at(-1) === target &&
        !pathHasBlockedUser(record.chain.path));
      matches.sort((a, b) => a.chain.path.length - b.chain.path.length || b.verifiedAt - a.verifiedAt);
      return matches[0]?.chain || null;
    } catch { return null; }
  }

  function rememberVerifiedRoute(job) {
    if (job?.policyVersion !== SEARCH_POLICY_VERSION || !job.start || !job.target ||
        window.SavedRoutes?.routeStepCount(job.chain) == null ||
        job.chain.path[0] !== job.start || job.chain.path.at(-1) !== job.target ||
        pathHasBlockedUser(job.chain.path)) return;
    try {
      const stored = JSON.parse(localStorage.getItem(LS_VERIFIED_ROUTES_KEY) || "[]");
      const records = Array.isArray(stored) ? stored : [];
      const previous = records.find(record => record.start === job.start && record.target === job.target);
      if (previous?.serverVerified && window.SavedRoutes?.routeStepCount(previous.chain) != null &&
          (previous.chain.path.length < job.chain.path.length || JSON.stringify(previous.chain) === JSON.stringify(job.chain))) return;
      const next = [{ start: job.start, target: job.target, chain: job.chain,
        serverVerified: true, verifiedAt: Date.now() },
        ...records.filter(record => record.start !== job.start || record.target !== job.target)].slice(0, 64);
      localStorage.setItem(LS_VERIFIED_ROUTES_KEY, JSON.stringify(next));
    } catch { /* Browsing/storage restrictions must not stop a server search. */ }
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
  function hydrateGraphImages(svg) {
    svg.querySelectorAll("image[data-avatar-src]").forEach((image) => {
      const source = image.dataset.avatarSrc;
      if (!source) return;
      image.setAttribute("href", source);
      image.removeAttribute("data-avatar-src");
    });
  }

  function loadGraphImagesWhenVisible(svg) {
    state.graphImageObserver?.disconnect();
    state.graphImageObserver = null;
    if (!svg.querySelector("image[data-avatar-src]")) return;
    if (typeof IntersectionObserver !== "function") {
      hydrateGraphImages(svg);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      if (state.graphImageObserver === observer) state.graphImageObserver = null;
      hydrateGraphImages(svg);
    }, { rootMargin: "160px 0px" });
    state.graphImageObserver = observer;
    observer.observe(svg.closest(".graph-wrap") || svg);
  }

  function updateGraphSummary(chain) {
    const summary = $("#graph-summary");
    const svg = $("#graph");
    if (!summary || !svg) return;
    if (!chain) {
      summary.textContent = "No connection is selected yet.";
      svg.setAttribute("aria-label", "Connection graph");
      return;
    }
    if (chain.tree) {
      const root = chain.root || chain.path?.[0] || "the starting player";
      const found = chain.foundSlotCount || chain.branchCount || 0;
      const total = chain.targetCount || chain.branchCount || 0;
      summary.textContent = `Connection tree from ${root}. ${found} of ${total} top players have verified routes. Open the proof ledger below for each game.`;
      svg.setAttribute("aria-label", `Connection tree from ${root}`);
      return;
    }
    if (!chain.found || !Array.isArray(chain.path) || !chain.path.length) {
      const target = chain.display || chain.target || "that player";
      summary.textContent = chain.pending ? `Searching for a verified connection to ${target}.`
        : chain.searchComplete === true ? `No verified connection to ${target} was found in the completed search.`
          : `The full search for ${target} has not completed.`;
      svg.setAttribute("aria-label", chain.pending ? `Searching for a connection to ${target}`
        : chain.searchComplete === true ? `No verified connection to ${target}` : `Search for ${target} not completed`);
      return;
    }
    const route = chain.path.map((username) => nameOf(username)).join(" then ");
    const links = Math.max(0, chain.path.length - 1);
    summary.textContent = `Verified ${links}-link win chain: ${route}. Every link has a public proof game in the ledger below.`;
    svg.setAttribute("aria-label", `Verified win chain from ${nameOf(chain.path[0])} to ${nameOf(chain.path[chain.path.length - 1])}`);
  }

  function renderGraph(chain, options = {}) {
    hideGraphExplorer();
    updateGraphSummary(chain);
    if (chain?.tree) {
      renderTreeGraph(chain, options);
      return;
    }
    const svg = $("#graph");
    svg.innerHTML = "";
    svg.classList.remove("is-tree-graph");
    delete svg.dataset.treeSignature;
    delete svg.dataset.treeAnimationRun;
    const compactGraph = COMPACT_GRAPH_MEDIA.matches;
    let viewWidth = compactGraph ? 300 : 1040;
    let viewHeight = 420;
    svg.setAttribute("viewBox", `0 0 ${viewWidth} ${viewHeight}`);
    svg.style.setProperty("--chain-graph-height", compactGraph ? "420px" : "330px");

    const defs = el("defs");
    const grad = el("linearGradient", {
      id: "edge-grad",
      gradientUnits: "userSpaceOnUse",
      x1: "0",
      y1: "0",
      x2: compactGraph ? "0" : String(viewWidth),
      y2: compactGraph ? String(viewHeight) : "0",
    });
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
        x: viewWidth / 2, y: 180, "text-anchor": "middle",
        fill: "#63685f", "font-size": compactGraph ? "14" : "18", "font-family": "ui-sans-serif, system-ui, sans-serif",
      });
      t.textContent = chain.pending ? `searching for a connection to ${chain.display || chain.target}...`
        : chain.searchComplete === true ? `No verified connection was found for ${chain.display || chain.target} in the completed search.`
          : `The full search for ${chain.display || chain.target} has not completed.`;
      svg.appendChild(t);
      $("#graph-hint").textContent =
        chain.pending ? "Checking public game connections." : chain.searchComplete === true ? "The completed search found no verified connection." : "The search has not finished; this is not a no-connection result.";
      return;
    }

    const nodes = chain.path;
    const n = nodes.length;
    if (compactGraph) {
      viewHeight = Math.max(420, 164 + Math.max(0, n - 1) * 132);
      svg.setAttribute("viewBox", `0 0 ${viewWidth} ${viewHeight}`);
      svg.style.setProperty("--chain-graph-height", `${viewHeight}px`);
      grad.setAttribute("y2", String(viewHeight));
    }
    const PAD = 128;
    const usable = viewWidth - PAD * 2;
    const stepX = n > 1 ? usable / (n - 1) : 0;
    const positions = compactGraph
      ? nodes.map((_, i) => ({ x: viewWidth / 2, y: 64 + i * 132 }))
      : nodes.map((_, i) => ({ x: PAD + stepX * i, y: 196 }));

    const edgesGroup = el("g");
    for (let i = 0; i < n - 1; i++) {
      const a = positions[i], b = positions[i + 1];
      const d = compactGraph
        ? `M ${a.x} ${a.y} C ${a.x + 28} ${(a.y + b.y) / 2}, ${b.x + 28} ${(a.y + b.y) / 2}, ${b.x} ${b.y}`
        : `M ${a.x} ${a.y} Q ${(a.x + b.x) / 2} ${a.y - 28} ${b.x} ${b.y}`;
      edgesGroup.appendChild(el("path", { class: "edge-glow", d }));
      edgesGroup.appendChild(el("path", { class: "edge-line", d }));
    }
    svg.appendChild(edgesGroup);

    const nodesGroup = el("g");
    nodes.forEach((u, i) => {
      const pos = positions[i];
      const isStart = i === 0;
      const isTarget = i === n - 1;
      const title = titleOf(u);
      const nodeMeta = title
        ? [title, isTarget ? "TARGET" : ""]
        : [isTarget ? "TARGET" : isStart ? "YOU" : ""];
      const nodeLabel = [nameOf(u), ...nodeMeta, "profile"]
        .filter(Boolean)
        .join(" ");
      const g = el("g", {
        class: "node" + (isStart ? " is-start" : "") + (isTarget ? " is-target" : ""),
        transform: `translate(${pos.x}, ${pos.y})`,
        "data-profile-user": u,
        "data-profile-trigger": "",
        tabindex: "0",
        role: "button",
        "aria-label": nodeLabel,
      });
      g.appendChild(el("circle", { class: "node__hit", r: 46 }));
      g.appendChild(el("ellipse", { class: "node__shadow", cx: 0, cy: 42, rx: 34, ry: 8 }));
      g.appendChild(el("circle", { class: "node__pulse", r: 34 }));
      g.appendChild(el("circle", { class: "node__ring", r: 32 }));

      const av = avatarOf(u);
      const fallback = el("text", { class: "node__icon", x: 0, y: 0 });
      fallback.textContent = pieceFor(isStart, isTarget);
      g.appendChild(fallback);
      if (av) {
        const img = el("image", {
          class: "node__img", "data-avatar-src": av,
          x: -32, y: -32, width: 64, height: 64,
          "clip-path": "url(#clip)", preserveAspectRatio: "xMidYMid slice",
        });
        img.addEventListener("error", () => {
          if (img.parentNode === g) failedAvatarURLs.set(g, av);
          img.remove();
        });
        img.addEventListener("load", () => fallback.remove(), { once: true });
        g.appendChild(img);
      }

      const label = el("text", { class: "node__label", x: 0, y: 58 });
      label.textContent = compactGraphLabel(nameOf(u), n > 7 ? 11 : 15);
      g.appendChild(label);

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

    loadGraphImagesWhenVisible(svg);
    animateGraph(svg, traveller, spark);
  }

  if (location.hostname === "127.0.0.1" || location.hostname === "localhost") {
    window.__connectionsDebugRenderGraph = renderGraph;
  }

  COMPACT_GRAPH_MEDIA.addEventListener?.("change", () => {
    if (!state.currentChain || state.currentChain.tree) return;
    hideProfilePopover();
    renderGraph(state.currentChain);
  });

  function renderTreeGraph(treeChain, options = {}) {
    const svg = $("#graph");
    const nextSignature = treeGraphSignature(treeChain);
    const preserveProgress = Boolean(
      options.preserveTreeProgress
      && svg.classList.contains("is-tree-graph")
      && svg.dataset.treeSignature === nextSignature
    );
    const now = performance.now();
    const preservedEdges = preserveProgress ? new Set(
      Array.from(svg.querySelectorAll(".tree-edge-line"))
        .filter((path) => {
          const completeAt = Number(path.dataset.drawCompleteAt || 0);
          return completeAt > 0 && completeAt <= now;
        })
        .map((path) => path.dataset.treeEdge)
        .filter(Boolean),
    ) : new Set();
    const preservedNodes = preserveProgress ? new Set(
      Array.from(svg.querySelectorAll(".tree-node.is-placed"))
        .map((node) => node.dataset.treeNodeId || node.dataset.profileUser)
        .filter(Boolean),
    ) : new Set();
    svg.innerHTML = "";
    svg.classList.add("is-tree-graph");
    svg.dataset.treeSignature = nextSignature;

    const defs = el("defs");
    const grad = el("linearGradient", { id: "edge-grad", gradientUnits: "userSpaceOnUse", x1: "0", y1: "0", x2: "1180", y2: "0" });
    grad.appendChild(el("stop", { offset: "0%", "stop-color": "#496a46" }));
    grad.appendChild(el("stop", { offset: "52%", "stop-color": "#c99b4b" }));
    grad.appendChild(el("stop", { offset: "100%", "stop-color": "#7e8b83" }));
    defs.appendChild(grad);
    const clip = el("clipPath", { id: "clip" });
    clip.appendChild(el("circle", { r: 28, cx: 0, cy: 0 }));
    defs.appendChild(clip);
    svg.appendChild(defs);

    const graph = buildMergedChainTree(treeChain.chains || []);
    if (!graph.nodes.length) {
      $("#graph-hint").textContent = "no top-player tree available yet.";
      return;
    }
    const viewWidth = graph.width || 1180;
    const viewHeight = graph.height || 680;
    svg.setAttribute("viewBox", `0 0 ${viewWidth} ${viewHeight}`);
    svg.style.setProperty("--tree-graph-height", `${Math.min(2200, Math.max(620, viewHeight * 0.84))}px`);

    const edgesGroup = el("g", { class: "tree-edges" });
    for (const edge of graph.edges) {
      const a = graph.positions.get(edge.from);
      const b = graph.positions.get(edge.to);
      if (!a || !b) continue;
      const c1x = a.x + Math.max(42, (b.x - a.x) * .46);
      const c2x = b.x - Math.max(42, (b.x - a.x) * .34);
      const dx = Math.max(1, b.x - a.x);
      const yDelta = b.y - a.y;
      const bow = Math.abs(yDelta) < 8 ? Math.min(12, Math.max(5, dx * .025)) : 0;
      const d = `M ${a.x} ${a.y} C ${c1x} ${a.y - bow} ${c2x} ${b.y - bow} ${b.x} ${b.y}`;
      const edgeKey = `${edge.from}|${edge.to}`;
      const depth = Math.max(1, Number(edge.depth || 1));
      edgesGroup.appendChild(el("path", {
        class: "edge-glow tree-edge-glow",
        d,
        "data-tree-edge": edgeKey,
        "data-edge-depth": depth,
      }));
      edgesGroup.appendChild(el("path", {
        class: "edge-line tree-edge-line",
        d,
        "data-tree-edge": edgeKey,
        "data-edge-depth": depth,
      }));
    }
    svg.appendChild(edgesGroup);

    const nodesGroup = el("g", { class: "tree-nodes" });
    for (const node of graph.nodes) {
      const pos = graph.positions.get(node.id);
      if (!pos) continue;
      const g = el("g", {
        class: "node tree-node" + (node.depth === 0 ? " is-start" : "") + (node.isTarget ? " is-target" : "") + (node.children.length > 1 ? " is-split" : ""),
        transform: `translate(${pos.x}, ${pos.y})`,
        "data-tree-node-id": node.id,
        "data-profile-user": node.username,
        "data-profile-trigger": "",
        tabindex: "0",
        role: "button",
        "aria-label": `${nameOf(node.username)} profile`,
      });
      g.appendChild(el("circle", { class: "node__hit", r: 42 }));
      g.appendChild(el("ellipse", { class: "node__shadow", cx: 0, cy: 36, rx: 28, ry: 7 }));
      g.appendChild(el("circle", { class: "node__pulse", r: 28 }));
      g.appendChild(el("circle", { class: "node__ring", r: 28 }));
      const av = avatarOf(node.username);
      if (av) {
        g.appendChild(el("image", {
          class: "node__img", href: av,
          x: -28, y: -28, width: 56, height: 56,
          "clip-path": "url(#clip)", preserveAspectRatio: "xMidYMid slice",
        }));
      } else {
        const icon = el("text", { class: "node__icon", x: 0, y: 0 });
        icon.textContent = pieceFor(node.depth === 0, node.isTarget);
        g.appendChild(icon);
      }
      const label = el("text", { class: "node__label", x: 0, y: 52 });
      label.textContent = compactGraphLabel(nameOf(node.username), node.depth === 0 ? 15 : 12);
      g.appendChild(label);
      const title = titleOf(node.username) || (node.depth === 0 ? "YOU" : node.isTarget ? "TARGET" : "");
      if (title) {
        const ttag = el("text", { class: "node__title", x: 0, y: 68 });
        ttag.textContent = title;
        g.appendChild(ttag);
      }
      nodesGroup.appendChild(g);
    }
    svg.appendChild(nodesGroup);

    $("#graph-hint").textContent =
      `${treeChain.foundSlotCount || treeChain.branchCount} of ${treeChain.targetCount || treeChain.branchCount} leaderboard targets found from ${treeChain.root}; duplicate players merge into ${treeChain.branchCount} unique branch${treeChain.branchCount === 1 ? "" : "es"}.`;

    preloadTreeProfiles(graph.nodes);
    animateTreeGraph(svg, { preservedEdges, preservedNodes });
  }

  window.__connectionsDebugRenderGraph = renderGraph;

  function treeGraphSignature(treeChain) {
    const root = cleanUsernameInput(treeChain?.root || "");
    const paths = (treeChain?.chains || [])
      .map((chain) => (chain.path || []).map(cleanUsernameInput).filter(Boolean).join(">"))
      .filter(Boolean)
      .sort()
      .join("|");
    const raw = [
      root,
      treeChain?.targetCount || "",
      treeChain?.foundSlotCount || "",
      treeChain?.branchCount || "",
      paths,
    ].join("::");
    let hash = 2166136261;
    for (let i = 0; i < raw.length; i++) {
      hash ^= raw.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `${root}:${treeChain?.targetCount || ""}:${treeChain?.foundSlotCount || ""}:${treeChain?.branchCount || ""}:${(hash >>> 0).toString(36)}`;
  }

  function buildMergedChainTree(chains) {
    const rootPath = chains.find((chain) => Array.isArray(chain.path) && chain.path.length >= 2)?.path || [];
    const root = cleanUsernameInput(rootPath[0]);
    if (!root) return { nodes: [], edges: [], positions: new Map() };
    const rootNode = { id: root, username: root, depth: 0, parent: null, children: [], targets: new Set(), leafOrder: null, isTarget: false };
    const nodesByKey = new Map([[root, rootNode]]);
    const edgesByKey = new Map();

    for (const chain of chains) {
      const path = Array.isArray(chain.path) ? chain.path.map(cleanUsernameInput).filter(Boolean) : [];
      if (path.length < 2 || path[0] !== root) continue;
      let parent = rootNode;
      for (let i = 1; i < path.length; i++) {
        const username = path[i];
        const id = `${parent.id}>${username}`;
        let node = nodesByKey.get(id);
        if (!node) {
          node = { id, username, depth: i, parent, children: [], targets: new Set(), leafOrder: null, isTarget: false };
          nodesByKey.set(id, node);
          parent.children.push(node);
          edgesByKey.set(`${parent.id}|${id}`, { from: parent.id, to: id, depth: i });
        }
        if (i === path.length - 1) {
          node.isTarget = true;
          node.targets.add(chain.target || username);
        }
        parent = node;
      }
    }

    const leaves = [];
    const assignLeaves = (node) => {
      if (!node.children.length) {
        node.leafOrder = leaves.length;
        leaves.push(node);
        return node.leafOrder;
      }
      const childOrders = node.children.map(assignLeaves);
      node.leafOrder = childOrders.reduce((sum, value) => sum + value, 0) / childOrders.length;
      return node.leafOrder;
    };
    assignLeaves(rootNode);

    const maxDepth = Math.max(1, ...[...nodesByKey.values()].map((node) => node.depth));
    const leafCount = Math.max(1, leaves.length);
    const positions = new Map();
    const width = 1180;
    const height = Math.max(680, leafCount * 86 + 150);
    const leftPad = 112;
    const rightPad = 116;
    const topPad = 86;
    const bottomPad = 92;
    const xForDepth = (depth) => leftPad + (depth / maxDepth) * (width - leftPad - rightPad);
    const yForLeaf = (leafOrder) => leafCount === 1 ? height / 2 : topPad + (leafOrder / (leafCount - 1)) * (height - topPad - bottomPad);
    for (const node of nodesByKey.values()) {
      positions.set(node.id, {
        x: xForDepth(node.depth),
        y: yForLeaf(node.leafOrder ?? 0),
      });
    }

    return {
      nodes: [...nodesByKey.values()],
      edges: [...edgesByKey.values()],
      positions,
      width,
      height,
    };
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

  function animateTreeGraph(svg, options = {}) {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const animationToken = nextTreeAnimationToken(svg);
    const preservedEdges = options.preservedEdges instanceof Set ? options.preservedEdges : new Set();
    const preservedNodes = options.preservedNodes instanceof Set ? options.preservedNodes : new Set();
    const nodes = Array.from(svg.querySelectorAll(".node"));
    const lines = Array.from(svg.querySelectorAll(".edge-line"));
    const glows = Array.from(svg.querySelectorAll(".edge-glow"));
    svg.querySelector(".tree-riders")?.remove();

    lines.forEach((path) => {
      const len = path.getTotalLength();
      const preserved = preservedEdges.has(path.dataset.treeEdge || "");
      path.style.strokeDasharray = len;
      path.style.strokeDashoffset = reduced || preserved ? 0 : len;
      path.style.transition = "none";
    });
    glows.forEach((path) => {
      const len = path.getTotalLength();
      const preserved = preservedEdges.has(path.dataset.treeEdge || "");
      path.style.strokeDasharray = len;
      path.style.strokeDashoffset = reduced || preserved ? 0 : len;
      path.style.opacity = reduced ? 0.08 : preserved ? treeGlowOpacity() : 0;
      path.style.transition = "none";
    });
    nodes.forEach((node) => {
      const nodeId = node.dataset.treeNodeId || node.dataset.profileUser || "";
      const preserved = preservedNodes.has(nodeId);
      node.style.opacity = reduced || preserved ? 1 : 0;
      node.style.transition = "none";
      node.classList.toggle("is-placed", reduced || preserved);
    });
    if (reduced) return;

    const riders = el("g", { class: "tree-riders", "aria-hidden": "true" });
    svg.appendChild(riders);
    const nodeById = new Map(nodes.map((node) => [node.dataset.treeNodeId || node.dataset.profileUser, node]));
    const edgesByFrom = new Map();
    const glowByEdge = new Map();
    glows.forEach((path) => {
      const key = path.dataset.treeEdge;
      if (key) glowByEdge.set(key, path);
    });
    lines.forEach((path, index) => {
      const [from, to] = String(path.dataset.treeEdge || "").split("|");
      if (!from || !to) return;
      const edge = {
        from,
        to,
        path,
        glow: glowByEdge.get(path.dataset.treeEdge),
        index,
      };
      if (!edgesByFrom.has(from)) edgesByFrom.set(from, []);
      edgesByFrom.get(from).push(edge);
    });

    requestAnimationFrame(() => {
      if (!isActiveTreeAnimation(svg, animationToken)) return;
      const root = nodes.find((node) => node.classList.contains("is-start"))?.dataset.profileUser;
      const rootEdge = lines.find((path) => String(path.dataset.treeEdge || "").startsWith(`${root}|`));
      const rootId = rootEdge ? String(rootEdge.dataset.treeEdge).split("|")[0] : null;
      const rootNode = rootId ? nodeById.get(rootId) : nodes.find((node) => node.classList.contains("is-start"));
      revealTreeNode(rootNode, 0, svg, animationToken);
      if (rootId) {
        setTimeout(() => cascadeTreeRiders(rootId, edgesByFrom, riders, nodeById, svg, animationToken), 360);
      } else {
        lines.forEach((path, index) => {
          drawTreePath(path, glows[index], index * 110, 820, svg, animationToken);
        });
      }
    });
  }

  function nextTreeAnimationToken(svg) {
    const token = String((Number(svg.dataset.treeAnimationRun) || 0) + 1);
    svg.dataset.treeAnimationRun = token;
    return token;
  }

  function isActiveTreeAnimation(svg, token) {
    return Boolean(svg && svg.dataset.treeAnimationRun === token);
  }

  function cascadeTreeRiders(fromId, edgesByFrom, riders, nodeById, svg, animationToken) {
    if (!isActiveTreeAnimation(svg, animationToken)) return Promise.resolve();
    const edges = edgesByFrom.get(fromId) || [];
    if (!edges.length) return Promise.resolve();
    return Promise.all(edges.map((edge, branchIndex) => {
      const branchDelay = branchIndex * 54;
      const duration = 760 + Math.min(220, Number(edge.path.dataset.edgeDepth || 1) * 40);
      drawTreePath(edge.path, edge.glow, branchDelay, duration, svg, animationToken);
      return rideTreePath(edge.path, riders, branchDelay, duration, svg, animationToken)
        .then(() => {
          if (!isActiveTreeAnimation(svg, animationToken)) return Promise.resolve();
          const reachedNode = nodeById?.get(edge.to);
          revealTreeNode(reachedNode, 0, svg, animationToken);
          warmNodeProfileForReveal(reachedNode);
          const nextEdges = edgesByFrom.get(edge.to) || [];
          if (!nextEdges.length) return Promise.resolve();
          return new Promise((resolve) => {
            setTimeout(() => {
              cascadeTreeRiders(edge.to, edgesByFrom, riders, nodeById, svg, animationToken).then(resolve);
            }, 80);
          });
        });
    }));
  }

  function warmNodeProfileForReveal(node) {
    const username = cleanUsernameInput(node?.dataset?.profileUser);
    if (!username) return Promise.resolve();
    const current = state.players?.[username];
    if (current?.profileComplete && (current.avatar || current.name)) {
      refreshGraphProfileNodes(username);
      return Promise.resolve();
    }
    return Promise.race([
      fetchProfile(username).catch(() => null),
      new Promise((resolve) => setTimeout(resolve, 240)),
    ]).then(() => refreshGraphProfileNodes(username));
  }

  function revealTreeNode(node, delay = 0, svg = null, animationToken = "") {
    if (!node || node.classList.contains("is-placed")) return;
    setTimeout(() => {
      if (svg && !isActiveTreeAnimation(svg, animationToken)) return;
      node.style.transition = "opacity .28s ease";
      node.style.opacity = 1;
      node.classList.add("is-placed");
      pulse(node);
    }, delay);
  }

  function drawTreePath(path, glow, delay = 0, duration = 820, svg = null, animationToken = "") {
    if (!path) return;
    if (svg && !isActiveTreeAnimation(svg, animationToken)) return;
    path.dataset.drawCompleteAt = String(performance.now() + delay + duration + 40);
    path.style.transition = `stroke-dashoffset ${duration}ms cubic-bezier(.2,.8,.2,1) ${delay}ms`;
    path.style.strokeDashoffset = 0;
    if (glow) {
      glow.dataset.drawCompleteAt = path.dataset.drawCompleteAt;
      glow.style.transition = `stroke-dashoffset ${duration}ms cubic-bezier(.2,.8,.2,1) ${delay}ms, opacity .28s ease ${delay}ms`;
      glow.style.strokeDashoffset = 0;
      glow.style.opacity = treeGlowOpacity();
    }
  }

  function treeGlowOpacity() {
    return 0.28;
  }

  function rideTreePath(path, riders, delay = 0, duration = 820, svg = null, animationToken = "") {
    if (!path || !riders) return Promise.resolve();
    const len = path.getTotalLength();
    const rider = el("text", {
      class: "tree-rider",
      x: 0,
      y: 0,
    });
    rider.textContent = "♞";
    rider.style.opacity = 0;
    riders.appendChild(rider);
    return new Promise((resolve) => window.setTimeout(() => {
      if (svg && !isActiveTreeAnimation(svg, animationToken)) {
        rider.remove();
        resolve();
        return;
      }
      const start = performance.now();
      let resolved = false;
      rider.style.opacity = 1;
      const step = (now) => {
        if (svg && !isActiveTreeAnimation(svg, animationToken)) {
          rider.remove();
          if (!resolved) {
            resolved = true;
            resolve();
          }
          return;
        }
        const t = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - t, 3);
        const point = path.getPointAtLength(len * eased);
        const next = path.getPointAtLength(Math.min(len, len * eased + 2));
        const angle = Math.atan2(next.y - point.y, next.x - point.x) * 180 / Math.PI;
        rider.setAttribute("x", point.x);
        rider.setAttribute("y", point.y);
        rider.setAttribute("transform", `rotate(${angle} ${point.x} ${point.y})`);
        if (t < 1) {
          requestAnimationFrame(step);
        } else {
          rider.classList.add("is-arrived");
          if (!resolved) {
            resolved = true;
            resolve();
          }
          setTimeout(() => {
            rider.style.transition = "opacity .45s ease, filter .45s ease, transform .45s ease";
            rider.style.opacity = 0;
            rider.style.filter = "drop-shadow(0 0 2px rgba(240, 201, 119, .12))";
          }, 760);
          setTimeout(() => {
            rider.remove();
          }, 1260);
        }
      };
      requestAnimationFrame(step);
    }, delay));
  }

  function revealNode(node, delay = 0) {
    return new Promise((resolve) => {
      setTimeout(() => {
        node.style.removeProperty("transform");
        node.style.transition = "opacity .14s ease";
        node.style.opacity = 1;
        setTimeout(resolve, 140);
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
      ring.style.transition = "r .22s ease-out, opacity .22s ease-out";
      ring.setAttribute("r", 52);
      ring.style.opacity = 0;
      setTimeout(resolve, 220);
    });
  }

  function travelPath(path, glow, traveller, spark) {
    return new Promise((resolve) => {
      const len = path.getTotalLength();
      const dur = 300;
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
    if (chain.tree) {
      renderTreeCards(chain, wrap);
      return;
    }
    if (!chain.found) {
      const message = chain.pending
        ? `Searching for a verified connection to ${esc(chain.display || chain.target)}. Proof games will appear here as routes are found.`
        : chain.searchComplete === true
          ? `No verified connection was found in the completed search for ${esc(chain.display || chain.target)}.`
          : "Search updates have not completed. Proof games will appear here when a verified route is available.";
      wrap.innerHTML = `<p style="color:var(--text-faint)">${message}</p>`;
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
      line.innerHTML =
        `<span class="winner">${esc(nameOf(hop.from))}</span> beat ` +
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

  function renderTreeCards(chain, wrap) {
    const branches = [...(Array.isArray(chain.chains) ? chain.chains : [])]
      .sort((a, b) =>
        topTraceStepCount(a) - topTraceStepCount(b) ||
        String(a.display || a.target || "").localeCompare(String(b.display || b.target || "")));
    if (!branches.length) {
      wrap.innerHTML = `<p style="color:var(--text-faint)">no top-player branches found yet.</p>`;
      return;
    }
    branches.forEach((branch, index) => {
      const target = branch.target || branch.path?.[branch.path.length - 1] || "";
      const card = document.createElement("div");
      card.className = "card tree-proof";
      card.style.setProperty("--branch-index", index);

      const avatars = document.createElement("div");
      avatars.className = "card__avatars";
      const rank = document.createElement("span");
      rank.className = "tree-proof__rank";
      rank.textContent = String(index + 1);
      avatars.appendChild(rank);
      avatars.appendChild(avatarEl(chain.root));
      const arrow = document.createElement("span");
      arrow.className = "card__arrow";
      arrow.textContent = "↳";
      avatars.appendChild(arrow);
      avatars.appendChild(avatarEl(target));

      const body = document.createElement("div");
      body.className = "card__body";
      const line = document.createElement("div");
      line.className = "card__line";
      line.innerHTML =
        `<button class="player-text winner" type="button" data-profile-trigger data-profile-user="${esc(chain.root)}">${esc(nameOf(chain.root))}</button> branches to ` +
        `<button class="player-text loser" type="button" data-profile-trigger data-profile-user="${esc(target)}">${esc(branch.display || nameOf(target))}</button>`;
      body.appendChild(line);
      const slotLabel = branch.slotCount > 1
        ? `${branch.slotCount} leaderboard slots`
        : branch.source || "leaderboard";
      const meta = document.createElement("div");
      meta.className = "tree-proof__meta";
      meta.innerHTML = `
        <span>${esc(slotLabel)}</span>
        <span>${plainNumber(Math.max(0, (branch.path || []).length - 1))} links</span>
        <span>${branch.shortestVerified === true ? "Shortest route verified" : "Shortest route not yet verified"}</span>
      `;
      body.appendChild(meta);
      const path = document.createElement("div");
      path.className = "tree-proof__path";
      path.innerHTML = treeBranchPath(branch.path || []);
      body.appendChild(path);

      const open = document.createElement("button");
      open.className = "card__proof";
      open.type = "button";
      open.dataset.treeOpen = target;
      open.textContent = "Open branch";

      card.appendChild(avatars);
      card.appendChild(body);
      card.appendChild(open);
      wrap.appendChild(card);
      setTimeout(() => card.classList.add("in"), index * 70);
    });
  }

  function treeBranchPath(path) {
    const clean = Array.isArray(path) ? path.map(cleanUsernameInput).filter(Boolean) : [];
    if (!clean.length) return "";
    return clean.map((username, index) => `
      <button class="tree-proof__path-node${index === 0 ? " is-root" : index === clean.length - 1 ? " is-target" : ""}" type="button" data-profile-trigger data-profile-user="${esc(username)}">
        @${esc(username)}
      </button>
      ${index < clean.length - 1 ? `<span class="tree-proof__path-arrow">→</span>` : ""}
    `).join("");
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
      img.width = 42;
      img.height = 42;
      img.loading = "lazy";
      img.decoding = "async";
      img.crossOrigin = "anonymous";
      img.dataset.profileUser = username.toLowerCase();
      img.dataset.profileTrigger = "";
      img.referrerPolicy = "no-referrer";
      img.addEventListener("error", () => {
        if (!img.parentNode) return;
        const fb = document.createElement("div");
        fb.className = "card__avatar-fallback";
        fb.textContent = (nameOf(username)[0] || "?").toUpperCase();
        fb.dataset.profileUser = username.toLowerCase();
        fb.dataset.profileTrigger = "";
        fb.tabIndex = 0;
        failedAvatarURLs.set(fb, av);
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
      ? `<img src="${esc(profile.avatar)}" alt="${esc(nameOf(key))} profile photo" crossorigin="anonymous" referrerpolicy="no-referrer">`
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

  function hideGraphExplorer() {
    const panel = $("#graph-explorer");
    if (panel) {
      panel.hidden = true;
      panel.innerHTML = "";
    }
  }

  function graphNodeFromEvent(event) {
    const direct = event.target?.closest?.(".node[data-profile-user]");
    if (direct) return direct;
    if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return null;
    let best = null;
    let bestDistance = Infinity;
    document.querySelectorAll("#graph .node[data-profile-user]").forEach((node) => {
      const hit = node.querySelector(".node__hit") || node;
      const rect = hit.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = event.clientX - cx;
      const dy = event.clientY - cy;
      const distance = Math.hypot(dx, dy);
      const radius = Math.max(32, Math.max(rect.width, rect.height) * .72);
      if (distance <= radius && distance < bestDistance) {
        best = node;
        bestDistance = distance;
      }
    });
    return best;
  }

  function activateGraphProfile(event) {
    const node = graphNodeFromEvent(event);
    if (!node) return false;
    event.preventDefault();
    event.stopPropagation();
    showProfilePopover(node.dataset.profileUser, node);
    return true;
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

  async function checkSearchPlayer(username) {
    const key = cleanUsernameInput(username);
    if (!key) return { username: key, exists: false, profile: null };
    const existing = state.players?.[key];
    if (existing?.profileExists === true || existing?.profileComplete) {
      return { username: key, exists: true, profile: existing };
    }

    try {
      const { data } = await fetchJsonWithRetry(
        `https://api.chess.com/pub/player/${encodeURIComponent(key)}`,
        { headers: { "Accept": "application/json" } },
        { attempts: 2, timeoutMs: 7000 }
      );
      const profile = data && typeof data === "object" ? data : null;
      if (!profile) return { username: key, exists: null, profile: null };
      const shaped = {
        ...(existing || {}),
        ...metaShape({ username: key, ...profile }),
        profileExists: true,
      };
      state.players = state.players || {};
      state.players[key] = shaped;
      return { username: key, exists: true, profile: shaped };
    } catch (error) {
      if (error?.status === 404 || error?.status === 410) {
        return { username: key, exists: false, profile: null };
      }
      // A rate limit or network failure must not be mistaken for a missing
      // player. The Worker can still validate and search the handle.
      return { username: key, exists: null, profile: null, error };
    }
  }

  async function validateSearchPlayers(start, target) {
    const [startResult, targetResult] = await Promise.all([
      checkSearchPlayer(start),
      checkSearchPlayer(target),
    ]);
    if (startResult.exists === false) {
      return { valid: false, missing: start };
    }
    if (targetResult.exists === false) {
      return { valid: false, missing: target };
    }
    return { valid: true, uncertain: startResult.exists == null || targetResult.exists == null };
  }

  async function lookupFallbackPlayer(engine, username) {
    try {
      return {
        outcome: "found",
        profile: await engine.fetchJSON(engine.API + username),
        error: null,
      };
    } catch (error) {
      if (error?.status === 404 || error?.status === 410) {
        return { outcome: "missing", profile: null, error };
      }
      const timedOut = error?.name === "AbortError" ||
        /timed out|timeout/i.test(String(error?.message || ""));
      return {
        outcome: timedOut ? "timeout" : "unavailable",
        profile: null,
        error,
      };
    }
  }

  async function fetchProfile(username) {
    const key = cleanUsernameInput(username);
    if (!key) return null;
    const existing = state.players?.[key];
    if (existing?.profileComplete) return existing;
    if (Number(existing?.profileRetryAt || 0) > Date.now()) return existing;
    if (state.profilePromises.has(key)) return state.profilePromises.get(key);

    const promise = (async () => {
      const remoteBase = String(window.CONNECTIONS_CACHE_API || "").replace(/\/+$/, "");
      let profile = null;
      if (/^https?:\/\//.test(remoteBase)) {
        try {
          const { data } = await fetchJsonWithRetry(
            `${remoteBase}/profile?username=${encodeURIComponent(key)}`,
            { headers: { "Accept": "application/json" } },
            { attempts: 2, timeoutMs: 7000, stopOnRateLimit: true }
          );
          profile = data?.profile || null;
          if (profile && data?.stale) profile = {...profile,enrichment:{
            stats:profile.enrichment?.stats === "unavailable" ? "unavailable" : "stale",
            recentGames:profile.enrichment?.recentGames === "unavailable" ? "unavailable" : "stale",
            retryAfterSeconds:Math.max(60,Number(data.retryAfter || 60)),
          }};
        } catch (error) {
          if (error?.status === 429) {
            state.players = state.players || {};
            state.players[key] = {...(existing || {username:key}),profileComplete:false,
              profilePartial:true,enrichment:existing?.enrichment || {stats:"unavailable",recentGames:"unavailable"},
              profileRetryAt:Date.now()+Math.max(60000,Number(error.retryAfterMs || 0))};
            return state.players[key];
          }
          // fall through to Chess.com direct lookup
        }
      }
      if (!profile) {
        try {
          const { data } = await fetchJsonWithRetry(
            `https://api.chess.com/pub/player/${encodeURIComponent(key)}`,
            { headers: { "Accept": "application/json" } },
            { attempts: 2, timeoutMs: 7000 }
          );
          profile = data || null;
        } catch {
          profile = null;
        }
      }
      if (!profile) return existing || null;
      const shaped = metaShape({ username: key, ...(profile || {}) });
      state.players = state.players || {};
      state.players[key] = {
        ...(state.players[key] || {}),
        ...shaped,
        profileExists: true,
        profileComplete: !profile.enrichment || (profile.enrichment.stats === "fresh" && profile.enrichment.recentGames === "fresh"),
        profilePartial: !!profile.enrichment && (profile.enrichment.stats !== "fresh" || profile.enrichment.recentGames !== "fresh"),
        profileRetryAt: profile.enrichment && (profile.enrichment.stats !== "fresh" || profile.enrichment.recentGames !== "fresh")
          ? Date.now() + Math.max(60000, Number(profile.enrichment.retryAfterSeconds || 60)*1000) : 0,
      };
      refreshGraphProfileNodes(key);
      return state.players[key];
    })();

    state.profilePromises.set(key, promise);
    try {
      return await promise;
    } finally {
      if (state.profilePromises.get(key) === promise) state.profilePromises.delete(key);
    }
  }

  function refreshGraphProfileNodes(username) {
    const key = cleanUsernameInput(username);
    const profile = state.players?.[key];
    const svg = $("#graph");
    if (!key || !profile || !svg) return;
    svg.querySelectorAll(`.node[data-profile-user="${CSS.escape(key)}"]`).forEach((node) => {
      const placed = node.classList.contains("is-placed") && Number(getComputedStyle(node).opacity) > 0.2;
      if (!placed) {
        const display = nameOf(key);
        const label = node.querySelector(".node__label");
        if (label) label.textContent = compactGraphLabel(display, node.classList.contains("is-start") ? 15 : 12);
        let title = node.querySelector(".node__title");
        const titleText = titleOf(key) || (node.classList.contains("is-start") ? "YOU" : node.classList.contains("is-target") ? "TARGET" : "");
        if (titleText) {
          if (!title) {
            title = el("text", { class: "node__title", x: 0, y: node.classList.contains("tree-node") ? 68 : 76 });
            node.appendChild(title);
          }
          title.textContent = titleText;
        }
      }
      if (profile.avatar && !node.querySelector(".node__img")) {
        const size = node.classList.contains("tree-node") ? 56 : 64;
        const img = el("image", {
          class: "node__img",
          href: profile.avatar,
          x: -size / 2,
          y: -size / 2,
          width: size,
          height: size,
          "clip-path": "url(#clip)",
          preserveAspectRatio: "xMidYMid slice",
        });
        const icon = node.querySelector(".node__icon");
        img.addEventListener("load", () => {
          // A late image must not remove a different fallback or replacement node.
          if (icon && img.parentNode === node && icon.parentNode === node &&
              node.querySelector(".node__icon") === icon) icon.remove();
        }, { once: true });
        const avatarURL = profile.avatar;
        img.addEventListener("error", () => {
          if (img.parentNode === node) failedAvatarURLs.set(node, avatarURL);
          img.remove();
        }, { once: true });
        if (icon?.parentNode === node) node.insertBefore(img, icon.nextSibling);
        else node.appendChild(img);
      }
      node.classList.add("is-profile-loaded");
    });
  }

  function renderProfilePopover(profile, username, anchor) {
    const pop = $("#profile-popover");
    if (!pop || !anchor) return;
    const display = profile?.name || profile?.username || username;
    const handle = profile?.username || username;
    const title = profile?.title ? `<span class="profile-popover__title">${esc(profile.title)}</span> ` : "";
    const avatar = profile?.avatar
      ? `<img src="${esc(profile.avatar)}" alt="${esc(display)} profile photo" crossorigin="anonymous" referrerpolicy="no-referrer">`
      : `<span>${esc((display[0] || "?").toUpperCase())}</span>`;
    const joined = profile?.joined ? `<span>Joined ${esc(formatProfileDate(profile.joined))}</span>` : `<span>Joined unavailable</span>`;
    const countryFlag = profile?.country ? flagIcon(profile.country, "profile-popover__flag") : "";
    const country = countryFlag
      ? `<span class="profile-popover__country" title="${esc(profile.country.toUpperCase())}">${countryFlag}</span>`
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
    const stats = renderProfileStats(profile?.stats, profile?.enrichment?.stats === "unavailable");
    const recentGames = renderProfileRecentGames(profile?.recentGames);
    const partialNotice = profile?.profilePartial
      ? `<p class="profile-popover__loading" role="status">Some player details could not refresh. ${profile.enrichment?.stats === "stale" || profile.enrichment?.recentGames === "stale" ? "Showing previously saved details." : "Ratings or recent games are temporarily unavailable."} Try again shortly.</p>` : "";

    pop.innerHTML = `
      <button class="profile-popover__close" type="button" data-profile-close aria-label="Close player details">Close</button>
      <div class="profile-popover__top">
        <span class="profile-popover__avatar">${avatar}</span>
        <span class="profile-popover__main">
          <strong>${title}${esc(display)}</strong>
          <small><span>@${esc(handle)}</span></small>
        </span>
      </div>
      <div class="profile-popover__meta">${country}${followers}${joined}${online}${location}${fide}${status}</div>
      ${partialNotice}
      ${stats}
      ${recentGames}
      <a class="profile-popover__open" href="${esc(url)}" target="_blank" rel="noopener">Open Chess.com profile</a>
    `;
    pop.setAttribute("aria-label", `${display} player details`);
    pop.hidden = false;
    positionProfilePopover(pop, anchor);
    pop.querySelector("[data-profile-close]")?.focus({ preventScroll: true });
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
    state.profilePopoverAnchor = anchor;
    const pop = $("#profile-popover");
    if (pop) {
      pop.hidden = false;
      pop.innerHTML = `<button class="profile-popover__close" type="button" data-profile-close aria-label="Close player details">Close</button><div class="profile-popover__loading" role="status">Loading ${esc(key)}...</div>`;
      positionProfilePopover(pop, anchor);
      pop.querySelector("[data-profile-close]")?.focus({ preventScroll: true });
    }
    const profile = await fetchProfile(key);
    if (token !== state.profilePopoverToken || $("#profile-popover")?.hidden) return;
    if (!profile) return;
    renderProfilePopover(profile, key, anchor);
  }

  function hideProfilePopover(restoreFocus = false) {
    state.profilePopoverToken++;
    const pop = $("#profile-popover");
    if (pop) {
      pop.hidden = true;
      pop.innerHTML = "";
    }
    const anchor = state.profilePopoverAnchor;
    state.profilePopoverAnchor = null;
    if (restoreFocus && anchor?.isConnected && typeof anchor.focus === "function") anchor.focus();
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

  function renderProfileStats(stats, unavailable = false) {
    const modes = [
      ["rapid", "Rapid"],
      ["blitz", "Blitz"],
      ["bullet", "Bullet"],
    ];
    const cells = modes.map(([key, label]) => {
      const stat = stats?.[key];
      if (!stat?.rating) {
        return `<div class="profile-stat"><span>${label}</span><strong>--</strong><small>${unavailable ? "Unavailable" : "No rating"}</small></div>`;
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

  function isSearchComplete(job) {
    return job?.status === "found" ? job.shortestVerified === true
      : job?.status === "not_found" && job.incomplete !== true;
  }

  async function runServerSearchFlow({ start, target, range, analyticsBase, mode, btn, status, logEl, knownChain = null }) {
    const remoteBase = workerBase();
    if (!remoteBase) {
      showStatus("error", "The full search service is not configured. No limited search was substituted.");
      return true;
    }
    const searchOwner = `search:${analyticsBase.searchId}`;
    const isCurrent = () => state.activeSearchOwner === searchOwner;

    let activeJob = null;
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

      const { data } = await fetchJsonWithRetry(
        `${remoteBase}/search/start`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json" },
          body: JSON.stringify({
            start,
            target,
            range,
            searchId: analyticsBase.searchId,
            knownChain,
          }),
        },
        { attempts: 3, timeoutMs: 12000, stopOnRateLimit: true }
      );
      if (!isCurrent()) return true;
      const job = data?.job;
      if (job?.policyVersion !== SEARCH_POLICY_VERSION) throw Object.assign(new Error("Start a new fresh search."), { code: "SEARCH_POLICY_EXPIRED" });
      if (!job?.id) throw Object.assign(new Error("job start failed"), { code: "SEARCH_PROTOCOL_ERROR" });
      activeJob = job;
      saveActiveJob({ id: job.id, start, target, range, searchId: analyticsBase.searchId, policyVersion: job.policyVersion });
      renderSearchQueue(job);
      // Only starting a request is exclusive. Once accepted, this durable job
      // can continue while the visitor submits another pair.
      btn.disabled = false;
      if (knownChain?.found) {
        let displayedChain = knownChain;
        let improvedByServer = false;
        const stepsIn = (chain) => window.SavedRoutes?.routeStepCount(chain) ?? 0;
        const showSavedRoute = (message) => {
          showStatus("working",
            `Showing a saved verified route — ${esc(start)} connects to ${esc(target)} in ` +
            `${stepText(stepsIn(displayedChain))}. ${message}`);
        };
        const applyIfShorter = async (finished) => {
          const candidate = finished?.chain;
          const shorter = window.SavedRoutes?.isStrictlyShorter(candidate, displayedChain);
          const sameProof = serverChainIdentity(candidate) === serverChainIdentity(displayedChain);
          if (!shorter && !sameProof) return false;
          const applied = await applyServerChain(finished, analyticsBase, {
            checking: !isSearchComplete(finished),
            recordOutcome: isSearchComplete(finished) ? "found" : null,
            submit: isSearchComplete(finished),
            isCurrent,
          });
          if (applied) {
            displayedChain = candidate;
            improvedByServer = true;
          }
          return applied;
        };
        const finishKnownRouteCheck = async (finished) => {
          if (!isCurrent()) {
            clearActiveJob(job.id);
            return;
          }
          if (isSearchComplete(finished)) clearActiveJob(job.id);
          finishSearchQueue(finished);
          const improved = await applyIfShorter(finished);
          if (!isCurrent() || improved || improvedByServer) return;
          if (isSearchComplete(finished)) {
            showStatus("done", "Your saved route is still the shortest verified route for this search.");
          } else showSavedRoute("The full search is not complete. Its progress is saved; reload to resume updates.");
        };

        await applyIfShorter(job);
        if (!isCurrent()) return true;
        if (TERMINAL_SEARCH_STATUSES.has(job.status)) {
          await finishKnownRouteCheck(job);
          return true;
        }

        logLine("found a verified route; checking for a shorter route");
        showSavedRoute("A full-history search is checking for a shorter route in the background.");
        btn.disabled = false;
        pollServerSearchJob(job.id, {
          analyticsBase,
          logLine,
          background: true,
          initialChain: displayedChain,
          isCurrent,
        })
          .then(finishKnownRouteCheck)
          .catch((error) => {
            if (!isCurrent()) {
              clearActiveJob(job.id);
              return;
            }
            if (error?.status === 404 || error?.status === 410) {
              clearActiveJob(job.id);
              finishSearchQueue({
                ...job,
                status: "expired",
                progress: "The shorter-route check expired; the saved proof is still available.",
              });
            }
            logLine(`shorter-route check paused: ${error.message}`);
            showSavedRoute("The shorter-route check paused; the saved proof is still available.");
          })
          .finally(() => {
            if (isCurrent()) btn.disabled = false;
          });
        return true;
      }
      let showedInstantChain = false;
      let instantChainKey = "";
      if (job.chain?.found) {
        if (TERMINAL_SEARCH_STATUSES.has(job.status)) {
          if (isSearchComplete(job)) clearActiveJob(job.id);
          finishSearchQueue(job);
          await applyServerChain(job, analyticsBase, { checking: !isSearchComplete(job),
            recordOutcome: isSearchComplete(job) ? "found" : null, submit: isSearchComplete(job), isCurrent });
          return true;
        }
        showedInstantChain = true;
        instantChainKey = chainKey(job.chain.path || []);
        await applyServerChain(job, analyticsBase, {
          checking: true,
          recordOutcome: null,
          submit: false,
          isCurrent,
        });
        logLine("found a verified connection; checking for a shorter route");
        btn.disabled = false;
        pollServerSearchJob(job.id, {
          analyticsBase,
          logLine,
          background: true,
          initialChain: job.chain,
          isCurrent,
        })
          .then(async (finished) => {
            if (!isCurrent()) return;
            if (isSearchComplete(finished)) clearActiveJob(job.id);
            finishSearchQueue(finished);
            if (finished?.chain?.found) {
              const finalChainKey = chainKey(finished.chain.path || []);
              await applyServerChain(finished, analyticsBase, {
                checking: !isSearchComplete(finished),
                recordOutcome: isSearchComplete(finished) ? "found" : null,
                submit: isSearchComplete(finished),
                scroll: finalChainKey !== instantChainKey,
                isCurrent,
              });
            }
          })
          .catch((error) => {
            logLine(`shorter-route check paused: ${error.message}`);
          })
          .finally(() => {
            if (isCurrent()) btn.disabled = false;
          });
        return true;
      }
      const finished = await pollServerSearchJob(job.id, {
        analyticsBase,
        logLine,
        isCurrent,
      });
      if (!isCurrent()) return true;
      if (isSearchComplete(finished)) clearActiveJob(job.id);
      finishSearchQueue(finished);
      if (finished?.chain?.found) {
        const finalChainKey = chainKey(finished.chain.path || []);
        await applyServerChain(finished, analyticsBase, {
          checking: !isSearchComplete(finished),
          recordOutcome: isSearchComplete(finished) ? (showedInstantChain && finalChainKey === instantChainKey ? "saved" : "found") : null,
          submit: isSearchComplete(finished),
          isCurrent,
        });
      } else {
        const rawOutcome = finished?.outcome ||
          (finished?.status === "timeout" ? "timeout" :
            finished?.status === "not_found" ? "not_found" : "error");
        const outcome = ["timeout", "not_found"].includes(rawOutcome) ? rawOutcome : "error";
        const missing = cleanUsernameInput(finished?.missingPlayer);
        showStatus("error", missing
          ? `couldn't find “${esc(missing)}” on Chess.com. Check the spelling or paste the member profile link.`
          : finished?.progress ||
          (finished?.status === "expired"
            ? "This saved search expired. Start it again to get a fresh result."
            : "no connection found in this search."));
        renderChain({
          target,
          display: target,
          found: false,
          searchComplete: isSearchComplete(finished),
          length: null,
          path: [],
          hops: [],
        });
        recordSearchEvent(outcome, {
          ...analyticsBase,
          jobId: finished?.id,
          durationMs: finished?.durationMs,
          expanded: finished?.stats?.expanded,
          requests: finished?.stats?.requests,
          cached: finished?.stats?.cached,
          error: finished?.error || finished?.progress || "",
        });
      }
      return true;
    } catch (error) {
      if (error?.code === "SEARCH_SUPERSEDED") return true;
      if (!isCurrent()) return true;
      logLine(`server search unavailable: ${error.message}`);
      if (error?.status === 410 || error?.code === "SEARCH_POLICY_EXPIRED") {
        clearActiveJob(activeJob?.id || "");
        showStatus("error", "This search has expired. Start a new search.");
        return true;
      }
      if (activeJob?.id) {
        if (knownChain?.found) {
          showStatus("done",
            "✓ the saved verified route is still available. " +
            "The shorter-route check paused and can resume after a reload.");
          return true;
        }
        showStatus("error",
          "The connection search is still saved, but live updates paused. " +
          "Reload this page to resume the same search instead of starting over.");
        return true;
      }
      const unavailable = error?.code !== "SEARCH_PROTOCOL_ERROR" &&
        (error?.status == null || [404, 405, 502, 503, 504].includes(error.status));
      if (!unavailable) {
        showStatus("error", error?.status === 429
          ? "The search service is cooling down. Try again after its rate limit clears."
          : "The search service could not accept this search. Try again later.");
        recordSearchEvent("error", { ...analyticsBase, error: error.message });
        return true;
      }
      showStatus("error", knownChain?.found
        ? "Your last verified route is still shown. The full search service could not connect; try again to continue looking for a shorter route."
        : "The full search service could not connect. Try again; no limited search was substituted.");
      recordSearchEvent("error", { ...analyticsBase, error: error.message });
      return true;
    } finally {
      if (isCurrent()) btn.disabled = false;
    }
  }

  async function pollServerSearchJob(id, {
    analyticsBase = null,
    logLine = null,
    background = false,
    initialChain = null,
    isCurrent = () => true,
  } = {}) {
    const remoteBase = workerBase();
    if (!remoteBase || !id) return null;
    let job = null;
    let displayedChain = initialChain;
    let attempt = 0;
    let consecutiveFailures = 0;
    const pollStartedAt = Date.now();
    for (;;) {
      if (!isCurrent()) {
        const error = new Error("search was replaced by a newer request");
        error.code = "SEARCH_SUPERSEDED";
        throw error;
      }
      if (Date.now() - pollStartedAt >= SERVER_SEARCH_HARD_LIMIT_MS) {
        const error = new Error("live updates timed out while the saved search kept running");
        error.code = "SEARCH_POLL_TIMEOUT";
        throw error;
      }
      const previous = state.searchJobs.get(id);
      const previousStats = previous?.stats || {};
      const params = new URLSearchParams({ id });
      if (Number(previousStats.expanded || 0) > 0) params.set("minExpanded", String(Number(previousStats.expanded || 0)));
      if (Number(previousStats.cached || 0) > 0) params.set("minCached", String(Number(previousStats.cached || 0)));
      let data = null;
      try {
        ({ data } = await fetchJsonWithRetry(
          `${remoteBase}/search/job?${params.toString()}`,
          { headers: { "Accept": "application/json" } },
          { attempts: 2, timeoutMs: 12000 }
        ));
        if (!isCurrent()) {
          const superseded = new Error("search was replaced by a newer request");
          superseded.code = "SEARCH_SUPERSEDED";
          throw superseded;
        }
        consecutiveFailures = 0;
      } catch (error) {
        consecutiveFailures++;
        if (!error?.retryable || consecutiveFailures > SERVER_POLL_RETRY_LIMIT) throw error;
        const retryDelay = Math.min(3000, error.retryAfterMs || 300 * (2 ** (consecutiveFailures - 1)));
        if (logLine) {
          logLine(`connection hiccup; retrying saved search (${consecutiveFailures}/${SERVER_POLL_RETRY_LIMIT})`);
        }
        await wait(retryDelay);
        continue;
      }

      if (data?.job?.policyVersion !== SEARCH_POLICY_VERSION) {
        clearActiveJob(id);
        throw Object.assign(new Error("This search belongs to an older policy. Start a new search."), { code: "SEARCH_POLICY_EXPIRED" });
      }
      job = mergeSearchJobSnapshot(data?.job);
      if (!job) throw new Error("job missing");
      if (!background) showServerJobProgress(job);
      if (logLine) logLine(job.progress || statusText(job.status));
      if (TERMINAL_SEARCH_STATUSES.has(job.status)) return job;
      const nextChain = job.chain;
      if (job.id === id && nextChain?.found && Array.isArray(nextChain.path) &&
          nextChain.path.length >= 2 && nextChain.path[0] === job.start &&
          nextChain.path.at(-1) === job.target &&
          (!displayedChain || nextChain.path.length < displayedChain.path.length ||
            (chainKey(nextChain.path) === chainKey(displayedChain.path) &&
              serverChainIdentity(nextChain) !== serverChainIdentity(displayedChain)))) {
        const applied = await applyServerChain(job, analyticsBase, {
          checking: true, recordOutcome: null, submit: false, scroll: false, isCurrent,
        });
        if (applied) displayedChain = nextChain;
      }
      await wait(attempt < 5 ? 350 : Math.min(1500, 500 + attempt * 75));
      attempt++;
    }
  }

  function mergeSearchJobSnapshot(job) {
    if (!job?.id) return job;
    const previous = state.searchJobs.get(job.id);
    const terminal = TERMINAL_SEARCH_STATUSES;
    if (!previous) {
      state.searchJobs.set(job.id, job);
      return job;
    }
    if (terminal.has(previous.status) && !terminal.has(job.status)) return previous;
    if (terminal.has(job.status)) {
      state.searchJobs.set(job.id, job);
      return job;
    }
    const prevStats = previous.stats || {};
    const nextStats = job.stats || {};
    const prevExpanded = Number(prevStats.expanded || 0);
    const nextExpanded = Number(nextStats.expanded || 0);
    const prevCached = Number(prevStats.cached || 0);
    const nextCached = Number(nextStats.cached || 0);
    const rewound = nextExpanded < prevExpanded || nextCached < prevCached;
    const merged = {
      ...job,
      start: job.start || previous.start,
      target: job.target || previous.target,
      range: job.range || previous.range,
      progress: rewound ? previous.progress : job.progress,
      stats: {
        ...nextStats,
        expanded: Math.max(prevExpanded, nextExpanded),
        cached: Math.max(prevCached, nextCached),
        requests: Math.max(Number(prevStats.requests || 0), Number(nextStats.requests || 0)),
      },
    };
    state.searchJobs.set(job.id, merged);
    return merged;
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

  function resetSearchQueue() {
    clearInterval(state.queueTimer);
    state.queueTimer = null;
    const panel = $("#search-queue");
    if (panel) panel.hidden = true;
    const log = $("#search-log");
    if (log) {
      log.hidden = true;
      log.innerHTML = "";
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

  function searchOptimalityNote(job) {
    if (job?.incomplete && job?.shortestVerified !== true) {
      return "Some game history was not fully checked. This route may not be the shortest.";
    }
    return job?.shortestVerified === true
      ? "Shortest route verified for this search."
      : "Shortest route has not been verified.";
  }
  // Route/proof identity excludes changing counters and display metadata.
  function serverChainIdentity(chain) {
    return chain?.found ? JSON.stringify([chain.path || [], (chain.hops || []).map(hop => hop.url || "")]) : "";
  }
  async function applyServerChain(job, analyticsBase, options = {}) {
    const {
      checking = false,
      recordOutcome = "found",
      submit = true,
      scroll = true,
      isCurrent = () => true,
    } = options;
    if (!isCurrent()) return false;
    const chain = job.chain;
    rememberVerifiedRoute(job);
    const reuseVisible = Boolean(state.currentChain?.found &&
      serverChainIdentity(state.currentChain) === serverChainIdentity(chain));
    state.players = state.players || {};
    for (const [username, profile] of Object.entries(job.players || {})) {
      const key = username.toLowerCase();
      state.players[key] = {
        ...(state.players[key] || {}),
        ...metaShape({ username: key, ...profile }),
        profileComplete: Boolean(profile?.stats),
      };
    }
    // Publish this already verified route before optional display enrichment.
    // A same-proof terminal snapshot replaces provisional metadata without
    // invalidating its still-running player enrichment. Superseded proofs cannot
    // refresh the new display; callbacks always read the latest accepted object.
    const isDisplayed = () => isCurrent() &&
      serverChainIdentity(state.currentChain) === serverChainIdentity(chain);
    if (checking) {
      showStatus("working",
        `Found a verified connection — checking for a shorter route. ` +
        searchOptimalityNote(job));
    } else {
      showStatus("done",
        `✓ found it — ` +
        `${esc(job.start)} connects to ${esc(job.target)} in ${stepText((chain.path || []).length - 1)}. ` +
        `checked ${Math.max(1, Number(job.stats?.expanded || 0))} player histories, made ${Number(job.stats?.requests || 0)} requests` +
        (Number(job.stats?.cached || 0) ? `, reused ${Number(job.stats.cached)}` : "") + ". " + searchOptimalityNote(job));
    }
    setActiveChip(job.target);
    if (!reuseVisible) renderChain(chain);
    else state.currentChain = chain;
    const initialShareUrl = $("#copy-share")?.dataset.shareUrl;
    if (reuseVisible) refreshVisibleChainMetadata(chain, initialShareUrl);
    // Keep the graph/card containers and their original finite animations alive.
    if (!reuseVisible) void hydratePlayers(chain.path || [], {
      fetchJSON: (url) => fetch(url, { headers: { "Accept": "application/json" } }).then((res) => res.json()),
      API: "https://api.chess.com/pub/player/",
    }).then(() => {
      if (isDisplayed()) refreshVisibleChainMetadata(state.currentChain, initialShareUrl);
    }).catch(() => {
      // Optional metadata failure must not retract verified public game proof.
    });
    if (submit) submitLeaderboardChain(job.start, job.target, chain, job.range || analyticsBase?.range || "auto", job.id);
    if (recordOutcome !== null) recordSearchEvent(recordOutcome, {
      ...analyticsBase,
      jobId: job.id,
      length: chain.length,
      steps: Math.max(0, (chain.path || []).length - 1),
      path: chain.path || [],
      hops: chain.hops || [],
      durationMs: job.durationMs,
      expanded: job.stats?.expanded,
      requests: job.stats?.requests,
      cached: job.stats?.cached,
      quality: qualityFromChain(chain),
    });
    if (scroll && !reuseVisible) document.querySelector(".graph-section").scrollIntoView({ behavior: "smooth" });
    return true;
  }

  function refreshVisibleChainMetadata(chain, initialShareUrl) {
    if (state.currentChain !== chain || chain.tree || !chain.found) return;
    const path = chain.path || [];
    const shareButton = $("#copy-share");
    if (initialShareUrl && shareButton?.dataset.shareUrl === initialShareUrl) {
      shareButton.dataset.shareUrl = buildLongShareUrl(chain);
    }
    updateGraphSummary(chain);
    const svg = $("#graph");
    if (svg) svg.querySelectorAll('.node[data-profile-user]').forEach((node) => {
      const username = node.dataset.profileUser;
      if (!path.includes(username)) return;
      // Existing avatars keep their placement/profile animation state.
      if (state.players?.[username]?.avatar && !node.querySelector('.node__img') &&
          failedAvatarURLs.get(node) !== state.players[username].avatar) {
        refreshGraphProfileNodes(username);
      }
      const isStart = node.classList.contains("is-start"), isTarget = node.classList.contains("is-target");
      const title = titleOf(username);
      const label = node.querySelector('.node__label');
      if (label) label.textContent = compactGraphLabel(nameOf(username), path.length > 7 ? 11 : 15);
      const meta = title ? [title, isTarget ? "TARGET" : ""] : [isTarget ? "TARGET" : isStart ? "YOU" : ""];
      node.setAttribute('aria-label', [nameOf(username), ...meta, "profile"].filter(Boolean).join(' '));
      let tag = node.querySelector('.node__title');
      const titleText = title ? title + (isTarget ? ' · TARGET' : '') : isTarget ? 'TARGET' : isStart ? 'YOU' : '';
      if (titleText) {
        if (!tag) { tag = el('text', {class:'node__title',x:0,y:76});node.appendChild(tag); }
        tag.textContent = titleText;
      } else tag?.remove();
    });
    const cards = $("#cards")?.querySelectorAll('.card') || [];
    (chain.hops || []).forEach((hop,index) => {
      const card = cards[index];if (!card) return;
      const details = card.querySelector('.card__sub');
      if (details) details.textContent = proofDetails(hop, index, chain.hops.length).join(" · ");
      const winner = card.querySelector('.winner'), loser = card.querySelector('.loser');
      if (winner) winner.textContent = nameOf(hop.from);
      if (loser) loser.textContent = nameOf(hop.to);
      const avatars = card.querySelectorAll('.card__avatars [data-profile-user]');
      [hop.from,hop.to].forEach((username,i) => {
        const current = avatars[i];if (!current) return;
        const avatar = avatarOf(username);
        if (current.tagName === 'IMG' && avatar && current.getAttribute('src') === avatar) {
          current.alt = nameOf(username);
          current.classList.toggle('is-titled', Boolean(titleOf(username)));
        } else if (current.classList.contains('card__avatar-fallback') &&
            (!avatar || failedAvatarURLs.get(current) === avatar)) {
          current.textContent = (nameOf(username)[0] || '?').toUpperCase();
        } else current.replaceWith(avatarEl(username));
      });
    });
  }
  function saveActiveJob(job) {
    try {
      localStorage.setItem(LS_ACTIVE_JOB_KEY, JSON.stringify({ ...job, policyVersion: SEARCH_POLICY_VERSION, ts: Date.now() }));
    } catch {
      // Non-critical.
    }
  }

  function clearActiveJob(id = "") {
    if (id) state.searchJobs.delete(id);
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
    if (!record?.id || record.policyVersion !== SEARCH_POLICY_VERSION || Date.now() - Number(record.ts || 0) > 7 * 24 * 60 * 60 * 1000) {
      clearActiveJob();
      return;
    }
    const resumeSearchId = record.searchId || record.id;
    const resumeOwner = `resume:${resumeSearchId}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    state.activeSearchId = resumeSearchId;
    state.activeSearchOwner = resumeOwner;
    const ownsResume = () =>
      state.activeSearchId === resumeSearchId && state.activeSearchOwner === resumeOwner;

    $("#search-start").value = record.start || $("#search-start").value;
    $("#search-target").value = record.target || $("#search-target").value;
    const saved = savedVerifiedRoute(record.start, record.target);
    if (saved) renderChain(saved);
    showStatus("working", "resuming full-history search...");
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
          searchId: resumeSearchId,
          start: record.start,
          target: record.target,
          range: record.range,
        },
        isCurrent: ownsResume,
      });
      if (!ownsResume()) return;
      if (isSearchComplete(job)) clearActiveJob(record.id);
      if (!ownsResume()) return;
      finishSearchQueue(job);
      if (job?.chain?.found) {
        await applyServerChain(job, {
          searchId: resumeSearchId,
          start: record.start,
          target: record.target,
          range: record.range,
        }, { checking: !isSearchComplete(job), recordOutcome: isSearchComplete(job) ? "found" : null, submit: isSearchComplete(job), isCurrent: ownsResume });
      } else if (job) {
        if (!ownsResume()) return;
        showStatus("error", job.progress || "The saved search finished without a connection.");
        if (!ownsResume()) return;
        renderChain({
          target: record.target,
          display: record.target,
          found: false,
          searchComplete: isSearchComplete(job),
          length: null,
          path: [],
          hops: [],
        });
      }
    } catch (error) {
      if (!ownsResume()) return;
      if (error?.status === 410 || error?.code === "SEARCH_POLICY_EXPIRED") {
        clearActiveJob(record.id);
        showStatus("error", "This search has expired. Start a new search.");
        return;
      }
      saveActiveJob(record);
      if (!ownsResume()) return;
      showStatus("error",
        "Could not resume live updates yet. The saved search is still available; reload to try again.");
      const message = $("#queue-message");
      if (message) message.textContent = error?.message || "Resume temporarily unavailable.";
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
    const start = cleanUsernameInput(startRaw);
    const target = cleanUsernameInput(targetRaw);
    const status = $("#search-status");
    const logEl = $("#search-log");
    const btn = $("#trace-chain");
    range = "all";
    const mode = parseSearchMode(range);
    resetSearchQueue();

    if (!start) {
      showStatus("error", usernameInputError(startRaw, "your username"));
      $("#search-start")?.focus();
      return;
    }
    if (!target) {
      showStatus("error", usernameInputError(targetRaw, "the target username"));
      $("#search-target")?.focus();
      return;
    }
    if (start === target) {
      showStatus("error", "those are the same player — pick two different ones.");
      return;
    }
    if (isBlockedUsername(start) || isBlockedUsername(target)) {
      showStatus("error", "that player is not available.");
      return;
    }
    $("#search-start").value = start;
    $("#search-target").value = target;
    const searchStartedAt = performance.now();
    const analyticsBase = { searchId: newSearchEventId(), start, target, range };
    state.activeSearchId = analyticsBase.searchId;
    state.activeSearchOwner = `search:${analyticsBase.searchId}`;
    recordSearchEvent("started", analyticsBase);

    // remember the username for next time
    localStorage.setItem(LS_KEY, start);
    localStorage.setItem(LS_RANGE_KEY, range);
    $("#setting-username").value = start;

    clearActiveJob();
    state.topTraceOpenedBranch = null;
    state.latestTopTraceTree = null;
    const knownChain = savedVerifiedRoute(start, target);
    state.chains = { chains: [] };
    state.topTraceRunId++;
    const topButton = $("#trace-top-players");
    if (topButton) topButton.disabled = false;
    if (knownChain) {
      renderChain(knownChain);
      showStatus("working", "Showing your last verified route while a full search checks for a shorter one.");
    } else {
      renderChain({ target, display: nameOf(target), found: false, pending: true, length: null, path: [], hops: [] });
      showStatus("working", "starting fresh full-history search...");
    }
    const handledByServer = await runServerSearchFlow({
      start,
      target,
      range,
      knownChain,
      analyticsBase,
      mode,
      btn,
      status,
      logEl,
    });
    if (!handledByServer) {
      showStatus("error", "The full search service could not start. Try again; no limited search was substituted.");
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
      enrichment: p.enrichment,
      profilePartial: p.profilePartial,
      profileRetryAt: p.profileRetryAt,
      profileComplete: !p.profilePartial && (!p.enrichment || (p.enrichment.stats === "fresh" && p.enrichment.recentGames === "fresh")) && Boolean(p.profileComplete || p.stats),
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

  // ---------- settings modal ----------
  function openSettings() {
    const modal = $("#settings-modal");
    rememberDialogFocus(modal);
    modal.hidden = false;
    document.body.classList.add("has-open-dialog");
    // populate fields from current state / storage
    $("#setting-username").value = localStorage.getItem(LS_KEY) || "";
    refreshCacheSize();
    const ownerStatus = $("#owner-status");
    const ownerAnalytics = $("#owner-analytics");
    const ownerFilters = $("#owner-filters");
    const ownerTools = $("#owner-tools");
    if (ownerStatus) {
      ownerStatus.hidden = true;
      ownerStatus.textContent = "";
    }
    if (ownerFilters && !state.ownerCode) ownerFilters.hidden = true;
    if (ownerTools) ownerTools.hidden = !state.ownerCode;
    if (ownerAnalytics) {
      ownerAnalytics.hidden = true;
      ownerAnalytics.innerHTML = "";
    }
    requestAnimationFrame(() => $("#setting-username")?.focus());
  }
  function closeSettings() {
    const modal = $("#settings-modal");
    modal.hidden = true;
    document.body.classList.remove("has-open-dialog");
    restoreDialogFocus(modal, $("#settings-open"));
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
  $("#settings-modal").addEventListener("click", (e) => {
    if (e.target.id === "settings-modal") closeSettings(); // click backdrop
  });
  document.addEventListener("keydown", (e) => {
    const settings = $("#settings-modal");
    if (settings && !settings.hidden) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeSettings();
        return;
      }
      trapDialogFocus(e, settings);
      return;
    }
    if (e.key === "Escape" && !$("#profile-popover")?.hidden) {
      e.preventDefault();
      hideProfilePopover(true);
    }
  });
  $("#owner-form")?.addEventListener("submit", (e) => {
    e.preventDefault();
    loadOwnerAnalytics();
  });
  $("#owner-filter-apply")?.addEventListener("click", () => {
    loadOwnerAnalytics();
  });
  $("#owner-filter-reset")?.addEventListener("click", () => {
    ["#owner-filter-outcome", "#owner-filter-username", "#owner-filter-target", "#owner-filter-range"].forEach((selector) => {
      const field = $(selector);
      if (field) field.value = "";
    });
    loadOwnerAnalytics();
  });
  $("#owner-warm-run")?.addEventListener("click", () => {
    loadOwnerWarmStatus("warm");
  });
  $("#owner-graph-rebuild")?.addEventListener("click", () => {
    loadOwnerWarmStatus("graph");
  });
  $("#owner-speed-check")?.addEventListener("click", () => {
    runOwnerSpeedCheck();
  });
  $("#owner-warm-refresh")?.addEventListener("click", () => {
    loadOwnerWarmStatus("status");
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
    if (state.currentChain?.tree) {
      renderGraph(state.currentChain);
      return;
    }
    const svg = $("#graph");
    const traveller = svg.querySelector(".traveller");
    const spark = svg.querySelector(".edge-spark");
    if (svg.querySelector(".node") && traveller) animateGraph(svg, traveller, spark);
  });
  $("#top-tree-back")?.addEventListener("click", showAllTopPlayers);
  $("#copy-share")?.addEventListener("click", copyShareLink);
  $("#save-share-image")?.addEventListener("click", saveShareImage);
  $("#graph")?.addEventListener("click", (event) => {
    activateGraphProfile(event);
  });

  $("#graph")?.addEventListener("pointerup", (event) => {
    if (event.pointerType === "mouse") return;
    activateGraphProfile(event);
  });

  $("#graph")?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const node = event.target.closest(".node[data-profile-user]");
    if (!node) return;
    event.preventDefault();
    showProfilePopover(node.dataset.profileUser, node);
  });
  $("#cards")?.addEventListener("click", (event) => {
    const open = event.target.closest("[data-tree-open]");
    if (!open || !state.currentChain?.tree) return;
    const target = cleanUsernameInput(open.dataset.treeOpen);
    const branch = (state.currentChain.chains || []).find((item) => cleanUsernameInput(item.target) === target);
    if (!branch) return;
    state.topTraceOpenedBranch = target;
    renderChain({
      target: branch.target,
      display: branch.display || nameOf(branch.target),
      found: true,
      length: Math.max(0, (branch.path || []).length - 1),
      path: branch.path || [],
      hops: branch.hops || [],
      quality: branch.quality || null,
      shortestVerified: branch.shortestVerified === true,
    });
    setActiveChip(branch.target);
    document.querySelector(".graph-section")?.scrollIntoView({ behavior: "smooth" });
  });

  $("#search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    hideUsernameSuggest();
    runSearch($("#search-start").value, $("#search-target").value, $("#search-range").value);
  });
  $("#trace-top-players")?.addEventListener("click", () => {
    hideUsernameSuggest();
    runTopPlayersTrace();
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

    const more = event.target.closest("[data-show-all-targets]");
    if (more) {
      event.currentTarget.querySelectorAll(".quick-player[hidden]").forEach((player) => {
        player.hidden = false;
      });
      event.currentTarget.querySelectorAll(".quick-group").forEach((group) => {
        group.classList.add("is-expanded");
      });
      more.hidden = true;
      return;
    }

    const chip = event.target.closest(".chip[data-target]");
    if (!chip) return;
    $("#search-target").value = chip.dataset.target;
    setActiveChip(chip.dataset.target);
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
      hideGraphExplorer();
      return;
    }
    if (event.target.closest("[data-profile-close]")) {
      hideProfilePopover(true);
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
    // Automatic search now traverses full histories under the current policy.
    localStorage.removeItem("chess-connections:active-search-job:v1");
    localStorage.removeItem("chess-connections:active-search-job:v2:fresh-search");
    loadPlayerMetadata().then(async () => {
      const sharedLoaded = await loadSharedChainFromUrl();
      loadLeaderboardTargetsWhenVisible();
      if (!sharedLoaded && !await resumeTopPlayersTrace()) resumeActiveSearchJob();
    });
    // Keep the global leaderboard off the initial critical path.
    if (window.Leaderboard) window.Leaderboard.init();
  });
})();
