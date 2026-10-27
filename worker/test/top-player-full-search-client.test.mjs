import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import savedRoutes from '../../site/saved-routes.js';
const source=readFileSync(new URL('../../site/app.js',import.meta.url),'utf8');
const section=(from,to)=>source.slice(source.indexOf(from),source.indexOf(to,source.indexOf(from)));
const route=path=>({found:true,path,hops:path.slice(1).map((to,i)=>({from:path[i],to,url:`https://www.chess.com/game/live/${i+1}`}))});
function harness(responses){const requests=[],updates=[]; const state={topTraceRunId:1,topTraceResults:[]}; const c=vm.createContext({state,Date,JSON,window:{SavedRoutes:savedRoutes},pathHasBlockedUser:()=>false,Map,Set,console,URLSearchParams,cleanUsernameInput:s=>String(s||'').toLowerCase(),performance:{now:()=>10},newSearchEventId:()=> 'event-1',workerBase:()=> 'https://test.example',SEARCH_POLICY_VERSION:'fresh-search-v2',TERMINAL_SEARCH_STATUSES:new Set(['found','not_found','timeout','failed','expired']),TOP_TRACE_HARD_LIMIT_MS:240000,TOP_TRACE_POLL_INTERVAL_MS:140,SERVER_POLL_RETRY_LIMIT:5,$:()=>({value:'all'}),setTimeout:fn=>fn(),wait:async()=>{},saveTopTraceBatch:()=>{},rememberVerifiedRoute:()=>{},savedVerifiedRoute:()=>null,topTraceProgress:()=>({}),renderTopTraceCurrentTree:()=>{},showStatus:()=>{},plainNumber:String,fetchJsonWithRetry:async(url,options)=>{requests.push({url,options});const response=responses.shift(); if(response instanceof Error)throw response;return {data:response};},fetch:async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>responses.shift()};}});vm.runInContext(section('  async function traceTopCandidate(', '  function sortedTopTraceResults('),c);return {c,requests,updates,state};}
test('top-player trace keeps polling after a provisional route and returns the shorter finished route',async()=>{const f=harness([{job:{id:'job-1',start:'alpha',target:'omega',status:'running',policyVersion:'fresh-search-v2',chain:route(['alpha','one','two','omega'])}},{job:{id:'job-1',start:'alpha',target:'omega',status:'found',policyVersion:'fresh-search-v2',shortestVerified:true,chain:route(['alpha','one','omega'])}}]);const result=await f.c.traceTopCandidate('alpha',{username:'omega'},1);assert.equal(result.steps,2);assert.equal(result.job.shortestVerified,true);assert.equal(f.requests.length,2);assert.match(f.requests[1].url,/search\/job/);});
test('top-player trace rejects an old-policy job instead of presenting it as a finished search',async()=>{const f=harness([{job:{id:'old',status:'found',policyVersion:'old-policy',chain:route(['alpha','omega'])}}]);const result=await f.c.traceTopCandidate('alpha',{username:'omega'},1);assert.notEqual(result.status,'found');assert.match(result.error,/older|policy|fresh/i);});


test('top-player start requests full history and uses retry-capable server transport',async()=>{
 const f=harness([{job:{id:'full',start:'alpha',target:'omega',status:'found',policyVersion:'fresh-search-v2',shortestVerified:true,chain:route(['alpha','omega'])}}]);
 const result=await f.c.traceTopCandidate('alpha',{username:'omega'},1);
 assert.equal(JSON.parse(f.requests[0].options.body).range,'all');assert.equal(result.status,'found');
});
test('a lost poll leaves the durable job available for resume instead of erasing its route',async()=>{
 const first={id:'job-1',start:'alpha',target:'omega',status:'running',policyVersion:'fresh-search-v2',chain:route(['alpha','mid','omega'])};
 const f=harness([{job:first},new Error('temporary network failure')]);
 const result=await f.c.traceTopCandidate('alpha',{username:'omega'},1);
 assert.equal(result.status,'paused');assert.equal(result.job.id,'job-1');assert.equal(result.job.status,'running');assert.equal(result.job.chain.path.length,3);
});
test('resuming a top-player job polls the same durable id and does not create a duplicate search',async()=>{
 const first={id:'job-1',start:'alpha',target:'omega',status:'running',policyVersion:'fresh-search-v2',chain:route(['alpha','mid','omega'])};
 const f=harness([{job:{...first,status:'found',shortestVerified:true}}]);
 const result=await f.c.traceTopCandidate('alpha',{username:'omega'},1,{existing:{job:first,searchId:'same-id'}});
 assert.equal(result.status,'found');assert.equal(f.requests.length,1);assert.match(f.requests[0].url,/search\/job\?id=job-1/);assert.equal(f.requests[0].options.method,undefined);
});

test('a response for another pair cannot be shown in the requested top-player branch',async()=>{
 const f=harness([{job:{id:'wrong-pair',start:'someoneelse',target:'omega',status:'found',policyVersion:'fresh-search-v2',shortestVerified:true,chain:route(['someoneelse','omega'])}}]);
 const result=await f.c.traceTopCandidate('alpha',{username:'omega'},1);assert.notEqual(result.status,'found');assert.equal(result.job,null);assert.match(result.error,/pair|requested/i);
});
test('a proof path with different endpoints is rejected even when the job labels match',async()=>{
 const f=harness([{job:{id:'wrong-route',start:'alpha',target:'omega',status:'found',policyVersion:'fresh-search-v2',shortestVerified:true,chain:route(['alpha','beta'])}}]);
 const result=await f.c.traceTopCandidate('alpha',{username:'omega'},1);assert.notEqual(result.status,'found');assert.equal(result.job,null);assert.match(result.error,/proof|route|requested/i);
});
