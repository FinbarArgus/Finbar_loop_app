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
  const f = (v) => String(Math.round(v * 100) / 100);

  // state: growth.derive(); agents: status.json agents[]; opts: {messages, t, branchNames, hour}.
  // -> {svg, L (the farm's layout), box (the whole scene), home (the default view: the farm and the trunk's foot),
  //     tree (the tree, over the scene's width, and the ground it stands on)}; each box is {x0, y0, x1, y1} in blocks.
  function scene(state, agents, opts = {}) {
    const trunk = SCALE * ((((state.chains || [])[0] || {}).segs || [])[0] || {}).w0 || 0;
    const gap = 2 * Math.ceil(Math.max(GAP, trunk + 8) / 2);
    const lopts = { ...opts, gap };
    const L = H.layout(agents, lopts);
    const fx = L.gap.cx;
    const T = G.parts(state, { scene: true, paper: SKY, branchNames: opts.branchNames, hour: opts.hour, scaleX: (1 - fx) / SCALE });
    const tx0 = fx + SCALE * T.x0, tx1 = fx + SCALE * (T.x0 + T.w), ty0 = L.surface + SCALE * T.y0;
    const box = { x0: Math.min(0, tx0), y0: Math.min(0, ty0), x1: Math.max(L.width, tx1), y1: L.height };
    const tree = { x0: box.x0, y0: ty0, x1: box.x1, y1: L.surface + 4 };
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
      + `<g class="farm">${farm.body}</g>`
      + `<g class="tree" transform="${place}">${T.hits}</g></svg>`;
    return { svg, L, box, home, tree };
  }

  return { scene, SCALE, HOME_SKY, GAP };
}));
