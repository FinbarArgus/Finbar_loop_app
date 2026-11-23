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
const grown = (days) => { const { entries, writes } = EX.history(days); return EX.snapshot(entries, writes, days).s; };
const within = (p, b) => p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1;

test('the trunk stands on the surface in the middle of LOOP\'s fruit pile', () => {
  const st = young();
  const sc = S.scene(st, AGENTS);
  const g = st.chains[0].segs[0];
  const foot = { x: sc.L.width / 2 + S.SCALE * g.x0, y: sc.L.surface - S.SCALE * g.y0 };
  assert.equal(foot.y, sc.L.surface);
  assert.equal(foot.x, sc.L.food.cx);
  assert.ok(foot.x > sc.L.food.x0 && foot.x < sc.L.food.x0 + sc.L.food.w);
  assert.match(sc.svg, new RegExp(`<g class="tree" transform="translate\\(${sc.L.width / 2} ${sc.L.surface}\\) scale\\(2\\)"`));
});

test('the default view frames every anthill, anthome and the trunk\'s foot', () => {
  const sc = S.scene(young(), AGENTS);
  for (const hl of sc.L.hills.filter((h) => h.kind === 'home')) {
    assert.ok(within({ x: hl.mound.x0, y: sc.L.surface - hl.mound.h }, sc.home) && within({ x: hl.mound.x0 + hl.mound.w, y: sc.L.surface }, sc.home), hl.name);
    assert.ok(within({ x: hl.home.x0, y: hl.home.y0 }, sc.home) && within({ x: hl.home.x0 + hl.home.w, y: hl.home.y0 + hl.home.h }, sc.home), hl.name);
  }
  assert.ok(within({ x: sc.L.food.cx, y: sc.L.surface - S.HOME_SKY + 1 }, sc.home));
  assert.match(sc.svg, new RegExp(`viewBox="0 ${sc.L.surface - S.HOME_SKY} ${sc.L.width} ${sc.L.height - sc.L.surface + S.HOME_SKY}"`));
});

test('a grown tree rises above the default view, and the scene grows to hold it', () => {
  const sc = S.scene(grown(2 * 365), AGENTS);
  assert.ok(sc.tree.y0 < sc.home.y0 - 40, `tree top ${sc.tree.y0}, view top ${sc.home.y0}`);
  assert.equal(sc.box.y0, sc.tree.y0);
  assert.ok(sc.box.x0 <= 0 && sc.box.x1 >= sc.L.width);
  assert.deepEqual([sc.tree.x0, sc.tree.x1, sc.tree.y0], [sc.box.x0, sc.box.x1, sc.box.y0]);
  const wood = [...sc.svg.matchAll(/<rect x="([-\d.]+)" y="[-\d.]+" width="([\d.]+)" height="[\d.]+" fill="#6e4b2e"\/>/g)];
  const [wx0, wx1] = [Math.min(...wood.map((m) => +m[1])), Math.max(...wood.map((m) => +m[1] + +m[2]))].map((x) => sc.L.width / 2 + S.SCALE * x);
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
  const x = sc.L.width / 2 + S.SCALE * +m[1];
  assert.ok(x > 0 && x < 8, `label at ${x} blocks`);
});

test('without agents the tree still stands on an empty farm', () => {
  const sc = S.scene(young(), []);
  assert.equal(sc.L.hills.length, 0);
  assert.match(sc.svg, /data-k="branch"/);
});
