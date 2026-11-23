// Example trees after 1, 2 and 5 years of estimated use, drawn by growth.js exactly as the app draws them.
//   TZ=Pacific/Auckland node tools/tree_examples.js OUTDIR   -> OUTDIR/year-{1,2,5}.svg and OUTDIR/stats.json
// The usage model (all fixed by USAGE_SEED; the tree itself uses growth.js's default seed):
//   papers: weekdays read on 60%, weekend days on 25%, 1 paper (2 on 10% of read days): ~200 a year;
//   deadlines: 28 a year, 25 met (ticked 0-5 days before), 3 missed (ticked 2-6 days late);
//   papers submitted: 3 a year, the first the CMPB 2026 paper; citations c = A * y^1.3, y years since
//   publication (half a year after submission; the CMPB paper is already published), A drawn in 4-15.
const fs = require('fs');
const path = require('path');
const G = require('../growth.js');

const USAGE_SEED = 'usage-2026-11-23';
const START = '2026-11-23';
const CMPB = { doi: '10.1016/j.cmpb.2026.109528', title: 'Accounting for approximation errors using surrogate-based parameter estimation of cardiac mechanics digital twins' };
const NAMES = ['Kōwhai', 'Pip', 'Moss', 'Tui', 'Fern', 'Rata', 'Huia', 'Kauri', 'Nikau', 'Totara', 'Miro', 'Rimu', 'Weka', 'Kea', 'Pōhutu'];

function history(days) {
  const r = G.rng(USAGE_SEED);
  const entries = [];
  const iso = (day, h) => `${G.addDays(START, day)}T${String(h).padStart(2, '0')}:00:00`;
  const writes = [];
  for (let d = 0; d < days; d++) {
    const dow = new Date(`${G.addDays(START, d)}T00:00:00Z`).getUTCDay();
    const p = dow === 0 || dow === 6 ? 0.25 : 0.6;
    if (r() < p) {
      const n = r() < 0.1 ? 2 : 1;
      for (let k = 0; k < n; k++) {
        entries.push({ id: `read-${d}-${k}`, kind: 'read', title: `Paper ${d}.${k}`, done: true, created: iso(d, 9), done_at: iso(d, 15 + k), deadline: null });
      }
    }
  }
  const years = Math.ceil(days / 365);
  for (let y = 0; y < years; y++) {
    for (let k = 0; k < 28; k++) {
      const dl = y * 365 + Math.floor(r() * 365);
      const missed = k < 3;
      const done = missed ? dl + 2 + Math.floor(r() * 5) : dl - Math.floor(r() * 6);
      entries.push({ id: `dl-${y}-${k}`, kind: 'other', title: `Deadline ${y}.${k}`, deadline: G.addDays(START, dl), done: true,
        created: iso(Math.max(0, dl - 30), 8), done_at: iso(Math.max(0, done), 17) });
    }
    for (let k = 0; k < 3; k++) {
      const first = y === 0 && k === 0;
      const d = first ? 0 : y * 365 + 60 + k * 110 + Math.floor(r() * 40);
      const id = `write-${y}-${k}`;
      writes.push({ id, day: d, A: first ? 10 : 4 + 11 * r(), published: first });
      entries.push({ id, kind: 'write', title: first ? CMPB.title : `Paper submitted ${y}.${k}`,
        doi: first ? CMPB.doi : `10.0000/sim.${y}.${k}`, done: true, created: iso(Math.max(0, d - 90), 8), done_at: iso(d, 11) });
    }
  }
  return { entries, writes };
}

// The tree on `day` (days after START): citations as they would be then, every creature named.
function snapshot(entries, writes, day) {
  const now = `${G.addDays(START, day)}T12:00:00`;
  const dois = {};
  const creatures = {};
  writes.forEach((w, i) => {
    const e = entries.find((x) => x.id === w.id);
    const y = (day - w.day) / 365 - (w.published ? 0 : 0.5);
    if (day >= w.day) dois[e.doi.toLowerCase()] = { count: y > 0 ? Math.round(w.A * Math.pow(y, 1.3)) : 0 };
    creatures[w.id] = { name: NAMES[i % NAMES.length] };
  });
  return { s: G.derive(entries, { creatures }, { dois }, now), now };
}

if (require.main === module) {
  const out = process.argv[2] || 'tree-examples';
  fs.mkdirSync(out, { recursive: true });
  const { entries, writes } = history(5 * 365);
  const stats = {};
  for (const y of [1, 2, 5]) {
    const { s, now } = snapshot(entries, writes, y * 365);
    fs.writeFileSync(path.join(out, `year-${y}.svg`), G.svg(s, { hour: G.hourOf(now) }));
    stats[y] = { now, stage: s.stage, papers: s.papers.length, good_days: s.goodDays.length, days: y * 365,
      mass: s.mass, branches: s.branches.length, leaves: s.leaves.length, leaf_weight: s.leafCount, passed: s.passed.length,
      branch_share_now: Math.round(s.share * 100) / 100,
      creatures: s.creatures.map((c) => ({ name: c.name, animal: c.animal, citations: c.citations, title: c.title.slice(0, 40) })) };
  }
  fs.writeFileSync(path.join(out, 'stats.json'), JSON.stringify(stats, null, 1));
  console.log(JSON.stringify(stats, (k, v) => (k === 'creatures' ? v.map((c) => `${c.name}:${c.citations}`).join(' ') : v), 1));
}
module.exports = { history, snapshot, USAGE_SEED, START };
