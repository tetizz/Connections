import test from 'node:test';
import assert from 'node:assert/strict';
import {__test as api} from '../src/index.js';

test('deferred same-layer player resumes and replaces four-hop candidate with two-hop result', async () => {
  const proof = id => `https://www.chess.com/game/live/${id}`;
  const search = {
    ...api.initialSearchState('alpha','omega'),
    sinceMonth:'2024/01', profileChecked:true, fastLaneChecked:true,
    activeSide:'forward', activeFrontier:['first','second'], activeCursor:0,
    // Conservative partial reverse-tree fixture: omega remains the unexpanded
    // depth-zero frontier, so four hops cannot satisfy the early-finish bound.
    forwardFrontier:[], backwardFrontier:['omega'],
    forwardVisited:{
      alpha:{prev:'',hopUrl:''},
      first:{prev:'alpha',hopUrl:proof(1)},
      second:{prev:'alpha',hopUrl:proof(2)},
    },
    backwardVisited:{
      omega:{next:'',hopUrl:''},
      delta:{next:'omega',hopUrl:proof(5)},
      gamma:{next:'delta',hopUrl:proof(4)},
    },
  };
  const job = {id:'deferred-layer',start:'alpha',target:'omega',range:'instant',
    policyVersion:api.SEARCH_POLICY_VERSION,search};
  const stats = {requests:0,fetched:0,cached:0,expanded:0};
  const reads = []; let deferSecond = true;
  const edgeReader = {
    async prime() {},
    async read(name) {
      reads.push(name);
      if (name === 'first') return {edges:{beatenByMe:new Map([['gamma',[proof(3)]]]),beatMe:new Map()}};
      assert.equal(name,'second');
      if (deferSecond) return {deferred:true,reason:'chunk-request-limit'};
      return {edges:{beatenByMe:new Map([['omega',[proof(6)]]]),beatMe:new Map()}};
    },
  };
  const options = {edgeReader,expansionBudget:10,timeBudgetMs:5000};
  const first = await api.advanceServerSearch({},job,search,stats,async()=>{},options);
  assert.equal(first.status,'running');
  assert.deepEqual(first.chain.path,['alpha','first','gamma','delta','omega']);
  assert.equal(search.bestMeeting,'gamma');
  assert.equal(search.bestMeetingLength,4);
  assert.equal(search.activeSide,'forward');
  assert.deepEqual(search.activeFrontier,['second']);
  assert.equal(search.activeCursor,0);
  assert.equal(first.shortestVerified,false);

  // Model the actual persisted chunk boundary, not a shared mutable return.
  const resumed = JSON.parse(JSON.stringify(search));
  job.search = resumed; deferSecond = false;
  const second = await api.advanceServerSearch({},job,resumed,stats,async()=>{},options);
  assert.equal(second.status,'found');
  assert.deepEqual(second.chain.path,['alpha','second','omega']);
  assert.deepEqual(second.chain.hops,[
    {from:'alpha',to:'second',url:proof(2)},
    {from:'second',to:'omega',url:proof(6)},
  ]);
  assert.equal(resumed.bestMeeting,'omega');
  assert.equal(resumed.bestMeetingLength,2);
  assert.deepEqual(reads,['first','second','second']);
  assert.equal(stats.expanded,2);
  assert.equal(second.shortestVerified,false);
});

function boundFixture() {
  const proof=id=>`https://www.chess.com/game/live/${id}`;
  const search={...api.initialSearchState('alpha','omega'),sinceMonth:'2024/01',
    activeSide:'forward',activeFrontier:['first','sibling'],activeCursor:0,
    forwardFrontier:[],backwardFrontier:['beta'],
    forwardVisited:{alpha:{prev:'',hopUrl:''},first:{prev:'alpha',hopUrl:proof(1)},sibling:{prev:'alpha',hopUrl:proof(2)}},
    backwardVisited:{omega:{next:'',hopUrl:''},beta:{next:'omega',hopUrl:proof(4)}},
  };
  const job={id:'bound-layer',start:'alpha',target:'omega',range:'instant',policyVersion:api.SEARCH_POLICY_VERSION,search};
  const stats={requests:0,fetched:0,cached:0,expanded:0};const reads=[];
  const edgeReader={async prime(){},async read(name){reads.push(name);return name==='first'
    ?{edges:{beatenByMe:new Map([['beta',[proof(3)]]]),beatMe:new Map()}}
    :{deferred:true,reason:'chunk-request-limit'};}};
  return {search,job,stats,reads,options:{edgeReader,expansionBudget:10,timeBudgetMs:5000}};
}
test('uniform depth-one frontiers accept three-hop minimum despite deferred sibling',async()=>{
  const f=boundFixture();
  const result=await api.advanceServerSearch({},f.job,f.search,f.stats,async()=>{},f.options);
  assert.equal(result.status,'found');
  assert.deepEqual(result.chain.path,['alpha','first','beta','omega']);
  assert.equal(f.search.bestMeetingLength,3);
  assert.deepEqual(f.reads,['first','sibling']);
  assert.equal(f.stats.expanded,1);
  assert.equal(result.shortestVerified,false);
});

for(const [name,mutate] of [
  ['missing frontier node',f=>{f.search.backwardFrontier=['missing'];}],
  ['broken parent',f=>{f.search.backwardVisited.beta.next='missing';}],
  ['cyclic parent',f=>{f.search.backwardVisited.loop={next:'loop',hopUrl:''};f.search.backwardFrontier=['loop'];}],
  ['nonuniform depths',f=>{f.search.backwardFrontier=['omega','beta'];}],
  ['missing root',f=>{delete f.search.backwardVisited.omega;}],
  ['cyclic root',f=>{f.search.backwardVisited.omega.next='omega';}],
  ['incomplete prior coverage',f=>{f.search.incomplete=true;}],
]) test(`early finish rejects ${name}`,async()=>{
  const f=boundFixture();mutate(f);
  const result=await api.advanceServerSearch({},f.job,f.search,f.stats,async()=>{},f.options);
  assert.equal(result.status,'running');
  // Malformed ancestry is deliberately not a proof-valid route fixture; this
  // assertion isolates refusal of the early-finish bound, not reconstruction.
  assert.deepEqual(f.search.activeFrontier,['sibling']);
});
