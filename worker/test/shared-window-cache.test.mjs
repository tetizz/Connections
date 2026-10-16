import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {__test as api} from '../src/index.js';
const realFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=realFetch;});
class KV {
  values=new Map();
  async get(k,o){const v=this.values.get(k);return v==null?null:o?.type==='json'?JSON.parse(v):v;}
  async put(k,v){this.values.set(k,String(v));}
}
const url=(name,month)=>`https://api.chess.com/pub/player/${name}/games/${month}`;
function fixture(){
  const lists={alice:['2024/01','2024/08','2024/09'],bob:['2023/11','2024/01','2024/02'],connector:['2023/10','2023/11','2024/03','2024/07','2024/09']};
  const env={GAMES_CACHE:new KV()};const calls=[];
  globalThis.fetch=async raw=>{const value=String(raw);calls.push(value);const name=value.split('/')[5];return new Response(JSON.stringify(value.endsWith('/archives')?{archives:lists[name].map(month=>url(name,month))}:{games:[{rules:'chess',white:{username:name,result:'win'},black:{username:'other',result:'resigned'},url:value,time_class:'rapid',end_time:1700000000}]}),{headers:{'Content-Type':'application/json'}});};
  return {env,calls};
}
test('unequal endpoint windows define one graph including every available connector month since boundary',async()=>{
  const {env}=fixture();const sinceMonth=await api.sharedSinceMonth(env,'alice','bob','instant');assert.equal(sinceMonth,'2024/01');
  for(const [name,months] of [['alice',['2024/01','2024/08','2024/09']],['bob',['2024/01','2024/02']],['connector',['2024/03','2024/07','2024/09']]]){
    const games=await api.fetchGames({username:name,sinceMonth},env);
    assert.deepEqual(games.map(g=>g.url),months.map(m=>url(name,m)));
    assert.equal(games.archiveCoverage.sinceMonth,sinceMonth);
    assert.equal(Object.keys(games).includes('archiveCoverage'),false);
  }
  assert.equal(await api.sharedSinceMonth(env,'alice','bob','all'),'0000/01');
});
test('scoped games/derived edges persist and restore exact nonenumerable coverage; expired aggregates miss',async()=>{
  const {env}=fixture();const parsed={username:'alice',sinceMonth:'2024/01'};
  const games=await api.readOrFetchGames(env,parsed);
  const gamesKey='games:alice:since:2024/01';const edgeKey='edges:alice:since:2024/01';
  assert.deepEqual(JSON.parse(env.GAMES_CACHE.values.get(gamesKey)).coverage,games.archiveCoverage);
  const edges=await api.readCachedEdges(env,parsed);assert.deepEqual(edges.archiveCoverage,games.archiveCoverage);
  assert.deepEqual((await api.readCachedGames(env,parsed)).archiveCoverage,games.archiveCoverage);
  for(const key of [gamesKey,edgeKey]){const r=JSON.parse(env.GAMES_CACHE.values.get(key));r.coverage.expiresAt=Date.now()-1;env.GAMES_CACHE.values.set(key,JSON.stringify(r));}
  assert.equal(await api.readCachedGames(env,parsed),null);assert.equal(await api.readCachedEdges(env,parsed),null);
  assert.equal(await api.readCachedGames(env,{...parsed,sinceMonth:'2024/02'}),null);
});
test('scoped expired games cannot escape via rate-limit stale fallback',async()=>{
  const {env}=fixture();const parsed={username:'alice',sinceMonth:'2024/01'};
  await api.readOrFetchGames(env,parsed);
  const key='games:alice:since:2024/01';const r=JSON.parse(env.GAMES_CACHE.values.get(key));r.coverage.expiresAt=0;env.GAMES_CACHE.values.set(key,JSON.stringify(r));
  globalThis.fetch=async()=>new Response('',{status:429,headers:{'Retry-After':'90'}});
  // Force monthly refresh too, while preserving the original complete aggregates.
  for(const k of [...env.GAMES_CACHE.values.keys()])if(k.startsWith('archive:games:'))env.GAMES_CACHE.values.delete(k);
  await assert.rejects(api.readOrFetchGames(env,parsed),error=>error.status===429);
});
test('current-month no-store never becomes seven-day scoped aggregate coverage',async()=>{
  const env={GAMES_CACHE:new KV()};const now=new Date();const month=`${now.getUTCFullYear()}/${String(now.getUTCMonth()+1).padStart(2,'0')}`;
  let monthlyCalls=0;
  globalThis.fetch=async raw=>{const value=String(raw);if(value.endsWith('/archives'))return new Response(JSON.stringify({archives:[url('alice',month)]}));monthlyCalls++;return new Response(JSON.stringify({games:[]}),{headers:{'Cache-Control':'no-store, max-age=600'}});};
  const parsed={username:'alice',sinceMonth:month};
  const games=await api.readOrFetchGames(env,parsed);assert.ok(games.archiveCoverage.expiresAt<=Date.now());
  assert.equal(env.GAMES_CACHE.values.has(`games:alice:since:${month}`),false);
  assert.equal(env.GAMES_CACHE.values.has(`edges:alice:since:${month}`),false);
  await api.readOrFetchGames(env,parsed);assert.equal(monthlyCalls,2);
});

test('a listed missing month cannot masquerade as complete shared-window history',async()=>{
  const env={GAMES_CACHE:new KV()};
  globalThis.fetch=async raw=>String(raw).endsWith('/archives')
    ?new Response(JSON.stringify({archives:[url('alice','2024/01')]}))
    :new Response('',{status:404});
  await assert.rejects(api.readOrFetchGames(env,{username:'alice',sinceMonth:'2024/01'}),error=>error.status===404);
  assert.equal(env.GAMES_CACHE.values.has('games:alice:since:2024/01'),false);
  assert.equal(env.GAMES_CACHE.values.has('edges:alice:since:2024/01'),false);
});
