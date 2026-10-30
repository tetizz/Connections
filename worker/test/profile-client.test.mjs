import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../../site/app.js',import.meta.url),'utf8');
const extract=(from,to)=>source.slice(source.indexOf(from),source.indexOf(to,source.indexOf(from)));
const functions=extract('  async function fetchProfile(username)','  function refreshGraphProfileNodes')+extract('  function metaShape(p)','  function timeAgo');
function harness(transport,clock=Date){const state={players:{},profilePromises:new Map()};const c=vm.createContext({state,window:{CONNECTIONS_CACHE_API:'https://worker.test'},Date:clock,cleanUsernameInput:s=>s.toLowerCase(),countryCode:s=>s,refreshGraphProfileNodes(){},fetchJsonWithRetry:transport});vm.runInContext(functions,c);return c;}

for(const cached of [false,true])test(`total profile failure preserves ${cached?'existing metadata':'null'} and suppresses retries for five seconds`,async()=>{
  let now=100000;const calls=[];
  const c=harness(async url=>{calls.push(url);throw Error('unavailable');},{now:()=>now});
  const existing={username:'alpha',name:'Saved name',avatar:'https://example.invalid/avatar.png'};
  if(cached)c.state.players.alpha=existing;
  assert.equal(await c.fetchProfile('alpha'),cached?existing:null);
  assert.equal(calls.length,2,'One Worker operation and one direct fallback operation');
  assert.equal(await c.fetchProfile('alpha'),cached?existing:null);
  now+=4999;assert.equal(await c.fetchProfile('alpha'),cached?existing:null);
  assert.equal(calls.length,2,'Cooldown calls must not invoke transport');
  assert.equal(c.state.players.alpha,cached?existing:undefined,'Failure must not fabricate or mutate player metadata');
  if(cached)assert.deepEqual(existing,{username:'alpha',name:'Saved name',avatar:'https://example.invalid/avatar.png'});
  now++;await c.fetchProfile('alpha');assert.equal(calls.length,4,'Retry becomes eligible at the five-second deadline');
});

test('direct profile 429 opts out of retries and suppresses both sources for full server deadline',async()=>{
  let now=100000;const calls=[];
  const c=harness(async(url,_init,options)=>{
    calls.push({url,options});
    if(url.startsWith('https://worker.test'))throw Error('worker unavailable');
    throw Object.assign(Error('direct cooldown'),{status:429,retryAfterMs:300000});
  },{now:()=>now});
  assert.equal(await c.fetchProfile('alpha'),null);
  assert.equal(calls.length,2);
  assert.equal(calls[1].options.stopOnRateLimit,true,'Direct lookup must stop its internal retry on 429');
  now+=299999;await c.fetchProfile('alpha');assert.equal(calls.length,2);
  now++;await c.fetchProfile('alpha');assert.equal(calls.length,4);
});

test('failure suppression is per username and a recovered profile remains usable',async()=>{
  let now=100000,recover=false;const calls=[];
  const c=harness(async url=>{
    calls.push(url);
    if(!recover&&url.includes('alpha'))throw Error('unavailable');
    return {data:{profile:{username:url.includes('beta')?'beta':'alpha',stats:{},enrichment:{stats:'fresh',recentGames:'fresh'}}}};
  },{now:()=>now});
  await c.fetchProfile('alpha');assert.equal(calls.length,2);
  const beta=await c.fetchProfile('beta');assert.equal(beta.username,'beta');assert.equal(calls.length,3);
  await c.fetchProfile('alpha');assert.equal(calls.length,3,'Another username must not clear alpha suppression');
  now+=5000;recover=true;
  const alpha=await c.fetchProfile('alpha');assert.equal(alpha.profileComplete,true);assert.equal(calls.length,4);
  assert.equal(await c.fetchProfile('alpha'),alpha);assert.equal(calls.length,4,'Recovered complete metadata uses existing cache');
});

for(const retryAfterMs of [undefined,0])test(`direct 429 with ${retryAfterMs===undefined?'missing':'zero'} retry duration suppresses both sources for at least sixty seconds`,async()=>{
  let now=100000;const calls=[];
  const c=harness(async url=>{
    calls.push(url);
    if(url.startsWith('https://worker.test'))throw Error('Worker unavailable');
    throw Object.assign(Error('direct cooldown'),{status:429,...(retryAfterMs===undefined?{}:{retryAfterMs})});
  },{now:()=>now});
  assert.equal(await c.fetchProfile('alpha'),null);assert.equal(calls.length,2);
  now+=5000;await c.fetchProfile('alpha');assert.equal(calls.length,2,'Ordinary failure deadline must not shorten a 429 cooldown');
  now+=54999;await c.fetchProfile('alpha');assert.equal(calls.length,2);
  now++;await c.fetchProfile('alpha');assert.equal(calls.length,4,'Retry is allowed at sixty seconds');
});

for(const cached of [false,true])test(`profile use prunes expired other-user failure entries on ${cached?'cached':'uncached'} path`,async()=>{
  let now=100000;let calls=0;
  const c=harness(async()=>{calls++;return {data:{profile:{username:'current',stats:{}}}};},{now:()=>now});
  // Failure deadlines are intentionally kept outside player metadata. Seed historical
  // users to verify bounded retention independently of the requested username.
  c.state.profileFailureRetryAt=new Map([['expired-one',now-1],['expired-two',now],['still-cooling',now+300000]]);
  const existing={username:'current',profileComplete:true};
  if(cached)c.state.players.current=existing;
  const result=await c.fetchProfile('current');
  assert.equal(c.state.profileFailureRetryAt.has('expired-one'),false);
  assert.equal(c.state.profileFailureRetryAt.has('expired-two'),false);
  assert.equal(c.state.profileFailureRetryAt.get('still-cooling'),now+300000,'Pruning must preserve unrelated live cooldowns');
  assert.equal(calls,cached?0:1);
  if(cached)assert.equal(result,existing);
});
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
