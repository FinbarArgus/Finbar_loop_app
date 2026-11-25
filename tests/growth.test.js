// Unit tests of growth.js: node --test tests/   (days are local, so the time zone is fixed here)
process.env.TZ = 'Pacific/Auckland';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../growth.js');
const EX = require('../tools/tree_examples.js');
const grown = (days) => { const { entries, writes } = EX.history(days); return EX.snapshot(entries, writes, days).s; };

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
  // Only the paper's own collection grows (C-0006): its parents stay stubs.
  assert.deepEqual(ch.get('physiology').segs.map((g) => [g.paper, g.weight, g.len]), [[null, 0, G.STUB]]);
  assert.deepEqual(ch.get('physiology / cardiac').segs.map((g) => [g.paper, g.weight, g.len]), [[null, 0, G.STUB]]);
  assert.deepEqual(s.papers.map((p) => p.branch), ['physiology / cardiac / valves', 'physiology / cardiac / valves', 'inference', 'trunk', 'trunk']);
  // The segment's length is set by the multiplier (b's day is the 2nd good day in a row: 1.2x).
  const [ga, gb] = ch.get('physiology / cardiac / valves').segs;
  assert.ok(Math.abs(gb.len / ga.len - 1.2 / Math.sqrt(1 + 1 / G.SEG_HALF)) < 1e-12);
  // Every paper also raises the trunk.
  // (height is the drawn tree's, scaled by the young tree's scale)
  assert.ok(Math.abs(s.height / s.scale - G.trunkHeight(s.grown)) < 1e-9 || s.height / s.scale > G.trunkHeight(s.grown));
  assert.equal(ch.get('trunk').segs.filter((g) => g.paper).length, 5);
  // Hover: every paper's segment is a tap target with its entry id and branch; leaves have none.
  const svg = G.svg(s, { hour: 0 });
  for (const id of 'abcde') assert.match(svg, new RegExp(`data-k="seg" data-i="${id}"`));
  assert.match(svg, /data-k="branch" data-i="physiology"/);
  assert.doesNotMatch(svg, /data-k="leaf"/);
});

test('an oak (Q-0056): the crown widens past the sapling stage to the ground, then the tree grows up again', () => {
  const span = (s) => { const xs = s.chains.flatMap((c) => c.segs.flatMap((g) => [g.x0, g.x1])); return s.scale * (Math.max(...xs) - Math.min(...xs)); };
  // Five years of estimated use (tools/tree_examples.js), the first n papers read.
  const reads = EX.history(5 * 365).entries.filter((e) => e.kind === 'read').sort((a, b) => a.done_at.localeCompare(b.done_at));
  const at = (n) => G.derive(reads.slice(0, n), {}, {}, '2032-01-01T12:00:00');
  assert.equal(at(5).spread, 0, 'a sapling is narrow');
  const s20 = at(20), s40 = at(40);
  assert.ok(s40.spread > 0.5 && span(s40) > 1.2 * span(s20), `wider with papers: ${span(s20)} -> ${span(s40)} m`);
  for (const n of [40, 80, 200, 1000]) {
    const s = at(n);
    assert.ok(span(s) <= G.GROUND_M + 1e-6, `${n} papers: ${span(s)} m wide, within the ground`);
    assert.ok(s.height < G.trunkHeight(s.grown), `${n} papers: ${s.height} m, shorter than a poplar (${G.trunkHeight(s.grown)} m)`);
  }
  assert.ok(Math.abs(span(at(80)) - G.GROUND_M) < 0.01, 'by 80 papers the crown spans the ground');
  const [a, b] = [200, 400].map(at);
  assert.ok(b.height - a.height > 0.5 * (G.trunkHeight(b.grown) - G.trunkHeight(a.grown)),
    `at the ground's width it grows up at the full rate again: ${a.height} -> ${b.height} m`);
});

test('it grows up again: after five years the tree is taller than it is wide', () => {
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
  const svg = G.svg(G.derive([read('a', '2026-11-30'), { ...W, submitted: true, submitted_at: '2026-12-01T10:00:00' }], { creatures: { w1: { name: '<b>&"x' } } }, {}, NOW), { hour: 0 });
  assert.ok(svg.includes('&lt;b&gt;&amp;&quot;x') && !svg.includes('<b>'));
});

test('branch names: each collection named at its branch tip, only when asked', () => {
  const s = G.derive([read('a', '2026-12-01', inZ('physiology / cardiac'))], {}, {}, NOW);
  assert.match(G.svg(s, { hour: 0, branchNames: true }), />cardiac<\/text>/);
  assert.doesNotMatch(G.svg(s, { hour: 0 }), />cardiac<\/text>/);
});

test("branches leave the trunk spread over its height, by length, oldest lowest", () => {
  const { entries } = EX.history(2 * 365);
  const s = G.derive(entries, {}, {}, '2028-11-22T12:00:00');
  const trunk = s.chains[0];
  const H = trunk.segs.reduce((a, g) => a + g.len, 0);
  const kids = s.chains.filter((c) => c.parent === 'trunk').sort((a, b) => a.rank - b.rank);
  const ys = kids.map((c) => c.segs[0].y0 / H);
  assert.ok(ys[0] < 0.25, `lowest at ${ys[0]}`);
  assert.ok(ys.at(-1) > 0.75, `highest at ${ys.at(-1)}`);
  assert.deepEqual(ys, [...ys].sort((a, b) => a - b));
});

test('only its own branch grows; a parent is one stub longer per further subcollection; every paper thickens the trunk', () => {
  const es = [read('a', '2026-12-01', inZ('physiology / cardiac')), read('b', '2026-12-02', inZ('physiology / renal')),
    read('c', '2026-12-03', inZ('physiology / cardiac')), read('d', '2026-12-04', inZ('inference'))];
  const s = G.derive(es, {}, {}, NOW);
  const ch = new Map(s.chains.map((c) => [c.id, c]));
  assert.deepEqual(ch.get('physiology').segs.map((g) => [g.paper, g.len]), [[null, G.STUB], [null, G.STUB]]);
  assert.deepEqual(ch.get('physiology / cardiac').segs.map((g) => g.paper), ['a', 'c']);
  assert.deepEqual(ch.get('physiology / renal').segs.map((g) => g.paper), ['b']);
  assert.deepEqual(ch.get('inference').segs.map((g) => g.paper), ['d']);
  // The trunk rises with each paper and is thicker at its foot after each one.
  const foot = (n) => G.derive(es.slice(0, n), {}, {}, NOW).chains[0].segs[0].w0;
  for (let n = 1; n < es.length; n++) assert.ok(foot(n + 1) > foot(n));
  assert.equal(ch.get('trunk').segs.filter((g) => g.paper).length, 4);
});

test('colours: brown wood, green leaves, each animal in its own muted colours', () => {
  const es = [read('a', '2026-12-01', { ...inZ('physiology'), deadline: '2026-12-02' }),
    { ...W, submitted: true, submitted_at: '2026-12-01T10:00:00' }];
  const s = G.derive(es, { creatures: { w1: { animal: 'bird' } } }, {}, NOW);
  const svg = G.svg(s, { hour: 0 });
  assert.match(svg, /fill="#6e4b2e"/);
  assert.doesNotMatch(svg, /fill="#111"/);
  assert.match(svg, /fill="#5d7748"/);
  const [, , [ink, fill]] = G.ANIMALS.find(([k]) => k === 'bird');
  assert.ok(svg.includes(`fill="${ink}"`) && svg.includes(`fill="${fill}"`));
  // muted: no channel at full brightness or saturation
  for (const [, , cs] of G.ANIMALS) for (const c of cs) {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    assert.ok(Math.max(r, g, b) - Math.min(r, g, b) < 80 && Math.max(r, g, b) < 230, c);
  }
});

test('the seedling starts small: SEEDLING tall, rising in a line to the sapling height, which is unchanged', () => {
  assert.equal(G.trunkHeight(0), G.SEEDLING);
  assert.ok(G.SEEDLING < G.TRUNK_BASE);
  for (let g = 0; g < 40; g += 0.5) assert.ok(G.trunkHeight(g + 0.5) > G.trunkHeight(g), `rises at ${g}`);
  for (const g of [1, 5, 10, 19]) assert.ok(G.trunkHeight(g) < G.TRUNK_BASE + G.TRUNK_K * Math.sqrt(g), `smaller at ${g}`);
  for (const g of [G.SAPLING, 150, 600]) assert.equal(G.trunkHeight(g), G.TRUNK_BASE + G.TRUNK_K * Math.sqrt(g));
  const bare = G.derive([], {}, {}, NOW);
  assert.equal(bare.stage, 'seedling');
  assert.equal(bare.height, 0);
  // the frame is a seedling's frame (drawn at the first paper's scale), so a young seedling stands small in it
  const vb = (s) => G.svg(s, { hour: 0 }).match(/viewBox="([^"]+)"/)[1].split(' ').map(Number);
  assert.ok(vb(bare)[3] >= G.trunkHeight(1) * G.youngScale(1), `frame ${vb(bare)[3]}`);
  assert.ok(G.MIN_FRAME > G.trunkHeight(G.SAPLING));
});

// n papers on every other day (no streak, so each grows 1 unit), dated before NOW.
const papersN = (n) => Array.from({ length: n }, (_, k) => read(`p${k}`, new Date(Date.UTC(2026, 0, 1) + 2 * k * 864e5).toISOString().slice(0, 10)));
const NOW100 = '2026-12-31T12:00:00';

test('a young tree is the same tree scaled down (Q-0036): 0 m, 5 cm after 1 paper, ~1.1 m after 5, full size from 20', () => {
  const h = (n) => G.derive(papersN(n), {}, {}, NOW100).height;
  assert.equal(h(0), 0);
  assert.ok(h(1) >= 0.04 && h(1) <= 0.06, `1 paper: ${h(1)} m`);
  assert.ok(h(5) > 0.9 && h(5) < 1.3, `5 papers: ${h(5)} m`);
  assert.ok(Math.abs(h(20) - G.trunkHeight(20)) < 0.5, `20 papers: ${h(20)} m`);
  assert.ok(h(100) > h(20) && h(100) < G.trunkHeight(100) - 5, `100 papers: ${h(100)} m, an oak, shorter than a poplar`);
  for (let n = 0; n < 25; n++) assert.ok(h(n + 1) > h(n), `rises from ${n} papers`);
  assert.equal(G.youngScale(0), 0);
  assert.equal(G.youngScale(G.SAPLING), 1);
  // the whole drawing shrinks: wood, blocks and frame are scaled together, and its scale is labelled in true units
  const one = G.derive(papersN(1), {}, {}, NOW100), twenty = G.derive(papersN(20), {}, {}, NOW100);
  const svg1 = G.svg(one, { hour: 0 });
  assert.match(svg1, new RegExp(`<g transform="scale\\(${one.scale}\\)">`));
  assert.match(svg1, />\d+ cm<\/text>/);
  assert.doesNotMatch(G.svg(twenty, { hour: 0 }), /<g transform="scale/);
  const parts1 = G.parts(one, {}), full1 = G.parts({ ...one, scale: 1 }, {});
  // the same drawing, scaled: as wide x scale; framed to its own height (no seedling minimum), and still taller than the tree
  assert.ok(Math.abs(parts1.w - one.scale * full1.w) < 1e-9);
  assert.ok(parts1.h < one.scale * full1.h && parts1.h > one.height, `frame ${parts1.h}, tree ${one.height}`);
  assert.doesNotMatch(G.svg(G.derive([], {}, {}, NOW100), { hour: 0 }), /fill="#[0-9a-f]+" d=|<polygon/);  // nothing grown, no wood
});

test('a paper carries its journal and full title, for the line under its key title', () => {
  const s = G.derive([read('k1', '2026-12-01', { title: 'Smith2026Hopfit', journal: 'J Clin Monit Comput', full_title: 'HOPFIT' }),
    read('k2', '2026-12-02', { title: 'Plain' })], {}, {}, NOW);
  assert.deepEqual(s.papers.map((p) => [p.title, p.journal, p.full_title]),
    [['Smith2026Hopfit', 'J Clin Monit Comput', 'HOPFIT'], ['Plain', null, null]]);
});

test("the frame holds every label: an animal's name wider than the animal, and branch names", () => {
  // A young tree (one paper) with an unnamed animal: "bat (name me)" is far wider than the sprite and the stub of wood.
  const es = [read('a', '2026-11-30', inZ('ROM / Beat maps')), { ...W, submitted: true, submitted_at: '2026-12-01T10:00:00' }];
  for (const [animal, named] of [['bat', null], ['owl', 'A rather long animal name']]) {
    const s = G.derive(es, { creatures: { w1: { animal, ...(named ? { name: named } : {}) } } }, {}, NOW);
    for (const branchNames of [false, true]) {
      const T = G.parts(s, { hour: 0, branchNames });
      const k = s.scale == null ? 1 : s.scale;
      for (const m of T.body.matchAll(/<text x="([-\d.]+)" y="([-\d.]+)" font-size="([\d.]+)"[^>]*text-anchor="middle"[^>]*>([^<]*)</g)) {
        const [x, y, size, text] = [Number(m[1]) * k, Number(m[2]) * k, Number(m[3]) * k, m[4]];
        const half = text.length * 0.6 * size / 2;
        assert.ok(x - half >= T.x0 && x + half <= T.x0 + T.w, `${text}: ${x - half}..${x + half} across, frame ${T.x0}..${T.x0 + T.w}`);
        assert.ok(y - size >= T.y0, `${text}: top ${y - size}, frame top ${T.y0}`);
      }
    }
  }
});

test('deadline birds: each open deadline is a bird, days to the end of its day; passed ones are evil, done ones leave', () => {
  const due = (id, deadline, extra = {}) => ({ id, kind: 'task', created: '2026-12-01T09:00:00', deadline, title: id, ...extra });
  const st = G.derive([due('soon', '2026-12-12'), due('late', '2026-12-08'), due('met', '2026-12-11', { done: true, done_at: '2026-12-09T10:00:00' }),
    due('lateDone', '2026-12-05', { done: true, done_at: '2026-12-07T10:00:00' }), due('far', '2027-02-01')], {}, {}, NOW);
  assert.deepEqual(st.birds.map((b) => [b.id, b.evil]), [['late', true], ['soon', false], ['far', false]]);
  const soon = st.birds.find((b) => b.id === 'soon');
  assert.equal(soon.days, 2.5);                                  // noon on the 10th to the end of the 12th
  assert.equal(st.birds.find((b) => b.id === 'late').days, -1.5);
  const L = G.layout(st);
  const ys = [...L.graph.nodes.values()].map((p) => p.y).sort((a, b) => b - a);
  for (const b of L.birds) assert.ok(b.y >= ys[Math.max(0, Math.ceil(ys.length / 4) - 1)], `${b.id} lands in the crown`);
  assert.deepEqual(G.layout(st).birds, L.birds, 'the same deadline always lands on the same node');
});

test('a passed deadline\'s crow perches on the tree; animals within sadR of it get a sad face', () => {
  let sadSeen = 0, calmSeen = 0;
  for (const days of [120, 2 * 365]) {
    const st = grown(days);
    const hour = Math.max(...st.creatures.map((c) => c.startHour)) + 300;   // every animal has walked a while
    assert.ok(st.creatures.length, 'needs animals');
    assert.doesNotMatch(G.svg({ ...st, birds: [] }, { hour }), /data-k="bird"|class="sad"/);
    const s = { ...st, birds: [{ id: 'crow', deadline: '2026-12-01', title: 't', days: -3, evil: true }] };
    const L = G.layout(s), b = L.birds[0], svg = G.svg(s, { hour });
    assert.match(svg, /data-k="bird" data-i="crow"/);
    for (const c of st.creatures) {
      const p = L.graph.nodes.get(G.walk(L.graph, st.seed, c.id, c.startHour, hour).node);
      const sad = Math.hypot(p.x - b.x, p.y - b.y) <= G.sadR(L);
      assert.equal(svg.includes(`class="sad" data-i="${c.id}"`), sad, `${days} d, ${c.id} sad: ${sad}`);
      if (sad) sadSeen++; else calmSeen++;
    }
  }
  assert.ok(sadSeen && calmSeen, `both cases met: ${sadSeen} sad, ${calmSeen} calm`);
  // An open (flying) deadline is drawn by the scene, not on the tree.
  assert.doesNotMatch(G.svg({ ...grown(120), birds: [{ id: 'x', deadline: '2027-01-01', days: 20, evil: false }] }), /data-k="bird"/);
  const tall = G.layout(grown(2 * 365));
  const ps = [...tall.graph.nodes.values()], xs = ps.map((p) => p.x);
  assert.equal(G.sadR(tall), Math.max(Math.max(...ps.map((p) => p.y)), Math.max(...xs) - Math.min(...xs)) / 4, 'a quarter of the tree, tall or wide');
  assert.equal(G.sadR(G.layout(G.derive([], {}, {}, NOW))), G.SAD_R, 'at least SAD_R');
});

test('crows and sad faces are drawn over the animals', () => {
  const st = grown(120);
  const hour = Math.max(...st.creatures.map((c) => c.startHour)) + 300;
  const svg = G.svg({ ...st, birds: [{ id: 'crow', deadline: '2026-12-01', title: 't', days: -3, evil: true }] }, { hour });
  const lastAnimal = Math.max(...st.creatures.map((c) => svg.lastIndexOf(`fill="${c.ink}"`)));
  assert.ok(svg.indexOf('<g class="crow">') > lastAnimal);
  assert.ok(!svg.includes('class="sad"') || svg.indexOf('class="sad"') > lastAnimal);
});
