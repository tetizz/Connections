# Bounded performance records

The optional `PERFORMANCE_METRICS=true` environment value enables one fixed-size numeric record per fetch or scheduled warm operation. It defaults off; the checked-in Wrangler settings and deployed environment are unchanged. Existing platform sampling applies if this is enabled in a future release. No additional storage, binding or paid product is required by the source.

Fetch dimensions are an allowlisted route class and HTTP method. Query values, profile names, request bodies, headers, credentials, job IDs and error messages are absent from these new records. Unknown paths collapse to `other`. Logger failure does not change the response.

`/profile` and `/games` record primary endpoint fresh/stale/miss/cooldown decisions, cold-fill ownership/sharing/overflow, physical upstream attempts and selected status classes, upstream-fetch elapsed time and JSON-body parse elapsed time. A shared fill's physical work belongs to its owner; waiters record sharing and zero owned upstream attempts. Successful partial enrichment is explicit. These counters do not change cache identity, deadlines or rate-limit behavior.

Other routes and scheduled warming record only status and elapsed operation/response-handler time. Their detailed cache/upstream counters are **null**, meaning unmeasured. Durable Object alarms, search stages and their individual upstream operations still need separate detailed instrumentation. Do not read these nulls as zero work.

Elapsed fields are wall-clock observations, **not CPU measurements or time to the last byte on a user's screen**. Workers clock precision/advancement can differ from a local Node fixture, especially for synchronous parse work. A zero parse interval does not establish zero CPU work. Use platform CPU profiling/metrics for CPU, and match route/version/cache conditions before comparing p50/p95 from a stated sample window.

Focused fixtures verify twelve concurrent cold profile requests report one owner, eleven waiters and exactly three total physical upstream attempts; warm/cooldown requests record no upstream work. Existing response, proof, retry and cache suites still pass. Nothing has been deployed or enabled live.

Cloudflare references: [structured Worker logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) and [metrics definitions](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/). The initial source review's legacy error logs are outside this new numeric-record contract and may still include public player identifiers; this change does not claim to sanitize every existing log.
