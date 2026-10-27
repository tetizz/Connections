// Share only the raw provider response. Each search still validates and builds
// its own archive coverage, proof collectors, adjacency and durable checkpoint.
const pools = new WeakMap();
const MAX_ACTIVE_FILLS = 128;
const MAX_RECENT_BYTES = 4 * 1024 * 1024;
const MAX_RECENT_RESPONSE_BYTES = 1024 * 1024;
const RECENT_WINDOW_MS = 2000;
const recent = new Map();
let activeFills = 0;
let recentBytes = 0;

function dropRecent(entry) {
  const record = recent.get(entry);
  if (!record) return;
  recent.delete(entry);
  recentBytes -= record.bytes;
  entry.retainUntil = 0;
  if (record.pool.get(record.key) === entry) record.pool.delete(record.key);
}

function pruneRecent() {
  const now = Date.now();
  for (const [entry, record] of recent) {
    if (record.until <= now) dropRecent(entry);
  }
}

function retainBriefly(entry, pool, key, value) {
  // A prefetched KV miss can outlive the first caller's response processing.
  // Bridge only that short gap, never the provider's original freshness bound.
  const now = Date.now(), observedAt = Number(value?.observedAt);
  const reuseUntil = Number(value?.reuseUntil);
  const until = Math.min(reuseUntil, observedAt + RECENT_WINDOW_MS);
  if (!Number.isFinite(observedAt) || observedAt > now || !Number.isFinite(until) || until <= now) return;
  let bytes;
  try {
    const json = JSON.stringify(value);
    if (typeof json !== 'string' || json.length > MAX_RECENT_RESPONSE_BYTES) return;
    bytes = new TextEncoder().encode(json).byteLength;
  } catch { return; }
  if (bytes > MAX_RECENT_RESPONSE_BYTES) return;
  pruneRecent();
  while (recent.size && (recentBytes + bytes > MAX_RECENT_BYTES || recent.size >= MAX_ACTIVE_FILLS)) {
    dropRecent(recent.keys().next().value);
  }
  entry.retainUntil = until;
  recent.set(entry, { pool, key, bytes, until });
  recentBytes += bytes;
}

function aborted(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('Archive subscriber cancelled', 'AbortError');
}

function ownershipError(error) {
  return /Cannot perform I\/O on behalf of a different (?:request|Durable Object)/.test(String(error?.message || ''));
}

function independent(fill, signal) {
  if (signal?.aborted) return Promise.reject(aborted(signal));
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = () => {
      if (done) return false;
      done = true;
      signal?.removeEventListener('abort', onAbort);
      return true;
    };
    const onAbort = () => { if (finish()) reject(aborted(signal)); };
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => {
      if (signal?.aborted) throw aborted(signal);
      return fill(signal);
    }).then(value => {
      if (!finish()) return;
      try { resolve(structuredClone(value)); } catch (error) { reject(error); }
    }, error => { if (finish()) reject(error); });
  });
}

/**
 * Coalesce in-flight JSON fetches for one KV binding and exact provider URL.
 * fill(signal) returns a cloneable envelope containing data and the original
 * response's observedAt/reuseUntil. Never recompute freshness on subscriber delivery.
 * Cancellation detaches one subscriber; the provider request is cancelled only
 * when no subscribers remain. Small completed envelopes may bridge a prefetched
 * KV miss for at most two seconds, with a four-MiB total retained-data bound.
 */
export function shareArchiveFetch(binding, key, fill, { signal = null, reuseCompleted = true } = {}) {
  if (signal?.aborted) return Promise.reject(aborted(signal));
  if (!binding || !['object', 'function'].includes(typeof binding)) {
    return independent(fill, signal);
  }
  pruneRecent();
  let pool = pools.get(binding);
  if (!pool) { pool = new Map(); pools.set(binding, pool); }
  let entry = pool.get(key);
  // Workerd associates AbortControllers and pending I/O with their originating
  // request/DO. Completed cache entries are plain data and must never touch
  // the originating controller or promise from another invocation.
  if (entry?.settled) {
    if (reuseCompleted && entry.value !== undefined) return independent(() => entry.value, signal);
    dropRecent(entry);pool.delete(key);entry = null;
  }
  if (entry) {
    try { if (entry.controller.signal.aborted) { pool.delete(key);entry = null; } }
    catch (error) {
      if (!ownershipError(error)) throw error;
      // Decline cross-context sharing; never turn a local optimization into
      // an upstream failure or cancel the other request's provider operation.
      pool.delete(key);entry = null;
    }
  }
  if (!entry) {
    if (activeFills >= MAX_ACTIVE_FILLS) return independent(fill, signal);
    entry = { controller: new AbortController(), subscribers: new Set(), settled: false };
    pool.set(key, entry);
    activeFills++;
    const owned = entry;
    owned.promise = Promise.resolve().then(() => {
      if (owned.controller.signal.aborted) throw aborted(owned.controller.signal);
      return fill(owned.controller.signal);
    }).then(value => {
      owned.settled = true;
      retainBriefly(owned, pool, key, value);
      if (owned.retainUntil) owned.value = value;
      owned.controller = null;
      return value;
    }, error => {
      owned.settled = true;owned.controller = null;throw error;
    }).finally(() => {
      if (!owned.retainUntil && pool.get(key) === owned) pool.delete(key);
      activeFills--;
    });
    // A final subscriber may cancel before an aborted transport rejects.
    owned.promise.catch(() => {});
  }
  const owned = entry;
  return new Promise((resolve, reject) => {
    const subscriber = {};
    let done = false;
    const detach = () => {
      if (done) return false;
      done = true;
      signal?.removeEventListener('abort', onAbort);
      owned.subscribers.delete(subscriber);
      return true;
    };
    const onAbort = () => {
      if (!detach()) return;
      reject(aborted(signal));
      if (!owned.settled && !owned.subscribers.size) {
        if (pool.get(key) === owned) pool.delete(key);
        owned.controller.abort(new DOMException('All archive subscribers cancelled', 'AbortError'));
      }
    };
    owned.subscribers.add(subscriber);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    try {
      owned.promise.then(value => {
        if (!detach()) return;
        try { resolve(structuredClone(value)); } catch (error) { reject(error); }
      }, error => { if (detach()) reject(error); });
    } catch (error) {if(detach())reject(error);}
  }).catch(error => {
    if (!ownershipError(error)) throw error;
    if (pool.get(key) === owned) pool.delete(key);
    return independent(fill, signal);
  });
}
