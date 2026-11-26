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
    assert.match(sc.svg, new RegExp(`<g class="tree" transform="translate\\(${sc.L.gap.cx} ${sc.L.surface}\\) scale\\(${S.SCALE}\\)"`));
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
  const top = Math.min(sc.L.surface - S.HOME_SKY, Math.max(sc.arc.top - 1, sc.L.surface - S.HOME_MAX));   // and the sun's arc
  assert.deepEqual(sc.home, { x0: 0, y0: top, x1: sc.L.width, y1: sc.L.height });
  assert.match(sc.svg, new RegExp(`viewBox="0 ${Math.round(top * 100) / 100} ${sc.L.width} ${Math.round((sc.L.height - top) * 100) / 100}"`));
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

test('one sky, a grown tree behind the farm and a young one over it, the tree\'s tap targets on top of the farm\'s', () => {
  const st = G.derive([{ id: 'r1', kind: 'read', done: true, created: '2026-12-01T09:00:00', done_at: '2026-12-01T15:00:00' }], {}, {}, NOW);
  const sc = S.scene(st, AGENTS);
  assert.equal((sc.svg.match(/fill="#f3f2ea"\/>/g) || []).length, 1, 'one sky rect');
  assert.ok(!sc.svg.includes('fill="#fff"'), 'no white paper behind the tree');
  // A young tree is drawn over the farm (its grass would hide it); its tap targets are on top of the farm's.
  const treeBody = sc.svg.indexOf('<g class="tree"'), farm = sc.svg.indexOf('<g class="farm">'), treeHits = sc.svg.lastIndexOf('<g class="tree"');
  assert.ok(farm < treeBody && treeBody < treeHits);
  // A grown tree stands behind the farm, so its foot is in LOOP's pile.
  const gs = S.scene(grown(365), AGENTS).svg;
  assert.ok(gs.indexOf('<g class="tree"') < gs.indexOf('<g class="farm">') && gs.indexOf('<g class="farm">') < gs.lastIndexOf('<g class="tree"'));
  assert.ok(sc.svg.indexOf('data-k="hill"') > farm && sc.svg.indexOf('data-k="hill"') < treeHits);
  assert.ok(sc.svg.indexOf('data-k="seg" data-i="r1"') > treeHits);
  assert.equal((sc.svg.match(/class="ant"/g) || []).length, 6 + 5 + 2 + 5);
});

test('the height scale stands at the farm\'s left edge, its labels to its right', () => {
  const sc = S.scene(grown(365), AGENTS);
  const m = /<g class="scale">.*?<text x="([-\d.]+)"[^>]*text-anchor="start"[^>]*>(\d+) m<\/text>/.exec(sc.svg);
  assert.ok(m, 'a scale label');
  const x = sc.L.gap.cx + S.SCALE * +m[1];
  assert.ok(x > 0 && x < 1 + 4 * G.CELL * S.SCALE, `label at ${x} blocks, within 4 of the tree's blocks of the edge`);
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

test('anthomes are about 1 m on the tree\'s height scale (Finbar, C-0007), and LOOP\'s pile has no crown', () => {
  const sc = S.scene(young(), AGENTS);
  const m = (blocks) => blocks / S.SCALE;
  // A home grows with its agent's tokens: a typical one is under 1 m, the heaviest user's up to 1.5 m.
  const homes = sc.L.hills.filter((x) => x.home).map((h) => m(h.home.h)).sort((x, y) => x - y);
  assert.ok(homes[Math.floor(homes.length / 2)] <= 1 && homes.every((h) => h >= 0.5 && h <= 1.5), `homes ${homes} m`);
  assert.ok(sc.L.hills.filter((x) => x.mound).every((h) => m(h.mound.h) <= 1), 'mounds under 1 m');
  assert.ok(!sc.svg.includes('#b89b55'), 'no crown');
});

test('deadline birds wait up and out from the crown node they land on: further for later deadlines, bigger when near, a dashed line to it', () => {
  const due = (id, deadline) => ({ id, kind: 'task', created: '2026-12-01T09:00:00', deadline, title: id });
  const st = G.derive([...EX.history(365).entries, due('d1', '2026-12-11'), due('d10', '2026-12-20'), due('d90', '2027-03-10'), due('gone', '2026-12-05')], {}, {}, NOW);
  const sc = S.scene(st, AGENTS);
  const top = Math.min(0, sc.tree.y0, sc.arc.top - 1) - S.BIRD_ROOM;
  const B = Object.fromEntries(S.birds(st, sc.L, sc.L.gap.cx, top).filter((b) => /^(d\d+|gone)$/.test(b.id)).map((b) => [b.id, b]));
  assert.deepEqual(Object.keys(B).sort(), ['d1', 'd10', 'd90'], 'a passed deadline does not fly');
  const dist = (b) => Math.hypot(b.x - b.land.x, b.y - b.land.y);
  assert.ok(dist(B.d1) < dist(B.d10) && dist(B.d10) < dist(B.d90), 'nearer deadlines are nearer their node');
  assert.ok(Math.abs(dist(B.d1) - (S.BIRD_NEAR + S.BIRD_PER_DAY * 1.5)) < 1, 'a near one is about its distance away');
  assert.ok(B.d1.size > B.d10.size && B.d10.size > B.d90.size && B.d90.size === S.BIRD_SMALL);
  for (const b of Object.values(B)) {
    assert.ok(b.y < b.land.y && Math.sign(b.x - sc.L.gap.cx) === Math.sign(b.land.x - sc.L.gap.cx), `${b.id} above its node, on its side of the trunk`);
    assert.ok(within(b, sc.box) && b.y >= top - 1e-9 && b.x >= S.BIRD_EDGE - 1e-9 && b.x <= sc.L.width - S.BIRD_EDGE + 1e-9, `${b.id} inside the sky`);
    const lb = G.layout(st).birds.find((x) => x.id === b.id), k = G.treeScale(st);
    assert.deepEqual(b.land, { x: sc.L.gap.cx + S.SCALE * k * lb.x, y: sc.L.surface - S.SCALE * k * lb.y });
    assert.match(sc.svg, new RegExp(`<g class="bird" data-i="${b.id}"><line [^>]*x2="${Math.round(b.land.x * 100) / 100}" y2="${Math.round(b.land.y * 100) / 100}"[^>]*stroke-dasharray`));
    assert.match(sc.svg, new RegExp(`<g class="hits">.*data-k="bird" data-i="${b.id}"`));
  }
  assert.match(sc.svg, /data-k="bird" data-i="gone"/, 'the passed one perches on the tree');
  // At night the birds are shaded with the rest of the scene, and their tap targets stay above the shade.
  const dark = S.scene(st, AGENTS, { usage: { pct: 95, held: true, woken: [] } }), at = (x) => dark.svg.indexOf(x);
  assert.ok(at('<g class="birds">') < at('nightshade') && at('nightshade') < dark.svg.lastIndexOf('data-k="bird"'));
});

test('night (usage held): a dark sky with stars and a moon in the default view, the scene shaded, z\'s over the shade', () => {
  const day = S.scene(young(), AGENTS);
  assert.doesNotMatch(day.svg, /nightshade|class="zz"|data-still|class="stars"/);
  const sc = S.scene(young(), AGENTS, { usage: { pct: 95, held: true, woken: [] } });
  assert.match(sc.svg, /class="scene night"/);
  assert.match(sc.svg, new RegExp(`fill="${S.NIGHT.sky}"`));
  const stars = [...sc.svg.matchAll(/<rect x="([-\d.]+)" y="([-\d.]+)" width="0\.[35]" height="0\.[35]" fill="#fff6d8"/g)]
    .map((m) => ({ x: +m[1], y: +m[2] }));
  assert.ok(stars.filter((p) => within(p, sc.home)).length >= 20, 'stars in the default view');
  const moon = /<g class="moon"><circle cx="([-\d.]+)" cy="([-\d.]+)"/.exec(sc.svg);
  assert.ok(within({ x: +moon[1], y: +moon[2] }, sc.home) && +moon[2] < sc.L.surface, 'the moon in the default view\'s sky');
  // The shade comes after the tree and the farm, the z's after the shade, the tree's tap targets last; taps pass the shade.
  const at = (s) => sc.svg.indexOf(s);
  assert.ok(at('<g class="farm">') < at('nightshade') && at('nightshade') < at('class="zz"') && at('class="zz"') < sc.svg.lastIndexOf('<g class="tree"'));
  assert.match(sc.svg, /class="nightshade"[^>]*pointer-events="none"/);
  // Every anthill sleeps: one set of z's per hill (LOOP's pile too), every ant still.
  assert.equal((sc.svg.match(/class="zz"/g) || []).length, sc.L.hills.length);
  assert.equal((sc.svg.match(/class="ant"/g) || []).length, (sc.svg.match(/class="ant"[^>]*data-still="1"/g) || []).length);
});

test('night: an urgent message wakes only that agent while its session works; it sleeps again when idle', () => {
  const woke = S.scene(young(), AGENTS, { usage: { pct: 95, held: true, woken: ['HIGH-a', 'MED-c'] } });   // MED-c stalled: asleep again
  const hill = (sc, name) => sc.L.hills.findIndex((h) => h.name === name);
  const zzOf = (sc, name) => sc.svg.includes(`class="zz" data-h="${hill(sc, name)}"`);
  assert.ok(!zzOf(woke, 'HIGH-a') && zzOf(woke, 'MED-c') && zzOf(woke, 'LOW-d') && zzOf(woke, 'LOOP'));
  const ants = (sc, name) => [...sc.svg.matchAll(new RegExp(`<g class="ant" data-h="${hill(sc, name)}"[^>]*>`, 'g'))].map((m) => m[0]);
  assert.ok(ants(woke, 'HIGH-a').length > 0 && ants(woke, 'HIGH-a').every((a) => !a.includes('data-still')), 'the woken hill\'s ants move');
  assert.ok(ants(woke, 'LOW-d').length > 0 && ants(woke, 'LOW-d').every((a) => a.includes('data-still')), 'a working, unwoken hill\'s ants stand still');
  const idle = S.scene(young(), AGENTS.map((a) => (a.name === 'HIGH-a' ? { ...a, state: 'idle' } : a)), { usage: { pct: 95, held: true, woken: ['HIGH-a'] } });
  assert.ok(zzOf(idle, 'HIGH-a'), 'woken but idle: asleep again');
});

test('day: the sun rises at the left at 0%, is highest at 47.5%, sets at the right at 95%, its percentage above it', () => {
  const wide = Array.from({ length: 20 }, (_, k) => ag(`MED-${k}`));
  for (const agents of [AGENTS, wide]) {
    const sc = S.scene(young(), agents, { usage: { pct: 0 } }), arc = sc.arc, h = sc.home, at = (p) => S.sunAt(p, arc);
    const [a, m, b] = [at(0), at(47.5), at(95)];
    assert.equal(arc.s, Math.max(1, sc.L.width / S.SUN.per), 'the sun grows with the farm\'s width');
    assert.deepEqual(arc, S.sunArc(sc.L, S.SCALE * (young().height || 0)));
    assert.ok(a.x - arc.reach - h.x0 >= S.SUN.margin && h.x1 - b.x - arc.reach >= S.SUN.margin - 1e-9, 'near the edges, clear of the height scale');
    assert.ok(Math.abs(m.x - (h.x0 + h.x1) / 2) < 1e-9 && Math.abs(a.y - b.y) < 1e-9 && m.y < a.y - 10, 'low at both ends, highest in the middle');
    assert.ok(at(20).x < at(40).x && at(20).y > m.y && at(70).y < b.y, 'x moves right, y rises then falls');
    assert.deepEqual(at(120), b, 'past 95% it stays set');
    for (const [pct, p] of [[0, a], [47.5, m], [95, b]]) {
      assert.ok(p.y - arc.gap - arc.font >= h.y0, `${pct}%: its label inside the default view`);
      assert.ok(p.y + arc.reach <= sc.L.surface - S.SUN.ground + 1e-9, `${pct}%: clear of the anthills`);
    }
  }
  const day = S.scene(young(), AGENTS, { usage: { pct: 26.4, held: false } });
  assert.doesNotMatch(day.svg, /class="scene night"|nightshade|class="moon"|class="lamp"/);
  const c = S.sunAt(26.4, day.arc);
  assert.match(day.svg, new RegExp(`<g class="sun"><g [^>]*>.*<circle cx="${Math.round(c.x * 100) / 100}" cy="${Math.round(c.y * 100) / 100}"`));
  assert.match(day.svg, /<text class="sunlabel"[^>]*>26%<\/text>/);
  assert.match(day.svg, /<g class="hits">.*data-k="sky"/);
  // The sun and its label are drawn over the tree and the farm, so neither hides it.
  const i = (x) => day.svg.indexOf(x);
  assert.ok(i('<g class="sun">') > i('<g class="farm">') && i('<g class="sun">') > i('<g class="tree"') && i('sunlabel') > i('<g class="sun">'));
  assert.match(S.scene(young(), AGENTS, { usage: { pct: 40, stale: true } }).svg, /sunlabel[^>]*opacity="0.45">40%\?</);
  assert.doesNotMatch(S.scene(young(), AGENTS).svg, /class="sun"|data-k="sky"/, 'no usage figure: no sun');
});

test('night when held, and at 95% with the guard overridden; the lamp when overridden or an Urgent message woke a session', () => {
  assert.deepEqual(S.skyOf({ pct: 50 }), { night: false, lamp: false, held: false, woken: [] });
  assert.deepEqual(S.skyOf({ pct: 94.9, override: true }), { night: false, lamp: false, held: false, woken: [] });
  assert.deepEqual(S.skyOf({ pct: 95, held: true }), { night: true, lamp: false, held: true, woken: [] });
  assert.deepEqual(S.skyOf({ pct: 97, held: false, override: true }), { night: true, lamp: true, held: false, woken: [] });
  assert.deepEqual(S.skyOf({ pct: 95, held: true, woken: ['HIGH-a'] }), { night: true, lamp: true, held: true, woken: ['HIGH-a'] });
  const held = S.scene(young(), AGENTS, { usage: { pct: 95, held: true } });
  assert.match(held.svg, /class="scene night"/);
  assert.doesNotMatch(held.svg, /class="sun"|class="lamp"|lampmask/);
  assert.match(held.svg, /<g class="hits">.*data-k="sky"/, 'the moon is a tap target');
  // Overridden at 97%: night, stars and the moon, a lamp over LOOP's pile lifting the shade around it; nobody asleep.
  const lit = S.scene(young(), AGENTS, { usage: { pct: 97, override: true } });
  assert.match(lit.svg, /class="scene night"/);
  assert.match(lit.svg, /class="stars"/);
  assert.match(lit.svg, /class="moon"/);
  assert.match(lit.svg, /<g class="lamp">/);
  assert.match(lit.svg, /class="nightshade"[^>]*mask="url\(#lampmask\)"/);
  assert.match(lit.svg, /<mask id="lampmask"[^>]*>.*fill="url\(#lamphole\)"/);
  assert.ok(lit.svg.indexOf('nightshade') < lit.svg.indexOf('<g class="lamp">'), 'the bulb over the shade');
  assert.doesNotMatch(lit.svg, /class="zz"|data-still/);
  assert.match(lit.svg, /at night \(over the weekly limit, a lamp lit\)/);
  // Held, an Urgent message woke HIGH-a: the lamp too, and the other anthills asleep.
  const woke = S.scene(young(), AGENTS, { usage: { pct: 96, held: true, woken: ['HIGH-a'] } });
  assert.match(woke.svg, /<g class="lamp">/);
  assert.match(woke.svg, /class="zz"/);
});

test("LOOP's food pile is the tasks queued for the agents: gone with none, higher with more, full at FOOD_FULL", () => {
  const H = require('../anthills.js');
  assert.equal(H.FOOD_FULL, 15);
  assert.equal(H.foodSize(null), 0);
  assert.equal(H.foodSize({ total: 0, per_session: {} }), 0);
  assert.equal(H.foodSize({ total: 6 }), 6 / 15);
  assert.equal(H.foodSize({ total: 40 }), 1);
  const fruit = (food) => (S.scene(young(), AGENTS, { food }).svg.match(/fill="#(c8553d|e39a3b|9a3d2c)"/g) || []).length;
  const n = [0, 3, 8, 15, 30].map((k) => fruit({ total: k }));
  assert.equal(n[0], 0, 'nothing queued: no pile');
  assert.ok(n[0] < n[1] && n[1] < n[2] && n[2] < n[3] && n[3] === n[4], `the pile grows with the count, full at 15 ${n}`);
  assert.equal(fruit(null), 0, 'no figure: no pile');
});

test('a bird flies down onto its crown node as its deadline nears, never near the ground (Finbar 2026-11-27)', () => {
  const due = (id, deadline) => ({ id, kind: 'task', created: '2026-12-01T09:00:00', deadline, title: id });
  for (const history of [EX.history(30).entries, EX.history(2 * 365).entries]) {        // a small tree and a grown one
    const st = G.derive([...history, due('soon', '2026-12-20')], {}, {}, NOW);
    const sc = S.scene(st, AGENTS);
    const top = Math.min(0, sc.tree.y0, sc.arc.top - 1) - S.BIRD_ROOM;
    const k = G.treeScale(st), lowest = Math.max(...G.layout(st).birds.map((b) => sc.L.surface - S.SCALE * k * b.y));
    const at = (days) => S.birds({ ...st, birds: st.birds.map((b) => ({ ...b, days })) }, sc.L, sc.L.gap.cx, top).find((b) => b.id === 'soon');
    const path = [45, 14, 3, 0].map(at);
    const dist = path.map((b) => Math.hypot(b.x - b.land.x, b.y - b.land.y));
    for (let i = 1; i < dist.length; i++) assert.ok(dist[i] < dist[i - 1], `closer each step ${dist}`);
    assert.ok(path.every((b) => b.y < b.land.y && b.y <= lowest && b.y < sc.L.surface - 6), 'above its node and the crown, never near the ground');
    assert.ok(path.every((b) => b.y >= top - 1e-9 && b.x >= S.BIRD_EDGE - 1e-9 && b.x <= sc.L.width - S.BIRD_EDGE + 1e-9), 'inside the sky');
    assert.ok(path[0].size === S.BIRD_SMALL && path[0].y < path[3].y, 'a far one is small and high');
    assert.ok(new Set(path.map((b) => `${b.land.x},${b.land.y}`)).size === 1, 'one node all the way');
  }
});

test('the sun peaks 5 m above the top of the tree, small or grown, its label clear of the crown', () => {
  for (const st of [young(), grown(30), grown(2 * 365)]) {
    const sc = S.scene(st, AGENTS, { usage: { pct: 47.5 } }), top = sc.L.surface - S.SCALE * st.height;
    const m = S.sunAt(47.5, sc.arc);
    assert.ok(Math.abs(m.y - Math.min(sc.arc.low - S.SUN.lift, top - 5 * S.SCALE)) < 1e-9, `${st.height} m: the peak 5 m over the tree`);
    if (st.height > 1) assert.ok(Math.abs(m.y - (top - 5 * S.SCALE)) < 1e-9);
    assert.ok(m.y + sc.arc.reach < top, 'clear of the crown');
    if (sc.arc.top - 1 >= sc.L.surface - S.HOME_MAX) assert.ok(m.y - sc.arc.gap - sc.arc.font >= sc.home.y0, 'its label inside the default view');
    assert.ok(S.sunAt(0, sc.arc).y === sc.arc.low && S.sunAt(95, sc.arc).y === sc.arc.low, '0% and 95% stay low');
  }
});
