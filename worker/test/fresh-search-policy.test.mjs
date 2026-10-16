import assert from "node:assert/strict";
import test from "node:test";
import { SearchJobObject, __test } from "../src/index.js";

const oldJob = { id: "test-search", start: "alpha", target: "omega", status: "found", createdAt: Date.now(),
  chain: { found: true, path: ["alpha", "omega"], hops: [] } };

test("fresh search policy uses reversible independent storage and Durable Object namespaces", () => {
  assert.equal(__test.SEARCH_POLICY_VERSION, "fresh-search-v1");
  assert.equal(__test.searchJobKey("id"), "search:job:fresh-search-v1:id");
  assert.equal(__test.searchPublicJobKey("id"), "search:public:fresh-search-v1:id");
  assert.equal(__test.searchDurableName("id"), "fresh-search-v1:id");
  assert.equal(__test.searchJobShape(oldJob).policyVersion, "fresh-search-v1");
  assert.equal(__test.publicSearchJobShape(oldJob), null);
});

test("a historical Durable Object alarm cannot upgrade an old stored answer", async () => {
  let writes = 0;
  const object = new SearchJobObject({ storage: { get: async () => oldJob, put: async () => { writes++; } } }, {});
  assert.equal(await object.readJob(), null);
  assert.equal(writes, 0);
});
