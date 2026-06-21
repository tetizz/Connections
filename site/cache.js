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
    const db = await this._dbPromise;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.store, "readonly");
      const req = tx.objectStore(this.store).get(username.toLowerCase());
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
    try {
      const db = await this._dbPromise;
      await new Promise((resolve, reject) => {
        const tx = db.transaction(this.store, "readwrite");
        tx.objectStore(this.store).put(
          { games, ts: Date.now() }, username.toLowerCase()
        );
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      // quota errors etc. — fail silently, cache is best-effort
      console.warn("cache write failed:", e.message);
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
