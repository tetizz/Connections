import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import savedRoutes from "../../site/saved-routes.js";

// Exercise the real controller and helpers. Only DOM/render, analytics,
// leaderboard and the server-flow boundary are adapted; no HTTP is performed.
// This is not a browser layout, share serialization or elapsed-time fixture.
const appSource = readFileSync(new URL("../../site/app.js", import.meta.url), "utf8");
const publicData = JSON.parse(readFileSync(new URL("../../data/chains.json", import.meta.url), "utf8"));
const plain = value => JSON.parse(JSON.stringify(value));

function section(start, end) {
  const first = appSource.indexOf(start);
  const last = appSource.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `Actual app section missing: ${start}`);
  return appSource.slice(first, last);
}

function constant(name) {
  const line = appSource.split(/\r?\n/).find(value => value.startsWith(`  const ${name} = `));
  assert.ok(line, `Actual app constant missing: ${name}`);
  return line;
}

function fixture({ chains = publicData } = {}) {
  const events = [], submissions = [], renders = [], cards = [], shares = [], serverCalls = [];
  const timerClears = [], focusCalls = [], scrolls = [];
  const storage = new Map();
  const elements = new Map();
  const document = { activeElement: null };
  function element(selector) {
    if (!elements.has(selector)) elements.set(selector, {
      hidden: false, disabled: false, value: "", textContent: "", innerHTML: "", className: "",
      focus() { document.activeElement = this; focusCalls.push(selector); },
      scrollIntoView(options) { scrolls.push({ selector, options }); },
    });
    return elements.get(selector);
  }
  document.querySelector = element;
  document.activeElement = element("#trace-chain");
  element("#trace-chain").disabled = true;
  element("#search-log").innerHTML = "old progress";
  const priorOwner = "search:prior-job";
  const state = {
    chains: plain(chains), players: {}, activeSearchId: "prior-job", activeSearchOwner: priorOwner,
    queueTimer: 17, searchJobs: new Map([["prior-job", { id: "prior-job", status: "running" }]]),
  };
  storage.set("chess-connections:active-search-job:v1", JSON.stringify({
    id: "prior-job", searchId: "prior-job", start: "old-start", target: "old-target", range: "auto", ts: 1,
  }));
  let eventNumber = 0;
  const context = vm.createContext({
    state, document, window: { SavedRoutes: savedRoutes },
    $: element,
    localStorage: {
      getItem: key => storage.has(key) ? storage.get(key) : null,
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
    },
    performance: { now: () => 100 },
    clearInterval: timer => timerClears.push(timer),
    newSearchEventId: () => `client-test-${++eventNumber}`,
    recordSearchEvent: (outcome, detail) => events.push({ outcome, detail }),
    submitLeaderboardChain: (start, target, chain) => submissions.push({ start, target, chain }),
    setActiveChip: target => { context.activeChip = target; },
    nameOf: username => username,
    renderGraph: (chain, options) => renders.push({ chain, options }),
    renderCards: chain => cards.push(chain),
    updateShareButton: chain => shares.push(chain),
    runServerSearchFlow: async options => { serverCalls.push(options); return true; },
    fetch: () => { throw new Error("Unexpected HTTP in controller fixture"); },
    pollServerSearchJob: async id => { context.polled = id; return { id, policyVersion: "fresh-search-v2", status: "found", chain: { found: true } }; },
    renderSearchQueue: () => {}, finishSearchQueue: () => {},
    applyServerChain: async job => { context.applied = job; },
    Date,
    console,
  });
  vm.runInContext([
    ...["LS_KEY", "LS_RANGE_KEY", "LS_ACTIVE_JOB_KEY", "SEARCH_POLICY_VERSION", "AUTO_SEARCH_DEPTH", "USERNAME_MAX_LENGTH", "BLOCKED_USERNAMES"].map(constant),
    section("  const esc =", "  const plainNumber ="),
    section("  const cleanUsernameInput =", "  const wait ="),
    section("  function precomputedChain(", "  async function quickBridge("),
    section("  function renderChain(", "  function qualityFromChain("),
    section("  function resetSearchQueue(", "  function compactJobId("),
    section("  function saveActiveJob(", "  function warmSharedCaches("),
    section("  async function runSearch(", "  function metaShape("),
    section("  function showStatus(", "  function applyTheme("),
  ].join("\n"), context, { filename: "actual-app-saved-route-search-sections.js" });
  return {
    context, state, priorOwner, storage, element, document,
    events, submissions, renders, cards, shares, serverCalls, timerClears, focusCalls, scrolls,
    run: (start, target, range = "auto") => context.runSearch(start, target, range),
  };
}

const activeKey = "chess-connections:active-search-job:v3:full-history-search";

test("all ordinary pairs discard saved answers and enter one fresh server search", async t => {
  for (const [start, target] of [["fredalsup", "pianoskater"], ["trixize1234", "pianoskater"], ["public-a", "public-b"]]) {
    await t.test(`${start} to ${target}`, async () => {
      const f = fixture();
      await f.run(start, target);
      assert.equal(f.serverCalls.length, 1);
      const call = f.serverCalls[0];
      assert.equal(call.start, start);
      assert.equal(call.target, target);
      assert.equal(call.knownChain, undefined);
      assert.equal(f.state.currentChain.found, false);
      assert.deepEqual(plain(f.state.currentChain.path), []);
      assert.deepEqual(plain(f.cards.at(-1).hops), []);
      assert.equal(f.shares.at(-1).found, false, "Normal renderer clears stale share payload");
      assert.deepEqual(plain(f.state.chains), { chains: [] });
      assert.deepEqual(f.events.map(row => row.outcome), ["started"]);
      assert.equal(f.submissions.length, 0);
      assert.match(f.element("#search-status").innerHTML, /fresh search/);
      assert.equal(f.state.activeSearchOwner, "search:client-test-1");
      assert.deepEqual(f.focusCalls, []);
    });
  }
});

test("invalid, same and blocked inputs preserve validation without server work", async t => {
  for (const [label, start, target] of [["empty", "", "pianoskater"], ["invalid", "fredalsup", "not a username!"], ["same", "fredalsup", "FREDALSUP"]]) {
    await t.test(label, async () => { const f=fixture(); await f.run(start,target); assert.equal(f.serverCalls.length,0); assert.equal(f.renders.length,0); assert.equal(f.state.activeSearchOwner,f.priorOwner); });
  }
  const f=fixture();const blocked=vm.runInContext("Array.from(BLOCKED_USERNAMES)[0]",f.context);await f.run(blocked,"pianoskater");assert.equal(f.serverCalls.length,0);
});

test("old policy records are invalidated without polling or rendering", async () => {
  const f=fixture();f.storage.set(activeKey,JSON.stringify({id:"legacy",ts:Date.now()}));
  await f.context.resumeActiveSearchJob();
  assert.equal(f.context.polled,undefined);assert.equal(f.storage.has(activeKey),false);assert.equal(f.renders.length,0);
  assert.match(appSource,/localStorage\.removeItem\("chess-connections:active-search-job:v1"\)/);
  assert.match(appSource,/localStorage\.removeItem\("chess-connections:active-search-job:v2:fresh-search"\)/);
});

test("fresh policy jobs retain resume reliability and policy-bound persistence", async () => {
  const f=fixture();f.context.saveActiveJob({id:"fresh",searchId:"fresh",start:"fredalsup",target:"pianoskater",range:"auto"});
  assert.equal(JSON.parse(f.storage.get(activeKey)).policyVersion,"fresh-search-v2");
  await f.context.resumeActiveSearchJob();assert.equal(f.context.polled,"fresh");assert.equal(f.context.applied.id,"fresh");assert.equal(f.storage.has(activeKey),false);
});

test("metadata startup does not fetch or automatically render showcase answers", () => {
  const startup=section("  async function loadPlayerMetadata(","  function renderShowcaseTabs(");
  assert.match(startup,/players\.json/);assert.doesNotMatch(startup,/chains\.json|selectTarget|renderChain/);
  assert.doesNotMatch(appSource,/loadShowcase\(/);
  assert.match(appSource,/loadSharedChainFromUrl\(\)/,"Explicit shared links remain supported");
});
test("discovered route wording does not imply an unverified global minimum", () => {
  const context=vm.createContext({});
  vm.runInContext(section("  function searchOptimalityNote(", "  async function applyServerChain("),context);
  assert.equal(context.searchOptimalityNote({shortestVerified:false}),"Shortest route has not been verified.");
  assert.equal(context.searchOptimalityNote({}),"Shortest route has not been verified.");
  assert.equal(context.searchOptimalityNote({shortestVerified:true}),"Shortest route verified for this search.");
  const publication=section("  async function applyServerChain(","  function refreshVisibleChainMetadata(");
  assert.match(publication,/searchOptimalityNote\(job\)/);
  assert.doesNotMatch(publication,/loaded saved connection|shortest possible/i);
});