# Connections API on Pages

Source preparation only. The public API origin is https://tetizz-connections-api.pages.dev. The existing frontend remains https://tetizz-connections.pages.dev.

public/_worker.js is a standalone Pages advanced-mode service-binding proxy. Every method/path/query/body/header is forwarded to the existing connections-cache Worker through CONNECTIONS; it does not fetch its public hostname over the network. The fixed internal request origin preserves the backend's existing URL identity while the original Origin header remains unchanged. The backend retains CORS/preflight, all API/proof/fresh-search rules, KV, SQLite Durable Objects, alarms, secrets and authority. No DO class, migration, new data store or backend source is included here.

The proxy returns the original Response promise without parsing/reconstructing its body or headers. Redirects are not followed; status, CORS, cache policy, errors, streaming and runtime-owned upgrade handles stay with the backend. It adds no path allowlist, asset fallback, retry or caching layer. Incoming HEAD/OPTIONS/POST and arbitrary query parameters follow the same backend routing contract. Missing/broken service binding is an infrastructure failure, not a fabricated API success.

Root deployment source command, from this api-pages directory after source/runtime review:

    wrangler pages deploy public --project-name tetizz-connections-api --branch main

Use the existing reviewed installed CLI, not an installer. wrangler.jsonc binds production CONNECTIONS to the existing connections-cache service and compatibility_date2026-06-24. Root must verify actual production binding settings, project creation/default branch and any independently configured preview environment before publication. This source has not been imported, checked, built, tested or deployed. No resource deletion or workers.dev exposure change is performed by this config.

After API publication, Root must deploy the frontend config.js/leaderboard.js/index.html changes and qualify same paths/query/preflight/errors, ordinary fresh all-history search/terminal proof, leaderboard submit with serverSearchId and explicit share behavior. Frontend query versions invalidate the old cached API configuration/scripts. A Pages frontend deployment alone does not establish the API binding or search quality. Keep the internal Worker and its data while public workers.dev exposure is retired separately after exact verification.
