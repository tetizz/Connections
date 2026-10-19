import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';

const relays=[
  {name:'Connections API',file:'../../api-pages/public/_worker.js',binding:'CONNECTIONS',origin:'https://connections-cache.tetizz.workers.dev'},
  {name:'legacy leaderboard',file:'../../legacy-leaderboard-pages/public/_worker.js',binding:'LEGACY_LEADERBOARD',origin:'https://chess-connections-leaderboard.tetizz.workers.dev'},
];
// Data-URL import permits the same standalone Pages source independently of
// repository package type; no backend module or real transport is loaded.
for(const relay of relays){
 const source=await readFile(new URL(relay.file,import.meta.url),'utf8');
 const {default:proxy}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));

 test(`${relay.name}: forwards methods, encoded path/query, headers and body without following redirects`,async t=>{
  for(const method of ['GET','HEAD','OPTIONS','POST','PUT','PATCH','DELETE'])await t.test(method,async()=>{
   const hasBody=['POST','PUT','PATCH','DELETE'].includes(method),payload='{"opaque":"literal + % &"}';
   const headers={'x-public-contract':'preserve-me',origin:'https://tetizz-connections.pages.dev',accept:'application/json'};
   if(hasBody)headers['content-type']='application/json';
   const incoming=new Request('https://public.pages.dev/custom%20path/nested?a=1&a=2&token=%2B%2F%3D',{method,headers,...(hasBody?{body:payload}:{})});
   let calls=0;const response=new Response(null,{status:307,headers:{location:'/unchanged?x=1'}});
   const returned=await proxy.fetch(incoming,{[relay.binding]:{fetch:async forwarded=>{
    calls++;assert.equal(forwarded.url,relay.origin+'/custom%20path/nested?a=1&a=2&token=%2B%2F%3D');
    assert.equal(forwarded.method,method);assert.equal(forwarded.redirect,'manual');
    assert.deepEqual([...forwarded.headers],[...incoming.headers]);
    assert.equal(await forwarded.text(),hasBody?payload:'');return response;
   }}});
   assert.equal(calls,1);assert.equal(returned,response);assert.equal(returned.headers.get('location'),'/unchanged?x=1');
  });
 });

 test(`${relay.name}: returns original streamed response and upgrade sentinel by identity`,async()=>{
  const stream=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('stream chunk'));controller.close();}});
  const response=new Response(stream,{status:200,headers:{'x-identity':'unchanged','cache-control':'no-store'}});
  const actual=await proxy.fetch(new Request('https://public.pages.dev/stream'),{[relay.binding]:{fetch:async()=>response}});
  assert.equal(actual,response);assert.equal(actual.body,stream);assert.equal(await actual.text(),'stream chunk');
  // Node cannot construct a native101 Response. This sentinel proves the relay
  // never reconstructs its service result; native upgrade qualification is separate.
  const socket={opaque:true},upgrade={status:101,webSocket:socket};
  const result=await proxy.fetch(new Request('https://public.pages.dev/socket',{headers:{upgrade:'websocket'}}),{[relay.binding]:{fetch:async forwarded=>{assert.equal(forwarded.headers.get('upgrade'),'websocket');return upgrade;}}});
  assert.equal(result,upgrade);assert.equal(result.webSocket,socket);
 });

 test(`${relay.name}: service rejection propagates without synthetic fallback`,async()=>{
  const error=new Error('fixed service failure');
  await assert.rejects(async()=>proxy.fetch(new Request('https://public.pages.dev/fail'),{[relay.binding]:{fetch:async()=>{throw error;}}}),actual=>actual===error);
 });
}
