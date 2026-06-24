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

  const state = {
    chains: null,
    players: null,
    activeTarget: null,
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
  const connectionCount = (path = []) => Math.max(0, path.length - 2);
  const stepText = (count) => `${count} step${count === 1 ? "" : "s"}`;

  const titleOf = (u) => state.players?.[u.toLowerCase()]?.title || null;
  const nameOf = (u) => {
    const p = state.players?.[u.toLowerCase()];
    return p?.name || p?.username || u;
  };
  const avatarOf = (u) => state.players?.[u.toLowerCase()]?.avatar || null;

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
    const first = state.chains.chains.find((c) => c.found) || state.chains.chains[0];
    if (first) selectTarget(first.target);
  }

  function renderShowcaseTabs() {
    // we keep a lightweight showcase selector below the search for quick swaps
    // (built dynamically only if showcase chains exist)
    if (!state.chains?.chains?.length) return;
    // default the search target to the first found showcase target
    if (!$("#search-target").value) {
      const first = state.chains.chains.find((c) => c.found);
      if (first) $("#search-target").value = first.target;
    }
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
    $("#target-name").textContent = chain.display || chain.target;
    $("#chain-length").textContent = chain.found ? chain.length : "—";
    renderGraph(chain);
    renderCards(chain);
  }

  function submitLeaderboardChain(start, target, chain) {
    if (!window.Leaderboard || !chain?.found || !Array.isArray(chain.path)) return;
    window.Leaderboard.submit(start, target, connectionCount(chain.path), chain.path)
      .then(() => window.Leaderboard && window.Leaderboard.load());
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
      const m = await engine.fetchJSON(engine.API + u).catch(() => null);
      if (m) state.players[u] = metaShape(m);
    }));
  }

  // ---------- graph ----------
  function renderGraph(chain) {
    const svg = $("#graph");
    svg.innerHTML = "";

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
    const PAD = 96, W = 1040;
    const usable = W - PAD * 2;
    const stepX = n > 1 ? usable / (n - 1) : 0;
    const y = 170;
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

      const label = el("text", { class: "node__label", x: 0, y: 56 });
      label.textContent = nameOf(u);
      g.appendChild(label);

      const title = titleOf(u);
      if (title) {
        const ttag = el("text", { class: "node__title", x: 0, y: 72 });
        ttag.textContent = title + (isTarget ? " · TARGET" : "");
        g.appendChild(ttag);
      } else if (isTarget) {
        const ttag = el("text", { class: "node__title", x: 0, y: 72 });
        ttag.textContent = "TARGET";
        g.appendChild(ttag);
      } else if (isStart) {
        const ttag = el("text", { class: "node__title", x: 0, y: 72 });
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
      node.style.transform = node.getAttribute("transform") + " scale(0.52)";
      node.style.transformOrigin = "center";
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
        node.style.transform = node.getAttribute("transform");
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
        node.style.transition = "opacity .35s ease, transform .45s cubic-bezier(.34,1.56,.64,1)";
        node.style.opacity = 1;
        node.style.transform = node.getAttribute("transform");
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
      const sub = document.createElement("div");
      sub.className = "card__sub";
      sub.textContent = `link ${i + 1} of ${chain.hops.length}`;
      body.appendChild(sub);

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
  }

  function avatarEl(username) {
    const av = avatarOf(username);
    const title = titleOf(username);
    if (av) {
      const img = document.createElement("img");
      img.className = "card__avatar" + (title ? " is-titled" : "");
      img.src = av;
      img.alt = nameOf(username);
      img.referrerPolicy = "no-referrer";
      img.addEventListener("error", () => {
        const fb = document.createElement("div");
        fb.className = "card__avatar-fallback";
        fb.textContent = (nameOf(username)[0] || "?").toUpperCase();
        img.replaceWith(fb);
      });
      return img;
    }
    const fb = document.createElement("div");
    fb.className = "card__avatar-fallback";
    fb.textContent = (nameOf(username)[0] || "?").toUpperCase();
    return fb;
  }

  // ---------- live search ----------
  async function runSearch(startRaw, targetRaw, depth, range) {
    const start = startRaw.trim().toLowerCase();
    const target = targetRaw.trim().toLowerCase();
    const status = $("#search-status");
    const logEl = $("#search-log");
    const btn = $(".search__btn");
    const mode = parseSearchMode(range);

    if (!start || !target) {
      showStatus("error", "put in both usernames first.");
      return;
    }
    if (start === target) {
      showStatus("error", "those are the same player — pick two different ones.");
      return;
    }

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
      document.querySelector(".graph-section").scrollIntoView({ behavior: "smooth" });
      return;
    }

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
          `${stats.apiCalls} API calls · ${stats.cached} cached</span>`;
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
    logLine(`connecting ${start} → ${target}  (${mode.label}${mode.instantOnly ? "" : `, up to ${depth} steps deep`})`);

    try {
      // check both players exist + grab their info for the display
      const [startMeta, targetMeta] = await Promise.all([
        engine.fetchJSON(engine.API + start).catch(() => null),
        engine.fetchJSON(engine.API + target).catch(() => null),
      ]);
      if (!startMeta) {
        showStatus("error", `couldn't find "${esc(start)}" on chess.com — check the spelling?`);
        return;
      }
      if (!targetMeta) {
        showStatus("error", `couldn't find "${esc(target)}" on chess.com — check the spelling?`);
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
          return;
        }
      }
      if (bridged) {
        await hydratePlayers(bridged.path, bridgeEngine);
        const bridgeWork = bridgeEngine.stats.apiCalls
          ? `made ${bridgeEngine.stats.apiCalls} quick requests` +
            (bridgeEngine.stats.cached ? `, ${bridgeEngine.stats.cached} from cache` : "")
          : bridgeEngine.stats.cached
            ? `read ${bridgeEngine.stats.cached} player cache${bridgeEngine.stats.cached === 1 ? "" : "s"}`
          : "used the saved bridge index";
        showStatus("done",
          `✓ found it fast — ${esc(start)} connects to ${esc(target)} in ${stepText(bridged.length)}. ` +
          `checked ${esc(mode.instantOnly ? mode.label : "the instant bridge first")} and ${bridgeWork}.`);
        setActiveChip(target);
        renderChain(bridged);
        submitLeaderboardChain(start, target, bridged);
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
        return;
      }

      showStatus("working", "no instant bridge yet; widening the search…");
      logLine(`no instant bridge found; continuing with ${mode.crawlLabel}`);
      const result = await engine.findChain(start, target, depth);

      if (!result) {
        showStatus("error",
          `no connection found within ${depth} steps. ` +
          (Number.isFinite(mode.archiveLimit)
            ? `Fast mode only checked the ${esc(mode.crawlLabel)}. Try Full slow if you want a deeper crawl. `
            : "") +
          `(looked through ${engine.stats.fetched} players)`);
        renderChain({
          target, display: targetMeta.name || target,
          found: false, length: null, path: [], hops: [],
        });
        return;
      }

      // grab avatars/titles for the players in between
      await hydratePlayers(result.path.slice(1, -1), engine);

      showStatus("done",
        `✓ found it — ${esc(start)} connects to ${esc(target)} in ${stepText(result.path.length - 1)}. ` +
        `looked at ${engine.stats.fetched} players, made ${engine.stats.apiCalls} requests` +
        (engine.stats.cached ? `, ${engine.stats.cached} from cache` : "") + ".");
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
      document.querySelector(".graph-section").scrollIntoView({ behavior: "smooth" });
    } catch (e) {
      console.error(e);
      showStatus("error", `something went wrong: ${esc(e.message)}`);
    } finally {
      btn.disabled = false;
      const est = await cache.estimate();
      if (est) {
        const info = $("#cache-info");
        info.hidden = false;
        info.textContent =
          `saved ${(est.usage / 1048576).toFixed(1)} MB of game data locally ` +
          `(of ${(est.quota / 1048576).toFixed(0)} MB available)`;
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
    };
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
  const LS_DEPTH_KEY = "chess-connections:depth";

  function openSettings() {
    const modal = $("#settings-modal");
    modal.hidden = false;
    // populate fields from current state / storage
    $("#setting-username").value = localStorage.getItem(LS_KEY) || "";
    const savedDepth = localStorage.getItem(LS_DEPTH_KEY) || $("#search-depth").value;
    $("#setting-depth").value = savedDepth;
    refreshCacheSize();
  }
  function closeSettings() {
    $("#settings-modal").hidden = true;
  }
  async function refreshCacheSize() {
    const el = $("#setting-cache-size");
    const cache = new window.GameCache();
    const est = await cache.estimate();
    if (est && est.usage) {
      el.textContent = `${(est.usage / 1048576).toFixed(1)} MB stored`;
    } else {
      el.textContent = "nothing stored yet";
    }
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
    if (e.key === "Escape" && !$("#settings-modal").hidden) closeSettings();
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
  // persist default depth
  $("#setting-depth").addEventListener("change", (e) => {
    localStorage.setItem(LS_DEPTH_KEY, e.target.value);
    $("#search-depth").value = e.target.value;
  });
  // clear cache button
  $("#setting-clear-cache").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "clearing…";
    try {
      const cache = new window.GameCache();
      await cache.clear();
      btn.textContent = "cleared ✓";
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

  $("#search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const depth = parseInt($("#search-depth").value, 10) || 3;
    runSearch($("#search-start").value, $("#search-target").value, depth, $("#search-range").value);
  });

  document.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      $("#search-target").value = chip.dataset.target;
      setActiveChip(chip.dataset.target);
      if ($("#search-start").value) {
        $("#search-form").requestSubmit();
      } else {
        $("#search-start").focus();
      }
    });
  });

  $("#search-target").addEventListener("input", (e) => {
    setActiveChip(e.target.value.trim().toLowerCase());
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
    const savedDepth = localStorage.getItem(LS_DEPTH_KEY);
    if (savedDepth) $("#search-depth").value = savedDepth;
    const migratedRange = localStorage.getItem(LS_RANGE_MIGRATION_KEY);
    const savedRange = migratedRange ? localStorage.getItem(LS_RANGE_KEY) : "instant";
    if (savedRange && $("#search-range").querySelector(`option[value="${savedRange}"]`)) {
      $("#search-range").value = savedRange;
    }
    if (!migratedRange) {
      localStorage.setItem(LS_RANGE_KEY, "instant");
      localStorage.setItem(LS_RANGE_MIGRATION_KEY, "1");
    }
    loadShowcase();
    // load the global leaderboard in the background
    if (window.Leaderboard) window.Leaderboard.load();
  });
})();
