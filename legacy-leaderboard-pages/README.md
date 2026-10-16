# Legacy chess leaderboard on Pages

Source-only relay for https://tetizz-chess-leaderboard.pages.dev. No runtime, test or deployment has been performed during preparation.

The standalone advanced-mode public/_worker.js forwards all methods, paths, queries, request bodies and headers through LEGACY_LEADERBOARD to the existing chess-connections-leaderboard service. The fixed workers.dev URL is an internal service-request identity, not a network fetch. Original responses—including streaming/upgrade handles and redirects—are returned unchanged; redirects are not followed. No route allowlist, retry, asset fallback or fabricated response is added.

wrangler.toml preserves the live compatibility_date2024-09-25. The existing Worker and LEADERBOARD namespace88a8db1b34d74d54b5ec6c38aa5af7f0 remain unchanged; the relay has no direct KV binding, data operation or migration. Root must verify actual production service binding before retiring public workers.dev exposure. Domain migration does not authorize deletion of backend state.

Root source deployment command from this directory, using the reviewed existing CLI after qualification:

    wrangler pages deploy public --project-name tetizz-chess-leaderboard --branch main

Output directory is public; only _worker.js is served in advanced mode. Root separately owns project creation, binding/source verification, ordinary endpoint/preflight/error behavior and publication. The relay tests in worker/test/pages-relay.test.mjs cover forwarding and response identity locally, not deployed binding or browser compatibility.
