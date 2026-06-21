#!/usr/bin/env python3
"""
compute_chains.py
-----------------
Batch runner: reads config.yml, runs the beaten-chain search for every
target, and emits data/chains.json + data/players.json that the static
site consumes.

Run locally:
    python scripts/compute_chains.py
The GitHub Action does the same thing on schedule.
"""

import json
import os
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
sys.path.insert(0, HERE)

from chess_beaten_chain import find_chain, fetch, edges  # noqa: E402

HEADERS = {"User-Agent": "chess-connections/1.0 (github.com/tetizz/Connections)"}


def load_config():
    """Tiny YAML loader - config.yml is simple enough to parse by hand."""
    path = os.path.join(ROOT, "config.yml")
    cfg = {"start": None, "max_depth": 4, "targets": []}
    cur_target = None
    for raw in open(path, encoding="utf-8"):
        line = raw.rstrip()
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        # match on the stripped form so indentation doesn't break parsing
        if stripped.startswith("start:") and "targets" not in stripped:
            cfg["start"] = stripped.split(":", 1)[1].strip()
        elif stripped.startswith("max_depth:"):
            cfg["max_depth"] = int(stripped.split(":", 1)[1].strip())
        elif stripped.startswith("- username:"):
            cur_target = {"username": stripped.split(":", 1)[1].strip(),
                          "display": ""}
            cfg["targets"].append(cur_target)
        elif stripped.startswith("display:") and cur_target is not None:
            cur_target["display"] = stripped.split(":", 1)[1].strip()
    return cfg


def player_meta(username):
    """Fetch avatar / title / name / url for nicer cards. Best-effort."""
    try:
        p = fetch(
            f"https://api.chess.com/pub/player/{username.lower()}")
        return {
            "username": p.get("username", username),
            "avatar": p.get("avatar"),
            "title": p.get("title"),
            "name": p.get("name"),
            "url": p.get("url"),
            "country": (p.get("country") or "").split("/")[-1].upper()
            if p.get("country") else None,
        }
    except Exception:
        return {"username": username, "avatar": None, "title": None,
                "name": None, "url": None, "country": None}


def main():
    cfg = load_config()
    start = cfg["start"]
    max_depth = cfg["max_depth"]
    targets = cfg["targets"]
    print(f"Config: start={start}  max_depth={max_depth}  "
          f"targets={[t['username'] for t in targets]}")

    data_dir = os.path.join(ROOT, "data")
    os.makedirs(data_dir, exist_ok=True)
    chains_path = os.path.join(data_dir, "chains.json")
    players_path = os.path.join(data_dir, "players.json")

    # resume support: load any previously-computed data so we can skip
    # targets already done and merge player metadata incrementally.
    try:
        prev = json.load(open(chains_path))
        chains = prev.get("chains", [])
    except Exception:
        prev = {}
        chains = []
    try:
        players = json.load(open(players_path))
    except Exception:
        players = {}

    def save():
        out = {
            "start": start,
            "start_display": players.get(start.lower(), {}).get("name", start),
            "max_depth": max_depth,
            "computed_at": int(time.time()),
            "chains": chains,
        }
        json.dump(out, open(chains_path, "w"), indent=2)
        json.dump(players, open(players_path, "w"), indent=2)

    def ensure_player(u):
        u = u.lower()
        if u in players:
            return
        players[u] = player_meta(u)
        print(f"    player meta: {u}: "
              f"{players[u].get('title','')} {players[u].get('name','')}")

    # always refresh the start + target metadata (cheap, keeps avatars fresh)
    ensure_player(start)
    for t in targets:
        ensure_player(t["username"])

    done_targets = {c["target"] for c in chains}

    for t in targets:
        target = t["username"]
        if target in done_targets:
            print(f"\n[skip] {target} already computed")
            continue
        print("\n" + "#" * 64)
        print(f"# {start}  ->  {target}   ({t.get('display', target)})")
        print("#" * 64)
        t0 = time.time()
        # give each target at most ~3 minutes so one hard target can't
        # block the whole batch run
        deadline = time.time() + 180
        path, hops = find_chain(start, target, max_depth, deadline=deadline)
        elapsed = time.time() - t0
        if path:
            print(f"\nFOUND length {len(path)-1} in {elapsed:.0f}s")
            for h in hops:
                print(f"  {h['from']} -> {h['to']}  {h['url']}")
                ensure_player(h["from"])
                ensure_player(h["to"])
            chains.append({
                "target": target,
                "display": t.get("display", target),
                "found": True,
                "length": len(path) - 1,
                "path": path,
                "hops": hops,
            })
        else:
            print(f"\nNO CHAIN within depth {max_depth} ({elapsed:.0f}s)")
            chains.append({
                "target": target,
                "display": t.get("display", target),
                "found": False,
                "length": None,
                "path": [],
                "hops": [],
            })
        # save after EACH target so a kill doesn't lose work
        save()
        print(f"  (saved progress: {len(chains)}/{len(targets)} targets)")

    print(f"\nDone. {len(chains)} chains written to {chains_path}")


if __name__ == "__main__":
    main()
