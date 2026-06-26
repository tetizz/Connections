/* ============================================================
   cache.js — Cloudflare-backed game cache
   ------------------------------------------------------------
   The browser no longer stores game histories in IndexedDB.
   Game history cache reads go through the shared Cloudflare Worker,
   which fills KV from Chess.com when a key is missing or stale.
   ============================================================ */

window.GameCache = class GameCache {
  constructor() {
    this.remoteBase = String(window.CONNECTIONS_CACHE_API || "").replace(/\/+$/, "");
    this.remoteEnabled = /^https?:\/\//.test(this.remoteBase);
  }

  async get(cacheKey) {
    if (!this.remoteEnabled) return null;
    return this._remoteGet(String(cacheKey || "").toLowerCase());
  }

  async set() {
    // Cloudflare fills the shared cache during GET /games. Do not persist
    // large game histories in the browser.
  }

  async clear() {
    // Browser game-history cache is intentionally disabled.
  }

  async estimate() {
    return {
      remote: this.remoteEnabled,
      usage: 0,
      quota: 0,
    };
  }

  async _remoteGet(key) {
    if (!key) return null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
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
      console.warn("game data read failed:", e.message);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
};
