import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../../site/app.js',import.meta.url),'utf8');
const section=(from,to)=>source.slice(source.indexOf(from),source.indexOf(to,source.indexOf(from)));
function harness(){const values=new Map(),writes=[],runs=[];const state={};const c=vm.createContext({state,Date,JSON,SEARCH_POLICY_VERSION:'fresh-search-v2',LS_TOP_TRACE_KEY:'top',LS_ACTIVE_JOB_KEY:'active',localStorage:{getItem:k=>values.get(k)||null,setItem:(k,v)=>{values.set(k,v);writes.push({k,v});}},serverChainIdentity:chain=>chain?.found?JSON.stringify([chain.path,chain.hops.map(h=>h.url)]):'',cleanUsernameInput:s=>s,runTopPlayersTrace:record=>runs.push(record)});vm.runInContext(section('  function topTraceProgress(', '  async function runTopPlayersTrace('),c);return {c,values,writes,runs};}
const item=()=>({player:{username:'omega'},status:'running',searchId:'event',job:{id:'job',start:'alpha',target:'omega',status:'running',policyVersion:'fresh-search-v2',players:{alpha:{avatar:'large profile metadata'}},chain:{found:true,path:['alpha','omega'],hops:[{from:'alpha',to:'omega',url:'https://www.chess.com/game/live/1'}]},stats:{expanded:1}}});
test('top-player persistence retains resumable ids/proofs while excluding optional profile payloads',()=>{const f=harness();f.c.saveTopTraceBatch('alpha',[item()]);const row=JSON.parse(f.values.get('top')).results[0];assert.equal(row.job.id,'job');assert.equal(row.searchId,'event');assert.equal(row.job.players,undefined);assert.equal(row.job.chain.hops.length,1);});
test('counter-only polls do not rewrite the full batch repeatedly; changed proofs persist immediately',()=>{const f=harness(),row=item();f.c.saveTopTraceBatch('alpha',[row]);row.job.stats.expanded=2;f.c.saveTopTraceBatch('alpha',[row]);assert.equal(f.writes.length,1);row.job.chain.hops[0].url='https://www.chess.com/game/live/2';f.c.saveTopTraceBatch('alpha',[row]);assert.equal(f.writes.length,2);});
test('a different root persists immediately even if queued target ids match',()=>{const f=harness();const row={player:{username:'omega'},status:'queued'};f.c.saveTopTraceBatch('alpha',[row]);f.c.saveTopTraceBatch('beta',[row]);assert.equal(f.writes.length,2);assert.equal(JSON.parse(f.values.get('top')).start,'beta');});
test('overnight top-player batches resume the same jobs and a newer foreground search takes priority',async()=>{const f=harness();f.values.set('top',JSON.stringify({start:'alpha',policyVersion:'fresh-search-v2',ts:Date.now()-8*60*60*1000,results:[item()]}));assert.equal(await f.c.resumeTopPlayersTrace(),true);assert.equal(f.runs[0].results[0].job.id,'job');f.values.set('active',JSON.stringify({id:'newer',ts:Date.now()}));assert.equal(await f.c.resumeTopPlayersTrace(),false);assert.equal(f.runs.length,1);});

test('a manual top-player click starts fresh full searches for every target despite an old mixed batch',async()=>{
 const values=new Map(),calls=[]; const old={start:'alpha',policyVersion:'fresh-search-v2',ts:Date.now(),results:[
   {player:{username:'omega'},status:'found',job:{id:'old-complete',status:'found',shortestVerified:true}},
   {player:{username:'beta'},status:'paused',job:{id:'old-pending',status:'running'}}]};
 values.set('top',JSON.stringify(old)); const elements=new Map();const element=key=>{if(!elements.has(key))elements.set(key,{value:key==='#search-start'?'alpha':'',disabled:false});return elements.get(key);};
 const state={topTraceRunId:0};const c=vm.createContext({state,Date,JSON,Promise,SEARCH_POLICY_VERSION:'fresh-search-v2',LS_TOP_TRACE_KEY:'top',LS_ACTIVE_JOB_KEY:'active',LS_KEY:'username',TOP_TRACE_CONCURRENCY:6,$:element,localStorage:{getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)},cleanUsernameInput:s=>s,topTraceCandidates:()=>[{username:'omega'},{username:'beta'}],savedVerifiedRoute:()=>null,serverChainIdentity:chain=>chain?.path?.join('>')||'',showStatus:()=>{},plainNumber:String,renderTopTraceCurrentTree:async()=>{},resetSearchQueue:()=>{},traceTopCandidate:async(start,player)=>{calls.push(player.username);return {player,status:'found',job:{id:'fresh-'+player.username,status:'found',shortestVerified:true,chain:{found:true,path:[start,player.username]}}};}});
 vm.runInContext(section('  function topTraceProgress(', '  async function traceTopCandidate('),c);
 await c.runTopPlayersTrace();assert.deepEqual(calls.sort(),['beta','omega']);
});

test('all top-player jobs are accepted before polling can wait on the first unfinished target',async()=>{
 const values=new Map(),requests=[],gates=[];let released=false,nextId=0;
 const players=Array.from({length:30},(_,i)=>({username:'target'+i}));
 const elements=new Map();const element=key=>{if(!elements.has(key))elements.set(key,{value:key==='#search-start'?'alpha':'',disabled:false});return elements.get(key);};
 const state={topTraceRunId:0};const pendingJob=target=>({id:'job-'+target,start:'alpha',target,status:'running',policyVersion:'fresh-search-v2'});
 const finished=target=>({...pendingJob(target),status:'found',shortestVerified:true,chain:{found:true,path:['alpha',target],hops:[{from:'alpha',to:target,url:'https://www.chess.com/game/live/1'}]}});
 const c=vm.createContext({state,Date,JSON,Promise,performance:{now:()=>10},SEARCH_POLICY_VERSION:'fresh-search-v2',LS_TOP_TRACE_KEY:'top',LS_ACTIVE_JOB_KEY:'active',LS_KEY:'username',TOP_TRACE_CONCURRENCY:6,TOP_TRACE_HARD_LIMIT_MS:240000,TOP_TRACE_POLL_INTERVAL_MS:140,TERMINAL_SEARCH_STATUSES:new Set(['found','not_found','timeout','failed','expired']),window:{SavedRoutes:{routeStepCount:chain=>chain.hops.length}},pathHasBlockedUser:()=>false,$:element,localStorage:{getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)},cleanUsernameInput:s=>s,topTraceCandidates:()=>players,savedVerifiedRoute:()=>null,rememberVerifiedRoute:()=>{},serverChainIdentity:chain=>chain?.path?.join('>')||'',showStatus:()=>{},plainNumber:String,renderTopTraceCurrentTree:async()=>{},resetSearchQueue:()=>{},newSearchEventId:()=>String(++nextId),workerBase:()=> 'https://test.example',wait:async()=>{},fetchJsonWithRetry:async(url,options)=>{requests.push({url,options});if(options.method==='POST')return {data:{job:pendingJob(JSON.parse(options.body).target)}};const target=new URL(url).searchParams.get('id').slice(4);if(released)return {data:{job:finished(target)}};return new Promise(resolve=>gates.push(()=>resolve({data:{job:finished(target)}})));}});
 vm.runInContext(section('  function topTraceProgress(', '  function sortedTopTraceResults('),c);
 const done=c.runTopPlayersTrace();await new Promise(resolve=>setImmediate(resolve));
 try {assert.equal(requests.filter(r=>r.options.method==='POST').length,30,'all 30 targets must get durable jobs without waiting for earlier routes to finish');const firstGet=requests.findIndex(r=>r.options.method!=='POST');assert.equal(firstGet,30);}
 finally {released=true;for(const release of gates)release();await done;}
 const stored=JSON.parse(values.get('top'));assert.equal(stored.results.length,30);assert.ok(stored.results.every(item=>item.job?.id));
});

test('late progress from an older batch cannot steal resume priority from a newer foreground search',async()=>{
 const f=harness();f.values.set('top',JSON.stringify({start:'alpha',policyVersion:'fresh-search-v2',startedAt:Date.now()-8*60*60*1000,ts:Date.now(),results:[item()]}));f.values.set('active',JSON.stringify({id:'newer',ts:Date.now()-60*60*1000}));
 assert.equal(await f.c.resumeTopPlayersTrace(),false);assert.equal(f.runs.length,0);
});
test('new foreground ownership detaches batch UI without cancelling target dispatch',async()=>{
 const values=new Map(),calls=[],statuses=[];const elements=new Map();const element=key=>{if(!elements.has(key))elements.set(key,{value:key==='#search-start'?'alpha':'',disabled:false});return elements.get(key);};
 const state={topTraceRunId:0};let detachedAt=null;const c=vm.createContext({state,Date,JSON,Promise,SEARCH_POLICY_VERSION:'fresh-search-v2',LS_TOP_TRACE_KEY:'top',LS_ACTIVE_JOB_KEY:'active',LS_KEY:'username',TOP_TRACE_CONCURRENCY:2,$:element,localStorage:{getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)},cleanUsernameInput:s=>s,topTraceCandidates:()=>[{username:'one'},{username:'two'},{username:'three'}],savedVerifiedRoute:()=>null,serverChainIdentity:()=>'',showStatus:(kind,message)=>statuses.push(message),plainNumber:String,renderTopTraceCurrentTree:async()=>{},resetSearchQueue:()=>{},traceTopCandidate:async(start,player,runId,options)=>{assert.equal(options.startOnly,true);calls.push(player.username);if(detachedAt===null){state.topTraceRunId++;state.activeSearchOwner='search:new-foreground';detachedAt=statuses.length;}return {player,status:'running',job:{id:'accepted-'+player.username,start,target:player.username,status:'running',policyVersion:'fresh-search-v2'}};}});
 vm.runInContext(section('  function topTraceProgress(', '  async function traceTopCandidate('),c);await c.runTopPlayersTrace();
 assert.deepEqual(calls,['one','two','three']);assert.equal(statuses.length,detachedAt);assert.equal(state.activeSearchOwner,'search:new-foreground');assert.equal(JSON.parse(values.get('top')).results.filter(row=>row.job?.id).length,3);
});

test('starting a top-player batch clears the previous ordinary queue and stale failure log without deleting its saved job',async()=>{
 const values=new Map([['active',JSON.stringify({id:'ordinary-job',ts:Date.now()-1000})]]),elements=new Map();
 const element=key=>{if(!elements.has(key))elements.set(key,{value:key==='#search-start'?'alpha':'',disabled:false,hidden:false,innerHTML:key==='#search-log'?'server search unavailable: Failed to fetch':''});return elements.get(key);};
 const state={topTraceRunId:0,queueTimer:17};const c=vm.createContext({state,Date,JSON,Promise,clearInterval:()=>{},SEARCH_POLICY_VERSION:'fresh-search-v2',LS_TOP_TRACE_KEY:'top',LS_ACTIVE_JOB_KEY:'active',LS_KEY:'username',TOP_TRACE_CONCURRENCY:2,$:element,localStorage:{getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)},cleanUsernameInput:s=>s,topTraceCandidates:()=>[{username:'omega'}],savedVerifiedRoute:()=>null,serverChainIdentity:()=>'',showStatus:()=>{},plainNumber:String,renderTopTraceCurrentTree:async()=>{},resetSearchQueue:()=>{},traceTopCandidate:async(start,player)=>({player,status:'found',job:{id:'fresh',start,target:player.username,status:'found',shortestVerified:true,chain:{found:true,path:[start,player.username]}}})});
 vm.runInContext(section('  function resetSearchQueue(', '  function compactJobId(')+section('  function topTraceProgress(', '  async function traceTopCandidate('),c);await c.runTopPlayersTrace();
 assert.equal(element('#search-queue').hidden,true);assert.equal(element('#search-log').hidden,true);assert.equal(element('#search-log').innerHTML,'');assert.equal(state.queueTimer,null);assert.equal(JSON.parse(values.get('active')).id,'ordinary-job');
});
