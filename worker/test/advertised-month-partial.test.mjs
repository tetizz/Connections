import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {SearchJobObject, __test as api} from '../src/index.js';

// Controlled correctness inputs only. These are actual production functions,
// not provider-quality or native latency evidence.
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const copy = value => value === undefined ? undefined : structuredClone(value);
const url = (name, month) => `https://api.chess.com/pub/player/${name}/games/${month}`;
const game = (from, to, id) => ({rules:'chess', white:{username:from,result:'win'},
  black:{username:to,result:'resigned'}, url:`https://www.chess.com/game/live/${id}`,
  time_class:'blitz', end_time:1700000000, eco:''});
class Storage {
  values = new Map();
  async get(key) { return Array.isArray(key)
    ? new Map(key.filter(k => this.values.has(k)).map(k => [k,copy(this.values.get(k))]))
    : copy(this.values.get(key)); }
  async put(key,value) { if(typeof key === 'object') for(const [k,v] of Object.entries(key)) this.values.set(k,copy(v)); else this.values.set(key,copy(value)); }
  async delete(keys) { for(const key of Array.isArray(keys) ? keys : [keys]) this.values.delete(key); }
  async setAlarm() {}
  async transaction(fn) { const before=copy(this.values); try { return await fn(this); } catch(error) { this.values=before; throw error; } }
}
async function fixture() {
  const values=new Map(), writes=[], calls=[], data=new Map(), statuses=new Map(), storage=new Storage();
  for(const name of ['alice','bob','middle','padding']) {
    const months=['2020/01','2020/02','2020/03'];
    values.set(`archives:fetch:v1:${name}`,{schema:1,ts:Date.now(),archives:months.map(m=>url(name,m))});
    for(const m of months) data.set(url(name,m),{games:[]});
  }
  data.set(url('alice','2020/01'),{games:[game('alice','middle',1001),game('alice','padding',1002),game('other','alice',1003)]});
  data.set(url('bob','2020/01'),{games:[game('middle','bob',2001)]});
  const env={GAMES_CACHE:{
    async get(key,options) {
      const read=k=>{const value=values.get(k);return value==null?null:options?.type==='json'?copy(value):JSON.stringify(value);};
      return Array.isArray(key)?new Map(key.map(k=>[k,read(k)])):read(key);
    },
    async put(key,value,options) { writes.push({key,value:JSON.parse(value),options:copy(options)});values.set(key,JSON.parse(value)); },
    async delete(key) {values.delete(key);}, async list(){return{keys:[],list_complete:true};}
  }};
  let object=new SearchJobObject({storage},env);
  env.SEARCH_JOBS={getByName(){return{fetch:(input,options)=>object.fetch(new Request(input,options))};}};
  globalThis.fetch=async(input,options)=>{
    const key=String(input);calls.push(key);assert.ok(data.has(key),`unadmitted fixture request ${key}`);
    if(options?.signal?.aborted) throw options.signal.reason;
    return new Response(JSON.stringify(statuses.has(key)?{code:0,message:'provider internal error'}:data.get(key)),{
      status:statuses.get(key)||200,headers:{'Content-Type':'application/json','Cache-Control':'public, max-age=300','Retry-After':statuses.get(key)===429?'90':'0'}
    });
  };
  const search=api.initialSearchState('alice','bob');Object.assign(search,{sinceMonth:'0000/01',profileChecked:true,fastLaneChecked:true});
  let job={id:'advertised-partial-job',policyVersion:api.SEARCH_POLICY_VERSION,start:'alice',target:'bob',range:'all',status:'running',
    createdAt:Date.now(),processingToken:'first-owner',processingUntil:Date.now()+60000,stats:{fetched:0,requests:0,cached:0,expanded:0},search};
  await object.applyAction('write',{job});job=(await object.applyAction('read')).body.job;
  async function advance() {
    return api.advanceServerSearch(env,job,job.search,job.stats,async(message,patch={})=>{
      const result=await object.applyAction('update-owned',{token:job.processingToken,patch:{search:job.search,stats:job.stats,progress:message,...patch}});
      assert.ok(result.body.job);
    },{expansionBudget:1,timeBudgetMs:5000,chunkStartedAt:Date.now()});
  }
  async function resume() {
    await object.applyAction('update-owned',{token:job.processingToken,patch:{search:job.search,stats:job.stats,processingUntil:0,processingToken:''}});
    object=new SearchJobObject({storage},env);
    job=(await object.applyAction('claim',{token:'second-owner',leaseMs:60000})).body.job;
  }
  return {env,values,writes,calls,data,statuses,storage,advance,resume,job:()=>job,
    reader:()=>api.createSearchEdgeReader(env,job,job.stats)};
}
function noAggregates(f,name='alice') {
  assert.equal(f.writes.some(w=>w.key===`games:${name}:since:0000/01`||w.key===`edges:${name}:since:0000/01`),false);
}
function replay(chain,f) {
  assert.deepEqual(chain.path,['alice','middle','bob']);
  assert.equal(chain.hops.length,2);
  for(let i=0;i<2;i++) {
    const hop=chain.hops[i], raw=[...f.data.values()].flatMap(r=>r.games||[]).find(g=>g.url===hop.url);
    assert.ok(raw);assert.equal(raw.white.username,hop.from);assert.equal(raw.black.username,hop.to);
    assert.equal(hop.from,chain.path[i]);assert.equal(hop.to,chain.path[i+1]);
  }
}

for(const status of [404,410]) test(`advertised ${status} keeps older rich winning/losing edges without complete cache or certificate`,async()=>{
  const f=await fixture();f.statuses.set(url('alice','2020/03'),status);
  const result=await f.reader().read('alice');
  assert.equal(result.incomplete,true);assert.equal(f.job().search.incomplete,true);
  assert.deepEqual([...result.edges.beatenByMe.keys()],['padding','middle']);
  assert.deepEqual([...result.edges.beatMe.keys()],['other']);
  assert.deepEqual(f.calls,[url('alice','2020/03'),url('alice','2020/02'),url('alice','2020/01')]);
  assert.equal(result.edges.archiveCoverage.expiresAt,0);noAggregates(f);
  assert.equal(await f.storage.get('twohop:v1:manifest'),undefined);
  const healthy=f.writes.find(w=>w.key==='archive:games:v1:alice:2020/01');
  assert.ok(healthy);assert.equal(healthy.value.games.length,3);
  assert.ok(healthy.value.expiresAt>Date.now());assert.ok(healthy.options.expirationTtl>=60);
  const again=await f.reader().read('alice');assert.equal(again.incomplete,true);
  assert.equal(f.calls.filter(c=>c===url('alice','2020/03')).length,2,'one unavailable attempt per separate expansion, no negative cache');
});

test('root partial expansion still finds an older healthy two-hop route without shortest claim',async()=>{
  const f=await fixture();f.statuses.set(url('alice','2020/03'),404);
  let result;for(let i=0;i<10;i++){result=await f.advance();if(result.status!=='running')break;}
  assert.equal(result.status,'found');assert.equal(result.shortestVerified,false);replay(result.chain,f);
  assert.equal(f.job().search.incomplete,true);noAggregates(f);
  assert.equal(f.calls.filter(c=>c===url('alice','2020/03')).length,1);
});

test('complete root certificate permits positive target witness after target hole and persists incomplete before early return',async()=>{
  const f=await fixture();assert.equal((await f.advance()).status,'running');
  assert.equal((await f.storage.get('twohop:v1:manifest')).complete,true);
  await f.resume();f.statuses.set(url('bob','2020/03'),404);
  const result=await f.advance();assert.equal(result.status,'found');replay(result.chain,f);
  assert.equal(result.shortestVerified,false);assert.equal(f.job().search.incomplete,true);noAggregates(f,'bob');
  assert.deepEqual(f.calls.filter(c=>c.includes('/bob/')),[url('bob','2020/03'),url('bob','2020/02'),url('bob','2020/01')]);
  await f.resume();assert.equal(f.job().search.incomplete,true);
  const publicJob=api.publicSearchJob(f.job()),mirror=api.publicSearchJobShape(publicJob);
  assert.equal(publicJob.incomplete,true);assert.equal(mirror.incomplete,true);
  assert.match(publicJob.progress,/Some game history was not fully checked/);
});

test('all advertised months unavailable ends incomplete timeout, not false not_found or complete negative evidence',async()=>{
  const f=await fixture();for(const key of f.data.keys())f.statuses.set(key,404);
  let result;for(let i=0;i<10;i++){result=await f.advance();if(result.status!=='running')break;}
  assert.equal(result.status,'timeout');assert.equal(f.job().search.incomplete,true);
  assert.equal(await f.storage.get('twohop:v1:manifest'),undefined);noAggregates(f);
  for(const key of new Set(f.calls))assert.equal(f.calls.filter(c=>c===key).length,1);
  assert.equal(f.writes.some(w=>w.key.startsWith('archive:games:')),false);
});

test('missing newest month then older direct proof marks incomplete before direct branch while preserving absolute one-hop bound',async()=>{
  const f=await fixture();f.statuses.set(url('alice','2020/03'),404);
  f.data.set(url('alice','2020/02'),{games:[game('alice','bob',3001)]});
  const result=await f.advance();assert.equal(result.status,'found');assert.equal(result.shortestVerified,true);
  assert.equal(result.chain.path.length,2);assert.equal(result.chain.hops[0].url,'https://www.chess.com/game/live/3001');
  assert.equal(f.job().search.incomplete,true);noAggregates(f);
  assert.equal(await f.storage.get('twohop:v1:manifest'),undefined);
});

for(const status of [404,410]) test(`strict public helpers still reject advertised ${status}`,async()=>{
  const f=await fixture();f.statuses.set(url('alice','2020/01'),status);
  for(const call of [()=>api.fetchGames({username:'alice',sinceMonth:'0000/01'},f.env),
    ()=>api.readOrFetchGames(f.env,{username:'alice',sinceMonth:'0000/01'}),
    ()=>api.readOrFetchEdges(f.env,{username:'alice',sinceMonth:'0000/01'})]) {
    await assert.rejects(call,error=>error.status===status);
  }
  assert.equal(f.job().search.incomplete,false);noAggregates(f);
});

for(const status of [429,503]) test(`${status} remains deferred and does not become missing coverage`,async()=>{
  const f=await fixture();f.statuses.set(url('alice','2020/03'),status);
  const result=await f.reader().read('alice');assert.equal(result.deferred,true);
  assert.equal(result.reason,status===429?'rate-limited':'upstream-error');
  assert.equal(f.calls.length,status===429?1:3,'unchanged provider retry policy');
  assert.equal(f.job().search.incomplete,false);assert.equal(f.calls.some(c=>c.endsWith('2020/02')),false);
  noAggregates(f);assert.equal(await f.storage.get('twohop:v1:manifest'),undefined);
});

test('invalid successful body remains an error instead of an empty month',async()=>{
  const f=await fixture();f.data.set(url('alice','2020/03'),{games:null});
  const result=await f.reader().read('alice');assert.equal(result.deferred,true);
  assert.equal(f.job().search.incomplete,false);assert.equal(f.calls.length,1);noAggregates(f);
});

test('abort after a hole still rejects exact parent reason and cannot publish aggregate/certificate',async()=>{
  const f=await fixture(),controller=new AbortController(),fetch=globalThis.fetch,reason=new Error('owned cancellation');
  f.statuses.set(url('alice','2020/03'),404);
  globalThis.fetch=async(input,options)=>{const response=await fetch(input,options);if(String(input).endsWith('2020/02')){
    const json=response.json.bind(response);response.json=async()=>{const body=await json();controller.abort(reason);return body;};
  }return response;};
  await assert.rejects(f.reader().read('alice',controller.signal),error=>error===reason);
  assert.equal(f.job().search.incomplete,true);noAggregates(f);assert.equal(await f.storage.get('twohop:v1:manifest'),undefined);
  assert.equal(f.calls.some(c=>c.endsWith('2020/01')),false);
});

test('actual UI optimality note distinguishes limited history without claiming raw provider details',()=>{
  const source=readFileSync(new URL('../../site/app.js',import.meta.url),'utf8');
  const start=source.indexOf('  function searchOptimalityNote(job) {'),end=source.indexOf('  async function applyServerChain',start);
  assert.ok(start>=0&&end>start);const context=vm.createContext({});
  vm.runInContext(`${source.slice(start,end)};globalThis.note=searchOptimalityNote;`,context);
  assert.equal(context.note({incomplete:true,shortestVerified:false}),'Some game history was not fully checked. This route may not be the shortest.');
  assert.equal(context.note({incomplete:false,shortestVerified:false}),'Shortest route has not been verified.');
  assert.equal(context.note({incomplete:true,shortestVerified:true}),'Shortest route verified for this search.');
});
