import assert from "node:assert/strict";
import test from "node:test";
import { bindVerifiedJobSubmission } from "../src/verified-job-submit.js";

function fixture() {
  const hop = { from: "alpha", to: "omega", url: "https://www.chess.com/game/live/12345", white: { username: "alpha", rating: 2000 } };
  const job = { id: "actual-job", policyVersion: "fresh-search-v2", status: "found", outcome: "found",
    start: "alpha", target: "omega", range: "auto", createdAt: 1000, updatedAt: 2000,
    search: { sinceMonth: "2026/01", incomplete: false }, chain: { found: true, path: ["alpha", "omega"], hops: [hop] } };
  const submission = { searchId: job.id, start: job.start, target: job.target, range: job.range,
    path: [...job.chain.path], hops: [{ from: hop.from, to: hop.to, url: hop.url, white: { username: "forged" } }], sinceMonth: "0000/01" };
  const options = { submission, readSearchJob: async () => job, policyVersion: "fresh-search-v2",
    validSinceMonth: value => typeof value === "string" && /^\d{4}\/(?:0[1-9]|1[0-2])$/.test(value),
    maxAgeMs: 7200000, now: () => 3000 };
  return { job, submission, options, run: extra => bindVerifiedJobSubmission({ ...options, ...extra }) };
}
test("exact terminal job binds server window and detached server metadata only", async () => {
  const f = fixture(), result = await f.run();
  assert.equal(result.sinceMonth, "2026/01"); assert.equal(result.searchId, "actual-job");
  assert.deepEqual(result.hops, f.job.chain.hops);
  result.hops[0].white.rating = 1; assert.equal(f.job.chain.hops[0].white.rating, 2000);
});
test("no/invalid search ID never authorizes client scope or reads a job", async () => {
  for (const searchId of [undefined, null, "", "bad/id", {}, "x".repeat(129)]) {
    const f = fixture(); f.submission.searchId = searchId;
    assert.equal(await f.run({ readSearchJob: async () => { throw Error("must not read"); } }), null);
  }
});
test("wrong job authority, lifecycle, scope or expiry rejects binding", async () => {
  const edits = [job => { job.id = "another"; }, job => { job.policyVersion = "old"; },
    job => { job.status = "running"; }, job => { job.status = "timeout"; }, job => { job.outcome = "timeout"; },
    job => { job.chain.found = false; }, job => { job.start = "other"; }, job => { job.target = "other"; },
    job => { job.range = "all"; }, job => { job.search.incomplete = true; },
    job => { job.search.sinceMonth = "2026/99"; }, job => { delete job.search.sinceMonth; },
    job => { job.createdAt = 3001; }, job => { job.updatedAt = 3001; }, job => { job.updatedAt = 999; }];
  for (const edit of edits) { const f = fixture(); edit(f.job); assert.equal(await f.run(), null); }
  const f = fixture(); assert.equal(await f.run({ now: () => 7201000 }), null);
  assert.equal(await f.run({ readSearchJob: async () => null }), null);
});
test("path, direction and exact proof URL bind; client decorative fields do not", async () => {
  const edits = [s => { s.path[0] = "other"; }, s => { s.path.reverse(); },
    s => { s.path.push("alpha"); }, s => { s.hops[0].to = "other"; },
    s => { s.hops[0].url = "https://www.chess.com/game/live/99999"; },
    s => { s.hops = []; }, s => { s.hops.push(s.hops[0]); }];
  for (const edit of edits) { const f = fixture(); edit(f.submission); assert.equal(await f.run(), null); }
});
