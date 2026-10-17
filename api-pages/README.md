# Connections API on Pages

Deployed at https://tetizz-connections-api.pages.dev. The frontend is deployed at https://tetizz-connections.pages.dev. Production service bindings and HTTP behavior were verified; two fresh full-history searches through the Pages API completed with shortest direct-route proofs. These checks establish that tested scope, not a general search-speed multiplier.

public/_worker.js forwards every method/path/query/body/header through CONNECTIONS to the existing connections-cache service and returns its original Response. Redirects are not followed; CORS, errors, streams and upgrade handles are retained. The fixed workers.dev URL is an internal service-request identity, not a public network hop. wrangler.jsonc preserves compatibility_date2026-06-24 and the service binding. KV, SQLite Durable Objects, alarms, secrets and backend logic remain with the existing service; no data migration or deletion is required.

The old c frontend now returns a verified308 to the Pages frontend, preserving path/query. Its exact deployed redirect source/config are retained in ../legacy-site-redirect. The backend public workers.dev route and preview URLs were disabled on October 16, 2026; Pages reaches the unchanged Worker through the service binding.

From this directory, the existing deployment recipe is:

    wrangler pages deploy public --project-name tetizz-connections-api --branch main

Use the reviewed installed CLI and preserve the production CONNECTIONS binding. Output is public. Local relay contracts cover forwarding/response identity; they do not replace live service-binding or browser qualification.