import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

// Isolated browser regressions. Every request is fulfilled locally; no server,
// user browser profile, real search job, analytics write, or real game is used.
// All displayed people and proof links below are explicitly synthetic fixtures.
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(repo, 'site');
const output = path.resolve(option('--output-dir') || path.join(repo, 'evidence', 'responsive-interaction-audit'));
const modulePath = option('--playwright-module') || process.env.CONNECTIONS_QA_PLAYWRIGHT_MODULE;
const {chromium} = await import(modulePath ? pathToFileURL(path.resolve(modulePath)).href : 'playwright');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const coreNames = ['index.html', 'styles.css', 'app.js', 'config.js', 'cache.js', 'engine.js', 'leaderboard.js', 'saved-routes.js'];
const snapshot = new Map(await Promise.all(coreNames.map(async name => [name, await fs.readFile(path.join(site, name))])));
const sourceHashes = Object.fromEntries([...snapshot].map(([name, bytes]) => [name, hash(bytes)]));
await fs.mkdir(output, {recursive: true});

const origin = 'http://connections-fixture.test';
const players = {
  magnus_fixture: {username: 'magnus_fixture', name: 'QA Fixture Magnus', title: 'GM'},
  mag_fixture_two: {username: 'mag_fixture_two', name: 'QA Fixture Second'},
  fixture_top: {username: 'fixture_top', name: 'QA Fixture Top', title: 'GM'},
};
const share = {
  target: 'fixture_target', display: 'QA Fixture Target', length: 2,
  path: ['fixture_start', 'fixture_middle', 'fixture_target'],
  hops: [
    {from: 'fixture_start', to: 'fixture_middle', url: 'https://www.chess.com/game/live/1', time_class: 'blitz'},
    {from: 'fixture_middle', to: 'fixture_target', url: 'https://www.chess.com/game/live/2', time_class: 'rapid'},
  ],
  players: Object.fromEntries(['fixture_start', 'fixture_middle', 'fixture_target'].map(username => [username, {username, name: `QA Fixture ${username}`, title: ''}])),
};
const treeFixture = {
  tree: true, found: true, root: 'fixture_start', branchCount: 3, targetCount: 3, foundSlotCount: 3,
  chains: [
    {...share, found: true},
    {...share, found: true, target: 'fixture_second', path: ['fixture_start', 'fixture_middle', 'fixture_second']},
    {...share, found: true, target: 'fixture_third', path: ['fixture_start', 'fixture_other', 'fixture_third']},
  ],
};
const checks = [], errors = [], requestLog = [];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2S8AAAAASUVORK5CYII=', 'base64');
const browser = await chromium.launch({headless: true, executablePath: option('--chromium-executable'), timeout: 20000});

async function fixture(viewport = {width: 1440, height: 900}) {
  const context = await browser.newContext({viewport, reducedMotion: 'reduce', locale: 'en-US', serviceWorkers: 'block', acceptDownloads: true});
  const page = await context.newPage();
  const pendingSuggestions = [], pendingProfiles = [];
  const control = {deferSuggestions: false, deferProfiles: false, failLeaderboard: false};
  page.on('pageerror', error => errors.push({kind: 'pageerror', message: error.message}));
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    requestLog.push({host: url.hostname, path: url.pathname, method: route.request().method(), disposition: 'fixture-only'});
    const cors = {'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type'};
    const json = body => route.fulfill({status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(body)});
    try {
      if (route.request().method() === 'OPTIONS') return await route.fulfill({status: 204, headers: cors, body: ''});
      if (url.pathname === '/suggest') {
        if (control.deferSuggestions) await new Promise(resolve => pendingSuggestions.push(resolve));
        // Reorder the same identities to catch selection preserved by index only.
        return await json({suggestions: Object.values(players).filter(p => p.username.startsWith('mag')).reverse()});
      }
      if (url.pathname === '/profile') {
        if (control.deferProfiles) await new Promise(resolve => pendingProfiles.push(resolve));
        const username = url.searchParams.get('username') || 'fixture_top';
        return await json({username, name: `QA Fixture ${username}`, title: 'GM', url: `https://www.chess.com/member/${username}`, followers: 1, joined: 1500000000, recentGames: [], stats: {}, profileComplete: true});
      }
      if (url.pathname === '/leaderboard') {
        if (control.failLeaderboard) return await route.fulfill({status: 503, headers: cors, contentType: 'application/json', body: '{"error":"Synthetic fixture unavailable"}'});
        return await json({entries: [], category: url.searchParams.get('category') || 'connectors'});
      }
      if (url.pathname === '/pub/leaderboards') {
        const row = {username: 'fixture_top', player_id: 1, score: 2700, rank: 1, url: 'https://www.chess.com/member/fixture_top'};
        return await json({live_rapid: [row], live_blitz: [row], live_bullet: [row]});
      }
      if (url.pathname === '/share') return await json({share});
      if (url.pathname === '/search/start') return await route.fulfill({status: 503, headers: cors, contentType: 'application/json', body: '{"error":"Synthetic fixture unavailable"}'});
      if (url.pathname.startsWith('/analytics/') || ['/search/warm', '/submit'].includes(url.pathname)) return await json({ok: true});
      if (url.origin === origin) {
        const name = decodeURIComponent(url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
        if (name === 'data/players.json') return await json(players);
        const absolute = path.resolve(site, name);
        if (!absolute.startsWith(site + path.sep)) return await route.fulfill({status: 403, body: ''});
        let body = snapshot.get(name);
        if (!body) { try { body = await fs.readFile(absolute); } catch { return await route.fulfill({status: 404, body: ''}); } }
        const types = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2'};
        return await route.fulfill({status: 200, contentType: types[path.extname(name)] || 'application/octet-stream', body});
      }
      // External avatars/flags are synthetic pixels, never real outbound calls.
      if (/\.(png|jpg|jpeg|webp|gif|svg)$/i.test(url.pathname)) return await route.fulfill({status: 200, contentType: 'image/png', body: png});
      return await route.fulfill({status: 404, body: ''});
    } catch (error) {
      if (!/closed|aborted|already handled|Invalid InterceptionId/i.test(error.message)) errors.push({kind: 'fixture-route', message: error.message});
    }
  });
  async function open(query = '') {
    await page.goto(origin + '/' + query, {waitUntil: 'load'});
    const discovery = page.locator('#target-discovery');
    if (await discovery.count() && await discovery.getAttribute('open') === null) {
      await discovery.locator('summary').click();
    }
    // Targets intentionally load only when their section becomes visible.
    await page.locator('.quick-targets').scrollIntoViewIfNeeded();
    await page.waitForSelector('.quick-player', {timeout: 7000});
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
  }
  async function waitPending(list) {
    const until = Date.now() + 5000;
    while (!list.length && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 20));
    if (!list.length) throw new Error('Expected synthetic deferred request was not issued');
  }
  const release = list => { while (list.length) list.shift()(); };
  return {context, page, control, pendingSuggestions, pendingProfiles, open, waitPending, release};
}

async function run(name, operation) {
  const before = checks.length;
  try { await operation(); } catch (error) { checks.push({name, pass: false, error: error.message}); }
  console.log(`${name}: ${checks.length - before} checks recorded`);
}
function record(name, pass, detail) { checks.push({name, pass: Boolean(pass), detail}); }
async function shot(page, name, fullPage = true) { const filename = path.join(output, name + '.png'); await page.screenshot({path: filename, fullPage}); return filename; }
async function graphDirections(page) {
  return page.locator('#graph').evaluate(svg => {
    const edges = [...svg.querySelectorAll('.edge-line')];
    return {edges: edges.length, marked: edges.filter(edge => {
      const id = edge.getAttribute('marker-end')?.match(/^url\(#(.+)\)$/)?.[1];
      return id && svg.querySelector(`marker[id="${id}"] path`);
    }).length, labels: [...svg.querySelectorAll('.node__label')].map(label => ({text: label.textContent, renderedHeight: label.getBoundingClientRect().height}))};
  });
}

try {
  for (const viewport of [{width: 320, height: 568}, {width: 390, height: 664}, {width: 768, height: 400}, {width: 1440, height: 900}]) {
    await run(`layout-${viewport.width}x${viewport.height}`, async () => {
      const f = await fixture(viewport);
      try {
        await f.open('?c=synthetic-fixture');
        const layout = await f.page.evaluate(() => ({width: innerWidth, scrollWidth: document.documentElement.scrollWidth, graphNodes: document.querySelectorAll('#graph .node').length, targetActions: [...document.querySelectorAll('.quick-targets__actions > *')].map(e => {const r = e.getBoundingClientRect(); return {text: e.textContent.trim(), x: r.x, right: r.right, width: r.width};})}));
        record(`page-width-${viewport.width}`, layout.scrollWidth <= viewport.width + 1, layout);
        const directions = await graphDirections(f.page);
        record(`normal-graph-directions-${viewport.width}`, directions.edges === 2 && directions.marked === directions.edges, directions);
        await shot(f.page, `route-${viewport.width}x${viewport.height}`);
        await f.page.click('#settings-open');
        await f.page.waitForFunction(() => document.activeElement === document.querySelector('#setting-username'));
        const modal = await f.page.evaluate(() => {
          const box = document.querySelector('#settings-modal .modal'), body = document.querySelector('.modal__body'), close = document.querySelector('#settings-close');
          const rect = e => {const r = e.getBoundingClientRect(); return {top: r.top, bottom: r.bottom, height: r.height};};
          return {viewportHeight: innerHeight, box: rect(box), close: rect(close), body: rect(body), bodyScrollHeight: body.scrollHeight, bodyClientHeight: body.clientHeight, bodyOverflowY: getComputedStyle(body).overflowY, overlayOverflowY: getComputedStyle(document.querySelector('#settings-modal')).overflowY, pageOverflow: getComputedStyle(document.body).overflowY};
        });
        const closeReachable = modal.close.top >= 0 && modal.close.bottom <= viewport.height;
        const bodyFitsOrScrolls = modal.box.top >= 0 && modal.box.bottom <= viewport.height + 1 && modal.body.top >= 0 && modal.body.bottom <= viewport.height + 1 && (modal.bodyScrollHeight <= modal.bodyClientHeight + 1 || ['auto', 'scroll'].includes(modal.bodyOverflowY));
        record(`settings-reachable-${viewport.width}x${viewport.height}`, closeReachable && bodyFitsOrScrolls, modal);
        await f.page.locator('#settings-close').focus();
        await f.page.keyboard.press('Shift+Tab');
        const finalControl = await f.page.locator('#owner-load').evaluate(e => {const r = e.getBoundingClientRect(), body = e.closest('.modal__body').getBoundingClientRect(); return {focused: e === document.activeElement, activeId: document.activeElement.id, top: r.top, bottom: r.bottom, bodyTop: body.top, bodyBottom: body.bottom};});
        await f.page.keyboard.press('Tab');
        const wrappedToFirst = await f.page.locator('#settings-close').evaluate(e => e === document.activeElement);
        record(`settings-keyboard-trap-${viewport.width}`, finalControl.focused && finalControl.top >= finalControl.bodyTop - 1 && finalControl.bottom <= finalControl.bodyBottom + 1 && wrappedToFirst, {finalControl, wrappedToFirst});
        await shot(f.page, `settings-${viewport.width}x${viewport.height}`, false);
        await f.page.keyboard.press('Escape');
        record(`settings-focus-return-${viewport.width}`, await f.page.locator('#settings-modal').isHidden() && await f.page.locator('#settings-open').evaluate(e => e === document.activeElement), {});
      } finally { await f.context.close(); }
    });
  }

  for (const viewport of [{width: 390, height: 664}, {width: 1440, height: 900}]) {
    await run(`tree-graph-${viewport.width}`, async () => {
      const f = await fixture(viewport);
      try {
        await f.open('?c=synthetic-fixture');
        // Renderer-only smoke via the frontend's existing debug hook. This does
        // not certify top-player search, proof cards, or a real verified tree.
        await f.page.evaluate(tree => window.__connectionsDebugRenderGraph(tree), treeFixture);
        const directions = await graphDirections(f.page);
        const nodes = await f.page.locator('#graph .tree-node').count();
        record(`tree-graph-directions-${viewport.width}`, nodes === 6 && directions.edges === 5 && directions.marked === directions.edges, {nodes, ...directions});
        const scroll = await f.page.locator('.graph-wrap').evaluate(wrap => {
          const before = wrap.scrollLeft; wrap.scrollLeft = 120;
          const after = wrap.scrollLeft; wrap.scrollLeft = before;
          return {overflowX: getComputedStyle(wrap).overflowX, clientWidth: wrap.clientWidth, scrollWidth: wrap.scrollWidth, scrolled: after > 0};
        });
        const readable = directions.labels.length === nodes && directions.labels.every(label => label.renderedHeight >= 12);
        const scrollable = viewport.width > 620 || (['auto', 'scroll'].includes(scroll.overflowX) && scroll.scrollWidth > scroll.clientWidth && scroll.scrolled);
        record(`tree-readable-viewport-${viewport.width}`, readable && scrollable, {labels: directions.labels, scroll});
        await f.page.locator('.graph-wrap').screenshot({path: path.join(output, `tree-${viewport.width}x${viewport.height}.png`)});
      } finally { await f.context.close(); }
    });
  }

  for (const viewport of [{width: 390, height: 664}, {width: 1440, height: 900}]) {
    await run(`dark-only-${viewport.width}`, async () => {
      const f = await fixture(viewport);
      try {
        await f.context.addInitScript(() => localStorage.setItem('chess-connections:theme', 'light'));
        await f.open('?c=synthetic-fixture');
        const initialTheme = await f.page.locator('html').getAttribute('data-theme');
        const themeControls = await f.page.locator('#theme-toggle').count();
        const eyebrow = await f.page.getByText('Real games. Unexpected connections.', {exact: true}).count();
        const headline = (await f.page.locator('h1').innerText()).replace(/\s+/g, ' ').trim();
        const subtitle = await f.page.getByText('Every link is a real Chess.com live win: rapid, blitz, or bullet.', {exact: true}).isVisible();
        const decoration = await f.page.locator('.intro-map, .intro-formats').count();
        await shot(f.page, `route-dark-only-${viewport.width}x${viewport.height}`);
        await f.page.reload({waitUntil: 'load'});
        await f.page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
        const darkScheme = await f.page.locator('html').evaluate(element => getComputedStyle(element).colorScheme);
        record(`dark-only-ignores-light-preference-${viewport.width}`, initialTheme === 'dark' && themeControls === 0 && eyebrow === 0 && darkScheme === 'dark' && headline === 'Find the win chain between any two players' && subtitle && decoration === 0, {initialTheme, darkScheme, themeControls, eyebrow, headline, subtitle, decoration});
      } finally { await f.context.close(); }
    });
  }

  await run('autocomplete-dismissal', async () => {
    const f = await fixture();
    try {
      await f.open(); f.control.deferSuggestions = true;
      await f.page.fill('#search-start', 'mag'); await f.waitPending(f.pendingSuggestions);
      const aborted = f.page.waitForEvent('requestfailed', {predicate: request => new URL(request.url()).pathname === '/suggest', timeout: 4000});
      await f.page.keyboard.press('Escape'); await aborted;
      const suggestionState = () => f.page.evaluate(() => ({expanded: document.querySelector('#search-start').getAttribute('aria-expanded'), active: document.querySelector('#search-start').getAttribute('aria-activedescendant'), hidden: document.querySelector('#username-suggest').hidden}));
      // The requestfailed event precedes fetch rejection callbacks in some builds.
      const settle = () => f.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await settle(); const afterAbort = await suggestionState();
      f.release(f.pendingSuggestions); await settle();
      const afterSettled = await suggestionState();
      const closed = state => state.expanded === 'false' && !state.active && state.hidden;
      record('Escape-keeps-suggestions-closed-after-request', closed(afterAbort) && closed(afterSettled), {afterAbort, afterSettled});
      await shot(f.page, 'autocomplete-after-Escape');
    } finally { f.release(f.pendingSuggestions); await f.context.close(); }
  });

  await run('native-PNG-download', async () => {
    const f = await fixture({width: 390, height: 664});
    try {
      await f.open('?c=synthetic-fixture');
      const [download] = await Promise.all([
        f.page.waitForEvent('download', {timeout: 10000}),
        f.page.click('#save-share-image'),
      ]);
      const failure = await download.failure();
      const filename = path.join(output, 'synthetic-export-390.png');
      await download.saveAs(filename);
      const bytes = await fs.readFile(filename);
      const isPng = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const width = isPng ? bytes.readUInt32BE(16) : 0, height = isPng ? bytes.readUInt32BE(20) : 0;
      await f.page.waitForFunction(() => !document.querySelector('#save-share-image').disabled);
      record('save-image-produces-native-PNG-download', !failure && isPng && width > 0 && height > 0 && /fixture_start-fixture_target\.png$/.test(download.suggestedFilename()), {failure, suggestedFilename: download.suggestedFilename(), bytes: bytes.length, width, height});
    } finally { await f.context.close(); }
  });

  await run('autocomplete-selection-refresh', async () => {
    const f = await fixture();
    try {
      await f.open(); f.control.deferSuggestions = true;
      await f.page.fill('#search-start', 'mag'); await f.waitPending(f.pendingSuggestions);
      await f.page.keyboard.press('ArrowDown');
      const selection = () => f.page.evaluate(() => {const id = document.querySelector('#search-start').getAttribute('aria-activedescendant'); return {id, username: id ? document.getElementById(id)?.dataset.username : null};});
      const before = await selection();
      const response = f.page.waitForResponse(response => new URL(response.url()).pathname === '/suggest');
      f.release(f.pendingSuggestions); await response;
      await f.page.waitForFunction(() => !document.querySelector('#username-suggest .username-suggest__status'));
      const after = await selection();
      record('suggestion-refresh-preserves-keyboard-choice', Boolean(before.username) && before.username === after.username, {before, after});
      await shot(f.page, 'autocomplete-after-refresh');
    } finally { f.release(f.pendingSuggestions); await f.context.close(); }
  });

  await run('profile-focus-refresh', async () => {
    const f = await fixture();
    try {
      await f.open(); f.control.deferProfiles = true;
      await f.page.locator('.quick-targets [data-profile-trigger][data-profile-user]').first().click();
      await f.waitPending(f.pendingProfiles);
      await f.page.keyboard.press('Shift+Tab');
      const focused = () => f.page.evaluate(() => ({tag: document.activeElement.tagName, id: document.activeElement.id, text: document.activeElement.textContent.trim().slice(0, 80), inPopover: Boolean(document.activeElement.closest('#profile-popover'))}));
      const before = await focused();
      const outsideTarget = await f.page.evaluateHandle(() => document.activeElement);
      const response = f.page.waitForResponse(response => new URL(response.url()).pathname === '/profile');
      f.release(f.pendingProfiles); await response;
      await f.page.waitForFunction(() => document.querySelector('#profile-popover').hidden || document.querySelector('#profile-popover .profile-popover__top'), null, {timeout: 4000});
      const after = await focused();
      const retained = await f.page.evaluate(element => element === document.activeElement, outsideTarget);
      record('late-profile-does-not-steal-outside-focus', before.tag !== 'BODY' && !before.inPopover && retained, {before, after});
      await outsideTarget.dispose();
      await shot(f.page, 'profile-after-enrichment');
    } finally { f.release(f.pendingProfiles); await f.context.close(); }
  });

  await run('invalid-search-and-leaderboard-error', async () => {
    const f = await fixture();
    try {
      await f.open(); await f.page.click('#trace-chain');
      const invalid = await f.page.locator('#search-status').textContent();
      record('empty-search-has-readable-error-and-focus', /username/i.test(invalid) && await f.page.locator('#search-start').evaluate(e => e === document.activeElement), {message: invalid});
      await f.page.fill('#search-start', 'fixture_top'); await f.page.fill('#search-target', 'fixture_top'); await f.page.keyboard.press('Escape'); await f.page.click('#trace-chain');
      record('same-player-search-explains-correction', /same player|different/i.test(await f.page.locator('#search-status').textContent()), {});
      f.control.failLeaderboard = true;
      await f.page.locator('#leaderboard-tab-fastest').click();
      await f.page.waitForSelector('[data-leaderboard-retry]', {timeout: 4000});
      record('leaderboard-failure-offers-native-retry', await f.page.locator('[data-leaderboard-retry]').isVisible(), {});
      f.control.failLeaderboard = false;
      await f.page.locator('[data-leaderboard-retry]').click();
      await f.page.waitForFunction(() => document.querySelector('#leaderboard-list').getAttribute('aria-busy') === 'false');
      record('leaderboard-retry-recovers-to-explicit-empty-state', /^No /i.test((await f.page.locator('#leaderboard-list').textContent()).trim()), {});
    } finally { await f.context.close(); }
  });
} finally {
  await browser.close();
  const changedFiles = [];
  for (const name of coreNames) if (hash(await fs.readFile(path.join(site, name))) !== sourceHashes[name]) changedFiles.push(name);
  const report = {capturedAtUtc: new Date().toISOString(), repo, sourceHashes, sourceChangedDuringRun: changedFiles, syntheticFixturesOnly: true, realNetworkRequests: 0, sharedBrowserUsed: false, serverStarted: false, checks, errors, requests: requestLog, passed: checks.filter(c => c.pass).length, failed: checks.filter(c => !c.pass).length};
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({output, passed: report.passed, failed: report.failed, errors: errors.length, changedFiles}, null, 2));
  if (!args.includes('--report-only') && (report.failed || errors.length)) process.exitCode = 1;
}
