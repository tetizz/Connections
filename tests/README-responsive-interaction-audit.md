# Isolated responsive and interaction audit

`responsive_interaction_audit.mjs` exercises the actual frontend in a fresh headless Chromium context. It starts no HTTP server, uses no existing browser profile, and fulfills **every** page/API/image request locally. People, game links, profile data, suggestions and API errors are synthetic fixtures. Do not publish its route screenshots as real chess evidence.

Use an existing Playwright installation and Chromium. The script does not install either. With Playwright available on the Node module path:

```sh
node tests/responsive_interaction_audit.mjs --output-dir /absolute/path/to/new-qa-output
```

Alternatively supply existing runtime paths:

```sh
node tests/responsive_interaction_audit.mjs \
  --playwright-module /absolute/path/to/playwright/index.mjs \
  --chromium-executable /absolute/path/to/chromium \
  --output-dir /absolute/path/to/new-qa-output
```

`CONNECTIONS_QA_PLAYWRIGHT_MODULE` is an alternative to `--playwright-module`. Use a fresh output directory for each evidence run. Avoid a user's browser/profile directory. The audit owns and closes only its own headless browser.

The default exit code is nonzero if a check fails or an application/fixture error occurs. `--report-only` preserves failed measurements in `report.json` but returns zero, allowing an intentionally red baseline to complete. **A zero exit with that flag is not a passing audit.** Read `passed`, `failed`, each check and `errors`.

Coverage includes four viewport sizes (320×568, 390×664, 768×400, 1440×900), short-screen Settings reachability, keyboard wrap, final-control visibility and dismissal/focus return; dark-only rendering despite an old light preference at mobile and desktop widths, absence of the theme switch and removed eyebrow copy; deferred suggestion dismissal and selected-username preservation across reordered results; delayed profile focus; invalid searches; leaderboard error/retry/empty states; and a native PNG download from the synthetic route. Deferred checks await request completion and observable settled UI, with the aborted suggestion request observed through its failure event. Screenshots are supplementary; page-width checks do not alone prove that nested clipped content is readable or color contrast passes.

Normal graphs at all four widths and a synthetic three-branch tree at mobile/desktop widths must retain the original d1d5960 center-to-center Q/C curves and matching glow paths, with no SVG marker definitions, marker references (including computed CSS), or triangular paths/polygons. The helper is `graph_visual_audit.mjs`; keep it beside this script. Normal graph checks also preserve node order, proof URLs and the revised link hint. The tree smoke invokes the frontend's existing `__connectionsDebugRenderGraph` hook; it tests rendering only, not top-player search, proof cards or a real verified tree. Tree labels must render at least 12 CSS pixels high, and the mobile tree must allow horizontal scrolling. The four width checks additionally require the permanently expanded top-player area with its heading and explainer. The suite still records 34 checks; the other 28 cases are preserved.

This release audit retains reduced motion. It does not claim intermediate-animation or real tree-Replay coverage. The debug render hook does not set current-chain ownership, so a debug redraw must not be called a successful Replay. Root owns live Replay verification; a new animated three-target fixture was explicitly left out of this bounded release. The exported PNG is synthetic fixture evidence and must not be presented as a real game result.

The eight core source files are snapshotted in memory at run start. Their exact SHA-256 values and any on-disk changes detected during the run are recorded. When another owner is editing the shared integration worktree, the screenshots still describe the recorded snapshot, not necessarily the final files. Run the audit again after integration settles before claiming the final frontend passes. No installed/deployed/backend/live-browser behavior is certified by synthetic fixture tests.
