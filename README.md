# Chess Connections

Chess Connections answers a simple chess question:

> Who did I beat, who beat someone else, who beat someone else... until the chain reaches a grandmaster?

The site traces those links with real Chess.com live-game results. A link only counts when one player beat the next player in rapid, blitz, or bullet. Daily games and variants are skipped.

Live site: https://tetizz.github.io/Connections/

## What the site does

- Searches for a shortest known win chain between two Chess.com usernames.
- Shows the chain as an animated graph.
- Lists every hop with a link back to the original Chess.com game.
- Saves fetched game histories in the browser for a week so repeated searches are faster.
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
- `site/cache.js` stores fetched game histories in IndexedDB.
- `site/app.js` renders the graph, ledger, settings, and search states.

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
- Depth 3 or 4 is usually the practical range for a browser session.
- If no chain is found, that means no chain was found inside the chosen depth, not that no chain exists.

## License

MIT. Chess.com game data belongs to Chess.com and its players; this project only links to public game pages.
