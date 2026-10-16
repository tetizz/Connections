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
    console,
  });
  vm.runInContext([
    ...["LS_KEY", "LS_RANGE_KEY", "LS_ACTIVE_JOB_KEY", "AUTO_SEARCH_DEPTH", "USERNAME_MAX_LENGTH", "BLOCKED_USERNAMES"].map(constant),
    section("  const cleanUsernameInput =", "  const wait ="),
    section("  function precomputedChain(", "  async function quickBridge("),
    section("  function renderChain(", "  function qualityFromChain("),
    section("  function resetSearchQueue(", "  function compactJobId("),
    section("  function clearActiveJob(", "  async function resumeActiveSearchJob("),
    section("  async function runSearch(", "  function metaShape("),
    section("  function showStatus(", "  function applyTheme("),
  ].join("\n"), context, { filename: "actual-app-saved-route-search-sections.js" });
  return {
    context, state, priorOwner, storage, element, document,
    events, submissions, renders, cards, shares, serverCalls, timerClears, focusCalls, scrolls,
    run: (start, target, range = "auto") => context.runSearch(start, target, range),
  };
}

test("actual direct saved edge completes without a new server search and clears prior resume state", async () => {
  const f = fixture();
  const originalFocus = f.document.activeElement;
  const wasPriorOwner = () => f.state.activeSearchOwner === f.priorOwner;
  assert.equal(wasPriorOwner(), true);
  await f.run("FREDALSUP", "PianoSkater", "12");

  const chain = plain(f.state.currentChain);
  assert.deepEqual(chain.path, ["fredalsup", "pianoskater"]);
  assert.equal(chain.length, 1);
  assert.equal(chain.target, "pianoskater");
  assert.deepEqual(chain.hops, [{ from: "fredalsup", to: "pianoskater", url: "https://www.chess.com/game/live/63496054537" }]);
  assert.equal(f.serverCalls.length, 0, "Direct minimum must not enter search/start or polling flow");
  assert.equal(f.storage.has("chess-connections:active-search-job:v1"), false);
  assert.equal(f.storage.get("chess-connections:username"), "fredalsup");
  assert.equal(f.storage.get("chess-connections:range"), "12");
  assert.equal(f.element("#setting-username").value, "fredalsup");
  assert.equal(wasPriorOwner(), false);
  assert.equal(f.state.activeSearchId, "client-test-1");
  assert.equal(f.state.activeSearchOwner, "search:client-test-1");
  assert.equal(f.element("#trace-chain").disabled, false);
  assert.equal(f.state.queueTimer, null);
  assert.ok(f.timerClears.includes(17));
  assert.equal(f.element("#search-queue").hidden, true);
  assert.equal(f.element("#search-log").hidden, true);
  assert.equal(f.element("#search-log").innerHTML, "");
  assert.match(f.element("#search-status").textContent, /verified direct win against pianoskater/i);
  assert.match(f.element("#search-status").textContent, /shortest possible connection/i);
  assert.doesNotMatch(f.element("#search-status").className, /is-working|is-error/);
  assert.equal(f.document.activeElement, originalFocus);
  assert.deepEqual(f.focusCalls, []);
  assert.equal(f.renders.length, 1);
  assert.deepEqual(plain(f.renders[0].chain), chain);
  assert.deepEqual(plain(f.cards[0]), chain);
  assert.deepEqual(plain(f.shares[0]), chain, "Unchanged render path receives complete proof payload for sharing");
  assert.equal(f.submissions.length, 1);
  assert.deepEqual(plain(f.submissions[0]), { start: "fredalsup", target: "pianoskater", chain });
  assert.deepEqual(f.events.map(row => row.outcome), ["started", "saved"]);
  assert.equal(f.events[1].detail.steps, 1);
  assert.equal(f.events[1].detail.searchId, "client-test-1");
  assert.deepEqual(plain(f.events[1].detail.path), chain.path);
  assert.equal(f.scrolls.length, 1);
  assert.equal(f.context.activeChip, "pianoskater");
});

test("actual saved route longer than one keeps the existing background search boundary", async () => {
  const f = fixture();
  await f.run("trixize1234", "pianoskater", "all");
  const chain = plain(f.state.currentChain);
  assert.deepEqual(chain.path, ["trixize1234", "fredalsup", "pianoskater"]);
  assert.equal(chain.length, 2);
  assert.equal(f.serverCalls.length, 1);
  const call = f.serverCalls[0];
  assert.equal(call.start, "trixize1234");
  assert.equal(call.target, "pianoskater");
  assert.equal(call.range, "all");
  assert.equal(call.mode.key, "all");
  assert.equal(call.mode.instantOnly, false);
  assert.deepEqual(plain(call.knownChain), chain);
  assert.equal(call.analyticsBase.searchId, f.state.activeSearchId);
  assert.equal(f.state.activeSearchOwner, `search:${call.analyticsBase.searchId}`);
  assert.match(f.element("#search-status").textContent, /checking for a shorter route/i);
  assert.doesNotMatch(f.element("#search-status").textContent, /shortest possible/i);
  assert.equal(f.submissions.length, 1);
  assert.deepEqual(f.events.map(row => row.outcome), ["started", "saved"]);
  assert.equal(f.shares.length, 1);
  // The existing server flow owns save/poll/clear, not this adapted boundary.
  assert.equal(f.storage.has("chess-connections:active-search-job:v1"), true);
});

test("invalid and same-player inputs retain validation before saved-route shortcuts", async t => {
  for (const [label, start, target, focus] of [
    ["empty start", "", "pianoskater", "#search-start"],
    ["invalid target", "fredalsup", "not a username!", "#search-target"],
    ["same player", "fredalsup", "FREDALSUP", null],
  ]) await t.test(label, async () => {
    const f = fixture();
    await f.run(start, target);
    assert.equal(f.renders.length, 0);
    assert.equal(f.serverCalls.length, 0);
    assert.equal(f.submissions.length, 0);
    assert.equal(f.events.length, 0);
    assert.equal(f.state.activeSearchOwner, f.priorOwner);
    assert.equal(f.storage.has("chess-connections:active-search-job:v1"), true);
    assert.match(f.element("#search-status").className, /is-error/);
    assert.deepEqual(f.focusCalls, focus ? [focus] : []);
  });
});

test("blocked player validation remains ahead of any saved proof fast path", async () => {
  const f = fixture();
  const blocked = vm.runInContext("Array.from(BLOCKED_USERNAMES)[0]", f.context);
  await f.run(blocked, "pianoskater");
  assert.equal(f.renders.length, 0);
  assert.equal(f.serverCalls.length, 0);
  assert.equal(f.events.length, 0);
  assert.match(f.element("#search-status").textContent, /not available/);
  assert.equal(f.state.activeSearchOwner, f.priorOwner);
});

test("malformed saved direct proof falls through to ordinary server flow", async () => {
  const f = fixture({ chains: { chains: [{
    target: "pianoskater", found: true, path: ["fredalsup", "pianoskater"],
    hops: [{ from: "fredalsup", to: "pianoskater", url: "https://www.chess.com/game/live/63496054537?redirect=1" }],
  }] } });
  await f.run("fredalsup", "pianoskater");
  assert.equal(f.renders.length, 0);
  assert.equal(f.submissions.length, 0);
  assert.equal(f.serverCalls.length, 1);
  assert.equal(f.serverCalls[0].knownChain, undefined);
  assert.deepEqual(f.events.map(row => row.outcome), ["started"]);
  assert.equal(f.storage.has("chess-connections:active-search-job:v1"), true);
});
