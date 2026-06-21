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
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);

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
        "Showcase data not available yet — try the search above!";
      return;
    }
    renderShowcaseTabs();
    // auto-load the first chain so the page isn't empty
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

  // ---------- graph ----------
  function renderGraph(chain) {
    const svg = $("#graph");
    svg.innerHTML = "";

    const defs = el("defs");
    const grad = el("linearGradient", { id: "edge-grad", x1: "0", y1: "0", x2: "1", y2: "0" });
    grad.appendChild(el("stop", { offset: "0%", "stop-color": "#4be3c4" }));
    grad.appendChild(el("stop", { offset: "50%", "stop-color": "#ffd479" }));
    grad.appendChild(el("stop", { offset: "100%", "stop-color": "#c084fc" }));
    defs.appendChild(grad);
    const clip = el("clipPath", { id: "clip" });
    clip.appendChild(el("circle", { r: 30, cx: 0, cy: 0 }));
    defs.appendChild(clip);
    svg.appendChild(defs);

    if (!chain.found) {
      const t = el("text", {
        x: 500, y: 160, "text-anchor": "middle",
        fill: "#9aa0b4", "font-size": "18", "font-family": "Inter, sans-serif",
      });
      t.textContent = `No chain to ${chain.display || chain.target} within ${state.chains?.max_depth || 4} hops.`;
      svg.appendChild(t);
      $("#graph-hint").textContent =
        "Try a different target, or a start player with a longer game history.";
      return;
    }

    const nodes = chain.path;
    const n = nodes.length;
    const PAD = 90, W = 1000;
    const usable = W - PAD * 2;
    const stepX = n > 1 ? usable / (n - 1) : 0;
    const y = 150;
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
      g.appendChild(el("circle", { class: "node__pulse", r: 34 }));
      g.appendChild(el("circle", { class: "node__ring", r: 30 }));

      const av = avatarOf(u);
      if (av) {
        const img = el("image", {
          class: "node__img", href: av,
          x: -30, y: -30, width: 60, height: 60,
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

    const traveller = el("text", { class: "traveller", x: positions[0].x, y: positions[0].y });
    traveller.textContent = "♞";
    svg.appendChild(traveller);

    $("#graph-hint").textContent =
      `Each link is a real recorded win in a live game. ${n - 1} hop${n - 1 === 1 ? "" : "s"} total.`;

    animateGraph(svg, positions, traveller);
  }

  const pieceFor = (isStart, isTarget) => (isTarget ? "♚" : "♟");

  // ---------- animations ----------
  async function animateGraph(svg, positions, traveller) {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    svg.querySelectorAll(".edge-line").forEach((p) => {
      const len = p.getTotalLength();
      p.style.strokeDasharray = len;
      p.style.strokeDashoffset = len;
      p.style.transition = "none";
    });
    svg.querySelectorAll(".node").forEach((node) => {
      node.style.opacity = 0;
      node.style.transform = node.getAttribute("transform") + " scale(0.4)";
      node.style.transformOrigin = "center";
      node.style.transition = "none";
    });
    svg.querySelectorAll(".edge-glow").forEach((p) => (p.style.opacity = 0));
    traveller.style.opacity = 0;

    if (reduced) {
      svg.querySelectorAll(".edge-line").forEach((p) => (p.style.strokeDashoffset = 0));
      svg.querySelectorAll(".edge-glow").forEach((p) => (p.style.opacity = 0.18));
      svg.querySelectorAll(".node").forEach((node) => {
        node.style.opacity = 1;
        node.style.transform = node.getAttribute("transform");
      });
      return;
    }

    const nodes = svg.querySelectorAll(".node");
    const lines = svg.querySelectorAll(".edge-line");
    const glows = svg.querySelectorAll(".edge-glow");

    await revealNode(nodes[0]);
    await pulse(nodes[0]);
    for (let i = 0; i < lines.length; i++) {
      glows[i].style.transition = "opacity .4s ease";
      glows[i].style.opacity = 0.18;
      lines[i].style.transition = "stroke-dashoffset .6s ease";
      lines[i].style.strokeDashoffset = 0;
      await sleep(600);
      await slideTraveller(traveller, positions[i], positions[i + 1]);
      await revealNode(nodes[i + 1]);
      await pulse(nodes[i + 1]);
    }
    traveller.style.transition = "opacity .3s";
    traveller.style.opacity = 0;
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

  function slideTraveller(traveller, from, to) {
    return new Promise((resolve) => {
      const dur = 650, start = performance.now();
      const midX = (from.x + to.x) / 2;
      const peakY = Math.min(from.y, to.y) - 28;
      function frame(now) {
        const t = Math.min(1, (now - start) / dur);
        const e = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        const x = (1 - e) ** 2 * from.x + 2 * (1 - e) * e * midX + e ** 2 * to.x;
        const y = (1 - e) ** 2 * from.y + 2 * (1 - e) * e * peakY + e ** 2 * to.y;
        traveller.setAttribute("x", x);
        traveller.setAttribute("y", y);
        traveller.style.opacity = 1;
        if (t < 1) requestAnimationFrame(frame);
        else resolve();
      }
      requestAnimationFrame(frame);
    });
  }

  // ---------- hop cards ----------
  function renderCards(chain) {
    const wrap = $("#cards");
    wrap.innerHTML = "";
    if (!chain.found) {
      wrap.innerHTML = `<p style="color:var(--text-faint)">No chain found for ${esc(chain.display || chain.target)}.</p>`;
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
      sub.textContent = `Hop ${i + 1} of ${chain.hops.length}`;
      body.appendChild(sub);

      const proof = document.createElement("a");
      proof.className = "card__proof";
      proof.href = hop.url;
      proof.target = "_blank";
      proof.rel = "noopener";
      proof.innerHTML = `View game <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path d="M14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3z" fill="currentColor"/></svg>`;

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
  async function runSearch(startRaw, targetRaw, depth) {
    const start = startRaw.trim().toLowerCase();
    const target = targetRaw.trim().toLowerCase();
    const status = $("#search-status");
    const logEl = $("#search-log");
    const btn = $(".search__btn");

    if (!start || !target) {
      showStatus("error", "Enter both your username and a target.");
      return;
    }
    if (start === target) {
      showStatus("error", "Start and target must be different players.");
      return;
    }

    // save the username for next time
    localStorage.setItem(LS_KEY, start);

    btn.disabled = true;
    status.hidden = false;
    status.className = "search__status is-working";
    logEl.hidden = false;
    logEl.innerHTML = "";

    const cache = new window.GameCache();
    const engine = new window.ChessChain(cache);

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
    engine.onProgress = (msg, stats) => {
      // status line: current action + counters
      status.innerHTML =
        `<span class="spinner"></span>${esc(msg)}` +
        `<span class="counters">scanned <b>${stats.fetched}</b> users · ` +
        `${stats.apiCalls} API calls · ${stats.cached} cached</span>`;
      // log significant events
      if (msg.startsWith("Depth") || msg.includes("Found") ||
          msg.includes("beaten") || msg.includes("have beaten") ||
          msg.startsWith("Loading") || msg.includes("Rate limited")) {
        if (msg !== lastScanMsg) {
          lastScanMsg = msg;
          logLine(`[${new Date().toLocaleTimeString()}] ${msg}  ` +
            `(scanned ${stats.fetched} users total)`);
        }
      }
    };
    showStatus("working", "Starting search…");
    logLine(`Searching: ${start} → ${target}  (max depth ${depth})`);

    try {
      // validate both players exist + grab their meta for nicer rendering
      const [startMeta, targetMeta] = await Promise.all([
        engine.fetchJSON(engine.API + start).catch(() => null),
        engine.fetchJSON(engine.API + target).catch(() => null),
      ]);
      if (!startMeta) {
        showStatus("error", `Player "${esc(start)}" not found on Chess.com.`);
        return;
      }
      if (!targetMeta) {
        showStatus("error", `Target "${esc(target)}" not found on Chess.com.`);
        return;
      }
      state.players = state.players || {};
      state.players[start] = metaShape(startMeta);
      state.players[target] = metaShape(targetMeta);

      showStatus("working", "Searching game histories…");
      const result = await engine.findChain(start, target, depth);

      if (!result) {
        showStatus("error",
          `No chain found within ${depth} hops. ` +
          `${esc(target)} may have very few recorded losses. ` +
          `(scanned ${engine.stats.fetched} users)`);
        renderChain({
          target, display: targetMeta.name || target,
          found: false, length: null, path: [], hops: [],
        });
        return;
      }

      // fetch avatars/titles for the intermediate hops
      const intermediates = result.path.slice(1, -1);
      await Promise.all(intermediates.map(async (u) => {
        if (state.players[u]) return;
        const m = await engine.fetchJSON(engine.API + u).catch(() => null);
        if (m) state.players[u] = metaShape(m);
      }));

      showStatus("done",
        `✓ Found! ${esc(start)} → ${esc(target)} in ${result.path.length - 1} hops. ` +
        `Scanned ${engine.stats.fetched} users, ` +
        `${engine.stats.apiCalls} API calls, ${engine.stats.cached} cached.`);

      renderChain({
        target,
        display: targetMeta.name || target,
        found: true,
        length: result.path.length - 1,
        path: result.path,
        hops: result.hops,
      });
      document.querySelector(".graph-section").scrollIntoView({ behavior: "smooth" });
    } catch (e) {
      console.error(e);
      showStatus("error", `Search failed: ${esc(e.message)}`);
    } finally {
      btn.disabled = false;
      // show cache usage info
      const est = await cache.estimate();
      if (est) {
        const info = $("#cache-info");
        info.hidden = false;
        info.textContent =
          `📦 Cache: ${(est.usage / 1048576).toFixed(1)} MB used / ` +
          `${(est.quota / 1048576).toFixed(0)} MB available`;
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

  // ---------- starfield ----------
  function starfield() {
    const canvas = $("#stars");
    const ctx = canvas.getContext("2d");
    let stars = [], raf;
    function resize() {
      canvas.width = innerWidth * devicePixelRatio;
      canvas.height = innerHeight * devicePixelRatio;
      canvas.style.width = innerWidth + "px";
      canvas.style.height = innerHeight + "px";
      const count = Math.min(120, Math.floor(innerWidth / 12));
      stars = Array.from({ length: count }, () => ({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        r: Math.random() * 1.4 + 0.3,
        a: Math.random(),
        s: Math.random() * 0.02 + 0.005,
        c: Math.random() > 0.85 ? "#ffd479" : Math.random() > 0.7 ? "#4be3c4" : "#ffffff",
      }));
    }
    function tick() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const st of stars) {
        st.a += st.s;
        const alpha = (Math.sin(st.a) + 1) / 2 * 0.7 + 0.1;
        ctx.beginPath();
        ctx.arc(st.x, st.y, st.r * devicePixelRatio, 0, Math.PI * 2);
        ctx.fillStyle = st.c;
        ctx.globalAlpha = alpha;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(tick);
    }
    resize();
    addEventListener("resize", () => { cancelAnimationFrame(raf); resize(); tick(); });
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) tick();
  }

  // ---------- wire up ----------
  $("#replay").addEventListener("click", () => {
    const svg = $("#graph");
    const positions = Array.from(svg.querySelectorAll(".node")).map((n) => {
      const t = n.getAttribute("transform").match(/translate\(([\d.]+),\s*([\d.]+)\)/);
      return { x: +t[1], y: +t[2] };
    });
    const traveller = svg.querySelector(".traveller");
    if (positions.length && traveller) animateGraph(svg, positions, traveller);
  });

  $("#search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const depth = parseInt($("#search-depth").value, 10) || 4;
    runSearch($("#search-start").value, $("#search-target").value, depth);
  });

  document.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      $("#search-target").value = chip.dataset.target;
      if ($("#search-start").value) {
        $("#search-form").requestSubmit();
      } else {
        $("#search-start").focus();
      }
    });
  });

  document.addEventListener("DOMContentLoaded", () => {
    starfield();
    // restore saved username
    const saved = localStorage.getItem(LS_KEY);
    if (saved) $("#search-start").value = saved;
    loadShowcase();
  });
})();
