import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../../site/app.js',import.meta.url),'utf8');
const extract=(from,to)=>source.slice(source.indexOf(from),source.indexOf(to,source.indexOf(from)));
const functions=extract('  async function fetchProfile(username)','  function refreshGraphProfileNodes')+extract('  function metaShape(p)','  function timeAgo');
function harness(transport){const state={players:{},profilePromises:new Map()};const c=vm.createContext({state,window:{CONNECTIONS_CACHE_API:'https://worker.test'},Date,cleanUsernameInput:s=>s.toLowerCase(),countryCode:s=>s,refreshGraphProfileNodes(){},fetchJsonWithRetry:transport});vm.runInContext(functions,c);return c;}
test('partial client details remain retryable without repeatedly calling before the retry time',async()=>{
  let calls=0;
  const c=harness(async()=>{calls++;return {data:{partial:true,profile:{username:'alpha',stats:{},recentGames:[],enrichment:{stats:'unavailable',recentGames:'fresh',retryAfterSeconds:60}}}};});
  const first=await c.fetchProfile('alpha');const second=await c.fetchProfile('alpha');
  assert.equal(calls,1);assert.equal(first,second);assert.equal(first.profileComplete,false);assert.equal(first.profilePartial,true);assert.equal(first.enrichment.stats,'unavailable');
});
test('known Worker cooldown never falls through to a direct Chess.com request',async()=>{
  let calls=0;
  const c=harness(async()=>{calls++;throw Object.assign(new Error('rate limited'),{status:429,retryAfterMs:300000});});
  const result=await c.fetchProfile('alpha');await c.fetchProfile('alpha');
  assert.equal(calls,1);assert.equal(result.profilePartial,true);assert.equal(result.profileComplete,false);
});
test('stale verified Worker sections remain marked stale in the client',async()=>{
  const c=harness(async()=>({data:{stale:true,retryAfter:60,profile:{username:'alpha',stats:{rapid:{rating:1700}},recentGames:[]}}}));
  const result=await c.fetchProfile('alpha');assert.equal(result.enrichment.stats,'stale');assert.equal(result.stats.rapid.rating,1700);assert.equal(result.profileComplete,false);
});
test('profile rate limits stop browser retries and retain the complete cooldown duration',async()=>{
  let calls=0;
  const c=vm.createContext({setTimeout,clearTimeout,AbortController,REQUEST_TIMEOUT_MS:7000,retryAfterMs:()=>5000,wait:async()=>{},fetch:async()=>{calls++;return new Response(JSON.stringify({error:'rate limited',retryAfter:300}),{status:429,headers:{'Content-Type':'application/json'}});}});
  vm.runInContext(extract('  async function fetchJsonWithRetry','  // ---------- data load'),c);
  await assert.rejects(c.fetchJsonWithRetry('https://worker.test/profile',{}, {attempts:2,stopOnRateLimit:true}),error=>error.status===429&&error.retryAfterMs===300000);
  assert.equal(calls,1);
});
test('unavailable stats do not tell visitors that the player has no rating',()=>{
  const c=vm.createContext({plainNumber:String,esc:String});
  vm.runInContext(extract('  function renderProfileStats','  function renderProfileRecentGames'),c);
  assert.match(c.renderProfileStats({},true),/Unavailable/);assert.doesNotMatch(c.renderProfileStats({},true),/No rating/);
  assert.match(c.renderProfileStats({},false),/No rating/);
});
