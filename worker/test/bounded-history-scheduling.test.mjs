import test,{afterEach} from 'node:test';import assert from 'node:assert/strict';
import {__test as bounded} from '../src/index.js';
const nativeFetch=globalThis.fetch;afterEach(()=>{globalThis.fetch=nativeFetch;});
const proof=id=>`https://www.chess.com/game/live/${id}`;
const month=name=>`https://api.chess.com/pub/player/${name}/games/2020/01`;
function fixture(api=bounded,{count=279,failOnce=true,permanent=false,route=true,rate=false}={}){
 const names=Array.from({length:count},(_,i)=>`frontier${i+1}`),failed=new Set(names.slice(0,3)),values=new Map(),calls=[],attempts=new Map(),settled=[];
 for(const name of names)values.set(`archives:fetch:v1:${name}`,{schema:1,ts:Date.now(),archives:[month(name)]});
 const env={GAMES_CACHE:{async get(key,options){const read=k=>{const v=values.get(k);return v==null?null:options?.type==='json'?structuredClone(v):JSON.stringify(v);};return Array.isArray(key)?new Map(key.map(k=>[k,read(k)])):read(key);},async put(key,value){values.set(key,JSON.parse(value));},async delete(key){values.delete(key);},async list(){return{keys:[],list_complete:true};}}};
 const search={...api.initialSearchState('alpha','omega'),sinceMonth:'0000/01',profileChecked:true,fastLaneChecked:true,incomplete:true,activeSide:'forward',activeFrontier:[...names],activeCursor:0,activeNextFrontier:[],forwardFrontier:[],backwardFrontier:['bridge'],forwardVisited:{alpha:{prev:'',hopUrl:''},...Object.fromEntries(names.map((name,i)=>[name,{prev:'alpha',hopUrl:proof(1000+i)}]))},backwardVisited:{omega:{next:'',hopUrl:''},bridge:{next:'omega',hopUrl:proof(999)}}};
 let job={id:'bounded-history-scheduler',createdAt:Date.now(),updatedAt:Date.now(),status:'running',start:'alpha',target:'omega',range:'all',policyVersion:api.SEARCH_POLICY_VERSION,search};const stats={requests:0,fetched:0,cached:0,expanded:0};
 function install(){globalThis.fetch=async(input,{signal}={})=>{const name=names.find(n=>month(n)===String(input));assert.ok(name,'only admitted synthetic monthly requests');assert.equal(signal?.aborted,false);calls.push(name);const n=(attempts.get(name)||0)+1;attempts.set(name,n);try{
  if(rate)return new Response('{}',{status:429,headers:{'Content-Type':'application/json','Retry-After':'90'}});
  if((permanent&&failed.has(name))||(failOnce&&failed.has(name)&&n===1))return new Response('{}',{status:403,headers:{'Content-Type':'application/json'}});
  const games=route&&name===names[0]?[{rules:'chess',white:{username:name,result:'win'},black:{username:'bridge',result:'resigned'},url:proof(8001),time_class:'blitz',end_time:1700000000}]:[];
  return new Response(JSON.stringify({games}),{headers:{'Content-Type':'application/json','Cache-Control':'public, max-age=300'}});
 }finally{settled.push(name);}};}
 async function step(extra={}){install();const result=await api.advanceServerSearch(env,job,job.search,stats,async()=>{},{expansionBudget:16,timeBudgetMs:5000,chunkStartedAt:Date.now(),...extra});assert.equal(settled.length,calls.length,'all started provider callbacks settled');job=api.searchJobShape({...job,stats,search:JSON.parse(JSON.stringify(job.search))});assert.ok(job);return result;}
 return{names,failed,values,calls,attempts,settled,stats,env,step,get job(){return job;}};
}
function partition(f){const pending=f.job.search.activeFrontier.slice(f.job.search.activeCursor);assert.equal(new Set(pending).size,pending.length);assert.ok(pending.every(n=>f.names.includes(n)));for(const n of f.names.filter(n=>!f.attempts.has(n)||f.failed.has(n)))assert.ok(pending.includes(n));assert.equal(f.job.search.depth,0);assert.equal(f.job.search.activeSide,'forward');}

test('279-node actual reader reserves two upcoming attempts and one healthy retry before global budget',async()=>{
 const f=fixture();await f.step();assert.deepEqual(f.calls,f.names.slice(0,3));assert.deepEqual(f.job.search.activeFrontier.slice(0,3),['frontier4','frontier5','frontier1']);
 const r=await f.step();assert.deepEqual(f.calls.slice(3,6),['frontier4','frontier5','frontier1']);assert.equal(f.attempts.get('frontier1'),2);assert.ok(f.stats.requests<160);assert.deepEqual(r.chain.path,['alpha','frontier1','bridge','omega']);assert.equal(r.shortestVerified,false);assert.equal(f.job.search.depth,0);
});
test('permanent failures receive bounded repeated opportunities while untouched work continues across persisted chunks',async()=>{
 const f=fixture(bounded,{permanent:true,route:false});for(let i=0;i<12;i++){const r=await f.step();assert.equal(r.status,'running');partition(f);}
 assert.ok(f.attempts.get('frontier1')>=2);assert.ok(f.attempts.get('frontier2')>=2);assert.ok(f.attempts.get('frontier3')>=2);assert.ok(f.calls.some(n=>Number(n.slice(8))>=15));assert.ok(f.job.search.incomplete);assert.ok(f.stats.requests<160);
});
test('all-error layer rotates retries without losing a node or advancing root/depth',async()=>{
 const f=fixture(bounded,{count:12,permanent:true,route:false});for(const n of f.names)f.failed.add(n);for(let i=0;i<12;i++){const r=await f.step();assert.equal(r.status,'running');partition(f);}
 assert.ok(f.names.every(n=>f.attempts.has(n)));assert.ok([...f.attempts.values()].some(n=>n>=2));assert.equal(f.stats.expanded,0);assert.equal(f.job.search.activeFrontier.length,12);assert.deepEqual(f.job.search.forwardVisited.alpha,{prev:'',hopUrl:''});
});
test('actual429 preserves global pause, pending order and prevents new calls while rate cache is active',async()=>{
 const f=fixture(bounded,{count:18,rate:true,route:false});const r=await f.step();assert.equal(r.status,'running');assert.equal(r.pauseMs,90000);assert.deepEqual(f.job.search.activeFrontier,f.names);const before=f.calls.length;assert.ok(before>=1&&before<=2);const next=await f.step();assert.equal(next.status,'running');assert.ok(next.pauseMs>0);assert.equal(f.calls.length,before);partition(f);
});
test('chunk-budget-only deferrals remain unattempted and never become history retries',async()=>{
 const f=fixture(bounded,{count:18,failOnce:false,route:false});await f.step();assert.equal(f.stats.requests,3);assert.deepEqual(f.job.search.historyRetryNodes,[]);assert.deepEqual(f.job.search.activeFrontier,f.names.slice(3));await f.step();assert.deepEqual(f.calls,f.names.slice(0,6));assert.deepEqual(f.job.search.historyRetryNodes,[]);
});
test('mixed timeout and chunk deferrals retain queues and joining while429 keeps original pending priority',async()=>{
 const f=fixture(bounded,{count:6,route:false});const done=[];const reasons=['upstream-timeout','chunk-request-limit','upstream-error','cache-unavailable','rate-limited','chunk-request-limit'];
 const r=await f.step({edgeReader:{async prime(){},async read(node){try{return{deferred:true,reason:reasons[f.names.indexOf(node)],retryAfter:node==='frontier5'?90:0};}finally{done.push(node);}}}});
 assert.equal(r.pauseMs,90000);assert.deepEqual(f.job.search.activeFrontier,f.names);assert.deepEqual(f.job.search.historyRetryNodes,['frontier1','frontier3']);assert.deepEqual(done,f.names);assert.equal(f.stats.requests,0);partition(f);
});
test('unchanged actual global cap remains terminal with exact pending/completed partition and no false completeness',async()=>{
 const f=fixture(bounded,{permanent:true,route:false});let r;for(let i=0;i<100;i++){r=await f.step();if(r.status!=='running')break;}
 assert.equal(r.status,'timeout');assert.equal(r.shortestVerified,false);assert.ok(f.stats.requests>=160&&f.stats.requests<=161);assert.ok(f.attempts.get('frontier1')>=2);partition(f);
 const pending=f.job.search.activeFrontier.slice(f.job.search.activeCursor),completed=f.names.filter(n=>f.attempts.has(n)&&!f.failed.has(n));assert.equal(completed.length,f.stats.expanded);assert.equal(pending.length,279-f.stats.expanded);assert.deepEqual([...pending,...completed].sort(),[...f.names].sort());assert.ok(f.job.search.incomplete);
});


test('all16 confirmed complete primed hits retain wide cached processing despite persisted retries',async()=>{
 const f=fixture(bounded,{count:18,failOnce:false,route:false});const ts=Date.now();
 f.job.search.historyRetryNodes=['frontier3','frontier6','frontier9'];
 for(const name of f.names)f.values.set(`edges:${name}:since:0000/01`,{schema:2,ts,coverage:{sinceMonth:'0000/01',expiresAt:ts+3600000},edges:{truncated:false,beatenByMe:name==='frontier18'?[['bridge',[proof(8001)]]]:[],beatMe:[]}});
 const original=f.env.GAMES_CACHE.get,reads=[];let active=0,peak=0;
 f.env.GAMES_CACHE.get=async(...args)=>{reads.push(args[0]);active++;peak=Math.max(peak,active);try{return await original(...args);}finally{active--;}};
 const r=await f.step({expansionBudget:512});
 assert.equal(r.status,'found');assert.deepEqual(r.chain.path,['alpha','frontier18','bridge','omega']);assert.equal(r.shortestVerified,false);
 assert.equal(f.calls.length,0);assert.equal(f.stats.requests,0);assert.equal(f.stats.fetched,0);assert.equal(f.stats.cached,18);assert.equal(f.stats.expanded,18);assert.equal(reads.length,18);assert.equal(active,0);assert.equal(peak,16,'trusted complete warm hits preserve original sixteen-reader priming width');
 assert.deepEqual(reads,f.names.map(name=>`edges:${name}:since:0000/01`));
});
