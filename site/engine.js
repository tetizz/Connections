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
          // rate limited — back off then try again
          const wait = 1000 * Math.pow(2, attempt);
          this.log(`chess.com is busy, waiting ${Math.round(wait/1000)}s before retrying…`);
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
        this.log(`(already had ${u}'s games saved)`);
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
   * Bidirectional BFS shortest beaten-chain from `start` to `target`.
   *
   * Forward search (from `start`): follows "X beat Y" edges.
   * Backward search (from `target`): follows "Y beat target-side" edges,
   *   i.e. expands the set of players that can reach the target.
   *
   * Each iteration we expand whichever frontier is SMALLER, so we do the
   * least API work. The two searches meet when a node appears in both.
   *
   * @returns { path, hops } or null.
   */
  async findChain(start, target, maxDepth = 4) {
    start = start.toLowerCase(); target = target.toLowerCase();
    this.stats = { fetched: 0, apiCalls: 0, cached: 0, depth: 0 };

    // ---- load the two anchor players ----
    this.log(`reading ${start}'s games…`);
    await Promise.all([ this.edges(start), this.edges(target) ]);

    // FORWARD state: nodes reachable from `start` via "beat" edges.
    //   forwardVisited: node -> { prev, hopUrl }  (how we got here)
    //   forwardFrontier: nodes whose "beatenByMe" we haven't expanded yet
    const forwardVisited = new Map();
    forwardVisited.set(start, { prev: null, hopUrl: null });
    const forwardFrontier = [start];

    // BACKWARD state: nodes that can REACH `target` via "beat" edges
    //   (i.e. "X beat ... beat target").
    //   backwardVisited: node -> { next, hopUrl }
    //   backwardFrontier: nodes whose "beatMe" we haven't expanded yet
    const backwardVisited = new Map();
    backwardVisited.set(target, { next: null, hopUrl: null });
    const backwardFrontier = [target];

    const totalVisited = () => forwardVisited.size + backwardVisited.size;

    for (let depth = 0; depth < maxDepth; depth++) {
      this.stats.depth = depth;

      // ---- expand the SMALLER frontier each iteration ----
      const expandForward = forwardFrontier.length <= backwardFrontier.length;
      const side = expandForward ? "forward" : "backward";
      const frontier = expandForward ? forwardFrontier : backwardFrontier;
      this.log(`step ${depth + 1}: looking through ${frontier.length} player's games ` +
               `(checked ${totalVisited()} so far)`);

      if (frontier.length === 0) {
        this.log(`ran out of players to check — no connection exists.`);
        break;
      }

      // expand this frontier's nodes, watching for a meeting point
      const nextFrontier = [];
      let meeting = null;  // details of where the two searches meet

      let idx = 0;
      const expandOne = async () => {
        while (!meeting && idx < frontier.length) {
          const node = frontier[idx++];
          if (expandForward) {
            // forward: node beat these players
            const { beatenByMe } = await this.edges(node);
            for (const [opp, urls] of beatenByMe) {
              if (forwardVisited.has(opp)) continue;
              // meeting? opp already reaches target backward
              if (backwardVisited.has(opp)) {
                // record the forward link that completes the meeting
                forwardVisited.set(opp, { prev: node, hopUrl: urls[0] });
                meeting = { node: opp };
                return;
              }
              forwardVisited.set(opp, { prev: node, hopUrl: urls[0] });
              nextFrontier.push(opp);
            }
          } else {
            // backward: who beat `node`? those players can reach target via node
            const { beatMe } = await this.edges(node);
            for (const [opp, urls] of beatMe) {
              if (backwardVisited.has(opp)) continue;
              // meeting? opp already reached from start forward
              if (forwardVisited.has(opp)) {
                // record the backward link that completes the meeting
                backwardVisited.set(opp, { next: node, hopUrl: urls[0] });
                meeting = { node: opp };
                return;
              }
              backwardVisited.set(opp, { next: node, hopUrl: urls[0] });
              nextFrontier.push(opp);
            }
          }
        }
      };
      await Promise.all(Array.from({ length: 4 }, expandOne));

      // report progress roughly every ~50 nodes
      this.log(`checked ${frontier.length} more players — ${totalVisited()} total, ${this.stats.apiCalls} requests so far`);

      if (meeting) {
        const result = this.reconstructPath(
          meeting, forwardVisited, backwardVisited);
        this.log(`✓ found a connection! ${result.path.length - 1} steps long ` +
                 `(looked at ${totalVisited()} players, ${this.stats.apiCalls} requests)`);
        return result;
      }

      // replace the expanded frontier
      if (expandForward) {
        forwardFrontier.length = 0;
        forwardFrontier.push(...nextFrontier);
      } else {
        backwardFrontier.length = 0;
        backwardFrontier.push(...nextFrontier);
      }
    }
    this.log(`no connection found within ${maxDepth} steps. ` +
             `(looked through ${totalVisited()} players in total)`);
    return null;
  }

  /** Reconstruct the full path + hops from a bidirectional meeting point. */
  reconstructPath(meeting, forwardVisited, backwardVisited) {
    const mid = meeting.node;
    // forward half: start -> ... -> mid
    const fwdHops = [];
    let cur = mid;
    while (forwardVisited.get(cur) && forwardVisited.get(cur).prev) {
      const info = forwardVisited.get(cur);
      fwdHops.unshift({ from: info.prev, to: cur, url: info.hopUrl });
      cur = info.prev;
    }
    // backward half: mid -> ... -> target
    const bwdHops = [];
    cur = mid;
    while (backwardVisited.get(cur) && backwardVisited.get(cur).next) {
      const info = backwardVisited.get(cur);
      bwdHops.push({ from: cur, to: info.next, url: info.hopUrl });
      cur = info.next;
    }
    const hops = [...fwdHops, ...bwdHops];
    const path = hops.length ? [hops[0].from, ...hops.map(h => h.to)] : [mid];
    return { path, hops };
  }
};
