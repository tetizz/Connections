import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../site/app.js', import.meta.url), 'utf8');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `missing extraction boundary: ${start}`);
  return source.slice(a, b);
}
const retrySource = section('  function retryAfterMs(', '  // ---------- data load');
const pollSource = section('  async function pollServerSearchJob(', '  function mergeSearchJobSnapshot(');
function response(status, { header, body } = {}) {
  return { status, ok: status >= 200 && status < 300,
    headers: { get: key => key.toLowerCase() === 'retry-after' ? header ?? null : 'application/json' },
    json: async () => body ?? {} };
}
function fixture({ replies = [], onWait, hardLimit = 120000, pollFetch } = {}) {
  const start = Date.UTC(2026, 9, 30, 12), requests = [], waits = [], timers = new Set();
  let now = start, current = true, nextTimer = 0;
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({ Date: Clock, URLSearchParams, AbortController,
    REQUEST_TIMEOUT_MS: 7000, SEARCH_POLICY_VERSION: 'fresh-search-v2',
    SERVER_SEARCH_HARD_LIMIT_MS: hardLimit, SERVER_POLL_RETRY_LIMIT: 3,
    TERMINAL_SEARCH_STATUSES: new Set(['found', 'not_found', 'failed', 'timeout', 'expired']),
    state: { searchJobs: new Map() }, workerBase: () => 'https://fixture.invalid',
    clearActiveJob() {}, showServerJobProgress() {}, statusText: String,
    mergeSearchJobSnapshot: job => job,
    setTimeout() { const id = ++nextTimer; timers.add(id); return id; },
    clearTimeout: id => timers.delete(id),
    wait: async ms => {
      assert.ok(Number.isFinite(ms) && ms > 0, `invalid fake wait ${ms}`);
      waits.push(ms); now += ms; onWait?.({ ms, count: waits.length, supersede: () => { current = false; } });
    },
    fetch: async (url, init) => {
      requests.push({ at: now, url, init });
      const next = replies.shift();
      assert.ok(next !== undefined, 'unexpected extra fake HTTP request');
      if (next instanceof Error) throw next;
      return next;
    },
  });
  vm.runInContext(retrySource + '\n' + pollSource, context, { filename: 'actual-client-network-cooldown.js' });
  if (pollFetch) context.fetchJsonWithRetry = async (...args) => {
    requests.push({ at: now, options: args[2] });
    return pollFetch(...args);
  };
  return { context, requests, waits, timers, start, elapsed: () => now - start,
    isCurrent: () => current, poll: () => context.pollServerSearchJob('job-1', { isCurrent: () => current }) };
}
const finished = { data: { job: { id: 'job-1', policyVersion: 'fresh-search-v2', status: 'found' } } };

test('actual Retry-After parser preserves numeric and HTTP-date sixty-second cooldowns', () => {
  const f = fixture();
  assert.equal(f.context.retryAfterMs(response(429, { header: '60' })), 60000);
  assert.equal(f.context.retryAfterMs(response(429, { header: new Date(f.start + 60000).toUTCString() })), 60000);
  for (const header of [undefined, '', 'nonsense', '-1']) assert.equal(f.context.retryAfterMs(response(429, { header })), 0);
});

for (const [header, body, delay] of [['60', { retryAfter: 5 }, 60000], ['5', { retryAfter: 60 }, 60000]]) {
  test(`actual fetch retry uses max header/JSON 429 cooldown (${header}/${body.retryAfter})`, async () => {
    const f = fixture({ replies: [response(429, { header, body }), response(200)] });
    await f.context.fetchJsonWithRetry('https://fixture.invalid', {}, { attempts: 2 });
    assert.equal(f.requests[1].at - f.requests[0].at, delay);
    assert.ok(f.waits.every(ms => ms <= 1000)); assert.equal(f.timers.size, 0);
  });
}

test('actual fetch retry preserves HTTP-date cooldown through fake time advancement', async () => {
  const f = fixture();
  const g = fixture({ replies: [response(429, { header: new Date(f.start + 60000).toUTCString() }), response(200)] });
  await g.context.fetchJsonWithRetry('https://fixture.invalid', {}, { attempts: 2 });
  assert.equal(g.elapsed(), 60000); assert.equal(g.requests.length, 2);
});

for (const header of [undefined, 'not-a-date']) {
  test(`actual fetch retry has bounded fallback without usable Retry-After (${header})`, async () => {
    const f = fixture({ replies: [response(429, { header }), response(200)] });
    await f.context.fetchJsonWithRetry('https://fixture.invalid', {}, { attempts: 2 });
    assert.ok(f.elapsed() > 0 && f.elapsed() <= 1200); assert.equal(f.requests.length, 2);
  });
}

test('actual fetch retry ownership cancellation interrupts a long cooldown within one-second slices', async () => {
  const f = fixture({ replies: [response(429, { header: '60' })], onWait: ({ supersede }) => supersede() });
  await assert.rejects(f.context.fetchJsonWithRetry('https://fixture.invalid', {}, { attempts: 2, isCurrent: f.isCurrent }),
    error => error.code === 'SEARCH_SUPERSEDED');
  assert.equal(f.elapsed(), 1000); assert.equal(f.requests.length, 1); assert.equal(f.timers.size, 0);
});

test('actual ordinary polling respects error.retryAfterMs=60000 and forwards ownership/deadline', async () => {
  let calls = 0;
  const f = fixture({ pollFetch: async () => {
    if (++calls === 1) throw Object.assign(new Error('cooldown'), { retryable: true, retryAfterMs: 60000 });
    return finished;
  } });
  assert.equal((await f.poll()).status, 'found'); assert.equal(f.elapsed(), 60000);
  assert.ok(f.waits.every(ms => ms <= 1000));
  assert.equal(typeof f.requests[0].options.isCurrent, 'function');
  assert.equal(f.requests[0].options.retryDeadline, f.start + 120000);
});

test('actual ordinary poll cooldown stops superseded ownership without another request', async () => {
  const f = fixture({ pollFetch: async () => { throw Object.assign(new Error('cooldown'), { retryable: true, retryAfterMs: 60000 }); },
    onWait: ({ supersede }) => supersede() });
  await assert.rejects(f.poll(), error => error.code === 'SEARCH_SUPERSEDED');
  assert.equal(f.elapsed(), 1000); assert.equal(f.requests.length, 1);
});

test('actual ordinary poll retry cooldown cannot wait beyond its hard poll budget', async () => {
  const f = fixture({ hardLimit: 2500, pollFetch: async () => {
    throw Object.assign(new Error('cooldown'), { retryable: true, retryAfterMs: 60000 });
  } });
  await assert.rejects(f.poll(), error => error.code === 'SEARCH_POLL_TIMEOUT');
  assert.equal(f.elapsed(), 2500); assert.equal(f.requests.length, 1);
  assert.deepEqual(f.waits, [1000, 1000, 500]);
});

test('actual ordinary poll bounds nested fetch cooldown by the same hard deadline', async () => {
  const f = fixture({ hardLimit: 2500, replies: [response(429, { header: '60' })] });
  await assert.rejects(f.poll(), error => error.code === 'SEARCH_POLL_TIMEOUT');
  assert.equal(f.elapsed(), 2500); assert.equal(f.requests.length, 1);
  assert.deepEqual(f.waits, [1000, 1000, 500]); assert.equal(f.timers.size, 0);
});
