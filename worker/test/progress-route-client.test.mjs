import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const source=readFileSync(new URL('../../site/app.js',import.meta.url),'utf8');
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert.ok(a>=0&&b>a);return source.slice(a,b);}
const plain=x=>JSON.parse(JSON.stringify(x));
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({holdHydration=false}={}){
 const requests=[],renders=[],events=[],submissions=[],statuses=[],scrolls=[],clears=[],hydrations=[],cards=[];
 const state={activeSearchOwner:'search:test-search',searchJobs:new Map(),players:{},currentChain:null};
 const elements=new Map();
 const element=key=>{if(!elements.has(key))elements.set(key,{hidden:false,disabled:false,className:'',innerHTML:'',dataset:{},children:[],setAttribute(){},querySelectorAll:()=>key==='#cards'?cards:[],appendChild(x){this.children.push(x);},removeChild(){this.children.shift();},scrollIntoView(){scrolls.push(key);}});return elements.get(key);};
 const context=vm.createContext({state,Date,URL,URLSearchParams,console,location:{href:"https://example.invalid/"},CHAIN_PARAM:"chain",SHORT_CHAIN_PARAM:"c",LEGACY_SHARE_PARAM:"share",encodeSharePayload:chain=>JSON.stringify(context.sharePayload(chain)),
  SEARCH_POLICY_VERSION:'fresh-search-v2',TERMINAL_SEARCH_STATUSES:new Set(['found','not_found','timeout','failed','expired']),SERVER_SEARCH_HARD_LIMIT_MS:360000,SERVER_POLL_RETRY_LIMIT:3,
  rememberVerifiedRoute:()=>{},workerBase:()=> 'https://example.invalid',chainKey:path=>path.join('>'),
  fetchJsonWithRetry:(url,options)=>new Promise((resolve,reject)=>requests.push({url,options,resolve:job=>resolve({data:{job}}),reject})),
  wait:async()=>{},$:element,document:{createElement:()=>({}),querySelector:element},
  window:{SavedRoutes:{}},esc:String,stepText:n=>`${n} steps`,statusText:String,
  showStatus:(kind,text)=>statuses.push({kind,text}),showServerJobProgress:job=>statuses.push({kind:'working',text:job.progress}),
  renderSearchQueue:()=>{},finishSearchQueue:()=>{},saveActiveJob:()=>{},clearActiveJob:id=>clears.push(id),
  renderChain:chain=>{state.currentChain=chain;renders.push(plain(chain));element("#copy-share").dataset.shareUrl=context.buildLongShareUrl(chain);},
  setActiveChip:()=>{},metaShape:x=>x,hydratePlayers:()=>holdHydration?new Promise(resolve=>hydrations.push(resolve)):Promise.resolve(),nameOf:String,isValidProofTime:Number.isFinite,compactGraphLabel:String,
  submitLeaderboardChain:(...args)=>submissions.push(args),recordSearchEvent:(outcome,detail)=>events.push({outcome,detail}),
  cleanUsernameInput:String,isWorkerUnavailable:()=>false,
 });
 vm.runInContext([
  section('  function isSearchComplete(', '  async function pollServerSearchJob('),
  section('  async function pollServerSearchJob(', '  function showServerJobProgress('),
  section('  function searchOptimalityNote(', '  function saveActiveJob('),
  section('  function updateGraphSummary(', '  function renderGraph('),
  section('  function qualityFromChain(', '  function updateShareButton('),
  section('  function buildLongShareUrl(', '  function buildShortShareUrl('),
  section('  function sharePayload(', '  function decodeSharePayload('),
  section('  function proofDetails(', '  function avatarEl('),
 ].join('\n'),context,{filename:'actual-progress-route-controller.js'});
 const run=()=>context.runServerSearchFlow({start:'alice',target:'bob',range:'all',analyticsBase:{searchId:'test-search'},mode:{label:'all history'},btn:element('button'),status:element('status'),logEl:element('log')});
 const poll=()=>context.pollServerSearchJob('job-current',{analyticsBase:{searchId:'test-search'},isCurrent:()=>state.activeSearchOwner==='search:test-search'});
 const reply=async job=>{const pending=requests.find(r=>!r.replied);assert.ok(pending,'an actual request must be pending');pending.replied=true;pending.resolve(plain(job));await flush();};
 return {context,state,requests,renders,events,submissions,statuses,scrolls,clears,hydrations,cards,element,run,poll,reply};
}
function chain(path=['alice','mid','other','bob'],offset=0){return {found:true,path,length:path.length-1,hops:path.slice(1).map((to,i)=>({from:path[i],to,url:`https://www.chess.com/game/live/${100+offset+i}`}))};}
function job(route=null,status='running'){return {id:'job-current',policyVersion:'fresh-search-v2',start:'alice',target:'bob',range:'all',status,shortestVerified:status==='found',progress:'Checking for a shorter route',stats:{expanded:1,requests:2,cached:0},chain:route};}

test('ordinary controller displays first running route before terminal, deduplicates polls and commits final once',async()=>{
 const f=fixture(),done=f.run();await f.reply(job());
 const first=chain();await f.reply(job(first));
 assert.equal(f.renders.length,1);assert.equal(f.events.length,0);assert.equal(f.submissions.length,0);assert.equal(f.scrolls.length,0);
 let complete=false;done.then(()=>{complete=true;});await flush();assert.equal(complete,false,'terminal gate remains pending');
 await f.reply(job(first));assert.equal(f.renders.length,1);
 const shorter=chain(['alice','mid','bob'],10);await f.reply(job(shorter));assert.equal(f.renders.length,2);assert.deepEqual(f.renders[1].path,shorter.path);
 assert.equal(f.events.length,0);assert.equal(f.submissions.length,0);
 await f.reply(job(shorter,'found'));await done;
 assert.equal(f.renders.length,2,'same terminal route must retain mounted graph');assert.equal(f.events.length,1);assert.equal(f.events[0].outcome,'found');assert.equal(f.submissions.length,1);assert.equal(f.clears.at(-1),'job-current');
});
test('same route changed proof updates once; counters alone do not remount',async()=>{
 const f=fixture(),done=f.poll(),first=chain();await f.reply(job(first));await f.reply({...job(first),stats:{expanded:4,requests:9,cached:0}});assert.equal(f.renders.length,1);
 const proof=chain(undefined,50);await f.reply(job(proof));assert.equal(f.renders.length,2);assert.equal(f.renders[1].hops[0].url,proof.hops[0].url);
 await f.reply(job(proof,'found'));await done;assert.equal(f.events.length,0);assert.equal(f.submissions.length,0);
});
test('longer and equal-length alternate running routes cannot replace the visible shorter route',async()=>{
 const f=fixture(),done=f.poll(),first=chain(['alice','mid','bob']);await f.reply(job(first));await f.reply(job(chain()));await f.reply(job(chain(['alice','else','bob'],20)));assert.equal(f.renders.length,1);await f.reply(job(first,'found'));await done;
});
test('supersession while request is pending prevents stale progress rendering',async()=>{
 const f=fixture(),done=f.poll();const rejected=assert.rejects(done,e=>e.code==='SEARCH_SUPERSEDED');f.state.activeSearchOwner='search:newer';await f.reply(job(chain()));await rejected;assert.equal(f.renders.length,0);assert.equal(f.events.length,0);assert.equal(f.submissions.length,0);
});
test('old-policy progress cannot render and clears resumable job',async()=>{
 const f=fixture(),done=f.poll();const rejected=assert.rejects(done,e=>e.code==='SEARCH_POLICY_EXPIRED');await f.reply({...job(chain()),policyVersion:'fresh-search-v1'});await rejected;assert.equal(f.renders.length,0);assert.deepEqual(f.clears,['job-current']);
});
test('initial running route is provisional and background polling never repeats its render or completion effects',async()=>{
 const f=fixture(),first=chain(),done=f.run();await f.reply(job(first));await done;assert.equal(f.renders.length,1);assert.equal(f.events.length,0);assert.equal(f.submissions.length,0);assert.ok(f.statuses.every(s=>s.kind!=='done'));
 await f.reply(job(first));assert.equal(f.renders.length,1);await f.reply(job(first,'found'));assert.equal(f.renders.length,1);assert.equal(f.events.length,1);assert.equal(f.submissions.length,1);
});
test('running snapshot without route has no render or completion side effects',async()=>{
 const f=fixture(),done=f.poll();await f.reply(job());assert.equal(f.renders.length,0);await f.reply(job(null,'timeout'));await done;assert.equal(f.renders.length,0);assert.equal(f.events.length,0);assert.equal(f.submissions.length,0);
});
test('terminal-only controller path keeps final render, submission and completion analytics',async()=>{
 const f=fixture(),done=f.run();await f.reply(job());await f.reply(job(chain(),'found'));await done;assert.equal(f.renders.length,1);assert.equal(f.events.length,1);assert.equal(f.events[0].outcome,'found');assert.equal(f.submissions.length,1);assert.equal(f.statuses.at(-1).kind,'done');
});


test('same-proof terminal accepts current quality/hop metadata, refreshes real share payload/cards and preserves pending enrichment',async()=>{
 const f=fixture({holdHydration:true}),done=f.run();
 const details={textContent:''},winner={textContent:''},loser={textContent:''};
 f.cards.push({querySelector:selector=>selector==='.card__sub'?details:selector==='.winner'?winner:selector==='.loser'?loser:null,querySelectorAll:()=>[]});
 await f.reply(job());const provisional=chain();await f.reply(job(provisional));
 assert.equal(f.hydrations.length,1);const final=chain();final.quality={score:97,label:'Excellent',source:'server'};final.hops[0].timeClass='rapid';final.hops[0].endTime=1700000000;
 await f.reply(job(final,'found'));await done;
 assert.equal(f.renders.length,1);assert.deepEqual(plain(f.state.currentChain.quality),final.quality);assert.equal(f.state.currentChain.hops[0].endTime,1700000000);
 assert.match(details.textContent,/rapid/);assert.match(f.element('#graph-summary').textContent,/Verified 3-link/);
 const shared=JSON.parse(new URL(f.element('#copy-share').dataset.shareUrl).searchParams.get('chain'));
 assert.deepEqual(shared.quality,final.quality);assert.equal(shared.hops[0].endTime,1700000000);
 f.hydrations[0]();await flush();assert.deepEqual(plain(f.context.sharePayload(f.state.currentChain).quality),final.quality);assert.equal(f.renders.length,1);
});
test('provisional working status carries incomplete-history warning and never claims verified minimum',async()=>{
 for (const progress of ['Checking more players.', 'Some game history was not fully checked. Checking more players.']) {
  const f=fixture(),done=f.poll();await f.reply({...job(chain()),incomplete:true,progress});
  const status=f.statuses.at(-1);
  assert.equal((status.text.match(/Some game history was not fully checked\./g)||[]).length,1);
  assert.match(status.text,/This route may not be the shortest/);assert.equal(status.kind,'working');
  assert.doesNotMatch(status.text,/Shortest route verified/);
  await f.reply(job(chain(),'found'));await done;
 }
});


test('a terminal route without shortest proof remains provisional and keeps its saved job',async()=>{
 const f=fixture(),done=f.run();await f.reply(job());await f.reply({...job(chain(),'found'),shortestVerified:false,incomplete:true});await done;
 assert.equal(f.renders.length,1);assert.equal(f.events.length,0);assert.equal(f.submissions.length,0);assert.deepEqual(f.clears,[]);
 assert.equal(f.statuses.at(-1).kind,'working');assert.match(f.statuses.at(-1).text,/may not be the shortest/);
});

test('a server start network failure reports unavailable without requesting a limited fallback',async()=>{
 const f=fixture(),done=f.run();f.requests[0].reject(new Error('Failed to fetch'));await done;
 assert.equal(await done,true);assert.equal(f.renders.length,0);
 assert.match(f.statuses.at(-1).text,/full search service could not connect/);
 assert.match(f.statuses.at(-1).text,/no limited search was substituted/);
});
