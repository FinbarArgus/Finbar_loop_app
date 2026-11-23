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
  // 45 Mg and more. That is the baseline share, branchShare(). MG_PER_UNIT maps the tree's mass (in papers;
  // a good-day paper counts 2) onto tree mass: about a year of reading reaches 10 Mg, about five years
  // 45 Mg. Between them the share rises linearly in log mass.
  const MG_PER_UNIT = 0.0225;
  function branchShare(units) {
    const mg = units * MG_PER_UNIT;
    if (mg <= 10) return 0.34;
    return Math.min(0.55, 0.34 + (0.50 - 0.34) * Math.log(mg / 10) / Math.log(45 / 10));
  }
  // BRANCH_WEIGHT (Finbar's choice, 2026-11-23: "branch networks reach much further out") multiplies the
  // baseline odds of branch over trunk: p = w q / (1 - q + w q) for baseline share q. With 3, a young tree
  // puts 61% of its wood into branches (34% baseline) and an old one 75% (50%).
  const BRANCH_WEIGHT = 3;
  function branchChance(units) {
    const q = branchShare(units);
    return BRANCH_WEIGHT * q / (1 - q + BRANCH_WEIGHT * q);
  }
  // Branch wood starts a new branch with probability 1 / (1 + n/6) (n branches so far), else lengthens an
  // existing one chosen in proportion to its mass, so a few limbs dominate as in a real crown. A new branch
  // grows from another branch with probability NEW_FROM_BRANCH (once one is big enough), else from the trunk.
  const newBranchChance = (n) => 1 / (1 + n / 6);
  const NEW_FROM_BRANCH = 0.75;
  const GOOD_DAY = 2;                             // growth earned on a good day counts double
  const STAGES = [[0, 'seedling'], [20, 'sapling'], [150, 'young tree'], [600, 'tree'], [1500, 'old tree']];
  const stageOf = (units) => STAGES.filter(([m]) => units >= m).pop()[1];
  // The animals, drawn in blocks: '#' ink, 'o' paper, ' ' clear.
  const ANIMALS = [
    ['owl', ['#      #', '########', '#oo##oo#', '#o#oo#o#', '#oo##oo#', ' #o##o# ', ' #oooo# ', ' ###### ', '  #  #  ']],
    ['squirrel', ['  ##   ##', ' #oo# #oo#', ' #o#o##oo#', '#ooooo#oo#', ' ##ooo#oo# ', '  #ooo#o#', '  #o#o## ', '  ## ##  ']],
    ['snail', ['#  #     ', '#  #  ###', ' ## ##ooo#', ' #o##o##o#', ' #oo#o#oo#', ' #oo#oo#o#', '##########']],
    ['beetle', [' #    # ', '  #  #  ', '  ####  ', ' #o##o# ', '#oo##oo#', '#o#oo#o#', '#oo##oo#', ' ###### ', '#  ##  #']],
    ['bird', ['   ###   ', '  #ooo#  ', '  #o#o###', ' #oooo#  ', '#ooooo#  ', '#o#ooo#  ', ' #####   ', '  #  #   ']],
    ['monkey', ['  ####   ', ' #oooo#  ', '#o#oo#o# ', '#oooooo# ', ' #o##o#  ', '  ####  #', ' #oooo# #', ' #oooo## ', ' #o##o#  ', ' ##  ##  ']],
    ['caterpillar', ['#  #         ', ' ###  ##  ## ', '#o#o##oo##oo#', '#ooo#oo##oo# ', ' ### #  #  # ']],
    ['bat', ['#   #   #   #', '##  #####  ##', '###o#o#o#o###', ' ##########  ', '  ## ### ##  ', '   #  #  #   ']],
  ];
  const CELL = 0.5;                               // one drawn block, in tree units
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
      if (r() < branchChance(grown)) {
        let b;
        if (!branches.length || r() < newBranchChance(branches.length)) {
          const hosts = branches.filter((x) => x.mass >= 2 && x.depth < 5);
          const parent = !hosts.length || r() >= NEW_FROM_BRANCH ? null : pickWeighted(r, hosts, (x) => x.mass);
          b = { id: branches.length, parent: parent ? parent.id : null, depth: parent ? parent.depth + 1 : 1,
            t: parent ? 0.25 + 0.7 * r() : 0.3 + 0.65 * r(), side: r() < 0.5 ? -1 : 1, spread: r(),
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
      c.sprite = a[1];
      c.name = own.name || null;
      const n = c.doi ? ((cites.dois || {})[String(c.doi).toLowerCase()] || {}).count : undefined;
      c.citations = Number.isFinite(n) ? n : null;
      // Block scale grows with the log of its citations: 1 at 0, 2 from 3, 3 from 20, 4 from 148.
      c.size = 1 + Math.floor(0.5 * Math.log(1 + (c.citations || 0)));
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
      leafCount: leaves.reduce((s, l) => s + l.weight, 0), stage: stageOf(grown), share: branchShare(grown), chance: branchChance(grown) };
  }

  // ---------------------------------------------------------------- layout (tree units, y up)

  // Trunk: mass ~ D^(8/3) and height ~ D^(2/3), the metabolic-scaling forms; drawn shorter and wider than a
  // real stem so the crown stays readable. Branches: base width ~ m^(3/8), length ~ m^(0.45), at most 1.3 H,
  // so the branch network reaches well beyond the trunk.
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
      const off = p.kind === 'trunk' ? (30 + 35 * b.spread) : (20 + 30 * b.spread);
      const ang = p.ang + b.side * off * Math.PI / 180;
      const m = Math.max(b.mass, 0.5);
      const w0 = Math.min(0.32 * Math.pow(m, 3 / 8), 0.8 * widthAt(p, b.t));
      const s = { id: `b${b.id}`, branch: b.id, x: base.x, y: base.y, ang, len: Math.min(1.3 * H, 4.5 * Math.pow(m, 0.45) + 1.5),
        w0, w1: Math.max(0.06, 0.25 * w0), kind: 'branch', parent: p.id, t: b.t };
      segs.push(s);
      segOf.set(s.id, s);
    }
    const leaves = state.leaves.map((l) => {
      const s = l.host == null ? segs[0] : segOf.get(`b${l.host}`);
      const t = l.host == null ? 0.7 + 0.3 * l.t : l.t;
      const p = at(s, t);
      const a = s.ang + l.side * (0.5 + 0.7 * l.tilt);
      const r = CELL * (l.weight > 1 ? 2.5 : 1.8);
      return { id: l.id, x: p.x + Math.cos(a) * r, y: p.y + Math.sin(a) * r, good: l.weight > 1 };
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
    return { H, D, segs, leaves, graph, at, widthAt };
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

  // ---------------------------------------------------------------- SVG: black-and-white pixel blocks

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const f = (n) => (Math.round(n * 100) / 100).toString();
  const INK = '#111', PAPER = '#fff';
  // Leaves: a diamond outline of cells, 3 wide (5 on a good day).
  const LEAF = [[' # ', '#o#', ' # '], ['  #  ', ' #o# ', '#ooo#', ' #o# ', '  #  ']];

  // Cells (integer i, j; j up) -> SVG rects, one per horizontal run.
  function runs(cells, fill, extra = '') {
    const rows = new Map();
    for (const c of cells) {
      const [i, j] = c.split(',').map(Number);
      if (!rows.has(j)) rows.set(j, []);
      rows.get(j).push(i);
    }
    let out = '';
    for (const [j, is] of rows) {
      is.sort((a, b) => a - b);
      for (let k = 0; k < is.length;) {
        let e = k;
        while (e + 1 < is.length && is[e + 1] === is[e] + 1) e++;
        out += `<rect x="${f(is[k] * CELL)}" y="${f(-(j + 1) * CELL)}" width="${f((e - k + 1) * CELL)}" height="${f(CELL)}" fill="${fill}"${extra}/>`;
        k = e + 1;
      }
    }
    return out;
  }
  // A sprite (rows of '#' ink, 'o' paper, ' ' clear) at cell (i, j) = its bottom-centre, scaled by n.
  function stamp(rows, i, j, n, ink, paper) {
    const w = rows[0].length, h = rows.length;
    const i0 = i - Math.floor(w * n / 2);
    rows.forEach((row, r) => [...row].forEach((ch, k) => {
      if (ch === ' ') return;
      for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
        (ch === '#' ? ink : paper).add(`${i0 + k * n + a},${j + (h - 1 - r) * n + b}`);
      }
    }));
    return { i0, j0: j, w: w * n, h: h * n };
  }

  // The tree as an SVG string, drawn in CELL-sized blocks. opts: {hour, mini (no names, no tap targets)}.
  // Tap targets carry data-k (trunk, branch, leaf, creature) and data-i (branch number or entry id).
  function svg(state, opts = {}) {
    const L = layout(state);
    const hour = opts.hour != null ? opts.hour : hourOf(Date.now());
    const cell = (x, y) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
    const wood = new Set();
    const hits = [];
    for (const s of L.segs) {                      // rasterise each segment with a square brush
      const steps = Math.max(2, Math.ceil(s.len / (CELL * 0.4)));
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const p = L.at(s, t);
        const hw = Math.max(CELL * 0.5, L.widthAt(s, t) / 2);
        for (let x = p.x - hw + CELL / 2; x <= p.x + hw - CELL / 2 + 1e-9; x += CELL) {
          for (let y = p.y - hw + CELL / 2; y <= p.y + hw - CELL / 2 + 1e-9; y += CELL) wood.add(cell(x, y));
        }
        wood.add(cell(p.x, p.y));
      }
      const c = Math.cos(s.ang), si = Math.sin(s.ang), w = Math.max(s.w0, CELL * 2);
      const ex = s.x + c * s.len, ey = s.y + si * s.len;
      hits.push(`<polygon points="${[[s.x - si * w / 2, s.y + c * w / 2], [ex - si * w / 2, ey + c * w / 2], [ex + si * w / 2, ey - c * w / 2], [s.x + si * w / 2, s.y - c * w / 2]]
        .map(([x, y]) => `${f(x)},${f(-y)}`).join(' ')}" data-k="${s.kind}" data-i="${s.kind === 'trunk' ? 'trunk' : s.branch}"/>`);
    }
    const leafInk = new Set(), leafPaper = new Set();
    L.leaves.forEach((l) => {
      const [i, j] = cell(l.x, l.y).split(',').map(Number);
      const b = stamp(LEAF[l.good ? 1 : 0], i, j - (l.good ? 2 : 1), 1, leafInk, leafPaper);
      hits.push(`<rect x="${f(b.i0 * CELL)}" y="${f(-(b.j0 + b.h) * CELL)}" width="${f(b.w * CELL)}" height="${f(b.h * CELL)}" data-k="leaf" data-i="${esc(l.id)}"/>`);
    });
    const critInk = new Set(), critPaper = new Set();
    let labels = '';
    state.creatures.forEach((c) => {
      const { node } = walk(L.graph, state.seed, c.id, c.startHour, hour);
      const p = L.graph.nodes.get(node);
      const [i, j] = cell(p.x, p.y).split(',').map(Number);
      const b = stamp(c.sprite, i, j + 1, c.size, critInk, critPaper);
      hits.push(`<rect x="${f(b.i0 * CELL)}" y="${f(-(b.j0 + b.h) * CELL)}" width="${f(b.w * CELL)}" height="${f(b.h * CELL)}" data-k="creature" data-i="${esc(c.id)}" data-node="${esc(node)}"/>`);
      if (!opts.mini) {
        labels += `<text x="${f((b.i0 + b.w / 2) * CELL)}" y="${f(-(b.j0 + b.h + 0.6) * CELL)}" font-size="${f(CELL * 3.2)}" font-family="ui-monospace, Menlo, Consolas, monospace" font-weight="700"`
          + ` text-anchor="middle" fill="${INK}" stroke="${PAPER}" stroke-width="${f(CELL * 0.9)}" paint-order="stroke">${esc(c.name || `${c.animal} (name me)`)}</text>`;
      }
    });
    const all = [...wood, ...leafInk, ...leafPaper, ...critInk, ...critPaper].map((c) => c.split(',').map(Number));
    const is = all.map((c) => c[0]), js = all.map((c) => c[1]);
    const pad = 3 + (opts.mini ? 0 : 4);
    const i0 = Math.min(...is, -6) - pad, i1 = Math.max(...is, 6) + pad + 1, j1 = Math.max(...js) + pad + 1, jg = -2;
    const ground = new Set();
    const g = Math.round((i1 - i0) * 0.35);
    for (let i = -g; i <= g; i++) ground.add(`${i},-1`);
    const x0 = i0 * CELL, y0 = -j1 * CELL, w = (i1 - i0) * CELL, h = (j1 - jg) * CELL;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(x0)} ${f(y0)} ${f(w)} ${f(h)}" class="growth-tree" role="img" shape-rendering="crispEdges"`
      + ` aria-label="${esc(state.stage)}: ${state.papers.length} papers, ${state.leaves.length} leaves">`
      + `<rect x="${f(x0)}" y="${f(y0)}" width="${f(w)}" height="${f(h)}" fill="${PAPER}"/>`
      + runs(ground, INK) + runs(wood, INK) + runs(leafPaper, PAPER) + runs(leafInk, INK)
      + runs(critPaper, PAPER) + runs(critInk, INK) + labels
      + (opts.mini ? '' : `<g class="hits" fill="#000" fill-opacity="0">${hits.join('')}</g>`) + '</svg>';
  }

  return { hash, rng, dayOf, addDays, hourOf, branchShare, branchChance, BRANCH_WEIGHT, NEW_FROM_BRANCH, newBranchChance,
    stageOf, STAGES, ANIMALS, GOOD_DAY, MG_PER_UNIT, DEFAULT_SEED, CELL, derive, layout, walk, svg };
}));
