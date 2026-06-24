/* ============================================================
   cache.js — IndexedDB-backed cache for player game histories
   ------------------------------------------------------------
   Persists the (often large) list of a player's standard games so
   that revisits and deeper searches don't re-fetch everything.
   Stores: key=username, value={games, ts}
   TTL: 7 days (past games don't change; new ones get added).
   ============================================================ */

window.GameCache = class GameCache {
  constructor(dbName = "chess-connections", store = "games") {
    this.dbName = dbName;
    this.store = store;
    this.ttlMs = 7 * 24 * 60 * 60 * 1000; // 7 days
    this.remoteBase = String(window.CONNECTIONS_CACHE_API || "").replace(/\/+$/, "");
    this.remoteEnabled = /^https?:\/\//.test(this.remoteBase);
    this._dbPromise = this._open();
  }

  _open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(this.store)) {
          db.createObjectStore(this.store); // key=username
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async get(username) {
    const key = username.toLowerCase();
    const remotePromise = this._remoteGet(key);
    let local = null;
    try {
      local = await this._getLocal(key);
    } catch (e) {
      console.warn("local cache read failed:", e.message);
    }
    if (local) {
      remotePromise.catch(() => null);
      return local;
    }

    const remote = await remotePromise;
    if (!remote) return null;
    await this._setLocal(key, remote);
    return remote;
  }

  async _getLocal(key) {
    const db = await this._dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.store, "readonly");
      const req = tx.objectStore(this.store).get(key);
      req.onsuccess = () => {
        const rec = req.result;
        if (!rec) return resolve(null);
        if (Date.now() - rec.ts > this.ttlMs) return resolve(null); // stale
        resolve(rec.games);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async set(username, games) {
    const key = username.toLowerCase();
    await this._setLocal(key, games);
  }

  async _setLocal(key, games) {
    try {
      const db = await this._dbPromise;
      await new Promise((resolve, reject) => {
        const tx = db.transaction(this.store, "readwrite");
        tx.objectStore(this.store).put(
          { games, ts: Date.now() }, key.toLowerCase()
        );
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      // quota errors etc. — fail silently, cache is best-effort
      console.warn("cache write failed:", e.message);
    }
  }

  async _remoteGet(key) {
    if (!this.remoteEnabled) return null;
    if (key.endsWith(":all")) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const url = `${this.remoteBase}/games?key=${encodeURIComponent(key)}`;
      const res = await fetch(url, {
        headers: { "Accept": "application/json" },
        signal: controller.signal,
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return Array.isArray(data.games) ? data.games : null;
    } catch (e) {
      console.warn("shared cache read failed:", e.message);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  async clear() {
    const db = await this._dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.store, "readwrite");
      tx.objectStore(this.store).clear();
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }

  async estimate() {
    if (navigator.storage?.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      return { usage, quota };
    }
    return null;
  }
};
