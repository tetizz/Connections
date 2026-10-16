# Legacy chess leaderboard on Pages

Deployed at https://tetizz-chess-leaderboard.pages.dev. Production service binding and HTTP behavior were verified.

public/_worker.js forwards all methods/paths/queries/bodies/headers through LEGACY_LEADERBOARD to the existing chess-connections-leaderboard service and returns the original Response, including redirects/streaming/upgrade handles. The fixed workers.dev URL identifies an internal service request; it is not fetched over the public network. No route allowlist, retry, asset fallback or fabricated response is added.

wrangler.jsonc preserves compatibility_date2024-09-25. The existing Worker and LEADERBOARD namespace88a8db1b34d74d54b5ec6c38aa5af7f0 remain intact; this relay has no direct KV binding or migration. The backend public workers.dev route and preview URLs were disabled on October 16, 2026. Pages still reaches the unchanged internal service.

From this directory, the existing deployment recipe is:

    wrangler pages deploy public --project-name tetizz-chess-leaderboard --branch main

Output is public. Preserve the production LEGACY_LEADERBOARD service binding. Local relay contracts establish forwarding/identity behavior; native upgrade/browser qualification remains separate.