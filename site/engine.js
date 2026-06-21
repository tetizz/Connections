/* ============================================================
   engine.js — client-side Chess.com beaten-chain engine
   ------------------------------------------------------------
   Pure browser JS. Hits the public Chess.com pubapi directly
   (CORS is enabled: Access-Control-Allow-Origin: *).
   Finds the shortest chain  X -> ... -> TARGET  where each
   arrow means "beat in a live standard-chess game".
   Exposes a single ChessChain class with a progress callback.
   ============================================================ */

window.ChessChain = class ChessChain {
  constructor(cache = null) {
    this.API = "https://api.chess.com/pub/player/";
    this._gamesCache = new Map();  // username -> games[]
    this._edgesCache = new Map();  // username -> {beatenByMe, beatMe}
    this.onProgress = null;        // (msg, stats) => void
    this.stats = { fetched: 0, apiCalls: 0, cached: 0, depth: 0 };
    // global concurrency gate for all HTTP requests — keeps us under
    // Chess.com's rate limit no matter how many tasks are queued.
    this._inflight = 0;
    this._maxInflight = 3;
    this._cache = cache;           // optional GameCache (IndexedDB)
    this._lastReqTs = 0;           // throttle: min ms between request starts
    this._minSpacing = 120;        // ~8 req/sec sustained, well under the limit
  }

  /** Acquire a concurrency slot AND enforce min spacing between starts. */
  async _acquire() {
    while (this._inflight >= this._maxInflight) {
      await new Promise(r => setTimeout(r, 20));
    }
    // enforce minimum spacing between request starts
    const wait = this._lastReqTs + this._minSpacing - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    this._lastReqTs = Date.now();
    this._inflight++;
  }
  _release() { this._inflight--; }

  log(msg) {
    if (this.onProgress) this.onProgress(msg, { ...this.stats });
  }

  async fetchJSON(url) {
    this.stats.apiCalls++;
    const MAX_RETRIES = 5;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      await this._acquire();
      try {
        const res = await fetch(url, { headers: { "Accept": "application/json" } });
        if (res.status === 429) {
          // rate limited — exponential backoff then retry
          const wait = 1000 * Math.pow(2, attempt);
          this.log(`Rate limited, backing off ${wait}ms…`);
          await new Promise(r => setTimeout(r, wait));
          continue;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
        return await res.json();
      } catch (e) {
        if (attempt === MAX_RETRIES - 1) throw e;
        await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
      } finally {
        this._release();
      }
    }
    throw new Error("Max retries exceeded for " + url);
  }

  /** Run async tasks with a hard concurrency cap. Each task is also
   *  rate-limited via a shared token slot so we never exceed N starts
   *  per rolling window. */
  async runThrottled(tasks, concurrency = 3) {
    const results = new Array(tasks.length);
    let next = 0;
    const worker = async () => {
      while (next < tasks.length) {
        const i = next++;
        results[i] = await tasks[i]();
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return results;
  }

  /** All standard-chess games for a user (cached in memory + IndexedDB). */
  async getGames(username) {
    const u = username.toLowerCase();
    if (this._gamesCache.has(u)) {
      this.stats.cached++;
      return this._gamesCache.get(u);
    }
    // try persistent (IndexedDB) cache first
    if (this._cache) {
      const hit = await this._cache.get(u);
      if (hit) {
        this.stats.cached++;
        this._gamesCache.set(u, hit);
        this.log(`(cache hit) ${u}`);
        return hit;
      }
    }
    const { archives } = await this.fetchJSON(this.API + u + "/games/archives");
    const games = [];
    // fetch archives with throttling to respect rate limits
    const tasks = archives.map((a) => async () => {
      try { return await this.fetchJSON(a); }
      catch { return { games: [] }; }
    });
    const results = await this.runThrottled(tasks, 3);
    for (const data of results) {
      for (const g of data.games || []) {
        if (g.rules !== "chess") continue;  // skip variants
        games.push({
          white: (g.white?.username || "").toLowerCase(),
          black: (g.black?.username || "").toLowerCase(),
          whiteResult: g.white?.result,
          blackResult: g.black?.result,
          url: g.url,
          timeClass: g.time_class,
        });
      }
    }
    this.stats.fetched++;
    this._gamesCache.set(u, games);
    if (this._cache) await this._cache.set(u, games); // persist
    return games;
  }

  /** Edges: who `username` beat, and who beat `username` (live games only). */
  async edges(username) {
    const u = username.toLowerCase();
    if (this._edgesCache.has(u)) return this._edgesCache.get(u);
    const games = await this.getGames(u);
    const beatenByMe = new Map();  // opp -> [urls]
    const beatMe = new Map();
    for (const g of games) {
      if (g.timeClass === "daily") continue;  // no correspondence
      if (g.white === u) {
        if (g.whiteResult === "win" && g.black) {
          this._push(beatenByMe, g.black, g.url);
        } else if (g.blackResult === "win" && g.black) {
          this._push(beatMe, g.black, g.url);
        }
      } else if (g.black === u) {
        if (g.blackResult === "win" && g.white) {
          this._push(beatenByMe, g.white, g.url);
        } else if (g.whiteResult === "win" && g.white) {
          this._push(beatMe, g.white, g.url);
        }
      }
    }
    const result = { beatenByMe, beatMe };
    this._edgesCache.set(u, result);
    return result;
  }

  _push(map, key, url) {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(url);
  }

  /**
   * BFS shortest beaten-chain from `start` to `target`.
   * @returns { path, hops } or null.
   */
  async findChain(start, target, maxDepth = 4) {
    start = start.toLowerCase(); target = target.toLowerCase();
    this.stats = { fetched: 0, apiCalls: 0, cached: 0, depth: 0 };

    this.log(`Loading target ${target} (who beat them)…`);
    const { beatMe: beatTarget } = await this.edges(target);
    const beatTargetMap = beatTarget;  // opp -> [urls]
    const beatTargetSet = new Set(beatTarget.keys());
    this.log(`${beatTargetSet.size} players have beaten ${target}`);

    this.log(`Loading ${start} (who they've beaten)…`);
    const { beatenByMe: beatenStart } = await this.edges(start);
    this.log(`${beatenStart.size} players ${start} has beaten`);

    // ---- CHEAP SHORTCUTS (no extra fetches) ----
    // Depth 1: start beat target directly
    if (beatenStart.has(target)) {
      this.log(`✓ Found! Direct win: ${start} beat ${target}`);
      return {
        path: [start, target],
        hops: [{ from: start, to: target, url: beatenStart.get(target)[0] }],
      };
    }
    // Depth 2: start beat someone who beat target (already-loaded sets)
    for (const [opp, urls] of beatenStart) {
      if (beatTargetSet.has(opp)) {
        this.log(`✓ Found! Chain length 2 (via ${opp})`);
        return {
          path: [start, opp, target],
          hops: [
            { from: start, to: opp, url: urls[0] },
            { from: opp, to: target, url: beatTargetMap.get(opp)[0] },
          ],
        };
      }
    }

    // ---- BFS for depth >= 3 ----
    // frontier: array of { node, path, hops }
    let frontier = [{
      node: start, path: [start], hops: []
    }];
    const visited = new Set([start]);

    for (let depth = 0; depth < maxDepth; depth++) {
      if (frontier.length === 0) {
        this.log("No more players to explore.");
        break;
      }
      this.stats.depth = depth;
      this.log(`Depth ${depth}: expanding ${frontier.length} player(s)…`);

      // load edges for whole frontier with throttling.
      // Early-exit: as soon as ANY task finds a hit, cancel the rest.
      let found = null;
      const tasks = frontier.map((f) => async () => {
        if (found) return; // short-circuit after a hit
        const beaten = (await this.edges(f.node)).beatenByMe;
        if (found) return;
        // Pass 1 — this node beat target directly
        if (beaten.has(target)) {
          found = {
            f, beaten,
            path: [...f.path, target],
            hops: [...f.hops, { from: f.node, to: target, url: beaten.get(target)[0] }],
          };
          return;
        }
        // Pass 2 — this node beat someone who beat target
        for (const [opp, urls] of beaten) {
          if (beatTargetSet.has(opp)) {
            found = {
              f, beaten,
              path: [...f.path, opp, target],
              hops: [
                ...f.hops,
                { from: f.node, to: opp, url: urls[0] },
                { from: opp, to: target, url: beatTargetMap.get(opp)[0] },
              ],
            };
            return;
          }
        }
        // no hit — record edges for frontier expansion (Pass 3)
        return { f, beaten };
      });

      // run with a small concurrency so we can bail the moment we find
      const frontierEdges = [];
      const concurrency = 4;
      let next = 0;
      const worker = async () => {
        while (!found && next < tasks.length) {
          const i = next++;
          const r = await tasks[i]();
          if (r && r.f) frontierEdges.push(r);
          this.log(
            `${frontierEdges.length}/${frontier.length} players expanded` +
            (this.stats.cached ? ` (${this.stats.cached} cached)` : "")
          );
        }
      };
      await Promise.all(Array.from({ length: concurrency }, () => worker()));

      if (found) {
        this.log(`✓ Found! Chain length ${found.path.length - 1}`);
        return { path: found.path, hops: found.hops };
      }

      // Pass 3 — expand frontier by one 'beat' hop
      const expanded = [];
      for (const { f, beaten } of frontierEdges) {
        for (const [opp, urls] of beaten) {
          if (visited.has(opp)) continue;
          visited.add(opp);
          expanded.push({
            node: opp,
            path: [...f.path, opp],
            hops: [...f.hops, { from: f.node, to: opp, url: urls[0] }],
          });
        }
      }
      // cap to prevent runaway searches on near-unbeatable targets
      if (expanded.length > 3000) {
        this.log(`Search too large (${expanded.length} candidates) — stopping.`);
        break;
      }
      frontier = expanded;
    }
    return null;
  }
};
