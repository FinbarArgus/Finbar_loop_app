// Unit tests for anthills.js: node --test tests/anthills.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../anthills.js');

const ag = (name, state = 'working', extra = {}) => ({ name, state, running: true, ...extra });
const AGENTS = [ag('LOOP', 'working', { loop: true }), ag('HIGH-a'), ag('HIGH-b', 'blocked', { items: ['Q-0001'] }),
  ag('MED-c', 'stalled', { running: false }), ag('LOW-d'), ag('IMPLEMENT-e'), ag('cam-session'), ag('MED-f', 'working', { running: false })];

test('size by priority: LOOP the queen, HIGH large, MED medium, LOW small, IMPLEMENT and others medium-small', () => {
  assert.deepEqual(AGENTS.map((a) => H.sizeOf(a)), ['queen', 'large', 'large', 'medium', 'small', 'medium-small', 'medium-small', 'medium']);
  assert.equal(H.sizeOf({ name: 'LOOP' }), 'queen');
  assert.equal(H.sizeOf({ name: 'high-lower-case' }), 'large');
  const w = (s) => H.SIZES[s][0];
  assert.ok(w('queen') > w('large') && w('large') > w('medium') && w('medium') > w('medium-small') && w('medium-small') > w('small'));
});

test('blocked gets a rock and no ants; working gets ants; stalled or stopped is quiet with no ants', () => {
  const L = H.layout(AGENTS, { width: 96 });
  const by = new Map(L.hills.map((h) => [h.name, h]));
  assert.equal(by.get('HIGH-b').mood, 'blocked');
  assert.ok(by.get('HIGH-b').rock && by.get('HIGH-b').ants === 0);
  assert.ok(!by.get('HIGH-a').rock && by.get('HIGH-a').ants === H.ANTS.large);
  for (const n of ['MED-c', 'MED-f']) {                     // stalled, and working but not running
    assert.equal(by.get(n).mood, 'quiet');
    assert.ok(!by.get(n).rock && by.get(n).ants === 0);
  }
  const svg = H.svg(AGENTS, { width: 96 });
  assert.equal((svg.match(/class="ant"/g) || []).length, L.hills.reduce((s, h) => s + h.ants, 0));
  assert.match(svg, /fill="#686a66"/);                     // the rock's rim
  assert.doesNotMatch(H.svg(AGENTS.filter((a) => a.state !== 'blocked'), { width: 96 }), /fill="#686a66"/);
});

test('the same name always gives the same design; names give varied designs', () => {
  assert.deepEqual(H.design('HIGH-a'), H.design('HIGH-a'));
  assert.equal(H.svg(AGENTS, { width: 80, t: 2 }), H.svg(AGENTS, { width: 80, t: 2 }));
  const ds = Array.from({ length: 40 }, (_, i) => H.design(`agent-${i}`));
  assert.ok(new Set(ds.map((d) => d.shape)).size >= 4, 'shapes vary');
  assert.ok(new Set(ds.map((d) => d.soil)).size >= 3, 'soils vary');
  // a hill's design does not depend on who else is in the meadow
  const one = H.layout([ag('HIGH-a')]).hills[0].design;
  assert.deepEqual(one, H.layout(AGENTS).hills.find((h) => h.name === 'HIGH-a').design);
});

test('layout: queen first, by priority then blocked-working-quiet; every hill inside the width, none overlapping', () => {
  for (const width of [48, 64, 96]) {
    const many = [...AGENTS, ...Array.from({ length: 12 }, (_, i) => ag(`MED-x${i}`, ['working', 'blocked', 'stalled'][i % 3]))];
    const L = H.layout(many, { width });
    assert.equal(L.hills[0].name, 'LOOP');
    const order = ['queen', 'large', 'medium', 'medium-small', 'small'];
    L.hills.forEach((h, i) => { if (i) assert.ok(order.indexOf(h.size) >= order.indexOf(L.hills[i - 1].size)); });
    const meds = L.hills.filter((h) => h.size === 'medium').map((h) => h.mood);
    assert.deepEqual(meds, [...meds].sort((a, b) => ['blocked', 'working', 'quiet'].indexOf(a) - ['blocked', 'working', 'quiet'].indexOf(b)));
    for (const h of L.hills) assert.ok(h.x0 >= 0 && h.x0 + h.w <= width && h.base < L.height, `${h.name} at ${width}`);
    for (const a of L.hills) for (const b of L.hills) {
      if (a !== b && a.base === b.base) assert.ok(a.x0 + a.w <= b.x0 || b.x0 + b.w <= a.x0, `${a.name} overlaps ${b.name}`);
    }
  }
});

test('ants walk their hill\'s trail out and back, evenly spaced, the same at the same time', () => {
  const hl = H.layout(AGENTS, { width: 96 }).hills.find((h) => h.name === 'HIGH-a');
  const [e, edge, end] = hl.trail;
  assert.ok(e.y < edge.y, 'the trail starts up on the mound');
  const near = (p) => {                                       // distance from the trail polyline
    const seg = (a, b) => {
      const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l));
      return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
    };
    return Math.min(seg(e, edge), seg(edge, end));
  };
  for (let t = 0; t < 20; t += 0.37) for (let k = 0; k < hl.ants; k++) assert.ok(near(H.antAt(hl, k, t)) < 1e-9);
  assert.deepEqual(H.antAt(hl, 1, 3.3), H.antAt(hl, 1, 3.3));
  // ant 0 leaves the entrance at t0 and reaches the crumb half a round later
  const len = Math.hypot(edge.x - e.x, edge.y - e.y) + Math.hypot(end.x - edge.x, end.y - edge.y);
  const t0 = (-0.25 / hl.ants) * (2 * len) / H.SPEED;
  const p0 = H.antAt(hl, 0, t0), half = H.antAt(hl, 0, t0 + len / H.SPEED);
  assert.ok(Math.hypot(p0.x - e.x, p0.y - e.y) < 1e-9 && Math.hypot(half.x - end.x, half.y - end.y) < 1e-9);
  const xs = new Set(Array.from({ length: hl.ants }, (_, k) => H.antAt(hl, k, 0).x.toFixed(3)));
  assert.equal(xs.size, hl.ants, 'ants spread along the trail');
});

test('names are escaped and shortened; the mini meadow has no text or tap targets', () => {
  const svg = H.svg([ag('<b>&"x')], { width: 48 });
  assert.ok(svg.includes('&lt;b&gt;&amp;&quot;x') && !svg.includes('<b>'));
  const long = H.layout([ag('MED-READ-Lung model CPAP calibration pipeline')]).hills[0];
  assert.ok(H.label(long).endsWith('…') && H.label(long).length < long.name.length);
  const mini = H.svg(AGENTS, { width: 48, mini: true });
  assert.doesNotMatch(mini, /<text|data-k="hill"/);
  assert.match(H.svg(AGENTS, { width: 48 }), /data-k="hill" data-i="0"/);
  assert.match(H.svg([], { width: 48 }), /<svg/);
});
