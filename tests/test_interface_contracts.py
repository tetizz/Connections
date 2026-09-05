import re
import unittest
from html.parser import HTMLParser
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
HTML = (ROOT / "site" / "index.html").read_text(encoding="utf-8")
APP = (ROOT / "site" / "app.js").read_text(encoding="utf-8")
LEADERBOARD = (ROOT / "site" / "leaderboard.js").read_text(encoding="utf-8")
CSS = (ROOT / "site" / "styles.css").read_text(encoding="utf-8")


class IdCollector(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = []
        self.tabs = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if "id" in attributes:
            self.ids.append(attributes["id"])
        if attributes.get("role") == "tab":
            self.tabs.append(attributes)


class InterfaceContractTests(unittest.TestCase):
    def test_document_ids_are_unique(self):
        parser = IdCollector()
        parser.feed(HTML)
        duplicates = sorted({item for item in parser.ids if parser.ids.count(item) > 1})
        self.assertEqual(duplicates, [])

    def test_primary_status_and_graph_have_text_alternatives(self):
        self.assertIn('id="search-status" role="status" aria-live="polite"', HTML)
        self.assertIn('id="graph-summary" aria-live="polite"', HTML)
        self.assertIn('id="graph" viewBox="0 0 1040 420" preserveAspectRatio="xMidYMid meet" role="group"', HTML)
        self.assertIn('aria-describedby="graph-summary"', HTML)
        self.assertIn("function updateGraphSummary(chain)", APP)

    def test_autocomplete_exposes_active_option(self):
        self.assertEqual(HTML.count('role="combobox"'), 2)
        self.assertIn('aria-autocomplete="list"', HTML)
        self.assertIn('input.setAttribute("aria-activedescendant"', APP)
        self.assertIn('input?.removeAttribute("aria-activedescendant")', APP)

    def test_leaderboard_uses_keyboard_operable_tabs(self):
        parser = IdCollector()
        parser.feed(HTML)
        self.assertEqual(len(parser.tabs), 5)
        for tab in parser.tabs:
            self.assertTrue(tab.get("id"))
            self.assertEqual(tab.get("aria-controls"), "leaderboard-list")
            self.assertIn(tab.get("aria-selected"), {"true", "false"})
        for key in ("ArrowRight", "ArrowLeft", "Home", "End"):
            self.assertIn(key, LEADERBOARD)

    def test_dialogs_trap_focus_and_restore_settings_trigger(self):
        self.assertIn("function trapDialogFocus", APP)
        self.assertIn('restoreDialogFocus(modal, $("#settings-open"))', APP)
        self.assertIn("data-profile-close", APP)
        self.assertIn('typeof anchor.focus === "function"', APP)
        self.assertRegex(CSS, re.compile(r"\.profile-popover\s*\{[^}]*z-index:\s*360", re.S))
        self.assertRegex(CSS, re.compile(r"\.modal-overlay\s*\{[^}]*z-index:\s*340", re.S))

    def test_search_is_not_blocked_by_a_first_run_gate(self):
        self.assertNotIn('id="intro-gate"', HTML)
        self.assertNotIn("openIntroGate", APP)

    def test_below_fold_people_and_rankings_load_lazily(self):
        self.assertIn("function loadLeaderboardTargetsWhenVisible", APP)
        self.assertIn('{ rootMargin: "80px 0px" }', APP)
        self.assertIn("function loadGraphImagesWhenVisible", APP)
        self.assertIn('"data-avatar-src": av', APP)
        self.assertIn('img.loading = "lazy"', APP)
        self.assertIn('loading="lazy" decoding="async"', LEADERBOARD)
        self.assertIn("requestIdleCallback", APP)
        self.assertIn("window.Leaderboard.init()", APP)
        self.assertIn("function init()", LEADERBOARD)
        self.assertIn("initialLoadObserver", LEADERBOARD)

    def test_light_theme_and_narrow_layout_do_not_inherit_dark_fallbacks(self):
        self.assertIn('html[data-theme="light"] body', HTML)
        body_rule = re.search(r"body\s*\{(?P<body>.*?)\n\}", CSS, re.S)
        self.assertIsNotNone(body_rule)
        self.assertIn("color: var(--ink)", body_rule.group("body"))
        self.assertNotIn("min-width: 320px", body_rule.group("body"))

    def test_compact_graph_keeps_player_labels_readable(self):
        self.assertIn('COMPACT_GRAPH_MEDIA = window.matchMedia("(max-width: 620px)")', APP)
        self.assertIn('COMPACT_GRAPH_MEDIA.addEventListener?.("change"', APP)
        self.assertIn('nodes.map((_, i) => ({ x: viewWidth / 2, y: 64 + i * 132 }))', APP)
        self.assertIn("--chain-graph-height", APP)
        self.assertIn("height: var(--chain-graph-height, 330px)", CSS)

    def test_original_design_keeps_local_fonts_and_quiet_motion(self):
        self.assertNotIn("fonts.googleapis.com", HTML)
        self.assertNotIn("fonts.gstatic.com", HTML)
        self.assertNotIn("trust-strip", HTML)
        self.assertNotIn("command-center__kicker", HTML)
        self.assertIn('<span class="brand__mark" aria-hidden="true">♞</span>', HTML)
        self.assertRegex(CSS, re.compile(r"body,\s*html\[data-theme=\"dark\"\] body\s*\{[^}]*animation:\s*none", re.S))
        self.assertRegex(CSS, re.compile(r"\.top-links \.home-site-button,[^{]+\{\s*animation:\s*none", re.S))
        self.assertIn("@media (prefers-reduced-motion: reduce)", CSS)


if __name__ == "__main__":
    unittest.main()
