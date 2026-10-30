import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {__test as api} from '../src/index.js';

// Deterministic dependency latency, not a production throughput benchmark.
// Actual exports/handlers run with fake provider/KV I/O and virtual timer/Date
// deadlines. Native setImmediate only flushes promise work; wall time is not a
// pass criterion. Tests stay serial because fetch and timers are process-global.
const turn = () => new Promise(setImmediate);
const EPOCH = Date.UTC(2026, 9, 30);
const RATE_KEY = 'games:ratelimit:chesscom';

class Clock {
  now = 0;
  nextId = 0;
  events = new Map();
  constructor(t) {
    t.mock.method(Date, 'now', () => EPOCH + this.now);
    t.mock.method(globalThis, 'setTimeout', (callback, ms = 0, ...args) => this.schedule(ms, () => callback(...args)));
    t.mock.method(globalThis, 'clearTimeout', token => this.cancel(token));
  }
  schedule(ms, callback) {
    const token = {id: ++this.nextId, unref() {return this;}, ref() {return this;}};
    this.events.set(token, {at: this.now + Math.max(0, Number(ms) || 0), callback});
    return token;
  }
  cancel(token) { this.events.delete(token); }
  sleep(ms) { return new Promise(resolve => this.schedule(ms, resolve)); }
  async until(predicate) {
    let idle = 0;
    for (let steps = 0; steps < 3000; steps++) {
      await turn();
      if (predicate()) return;
      if (!this.events.size) {
        if (++idle > 8) throw new Error('Virtual fixture stalled without a scheduled event');
        continue;
      }
      idle = 0;
      const at = Math.min(...[...this.events.values()].map(event => event.at));
      this.now = at;
      const due = [...this.events].filter(([, event]) => event.at <= at);
      for (const [token, event] of due) if (this.events.delete(token)) event.callback();
    }
    throw new Error('Virtual fixture exceeded its bounded event budget');
  }
  async run(operation) {
    const started = this.now;
    let outcome;
    Promise.resolve().then(operation).then(value => {outcome = {value};}, error => {outcome = {error};});
    await this.until(() => outcome !== undefined);
    await turn();
    return {...outcome, elapsedMs: this.now - started};
  }
  async value(operation) {
    const outcome = await this.run(operation);
    if (outcome.error) throw outcome.error;
    return outcome;
  }
}

class KV {
  values = new Map();
  reads = [];
  active = 0;
  peak = 0;
  constructor(clock, readMs = 10) {this.clock = clock; this.readMs = readMs;}
  async get(key, options) {
    this.reads.push({key, at: this.clock.now}); this.active++; this.peak = Math.max(this.peak, this.active);
    try {
      await this.clock.sleep(this.readMs);
      const read = name => {
        const raw = this.values.get(name);
        return raw == null ? null : options === 'json' || options?.type === 'json' ? JSON.parse(raw) : raw;
      };
      return Array.isArray(key) ? new Map(key.map(name => [name, read(name)])) : read(key);
    } finally {this.active--;}
  }
  async put(key, value) {this.values.set(key, value);}
  async delete(key) {this.values.delete(key);}
}

function provider(t, clock, plan = () => ({})) {
  const calls = [];
  let active = 0, peak = 0;
  t.mock.method(globalThis, 'fetch', (raw, {signal} = {}) => {
    const url = String(raw);
    assert.equal(new URL(url).origin, 'https://api.chess.com', 'only the intercepted fixture provider is allowed');
    const spec = plan(url, calls.length) || {};
    const call = {url, at: clock.now, aborted: false}; calls.push(call);
    active++; peak = Math.max(peak, active);
    return new Promise((resolve, reject) => {
      let done = false, token;
      const finish = callback => {
        if (done) return;
        done = true; active--; call.finishedAt = clock.now;
        signal?.removeEventListener('abort', onAbort); callback();
      };
      const onAbort = () => {
        clock.cancel(token); call.aborted = true; call.abortedAt = clock.now;
        const rejectAbort = () => finish(() => reject(signal.reason));
        if (spec.cleanupMs) token = clock.schedule(spec.cleanupMs, rejectAbort);
        else rejectAbort();
      };
      if (signal?.aborted) {onAbort(); return;}
      signal?.addEventListener('abort', onAbort, {once: true});
      token = clock.schedule(spec.delayMs ?? 100, () => finish(() => resolve(Response.json(
        spec.body ?? {username: url.split('/').at(-1), name: 'QA latency fixture'},
        {status: spec.status || 200, headers: spec.headers},
      ))));
    });
  });
  return {calls, get active() {return active;}, get peak() {return peak;}};
}

const profile = (kv, signal = null) => api.readOrFetchProfile({GAMES_CACHE: kv}, 'alpha', {strict: true, signal});
const report = (t, scenario, measurements) => t.diagnostic(JSON.stringify({scenario, ...measurements}));
const settled = promises => Promise.all(promises.map(promise => promise.then(value => ({value}), error => ({error}))));

test('23 cold basic profiles share physical work, preserve per-caller data and add no completed memory cache', {concurrency: false}, async t => {
  const clock = new Clock(t), p = provider(t, clock), trials = [];
  for (let trial = 0; trial < 3; trial++) {
    const kv = new KV(clock), before = p.calls.length;
    const cold = await clock.value(() => Promise.all(Array.from({length: 23}, () => profile(kv))));
    assert.equal(p.calls.length - before, 1, 'one overlapping cold provider fill in the same binding/context');
    assert.equal(cold.elapsedMs, 120);
    assert.ok(cold.value.every(row => row.username === 'alpha'));
    assert.notEqual(cold.value[0], cold.value[1]);
    cold.value[0].name = 'caller-local edit';
    assert.equal(cold.value[1].name, 'QA latency fixture');
    const warm = await clock.value(() => Promise.all(Array.from({length: 23}, () => profile(kv))));
    assert.equal(warm.elapsedMs, 10); assert.equal(p.calls.length - before, 1);
    await kv.delete('profile:alpha');
    const refreshed = await clock.value(() => profile(kv));
    assert.equal(refreshed.elapsedMs, 120);
    assert.equal(p.calls.length - before, 2, 'deleting persisted data starts a fresh physical fill');
    trials.push({coldMs: cold.elapsedMs, coldProviderCalls: 1, warmMs: warm.elapsedMs, warmProviderCalls: 0, refreshMs: refreshed.elapsedMs});
  }
  assert.equal(p.active, 0); assert.equal(clock.events.size, 0);
  report(t, 'same-context-profile-coalescing', {callers: 23, trials, providerDelayMs: 100, kvReadMs: 10});
});

test('separate cold bindings preserve isolation and do not claim an elapsed speedup from duplicate work', {concurrency: false}, async t => {
  const clock = new Clock(t), p = provider(t, clock);
  const result = await clock.value(() => Promise.all(Array.from({length: 23}, () => profile(new KV(clock)))));
  assert.equal(result.elapsedMs, 120); assert.equal(p.calls.length, 23); assert.equal(p.peak, 23);
  assert.ok(result.value.every(row => row.username === 'alpha')); assert.equal(p.active, 0);
  report(t, 'separate-binding-profile-fills', {callers: 23, elapsedMs: result.elapsedMs, providerCalls: p.calls.length, peakProviderCalls: p.peak,
    limitation: 'synthetic independent coalescing domains, not Cloudflare replicas or an RPS recommendation'});
});

test('a simulated cross-invocation controller ownership boundary safely declines profile sharing', {concurrency: false}, async t => {
  const clock = new Clock(t), kv = new KV(clock), p = provider(t, clock);
  const NativeController = globalThis.AbortController;
  let invocation = 1;
  globalThis.AbortController = class extends NativeController {
    constructor() {super(); this.owner = invocation;}
    get signal() {
      if (this.owner !== invocation) throw new Error('Cannot perform I/O on behalf of a different Durable Object in the same isolate.');
      return super.signal;
    }
  };
  let first, second;
  try {
    first = profile(kv);
    await clock.until(() => p.calls.length === 1);
    invocation = 2;
    second = profile(kv);
    const result = await clock.value(() => Promise.all([first, second]));
    assert.ok(result.value.every(row => row.username === 'alpha'));
    assert.equal(p.calls.length, 2, 'ownership fallback must preserve both requests rather than force one shared fill');
    assert.ok(p.calls.every(call => !call.aborted)); assert.equal(p.active, 0);
    report(t, 'cross-invocation-ownership-fallback', {providerCalls: p.calls.length, results: 2,
      limitation: 'constructed ownership exception; real Workerd request/DO boundaries are not emulated'});
  } finally {
    // Join any outstanding fixture work before restoring process-global state.
    if (p.active) await clock.run(() => settled([first, second].filter(Boolean)));
    globalThis.AbortController = NativeController;
  }
});

test('actual leaderboard handler overlaps independent delayed KV reads without changing its response', {concurrency: false}, async t => {
  const clock = new Clock(t), kv = new KV(clock, 40), p = provider(t, clock);
  const request = () => new Request('https://worker.test/leaderboard?category=connectors');
  const result = await clock.value(async () => {const response = await worker.fetch(request(), {GAMES_CACHE: kv}); return {status: response.status, cache: response.headers.get('Cache-Control'), body: await response.json()};});
  assert.equal(result.elapsedMs, 40); assert.equal(kv.peak, 2);
  assert.deepEqual(kv.reads.map(row => row.key), ['leaderboard:entries', 'analytics:events']);
  assert.equal(kv.reads[0].at, kv.reads[1].at);
  assert.deepEqual(result.value, {status: 200, cache: 'no-store', body: {category: 'connectors', entries: [], total: 0, chainTotal: 0}});
  const serial = await clock.value(async () => {await kv.get('leaderboard:entries', 'json'); await kv.get('analytics:events', 'json');});
  assert.equal(serial.elapsedMs, 80); assert.equal(p.calls.length, 0);
  report(t, 'leaderboard-independent-kv-overlap', {handlerMs: result.elapsedMs, serialReadReferenceMs: serial.elapsedMs, kvReadMs: 40, physicalReads: 2, providerCalls: 0});
});

test('one cancelled profile subscriber returns promptly without cancelling the surviving fill', {concurrency: false}, async t => {
  const clock = new Clock(t), kv = new KV(clock), p = provider(t, clock), controller = new AbortController();
  const reason = new Error('one-profile-budget-ended'); let cancelledAt;
  clock.schedule(50, () => controller.abort(reason));
  const result = await clock.value(() => settled([profile(kv, controller.signal).catch(error => {cancelledAt = clock.now; throw error;}), profile(kv)]));
  assert.equal(result.value[0].error, reason); assert.equal(cancelledAt, 50);
  assert.equal(result.value[1].value.username, 'alpha'); assert.equal(result.elapsedMs, 120);
  assert.equal(p.calls.length, 1); assert.equal(p.calls[0].aborted, false); assert.equal(p.active, 0);
  report(t, 'individual-profile-cancellation', {cancelledAt, survivorMs: result.elapsedMs, providerCalls: p.calls.length, providerAborted: false});
});

test('all cancelled profile subscribers stop transport and leave a fresh retry available', {concurrency: false}, async t => {
  const clock = new Clock(t), kv = new KV(clock), p = provider(t, clock), a = new AbortController(), b = new AbortController();
  const reason = new Error('all-profile-budgets-ended');
  clock.schedule(50, () => {a.abort(reason); b.abort(reason);});
  const cancelled = await clock.value(() => settled([profile(kv, a.signal), profile(kv, b.signal)]));
  assert.ok(cancelled.value.every(row => row.error === reason)); assert.equal(cancelled.elapsedMs, 50);
  assert.equal(p.calls.length, 1); assert.equal(p.calls[0].abortedAt, 50); assert.equal(p.active, 0);
  assert.equal(kv.values.has('profile:alpha'), false);
  const retry = await clock.value(() => profile(kv));
  assert.equal(retry.value.username, 'alpha'); assert.equal(p.calls.length, 2); assert.equal(clock.events.size, 0);
  report(t, 'all-profile-subscribers-cancel', {cancelledMs: cancelled.elapsedMs, retryMs: retry.elapsedMs, providerCalls: p.calls.length, activeAfterSettlement: p.active});
});

test('shared missing-profile failure is not cached and a later healthy request recovers', {concurrency: false}, async t => {
  const clock = new Clock(t), kv = new KV(clock), p = provider(t, clock, (_, i) => i === 0 ? {status: 404} : {});
  const missing = await clock.value(() => Promise.all([profile(kv), profile(kv)]));
  assert.deepEqual(missing.value, [null, null]); assert.equal(p.calls.length, 1); assert.equal(kv.values.has('profile:alpha'), false);
  const recovered = await clock.value(() => profile(kv));
  assert.equal(recovered.value.username, 'alpha'); assert.equal(p.calls.length, 2);
  report(t, 'missing-profile-recovery', {missingMs: missing.elapsedMs, recoveryMs: recovered.elapsedMs, missingCalls: 1, recoveryCalls: 1});
});

test('shared 503 retry waits for Retry-After rather than multiplying attempts by subscribers', {concurrency: false}, async t => {
  const clock = new Clock(t), kv = new KV(clock), p = provider(t, clock, (_, i) => i === 0 ? {status: 503, headers: {'Retry-After': '1'}} : {});
  const result = await clock.value(() => Promise.all([profile(kv), profile(kv), profile(kv)]));
  assert.ok(result.value.every(row => row.username === 'alpha')); assert.equal(p.calls.length, 2);
  assert.ok(p.calls[1].at >= p.calls[0].finishedAt + 1000); assert.equal(result.elapsedMs, 1230); assert.equal(p.active, 0);
  report(t, 'shared-503-retry', {elapsedMs: result.elapsedMs, providerCalls: 2, firstFinishedAt: p.calls[0].finishedAt, retryStartedAt: p.calls[1].at});
});

test('cancellation during Retry-After removes the pending retry and preserves its exact reason', {concurrency: false}, async t => {
  const clock = new Clock(t), kv = new KV(clock), p = provider(t, clock, () => ({status: 503, headers: {'Retry-After': '1'}}));
  const controller = new AbortController(), reason = new Error('cancel-during-backoff');
  clock.schedule(200, () => controller.abort(reason));
  const result = await clock.run(() => profile(kv, controller.signal));
  assert.equal(result.error, reason); assert.equal(result.elapsedMs, 200); assert.equal(p.calls.length, 1);
  assert.equal(kv.values.has('profile:alpha'), false); assert.equal(clock.events.size, 0); assert.equal(p.active, 0);
  report(t, 'cancel-retry-after', {elapsedMs: result.elapsedMs, providerCalls: 1, pendingTimers: clock.events.size});
});

test('HTTP-date 429 retains its provider deadline, does not slide on reads, and admits at expiry', {concurrency: false}, async t => {
  const clock = new Clock(t), kv = new KV(clock);
  const providerDeadline = EPOCH + 90000;
  const p = provider(t, clock, (_, i) => i === 0 ? {status: 429, headers: {'Retry-After': new Date(providerDeadline).toUTCString()}} : {});
  const limited = await clock.run(() => profile(kv));
  assert.equal(limited.error?.status, 429); assert.equal(p.calls.length, 1);
  const until = JSON.parse(kv.values.get(RATE_KEY)).until;
  assert.ok(until >= providerDeadline && until < providerDeadline + 1000, 'seconds are rounded up without shortening the provider not-before');
  clock.now = until - EPOCH - 21; // cache and cooldown reads cost 20ms.
  const gated = await clock.run(() => profile(kv));
  assert.equal(gated.error?.status, 429); assert.equal(p.calls.length, 1);
  assert.equal(JSON.parse(kv.values.get(RATE_KEY)).until, until);
  clock.now = until - EPOCH;
  const recovered = await clock.value(() => profile(kv));
  assert.equal(recovered.value.username, 'alpha'); assert.equal(p.calls.length, 2);
  report(t, 'http-date-cooldown-boundary', {recordedUntil: until, providerDeadline, callsBeforeExpiry: 1, callsAfterRecovery: 2, recoveryMs: recovered.elapsedMs});
});

test('timeout cancellation waits for admitted transport cleanup instead of returning detached work', {concurrency: false}, async t => {
  const clock = new Clock(t), p = provider(t, clock, () => ({delayMs: 500, cleanupMs: 60}));
  let wrapperSettled = false;
  const operation = api.withAbortTimeout(signal => fetch('https://api.chess.com/pub/player/alpha', {signal}), 40).finally(() => {wrapperSettled = true;});
  clock.schedule(41, () => assert.equal(wrapperSettled, false, 'aborted work is still joined during cleanup'));
  const result = await clock.run(() => operation);
  assert.equal(result.error?.name, 'AbortError'); assert.equal(p.calls[0].abortedAt, 40);
  assert.equal(result.elapsedMs, 100); assert.equal(p.active, 0); assert.equal(clock.events.size, 0);
  report(t, 'timeout-joins-cleanup', {deadlineMs: 40, cleanupMs: 60, wrapperMs: result.elapsedMs, activeAfterSettlement: p.active});
});

test('chunk time budget stops the next batch while joining the already-admitted batch', {concurrency: false}, async t => {
  const clock = new Clock(t), p = provider(t, clock, () => ({delayMs: 25}));
  const names = Array.from({length: 20}, (_, i) => `frontier${i + 1}`), reads = [], primes = [];
  const proof = i => `https://www.chess.com/game/live/${i}`;
  const search = {...api.initialSearchState('alpha', 'omega'), sinceMonth: '0000/01', profileChecked: true, fastLaneChecked: true,
    incomplete: true, activeSide: 'forward', activeFrontier: [...names], activeCursor: 0, activeNextFrontier: [], forwardFrontier: [], backwardFrontier: ['omega'],
    forwardVisited: {alpha: {prev: '', hopUrl: ''}, ...Object.fromEntries(names.map((name, i) => [name, {prev: 'alpha', hopUrl: proof(i + 1)}]))},
    backwardVisited: {omega: {next: '', hopUrl: ''}}};
  const job = {id: 'latency-budget-fixture', start: 'alpha', target: 'omega', range: 'all', policyVersion: api.SEARCH_POLICY_VERSION, search};
  const stats = {requests: 0, fetched: 0, cached: 0, expanded: 0};
  const edgeReader = {async prime(batch) {primes.push([...batch]);}, async read(name, signal) {
    reads.push(name); stats.requests++;
    await fetch(`https://api.chess.com/pub/player/${name}`, {signal});
    return {edges: {beatenByMe: new Map(), beatMe: new Map()}};
  }};
  const result = await clock.value(() => api.advanceServerSearch({}, job, search, stats, async () => {}, {edgeReader, timeBudgetMs: 40, chunkStartedAt: Date.now(), expansionBudget: 20}));
  assert.equal(result.value.status, 'running'); assert.equal(result.value.shortestVerified, false);
  assert.deepEqual(primes, [names.slice(0, 16)]); assert.deepEqual(reads, names.slice(0, 16));
  assert.deepEqual(search.activeFrontier.slice(search.activeCursor), names.slice(16)); assert.equal(stats.expanded, 16);
  assert.equal(result.elapsedMs, 200); assert.equal(p.active, 0); assert.equal(p.calls.length, 16); assert.equal(clock.events.size, 0);
  report(t, 'chunk-admission-boundary', {budgetMs: 40, elapsedMs: result.elapsedMs, admitted: 16, pending: 4, peakProviderCalls: p.peak,
    limitation: 'injected edge-reader latency tests scheduling; this is not a claim of 16 allowed fresh upstream history fills'});
});
