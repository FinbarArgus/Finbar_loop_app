// Unit tests for anthills.js (the ant farm): node --test tests/anthills.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../anthills.js');

const ag = (name, state = 'working', tokens = null, extra = {}) =>
  ({ name, state, running: true, ...(tokens == null ? {} : { week_tokens: { total: tokens } }), ...extra });
const AGENTS = [ag('LOOP', 'working', 9e6, { loop: true }), ag('HIGH-a', 'working', 2.5e7), ag('HIGH-b', 'blocked', 4e6, { items: ['Q-0001'] }),
  ag('MED-c', 'stalled', 3e5, { running: false }), ag('LOW-d', 'working', 1e6), ag('IMPLEMENT-e', 'working', 1.2e7), ag('cam-session', 'working', 2e5),
  ag('MED-f', 'working', 5e4, { running: false })];
const MSGS = {
  messages: [
    { at: '2026-11-23T01:00:00Z', from: 'LOOP', to: 'HIGH-a', text: 'first' },
    { at: '2026-11-23T02:00:00Z', from: 'HIGH-a', to: 'LOOP', text: 'second' },
    { at: '2026-11-23T03:00:00Z', from: 'LOOP', to: 'HIGH-a', text: 'third' },
    { at: '2026-11-23T04:00:00Z', from: 'ghost-agent', to: 'IMPLEMENT-e', text: 'from a session not in the status' }],
  pairs: [{ a: 'HIGH-a', b: 'LOOP', count: 3, last: '2026-11-23T03:00:00Z' },
    { a: 'IMPLEMENT-e', b: 'ghost-agent', count: 1, last: '2026-11-23T04:00:00Z' },
    { a: 'HIGH-a', b: 'IMPLEMENT-e', count: 6, last: '2026-11-23T04:00:00Z' },
    { a: 'LOW-d', b: 'cam-session', count: 2, last: '2026-11-23T04:00:00Z' },
    { a: 'LOOP', b: 'LOOP', count: 2, last: '2026-11-23T04:00:00Z' }],          // never a path to itself
};
const many = (n) => [...AGENTS, ...Array.from({ length: n }, (_, i) => ag(`MED-x${i}`, ['working', 'blocked', 'stalled'][i % 3], (i + 1) * 7e5))];
const inBox = (p, b, pad = 0) => p.x > b.x0 - pad && p.x < b.x0 + b.w + pad && p.y > b.y0 - pad && p.y < b.y0 + b.h + pad;
const along = (pts, step = 0.25) => pts.slice(1).flatMap((b, k) => {
  const a = pts[k], n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
  return Array.from({ length: n + 1 }, (_, m) => ({ x: a.x + (b.x - a.x) * m / n, y: a.y + (b.y - a.y) * m / n }));
});

test('roles set the lights: HIGH, MED, LOW, IMPLEMENT and other each their own colour; LOOP is the food', () => {
  assert.deepEqual(AGENTS.map((a) => H.roleOf(a)), ['loop', 'high', 'high', 'med', 'low', 'implement', 'other', 'med']);
  assert.equal(H.roleOf({ name: 'git-projects-2b' }), 'other');
  assert.equal(H.roleOf({ name: 'IMPLEMENTER' }), 'other');             // the prefix, with its dash
  assert.equal(new Set(['high', 'med', 'low', 'implement', 'other'].map((r) => H.LIGHTS[r])).size, 5);
  // IMPLEMENT is blue and ranks between HIGH and MED.
  assert.equal(H.LIGHTS.implement, '#3f8fe0');
  assert.deepEqual(H.ROLE_ORDER, ['loop', 'high', 'implement', 'med', 'low', 'other']);
  const big = H.layout([{ name: 'IMPLEMENT-a', state: 'working', running: true }, { name: 'HIGH-b', state: 'working', running: true },
    { name: 'HIGH-c', state: 'blocked', running: true }, { name: 'IMPLEMENT-d', state: 'blocked', running: true }]);
  assert.deepEqual(big.hills.map((h) => h.name), ['HIGH-c', 'HIGH-b', 'IMPLEMENT-d', 'IMPLEMENT-a']);   // by role, then mood
  const L = H.layout(AGENTS);
  assert.deepEqual(L.hills.filter((h) => h.kind === 'food').map((h) => h.name), ['LOOP']);
  const svg = H.svg(AGENTS);
  for (const r of ['high', 'low', 'implement', 'other']) assert.match(svg, new RegExp(`class="glow" data-role="${r}"[^>]*fill="${H.LIGHTS[r]}"`));
  // stalled homes have their lights off: no glow, and grey bulbs
  assert.doesNotMatch(svg, /data-role="med"/);                           // both MED sessions are quiet
});

test('one anthill per session, its shaft down to its own anthome; homes never overlap; shafts pass no other home', () => {
  for (const n of [0, 5, 12]) {
    const L = H.layout(many(n), { messages: MSGS });
    const homes = L.hills.filter((h) => h.kind === 'home');
    assert.equal(new Set(homes.map((h) => h.x)).size, homes.length, 'one column each');
    for (const h of homes) {
      assert.ok(h.shaft[0].y < L.surface && Math.abs(h.shaft[0].x - h.x) < 1e-9, `${h.name} starts at its anthill`);
      const end = h.shaft.at(-1);
      assert.ok(inBox(end, h.home, 0.01), `${h.name} ends in its home`);
      assert.ok(h.home.x0 >= 0 && h.home.x0 + h.home.w <= L.width && h.home.y0 > L.surface && h.home.y0 + h.home.h < L.gallery);
      for (const o of homes) {
        if (o === h) continue;
        const a = h.home, b = o.home;
        assert.ok(a.x0 + a.w + 1 <= b.x0 || b.x0 + b.w + 1 <= a.x0 || a.y0 + a.h + 1 <= b.y0 || b.y0 + b.h + 1 <= a.y0, `${h.name} overlaps ${o.name}`);
        for (const p of along(h.shaft)) assert.ok(!inBox(p, o.home, 1.75), `${h.name}'s shaft passes ${o.name}`);
      }
    }
  }
});

test('home size follows tokens since the weekly reset (area as tokens, width as sqrt); small ones stay visible', () => {
  const L = H.layout(AGENTS);
  const by = new Map(L.hills.map((h) => [h.name, h]));
  const w = (n) => by.get(n).home.w;
  assert.ok(w('HIGH-a') > w('IMPLEMENT-e') && w('IMPLEMENT-e') > w('HIGH-b') && w('HIGH-b') > w('cam-session'));
  assert.ok(w('HIGH-a') >= 15 && w('MED-f') >= 7, `${w('HIGH-a')} ${w('MED-f')}`);
  assert.ok(w('LOW-d') > w('MED-f'), 'a low-priority session with more tokens has the bigger home');
  assert.equal(by.get('HIGH-a').tokens, 2.5e7);
  const none = H.layout([ag('HIGH-z'), ag('LOW-z')]).hills;                // no token figures: one middle size
  assert.equal(none[0].home.w, none[1].home.w);
  assert.equal(none[0].tokens, null);
});

test('blocked: a rock on its anthill and no ants; working: ants; stalled or stopped: quiet, no ants', () => {
  const L = H.layout(AGENTS);
  const by = new Map(L.hills.map((h) => [h.name, h]));
  assert.ok(by.get('HIGH-b').rock && by.get('HIGH-b').ants === 0);
  assert.ok(!by.get('HIGH-a').rock && by.get('HIGH-a').ants === H.ANTS.large);
  for (const n of ['MED-c', 'MED-f']) assert.ok(by.get(n).mood === 'quiet' && by.get(n).ants === 0);
  const svg = H.svg(AGENTS);
  assert.equal((svg.match(/class="ant"/g) || []).length, L.hills.reduce((s, h) => s + h.ants, 0));
  assert.match(svg, /fill="#686a66"/);                                   // the rock's rim
  assert.doesNotMatch(H.svg(AGENTS.filter((a) => a.state !== 'blocked')), /fill="#686a66"/);
});

test('every anthome looks different, and the same name always looks the same', () => {
  assert.deepEqual(H.design('HIGH-a'), H.design('HIGH-a'));
  assert.equal(H.svg(AGENTS, { t: 2, messages: MSGS }), H.svg(AGENTS, { t: 2, messages: MSGS }));
  const ds = Array.from({ length: 40 }, (_, i) => H.design(`agent-${i}`));
  assert.ok(new Set(ds.map((d) => d.shape)).size >= 4, 'shapes vary');
  assert.ok(new Set(ds.flatMap((d) => d.contents)).size >= 5, 'contents vary');
  assert.ok(new Set(ds.map((d) => d.lights)).size >= 3, 'number of lights varies');
  assert.equal(new Set(ds.map((d) => JSON.stringify([d.shape, d.contents, d.lights, d.soil, d.dw, d.dh]))).size >= 30, true, 'nearly all distinct');
  const one = H.layout([ag('HIGH-a')]).hills[0].design;                    // independent of who else is there
  assert.deepEqual(one, H.layout(AGENTS).hills.find((h) => h.name === 'HIGH-a').design);
});

test('tunnels: one per pair that messaged; between homes underground through the gallery, with LOOP up to the food', () => {
  const L = H.layout(AGENTS, { messages: MSGS });
  const ghost = L.hills.find((h) => h.name === 'ghost-agent');
  assert.ok(ghost && ghost.mood === 'quiet' && ghost.agent.ghost && ghost.kind === 'home');
  assert.equal(L.paths.length, 4);
  const toLoop = L.paths.find((x) => x.b === 'LOOP');
  assert.deepEqual([toLoop.count, toLoop.ab, toLoop.ba, toLoop.ants], [3, 1, 2, 3]);
  assert.deepEqual(toLoop.msgs.map((m) => m.text), ['third', 'second', 'first']);
  const A = L.hills.find((h) => h.name === 'HIGH-a');
  assert.ok(inBox(toLoop.trail[0], A.home) && toLoop.toFood);
  const end = toLoop.trail.at(-1);
  assert.ok(Math.abs(end.y - (L.surface - 0.5)) < 1e-9 && end.x >= L.food.x0 - 1e-9 && end.x <= L.food.x0 + L.food.w + 1e-9, 'ends at the food');
  const homes = L.hills.filter((h) => h.kind === 'home');
  for (const pa of L.paths.filter((x) => !x.toFood)) {
    const a = homes.find((h) => h.name === pa.a), b = homes.find((h) => h.name === pa.b);
    assert.ok(inBox(pa.trail[0], a.home) && inBox(pa.trail.at(-1), b.home), `${pa.a}-${pa.b} joins the two homes`);
    for (const p of along(pa.trail)) {
      assert.ok(p.y > L.surface, 'underground');
      for (const o of homes) if (o !== a && o !== b) assert.ok(!inBox(p, o.home, pa.w / 2 + 0.5), `${pa.a}-${pa.b} cuts through ${o.name}`);
    }
  }
  const svg = H.svg(AGENTS, { messages: MSGS });
  assert.equal((svg.match(/data-k="path"/g) || []).length, 4);
  assert.equal((svg.match(/class="ant" data-p=/g) || []).length, 3 + 1 + 6 + 2);
  assert.doesNotMatch(H.svg(AGENTS, { messages: MSGS, mini: true }), /data-k=/);
});

test('tunnel width: one block for one message, growing as sqrt, at most three', () => {
  assert.equal(H.pathWidth(1), 1);
  for (let n = 1; n < 60; n++) assert.ok(H.pathWidth(n + 1) >= H.pathWidth(n));
  assert.equal(H.pathWidth(1000), 3);
});

test('each anthome holds food, a tap target of its own inside the home; the home is another', () => {
  const L = H.layout(AGENTS);
  const svg = H.svg(AGENTS);
  L.hills.forEach((h, i) => {
    assert.match(svg, new RegExp(`<g data-k="hill" data-i="${i}">`));
    if (h.kind !== 'home') return;
    assert.ok(inBox({ x: h.food.x0 + h.food.w / 2, y: h.food.y0 + h.food.h / 2 }, h.home), `${h.name}'s food is in its home`);
    assert.match(svg, new RegExp(`<rect data-k="food" data-i="${i}"`));
  });
  assert.ok(svg.indexOf('data-k="food"') > svg.lastIndexOf('data-k="hill"'), 'the food is above the home, so hovering it picks the food');
});

test('ants are small and turn to face where they walk, never upside down', () => {
  assert.ok(H.SCALE <= 0.8);
  const hl = H.layout(AGENTS).hills.find((h) => h.name === 'HIGH-a');
  const pts = hl.trail;
  for (let t = 0; t < 20; t += 0.37) {
    for (let k = 0; k < hl.ants; k++) {
      const p = H.antAt(hl, k, t);
      const near = pts.slice(1).some((b, i) => {
        const a = pts[i], dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy || 1;
        const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l));
        return Math.hypot(p.x - a.x - u * dx, p.y - a.y - u * dy) < 1e-9;
      });
      assert.ok(near, 'on its trail');
    }
  }
  const pose = (ang) => H.antPose({ x: 1, y: 2, ang });
  assert.match(pose(0), /rotate\(0\) scale\(0\.75 0\.75\)/);
  assert.match(pose(Math.PI), /rotate\(0\) scale\(-0\.75 0\.75\)/);      // heading left: mirrored, upright
  assert.match(pose(Math.PI / 2), /rotate\(90\) scale\(0\.75/);           // down a shaft
  assert.match(pose(-Math.PI / 2), /rotate\(-90\) scale\(0\.75/);         // up a shaft
});

test('names are escaped and shortened; the mini farm has no text or tap targets', () => {
  const svg = H.svg([ag('<b>&"x')]);
  assert.ok(svg.includes('&lt;b&gt;&amp;&quot;x') && !svg.includes('<b>'));
  const long = H.layout([ag('MED-READ-Lung model CPAP calibration pipeline')]).hills[0];
  assert.ok(H.label(long).endsWith('…') && H.label(long).length < long.name.length);
  assert.doesNotMatch(H.svg(AGENTS, { mini: true }), /<text|data-k="hill"/);
  assert.match(H.svg([], {}), /<svg/);
});

test('the maintainer is a dung beetle in the gallery under the hill it works with, not an anthill, with no tunnels', () => {
  const B = 'Maintenance-Dung-Beetle';
  const agents = [...AGENTS, ag(B, 'working', 3e6)];
  const msgs = { ...MSGS, pairs: [...MSGS.pairs, { a: B, b: 'MED-c', count: 4, last: '2026-11-23T05:00:00Z' }] };
  const at = (where) => H.layout(agents, { messages: msgs, maintainer: { name: B, at: where, why: 'stuck dialog', since: '2026-11-23T05:00:00Z', source: 'said' } });
  const L = at('MED-c');
  assert.ok(!L.hills.some((h) => h.name === B), 'no anthill');
  assert.ok(!L.paths.some((p) => p.a === B || p.b === B), 'no tunnels');
  const n = L.hills.findIndex((h) => h.name === 'MED-c');
  assert.equal(L.beetle.hill, n);
  assert.equal(L.beetle.x, L.hills[n].x);
  assert.ok(L.beetle.y > L.gallery && L.beetle.y < L.height, 'underground, below the homes');
  assert.equal(L.beetle.agent.state, 'working', 'its status row, for the tap');
  assert.deepEqual([L.beetle.at, L.beetle.why, L.beetle.source], ['MED-c', 'stuck dialog', 'said']);
  for (const where of ['LOOP', 'no-such-session']) {                    // at LOOP, or a session not in the farm: under LOOP's pile
    const M = at(where);
    assert.equal(M.beetle.x, M.food.cx);
    assert.equal(M.hills[M.beetle.hill].kind, 'food');
  }
  assert.ok(H.layout(agents, { messages: msgs }).hills.some((h) => h.name === B) && !H.layout(agents).beetle, 'without usage.maintainer, an anthill as before');
  const s = H.svg(agents, { messages: msgs, maintainer: { name: B, at: 'MED-c' } });
  assert.match(s, new RegExp(`<g class="beetle" data-x="${L.beetle.x}" `));
  assert.match(s, /data-k="beetle"/);
  assert.doesNotMatch(H.svg(agents, { mini: true, maintainer: { name: B, at: 'MED-c' } }), /data-k="beetle"/, 'no tap target in the mini farm');
  const wide = H.layout(many(40), { maintainer: { name: B, at: 'MED-x3' } });
  assert.ok(wide.beetle.k > 1 && Math.abs(wide.beetle.k - wide.width / 100) < 1e-9, 'it grows with the farm');
});

test('opts.gap leaves open surface to the right of the food: the right-hand anthills move over, the farm widens', () => {
  const a = H.layout(AGENTS), b = H.layout(AGENTS, { gap: 14 });
  assert.equal(a.gap, null);
  assert.equal(b.width, a.width + 14);
  assert.deepEqual(b.food, a.food);
  const xs = (L) => Object.fromEntries(L.hills.filter((h) => h.kind === 'home').map((h) => [h.name, h.x]));
  const [xa, xb] = [xs(a), xs(b)];
  for (const n of Object.keys(xa)) assert.equal(xb[n], xa[n] + (xa[n] > a.food.cx ? 14 : 0), n);
  assert.deepEqual(b.gap, { x0: a.food.cx + 10, x1: a.food.cx + 24, cx: a.food.cx + 17 });
  const right = Math.min(...b.hills.filter((h) => h.kind === 'home' && h.x > b.food.cx).map((h) => h.mound.x0));
  assert.ok(b.gap.x0 >= b.food.x0 + b.food.w && b.gap.x1 <= right, 'the gap is open surface');
});
