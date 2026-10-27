import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../../site/_worker.js',import.meta.url),'utf8');
const {default:site}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));

test('same-origin search API preserves request and response identity through the existing service',async()=>{
  let calls=0;
  const response=new Response('{"job":{"id":"same-job"}}',{status:202,headers:{'content-type':'application/json','cache-control':'no-store'}});
  const request=new Request('https://tetizz-connections.pages.dev/api/search/start?trace=a%2Bb',{method:'POST',headers:{'content-type':'application/json'},body:'{"start":"alpha","target":"omega","searchId":"same-job"}'});
  const actual=await site.fetch(request,{CONNECTIONS:{fetch:async forwarded=>{
    calls++;assert.equal(forwarded.url,'https://connections-cache.tetizz.workers.dev/search/start?trace=a%2Bb');
    assert.equal(forwarded.method,'POST');assert.equal(forwarded.redirect,'manual');
    assert.deepEqual([...forwarded.headers],[...request.headers]);
    assert.equal(await forwarded.text(),'{"start":"alpha","target":"omega","searchId":"same-job"}');return response;
  }}});
  assert.equal(actual,response);assert.equal(calls,1);
});

test('normal site assets bypass the search service',async()=>{
  const request=new Request('https://tetizz-connections.pages.dev/styles.css');
  const response=new Response('body{}');
  assert.equal(await site.fetch(request,{ASSETS:{fetch:async actual=>{assert.equal(actual,request);return response;}}}),response);
});

test('a service failure is an uncached retryable API response, never the HTML app',async()=>{
  const response=await site.fetch(new Request('https://tetizz-connections.pages.dev/api/search/job?id=one'),{CONNECTIONS:{fetch:async()=>{throw new Error('private runtime failure');}}});
  assert.equal(response.status,503);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.ok(Number(response.headers.get('retry-after'))>0);
  assert.match(response.headers.get('content-type'),/application\/json/);
  const data=await response.json();assert.equal(data.retryable,true);assert.equal(data.code,'SEARCH_SERVICE_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(data),/private runtime failure/);
});

test('only API paths invoke the Pages function',async()=>{
  const routes=JSON.parse(await readFile(new URL('../../site/_routes.json',import.meta.url),'utf8'));
  assert.deepEqual(routes.include,['/api','/api/*']);
  assert.deepEqual(routes.exclude,[]);
});

test('public Pages and preview browsers use their own API while static local testing keeps its working backend',async()=>{
  const config=await readFile(new URL('../../site/config.js',import.meta.url),'utf8');
  for(const [origin,expected] of [
    ['https://tetizz-connections.pages.dev','https://tetizz-connections.pages.dev/api'],
    ['https://preview.tetizz-connections.pages.dev','https://preview.tetizz-connections.pages.dev/api'],
    ['http://127.0.0.1:8925','https://tetizz-connections-api.pages.dev'],
    ['https://tetizz.github.io','https://tetizz-connections-api.pages.dev'],
  ]){
    const context=vm.createContext({window:{location:new URL(origin)},URL});
    vm.runInContext(config,context);assert.equal(context.window.CONNECTIONS_CACHE_API,expected);
  }
});
