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
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, ".."))
sys.path.insert(0, HERE)

from chess_beaten_chain import (  # noqa: E402
    GameDataRefreshError,
    SearchIncompleteError,
    fetch,
    find_chain,
)

TARGET_SEARCH_SECONDS = max(
    1.0,
    float(os.environ.get("CONNECTIONS_TARGET_SEARCH_SECONDS", "300")),
)


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


def player_meta(username, previous=None):
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
        if isinstance(previous, dict):
            return dict(previous)
        return {"username": username, "avatar": None, "title": None,
                "name": None, "url": None, "country": None}


def _stage_json(path, payload):
    """Serialize JSON beside its destination and return the staged path."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(
        prefix=os.path.basename(path) + ".", suffix=".tmp",
        dir=os.path.dirname(path), text=True
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
            f.write("\n")
        return tmp_path
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _restore_file(path, content):
    if content is None:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        return
    fd, tmp_path = tempfile.mkstemp(
        prefix=os.path.basename(path) + ".", suffix=".rollback",
        dir=os.path.dirname(path)
    )
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(content)
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def write_json_batch_atomic(outputs):
    """Replace a related set of JSON files, rolling back on any failure."""
    originals = {}
    staged = []
    replaced = []
    try:
        for path, payload in outputs:
            try:
                with open(path, "rb") as f:
                    originals[path] = f.read()
            except FileNotFoundError:
                originals[path] = None
            staged.append((path, _stage_json(path, payload)))

        for path, tmp_path in staged:
            os.replace(tmp_path, path)
            replaced.append(path)
    except Exception as exc:
        rollback_errors = []
        for path in reversed(replaced):
            try:
                _restore_file(path, originals[path])
            except Exception as rollback_exc:  # noqa: BLE001
                rollback_errors.append(rollback_exc)
        if rollback_errors:
            raise RuntimeError(
                "JSON publication failed and rollback was incomplete"
            ) from exc
        raise
    finally:
        for _, tmp_path in staged:
            try:
                os.unlink(tmp_path)
            except FileNotFoundError:
                pass


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError, TypeError):
        return default


def main():
    cfg = load_config()
    start = (cfg["start"] or "").strip().lower()
    max_depth = cfg["max_depth"]
    targets = [
        {
            **target,
            "username": target["username"].strip().lower(),
        }
        for target in cfg["targets"]
    ]
    if not start:
        raise ValueError("config.yml must define a start username")
    if any(not target["username"] for target in targets):
        raise ValueError("every configured target must have a username")
    target_names = [target["username"] for target in targets]
    if len(target_names) != len(set(target_names)):
        raise ValueError("configured target usernames must be unique")

    print(f"Config: start={start}  max_depth={max_depth}  "
          f"targets={[t['username'] for t in targets]}")

    data_dir = os.path.join(ROOT, "data")
    os.makedirs(data_dir, exist_ok=True)
    chains_path = os.path.join(data_dir, "chains.json")
    players_path = os.path.join(data_dir, "players.json")

    # Previous metadata is only a fallback for a transient profile lookup.
    # Previous chains are accepted only for the exact current start/depth and
    # configured target; found paths are ordering hints, while pathless
    # negatives may be retained with their old timestamp after an incomplete
    # refresh. Removed targets can never leak into the new output.
    previous_output = load_json(chains_path, {})
    previous_players = load_json(players_path, {})
    previous_matches_search = (
        isinstance(previous_output, dict)
        and previous_output.get("start") == start
        and previous_output.get("max_depth") == max_depth
        and isinstance(previous_output.get("chains"), list)
    )
    previous_chains = {
        item.get("target"): item
        for item in previous_output.get("chains", [])
        if previous_matches_search
        and isinstance(item, dict)
        and isinstance(item.get("target"), str)
    }
    previous_computed_at = previous_output.get("computed_at")
    chains = []
    players = {}
    refreshed_players = set()
    fully_refreshed = True

    def ensure_player(u):
        u = u.lower()
        if u in refreshed_players:
            return
        players[u] = player_meta(u, previous_players.get(u))
        refreshed_players.add(u)
        print(f"    player meta: {u}: "
              f"{players[u].get('title','')} {players[u].get('name','')}")

    # Refresh every currently-relevant profile once per run.
    ensure_player(start)
    for t in targets:
        ensure_player(t["username"])

    for t in targets:
        target = t["username"]
        previous_chain = previous_chains.get(target)
        print("\n" + "#" * 64)
        print(f"# {start}  ->  {target}   ({t.get('display', target)})")
        print("#" * 64)
        t0 = time.time()
        # Keep one hard target from blocking the batch. With the current eight
        # configured targets, the default caps searches at 40 minutes total,
        # leaving five minutes inside the workflow timeout for setup and I/O.
        deadline = time.time() + TARGET_SEARCH_SECONDS
        search_options = {"deadline": deadline}
        if (
            isinstance(previous_chain, dict)
            and previous_chain.get("found") is True
            and isinstance(previous_chain.get("path"), list)
        ):
            search_options["preferred_path"] = previous_chain["path"]
        try:
            path, hops = find_chain(
                start,
                target,
                max_depth,
                **search_options,
            )
        except (GameDataRefreshError, SearchIncompleteError) as exc:
            # A known negative has no proof path that could be poisoned by a
            # partial refresh. Preserve its original timestamp instead of
            # turning an incomplete search into a newly-computed "not found."
            can_preserve_negative = (
                isinstance(previous_chain, dict)
                and previous_chain.get("found") is False
                and previous_chain.get("path") == []
                and previous_chain.get("hops") == []
            )
            if not can_preserve_negative:
                raise
            fully_refreshed = False
            preserved = dict(previous_chain)
            preserved["display"] = t.get("display", target)
            preserved["refresh_status"] = "preserved"
            preserved["computed_at"] = preserved.get(
                "computed_at", previous_computed_at
            )
            chains.append(preserved)
            print(
                "\nPRESERVED prior no-chain result; refresh was incomplete: "
                f"{exc}"
            )
            print(f"  (computed: {len(chains)}/{len(targets)} targets)")
            continue
        elapsed = time.time() - t0
        chain_computed_at = int(time.time())
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
                "refresh_status": "verified",
                "computed_at": chain_computed_at,
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
                "refresh_status": "verified",
                "computed_at": chain_computed_at,
            })
        print(f"  (computed: {len(chains)}/{len(targets)} targets)")

    out = {
        "start": start,
        "start_display": players.get(start, {}).get("name") or start,
        "max_depth": max_depth,
        "computed_at": int(time.time()),
        "fully_refreshed": fully_refreshed,
        "chains": chains,
    }
    # Publish only after every target completed. A transient or partial Chess.com
    # failure leaves the prior known-good site data untouched.
    write_json_batch_atomic([
        (chains_path, out),
        (players_path, players),
    ])

    print(f"\nDone. {len(chains)} chains written to {chains_path}")


if __name__ == "__main__":
    main()
