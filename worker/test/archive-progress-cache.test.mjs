import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { __test } from '../src/index.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
class MemoryKV {
  values = new Map();
  writes = [];
  async get(key, options) {
    const value = this.values.get(key);
    return value === undefined ? null : options?.type === 'json' ? JSON.parse(value) : value;
  }
  async put(key, value, options) {
    this.values.set(key, String(value)); this.writes.push({ key, options });
  }
}
const base = 'https://api.chess.com/pub/player/alice/games/';
const listURL = base + 'archives';
const monthKey = month => `archive:games:v1:alice:${month}`;
function response(value, headers = {}) {
  return new Response(JSON.stringify(value), {headers: {'Content-Type':'application/json', ...headers}});
}
function game(id) {
  return {rules:'chess',white:{username:'Alice',result:'win'},black:{username:'Bob',result:'resigned'},
    url:`https://www.chess.com/game/live/${id}`,time_class:'blitz',end_time:1700000000,eco:'opening'};
}
function transport(handler) {
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push(String(url)); return handler(String(url), options); };
  return calls;
}
const args = {username:'alice', archiveLimit:6};

test('actual fetchGames retains complete first month after owned second-month abort and resumes without repeating it', async () => {
  const env = {GAMES_CACHE:new MemoryKV()};
  const controller = new AbortController(); let abort = true;
  const calls = transport(async url => {
    if (url === listURL) return response({archives:[base+'2020/01',base+'2020/02']});
    if (url === base+'2020/02' && abort) {
      controller.abort(new DOMException('owned cancellation','AbortError'));
      throw controller.signal.reason;
    }
    return response({games:[game(url.endsWith('/01') ? 1 : 2)]});
  });
  await assert.rejects(__test.fetchGames({...args, signal:controller.signal}, env), {name:'AbortError'});
  assert.equal(env.GAMES_CACHE.values.has(monthKey('2020/01')), true);
  assert.equal(env.GAMES_CACHE.values.has(monthKey('2020/02')), false);
  abort = false;
  const rows = await __test.fetchGames(args, env);
  assert.deepEqual(rows.map(row => row.url), [game(1).url,game(2).url]);
  assert.equal(calls.filter(url => url === listURL).length, 1);
  assert.equal(calls.filter(url => url === base+'2020/01').length, 1);
  assert.equal(calls.filter(url => url === base+'2020/02').length, 2);
  assert.deepEqual(rows[0], {white:'alice',black:'bob',whiteResult:'win',blackResult:'resigned',
    url:game(1).url,timeClass:'blitz',endTime:1700000000,opening:'opening'});
});

test('aggregate remains pending until the final monthly body has parsed completely', async () => {
  const env = {GAMES_CACHE:new MemoryKV()};
  let release; const gate = new Promise(resolve => { release = resolve; });
  let reached; const finalStarted = new Promise(resolve => { reached = resolve; });
  transport(async url => {
    if (url === listURL) return response({archives:[base+'2020/01',base+'2020/02']});
    if (url.endsWith('/02')) { reached(); await gate; }
    return response({games:[game(url.endsWith('/01') ? 1 : 2)]});
  });
  let complete = false;
  const pending = __test.fetchGames(args, env).then(rows => { complete = true; return rows; });
  await finalStarted;
  assert.equal(complete, false);
  assert.equal(env.GAMES_CACHE.values.has(monthKey('2020/01')), true);
  assert.equal(env.GAMES_CACHE.values.has(monthKey('2020/02')), false);
  release(); assert.equal((await pending).length, 2);
});

test('current month uses explicit provider max-age minus Age and expired data is fetched again', async () => {
  const env = {GAMES_CACHE:new MemoryKV()};
  const now = new Date(); const month = `${now.getUTCFullYear()}/${String(now.getUTCMonth()+1).padStart(2,'0')}`;
  const calls = transport(async url => url === listURL ? response({archives:[base+month]}) :
    response({games:[game(1)]},{'Cache-Control':'public, max-age=180','Age':'60'}));
  const before = Date.now(); await __test.fetchGames(args, env);
  const cached = JSON.parse(env.GAMES_CACHE.values.get(monthKey(month)));
  assert.ok(cached.expiresAt >= before + 120000 && cached.expiresAt <= Date.now() + 120000);
  assert.equal(env.GAMES_CACHE.writes.find(row => row.key === monthKey(month)).options.expirationTtl,120);
  await __test.fetchGames(args, env);
  assert.equal(calls.filter(url => url === base+month).length,1);
  cached.expiresAt = Date.now()-1; env.GAMES_CACHE.values.set(monthKey(month),JSON.stringify(cached));
  await __test.fetchGames(args, env);
  assert.equal(calls.filter(url => url === base+month).length,2);
});

test('current month no-store or absent freshness is never persisted', async () => {
  const now = new Date(); const month = `${now.getUTCFullYear()}/${String(now.getUTCMonth()+1).padStart(2,'0')}`;
  for (const headers of [{},{'Cache-Control':'no-store, max-age=180'}]) {
    const env = {GAMES_CACHE:new MemoryKV()};
    const calls = transport(async url => url === listURL ? response({archives:[base+month]}) : response({games:[game(1)]},headers));
    await __test.fetchGames(args,env); await __test.fetchGames(args,env);
    assert.equal(env.GAMES_CACHE.values.has(monthKey(month)),false);
    assert.equal(calls.filter(url => url === base+month).length,2);
  }
});

test('invalid and foreign archive URLs fail without fetching an untrusted monthly URL', async () => {
  for (const url of [base+'2020/00',base+'2020/13','https://example.org/games/2020/01',
    'https://api.chess.com/pub/player/bob/games/2020/01']) {
    const env = {GAMES_CACHE:new MemoryKV()};
    const calls = transport(async () => response({archives:[url]}));
    await assert.rejects(__test.fetchGames(args,env),/Invalid archive list/);
    assert.deepEqual(calls,[listURL]);
    assert.equal(env.GAMES_CACHE.values.size,0);
  }
});

test('invalid cached list/month records are ignored and replaced by complete provider data', async () => {
  for (const mutation of [record => {record.url = base+'2020/02';},
    record => {record.schema = 99;}, record => {record.games = [{white:'alice'}];},
    record => {record.expiresAt = 'tomorrow';}]) {
    const env = {GAMES_CACHE:new MemoryKV()};
    env.GAMES_CACHE.values.set('archives:fetch:v1:alice',JSON.stringify({schema:1,ts:Date.now(),archives:['https://example.org/games/2020/01']}));
    const cached = {schema:1,url:base+'2020/01',expiresAt:Date.now()+600000,games:[]}; mutation(cached);
    env.GAMES_CACHE.values.set(monthKey('2020/01'),JSON.stringify(cached));
    const calls = transport(async url => url === listURL ? response({archives:[base+'2020/01']}) : response({games:[game(1)]}));
    assert.equal((await __test.fetchGames(args,env))[0].url,game(1).url);
    assert.deepEqual(calls,[listURL,base+'2020/01']);
  }
});

test('actual provider TTL parser rejects noncacheable policy and caps historical maximum', () => {
  const ttl = (policy, age) => __test.archiveProviderTTL(new Response('',{headers:{'Cache-Control':policy,...(age ? {Age:age}:{})}}));
  assert.equal(ttl('public,max-age=120','30'),90);
  for (const policy of ['no-cache,max-age=120','private,max-age=120','no-store,max-age=120','public']) assert.equal(ttl(policy),0);
  assert.equal(ttl('max-age=9999999'),604800);
  assert.equal(ttl('max-age=120','invalid'),0);
});

test('failed JSON body never persists a partial month or returns partial aggregate', async () => {
  const env = {GAMES_CACHE:new MemoryKV()};
  transport(async url => {
    if (url === listURL) return response({archives:[base+'2020/01',base+'2020/02']});
    if (url.endsWith('/01')) return response({games:[game(1)]});
    return new Response('{"games":[', {headers:{'Content-Type':'application/json','Cache-Control':'max-age=180'}});
  });
  await assert.rejects(__test.fetchGames(args,env),SyntaxError);
  assert.equal(env.GAMES_CACHE.values.has(monthKey('2020/01')),true);
  assert.equal(env.GAMES_CACHE.values.has(monthKey('2020/02')),false);
});
