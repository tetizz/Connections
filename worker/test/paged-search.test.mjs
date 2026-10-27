import test from 'node:test';
import assert from 'node:assert/strict';
import {pagedSearchAction} from '../src/paged-search.js';
const url=id=>`https://www.chess.com/game/live/${id}`;
class Storage {
  values=new Map();
  async get(key){if(Array.isArray(key))assert.ok(key.length<=128);return Array.isArray(key)?new Map(key.filter(k=>this.values.has(k)).map(k=>[k,structuredClone(this.values.get(k))])):structuredClone(this.values.get(key));}
  async put(key,value){if(typeof key==='object'){assert.ok(Object.keys(key).length<=128);for(const[k,v]of Object.entries(key))this.values.set(k,structuredClone(v));}else this.values.set(key,structuredClone(value));}
  async delete(key){for(const k of Array.isArray(key)?key:[key])this.values.delete(k);}
  async transaction(fn){const before=structuredClone(this.values);try{return await fn();}catch(e){this.values=before;throw e;}}
}
async function fixture(edges={}) {
  const storage=new Storage(),token='owned-lease-token';
  await storage.put('job',{id:'paged-job',policyVersion:'fresh-search-v2',start:'alpha',target:'omega',status:'running',processingToken:token,processingUntil:Date.now()+60000,search:{sinceMonth:'0000/01'}});
  const action=(kind,payload={})=>pagedSearchAction(storage,kind,{token,...payload});
  async function step(){let work=await action('full-bfs-load');assert.equal(work.accepted,true);
    if(work.terminal)return work;
    if(!work.staged){const rows=edges[`${work.side}:${work.node}`]||[];work=await action('full-bfs-stage',{version:work.version,node:work.node,edges:rows});assert.equal(work.accepted,true);}
    return action('full-bfs-advance',{version:work.version});
  }
  return{storage,token,action,step};
}
test('lossless queue admits opponents beyond800 and visited beyond8000, then proves shorter route',async()=>{
  const nodes=Array.from({length:9100},(_,i)=>[`node${i}`,url(10000+i)]);
  const f=await fixture({'forward:alpha':nodes,'backward:omega':[['node9099',url(99999)]]});
  let r;for(let i=0;i<200;i++){r=await f.step();if(r.terminal)break;}
  assert.equal(r.terminal?.status,'found');assert.equal(r.terminal.shortestVerified,true);
  assert.deepEqual(r.best.path,['alpha','node9099','omega']);assert.ok(r.visited>9000);
  assert.ok([...f.storage.values.keys()].filter(k=>k.includes(':queue:forward:1:')).length>64);
  assert.ok([...f.storage.values].every(([,v])=>JSON.stringify(v).length<32*1024),'native values remain paged');
});
test('staged adjacency and cursor survive reconstructed callers without duplicate or missing nodes',async()=>{
  const f=await fixture({'forward:alpha':Array.from({length:300},(_,i)=>[`n${i}`,url(1000+i)]),'backward:omega':[['n299',url(5000)]]});
  let work=await f.action('full-bfs-load');const staged=await f.action('full-bfs-stage',{version:work.version,node:work.node,edges:Array.from({length:300},(_,i)=>[`n${i}`,url(1000+i)])});
  const first=await f.action('full-bfs-advance',{version:staged.version});
  assert.equal((await f.action('full-bfs-advance',{version:staged.version})).accepted,false,'stale commit cannot replay');
  const reloaded=await pagedSearchAction(f.storage,'full-bfs-load',{token:f.token});
  assert.equal(reloaded.staged,true);assert.equal(reloaded.visited,66);
  let r=first;for(let i=0;i<10&&!r.terminal;i++)r=await f.step();
  assert.deepEqual(r.best.path,['alpha','n299','omega']);assert.equal(r.visited,303);
});
test('a failed root is retained while other-side work continues, never false absence',async()=>{
  const f=await fixture();let work=await f.action('full-bfs-load');
  assert.equal(work.node,'alpha');await f.action('full-bfs-defer',{version:work.version,node:work.node});
  work=await f.action('full-bfs-load');assert.equal(work.node,'omega');assert.equal(work.incomplete,true);
  const staged=await f.action('full-bfs-stage',{version:work.version,node:work.node,edges:[['middle',url(100)]]});
  await f.action('full-bfs-advance',{version:staged.version});
  work=await f.action('full-bfs-load');assert.equal(work.node,'alpha');assert.equal(work.terminal,null);
  const repaired=await f.action('full-bfs-stage',{version:work.version,node:'alpha',edges:[['middle',url(101)]]});
  const result=await f.action('full-bfs-advance',{version:repaired.version});
  assert.equal(result.incomplete,false);assert.equal(result.terminal.shortestVerified,true);
  assert.deepEqual(result.best.path,['alpha','middle','omega']);
});
test('wrong or expired native lease cannot create or change search records',async()=>{
  const f=await fixture();assert.equal((await pagedSearchAction(f.storage,'full-bfs-load',{token:'wrong'})).accepted,false);
  const job=await f.storage.get('job');job.processingUntil=Date.now()-1;await f.storage.put('job',job);
  assert.equal((await f.action('full-bfs-load')).accepted,false);assert.equal(f.storage.values.size,1);
});

test('a traversal three-hop witness proves shortest on its first page after both roots complete',async()=>{
 const roots=Array.from({length:100},(_,i)=>[`left${i}`,url(1000+i)]),backs=Array.from({length:100},(_,i)=>[`right${i}`,url(2000+i)]);
 const f=await fixture({'forward:alpha':roots,'backward:omega':backs});
 await f.step();await f.step();await f.step();await f.step();
 let w=await f.action('full-bfs-load');assert.equal(w.depth,1);
 const side=w.side,opposite=side==='forward'?'right0':'left0';
 const staged=await f.action('full-bfs-stage',{version:w.version,node:w.node,edges:[[opposite,url(3000)],...Array.from({length:130},(_,i)=>[`extra${i}`,url(4000+i)])]});
 const r=await f.action('full-bfs-advance',{version:staged.version});
 assert.equal(r.terminal?.shortestVerified,true);assert.equal(r.best.hops.length,3);
 assert.ok((await f.storage.get('full-bfs:v1:meta')).staged,'proof does not wait for unrelated remaining adjacency pages');
});

test('partial frontiers cannot prove a three-hop candidate while shorter discovery layers remain incomplete',async()=>{
 const f=await fixture({'backward:omega':[['bridge',url(8001)]]});let w=await f.action('full-bfs-load');
 let s=await f.action('full-bfs-stage',{version:w.version,node:w.node,edges:[['middle',url(8000)]],incomplete:true});await f.action('full-bfs-advance',{version:s.version});
 await f.step();w=await f.action('full-bfs-load');
 if(w.node==='alpha'){s=await f.action('full-bfs-stage',{version:w.version,node:w.node,edges:[['middle',url(8000)]],incomplete:true});await f.action('full-bfs-advance',{version:s.version});w=await f.action('full-bfs-load');}
 s=await f.action('full-bfs-stage',{version:w.version,node:w.node,edges:[['middle',url(8002)]],incomplete:true});const candidate=await f.action('full-bfs-advance',{version:s.version});
 assert.equal(candidate.best?.hops.length,3);assert.equal(candidate.terminal,null);
});
