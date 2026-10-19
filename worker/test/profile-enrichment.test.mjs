import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
const originalFetch=globalThis.fetch;
afterEach(()=>globalThis.fetch=originalFetch);
class KV {
  values=new Map();
  async get(key,options){const raw=this.values.get(key);return raw==null?null:options==='json'||options?.type==='json'?JSON.parse(raw):raw;}
  async put(key,value){this.values.set(key,value);}
}
const response=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json',...headers}});
const profileRequest=kv=>worker.fetch(new Request('https://worker.test/profile?username=alpha'),{GAMES_CACHE:kv});
test('profile misses respect the existing shared Chess.com cooldown without fetching',async()=>{
  const kv=new KV();await kv.put('games:ratelimit:chesscom',JSON.stringify({until:Date.now()+60000}));
  let calls=0;globalThis.fetch=async()=>{calls++;return response({username:'alpha',archives:[]});};
  const result=await profileRequest(kv);
  assert.equal(calls,0);assert.equal(result.status,429);
});
test('stats 429 is explicit partial enrichment, retains verified stale sections and retries soon',async()=>{
  const kv=new KV();
  const previous={username:'alpha',stats:{rapid:{rating:1700}},recentGames:[{opponent:'beta',result:'win'}]};
  await kv.put('profile:alpha',JSON.stringify({ts:0,profile:previous}));
  let calls=0;globalThis.fetch=async(url)=>{calls++;return String(url).endsWith('/stats')?response({},429,{'Retry-After':'60'}):response({username:'alpha',archives:[]});};
  const result=await profileRequest(kv),body=await result.json();
  assert.equal(body.partial,true);assert.equal(body.profile.enrichment.stats,'stale');
  assert.deepEqual(body.profile.stats,previous.stats);assert.deepEqual(body.profile.recentGames,previous.recentGames);
  assert.ok(kv.values.has('games:ratelimit:chesscom'));assert.equal(calls,2);
  const cached=JSON.parse(kv.values.get('profile:alpha'));cached.ts=Date.now()-61000;await kv.put('profile:alpha',JSON.stringify(cached));kv.values.delete('games:ratelimit:chesscom');
  globalThis.fetch=async(url)=>response(String(url).endsWith('/stats')?{chess_rapid:{last:{rating:1800}}}:{username:'alpha',archives:[]});
  const retried=await (await profileRequest(kv)).json();assert.equal(retried.profile.stats.rapid.rating,1800);assert.equal(retried.partial,false);
});
test('concurrent cold profile fills share one upstream sequence per isolate and binding',async()=>{
  const kv=new KV();let calls=0;
  globalThis.fetch=async(url)=>{calls++;await new Promise(r=>setTimeout(r,10));return response({username:'alpha',archives:[]});};
  const results=await Promise.all(Array.from({length:12},()=>profileRequest(kv)));
  assert.equal(calls,3);for(const result of results)assert.equal((await result.json()).profile.username,'alpha');
  const other=new KV();await profileRequest(other);assert.equal(calls,6);
});
test('recent-game failures stay unavailable rather than asserting an empty verified history',async()=>{
  const kv=new KV();globalThis.fetch=async(url)=>String(url).endsWith('/games/archives')?response({},503):response({username:'alpha'});
  const body=await (await profileRequest(kv)).json();
  assert.equal(body.partial,true);assert.equal(body.profile.enrichment.recentGames,'unavailable');
});
test('verified stale games retained by the game cache stay explicitly stale in enrichment',async()=>{
  const kv=new KV();await kv.put('games:alpha:recent:2',JSON.stringify({schema:2,ts:0,games:[{white:'alpha',black:'beta',whiteResult:'win',blackResult:'resigned',endTime:1700000000,url:'https://www.chess.com/game/live/123'}]}));
  globalThis.fetch=async(url)=>String(url).endsWith('/games/archives')?response({},429,{'Retry-After':'60'}):response({username:'alpha'});
  const body=await (await profileRequest(kv)).json();assert.equal(body.partial,true);assert.equal(body.profile.enrichment.recentGames,'stale');assert.equal(body.profile.recentGames[0].opponent,'beta');
});
test('failed cold fills clear the promise so a later request can recover',async()=>{
  const kv=new KV();globalThis.fetch=async()=>response({},404);
  assert.equal((await profileRequest(kv)).status,404);
  globalThis.fetch=async()=>response({username:'alpha',archives:[]});
  assert.equal((await profileRequest(kv)).status,200);
});
test('concurrent cold game requests share one archive-list fill',async()=>{
  const kv=new KV();let calls=0;globalThis.fetch=async()=>{calls++;await new Promise(r=>setTimeout(r,10));return response({archives:[]});};
  const results=await Promise.all(Array.from({length:12},()=>worker.fetch(new Request('https://worker.test/games?key=alpha:recent:2'),{GAMES_CACHE:kv})));
  assert.equal(calls,1);for(const result of results)assert.equal(result.status,200);
});
