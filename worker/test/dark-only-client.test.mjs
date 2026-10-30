import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../site/app.js', import.meta.url), 'utf8');
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `Actual app section missing: ${start}`);
  return source.slice(first, last);
}
function constant(name) {
  const line = source.split(/\r?\n/).find(value => value.startsWith(`  const ${name} = `));
  assert.ok(line, `Actual app constant missing: ${name}`);
  return line;
}
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };

// Actual theme function and DOMContentLoaded callback. Metadata, share and saved
// work boundaries are inert spies; there is no network or real browser storage.
function fixture({ failStorage = null, togglePresent = true } = {}) {
  const storage = new Map([['chess-connections:theme', 'light']]);
  const elements = new Map(), calls = [];
  let ready;
  const element = id => {
    if (id === '#theme-toggle' && !togglePresent) return null;
    if (!elements.has(id)) elements.set(id, {
      value: '', hidden: false, disabled: false, title: '', attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; },
    });
    return elements.get(id);
  };
  const operation = name => { if (failStorage === name) throw Object.assign(new Error('Storage access denied'), { name: 'SecurityError' }); };
  const document = { documentElement: { dataset: { theme: 'dark' } }, addEventListener(event, fn) { assert.equal(event, 'DOMContentLoaded'); ready = fn; } };
  const context = vm.createContext({
    state: { activeSearchOwner: '', topTraceRunId: 0 }, document, window: {}, $: element,
    localStorage: {
      getItem(key) { operation('getItem'); return storage.get(key) ?? null; },
      setItem(key, value) { operation('setItem'); storage.set(key, String(value)); },
      removeItem(key) { operation('removeItem'); storage.delete(key); },
    },
    loadPlayerMetadata: async () => { calls.push('metadata'); },
    loadSharedChainFromUrl: async () => { calls.push('share'); return false; },
    loadLeaderboardTargetsWhenVisible: () => calls.push('targets'),
    resumeTopPlayersTrace: async () => { calls.push('top-resume'); return false; },
    resumeActiveSearchJob: () => calls.push('foreground-resume'),
  });
  vm.runInContext([
    ...['LS_THEME_KEY', 'LS_KEY', 'LEGACY_DEPTH_KEY', 'LS_RANGE_KEY', 'LS_RANGE_MIGRATION_KEY', 'DEFAULT_TARGET'].map(constant),
    section('  function applyTheme(', '  // ---------- settings modal ----------'),
    section('  document.addEventListener("DOMContentLoaded", () => {', '})();'),
  ].join('\n'), context, { filename: 'actual-dark-theme-startup.js' });
  return { context, document, calls, element, ready: () => ready() };
}

test('saved light preference cannot switch startup away from dark', async () => {
  const f = fixture(); f.ready(); await flush();
  assert.equal(f.document.documentElement.dataset.theme, 'dark');
  assert.ok(f.calls.includes('foreground-resume'));
});

test('applyTheme light remains dark and leaves an optional theme switch hidden and inert', () => {
  const f = fixture(); f.context.applyTheme('light');
  assert.equal(f.document.documentElement.dataset.theme, 'dark');
  const toggle = f.element('#theme-toggle');
  assert.equal(toggle.hidden, true); assert.equal(toggle.disabled, true);
  assert.doesNotMatch(`${toggle.title} ${toggle.attributes['aria-label'] || ''}`, /switch to light/i);
});

test('applyTheme works when the optional theme switch is absent', () => {
  const f = fixture({ togglePresent: false });
  assert.doesNotThrow(() => f.context.applyTheme('light'));
  assert.equal(f.document.documentElement.dataset.theme, 'dark');
});

for (const failStorage of ['getItem', 'setItem', 'removeItem']) {
  test(`storage ${failStorage} SecurityError does not abort startup work`, async () => {
    const f = fixture({ failStorage });
    assert.doesNotThrow(() => f.ready()); await flush();
    assert.equal(f.document.documentElement.dataset.theme, 'dark');
    assert.deepEqual(f.calls, ['metadata', 'share', 'targets', 'top-resume', 'foreground-resume']);
    assert.equal(f.element('#search-range').value, 'auto');
    assert.ok(f.element('#search-target').value);
  });
}
