import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {rootBoundAction,rootBoundDigest,rootBoundFresh,unpackRootBound} from '../src/root-three-hop-bound.js';
import {certificateScope,certificateDigest} from '../src/two-hop-certificate.js';
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


async function healthy(){const f=await fixture();f.data.set(url('bob','2020/01'),{games:[game('bzero','bob',2001)]});const months=['2020/01','2020/02','2020/03'];f.values.set('archives:fetch:v1:bzero',{schema:1,ts:Date.now(),archives:months.map(m=>url('bzero',m))});for(const m of months)f.data.set(url('bzero',m),{games:[]});f.data.set(url('bzero','2020/03'),{games:[game('middle','bzero',3001)]});return f;}
async function roots(f){assert.equal((await f.advance()).status,'running');assert.equal((await f.advance()).status,'running');assert.ok(await f.storage.get('root-three:v1:manifest'));}
async function bound(f){return rootBoundAction(f.storage,'root-three-read',{scope:certificateScope(f.job()),token:f.job().processingToken});}
function noPartial(f,name='bzero'){assert.equal(f.writes.some(w=>w.key===`edges:${name}:since:0000/01`||w.key===`games:${name}:since:0000/01`),false);}

async function warm(f){
 for(const username of ['alice','bob'])await api.fetchGames({username,archiveLimit:Infinity,sinceMonth:'0000/01'},f.env);
 f.calls.length=0;
}
const cachedTarget=f=>f.values.get('archive:games:v1:bob:2020/03');
test('certified warm roots establish3hop without root provider reads or expiry extension',async t=>{
 const f=await healthy(),at=Date.now()-1000,mock=t.mock.method(Date,'now',()=>at);
 for(const name of ['alice','bob'])f.values.get(`archives:fetch:v1:${name}`).ts=at;
 try{await warm(f);}finally{mock.mock.restore();}
 const original=structuredClone(cachedTarget(f));assert.ok(original.negativeProvenance);
 assert.ok(original.negativeProvenance.providerObservedAt<f.job().createdAt);
 await roots(f);const r=await f.advance();assert.equal(r.status,'found');assert.deepEqual(r.chain.path,['alice','middle','bzero','bob']);
 assert.equal(f.calls.some(u=>u.includes('/player/alice/')||u.includes('/player/bob/')),false);
 assert.deepEqual(cachedTarget(f),original);noPartial(f);
});
for(const kind of ['legacy','digest','games','username','url','schema','observation-missing','observation-future','expiry-missing','expiry-extended','bytes','validator','expired','ttl-zero'])
 test(`warm ${kind} cannot authorize negative root bound`,async()=>{
  const f=await healthy();await warm(f);const row=cachedTarget(f),p=row.negativeProvenance;assert.ok(p);
  if(kind==='legacy')delete row.negativeProvenance;
  if(kind==='digest')p.sha256='0'.repeat(64);
  if(kind==='games')row.games=[{white:'other',black:'bob',whiteResult:'win',blackResult:'resigned',url:'https://www.chess.com/game/live/777',timeClass:'blitz',endTime:1700000000,opening:''}];
  if(kind==='username')p.username='alice';if(kind==='url')p.url=url('bob','2020/02');if(kind==='schema')p.schema=2;
  if(kind==='observation-missing')delete p.providerObservedAt;if(kind==='observation-future')p.providerObservedAt=Date.now()+60000;
  if(kind==='expiry-missing')delete p.expiresAt;if(kind==='expiry-extended')row.expiresAt+=1000;
  if(kind==='bytes')p.bytes++;if(kind==='validator')p.validator='unvalidated';
  if(kind==='expired'||kind==='ttl-zero'){row.expiresAt=kind==='expired'?Date.now()-1:Date.now();f.statuses.set(url('bob','2020/03'),404);}
  await f.advance();await f.advance();assert.equal(await f.storage.get('root-three:v1:manifest'),undefined);
  if(kind!=='expired'&&kind!=='ttl-zero')assert.equal(f.calls.includes(url('bob','2020/03')),false);
 });
for(const kind of ['missing-rules','unknown-outcome','missing-games'])test(`raw ${kind} never mints provenance`,async()=>{
 const f=await healthy();if(kind==='missing-games')f.data.set(url('bob','2020/03'),{});
 else {const g=game('other','bob',777);if(kind==='missing-rules')delete g.rules;else g.white.result='unknown';f.data.set(url('bob','2020/03'),{games:[g]});}
 if(kind==='missing-games')await assert.rejects(warm(f));else await warm(f);
 assert.equal(cachedTarget(f)?.negativeProvenance,undefined);
});
test('missing advertised month remains sticky incomplete and has no certified cache row',async()=>{
 const f=await healthy();f.statuses.set(url('bob','2020/03'),404);await f.advance();await f.advance();
 assert.equal(f.job().search.incomplete,true);assert.equal(cachedTarget(f),undefined);assert.equal(await f.storage.get('root-three:v1:manifest'),undefined);
});

test('oversize monthly sanitized payload retains positive cache without negative provenance',async()=>{
 const f=await healthy();f.data.get(url('bob','2020/01')).games[0].eco='x'.repeat(2*1024*1024+1);await warm(f);
 assert.equal(f.values.get('archive:games:v1:bob:2020/01').negativeProvenance,undefined);
 await f.advance();await f.advance();assert.equal(await f.storage.get('root-three:v1:manifest'),undefined);
});
test('current-month provider TTL0 never writes reusable negative provenance',async()=>{
 const f=await healthy(),month=new Date().toISOString().slice(0,7).replace('-','/'),u=url('bob',month);
 f.values.get('archives:fetch:v1:bob').archives.push(u);f.data.set(u,{games:[]});const original=globalThis.fetch;
 globalThis.fetch=async(...args)=>{const response=await original(...args);if(String(args[0])===u)response.headers.set('Cache-Control','public, max-age=0');return response;};
 await warm(f);assert.equal(f.values.has('archive:games:v1:bob:'+month),false);
 await f.advance();await f.advance();assert.equal(await f.storage.get('root-three:v1:manifest'),undefined);
});
