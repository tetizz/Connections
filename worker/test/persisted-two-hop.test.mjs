import test,{afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {SearchJobObject,__test as api} from '../src/index.js';
import {certificateAction,certificateScope} from '../src/two-hop-certificate.js';
const savedFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=savedFetch;});
const month=new Date().toISOString().slice(0,7).replace('-','/');
const clone=v=>v===undefined?undefined:structuredClone(v);
class Storage {
 values=new Map();
 async get(k){return Array.isArray(k)?new Map(k.filter(x=>this.values.has(x)).map(x=>[x,clone(this.values.get(x))])):clone(this.values.get(k));}
 async put(k,v){if(typeof k==='object'){for(const[a,b]of Object.entries(k))this.values.set(a,clone(b));}else this.values.set(k,clone(v));}
 async delete(keys){for(const k of Array.isArray(keys)?keys:[keys])this.values.delete(k);}
 async deleteAll(){this.values.clear();}
 async setAlarm(){}
 async transaction(fn){const old=clone(this.values);try{return await fn(this);}catch(e){this.values=old;throw e;}}
}
const game=(from,to,id)=>({rules:'chess',white:{username:from,result:'win'},black:{username:to,result:'resigned'},url:`https://www.chess.com/game/live/${id}`,time_class:'blitz',end_time:Math.floor(Date.now()/1000)-10,eco:''});
function minimum(edges){const queue=[['alice']],seen=new Set(['alice']);for(let i=0;i<queue.length;i++)for(const[from,to]of edges){if(from!==queue[i].at(-1)||seen.has(to))continue;const p=[...queue[i],to];if(to==='bob')return p.length-1;seen.add(to);queue.push(p);}return null;}
async function fixture({count=830,witness=true,directOld=false,twoTies=false}={}){
 const values=new Map(),calls=[],data=new Map(),storage=new Storage();
 const archive=(name,m)=>`https://api.chess.com/pub/player/${name}/games/${m}`;
 const start=Array.from({length:count},(_,i)=>game('alice',`player${String(i).padStart(4,'0')}`,10000+i));
 const chosen='player0000';
 data.set(archive('alice',month),{games:start});data.set(archive('alice','2020/01'),{games:directOld?[game('alice','bob',50000)]:[]});
 data.set(archive('bob',month),{games:witness?[game(chosen,'bob',60000),...(twoTies?[game(`player${String(count-1).padStart(4,'0')}`,'bob',60001)]:[])]:[]});
 data.set(archive('bob','2020/02'),{games:[]});data.set(archive('bob','2020/01'),{games:[]});
 for(const[name,months]of[['alice',['2020/01',month]],['bob',['2020/01','2020/02',month]]])values.set(`archives:fetch:v1:${name}`,{schema:1,ts:Date.now(),archives:months.map(m=>archive(name,m))});
 const env={GAMES_CACHE:{async get(k,o){calls.push(['kvget',k]);const read=x=>{const v=values.get(x);return v==null?null:o?.type==='json'?clone(v):JSON.stringify(v);};return Array.isArray(k)?new Map(k.map(x=>[x,read(x)])):read(k);},async put(k,v){calls.push(['kvput',k]);values.set(k,JSON.parse(v));},async list(){return{keys:[],list_complete:true};},async delete(k){values.delete(k);}}};
 let object=new SearchJobObject({storage},env);
 env.SEARCH_JOBS={getByName(){return{fetch:(url,options)=>object.fetch(new Request(url,options))};}};
 globalThis.fetch=async raw=>{const url=String(raw);calls.push(['provider',url]);assert.ok(data.has(url),'only admitted months');return new Response(JSON.stringify(data.get(url)),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});};
 const search=api.initialSearchState('alice','bob');Object.assign(search,{sinceMonth:'0000/01',profileChecked:true,fastLaneChecked:true});
 let job={id:'twohop-test-owned-job',policyVersion:api.SEARCH_POLICY_VERSION,start:'alice',target:'bob',range:'all',status:'running',createdAt:Date.now(),processingToken:'first-owner-token',processingUntil:Date.now()+60000,stats:{fetched:0,requests:0,cached:0,expanded:0},search};
 await object.applyAction('write',{job});job=(await object.applyAction('read')).body.job;
 const stats=job.stats;
 async function advance(){const state=job.search;const result=await api.advanceServerSearch(env,job,state,stats,async(message,patch={})=>{const r=await object.applyAction('update-owned',{token:job.processingToken,patch:{search:state,stats,progress:message,...patch}});assert.ok(r.body.job);},{expansionBudget:1,timeBudgetMs:5000,chunkStartedAt:Date.now()});job.search=state;return result;}
 async function resume(){await object.applyAction('update-owned',{token:job.processingToken,patch:{search:job.search,stats,processingUntil:0,processingToken:''}});object=new SearchJobObject({storage},env);job=(await object.applyAction('claim',{token:'resumed-owner-token',leaseMs:60000})).body.job;assert.equal(job.processingToken,'resumed-owner-token');}
 const edges=[...data.values()].flatMap(value=>value.games.map(g=>[g.white.username,g.black.username]));
 return{env,storage,values,calls,data,chosen,advance,resume,job:()=>job,edges,archive};
}
function replay(chain,f){assert.equal(chain.path.length-1,minimum(f.edges));assert.equal(chain.hops.length,chain.path.length-1);for(let i=0;i<chain.hops.length;i++){const h=chain.hops[i];assert.equal(h.from,chain.path[i]);assert.equal(h.to,chain.path[i+1]);const found=[...f.data.values()].flatMap(v=>v.games).find(g=>{const winner=g.white.result==='win'?g.white:g.black,loser=g.white.result==='win'?g.black:g.white;return g.url===h.url&&winner.username===h.from&&loser.username===h.to;});assert.ok(found);assert.equal(h.result,'win');assert.equal(h.color,found.white.username===h.from?'white':'black');assert.equal(h.timeClass,found.time_class);}}
const targetReads=f=>f.calls.filter(c=>c[0]==='provider'&&c[1].includes('/bob/'));

test('complete uncapped certificate survives checkpoint and recreated DO beyond800',async()=>{
 const f=await fixture();assert.equal((await f.advance()).status,'running');assert.equal(f.job().search.incomplete,true);assert.equal(f.job().search.forwardFrontier.length,800);assert.ok(!f.job().search.forwardFrontier.includes(f.chosen));
 const m=await f.storage.get('twohop:v1:manifest');assert.equal(m.complete,true);assert.equal(m.proofCount,830);assert.ok(m.chunks.length>1);assert.equal(m.months.find(r=>r.url.endsWith(month)).kind,'job-current-observation');assert.equal(f.job().search.twoHopInputReady,true);assert.equal(Object.hasOwn(api.publicSearchJob(f.job()),'search'),false);
 await f.resume();const result=await f.advance();assert.equal(result.status,'found');assert.equal(result.shortestVerified,false);assert.equal(result.chain.path[1],f.chosen);replay(result.chain,f);assert.deepEqual(targetReads(f).map(r=>r[1]),[f.archive('bob',month)]);assert.equal(f.values.has('edges:'+api.sharedWindowCacheKey({username:'bob',sinceMonth:'0000/01'})),false);
});
test('oldest direct win overrides2hop and cannot publish partial certificate',async()=>{const f=await fixture({directOld:true});const r=await f.advance();assert.equal(r.status,'found');assert.equal(r.chain.path.length,2);assert.equal(r.shortestVerified,true);assert.equal(await f.storage.get('twohop:v1:manifest'),undefined);replay(r.chain,f);});
test('missing certificate continues original full target scan',async()=>{const f=await fixture();await f.advance();await f.storage.delete('twohop:v1:manifest');await f.resume();await f.advance();assert.equal(targetReads(f).length,3);});
test('changed start index cannot certify absence for newly admitted month',async()=>{const f=await fixture();await f.advance();f.values.get('archives:fetch:v1:alice').archives.unshift(f.archive('alice','2019/12'));await f.resume();await f.advance();assert.equal(targetReads(f).length,3);});
test('missing or corrupt proof chunk falls back to original target scan',async()=>{for(const change of['missing','corrupt']){const f=await fixture();await f.advance();if(change==='missing')await f.storage.delete('twohop:v1:chunk:000');else await f.storage.put('twohop:v1:chunk:000','[]');await f.resume();await f.advance();assert.equal(targetReads(f).length,3);}});
test('no intersection still consumes every target month',async()=>{const f=await fixture({witness:false});await f.advance();await f.resume();assert.notEqual((await f.advance()).status,'found');assert.equal(targetReads(f).length,3);});
test('stale owner or wrong scope cannot commit certificate',async()=>{const f=await fixture();await f.advance();const manifest=await f.storage.get('twohop:v1:manifest');const chunks=await Promise.all(manifest.chunks.map((_,i)=>f.storage.get(`twohop:v1:chunk:${String(i).padStart(3,'0')}`)));const input={scope:certificateScope(f.job()),token:'wrong-owner-token',package:{manifest,chunks}};assert.equal((await certificateAction(f.storage,'twohop-commit',input)).accepted,false);input.token=f.job().processingToken;input.scope={...input.scope,target:'other'};assert.equal((await certificateAction(f.storage,'twohop-commit',input)).accepted,false);});
test('failed storage transaction cannot expose complete manifest or partial chunks',async()=>{const f=await fixture();const saved=f.storage.put.bind(f.storage);f.storage.put=async(k,v)=>{await saved(k,v);if(typeof k==='object'&&Object.keys(k).some(n=>n.startsWith('twohop:')))throw new Error('fixture storage failure');};await f.advance();assert.equal(await f.storage.get('twohop:v1:manifest'),undefined);assert.equal([...f.storage.values.keys()].some(k=>k.startsWith('twohop:')),false);});
test('expired historical evidence cannot authorize target early stop',async()=>{const f=await fixture();await f.advance();const m=await f.storage.get('twohop:v1:manifest');m.months.find(r=>r.kind==='historical').expiresAt=0;await f.storage.put('twohop:v1:manifest',m);await f.resume();await f.advance();assert.equal(targetReads(f).length,3);});
test('equal-depth witnesses qualify by independentBFS and proof replay',async()=>{const f=await fixture({twoTies:true});await f.advance();await f.resume();const r=await f.advance();assert.equal(r.status,'found');replay(r.chain,f);});
test('failed partial start scan never commits complete certificate',async()=>{const f=await fixture();f.data.set(f.archive('alice','2020/01'),{games:null});assert.equal((await f.advance()).status,'running');assert.equal(await f.storage.get('twohop:v1:manifest'),undefined);});
test('abort during original start body prevents complete certificate publication',async()=>{
 const f=await fixture(),controller=new AbortController(),fetch=globalThis.fetch;
 globalThis.fetch=async(input,options)=>{const response=await fetch(input,options);if(String(input).endsWith('2020/01')){const json=response.json.bind(response);response.json=async()=>{const value=await json();controller.abort(new Error('fixture cancelled'));return value;};}return response;};
 const reader=api.createSearchEdgeReader(f.env,f.job(),f.job().stats);
 await assert.rejects(reader.read('alice',controller.signal),/fixture cancelled/);
 assert.equal(await f.storage.get('twohop:v1:manifest'),undefined);
});
test('abort before target witness cannot escape as a successful result',async()=>{
 const f=await fixture();await f.advance();await f.resume();const controller=new AbortController(),fetch=globalThis.fetch;
 globalThis.fetch=async(input,options)=>{const response=await fetch(input,options);if(String(input).includes('/bob/')){const json=response.json.bind(response);response.json=async()=>{const value=await json();controller.abort(new Error('target cancelled'));return value;};}return response;};
 const reader=api.createSearchEdgeReader(f.env,f.job(),f.job().stats);
 await assert.rejects(reader.read('bob',controller.signal),/target cancelled/);
});
test('lost owner cannot read even a complete certificate',async()=>{
 const f=await fixture();await f.advance();await f.resume();
 assert.equal((await certificateAction(f.storage,'twohop-read',{scope:certificateScope(f.job()),token:'first-owner-token'})).accepted,false);
});
test('invalid target game proof does not authorize partial-history result',async()=>{
 const f=await fixture();await f.advance();f.data.get(f.archive('bob',month)).games[0].url='https://example.invalid/not-a-game';await f.resume();await f.advance();assert.equal(targetReads(f).length,3);
});
test('certificate from a different job cannot be reused',async()=>{
 const f=await fixture();await f.advance();
 const input={scope:{...certificateScope(f.job()),id:'different-owned-job'},token:f.job().processingToken};
 assert.equal((await certificateAction(f.storage,'twohop-read',input)).accepted,false);
});
test('oversized uncapped evidence falls back without truncating a complete certificate',async()=>{
 const f=await fixture({count:15000});assert.equal((await f.advance()).status,'running');
 assert.equal(await f.storage.get('twohop:v1:manifest'),undefined);
 assert.equal(f.job().search.forwardFrontier.length,800);
 assert.equal(f.job().search.incomplete,true);
});
test('both black-side game proofs preserve complete metadata across continuation',async()=>{
 const f=await fixture();
 for(const [name,opponent]of[['alice',f.chosen],[f.chosen,'bob']]){
  const rows=name==='alice'?f.data.get(f.archive('alice',month)).games:f.data.get(f.archive('bob',month)).games;
  const g=rows.find(g=>g.white.username===name&&g.black.username===opponent);
  g.white={username:opponent,result:'resigned'};g.black={username:name,result:'win'};
 }
 await f.advance();await f.resume();const r=await f.advance();assert.equal(r.status,'found');replay(r.chain,f);
 assert.deepEqual(r.chain.hops.map(h=>h.color),['black','black']);
});

for (const stage of ['begin','month','finish','digest']) test(`optional ${stage} rejection preserves ordinary complete traversal`,async t=>{
 const f=await fixture();let injected=0;
 if(stage==='begin'||stage==='month'){
  const encode=TextEncoder.prototype.encode;
  t.mock.method(TextEncoder.prototype,'encode',function(value){
   const hit=typeof value==='string'&&(stage==='begin'?value.startsWith('["https://api.chess.com/pub/player/alice/games/'):value.startsWith('{"from":"alice","to":"'));
   if(hit){injected++;throw new Error(`fixture ${stage} failure`);}
   return encode.call(this,value);
  });
 }else if(stage==='finish'){
  const values=Map.prototype.values;
  t.mock.method(Map.prototype,'values',function(){
   const row=this.get('player0000');
   if(row?.from==='alice'&&row?.to==='player0000'){injected++;throw new Error('fixture finish failure');}
   return values.call(this);
  });
 }else {
  const nativeDigest=crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(crypto.subtle,'digest',async(algorithm,bytes)=>{
   const payload=new TextDecoder().decode(bytes);
   // Select certificate proof semantics independently of proof enumeration order.
   let rows;try{rows=JSON.parse(payload);}catch{}
   const certificateChunk=Array.isArray(rows)&&rows.length>0&&rows.every(row=>
    row&&typeof row==='object'&&row.from==='alice'&&/^player\d{4}$/.test(row.to)&&
    /^https:\/\/www\.chess\.com\/game\/live\/[1-9]\d*$/.test(row.url)&&
    row.result==='win'&&['white','black'].includes(row.color)&&row.timeClass==='blitz');
   if(certificateChunk&&injected===0){
    injected++;throw new Error('fixture digest failure');
   }
   return nativeDigest(algorithm,bytes);
  });
 }
 const result=await f.advance();
 assert.equal(injected,1,'the requested optional stage was actually reached once');
 assert.equal(result.status,'running');assert.equal(f.job().search.forwardFrontier.length,800);
 assert.equal(f.job().search.incomplete,true);assert.notEqual(f.job().search.twoHopInputReady,true);
 assert.equal(await f.storage.get('twohop:v1:manifest'),undefined);
 await f.resume();await f.advance();assert.equal(targetReads(f).length,3,'ordinary target traversal remains complete');
});

test('parent abort raised by an optional hook is not converted into fallback',async t=>{
 const f=await fixture(),controller=new AbortController(),reason=new Error('fixture parent cancellation');let injected=0;
 const encode=TextEncoder.prototype.encode;
 t.mock.method(TextEncoder.prototype,'encode',function(value){
  if(typeof value==='string'&&value.startsWith('["https://api.chess.com/pub/player/alice/games/')){injected++;controller.abort(reason);throw new Error('optional hook failure');}
  return encode.call(this,value);
 });
 const reader=api.createSearchEdgeReader(f.env,f.job(),f.job().stats);
 await assert.rejects(reader.read('alice',controller.signal),error=>error===reason);
 assert.equal(injected,1);assert.equal(await f.storage.get('twohop:v1:manifest'),undefined);
});
test('shared monthly adjacency preserves complete recent-first proof order and repeated opponent URL selection',async()=>{
 const f=await fixture({count:3});const rows=f.data.get(f.archive('alice',month)).games;rows[0].end_time=10;rows[1].end_time=20;rows[2].end_time=20;const recent=game('alice','player0000',70000);recent.end_time=30;rows.push(recent,{...recent});
 await f.advance();const read=await certificateAction(f.storage,'twohop-read',{scope:certificateScope(f.job()),token:f.job().processingToken});assert.equal(read.accepted,true);const proofs=read.package.chunks.flatMap(s=>JSON.parse(s));assert.deepEqual(proofs.map(p=>[p.to,p.url]),[['player0000','https://www.chess.com/game/live/70000'],['player0002','https://www.chess.com/game/live/10002'],['player0001','https://www.chess.com/game/live/10001']]);await f.resume();const r=await f.advance();assert.equal(r.status,'found');assert.equal(r.chain.hops[0].url,'https://www.chess.com/game/live/70000');replay(r.chain,f);
});
test('an invalid winning row invalidates certificate even when a valid recent URL for that opponent exists',async()=>{
 const f=await fixture({count:3});const rows=f.data.get(f.archive('alice',month)).games;rows.push({...game('alice','player0000',70001),url:'https://example.invalid/game',end_time:1});await f.advance();assert.equal(await f.storage.get('twohop:v1:manifest'),undefined);assert.equal(f.job().search.twoHopInputReady,undefined);await f.resume();await f.advance();assert.equal(targetReads(f).length,3);
});