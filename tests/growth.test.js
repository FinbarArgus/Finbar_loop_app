// Unit tests of growth.js: node --test tests/   (days are local, so the time zone is fixed here)
process.env.TZ = 'Pacific/Auckland';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../growth.js');
const EX = require('../tools/tree_examples.js');

const read = (id, day, extra = {}) => ({ id, kind: 'read', done: true, created: `${day}T09:00:00`, done_at: `${day}T15:00:00`, ...extra });
const inZ = (name) => ({ zotero: { name } });
const NOW = '2026-12-10T12:00:00';
const W = { id: 'w1', kind: 'write', created: '2026-11-01T09:00:00', doi: '10.1016/J.CMPB.2026.109528' };

test('a paper read counts on the day it was ticked, also when added that day', () => {
  const s = G.derive([read('r1', '2026-12-01'), { id: 'r2', kind: 'read', done: false, created: '2026-12-01T09:00:00' }], {}, {}, NOW);
  assert.deepEqual(s.papers.map((p) => [p.id, p.day]), [['r1', '2026-12-01']]);
  assert.deepEqual(s.goodDays, ['2026-12-01']);
  assert.equal(s.papers[0].mult, 1);                             // the first good day of a streak: 1x
});

test('entries ticked before done_at existed use updated', () => {
  const s = G.derive([{ id: 'r', kind: 'read', done: true, created: '2026-11-01T09:00:00', updated: '2026-11-03T10:00:00' }], {}, {}, NOW);
  assert.equal(s.papers[0].day, '2026-11-03');
});

test('the multiplier grows with the streak of good days: 1, 1.2, 1.4, 1.6, 1.8, 2, then stays at 2', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 9].map(G.multOf), [1, 1, 1.2, 1.4, 1.6, 1.8, 2, 2].map((x) => x));
  const days = Array.from({ length: 7 }, (_, i) => G.addDays('2026-11-20', i));
  const s = G.derive(days.map((d, i) => read(`r${i}`, d)), {}, {}, NOW);
  assert.deepEqual(s.papers.map((p) => Math.round(p.mult * 10) / 10), [1, 1.2, 1.4, 1.6, 1.8, 2, 2]);
  // A day without a paper ends the streak; so does a deadline passing on a reading day.
  const gap = G.derive([read('a', '2026-11-20'), read('b', '2026-11-21'), read('c', '2026-11-23'), read('d', '2026-11-24'),
    { id: 'dl', kind: 'other', deadline: '2026-11-24', done: false, created: '2026-11-01T09:00:00' }, read('e', '2026-11-25'), read('f', '2026-11-26')], {}, {}, NOW);
  assert.deepEqual(gap.papers.map((p) => Math.round(p.mult * 10) / 10), [1, 1.2, 1, 1.2, 1, 1]);   // 11-25 is not good, so 11-26 starts again
  assert.ok(!gap.goodDays.includes('2026-11-25'));                 // dl passed at the end of 11-24
});

test('the streak shown now counts today or yesterday, and resets after a missed day', () => {
  const es = [read('a', '2026-12-07'), read('b', '2026-12-08'), read('c', '2026-12-09')];
  assert.equal(G.derive(es, {}, {}, NOW).streak, 3);
  assert.equal(Math.round(G.derive(es, {}, {}, NOW).mult * 10) / 10, 1.4);
  assert.equal(G.derive(es, {}, {}, '2026-12-11T12:00:00').streak, 0);
});

test('leaves for deadlines met, passed deadlines on the day after', () => {
  const entries = [
    { id: 'met', kind: 'other', deadline: '2026-12-05', done: true, created: '2026-11-20T09:00:00', done_at: '2026-12-05T20:00:00' },
    { id: 'late', kind: 'other', deadline: '2026-12-03', done: true, created: '2026-11-20T09:00:00', done_at: '2026-12-06T09:00:00' },
    { id: 'open', kind: 'write', deadline: '2026-12-07', created: '2026-11-20T09:00:00' },
    { id: 'future', kind: 'other', deadline: '2026-12-20', done: false, created: '2026-11-20T09:00:00' },
    read('a', '2026-12-04', inZ('physiology')), read('b', '2026-12-08'), read('c', '2026-12-09'),
  ];
  const s = G.derive(entries, {}, {}, NOW);
  assert.deepEqual(s.leaves.map((l) => l.id), ['met']);
  assert.deepEqual(s.passed.map((p) => [p.id, p.day]), [['late', '2026-12-04'], ['open', '2026-12-08']]);
  assert.deepEqual(s.goodDays, ['2026-12-09']);
  assert.equal(s.leaves[0].host, 'physiology');                   // on a branch segment that existed then
});

test('a state reached after `now` is not reached yet; an entry made after `now` does not exist yet', () => {
  const e = [{ id: 'x', kind: 'other', deadline: '2026-12-05', done: true, created: '2026-11-20T09:00:00', done_at: '2026-12-20T09:00:00' },
    read('later', '2026-12-15'), { ...W, submitted: true, submitted_at: '2026-12-12T09:00:00' }];
  const s = G.derive(e, {}, {}, NOW);
  assert.equal(s.leaves.length, 0);
  assert.equal(s.passed.length, 1);
  assert.equal(s.papers.length, 0);
  assert.equal(s.creatures.length, 0);
});

test('topic paths: the collection and its parents; _work and no collection grow only the trunk', () => {
  assert.deepEqual(G.topicPath(inZ('physiology / cardiac / valves')),
    ['physiology', 'physiology / cardiac', 'physiology / cardiac / valves']);
  assert.deepEqual(G.topicPath(inZ('_work / papers / cuflynx')), []);
  assert.deepEqual(G.topicPath({}), []);
});

test("each paper grows one segment on its collection's branch, which hangs from its parent collection", () => {
  const es = [read('a', '2026-12-01', inZ('physiology / cardiac / valves')), read('b', '2026-12-02', inZ('physiology / cardiac / valves')),
    read('c', '2026-12-03', inZ('inference')), read('d', '2026-12-04', inZ('_work / grants')), read('e', '2026-12-05')];
  const s = G.derive(es, {}, {}, NOW);
  const ch = new Map(s.chains.map((c) => [c.id, c]));
  assert.deepEqual([...ch.keys()], ['trunk', 'physiology', 'physiology / cardiac', 'physiology / cardiac / valves', 'inference']);
  assert.equal(ch.get('physiology / cardiac / valves').parent, 'physiology / cardiac');
  assert.equal(ch.get('physiology / cardiac').parent, 'physiology');
  assert.equal(ch.get('physiology').parent, 'trunk');
  assert.deepEqual(ch.get('physiology / cardiac / valves').segs.map((g) => g.paper), ['a', 'b']);
  assert.deepEqual(ch.get('physiology').segs.map((g) => g.paper), [null]);      // a stub: no paper of its own yet
  assert.deepEqual(s.papers.map((p) => p.branch), ['physiology / cardiac / valves', 'physiology / cardiac / valves', 'inference', 'trunk', 'trunk']);
  // The segment's length is set by the multiplier (b's day is the 2nd good day in a row: 1.2x).
  const [ga, gb] = ch.get('physiology / cardiac / valves').segs;
  assert.ok(Math.abs(gb.len / ga.len - 1.2 / Math.sqrt(1 + 1 / G.SEG_HALF)) < 1e-12);
  // Every paper also raises the trunk.
  assert.ok(Math.abs(s.height - G.trunkHeight(s.grown)) < 1e-9 || s.height > G.trunkHeight(s.grown));
  assert.equal(ch.get('trunk').segs.filter((g) => g.paper).length, 5);
  // Hover: every paper's segment is a tap target with its entry id and branch; leaves have none.
  const svg = G.svg(s, { hour: 0 });
  for (const id of 'abcde') assert.match(svg, new RegExp(`data-k="seg" data-i="${id}"`));
  assert.match(svg, /data-k="branch" data-i="physiology"/);
  assert.doesNotMatch(svg, /data-k="leaf"/);
});

test('it grows upwards: after five years the tree is taller than it is wide', () => {
  const { entries } = EX.history(5 * 365);
  const s = G.derive(entries, {}, {}, '2031-11-22T12:00:00');
  const xs = s.chains.flatMap((c) => c.segs.flatMap((g) => [g.x0, g.x1]));
  const width = Math.max(...xs) - Math.min(...xs);
  assert.ok(s.height > 1.5 * width, `height ${s.height}, width ${width}`);
  assert.ok(s.chains.every((c) => c.segs.every((g) => g.y1 >= g.y0 - 1e-9)), 'no segment points down');
  // Widths taper (Leonardo's rule): the trunk is widest at the ground and no segment widens towards its tip.
  const trunk = s.chains[0];
  assert.equal(trunk.segs[0].w0, Math.max(...s.chains.flatMap((c) => c.segs.map((g) => g.w0))));
  assert.ok(s.chains.every((c) => c.segs.every((g) => g.w1 <= g.w0 + 1e-12)));
});

test('a height scale is drawn beside the tree, labelled in metres', () => {
  const { entries } = EX.history(365);
  const s = G.derive(entries, {}, {}, '2027-11-23T12:00:00');
  const svg = G.svg(s, { hour: 0 });
  assert.match(svg, /<g class="scale">/);
  assert.match(svg, />\d+ m<\/text>/);
  assert.doesNotMatch(G.svg(s, { hour: 0, mini: true }), /<\/text>/);     // the mini view has no text
});

test('unticking a paper removes its segment and its growth', () => {
  const es = Array.from({ length: 30 }, (_, i) => read(`r${i}`, G.addDays('2026-11-01', i), inZ('inference / uq')));
  const all = G.derive(es, {}, {}, NOW);
  const less = G.derive(es.map((e) => (e.id === 'r29' ? { ...e, done: false } : e)), {}, {}, NOW);
  assert.equal(all.grown - less.grown, all.papers.at(-1).mult);
  assert.equal(all.chains.at(-1).segs.length - less.chains.at(-1).segs.length, 1);
});

test('the same entries and seed always give the same tree; another seed gives another', () => {
  const { entries } = EX.history(400);
  const a = G.derive(entries, { seed: 's1' }, {}, '2027-12-01T12:00:00');
  const b = G.derive(entries.slice().reverse(), { seed: 's1' }, {}, '2027-12-01T12:00:00');
  const c = G.derive(entries, { seed: 's2' }, {}, '2027-12-01T12:00:00');
  assert.deepEqual(a.chains, b.chains);
  assert.equal(G.svg(a, { hour: 1000 }), G.svg(b, { hour: 1000 }));
  assert.notDeepEqual(a.chains, c.chains);
});

test('stages follow the growth', () => {
  assert.deepEqual([0, 19, 20, 149, 150, 600, 1499, 1500].map(G.stageOf),
    ['seedling', 'seedling', 'sapling', 'sapling', 'young tree', 'tree', 'tree', 'old tree']);
});

test('a Write entry unlocks its animal when submitted (not at a draft), named from tree.json, sized by citations', () => {
  assert.equal(G.derive([{ ...W, draft: 3 }], {}, {}, NOW).creatures.length, 0);
  const sub = { ...W, draft: 3, submitted: true, submitted_at: '2026-12-01T10:00:00' };
  const none = G.derive([sub], {}, {}, NOW).creatures[0];
  assert.equal(none.day, '2026-12-01');
  assert.equal(none.name, null);
  assert.equal(none.citations, null);
  assert.equal(none.published, false);
  assert.ok(G.ANIMALS.some(([k]) => k === none.animal));
  const pub = { ...sub, published: true, published_at: '2026-12-05T10:00:00' };
  const named = G.derive([pub], { creatures: { w1: { name: 'Pip' } } }, { dois: { '10.1016/j.cmpb.2026.109528': { count: 20 } } }, NOW).creatures[0];
  assert.equal(named.name, 'Pip');
  assert.equal(named.animal, none.animal);
  assert.equal(named.published, true);
  assert.equal(named.citations, 20);
  assert.equal(named.size, 2);
  assert.ok(named.size > none.size);
  assert.equal(G.derive([{ ...sub, submitted: false }], {}, {}, NOW).creatures.length, 0);
});

test('the hourly walk: fixed for a given hour, one step to a neighbour each hour, over the whole tree', () => {
  const { entries } = EX.history(300);
  const s = G.derive(entries, {}, {}, '2027-09-01T12:00:00');
  const L = G.layout(s);
  const c = s.creatures[0];
  const h = c.startHour + 500;
  const one = G.walk(L.graph, s.seed, c.id, c.startHour, h);
  assert.deepEqual(G.walk(L.graph, s.seed, c.id, c.startHour, h), one);
  assert.equal(one.path.length, 501);
  for (let i = 1; i < one.path.length; i++) assert.ok(L.graph.adj.get(one.path[i - 1]).includes(one.path[i]));
  const next = G.walk(L.graph, s.seed, c.id, c.startHour, h + 1);
  assert.deepEqual(next.path.slice(0, -1), one.path);              // the next hour extends the same walk
  const places = new Set(Array.from({ length: 48 }, (_, k) => G.walk(L.graph, s.seed, c.id, c.startHour, h + k).node));
  assert.ok(places.size > 5, 'it moves around the tree');
  assert.ok(new Set(one.path.map((k) => k.split('#')[0])).size > 3, 'it reaches several branches');
  assert.match(G.svg(s, { hour: h }), new RegExp(`data-node="${one.node.replace(/[.#/ ]/g, '\\$&')}"`));
});

test('names are escaped in the SVG', () => {
  const svg = G.svg(G.derive([{ ...W, submitted: true, submitted_at: '2026-12-01T10:00:00' }], { creatures: { w1: { name: '<b>&"x' } } }, {}, NOW), { hour: 0 });
  assert.ok(svg.includes('&lt;b&gt;&amp;&quot;x') && !svg.includes('<b>'));
});
