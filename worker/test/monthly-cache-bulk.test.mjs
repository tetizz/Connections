import assert from 'node:assert/strict';
import test,{afterEach} from 'node:test';
import {__test} from '../src/index.js';
const originalFetch=globalThis.fetch,originalNow=Date.now;
afterEach(()=>{globalThis.fetch=originalFetch;Date.now=originalNow;});
const base='https://api.chess.com/pub/player/alice/games/';
const url=n=>base+'2020/'+String(n).padStart(2,'0');
const key=n=>'archive:games:v1:alice:2020/'+String(n).padStart(2,'0');
const args={username:'alice',archiveLimit:Infinity,sinceMonth:'2020/01'};
const clone=v=>v==null?null:JSON.parse(JSON.stringify(v));
const game=n=>({white:'alice',black:'bob',whiteResult:'win',blackResult:'resigned',url:'https://www.chess.com/game/live/'+n,timeClass:'blitz',endTime:1578000000,opening:''});
function fixture(count=10){
 const values=new Map(),calls=[],provider=[];let bulkHook=null;
 values.set('archives:fetch:v1:alice',{schema:1,ts:Date.now(),archives:Array.from({length:count},(_,i)=>url(i+1))});
 for(let i=1;i<=count;i++)values.set(key(i),{schema:1,url:url(i),expiresAt:Date.now()+600000,games:[game(i)]});
 const kv={async get(k,options){calls.push({key:k,options});if(Array.isArray(k)){if(bulkHook)return bulkHook(k);return new Map(k.map(x=>[x,clone(values.get(x))]));}return clone(values.get(k));},async put(k,v){values.set(k,JSON.parse(v));}};
 globalThis.fetch=async u=>{provider.push(String(u));const n=Number(String(u).slice(-2));return new Response(JSON.stringify({games:[{rules:'chess',white:{username:'alice',result:'win'},black:{username:'bob',result:'resigned'},url:game(n).url,time_class:'blitz',end_time:1578000000,eco:''}]}),{headers:{'Content-Type':'application/json'}});};
 return {values,calls,provider,env:{GAMES_CACHE:kv},setBulk:f=>{bulkHook=f;},monthly:()=>calls.filter(r=>Array.isArray(r.key)||r.key.startsWith('archive:games:'))};
}

test('native Map groups preserve options, four-key bound and exact archive order',async()=>{
 const f=fixture(),rows=await __test.fetchGames(args,f.env);
 assert.deepEqual(rows,Array.from({length:10},(_,i)=>game(i+1)));
 assert.deepEqual(f.monthly().map(r=>r.key),[key(1),[2,3,4,5].map(key),[6,7,8,9].map(key),key(10)]);
 for(const r of f.monthly())assert.deepEqual(r.options,{type:'json',cacheTtl:60});assert.equal(f.provider.length,0);
});

test('first selected direct proof starts no later group',async()=>{
 const f=fixture();f.values.get(key(10)).games[0].black='target';
 await assert.rejects(__test.fetchGames({...args,directTarget:'target'},f.env),{name:'DirectWinFound'});
 assert.deepEqual(f.monthly().map(r=>r.key),[key(10)]);assert.equal(f.provider.length,0);
});

test('later-group direct proof consumes in order and starts no next group',async()=>{
 const f=fixture();f.values.get(key(8)).games[0].black='target';const observed=[];
 await assert.rejects(__test.fetchGames({...args,directTarget:'target',onGames:g=>observed.push(g[0].url)},f.env),{name:'DirectWinFound'});
 assert.deepEqual(observed,[game(10).url,game(9).url]);
 assert.deepEqual(f.monthly().map(r=>r.key),[key(10),[9,8,7,6].map(key)]);
});

test('mixed missing malformed and expired records retain sequential provider order',async()=>{
 const f=fixture(5);f.values.delete(key(2));f.values.get(key(3)).expiresAt=0;f.values.get(key(4)).games=[{}];
 const rows=await __test.fetchGames(args,f.env);assert.deepEqual(rows.map(g=>g.url),[1,2,3,4,5].map(n=>game(n).url));
 assert.deepEqual(f.provider,[url(2),url(3),url(4)]);
});

test('prefetched record expiry is rechecked after an earlier provider await',async()=>{
 const f=fixture(5),now=Date.now();f.values.delete(key(2));f.values.get(key(3)).expiresAt=now+100;
 const fetch=globalThis.fetch;globalThis.fetch=async(...a)=>{const r=await fetch(...a);Date.now=()=>now+200;return r;};
 await __test.fetchGames(args,f.env);assert.deepEqual(f.provider,[url(2),url(3)]);
});

test('throw, 413 and non-Map each disable bulk and reread the group as ordered singles',async t=>{
 for(const mode of ['throw','413','nonMap'])await t.test(mode,async()=>{
  const f=fixture(10);f.setBulk(()=>{if(mode==='nonMap')return {};throw Object.assign(new Error('fixed bulk failure'),{status:mode==='413'?413:500});});
  const rows=await __test.fetchGames(args,f.env);assert.equal(rows.length,10);
  assert.equal(f.monthly().filter(r=>Array.isArray(r.key)).length,1);
  assert.deepEqual(f.monthly().filter(r=>!Array.isArray(r.key)).map(r=>r.key),Array.from({length:10},(_,i)=>key(i+1)));
 });
});

test('abort during bulk propagates before fallback and coverage publication',async()=>{
 const f=fixture(5),controller=new AbortController();let coverage=0;
 f.setBulk(()=>{controller.abort(new DOMException('owned','AbortError'));throw new Error('bulk stopped');});
 await assert.rejects(__test.fetchGames({...args,signal:controller.signal,onCoverage:()=>coverage++},f.env),{name:'AbortError'});
 assert.equal(f.monthly().length,2);assert.equal(f.provider.length,0);assert.equal(coverage,0);
});

test('abort between group members prevents later callbacks and provider work',async()=>{
 const f=fixture(5),controller=new AbortController(),seen=[];let coverage=0;
 await assert.rejects(__test.fetchGames({...args,signal:controller.signal,onGames:g=>{seen.push(g[0].url);if(seen.length===2)controller.abort(new DOMException('owned','AbortError'));},onCoverage:()=>coverage++},f.env),{name:'AbortError'});
 assert.deepEqual(seen,[game(1).url,game(2).url]);assert.equal(f.monthly().length,2);assert.equal(f.provider.length,0);assert.equal(coverage,0);
});

test('streamed edges retain newest-first callbacks and complete nonenumerable coverage',async()=>{
 const f=fixture(5),seen=[];let coverage;
 const rows=await __test.fetchGames({...args,collectGames:false,onGames:g=>seen.push(g[0].url),onCoverage:c=>coverage=c},f.env);
 assert.deepEqual(rows,[]);assert.deepEqual(seen,[5,4,3,2,1].map(n=>game(n).url));assert.equal(coverage.sinceMonth,'2020/01');assert.ok(coverage.expiresAt>Date.now());assert.equal(rows.archiveCoverage.sinceMonth,'2020/01');assert.equal(Object.keys(rows).includes('archiveCoverage'),false);
});

test('duplicate URLs disable every bulk read and preserve duplicate callbacks/output',async()=>{
 const f=fixture(5);f.values.get('archives:fetch:v1:alice').archives.splice(2,0,url(2));const seen=[];
 const rows=await __test.fetchGames({...args,onGames:g=>seen.push(g[0].url)},f.env);
 assert.equal(f.monthly().some(r=>Array.isArray(r.key)),false);assert.deepEqual(rows.map(g=>g.url),[1,2,2,3,4,5].map(n=>game(n).url));assert.deepEqual(seen,rows.map(g=>g.url));assert.equal(f.monthly().filter(r=>r.key===key(2)).length,2);
});
