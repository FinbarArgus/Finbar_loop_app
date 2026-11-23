// Unit tests for scene.js (the growth tree standing on the ant farm): node --test tests/scene.test.js
process.env.TZ = 'Pacific/Auckland';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../growth.js');
const S = require('../scene.js');
const EX = require('../tools/tree_examples.js');

const NOW = '2026-12-10T12:00:00';
const ag = (name, state = 'working', tokens = null, extra = {}) =>
  ({ name, state, running: true, ...(tokens == null ? {} : { week_tokens: { total: tokens } }), ...extra });
const AGENTS = [ag('LOOP', 'working', 9e6, { loop: true }), ag('HIGH-a', 'working', 2.5e7), ag('HIGH-b', 'blocked', 4e6),
  ag('MED-c', 'stalled', 3e5, { running: false }), ag('LOW-d', 'working', 1e6), ag('IMPLEMENT-e', 'working', 1.2e7)];
const young = () => G.derive([], {}, {}, NOW);
const read = (id, day) => ({ id, kind: 'read', done: true, created: `${day}T09:00:00`, done_at: `${day}T15:00:00` });
const grown = (days) => { const { entries, writes } = EX.history(days); return EX.snapshot(entries, writes, days).s; };
const within = (p, b) => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1;

test('the tree stands on the surface in a gap between LOOP\'s fruit pile and the first anthill to its right', () => {
  for (const st of [young(), grown(5 * 365)]) {
    const sc = S.scene(st, AGENTS);
    const g = st.chains[0].segs[0];
    const foot = { x: sc.L.gap.cx + S.SCALE * g.x0, y: sc.L.surface - S.SCALE * g.y0 };
    const half = S.SCALE * g.w0 / 2;
    assert.equal(foot.y, sc.L.surface);
    assert.equal(foot.x, sc.L.gap.cx);
    const pile = sc.L.food.x0 + sc.L.food.w;
    const next = Math.min(...sc.L.hills.filter((h) => h.kind === 'home' && h.x > sc.L.food.cx).map((h) => h.mound.x0));
    assert.ok(foot.x - half >= pile + 4, `trunk ${foot.x - half} clear of the pile ${pile}`);
    assert.ok(foot.x + half <= next - 4, `trunk ${foot.x + half} clear of the anthill ${next}`);
    assert.ok(sc.L.gap.x1 - sc.L.gap.x0 >= S.GAP);
    assert.match(sc.svg, new RegExp(`<g class="tree" transform="translate\\(${sc.L.gap.cx} ${sc.L.surface}\\) scale\\(2\\)"`));
  }
});

test('the default view frames every anthill, anthome and the trunk\'s foot', () => {
  const sc = S.scene(young(), AGENTS);
  for (const hl of sc.L.hills.filter((h) => h.kind === 'home')) {
    assert.ok(within({ x: hl.mound.x0, y: sc.L.surface - hl.mound.h }, sc.home) && within({ x: hl.mound.x0 + hl.mound.w, y: sc.L.surface }, sc.home), hl.name);
    assert.ok(within({ x: hl.home.x0, y: hl.home.y0 }, sc.home) && within({ x: hl.home.x0 + hl.home.w, y: hl.home.y0 + hl.home.h }, sc.home), hl.name);
  }
  assert.ok(within({ x: sc.L.food.cx, y: sc.L.surface - S.HOME_SKY + 1 }, sc.home));
  assert.ok(within({ x: sc.L.gap.cx, y: sc.L.surface }, sc.home), 'the trunk\'s foot');
  assert.match(sc.svg, new RegExp(`viewBox="0 ${sc.L.surface - S.HOME_SKY} ${sc.L.width} ${sc.L.height - sc.L.surface + S.HOME_SKY}"`));
});

test('a grown tree rises above the default view, and the scene grows to hold it', () => {
  const sc = S.scene(grown(2 * 365), AGENTS);
  assert.ok(sc.tree.y0 < sc.home.y0 - 40, `tree top ${sc.tree.y0}, view top ${sc.home.y0}`);
  assert.equal(sc.box.y0, sc.tree.y0);
  assert.ok(sc.box.x0 <= 0 && sc.box.x1 >= sc.L.width);
  assert.deepEqual([sc.tree.x0, sc.tree.x1, sc.tree.y0], [sc.box.x0, sc.box.x1, sc.box.y0]);
  const wood = [...sc.svg.matchAll(/<rect x="([-\d.]+)" y="[-\d.]+" width="([\d.]+)" height="[\d.]+" fill="#6e4b2e"\/>/g)];
  const [wx0, wx1] = [Math.min(...wood.map((m) => +m[1])), Math.max(...wood.map((m) => +m[1] + +m[2]))].map((x) => sc.L.gap.cx + S.SCALE * x);
  assert.ok(wx0 >= sc.box.x0 && wx1 <= sc.box.x1, `wood ${wx0}..${wx1} inside ${sc.box.x0}..${sc.box.x1}`);
  assert.equal(sc.box.y1, sc.L.height);
});

test('a tree wider than the farm widens the ground under it', () => {
  const sc = S.scene(grown(5 * 365), [ag('LOOP', 'working', 1, { loop: true })]);
  assert.ok(sc.box.x0 < 0 || sc.box.x1 > sc.L.width, `scene ${sc.box.x0}..${sc.box.x1}, farm 0..${sc.L.width}`);
  const soil = [...sc.svg.matchAll(/<rect x="([-\d.]+)" y="[\d.]+" width="([\d.]+)" height="[\d.]+" fill="#6e5139"\/>/g)];
  assert.equal(soil.length, 1);
  const bw = sc.box.x1 - sc.box.x0;
  assert.equal(+soil[0][1], sc.box.x0 - bw, 'the ground runs a scene width past the left');
  assert.equal(+soil[0][2], 3 * bw, 'and past the right');
});

test('one sky, the tree behind the farm, the tree\'s tap targets on top of the farm\'s', () => {
  const st = G.derive([{ id: 'r1', kind: 'read', done: true, created: '2026-12-01T09:00:00', done_at: '2026-12-01T15:00:00' }], {}, {}, NOW);
  const sc = S.scene(st, AGENTS);
  assert.equal((sc.svg.match(/fill="#f3f2ea"\/>/g) || []).length, 1, 'one sky rect');
  assert.ok(!sc.svg.includes('fill="#fff"'), 'no white paper behind the tree');
  const treeBody = sc.svg.indexOf('<g class="tree"'), farm = sc.svg.indexOf('<g class="farm">'), treeHits = sc.svg.lastIndexOf('<g class="tree"');
  assert.ok(treeBody < farm && farm < treeHits);
  assert.ok(sc.svg.indexOf('data-k="hill"') > farm && sc.svg.indexOf('data-k="hill"') < treeHits);
  assert.ok(sc.svg.indexOf('data-k="seg" data-i="r1"') > treeHits);
  assert.equal((sc.svg.match(/class="ant"/g) || []).length, 6 + 5 + 2 + 5);
});

test('the height scale stands at the farm\'s left edge, its labels to its right', () => {
  const sc = S.scene(grown(365), AGENTS);
  const m = /<g class="scale">.*?<text x="([-\d.]+)"[^>]*text-anchor="start"[^>]*>(\d+) m<\/text>/.exec(sc.svg);
  assert.ok(m, 'a scale label');
  const x = sc.L.gap.cx + S.SCALE * +m[1];
  assert.ok(x > 0 && x < 8, `label at ${x} blocks`);
});

test('without agents the tree still stands on an empty farm', () => {
  const sc = S.scene(young(), []);
  assert.equal(sc.L.hills.length, 0);
  assert.match(sc.svg, /tree: none yet/);                         // nothing grown yet: only the marker
  assert.match(S.scene(G.derive([read('a', '2026-12-01')], {}, {}, NOW), []).svg, /data-k="seg"/);
});

test('a young tree (Q-0036) stands small beside the fruit pile: a marker with its height, a tap target, its own frame', () => {
  const st = G.derive([read('a', '2026-12-01')], {}, {}, NOW);
  assert.ok(st.height >= 0.04 && st.height <= 0.06, `height ${st.height}`);
  const sc = S.scene(st, AGENTS);
  assert.match(sc.svg, />tree: 5 cm ↓<\/text>/);
  assert.match(sc.svg, /data-k="sprout"/);
  const m = sc.svg.match(/<g class="sprout"><text x="([\d.]+)" y="([\d.]+)"/).map(Number);
  assert.ok(within({ x: m[1], y: m[2] }, sc.home) && Math.abs(m[1] - sc.L.gap.cx) < 1e-9, 'the marker is over the trunk, in the default view');
  // Whole tree frames the small tree itself (with its scale), a few blocks across, standing on the surface.
  const w = sc.tree.x1 - sc.tree.x0;
  assert.ok(w > 0.5 && w < 12, `frame ${w} blocks`);
  assert.ok(sc.tree.y1 > sc.L.surface && sc.tree.y0 < sc.L.surface - S.SCALE * st.height, 'the frame holds the tree and its foot');
  assert.ok(sc.tree.x0 < sc.L.gap.cx && sc.L.gap.cx < sc.tree.x1);
  // A grown tree has no marker, and its frame spans the scene.
  const big = S.scene(grown(365), AGENTS);
  assert.doesNotMatch(big.svg, /data-k="sprout"/);
  assert.ok(big.tree.x1 - big.tree.x0 >= big.L.width);
});
