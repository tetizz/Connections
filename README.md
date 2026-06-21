# ♞ Chess Connections

> Six degrees of chess separation. Trace the chain of **real recorded wins**
> that links any player to the world's top grandmasters.

Live site: **https://tetizz.github.io/Connections/**

This repo answers questions like:

> *"Who did I beat, who beat someone, who beat someone, ... who beat Hikaru?"*

Each link in the chain is a genuine win in a **live** Chess.com game
(rapid / blitz / bullet). Daily (correspondence) games and variants
(bughouse, chess960, etc.) are excluded — only real over-the-board-style wins
count.

---

## How it works

```
┌─────────────────┐     GitHub Actions      ┌──────────────┐     GitHub Pages
│  Chess.com API  │ ─────────────────────▶  │  data/*.json │ ─────────────▶  🌐 animated site
│  (public, no key)│   scripts/compute_chains │              │   site/ (static)
└─────────────────┘                          └──────────────┘
```

1. **`scripts/chess_beaten_chain.py`** — the engine. Builds a directed graph
   where `X → Y` means *X beat Y in a live standard game*, then runs BFS to
   find the shortest path from a start player to a target.
2. **`scripts/compute_chains.py`** — batch runner. Reads `config.yml`, runs
   the search for every target, and writes `data/chains.json` +
   `data/players.json`.
3. **`.github/workflows/compute-chains.yml`** — runs weekly and on push,
   commits fresh data back to `main`.
4. **`.github/workflows/deploy-pages.yml`** — publishes `site/` to GitHub
   Pages whenever data or site files change.
5. **`site/`** — a no-build-step static site (vanilla HTML/CSS/JS) that
   renders the chains as an animated node graph with a travelling chess piece.

### Why precompute instead of live-search?

Chess.com's pubapi does **not** send CORS headers, so a browser `fetch()` is
blocked. Precomputing via GitHub Actions sidesteps that entirely — and keeps
the site fast, free, and dependency-free.

---

## Run it locally

```bash
# find a single chain
python scripts/chess_beaten_chain.py trixize1234 hikaru 4

# regenerate all data/*.json from config.yml
python scripts/compute_chains.py

# preview the site (from the repo root)
python -m http.server 8000
# then open http://localhost:8000/site/
```

> Note: the engine caches every player's game history under `chess_cache/`
> (gitignored). First runs are slow; reruns are near-instant.

---

## Make it yours

Edit **`config.yml`**:

```yaml
start: your_username
max_depth: 4
targets:
  - username: hikaru
    display: Hikaru Nakamura
  - username: magnuscarlsen
    display: Magnus Carlsen
```

Push to `main` — the Action recomputes and the site updates automatically.
Or trigger a manual run from the
[Actions tab](https://github.com/tetizz/Connections/actions)
(`workflow_dispatch`).

---

## Data source & limits

- All data comes from the public
  [Chess.com Published Data API](https://www.chess.com/news/view/published-data-api)
  (no API key, read-only).
- The API is rate-limited (~300 req/min); the engine retries with backoff.
- Chains longer than ~4 hops get slow due to graph fan-out. BFS guarantees
  the chain shown is the **shortest** that exists within `max_depth`.
- A chain may not exist for very strong targets — the site shows a graceful
  "no chain within N hops" message in that case.

---

## License

MIT — see the engine and site files. Chess.com game data is owned by
Chess.com and its players; this project only links to public game URLs.
