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
test('auto is full history and older-than-six-month direct proof stops without aggregate coverage, then reuses months',async()=>{
  const env={GAMES_CACHE:new KV()};
  const months=['2019/12','2020/01','2020/02','2020/03','2020/04','2020/05','2020/06','2020/07','2020/08'];
  const calls=[];let coverageCalls=0;
  globalThis.fetch=async raw=>{
    const value=String(raw);calls.push(value);
    if(value.endsWith('/archives'))return new Response(JSON.stringify({archives:months.map(month=>url('alice',month))}));
    const month=value.slice(-7);const direct=month==='2020/01';
    return new Response(JSON.stringify({games:[{rules:'chess',white:{username:'alice',result:'win'},
      black:{username:direct?'bob':'other',result:'resigned'},url:`https://www.chess.com/game/live/${direct?123:456}`,
      time_class:'blitz',end_time:1700000000}]}));
  };
  assert.equal(await api.sharedSinceMonth(env,'alice','bob','auto'),'0000/01');
  assert.equal(calls.length,0,'full-history boundary needs no endpoint list round trips');
  const parsed={username:'alice',sinceMonth:'0000/01',directTarget:'bob',onCoverage:()=>{coverageCalls++;}};
  let savedGame;
  await assert.rejects(api.readOrFetchGames(env,parsed),error=>{
    assert.ok(error instanceof api.DirectWinFound);savedGame=error.game;
    assert.equal(error.game.url,'https://www.chess.com/game/live/123');return true;
  });
  assert.deepEqual(calls.slice(1),months.slice(1).reverse().map(month=>url('alice',month)));
  assert.equal(calls.includes(url('alice','2019/12')),false,'older unneeded month is not downloaded after absolute-minimum proof');
  assert.equal(coverageCalls,0);
  assert.equal(env.GAMES_CACHE.values.has('games:alice:since:0000/01'),false);
  assert.equal(env.GAMES_CACHE.values.has('edges:alice:since:0000/01'),false);
  assert.equal([...env.GAMES_CACHE.values.keys()].filter(key=>key.startsWith('archive:games:')).length,8);
  // The carried proof is detached from persisted sanitized monthly bytes.
  savedGame.white='changed';
  assert.equal(JSON.parse(env.GAMES_CACHE.values.get('archive:games:v1:alice:2020/01')).games[0].white,'alice');
  const before=calls.length;
  await assert.rejects(api.readOrFetchGames(env,parsed),error=>error instanceof api.DirectWinFound && error.game.white==='alice');
  assert.equal(calls.length,before,'retry uses retained list and complete months');
  assert.equal(coverageCalls,0);
});
test('direct scan rejects reversed win, daily and invalid proof URL',()=>{
  for(const game of [
    {white:'bob',black:'alice',whiteResult:'win',blackResult:'resigned',timeClass:'blitz',url:'https://www.chess.com/game/live/123'},
    {white:'alice',black:'bob',whiteResult:'win',timeClass:'daily',url:'https://www.chess.com/game/live/123'},
    {white:'alice',black:'bob',whiteResult:'win',timeClass:'blitz',url:'https://example.org/game/live/123'},
  ]) assert.doesNotThrow(()=>api.checkDirectArchiveWin([game],'alice','bob'));
});
test('scoped edge streaming visits every month newest-first, keeps one newest proof and no aggregate games',async()=>{
  const env={GAMES_CACHE:new KV()};const months=['2020/01','2020/02','2020/03'];const seen=[];
  globalThis.fetch=async raw=>{
    const value=String(raw);
    if(value.endsWith('/archives'))return new Response(JSON.stringify({archives:months.map(month=>url('alice',month))}));
    const month=value.slice(-7);const id=Number(month.slice(-2));seen.push(month);
    return new Response(JSON.stringify({games:[{rules:'chess',white:{username:'alice',result:'win'},
      black:{username:'bob',result:'resigned'},url:`https://www.chess.com/game/live/${id}`,time_class:'blitz',end_time:1700000000+id}]}));
  };
  const stats={requests:0,fetched:0,cached:0};
  const edges=await api.readOrFetchEdges(env,{username:'alice',sinceMonth:'0000/01'},stats);
  assert.deepEqual(seen,['2020/03','2020/02','2020/01']);
  assert.deepEqual([...edges.beatenByMe],[['bob',['https://www.chess.com/game/live/3']]]);
  assert.equal(stats.requests,1);assert.equal(stats.fetched,1);
  assert.equal(env.GAMES_CACHE.values.has('games:alice:since:0000/01'),false);
  assert.equal(env.GAMES_CACHE.values.has('edges:alice:since:0000/01'),true);
  assert.equal([...env.GAMES_CACHE.values.keys()].filter(key=>key.startsWith('archive:games:')).length,3);
  assert.deepEqual((await api.readCachedEdges(env,{username:'alice',sinceMonth:'0000/01'})).archiveCoverage,edges.archiveCoverage);
});
test('streaming failure retains completed month but publishes no partial edge or aggregate cache',async()=>{
  const env={GAMES_CACHE:new KV()};const controller=new AbortController();
  globalThis.fetch=async raw=>{
    const value=String(raw);
    if(value.endsWith('/archives'))return new Response(JSON.stringify({archives:['2020/01','2020/02'].map(month=>url('alice',month))}));
    if(value.endsWith('/01')){controller.abort(new DOMException('owned stop','AbortError'));throw controller.signal.reason;}
    return new Response(JSON.stringify({games:[]}));
  };
  const stats={requests:0,fetched:0,cached:0};
  await assert.rejects(api.readOrFetchEdges(env,{username:'alice',sinceMonth:'0000/01',signal:controller.signal},stats),{name:'AbortError'});
  assert.equal(stats.requests,1);assert.equal(stats.fetched,0);
  assert.equal(env.GAMES_CACHE.values.has('archive:games:v1:alice:2020/02'),true);
  assert.equal(env.GAMES_CACHE.values.has('edges:alice:since:0000/01'),false);
  assert.equal(env.GAMES_CACHE.values.has('games:alice:since:0000/01'),false);
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
