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
const chain = start => ({ found: true, path: [start, 'target'], hops: [{}] });
function fixture({ serializeFails = false } = {}) {
  const state = { currentChain: null }, draws = [], clicks = [], statuses = [];
  const image = { disabled: false, lastChild: { textContent: ' Save image' } };
  const copy = { dataset: {}, classList: { remove() {} }, lastChild: {} };
  const context = vm.createContext({
    state, $: selector => selector === '#save-share-image' ? image : copy,
    buildLongShareUrl: route => `https://example.invalid/${route.path[0]}`,
    nameOf: String, drawShareBackground() {}, drawSharePill() {},
    drawShareChain: (_ctx, route) => new Promise((resolve, reject) => draws.push({ route, resolve, reject })),
    showStatus: (...args) => statuses.push(args),
    document: { createElement(tag) {
      if (tag === 'canvas') return { getContext: () => ({ fillText() {} }), toDataURL(type) {
        assert.equal(type, 'image/png');
        if (serializeFails) throw Error('Canvas serialization failed');
        return 'data:image/png;base64,MOCK';
      } };
      if (tag === 'a') return { click() { clicks.push({ href: this.href, filename: this.download }); } };
      throw Error(`Unexpected element: ${tag}`);
    } },
  });
  vm.runInContext(section('  function updateShareButton(', '  function buildLongShareUrl(') +
    section('  async function saveShareImage(', '  function drawShareBackground('), context);
  const display = route => { state.currentChain = route; context.updateShareButton(route); };
  return { context, state, draws, clicks, statuses, image, display };
}

test('image export invokes PNG data URL with captured filename and restores controls', async () => {
  const f = fixture(); f.display(chain('alice'));
  const saving = f.context.saveShareImage();
  assert.equal(f.image.disabled, true);
  assert.match(f.image.lastChild.textContent, /saving/i);
  f.draws[0].resolve(); await saving;
  assert.deepEqual(f.clicks, [{ href: 'data:image/png;base64,MOCK', filename: 'connections-alice-target.png' }]);
  assert.equal(f.image.disabled, false);
  assert.match(f.image.lastChild.textContent, /save image/i);
  // Mock anchor invocation establishes neither browser delivery nor PNG validity.
});

for (const failure of ['draw', 'serialization']) {
  test(`${failure} failure is handled, visibly reported, and restores export controls`, async () => {
    const f = fixture({ serializeFails: failure === 'serialization' }); f.display(chain('alice'));
    const saving = f.context.saveShareImage();
    if (failure === 'draw') f.draws[0].reject(Error('Drawing failed')); else f.draws[0].resolve();
    let rejection;
    await saving.catch(error => { rejection = error; });
    assert.equal(f.image.disabled, false);
    assert.match(f.image.lastChild.textContent, /save image/i);
    assert.equal(f.clicks.length, 0);
    assert.ok(f.statuses.some(([kind, message]) => kind === 'error' && String(message).trim()), 'Failure needs a visible error status');
    assert.equal(rejection, undefined, 'Click handler must handle the failure rather than reject');
  });
}

test('finishing A cannot enable or reset B while B image export is pending', async () => {
  const f = fixture(); f.display(chain('alice'));
  const savingA = f.context.saveShareImage();
  f.display(chain('bob'));
  assert.equal(f.image.disabled, false, 'New displayed route must allow its own export');
  const savingB = f.context.saveShareImage();
  const pendingLabel = f.image.lastChild.textContent;
  f.draws[0].resolve(); await savingA;
  assert.equal(f.image.disabled, true, 'A completion cannot enable B pending export');
  assert.equal(f.image.lastChild.textContent, pendingLabel);
  f.draws[1].resolve(); await savingB;
  assert.equal(f.image.disabled, false);
  assert.match(f.image.lastChild.textContent, /save image/i);
  assert.deepEqual(f.clicks.map(item => item.filename), ['connections-alice-target.png', 'connections-bob-target.png']);
});
