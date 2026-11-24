// The ant farm: every agent in state/status.json drawn as a cross-section of the ground (Finbar, 2026-11-24).
// A pure function of the agents (no clock, no network): the same agents give the same farm on every device.
// Loaded in the browser (window.LoopHills) and by Node (tests).
//
// LOOP is the food source on the surface, in the middle: a pile of fruit, beside the growth tree in the app's
// scene (scene.js; layout's opts.gap leaves the tree's place to the food's right). Every other session is an anthill on the surface beside it, whose shaft leads down to that
// session's own chamber, its anthome. Sessions that messaged each other (state/messages.json, the last 50) are joined
// by a tunnel underground, through a gallery below the homes; messages with LOOP go up the session's shaft and
// along the surface to the food. A rock on an anthill means that session is blocked on Finbar. Each anthome's shape, contents and lights come from its name, so each looks different; the
// colour of its lights is the session's role (HIGH, MED, LOW, IMPLEMENT or other), and the lights are off when the
// session has stalled or stopped. Working sessions have ants walking from their home up to the surface.
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

  // ---------------------------------------------------------------- what each agent is

  // An anthome's width and height in blocks by priority, and how many ants walk from it while it works.
  const SIZES = { queen: [16, 7], large: [14, 9], medium: [12, 8], 'medium-small': [11, 7], small: [9, 6] };
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
  // The role, from the name's prefix: it sets the colour of the anthome's lights.
  function roleOf(agent) {
    const n = String(agent.name || '');
    if (agent.loop || n === 'LOOP') return 'loop';
    const m = /^(HIGH|MED|LOW|IMPLEMENT)-/i.exec(n);
    return m ? m[1].toLowerCase() : 'other';
  }
  // The role colours, used for the lights and wherever the app shows a session; IMPLEMENT ranks between HIGH and MED.
  const LIGHTS = { high: '#e0482f', implement: '#3f8fe0', med: '#f0a92a', low: '#5fb04a', other: '#a46ad6', loop: '#f3d36b' };
  const ROLE_ORDER = ['loop', 'high', 'implement', 'med', 'low', 'other'];
  const roleRank = (agent) => ROLE_ORDER.indexOf(roleOf(agent));
  const ROLE_TEXT = { high: 'HIGH', med: 'MED', low: 'LOW', implement: 'IMPLEMENT', other: 'other roles' };
  // blocked: a rock on its anthill. working (and running): ants. Anything else (stalled, stopped): quiet.
  function moodOf(agent) {
    if (agent.state === 'blocked') return 'blocked';
    if (agent.state === 'working' && agent.running !== false) return 'working';
    return 'quiet';
  }

  const SHAPES = ['oval', 'bean', 'twin', 'tall', 'wide'];
  const CONTENTS = ['eggs', 'seeds', 'larvae', 'fungus', 'roots', 'crumbs'];
  const SOILS = [
    { name: 'sand', base: '#b59a6d', dark: '#8f7853', light: '#ccb88f' },
    { name: 'red earth', base: '#a8714f', dark: '#85583d', light: '#c38d6c' },
    { name: 'loam', base: '#836750', dark: '#634c39', light: '#9d8166' },
    { name: 'clay', base: '#a98a6a', dark: '#866b50', light: '#c2a687' },
  ];
  const C = {
    sky: '#f3f2ea', grass: '#6f8a55', grassLight: '#87a068', topsoil: '#7d5e42', soil: ['#6e5139', '#634832', '#57402d'],
    pebble: '#8d8378', pebbleDark: '#6f675d', room: '#c9a77e', roomFloor: '#b99569', wall: '#9c7a57', tunnel: '#b8956b',
    trail: '#a89068', ant: '#1f1610', egg: '#f2ece0', seed: '#d2b483', seedDark: '#a8885b', larva: '#efe3c7', fungus: '#d9dccb',
    fungusDark: '#b5b9a3', root: '#3c2c1f', crumb: '#e2c46e', leaf: '#7f9a5c', fruit: '#c8553d', fruitDark: '#9a3d2c', fruitGold: '#e39a3b', off: '#6d665e',
    rock: '#8a8c88', rockDark: '#686a66', rockLight: '#b0b2ad', label: '#4a4036', inkUnder: '#f4ecdc',
  };

  // An anthome's design, fixed by its name.
  function design(name) {
    const r = rng('home', name);
    const contents = [CONTENTS[Math.floor(r() * CONTENTS.length)]];
    if (r() < 0.6) contents.push(CONTENTS[Math.floor(r() * CONTENTS.length)]);
    return {
      shape: SHAPES[Math.floor(r() * SHAPES.length)], soil: Math.floor(r() * SOILS.length),
      contents: [...new Set(contents)], lights: 2 + Math.floor(r() * 3), dw: -Math.floor(r() * 2), dh: Math.floor(r() * 3) - 1,
      wiggle: [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1], lean: r() < 0.5 ? -1 : 1, seed: hash('home', name),
    };
  }

  // Is (u, v) (each in [-1, 1] across the home's box) inside a home of this shape?
  function inside(shape, u, v, lean) {
    const e = (cu, cv, ru, rv) => ((u - cu) / ru) ** 2 + ((v - cv) / rv) ** 2 <= 1;
    if (shape === 'bean') return e(0, 0, 1, 1) && !e(lean * 0.55, -1.05, 0.45, 0.5);
    if (shape === 'twin') return e(-0.42, 0.12, 0.58, 0.88) || e(0.45, -0.08, 0.55, 0.92) || (Math.abs(u) < 0.4 && Math.abs(v - 0.3) < 0.35);
    if (shape === 'tall') return e(0, 0, 0.78, 1);
    if (shape === 'wide') return e(0, 0.12, 1, 0.82);
    return e(0, 0, 1, 1);
  }

  // ---------------------------------------------------------------- layout

  const COL = 11;           // blocks between anthills on the surface
  const HOME_W = [7, 16];   // an anthome's width in blocks, from the session that used the fewest tokens to the most
  const HOME_H = 12;
  const NO_TOKENS_W = 9;    // the width of a home whose session has no token figures        // the tallest an anthome can be
  const SKY = 12;           // sky above the surface (anthills, rocks, the food pile)
  const FOOD = 20;          // the food pile's room on the surface
  const MARGIN = 3;
  const MOUND = { queen: 0, large: 5, medium: 4, 'medium-small': 4, small: 3 };   // an anthill's height
  const HOME_TOP = 5;       // soil between the surface and the shallow homes
  const TIER = 18;          // from the shallow homes to the deep ones (a home and its name)
  const GALLERY = 6;        // the band below the homes the tunnels run through
  const LABEL = 3.4;        // from a home's floor to its name's baseline

  // agents (status.json agents[]) -> {width, height, surface, food, hills, paths}. hills[0] is LOOP (the food;
  // kind: 'food') when it is in the status; each other hill (kind: 'home') has its agent, role, size, mood, design,
  // x (its column), tier, mound {x0, w, h}, home {cx, cy, w, h, x0, y0} (a box), shaft (the polyline from the
  // anthill down to the home), lights [{x, y}], rock, ants, and trail (the polyline its ants walk). Columns go
  // right and left of the food in turn, by priority, then blocked before working before quiet, then by name;
  // neighbouring homes sit at alternating depths. opts.messages: state/messages.json ({messages: [{at, from, to}],
  // pairs: [{a, b, count, last}]}); agents named there but missing from the status are drawn as stalled homes
  // (ghost: true). opts.fit is accepted for the app and does not change the layout.
  // An anthome's size is the session's tokens since the weekly reset (agent.week_tokens.total): its width runs from
  // HOME_W[0] to HOME_W[1] with the square root of its share of the largest session's tokens, so its area follows
  // the tokens and a small session stays visible. Without token figures it is NO_TOKENS_W wide. hl.food is
  // the food pile on its floor (a box), hl.tokens its tokens.
  function layout(agents, opts = {}) {
    const all = (agents || []).filter((a) => a && a.name);
    const known = new Set(all.map((a) => a.name));
    for (const pr of (opts.messages || {}).pairs || []) {
      for (const n of [pr.a, pr.b]) {
        if (n && !known.has(n)) { known.add(n); all.push({ name: n, state: 'stalled', running: false, ghost: true }); }
      }
    }
    const list = all.map((agent) => {
      const size = sizeOf(agent), mood = moodOf(agent), role = roleOf(agent);
      return { name: agent.name, agent, size, role, mood, kind: role === 'loop' ? 'food' : 'home', design: design(agent.name),
        ants: mood === 'working' ? ANTS[size] : 0, rock: mood === 'blocked' };
    }).sort((a, b) => SIZE_ORDER.indexOf(a.size) - SIZE_ORDER.indexOf(b.size)
      || ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || MOOD_ORDER.indexOf(a.mood) - MOOD_ORDER.indexOf(b.mood) || a.name.localeCompare(b.name));
    const homes = list.filter((h) => h.kind === 'home');
    const right = Math.ceil(homes.length / 2), left = homes.length - right;
    // opts.gap: blocks of open surface between the food and the first anthill to its right (where the app's tree
    // stands); the farm widens by it and the food stays in the middle of the rest.
    const gap = Math.max(0, Math.round(opts.gap || 0));
    const base = Math.max(48, FOOD + 2 * Math.max(right, left, 1) * COL + 2 * MARGIN);
    const width = base + gap;
    const fx = base / 2, surface = SKY;
    const top0 = surface + HOME_TOP;
    const gallery = top0 + TIER + HOME_H + LABEL + 3;
    const tok = (hl) => Number(((hl.agent || {}).week_tokens || {}).total);
    const most = Math.max(0, ...homes.map(tok).filter(Number.isFinite));
    const height = gallery + GALLERY + 2;
    const food = { cx: fx, x0: fx - FOOD / 2 + 2, w: FOOD - 4 };
    for (const hl of list.filter((h) => h.kind === 'food')) {
      Object.assign(hl, { x: fx, mound: null, home: null, shaft: [], lights: [], food,
        trail: [{ x: food.x0 - 1.5, y: surface - 0.5 }, { x: food.x0 + food.w + 1.5, y: surface - 0.5 }] });
    }
    homes.forEach((hl, i) => {
      const side = i % 2 ? -1 : 1, k = Math.floor(i / 2);
      const x = Math.round(fx + side * (FOOD / 2 + COL / 2 + k * COL)) + (side > 0 ? gap : 0);
      const tier = k % 2;
      const d = hl.design;
      const t = tok(hl);
      hl.tokens = Number.isFinite(t) ? t : null;
      let w = most > 0 && hl.tokens != null ? Math.round(HOME_W[0] + (HOME_W[1] - HOME_W[0]) * Math.sqrt(Math.max(0, hl.tokens) / most))
        : NO_TOKENS_W;
      w = Math.max(HOME_W[0], Math.min(HOME_W[1], w));            // width follows the tokens alone; the shape varies
      const h = Math.max(5, Math.min(HOME_H, Math.round(w * 0.6) + d.dh + (d.shape === 'tall' ? 1 : 0)));
      const y0 = top0 + tier * TIER + (HOME_H - h);                // homes of one tier share their floor
      const home = { cx: x, cy: y0 + h / 2, w, h, x0: x - w / 2, y0 };
      const mh = MOUND[hl.size];
      const shaft = [{ x, y: surface - 1 }];
      const depth = y0 + 1 - surface;
      d.wiggle.forEach((wg, j) => shaft.push({ x: x + 0.8 * wg, y: surface + depth * (j + 1) / 4 }));
      shaft.push({ x, y: y0 + 1 });
      const lights = [];
      const lr = rng('lights', hl.name);
      for (let j = 0; j < d.lights; j++) {
        const a = Math.PI * (1.15 + 0.7 * (j + 0.5) / d.lights + 0.08 * (lr() - 0.5));   // along the ceiling
        lights.push({ x: x + Math.cos(a) * (w / 2 - 1.6), y: home.cy + Math.sin(a) * (h / 2 - 1.4) });
      }
      const floor = y0 + h - 1.5;
      const fw = Math.max(2, Math.min(4, Math.round(w / 4)));
      const fx0 = Math.round(x + d.lean * w * 0.18 - fw / 2);
      Object.assign(hl, { x, tier, home, shaft, lights, mound: { x0: x - 3.5, w: 7, h: mh },
        food: { x0: fx0, y0: Math.round(y0 + h) - 3, w: fw, h: 2 },
        trail: [{ x: x - w * 0.3, y: floor }, { x, y: floor }, ...shaft.slice().reverse()] });
    });
    const L = { width, height, surface, gallery, food, hills: list,
      gap: gap ? { x0: fx + FOOD / 2, x1: fx + FOOD / 2 + gap, cx: fx + FOOD / 2 + gap / 2 } : null };
    L.paths = pathsOf(L, opts.messages);
    return L;
  }

  // ---------------------------------------------------------------- message paths

  // A tunnel's width in blocks for n messages: 1 for one, growing as sqrt, at most 3.
  const pathWidth = (n) => Math.min(3, 1 + 0.5 * Math.sqrt(Math.max(0, n - 1)));
  const MAX_PATH_ANTS = 8;

  // One path per pair that messaged, from a to b. Between two homes: down from one home's floor to the gallery
  // below every home, along it, and up into the other home's floor; so a tunnel never cuts through a third home.
  // Each pair keeps its own row in the gallery. With LOOP: up the session's own shaft and along the surface to the food.
  function pathsOf(L, messages) {
    const by = new Map(L.hills.map((h) => [h.name, h]));
    const msgs = (messages || {}).messages || [];
    return ((messages || {}).pairs || []).filter((pr) => by.has(pr.a) && by.has(pr.b) && pr.a !== pr.b && pr.count > 0).map((pr) => {
      const A = by.get(pr.a), B = by.get(pr.b);
      let trail;
      if (A.kind === 'food' || B.kind === 'food') {
        const S = A.kind === 'food' ? B : A, F = A.kind === 'food' ? A : B;
        if (S.kind === 'food') return null;
        const edge = S.x > F.food.cx ? F.food.x0 + F.food.w : F.food.x0;
        trail = [{ x: S.x, y: S.home.y0 + S.home.h - 1.5 }, ...S.shaft.slice().reverse(), { x: S.x, y: L.surface - 0.5 },
          { x: edge, y: L.surface - 0.5 }];
        if (A.kind === 'food') trail.reverse();
      } else {
        const gy = L.gallery + 1 + (hash('gallery', pr.a, pr.b) % (GALLERY - 2));
        const fa = A.home.y0 + A.home.h - 1.5, fb = B.home.y0 + B.home.h - 1.5;
        const off = (n) => (hash('tunnel', n, pr.a, pr.b) % 3 - 1) * 0.9;    // a little apart where tunnels share a home
        const xa = A.x + off(A.name), xb = B.x + off(B.name);
        trail = [{ x: xa, y: fa }, { x: xa, y: gy }, { x: xb, y: gy }, { x: xb, y: fb }];
      }
      const between = msgs.filter((m) => (m.from === pr.a && m.to === pr.b) || (m.from === pr.b && m.to === pr.a));
      return { a: pr.a, b: pr.b, count: pr.count, last: pr.last, w: pathWidth(pr.count), trail, toFood: A.kind === 'food' || B.kind === 'food',
        ants: Math.min(MAX_PATH_ANTS, pr.count),
        ab: between.filter((m) => m.from === pr.a).length, ba: between.filter((m) => m.from === pr.b).length,
        msgs: [...between].sort((x, y) => String(y.at).localeCompare(String(x.at))) };   // newest first
    }).filter(Boolean);
  }

  // Where ant k of a working hill (or a path) is at time t (seconds): each ant walks the trail out and back, the
  // ants evenly spaced in phase (offset a quarter step, so no two share a spot going out and back), SPEED blocks a
  // second. dir is +1 heading right, -1 left; ang (radians) is the heading.
  const SPEED = 2.5;
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
        const dx = (b.x - a.x) * (out ? 1 : -1), dy = (b.y - a.y) * (out ? 1 : -1);
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, dir: Math.sign(dx) || 1, ang: Math.atan2(dy, dx) };
      }
      d -= segs[i];
    }
    return { x: pts[0].x, y: pts[0].y, dir: 1, ang: 0 };
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
  const toneOf = (hl) => (hl.mood === 'quiet' ? (c) => grey(c, 0.85) : (c) => c);

  // Blocks along a polyline, `r` blocks either side of it.
  function brush(pts, r, put) {
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1], b = pts[k], steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.3));
      for (let m = 0; m <= steps; m++) {
        const x = a.x + (b.x - a.x) * m / steps, y = a.y + (b.y - a.y) * m / steps;
        for (let i = Math.floor(x - r); i <= Math.floor(x + r - 1e-9); i++) {
          for (let j = Math.floor(y - r); j <= Math.floor(y + r - 1e-9); j++) {
            if (Math.hypot(i + 0.5 - x, j + 0.5 - y) <= Math.max(0.75, r)) put(i, j);
          }
        }
      }
    }
  }

  // An anthome: the room (floor bedding at the bottom), a packed wall round it, its contents and its light bulbs.
  function paintHome(hl, px, carved) {
    const { home: hm, design: d } = hl, t = toneOf(hl), r = rng('paint', hl.name);
    const set = (x, y, c) => px.set(`${x},${y}`, c);
    const cells = [];
    for (let j = Math.floor(hm.y0); j < Math.ceil(hm.y0 + hm.h); j++) {
      for (let i = Math.floor(hm.x0); i < Math.ceil(hm.x0 + hm.w); i++) {
        const u = ((i + 0.5 - hm.x0) / hm.w) * 2 - 1, v = ((j + 0.5 - hm.y0) / hm.h) * 2 - 1;
        if (inside(d.shape, u, v, d.lean)) cells.push([i, j]);
      }
    }
    const room = new Set(cells.map(([i, j]) => `${i},${j}`));
    for (const [i, j] of cells) { set(i, j, t(j >= hm.y0 + hm.h - 2 ? C.roomFloor : C.room)); carved.add(`${i},${j}`); }
    for (const [i, j] of cells) {
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const k = `${i + di},${j + dj}`;
        if (!room.has(k) && !carved.has(k)) set(i + di, j + dj, t(C.wall));
      }
    }
    const floorCells = cells.filter(([i, j]) => !room.has(`${i},${j + 1}`));
    const pick = () => floorCells[Math.floor(r() * floorCells.length)];
    for (const what of d.contents) {
      if (what === 'roots') {                   // roots hang through the ceiling
        for (let k = 0; k < 2; k++) {
          const i = Math.round(hm.cx + (r() - 0.5) * hm.w * 0.6);
          const top = Math.min(...cells.filter(([ci]) => ci === i).map(([, cj]) => cj));
          if (!Number.isFinite(top)) continue;
          for (let j = top - 3; j < top + 2 + Math.floor(r() * 2); j++) set(i + (j > top ? (k ? 1 : -1) * (j - top > 1) : 0), j, t(C.root));
        }
        continue;
      }
      const n = what === 'fungus' ? 3 : 4 + Math.floor(r() * 3);
      for (let k = 0; k < n; k++) {
        const c = pick();
        if (!c) break;
        const [i, j] = c;
        if (what === 'eggs') { set(i, j, t(C.egg)); if (room.has(`${i},${j - 1}`) && r() < 0.5) set(i, j - 1, t(C.egg)); }
        else if (what === 'seeds') set(i, j, t(r() < 0.5 ? C.seed : C.seedDark));
        else if (what === 'larvae') { set(i, j, t(C.larva)); if (room.has(`${i + 1},${j}`)) set(i + 1, j, t(C.larva)); }
        else if (what === 'crumbs') set(i, j, t(r() < 0.6 ? C.crumb : C.leaf));
        else if (what === 'fungus') {
          for (const [di, dj] of [[0, 0], [1, 0], [-1, 0], [0, -1], [1, -1]]) {
            if (room.has(`${i + di},${j + dj}`)) set(i + di, j + dj, t(dj ? C.fungus : C.fungusDark));
          }
        }
      }
    }
    const fd = hl.food;                         // the home's food: a little pile on the floor
    for (let i = 0; i < fd.w; i++) {
      for (let j = 0; j < fd.h; j++) {
        if (j === 0 && (i === 0 || i === fd.w - 1) && fd.w > 2) continue;
        const n = hash('food', hl.name, i, j) % 4;
        set(fd.x0 + i, fd.y0 + j, t([C.crumb, C.seed, C.seedDark, C.leaf][n]));
      }
    }
    for (const l of hl.lights) set(Math.floor(l.x), Math.floor(l.y), hl.mood === 'quiet' ? C.off : LIGHTS[hl.role]);
  }

  // An anthill on the surface, with its entrance, and a rock on it when blocked.
  function paintMound(hl, px, surface) {
    const t = toneOf(hl), soil = SOILS[hl.design.soil], m = hl.mound;
    const set = (x, y, c) => px.set(`${x},${y}`, c);
    for (let i = 0; i < m.w; i++) {
      const u = ((i + 0.5) / m.w) * 2 - 1, col = Math.round(m.h * Math.sqrt(Math.max(0, 1 - u * u)));
      for (let j = 0; j < col; j++) {
        const edge = j === col - 1 || i === 0 || i === m.w - 1;
        set(Math.floor(m.x0) + i, surface - 1 - j, t(edge ? soil.dark : (hash(hl.name, i, j) % 5 ? soil.base : soil.light)));
      }
    }
    set(Math.floor(hl.x), surface - m.h + 1, C.root);              // the entrance
    if (hl.rock) paintRock(px, hl.x, surface - m.h + 1);
  }
  function paintRock(px, cx, y1) {
    const rw = 6, rh = 4, x0 = Math.round(cx - rw / 2);
    for (let j = 0; j < rh; j++) {
      const f = (j + 0.5) / rh, half = (rw / 2) * Math.sqrt(Math.max(0, 1 - Math.pow((f - 0.3) / 0.75, 2)));
      for (let i = 0; i < rw; i++) {
        const dx = i + 0.5 - rw / 2;
        if (Math.abs(dx) > half + 0.25) continue;
        const rim = j === 0 || Math.abs(dx) > half - 0.75 || j === rh - 1;
        px.set(`${x0 + i},${y1 - j}`, rim ? C.rockDark : (dx < 0 && j >= rh / 2) ? C.rockLight : C.rock);
      }
    }
  }
  // LOOP: a pile of fruit fallen from the growth tree (which stands in it in the scene) and leaf bits.
  function paintFood(hl, L, px) {
    const t = toneOf(hl), f = L.food, r = rng('food', hl.name);
    const set = (x, y, c) => px.set(`${x},${y}`, t(c));
    const H = 6;
    let peak = 0;
    for (let i = 0; i < f.w; i++) {
      const u = ((i + 0.5) / f.w) * 2 - 1, col = Math.max(1, Math.round(H * (1 - Math.abs(u)) ** 0.8));
      peak = Math.max(peak, col);
      for (let j = 0; j < col; j++) {
        const n = r();
        set(Math.floor(f.x0) + i, L.surface - 1 - j, n < 0.35 ? C.fruit : n < 0.55 ? C.fruitGold : n < 0.75 ? C.fruitDark : n < 0.88 ? C.crumb : C.leaf);
      }
    }
    if (hl.rock) paintRock(px, f.cx, L.surface - peak - 3);
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

  // An ant, facing +x with its legs below, about 1.7 blocks long: abdomen, thorax and head, six legs, two antennae.
  const ANT = `<g fill="${C.ant}" stroke="${C.ant}" stroke-width="0.09" stroke-linecap="round">`
    + '<ellipse cx="-0.5" cy="0" rx="0.36" ry="0.24" stroke="none"/><ellipse cx="0.02" cy="0" rx="0.17" ry="0.12" stroke="none"/>'
    + '<circle cx="0.36" cy="-0.02" r="0.16" stroke="none"/>'
    + '<path fill="none" d="M-0.08 0.05 L-0.4 0.38 M0.02 0.08 L-0.02 0.42 M0.1 0.05 L0.38 0.38 M-0.08 -0.05 L-0.36 -0.32 M0.1 -0.05 L0.34 -0.32 M0.02 -0.08 L0 -0.36'
    + ' M0.46 -0.1 L0.7 -0.4 M0.48 -0.04 L0.78 -0.2"/></g>';
  const SCALE = 0.75;
  // Ant transform: moved to p, turned to its heading, never upside down (mirrored when heading left).
  function antPose(p) {
    const f = (n) => (Math.round(n * 100) / 100 + 0).toString();
    const ang = p.ang ?? (p.dir < 0 ? Math.PI : 0), dx = Math.cos(ang), dy = Math.sin(ang);
    const left = dx < -1e-9;                    // mirrored, then turned so its head points along (dx, dy)
    const deg = (left ? Math.atan2(-dy, -dx) : ang) * 180 / Math.PI;
    return `translate(${f(p.x)} ${f(p.y)}) rotate(${f(deg)}) scale(${left ? -SCALE : SCALE} ${SCALE})`;
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const f = (n) => (Math.round(n * 100) / 100).toString();
  // The name under a home, shortened so it stays clear of its neighbours' shafts.
  function label(hl) {
    const max = Math.max(6, Math.floor((2 * COL - 4) / 1.1));
    return hl.name.length > max ? hl.name.slice(0, max - 1) + '…' : hl.name;
  }

  // The farm as an SVG string. opts: {t (seconds, for the ants), mini (no names, no tap targets), messages}.
  // Ants are <g class="ant" data-h=<hill index> | data-p=<path index> data-a=<ant>>, for the app to move; lights
  // are <circle class="glow" data-role=<role>>; tap targets are data-k="hill" (a group per hill, data-i its index
  // in layout().hills), data-k="food" (the food in an anthome: data-i its hill index) and data-k="path" (data-i its
  // index in layout().paths).
  // The farm's drawing without its <svg> wrapper: {body, L}, in blocks (y down, the surface at L.surface).
  // opts.scene (for scene.js): no sky (the scene draws it), and the soil and grass run over opts.span [x0, x1].
  function parts(agents, opts = {}) {
    const L = layout(agents, opts);
    const [sx0, sx1] = opts.span || [0, L.width];
    const px = new Map(), carved = new Set();
    const put = (c) => (i, j) => { if (j >= L.surface && i >= 0 && i < L.width && j < L.height) { px.set(`${i},${j}`, c); carved.add(`${i},${j}`); } };
    const r = rng('soil');
    for (let k = 0; k < L.width * L.height / 40; k++) {          // pebbles in the soil
      const i = Math.floor(r() * L.width), j = L.surface + 2 + Math.floor(r() * (L.height - L.surface - 2));
      px.set(`${i},${j}`, r() < 0.5 ? C.pebble : C.pebbleDark);
      if (r() < 0.4) px.set(`${i + 1},${j}`, C.pebbleDark);
    }
    for (let i = Math.floor(sx0); i < sx1; i++) {                  // grass along the surface
      px.set(`${i},${L.surface}`, C.topsoil);
      if (hash('grass', i) % 4 === 0) px.set(`${i},${L.surface - 1}`, hash('g', i) % 2 ? C.grass : C.grassLight);
    }
    const homes = L.hills.filter((h) => h.kind === 'home');
    for (const hl of homes) brush(hl.shaft, 0.75, put(toneOf(hl)(C.tunnel)));
    for (const pa of L.paths) {
      if (pa.toFood) brush(pa.trail.slice(-2), 0.5, (i, j) => px.set(`${i},${j}`, C.trail));     // along the surface
      else brush(pa.trail, pa.w / 2, put(C.tunnel));
    }
    for (const hl of homes) paintHome(hl, px, carved);
    for (const hl of homes) paintMound(hl, px, L.surface);
    for (const hl of L.hills.filter((h) => h.kind === 'food')) paintFood(hl, L, px);
    let ants = '', labels = '', hits = '', glow = '', foods = '';
    L.paths.forEach((pa, n) => {
      for (let k = 0; k < pa.ants; k++) ants += `<g class="ant" data-p="${n}" data-a="${k}" transform="${antPose(antAt(pa, k, opts.t || 0))}">${ANT}</g>`;
      if (!opts.mini) {
        hits += `<polyline data-k="path" data-i="${n}" points="${pa.trail.map((q) => `${f(q.x)},${f(q.y)}`).join(' ')}"`
          + ` fill="none" stroke="#000" stroke-opacity="0" stroke-width="${f(Math.max(2.5, pa.w + 1))}"/>`;
      }
    });
    L.hills.forEach((hl, n) => {
      for (let k = 0; k < hl.ants; k++) ants += `<g class="ant" data-h="${n}" data-a="${k}" transform="${antPose(antAt(hl, k, opts.t || 0))}">${ANT}</g>`;
      if (hl.mood !== 'quiet') {
        hl.lights.forEach((l, j) => {
          glow += `<circle class="glow" data-role="${hl.role}" cx="${f(Math.floor(l.x) + 0.5)}" cy="${f(Math.floor(l.y) + 0.5)}" r="1.25"`
            + ` fill="${LIGHTS[hl.role]}" style="animation-delay:${f(-((hash(hl.name, j) % 30) / 10))}s"/>`;
        });
      }
      if (opts.mini) return;
      const ink = hl.mood === 'quiet' ? '#b9b0a2' : C.inkUnder;
      if (hl.kind === 'food') {
        labels += `<text x="${f(L.food.cx)}" y="${f(L.surface - 9.6)}" font-size="2" font-weight="700" font-family="ui-monospace, Menlo, Consolas, monospace"`
          + ` text-anchor="middle" fill="${C.label}" stroke="${C.sky}" stroke-width="0.6" paint-order="stroke">${esc(hl.name)}</text>`;
        hits += `<g data-k="hill" data-i="${n}"><rect x="${f(L.food.x0 - 1)}" y="${f(L.surface - 11.5)}" width="${f(L.food.w + 2)}" height="12"/></g>`;
        return;
      }
      const hm = hl.home;
      labels += `<text x="${f(hm.cx)}" y="${f(hm.y0 + hm.h + LABEL - 0.6)}" font-size="1.8" font-family="ui-monospace, Menlo, Consolas, monospace"`
        + ` text-anchor="middle" fill="${ink}" stroke="#3b2a1c" stroke-width="0.5" paint-order="stroke">${esc(label(hl))}</text>`;
      hits += `<g data-k="hill" data-i="${n}"><rect x="${f(hl.mound.x0 - 1)}" y="${f(L.surface - hl.mound.h - 5)}" width="${f(hl.mound.w + 2)}" height="${f(hl.mound.h + 5)}"/>`
        + `<rect x="${f(hm.x0 - 0.5)}" y="${f(hm.y0 - 0.5)}" width="${f(hm.w + 1)}" height="${f(hm.h + LABEL + 0.5)}"/></g>`;
      foods += `<rect data-k="food" data-i="${n}" x="${f(hl.food.x0 - 0.6)}" y="${f(hl.food.y0 - 1)}" width="${f(hl.food.w + 1.2)}" height="${f(hl.food.h + 1.4)}"/>`;
    });
    const sw = f(sx1 - sx0), sx = sx0 ? `x="${f(sx0)}" ` : '';
    const body = (opts.scene ? '' : `<rect width="${L.width}" height="${L.surface}" fill="${C.sky}"/>`)
      + `<rect ${sx}y="${L.surface}" width="${sw}" height="${f(L.height - L.surface)}" fill="${C.soil[0]}"/>`
      + `<rect ${sx}y="${L.surface + 10}" width="${sw}" height="${f(L.height - L.surface - 10)}" fill="${C.soil[1]}"/>`
      + `<rect ${sx}y="${f(L.gallery - 2)}" width="${sw}" height="${f(L.height - L.gallery + 2)}" fill="${C.soil[2]}"/>`
      + `<g shape-rendering="crispEdges">${rects(px)}</g>`
      + `<g class="glows" opacity="0.38">${glow}</g>${labels}<g class="ants">${ants}</g>`
      + (opts.mini ? '' : `<g class="hits" fill="#000" fill-opacity="0">${hits}${foods}</g>`);
    return { body, L };
  }

  function svg(agents, opts = {}) {
    const { body, L } = parts(agents, opts);
    const counts = MOOD_ORDER.map((m) => `${L.hills.filter((h) => h.mood === m).length} ${m}`).join(', ');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${L.width} ${L.height}" class="anthills" role="img"`
      + ` aria-label="${L.hills.length} agents: ${counts}">${body}</svg>`;
  }

  return { pathWidth, antPose, hash, rng, sizeOf, roleOf, roleRank, moodOf, design, inside, layout, antAt, parts, svg, label,
    SIZES, ANTS, SHAPES, CONTENTS, SOILS, LIGHTS, ROLE_ORDER, ROLE_TEXT, SPEED, SCALE, COL };
}));
