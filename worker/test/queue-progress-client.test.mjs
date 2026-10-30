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
const flush = () => new Promise(resolve => setImmediate(resolve));
const route = { found: true, path: ['alice', 'middle', 'other', 'bob'], hops: [1, 2, 3].map(id => ({ url: `https://www.chess.com/game/live/${id}` })) };
const snapshot = (expanded, chain = route, status = 'running') => ({
  id: 'queue-job', policyVersion: 'fresh-search-v2', start: 'alice', target: 'bob', range: 'all', status,
  chain, shortestVerified: false, createdAt: Date.now(), progress: `Checked ${expanded} player histories; checking for a shorter route.`,
  stats: { expanded, requests: expanded * 2, cached: expanded },
});

// Actual ordinary controller, polling, snapshot merge, queue and status renderers.
// Network and route-graph publication boundaries are mocked. Timers are inert.
function fixture() {
  const requests = [], elements = new Map(), published = [];
  const state = { activeSearchOwner: 'search:queue-test', searchJobs: new Map() };
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      hidden: false, disabled: false, innerHTML: '', textContent: '', children: [],
      classList: { add() {}, remove() {} },
      appendChild(child) { this.children.push(child); }, removeChild() { this.children.shift(); },
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    state, Date, Math, Number, String, JSON, URLSearchParams, console, $: element,
    SEARCH_POLICY_VERSION: 'fresh-search-v2', SERVER_SEARCH_HARD_LIMIT_MS: 360000, SERVER_POLL_RETRY_LIMIT: 3,
    TERMINAL_SEARCH_STATUSES: new Set(['found', 'not_found', 'timeout', 'failed', 'expired']),
    workerBase: () => 'https://example.invalid', esc: String, plainNumber: String, stepText: n => `${n} steps`,
    chainKey: path => path.join('>'), cleanUsernameInput: String,
    statusText: value => value.toUpperCase(),
    document: { createElement: () => ({ textContent: '' }) },
    setInterval: () => 1, clearInterval() {}, wait: async () => {},
    fetchJsonWithRetry: (url, options) => new Promise(resolve => requests.push({ url, options, resolve })),
    saveActiveJob() {}, clearActiveJob() {}, recordSearchEvent() {}, isWorkerUnavailable: () => false,
    window: { SavedRoutes: { routeStepCount: chain => chain.path.length - 1, isStrictlyShorter: (a, b) => a?.found && a.path.length < b.path.length } },
    showStatus: (kind, message) => { element('#search-status').innerHTML = message; },
    applyServerChain: async (job, analytics, options) => {
      if (!options.isCurrent()) return false;
      published.push(job.chain); element('#search-status').innerHTML = 'Found a verified connection; checking for a shorter route.';
      return true;
    },
    renderChain() {},
  });
  vm.runInContext([
    section('  function isSearchComplete(', '  function searchOptimalityNote('),
    section('  function serverChainIdentity(', '  async function applyServerChain('),
  ].join('\n'), context, { filename: 'actual-queue-controller.js' });
  const run = knownChain => context.runServerSearchFlow({ start: 'alice', target: 'bob', range: 'all',
    analyticsBase: { searchId: 'queue-test' }, mode: { label: 'full history' }, knownChain,
    btn: element('button'), status: element('#search-status'), logEl: element('#search-log') });
  const reply = async job => {
    const pending = requests.find(request => !request.replied); assert.ok(pending, 'expected a pending mock service request');
    pending.replied = true; pending.resolve({ data: { job } }); await flush();
  };
  const stop = async () => { state.activeSearchOwner = 'search:replacement'; if (requests.some(r => !r.replied)) await reply(snapshot(8)); await flush(); };
  return { state, element, requests, published, run, reply, stop };
}

for (const [label, known] of [['server start returns a verified route', null], ['saved verified route is being improved', route]]) {
  test(`queue tracks continuing snapshots when ${label}`, async () => {
    const f = fixture(); const done = f.run(known);
    await f.reply(snapshot(0, route, 'queued')); await done;
    const routeStatus = f.element('#search-status').innerHTML;
    await f.reply(snapshot(8));
    try {
      assert.ok(f.element('#search-log').children.some(line => /Checked 8 player histories/.test(line.textContent)), 'log confirms actual poll consumed the advancing snapshot');
      assert.equal(f.state.searchJobs.get('queue-job').stats.expanded, 8, 'merge accepted the advancing snapshot');
      assert.equal(f.element('#queue-checked').textContent, '8', 'queue must not remain at the start snapshot while background polling advances');
      assert.equal(f.element('#queue-state').textContent, 'RUNNING');
      assert.equal(f.element('#queue-requests').textContent, '16');
      assert.equal(f.element('#queue-cached').textContent, '8');
      assert.match(f.element('#queue-message').textContent, /Checked 8/);
      assert.equal(f.element('#search-status').innerHTML, routeStatus, 'queue refresh must preserve the visible verified-route status');
      assert.equal(f.published.length, 1, 'counter changes must not republish the route');
    } finally { await f.stop(); }
  });
}

test('ordinary foreground polling without an initial route already keeps queue counters current', async () => {
  const f = fixture(); const done = f.run(null);
  await f.reply(snapshot(0, null, 'queued')); await f.reply(snapshot(8, null));
  try {
    assert.equal(f.element('#queue-checked').textContent, '8');
    assert.equal(f.element('#queue-state').textContent, 'RUNNING');
  } finally { await f.stop(); await done; }
});
