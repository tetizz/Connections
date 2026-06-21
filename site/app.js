/* ============================================================
   Chess Connections — app.js
   Loads precomputed data, renders the animated node graph,
   draws the connecting path, and animates a chess piece
   travelling along it. Vanilla JS, no build step.
   ============================================================ */

(() => {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const DATA_BASE = (() => {
    // works both locally (data/ next to index) and on Pages (data/ copied in)
    const p = new URL("./data/", document.baseURI).href;
    return p;
  })();

  const state = {
    chains: null,
    players: null,
    activeTarget: null,
  };

  // ---------- utilities ----------
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
  const titleOf = (u) => (state.players?.[u.toLowerCase()]?.title) || null;
  const nameOf = (u) => {
    const p = state.players?.[u.toLowerCase()];
    return p?.name || p?.username || u;
  };
  const avatarOf = (u) => state.players?.[u.toLowerCase()]?.avatar || null;

  // ---------- data load ----------
  async function load() {
    try {
      const [chainsRes, playersRes] = await Promise.all([
        fetch(DATA_BASE + "chains.json"),
        fetch(DATA_BASE + "players.json"),
      ]);
      if (!chainsRes.ok) throw new Error("chains.json " + chainsRes.status);
      state.chains = await chainsRes.json();
      state.players = playersRes.ok ? await playersRes.json() : {};
    } catch (e) {
      $("#graph-hint").textContent =
        "Couldn't load data yet. The first GitHub Action run generates it.";
      console.error(e);
      return;
    }
    renderTabs();
  }

  // ---------- tabs ----------
  function renderTabs() {
    const tabs = $("#tabs");
    tabs.innerHTML = "";
    $("#start-name").textContent =
      state.chains.start_display || state.chains.start;

    for (const chain of state.chains.chains) {
      const btn = document.createElement("button");
      btn.className = "tab";
      if (!chain.found) btn.classList.add("missing");
      btn.type = "button";
      btn.dataset.target = chain.target;

      const title = titleOf(chain.target);
      const label = document.createElement("span");
      label.textContent = chain.display || nameOf(chain.target);
      btn.appendChild(label);
      if (title) {
        const tag = document.createElement("span");
        tag.className = "tab__title";
        tag.textContent = title;
        btn.appendChild(tag);
      }
      btn.addEventListener("click", () => selectTarget(chain.target));
      tabs.appendChild(btn);
    }
    // pick first found chain, else first
    const firstFound = state.chains.chains.find((c) => c.found)
      || state.chains.chains[0];
    if (firstFound) selectTarget(firstFound.target);
  }

  function selectTarget(target) {
    state.activeTarget = target;
    document.querySelectorAll(".tab").forEach((t) =>
      t.classList.toggle("active", t.dataset.target === target)
    );
    const chain = state.chains.chains.find((c) => c.target === target);
    renderGraph(chain);
    renderCards(chain);
    $("#target-name").textContent = chain.display || nameOf(target);
    $("#chain-length").textContent = chain.found ? chain.length : "—";
  }

  // ---------- graph rendering ----------
  function renderGraph(chain) {
    const svg = $("#graph");
    svg.innerHTML = "";

    // defs: gradient for the edge + clip for circular avatars
    const defs = el("defs");
    const grad = el("linearGradient", { id: "edge-grad", x1: "0", y1: "0", x2: "1", y2: "0" });
    grad.appendChild(el("stop", { offset: "0%",   "stop-color": "#4be3c4" }));
    grad.appendChild(el("stop", { offset: "50%",  "stop-color": "#ffd479" }));
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
      t.textContent = `No chain to ${chain.display || chain.target} within ${state.chains.max_depth} hops.`;
      svg.appendChild(t);
      $("#graph-hint").textContent = "Try another grandmaster, or raise max_depth in config.yml.";
      return;
    }

    const nodes = chain.path; // usernames
    const n = nodes.length;
    const PAD = 90;
    const W = 1000;
    const usable = W - PAD * 2;
    const stepX = n > 1 ? usable / (n - 1) : 0;
    const y = 150;
    const positions = nodes.map((_, i) => ({ x: PAD + stepX * i, y }));

    // edges first (so nodes sit on top)
    const edgesGroup = el("g");
    const pathPts = [];
    for (let i = 0; i < n - 1; i++) {
      const a = positions[i], b = positions[i + 1];
      // gentle curve up then down for visual interest
      const midX = (a.x + b.x) / 2;
      const d = `M ${a.x} ${a.y} Q ${midX} ${a.y - 28} ${b.x} ${b.y}`;
      pathPts.push(d);
      edgesGroup.appendChild(el("path", { class: "edge-glow", d }));
      edgesGroup.appendChild(el("path", { class: "edge-line", d }));
    }
    svg.appendChild(edgesGroup);

    // nodes
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
          class: "node__img",
          href: av,
          x: -30, y: -30, width: 60, height: 60,
          "clip-path": "url(#clip)",
          preserveAspectRatio: "xMidYMid slice",
        });
        // fallback to a piece glyph if the avatar fails to load
        img.addEventListener("error", () => {
          const fb = el("text", { class: "node__icon", x: 0, y: 0 });
          fb.textContent = pieceFor(isStart, isTarget);
          g.replaceChild(fb, img);
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

    // traveller chess piece that rides along the path
    const traveller = el("text", { class: "traveller", x: positions[0].x, y: positions[0].y });
    traveller.textContent = "♟";
    svg.appendChild(traveller);

    $("#graph-hint").textContent =
      `Each link is a real recorded win in a live game. ${n - 1} hop${n - 1 === 1 ? "" : "s"} total.`;

    animateGraph(svg, positions, traveller);
  }

  function pieceFor(isStart, isTarget) {
    if (isTarget) return "♚";
    if (isStart) return "♟";
    return "♟";
  }

  // ---------- animations ----------
  async function animateGraph(svg, positions, traveller) {
    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // reset
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

    if (prefersReduced) {
      // show everything immediately
      svg.querySelectorAll(".edge-line").forEach((p) => (p.style.strokeDashoffset = 0));
      svg.querySelectorAll(".edge-glow").forEach((p) => (p.style.opacity = 0.18));
      svg.querySelectorAll(".node").forEach((node) => {
        node.style.opacity = 1;
        node.style.transform = node.getAttribute("transform");
      });
      return;
    }

    // animate each edge + node sequentially
    const nodes = svg.querySelectorAll(".node");
    const lines = svg.querySelectorAll(".edge-line");
    const glows = svg.querySelectorAll(".edge-glow");

    // first node appears
    await revealNode(nodes[0], 0);
    await pulse(nodes[0]);

    for (let i = 0; i < lines.length; i++) {
      // draw the edge
      glows[i].style.transition = "opacity .4s ease";
      glows[i].style.opacity = 0.18;
      lines[i].style.transition = "stroke-dashoffset .6s ease";
      lines[i].style.strokeDashoffset = 0;
      await sleep(600);

      // traveller slides along this edge
      await slideTraveller(traveller, positions[i], positions[i + 1]);

      // next node pops in + pulses
      await revealNode(nodes[i + 1], 0);
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
      // force reflow
      void ring.getBoundingClientRect();
      ring.style.transition = "r .7s ease-out, opacity .7s ease-out";
      ring.setAttribute("r", 52);
      ring.style.opacity = 0;
      setTimeout(resolve, 700);
    });
  }

  function slideTraveller(traveller, from, to) {
    return new Promise((resolve) => {
      const dur = 650;
      const start = performance.now();
      const midX = (from.x + to.x) / 2;
      const peakY = Math.min(from.y, to.y) - 28;
      function frame(now) {
        const t = Math.min(1, (now - start) / dur);
        const ease = t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        // quadratic bezier between from -> (midX, peakY) -> to
        const x = (1 - ease) ** 2 * from.x + 2 * (1 - ease) * ease * midX + ease ** 2 * to.x;
        const y = (1 - ease) ** 2 * from.y + 2 * (1 - ease) * ease * peakY + ease ** 2 * to.y;
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
      wrap.innerHTML = `<p style="color:var(--text-faint)">No chain found for ${chain.display || chain.target}.</p>`;
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
      const winnerTitle = titleOf(hop.from);
      const loserTitle = titleOf(hop.to);
      line.innerHTML =
        (winnerTitle ? `<span class="card__title-tag">${esc(winnerTitle)}</span>` : "") +
        `<span class="winner">${esc(nameOf(hop.from))}</span>` +
        ` beat ` +
        (loserTitle ? `<span class="card__title-tag">${esc(loserTitle)}</span>` : "") +
        `<span class="loser">${esc(nameOf(hop.to))}</span>`;
      body.appendChild(line);

      const sub = document.createElement("div");
      sub.className = "card__sub";
      sub.textContent = `Hop ${i + 1} of ${chain.hops.length} · proof game`;
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

    // reveal on scroll
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e, idx) => {
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
    const u = username.toLowerCase();
    const av = avatarOf(u);
    const title = titleOf(u);
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

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);

  // ---------- starfield ----------
  function starfield() {
    const canvas = $("#stars");
    const ctx = canvas.getContext("2d");
    let stars = [];
    let raf;
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
    const chain = state.chains.chains.find((c) => c.target === state.activeTarget);
    if (chain) {
      const svg = $("#graph");
      const positions = Array.from(svg.querySelectorAll(".node")).map((n) => {
        const t = n.getAttribute("transform").match(/translate\(([\d.]+),\s*([\d.]+)\)/);
        return { x: +t[1], y: +t[2] };
      });
      const traveller = svg.querySelector(".traveller");
      if (positions.length && traveller) animateGraph(svg, positions, traveller);
    }
  });

  document.addEventListener("DOMContentLoaded", () => {
    starfield();
    load();
  });
})();
