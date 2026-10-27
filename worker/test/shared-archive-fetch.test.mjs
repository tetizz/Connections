import test from 'node:test';
import assert from 'node:assert/strict';
import { shareArchiveFetch } from '../src/shared-archive-fetch.js';

const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };
const turn = () => new Promise(setImmediate);

test('three overlapping consumers share one raw fill with independent response objects', async () => {
  const binding={}, gate=deferred(); let calls=0;
  const fill=async()=>{ calls++; return gate.promise; };
  const pending=[1,2,3].map(()=>shareArchiveFetch(binding,'alpha/month',fill));
  await turn(); assert.equal(calls,1);
  gate.resolve({data:{games:[{id:1}]},observedAt:1000,expiresAt:2000});
  const values=await Promise.all(pending);
  values[0].data.games[0].id=99;
  assert.equal(values[1].data.games[0].id,1);
  assert.deepEqual(values[1],{data:{games:[{id:1}]},observedAt:1000,expiresAt:2000});
  await shareArchiveFetch(binding,'alpha/month',async()=>{calls++;return {data:[]};});
  assert.equal(calls,2,'settled fills do not become an unbounded second cache');
});

test('different bindings and exact URLs keep their own fills', async () => {
  let calls=0; const fill=async()=>{calls++;return {data:[]};}; const binding={};
  await Promise.all([shareArchiveFetch(binding,'a',fill),shareArchiveFetch({},'a',fill),shareArchiveFetch(binding,'b',fill)]);
  assert.equal(calls,3);
});

test('cancelling the first caller does not cancel another search', async () => {
  const binding={}, gate=deferred(), first=new AbortController(), second=new AbortController(); let upstream;
  const fill=async signal=>{upstream=signal;return gate.promise;};
  const a=shareArchiveFetch(binding,'a',fill,{signal:first.signal});
  const aRejected=assert.rejects(a,{name:'AbortError'});
  const b=shareArchiveFetch(binding,'a',fill,{signal:second.signal});
  await turn(); first.abort(); await aRejected;
  assert.equal(upstream.aborted,false);
  gate.resolve({games:[1]}); assert.deepEqual(await b,{games:[1]});
});

test('all callers cancelling aborts transport and a new request can retry', async () => {
  const binding={}, a=new AbortController(), b=new AbortController(); let upstream;
  const fill=signal=>new Promise((resolve,reject)=>{upstream=signal;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
  const pa=shareArchiveFetch(binding,'a',fill,{signal:a.signal}), pb=shareArchiveFetch(binding,'a',fill,{signal:b.signal});
  const rejected=[assert.rejects(pa,{name:'AbortError'}),assert.rejects(pb,{name:'AbortError'})];
  await turn(); a.abort(); b.abort(); await Promise.all(rejected); assert.equal(upstream.aborted,true);
  assert.deepEqual(await shareArchiveFetch(binding,'a',async()=>({games:[2]})),{games:[2]});
});

test('already cancelled callers never start a provider fill', async () => {
  const controller=new AbortController(); controller.abort(); let calls=0;
  await assert.rejects(shareArchiveFetch({},'a',async()=>{calls++;return {};},{signal:controller.signal}),{name:'AbortError'});
  assert.equal(calls,0);
});

test('a shared provider failure rejects every waiter and never poisons a retry', async () => {
  const binding={}, gate=deferred();let calls=0;
  const fill=()=>{calls++;return gate.promise;};
  const a=shareArchiveFetch(binding,'a',fill),b=shareArchiveFetch(binding,'a',fill);
  const rejected=[assert.rejects(a,/503/),assert.rejects(b,/503/)];
  await turn();gate.reject(new Error('HTTP 503'));await Promise.all(rejected);assert.equal(calls,1);
  assert.deepEqual(await shareArchiveFetch(binding,'a',async()=>({ok:true})),{ok:true});
});

test('overflow fills remain bounded and retain independent cancellation', async () => {
  const binding={}, controller=new AbortController(), gate=deferred();let calls=0;
  const fill=async()=>{calls++;return gate.promise;};
  const held=Array.from({length:128},(_,i)=>shareArchiveFetch(binding,String(i),fill));
  const overflow=shareArchiveFetch(binding,'overflow',fill,{signal:controller.signal});
  const rejected=assert.rejects(overflow,{name:'AbortError'});
  await turn();assert.equal(calls,129);controller.abort();await rejected;
  gate.resolve({ok:true});await Promise.all(held);
});

test('small completed responses bridge delayed callers without renewing freshness', async () => {
  const originalNow=Date.now;let now=originalNow();Date.now=()=>now;
  try {
    const binding={};let calls=0;
    const fill=async()=>{calls++;return {data:[1],observedAt:now,reuseUntil:now+10000};};
    const first=await shareArchiveFetch(binding,'a',fill);first.data.push(2);
    now+=1000;
    const second=await shareArchiveFetch(binding,'a',fill);
    assert.equal(calls,1);assert.deepEqual(second.data,[1]);assert.equal(second.observedAt,now-1000);
    now+=1001;await shareArchiveFetch(binding,'a',fill);assert.equal(calls,2);
    const expired=async()=>{calls++;return {data:[],observedAt:now,reuseUntil:now};};
    await shareArchiveFetch(binding,'expired',expired);await shareArchiveFetch(binding,'expired',expired);assert.equal(calls,4);
  } finally {Date.now=originalNow;}
});

test('large responses are not retained and the recent response byte budget evicts older entries', async () => {
  const binding={},calls=new Map();
  const fill=(key,size)=>async()=>{calls.set(key,(calls.get(key)||0)+1);const now=Date.now();return {data:'x'.repeat(size),observedAt:now,reuseUntil:now+10000};};
  await shareArchiveFetch(binding,'large',fill('large',1024*1024+1));
  await shareArchiveFetch(binding,'large',fill('large',1024*1024+1));assert.equal(calls.get('large'),2);
  for(let i=0;i<5;i++)await shareArchiveFetch(binding,'bounded'+i,fill('bounded'+i,900000));
  await shareArchiveFetch(binding,'bounded0',fill('bounded0',900000));assert.equal(calls.get('bounded0'),2);
});

test('forced refresh bypasses completed envelopes but can still join an unfinished provider response',async()=>{
  const binding={},gate=deferred();let calls=0;
  const fill=async()=>{calls++;await gate.promise;const now=Date.now();return {generation:calls,observedAt:now,reuseUntil:now+10000};};
  const a=shareArchiveFetch(binding,'a',fill),b=shareArchiveFetch(binding,'a',fill,{reuseCompleted:false});
  await turn();assert.equal(calls,1);gate.resolve();await Promise.all([a,b]);
  assert.equal((await shareArchiveFetch(binding,'a',fill)).generation,1);
  assert.equal((await shareArchiveFetch(binding,'a',fill,{reuseCompleted:false})).generation,2);
  assert.equal((await shareArchiveFetch(binding,'a',fill)).generation,2);
});

test('completed responses cross request contexts as plain data without touching an old controller',async()=>{
  const OriginalController=globalThis.AbortController;let context=1;
  globalThis.AbortController=class {
    constructor(){this.owner=context;this.inner=new OriginalController();}
    get signal(){if(this.owner!==context)throw new Error('Cannot perform I/O on behalf of a different request.');return this.inner.signal;}
    abort(reason){this.inner.abort(reason);}
  };
  try {
    const binding={};let calls=0;
    const fill=async()=>{calls++;const now=Date.now();return {data:[calls],observedAt:now,reuseUntil:now+10000};};
    await shareArchiveFetch(binding,'a',fill);context=2;
    assert.deepEqual((await shareArchiveFetch(binding,'a',fill)).data,[1]);assert.equal(calls,1);
    assert.deepEqual((await shareArchiveFetch(binding,'a',fill,{reuseCompleted:false})).data,[2]);
  } finally {globalThis.AbortController=OriginalController;}
});

test('pending cross-Durable-Object controller ownership safely declines sharing instead of failing a search',async()=>{
  const OriginalController=globalThis.AbortController;let context=1;
  globalThis.AbortController=class {
    constructor(){this.owner=context;this.inner=new OriginalController();}
    get signal(){if(this.owner!==context)throw new Error('Cannot perform I/O on behalf of a different Durable Object in the same isolate.');return this.inner.signal;}
    abort(reason){this.inner.abort(reason);}
  };
  try {
    const binding={},gate=deferred();let calls=0;
    const fill=async()=>{calls++;return gate.promise;};
    const first=shareArchiveFetch(binding,'a',fill);await turn();context=2;
    const second=shareArchiveFetch(binding,'a',fill);await turn();assert.equal(calls,2);
    gate.resolve({ok:true});assert.deepEqual(await Promise.all([first,second]),[{ok:true},{ok:true}]);
  } finally {globalThis.AbortController=OriginalController;}
});
