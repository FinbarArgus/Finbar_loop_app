// Unit tests of growth.js: node --test tests/   (days are local, so the time zone is fixed here)
process.env.TZ = 'Pacific/Auckland';
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../growth.js');
const EX = require('../tools/tree_examples.js');

const read = (id, day, extra = {}) => ({ id, kind: 'read', done: true, created: `${day}T09:00:00`, done_at: `${day}T15:00:00`, ...extra });
const NOW = '2026-12-10T12:00:00';

test('a paper read counts on the day it was ticked, also when added that day', () => {
  const s = G.derive([read('r1', '2026-12-01'), { id: 'r2', kind: 'read', done: false, created: '2026-12-01T09:00:00' }], {}, {}, NOW);
  assert.deepEqual(s.papers.map((p) => [p.id, p.day]), [['r1', '2026-12-01']]);
  assert.equal(s.mass.total, 2);                                  // a good day: counts double
  assert.deepEqual(s.goodDays, ['2026-12-01']);
});

test('entries ticked before done_at existed use updated', () => {
  const s = G.derive([{ id: 'r', kind: 'read', done: true, created: '2026-11-01T09:00:00', updated: '2026-11-03T10:00:00' }], {}, {}, NOW);
  assert.equal(s.papers[0].day, '2026-11-03');
});

test('leaves for deadlines met, passed deadlines on the day after, and no good day then', () => {
  const entries = [
    { id: 'met', kind: 'other', deadline: '2026-12-05', done: true, created: '2026-11-20T09:00:00', done_at: '2026-12-05T20:00:00' },
    { id: 'late', kind: 'other', deadline: '2026-12-03', done: true, created: '2026-11-20T09:00:00', done_at: '2026-12-06T09:00:00' },
    { id: 'open', kind: 'write', deadline: '2026-12-07', done: false, created: '2026-11-20T09:00:00' },
    { id: 'future', kind: 'other', deadline: '2026-12-20', done: false, created: '2026-11-20T09:00:00' },
    read('a', '2026-12-04'), read('b', '2026-12-08'), read('c', '2026-12-09'),
  ];
  const s = G.derive(entries, {}, {}, NOW);
  assert.deepEqual(s.leaves.map((l) => l.id), ['met']);
  assert.deepEqual(s.passed.map((p) => [p.id, p.day]), [['late', '2026-12-04'], ['open', '2026-12-08']]);
  assert.deepEqual(s.goodDays, ['2026-12-09']);                   // 12-04 and 12-08 each had a deadline pass
  assert.deepEqual(s.papers.map((p) => p.weight), [1, 1, 2]);
  assert.equal(s.leaves[0].weight, 1);                            // 12-05: no paper read, so not a good day
});

test('a deadline ticked after `now` is still open at `now`; an entry made after `now` does not exist yet', () => {
  const e = [{ id: 'x', kind: 'other', deadline: '2026-12-05', done: true, created: '2026-11-20T09:00:00', done_at: '2026-12-20T09:00:00' },
    read('later', '2026-12-15')];
  const s = G.derive(e, {}, {}, NOW);
  assert.equal(s.leaves.length, 0);
  assert.equal(s.passed.length, 1);
  assert.equal(s.papers.length, 0);
});

test('unticking a paper removes its growth', () => {
  const es = Array.from({ length: 30 }, (_, i) => read(`r${i}`, G.addDays('2026-11-01', i)));
  const all = G.derive(es, {}, {}, NOW);
  const less = G.derive(es.map((e) => (e.id === 'r29' ? { ...e, done: false } : e)), {}, {}, NOW);
  assert.equal(all.mass.total - less.mass.total, all.papers.at(-1).weight);
});

test('the wood split follows the allometry: 34% to branches under 10 Mg, rising to 50% at 45 Mg', () => {
  assert.equal(G.branchShare(0), 0.34);
  assert.equal(G.branchShare(10 / G.MG_PER_UNIT), 0.34);
  assert.ok(Math.abs(G.branchShare(45 / G.MG_PER_UNIT) - 0.50) < 1e-12);
  assert.equal(G.branchShare(1e6), 0.55);
  // Over many papers, the share of mass that went to branches is near the expected share.
  const es = Array.from({ length: 400 }, (_, i) => read(`p${i}`, G.addDays('2025-01-01', Math.floor(i / 2))));
  const s = G.derive(es, {}, {}, '2026-12-01T12:00:00');
  const toBranch = s.papers.filter((p) => p.grew.to === 'branch').length / s.papers.length;
  assert.ok(toBranch > 0.27 && toBranch < 0.45, `branch share ${toBranch}`);
  assert.equal(s.mass.trunk + s.mass.branches, s.mass.total);
});

test('the same entries and seed always give the same tree; another seed gives another', () => {
  const { entries } = EX.history(400);
  const a = G.derive(entries, { seed: 's1' }, {}, '2027-12-01T12:00:00');
  const b = G.derive(entries.slice().reverse(), { seed: 's1' }, {}, '2027-12-01T12:00:00');
  const c = G.derive(entries, { seed: 's2' }, {}, '2027-12-01T12:00:00');
  assert.deepEqual(a.branches, b.branches);
  assert.deepEqual(a.papers.map((p) => p.grew), b.papers.map((p) => p.grew));
  assert.equal(G.svg(a, { hour: 1000 }), G.svg(b, { hour: 1000 }));
  assert.notDeepEqual(a.papers.map((p) => p.grew), c.papers.map((p) => p.grew));
});

test('stages follow the mass', () => {
  assert.deepEqual([0, 19, 20, 149, 150, 600, 1499, 1500].map(G.stageOf),
    ['seedling', 'seedling', 'sapling', 'sapling', 'young tree', 'tree', 'tree', 'old tree']);
});

test('a submitted paper unlocks an animal, named from tree.json, sized by its citations', () => {
  const w = { id: 'w1', kind: 'write', done: true, doi: '10.1016/J.CMPB.2026.109528', created: '2026-11-01T09:00:00', done_at: '2026-12-01T10:00:00' };
  const none = G.derive([w], {}, {}, NOW).creatures[0];
  assert.equal(none.name, null);
  assert.equal(none.citations, null);
  assert.ok(G.ANIMALS.some(([k]) => k === none.animal));
  const named = G.derive([w], { creatures: { w1: { name: 'Pip' } } }, { dois: { '10.1016/j.cmpb.2026.109528': { count: 20 } } }, NOW).creatures[0];
  assert.equal(named.name, 'Pip');
  assert.equal(named.animal, none.animal);
  assert.equal(named.citations, 20);
  assert.ok(named.size > none.size);
  assert.equal(G.derive([{ ...w, done: false }], {}, {}, NOW).creatures.length, 0);
});

test('the hourly walk: fixed for a given hour, one step to a neighbour each hour', () => {
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
  assert.ok(L.graph.nodes.size > 20);
  assert.match(G.svg(s, { hour: h }), new RegExp(`data-node="${one.node.replace(/[.@]/g, '\\$&')}"`));
});

test('names are escaped in the SVG', () => {
  const w = { id: 'w1', kind: 'write', done: true, created: '2026-11-01T09:00:00', done_at: '2026-12-01T10:00:00' };
  const svg = G.svg(G.derive([w], { creatures: { w1: { name: '<b>&"x' } } }, {}, NOW), { hour: 0 });
  assert.ok(svg.includes('&lt;b&gt;&amp;&quot;x') && !svg.includes('<b>'));
});
