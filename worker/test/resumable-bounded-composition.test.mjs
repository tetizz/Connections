import test,{afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {SearchJobObject,__test as api} from '../src/index.js';
const originalFetch=globalThis.fetch;afterEach(()=>{globalThis.fetch=originalFetch;});
const proof=id=>`https://www.chess.com/game/live/${id}`;
const month=(name,m)=>`https://api.chess.com/pub/player/${name}/games/2020/${m}`;
const rawGame=(from,to,id)=>({rules:'chess',white:{username:from,result:'win'},black:{username:to,result:'resigned'},url:proof(id),time_class:'blitz',end_time:1700000000});
// This unit fixture uses real coordinator/reader/hooks/DO actions with controlled
// storage. Separate Root native fixtures qualify Workerd storage and ownership.
class Storage{
 values=new Map();
 async get(k){return Array.isArray(k)?new Map(k.filter(x=>this.values.has(x)).map(x=>[x,structuredClone(this.values.get(x))])):structuredClone(this.values.get(k));}
 async put(k,v){if(typeof k==='object')for(const[n,x]of Object.entries(k))this.values.set(n,structuredClone(x));else this.values.set(k,structuredClone(v));}
 async delete(keys){for(const k of Array.isArray(keys)?keys:[keys])this.values.delete(k);}
 async setAlarm(){}
 async transaction(fn){const before=structuredClone(this.values);try{return await fn(this);}catch(error){this.values=before;throw error;}}
}

test('bounded retry resumes real monthly checkpoint before publishing a directed route while retaining incomplete pending work',async()=>{
 const names=Array.from({length:6},(_,i)=>`frontier${i+1}`),values=new Map(),calls=[],reads=[],writes=[],attempts=new Map(),storage=new Storage();let phase='first';
 const now=Date.now();for(const n of names)values.set(`archives:fetch:v1:${n}`,{schema:1,ts:now,archives:[month(n,'01'),month(n,'02')]});
 const env={GAMES_CACHE:{
  async get(key,options){const keys=Array.isArray(key)?key:[key];reads.push({phase,keys:[...keys]});const read=k=>{const v=values.get(k);return v==null?null:options?.type==='json'?structuredClone(v):JSON.stringify(v);};return Array.isArray(key)?new Map(key.map(k=>[k,read(k)])):read(key);},
  async put(key,value){writes.push({phase,key});values.set(key,JSON.parse(value));},async delete(key){values.delete(key);},async list(){return{keys:[],list_complete:true};}
 }};
 const search={...api.initialSearchState('alpha','omega'),sinceMonth:'0000/01',profileChecked:true,fastLaneChecked:true,incomplete:true,
  activeSide:'forward',activeFrontier:[...names],activeCursor:0,activeNextFrontier:[],forwardFrontier:[],backwardFrontier:['bridge'],
  forwardVisited:{alpha:{prev:'',hopUrl:''},...Object.fromEntries(names.map((n,i)=>[n,{prev:'alpha',hopUrl:proof(1000+i)}]))},
  backwardVisited:{omega:{next:'',hopUrl:''},bridge:{next:'omega',hopUrl:proof(999)}}};
 let job={id:'resumable-bounded-integration',policyVersion:api.SEARCH_POLICY_VERSION,start:'alpha',target:'omega',range:'all',status:'running',createdAt:now-1000,processingToken:'composition-owner',processingUntil:now+60000,stats:{requests:0,fetched:0,cached:0,expanded:0},search};
 const object=new SearchJobObject({storage},env);env.__SEARCH_JOB_LOCAL={id:job.id,object};job=(await object.applyAction('write',{job})).body.job;assert.ok(job);
 globalThis.fetch=async(input,{signal}={})=>{
  assert.equal(signal?.aborted,false);const u=new URL(String(input)),name=u.pathname.split('/')[3],m=u.pathname.split('/').at(-1);assert.ok(names.includes(name));assert.ok(['01','02'].includes(m));
  calls.push({phase,name,month:m});const key=name+':'+m,n=(attempts.get(key)||0)+1;attempts.set(key,n);
  if(names.indexOf(name)<3&&m==='01'&&n===1)return new Response('{}',{status:403,headers:{'Content-Type':'application/json'}});
  const games=name==='frontier1'&&m==='01'?[rawGame(name,'bridge',8001)]:m==='02'?[rawGame(name,'seenopponent',9000+names.indexOf(name))]:[];
  return new Response(JSON.stringify({games}),{headers:{'Content-Type':'application/json','Cache-Control':'public, max-age=300'}});
 };
 async function step(){const result=await api.advanceServerSearch(env,job,job.search,job.stats,async()=>{},{expansionBudget:16,timeBudgetMs:5000,chunkStartedAt:Date.now()});
  const saved=await object.applyAction('update-owned',{token:job.processingToken,patch:{search:JSON.parse(JSON.stringify(job.search)),stats:job.stats}});assert.ok(saved.body.job);job=saved.body.job;return result;}
 const first=await step();assert.equal(first.status,'running');assert.equal(first.chain,null);assert.equal(job.stats.expanded,0);assert.equal(job.stats.requests,3);
 assert.deepEqual(job.search.historyRetryNodes,names.slice(0,3));assert.deepEqual(job.search.activeFrontier.slice(0,3),['frontier4','frontier5','frontier1']);
 for(const name of names.slice(0,3)){
  const manifest=await storage.get(`month-history:v1:${name}:manifest`);assert.ok(manifest);assert.deepEqual(Object.keys(manifest.months),[month(name,'02')]);
  assert.equal(values.has(`edges:${name}:since:0000/01`),false);assert.equal(values.has(`games:${name}:since:0000/01`),false);
 }
 phase='resumed';const second=await step();assert.equal(second.status,'running');assert.equal(second.shortestVerified,false);assert.equal(job.search.incomplete,true);
 assert.deepEqual(second.chain.path,['alpha','frontier1','bridge','omega']);assert.deepEqual(second.chain.hops,[
  {from:'alpha',to:'frontier1',url:proof(1000)},{from:'frontier1',to:'bridge',url:proof(8001)},{from:'bridge',to:'omega',url:proof(999)}]);
 assert.equal(job.stats.requests,6);assert.equal(job.stats.fetched,3);assert.equal(job.stats.expanded,3);assert.equal(job.search.activeSide,'forward');assert.equal(job.search.depth,0);
 const resumedUsers=[...new Set(calls.filter(c=>c.phase==='resumed').map(c=>c.name))];assert.deepEqual(resumedUsers.slice(0,2),['frontier4','frontier5']);assert.ok(resumedUsers.includes('frontier1'));
 assert.equal(calls.filter(c=>c.name==='frontier1'&&c.month==='02').length,1,'completed raw monthly provider body is not repeated');
 assert.equal(reads.filter(r=>r.phase==='resumed').flatMap(r=>r.keys).filter(k=>k==='archive:games:v1:frontier1:2020/02').length,0,'resumed retry bypasses completed raw KV month');
 const completed=['frontier1','frontier4','frontier5'],pending=job.search.activeFrontier.slice(job.search.activeCursor);
 assert.deepEqual([...completed,...pending].sort(),[...names].sort());assert.equal(new Set(pending).size,pending.length);assert.ok(pending.includes('frontier2')&&pending.includes('frontier3')&&pending.includes('frontier6'));
 assert.deepEqual(job.search.historyRetryNodes,['frontier2','frontier3']);assert.ok(job.search.activeNextFrontier.every(n=>!names.includes(n)));
 const complete=await storage.get('month-history:v1:frontier1:manifest');assert.deepEqual(Object.keys(complete.months),[month('frontier1','02'),month('frontier1','01')]);
 assert.ok(writes.some(w=>w.phase==='resumed'&&w.key==='edges:frontier1:since:0000/01'),'only the now-complete retry can publish its complete aggregate');
});