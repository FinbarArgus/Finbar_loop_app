// The anthills: every agent in state/status.json as an anthill, drawn in blocks in the growth tree's muted style.
// A pure function of the agents (no clock, no network): the same agents give the same hills on every device.
// Loaded in the browser (window.LoopHills) and by Node (tests).
//
// Size is the agent's priority (its name's prefix): LOOP is the queen's mound, HIGH- and IMPLEMENT- large (Finbar),
// MED- medium, LOW- small, the rest medium-small. Its design (shape, soil, entrances, grass, twigs, flowers)
// is drawn from a hash of its name, so each hill is recognisable and stays the same. Its state shows at a
// glance: working hills have ants running along a trail, a blocked hill has a rock on top and an amber tint,
// a stalled or stopped hill is grey and still. Dirt paths join agents that messaged each other (state/messages.json,
// the last 50), wider and busier with ants the more messages went between them.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LoopHills = api;
}(typeof self !== 'undefined' ? self : this, () => {
  'use strict';

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

  // ---------------------------------------------------------------- what each agent's hill is

  // Width and height in blocks, and how many ants run from it while it works.
  const SIZES = { queen: [30, 13], large: [24, 11], medium: [19, 8], 'medium-small': [15, 7], small: [11, 5] };
  const ANTS = { queen: 6, large: 5, medium: 4, 'medium-small': 3, small: 2 };
  const SIZE_ORDER = ['queen', 'large', 'medium', 'medium-small', 'small'];
  const MOOD_ORDER = ['blocked', 'working', 'quiet'];

  function sizeOf(agent) {
    const n = String(agent.name || '');
    if (agent.loop || n === 'LOOP') return 'queen';
    if (/^(HIGH|IMPLEMENT)-/i.test(n)) return 'large';
    if (/^MED-/i.test(n)) return 'medium';
    if (/^LOW-/i.test(n)) return 'small';
    return 'medium-small';
  }
  // blocked: a rock on top. working (and running): ants. Anything else (stalled, stopped): quiet.
  function moodOf(agent) {
    if (agent.state === 'blocked') return 'blocked';
    if (agent.state === 'working' && agent.running !== false) return 'working';
    return 'quiet';
  }

  const SHAPES = ['dome', 'cone', 'flat', 'twin', 'lean'];
  const SOILS = [
    { name: 'sand', base: '#b59a6d', dark: '#8f7853', light: '#ccb88f' },
    { name: 'red earth', base: '#a8714f', dark: '#85583d', light: '#c38d6c' },
    { name: 'loam', base: '#836750', dark: '#634c39', light: '#9d8166' },
    { name: 'clay', base: '#a98a6a', dark: '#866b50', light: '#c2a687' },
  ];
  const FLOWERS = ['#c9a3a8', '#d6c48c', '#a9b2cf', '#e2ded2', '#c7a6c4'];
  const GRASS = ['#6f8a55', '#87a068'];
  const C = {
    hole: '#3b2a1c', twig: '#5b4632', pebble: '#9c9a92', crown: '#b89b55', ant: '#2e2219',
    rock: '#8a8c88', rockDark: '#686a66', rockLight: '#b0b2ad', ground: '#d9d1b7', groundDark: '#cbc2a4',
    trail: '#b3a37a', path: '#d3c59f', pathDark: '#bfae84', crumb: '#87a068', bg: '#f3f2ea', label: '#4a4036', warn: '#c4a24e',
  };

  // A hill's design, fixed by its name.
  function design(name) {
    const r = rng('hill', name);
    return {
      shape: SHAPES[Math.floor(r() * SHAPES.length)], soil: Math.floor(r() * SOILS.length),
      speckle: 0.08 + 0.14 * r(), entrances: 1 + Math.floor(r() * 3), grass: 2 + Math.floor(r() * 4),
      twigs: Math.floor(r() * 3), flowers: Math.floor(r() * 4), pebbles: Math.floor(r() * 3),
      side: r() < 0.5 ? -1 : 1, seed: hash('hill', name),
    };
  }

  // Height of the mound (0-1) at u in [-1, 1] across it.
  const dome = (u) => Math.sqrt(Math.max(0, 1 - u * u));
  function profile(shape, u, side) {
    if (shape === 'cone') return Math.pow(Math.max(0, 1 - Math.abs(u)), 0.85);
    if (shape === 'flat') return Math.min(0.82, 1.3 * dome(u)) / 0.82;
    if (shape === 'twin') return Math.max(dome((u + 0.38) / 0.62), 0.72 * dome((u - 0.45) / 0.55));
    if (shape === 'lean') return Math.min(1, dome(u) * (1 + side * 0.4 * u) / 1.12);
    return dome(u);
  }

  // ---------------------------------------------------------------- layout

  const GAP = 6;            // blocks between hills (the trails run into it)
  const TOP = 6;            // room above the tallest hill of a row (for a rock)
  const LABEL = 5;          // room below a row for the names
  const MARGIN = 3;

  // agents (status.json agents[]) -> {width, height, hills}: each hill with its agent, size, mood, design,
  // w, h, x0 (left), base (ground row), cx, ants (how many), rock, trail (polyline the ants follow, in blocks).
  // Rows hold the hills in priority order (queen first), blocked before working before quiet, then by name.
  // opts.messages: state/messages.json ({messages: [{at, from, to}], pairs: [{a, b, count, last}]}); agents named
  // there but missing from the status are drawn as stalled hills (ghost: true). Adds `paths`.
  function layout(agents, opts = {}) {
    const width = Math.max(40, opts.width || 72);
    const all = (agents || []).filter((a) => a && a.name);
    const known = new Set(all.map((a) => a.name));
    for (const pr of (opts.messages || {}).pairs || []) {
      for (const n of [pr.a, pr.b]) {
        if (n && !known.has(n)) { known.add(n); all.push({ name: n, state: 'stalled', running: false, ghost: true }); }
      }
    }
    const list = all.map((agent) => {
      const size = sizeOf(agent);
      const [w, h] = SIZES[size];
      const mood = moodOf(agent);
      return { name: agent.name, agent, size, mood, design: design(agent.name), w, h,
        ants: mood === 'working' ? ANTS[size] : 0, rock: mood === 'blocked' };
    }).sort((a, b) => SIZE_ORDER.indexOf(a.size) - SIZE_ORDER.indexOf(b.size)
      || MOOD_ORDER.indexOf(a.mood) - MOOD_ORDER.indexOf(b.mood) || a.name.localeCompare(b.name));
    const rows = [];
    let row = [], used = 0;
    for (const hl of list) {
      const need = hl.w + (row.length ? GAP : 0);
      if (row.length && used + need > width - 2 * MARGIN) { rows.push(row); row = []; used = 0; }
      used += hl.w + (row.length ? GAP : 0);
      row.push(hl);
    }
    if (row.length) rows.push(row);
    let y = 0;
    for (const r of rows) {
      const tall = Math.max(...r.map((x) => x.h));
      const base = y + TOP + tall;
      const span = r.reduce((s, x) => s + x.w, 0) + GAP * (r.length - 1);
      let x = Math.floor((width - span) / 2);
      for (const hl of r) {
        hl.x0 = x;
        hl.base = base;
        hl.cx = x + hl.w / 2;
        x += hl.w + GAP;
        hl.trail = trailOf(hl, width);
      }
      y = base + LABEL;
    }
    const height = y + 1;
    return { width, height, hills: list, paths: pathsOf(list, opts.messages, width, height) };
  }

  // ---------------------------------------------------------------- message paths

  // A path's width in blocks for n messages: 1 for one, growing as sqrt, at most 5.
  const pathWidth = (n) => Math.min(5, 1 + 0.8 * Math.sqrt(Math.max(0, n - 1)));
  const MAX_PATH_ANTS = 8;

  // One path per pair that messaged: from the foot of one hill (the side facing the other) to the other's, bowed
  // so it does not run straight through the hills between (downwards, under the names, when both share a row).
  function pathsOf(hills, messages, width, height) {
    const by = new Map(hills.map((h) => [h.name, h]));
    const msgs = (messages || {}).messages || [];
    return ((messages || {}).pairs || []).filter((pr) => by.has(pr.a) && by.has(pr.b) && pr.a !== pr.b && pr.count > 0).map((pr) => {
      const A = by.get(pr.a), B = by.get(pr.b);
      const dir = Math.sign(B.cx - A.cx) || 1;
      const p0 = { x: A.cx + dir * A.w * 0.35, y: A.base - 0.5 }, p2 = { x: B.cx - dir * B.w * 0.35, y: B.base - 0.5 };
      const dx = p2.x - p0.x, dy = p2.y - p0.y, d = Math.hypot(dx, dy) || 1;
      const bow = (hash('bow', pr.a, pr.b) % 2 ? 1 : -1) * Math.min(10, 0.18 * d);
      const c = A.base === B.base ? { x: (p0.x + p2.x) / 2, y: A.base + 2 + Math.min(LABEL + 4, 0.12 * d) }
        : { x: (p0.x + p2.x) / 2 - (dy / d) * bow, y: (p0.y + p2.y) / 2 + (dx / d) * bow };
      const n = Math.max(8, Math.ceil(d / 1.5));
      const trail = [];
      for (let k = 0; k <= n; k++) {
        const t = k / n, u = 1 - t;
        trail.push({ x: Math.max(0.5, Math.min(width - 0.5, u * u * p0.x + 2 * u * t * c.x + t * t * p2.x)),
          y: Math.max(0.5, Math.min(height - 1.5, u * u * p0.y + 2 * u * t * c.y + t * t * p2.y)) });
      }
      const between = msgs.filter((m) => (m.from === pr.a && m.to === pr.b) || (m.from === pr.b && m.to === pr.a));
      return { a: pr.a, b: pr.b, count: pr.count, last: pr.last, w: pathWidth(pr.count), trail,
        ants: Math.min(MAX_PATH_ANTS, pr.count),
        ab: between.filter((m) => m.from === pr.a).length, ba: between.filter((m) => m.from === pr.b).length,
        msgs: [...between].sort((x, y) => String(y.at).localeCompare(String(x.at))) };   // newest first
    });
  }

  const colHeight = (hl, i) => Math.round(hl.h * profile(hl.design.shape, ((i + 0.5) / hl.w) * 2 - 1, hl.design.side));

  // The ants' path: out of the main entrance, down the mound's side, along the ground to a crumb.
  function trailOf(hl, width) {
    const s = hl.design.side;
    const ei = Math.round((hl.w - 1) * (0.5 + s * 0.22));
    const top = hl.base - colHeight(hl, ei);
    const edge = s > 0 ? hl.x0 + hl.w + 0.5 : hl.x0 - 0.5;
    const end = Math.max(1, Math.min(width - 1, edge + s * (GAP - 1.5)));
    return [{ x: hl.x0 + ei + 0.5, y: top + 2.5 }, { x: edge, y: hl.base - 0.5 }, { x: end, y: hl.base - 0.5 }];
  }

  // Where ant k of a working hill is at time t (seconds): each ant walks the trail out and back, the ants
  // evenly spaced in phase (offset a quarter step, so no two share a spot going out and back), SPEED blocks a second.
  const SPEED = 3;
  function antAt(hl, k, t) {
    const pts = hl.trail;
    const segs = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y));
    const len = segs.reduce((a, b) => a + b, 0) || 1;
    const phase = (((t * SPEED) / (2 * len) + (k + 0.25) / Math.max(1, hl.ants)) % 1 + 1) % 1;
    const out = phase < 0.5;
    let d = (out ? phase * 2 : 2 - phase * 2) * len;
    for (let i = 0; i < segs.length; i++) {
      if (d <= segs[i] || i === segs.length - 1) {
        const f = segs[i] ? Math.min(1, d / segs[i]) : 0;
        const a = pts[i], b = pts[i + 1];
        const dir = Math.sign((b.x - a.x) * (out ? 1 : -1)) || 1;
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, dir };
      }
      d -= segs[i];
    }
    return { x: pts[0].x, y: pts[0].y, dir: 1 };
  }

  // ---------------------------------------------------------------- drawing

  const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const toHex = (v) => '#' + v.map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('');
  const mix = (a, b, t) => toHex(hex(a).map((x, i) => x + (hex(b)[i] - x) * t));
  function grey(c, t) {
    const [r, g, b] = hex(c);
    const l = 0.3 * r + 0.59 * g + 0.11 * b;
    return toHex([r, g, b].map((x) => x + (l * 1.04 - x) * t));
  }
  // The colours a hill is drawn in, for its mood: blocked takes an amber tint, quiet is greyed.
  function tone(hl) {
    const f = hl.mood === 'quiet' ? (c) => grey(c, 0.85) : hl.mood === 'blocked' ? (c) => mix(c, C.warn, 0.28) : (c) => c;
    const soil = SOILS[hl.design.soil];
    return { base: f(soil.base), dark: f(soil.dark), light: f(soil.light), grass: GRASS.map(f),
      flower: (c) => (hl.mood === 'quiet' ? grey(c, 0.85) : c), twig: f(C.twig), hole: C.hole };
  }

  // One hill's blocks into px (Map "x,y" -> colour; later blocks paint over earlier ones).
  function paint(hl, px) {
    const d = hl.design, t = tone(hl), r = rng('paint', hl.name);
    const set = (x, y, c) => px.set(`${x},${y}`, c);
    const cols = [];
    for (let i = 0; i < hl.w; i++) cols.push(colHeight(hl, i));
    for (let i = 0; i < hl.w; i++) {
      for (let j = 0; j < cols[i]; j++) {
        const x = hl.x0 + i, y = hl.base - 1 - j;
        const edge = j === cols[i] - 1 || i === 0 || i === hl.w - 1 || j >= Math.min(cols[i - 1] ?? 0, cols[i + 1] ?? 0);
        const n = rng(d.seed, i, j)();
        set(x, y, edge ? t.dark : n < d.speckle ? (n < d.speckle / 2 ? t.dark : t.light) : t.base);
      }
    }
    // entrances: the main one where the trail starts, the others spread over the mound
    const holes = [Math.round((hl.w - 1) * (0.5 + d.side * 0.22))];
    for (let e = 1; e < d.entrances; e++) holes.push(Math.round((hl.w - 1) * (0.2 + 0.6 * r())));
    for (const i of holes) {
      if (cols[i] < 4) continue;
      const y = hl.base - cols[i] + 2;
      set(hl.x0 + i, y, t.hole);
      if (i + 1 < hl.w && cols[i + 1] >= 4) set(hl.x0 + i + 1, y, t.hole);
      if (hl.w >= 18) set(hl.x0 + i, y + 1, t.hole);
    }
    // twigs: lines of 3-5 blocks leaning out of the mound
    for (let k = 0; k < d.twigs; k++) {
      const i = Math.round((hl.w - 1) * (0.25 + 0.5 * r())), s = r() < 0.5 ? -1 : 1, n = 3 + Math.floor(r() * 3);
      for (let m = 0; m < n; m++) set(hl.x0 + i + s * m, hl.base - cols[i] - m + 1, t.twig);
    }
    // grass tufts at the foot, and pebbles
    for (let k = 0; k < d.grass; k++) {
      const x = r() < 0.5 ? hl.x0 - 1 - Math.floor(r() * 2) : hl.x0 + hl.w + Math.floor(r() * 2);
      const tall = 1 + Math.floor(r() * 3);
      for (let m = 0; m < tall; m++) set(x, hl.base - 1 - m, t.grass[(k + m) % 2]);
      if (tall > 1) set(x + (r() < 0.5 ? -1 : 1), hl.base - 1, t.grass[k % 2]);
    }
    for (let k = 0; k < d.pebbles; k++) set(hl.x0 + Math.floor(r() * hl.w), hl.base - 1, C.pebble);
    // flowers: a stem and a plus-shaped head, at the foot or on the slope
    const nf = d.flowers + (hl.size === 'queen' ? 4 : 0);
    for (let k = 0; k < nf; k++) {
      const onFoot = hl.size === 'queen' || r() < 0.6;
      const i = onFoot ? (k % 2 ? -3 - Math.floor(r() * 2) : hl.w + 2 + Math.floor(r() * 2)) : Math.floor(hl.w * (0.2 + 0.6 * r()));
      const ground = onFoot ? hl.base : hl.base - cols[Math.max(0, Math.min(hl.w - 1, i))];
      const c = t.flower(FLOWERS[Math.floor(r() * FLOWERS.length)]);
      const x = hl.x0 + i, y = ground - 3;
      set(x, ground - 1, t.grass[0]); set(x, ground - 2, t.grass[0]);
      set(x, y, t.flower(FLOWERS[1])); set(x - 1, y, c); set(x + 1, y, c); set(x, y - 1, c);
    }
    const peak = Math.max(...cols);
    const pi = cols.indexOf(peak);
    if (hl.size === 'queen') {             // the queen's mound wears a crown
      const crown = ['# # #', '#####'];
      crown.forEach((row, ry) => [...row].forEach((ch, rx) => {
        if (ch === '#') set(hl.x0 + pi - 2 + rx, hl.base - peak - 2 + ry, hl.mood === 'quiet' ? grey(C.crown, 0.85) : C.crown);
      }));
    }
    if (hl.rock) {                          // blocked: a rock sits on top
      const rw = Math.max(6, Math.round(hl.w * 0.45)), rh = Math.max(4, Math.round(rw * 0.7));
      const x0 = hl.x0 + pi - Math.floor(rw / 2), y1 = hl.base - peak + 2;
      for (let j = 0; j < rh; j++) {
        const f = (j + 0.5) / rh;             // rows from the bottom up: a boulder, widest a third of the way up
        const half = (rw / 2) * Math.sqrt(Math.max(0, 1 - Math.pow((f - 0.3) / 0.75, 2)));
        for (let i = 0; i < rw; i++) {
          const dx = i + 0.5 - rw / 2;
          if (Math.abs(dx) > half + 0.25) continue;
          const rim = j === 0 || Math.abs(dx) > half - 0.75 || j === rh - 1;
          const hi = !rim && dx < 0 && j >= rh / 2;
          set(x0 + i, y1 - j, rim ? C.rockDark : hi ? C.rockLight : C.rock);
        }
      }
    }
  }

  // Map "x,y" -> colour -> SVG rects, one per horizontal run of one colour.
  function rects(px) {
    const rows = new Map();
    for (const [k, c] of px) {
      const [x, y] = k.split(',').map(Number);
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push([x, c]);
    }
    let out = '';
    for (const y of [...rows.keys()].sort((a, b) => a - b)) {
      const row = rows.get(y).sort((a, b) => a[0] - b[0]);
      for (let k = 0; k < row.length;) {
        let e = k;
        while (e + 1 < row.length && row[e + 1][0] === row[e][0] + 1 && row[e + 1][1] === row[k][1]) e++;
        out += `<rect x="${row[k][0]}" y="${y}" width="${e - k + 1}" height="1" fill="${row[k][1]}"/>`;
        k = e + 1;
      }
    }
    return out;
  }

  // An ant: body and head (facing +x), legs below; moved and flipped by its transform.
  const ANT = `<rect x="-1" y="-0.7" width="1.3" height="0.8" fill="${C.ant}"/><rect x="0.3" y="-0.85" width="0.8" height="0.7" fill="${C.ant}"/>`
    + `<rect x="-0.9" y="0.1" width="0.25" height="0.4" fill="${C.ant}"/><rect x="0" y="0.1" width="0.25" height="0.4" fill="${C.ant}"/>`;
  const antPose = (p) => `translate(${f(p.x)} ${f(p.y)}) scale(${p.dir < 0 ? -1 : 1} 1)`;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const f = (n) => (Math.round(n * 100) / 100).toString();
  // The name under a hill, shortened to fit its slot.
  function label(hl) {
    const max = Math.max(6, Math.floor((hl.w + GAP - 1) / 1.32));
    return hl.name.length > max ? hl.name.slice(0, max - 1) + '…' : hl.name;
  }

  // The meadow as an SVG string. opts: {width (blocks), t (seconds, for the ants), mini (no names, no tap
  // targets)}. Ants are <rect class="ant" data-h=<hill index> data-a=<ant>>, for the app to move; tap targets
  // are data-k="hill" with data-i = the hill's index in layout().hills.
  function svg(agents, opts = {}) {
    const L = layout(agents, opts);
    const px = new Map();
    const bands = new Set(L.hills.map((hl) => hl.base));
    for (const b of bands) for (let x = 0; x < L.width; x++) {
      px.set(`${x},${b}`, C.ground);
      px.set(`${x},${b + 1}`, C.groundDark);
    }
    for (const pa of L.paths) {                 // dirt paths, under everything else
      const r = pa.w / 2;
      for (let k = 1; k < pa.trail.length; k++) {
        const a = pa.trail[k - 1], b = pa.trail[k], steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.3);
        for (let m = 0; m <= steps; m++) {
          const x = a.x + (b.x - a.x) * m / steps, y = a.y + (b.y - a.y) * m / steps;
          for (let i = Math.floor(x - r); i <= Math.floor(x + r - 1e-9); i++) {
            for (let j = Math.floor(y - r); j <= Math.floor(y + r - 1e-9); j++) {
              if (Math.hypot(i + 0.5 - x, j + 0.5 - y) <= Math.max(0.75, r)) px.set(`${i},${j}`, (hash('dirt', i, j) % 7) ? C.path : C.pathDark);
            }
          }
        }
      }
    }
    for (const hl of L.hills) {
      if (!hl.ants) continue;
      const [, , end] = hl.trail;
      const a = Math.min(hl.trail[1].x, end.x), b = Math.max(hl.trail[1].x, end.x);
      for (let x = Math.floor(a); x <= Math.floor(b); x++) px.set(`${x},${hl.base}`, C.trail);
      px.set(`${Math.floor(end.x)},${hl.base - 1}`, C.crumb);
      px.set(`${Math.floor(end.x) + 1},${hl.base - 1}`, C.crumb);
    }
    L.hills.forEach((hl) => paint(hl, px));
    let ants = '', labels = '', hits = '';
    L.paths.forEach((pa, n) => {
      for (let k = 0; k < pa.ants; k++) {
        ants += `<g class="ant" data-p="${n}" data-a="${k}" transform="${antPose(antAt(pa, k, opts.t || 0))}">${ANT}</g>`;
      }
      if (!opts.mini) {
        hits += `<polyline data-k="path" data-i="${n}" points="${pa.trail.map((q) => `${f(q.x)},${f(q.y)}`).join(' ')}"`
          + ` fill="none" stroke="#000" stroke-opacity="0" stroke-width="${f(Math.max(2.5, pa.w + 1))}"/>`;
      }
    });
    L.hills.forEach((hl, n) => {
      for (let k = 0; k < hl.ants; k++) {
        const p = antAt(hl, k, opts.t || 0);
        ants += `<g class="ant" data-h="${n}" data-a="${k}" transform="${antPose(p)}">${ANT}</g>`;
      }
      if (opts.mini) return;
      labels += `<text x="${f(hl.cx)}" y="${f(hl.base + 3.6)}" font-size="2.2" font-family="ui-monospace, Menlo, Consolas, monospace"`
        + ` text-anchor="middle" fill="${hl.mood === 'quiet' ? '#8d8a84' : C.label}" stroke="${C.bg}" stroke-width="0.7" paint-order="stroke">${esc(label(hl))}</text>`;
      hits += `<rect data-k="hill" data-i="${n}" x="${hl.x0 - 2}" y="${hl.base - hl.h - TOP + 1}" width="${hl.w + 4}" height="${hl.h + TOP + LABEL - 1}"/>`;
    });
    const counts = MOOD_ORDER.map((m) => `${L.hills.filter((h) => h.mood === m).length} ${m}`).join(', ');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${L.width} ${L.height}" class="anthills" role="img" shape-rendering="crispEdges"`
      + ` aria-label="${L.hills.length} agents: ${counts}">`
      + `<rect width="${L.width}" height="${L.height}" fill="${C.bg}"/>` + rects(px)
      + `${labels}<g class="ants">${ants}</g>`
      + (opts.mini ? '' : `<g class="hits" fill="#000" fill-opacity="0">${hits}</g>`) + '</svg>';
  }

  return { pathWidth, antPose, hash, rng, sizeOf, moodOf, design, profile, layout, antAt, svg, label, SIZES, ANTS, SHAPES, SOILS, SPEED };
}));
