import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../../site/app.js',import.meta.url),'utf8');
const section=(from,to)=>source.slice(source.indexOf(from),source.indexOf(to,source.indexOf(from)));
const route=(target,verified=false)=>({player:{username:target,slotCount:2},status:verified?'found':'running',ms:40,job:{id:'job-'+target,start:'alpha',target,shortestVerified:verified,chain:{found:true,path:['alpha',target],hops:[{from:'alpha',to:target,url:'https://www.chess.com/game/live/1'}]}}});
test('top-player tree consistently counts unique players before and after rankings finish loading',async()=>{
 const renders=[],state={quickTargetGroups:[{players:Array(10).fill({})},{players:Array(10).fill({})},{players:Array(10).fill({})}]};
 const results=Array.from({length:23},(_,i)=>i<12?route('target'+i,i<8):({player:{username:'target'+i,slotCount:1},status:'queued'}));
 const c=vm.createContext({state,Number,Math,serverChainIdentity:chain=>JSON.stringify([chain.path,chain.hops]),sortedTopTraceResults:items=>items,pathHasBlockedUser:()=>false,cleanUsernameInput:s=>s,topTraceStepCount:c=>c.path.length-1,hydrateTopTracePlayers:async()=>{},$:()=>({value:''}),setActiveChip:()=>{},renderChain:chain=>renders.push(chain),submitTopTraceLeaderboardBranches:()=>{},showStatus:()=>{},esc:String,plainNumber:String});
 vm.runInContext(section('  function topTraceLeaderboardSlotCount(', '  function topTraceProgress(')+section('  async function renderTopTraceCurrentTree(', '  // ---------- username autocomplete'),c);
 await c.renderTopTraceCurrentTree('alpha',results,{progressive:true});state.quickTargetGroups=[];await c.renderTopTraceCurrentTree('alpha',results,{progressive:true});
 assert.deepEqual(renders.map(r=>[r.foundSlotCount,r.targetCount]),[[12,23],[12,23]]);
});
function element(){return {children:[],style:{setProperty(){}},dataset:{},appendChild(child){this.children.push(child);},classList:{add(){}},innerHTML:'',textContent:''};}
test('top-player proof cards show proof status instead of presenting request latency as search speed',()=>{
 const wrap=element();const c=vm.createContext({document:{createElement:element},topTraceStepCount:c=>c.path.length-1,avatarEl:element,esc:String,nameOf:String,plainNumber:String,treeBranchPath:()=>'',setTimeout:()=>{}});
 vm.runInContext(section('  function renderTreeCards(', '  function treeBranchPath('),c);
 const provisional=route('omega');const proved=route('beta',true);c.renderTreeCards({root:'alpha',chains:[{...provisional.job.chain,target:'omega',ms:40,shortestVerified:false},{...proved.job.chain,target:'beta',ms:0,shortestVerified:true}]},wrap);
 const meta=wrap.children.map(card=>card.children[1].children.find(child=>child.className==='tree-proof__meta').innerHTML).join(' ');
 assert.doesNotMatch(meta,/\b\d+ms\b/);assert.match(meta,/Shortest route not yet verified/i);assert.match(meta,/Shortest route verified/i);
});
test('a pending proof ledger never says the connection search has failed',()=>{
 const wrap=element();const c=vm.createContext({$:()=>wrap,esc:String});vm.runInContext(section('  function renderCards(', '  function renderTreeCards('),c);
 c.renderCards({found:false,pending:true,target:'magnuscarlsen',display:'Magnus Carlsen'});
 assert.doesNotMatch(wrap.innerHTML,/no connection found|couldn.t find/i);assert.match(wrap.innerHTML,/search|checking|waiting/i);
});
test('only a completed negative search uses negative ledger wording',()=>{
 const wrap=element();const c=vm.createContext({$:()=>wrap,esc:String});vm.runInContext(section('  function renderCards(', '  function renderTreeCards('),c);
 c.renderCards({found:false,target:'magnuscarlsen'});assert.doesNotMatch(wrap.innerHTML,/no connection found|no verified connection was found/i);
 c.renderCards({found:false,searchComplete:true,target:'magnuscarlsen'});assert.match(wrap.innerHTML,/completed search/i);
});

test('graph summary distinguishes pending, incomplete and complete negative searches',()=>{
 const summary={textContent:''},svg={setAttribute(){}};const c=vm.createContext({$:id=>id==='#graph-summary'?summary:svg});vm.runInContext(section('  function updateGraphSummary(', '  function renderGraph('),c);
 c.updateGraphSummary({found:false,pending:true,target:'omega'});assert.match(summary.textContent,/Searching/);
 c.updateGraphSummary({found:false,target:'omega'});assert.match(summary.textContent,/has not completed/);assert.doesNotMatch(summary.textContent,/No verified connection/);
 c.updateGraphSummary({found:false,searchComplete:true,target:'omega'});assert.match(summary.textContent,/completed search/);
});

test('background tree updates preserve an explicitly opened proof branch and its shareable view',async()=>{
 const renders=[],statuses=[],targetInput={value:'omega'},state={topTraceOpenedBranch:'omega',currentChain:{...route('omega').job.chain,target:'omega',shortestVerified:false},quickTargetGroups:[]};
 const c=vm.createContext({state,Number,Math,serverChainIdentity:chain=>JSON.stringify([chain.path,chain.hops]),sortedTopTraceResults:items=>items,pathHasBlockedUser:()=>false,cleanUsernameInput:s=>s,topTraceStepCount:c=>c.path.length-1,hydrateTopTracePlayers:async()=>{},$:()=>targetInput,setActiveChip:()=>{},renderChain:chain=>renders.push(chain),submitTopTraceLeaderboardBranches:()=>{},showStatus:(kind,text)=>statuses.push(text),esc:String,plainNumber:String});
 vm.runInContext(section('  function topTraceLeaderboardSlotCount(', '  function topTraceProgress(')+section('  async function renderTopTraceCurrentTree(', '  // ---------- username autocomplete'),c);
 await c.renderTopTraceCurrentTree('alpha',[route('omega'),route('beta',true)],{progressive:true});assert.equal(renders.length,0);assert.equal(targetInput.value,'omega');assert.match(statuses.at(-1),/2 of 2/);
});

test('the selected branch accepts a shorter proof without being replaced by the batch tree',async()=>{
 const current={found:true,target:'omega',path:['alpha','middle','omega'],hops:[{from:'alpha',to:'middle',url:'https://www.chess.com/game/live/1'},{from:'middle',to:'omega',url:'https://www.chess.com/game/live/2'}],shortestVerified:false};
 const renders=[],input={value:'omega'},state={topTraceOpenedBranch:'omega',currentChain:current};
 const c=vm.createContext({state,Number,Math,serverChainIdentity:chain=>JSON.stringify([chain.path,chain.hops]),sortedTopTraceResults:items=>items,pathHasBlockedUser:()=>false,cleanUsernameInput:s=>s,topTraceStepCount:c=>c.path.length-1,hydrateTopTracePlayers:async()=>{},$:()=>input,setActiveChip:()=>{},renderChain:chain=>{state.currentChain=chain;renders.push(chain);},submitTopTraceLeaderboardBranches:()=>{},showStatus:()=>{},esc:String,plainNumber:String});
 vm.runInContext(section('  async function renderTopTraceCurrentTree(', '  // ---------- username autocomplete'),c);await c.renderTopTraceCurrentTree('alpha',[route('omega',true),route('beta',true)],{progressive:true});
 assert.equal(renders.length,1);assert.equal(renders[0].tree,undefined);assert.equal(renders[0].target,'omega');assert.equal(renders[0].path.length,2);assert.equal(input.value,'omega');assert.equal(renders[0].shortestVerified,true);
});

test('All top players is available only in a branch and returns the latest tree without another search',()=>{
 const markup=readFileSync(new URL('../../site/index.html',import.meta.url),'utf8');assert.match(markup,/<button[^>]*id="top-tree-back"[^>]*hidden>All top players<\/button>/);
 const fields=new Map(),field=id=>{if(!fields.has(id))fields.set(id,{hidden:false,textContent:'',value:'',focus(){this.focused=true;}});return fields.get(id);};
 const firstTree={tree:true,found:true,target:'omega',branchCount:1,targetCount:2,foundSlotCount:1};const state={topTraceOpenedBranch:'omega',latestTopTraceTree:firstTree};
 const c=vm.createContext({state,$:field,pathHasBlockedUser:()=>false,showStatus:()=>{},renderGraph:()=>{},renderCards:()=>{},updateShareButton:()=>{},setActiveChip:()=>{},fetch:()=>{throw new Error('Returning to the tree must not start another search');}});
 vm.runInContext(section('  function renderChain(', '  function qualityFromChain('),c);c.renderChain({...route('omega').job.chain,target:'omega',length:1});assert.equal(field('#top-tree-back').hidden,false);
 const latest={...firstTree,branchCount:2,foundSlotCount:2};state.latestTopTraceTree=latest;c.showAllTopPlayers();assert.equal(state.currentChain,latest);assert.equal(state.topTraceOpenedBranch,null);assert.equal(field('#top-tree-back').hidden,true);assert.equal(field('#replay').focused,true);
});
test('the selected branch updates shortest status once without switching targets or remounting unchanged snapshots',async()=>{
 const base={...route('omega').job.chain,target:'omega',shortestVerified:false};const renders=[],state={topTraceOpenedBranch:'omega',currentChain:base};const input={value:'omega'};
 const c=vm.createContext({state,Number,Math,serverChainIdentity:chain=>JSON.stringify([chain.path,chain.hops]),sortedTopTraceResults:items=>items,pathHasBlockedUser:()=>false,cleanUsernameInput:s=>s,topTraceStepCount:c=>c.path.length-1,hydrateTopTracePlayers:async()=>{},$:()=>input,setActiveChip:()=>{},renderChain:chain=>{state.currentChain=chain;renders.push(chain);},submitTopTraceLeaderboardBranches:()=>{},showStatus:()=>{},esc:String,plainNumber:String});
 vm.runInContext(section('  async function renderTopTraceCurrentTree(', '  // ---------- username autocomplete'),c);const results=[route('omega',true),route('beta',true)];await c.renderTopTraceCurrentTree('alpha',results,{progressive:true});await c.renderTopTraceCurrentTree('alpha',results,{progressive:true});
 assert.equal(renders.length,1);assert.equal(renders[0].target,'omega');assert.equal(renders[0].shortestVerified,true);assert.equal(input.value,'omega');
});
