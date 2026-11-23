// The growth tree: a pure function of Finbar's Mine entries, personal/tree.json (seed, creature names) and
// state/citations.json (citation counts by DOI). Nothing here reads the network or the clock: callers pass
// `now`, so the same inputs always give the same tree, and the hourly creature walk is fixed per hour.
// Loaded in the browser (window.LoopGrowth) and by Node (tests, tools/tree_examples.js).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LoopGrowth = api;
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

  // ---------------------------------------------------------------- seeded randomness

  function hash(...parts) {                       // FNV-1a, 32 bit
    let h = 0x811c9dc5;
    const s = parts.join('␟');
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }
  function rng(...parts) {                        // mulberry32, seeded by the parts
    let a = hash(...parts);
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const pickWeighted = (r, items, w) => {
    const tot = items.reduce((s, x) => s + w(x), 0);
    let u = r() * tot;
    for (const x of items) { u -= w(x); if (u < 0) return x; }
    return items[items.length - 1];
  };

  // ---------------------------------------------------------------- days (local time)

  const pad = (n) => String(n).padStart(2, '0');
  function dayOf(iso) {
    const d = new Date(iso);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function addDays(day, n) {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  const hourOf = (t) => Math.floor(new Date(t).getTime() / 3.6e6);

  // ---------------------------------------------------------------- growth rules

  // Where a paper's wood goes. Ploton et al. (2016), "Closing a gap in tropical forest biomass estimation:
  // taking crown mass variation into account in pantropical allometries", Biogeosciences 13, 1571-1585,
  // doi:10.5194/bg-13-1571-2016: in 673 destructively sampled trees the crown held on average 34% of
  // above-ground mass for trees under 10 Mg, rising sharply above that to over 50% on average for trees of
  // 45 Mg and more. A paper's mass goes to the branches with that probability, to the trunk otherwise.
  // MG_PER_UNIT maps the tree's mass (in papers; a good-day paper counts 2) onto tree mass: about a year of
  // reading reaches 10 Mg, about five years 45 Mg. Between them the share rises linearly in log mass.
  const MG_PER_UNIT = 0.0225;
  function branchShare(units) {
    const mg = units * MG_PER_UNIT;
    if (mg <= 10) return 0.34;
    return Math.min(0.55, 0.34 + (0.50 - 0.34) * Math.log(mg / 10) / Math.log(45 / 10));
  }
  // Branch mass starts a new branch with probability 1 / (1 + n/3) (n branches so far), else lengthens an
  // existing one chosen in proportion to its mass, so a few limbs dominate as in a real crown.
  const newBranchChance = (n) => 1 / (1 + n / 3);
  const GOOD_DAY = 2;                             // growth earned on a good day counts double
  const STAGES = [[0, 'seedling'], [20, 'sapling'], [150, 'young tree'], [600, 'tree'], [1500, 'old tree']];
  const stageOf = (units) => STAGES.filter(([m]) => units >= m).pop()[1];
  const ANIMALS = [['owl', '🦉'], ['squirrel', '🐿️'], ['koala', '🐨'], ['sloth', '🦥'], ['gecko', '🦎'],
    ['parrot', '🦜'], ['monkey', '🐒'], ['ladybird', '🐞'], ['snail', '🐌'], ['butterfly', '🦋'],
    ['bee', '🐝'], ['caterpillar', '🐛']];
  const DEFAULT_SEED = 'loop-tree';

  // ---------------------------------------------------------------- derivation

  // entries: Mine entries ({id, kind, done, done_at, updated, created, deadline, doi, title}).
  // treeDoc: {seed, creatures: {<entry id>: {name, animal}}}. cites: {dois: {<doi>: {count}}}. now: Date|ISO.
  function derive(entries, treeDoc = {}, cites = {}, now = new Date()) {
    const seed = String(treeDoc.seed || DEFAULT_SEED);
    const today = dayOf(now);
    const papers = [];
    const leaves = [];
    const passed = [];
    const creatures = [];
    for (const e of entries || []) {
      if (e.created && dayOf(e.created) > today) continue;         // not made yet at `now`
      let doneAt = e.done ? (e.done_at || e.updated || e.created) : null;
      if (doneAt && dayOf(doneAt) > today) doneAt = null;            // ticked after `now`: still open then
      const doneDay = doneAt ? dayOf(doneAt) : null;
      if (e.kind === 'read' && doneDay) papers.push({ id: e.id, day: doneDay, at: doneAt, title: e.title || '' });
      if (e.deadline) {
        if (doneDay && doneDay <= e.deadline) leaves.push({ id: e.id, day: doneDay, at: doneAt, deadline: e.deadline, title: e.title || '' });
        const pd = addDays(e.deadline, 1);       // a deadline passes when its day ends
        if (pd <= today && (!doneDay || doneDay > e.deadline)) passed.push({ id: e.id, day: pd, deadline: e.deadline, title: e.title || '' });
      }
      if (e.kind === 'write' && doneDay) creatures.push({ id: e.id, day: doneDay, at: doneAt, doi: e.doi || null, title: e.title || '' });
    }
    const byTime = (a, b) => a.day.localeCompare(b.day) || String(a.at || '').localeCompare(String(b.at || '')) || a.id.localeCompare(b.id);
    [papers, leaves, passed, creatures].forEach((l) => l.sort(byTime));

    const passedDays = new Set(passed.map((p) => p.day));
    const goodDays = [...new Set(papers.map((p) => p.day))].filter((d) => !passedDays.has(d)).sort();
    const good = new Set(goodDays);

    // Wood: the trunk starts as a seedling of mass 1; each paper adds its weight to the trunk or a branch.
    const trunk = { mass: 1 };
    const branches = [];
    let grown = 0;
    for (const p of papers) {
      const r = rng(seed, 'paper', p.id);
      p.weight = good.has(p.day) ? GOOD_DAY : 1;
      if (r() < branchShare(grown)) {
        let b;
        if (!branches.length || r() < newBranchChance(branches.length)) {
          const hosts = branches.filter((x) => x.mass >= 3 && x.depth < 3);
          const parent = !hosts.length || r() < 0.55 ? null : pickWeighted(r, hosts, (x) => x.mass);
          b = { id: branches.length, parent: parent ? parent.id : null, depth: parent ? parent.depth + 1 : 1,
            t: parent ? 0.3 + 0.6 * r() : 0.3 + 0.65 * r(), side: r() < 0.5 ? -1 : 1, spread: r(),
            mass: 0, papers: [], born: p.day };
          branches.push(b);
          p.grew = { to: 'branch', branch: b.id, new: true };
        } else {
          b = pickWeighted(r, branches, (x) => x.mass);
          p.grew = { to: 'branch', branch: b.id, new: false };
        }
        b.mass += p.weight;
        b.papers.push(p.id);
      } else {
        trunk.mass += p.weight;
        p.grew = { to: 'trunk' };
      }
      grown += p.weight;
    }
    for (const l of leaves) {
      const r = rng(seed, 'leaf', l.id);
      l.weight = good.has(l.day) ? GOOD_DAY : 1;
      l.host = branches.length ? branches[Math.floor(r() * branches.length)].id : null;
      l.t = 0.45 + 0.55 * r();
      l.side = r() < 0.5 ? -1 : 1;
      l.tilt = r();
    }
    for (const c of creatures) {
      const own = (treeDoc.creatures || {})[c.id] || {};
      const a = ANIMALS.find(([k]) => k === own.animal) || ANIMALS[hash(seed, 'animal', c.id) % ANIMALS.length];
      c.animal = a[0];
      c.emoji = a[1];
      c.name = own.name || null;
      const n = c.doi ? ((cites.dois || {})[String(c.doi).toLowerCase()] || {}).count : undefined;
      c.citations = Number.isFinite(n) ? n : null;
      c.size = 1 + 0.25 * Math.log(1 + (c.citations || 0));     // grows with the log of its citations
      c.startHour = hourOf(c.at);
    }
    const branchMass = branches.reduce((s, b) => s + b.mass, 0);
    const events = [
      ...papers.map((p) => ({ day: p.day, kind: 'paper', id: p.id, title: p.title, weight: p.weight, grew: p.grew })),
      ...leaves.map((l) => ({ day: l.day, kind: 'leaf', id: l.id, title: l.title, weight: l.weight, deadline: l.deadline })),
      ...passed.map((p) => ({ day: p.day, kind: 'passed', id: p.id, title: p.title, deadline: p.deadline })),
      ...creatures.map((c) => ({ day: c.day, kind: 'creature', id: c.id, title: c.title, animal: c.animal })),
    ].sort((a, b) => b.day.localeCompare(a.day));
    return { seed, today, papers, leaves, passed, creatures, goodDays, branches, events,
      trunk, mass: { trunk: trunk.mass - 1, branches: branchMass, total: grown },
      leafCount: leaves.reduce((s, l) => s + l.weight, 0), stage: stageOf(grown), share: branchShare(grown) };
  }

  // ---------------------------------------------------------------- layout (tree units, y up)

  // Trunk: mass ~ D^(8/3) and height ~ D^(2/3), the metabolic-scaling forms; drawn shorter and wider than a
  // real stem so the crown stays readable. Branches: base width ~ m^(3/8), length ~ m^(0.35), at most 0.8 H.
  function layout(state) {
    const D = 0.55 * Math.pow(state.trunk.mass, 3 / 8);
    const H = 11 * Math.pow(D, 2 / 3) + 4;
    const segs = [{ id: 'trunk', x: 0, y: 0, ang: Math.PI / 2, len: H, w0: D, w1: Math.max(0.12, 0.3 * D), kind: 'trunk' }];
    const segOf = new Map([['trunk', segs[0]]]);
    const at = (s, t) => ({ x: s.x + Math.cos(s.ang) * s.len * t, y: s.y + Math.sin(s.ang) * s.len * t });
    const widthAt = (s, t) => s.w0 + (s.w1 - s.w0) * t;
    for (const b of state.branches) {
      const p = b.parent == null ? segs[0] : segOf.get(`b${b.parent}`);
      const base = at(p, b.t);
      const off = p.kind === 'trunk' ? (30 + 35 * b.spread) : (20 + 25 * b.spread);
      const ang = p.ang + b.side * off * Math.PI / 180;
      const w0 = Math.min(0.32 * Math.pow(Math.max(b.mass, 0.5), 3 / 8), 0.8 * widthAt(p, b.t));
      const s = { id: `b${b.id}`, branch: b.id, x: base.x, y: base.y, ang, len: Math.min(0.8 * H, 4.2 * Math.pow(Math.max(b.mass, 0.5), 0.35) + 1.5),
        w0, w1: Math.max(0.06, 0.25 * w0), kind: 'branch', parent: p.id, t: b.t };
      segs.push(s);
      segOf.set(s.id, s);
    }
    const leafSize = 0.9 + 0.035 * H;
    const leaves = state.leaves.map((l) => {
      const s = l.host == null ? segs[0] : segOf.get(`b${l.host}`);
      const t = l.host == null ? 0.7 + 0.3 * l.t : l.t;
      const p = at(s, t);
      return { id: l.id, x: p.x, y: p.y, ang: s.ang + l.side * (0.5 + 0.7 * l.tilt), size: leafSize * (l.weight > 1 ? 1.4 : 1), good: l.weight > 1 };
    });
    // Walk graph: on each segment, its ends, its children's attach points and stops about H/10 apart;
    // neighbours along the segment.
    const ts = new Map(segs.map((s) => {
      const k = Math.max(1, Math.round(s.len / (H / 10)));
      return [s.id, new Set(Array.from({ length: k + 1 }, (_, j) => j / k))];
    }));
    segs.slice(1).forEach((s) => ts.get(s.parent).add(s.t));
    const key = (sid, t) => {
      if (t === 0 && sid !== 'trunk') { const s = segOf.get(sid); return key(s.parent, s.t); }
      return `${sid}@${t}`;
    };
    const nodes = new Map();
    const adj = new Map();
    const link = (a, b) => { adj.get(a).add(b); adj.get(b).add(a); };
    for (const s of segs) {
      const list = [...ts.get(s.id)].sort((a, b) => a - b);
      for (const t of list) {
        const k = key(s.id, t);
        if (!nodes.has(k)) { nodes.set(k, at(s, t)); adj.set(k, new Set()); }
      }
      for (let i = 1; i < list.length; i++) link(key(s.id, list[i - 1]), key(s.id, list[i]));
    }
    const graph = { start: 'trunk@0', nodes, adj: new Map([...adj].map(([k, v]) => [k, [...v].sort()])) };
    return { H, D, segs, leaves, graph, leafSize, at };
  }

  // ---------------------------------------------------------------- the hourly walk

  // A creature's node at `hour`: it starts at the foot of the trunk in the hour it arrived and each hour since
  // steps to a neighbouring node, chosen by a hash of (seed, creature, hour). Same inputs, same place on every
  // device. When the tree grows a branch the graph changes, and the creature may appear somewhere new.
  const MAX_STEPS = 50000;
  function walk(graph, seed, creatureId, startHour, hour) {
    let node = graph.start;
    const path = [node];
    for (let h = Math.max(startHour, hour - MAX_STEPS) + 1; h <= hour; h++) {
      const nb = graph.adj.get(node) || [];
      if (!nb.length) break;
      node = nb[Math.floor(rng(seed, 'walk', creatureId, h)() * nb.length)];
      path.push(node);
    }
    return { node, path };
  }

  // ---------------------------------------------------------------- SVG

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const f = (n) => (Math.round(n * 100) / 100).toString();

  // The tree as an SVG string. opts: {hour, labels (creature names), mini (no labels, no ground detail)}.
  // Elements carry data-k (trunk, branch, leaf, creature) and data-i (branch number or entry id) for taps.
  function svg(state, opts = {}) {
    const L = layout(state);
    const hour = opts.hour != null ? opts.hour : hourOf(Date.now());
    const pts = [];
    const poly = (s) => {
      const c = Math.cos(s.ang), si = Math.sin(s.ang);
      const nx = -si, ny = c;
      const ex = s.x + c * s.len, ey = s.y + si * s.len;
      const p = [[s.x + nx * s.w0 / 2, s.y + ny * s.w0 / 2], [ex + nx * s.w1 / 2, ey + ny * s.w1 / 2],
        [ex - nx * s.w1 / 2, ey - ny * s.w1 / 2], [s.x - nx * s.w0 / 2, s.y - ny * s.w0 / 2]];
      p.forEach((q) => pts.push(q));
      return p.map(([x, y]) => `${f(x)},${f(-y)}`).join(' ');
    };
    const wood = L.segs.map((s) => `<polygon class="wood" points="${poly(s)}" data-k="${s.kind}" data-i="${s.kind === 'trunk' ? 'trunk' : s.branch}"`
      + ` fill="${s.kind === 'trunk' ? '#6b4426' : '#7a5230'}" stroke="#4a2e18" stroke-width="${f(Math.max(0.04, s.w0 * 0.06))}" stroke-linejoin="round"/>`).join('');
    const leaves = L.leaves.map((l) => {
      const deg = -l.ang * 180 / Math.PI;
      const cx = l.x + Math.cos(l.ang) * l.size * 0.5, cy = l.y + Math.sin(l.ang) * l.size * 0.5;
      pts.push([cx - l.size, cy - l.size], [cx + l.size, cy + l.size]);
      return `<ellipse class="leaf" data-k="leaf" data-i="${esc(l.id)}" cx="${f(cx)}" cy="${f(-cy)}" rx="${f(l.size * 0.55)}" ry="${f(l.size * 0.25)}"`
        + ` transform="rotate(${f(deg)} ${f(cx)} ${f(-cy)})" fill="${l.good ? '#6dbb3c' : '#3f8f35'}" stroke="#2c6b25" stroke-width="${f(l.size * 0.04)}"/>`;
    }).join('');
    const unit = L.leafSize * 1.3;
    const critters = state.creatures.map((c) => {
      const { node } = walk(L.graph, state.seed, c.id, c.startHour, hour);
      const p = L.graph.nodes.get(node);
      const size = unit * c.size;
      pts.push([p.x - size, p.y], [p.x + size, p.y + size * 1.6]);
      const label = !opts.mini && opts.labels !== false
        ? `<text x="${f(p.x)}" y="${f(-p.y - size * 1.05)}" font-size="${f(unit * 0.42)}" text-anchor="middle" fill="currentColor" stroke="var(--tree-halo, #fff)" stroke-width="${f(unit * 0.08)}" paint-order="stroke">${esc(c.name || `${c.animal} (name me)`)}</text>` : '';
      return `<g class="creature" data-k="creature" data-i="${esc(c.id)}" data-node="${esc(node)}"><text x="${f(p.x)}" y="${f(-p.y)}" font-size="${f(size)}" text-anchor="middle">${c.emoji}</text>${label}</g>`;
    }).join('');
    pts.push([-L.H * 0.35, 0], [L.H * 0.35, L.H]);
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const pad = L.H * 0.06;
    const x0 = Math.min(...xs) - pad, x1 = Math.max(...xs) + pad, y0 = -Math.max(...ys) - pad, y1 = L.H * 0.06;
    const ground = `<ellipse cx="0" cy="0" rx="${f((x1 - x0) * 0.42)}" ry="${f(L.H * 0.035)}" fill="#8a6a45" opacity="0.35"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(x0)} ${f(y0)} ${f(x1 - x0)} ${f(y1 - y0)}" class="growth-tree" role="img"`
      + ` aria-label="${esc(state.stage)}: ${state.papers.length} papers, ${state.leaves.length} leaves">`
      + `${ground}${wood}${leaves}${critters}</svg>`;
  }

  return { hash, rng, dayOf, addDays, hourOf, branchShare, newBranchChance, stageOf, STAGES, ANIMALS, GOOD_DAY,
    MG_PER_UNIT, DEFAULT_SEED, derive, layout, walk, svg };
}));
