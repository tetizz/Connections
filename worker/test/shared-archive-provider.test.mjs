import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { __test as api } from '../src/index.js';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const turn = () => new Promise(setImmediate);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve=r; }); return { promise, resolve }; };
const archiveURL = m => `https://api.chess.com/pub/player/alpha/games/2020/${String(m).padStart(2,'0')}`;
function fixture() {
  const values=new Map(), indexGate=deferred(), arrived=deferred(), counts={indexes:0,months:0}, signals=[];
  const binding={
    async get(key,options) { const read=k=>{const raw=values.get(k);return raw==null?null:options==='json'||options?.type==='json'?JSON.parse(raw):raw;};return Array.isArray(key)?new Map(key.map(k=>[k,read(k)])):read(key); },
    async put(key,value) {values.set(key,value);}, async delete(key){values.delete(key);},
  };
  globalThis.fetch=async(raw,options={})=>{
    const url=String(raw);signals.push(options.signal);await turn();
    if(url.endsWith('/games/archives')) { counts.indexes++;arrived.resolve();await indexGate.promise;return Response.json({archives:Array.from({length:6},(_,i)=>archiveURL(i+1))}); }
    counts.months++;const m=Number(url.slice(-2));return Response.json({games:[{rules:'chess',white:{username:'alpha',result:'win'},black:{username:'beta'+m,result:'resigned'},url:'https://www.chess.com/game/live/'+(1000+m),time_class:'blitz',end_time:1578000000+m}]});
  };
  return {env:{GAMES_CACHE:binding},counts,signals,arrived,indexGate};
}
const parsed={username:'alpha',archiveLimit:Infinity,sinceMonth:'0000/01'};
const stats=()=>({requests:0,cached:0,fetched:0});

test('three full-history searches share provider fills but retain independent archive callbacks',async()=>{
  const f=fixture(), seen=[[],[],[]],arrays=[[],[],[]];
  const pending=seen.map((rows,i)=>api.readOrFetchEdges(f.env,{...parsed,onGames:games=>{rows.push(...games.map(g=>g.url));arrays[i].push(games);}},stats()));
  await f.arrived.promise;await turn();f.indexGate.resolve();
  const results=await Promise.all(pending);
  assert.deepEqual(f.counts,{indexes:1,months:6},'same-player top-target jobs must not redownload identical provider archives');
  for(const [i,edges] of results.entries()){assert.equal(edges.beatenByMe.size,6);assert.equal(seen[i].length,6);assert.deepEqual(seen[i],seen[0]);}
  assert.notEqual(arrays[0][0],arrays[1][0],'job-local sanitized arrays and collectors must not be shared');
  const before={...f.counts};await Promise.all([1,2,3].map(()=>api.readOrFetchEdges(f.env,parsed,stats())));
  assert.deepEqual(f.counts,before,'later unrelated pair searches reuse completed monthly/edge storage');
});

test('a cancelled search does not abort shared archive work for another search',async()=>{
  const f=fixture(),cancelled=new AbortController();
  const a=api.readOrFetchEdges(f.env,{...parsed,signal:cancelled.signal},stats());
  const rejected=assert.rejects(a,{name:'AbortError'});
  const b=api.readOrFetchEdges(f.env,parsed,stats());
  await f.arrived.promise;await turn();cancelled.abort();const providerAborted=f.signals[0].aborted;
  f.indexGate.resolve();await rejected;const edges=await b;
  assert.equal(providerAborted,false,'provider request belongs to the shared fill, not first search');
  assert.equal(edges.beatenByMe.size,6);assert.deepEqual(f.counts,{indexes:1,months:6});
});

test('duplicate top-target archive requests do not cause parallel-provider 429 failures',async()=>{
  const f=fixture(),fetch=globalThis.fetch;let active=0,rateLimited=0;
  globalThis.fetch=async(...args)=>{
    active++;const limited=active>1;
    try { if(limited){await turn();rateLimited++;return new Response('{}',{status:429,headers:{'Retry-After':'90'}});}return await fetch(...args); }
    finally {active--;}
  };
  const pending=[1,2,3].map(()=>api.readOrFetchEdges(f.env,parsed,stats()));
  const settled=Promise.allSettled(pending);
  await f.arrived.promise;await turn();f.indexGate.resolve();
  const results=await settled;
  assert.deepEqual(results.map(result=>result.status),['fulfilled','fulfilled','fulfilled']);
  assert.equal(rateLimited,0);
});

test('delayed subscribers cannot extend the original provider freshness window',async()=>{
  const originalNow=Date.now,originalClone=globalThis.structuredClone;
  let clock=originalNow(),providerObservedAt=0;
  const date=new Date(),month=`${date.getUTCFullYear()}/${String(date.getUTCMonth()+1).padStart(2,'0')}`;
  const url=`https://api.chess.com/pub/player/alpha/games/${month}`,values=new Map();
  const binding={async get(key,options){const raw=values.get(key);return raw==null?null:options==='json'||options?.type==='json'?JSON.parse(raw):raw;},async put(key,value){values.set(key,value);}};
  Date.now=()=>clock;
  // Delivery delay is independent of the upstream response observation.
  globalThis.structuredClone=value=>{clock+=1000;return originalClone(value);};
  globalThis.fetch=async raw=>{
    await turn();
    if(String(raw).endsWith('/games/archives'))return Response.json({archives:[url]});
    providerObservedAt=clock;
    return Response.json({games:[{rules:'chess',white:{username:'alpha',result:'win'},black:{username:'beta',result:'resigned'},url:'https://www.chess.com/game/live/1234',time_class:'blitz',end_time:1700000000}]},{headers:{'Cache-Control':'public,max-age=120'}});
  };
  try {
    const edges=await Promise.all([1,2].map(()=>api.readOrFetchEdges({GAMES_CACHE:binding},parsed,stats())));
    assert.equal(edges[0].archiveCoverage.expiresAt,providerObservedAt+120000);
    assert.equal(edges[1].archiveCoverage.expiresAt,edges[0].archiveCoverage.expiresAt);
  } finally {Date.now=originalNow;globalThis.structuredClone=originalClone;}
});
