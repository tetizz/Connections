import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {__test} from '../src/index.js';

test('missing-player metadata survives job shaping only for its actual endpoints',()=>{
  const base={id:'owned-job',start:'alpha',target:'omega',status:'not_found',outcome:'not_found'};
  assert.equal(__test.searchJobShape({...base,missingPlayer:'omega'}).missingPlayer,'omega');
  assert.equal(__test.searchJobShape({...base,missingPlayer:'ALPHA'}).missingPlayer,'alpha');
  assert.equal(Object.hasOwn(__test.searchJobShape({...base,missingPlayer:'foreign'}),'missingPlayer'),false);
  assert.equal(Object.hasOwn(__test.searchJobShape(base),'missingPlayer'),false);
});

test('actual strict search persists and returns the missing endpoint without starting archives',async()=>{
  const original=globalThis.fetch;
  const values=new Map(),calls=[];
  const kv={async get(k,o){const v=values.get(k);return v==null?null:(o==='json'||o?.type==='json')?JSON.parse(v):v;},async put(k,v){values.set(k,v);},async delete(k){values.delete(k);}};
  globalThis.fetch=async input=>{
    const url=String(input);calls.push(url);
    if(url==='https://api.chess.com/pub/player/alpha')return new Response(JSON.stringify({username:'alpha'}),{headers:{'Content-Type':'application/json'}});
    if(url==='https://api.chess.com/pub/player/omega')return new Response(JSON.stringify({error:'not found'}),{status:404,headers:{'Content-Type':'application/json'}});
    throw Error('Unexpected upstream work: '+url);
  };
  try{
    const job=__test.searchJobShape({id:'missing-endpoint',start:'alpha',target:'omega',range:'auto',status:'running',stats:{},search:__test.initialSearchState('alpha','omega'),processingUntil:0,processingToken:''});
    await kv.put(__test.searchJobKey(job.id),JSON.stringify(job));
    await __test.runSearchJob({GAMES_CACHE:kv},job);
    const saved=JSON.parse(await kv.get(__test.searchJobKey(job.id)));
    assert.equal(saved.status,'not_found');assert.equal(saved.missingPlayer,'omega');
    const response=await worker.fetch(new Request('https://worker.test/search/job?id='+job.id),{GAMES_CACHE:kv},{waitUntil(){}});
    assert.equal(response.status,200);assert.equal((await response.json()).job.missingPlayer,'omega');
    assert.equal(calls.length,2);assert(calls.every(url=>!url.includes('/games')));
  }finally{globalThis.fetch=original;}
});
