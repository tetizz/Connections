import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { __test as api } from '../src/index.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const RATE_KEY = 'games:ratelimit:chesscom';
const month = (name, n = 1) => `https://api.chess.com/pub/player/${name}/games/2020/${String(n).padStart(2, '0')}`;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
  const values = new Map(), calls = [];
  const binding = {
    async get(key, options) {
      const read = k => {
        const value = values.get(k);
        return value == null ? null : options === 'json' || options?.type === 'json' ? structuredClone(value) : JSON.stringify(value);
      };
      return Array.isArray(key) ? new Map(key.map(k => [k, read(k)])) : read(key);
    },
    async put(key, value) { values.set(key, JSON.parse(value)); },
    async delete(key) { values.delete(key); },
  };
  const seedIndex = (name, count = 1) => values.set(`archives:fetch:v1:${name}`, {
    schema: 1, ts: Date.now(), archives: Array.from({length: count}, (_, n) => month(name, n + 1)),
  });
  const pause = (seconds = 900) => values.set(RATE_KEY, {until: Date.now() + seconds * 1000});
  const history = (name, extra = {}) => api.readOrFetchEdges({GAMES_CACHE: binding}, {
    username: name, archiveLimit: Infinity, sinceMonth: '0000/01', ...extra,
  });
  const install = callback => { globalThis.fetch = async (raw, options = {}) => {
    const url = String(raw); calls.push(url); return callback(url, options);
  }; };
  return {values, calls, binding, env: {GAMES_CACHE: binding}, seedIndex, pause, history, install};
}
const rateError = error => error?.status === 429;

test('a gate-generated 429 never renews the recorded provider deadline', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const f = fixture(); f.seedIndex('alpha'); f.seedIndex('beta');
  f.install(() => new Response('{}', {status: 429, headers: {'Retry-After': '900'}}));
  await assert.rejects(f.history('alpha'), rateError);
  const until = f.values.get(RATE_KEY)?.until;
  assert.equal(until, now + 900000);
  now += 600;
  await assert.rejects(f.history('beta'), rateError);
  assert.equal(f.calls.length, 1, 'second history is gated without a new provider response');
  assert.equal(f.values.get(RATE_KEY)?.until, until, 'ceil remaining seconds must not push an absolute deadline forward');
});

test('provider Retry-After 900 keeps its full authoritative cooldown', async () => {
  const f = fixture(); f.seedIndex('alpha');
  f.install(() => new Response('{}', {status: 429, headers: {'Retry-After': '900'}}));
  const before = Date.now();
  await assert.rejects(f.history('alpha'), error => rateError(error) && error.retryAfter === 900);
  assert.ok(f.values.get(RATE_KEY)?.until >= before + 900000, 'provider not-before must not be shortened to a polling cap');
  assert.equal(f.calls.length, 1);
});

test('already running history stops new monthly fills after another job records 429', async () => {
  const f = fixture(); f.seedIndex('alpha'); f.seedIndex('beta', 2);
  const entered = deferred(), release = deferred();
  f.install(async url => {
    if (url === month('beta', 2)) { entered.resolve(); await release.promise; }
    if (url.includes('/alpha/')) return new Response('{}', {status: 429, headers: {'Retry-After': '900'}});
    return Response.json({games: []});
  });
  const beta = f.history('beta');
  const betaRejected = assert.rejects(beta, rateError);
  try {
    await entered.promise;
    await assert.rejects(f.history('alpha'), rateError);
    assert.ok(f.values.get(RATE_KEY)?.until > Date.now());
    release.resolve(); await betaRejected;
    assert.equal(f.calls.includes(month('beta', 1)), false, 'no next archive begins after the cooldown is recorded');
  } finally { release.resolve(); await beta.catch(() => {}); }
});

test('archive-list cache miss observes an existing cooldown before physical fetch', async () => {
  const f = fixture(); f.pause();
  f.install(() => Response.json({archives: []}));
  await assert.rejects(api.readArchiveList(f.env, 'alpha'), rateError);
  assert.deepEqual(f.calls, []);
});

test('503 retry checks newly recorded cooldown before a second physical attempt', async () => {
  const f = fixture(); f.seedIndex('alpha');
  f.install(() => { f.pause(); return new Response('{}', {status: 503}); });
  await assert.rejects(f.history('alpha'), rateError);
  assert.equal(f.calls.length, 1, 'retry is a new physical attempt and must obtain fresh cooldown admission');
});

test('archive-list retry also checks newly recorded cooldown', async () => {
  const f = fixture();
  f.install(() => { f.pause(); return new Response('{}', {status: 503}); });
  await assert.rejects(api.readArchiveList(f.env, 'alpha'), rateError);
  assert.equal(f.calls.length, 1);
});

test('fresh archive index and monthly cache hits remain usable during cooldown', async () => {
  const f = fixture(); f.seedIndex('alpha');
  f.values.set('archive:games:v1:alpha:2020/01', {schema: 1, url: month('alpha'), expiresAt: Date.now() + 60000, games: []});
  f.pause(); f.install(() => assert.fail('fresh cache hit must never contact provider'));
  const games = await api.fetchGames({username: 'alpha', archiveLimit: Infinity, sinceMonth: '0000/01'}, f.env);
  assert.deepEqual(games, []); assert.deepEqual(f.calls, []);
});

test('completed shared index envelope remains reusable in a newly recorded cooldown', async () => {
  const f = fixture();
  f.install(() => Response.json({archives: [month('alpha')]}));
  const first = await api.readArchiveList(f.env, 'alpha');
  f.values.delete('archives:fetch:v1:alpha'); f.pause();
  const second = await api.readArchiveList(f.env, 'alpha');
  assert.deepEqual(second, first);
  assert.equal(f.calls.length, 1, 'cooldown applies to new physical fills, not completed plain-data delivery');
});

test('cancellation during awaited cooldown admission prevents fetch and preserves exact reason', async () => {
  const f = fixture(), entered = deferred(), release = deferred(), controller = new AbortController();
  const get = f.binding.get.bind(f.binding), reason = new Error('cancel-during-cooldown-admission');
  f.binding.get = async (key, options) => {
    if (key === RATE_KEY) { entered.resolve(); await release.promise; }
    return get(key, options);
  };
  f.install(() => Response.json({archives: []}));
  const operation = api.readArchiveList(f.env, 'alpha', {signal: controller.signal});
  const outcome = operation.then(value => ({value}), error => ({error}));
  // Absence of the gate is reported without leaving an indefinitely pending test.
  try {
    const admissionEntered = await Promise.race([entered.promise.then(() => true), outcome.then(() => false)]);
    assert.equal(admissionEntered, true, 'archive fetch must await cooldown admission');
    controller.abort(reason); release.resolve();
    assert.equal((await outcome).error, reason);
    assert.deepEqual(f.calls, []);
  } finally { controller.abort(reason); release.resolve(); await outcome; }
});
