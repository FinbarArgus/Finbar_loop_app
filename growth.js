// The growth tree: a pure function of Finbar's Mine entries, personal/tree.json (seed, creature names) and
// state/citations.json (citation counts by DOI). Nothing here reads the network or the clock: callers pass
// `now`, so the same inputs always give the same tree, and the hourly creature walk is fixed per hour.
// Loaded in the browser (window.LoopGrowth) and by Node (tests, tools/tree_examples.js).
//
// The tree mirrors the Zotero collection tree: each topic collection (not `_work`) is a branch, its
// subcollections branch from it, and every paper read grows its own collection's branch by one segment (no other
// branch) and adds to the trunk's height and mass. Deadlines met grow leaves; submitted papers unlock animals that walk the tree.
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
  const DEG = Math.PI / 180;
  const UP = Math.PI / 2;

  // ---------------------------------------------------------------- growth rules

  // Multiplier (Finbar, Q-0027): a good day is one with a paper read and no deadline passing. The n-th good
  // day in a row multiplies that day's growth by 1 + 0.2 (n - 1), up to 2: 1x, 1.2x, 1.4x, 1.6x, 1.8x, 2x.
  // It sets the length of the segment each paper grows (and so the wood it adds), nothing else.
  const STREAK_STEP = 0.2;
  const MAX_MULT = 2;
  const multOf = (streak) => (streak > 0 ? Math.min(MAX_MULT, 1 + STREAK_STEP * (streak - 1)) : 1);
  // Lengths, in tree units (drawn as metres on the height scale; a block is CELL units). A paper's segment is
  // SEG x its multiplier, shrinking along a long branch as 1/sqrt(1 + k/SEG_HALF) for its k-th paper, so one
  // busy collection does not outgrow the whole tree. Only the paper's own collection grows (Finbar, C-0006): a
  // collection with no paper of its own (a parent of the paper's collection) is a STUB, one STUB longer for each
  // further subcollection born on it, so its subtopics have room. From the sapling stage (SAPLING units grown) the
  // trunk's height is TRUNK_BASE + TRUNK_K sqrt(growth so far); a seedling starts SEEDLING tall and rises in a
  // straight line to that height at SAPLING, so it starts small (Finbar). Each paper adds the rise it causes as a
  // trunk segment, and its wood thickens the trunk (Leonardo's rule, below).
  const SEG = 1;
  const SEG_HALF = 20;
  const STUB = 1.5;
  const TRUNK_BASE = 4;
  const TRUNK_K = 4;
  const SEEDLING = 1;
  const SAPLING = 20;
  const grownHeight = (grown) => TRUNK_BASE + TRUNK_K * Math.sqrt(grown);
  const trunkHeight = (grown) => (grown >= SAPLING ? grownHeight(grown)
    : SEEDLING + (grownHeight(SAPLING) - SEEDLING) * Math.max(0, grown) / SAPLING);
  // A young tree is the same tree drawn smaller (Finbar, Q-0036): below SAPLING units grown the whole drawing,
  // blocks and branches with it, is scaled by youngScale(grown) = (grown / SAPLING)^YOUNG_P, which is 0 with nothing
  // grown and 1 from SAPLING on. YOUNG_P puts the first paper's tree at FIRST_HEIGHT (5 cm). Heights: 0 m, then 5 cm
  // after 1 paper, ~1.1 m after 5, ~22 m after 20, ~44 m after 100.
  const FIRST_HEIGHT = 0.05;
  const YOUNG_P = Math.log(trunkHeight(1) / FIRST_HEIGHT) / Math.log(SAPLING);
  const youngScale = (grown) => (grown >= SAPLING ? 1 : Math.pow(Math.max(0, grown) / SAPLING, YOUNG_P));
  // The tree view is never shorter than a seedling's frame (a little over its height at SAPLING), so a seedling
  // stands small in it and grows into it.
  const MIN_FRAME = Math.ceil(grownHeight(SAPLING) + 2);
  // Shape: the branches of one parent leave it in the order they were born, oldest lowest, spread over
  // ATTACH (fractions of the parent's length), alternately left and right, 25-45 degrees off the trunk
  // (18-36 off a branch). Each segment turns BEND of the way towards LEAN off vertical on its side, so the
  // tree grows upwards and stays narrow. As the tree grows the branches move up with their parent.
  const BEND = 0.08;
  const LEAN = 14 * DEG;
  const MAX_TILT = 62 * DEG;
  const ATTACH = { trunk: [0.12, 0.92], branch: [0.25, 0.92] };
  // Width: Leonardo's rule (area is conserved through each fork; Eloy 2011, "Leonardo's rule, self-similarity,
  // and wind-induced stresses in trees", Phys. Rev. Lett. 107, 258101, doi:10.1103/PhysRevLett.107.258101): a
  // point's cross-section is proportional to the wood it carries, so its width is WIDTH_K sqrt(1 + growth beyond).
  const WIDTH_K = 0.12;
  const STAGES = [[0, 'seedling'], [SAPLING, 'sapling'], [150, 'young tree'], [600, 'tree'], [1500, 'old tree']];
  const stageOf = (units) => STAGES.filter(([m]) => units >= m).pop()[1];
  // The animals, drawn in blocks: '#' its ink, 'o' its fill, ' ' clear; each in muted colours [ink, fill].
  const ANIMALS = [
    ['owl', ['#      #', '########', '#oo##oo#', '#o#oo#o#', '#oo##oo#', ' #o##o# ', ' #oooo# ', ' ###### ', '  #  #  '], ['#6b5a48', '#d8c8a8']],
    ['squirrel', ['  ##   ##', ' #oo# #oo#', ' #o#o##oo#', '#ooooo#oo#', ' ##ooo#oo# ', '  #ooo#o#', '  #o#o## ', '  ## ##  '], ['#8a5a3e', '#dcc0a4']],
    ['snail', ['#  #     ', '#  #  ###', ' ## ##ooo#', ' #o##o##o#', ' #oo#o#oo#', ' #oo#oo#o#', '##########'], ['#5e6870', '#d3cbb0']],
    ['beetle', [' #    # ', '  #  #  ', '  ####  ', ' #o##o# ', '#oo##oo#', '#o#oo#o#', '#oo##oo#', ' ###### ', '#  ##  #'], ['#4e5e4c', '#a9b89c']],
    ['bird', ['   ###   ', '  #ooo#  ', '  #o#o###', ' #oooo#  ', '#ooooo#  ', '#o#ooo#  ', ' #####   ', '  #  #   '], ['#55697e', '#bccad6']],
    ['monkey', ['  ####   ', ' #oooo#  ', '#o#oo#o# ', '#oooooo# ', ' #o##o#  ', '  ####  #', ' #oooo# #', ' #oooo## ', ' #o##o#  ', ' ##  ##  '], ['#765a46', '#d4bca2']],
    ['caterpillar', ['#  #         ', ' ###  ##  ## ', '#o#o##oo##oo#', '#ooo#oo##oo# ', ' ### #  #  # '], ['#62774a', '#c6d2a2']],
    ['bat', ['#   #   #   #', '##  #####  ##', '###o#o#o#o###', ' ##########  ', '  ## ### ##  ', '   #  #  #   '], ['#5b5368', '#bbb3c8']],
  ];
  const CELL = 0.5;                               // one drawn block, in tree units
  const DEFAULT_SEED = 'loop-tree';

  // The branch path of a Read entry: its Zotero collection's name split into its ancestors
  // ('physiology / cardiac' -> ['physiology', 'physiology / cardiac']). `_work` collections and entries with
  // no collection give [] (they grow the trunk only).
  function topicPath(e) {
    const name = e && e.zotero && e.zotero.name ? String(e.zotero.name) : '';
    const parts = name.split('/').map((s) => s.trim()).filter(Boolean);
    if (!parts.length || parts[0].startsWith('_')) return [];
    return parts.map((_, i) => parts.slice(0, i + 1).join(' / '));
  }

  // When a Write entry reached each state. `submitted_at` and `published_at` are set by the app when ticked;
  // `updated` stands in when they are missing.
  const stateAt = (e, k) => (e[k] ? (e[`${k}_at`] || e.updated || e.created) : null);

  // ---------------------------------------------------------------- geometry

  // Places every chain (parents before children): each segment's ends (x0, y0, x1, y1), and each branch's
  // `at`, the node of its parent it leaves from.
  function geometry(order, seed) {
    const byId = new Map(order.map((c) => [c.id, c]));
    for (const c of order) {
      let x = 0, y = 0, ang = UP, side = 0, target = UP;
      if (c.parent) {
        const p = byId.get(c.parent);
        const sibs = p.kids;
        const [lo, hi] = ATTACH[p.parent ? 'branch' : 'trunk'];
        const t = lo + (hi - lo) * (c.rank + 0.3 + 0.4 * c.at) / sibs;
        const L = p.segs.reduce((acc, g) => acc + g.len, 0);
        let run = 0, n = 0;
        while (n < p.segs.length && run + p.segs[n].len / 2 < t * L) run += p.segs[n++].len;
        c.node = Math.max(1, n);                    // the node at fraction t of the parent's length
        const g = p.segs[c.node - 1];
        x = g.x1; y = g.y1;
        if (p.firstSide == null) p.firstSide = hash(seed, 'side', p.id) % 2 ? 1 : -1;
        side = c.rank % 2 ? -p.firstSide : p.firstSide;
        const off = p.parent ? (18 + 18 * c.off) * DEG : (25 + 20 * c.off) * DEG;
        ang = UP + Math.max(-MAX_TILT, Math.min(MAX_TILT, g.ang - UP + side * off));
        target = UP + side * LEAN;
      }
      c.side = side;
      c.segs.forEach((g, i) => {
        if (c.parent && i > 0) ang += (target - ang) * BEND;
        const a = c.parent ? ang + g.wob : UP;
        g.ang = a;
        g.x0 = x; g.y0 = y;
        x += Math.cos(a) * g.len; y += Math.sin(a) * g.len;
        g.x1 = x; g.y1 = y;
      });
    }
  }

  // ---------------------------------------------------------------- derivation

  // entries: Mine entries ({id, kind, done, done_at, updated, created, deadline, title, zotero: {name}}; write
  // entries also {draft, submitted, submitted_at, published, published_at, doi}).
  // treeDoc: {seed, creatures: {<entry id>: {name, animal}}}. cites: {dois: {<doi>: {count}}}. now: Date|ISO.
  function derive(entries, treeDoc = {}, cites = {}, now = new Date()) {
    const seed = String(treeDoc.seed || DEFAULT_SEED);
    const today = dayOf(now);
    const papers = [];
    const leaves = [];
    const passed = [];
    const creatures = [];
    const birds = [];
    const upTo = (iso) => (iso && dayOf(iso) <= today ? iso : null);   // a state reached after `now` is not reached yet
    for (const e of entries || []) {
      if (e.created && dayOf(e.created) > today) continue;               // not made yet at `now`
      const doneAt = e.done ? upTo(e.done_at || e.updated || e.created) : null;
      const doneDay = doneAt ? dayOf(doneAt) : null;
      if (e.kind === 'read' && doneDay) {
        papers.push({ id: e.id, day: doneDay, at: doneAt, title: e.title || '', journal: e.journal || null,
          full_title: e.full_title || null, path: topicPath(e) });
      }
      if (e.deadline) {
        if (doneDay && doneDay <= e.deadline) leaves.push({ id: e.id, day: doneDay, at: doneAt, deadline: e.deadline, title: e.title || '' });
        const pd = addDays(e.deadline, 1);       // a deadline passes when its day ends
        if (pd <= today && (!doneDay || doneDay > e.deadline)) passed.push({ id: e.id, day: pd, deadline: e.deadline, title: e.title || '' });
        // A deadline not yet met is a bird: `days` to the end of its day (negative once passed, when it turns evil).
        if (!doneDay) {
          const [y, m, d] = e.deadline.split('-').map(Number);
          const days = (new Date(y, m - 1, d + 1) - new Date(now)) / 864e5;
          birds.push({ id: e.id, deadline: e.deadline, title: e.title || '', kind: e.kind || null, days, evil: days <= 0 });
        }
      }
      const sub = e.kind === 'write' ? upTo(stateAt(e, 'submitted')) : null;
      if (sub) {
        const pub = upTo(stateAt(e, 'published'));
        creatures.push({ id: e.id, day: dayOf(sub), at: sub, doi: e.doi || null, published: !!pub, title: e.title || '' });
      }
    }
    const byTime = (a, b) => a.day.localeCompare(b.day) || String(a.at || '').localeCompare(String(b.at || '')) || a.id.localeCompare(b.id);
    [papers, leaves, passed, creatures].forEach((l) => l.sort(byTime));
    birds.sort((a, b) => a.deadline.localeCompare(b.deadline) || a.id.localeCompare(b.id));

    // Good days and streaks: consecutive calendar days, each with a paper read and no deadline passing.
    const passedDays = new Set(passed.map((p) => p.day));
    const goodDays = [...new Set(papers.map((p) => p.day))].filter((d) => !passedDays.has(d)).sort();
    const streak = new Map();
    goodDays.forEach((d) => streak.set(d, (streak.get(addDays(d, -1)) || 0) + 1));
    const multOfDay = (d) => multOf(streak.get(d) || 0);

    // Branches: chains of segments, the trunk first. Growth builds the structure (each chain's segments, in
    // order, with their length, a seeded wobble, paper, weight and day); geometry() then places it.
    // chain: {id, parent, rank (birth order among its parent's branches), segs, papers, kids}.
    const trunk = { id: 'trunk', parent: null, rank: 0, segs: [], papers: 0, kids: 0, born: null };
    const chains = new Map([['trunk', trunk]]);
    const order = [trunk];
    const seg = (c, len, r, paper, weight, day) => c.segs.push({ len, wob: r ? (r() - 0.5) * 8 * DEG : 0, paper, weight, day });
    let grown = 0;
    seg(trunk, trunkHeight(0), null, null, 0, null);
    for (const p of papers) {
      const r = rng(seed, 'paper', p.id);
      p.mult = multOfDay(p.day);
      const rise = trunkHeight(grown + p.mult) - trunkHeight(grown);
      grown += p.mult;
      let host = trunk;
      for (const name of p.path) {
        let c = chains.get(name);
        if (!c) {
          if (host !== trunk && host.kids > 0) seg(host, STUB, r, null, 0, p.day);   // room for another subtopic
          c = { id: name, parent: host.id, rank: host.kids++, segs: [], papers: 0, kids: 0, born: p.day,
            off: r(), at: r() };
          chains.set(name, c);
          order.push(c);
          if (name !== p.path[p.path.length - 1]) seg(c, STUB, r, null, 0, p.day);
        }
        host = c;
      }
      if (host === trunk) {
        seg(trunk, rise, null, p.id, p.mult, p.day);             // an unsorted paper's wood stays in the trunk
        p.len = rise;
      } else {
        seg(trunk, rise, null, p.id, 0, p.day);
        p.len = SEG * p.mult / Math.sqrt(1 + host.papers / SEG_HALF);
        seg(host, p.len, r, p.id, p.mult, p.day);
        host.papers += 1;
      }
      p.branch = host.id;
    }
    geometry(order, seed);
    // Widths: growth carried beyond each node (the chain's own later segments plus every branch leaving there
    // or later), so every segment tapers from its base to its tip.
    const total = new Map();
    for (const c of [...order].reverse()) {
      let t = c.segs.reduce((s, g) => s + g.weight, 0);
      for (const k of order) if (k.parent === c.id) t += total.get(k.id);
      total.set(c.id, t);
    }
    for (const c of order) {
      const beyond = new Array(c.segs.length + 1).fill(0);
      for (const k of order) if (k.parent === c.id) beyond[k.node] += total.get(k.id);
      let acc = 0;
      for (let i = c.segs.length; i >= 0; i--) {
        acc += beyond[i];
        if (i < c.segs.length) {
          c.segs[i].w1 = WIDTH_K * Math.sqrt(1 + acc);
          acc += c.segs[i].weight;
          c.segs[i].w0 = WIDTH_K * Math.sqrt(1 + acc);
        }
      }
    }

    // Leaves: each on a random branch segment that existed when the leaf grew (the trunk top if none).
    const branchSegs = [];
    for (const c of order) if (c !== trunk) c.segs.forEach((g, i) => branchSegs.push({ c, i, g }));
    branchSegs.sort((a, b) => String(a.g.day).localeCompare(String(b.g.day)) || a.c.id.localeCompare(b.c.id) || a.i - b.i);
    for (const l of leaves) {
      const r = rng(seed, 'leaf', l.id);
      l.mult = multOfDay(l.day);
      const then = branchSegs.filter((s) => s.g.day && s.g.day <= l.day);
      const s = then.length ? then[Math.floor(r() * then.length)] : { c: trunk, i: trunk.segs.length - 1 };
      l.host = s.c.id;
      l.seg = s.i;
      l.t = 0.2 + 0.8 * r();
      l.side = r() < 0.5 ? -1 : 1;
      l.tilt = r();
    }
    for (const c of creatures) {
      const own = (treeDoc.creatures || {})[c.id] || {};
      const a = ANIMALS.find(([k]) => k === own.animal) || ANIMALS[hash(seed, 'animal', c.id) % ANIMALS.length];
      c.animal = a[0];
      c.sprite = a[1];
      [c.ink, c.fill] = a[2];
      c.name = own.name || null;
      const n = c.doi ? ((cites.dois || {})[String(c.doi).toLowerCase()] || {}).count : undefined;
      c.citations = Number.isFinite(n) ? n : null;
      // Block scale: one step per factor of ten in citations: 1 under 9, 2 from 9, 3 from 99.
      c.size = 1 + Math.floor(Math.log10(1 + (c.citations || 0)));
      c.startHour = hourOf(c.at);
    }
    const events = [
      ...papers.map((p) => ({ day: p.day, kind: 'paper', id: p.id, title: p.title, mult: p.mult, branch: p.branch })),
      ...leaves.map((l) => ({ day: l.day, kind: 'leaf', id: l.id, title: l.title, mult: l.mult, deadline: l.deadline })),
      ...passed.map((p) => ({ day: p.day, kind: 'passed', id: p.id, title: p.title, deadline: p.deadline })),
      ...creatures.map((c) => ({ day: c.day, kind: 'creature', id: c.id, title: c.title, animal: c.animal })),
    ].sort((a, b) => b.day.localeCompare(a.day));
    const lastGood = goodDays[goodDays.length - 1];
    const streakNow = lastGood && (lastGood === today || lastGood === addDays(today, -1)) ? streak.get(lastGood) : 0;
    const scale = youngScale(grown);
    return { seed, today, papers, leaves, passed, creatures, birds, goodDays, events, chains: order, grown, scale,
      height: scale * Math.max(...order.flatMap((c) => c.segs.map((g) => Math.max(g.y0, g.y1)))),
      streak: streakNow, mult: multOf(streakNow), multToday: multOfDay(today),
      stage: stageOf(grown) };
  }

  // ---------------------------------------------------------------- layout: leaves and the walk graph

  const at = (g, t) => ({ x: g.x0 + (g.x1 - g.x0) * t, y: g.y0 + (g.y1 - g.y0) * t });
  function layout(state) {
    const byId = new Map(state.chains.map((c) => [c.id, c]));
    const leaves = state.leaves.map((l) => {
      const g = byId.get(l.host).segs[l.seg];
      const p = at(g, l.t);
      const ang = Math.atan2(g.y1 - g.y0, g.x1 - g.x0) + l.side * (0.6 + 0.7 * l.tilt);
      const r = CELL * (l.mult > 1 ? 2.5 : 1.8) + g.w0 / 2;
      return { id: l.id, x: p.x + Math.cos(ang) * r, y: p.y + Math.sin(ang) * r, big: l.mult >= 1.6 };
    });
    // Walk graph: on each chain its ends, the nodes where branches leave, and a stop about every STOP_M along
    // it; neighbours along the chain. A branch's first node is its parent's node where it leaves.
    const key = (c, i) => (i === 0 && c.parent ? key(byId.get(c.parent), c.node) : `${c.id}#${i}`);
    const keep = new Map(state.chains.map((c) => [c.id, new Set([0, c.segs.length])]));
    for (const c of state.chains) {
      if (c.parent) keep.get(c.parent).add(c.node);
      let run = 0;
      c.segs.forEach((g, i) => { run += g.len; if (run >= STOP_M) { keep.get(c.id).add(i + 1); run = 0; } });
    }
    const nodes = new Map();
    const adj = new Map();
    const add = (k, p) => { if (!nodes.has(k)) { nodes.set(k, p); adj.set(k, new Set()); } };
    for (const c of state.chains) {
      if (!c.segs.length) continue;
      const list = [...keep.get(c.id)].sort((x, y) => x - y);
      const pos = (i) => (i === 0 ? { x: c.segs[0].x0, y: c.segs[0].y0 } : { x: c.segs[i - 1].x1, y: c.segs[i - 1].y1 });
      list.forEach((i, n) => {
        add(key(c, i), pos(i));
        if (n) { adj.get(key(c, list[n - 1])).add(key(c, i)); adj.get(key(c, i)).add(key(c, list[n - 1])); }
      });
    }
    const graph = { start: 'trunk#0', nodes, adj: new Map([...adj].map(([k, v]) => [k, [...v].sort()])) };
    // Birds land on a node in the crown: the top quarter of the walk graph's nodes, one chosen per deadline.
    const top = [...nodes].sort((a, b) => b[1].y - a[1].y || a[0].localeCompare(b[0]));
    const crown = top.slice(0, Math.max(1, Math.ceil(top.length / 4)));
    const birds = (state.birds || []).map((b) => {
      const [node, p] = crown[Math.floor(rng(state.seed, 'bird', b.id)() * crown.length)];
      return { id: b.id, node, x: p.x, y: p.y };
    });
    return { leaves, graph, birds };
  }

  // ---------------------------------------------------------------- the hourly walk

  // A creature's node at `hour`: it starts at the foot of the trunk in the hour it arrived and each hour since
  // steps to a neighbouring node, chosen by a hash of (seed, creature, hour). Same inputs, same place on every
  // device. When the tree grows the graph changes, and the creature may appear somewhere new.
  const MAX_STEPS = 50000;
  const STOP_M = 4;
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

  // ---------------------------------------------------------------- SVG: pixel blocks in muted colours

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const f = (n) => (Math.round(n * 100) / 100).toString();
  // Colours (Finbar, C-0006): brown wood, muted green leaves, each animal its own muted ink and fill.
  const WOOD = '#6e4b2e', GROUND = '#4f3a26', LEAF_INK = '#5d7748', LEAF_FILL = '#cbd9b4';
  const INK = '#3b2a1c', PAPER0 = '#fff', SCALE = '#b8b8b8';
  // Leaves: a diamond outline of cells, 3 wide (5 at a 1.6x multiplier or more).
  const LEAF = [[' # ', '#o#', ' # '], ['  #  ', ' #o# ', '#ooo#', ' #o# ', '  #  ']];

  // Deadline birds (scene.js draws the flying ones): a gull flying in; a passed deadline's crow, red-eyed, perched.
  const GULL = ['##     ##', ' ##   ## ', '  ## ##  ', '   #o#   '];
  const CROW = ['  ##    ', ' #o##   ', '#####   ', ' #######', '  ######', '  #  #  '];
  const BIRD_INK = '#3d3a40', GULL_FILL = '#e8e4d8', CROW_INK = '#26222a', CROW_EYE = '#c8553d';
  // A sad face over each animal within SAD_R tree units of a crow.
  const SAD = [' ##### ', '#ooooo#', '#o#o#o#', '#ooooo#', '#oo#oo#', '#o#o#o#', ' ##### '];
  const SAD_INK = '#4f6a86', SAD_FILL = '#dbe4ee', SAD_R = 8;

  // Cells (integer i, j; j up) -> SVG rects, one per horizontal run.
  function runs(cells, fill, extra = '') {
    const rows = new Map();
    for (const c of cells) {
      const [i, j] = c.split(',').map(Number);
      if (!rows.has(j)) rows.set(j, []);
      rows.get(j).push(i);
    }
    let out = '';
    for (const j of [...rows.keys()].sort((a, b) => a - b)) {
      const is = rows.get(j).sort((a, b) => a - b);
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

  // The tree as an SVG string, drawn in CELL-sized blocks, with a height scale on its left.
  // opts: {hour, mini (no names, no tap targets), branchNames (each collection's last name at its branch tip)}. Tap targets: data-k="seg" with data-i = the paper's entry id
  // and data-b = its branch ('trunk' or the collection name), data-k="branch" on a collection's stub, and
  // data-k="creature" with data-i = the Write entry id, and data-k="bird" (a passed deadline's crow) with data-i = its
  // entry id. Leaves have none. An animal within SAD_R of a crow has a sad face beside it (<g class="sad">).
  // The tree's drawing without its <svg> wrapper: {body, hits, x0, y0, w, h} (hits: its tap targets), in tree units with y down (the ground at
  // y = 0, the tree above it at negative y). opts.scene (for scene.js): no background and no ground, labels haloed
  // in opts.paper, and the height scale at x = opts.scaleX (true tree units) with its labels to its right.
  // A young tree (state.scale < 1) is drawn at full size and scaled down as a whole: x0, y0, w, h and the hits
  // are in true tree units, and the height scale is labelled in true metres. With nothing grown nothing is drawn but
  // the scale, in the first paper's frame.
  // The factor a tree is drawn at (a young one smaller; with nothing grown, the first paper's).
  const treeScale = (state) => (state.scale == null ? 1 : state.scale > 0 ? state.scale : youngScale(1));
  function parts(state, opts = {}) {
    const k = treeScale(state);
    const L = layout(state);
    const PAPER = opts.paper || PAPER0;
    const hour = opts.hour != null ? opts.hour : hourOf(Date.now());
    const cell = (x, y) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
    const wood = new Set();
    const hits = [];
    for (const c of state.chains) {
      for (const g of c.segs) {
        const len = Math.hypot(g.x1 - g.x0, g.y1 - g.y0);
        const steps = Math.max(2, Math.ceil(len / (CELL * 0.4)));
        for (let k = 0; k <= steps; k++) {        // rasterise with a square brush as wide as the wood there
          const t = k / steps;
          const p = at(g, t);
          const hw = Math.max(CELL * 0.5, (g.w0 + (g.w1 - g.w0) * t) / 2);
          for (let x = p.x - hw + CELL / 2; x <= p.x + hw - CELL / 2 + 1e-9; x += CELL) {
            for (let y = p.y - hw + CELL / 2; y <= p.y + hw - CELL / 2 + 1e-9; y += CELL) wood.add(cell(x, y));
          }
          wood.add(cell(p.x, p.y));
        }
        if (opts.mini || len < 1e-6) continue;
        const ux = (g.x1 - g.x0) / len, uy = (g.y1 - g.y0) / len, w = Math.max(g.w0, CELL * 3);
        const pts = [[g.x0 - uy * w / 2, g.y0 + ux * w / 2], [g.x1 - uy * w / 2, g.y1 + ux * w / 2],
          [g.x1 + uy * w / 2, g.y1 - ux * w / 2], [g.x0 + uy * w / 2, g.y0 - ux * w / 2]].map(([x, y]) => `${f(x)},${f(-y)}`).join(' ');
        const what = g.paper ? `data-k="seg" data-i="${esc(g.paper)}"` : `data-k="branch" data-i="${esc(c.id)}"`;
        hits.push(`<polygon points="${pts}" ${what} data-b="${esc(c.id)}"/>`);
      }
    }
    const leafInk = new Set(), leafPaper = new Set();
    L.leaves.forEach((l) => {
      const [i, j] = cell(l.x, l.y).split(',').map(Number);
      stamp(LEAF[l.big ? 1 : 0], i, j - (l.big ? 2 : 1), 1, leafInk, leafPaper);
    });
    const critCells = [];
    // Corners (cells) of the labels' text, so the frame holds them: monospace glyphs ~0.6 of the font size wide.
    const labelCells = [];
    const textBox = (cx, base, size, text) => {
      const half = Math.ceil(text.length * 0.6 * size / 2);
      labelCells.push(`${Math.floor(cx - half)},${Math.floor(base)}`, `${Math.ceil(cx + half)},${Math.ceil(base + size)}`);
    };
    let labels = '', critters = '';
    // Crows: each passed deadline's bird perches where it landed. Animals near one are sad.
    const crows = L.birds.filter((b, n) => state.birds[n].evil);
    crows.forEach((b) => {
      const [i, j] = cell(b.x, b.y).split(',').map(Number);
      const ink = new Set(), eye = new Set();
      const s = stamp(CROW, i, j + 1, 1, ink, eye);
      critCells.push(...ink, ...eye);
      critters += runs(eye, CROW_EYE) + runs(ink, CROW_INK);
      if (!opts.mini) hits.push(`<rect x="${f(s.i0 * CELL)}" y="${f(-(s.j0 + s.h) * CELL)}" width="${f(s.w * CELL)}" height="${f(s.h * CELL)}" data-k="bird" data-i="${esc(b.id)}"/>`);
    });
    state.creatures.forEach((c) => {
      const { node } = walk(L.graph, state.seed, c.id, c.startHour, hour);
      const p = L.graph.nodes.get(node);
      const [i, j] = cell(p.x, p.y).split(',').map(Number);
      const ink = new Set(), fill = new Set();
      const b = stamp(c.sprite, i, j + 1, c.size, ink, fill);
      if (crows.some((w) => Math.hypot(w.x - p.x, w.y - p.y) <= SAD_R)) {
        const sInk = new Set(), sFill = new Set();
        stamp(SAD, b.i0 + b.w + 3, b.j0 + b.h, 1, sInk, sFill);
        critCells.push(...sInk, ...sFill);
        critters += `<g class="sad" data-i="${esc(c.id)}">${runs(sFill, SAD_FILL)}${runs(sInk, SAD_INK)}</g>`;
      }
      critCells.push(...ink, ...fill);
      critters += runs(fill, c.fill) + runs(ink, c.ink);
      if (opts.mini) return;
      hits.push(`<rect x="${f(b.i0 * CELL)}" y="${f(-(b.j0 + b.h) * CELL)}" width="${f(b.w * CELL)}" height="${f(b.h * CELL)}" data-k="creature" data-i="${esc(c.id)}" data-node="${esc(node)}"/>`);
      textBox(b.i0 + b.w / 2, b.j0 + b.h + 0.6, 3.2, c.name || `${c.animal} (name me)`);
      labels += `<text x="${f((b.i0 + b.w / 2) * CELL)}" y="${f(-(b.j0 + b.h + 0.6) * CELL)}" font-size="${f(CELL * 3.2)}" font-family="ui-monospace, Menlo, Consolas, monospace" font-weight="700"`
        + ` text-anchor="middle" fill="${INK}" stroke="${PAPER}" stroke-width="${f(CELL * 0.9)}" paint-order="stroke">${esc(c.name || `${c.animal} (name me)`)}</text>`;
    });
    if (opts.branchNames && !opts.mini) {
      for (const c of state.chains) {
        if (!c.parent || !c.segs.length) continue;
        const g = c.segs[c.segs.length - 1];
        textBox(g.x1 / CELL, g.y1 / CELL + 1, 2.2, c.id.split(' / ').pop());
        labels += `<text x="${f(g.x1)}" y="${f(-g.y1 - CELL)}" font-size="${f(CELL * 2.2)}" font-family="ui-monospace, Menlo, Consolas, monospace"`
          + ` text-anchor="middle" fill="#666" stroke="${PAPER}" stroke-width="${f(CELL * 0.6)}" paint-order="stroke">${esc(c.id.split(' / ').pop())}</text>`;
      }
    }
    if (!(state.scale > 0) && state.scale != null) { wood.clear(); leafInk.clear(); leafPaper.clear(); critCells.length = 0; labelCells.length = 0; critters = ''; labels = ''; hits.length = 0; }
    const all = [...wood, ...leafInk, ...leafPaper, ...critCells, ...labelCells, '0,0'].map((c) => c.split(',').map(Number));
    const is = all.map((c) => c[0]), js = all.map((c) => c[1]);
    const margin = opts.mini ? 2 : 4;
    // A full-size tree's frame is at least MIN_FRAME tall; a young one (drawn smaller) is framed to its own height.
    const top = Math.max(Math.max(...js) + 1, k < 1 ? Math.round((trunkHeight(state.grown || 1) + 2) / CELL) : Math.round(MIN_FRAME / CELL));
    // Height scale: a light rule left of the tree, a tick every step (true metres), labelled every other tick.
    const step = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100].find((s) => top * CELL * k / s <= 12) || 200;
    const mark = (m) => (m < 1 ? `${Math.round(m * 100)} cm` : `${Math.round(m * 10) / 10} m`);
    const si = opts.scaleX != null ? Math.round(opts.scaleX / k / CELL) : Math.min(...is, -4) - (opts.mini ? 3 : 6);
    const right = opts.scaleX != null;
    const rule = new Set();
    let scaleText = '';
    for (let j = 0; j < top; j++) rule.add(`${si},${j}`);
    for (let m = 0, n = 0; m * step / k / CELL <= top; m++, n++) {
      const j = Math.round(m * step / k / CELL);
      rule.add(`${right ? si + 1 : si - 1},${j}`);
      if (m % 2 === 0 && m > 0 && !opts.mini) {
        scaleText += `<text x="${f((right ? si + 2.5 : si - 1.5) * CELL)}" y="${f(-(j - 0.6) * CELL)}" font-size="${f(CELL * 2.4)}" font-family="ui-monospace, Menlo, Consolas, monospace"`
          + ` text-anchor="${right ? 'start' : 'end'}" fill="${SCALE}">${mark(m * step)}</text>`;
      }
    }
    const i0 = Math.min(si - (right ? 0 : opts.mini ? 2 : 10), Math.min(...is)) - margin, i1 = Math.max(...is, 4, si + (right ? 10 : 0)) + margin + 1;
    const j1 = top + margin, jg = opts.scene ? 0 : -2;
    const ground = new Set();
    const g = Math.max(6, Math.round((i1 - si) * 0.3));
    if (!opts.scene) for (let i = -g; i <= g; i++) ground.add(`${i},-1`);
    const x0 = i0 * CELL, y0 = -j1 * CELL, w = (i1 - i0) * CELL, h = (j1 - jg) * CELL;
    const inner = (opts.scene ? '' : `<rect x="${f(x0)}" y="${f(y0)}" width="${f(w)}" height="${f(h)}" fill="${PAPER}"/>`)
      + `<g class="scale">${runs(rule, SCALE)}${scaleText}</g>`
      + runs(ground, GROUND) + runs(wood, WOOD) + runs(leafPaper, LEAF_FILL) + runs(leafInk, LEAF_INK)
      + critters + labels;
    const wrap = (s) => (k === 1 ? s : `<g transform="scale(${k})">${s}</g>`);
    const hitG = opts.mini ? '' : `<g class="hits" fill="#000" fill-opacity="0">${wrap(hits.join(''))}</g>`;
    return { body: wrap(inner), hits: hitG, x0: x0 * k, y0: y0 * k, w: w * k, h: h * k };
  }

  function svg(state, opts = {}) {
    const { body, hits, x0, y0, w, h } = parts(state, opts);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(x0)} ${f(y0)} ${f(w)} ${f(h)}" class="growth-tree" role="img" shape-rendering="crispEdges"`
      + ` aria-label="${esc(state.stage)}: ${state.papers.length} papers, ${state.leaves.length} leaves, ${f(state.height)} m tall">${body}${hits}</svg>`;
  }

  return { hash, rng, dayOf, addDays, hourOf, topicPath, multOf, trunkHeight, stageOf, STAGES, ANIMALS,
    GULL, BIRD_INK, GULL_FILL, SAD_R, treeScale,
    STREAK_STEP, MAX_MULT, SEG, SEG_HALF, STUB, TRUNK_BASE, TRUNK_K, SEEDLING, SAPLING, MIN_FRAME, FIRST_HEIGHT, YOUNG_P, youngScale, BEND, LEAN, WIDTH_K, DEFAULT_SEED, CELL,
    derive, layout, walk, parts, svg };
}));
