import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../site/app.js', import.meta.url), 'utf8');
function section(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `Missing source section ${start}`);
  return source.slice(a, b);
}
function chain(start) {
  return { found: true, path: [start, 'target'], hops: [{ from: start, to: 'target', url: 'https://www.chess.com/game/live/123' }], target: 'target' };
}
function fixture({ clipboardFails = false, legacyCopySucceeds = true } = {}) {
  const classes = new Set(), copied = [], requests = [], statuses = [], timers = [];
  const button = { dataset: {}, lastChild: { textContent: '' }, hidden: true, disabled: false,
    classList: { add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x) } };
  const imageButton = {};
  const state = { currentChain: null };
  const context = vm.createContext({
    state, URL, location: { href: 'https://example.invalid/' },
    CHAIN_PARAM: 'chain', SHORT_CHAIN_PARAM: 'c', LEGACY_SHARE_PARAM: 'share',
    encodeSharePayload: route => route.path.join('>'),
    $: selector => selector === '#copy-share' ? button : imageButton,
    createShortShareUrl: route => new Promise(resolve => requests.push({ route, resolve })),
    navigator: { clipboard: { writeText: async url => { if (clipboardFails) throw Error('Clipboard denied'); copied.push(url); } } },
    document: { createElement: () => ({ style: {}, setAttribute() {}, select() {}, remove() {} }), body: { appendChild() {} }, execCommand: () => legacyCopySucceeds },
    showStatus: (...args) => statuses.push(args),
    setTimeout: callback => timers.push(callback), clearTimeout() {}, console,
  });
  vm.runInContext(
    section('  function updateShareButton(', '  function buildShortShareUrl(') +
    section('  async function copyShareLink(', '  async function saveShareImage('), context);
  function display(route) { state.currentChain = route; context.updateShareButton(route); }
  return { context, state, button, classes, copied, requests, statuses, timers, display };
}

test('late share A cannot replace the displayed B link or make B fallback copy A', async () => {
  const f = fixture(), a = chain('alice'), b = chain('bob');
  f.display(a);
  const copyA = f.context.copyShareLink();
  assert.equal(f.requests.length, 1);
  f.display(b);
  const expectedB = f.button.dataset.shareUrl;
  f.requests[0].resolve('https://example.invalid/?c=short-A');
  await copyA;
  assert.equal(f.button.dataset.shareUrl, expectedB, 'Late A response must leave B share URL intact');
  const copyB = f.context.copyShareLink();
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve('');
  await copyB;
  assert.equal(f.copied.at(-1), expectedB, 'Failed B POST must copy the long URL captured for B');
});

test('both clipboard mechanisms failing never report Copied', async () => {
  const f = fixture({ clipboardFails: true, legacyCopySucceeds: false });
  f.display(chain('alice'));
  const copying = f.context.copyShareLink();
  f.requests[0].resolve('');
  // An explicit failure or a handled error are both valid; success feedback is not.
  await Promise.resolve(copying).catch(() => {});
  assert.equal(f.classes.has('is-copied'), false, 'Failed copy must not receive success styling');
  assert.doesNotMatch(f.button.lastChild.textContent, /copied/i, 'Failed copy must not display Copied');
  assert.equal(f.button.disabled, false, 'Failed copy must allow another attempt');
});

test('superseded A completion leaves pending B disabled and only B copies', async () => {
  const f = fixture();
  f.display(chain('alice'));
  const copyA = f.context.copyShareLink();
  f.display(chain('bob'));
  const expectedB = f.button.dataset.shareUrl;
  const copyB = f.context.copyShareLink();
  const pendingFeedback = f.button.lastChild.textContent;
  assert.equal(f.button.disabled, true);
  f.requests[0].resolve('https://example.invalid/?c=short-A');
  await copyA;
  assert.equal(f.button.disabled, true, 'A must not enable the button while B is pending');
  assert.equal(f.button.lastChild.textContent, pendingFeedback);
  assert.equal(f.button.dataset.shareUrl, expectedB);
  assert.deepEqual(f.copied, [], 'Superseded A must not write the clipboard');
  assert.equal(f.classes.has('is-copied'), false);
  f.requests[1].resolve('https://example.invalid/?c=short-B');
  await copyB;
  assert.deepEqual(f.copied, ['https://example.invalid/?c=short-B']);
  assert.equal(f.button.dataset.shareUrl, 'https://example.invalid/?c=short-B');
  assert.equal(f.button.disabled, false);
  assert.match(f.button.lastChild.textContent, /copied/i);
  assert.equal(f.classes.has('is-copied'), true);
});

test('old copied timer cannot reset B pending or completed feedback', async () => {
  for (const completeBFirst of [false, true]) {
    const f = fixture();
    f.display(chain('alice'));
    const copyA = f.context.copyShareLink();
    f.requests[0].resolve('https://example.invalid/?c=short-A');
    await copyA;
    assert.equal(f.timers.length, 1);
    const oldTimer = f.timers[0];
    f.display(chain('bob'));
    const copyB = f.context.copyShareLink();
    if (completeBFirst) {
      f.requests[1].resolve('https://example.invalid/?c=short-B');
      await copyB;
    }
    const expected = { text: f.button.lastChild.textContent, disabled: f.button.disabled,
      copied: f.classes.has('is-copied'), url: f.button.dataset.shareUrl };
    oldTimer();
    assert.deepEqual({ text: f.button.lastChild.textContent, disabled: f.button.disabled,
      copied: f.classes.has('is-copied'), url: f.button.dataset.shareUrl }, expected,
    `Old timer must preserve B ${completeBFirst ? 'completed' : 'pending'} state`);
    if (!completeBFirst) {
      f.requests[1].resolve('https://example.invalid/?c=short-B');
      await copyB;
    }
  }
});
