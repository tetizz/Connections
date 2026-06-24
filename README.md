# Chess Connections

Chess Connections answers a simple chess question:

> Who did I beat, who beat someone else, who beat someone else... until the chain reaches a grandmaster?

The site traces those links with real Chess.com live-game results. A link only counts when one player beat the next player in rapid, blitz, or bullet. Daily games and variants are skipped.

Live site: https://tetizz.github.io/Connections/

## What the site does

- Searches for a verified win chain between two Chess.com usernames.
- Shows the chain as an animated graph.
- Ranks searches by the most middle connections found. The start player and target are shown in the path but do not count toward the score.
- Lists every hop with a link back to the original Chess.com game.
- Saves fetched game histories in the browser and shared Cloudflare KV cache for a week so repeated searches are faster.
- Defaults to an instant bridge check so a random username gets a fast answer instead of a long crawl.
- Ships with precomputed example chains so the page has something useful to show immediately.

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

The Python scripts can precompute chains from `config.yml`. The static site reads the generated JSON for examples, then uses the browser-side engine for ad hoc searches.

Main files:

- `scripts/chess_beaten_chain.py` builds the directed graph. `A -> B` means A beat B in a standard live game.
- `scripts/compute_chains.py` runs the configured searches and writes JSON.
- `site/engine.js` runs the bidirectional search in the browser.
- `site/cache.js` reads from IndexedDB first, then the shared Cloudflare Worker cache when configured.
- `site/app.js` renders the graph, ledger, settings, and search states.
- `site/leaderboard.js` auto-submits found chains and displays the global most-connections leaderboard. Its score is the number of middle players between the start and target.
- `worker/` is the Cloudflare Worker backend for the leaderboard and shared game-history cache.

## Cloudflare backend

The shared backend runs on Cloudflare Workers + KV:

```text
https://connections-cache.tetizz.workers.dev
```

Endpoints:

- `GET /games?key=username:recent:N` checks KV first, then fetches public Chess.com archives on a miss and stores sanitized game rows for seven days.
- `POST /submit` stores an automatically submitted found chain, rejects duplicate exact paths, dedupes by `(start,target)` while keeping the chain with the most middle connections, and rate-limits writes by IP.
- `GET /leaderboard?limit=50` returns ranked entries with the most connections first.
- `GET /health` is an uptime check.

Useful commands:

```bash
cd worker
npm install
npx wrangler whoami
npm run deploy
```

After changing the Worker URL, update `site/config.js`.

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
- Depth 3 is the practical default for a browser session.
- `Instant bridge` checks the starting player's latest two monthly archives for a direct win or a known connector into a saved master-player route. It returns fast and stops there.
- `Recent fast` checks the latest six monthly archives for each player it touches.
- `Last year` checks the latest twelve monthly archives and can use the shared Cloudflare cache.
- `Full slow` checks all available archives and can take much longer, especially for famous players.
- If no chain is found, that means no chain was found inside the chosen depth, not that no chain exists.

## License

MIT. Chess.com game data belongs to Chess.com and its players; this project only links to public game pages.
