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
test('native-shaped complete raw roots authorize streamed3hop and skip older interior months without completing that player',async()=>{const f=await healthy();await roots(f);const before=f.job().stats.expanded;const r=await f.advance();assert.equal(r.status,'found');assert.deepEqual(r.chain.path,['alice','middle','bzero','bob']);assert.deepEqual(r.chain.hops.map(h=>h.url),[1001,3001,2001].map(id=>'https://www.chess.com/game/live/'+id));assert.equal(f.job().stats.expanded,before);assert.ok(!f.calls.includes(url('bzero','2020/01')));assert.equal(r.shortestVerified,false);noPartial(f);});
test('raw root proof maps retain beyond800 inputs despite capped visited frontier',async()=>{const f=await healthy();f.data.set(url('alice','2020/01'),{games:Array.from({length:901},(_,i)=>game('alice','a'+String(i).padStart(4,'0'),10000+i))});f.data.set(url('bzero','2020/03'),{games:[game('a0000','bzero',3001)]});await roots(f);assert.equal(f.job().search.incomplete,true);assert.equal(f.job().search.forwardVisited.a0000,undefined);const r=await f.advance();assert.equal(r.status,'found');assert.deepEqual(r.chain.path,['alice','a0000','bzero','bob']);assert.equal(r.shortestVerified,false);noPartial(f);});
test('hidden raw two-hop beyond800 prevents negative bound and preserves positive2hop behavior',async()=>{const f=await healthy();f.data.set(url('alice','2020/01'),{games:Array.from({length:901},(_,i)=>game('alice','a'+String(i).padStart(4,'0'),10000+i))});f.data.set(url('bob','2020/01'),{games:[game('a0000','bob',2001)]});await f.advance();const r=await f.advance();assert.equal(r.status,'found');assert.deepEqual(r.chain.path,['alice','a0000','bob']);assert.equal(await f.storage.get('root-three:v1:manifest'),undefined);assert.equal(r.shortestVerified,false);});
test('oldest direct proof remains absolute1hop and cannot mint root negative',async()=>{const f=await healthy();f.data.get(url('alice','2020/01')).games.push(game('alice','bob',9001));const r=await f.advance();assert.equal(r.status,'found');assert.deepEqual(r.chain.path,['alice','bob']);assert.equal(r.shortestVerified,true);assert.equal(await f.storage.get('root-three:v1:manifest'),undefined);});
for(const status of[404,410])test(`target${status} disables negative authority while healthy positive route remains ordinary`,async()=>{const f=await healthy();f.statuses.set(url('bob','2020/03'),status);await f.advance();await f.advance();assert.equal(await f.storage.get('root-three:v1:manifest'),undefined);assert.equal((await bound(f)).accepted,false);const r=await f.advance();assert.equal(r.status,'found');assert.ok(f.calls.includes(url('bzero','2020/01')));assert.equal(r.shortestVerified,false);});
test('root currentTTL0 disables negative bound rather than declaring freshness',async()=>{const f=await healthy(),m=new Date().toISOString().slice(0,7).replace('-','/');for(const n of['alice','bob']){f.values.get('archives:fetch:v1:'+n).archives.push(url(n,m));f.data.set(url(n,m),{games:[]});}const fetch=globalThis.fetch;globalThis.fetch=async(...args)=>{const r=await fetch(...args);r.headers.set('Cache-Control','no-store');return r;};await f.advance();await f.advance();assert.equal(await f.storage.get('root-three:v1:manifest'),undefined);assert.equal((await bound(f)).accepted,false);});
test('malformed incoming winning row disables negative evidence without becoming empty absence',async()=>{const f=await healthy();f.data.get(url('bob','2020/03')).games=[{...game('bad','bob',7001),url:'https://example.invalid/not-a-proof'}];await f.advance();await f.advance();assert.equal(await f.storage.get('root-three:v1:manifest'),undefined);});
test('historical later3hop beats a prospective longer route; no4hop early claim',async()=>{const f=await healthy();f.data.set(url('bzero','2020/03'),{games:[game('unknowninterior','bzero',7001)]});f.data.set(url('bzero','2020/01'),{games:[game('middle','bzero',3001)]});await roots(f);const r=await f.advance();assert.equal(r.status,'found');assert.deepEqual(r.chain.path,['alice','middle','bzero','bob']);assert.ok(f.calls.includes(url('bzero','2020/01')));assert.equal(r.shortestVerified,false);});
test('equal3hop choices need no tie enumeration and retain valid directed proof',async()=>{const f=await healthy();f.data.set(url('bzero','2020/03'),{games:[game('middle','bzero',3001),game('padding','bzero',3002)]});await roots(f);const r=await f.advance();assert.equal(r.status,'found');assert.equal(r.chain.path.length,4);assert.ok(['middle','padding'].includes(r.chain.path[1]));assert.ok(!f.calls.includes(url('bzero','2020/01')));});
for(const kind of['target-expiry','index','start-digest','corrupt-chunk','missing-chunk','scope','token','lease'])test(`negative authority${kind} fails closed`,async()=>{const f=await healthy();await roots(f);if(kind==='target-expiry'){const m=await f.storage.get('root-three:v1:manifest');m.months[0].expiresAt=Date.now()-1;await f.storage.put('root-three:v1:manifest',m);}if(kind==='start-digest'){const m=await f.storage.get('root-three:v1:manifest');m.startDigest='0'.repeat(64);await f.storage.put('root-three:v1:manifest',m);}if(kind==='corrupt-chunk')await f.storage.put('root-three:v1:chunk:000','bad');if(kind==='missing-chunk')await f.storage.delete('root-three:v1:chunk:000');if(kind==='scope'){const j=await f.storage.get('job');j.target='different';await f.storage.put('job',j);}if(kind==='token'){const j=await f.storage.get('job');j.processingToken='replacement-owner';await f.storage.put('job',j);}if(kind==='lease'){const j=await f.storage.get('job');j.processingUntil=Date.now()-1;await f.storage.put('job',j);}if(kind==='index'){f.values.get('archives:fetch:v1:alice').ts-=1;const r=await f.advance();assert.equal(r.status,'found');assert.ok(f.calls.includes(url('bzero','2020/01')));}else assert.equal((await bound(f)).accepted,false);});
test('negative package has native stored digest authority rather than persisted boolean',async()=>{const f=await healthy();await roots(f);const r=await bound(f);assert.equal(r.accepted,true);const authority=await unpackRootBound(r.startPackage,r.targetPackage,r.startScan);assert.ok(authority);assert.equal(rootBoundFresh(authority,f.job()),true);assert.equal(authority.digest,await rootBoundDigest(r.targetPackage));f.job().search.rootThreeHopReady=true;await f.storage.delete('root-three:v1:manifest');assert.equal((await bound(f)).accepted,false);});

test('missing raw rules and unknown outcomes cannot become negative absence',async()=>{for(const kind of['missing-rules','unknown-result','missing-result']){const f=await healthy();const g=game('someone','bob',7002);if(kind==='missing-rules')delete g.rules;if(kind==='unknown-result')g.white.result='unsupported-result';if(kind==='missing-result')delete g.black.result;f.data.get(url('bob','2020/03')).games=[g];await f.advance();await f.advance();assert.equal(await f.storage.get('root-three:v1:manifest'),undefined);}});
test('unsupported start outcomes block negative-only scan while preserving positive2hop certificate behavior',async()=>{const f=await healthy();const g=game('alice','unknown',5001);g.white.result='unsupported-result';f.data.get(url('alice','2020/03')).games=[g];await f.advance();await f.advance();assert.ok(await f.storage.get('twohop:v1:manifest'));assert.equal(await f.storage.get('root-three:v1:start-scan'),undefined);assert.equal(await f.storage.get('root-three:v1:manifest'),undefined);});
test('legacy cached sanitized root month is not negative raw-envelope authority',async()=>{const f=await healthy();const u=url('bob','2020/03');f.values.set('archive:games:v1:bob:2020/03',{schema:1,url:u,expiresAt:Date.now()+60000,games:[]});await f.advance();await f.advance();assert.ok(!f.calls.includes(u));assert.equal(await f.storage.get('root-three:v1:manifest'),undefined);});

test('a previously known shorter meeting is never replaced by a streamed3hop witness',async()=>{const f=await healthy();await roots(f);f.data.get(url('bob','2020/01')).games.push(game('middle','bob',999));f.job().search.backwardVisited.middle={next:'bob',hopUrl:'https://www.chess.com/game/live/999'};f.job().search.bestMeeting='middle';f.job().search.bestMeetingLength=2;f.job().search.incomplete=true;const r=await f.advance();assert.equal(r.status,'found');assert.deepEqual(r.chain.path,['alice','middle','bob']);assert.equal(r.chain.hops[1].url,'https://www.chess.com/game/live/999');});
test('expiry crossing during awaited index reads disables a held bound rather than completing partial player',async t=>{const f=await healthy();await roots(f);const m=await f.storage.get('root-three:v1:manifest'),base=Date.now();m.months[0].expiresAt=base+10;await f.storage.put('root-three:v1:manifest',m);let now=base;const mock=t.mock.method(Date,'now',()=>now),get=f.env.GAMES_CACHE.get.bind(f.env.GAMES_CACHE);f.env.GAMES_CACHE.get=async(...args)=>{const value=await get(...args);if(args[0]==='archives:fetch:v1:alice')now=base+20;return value;};try{const r=await f.advance();assert.equal(r.status,'found');assert.ok(f.calls.includes(url('bzero','2020/01')));}finally{mock.mock.restore();}});
test('native read checks lease again after awaited package loading',async t=>{const f=await healthy();await roots(f);const base=Date.now();let now=base;const j=await f.storage.get('job');j.processingUntil=base+10;await f.storage.put('job',j);const mock=t.mock.method(Date,'now',()=>now),get=f.storage.get.bind(f.storage);f.storage.get=async key=>{const value=await get(key);if(Array.isArray(key)&&key.includes('twohop:v1:chunk:000'))now=base+20;return value;};try{assert.equal((await bound(f)).accepted,false);}finally{mock.mock.restore();}});
test('oversize negative package declines without truncating or replacing existing authority',async()=>{const f=await healthy();await roots(f);const r=await bound(f),pkg=structuredClone(r.targetPackage),body=' '.repeat(32*1024+1);pkg.chunks=[body];pkg.manifest.chunks=[{bytes:body.length,sha256:await certificateDigest(body)}];const before=await rootBoundDigest(r.targetPackage);const response=await rootBoundAction(f.storage,'root-three-commit',{scope:certificateScope(f.job()),token:f.job().processingToken,package:pkg});assert.equal(response.accepted,false);const after=await bound(f);assert.equal(after.accepted,true);assert.equal(await rootBoundDigest(after.targetPackage),before);});
