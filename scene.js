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
  // The sky follows the weekly usage (state/usage.json): by day a sun crosses the default view on an arc, rising at
  // its left at 0%, highest at SUN_PCT / 2 and setting at its right at SUN_PCT, with the percentage above it; night
  // from SUN_PCT on, or while the usage guard holds. At night a lamp lights the scene when the guard is overridden or
  // an Urgent message woke a session. The sun and its arc grow with the farm's width (1 at SUN.per blocks or less), so
  // they read at the default view's zoom on a phone; the default view's top rises to hold them (sunArc). SUN.ground:
  // blocks of clear sky between the ray tips at the arc's ends and the surface (the anthills, their rocks);
  // SUN.margin: from the view's sides (the height scale); the arc rises SUN.lift + SUN.liftPer blocks per unit.
  const SUN_PCT = 95;
  const SUN = { per: 100, r: 2, ray: 1.3, font: 1.7, ground: 9, margin: 8, lift: 5, liftPer: 7,
    core: '#f7c948', edge: '#ee9a2e', ink: '#6b4a10' };
  const LAMP = { glass: '#fff1b8', base: '#8a8577', glow: '#ffd77a', reach: 34 };
  const HOME_SKY = 24;          // blocks of sky above the surface in the default view (the anthills and the trunk's foot)
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

  // The sky for a usage figure (state/usage.json: {pct, held, override, woken, stale}, or null when unknown):
  // {night, lamp, held, woken}. Night while held, and from SUN_PCT on (the guard overridden: `usage-guard off`).
  function skyOf(usage) {
    const u = usage || {}, woken = u.woken || [];
    const night = !!u.held || (u.pct != null && u.pct >= SUN_PCT);
    return { night, lamp: night && (!!u.override || woken.length > 0), held: !!u.held, woken };
  }
  // The sun's arc over the farm L: {s (its size), r, reach (centre to ray tip), gap (centre to the label's baseline),
  // font, x0, x1 (its centre at 0% and SUN_PCT), low (its centre at both ends), apex (at SUN_PCT / 2), top (the label's
  // top at the apex)}.
  function sunArc(L) {
    const s = Math.max(1, L.width / SUN.per), r = SUN.r * s, reach = r + SUN.ray * s, gap = r + 1.6 * s, font = SUN.font * s;
    const low = L.surface - SUN.ground - reach, apex = low - (SUN.lift + SUN.liftPer * s), edge = SUN.margin + reach;
    return { s, r, reach, gap, font, x0: edge, x1: L.width - edge, low, apex, top: apex - gap - font };
  }
  // The sun's centre for pct: x linear from arc.x0 (0%) to arc.x1 (SUN_PCT), y on a parabola, arc.low at both ends
  // and arc.apex at SUN_PCT / 2; past SUN_PCT it stays set.
  function sunAt(pct, arc) {
    const u = Math.max(0, Math.min(1, pct / SUN_PCT));
    return { x: arc.x0 + u * (arc.x1 - arc.x0), y: arc.low - (arc.low - arc.apex) * (1 - (2 * u - 1) ** 2) };
  }
  const MONO = 'font-family="ui-monospace, Menlo, Consolas, monospace"';
  // The sun (a disc with eight short rays) and, over the scene, its label; a stale figure is drawn faded with a "?".
  function sunSvg(usage, arc) {
    const { x, y } = sunAt(usage.pct, arc), { s, r, reach, gap, font } = arc, op = usage.stale ? ' opacity="0.45"' : '';
    const rays = [...Array(8)].map((_, k) => {
      const a = k * Math.PI / 4, c = Math.cos(a), sn = Math.sin(a);
      return `<line x1="${f(x + c * (r + 0.5 * s))}" y1="${f(y + sn * (r + 0.5 * s))}" x2="${f(x + c * reach)}" y2="${f(y + sn * reach)}"/>`;
    }).join('');
    const text = `${Math.round(usage.pct)}%${usage.stale ? '?' : ''}`;
    const w = Math.max(2 * reach, 0.62 * font * text.length);
    return {
      disc: `<g class="sun"${op}><g stroke="${SUN.edge}" stroke-width="${f(0.45 * s)}" stroke-linecap="round">${rays}</g>`
        + `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="${SUN.core}" stroke="${SUN.edge}" stroke-width="${f(0.3 * s)}"/></g>`,
      label: `<text class="sunlabel" x="${f(x)}" y="${f(y - gap)}" font-size="${f(font)}" font-weight="700" text-anchor="middle" ${MONO}`
        + ` fill="${SUN.ink}" stroke="${SKY}" stroke-width="${f(0.45 * s)}" paint-order="stroke"${op}>${text}</text>`,
      hit: `<rect x="${f(x - w / 2)}" y="${f(y - gap - font)}" width="${f(w)}" height="${f(gap + font + reach)}" data-k="sky" fill="#000" fill-opacity="0"/>`,
    };
  }
  // The lamp hanging in the night sky over LOOP's pile: a bulb on a cord, its warm glow, and a hole in the night shade
  // around it (a mask) so that part of the scene is lit.
  function lampSvg(L, skyTop) {
    const x = L.food.cx, y = L.surface - HOME_SKY + 4.5;
    return {
      x, y,
      bulb: `<g class="lamp"><line x1="${f(x)}" y1="${f(skyTop)}" x2="${f(x)}" y2="${f(y - 2.1)}" stroke="${LAMP.base}" stroke-width="0.2"/>`
        + `<rect x="${f(x - 0.6)}" y="${f(y - 2.3)}" width="1.2" height="1" fill="${LAMP.base}"/>`
        + `<circle cx="${f(x)}" cy="${f(y)}" r="1.5" fill="${LAMP.glass}"/></g>`,
      glow: `<circle class="lampglow" cx="${f(x)}" cy="${f(y)}" r="${LAMP.reach}" fill="url(#lampglow)" pointer-events="none"/>`,
      defs: `<defs><radialGradient id="lampglow"><stop offset="0" stop-color="${LAMP.glow}" stop-opacity="0.32"/>`
        + `<stop offset="1" stop-color="${LAMP.glow}" stop-opacity="0"/></radialGradient>`
        + `<radialGradient id="lamphole"><stop offset="0.15" stop-color="#000"/><stop offset="1" stop-color="#fff"/></radialGradient></defs>`,
      hit: `<rect x="${f(x - 2.5)}" y="${f(y - 3)}" width="5" height="5" data-k="sky" fill="#000" fill-opacity="0"/>`,
    };
  }

  // state: growth.derive(); agents: status.json agents[]; opts: {messages, t, branchNames, hour, usage, tasks}.
  // opts.usage (state/usage.json, see skyOf): the sun by day; at night a sky with stars and a moon, the tree and the
  // farm in shade, and, while held, z's from every asleep anthill (anthills.js) drawn over the shade (an overridden
  // guard holds nothing, so its sessions stay awake). opts.tasks ({n, blocking}): the size of LOOP's pile (anthills.js).
  // The sun, the moon and the lamp are a tap target data-k="sky" (the app shows the usage).
  // -> {svg, L (the farm's layout), box (the whole scene), home (the default view: the farm and the trunk's foot),
  //     tree (the tree, over the scene's width, and the ground it stands on; a small tree's own frame)}; each box is
  //     {x0, y0, x1, y1} in blocks. A small tree (a young one, drawn smaller) has a marker above its foot in the
  //     default view, with its height and a tap target data-k="sprout" (the app zooms to `tree`).
  function scene(state, agents, opts = {}) {
    const trunk = SCALE * (state.scale == null ? 1 : state.scale) * (((((state.chains || [])[0] || {}).segs || [])[0] || {}).w0 || 0);
    const gap = 2 * Math.ceil(Math.max(GAP, trunk + 8) / 2);
    const sk = skyOf(opts.usage);
    const lopts = { ...opts, gap, night: sk.held ? { woken: sk.woken } : null };
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
    // The default view: the farm, the trunk's foot and at least HOME_SKY of sky, up to the sun's arc.
    const arc = sunArc(L);
    const home = { x0: 0, y0: Math.min(L.surface - HOME_SKY, arc.top - 1), x1: L.width, y1: L.height };
    const place = `translate(${f(fx)} ${f(L.surface)}) scale(${SCALE})`;
    const counts = ['blocked', 'working', 'quiet'].map((m) => `${L.hills.filter((h) => h.mood === m).length} ${m}`).join(', ');
    const skyTop = box.y0 - (box.y1 - box.y0), sky = sk.night ? NIGHT.sky : SKY;
    const sun = !sk.night && opts.usage && opts.usage.pct != null ? sunSvg(opts.usage, arc) : null;
    const lamp = sk.lamp ? lampSvg(L, skyTop) : null;
    const shadeBox = `x="${f(span[0])}" y="${f(skyTop)}" width="${f(span[1] - span[0])}" height="${f(L.height - skyTop)}"`;
    const night = !sk.night ? null : {
      sky: nightSky(span, skyTop, L.surface - 6, home, L),
      shade: (lamp ? `${lamp.defs}<mask id="lampmask" maskUnits="userSpaceOnUse" ${shadeBox}><rect ${shadeBox} fill="#fff"/>`
        + `<circle cx="${f(lamp.x)}" cy="${f(lamp.y)}" r="${LAMP.reach}" fill="url(#lamphole)"/></mask>` : '')
        + `<rect class="nightshade" ${shadeBox} fill="${NIGHT.shade}" fill-opacity="0.42" pointer-events="none"${lamp ? ' mask="url(#lampmask)"' : ''}/>`
        + (lamp ? lamp.glow + lamp.bulb : '') + farm.zz,
    };
    const moon = sk.night ? moonAt(L) : null;
    const skyHit = sun ? sun.hit : moon ? `<rect x="${f(moon.x - 3.5)}" y="${f(moon.y - 3.5)}" width="7" height="7" data-k="sky" fill="#000" fill-opacity="0"/>`
      + (lamp ? lamp.hit : '') : '';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(home.x0)} ${f(home.y0)} ${f(home.x1 - home.x0)} ${f(home.y1 - home.y0)}"`
      + ` class="scene${night ? ' night' : ''}" role="img" aria-label="${state.stage}, ${f(state.height)} m tall, over ${L.hills.length} agents: ${counts}`
      + `${night ? `, at night (${sk.held ? 'usage held' : 'over the weekly limit'}${lamp ? ', a lamp lit' : ''})` : ''}`
      + `${sun ? `, a sun at ${Math.round(opts.usage.pct)}% weekly usage` : ''}">`
      + `<rect x="${f(span[0])}" y="${f(skyTop)}" width="${f(span[1] - span[0])}" height="${f(L.surface - skyTop)}" fill="${sky}"/>`
      + (night ? night.sky : '')
      // A grown tree's foot stands in LOOP's pile (the farm drawn over it); a young one is drawn over the farm's grass.
      + (small ? `<g class="farm">${farm.body}</g><g class="tree" transform="${place}" shape-rendering="crispEdges">${T.body}</g>`
        : `<g class="tree" transform="${place}" shape-rendering="crispEdges">${T.body}</g><g class="farm">${farm.body}</g>`)
      + (flying.length ? `<g class="birds">${flying.map((b) => b.draw).join('')}</g>` : '')
      + (night ? night.shade : '')
      + sprout + (sun ? sun.disc + sun.label : '')
      + `<g class="tree" transform="${place}">${T.hits}</g>`
      + (sproutHit || flying.length || skyHit ? `<g class="hits">${sproutHit}${flying.map((b) => b.hit).join('')}${skyHit}</g>` : '') + '</svg>';
    return { svg, L, box, home, tree };
  }

  // Stars over the sky [x0, x1] x [y0, y1] (a fixed pattern, thicker in the default view), and a crescent moon in the default view's top right.
  function nightSky([x0, x1], y0, y1, home, L) {
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
    const { x: mx, y: my } = moonAt(L);
    return out + `</g><g class="moon"><circle cx="${f(mx)}" cy="${f(my)}" r="2.6" fill="${NIGHT.moon}"/>`
      + `<circle cx="${f(mx + 1.2)}" cy="${f(my - 0.7)}" r="2.3" fill="${NIGHT.sky}"/></g>`;
  }

  // The moon: in the default view's top right, HOME_SKY - 5 above the surface.
  const moonAt = (L) => ({ x: L.width - 7, y: L.surface - HOME_SKY + 5 });

  return { scene, birds, skyOf, sunArc, sunAt, SUN_PCT, SUN, NIGHT, SCALE, HOME_SKY, GAP, SMALL, BIRD_NEAR, BIRD_PER_DAY, BIRD_DAYS, BIRD_SMALL, BIRD_GROW };
}));
