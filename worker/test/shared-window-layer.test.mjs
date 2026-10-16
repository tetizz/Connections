import test from 'node:test';
import assert from 'node:assert/strict';
import {__test as api} from '../src/index.js';

test('deferred same-layer player resumes and replaces four-hop candidate with two-hop result', async () => {
  const proof = id => `https://www.chess.com/game/live/${id}`;
  const search = {
    ...api.initialSearchState('alpha','omega'),
    sinceMonth:'2024/01', profileChecked:true, fastLaneChecked:true,
    activeSide:'forward', activeFrontier:['first','second'], activeCursor:0,
    forwardFrontier:[], backwardFrontier:['gamma'],
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
