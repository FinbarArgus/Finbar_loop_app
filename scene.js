// The Tree tab's scene: the growth tree (growth.js) standing on the ant farm (anthills.js), as one drawing.
// The tree stands on the surface in a gap between LOOP's fruit pile (its fallen fruit) and the first anthill to the
// right; the anthills' shafts lead down to the anthomes. Coordinates are the farm's blocks (y down, the surface at L.surface); the
// tree is drawn at SCALE farm blocks per tree unit (a metre): a farm block is BLOCK_M = 12.5 cm, so an anthome (5-7 blocks)
// is under 1 m on the tree's height scale, and one of the tree's own blocks (CELL = 0.5 m) is 4 farm blocks.
// A pure function like the two it draws (no clock, no network). Loaded in the browser (window.LoopScene) and by Node.
(function (root, factory) {
  const api = typeof module === 'object' && module.exports
    ? factory(require('./growth.js'), require('./anthills.js'))
    : factory(root.LoopGrowth, root.LoopHills);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LoopScene = api;
}(typeof self !== 'undefined' ? self : this, (G, H) => {
  'use strict';

  const BLOCK_M = 0.125;        // a farm block, in metres (the tree's units)
  const SCALE = 1 / BLOCK_M;    // farm blocks per tree unit
  const SKY = '#f3f2ea';        // the farm's sky
  const NIGHT = { sky: '#1d2340', shade: '#0d1230', star: '#fff6d8', moon: '#f4efd2' };
  const HOME_SKY = 16;          // blocks of sky above the surface in the default view (the anthills and the trunk's foot)
  const GAP = 12;               // the least open surface the tree stands in; it widens with the trunk (trunk + 8)
  const SMALL = 4;              // a tree shorter than this (blocks) gets a marker at its foot, and Whole tree frames it alone
  const f = (v) => String(Math.round(v * 100) / 100);
  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  // Deadline birds: a bird flies in from up and left of LOOP's food pile, BIRD_NEAR + BIRD_PER_DAY blocks per day to
  // its deadline away (counted up to BIRD_DAYS), and grows from BIRD_SMALL to 1 block per sprite cell over its last
  // BIRD_GROW days. A dashed line runs to the crown node it will land on (growth.layout); once passed it perches there.
  const BIRD_NEAR = 6, BIRD_PER_DAY = 4, BIRD_DAYS = 45, BIRD_SMALL = 0.35, BIRD_GROW = 14;

  // Flying birds -> [{id, x, y, size, land: {x, y}}] in scene blocks. fx: the trunk's foot; L: the farm's layout.
  function birds(state, L, fx) {
    const k = G.treeScale(state), lb = G.layout(state).birds;
    const pile = { x: L.food.cx, y: L.surface - 3 };
    return (state.birds || []).map((b, n) => ({ b, n })).filter(({ b }) => !b.evil).map(({ b, n }) => {
      const d = Math.min(Math.max(b.days, 0), BIRD_DAYS), dist = BIRD_NEAR + BIRD_PER_DAY * d;
      const a = (20 + 40 * G.rng(state.seed, 'bird-angle', b.id)()) * Math.PI / 180;
      return { id: b.id, x: pile.x - dist * Math.cos(a), y: pile.y - dist * Math.sin(a),
        size: BIRD_SMALL + (1 - BIRD_SMALL) * (1 - Math.min(Math.max(b.days, 0), BIRD_GROW) / BIRD_GROW),
        land: { x: fx + SCALE * k * lb[n].x, y: L.surface - SCALE * k * lb[n].y } };
    });
  }
  function birdSvg(bd) {
    const rows = G.GULL, s = bd.size, w = rows[0].length * s, h = rows.length * s, x0 = bd.x - w / 2, y0 = bd.y - h / 2;
    let px = '';
    rows.forEach((row, r) => [...row].forEach((ch, c) => {
      if (ch !== ' ') px += `<rect x="${f(x0 + c * s)}" y="${f(y0 + r * s)}" width="${f(s)}" height="${f(s)}" fill="${ch === '#' ? G.BIRD_INK : G.GULL_FILL}"/>`;
    }));
    const line = `<line x1="${f(bd.x)}" y1="${f(bd.y)}" x2="${f(bd.land.x)}" y2="${f(bd.land.y)}" stroke="${G.BIRD_INK}" stroke-opacity="0.45"`
      + ` stroke-width="0.25" stroke-dasharray="1 1"/>`;
    const hw = Math.max(w, 3) / 2, hh = Math.max(h, 3) / 2;
    return { draw: `<g class="bird" data-i="${esc(bd.id)}">${line}${px}</g>`,
      hit: `<rect x="${f(bd.x - hw)}" y="${f(bd.y - hh)}" width="${f(2 * hw)}" height="${f(2 * hh)}" data-k="bird" data-i="${esc(bd.id)}" fill="#000" fill-opacity="0"/>` };
  }

  // state: growth.derive(); agents: status.json agents[]; opts: {messages, t, branchNames, hour, usage, night}.
  // opts.night ({woken: [names]}, while state/usage.json is held): a night sky with stars and a moon, the tree and
  // the farm in shade, and z's from every asleep anthill (anthills.js) drawn over the shade.
  // -> {svg, L (the farm's layout), box (the whole scene), home (the default view: the farm and the trunk's foot),
  //     tree (the tree, over the scene's width, and the ground it stands on; a small tree's own frame)}; each box is
  //     {x0, y0, x1, y1} in blocks. A small tree (a young one, drawn smaller) has a marker above its foot in the
  //     default view, with its height and a tap target data-k="sprout" (the app zooms to `tree`).
  function scene(state, agents, opts = {}) {
    const trunk = SCALE * (state.scale == null ? 1 : state.scale) * (((((state.chains || [])[0] || {}).segs || [])[0] || {}).w0 || 0);
    const gap = 2 * Math.ceil(Math.max(GAP, trunk + 8) / 2);
    const lopts = { ...opts, gap };
    const L = H.layout(agents, lopts);
    const fx = L.gap.cx;
    const tall = SCALE * (state.height || 0);
    const small = tall < SMALL;
    // A grown tree's height scale stands at the farm's left edge; a small tree's beside it, to be seen with it up close.
    const T = G.parts(state, { scene: true, paper: SKY, branchNames: opts.branchNames, hour: opts.hour,
      scaleX: small ? null : (1 - fx) / SCALE });
    const tx0 = fx + SCALE * T.x0, tx1 = fx + SCALE * (T.x0 + T.w), ty0 = L.surface + SCALE * T.y0;
    const flying = birds(state, L, fx).map((bd) => ({ ...bd, ...birdSvg(bd) }));
    const box = { x0: Math.min(0, tx0, ...flying.map((b) => b.x - 4)), y0: Math.min(0, ty0, ...flying.map((b) => b.y - 4)),
      x1: Math.max(L.width, tx1), y1: L.height };
    // A small tree's frame: the tree and its height scale, with as much ground below as the tree is tall.
    const tree = small ? { x0: tx0, y0: ty0, x1: tx1, y1: L.surface + (L.surface - ty0) * 0.25 }
      : { x0: box.x0, y0: ty0, x1: box.x1, y1: L.surface + 4 };
    const cm = (state.height || 0) < 1 ? `${Math.round((state.height || 0) * 100)} cm` : `${(state.height || 0).toFixed(1)} m`;
    const sprout = !small ? '' : `<g class="sprout"><text x="${f(fx)}" y="${f(L.surface - tall - 1.2)}" font-size="1.6" text-anchor="middle"`
      + ` font-family="ui-monospace, Menlo, Consolas, monospace" fill="#5b4a2e" stroke="${SKY}" stroke-width="0.4" paint-order="stroke">`
      + `${state.papers && state.papers.length ? `tree: ${cm} ↓` : 'tree: none yet'}</text></g>`;
    const sproutHit = !small ? '' : `<rect x="${f(fx - 4)}" y="${f(L.surface - 5)}" width="8" height="5" data-k="sprout" fill="#000" fill-opacity="0"/>`;
    // The ground and sky run a scene's width past each side, so a view zoomed out past the scene shows no edge.
    const bw = box.x1 - box.x0, span = [box.x0 - bw, box.x1 + bw];
    const farm = H.parts(agents, { ...lopts, scene: true, span });
    const home = { x0: 0, y0: L.surface - HOME_SKY, x1: L.width, y1: L.height };
    const place = `translate(${f(fx)} ${f(L.surface)}) scale(${SCALE})`;
    const counts = ['blocked', 'working', 'quiet'].map((m) => `${L.hills.filter((h) => h.mood === m).length} ${m}`).join(', ');
    const skyTop = box.y0 - (box.y1 - box.y0), sky = opts.night ? NIGHT.sky : SKY;
    const night = !opts.night ? null : {
      sky: nightSky(span, skyTop, L.surface - 6, home),
      shade: `<rect class="nightshade" x="${f(span[0])}" y="${f(skyTop)}" width="${f(span[1] - span[0])}" height="${f(L.height - skyTop)}"`
        + ` fill="${NIGHT.shade}" fill-opacity="0.42" pointer-events="none"/>${farm.zz}`,
    };
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(home.x0)} ${f(home.y0)} ${f(home.x1 - home.x0)} ${f(home.y1 - home.y0)}"`
      + ` class="scene${night ? ' night' : ''}" role="img" aria-label="${state.stage}, ${f(state.height)} m tall, over ${L.hills.length} agents: ${counts}`
      + `${night ? ', at night (usage held)' : ''}">`
      + `<rect x="${f(span[0])}" y="${f(skyTop)}" width="${f(span[1] - span[0])}" height="${f(L.surface - skyTop)}" fill="${sky}"/>`
      + (night ? night.sky : '')
      // A grown tree's foot stands in LOOP's pile (the farm drawn over it); a young one is drawn over the farm's grass.
      + (small ? `<g class="farm">${farm.body}</g><g class="tree" transform="${place}" shape-rendering="crispEdges">${T.body}</g>`
        : `<g class="tree" transform="${place}" shape-rendering="crispEdges">${T.body}</g><g class="farm">${farm.body}</g>`)
      + (flying.length ? `<g class="birds">${flying.map((b) => b.draw).join('')}</g>` : '')
      + (night ? night.shade : '')
      + sprout
      + `<g class="tree" transform="${place}">${T.hits}</g>`
      + (sproutHit || flying.length ? `<g class="hits">${sproutHit}${flying.map((b) => b.hit).join('')}</g>` : '') + '</svg>';
    return { svg, L, box, home, tree };
  }

  // Stars over the sky [x0, x1] x [y0, y1] (a fixed pattern, thicker in the default view), and a crescent moon in the default view's top right.
  function nightSky([x0, x1], y0, y1, home) {
    const r = H.rng('stars');
    let out = '<g class="stars">';
    const scatter = (n, ax, bx, ay, by) => {
      for (let k = 0; k < n; k++) {
        const s = r() < 0.15 ? 0.5 : 0.3;
        out += `<rect x="${f(ax + r() * (bx - ax))}" y="${f(ay + r() * (by - ay))}" width="${s}" height="${s}" fill="${NIGHT.star}"/>`;
      }
    };
    scatter(30, home.x0, home.x1, home.y0, y1);                                   // the default view's sky
    scatter(Math.min(240, Math.round((x1 - x0) * Math.max(0, y1 - y0) / 70)), x0, x1, y0, y1);
    const mx = home.x1 - 7, my = home.y0 + 5;
    return out + `</g><g class="moon"><circle cx="${f(mx)}" cy="${f(my)}" r="2.6" fill="${NIGHT.moon}"/>`
      + `<circle cx="${f(mx + 1.2)}" cy="${f(my - 0.7)}" r="2.3" fill="${NIGHT.sky}"/></g>`;
  }

  return { scene, birds, NIGHT, SCALE, HOME_SKY, GAP, SMALL, BIRD_NEAR, BIRD_PER_DAY, BIRD_DAYS, BIRD_SMALL, BIRD_GROW };
}));
