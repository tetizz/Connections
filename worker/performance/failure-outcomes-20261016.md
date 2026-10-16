# Failure reporting repair

Release `2026-10-16-failure-outcomes-v5` fixes a secondary exception in `failSearchJob()`. The function persisted the failed or throttled job, then referenced the unrelated `completed` variable while recording analytics. It now uses its own persisted `job` result. Failure outcomes, analytics and warnings finish without that second exception; route answers are not promoted.

The regression exercises the real `runSearchJob()` path with an upstream exception and HTTP 429. It reproduces `ReferenceError: completed is not defined` on the original source and passes after the fix. The 429 case checks timeout classification; it does not establish shared cooldown creation or enforcement.

All 162 backend/relay tests and the Worker build passed. The published module matches the tested bundle byte-for-byte, SHA-256 `2b61676705156c7ed18ccf85a8e2555d036712fc30246eb8d5380821a55caf92`. Source SHA-256 is `6a2561d59670a755af9fbb3b6c4d356a8bfcc2a8c29236df6ab2917a6a75a1b9`.

The Pages health endpoint reported v5 after publication. A fresh all-history search completed with its verified direct-game proof. Its observed completion was 6,479.9 ms, including polling; this single observation is release verification, not a before/after speed comparison. Existing bindings, namespace IDs, schedules and private Worker routes were preserved.

Checkpoint attribution remains unmeasured. No diagnostic search was dispatched: Preview namespaces cannot be bound to Pages, and a later ordinary private-Worker diagnostic stopped before its first task request because its new Pages hostname initially returned 522. Both Pages URLs later returned the expected 403 gate, confirming readiness was transient. All temporary Pages projects, Workers, Previews and their namespaces were removed; production metadata remained unchanged before this v5 release. A future run must qualify the exact deployment's readiness before dispatch and use newly derived v5 source pins.

The accepted monthly cache batching logic is unchanged. There is no new successful-search speed multiplier or general tenfold claim.
