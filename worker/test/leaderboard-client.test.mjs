import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../../site/leaderboard.js", import.meta.url), "utf8");
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture(transport) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      innerHTML: "", textContent: "", attributes: {}, listeners: {},
      contains: () => false,
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(name, listener) { this.listeners[name] = listener; },
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    window: { CONNECTIONS_CACHE_API: "https://leaderboard.test" },
    document: { getElementById: element, querySelectorAll: () => [] },
    fetch: transport, URL, Date, AbortController, setTimeout, clearTimeout,
    console: { debug() {} },
  });
  vm.runInContext(source, context, { filename: "actual-leaderboard.js" });
  return { leaderboard: context.window.Leaderboard, element };
}

test("the last selected leaderboard category owns rows, heading and busy state", async () => {
  const requests = [];
  const f = fixture(url => {
    if (String(url).includes("/profile?")) return Promise.resolve(response({ profile: { username: "profile" } }));
    const pending = deferred(); requests.push(pending); return pending.promise;
  });
  const older = f.leaderboard.load("fastest");
  const latest = f.leaderboard.load("recent");
  requests[1].resolve(response({ category: "recent", entries: [{ username: "new-player", target: "omega", length: 1, ts: Date.now() }] }));
  await latest; await settle();
  requests[0].resolve(response({ category: "fastest", entries: [{ username: "old-player", target: "omega", durationMs: 1, steps: 2, ts: Date.now() }] }));
  await older; await settle();
  assert.equal(f.element("lb-heading").textContent, "Recent discoveries");
  assert.match(f.element("leaderboard-list").innerHTML, /new-player/);
  assert.doesNotMatch(f.element("leaderboard-list").innerHTML, /old-player/);
  assert.equal(f.element("leaderboard-list").attributes["aria-busy"], "false");
});

test("leaderboard rows appear before optional profile requests finish", async () => {
  const profile = deferred();
  const f = fixture(url => String(url).includes("/profile?") ? profile.promise :
    Promise.resolve(response({ category: "connectors", entries: [{ username: "alpha", count: 2, ts: Date.now() }] })));
  const loaded = f.leaderboard.load();
  try {
    await settle();
    assert.match(f.element("leaderboard-list").innerHTML, /class="lb-row/);
    assert.equal(f.element("leaderboard-list").attributes["aria-busy"], "false");
  } finally {
    profile.resolve(response({ profile: { username: "alpha", name: "Alpha Profile" } }));
    await loaded; await settle();
  }
  assert.match(f.element("leaderboard-list").innerHTML, /Alpha Profile/);
});

test("a late profile response cannot replace a newly selected category", async () => {
  const profile = deferred();
  const f = fixture(url => {
    const parsed = new URL(url);
    if (parsed.pathname === "/profile") return profile.promise;
    const recent = parsed.searchParams.get("category") === "recent";
    return Promise.resolve(response({ category: recent ? "recent" : "connectors", entries: recent ? [] : [{ username: "old-player", count: 2, ts: Date.now() }] }));
  });
  const older = f.leaderboard.load("connectors"); await settle();
  await f.leaderboard.load("recent");
  profile.resolve(response({ profile: { username: "old-player", name: "Old Profile" } }));
  await older; await settle();
  assert.match(f.element("leaderboard-list").innerHTML, /No recent discoveries yet/);
  assert.doesNotMatch(f.element("leaderboard-list").innerHTML, /Old Profile/);
});

test("a failed leaderboard request offers a retry without claiming deployment is missing", async () => {
  let calls = 0;
  const f = fixture(async () => ++calls === 1 ? response({ error: "unavailable" }, 503) : response({ category: "recent", entries: [] }));
  await f.leaderboard.load("recent");
  assert.match(f.element("leaderboard-list").innerHTML, /data-leaderboard-retry/);
  assert.doesNotMatch(f.element("leaderboard-list").innerHTML, /worker is deployed|activates once/i);
  f.element("leaderboard-list").listeners.click({ target: { closest: () => ({}) } });
  await settle();
  assert.equal(calls, 2);
  assert.match(f.element("leaderboard-list").innerHTML, /No recent discoveries yet/);
});

test("submission results distinguish accepted, skipped, HTTP failure and offline outcomes", async t => {
  for (const [name, transport, expected] of [
    ["accepted", async () => response({ ok: true, entry: { start: "alpha" } }), { ok: true }],
    ["unverified", async () => response({ ok: true, skipped: true, reason: "route proofs are not verified" }, 202), { ok: true, skipped: true }],
    ["http failure", async () => response({ error: "try later" }, 429), { ok: false, status: 429 }],
    ["offline", async () => { throw new Error("offline"); }, { ok: false }],
  ]) {
    await t.test(name, async () => {
      const f = fixture(transport);
      const result = await f.leaderboard.submit("alpha", "omega", 1, ["alpha", "middle", "omega"]);
      for (const [key, value] of Object.entries(expected)) assert.equal(result?.[key], value, key);
    });
  }
});
