# Monthly archive cache reads

The loader reads the first selected month individually, then awaits native KV JSON reads of up to four months. Records are consumed in their original order and checked for URL, schema, freshness and valid games. Downloads remain sequential. Bulk errors or unexpected results fall back to individual reads for that invocation; duplicate URLs retain individual reads. Saved connection answers remain excluded from fresh searches. Batching changes neither all-history coverage nor the shortest-path stopping rule.

## Accepted native KV component result

Cloudflare EWR measurements used the same isolate, ordered keys and exact value hashes. Both arms read the first month individually. Seven counterbalanced pairs per player used existing fresh historical monthly records after preparation warmed the reads. The native Worker clock includes KV JSON decoding; parity runs afterward.

| Cached keys | Individual median | Batched median | Ratio | Strict paired wins |
| --- | ---: | ---: | ---: | ---: |
| 47 | 247 ms | 82 ms | 3.012x | 7/7 |
| 5 | 22 ms | 10 ms | 2.2x | 7/7 |

All 34 requests passed with identical ordered data. An earlier minimum-eight-month preparation stopped because the short history had five fresh records. The separate 47/5 cohort was frozen before timing, retained that failure, and passed both players' unchanged 20% lower median and six-of-seven wins gates. These are warmed storage component results, not whole-search, cold-download, arbitrary-pair, browser or tenfold gains.

## Freshness findings and rejected trials

Both complete full-history helper cohorts stopped before returning any elapsed results: current-month coverage expired or could not be reused. They remain stopped, with no timing acceptance or further conditioning.

A separate actual provider observation returned `Cache-Control: public, max-age=5`, no Age header, and parser TTL 5. All 115 sanitized chess games were valid. Cloudflare documents a [minimum KV expiration TTL of 60 seconds](https://developers.cloudflare.com/kv/api/write-key-value-pairs/). Storage retention and record freshness are separate constraints.

The prototype that awaited a 60-second KV write while retaining the real shorter record expiry was rejected for first-read regression. Fred's first-call median rose from 24 to 293 ms; Piano's rose from 21 to 262 ms. Repeat medians improved from 23 to 8 ms and 17 to 6 ms, but both frozen first-read controls failed. All 13 requests and row checks were retained. Faster repeats did not justify the slower initial reads.

## Local-cache experiment held out of this release

An experimental v6 source retained short-lived records locally per KV binding in a module WeakMap, bounded to 32 entries and 4 MiB of charged serialized storage. Its fixed provider expiry, detached reads and binding isolation passed functional tests, but it did not complete the performance qualification.

The single frozen run completed one paired observation, then Cloudflare routed the next request to another isolate after the recorded natural five-second expiry wait. The protocol rejected the changed isolate and binding before calling the product. Only one of six pairs completed; no cohort median, first-read acceptance or local-cache improvement is claimed. The experiment and its tests were preserved separately, without resampling.

This release restores the exact batch-only source. It adds no local cache or short-TTL KV writes.

## Correctness and build evidence

The final batch-only source passed all 141 Worker tests, covering batching, fallback, duplicate URLs, direct wins, malformed/expired records, aborts and streaming. All 18 all-history handler oracle cases passed with their minimum-route and directed-proof checks; their in-memory transport is correctness evidence, not provider timing. The final Wrangler dry-run build passed. Source SHA-256 is `28dd7af40ce780cd49c34cd6a97570a3b94dafd37adc4e7eb85d28d279678025`, with release marker `2026-10-16-bulk-months-v4`.

Saved evidence is under `.project-audit-20261013/implementation/connections-monthly-cache-20261016`. Public API completion checks are recorded separately from these component measurements; earlier cache filling and different request times prevent a paired whole-search speed comparison.
