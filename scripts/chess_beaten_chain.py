#!/usr/bin/env python3
"""
chess_beaten_chain.py
---------------------
Find a "beaten chain" between two Chess.com players.

A path  START -> A -> B -> ... -> TARGET  where each arrow "X -> Y" means
X beat Y in a recorded STANDARD-CHESS LIVE game (variants AND daily/
correspondence games excluded - only rapid/blitz/bullet count).

Pure public Chess.com pubapi (no key required).

Usage:
    python chess_beaten_chain.py <start_username> <target_username> [max_depth]
    python chess_beaten_chain.py trixize1234 hikaru 4

Can also be imported:
    from chess_beaten_chain import find_chain
    path, hops = find_chain("trixize1234", "hikaru", max_depth=4)
"""

import urllib.request
import json
import time
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

HEADERS = {"User-Agent": "chess-connections/1.0 (github.com/tetizz/Connections)"}

# Cache lives next to the script so the action and local runs share it.
CACHE_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "chess_cache"
)

_MEM_GAMES = {}   # username_lower -> list[dict]
_MEM_EDGES = {}   # username_lower -> (beaten_by_me, beat_me)


def fetch(url, retries=5):
    """GET JSON with exponential backoff for 429/server errors."""
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(min(2 ** attempt, 16))
    raise last


def cache_path(u):
    return os.path.join(CACHE_DIR, f"{u.lower()}_stdgames.json")


def get_std_games(username):
    """All standard-chess games for a user. Cached on disk + in memory.

    Each game is a slim dict. Returns [] for closed/missing accounts.
    """
    u = username.lower()
    if u in _MEM_GAMES:
        return _MEM_GAMES[u]
    os.makedirs(CACHE_DIR, exist_ok=True)
    cp = cache_path(u)
    if os.path.exists(cp):
        try:
            games = json.load(open(cp))
            _MEM_GAMES[u] = games
            return games
        except Exception:
            pass
    try:
        archives = fetch(
            f"https://api.chess.com/pub/player/{u}/games/archives"
        )["archives"]
    except Exception:
        _MEM_GAMES[u] = []
        json.dump([], open(cp, "w"))
        return []
    games = []
    for arch in archives:
        try:
            data = fetch(arch)
        except Exception:
            continue
        for g in data.get("games", []):
            if g.get("rules", "chess") != "chess":  # skip variants
                continue
            games.append({
                "white": (g.get("white", {}).get("username") or "").lower(),
                "black": (g.get("black", {}).get("username") or "").lower(),
                "white_result": g.get("white", {}).get("result"),
                "black_result": g.get("black", {}).get("result"),
                "url": g.get("url"),
                "time_class": g.get("time_class"),
            })
    _MEM_GAMES[u] = games
    json.dump(games, open(cp, "w"))
    return games


def edges(username):
    """Return (beaten_by_me, beat_me) dicts for a user.

    beaten_by_me[opp] = [urls...]   games where `username` won
    beat_me[opp]     = [urls...]   games where `opp` beat `username`

    Daily games are excluded (only live: rapid/blitz/bullet).
    """
    u = username.lower()
    if u in _MEM_EDGES:
        return _MEM_EDGES[u]
    games = get_std_games(u)
    beaten_by_me, beat_me = {}, {}
    for g in games:
        if g.get("time_class") == "daily":  # no correspondence
            continue
        w, b = g["white"], g["black"]
        if w == u:
            if g["white_result"] == "win" and b:
                beaten_by_me.setdefault(b, []).append(g["url"])
            elif g["black_result"] == "win" and b:
                beat_me.setdefault(b, []).append(g["url"])
        elif b == u:
            if g["black_result"] == "win" and w:
                beaten_by_me.setdefault(w, []).append(g["url"])
            elif g["white_result"] == "win" and w:
                beat_me.setdefault(w, []).append(g["url"])
    _MEM_EDGES[u] = (beaten_by_me, beat_me)
    return beaten_by_me, beat_me


def prefetch(usernames, log=print, workers=20):
    """Cache game histories for all usernames in parallel."""
    todo = [u for u in usernames
            if u.lower() not in _MEM_GAMES and not os.path.exists(cache_path(u))]
    if not todo:
        return
    log(f"    prefetching {len(todo)} players ({workers} parallel)...")
    start = time.time()
    done = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(get_std_games, u): u for u in todo}
        for f in as_completed(futs):
            try:
                f.result()
            except Exception as e:  # noqa: BLE001
                log(f"      [err {futs[f]}: {str(e)[:40]}]")
            done += 1
            if done % 100 == 0:
                log(f"      {done}/{len(todo)} ({time.time()-start:.0f}s)")
    log(f"    prefetched {len(todo)} in {time.time()-start:.0f}s")


def find_chain(start, target, max_depth=4, log=print, frontier_cap=2000,
               deadline=None):
    """BFS shortest beaten-chain from start to target.

    Returns (path_list, hops) where hops is a list of
    {"from", "to", "url"} dicts. Both are None if not found.

    frontier_cap: if the BFS frontier exceeds this many nodes at one depth,
        the search is abandoned (returns None) rather than fanning out
        explosively. Prevents runaway searches for super-strong targets.
    deadline: optional epoch seconds; if exceeded, returns None.
    """
    start, target = start.lower(), target.lower()

    log(f"Loading backward set: who has beaten {target}...")
    _, beat_target = edges(target)
    log(f"  {len(beat_target)} players have beaten {target}")

    log(f"Loading start: who {start} has beaten...")
    beaten_start, _ = edges(start)
    log(f"  {start} has beaten {len(beaten_start)} players")

    visited = {start}
    # frontier: (node, path_list, hops_list)
    frontier = [(start, [start], [])]

    for depth in range(max_depth):
        if not frontier:
            log("  frontier empty - no further connections possible")
            break
        if deadline and time.time() > deadline:
            log("  deadline exceeded - aborting search")
            break
        log(f"\n== Depth {depth}: {len(frontier)} nodes to expand ==")

        prefetch([n for n, _, _ in frontier], log)
        node_beaten = {n: edges(n)[0] for n, _, _ in frontier}

        # Pass 1 - direct hit: a frontier node beat TARGET (length depth+1)
        for node, path, hops in frontier:
            if target in node_beaten[node]:
                full = path + [target]
                full_hops = hops + [{"from": node, "to": target,
                                     "url": node_beaten[node][target][0]}]
                return full, full_hops

        # Pass 2 - shortcut: frontier node beat someone who beat TARGET
        for node, path, hops in frontier:
            inter = set(node_beaten[node]) & set(beat_target)
            if inter:
                mid = next(iter(inter))
                full = path + [mid, target]
                full_hops = hops + [
                    {"from": node, "to": mid,
                     "url": node_beaten[node][mid][0]},
                    {"from": mid, "to": target,
                     "url": beat_target[mid][0]},
                ]
                return full, full_hops

        # Pass 3 - expand frontier by one 'beat' hop
        nxt = []
        for node, path, hops in frontier:
            if deadline and time.time() > deadline:
                log("  deadline exceeded mid-expand - aborting")
                break
            for opp, urls in node_beaten[node].items():
                if opp not in visited:
                    visited.add(opp)
                    nxt.append((opp, path + [opp],
                                hops + [{"from": node, "to": opp,
                                         "url": urls[0]}]))
                    if len(nxt) >= frontier_cap:
                        break
            if len(nxt) >= frontier_cap:
                break
        frontier = nxt
        if len(frontier) >= frontier_cap:
            log(f"  frontier cap ({frontier_cap}) hit at depth {depth+1} "
                "- search too large, abandoning")
            return None, None
        log(f"  expanded to {len(frontier)} candidates for next depth")

    return None, None


def main():
    if len(sys.argv) < 3:
        print("Usage: python chess_beaten_chain.py "
              "<start> <target> [max_depth]")
        sys.exit(1)
    start, target = sys.argv[1], sys.argv[2]
    max_depth = int(sys.argv[3]) if len(sys.argv) > 3 else 4
    print(f"Searching beaten-chain:  {start}  ->  {target}   "
          f"(max depth {max_depth})")
    print("=" * 64)
    t0 = time.time()
    path, hops = find_chain(start, target, max_depth)
    print("=" * 64)
    print(f"(elapsed {time.time()-t0:.0f}s)")
    if path:
        print(f"\n*** CHAIN FOUND  (length {len(path)-1}) ***\n")
        for h in hops:
            print(f"  {h['from']}  BEAT  {h['to']}")
            print(f"        proof: {h['url']}")
        print(f"\n  path: {'  ->  '.join(path)}")
    else:
        print(f"\nNo beaten-chain found within depth {max_depth}.")


if __name__ == "__main__":
    main()
