import test,{afterEach} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
const originalFetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=originalFetch;});
class KV{
  values=new Map();
  async get(key,options){const value=this.values.get(key);return value==null?null:options==='json'||options?.type==='json'?JSON.parse(value):value;}
  async put(key,value){this.values.set(key,value);}
}
const response=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
const request=(kv,route)=>worker.fetch(new Request('https://worker.test'+route),{GAMES_CACHE:kv});
function month(number){return {games:Array.from({length:3},(_,index)=>({rules:'chess',white:{username:'alpha',result:'win'},black:{username:'beta'+index,result:'resigned'},url:`https://www.chess.com/game/live/${number*10+index}`,time_class:'rapid',end_time:1700000000+number*100+index}))};}

async function pairFixture({profileFirst=false,separateBinding=false,failWrite=false}={}){
  const kv=new KV(),historyKV=separateBinding?new KV():kv;
  const normalPut=kv.put.bind(kv);let failedWrite=false;
  kv.put=async(key,value)=>{if(failWrite&&!failedWrite&&key.startsWith('games:')&&!key.includes('ratelimit')){failedWrite=true;throw Error('Fixture KV write failed');}return normalPut(key,value);};
  let release,arrived,statsDone;
  const gate=new Promise(resolve=>{release=resolve;});
  const firstArchive=new Promise(resolve=>{arrived=resolve;});
  const statsStarted=new Promise(resolve=>{statsDone=resolve;});
  const counts={core:0,stats:0,archives:0,months:0};
  globalThis.fetch=async raw=>{
    const url=String(raw);
    if(url.endsWith('/stats')){counts.stats++;statsDone();return response({chess_rapid:{last:{rating:1777},record:{win:4,loss:2,draw:1}}});}
    if(url.endsWith('/games/archives')){counts.archives++;arrived();await gate;return response({archives:['https://fixture.test/month/1','https://fixture.test/month/2']});}
    if(url.startsWith('https://fixture.test/month/')){counts.months++;return response(month(Number(url.split('/').pop())));}
    counts.core++;return response({username:'alpha',name:'Alpha',country:'https://api.chess.com/pub/country/US'});
  };
  let profilePending,historyPending;
  if(profileFirst){profilePending=request(kv,'/profile?username=alpha');await firstArchive;historyPending=request(historyKV,'/games?key=alpha:recent:2');}
  else{historyPending=request(historyKV,'/games?key=alpha:recent:2');await firstArchive;profilePending=request(kv,'/profile?username=alpha');}
  const pending=[profilePending,historyPending];
  try{await Promise.all([firstArchive,statsStarted]);await new Promise(setImmediate);}finally{release();}
  const replies=await Promise.all(pending);
  const [profile,history]=await Promise.all(replies.map(r=>r.json()));
  return {kv,historyKV,profile,history,statuses:replies.map(r=>r.status),counts};
}
function assertComplete({kv,profile,history,statuses},checkStored=true){
  assert.deepEqual(statuses,[200,200]);
  assert.equal(profile.profile.stats.rapid.rating,1777);
  assert.equal(profile.profile.recentGames.length,5);
  assert.deepEqual(profile.profile.enrichment,{stats:'fresh',recentGames:'fresh',retryAfterSeconds:60});
  assert.equal(history.games.length,6);
  assert.deepEqual(profile.profile.recentGames.map(g=>g.url),[...history.games].sort((a,b)=>b.endTime-a.endTime).slice(0,5).map(g=>g.url));
  if(checkStored){
    const stored=JSON.parse(kv.values.get('games:alpha:recent:2'));
    assert.deepEqual(stored.games,history.games);
  }
}
for(const profileFirst of [false,true])test(`complete profile/history share full fill with ${profileFirst?'profile':'games'} owner`,async()=>{
  const value=await pairFixture({profileFirst});assertComplete(value);
  assert.deepEqual(value.counts,{core:1,stats:1,archives:1,months:2});
});
test('different bindings retain independent full profile/history fills',async()=>{
  const value=await pairFixture({separateBinding:true});assertComplete(value);
  assert.deepEqual(value.counts,{core:1,stats:1,archives:2,months:4});
});
test('best-effort shared KV write failure preserves responses and a fresh fill retries caching',async()=>{
  const value=await pairFixture({failWrite:true});
  // putGamesCache intentionally logs storage failures without rejecting data.
  assertComplete(value,false);
  assert.equal(value.kv.values.has('games:alpha:recent:2'),false);
  value.kv.values.delete('profile:alpha');
  const replies=await Promise.all([request(value.kv,'/profile?username=alpha'),request(value.kv,'/games?key=alpha:recent:2')]);
  const [profile,history]=await Promise.all(replies.map(r=>r.json()));
  assertComplete({kv:value.kv,profile,history,statuses:replies.map(r=>r.status)});
  assert.equal(value.counts.archives,2);
  assert.equal(value.counts.months,4);
});
