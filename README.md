# Chess Connections

Chess Connections answers a simple chess question:

> Who did I beat, who beat someone else, who beat someone else... until the chain reaches a grandmaster?

The site traces those links with real Chess.com live-game results. A link only counts when one player beat the next player in rapid, blitz, or bullet. Daily games and variants are skipped.

Live site: https://tetizz-connections.pages.dev/

## What the site does

- Searches for a verified win chain between two Chess.com usernames.
- Runs every search against full game history as a persistent backend job. Closing the browser does not stop its server work; the page can resume saved searches for seven days.
- Shows the last server-verified route immediately, while a new full search checks for a shorter route. A saved route never counts as proof that no shorter route exists.
- Searches the current Chess.com leaderboard targets in parallel, displays routes as they arrive, and retains unfinished target jobs for resume.
- Shows the chain as an animated graph.
- Ranks the top connector players by how often they appear in the middle of submitted chains.
- Lists every hop with a link back to the original Chess.com game.
- Builds shareable result links with the exact chain, proof games, graph, and profile data.
- Shows player profile cards with avatars, flags, ratings, joined date, status, and recent public games.
- Saves fetched game histories in shared Cloudflare KV cache for a week so repeated searches are faster.
- Warms the cache around live Rapid, Blitz, and Bullet leaderboard players plus common targets.
- Includes a private owner debug panel for recent search outcomes, timings, request counts, reused cache hits, and errors.
- Uses paged Durable Object queues and visited records so a large search frontier is not silently truncated.
- Reuses fetched archives and verified proofs across searches, including different player pairs. Overlapping archive requests can share raw responses without sharing job-specific proof state or cancellation.

## Dialogue changes

The redesign rewrites the site copy around the way a chess player actually uses the tool:

- "Trace chain" instead of vague search language.
- "Recorded wins" for the chain length, because every edge needs a proof game.
- "Proof ledger" for the hop list, because each row is evidence, not decoration.
- Shorter status messages while the engine scans archives.
- Settings copy that says exactly what is saved and why.

No fake claims, no filler metrics, and no marketing page in front of the app.

## How it works

The project is intentionally small:

```text
config.yml
    |
    v
scripts/compute_chains.py
    |
    v
data/*.json and site/data/*.json
    |
    v
site/index.html, site/styles.css, site/app.js
```

The Python scripts can precompute chains from `config.yml` for separate offline analysis. Ordinary website searches use the persistent backend; bundled example chains are not substituted for a fresh search.

Main files:

- `scripts/chess_beaten_chain.py` builds the directed graph. `A -> B` means A beat B in a standard live game.
- `scripts/compute_chains.py` runs the configured searches and writes JSON.
- `site/engine.js` keeps a full-history engine for explicit local testing. The public controller never silently switches to a limited browser crawl when the server is unavailable.
- `site/cache.js` reads from IndexedDB first, then the shared Cloudflare Worker cache when configured.
- `site/app.js` renders the graph, ledger, settings, profile cards, share links, job progress, and search states.
- `site/leaderboard.js` auto-submits found chains and displays the top 10 connector players with Chess.com profile photos.
- `worker/` is the Cloudflare Worker backend for search jobs, cache warming, profiles, suggestions, the leaderboard, owner debug data, and shared game-history cache.

## Cloudflare backend

The hosted frontend calls its own `/api/*` routes through a service binding to the private `connections-cache` Worker. This avoids a separate browser cross-origin hop. Static local testing and older clients can use the existing standalone Pages API:

```text
https://tetizz-connections-api.pages.dev
```

Endpoints:

- `GET /games?key=username:recent:N` checks KV first, then fetches public Chess.com archives on a miss and stores sanitized game rows for seven days.
- `POST /search/start` starts a full-history backend search and returns its persistent job ID. A cached verified route may accompany a queued/running job as a provisional incumbent.
- `GET /search/job?id=...` returns live progress or the finished chain.
- `GET|POST /search/warm` refreshes common target/profile/game caches in the background.
- `GET /profile?username=...` returns Chess.com profile details, ratings, and recent public games.
- `GET /suggest?query=...` returns username autocomplete suggestions.
- `POST /submit` accepts server-verified search results for the historical rankings and rate-limits writes by IP. This historical ranking is separate from the live top-player search.
- `GET /leaderboard?limit=50` returns connector-player rankings built from stored chains.
- `POST /analytics/event` records search lifecycle events.
- `GET /analytics?limit=30` returns owner-only debug timeline data.
- `GET /health` is an uptime check.

Useful commands:

```bash
cd worker
npm install
npx wrangler whoami
npm run deploy
```

The backend keeps its existing KV and Durable Object bindings, and its public `workers.dev` and preview URLs remain disabled. `site/_worker.js` and `site/_routes.json` limit frontend function routing to the API; normal assets keep static delivery.

## Run it locally

```bash
python -m http.server 8000
```

Open:

```text
http://localhost:8000/site/
```

To regenerate the bundled data:

```bash
python scripts/compute_chains.py
```

To test a single chain from the command line:

```bash
python scripts/chess_beaten_chain.py trixize1234 hikaru 4
```

The scripts create a `chess_cache/` folder locally. It is ignored by git. First runs can be slow; cached runs are much faster.

## Configure examples

Edit `config.yml`:

```yaml
start: your_username
max_depth: 4
targets:
  - username: hikaru
    display: Hikaru Nakamura
  - username: magnuscarlsen
    display: Magnus Carlsen
```

Then run:

```bash
python scripts/compute_chains.py
```

Commit the updated JSON if you want the hosted examples to change.

## Data notes

- Data comes from the public Chess.com Published Data API.
- Searches can get expensive quickly because each player can add many more players to the graph.
- Every ordinary and top-player search uses all advertised monthly archives. There is no recent-only fallback or hidden depth-five browser search.
- Missing, malformed or unavailable archive data remains incomplete and retryable. It is not cached as an empty history or treated as proof that a route does not exist.
- A displayed route has one public win proof per hop. Provisional routes stay visible while shorter possibilities are checked.
- “Shortest verified for this search” refers to the complete observed game-history graph checked by that search, not an atomic live snapshot of Chess.com as new games arrive.
- Brief raw-response sharing is bounded and isolated from proof collectors. It is an in-isolate optimization; it does not imply that separate Durable Object isolates share memory.

## License

MIT. Chess.com game data belongs to Chess.com and its players; this project only links to public game pages.
