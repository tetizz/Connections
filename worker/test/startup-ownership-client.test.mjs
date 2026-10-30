import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../site/app.js', import.meta.url), 'utf8');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `Actual app section missing: ${start}`);
  return source.slice(first, last);
}
function constant(name) {
  const line = source.split(/\r?\n/).find(value => value.startsWith(`  const ${name} = `));
  assert.ok(line, `Actual app constant missing: ${name}`);
  return line;
}
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
const activeKey = 'chess-connections:active-search-job:v3:full-history-search';
const batchKey = 'chess-connections:top-player-jobs:v1';

// Execute actual startup, metadata loading, resume dispatch, persistence and user
// controllers. Only service/render boundaries are mocked; no HTTP is performed.
function fixture({ sharedKind = null } = {}) {
  const storage = new Map(), elements = new Map(), polls = [], starts = [], topStarts = [], renders = [], statuses = [], verifications = [];
  const state = { activeSearchOwner: '', searchJobs: new Map(), topTraceRunId: 0, players: {} };
  const startupCalls = [];
  let onReady, releaseMetadata, rejectMetadata;
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', focus() {} });
    return elements.get(id);
  };
  const context = vm.createContext({
    state, Date, Math, JSON, console, performance, URL, DATA_BASE: '/data/', $: element,
    location: { href: sharedKind ? `https://example.invalid/?${sharedKind === 'short' ? 'c' : 'chain'}=saved-proof` : 'https://example.invalid/' },
    document: { documentElement: { dataset: { theme: 'dark' } }, addEventListener(event, fn) { assert.equal(event, 'DOMContentLoaded'); onReady = fn; } },
    window: {}, localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) },
    fetch: url => { assert.equal(url, '/data/players.json'); return new Promise((resolve, reject) => { releaseMetadata = (players = {}) => resolve({ ok: true, json: async () => players }); rejectMetadata = reject; }); },
    applyTheme() {}, loadLeaderboardTargetsWhenVisible() { startupCalls.push('visible-targets'); },
    decodeSharePayload: value => value ? { found: true } : null,
    fetchShortSharedChain: () => new Promise(resolve => verifications.push(resolve)),
    verifyLongSharedChain: () => new Promise(resolve => verifications.push(resolve)),
    metaShape: value => value,
    cleanUsernameInput: value => String(value || '').trim().toLowerCase(), isBlockedUsername: () => false,
    usernameInputError: () => 'invalid', savedVerifiedRoute: () => null,
    renderChain: chain => renders.push(chain), showStatus: (...args) => statuses.push(args),
    renderSearchQueue() {}, resetSearchQueue() {}, finishSearchQueue() {}, applyServerChain() {},
    isSearchComplete: () => false, parseSearchMode: () => ({ label: 'full history' }), nameOf: String,
    newSearchEventId: () => 'user-new', recordSearchEvent() {},
    pollServerSearchJob: (id, options) => { polls.push({ id, options }); return new Promise(() => {}); },
    runServerSearchFlow: async options => {
      starts.push(options);
      context.saveActiveJob({ id: 'accepted-new', start: options.start, target: options.target, searchId: options.analyticsBase.searchId, range: 'all' });
      // Accepted foreground server work has one live polling lifecycle.
      void context.pollServerSearchJob('accepted-new', { isCurrent: () => state.activeSearchOwner === 'search:user-new' });
      return true;
    },
    topTraceCandidates: () => [{ username: 'omega' }],
    saveTopTraceBatch: (start, results, options) => storage.set(batchKey, JSON.stringify({ start, results, ...options, ts: Date.now(), policyVersion: 'fresh-search-v2' })),
    traceTopCandidate: (...args) => { topStarts.push(args); return new Promise(() => {}); },
    topTraceProgress: () => ({ found: 0, proven: 0, checking: 1 }), plainNumber: String,
  });
  vm.runInContext([
    ...['LS_KEY', 'LS_THEME_KEY', 'LS_RANGE_KEY', 'LS_RANGE_MIGRATION_KEY', 'LEGACY_DEPTH_KEY', 'LS_ACTIVE_JOB_KEY', 'LS_TOP_TRACE_KEY', 'SEARCH_POLICY_VERSION', 'DEFAULT_TARGET', 'TOP_TRACE_CONCURRENCY', 'CHAIN_PARAM', 'SHORT_CHAIN_PARAM', 'LEGACY_SHARE_PARAM'].map(constant),
    section('  async function loadPlayerMetadata()', '  function renderShowcaseTabs()'),
    section('  async function resumeTopPlayersTrace()', '  async function traceTopCandidate('),
    section('  function saveActiveJob(', '  function warmSharedCaches('),
    section('  async function runSearch(', '  function metaShape('),
    section('  async function loadSharedChainFromUrl(', '  async function verifyLongSharedChain('),
    section('  document.addEventListener("DOMContentLoaded", () => {', '})();'),
  ].join('\n'), context, { filename: 'actual-startup-user-controllers.js' });
  return { context, state, storage, polls, starts, topStarts, renders, statuses, verifications, startupCalls, element, ready: () => onReady(), release: async players => { releaseMetadata(players); await flush(); }, reject: async () => { rejectMetadata(new Error('optional seed unavailable')); await flush(); } };
}

test('a foreground search accepted while startup metadata waits retains ownership and its single polling lifecycle', async () => {
  const f = fixture(); f.ready();
  await f.context.runSearch('alice', 'bob', 'all');
  assert.equal(f.starts.length, 1); assert.equal(f.polls.length, 1);
  const owner = f.state.activeSearchOwner;
  await f.release();
  assert.equal(f.state.activeSearchOwner, owner, 'startup restoration must not supersede a user search');
  assert.equal(f.polls.length, 1, 'startup must not launch another poll for the newly accepted job');
  assert.equal(f.polls[0].options.isCurrent(), true);
});

test('a saved foreground job present at page load still resumes when the visitor has not started work', async () => {
  const f = fixture();
  f.storage.set(activeKey, JSON.stringify({ id: 'saved-before-load', searchId: 'saved-search', start: 'alice', target: 'bob', policyVersion: 'fresh-search-v2', ts: Date.now() }));
  f.ready(); await flush();
  assert.equal(f.polls.length, 1); assert.equal(f.polls[0].id, 'saved-before-load');
  assert.equal(f.polls[0].options.isCurrent(), true);
  assert.equal(f.element('#search-start').value, 'alice');
});

test('a user top-player run started while metadata waits prevents automatic saved-work restoration', async () => {
  const f = fixture();
  f.storage.set(activeKey, JSON.stringify({ id: 'older-foreground', start: 'old', target: 'target', policyVersion: 'fresh-search-v2', ts: Date.now() - 1000 }));
  f.ready(); f.element('#search-start').value = 'alice';
  void f.context.runTopPlayersTrace();
  assert.equal(f.topStarts.length, 1);
  const owner = f.state.activeSearchOwner;
  await f.release();
  assert.equal(f.state.activeSearchOwner, owner, 'startup must leave the user-selected top-player run in control');
  assert.equal(f.topStarts.length, 1, 'startup must not restart the newly persisted top-player batch');
  assert.equal(f.polls.length, 0, 'older foreground work must not resume over user-selected work');
});

const sharedProof = { found: true, path: ['shared-start', 'shared-target'], target: 'shared-target', display: 'Shared Target', players: { 'shared-start': { username: 'shared-start' } } };

for (const [kind, verified] of [['short', true], ['long', true], ['long', false]]) {
  test(`foreground work survives delayed ${kind} shared-chain verification (${verified ? 'verified' : 'rejected'})`, async () => {
    const f = fixture({ sharedKind: kind }); f.ready(); await flush();
    assert.equal(f.verifications.length, 1, 'startup must be waiting at the actual share verification boundary');
    await f.context.runSearch('alice', 'bob', 'all');
    const owner = f.state.activeSearchOwner, renderCount = f.renders.length, statusCount = f.statuses.length;
    f.verifications[0](verified ? sharedProof : null); await flush();
    assert.equal(f.state.activeSearchOwner, owner);
    assert.equal(f.renders.length, renderCount, 'stale shared proof must not replace the foreground graph');
    assert.equal(f.statuses.length, statusCount, 'stale shared success or failure must not replace the foreground status');
    assert.equal(f.element('#search-start').value, 'alice');
    assert.equal(f.element('#search-target').value, 'bob');
    assert.equal(f.state.players['shared-start'], undefined, 'stale shared metadata must not publish');
    assert.equal(f.polls.length, 1, 'startup must not launch a second foreground polling lifecycle');
  });
}

test('an undisturbed verified shared chain still loads and suppresses saved-job restoration', async () => {
  const f = fixture({ sharedKind: 'short' });
  f.storage.set(activeKey, JSON.stringify({ id: 'saved-before-load', start: 'alice', target: 'bob', policyVersion: 'fresh-search-v2', ts: Date.now() }));
  f.ready(); await flush();
  assert.equal(f.verifications.length, 1, 'share verification must start while optional metadata remains pending');
  f.verifications[0](sharedProof); await flush();
  assert.equal(f.renders.length, 1); assert.equal(f.renders[0], sharedProof);
  assert.equal(f.element('#search-start').value, 'shared-start');
  assert.equal(f.element('#search-target').value, 'shared-target');
  assert.equal(f.statuses.at(-1)[0], 'done'); assert.equal(f.polls.length, 0);
});

test('visible target setup does not wait for an indefinitely pending player seed', async () => {
  const f = fixture(); f.ready(); await flush();
  assert.deepEqual(f.startupCalls, ['visible-targets']);
});

test('late player seed fills missing fields while preserving fetched and job-authoritative profile fields', async () => {
  const f = fixture(); f.ready();
  const stats = { rapid: { rating: 2000 } };
  f.state.players = { alice: { username: 'alice', name: 'Live Alice', stats, profileComplete: true }, jobonly: { username: 'jobonly', title: 'GM' } };
  await f.release({ alice: { username: 'alice', name: 'Old seed name', avatar: 'seed-avatar' }, seedonly: { username: 'seedonly', name: 'Seed Only' } });
  assert.equal(f.state.players.alice.name, 'Live Alice');
  assert.equal(f.state.players.alice.stats, stats);
  assert.equal(f.state.players.alice.profileComplete, true);
  assert.equal(f.state.players.alice.avatar, 'seed-avatar', 'optional seed still fills missing display fields');
  assert.equal(f.state.players.jobonly.title, 'GM');
  assert.equal(f.state.players.seedonly.name, 'Seed Only');
});

test('late optional player-seed failure preserves profiles already fetched by active work', async () => {
  const f = fixture(); f.ready();
  const profiles = { alice: { username: 'alice', name: 'Live Alice', stats: { rapid: { rating: 2000 } } } };
  f.state.players = profiles;
  await f.reject();
  assert.equal(f.state.players.alice, profiles.alice);
  assert.equal(f.state.players.alice.name, 'Live Alice');
});

test('a user search after automatic restoration retains ownership when optional seed eventually completes', async () => {
  const f = fixture();
  f.storage.set(activeKey, JSON.stringify({ id: 'saved-before-load', searchId: 'saved-search', start: 'old-start', target: 'old-target', policyVersion: 'fresh-search-v2', ts: Date.now() }));
  f.ready(); await flush();
  assert.equal(f.polls.length, 1, 'saved job must restore before optional seed finishes');
  assert.equal(f.polls[0].id, 'saved-before-load');
  await f.context.runSearch('alice', 'bob', 'all');
  const owner = f.state.activeSearchOwner;
  assert.equal(f.polls.length, 2);
  assert.equal(f.polls[0].options.isCurrent(), false);
  await f.release();
  assert.equal(f.state.activeSearchOwner, owner);
  assert.equal(f.polls.length, 2, 'seed completion must not launch a duplicate resume');
  assert.equal(f.polls[1].options.isCurrent(), true);
});
