import test from 'node:test';
import assert from 'node:assert/strict';
import { __test as api } from '../src/index.js';

const DAY = 86400000;
const game = { white:'alpha', black:'beta', whiteResult:'win', blackResult:'resigned',
  timeClass:'rapid', url:'https://www.chess.com/game/live/123', endTime:1700000000 };
class KV {
  values = new Map(); writes = [];
  async get(key, options) {
    const value = this.values.get(key);
    return value == null ? null : options?.type === 'json' ? JSON.parse(value) : value;
  }
  async put(key, value) { this.values.set(key, String(value)); this.writes.push(key); }
}
function fixture({ ts = Date.now(), omitTimestamp = false, scoped = false, coverage } = {}) {
  const kv = new KV();
  const parsed = scoped ? {username:'alpha',sinceMonth:'2024/01'} : {username:'alpha',archiveLimit:Infinity};
  const key = scoped ? 'games:alpha:since:2024/01' : 'games:alpha:all';
  const record = {schema:2,...(!omitTimestamp ? {ts} : {}),games:[game],...(coverage ? {coverage} : {})};
  kv.values.set(key,JSON.stringify(record));
  return {kv,parsed,env:{GAMES_CACHE:kv}};
}
// Cache-only readers must miss stale data; intentional readOrFetchGames cooldown
// stale fallback is a different contract and is deliberately not changed here.
for (const [label, options] of [
  ['eight-day-old',{ts:Date.now()-8*DAY}],
  ['missing timestamp',{omitTimestamp:true}],
  ['future timestamp',{ts:Date.now()+DAY}],
]) test(`unscoped ${label} games are not fresh cache hits`, async () => {
  const {kv,parsed,env}=fixture(options), stats={cached:0};
  assert.equal(await api.readCachedGames(env,parsed,stats),null);
  assert.equal(stats.cached,0);
  assert.deepEqual(kv.writes,[]);
});
test('unscoped fresh game array remains a cache hit',async()=>{
  const {env,parsed,kv}=fixture({ts:Date.now()-DAY}),stats={cached:0};
  assert.deepEqual(await api.readCachedGames(env,parsed,stats),[game]);
  assert.equal(stats.cached,1);assert.deepEqual(kv.writes,[]);
});
test('legacy cache-only edge derivation preserves the source observation timestamp',async()=>{
  const observedAt=Date.now()-6*DAY, {env,kv}=fixture({ts:observedAt});
  const reader=api.createSearchEdgeReader(env,{range:'all',policyVersion:'legacy',search:{}},{cached:0});
  await reader.prime(['alpha']);
  assert.equal(reader.hasCompletePrimed(['alpha']),true);
  assert.deepEqual(kv.writes,['edges:alpha:all']);
  const derived=JSON.parse(kv.values.get('edges:alpha:all'));
  assert.equal(derived.ts,observedAt,'derivation must not restart seven-day freshness from old game input');
});
test('legacy cache-only edge derivation does not republish expired game arrays',async()=>{
  const {env,kv}=fixture({ts:Date.now()-8*DAY});
  const reader=api.createSearchEdgeReader(env,{range:'all',policyVersion:'legacy',search:{}},{cached:0});
  await reader.prime(['alpha']);
  assert.equal(reader.hasCompletePrimed(['alpha']),false);
  assert.deepEqual(kv.writes,[]);
});
test('scoped fresh coverage retains its existing independent freshness contract',async()=>{
  const coverage={sinceMonth:'2024/01',expiresAt:Date.now()+DAY};
  const {env,parsed}=fixture({scoped:true,ts:Date.now(),coverage});
  const hit=await api.readCachedGames(env,parsed);
  assert.deepEqual([...hit],[game]);
  assert.equal(hit.archiveCoverage.sinceMonth,'2024/01');
  assert.equal(hit.archiveCoverage.expiresAt,coverage.expiresAt);
  assert.equal(Object.keys(hit).includes('archiveCoverage'),false);
});
test('scoped expired or mismatched coverage still misses',async()=>{
  for(const coverage of [
    {sinceMonth:'2024/01',expiresAt:Date.now()-1},
    {sinceMonth:'2024/02',expiresAt:Date.now()+DAY},
  ]) {
    const {env,parsed}=fixture({scoped:true,ts:Date.now(),coverage});
    assert.equal(await api.readCachedGames(env,parsed),null);
  }
});

for (const [label, options] of [
  ['missing timestamp',{omitTimestamp:true}],
  ['future timestamp',{ts:Date.now()+DAY}],
]) test(`active cooldown cannot authorize unscoped ${label} fallback`, async t => {
  const {env,parsed,kv}=fixture(options);
  kv.values.set('games:ratelimit:chesscom',JSON.stringify({until:Date.now()+60000}));
  const originalFetch=globalThis.fetch;
  let fetches=0,staleCalls=0;
  globalThis.fetch=async()=>{fetches++;throw new Error('No HTTP allowed in cooldown fixture');};
  t.after(()=>{globalThis.fetch=originalFetch;});
  await assert.rejects(api.readOrFetchGames(env,parsed,null,()=>{staleCalls++;}),error=>error.status===429);
  assert.equal(staleCalls,0);assert.equal(fetches,0);assert.deepEqual(kv.writes,[]);
});
test('active cooldown deliberately retains valid eight-day-old unscoped stale fallback',async t=>{
  const {env,parsed,kv}=fixture({ts:Date.now()-8*DAY});
  kv.values.set('games:ratelimit:chesscom',JSON.stringify({until:Date.now()+60000}));
  const originalFetch=globalThis.fetch;
  let fetches=0,staleCalls=0;
  globalThis.fetch=async()=>{fetches++;throw new Error('No HTTP allowed in cooldown fixture');};
  t.after(()=>{globalThis.fetch=originalFetch;});
  const games=await api.readOrFetchGames(env,parsed,null,()=>{staleCalls++;});
  assert.deepEqual([...games],[game]);assert.equal(staleCalls,1);
  assert.equal(fetches,0);assert.deepEqual(kv.writes,[]);
});
