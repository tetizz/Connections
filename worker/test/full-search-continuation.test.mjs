import test,{afterEach} from 'node:test';
import assert from 'node:assert/strict';
import worker,{SearchJobObject,__test as api} from '../src/index.js';
class KV {
 values=new Map();async get(k,o){const v=this.values.get(k);return v==null?null:o==='json'||o?.type==='json'?JSON.parse(v):v;}
 async put(k,v){this.values.set(k,String(v));}async delete(k){this.values.delete(k);}async list(){return{keys:[],list_complete:true};}
}
const nativeFetch=globalThis.fetch;afterEach(()=>globalThis.fetch=nativeFetch);
const saved={start:'alpha',target:'omega',range:'all',verificationVersion:'server-game-proofs-v1',verifiedAt:Date.now(),savedAt:Date.now(),checkedAt:Date.now(),
 chain:{found:true,path:['alpha','middle','omega'],hops:[{from:'alpha',to:'middle',url:'https://www.chess.com/game/live/100'},{from:'middle',to:'omega',url:'https://www.chess.com/game/live/101'}]}};
test('a new full search displays a server-verified incumbent and still queues fresh traversal',async()=>{
 const kv=new KV();await kv.put('search:pair:v2:alpha:omega:all',JSON.stringify(saved));
 const r=await worker.fetch(new Request('https://api.test/search/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({start:'alpha',target:'omega',range:'all',searchId:'full-continuation'})}),{GAMES_CACHE:kv},{});
 const {job}=await r.json();assert.equal(r.status,202);assert.deepEqual(job.chain?.path,saved.chain.path);assert.equal(job.status,'queued');assert.equal(job.shortestVerified,false);assert.equal(job.refreshCached,false);
 const internal=JSON.parse(kv.values.get(api.searchJobKey(job.id)));assert.deepEqual(internal.search.forwardFrontier,['alpha']);assert.deepEqual(internal.search.backwardFrontier,['omega']);
});
test('unmarked legacy paths or malformed proof direction cannot become an incumbent',async()=>{
 for(const mutate of [s=>{delete s.verificationVersion;},s=>{s.chain.hops[0].from='other';}]){
  const kv=new KV(),record=structuredClone(saved);mutate(record);await kv.put('search:pair:v2:alpha:omega:all',JSON.stringify(record));
  const r=await worker.fetch(new Request('https://api.test/search/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({start:'alpha',target:'omega',range:'all',searchId:'invalid-continuation'})}),{GAMES_CACHE:kv},{});
  assert.equal((await r.json()).job.chain,null);
 }
});
test('active native work is retained beyond the former two-hour creation expiry',async()=>{
 const now=Date.now(),values=new Map([['job',api.searchJobShape({id:'long-search',start:'alpha',target:'omega',status:'running',createdAt:now-3*3600000,updatedAt:now,search:api.initialSearchState('alpha','omega')})]]);
 const storage={get:async k=>values.get(k),deleteAll:async()=>values.clear()};
 const object=new SearchJobObject({storage},{});assert.equal((await object.readJob())?.id,'long-search');
});

test('trusted search snapshots and public jobs preserve a65-hop route without silent truncation',()=>{
 const path=['alpha',...Array.from({length:64},(_,i)=>`n${i}`),'omega'];
 const hops=path.slice(0,-1).map((from,i)=>({from,to:path[i+1],url:`https://www.chess.com/game/live/${1000+i}`}));
 const job=api.searchJobShape({id:'long-route',start:'alpha',target:'omega',status:'found',chain:{found:true,path,hops,length:hops.length}});
 assert.deepEqual(job.chain.path,path);assert.deepEqual(api.publicSearchJob(job).chain.hops,hops.map(h=>({...h,timeClass:'',endTime:null,result:'',color:'',opening:''})));
});

test('native full reader rejects unknown raw rules as negative evidence while retaining positive games',async()=>{
 const kv=new KV(),url='https://api.chess.com/pub/player/middle/games/2020/01';
 globalThis.fetch=async input=>new Response(JSON.stringify(String(input).endsWith('/archives')?{archives:[url]}:{games:[
  {rules:'chess',white:{username:'middle',result:'win'},black:{username:'bridge',result:'resigned'},time_class:'blitz',url:'https://www.chess.com/game/live/333'},
  {white:{username:'bad',result:'win'},black:{username:'middle',result:'resigned'},time_class:'blitz',url:'https://www.chess.com/game/live/334'}
 ]}),{headers:{'Content-Type':'application/json','Cache-Control':'public, max-age=300'}});
 const job=api.searchJobShape({id:'native-bad-raw',start:'alpha',target:'omega',range:'all',status:'running',search:{...api.initialSearchState('alpha','omega'),sinceMonth:'0000/01',pagedSearch:true}});
 const result=await api.createSearchEdgeReader({GAMES_CACHE:kv},job,{requests:0,cached:0,fetched:0}).read('middle');
 assert.equal(result.incomplete,true);assert.ok(result.edges.beatenByMe.has('bridge'));
 assert.equal(kv.values.has('edges:middle:since:0000/01'),false);
});

test('fresh complete current-month TTL0 remains job-owned observed evidence and is fetched again for a new job',async()=>{
 const kv=new KV(),month=new Date().toISOString().slice(0,7).replace('-','/'),url=`https://api.chess.com/pub/player/middle/games/${month}`;let monthly=0;
 globalThis.fetch=async input=>{if(String(input)===url)monthly++;return new Response(JSON.stringify(String(input).endsWith('/archives')?{archives:[url]}:{games:[]}),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});};
 for(const id of ['zero-first','zero-second']){
  const job=api.searchJobShape({id,start:'alpha',target:'omega',range:'all',status:'running',search:{...api.initialSearchState('alpha','omega'),sinceMonth:'0000/01',pagedSearch:true}});
  const result=await api.createSearchEdgeReader({GAMES_CACHE:kv},job,{requests:0,cached:0,fetched:0}).read('middle');
  assert.equal(result.incomplete,false);assert.equal(result.edges.archiveCoverage.negativeComplete,true);
  assert.ok(result.edges.archiveCoverage.expiresAt<=Date.now());assert.equal(kv.values.has('edges:middle:since:0000/01'),false);
 }
 assert.equal(monthly,2);
});

test('a new search revalidates an old past-month-only index and discovers a new current-month direct win',async t=>{
 const kv=new KV(),initial=Date.now();let clock=initial,generation=0;const calls=[];
 t.mock.method(Date,'now',()=>clock);
 const old='https://api.chess.com/pub/player/alpha/games/2020/01',current=`https://api.chess.com/pub/player/alpha/games/${new Date(initial).toISOString().slice(0,7).replace('-','/')}`;
 const game=(to,id)=>({rules:'chess',white:{username:'alpha',result:'win'},black:{username:to,result:'resigned'},time_class:'blitz',url:`https://www.chess.com/game/live/${id}`});
 globalThis.fetch=async input=>{const url=String(input);calls.push(url);return new Response(JSON.stringify(url.endsWith('/archives')?{archives:generation?[old,current]:[old]}:{games:[url===old?game('bridge',400):game('omega',401)]}),{headers:{'Content-Type':'application/json','Cache-Control':'public, max-age=300'}});};
 const make=id=>api.searchJobShape({id,start:'alpha',target:'omega',range:'all',status:'running',createdAt:clock,search:{...api.initialSearchState('alpha','omega'),sinceMonth:'0000/01',pagedSearch:true}});
 const first=await api.createSearchEdgeReader({GAMES_CACHE:kv},make('first-index-job'),{requests:0,cached:0,fetched:0}).read('alpha');
 assert.ok(first.edges.beatenByMe.has('bridge'));assert.ok(kv.values.has('edges:alpha:since:0000/01'));
 calls.length=0;generation=1;clock+=1000;
 const second=await api.createSearchEdgeReader({GAMES_CACHE:kv},make('second-index-job'),{requests:0,cached:0,fetched:0}).read('alpha');
 assert.equal(second.directProof?.to,'omega');assert.equal(second.directProof?.url,'https://www.chess.com/game/live/401');
 assert.deepEqual(calls,['https://api.chess.com/pub/player/alpha/games/archives',current]);
});

test('an unchanged newly observed index reuses complete historical adjacency without re-fetching its months',async t=>{
 const kv=new KV();let clock=Date.now();const calls=[];t.mock.method(Date,'now',()=>clock);
 const month='https://api.chess.com/pub/player/middle/games/2020/01';
 globalThis.fetch=async input=>{calls.push(String(input));return new Response(JSON.stringify(String(input).endsWith('/archives')?{archives:[month]}:{games:[]}),{headers:{'Content-Type':'application/json','Cache-Control':'public, max-age=300'}});};
 for(const id of ['same-index-first','same-index-second']){
  const job=api.searchJobShape({id,start:'alpha',target:'omega',range:'all',status:'running',createdAt:clock,search:{...api.initialSearchState('alpha','omega'),sinceMonth:'0000/01',pagedSearch:true}});
  const result=await api.createSearchEdgeReader({GAMES_CACHE:kv},job,{requests:0,cached:0,fetched:0}).read('middle');assert.equal(result.incomplete,false);clock+=1000;
 }
 assert.equal(calls.filter(url=>url.endsWith('/archives')).length,2);assert.equal(calls.filter(url=>url===month).length,1);
});

test('seven warm historical players revalidate indexes in one chunk without consuming full-history fill slots',async t=>{
 const kv=new KV();let clock=Date.now();t.mock.method(Date,'now',()=>clock);
 globalThis.fetch=async input=>{const u=String(input);return new Response(JSON.stringify(u.endsWith('/archives')?{archives:[u.replace('/archives','/2020/01')]}:{games:[]}),{headers:{'Content-Type':'application/json','Cache-Control':'public, max-age=300'}});};
 const make=id=>api.searchJobShape({id,start:'alpha',target:'omega',range:'all',status:'running',createdAt:clock,search:{...api.initialSearchState('alpha','omega'),sinceMonth:'0000/01',pagedSearch:true}});
 for(let i=0;i<7;i++)await api.createSearchEdgeReader({GAMES_CACHE:kv},make(`warm-player-${i}`),{}).read(`player${i}`);
 clock+=1000;const reader=api.createSearchEdgeReader({GAMES_CACHE:kv},make('warm-shared-chunk'),{});
 for(let i=0;i<7;i++){const result=await reader.read(`player${i}`);assert.equal(result.deferred,undefined);assert.equal(result.incomplete,false);}
});

test('old unproven terminal routes resume full traversal while proven terminals remain complete',async()=>{
 for(const verified of [false,true]){
  let job=api.searchJobShape({id:`old-result-${verified}`,start:'alpha',target:'omega',range:'all',status:'found',shortestVerified:verified,chain:saved.chain,search:api.initialSearchState('alpha','omega')});
  const env={GAMES_CACHE:new KV(),SEARCH_JOBS:{getByName(){return{fetch:async(url,init)=>{if(String(url).endsWith('/update'))job=api.searchJobShape({...job,...JSON.parse(init.body).patch});return Response.json({job});}};}}};
  const result=await api.readSearchJob(env,job.id);assert.equal(result.status,verified?'found':'running');assert.equal(result.shortestVerified,verified);assert.deepEqual(result.chain.path,saved.chain.path);assert.equal(result.search.pagedSearchRequested,!verified);
 }
});
