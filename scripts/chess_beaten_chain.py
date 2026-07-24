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
import urllib.error
import json
import time
import os
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed

HEADERS = {
    "User-Agent":
        "chess-connections/2.0 (+https://github.com/tetizz/Connections/issues)"
}

# Cache lives next to the script so the action and local runs share it.
CACHE_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "chess_cache"
)

CACHE_SCHEMA_VERSION = 1
# The scheduled refresh runs weekly. Keep restored action caches for speed, but
# force a real Chess.com refresh before the next scheduled run.
CACHE_MAX_AGE_SECONDS = int(
    os.environ.get("CONNECTIONS_CACHE_TTL_SECONDS", 5 * 24 * 60 * 60)
)

_MEM_GAMES = {}   # username_lower -> {"fetched_at": float, "games": list[dict]}
_MEM_EDGES = {}   # username_lower -> (beaten_by_me, beat_me)


class GameDataRefreshError(RuntimeError):
    """Raised when a complete, trustworthy game-history refresh is impossible."""


class SearchIncompleteError(RuntimeError):
    """Raised when resource limits prevent a trustworthy not-found result."""


def fetch(url, retries=5):
    """GET JSON with exponential backoff for 429/server errors."""
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            # Retrying rate limits and server errors is useful; retrying a
            # permanent client error only delays the inevitable result.
            if 400 <= e.code < 500 and e.code != 429:
                raise
            last = e
            time.sleep(min(2 ** attempt, 16))
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(min(2 ** attempt, 16))
    raise last


def cache_path(u):
    return os.path.join(CACHE_DIR, f"{u.lower()}_stdgames.json")


def _read_game_cache(path):
    """Return a normalized cache record, including legacy list-only files."""
    try:
        with open(path, encoding="utf-8") as f:
            payload = json.load(f)
    except (OSError, ValueError, TypeError):
        return None

    if isinstance(payload, list):
        # Older cache files were a bare game list. Their mtime is the best
        # available fetch timestamp and lets us migrate without discarding a
        # still-fresh action cache.
        try:
            fetched_at = os.path.getmtime(path)
        except OSError:
            return None
        return {
            "version": 0,
            "fetched_at": fetched_at,
            "games": payload,
            "legacy": True,
        }

    if not isinstance(payload, dict) or not isinstance(payload.get("games"), list):
        return None
    try:
        fetched_at = float(payload["fetched_at"])
    except (KeyError, TypeError, ValueError):
        return None
    return {
        "version": payload.get("version"),
        "fetched_at": fetched_at,
        "games": payload["games"],
        "legacy": False,
    }


def _write_game_cache(path, games, fetched_at):
    """Atomically replace a cache only after a complete refresh succeeds."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    payload = {
        "version": CACHE_SCHEMA_VERSION,
        "fetched_at": fetched_at,
        "games": games,
    }
    fd, tmp_path = tempfile.mkstemp(
        prefix=os.path.basename(path) + ".", suffix=".tmp",
        dir=os.path.dirname(path), text=True
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _cache_is_fresh(record, now):
    return (
        record is not None
        and now >= record["fetched_at"]
        and now - record["fetched_at"] < CACHE_MAX_AGE_SECONDS
    )


def get_std_games(username):
    """All standard-chess games for a user. Cached on disk + in memory.

    Each game is a slim dict. A refresh is only committed if the archive list
    and every monthly archive are fetched successfully.
    """
    u = username.lower()
    now = time.time()
    mem_record = _MEM_GAMES.get(u)
    if _cache_is_fresh(mem_record, now):
        return mem_record["games"]

    os.makedirs(CACHE_DIR, exist_ok=True)
    cp = cache_path(u)
    disk_record = _read_game_cache(cp)
    if _cache_is_fresh(disk_record, now):
        if disk_record["legacy"]:
            _write_game_cache(cp, disk_record["games"], disk_record["fetched_at"])
        _MEM_GAMES[u] = {
            "fetched_at": disk_record["fetched_at"],
            "games": disk_record["games"],
        }
        return disk_record["games"]

    try:
        archive_payload = fetch(
            f"https://api.chess.com/pub/player/{u}/games/archives"
        )
        archives = archive_payload.get("archives")
        if not isinstance(archives, list):
            raise ValueError("archive response has no archives list")
    except urllib.error.HTTPError as exc:
        if exc.code not in (404, 410):
            raise GameDataRefreshError(
                f"could not refresh archive list for {u}"
            ) from exc
        # Chess.com uses these statuses for accounts with no accessible game
        # history. This is an authoritative empty result, not a transient
        # failure, so it is safe to cache.
        archives = []
    except Exception as exc:
        raise GameDataRefreshError(
            f"could not refresh archive list for {u}"
        ) from exc

    games = []
    for arch in archives:
        try:
            data = fetch(arch)
            monthly_games = data.get("games")
            if not isinstance(monthly_games, list):
                raise ValueError("monthly archive has no games list")
        except Exception as exc:
            raise GameDataRefreshError(
                f"incomplete game history for {u}: failed archive {arch}"
            ) from exc
        for g in monthly_games:
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

    fetched_at = time.time()
    _write_game_cache(cp, games, fetched_at)
    _MEM_GAMES[u] = {"fetched_at": fetched_at, "games": games}
    # A caller may explicitly refresh a username in a long-running process.
    _MEM_EDGES.pop(u, None)
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
    todo = list(dict.fromkeys(u.lower() for u in usernames))
    if not todo:
        return
    log(f"    prefetching {len(todo)} players ({workers} parallel)...")
    start = time.time()
    done = 0
    failures = []
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(get_std_games, u): u for u in todo}
        for f in as_completed(futs):
            try:
                f.result()
            except Exception as e:  # noqa: BLE001
                log(f"      [err {futs[f]}: {str(e)[:40]}]")
                failures.append((futs[f], e))
            done += 1
            if done % 100 == 0:
                log(f"      {done}/{len(todo)} ({time.time()-start:.0f}s)")
    if failures:
        players = ", ".join(u for u, _ in failures[:5])
        raise GameDataRefreshError(
            f"could not prefetch complete game histories for: {players}"
        ) from failures[0][1]
    log(f"    prefetched {len(todo)} in {time.time()-start:.0f}s")


def find_chain(start, target, max_depth=4, log=print, frontier_cap=2000,
               deadline=None):
    """BFS shortest beaten-chain from start to target.

    Returns (path_list, hops) where hops is a list of
    {"from", "to", "url"} dicts. Both are None if not found.

    frontier_cap: if the BFS frontier exceeds this many nodes at one depth,
        the search raises SearchIncompleteError rather than fanning out
        explosively. Prevents a capped search from being reported as a
        trustworthy "not found."
    deadline: optional epoch seconds; if exceeded, raises SearchIncompleteError.
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
            raise SearchIncompleteError("search deadline exceeded")
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
                raise SearchIncompleteError(
                    "search deadline exceeded while expanding frontier"
                )
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
            raise SearchIncompleteError(
                f"frontier cap ({frontier_cap}) hit at depth {depth + 1}"
            )
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
