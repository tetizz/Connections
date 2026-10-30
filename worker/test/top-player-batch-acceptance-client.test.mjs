import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../site/app.js', import.meta.url), 'utf8');
const from = source.indexOf('  function topTraceProgress(');
const to = source.indexOf('  function sortedTopTraceResults(', from);
assert.ok(from >= 0 && to > from, 'the batch fixture must execute the actual application functions');
const batchSource = source.slice(from, to);

const nextTurn = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) {
  for (let turn = 0; turn < 30; turn++) {
    if (predicate()) return;
    await nextTurn();
  }
  assert.ok(predicate(), 'the mocked batch did not reach the expected state');
}

function acceptanceFixture(t, { targets = ['omega'], holdFirstResponse = true } = {}) {
  const storage = new Map();
  const requests = [];
  const acceptedJobs = new Map();
  const responses = [];
  const pages = [];
  let sequence = 0;

  const finishedJob = body => ({
    id: body.searchId,
    start: body.start,
    target: body.target,
    range: body.range,
    status: 'found',
    policyVersion: 'fresh-search-v2',
    shortestVerified: true,
    chain: {
      found: true,
      path: [body.start, body.target],
      hops: [{ from: body.start, to: body.target, url: 'https://www.chess.com/game/live/123' }],
    },
  });

  function page() {
    const elements = new Map();
    const element = key => {
      if (!elements.has(key)) elements.set(key, {
        value: key === '#search-start' ? 'alpha' : '', disabled: false,
      });
      return elements.get(key);
    };
    const state = { topTraceRunId: 0 };
    const runs = [];
    const context = vm.createContext({
      state, Date, JSON, Promise, performance: { now: () => 0 },
      SEARCH_POLICY_VERSION: 'fresh-search-v2',
      LS_TOP_TRACE_KEY: 'top', LS_ACTIVE_JOB_KEY: 'active', LS_KEY: 'username',
      TOP_TRACE_CONCURRENCY: 6, TOP_TRACE_HARD_LIMIT_MS: 240000,
      TOP_TRACE_POLL_INTERVAL_MS: 140, SERVER_POLL_RETRY_LIMIT: 5,
      TERMINAL_SEARCH_STATUSES: new Set(['found', 'not_found', 'timeout', 'failed', 'expired']),
      window: { SavedRoutes: { routeStepCount: chain => chain.hops.length } },
      pathHasBlockedUser: () => false, $: element,
      localStorage: {
        getItem: key => storage.get(key) || null,
        setItem: (key, value) => storage.set(key, value),
      },
      cleanUsernameInput: value => String(value || '').toLowerCase(),
      topTraceCandidates: () => targets.map(username => ({ username })),
      savedVerifiedRoute: () => null, rememberVerifiedRoute: () => {},
      serverChainIdentity: chain => chain?.path?.join('>') || '',
      showStatus: () => {}, plainNumber: String,
      renderTopTraceCurrentTree: async () => {}, resetSearchQueue: () => {},
      newSearchEventId: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
      workerBase: () => 'https://offline.invalid/api', wait: async () => {},
      fetchJsonWithRetry: async (url, options) => {
        assert.equal(new URL(url).pathname, '/api/search/start');
        assert.equal(options.method, 'POST');
        const body = JSON.parse(options.body);
        requests.push({ body, savedAtDispatch: JSON.parse(storage.get('top') || 'null') });
        // The service accepts the UUID before its response reaches the browser.
        // Repeating that UUID recovers the accepted job; another UUID adds work.
        if (!acceptedJobs.has(body.searchId)) acceptedJobs.set(body.searchId, finishedJob(body));
        const response = { data: { job: acceptedJobs.get(body.searchId) } };
        if (holdFirstResponse && requests.length === 1) {
          return new Promise(resolve => responses.push(() => resolve(response)));
        }
        return response;
      },
    });
    vm.runInContext(batchSource, context);
    const run = context.runTopPlayersTrace;
    context.runTopPlayersTrace = (...args) => {
      const promise = run(...args);
      runs.push(promise);
      return promise;
    };
    const current = { context, state, runs };
    pages.push(current);
    return current;
  }

  t.after(async () => {
    for (const respond of responses) respond();
    await Promise.allSettled(pages.flatMap(current => current.runs));
  });
  return { page, storage, requests, acceptedJobs };
}

test('each top-player start UUID is saved before the service can accept its request', async t => {
  const fixture = acceptanceFixture(t, { targets: ['omega', 'beta', 'gamma'] });
  fixture.page().context.runTopPlayersTrace();
  await until(() => fixture.requests.length === 3);

  for (const request of fixture.requests) {
    const saved = request.savedAtDispatch.results.find(row => row.player.username === request.body.target);
    assert.equal(saved.searchId, request.body.searchId, `${request.body.target} must be resumable before the start response`);
  }
  assert.equal(fixture.acceptedJobs.size, 3);
});

test('reload after an accepted but unanswered start recovers the same job without duplicating accepted work', async t => {
  const fixture = acceptanceFixture(t);
  const first = fixture.page();
  first.context.runTopPlayersTrace();
  await until(() => fixture.requests.length === 1);
  const originalId = fixture.requests[0].body.searchId;
  first.state.topTraceRunId++; // The old page no longer owns foreground updates.

  const reloaded = fixture.page();
  assert.equal(await reloaded.context.resumeTopPlayersTrace(), true);
  await until(() => fixture.requests.length === 2);
  await Promise.all(reloaded.runs);

  assert.equal(fixture.requests[1].body.searchId, originalId, 'resume must recover the accepted UUID');
  assert.equal(fixture.acceptedJobs.size, 1, 'a lost response must not create another server search');
  const row = JSON.parse(fixture.storage.get('top')).results[0];
  assert.equal(row.searchId, originalId);
  assert.equal(row.job.id, originalId);
  assert.equal(row.job.shortestVerified, true);
});

test('a saved queued target keeps its already assigned UUID when resuming', async t => {
  const fixture = acceptanceFixture(t, { holdFirstResponse: false });
  const searchId = '00000000-0000-4000-8000-000000000099';
  fixture.storage.set('top', JSON.stringify({
    start: 'alpha', policyVersion: 'fresh-search-v2', ts: Date.now(),
    results: [{ player: { username: 'omega' }, status: 'queued', searchId, job: null }],
  }));
  const reloaded = fixture.page();
  assert.equal(await reloaded.context.resumeTopPlayersTrace(), true);
  await Promise.all(reloaded.runs);

  assert.equal(fixture.requests[0].body.searchId, searchId);
  assert.equal(fixture.requests[0].savedAtDispatch.results[0].searchId, searchId);
});

test('an older row with only a server job ID reuses that ID when it needs another start request', async t => {
  const fixture = acceptanceFixture(t, { holdFirstResponse: false });
  const jobId = '00000000-0000-4000-8000-000000000088';
  fixture.storage.set('top', JSON.stringify({
    start: 'alpha', policyVersion: 'fresh-search-v2', ts: Date.now(),
    results: [{
      player: { username: 'omega' }, status: 'paused',
      job: { id: jobId, start: 'alpha', target: 'omega', status: 'failed', policyVersion: 'fresh-search-v2' },
    }],
  }));
  const reloaded = fixture.page();
  assert.equal(await reloaded.context.resumeTopPlayersTrace(), true);
  await Promise.all(reloaded.runs);

  assert.equal(fixture.requests[0].body.searchId, jobId);
  assert.equal(fixture.requests[0].savedAtDispatch.results[0].searchId, jobId);
});

test('an older queued target without an ID saves its new UUID before its first resumable start', async t => {
  const fixture = acceptanceFixture(t);
  fixture.storage.set('top', JSON.stringify({
    start: 'alpha', policyVersion: 'fresh-search-v2', ts: Date.now(),
    results: [{ player: { username: 'omega' }, status: 'queued', job: null }],
  }));
  assert.equal(await fixture.page().context.resumeTopPlayersTrace(), true);
  await until(() => fixture.requests.length === 1);

  const request = fixture.requests[0];
  assert.ok(request.body.searchId);
  assert.equal(request.savedAtDispatch.results[0].searchId, request.body.searchId);
});
