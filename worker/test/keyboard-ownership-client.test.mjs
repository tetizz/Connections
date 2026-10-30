import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
const source = readFileSync(new URL('../../site/app.js', import.meta.url), 'utf8');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `Missing actual function section ${start}`);
  return source.slice(a, b);
}
function fixture() {
  const document = { activeElement: null }, elements = new Map(), suggestions = [], profiles = [];
  function element() {
    const attrs = new Map();
    return { hidden: true, value: '', style: {}, children: [], isConnected: true,
      classList: { toggle() {}, add() {}, remove() {} },
      setAttribute: (k, v) => attrs.set(k, v), getAttribute: k => attrs.get(k) ?? null,
      removeAttribute: k => attrs.delete(k), focus() { document.activeElement = this; },
      contains(child) { return child === this || this.children.includes(child); },
      matches(selector) { return this.selector === selector; },
      getBoundingClientRect: () => ({ left: 10, top: 10, bottom: 30, width: 100, height: 80 }),
      scrollIntoView() {},
      querySelector(selector) { return this.children.find(child => child.selector === selector) || null; },
      querySelectorAll() { return this.children; },
      set innerHTML(value) {
        if (this.contains(document.activeElement)) document.activeElement = document.body;
        this.html = value;
        this.children = [];
        for (const match of value.matchAll(/data-username="([^"]+)"/g)) {
          const row = element(); row.dataset = { username: match[1] }; this.children.push(row);
        }
        if (value.includes('data-profile-close')) {
          const close = element(); close.selector = '[data-profile-close]'; this.children.push(close);
        }
        if (value.includes('profile-popover__open')) {
          const link = element(); link.selector = '.profile-popover__open'; this.children.push(link);
        }
      }, get innerHTML() { return this.html || ''; },
    };
  }
  document.body = element(); document.activeElement = document.body;
  const $ = selector => { if (!elements.has(selector)) elements.set(selector, element()); return elements.get(selector); };
  document.querySelector = $;
  const state = { players: { alice: { username: 'alice' }, albert: { username: 'albert' } },
    suggest: { focused: true, field: 'start', seq: 0, items: [], activeIndex: -1 }, profilePopoverToken: 0 };
  const context = vm.createContext({ state, $, document, AbortController, console,
    window: { innerWidth: 1200, innerHeight: 900 }, SUGGEST_MIN_CHARS: 2, SUGGEST_LIMIT: 8,
    cleanUsernameInput: x => String(x || '').trim().toLowerCase(), isBlockedUsername: () => false,
    countryCode: String, esc: String, countryFlagIcon: () => '',
    setTimeout() {}, clearTimeout() {},
    fetchUsernameSuggestions: (_query, signal) => new Promise((resolve, reject) => suggestions.push({ resolve, reject, signal })),
    fetchProfile: () => new Promise(resolve => profiles.push(resolve)),
    renderProfileStats: () => '', renderProfileRecentGames: () => '', flagIcon: () => '', plainNumber: String,
  });
  vm.runInContext(section('  function suggestConfig(', '  async function fetchUsernameSuggestions(') +
    section('  function localUsernameSuggestions(', '  function countryFlagIcon(') +
    section('  function renderProfilePopover(', '  function formatProfileDate('), context);
  $('#search-start').value = 'al';
  return { context, state, $, document, suggestions, profiles };
}

for (const outcome of ['remote success', 'abort rejection']) {
  test(`Escape-style hide remains closed after pending suggestion ${outcome}`, async () => {
    const f = fixture();
    f.context.renderUsernameSuggest('al', [{ username: 'alice' }]);
    const loading = f.context.loadUsernameSuggestions('al');
    f.context.hideUsernameSuggest();
    assert.equal(f.$('#username-suggest').hidden, true);
    if (outcome === 'remote success') f.suggestions[0].resolve([{ username: 'alex' }]);
    else f.suggestions[0].reject(Object.assign(Error('aborted'), { name: 'AbortError' }));
    await loading;
    assert.equal(f.$('#username-suggest').hidden, true, 'Late completion must not reopen dismissed suggestions');
    assert.equal(f.$('#search-start').getAttribute('aria-expanded'), 'false');
  });
}

test('ArrowDown local username remains selected when remote results reorder it', async () => {
  const f = fixture();
  f.context.renderUsernameSuggest('al', [{ username: 'alice' }, { username: 'albert' }]);
  const loading = f.context.loadUsernameSuggestions('al');
  f.context.moveUsernameSuggest(1);
  assert.equal(f.state.suggest.items[f.state.suggest.activeIndex].username, 'alice');
  f.suggestions[0].resolve([{ username: 'alex' }, { username: 'alice' }]);
  await loading;
  assert.equal(f.state.suggest.items[f.state.suggest.activeIndex]?.username, 'alice');
  assert.equal(f.$('#search-start').getAttribute('aria-activedescendant'), `username-suggest-option-start-${f.state.suggest.activeIndex}`);
});

for (const change of ['query', 'field', 'missing username']) {
  test(`suggestion selection resets for changed ${change}`, () => {
    const f = fixture();
    f.context.renderUsernameSuggest('al', [{ username: 'alice' }, { username: 'albert' }]);
    f.context.moveUsernameSuggest(1);
    assert.equal(f.state.suggest.items[f.state.suggest.activeIndex].username, 'alice');
    const field = change === 'field' ? 'target' : 'start';
    const query = change === 'query' ? 'ali' : 'al';
    f.state.suggest.field = field;
    f.$(field === 'target' ? '#search-target' : '#search-start').value = query;
    const items = change === 'missing username' ? [{ username: 'alex' }] : [{ username: 'alice' }];
    f.context.renderUsernameSuggest(query, items, {}, field);
    assert.equal(f.state.suggest.activeIndex, -1, 'Only an explicit arrow choice for the same query and field can persist');
    assert.equal(f.$(field === 'target' ? '#search-target' : '#search-start').getAttribute('aria-activedescendant'), null);
  });
}

test('initial profile open focuses close; late enrichment does not steal outside focus', async () => {
  const f = fixture(), anchor = f.$('#anchor');
  anchor.focus();
  const loading = f.context.showProfilePopover('alice', anchor);
  assert.equal(f.document.activeElement, f.$('#profile-popover').querySelector('[data-profile-close]'));
  const outside = f.$('#search-start'); outside.focus();
  f.profiles[0]({ username: 'alice', name: 'Alice' });
  await loading;
  assert.equal(f.document.activeElement, outside, 'Background enrichment must preserve outside focus');
});

test('profile enrichment preserves logical close focus when replacing focused dialog content', async () => {
  const f = fixture(), anchor = f.$('#anchor');
  const loading = f.context.showProfilePopover('alice', anchor);
  const oldClose = f.$('#profile-popover').querySelector('[data-profile-close]');
  oldClose.focus();
  f.profiles[0]({ username: 'alice' });
  await loading;
  const newClose = f.$('#profile-popover').querySelector('[data-profile-close]');
  assert.notEqual(newClose, oldClose);
  assert.equal(f.document.activeElement, newClose);
});
