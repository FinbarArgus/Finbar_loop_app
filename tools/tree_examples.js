// Example trees after 1, 2 and 5 years of estimated use, drawn by growth.js exactly as the app draws them.
//   TZ=Pacific/Auckland node tools/tree_examples.js OUTDIR   -> OUTDIR/year-{1,2,5}.svg and OUTDIR/stats.json
// The usage model (all fixed by USAGE_SEED; the tree itself uses growth.js's default seed):
//   papers: weekdays read on 60%, weekend days on 25%, 1 paper (2 on 10% of read days): ~200 a year; each in
//   one of Finbar's topic collections (TOPICS, drawn with the weights given; 8% in none, which grow the trunk);
//   deadlines: 28 a year, 25 met (ticked 0-5 days before), 3 missed (ticked 2-6 days late);
//   papers submitted: 3 a year, the first the CMPB 2026 paper; published half a year after submission (the
//   CMPB paper already is); citations c = A * y^1.3, y years since publication, A drawn in 4-15.
const fs = require('fs');
const path = require('path');
const G = require('../growth.js');

const USAGE_SEED = 'usage-2026-11-23';
const START = '2026-11-23';
const CMPB = { doi: '10.1016/j.cmpb.2026.109528', title: 'Accounting for approximation errors using surrogate-based parameter estimation of cardiac mechanics digital twins' };
// A subset of Finbar's Zotero topic collections (state/zotero_collections.json) with how often a paper lands in each.
const TOPICS = [
  ['physiology / circulatory / full_system', 10], ['physiology / circulatory / arterial', 5], ['physiology / circulatory / venous', 3],
  ['physiology / cardiac / heart_model', 7], ['physiology / cardiac / valves', 2], ['physiology / autonomic / baroreflex', 4],
  ['physiology / autonomic / hrv', 2], ['physiology / brain / cerebral_blood_flow', 2], ['physiology / respiratory / cardiopulmonary', 2],
  ['physiology / metabolic', 2], ['physiology / renal', 1],
  ['reduction_and_ml / surrogates', 7], ['reduction_and_ml / lifting', 5], ['reduction_and_ml / koopman', 4], ['reduction_and_ml / physics_informed', 3],
  ['inference / parameter_id', 4], ['inference / parameter_id / identifiability', 4], ['inference / parameter_id / mcmc', 3],
  ['inference / approximation_error', 3], ['inference / uq', 3],
  ['modelling / bond_graphs', 5], ['modelling / port_hamiltonian', 2], ['modelling / multiscale', 2], ['modelling / software', 2],
  ['clinical / digital_twins', 4], ['clinical / intra-operative', 2], ['cells / ion_channels / calcium', 1], ['control / control_systems', 1],
];
const TOPIC_TOTAL = TOPICS.reduce((s, [, w]) => s + w, 0);
function topic(r) {
  if (r() < 0.08) return null;
  let u = r() * TOPIC_TOTAL;
  for (const [t, w] of TOPICS) { u -= w; if (u < 0) return t; }
  return TOPICS[0][0];
}
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
        const z = topic(r);
        entries.push({ id: `read-${d}-${k}`, kind: 'read', title: `Paper ${d}.${k}`, done: true, created: iso(d, 9), done_at: iso(d, 15 + k), deadline: null,
          ...(z ? { zotero: { name: z } } : {}) });
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
      const pub = first ? d : d + 182;
      entries.push({ id, kind: 'write', title: first ? CMPB.title : `Paper submitted ${y}.${k}`, draft: 3,
        doi: first ? CMPB.doi : `10.0000/sim.${y}.${k}`, created: iso(Math.max(0, d - 90), 8),
        submitted: true, submitted_at: iso(d, 11), published: true, published_at: iso(pub, 11), done: true, done_at: iso(pub, 11) });
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
    const y = (day - w.day) / 365 - (w.published ? 0 : 0.5);   // years since publication
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
    const streaks = s.papers.map((p) => p.mult);
    stats[y] = { now, stage: s.stage, papers: s.papers.length, good_days: s.goodDays.length, days: y * 365,
      grown: Math.round(s.grown * 10) / 10, height_m: Math.round(s.height * 10) / 10, branches: s.chains.length - 1,
      mean_mult: Math.round(100 * streaks.reduce((a, b) => a + b, 0) / streaks.length) / 100,
      at_2x: streaks.filter((m) => m === 2).length, leaves: s.leaves.length, passed: s.passed.length,
      creatures: s.creatures.map((c) => ({ name: c.name, animal: c.animal, citations: c.citations, title: c.title.slice(0, 40) })) };
  }
  fs.writeFileSync(path.join(out, 'stats.json'), JSON.stringify(stats, null, 1));
  console.log(JSON.stringify(stats, (k, v) => (k === 'creatures' ? v.map((c) => `${c.name}:${c.citations}`).join(' ') : v), 1));
}
module.exports = { history, snapshot, USAGE_SEED, START };
