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
    const box = { x0: Math.min(0, tx0), y0: Math.min(0, ty0), x1: Math.max(L.width, tx1), y1: L.height };
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
      + (night ? night.shade : '')
      + sprout
      + `<g class="tree" transform="${place}">${T.hits}</g>${sproutHit ? `<g class="hits">${sproutHit}</g>` : ''}</svg>`;
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

  return { scene, NIGHT, SCALE, HOME_SKY, GAP, SMALL };
}));
