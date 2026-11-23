// Unit tests for anthills.js: node --test tests/anthills.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../anthills.js');

const ag = (name, state = 'working', extra = {}) => ({ name, state, running: true, ...extra });
const AGENTS = [ag('LOOP', 'working', { loop: true }), ag('HIGH-a'), ag('HIGH-b', 'blocked', { items: ['Q-0001'] }),
  ag('MED-c', 'stalled', { running: false }), ag('LOW-d'), ag('IMPLEMENT-e'), ag('cam-session'), ag('MED-f', 'working', { running: false })];

test('size by priority: LOOP the queen, HIGH and IMPLEMENT large, MED medium, LOW small, others medium-small', () => {
  assert.deepEqual(AGENTS.map((a) => H.sizeOf(a)), ['queen', 'large', 'large', 'medium', 'small', 'large', 'medium-small', 'medium']);
  assert.equal(H.sizeOf({ name: 'LOOP' }), 'queen');
  assert.equal(H.sizeOf({ name: 'high-lower-case' }), 'large');
  assert.equal(H.sizeOf({ name: 'IMPLEMENT-loop-app' }), 'large');
  assert.equal(H.sizeOf({ name: 'IMPLEMENTER' }), 'medium-small');     // the prefix, with its dash
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

test('layers: LOOP alone at the back, IMPLEMENT- in front, every other session in the middle', () => {
  assert.equal(H.layerOf({ name: 'LOOP' }), 'back');
  assert.equal(H.layerOf({ name: 'anything', loop: true }), 'back');
  for (const n of ['IMPLEMENT-loop-app', 'implement-x']) assert.equal(H.layerOf({ name: n }), 'front');
  for (const n of ['HIGH-a', 'MED-READ-lung', 'LOW-x', 'git-projects-2b', 'cam-session', 'IMPLEMENTER', 'paper_summary']) {
    assert.equal(H.layerOf({ name: n }), 'middle', n);
  }
});

test('rows of depth: back above middle above front; size by priority, a little smaller further back', () => {
  for (const width of [48, 96]) {
    const many = [...AGENTS, ag('IMPLEMENT-f'), ...Array.from({ length: 6 }, (_, i) => ag(`MED-x${i}`))];
    const L = H.layout(many, { width });
    const bases = (ly) => L.hills.filter((h) => h.layer === ly).map((h) => h.base);
    assert.deepEqual(L.hills.filter((h) => h.layer === 'back').map((h) => h.name), ['LOOP']);
    assert.ok(Math.max(...bases('back')) < Math.min(...bases('middle')), `back above middle at ${width}`);
    assert.ok(Math.max(...bases('middle')) < Math.min(...bases('front')), `middle above front at ${width}`);
    assert.deepEqual(L.rows.map((r) => r.layer), [...L.rows.map((r) => r.layer)].sort((a, b) => H.LAYERS.indexOf(a) - H.LAYERS.indexOf(b)));
  }
  const by = new Map(H.layout(AGENTS, { width: 96 }).hills.map((h) => [h.name, h]));
  assert.equal(by.get('IMPLEMENT-e').w, H.SIZES.large[0]);                          // front: full size
  assert.equal(by.get('HIGH-a').w, Math.round(H.SIZES.large[0] * H.DEPTH.middle));    // middle: a little smaller
  assert.equal(by.get('LOOP').w, Math.round(H.SIZES.queen[0] * H.DEPTH.back));
  assert.ok(by.get('HIGH-a').w > by.get('MED-c').w && by.get('MED-c').w > by.get('LOW-d').w, 'priority still sets size');
  assert.ok(H.DEPTH.back < H.DEPTH.middle && H.DEPTH.middle < H.DEPTH.front);
});

test('fit: the width chosen draws the meadow largest in the box, at phone and computer shapes', () => {
  const many = [...AGENTS, ag('IMPLEMENT-f'), ag('IMPLEMENT-g'), ...Array.from({ length: 9 }, (_, i) => ag(`MED-x${i}`))];
  for (const fit of [{ w: 358, h: 560 }, { w: 594, h: 620 }, { w: 1000, h: 400 }]) {
    const L = H.layout(many, { fit });
    const scale = (Lx) => Math.min(fit.w / Lx.width, fit.h / Lx.height);
    for (const width of [40, 60, 80, 100, 140, 200]) assert.ok(scale(H.layout(many, { width })) <= scale(L) + 1e-9, `${width} vs ${L.width}`);
    for (const h of L.hills) assert.ok(h.x0 >= 0 && h.x0 + h.w <= L.width && h.base < L.height);
  }
});

test('layout: within a layer by priority then blocked-working-quiet; every hill inside the width, none overlapping', () => {
  for (const width of [48, 64, 96]) {
    const many = [...AGENTS, ...Array.from({ length: 12 }, (_, i) => ag(`MED-x${i}`, ['working', 'blocked', 'stalled'][i % 3]))];
    const L = H.layout(many, { width });
    assert.equal(L.hills[0].name, 'LOOP');
    const order = ['queen', 'large', 'medium', 'medium-small', 'small'];
    L.hills.forEach((h, i) => { if (i && h.layer === L.hills[i - 1].layer) assert.ok(order.indexOf(h.size) >= order.indexOf(L.hills[i - 1].size)); });
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

const MSGS = {
  messages: [
    { at: '2026-11-23T01:00:00Z', from: 'LOOP', to: 'HIGH-a', text: 'first' },
    { at: '2026-11-23T02:00:00Z', from: 'HIGH-a', to: 'LOOP', text: 'second' },
    { at: '2026-11-23T03:00:00Z', from: 'LOOP', to: 'HIGH-a', text: 'third' },
    { at: '2026-11-23T04:00:00Z', from: 'ghost-agent', to: 'LOOP', text: 'from a session not in the status' }],
  pairs: [{ a: 'HIGH-a', b: 'LOOP', count: 3, last: '2026-11-23T03:00:00Z' },
    { a: 'LOOP', b: 'ghost-agent', count: 1, last: '2026-11-23T04:00:00Z' },
    { a: 'LOOP', b: 'LOOP', count: 2, last: '2026-11-23T04:00:00Z' }],          // never a path to itself
};

test('path width: one block for one message, growing as sqrt, at most five', () => {
  assert.equal(H.pathWidth(1), 1);
  for (let n = 1; n < 60; n++) assert.ok(H.pathWidth(n + 1) >= H.pathWidth(n));
  assert.ok(H.pathWidth(4) > 2 && H.pathWidth(4) < 3);
  assert.equal(H.pathWidth(50), 5);
  assert.equal(H.pathWidth(1000), 5);
});

test('message paths: one per pair, ants in proportion, messages newest first; agents only in messages are stalled hills', () => {
  const L = H.layout(AGENTS, { width: 96, messages: MSGS });
  const ghost = L.hills.find((h) => h.name === 'ghost-agent');
  assert.ok(ghost && ghost.mood === 'quiet' && ghost.agent.ghost && ghost.ants === 0);
  assert.equal(L.paths.length, 2);
  const pa = L.paths.find((x) => x.a === 'HIGH-a');
  assert.deepEqual([pa.count, pa.ab, pa.ba, pa.ants, pa.w], [3, 1, 2, 3, H.pathWidth(3)]);
  assert.deepEqual(pa.msgs.map((m) => m.text), ['third', 'second', 'first']);
  // ends on the ground beside the two hills, outside them, and ants stay on it
  const A = L.hills.find((h) => h.name === 'HIGH-a'), B = L.hills.find((h) => h.name === 'LOOP');
  const [s, e] = [pa.trail[0], pa.trail.at(-1)];
  assert.ok(Math.abs(s.y - (A.base + 0.5)) < 1e-9 && Math.abs(e.y - (B.base + 0.5)) < 1e-9);
  assert.ok(Math.abs(s.x - A.cx) > A.w / 2 && Math.abs(e.x - B.cx) > B.w / 2);
  for (const p of pa.trail) assert.ok(p.x >= 0 && p.x <= L.width && p.y >= 0 && p.y <= L.height);
  const q = H.antAt(pa, 1, 5.5);
  assert.ok(pa.trail.some((p, i) => i && Math.min(Math.hypot(q.x - p.x, q.y - p.y), Math.hypot(q.x - pa.trail[i - 1].x, q.y - pa.trail[i - 1].y))
    <= Math.hypot(p.x - pa.trail[i - 1].x, p.y - pa.trail[i - 1].y) + 1e-9));
  const svg = H.svg(AGENTS, { width: 96, messages: MSGS });
  assert.equal((svg.match(/data-k="path"/g) || []).length, 2);
  assert.equal((svg.match(/class="ant" data-p=/g) || []).length, 3 + 1);
  assert.match(svg, /fill="#d3c59f"/);                           // dirt
  assert.doesNotMatch(H.svg(AGENTS, { width: 96 }), /data-k="path"|#d3c59f/);
  assert.doesNotMatch(H.svg(AGENTS, { width: 96, messages: MSGS, mini: true }), /data-k=/);
});

test('paths go round the hills: no path, at its full width, crosses any hill, at any width', () => {
  const many = [...AGENTS, ag('IMPLEMENT-f'), ag('IMPLEMENT-g'), ag('git-projects-2b'), ...Array.from({ length: 5 }, (_, i) => ag(`MED-x${i}`))];
  const names = many.map((a) => a.name);
  const pairs = [];
  for (let i = 0; i < names.length; i += 2) for (let j = i + 1; j < names.length; j += 3) pairs.push({ a: names[i], b: names[j], count: 1 + ((i + j) % 9) });
  for (const opts of [{ width: 48 }, { width: 96 }, { fit: { w: 358, h: 560 } }, { fit: { w: 594, h: 620 } }]) {
    const L = H.layout(many, { ...opts, messages: { messages: [], pairs } });
    assert.equal(L.paths.length, pairs.length);
    for (const pa of L.paths) {
      for (let k = 1; k < pa.trail.length; k++) {
        const a = pa.trail[k - 1], b = pa.trail[k];
        assert.ok(a.x === b.x || a.y === b.y, 'paths run along lanes and gaps');
        for (let m = 0; m <= 40; m++) {
          const x = a.x + (b.x - a.x) * m / 40, y = a.y + (b.y - a.y) * m / 40;
          assert.ok(x >= 0 && x <= L.width && y >= 0 && y <= L.height);
          for (const h of L.hills) {
            const dx = Math.max(h.x0 - x, 0, x - (h.x0 + h.w)), dy = Math.max(h.base - h.h - y, 0, y - h.base);
            assert.ok(Math.hypot(dx, dy) >= pa.w / 2 - 1e-9, `${pa.a}-${pa.b} crosses ${h.name} (${JSON.stringify(opts)})`);
          }
        }
      }
    }
  }
});
