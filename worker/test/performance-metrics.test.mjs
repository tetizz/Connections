import test, {afterEach} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import {createPerformanceMetrics, requestDimensions} from '../src/performance-metrics.js';
const originalFetch=globalThis.fetch, originalLog=console.log;
afterEach(()=>{globalThis.fetch=originalFetch;console.log=originalLog;});
class KV {
  values=new Map();
  async get(key,options){const value=this.values.get(key);return value==null?null:options==='json'||options?.type==='json'?JSON.parse(value):value;}
  async put(key,value){this.values.set(key,value);}
}
const response=body=>Response.json(body);
const records=[];
function capture(){records.length=0;console.log=value=>{if(value?.event==='connections_performance_v1')records.push(value);};}
const profile=(kv,enabled='true')=>worker.fetch(new Request('https://worker.test/profile?username=private-name',{headers:{'X-Owner-Code':'private-owner'}}),{GAMES_CACHE:kv,PERFORMANCE_METRICS:enabled});

test('disabled metrics allocate no timer or record and dimensions exclude input values',()=>{
  assert.equal(createPerformanceMetrics({}, {}, {now(){throw Error('disabled timer called');}}),null);
  assert.deepEqual(requestDimensions(new Request('https://worker.test/private-path?token=private-token')), {route:'other',method:'GET'});
});

test('metric records are bounded, private-free, exactly once and fail independently',()=>{
  const emitted=[];let time=0;
  const m=createPerformanceMetrics({PERFORMANCE_METRICS:'true'},{route:'/profile',method:'GET',secret:'private-token'},{now:()=>time,emit:value=>emitted.push(value)});
  m.count('private-token');m.duration('upstream_wall_ms',Infinity);m.count('upstream_attempts');time=10;m.finish(200);m.finish(500);
  assert.equal(emitted.length,1);assert.equal(emitted[0].response_wall_ms,10);assert.equal(emitted[0].upstream_attempts,1);
  assert.ok(!JSON.stringify(emitted).includes('private-token'));
  createPerformanceMetrics({PERFORMANCE_METRICS:true},{},{emit(){throw Error('logger unavailable');}}).finish(200);
});

test('concurrent profile records attribute physical upstream work to one owner',async()=>{
  capture();const kv=new KV();let calls=0;
  globalThis.fetch=async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,5));return response({username:'private-name',archives:[]});};
  const results=await Promise.all(Array.from({length:12},()=>profile(kv)));
  assert.equal(calls,3);assert.equal(records.length,12);
  assert.equal(records.reduce((sum,row)=>sum+row.upstream_attempts,0),3);
  // One profile owner also owns the distinct internal games fill.
  assert.equal(records.reduce((sum,row)=>sum+row.cold_fill_owned,0),2);
  const physicalOwners=records.filter(row=>row.upstream_attempts>0);
  assert.equal(physicalOwners.length,1);
  assert.equal(physicalOwners[0].cold_fill_owned,2);
  assert.equal(records.reduce((sum,row)=>sum+row.cold_fill_shared,0),11);
  assert.ok(!JSON.stringify(records).includes('private-name'));assert.ok(!JSON.stringify(records).includes('private-owner'));
  assert.ok(results.every(result=>result.status===200));
  records.length=0;await profile(kv);
  assert.equal(records[0].cache_fresh,1);assert.equal(records[0].upstream_attempts,0);
});

test('cooldown and disabled records retain the actual response behavior',async()=>{
  capture();const kv=new KV();await kv.put('games:ratelimit:chesscom',JSON.stringify({until:Date.now()+60000}));
  globalThis.fetch=async()=>{throw Error('cooldown called upstream');};
  assert.equal((await profile(kv)).status,429);
  assert.equal(records[0].cooldown,1);assert.equal(records[0].upstream_attempts,0);assert.equal(records[0].status,429);
  records.length=0;assert.equal((await profile(kv,'false')).status,429);assert.equal(records.length,0);
});

test('unmeasured routes use null counters instead of implying zero upstream work',async()=>{
  capture();const result=await worker.fetch(new Request('https://worker.test/health'),{PERFORMANCE_METRICS:'true'});
  assert.equal(result.status,200);assert.equal(records[0].detail_scope,'route-only');
  assert.equal(records[0].upstream_attempts,null);assert.equal(records[0].cache_fresh,null);
  assert.ok(Number.isFinite(records[0].response_wall_ms));
});

test('transport failure retains verified stale cache and records the actual failed attempt',async()=>{
  capture();const kv=new KV();await kv.put('profile:private-name',JSON.stringify({ts:0,profile:{username:'private-name',stats:{rapid:{rating:1600}},recentGames:[]}}));
  globalThis.fetch=async()=>{throw Error('offline transport fixture');};
  const result=await profile(kv),body=await result.json();
  assert.equal(result.status,200);assert.equal(body.stale,true);assert.equal(body.profile.stats.rapid.rating,1600);
  assert.equal(records[0].cache_miss,1);assert.equal(records[0].cache_stale,1);
  assert.equal(records[0].upstream_attempts,1);assert.equal(records[0].upstream_transport_errors,1);
  assert.ok(Number.isFinite(records[0].upstream_wall_ms));
});

test('malformed JSON is a parse failure and never a transport or successful enrichment',async()=>{
  capture();globalThis.fetch=async()=>new Response('malformed-json',{status:200});
  assert.equal((await profile(new KV())).status,502);
  assert.equal(records[0].status,502);assert.equal(records[0].upstream_attempts,1);
  assert.equal(records[0].upstream_transport_errors,0);assert.equal(records[0].partial_enrichment,0);
  assert.ok(Number.isFinite(records[0].json_parse_wall_ms));
});

test('scheduled records label total operation time and leave detail counters unmeasured',()=>{
  let time=0;const emitted=[];
  const m=createPerformanceMetrics({PERFORMANCE_METRICS:true},{handler:'scheduled',route:'/search/warm',method:'OTHER'},{now:()=>time,emit:value=>emitted.push(value)});
  m.count('upstream_attempts');time=20;m.finish(500);
  assert.equal(emitted[0].handler,'scheduled');assert.equal(emitted[0].operation_wall_ms,20);
  assert.equal(emitted[0].response_wall_ms,undefined);assert.equal(emitted[0].upstream_attempts,null);
  assert.equal(emitted[0].status,500);
});
