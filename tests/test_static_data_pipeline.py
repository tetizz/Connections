import json
import os
import sys
import tempfile
import unittest
import urllib.error
from unittest import mock


ROOT = os.path.normpath(os.path.join(os.path.dirname(__file__), ".."))
SCRIPTS = os.path.join(ROOT, "scripts")
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)

import chess_beaten_chain as chain  # noqa: E402
import compute_chains as compute  # noqa: E402


def sample_game(white="alice", black="bob"):
    return {
        "white": {"username": white, "result": "win"},
        "black": {"username": black, "result": "resigned"},
        "rules": "chess",
        "url": "https://www.chess.com/game/live/1",
        "time_class": "rapid",
    }


class GameCacheTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cache_patch = mock.patch.object(chain, "CACHE_DIR", self.tmp.name)
        self.cache_patch.start()
        self.addCleanup(self.cache_patch.stop)
        chain._MEM_GAMES.clear()
        chain._MEM_EDGES.clear()

    def write_cache(self, username, payload):
        path = chain.cache_path(username)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f)
        return path

    def test_successful_refresh_writes_explicit_freshness_envelope(self):
        def fake_fetch(url):
            if url.endswith("/games/archives"):
                return {"archives": ["https://archive/2026/07"]}
            return {"games": [sample_game()]}

        with (
            mock.patch.object(chain, "fetch", side_effect=fake_fetch),
            mock.patch.object(chain.time, "time", return_value=1_000_000),
        ):
            games = chain.get_std_games("Alice")

        self.assertEqual(games[0]["white"], "alice")
        with open(chain.cache_path("alice"), encoding="utf-8") as f:
            saved = json.load(f)
        self.assertEqual(saved["version"], chain.CACHE_SCHEMA_VERSION)
        self.assertEqual(saved["fetched_at"], 1_000_000)
        self.assertEqual(saved["games"], games)

    def test_fresh_legacy_cache_is_read_and_migrated_without_network(self):
        path = self.write_cache("alice", [{"white": "alice"}])
        os.utime(path, (1_000_000, 1_000_000))

        with (
            mock.patch.object(chain, "fetch") as fetch_mock,
            mock.patch.object(chain.time, "time", return_value=1_000_001),
        ):
            games = chain.get_std_games("alice")

        self.assertEqual(games, [{"white": "alice"}])
        fetch_mock.assert_not_called()
        with open(path, encoding="utf-8") as f:
            migrated = json.load(f)
        self.assertEqual(migrated["version"], chain.CACHE_SCHEMA_VERSION)
        self.assertEqual(migrated["fetched_at"], 1_000_000)

    def test_archive_list_failure_keeps_expired_good_cache_and_raises(self):
        original = {
            "version": chain.CACHE_SCHEMA_VERSION,
            "fetched_at": 1,
            "games": [{"white": "known-good"}],
        }
        path = self.write_cache("alice", original)

        with (
            mock.patch.object(chain, "CACHE_MAX_AGE_SECONDS", 10),
            mock.patch.object(chain.time, "time", return_value=100),
            mock.patch.object(chain, "fetch", side_effect=OSError("temporary")),
        ):
            with self.assertRaises(chain.GameDataRefreshError):
                chain.get_std_games("alice")

        with open(path, encoding="utf-8") as f:
            self.assertEqual(json.load(f), original)

    def test_archive_list_failure_without_prior_cache_does_not_create_empty_cache(self):
        path = chain.cache_path("alice")
        with mock.patch.object(chain, "fetch", side_effect=OSError("temporary")):
            with self.assertRaises(chain.GameDataRefreshError):
                chain.get_std_games("alice")
        self.assertFalse(os.path.exists(path))

    def test_missing_account_is_an_authoritative_cacheable_empty_result(self):
        missing = urllib.error.HTTPError(
            "https://api.chess.com/pub/player/missing/games/archives",
            404,
            "not found",
            {},
            None,
        )
        self.addCleanup(missing.close)
        with (
            mock.patch.object(chain, "fetch", side_effect=missing),
            mock.patch.object(chain.time, "time", return_value=1_000_000),
        ):
            self.assertEqual(chain.get_std_games("missing"), [])

        with open(chain.cache_path("missing"), encoding="utf-8") as f:
            saved = json.load(f)
        self.assertEqual(saved["games"], [])
        self.assertEqual(saved["fetched_at"], 1_000_000)

    def test_partial_monthly_failure_keeps_good_cache_and_fails_refresh(self):
        original = {
            "version": chain.CACHE_SCHEMA_VERSION,
            "fetched_at": 1,
            "games": [{"white": "known-good"}],
        }
        path = self.write_cache("alice", original)

        def fake_fetch(url):
            if url.endswith("/games/archives"):
                return {"archives": ["https://archive/one", "https://archive/two"]}
            if url.endswith("/one"):
                return {"games": [sample_game()]}
            raise OSError("month unavailable")

        with (
            mock.patch.object(chain, "CACHE_MAX_AGE_SECONDS", 10),
            mock.patch.object(chain.time, "time", return_value=100),
            mock.patch.object(chain, "fetch", side_effect=fake_fetch),
        ):
            with self.assertRaisesRegex(
                chain.GameDataRefreshError, "failed archive https://archive/two"
            ):
                chain.get_std_games("alice")

        with open(path, encoding="utf-8") as f:
            self.assertEqual(json.load(f), original)

    def test_prefetch_propagates_refresh_failures(self):
        with mock.patch.object(
            chain, "get_std_games",
            side_effect=chain.GameDataRefreshError("incomplete"),
        ):
            with self.assertRaises(chain.GameDataRefreshError):
                chain.prefetch(["alice"], log=lambda _message: None, workers=1)

    def test_deadline_abort_is_not_reported_as_not_found(self):
        with (
            mock.patch.object(chain, "edges", return_value=({}, {})),
            mock.patch.object(chain.time, "time", return_value=100),
        ):
            with self.assertRaisesRegex(
                chain.SearchIncompleteError, "deadline exceeded"
            ):
                chain.find_chain(
                    "alice", "bob", deadline=50, log=lambda _message: None
                )


class ComputeRefreshTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root_patch = mock.patch.object(compute, "ROOT", self.tmp.name)
        self.root_patch.start()
        self.addCleanup(self.root_patch.stop)
        os.makedirs(os.path.join(self.tmp.name, "data"))

    def data_path(self, name):
        return os.path.join(self.tmp.name, "data", name)

    def write_data(self, name, payload):
        with open(self.data_path(name), "w", encoding="utf-8") as f:
            json.dump(payload, f)

    @staticmethod
    def metadata(username, previous=None):
        return {
            "username": username,
            "avatar": f"https://images/{username}.png",
            "title": None,
            "name": f"Fresh {username}",
            "url": f"https://www.chess.com/member/{username}",
            "country": "US",
        }

    def test_every_current_target_is_recomputed_even_when_already_present(self):
        self.write_data(
            "chains.json",
            {
                "start": "start",
                "max_depth": 4,
                "chains": [
                    {"target": "one", "found": False},
                    {"target": "two", "found": False},
                ],
            },
        )
        self.write_data("players.json", {})
        config = {
            "start": "start",
            "max_depth": 4,
            "targets": [
                {"username": "one", "display": "One"},
                {"username": "two", "display": "Two"},
            ],
        }
        calls = []

        def fake_find(start, target, depth, deadline=None):
            calls.append((start, target, depth))
            return [start, target], [
                {"from": start, "to": target, "url": "https://game"}
            ]

        with (
            mock.patch.object(compute, "load_config", return_value=config),
            mock.patch.object(compute, "player_meta", side_effect=self.metadata),
            mock.patch.object(compute, "find_chain", side_effect=fake_find),
        ):
            compute.main()

        self.assertEqual(calls, [("start", "one", 4), ("start", "two", 4)])

    def test_changed_config_drops_removed_chains_and_unrelated_players(self):
        self.write_data(
            "chains.json",
            {
                "start": "old-start",
                "max_depth": 2,
                "chains": [
                    {"target": "keep", "display": "Old"},
                    {"target": "removed", "display": "Removed"},
                ],
            },
        )
        self.write_data(
            "players.json",
            {
                "new-start": {"username": "new-start", "name": "Stale"},
                "keep": {"username": "keep", "name": "Stale"},
                "removed": {"username": "removed", "name": "Removed"},
            },
        )
        config = {
            "start": "NEW-START",
            "max_depth": 5,
            "targets": [{"username": "KEEP", "display": "Kept"}],
        }

        with (
            mock.patch.object(compute, "load_config", return_value=config),
            mock.patch.object(compute, "player_meta", side_effect=self.metadata),
            mock.patch.object(
                compute, "find_chain",
                return_value=(
                    ["new-start", "keep"],
                    [{
                        "from": "new-start",
                        "to": "keep",
                        "url": "https://game",
                    }],
                ),
            ) as find_mock,
        ):
            compute.main()

        with open(self.data_path("chains.json"), encoding="utf-8") as f:
            result = json.load(f)
        with open(self.data_path("players.json"), encoding="utf-8") as f:
            players = json.load(f)
        self.assertEqual(result["start"], "new-start")
        self.assertEqual(result["max_depth"], 5)
        self.assertEqual([item["target"] for item in result["chains"]], ["keep"])
        self.assertEqual(set(players), {"new-start", "keep"})
        self.assertEqual(players["keep"]["name"], "Fresh keep")
        find_mock.assert_called_once()

    def test_failed_search_does_not_replace_previous_site_data(self):
        old_chains = {"start": "old", "max_depth": 2, "chains": []}
        old_players = {"old": {"username": "old"}}
        self.write_data("chains.json", old_chains)
        self.write_data("players.json", old_players)
        config = {
            "start": "start",
            "max_depth": 4,
            "targets": [{"username": "target", "display": "Target"}],
        }

        with (
            mock.patch.object(compute, "load_config", return_value=config),
            mock.patch.object(compute, "player_meta", side_effect=self.metadata),
            mock.patch.object(
                compute, "find_chain",
                side_effect=chain.GameDataRefreshError("partial archive"),
            ),
        ):
            with self.assertRaises(chain.GameDataRefreshError):
                compute.main()

        with open(self.data_path("chains.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f), old_chains)
        with open(self.data_path("players.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f), old_players)

    def test_second_output_failure_rolls_back_first_output(self):
        old_chains = {"start": "old", "max_depth": 2, "chains": []}
        old_players = {"old": {"username": "old"}}
        self.write_data("chains.json", old_chains)
        self.write_data("players.json", old_players)
        config = {
            "start": "start",
            "max_depth": 4,
            "targets": [{"username": "target", "display": "Target"}],
        }
        real_replace = os.replace
        failed_players_replace = False

        def fail_players_once(source, destination):
            nonlocal failed_players_replace
            if (
                destination == self.data_path("players.json")
                and not failed_players_replace
            ):
                failed_players_replace = True
                raise OSError("simulated players publication failure")
            return real_replace(source, destination)

        with (
            mock.patch.object(compute, "load_config", return_value=config),
            mock.patch.object(compute, "player_meta", side_effect=self.metadata),
            mock.patch.object(
                compute, "find_chain",
                return_value=(
                    ["start", "target"],
                    [{
                        "from": "start",
                        "to": "target",
                        "url": "https://game",
                    }],
                ),
            ),
            mock.patch.object(compute.os, "replace", side_effect=fail_players_once),
        ):
            with self.assertRaisesRegex(
                OSError, "simulated players publication failure"
            ):
                compute.main()

        with open(self.data_path("chains.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f), old_chains)
        with open(self.data_path("players.json"), encoding="utf-8") as f:
            self.assertEqual(json.load(f), old_players)

    def test_profile_refresh_failure_reuses_previous_metadata(self):
        previous = {"username": "alice", "name": "Known Alice", "avatar": "old"}
        with mock.patch.object(compute, "fetch", side_effect=OSError("temporary")):
            self.assertEqual(compute.player_meta("alice", previous), previous)


if __name__ == "__main__":
    unittest.main()
