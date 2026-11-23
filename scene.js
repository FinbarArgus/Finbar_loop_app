// The Tree tab's scene: the growth tree (growth.js) standing on the ant farm (anthills.js), as one drawing.
// The tree stands on the surface in a gap between LOOP's fruit pile (its fallen fruit) and the first anthill to the
// right; the anthills' shafts lead down to the anthomes. Coordinates are the farm's blocks (y down, the surface at L.surface); the
// tree is drawn at SCALE blocks per tree unit, so one of its blocks (CELL = 0.5 units) is one farm block.
// A pure function like the two it draws (no clock, no network). Loaded in the browser (window.LoopScene) and by Node.
(function (root, factory) {
  const api = typeof module === 'object' && module.exports
    ? factory(require('./growth.js'), require('./anthills.js'))
    : factory(root.LoopGrowth, root.LoopHills);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LoopScene = api;
}(typeof self !== 'undefined' ? self : this, (G, H) => {
  'use strict';

  const SCALE = 1 / G.CELL;     // farm blocks per tree unit
  const SKY = '#f3f2ea';        // the farm's sky
  const HOME_SKY = 16;          // blocks of sky above the surface in the default view (the anthills and the trunk's foot)
  const GAP = 12;               // the least open surface the tree stands in; it widens with the trunk (trunk + 8)
  const SMALL = 4;              // a tree shorter than this (blocks) gets a marker at its foot, and Whole tree frames it alone
  const f = (v) => String(Math.round(v * 100) / 100);

  // state: growth.derive(); agents: status.json agents[]; opts: {messages, t, branchNames, hour}.
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
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(home.x0)} ${f(home.y0)} ${f(home.x1 - home.x0)} ${f(home.y1 - home.y0)}"`
      + ` class="scene" role="img" aria-label="${state.stage}, ${f(state.height)} m tall, over ${L.hills.length} agents: ${counts}">`
      + `<rect x="${f(span[0])}" y="${f(box.y0 - (box.y1 - box.y0))}" width="${f(span[1] - span[0])}" height="${f(L.surface - box.y0 + (box.y1 - box.y0))}" fill="${SKY}"/>`
      + `<g class="tree" transform="${place}" shape-rendering="crispEdges">${T.body}</g>`
      + `<g class="farm">${farm.body}</g>${sprout}`
      + `<g class="tree" transform="${place}">${T.hits}</g>${sproutHit ? `<g class="hits">${sproutHit}</g>` : ''}</svg>`;
    return { svg, L, box, home, tree };
  }

  return { scene, SCALE, HOME_SKY, GAP, SMALL };
}));
