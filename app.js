// The loop app: reads items from the private loop repo through the GitHub API and writes answers and
// detail requests back as new files. No server: the token and repo name stay in this browser.
(function () {
  'use strict';
  const { el, inline } = window.LoopRender;
  const API = 'https://api.github.com';
  const $ = (s) => document.querySelector(s);
  const main = () => $('#main');

  const cfg = {
    get token() { return safeGet('loop.token'); },
    get repo() { return safeGet('loop.repo'); },
    get branch() { return safeGet('loop.branch') || 'main'; },
  };
  function safeGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function safeSet(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { /* private mode */ } }

  // ------------------------------------------------------------ GitHub

  async function gh(path, opts = {}) {
    const r = await fetch(API + path, {
      cache: 'no-cache',               // revalidate with the ETag: unchanged files cost no rate limit
      ...opts,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        Accept: opts.raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        ...(opts.headers || {}),
      },
    });
    if (!r.ok) {
      const err = new Error(`${r.status} ${r.statusText} for ${path}`);
      err.status = r.status;
      throw err;
    }
    return r;
  }
  const repoPath = (p) => `/repos/${cfg.repo}/contents/${p.split('/').map(encodeURIComponent).join('/')}?ref=${cfg.branch}`;
  // JSON files are cached by their blob sha in the last loaded tree: an unchanged file costs no request.
  const jsonCache = new Map();
  // fresh: skip the cache, for code that polls a file without reloading the tree.
  async function getJSON(p, { fresh } = {}) {
    const sha = tree.sha.get(p);
    const c = jsonCache.get(p);
    if (!fresh && sha && c && c.sha === sha) return JSON.parse(c.text);
    const text = await (await gh(repoPath(p), { raw: true })).text();
    if (sha) jsonCache.set(p, { sha, text });
    return JSON.parse(text);
  }

  // A blob gets its file's type from the name (GitHub serves raw files untyped), so a PDF opens as a PDF.
  // Types that run script when opened (html, svg) are left untyped.
  const FILE_TYPES = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', txt: 'text/plain', csv: 'text/csv', json: 'application/json' };
  const fileType = (p) => FILE_TYPES[(p.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
  const blobCache = new Map();   // path -> Promise<{ file, url }>
  const blobReady = new Map();   // path -> { file, url }, once loaded: lets a tap open it without awaiting
  function fileBlob(p) {
    if (!blobCache.has(p)) {
      blobCache.set(p, gh(repoPath(p), { raw: true }).then((r) => r.blob()).then((b) => {
        const file = new File([b], p.split('/').pop(), { type: fileType(p) });
        const f = { file, url: URL.createObjectURL(file) };
        blobReady.set(p, f);
        return f;
      }));
    }
    return blobCache.get(p);
  }
  async function fileUrl(p) {
    return (await fileBlob(p)).url;
  }

  let tree = { paths: new Set(), sha: new Map(), at: 0, root: null };
  async function loadTree() {
    const t = await (await gh(`/repos/${cfg.repo}/git/trees/${cfg.branch}?recursive=1`)).json();
    const blobs = t.tree.filter((x) => x.type === 'blob');
    tree = { paths: new Set(blobs.map((x) => x.path)), sha: new Map(blobs.map((x) => [x.path, x.sha])), at: Date.now(), root: t.sha };
    return tree;
  }
  // Views draw from a tree loaded in the last 5 min; route() then reloads it in the background and redraws if
  // the repo changed. Polls call loadTree() themselves.
  let treeWasCached = false;
  async function useTree() {
    if (tree.at && !tree.stale && Date.now() - tree.at < 300_000) { treeWasCached = true; return tree; }
    return loadTree();
  }
  const filesIn = (dir) => [...tree.paths].filter((p) => p.startsWith(dir + '/') && p.endsWith('.json')
    && p.split('/').length === dir.split('/').length + 1).map((p) => p.split('/').pop()).sort();

  function b64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  async function put(path, bytes, message) {
    await gh(`/repos/${cfg.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, content: b64(bytes), branch: cfg.branch, sha: tree.sha.get(path) }),
    }).then((r) => r.json()).then((j) => {
      if (!j || !j.content || !j.content.sha) { tree.sha.delete(path); return; }
      tree.sha.set(path, j.content.sha);
      if (path.endsWith('.json')) jsonCache.set(path, { sha: j.content.sha, text: new TextDecoder().decode(bytes) });
    }).catch(() => {});
    tree.paths.add(path);
    tree.stale = true;                   // the redraw after a write reloads the tree
  }
  const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
    + '-' + Math.random().toString(36).slice(2, 5);

  // Save images first, then the JSON that names them, so LOOP never sees a JSON before its images.
  async function send(dir, id, body, images) {
    const ts = stamp();
    const names = [];
    for (let k = 0; k < images.length; k++) {
      const name = `${ts}-${k}.${images[k].ext}`;
      await put(`${dir}/${id}/${name}`, images[k].bytes, `${id}: image for ${dir}`);
      names.push(name);
    }
    const doc = { id, ...body, images: names, at: new Date().toISOString(), device: matchMedia('(max-width: 700px)').matches ? 'phone' : 'computer' };
    await put(`${dir}/${id}/${ts}.json`, new TextEncoder().encode(JSON.stringify(doc, null, 1)), `${id}: ${dir === 'answers' ? 'answer' : 'detail request'}`);
    return `${ts}.json`;
  }

  // ------------------------------------------------------------ images from the reader

  async function toImage(file) {
    const MAX = 1600;
    let bmp;
    try { bmp = await createImageBitmap(file); } catch (e) { bmp = null; }
    if (!bmp || (file.size < 700_000 && Math.max(bmp.width, bmp.height) <= MAX && /png|jpe?g|gif|webp/.test(file.type))) {
      return { ext: (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg'), bytes: new Uint8Array(await file.arrayBuffer()), file };
    }
    const s = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * s);
    c.height = Math.round(bmp.height * s);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
    return { ext: 'jpg', bytes: new Uint8Array(await blob.arrayBuffer()), file: blob };
  }

  // Unsent text, kept in localStorage per box (`draft`: e.g. "item.R-0012.answer", "agent.HIGH-x.message") so a
  // redraw (a poll, coming back to the tab, leaving and reopening a view) never loses it. Cleared on a successful send.
  const DRAFT = 'loop.draft.';
  const draftGet = (key) => (key ? safeGet(DRAFT + key) : '');
  const draftSet = (key, v) => { if (key) safeSet(DRAFT + key, v ? v : null); };

  // A text box that takes images (attach, paste, drop). onSend(text, images) -> Promise. draft: its draft key.
  // urgent: while the usage hold is on, show an "Urgent: deliver now" tick; onSend gets {urgent} as its third argument.
  function composer({ placeholder, onSend, enterSends, sendLabel, extra, draft, urgent }) {
    const imgs = [];
    const tick = el('input', { type: 'checkbox', class: 'urgent' });
    const urgentRow = urgent && heldNow ? el('label', { class: 'wstate urgentrow' }, tick, 'Urgent: deliver now, despite the usage hold') : null;
    const ta = el('textarea', { rows: 2, placeholder });
    ta.value = draftGet(draft);
    ta.addEventListener('input', () => draftSet(draft, ta.value));
    const thumbs = el('div', { class: 'thumbs' });
    const status = el('div', { class: 'status' });
    const pick = el('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
    const add = async (files) => {
      for (const f of files) {
        if (!f.type.startsWith('image/')) continue;
        const im = await toImage(f);
        imgs.push(im);
        const t = el('span', { class: 'thumb' }, el('img', { src: URL.createObjectURL(im.file), alt: '' }),
          el('button', { class: 'x', title: 'remove', onclick: () => { imgs.splice(imgs.indexOf(im), 1); t.remove(); } }, '×'));
        thumbs.append(t);
      }
    };
    pick.addEventListener('change', () => add(pick.files));
    ta.addEventListener('paste', (e) => {
      const files = [...(e.clipboardData || {}).files || []];
      if (files.length) { e.preventDefault(); add(files); }
    });
    const box = el('div', { class: 'composer' });
    box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('drag'); });
    box.addEventListener('dragleave', () => box.classList.remove('drag'));
    box.addEventListener('drop', (e) => { e.preventDefault(); box.classList.remove('drag'); add(e.dataTransfer.files); });
    let busy = false;
    const go = async () => {
      const text = ta.value.trim();
      const ready = extra ? extra.ready() : true;
      if (busy || (!text && !imgs.length && !(extra && extra.value()))) return;
      if (!ready) return;
      busy = true;
      status.textContent = 'Sending…';
      try {
        await onSend(text, imgs.slice(), { urgent: !!(urgentRow && tick.checked) });
        tick.checked = false;
        draftSet(draft, null);
        ta.value = '';
        imgs.length = 0;
        thumbs.replaceChildren();
        status.textContent = 'Sent. LOOP picks it up within about a minute.';
      } catch (e) {
        status.textContent = `Not sent: ${e.message}`;
      }
      busy = false;
    };
    ta.addEventListener('keydown', (e) => {
      if (enterSends && e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); go(); }
    });
    box.append(extra ? extra.el : '', ta, urgentRow || '', thumbs,
      el('div', { class: 'row' },
        el('button', { class: 'ghost', title: 'Attach images (or paste / drop them)', onclick: () => pick.click() }, '+ image'),
        pick, el('span', { class: 'grow' }), el('button', { class: 'primary', onclick: go }, sendLabel || 'Send')),
      status);
    return box;
  }

  // ------------------------------------------------------------ views

  let index = { items: [] };
  let poller = null;
  let refreshItem = null;            // redraws the open item's thread and answers in place
  let justSent = null;               // id of the item whose answer was just sent (shows Next)
  const SECTIONS = [['question', 'Questions'], ['content', 'Content'], ['pr', 'Review']];
  const filterOf = (tab) => safeGet(`loop.filter.${tab}`) || 'all';

  function age(iso) {
    const h = (Date.now() - Date.parse(iso)) / 3.6e6;
    return h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} d`;
  }

  // Where an item sits: LOOP's index decides (a batch answered in part stays on the board).
  function sectionOf(it) {
    return it.section;
  }
  const isHistory = (it) => (it.section === 'answered' || it.section === 'closed')
    && !String(it.closed_reason || '').startsWith('grouped into');

  async function refreshIndex() {
    await useTree();
    index = await getJSON('index.json');
  }

  function setPoll(fn, ms) {
    clearInterval(poller);
    poller = setInterval(() => { if (!document.hidden) fn().catch(() => {}); }, ms);
  }

  function card(it) {
    const sent = filesIn(`answers/${it.id}`).length;
    const partial = it.n_questions > 1 && it.n_answered > 0 && it.n_answered < it.n_questions;
    return el('a', { class: `card imp-${it.importance}`, href: `#/item/${it.id}` },
      el('div', { class: 'top' }, el('span', { class: 'id' }, it.id), el('span', { class: 'imp' }, it.importance),
        it.blocking_now ? el('span', { class: 'badge block' }, 'blocking') : null,
        it.soon_blocking ? el('span', { class: 'badge soon' }, 'soon blocking') : null,
        it.stage ? el('span', { class: `badge stage ${it.stage}` }, it.stage === 'in-progress' ? 'in progress' : 'ready') : null,
        it.stage === 'in-progress' && it.versions > 1 ? el('span', { class: 'badge' }, `updated ${age(it.updated)} ago`) : null,
        it.n_questions > 1 ? el('span', { class: 'badge' }, `${it.n_questions} questions`) : null,
        partial ? el('span', { class: 'badge wait' }, `${it.n_answered} of ${it.n_questions} answered`) : null,
        isPermission(it) ? el('span', { class: 'badge perm' }, 'permission') : null,
        it.requests_open ? el('span', { class: 'badge wait' }, 'detail requested') : null,
        it.n_details ? el('span', { class: 'badge' }, `${it.n_details} detail`) : null,
        sent && !partial ? el('span', { class: 'badge ok' }, 'sent to LOOP') : null,
        el('span', { class: 'grow' }), el('span', { class: 'age' }, age(it.created))),
      el('div', { class: 'title', html: inline(it.title) }),
      el('div', { class: 'from' }, roleDot(it.from.name), it.from.name, it.holds_up ? ` · holds up: ${it.holds_up}` : ''));
  }

  // A permission prompt (posted by the PermissionRequest hook): Approve/Deny in one tap; the loop types it into
  // the session's dialog within seconds.
  const isPermission = (it) => (it.tags || []).includes('permission');

  function permissionBar(it, refresh) {
    const sent = filesIn(`answers/${it.id}`).length > 0;
    const msg = el('div', { class: 'status' }, sent ? 'Sent: the loop types it into the session within seconds.' : '');
    const pick = (choice) => async () => {
      [...btns.children].forEach((b) => { b.disabled = true; });
      msg.textContent = 'Sending…';
      try {
        await send('answers', it.id, { kind: 'answer', text: '', choice,
          answers: [{ question: 0, asked: questionsOf(it)[0].text, choice, text: '' }] }, []);
        justSent = it.id;
        msg.textContent = `${choice === 'Approve' ? 'Approved' : 'Denied'}: the loop types it into the session within seconds.`;
        await refresh();
      } catch (e) {
        msg.textContent = `Not sent: ${e.message || e}`;
        [...btns.children].forEach((b) => { b.disabled = false; });
      }
    };
    const btns = el('div', { class: 'permbtns' },
      el('button', { class: 'perm-yes', disabled: sent || it.status !== 'open', onclick: pick('Approve') }, 'Approve'),
      el('button', { class: 'perm-no', disabled: sent || it.status !== 'open', onclick: pick('Deny') }, 'Deny'));
    return el('section', { class: 'permbar' }, btns, msg,
      el('div', { class: 'who' }, 'Approve is the dialog\'s plain "Yes" (this once). Deny is its "No".'));
  }

  // Status: every permission decision, auto ones too, from state/permissions.json (newest first).
  const PERM_LABEL = { allow: 'auto-approved', deny: 'auto-denied', asked: 'asked you', approved: 'you approved',
    denied: 'you denied', gone: 'answered in the session' };
  function permissionsCard(log) {
    const rows = (log && log.entries) || [];
    const row = (e) => el('div', { class: `permrow ${e.decision}` },
      el('div', { class: 'arow' }, el('span', { class: `badge pd ${e.decision}` }, PERM_LABEL[e.decision] || e.decision),
        roleDot(e.session), el('b', {}, e.session), el('span', { class: 'who' }, ` · ${e.tool}`),
        el('span', { class: 'grow' }), el('span', { class: 'who' }, `${age(e.at)} ago`)),
      el('code', { class: 'ptarget' }, e.target.length > 300 ? e.target.slice(0, 300) + '…' : e.target),
      el('div', { class: 'who' }, e.reason, e.item ? ' · ' : '', e.item ? el('a', { href: `#/item/${e.item}` }, e.item) : ''));
    const first = rows.slice(0, 12);
    const rest = rows.slice(12);
    return el('section', { class: 'status-card perms' }, el('h3', {}, 'Permissions ', el('span', { class: 'n' }, String(rows.length))),
      rows.length ? first.map(row) : el('p', { class: 'empty' }, 'No permission prompts yet.'),
      rest.length ? el('details', { class: 'pmore' }, el('summary', {}, `Older (${rest.length})`), rest.map(row)) : null);
  }

  // A session's role colour (the anthome lights: HIGH red, IMPLEMENT blue, MED amber, LOW green, other purple).
  const roleDot = (name) => {
    const role = H.roleOf({ name });
    return el('i', { class: 'rdot', style: `background:${H.LIGHTS[role]}`, title: role === 'loop' ? 'LOOP' : H.ROLE_TEXT[role] });
  };

  async function showList(tab) {
    await refreshIndex();
    const groups = Object.fromEntries(SECTIONS.map(([k]) => [k, []]));
    index.items.forEach((it) => { const s = sectionOf(it); if (groups[s]) groups[s].push(it); });
    Object.values(groups).forEach((g) => g.sort(byRole));
    const nblock = (k) => groups[k].filter((x) => x.blocking_now).length;
    tab = SECTIONS.some(([k]) => k === tab) ? tab
      : SECTIONS.map(([k]) => k).find((k) => nblock(k)) || SECTIONS.map(([k]) => k).find((k) => groups[k].length) || 'question';
    const tabs = el('nav', { class: 'tabs' }, SECTIONS.map(([k, label]) => el('a', {
      href: `#/list/${k}`, class: k === tab ? 'on' : '',
    }, label, el('span', { class: 'n' }, String(groups[k].length)),
    nblock(k) ? el('span', { class: 'nb', title: 'blocking' }, String(nblock(k))) : null)));
    // Filters inside a tab; an item can match several (a ready entry that blocks is under Blocking and Ready).
    const FILTERS = {
      blocking: ['Blocking', (x) => x.blocking_now],
      soon: ['Soon blocking', (x) => x.soon_blocking],
      'in-progress': ['In progress', (x) => x.stage === 'in-progress'],
      ready: ['Ready', (x) => x.stage === 'ready'],
      all: ['All', () => true],
    };
    const names = tab === 'content' ? ['blocking', 'soon', 'in-progress', 'ready', 'all'] : ['blocking', 'soon', 'all'];
    const filter = names.includes(filterOf(tab)) ? filterOf(tab) : 'all';
    const sw = el('div', { class: 'switch' }, names.map((f) =>
      el('button', { class: f === filter ? 'on' : '', onclick: () => { safeSet(`loop.filter.${tab}`, f); showList(tab); } },
        `${FILTERS[f][0]} (${groups[tab].filter(FILTERS[f][1]).length})`)));
    const shown = groups[tab].filter(FILTERS[filter][1]);
    const list = el('div', { class: 'cards' });
    if (!shown.length) list.append(el('p', { class: 'empty' }, filter === 'all' ? 'Nothing here.' : `Nothing ${FILTERS[filter][0].toLowerCase()} here.`));
    shown.forEach((it) => list.append(card(it)));
    main().replaceChildren(tabs, sw, list, historyBox(tab),
      el('p', { class: 'foot' }, `Updated ${new Date(index.generated).toLocaleString()}`));
    setPoll(async () => {
      const before = index.generated + tree.paths.size;
      await loadTree();
      await refreshIndex();
      if (index.generated + tree.paths.size !== before) showList(tab);
    }, 60_000);
  }

  // History: answered and closed items, newest first, grouped by day. Each entry loads its questions and
  // answers only when opened; "Revisit" sends a request about that one item, which LOOP passes to the
  // session that asked it (agents read only that item, never the history).
  function historyBox(tab) {
    const label = (SECTIONS.find(([k]) => k === tab) || [, ''])[1];
    const past = index.items.filter((x) => isHistory(x) && (x.home || 'question') === tab)
      .sort((a, b) => (b.updated || b.created).localeCompare(a.updated || a.created));
    const box = el('details', { class: 'history' }, el('summary', {}, `${label} history (${past.length})`));
    let day = null;
    for (const it of past) {
      const d = new Date(it.updated || it.created).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
      if (d !== day) { box.append(el('div', { class: 'hday' }, d)); day = d; }
      const body = el('div', { class: 'hbody' });
      const entry = el('details', { class: 'hentry' },
        el('summary', {}, el('span', { class: 'id' }, it.id), ' ',
          el('span', { class: 'htitle', html: inline(it.title) }),
          el('span', { class: 'hstatus' }, it.section === 'closed' ? 'closed' : 'answered')),
        body);
      entry.addEventListener('toggle', () => { if (entry.open && !body.childElementCount) fillHistory(body, it); }, { once: false });
      box.append(entry);
    }
    if (!past.length) box.append(el('p', { class: 'empty' }, 'Nothing answered yet.'));
    return box;
  }

  async function fillHistory(body, row) {
    body.append(el('p', { class: 'empty' }, 'Loading…'));
    const it = await getJSON(`items/${row.id}/item.json`);
    window.LoopRender.setMacros(it.macros);
    const qs = questionsOf(it);
    const answers = [];
    for (const name of filesIn(`answers/${it.id}`)) {
      const a = await getJSON(`answers/${it.id}/${name}`).catch(() => null);
      if (a) answers.push(a);
    }
    const out = [el('div', { class: 'from' }, `From ${it.from.name}`, it.closed_reason ? ` · ${it.closed_reason}` : '')];
    qs.forEach((q, i) => {
      const given = answers.flatMap((a) => (a.answers || (i === 0 ? [{ question: 0, choice: a.choice, text: a.text }] : []))
        .filter((x) => x.question === i && (x.choice || x.text)));
      out.push(el('div', { class: 'hq' },
        qs.length > 1 || q.text !== it.title ? el('div', { class: 'hqt', html: `${qs.length > 1 ? `${i + 1}. ` : ''}${inline(q.text)}` }) : null,
        given.length ? given.map((x) => el('div', { class: 'ha' }, x.choice || '', x.choice && x.text ? ' — ' : '', x.text || ''))
          : el('div', { class: 'ha none' }, 'no answer')));
    });
    answers.filter((a) => (a.answers && a.text) || a.kind === 'answer' && !qs.length && (a.choice || a.text)).forEach((a) => {
      out.push(el('div', { class: 'ha' }, a.choice ? `${a.choice}${a.text ? ' — ' : ''}` : '', a.text || ''));
    });
    out.push(el('div', { class: 'row' }, el('a', { href: `#/item/${it.id}` }, 'Open the full item')));
    out.push(revisitBox(it.id));
    body.replaceChildren(...out);
  }

  function revisitBox(id) {
    return el('details', { class: 'detail revisit', open: draftGet(`item.${id}.revisit`) ? true : null },
      el('summary', {}, 'Revisit with the agent'),
      composer({
        placeholder: 'What should the agent look at again? Only this item is sent to it. Enter sends.',
        enterSends: true,
        draft: `item.${id}.revisit`,
        sendLabel: 'Send',
        onSend: async (text, imgs) => { await send('requests', id, { kind: 'revisit', text }, imgs); },
      }));
  }

  function store(id) {
    const k = `loop.item.${id}`;
    let data = {};
    try { data = JSON.parse(localStorage.getItem(k) || '{}'); } catch (e) { data = {}; }
    return { get: (n) => data[n], set: (n, v) => { data[n] = v; safeSet(k, JSON.stringify(data)); } };
  }

  // The questions of an item: a batch, or one question (older items keep it in title + options).
  function questionsOf(it) {
    if (it.questions && it.questions.length) return it.questions;
    if (it.kind === 'question') return [{ text: it.title, options: it.options || [], blocks: [] }];
    return [];
  }

  // Board order within a tab: the poster's role (LOOP, HIGH, IMPLEMENT, MED, LOW, other), then the index's order
  // (the item's importance, blocking, ...). The sort is stable, so the index's order holds within a role.
  const byRole = (a, b) => H.roleRank({ name: a.from && a.from.name }) - H.roleRank({ name: b.from && b.from.name });
  // Open items in board order, for Next.
  function boardOrder() {
    const order = ['question', 'content', 'pr'];
    return index.items.filter((x) => order.includes(sectionOf(x)))
      .sort((a, b) => order.indexOf(sectionOf(a)) - order.indexOf(sectionOf(b)) || byRole(a, b));
  }
  function nextAfter(id) {
    const list = boardOrder();
    const k = list.findIndex((x) => x.id === id);
    const rest = list.slice(k + 1).concat(list.slice(0, Math.max(k, 0))).filter((x) => x.id !== id);
    return { next: rest[0] || null, pos: k >= 0 ? k + 1 : null, total: list.length };
  }
  function nextLink(id, label) {
    const { next } = nextAfter(id);
    return next ? el('a', { class: 'next', href: `#/item/${next.id}` }, `${label} → ${next.id}`) : null;
  }

  async function showItem(id) {
    const [it] = await Promise.all([getJSON(`items/${id}/item.json`), refreshIndex()]);
    window.LoopRender.setMacros(it.macros);
    const st = store(id);
    const qs = questionsOf(it);
    const single = qs.length === 1 && qs[0].text === it.title;
    const ctx = {
      store: st,
      fileUrl: (name) => fileUrl(`items/${id}/${name}`),
      detailBox: ({ quiz, label }) => detailBox(id, { quiz }, label),
    };
    const { pos, total } = nextAfter(id);
    const row = index.items.find((x) => x.id === id) || {};
    const head = el('header', { class: 'item-head' },
      el('div', { class: 'navrow' }, el('a', { href: '#/list', class: 'back' }, '← Board'),
        el('span', { class: 'grow' }), pos ? el('span', { class: 'pos' }, `${pos} of ${total}`) : null,
        nextLink(id, 'Next')),
      el('div', { class: 'top' }, el('span', { class: 'id' }, it.id), el('span', { class: 'imp' }, it.importance),
        row.blocking_now ? el('span', { class: 'badge block' }, 'blocking') : it.blocking ? el('span', { class: 'badge soon' }, 'soon blocking: the agent needs it before ' + (it.holds_up || 'a later step')) : null,
        qs.length > 1 ? el('span', { class: 'badge' }, `${qs.length} questions`) : null,
        row.stage ? el('span', { class: `badge stage ${row.stage}` }, row.stage === 'in-progress' ? 'in progress' : 'ready') : null,
        (it.versions || 1) > 1 ? el('span', { class: 'badge' }, `version ${it.versions}, updated ${age(it.updated)} ago`) : null,
        el('span', { class: 'badge' }, it.status), el('span', { class: 'grow' }), el('span', { class: 'age' }, age(it.created))),
      el('h2', { html: inline(it.title) }),
      el('div', { class: 'from' }, roleDot(it.from.name), `From ${it.from.name}`, it.source === 'harvested' ? ' (found by the sweep)' : ''),
      it.holds_up ? el('div', { class: 'holds' }, `Holds up: ${it.holds_up}`) : null,
      it.links && it.links.length ? el('div', { class: 'links' }, it.links.map((u) => el('a', { href: u, target: '_blank', rel: 'noopener' }, u.replace(/^https?:\/\//, '')))) : null);
    const body = el('div', { class: 'blocks' });
    window.LoopRender.blocks(body, it.blocks, ctx);
    // Long content: a contents list of its sections, with open all / close all.
    const secs = [...body.querySelectorAll(':scope > details.section')];
    if (secs.length >= 3) {
      secs.forEach((d, k) => { if (!d.id) d.id = `s${k + 1}`; });
      const toggle = el('button', { class: 'link', onclick: () => {
        const open = !secs.every((d) => d.open);
        secs.forEach((d) => { d.open = open; });
        toggle.textContent = open ? 'Close all' : 'Open all';
      } }, secs.every((d) => d.open) ? 'Close all' : 'Open all');
      body.prepend(el('nav', { class: 'toc' },
        el('div', { class: 'row' }, el('b', {}, `Contents · ${secs.length} sections`), toggle),
        el('ol', {}, secs.map((d) => el('li', {}, el('a', { href: '#', onclick: (e) => {
          e.preventDefault();
          d.open = true;
          d.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, html: d.querySelector('.stitle').innerHTML }))))));
    }

    // One card per question: its content, options, answer box, detail box and detail thread.
    const picks = st.get('picks') || {};
    const notes = st.get('notes') || {};
    const threads = [];
    const cards = qs.map((q, i) => {
      const thread = el('div', { class: 'qthread' });
      threads.push(thread);
      const opts = el('div', { class: 'choices' }, (q.options || []).map((o) => {
        const b = el('button', { class: 'choice-btn' + (picks[i] === o.label ? ' on' : ''), onclick: () => {
          picks[i] = picks[i] === o.label ? null : o.label;
          st.set('picks', picks);
          [...opts.children].forEach((c) => c.classList.toggle('on', c === b && !!picks[i]));
        } }, el('b', {}, o.label), o.detail ? el('span', {}, o.detail) : null);
        return b;
      }));
      const note = el('textarea', { rows: 2, class: 'qnote', placeholder: (q.options || []).length ? 'Add to your choice, or answer in your own words' : 'Your answer' });
      note.value = notes[i] || '';
      note.addEventListener('input', () => { notes[i] = note.value; st.set('notes', notes); });
      const qb = el('div', { class: 'qblocks' });
      window.LoopRender.blocks(qb, q.blocks || [], ctx);
      return el('section', { class: 'question' },
        single ? null : el('h3', { class: 'qtitle', html: `<span class="qn">${i + 1}</span> ` + inline(q.text) }),
        qb, isPermission(it) ? null : opts, note, thread,
        detailBox(id, { question: i, open: qs.length === 1 }, qs.length === 1 ? 'More detail before you answer?' : 'More detail on this question'));
    });
    const thread = el('section', { class: 'thread' });
    const answerPanel = el('section', { class: 'answer' });
    const bundlePanel = it.bundle ? el('section', { class: 'bundle' }) : null;
    const redraw = async () => {
      await drawThread(thread, it, ctx, (x) => x.question == null);
      for (let i = 0; i < threads.length; i++) await drawThread(threads[i], it, ctx, (x) => x.question === i);
      const counted = await drawAnswers(answerPanel, it, qs, picks, notes, st);
      if (bundlePanel) drawBundle(bundlePanel, it, st, await bundleGiven(it), body, counted);
    };
    await redraw();
    const generalBox = !['open'].includes(it.status) ? revisitBox(id)
      : qs.length ? null : detailBox(id, {}, 'More detail before you review?');
    const perm = isPermission(it) ? permissionBar(it, async () => { if (refreshItem) await refreshItem(); }) : null;
    main().replaceChildren(head, ...(bundlePanel ? [bundlePanel] : []), body, ...(perm ? [cards[0], perm, ...cards.slice(1)] : cards), thread, generalBox || '', answerPanel);
    requestAnimationFrame(() => window.LoopRender.fitWide(main()));
    let sig = JSON.stringify([it.details, it.forwarded]) + [...tree.paths].filter((p) => p.includes(`/${id}/`)).join();
    const check = async (force) => {
      if (!force) await loadTree();
      const fresh = await getJSON(`items/${id}/item.json`);
      const s = JSON.stringify([fresh.details, fresh.forwarded]) + [...tree.paths].filter((p) => p.includes(`/${id}/`)).join();
      if (force || s !== sig) {
        sig = s;
        Object.assign(it, fresh);
        await redraw();
      }
      schedule();
    };
    // Every 5 s while a detail request waits for its reply, otherwise every 20 s.
    const schedule = () => {
      const waiting = filesIn(`requests/${id}`).some((r) => !(it.details || []).some((d) => d.request === r));
      setPoll(() => check(false), waiting ? 5_000 : 20_000);
    };
    refreshItem = () => check(true);
    schedule();
  }

  // Detail requests (from the reader) and the detail added for each, in time order. keep(x) picks which
  // requests and details belong in this box (by question).
  async function drawThread(box, it, ctx, keep) {
    const reqs = filesIn(`requests/${it.id}`);
    const details = (it.details || []).filter((d) => keep({ question: d.question ?? (d.asked || {}).question ?? null }));
    const byReq = new Map(details.map((d) => [d.request, d]));
    const parts = [];
    for (const name of reqs) {
      const r = await getJSON(`requests/${it.id}/${name}`).catch(() => null);
      if (!r || !keep({ question: r.question ?? null })) continue;
      const d = byReq.get(name);
      byReq.delete(name);
      const ask = el('div', { class: 'ask' },
        el('div', { class: 'who' }, 'You asked', r.quiz != null ? ` (quiz question ${r.quiz + 1})` : '', ` · ${age(r.at)} ago`),
        r.text ? el('div', { html: inline(r.text) }) : null,
        el('div', { class: 'thumbs' }, (r.images || []).map((n) => {
          const img = el('img', { alt: '' });
          fileUrl(`requests/${it.id}/${n}`).then((u) => { img.src = u; });
          return img;
        })));
      const reply = el('div', { class: 'reply' });
      if (d) {
        reply.append(el('div', { class: 'who' }, `Detail added · ${age(d.at)} ago`));
        window.LoopRender.blocks(reply, d.blocks, ctx);
      } else {
        const fwd = (it.forwarded || []).includes(name);
        reply.append(el('div', { class: 'who pending' }, fwd
          ? `LOOP passed this to ${it.from.name}; waiting for the reply… (checking every 5 s)`
          : 'Sent; waiting for LOOP to pick it up… (checking every 5 s)'));
      }
      parts.push(el('div', { class: 'exchange' }, ask, reply));
    }
    for (const d of byReq.values()) {          // detail added without a request
      const reply = el('div', { class: 'reply' }, el('div', { class: 'who' }, `Detail added · ${age(d.at)} ago`));
      window.LoopRender.blocks(reply, d.blocks, ctx);
      parts.push(el('div', { class: 'exchange' }, reply));
    }
    box.replaceChildren(...parts);
  }

  function detailBox(id, where, label) {
    const draft = `item.${id}.detail.${where.quiz != null ? `quiz${where.quiz}` : where.question != null ? `q${where.question}` : 'item'}`;
    return el('details', { class: 'detail', open: (where.open ?? where.quiz == null) || draftGet(draft) ? true : null },
      el('summary', {}, label),
      composer({
        placeholder: 'What do you want to know before answering? Enter sends; Shift+Enter for a new line. Paste or attach images.',
        enterSends: true,
        draft,
        sendLabel: 'Ask',
        onSend: async (text, imgs) => {
          await send('requests', id, { kind: 'detail', quiz: where.quiz ?? null, question: where.question ?? null, text }, imgs);
          if (refreshItem) await refreshItem();
        },
      }));
  }

  // ------------------------------------------------------------ PR-review bundles: a verdict per PR

  const prKey = (p) => `${p.repo}#${p.pr}`;
  // Each bundled PR's latest verdict over the answers sent: {key: {verdict, text, at}}.
  async function bundleGiven(it) {
    const out = {};
    for (const name of filesIn(`answers/${it.id}`)) {
      const a = await getJSON(`answers/${it.id}/${name}`).catch(() => null);
      for (const r of (a && a.prs) || []) if (r.verdict) out[prKey(r)] = { verdict: r.verdict, text: r.text || '', at: a.at };
    }
    return out;
  }

  // The rows at the top of a bundle: each PR's class, why, the verdict sent, Approve / Changes with a note,
  // and a link down to the section that reviews it. Verdicts chosen and not yet sent are kept in the item's
  // store ('prs') until "Send review" sends them. after() updates the answer panel's count.
  function drawBundle(box, it, st, given, body, after) {
    const pend = st.get('prs') || {};
    const save = () => { st.set('prs', pend); after(); };
    const prs = it.bundle.prs || [];
    const lows = prs.filter((p) => p.class === 'low' && !given[prKey(p)]);
    const rows = prs.map((p) => {
      const k = prKey(p), g = given[k], cur = pend[k] || {};
      const note = el('textarea', { rows: 1, class: 'qnote', placeholder: 'Note (what to change)' });
      note.value = cur.text || '';
      note.addEventListener('input', () => { pend[k] = { ...(pend[k] || {}), text: note.value }; st.set('prs', pend); });
      const btn = (v, label) => el('button', { class: `choice-btn v-${v}` + (cur.verdict === v ? ' on' : '') + (g && g.verdict === v ? ' sent' : ''), onclick: () => {
        pend[k] = { ...(pend[k] || {}), verdict: (pend[k] || {}).verdict === v ? null : v };
        save();
        drawBundle(box, it, st, given, body, after);
      } }, el('b', {}, label));
      const sec = p.review_section ? body.querySelector(`details.section[id="${CSS.escape(p.review_section)}"]`) : null;
      return el('div', { class: `bpr cls-${p.class}`, 'data-pr': k },
        el('div', { class: 'brow' }, el('span', { class: `badge cls ${p.class}` }, p.class),
          el('a', { href: p.url, target: '_blank', rel: 'noopener' }, el('b', {}, `${p.repo} #${p.pr}`)),
          el('span', { class: 'grow' }),
          sec ? el('a', { href: '#', class: 'bsec', onclick: (e) => {
            e.preventDefault();
            sec.open = true;
            sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
          } }, 'Review ↓') : null),
        el('div', { class: 'bwhy', html: inline(p.why || '') }),
        g ? el('div', { class: `bgiven ${g.verdict}` }, `You sent: ${g.verdict === 'approve' ? 'approve' : 'changes'}`,
          g.text ? ` — ${g.text}` : '', g.at ? ` · ${age(g.at)} ago` : '') : null,
        el('div', { class: 'choices bverdict' }, btn('approve', 'Approve'), btn('changes', 'Changes')),
        note);
    });
    const done = prs.filter((p) => given[prKey(p)]).length;
    box.replaceChildren(
      el('div', { class: 'brow' }, el('h3', {}, `Bundle ${it.bundle.title || it.bundle.id}`),
        el('span', { class: 'n' }, ` ${done} of ${prs.length} with your verdict`), el('span', { class: 'grow' }),
        lows.length ? el('button', { class: 'ghost bapprove-low', onclick: () => {
          lows.forEach((p) => { pend[prKey(p)] = { ...(pend[prKey(p)] || {}), verdict: 'approve' }; });
          save();
          drawBundle(box, it, st, given, body, after);
        } }, `Approve all low (${lows.length})`) : null),
      ...rows);
    after();
  }

  // Returns a function that updates the line over the send button (a bundle's count of verdicts chosen).
  async function drawAnswers(box, it, qs, picks, notes, st) {
    const prev = filesIn(`answers/${it.id}`);
    const shown = [];
    for (const name of prev) {
      const a = await getJSON(`answers/${it.id}/${name}`).catch(() => null);
      if (!a) continue;
      const rows = (a.answers || []).filter((x) => x.choice || x.text).map((x) => el('div', { class: 'choice' },
        qs.length > 1 ? `${x.question + 1}. ` : '', x.choice || '', x.choice && x.text ? ' — ' : '', x.text || ''));
      shown.push(el('div', { class: 'given' }, el('div', { class: 'who' }, `Your answer · ${age(a.at)} ago`),
        ...rows, ...(a.prs || []).map((r) => el('div', { class: 'choice' }, `${r.repo} #${r.pr}: ${r.verdict}`, r.text ? ` — ${r.text}` : '')),
        a.choice ? el('div', { class: 'choice' }, a.choice) : null,
        a.text ? el('div', { html: inline(a.text) }) : null,
        el('div', { class: 'thumbs' }, (a.images || []).map((n) => {
          const img = el('img', { alt: '' });
          fileUrl(`answers/${it.id}/${n}`).then((u) => { img.src = u; });
          return img;
        }))));
    }
    const done = el('div', { class: 'status' });
    let counted = () => {};
    let reviewChoice = null;
    let extra = null;
    if (it.bundle) {
      const pend = () => Object.entries(st.get('prs') || {}).filter(([, v]) => v && v.verdict);
      counted = () => {
        const n = pend().length;
        done.textContent = n ? `${n} verdict${n > 1 ? 's' : ''} chosen above, sent with your review.` : 'Choose Approve or Changes for each PR above.';
      };
      counted();
      extra = { el: done, value: () => pend().length > 0, ready: () => true };
    } else if (it.kind === 'review') {
      const labels = it.category === 'content' ? ['Understood', 'Have questions (in the comments)', 'Not now']
        : ['Reviewed: fine', 'Needs changes', 'Not now'];
      const opts = el('div', { class: 'choices' }, labels.map((label) => {
        const b = el('button', { class: 'choice-btn', onclick: () => {
          reviewChoice = reviewChoice === label ? null : label;
          [...opts.children].forEach((c) => c.classList.toggle('on', c === b && !!reviewChoice));
        } }, el('b', {}, label));
        return b;
      }));
      extra = { el: opts, value: () => reviewChoice, ready: () => true };
    } else {
      const count = () => qs.filter((q, i) => picks[i] || (notes[i] || '').trim()).length;
      extra = { el: done, value: () => count() > 0, ready: () => true };
      done.textContent = qs.length > 1 ? 'Answer each question above, then send them together.' : '';
    }
    const sent = el('div', { class: 'after' });
    if (justSent === it.id) {
      sent.append(el('span', {}, 'Sent. '), nextLink(it.id, 'Next item') || el('a', { href: '#/list' }, 'Back to the board'));
    }
    const comp = composer({
      placeholder: it.kind === 'review' ? 'Comments for the agent (optional). Images welcome.'
        : qs.length > 1 ? 'Anything for all the questions (optional). Images welcome.' : 'Anything else (optional). Images welcome.',
      enterSends: false,
      draft: `item.${it.id}.answer`,
      sendLabel: it.kind === 'review' ? 'Send review' : prev.length ? 'Send follow-up' : qs.length > 1 ? 'Send answers' : 'Send answer',
      extra,
      onSend: async (text, imgs) => {
        const body = { kind: 'answer', text };
        if (it.bundle) {
          const pend = st.get('prs') || {};
          body.prs = (it.bundle.prs || []).filter((p) => pend[prKey(p)] && pend[prKey(p)].verdict)
            .map((p) => ({ repo: p.repo, pr: p.pr, verdict: pend[prKey(p)].verdict, text: (pend[prKey(p)].text || '').trim() }));
        } else if (it.kind === 'review') body.choice = reviewChoice;
        else {
          // Only the questions answered get a row; text typed only in the general box answers a one-question item.
          const rows = qs.map((q, i) => ({ question: i, asked: q.text, choice: picks[i] || null, text: (notes[i] || '').trim() }))
            .filter((r) => r.choice || r.text);
          if (!rows.length && qs.length === 1 && (text || '').trim()) rows.push({ question: 0, asked: qs[0].text, choice: null, text: text.trim() });
          if (rows.length) body.answers = rows;
          if (qs.length === 1) body.choice = picks[0] || null;
        }
        await send('answers', it.id, body, imgs);
        if (it.bundle) st.set('prs', {});
        else if (it.kind !== 'review') {          // sent: the questions' drafts (notes and picks) start empty again
          qs.forEach((q, i) => { delete notes[i]; delete picks[i]; });
          st.set('notes', notes);
          st.set('picks', picks);
          document.querySelectorAll('#main .question .qnote').forEach((n) => { n.value = ''; });
          document.querySelectorAll('#main .question .choice-btn.on').forEach((b) => b.classList.remove('on'));
        }
        justSent = it.id;
        if (refreshItem) await refreshItem();
      },
    });
    box.replaceChildren(el('h3', {}, it.kind === 'review' ? 'Your review' : qs.length > 1 ? 'Send your answers' : 'Your answer'), ...shown, comp, sent);
    return counted;
  }

  // ------------------------------------------------------------ Status: usage and each agent's state

  function bar(pct) {
    const level = pct >= 90 ? 'hi' : pct >= 70 ? 'mid' : 'lo';
    return el('div', { class: 'ubar' }, el('div', { class: `ufill ${level}`, style: `width:${Math.min(100, pct)}%` }));
  }

  // PR-review bundles: per triage class, how often the reviewer's predicted verdict matched yours (your first
  // verdict on each PR), from the shadow log's summary (state/pr_triage.json, written by `loop`).
  function triageCard(t) {
    const cls = Object.entries((t && t.classes) || {});
    if (!cls.length) return '';
    const pct = (x) => (x == null ? '–' : `${Math.round(x * 100)}%`);
    return el('section', { class: 'status-card triage' }, el('h3', {}, 'Triage accuracy'),
      el('table', { class: 'ttable' },
        el('thead', {}, el('tr', {}, ['Class', 'PRs', 'Answered', 'Changes asked', 'Prediction right'].map((h) => el('th', {}, h)))),
        el('tbody', {}, cls.map(([name, c]) => el('tr', { 'data-class': name },
          el('td', {}, el('span', { class: `badge cls ${name}` }, name)), el('td', {}, String(c.reviews)),
          el('td', {}, String(c.answered)), el('td', {}, String(c.change_requests)),
          el('td', {}, `${pct(c.agreement)}${c.answered ? ` (${c.agreed}/${c.answered})` : ''}`))))),
      el('div', { class: 'who' }, 'The reviewer predicts each bundled PR\'s verdict before you answer; nothing is accepted for you.'));
  }

  // "Message <agent>": typed into its session by the loop. Used on Status and in the Tree tab (an anthome's info).
  // Its draft is keyed by the agent's name, so one half-written message shows in both places.
  function messageBox(r, open) {
    return el('details', { class: 'detail amsg', 'data-agent': r.name, open: open || draftGet(`agent.${r.name}.message`) ? true : null },
      el('summary', {}, `Message ${r.name}`),
      composer({
        placeholder: 'Guide this agent. It is typed into its session within seconds (or restarts it). Images welcome.',
        enterSends: false,
        sendLabel: 'Send',
        urgent: true,
        draft: `agent.${r.name}.message`,
        onSend: async (text, imgs, o) => { await send('messages', r.job, { kind: 'message', to: r.name, text, ...(o.urgent ? { urgent: true } : {}) }, imgs); },
      }));
  }

  async function showStatus() {
    await useTree();
    const [st, plog, triage] = await Promise.all([getJSON('state/status.json'),
      tree.paths.has('state/permissions.json') ? getJSON('state/permissions.json').catch(() => null) : null,
      tree.paths.has('state/pr_triage.json') ? getJSON('state/pr_triage.json').catch(() => null) : null,
      index.items.length ? null : refreshIndex()]);
    lastStatus = st;
    const titles = new Map(index.items.map((x) => [x.id, x.title]));
    const u = st.usage || {};
    const usage = el('section', { class: 'status-card' }, el('h3', {}, 'Claude usage'),
      ...(u.limits || []).map((l) => el('div', { class: 'ulimit' },
        el('div', { class: 'urow' }, el('b', {}, l.name), el('span', { class: 'grow' }), el('span', {}, `${l.pct}%`)),
        bar(l.pct), el('div', { class: 'who' }, `resets ${l.resets}`))),
      (u.tips || []).length ? el('details', { class: 'utips' }, el('summary', {}, 'What uses it'),
        el('ul', {}, u.tips.map((t) => el('li', {}, el('b', {}, `${t.pct}% `), t.text, el('span', { class: 'who' }, ` · ${t.period}`))))) : null,
      el('div', { class: 'who' }, `measured ${u.at ? age(u.at) + ' ago' : 'never'}`));
    const groups = { blocked: [], working: [], stalled: [] };
    (st.agents || []).forEach((r) => (groups[r.state] || groups.stalled).push(r));
    Object.values(groups).forEach((g) => g.sort((a, b) => H.roleRank(a) - H.roleRank(b)));   // LOOP, HIGH, IMPLEMENT, MED, LOW, other
    const label = { blocked: 'Blocked', working: 'Working', stalled: 'Stalled' };
    const sections = Object.keys(groups).map((k) => el('section', { class: 'status-card' },
      el('h3', {}, `${label[k]} `, el('span', { class: 'n' }, String(groups[k].length))),
      groups[k].length ? groups[k].map((r) => el('div', { class: `agent ${r.state}` },
        el('div', { class: 'arow' },
          el('span', { class: `dot ${r.running ? 'on' : 'off'}`, title: r.running ? 'running' : 'not running' }),
          roleDot(r.name), el('b', {}, r.name), r.loop ? el('span', { class: 'badge' }, 'LOOP') : null,
          el('span', { class: 'grow' }),
          r.context_tokens ? el('span', { class: 'who' }, `${Math.round(r.context_tokens / 1000)}k ctx`) : null,
          r.model ? el('span', { class: 'who' }, ` · ${r.model}`) : null),
        r.items && r.items.length ? el('div', { class: 'alinks' }, r.state === 'blocked' ? 'Waiting on: ' : 'Will need (soon blocking): ', r.items.map((id) =>
          el('a', { href: `#/item/${id}`, class: 'alink' }, el('b', {}, id), titles.has(id) ? ` ${titles.get(id).slice(0, 70)}` : ''))) : null,
        r.why && !(r.items && r.items.length) ? el('div', { class: 'awhy' }, r.why) : null,
        r.permission ? el('a', { href: '#/permission', class: 'alink permlink' }, 'Approve or deny it in Permission →') : null,
        r.working_on ? el('div', { class: 'adetail' }, el('span', { class: 'who' }, r.state === 'working' ? 'Working on: ' : 'Last: '), r.working_on) : null,
        el('div', { class: 'who' }, r.running ? '' : 'not running · ', r.updated ? `last active ${age(r.updated)} ago` : ''),
        (r.recent || []).length ? el('details', { class: 'arecent' }, el('summary', {}, `Its entries (${r.recent.length})`),
          el('div', { class: 'alinks' }, r.recent.map((x) => el('a', { href: `#/item/${x.id}`, class: 'alink' + (x.blocking_now ? ' blocking' : '') },
            el('b', {}, x.id), ` ${x.title.slice(0, 70)} `,
            el('span', { class: 'who' }, `${{ question: 'question', content: 'content', pr: 'review' }[x.tab] || x.tab}${['answered', 'closed'].includes(x.status) ? ' · ' + x.status : ''}`))))) : null,
        messageBox(r)))
        : el('p', { class: 'empty' }, 'None.')));
    await loadMine().catch(() => {});
    main().replaceChildren(deadlinesCard(), usage, ...sections, permissionsCard(plog), triageCard(triage),
      el('p', { class: 'foot' }, `Updated ${new Date(st.generated).toLocaleString()} · refreshed every 2 min by the loop`));
    setPoll(async () => { await loadTree(); if (location.hash.startsWith('#/status')) await showStatus(); }, 60_000);
  }

  // Permission: every session waiting on an approval. Hook prompts are `permission` items (Approve/Deny typed into
  // the dialog); a usage-guard denial (status row permission.kind 'guard') is approved by sending the session
  // "approve", which the guard counts as the approval, and the session retries the call; other dialogs are
  // answered in the session.
  function guardCard(r) {
    const p = r.permission;
    const msg = el('div', { class: 'status' });
    const pick = (text, done) => async () => {
      [...btns.children].forEach((b) => { b.disabled = true; });
      msg.textContent = 'Sending…';
      try {
        await send('messages', r.job, { kind: 'message', to: r.name, text, urgent: true }, []);
        msg.textContent = `${done}: sent to ${r.name}, typed into its session within seconds.`;
      } catch (e) {
        msg.textContent = `Not sent: ${e.message || e}`;
        [...btns.children].forEach((b) => { b.disabled = false; });
      }
    };
    const btns = el('div', { class: 'permbtns' },
      el('button', { class: 'perm-yes', onclick: pick('approve', 'Approved') }, 'Approve'),
      el('button', { class: 'perm-no', onclick: pick(`deny: do not run that ${p.tool} call; go on without it, or ask in LOOP.`, 'Denied') }, 'Deny'));
    return el('section', { class: 'status-card permwait', 'data-agent': r.name },
      el('div', { class: 'arow' }, el('span', { class: 'badge perm' }, 'usage guard'), roleDot(r.name), el('b', {}, r.name),
        el('span', { class: 'who' }, ` · ${p.tool}`), el('span', { class: 'grow' }), el('span', { class: 'who' }, p.since ? `waiting ${age(p.since)}` : '')),
      el('code', { class: 'ptarget' }, p.target.length > 600 ? p.target.slice(0, 600) + '…' : p.target),
      el('div', { class: 'awhy' }, p.why), btns, msg);
  }

  async function showPermission() {
    await useTree();
    const [st] = await Promise.all([getJSON('state/status.json'), refreshIndex()]);
    const asks = await Promise.all(index.items.filter((x) => isPermission(x) && x.status === 'open')
      .map((x) => getJSON(`items/${x.id}/item.json`).catch(() => null)));
    const items = asks.filter(Boolean);
    const rows = (st.agents || []).filter((r) => r.permission);
    const asked = (r) => items.some((it) => it.from.job === r.job || it.from.name === r.name);
    const dialogs = rows.filter((r) => r.permission.kind === 'dialog' && !asked(r));
    const guards = rows.filter((r) => r.permission.kind === 'guard');
    const itemCard = (it) => el('section', { class: 'status-card permwait', 'data-item': it.id },
      el('div', { class: 'arow' }, el('span', { class: 'badge perm' }, 'prompt'), roleDot(it.from.name), el('b', {}, it.from.name),
        el('span', { class: 'who' }, ` · ${it.permission.tool}`), el('span', { class: 'grow' }), el('span', { class: 'who' }, `waiting ${age(it.created)}`)),
      el('code', { class: 'ptarget' }, it.permission.target),
      el('div', { class: 'awhy' }, `Flagged because: ${it.permission.reason}`, el('a', { href: `#/item/${it.id}`, class: 'alink' }, ` ${it.id}`)),
      permissionBar(it, showPermission));
    const dialogCard = (r) => el('section', { class: 'status-card permwait', 'data-agent': r.name },
      el('div', { class: 'arow' }, el('span', { class: 'badge perm' }, 'dialog'), roleDot(r.name), el('b', {}, r.name),
        el('span', { class: 'grow' }), el('span', { class: 'who' }, r.updated ? `waiting ${age(r.updated)}` : '')),
      el('div', { class: 'awhy' }, 'At a permission prompt the loop did not post: answer it in the session.'));
    const cards = [...items.map(itemCard), ...guards.map(guardCard), ...dialogs.map(dialogCard)];
    main().replaceChildren(el('h2', { class: 'permh' }, 'Waiting for permission ', el('span', { class: 'n' }, String(cards.length))),
      ...(cards.length ? cards : [el('p', { class: 'empty' }, 'No session is waiting for an approval.')]),
      el('p', { class: 'foot' }, `Status updated ${new Date(st.generated).toLocaleString()}`));
    setPoll(async () => { await loadTree(); if (location.hash.startsWith('#/permission')) await showPermission(); }, 60_000);
  }

  // ------------------------------------------------------------ Manual: Read, Write, Students, Other
  // Finbar's own entries: personal/<id>/entry.json plus the files dropped with it. The app writes them;
  // loop-cron saves papers to Zotero and writes personal/<id>/zotero.json.

  const MINE_TABS = [['read', 'Read'], ['write', 'Write'], ['student', 'Students'], ['other', 'Other']];
  const PRIOS = [['high', 'High'], ['med', 'Medium'], ['low', 'Low']];
  let mine = { entries: [], deleting: [], zotero: {}, people: [], collections: [] };
  let mineLoaded = false;
  // personal/tree.json ({seed, creatures: {<write entry id>: {name, animal}}}) and state/citations.json.
  let growthDocs = { tree: {}, cites: {} };

  const safeName = (n) => n.replace(/[^\w.\-]+/g, '_').slice(-80) || 'file';
  const today = () => new Date(new Date().toDateString());
  function dueInfo(d) {
    if (!d) return null;
    const days = Math.round((new Date(d + 'T00:00:00') - today()) / 864e5);
    const when = new Date(d + 'T00:00:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
    const rel = days < 0 ? `${-days} d overdue` : days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} d`;
    return { days, text: `Due ${when} (${rel})`, level: days < 0 ? 'over' : days <= 3 ? 'soon' : 'later' };
  }

  async function loadMine() {
    await useTree();
    const ids = [...tree.paths].filter((p) => /^personal\/[^/]+\/entry\.json$/.test(p)).map((p) => p.split('/')[1]);
    const [entries, people, cols, treeDoc, cites] = await Promise.all([
      Promise.all(ids.map((id) => getJSON(`personal/${id}/entry.json`).catch(() => null))),
      getJSON('state/people.json').catch(() => ({ students: [] })),
      getJSON('state/zotero_collections.json').catch(() => ({ collections: [] })),
      tree.paths.has('personal/tree.json') ? getJSON('personal/tree.json').catch(() => ({})) : {},
      tree.paths.has('state/citations.json') ? getJSON('state/citations.json').catch(() => ({})) : {},
    ]);
    growthDocs = { tree: treeDoc || {}, cites: cites || {} };
    mineLoaded = true;
    const zot = {};
    await Promise.all(ids.filter((id) => tree.paths.has(`personal/${id}/zotero.json`)).map(async (id) => {
      zot[id] = await getJSON(`personal/${id}/zotero.json`).catch(() => null);
    }));
    // Entries with a delete asked for (delete_requests/<id>.json) are left out everywhere, tree included, and listed
    // as "Deleting" until the loop has removed them; <id>.waiting says why it waits.
    const asked = {};
    await Promise.all(ids.filter((id) => tree.paths.has(`delete_requests/${id}.json`)).map(async (id) => {
      const w = `delete_requests/${id}.waiting`;
      asked[id] = tree.paths.has(w) ? ((await getJSON(w).catch(() => null)) || {}).why || '' : '';
    }));
    const all = entries.filter(Boolean);
    mine = { entries: all.filter((e) => !(e.id in asked)), deleting: all.filter((e) => e.id in asked).map((e) => ({ e, why: asked[e.id] })),
      zotero: zot, people: people.students || [], collections: cols.collections || [] };
    return mine;
  }

  async function saveEntry(e, message) {
    e.updated = new Date().toISOString();
    await put(`personal/${e.id}/entry.json`, new TextEncoder().encode(JSON.stringify(e, null, 1)), message || `${e.id}: update`);
  }

  async function createEntry(kind, fields, files) {
    const id = `${kind}-${stamp()}`;
    const names = [];
    for (const f of files || []) {
      const name = safeName(f.name);
      await put(`personal/${id}/${name}`, new Uint8Array(await f.arrayBuffer()), `${id}: ${name}`);
      names.push(name);
    }
    const e = { id, kind, priority: 'med', deadline: null, done: false, created: new Date().toISOString(), files: names, ...fields };
    await saveEntry(e, `${id}: new ${kind}`);
    return e;
  }

  // Drop zone: drag files onto it, or tap to pick (the phone's file picker).
  function dropZone(label, onFiles, accept) {
    const pick = el('input', { type: 'file', multiple: true, hidden: true, accept: accept || null });
    const zone = el('div', { class: 'dropzone', tabindex: 0, onclick: () => pick.click() }, el('span', {}, label), pick);
    pick.addEventListener('change', () => { if (pick.files.length) onFiles([...pick.files]); pick.value = ''; });
    zone.addEventListener('dragover', (ev) => { ev.preventDefault(); zone.classList.add('drag'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
    zone.addEventListener('drop', (ev) => { ev.preventDefault(); zone.classList.remove('drag'); if (ev.dataTransfer.files.length) onFiles([...ev.dataTransfer.files]); });
    return zone;
  }

  function deadlineChip(e, redraw) {
    const info = dueInfo(e.deadline);
    const input = el('input', { type: 'date', value: e.deadline || '', class: 'datein' });
    const chip = el('button', { class: 'due ' + (info ? info.level : 'none'), onclick: (ev) => {
      ev.stopPropagation(); chip.replaceWith(input); input.focus(); try { input.showPicker(); } catch (x) { /* older browsers */ }
    } }, info ? info.text : '+ deadline');
    input.addEventListener('change', async () => { e.deadline = input.value || null; await saveEntry(e, `${e.id}: deadline`); redraw(); });
    input.addEventListener('blur', () => setTimeout(() => { if (input.isConnected && (input.value || null) === (e.deadline || null)) redraw(); }, 200));
    return chip;
  }

  // The line under a saved paper's heading (its key title, authorYEARFirstWord, set by the loop from the record):
  // "journal · full title", either part left out when missing, the title when it is the heading already. null if empty.
  function paperSub(e) {
    const full = e.full_title && e.full_title !== e.title ? e.full_title : null;
    const parts = [e.journal, full].filter(Boolean);
    return parts.length ? el('div', { class: 'msub' }, parts.join(' · ')) : null;
  }

  // A file link opens the file in the tap itself, since browsers only open windows (and share sheets) from a tap.
  // In a browser tab: a blank tab opens at once and goes to the file when it has loaded. In the installed app
  // (standalone, which can't show blob: URLs): the share sheet, with the file, so it opens in a PDF viewer; if
  // the file was still loading, the link says "tap again to open" and the next tap shares it.
  const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  function shareFile(f, a) {
    if (navigator.canShare && navigator.canShare({ files: [f.file] })) {
      navigator.share({ files: [f.file], title: f.file.name }).catch(() => {});
    } else {
      const d = el('a', { href: f.url, download: f.file.name });
      document.body.append(d);
      d.click();
      d.remove();
    }
    a.textContent = f.file.name;
    a.classList.remove('loading', 'ready');
  }
  function fileLinks(e) {
    return (e.files || []).map((n) => {
      const p = `personal/${e.id}/${n}`;
      const a = el('a', { href: '#', class: 'flink', onpointerdown: () => { fileBlob(p).catch(() => {}); }, onclick: async (ev) => {
        ev.preventDefault();
        const ready = blobReady.get(p);
        if (ready && standalone()) return shareFile(ready, a);
        if (ready) return void window.open(ready.url, '_blank');
        const w = standalone() ? null : window.open('', '_blank');
        a.classList.add('loading');
        a.textContent = `${n} (loading…)`;
        let f;
        try {
          f = await fileBlob(p);
        } catch {
          blobCache.delete(p);
          if (w) w.close();
          a.classList.remove('loading');
          a.textContent = `${n} (couldn't load: tap to retry)`;
          return;
        }
        a.classList.remove('loading');
        if (w) {
          w.location.href = f.url;
          a.textContent = n;
        } else if (standalone() && !(navigator.userActivation && !navigator.userActivation.isActive)) {
          shareFile(f, a);
        } else {
          a.classList.add('ready');
          a.textContent = `${n}: tap again to open`;
        }
      } }, n);
      return a;
    });
  }

  // `done_at` dates the tick for the growth tree. A Read entry needs a note before it is ticked done: ticking
  // it without one opens its Notes and asks for one instead.
  function entryRow(e, redraw, extra) {
    const pex = e.kind === 'read' ? paperExtras(e) : null;
    const done = el('input', { type: 'checkbox', title: 'done', onchange: async () => {
      if (done.checked && pex && !(await pex.hasNote())) {
        done.checked = false;
        pex.askNote();
        return;
      }
      e.done = done.checked;
      e.done_at = e.done ? new Date().toISOString() : null;
      await saveEntry(e, `${e.id}: ${e.done ? 'done' : 'not done'}`);
      redraw();
    } });
    done.checked = !!e.done;
    const prio = el('select', { class: 'prio', title: 'priority', onchange: async () => { e.priority = prio.value; await saveEntry(e, `${e.id}: priority`); redraw(); } },
      PRIOS.map(([k, l]) => el('option', { value: k, selected: e.priority === k ? true : null }, l)));
    const z = mine.zotero[e.id];
    const zb = e.kind === 'read' && e.zotero ? el('span', { class: `badge z ${z ? z.status : 'waiting'}`, title: (z && z.why) || '' },
      z && z.status === 'saved' ? `in Zotero: ${e.zotero.name || ''}` : z && z.status === 'error' ? 'Zotero: error' : `to Zotero: ${e.zotero.name || ''} (waiting)`) : null;
    const plibs = e.kind === 'read' && z && z.status === 'saved' && z.key ? paperLibs(e, z, redraw) : null;
    const isWrite = e.kind === 'write';
    return el('div', { class: 'mrow' + (e.done ? ' done' : '') },
      isWrite ? null : el('label', { class: 'mcheck' }, done),
      el('div', { class: 'mmain' },
        el('div', { class: 'mtitle' }, e.link ? el('a', { href: e.link, target: '_blank', rel: 'noopener' }, e.title || e.link) : (e.title || (e.files || [])[0] || 'note')),
        paperSub(e),
        e.title_warning ? el('div', { class: 'mwarn', title: 'The loop found no author and year for this paper; the summary or a later lookup fixes it.' }, `⚠ ${e.title_warning}`) : null,
        e.note ? el('div', { class: 'mnote', html: inline(e.note) }) : null,
        isWrite ? writeStates(e, redraw) : null,
        el('div', { class: 'mmeta' }, ...fileLinks(e), zb, ...(plibs ? plibs.chips : []), plibs ? plibs.button : null, extra || null, deadlineChip(e, redraw), prio,
          e.kind === 'read' || isWrite ? deleteButton(e, z, redraw) : null),
        plibs ? plibs.picker : null,
        pex ? pex.el : null));
  }

  // Delete (Read and Write entries), after a confirm step: writes delete_requests/<id>.json. The loop moves a saved
  // paper's Zotero item to Zotero's trash (it can be restored there), removes the entry with its PDF, notes, summary
  // and its branch or animal on the tree, and logs the delete.
  function deleteButton(e, z, redraw) {
    const box = el('span', { class: 'mdel' });
    const ask = el('button', { class: 'ghost mdelbtn', onclick: () => box.replaceChildren(confirm) }, 'Delete');
    const what = e.kind === 'read'
      ? `Delete this paper, its PDF, notes and summary?${z && z.status === 'saved' ? " Its Zotero item goes to Zotero's trash, where you can restore it." : ''}`
      : `Delete this writing entry?${e.submitted ? ' Its animal leaves the tree.' : ''}`;
    const yes = el('button', { class: 'mdelyes', onclick: async () => {
      yes.disabled = true;
      await put(`delete_requests/${e.id}.json`, new TextEncoder().encode(JSON.stringify({ entry: e.id, kind: e.kind, title: e.title || '', at: new Date().toISOString() })),
        `${e.id}: delete`);
      redraw();
    } }, 'Delete');
    const confirm = el('span', { class: 'mdelask' }, el('span', {}, what), yes,
      el('button', { class: 'ghost', onclick: () => box.replaceChildren(ask) }, 'Cancel'));
    box.append(ask);
    return box;
  }

  // "Add to paper lib": a paper saved to Zotero (its item key known) can be put in paper libraries, the Zotero
  // collections under _work / papers and _work / my_papers, and taken out of them. The picker ticks the ones it
  // is in (zotero.json work, read from Zotero by the loop). Saving writes zotero_requests/<t>.json {kind: work,
  // entry, add, remove, new}; the loop changes the item's collections in one PATCH, so the paper keeps its topic
  // collection and is not copied. A new library is made as _work / papers / <lower_snake_case>.
  const LIB_ROOTS = ['_work / papers / ', '_work / my_papers / '];
  const isLib = (c) => LIB_ROOTS.some((r) => c.name.startsWith(r));
  const snake = (t) => t.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  function paperLibs(e, z, redraw) {
    const byKey = new Map(mine.collections.map((c) => [c.key, c]));
    const work = z.work || [];
    const chips = work.filter((k) => byKey.has(k)).map((k) => el('span', { class: 'badge plib', title: byKey.get(k).name },
      byKey.get(k).name.replace(/^_work \/ /, '').replace(/ \/ /g, '/')));
    const picker = el('div', { class: 'plibpick', hidden: true });
    const st = el('div', { class: 'status' });
    const newNames = [];
    const ticked = new Set(work);              // kept across redraws of the picker
    const draw = () => {
      const libs = mine.collections.filter(isLib).sort((x, y) => x.name.toLowerCase().localeCompare(y.name.toLowerCase()));
      const boxes = libs.map((c) => {
        const b = el('input', { type: 'checkbox', value: c.key, onchange: () => { if (b.checked) ticked.add(c.key); else ticked.delete(c.key); } });
        b.checked = ticked.has(c.key);
        return el('label', { class: 'plibopt' }, b, c.name.replace(/^_work \/ /, ''));
      });
      const news = newNames.map((n) => el('label', { class: 'plibopt new' }, el('input', { type: 'checkbox', checked: true, disabled: true }), `papers / ${n} (new)`));
      const name = el('input', { type: 'text', placeholder: 'New paper lib name' });
      const addNew = () => {
        const n = snake(name.value);
        if (!n) { st.textContent = 'Give it a name.'; return; }
        if (libs.some((c) => c.name === `_work / papers / ${n}`) || newNames.includes(n)) { st.textContent = `papers / ${n} exists already: tick it.`; return; }
        newNames.push(n);
        st.textContent = '';
        draw();
      };
      name.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); addNew(); } });
      const save = el('button', { class: 'primary', onclick: async () => {
        const req = { kind: 'work', entry: e.id, add: [...ticked].filter((k) => !work.includes(k)),
          remove: work.filter((k) => byKey.has(k) && isLib(byKey.get(k)) && !ticked.has(k)), new: [...newNames] };
        if (!req.add.length && !req.remove.length && !req.new.length) { st.textContent = 'Nothing changed.'; return; }
        const id = stamp();
        save.disabled = true;
        try {
          await put(`zotero_requests/${id}.json`, new TextEncoder().encode(JSON.stringify(req)), `${e.id}: paper libraries`);
        } catch (err) { st.textContent = `Not saved: ${err.message}`; save.disabled = false; return; }
        st.textContent = 'Zotero is updated within about a minute (by the scheduled script)…';
        const t0 = Date.now();
        const timer = setInterval(async () => {
          if (Date.now() - t0 > 600_000) { clearInterval(timer); st.textContent = 'Still waiting for the scheduled script: check back later.'; return; }
          const res = await getJSON(`zotero_requests/${id}.result.json`, { fresh: true }).catch(() => null);
          if (!res) return;
          clearInterval(timer);
          if (res.status !== 'done') { st.textContent = `Zotero not changed: ${res.why || res.status}`; save.disabled = false; return; }
          tree.stale = true;                       // the loop wrote zotero.json work with the result
          redraw();
        }, 5000);
      } }, 'Save');
      picker.replaceChildren(
        el('div', { class: 'who' }, 'Paper libraries (Zotero _work collections). The paper stays in its topic collection.'),
        libs.length || news.length ? el('div', { class: 'plibopts' }, ...boxes, ...news) : el('p', { class: 'empty' }, 'No paper libraries in Zotero yet: make one below.'),
        el('div', { class: 'row' }, name, el('button', { class: 'ghost', onclick: addNew }, 'New paper lib…'), el('span', { class: 'grow' }), save),
        st);
    };
    const button = el('button', { class: 'ghost plibbtn', onclick: () => {
      picker.hidden = !picker.hidden;
      if (!picker.hidden) draw();
    } }, 'Add to paper lib');
    return { chips, button, picker };
  }

  // A Write entry's states (Q-0027), in place of one done tick: a draft version (▲ steps v1, v2, …), submitted
  // (the tree's animal arrives) and published (also done, so it moves to Done), and its DOI. The loop looks up
  // citations once it is published or has a DOI.
  function writeStates(e, redraw) {
    const now = () => new Date().toISOString();
    const save = async (what) => { await saveEntry(e, `${e.id}: ${what}`); redraw(); };
    const box = (label, checked, onchange, title) => {
      const c = el('input', { type: 'checkbox', title: title || label });
      c.checked = !!checked;
      c.addEventListener('change', () => onchange(c.checked));
      return el('label', { class: 'wstate' }, c, label);
    };
    const draft = box('Draft', e.draft, (on) => { e.draft = on ? (e.draft || 1) : null; save(on ? `draft v${e.draft}` : 'no draft'); }, 'a draft exists');
    const ver = el('span', { class: 'wver' }, e.draft ? `v${e.draft}` : '');
    const up = el('button', { class: 'ghost wup', title: 'next draft version', onclick: () => { e.draft = (e.draft || 0) + 1; save(`draft v${e.draft}`); } }, '▲');
    const sub = box('Submitted', e.submitted, (on) => {
      e.submitted = on; e.submitted_at = on ? now() : null;
      if (!on) { e.published = false; e.published_at = null; e.done = false; e.done_at = null; }
      save(on ? 'submitted' : 'not submitted');
    });
    const pub = box('Published', e.published, (on) => {
      const t = now();
      e.published = on; e.published_at = on ? t : null; e.done = on; e.done_at = on ? t : null;
      if (on && !e.submitted) { e.submitted = true; e.submitted_at = t; }   // published implies submitted
      save(on ? 'published' : 'not published');
    });
    const doi = el('input', { type: 'text', class: 'wdoi', placeholder: 'DOI', value: e.doi || '' });
    doi.addEventListener('change', () => {
      e.doi = doi.value.trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '') || null;
      save(e.doi ? 'DOI' : 'no DOI');
    });
    const n = e.doi ? ((growthDocs.cites.dois || {})[e.doi.toLowerCase()] || {}).count : undefined;
    return el('div', { class: 'wstates' }, draft, ver, up, sub, pub, doi,
      Number.isFinite(n) ? el('span', { class: 'badge', title: 'citations (OpenAlex)' }, `${n} citation${n === 1 ? '' : 's'}`) : null);
  }

  // A paper's Notes (saved as you type; the loop writes them into the notes repo under the paper's \\cite,
  // one \\item per line) and its Summary (written by the paper_summary agent).
  function paperExtras(e) {
    const notesPath = `personal/${e.id}/notes.md`;
    const ta = el('textarea', { rows: 4, class: 'pnotes', placeholder: 'One note per line: each becomes an \\item under the paper\'s \\cite in your notes.' });
    const st = el('div', { class: 'status' });
    let loaded = false, timer = null;
    const where = (e.zotero && e.zotero.name ? e.zotero.name : 'Unsorted');
    const leaf = where.split(' / ').pop();
    const notes = el('details', { class: 'pextra' }, el('summary', {}, 'Notes'),
      el('div', { class: 'who' }, `Goes to ${where.split(' / ').join('/')}/${leaf}.tex in your notes repo`), ta, st);
    const load = async () => {
      if (loaded) return;
      loaded = true;
      if (tree.paths.has(notesPath)) ta.value = await (await gh(repoPath(notesPath), { raw: true })).text();
    };
    notes.addEventListener('toggle', () => { if (notes.open) load(); });
    ta.addEventListener('input', () => {
      clearTimeout(timer);
      st.textContent = 'Not saved yet…';
      timer = setTimeout(async () => {
        try { await put(notesPath, new TextEncoder().encode(ta.value), `${e.id}: notes`); st.textContent = 'Saved; the loop adds it to your notes repo within a minute.'; }
        catch (err) { st.textContent = `Not saved: ${err.message}`; }
      }, 1500);
    });
    const sumPath = `personal/${e.id}/summary.json`;
    const sbody = el('div', { class: 'blocks' });
    const has = tree.paths.has(sumPath);
    const summary = el('details', { class: 'pextra' }, el('summary', {}, has ? 'Summary' : 'Summary (not yet)'), sbody);
    summary.addEventListener('toggle', async () => {
      if (!summary.open || sbody.childElementCount) return;
      if (!has) { sbody.append(el('p', { class: 'empty' }, 'The paper_summary agent has not summarised this paper yet. It is sent each new paper; the summary appears here.')); return; }
      const s = await getJSON(sumPath);
      window.LoopRender.blocks(sbody, s.blocks || [], { store: store(e.id), fileUrl: (n) => fileUrl(`personal/${e.id}/${n}`) });
      sbody.append(el('div', { class: 'who' }, `by ${s.by || 'paper_summary'}, ${age(s.at)} ago`));
    });
    return {
      el: el('div', { class: 'pextras' }, summary, notes),
      hasNote: async () => { await load(); return !!ta.value.trim(); },
      askNote: () => {
        notes.open = true;
        st.textContent = 'Add a note first (what you took from it), then tick it done.';
        st.classList.add('ask-note');
        ta.focus();
      },
    };
  }

  // A new Zotero collection: written as zotero_requests/<t>.json; the loop creates it (web API) and adds it
  // to state/zotero_collections.json. onMade(collection) runs when it appears.
  function newCollectionForm(parentKey, onMade) {
    const name = el('input', { type: 'text', placeholder: 'New collection name' });
    const parent = el('select', {}, el('option', { value: '' }, 'Top level'),
      mine.collections.filter((c) => !c.pending).map((c) => el('option', { value: c.key, selected: c.key === parentKey ? true : null }, c.name)));
    const st = el('div', { class: 'status' });
    let timer = null;
    const box = el('details', { class: 'addlink newcol' }, el('summary', {}, '+ New Zotero collection'),
      el('div', { class: 'newentry' }, el('label', {}, 'Name', name), el('label', {}, 'Inside', parent),
        el('div', { class: 'row' }, el('span', { class: 'grow' }), el('button', { class: 'primary', onclick: async () => {
          const n = name.value.trim();
          if (!n) { st.textContent = 'Give it a name.'; return; }
          const p = mine.collections.find((c) => c.key === parent.value);
          const path = p ? `${p.name} / ${n}` : n;
          await put(`zotero_requests/${stamp()}.json`, new TextEncoder().encode(JSON.stringify({ name: n, parent_key: p ? p.key : null, parent_name: p ? p.name : null })), `new Zotero collection: ${path}`);
          st.textContent = `"${path}" will be made in Zotero within about a minute (by the scheduled script)…`;
          clearInterval(timer);
          timer = setInterval(async () => {
            const cols = (await getJSON('state/zotero_collections.json', { fresh: true }).catch(() => ({}))).collections || [];
            const made = cols.find((c) => c.name === path);
            if (made) { clearInterval(timer); mine.collections = cols; st.textContent = `Made "${path}" in Zotero.`; if (onMade) onMade(made); }
          }, 5000);
        } }, 'Create')), st));
    box.setParent = (key) => { if ([...parent.options].some((o) => o.value === key)) parent.value = key; };
    return box;
  }

  // A link (Overleaf or any other) as an entry, e.g. a student's draft.
  function linkForm(kind, preset, redraw, label) {
    const t = el('input', { type: 'text', placeholder: 'Title (optional)' });
    const link = el('input', { type: 'url', placeholder: 'Paste a link (Overleaf, Google Doc, …)' });
    const due = el('input', { type: 'date' });
    const st = el('div', { class: 'status' });
    return el('details', { class: 'addlink' }, el('summary', {}, label || '+ Add a link'),
      el('div', { class: 'newentry' }, link, t, el('div', { class: 'row' }, el('label', {}, 'Deadline', due), el('span', { class: 'grow' }),
        el('button', { class: 'primary', onclick: async () => {
          const u = link.value.trim();
          if (!/^https?:\/\//.test(u)) { st.textContent = 'Paste the link.'; return; }
          await createEntry(kind, { title: t.value.trim() || u.replace(/^https?:\/\//, '').slice(0, 60), link: u, deadline: due.value || null, ...preset }, []);
          redraw();
        } }, 'Add')), st));
  }

  // The short form shown after a drop: title, Zotero collection (Read), deadline. A paper has no title box: the
  // loop titles it from its record (DOI/CrossRef, arXiv or its summary); its file's name stands in until then.
  function newEntryForm(kind, files, preset, redraw) {
    const title = el('input', { type: 'text', value: files.length === 1 ? files[0].name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ') : '', placeholder: 'Title' });
    const due = el('input', { type: 'date' });
    let colSel = null;
    const parts = [el('div', { class: 'who' }, files.map((f) => f.name).join(', ')),
      kind === 'read' ? el('div', { class: 'who autotitle' }, 'Title: set by the loop from the paper\'s record (DOI, arXiv or its summary).')
        : el('label', {}, 'Title', title)];
    if (kind === 'read') {
      const filter = el('input', { type: 'search', placeholder: `Filter ${mine.collections.length} Zotero collections…` });
      colSel = el('select', { size: 6, class: 'colsel' }, mine.collections.map((c) => el('option', { value: c.key }, c.name)));
      filter.addEventListener('input', () => {
        const q = filter.value.toLowerCase();
        [...colSel.options].forEach((o) => { o.hidden = q && !o.textContent.toLowerCase().includes(q); });
      });
      parts.push(el('label', {}, 'Save to Zotero collection', filter, colSel));
      // "Inside" (where a new collection goes) follows the collection picked above.
      const nc = newCollectionForm(null, (c) => {
        if (![...colSel.options].some((o) => o.value === c.key)) colSel.append(el('option', { value: c.key }, c.name));
        colSel.value = c.key;
      });
      colSel.addEventListener('change', () => nc.setParent(colSel.value));
      parts.push(nc);
    }
    parts.push(el('label', {}, 'Deadline (optional)', due));
    const status = el('div', { class: 'status' });
    const box = el('div', { class: 'newentry' }, ...parts, el('div', { class: 'row' },
      el('button', { class: 'ghost', onclick: () => box.remove() }, 'Cancel'), el('span', { class: 'grow' }),
      el('button', { class: 'primary', onclick: async () => {
        const c = colSel && mine.collections.find((x) => x.key === colSel.value);
        if (kind === 'read' && !c) { status.textContent = 'Pick a Zotero collection.'; return; }
        status.textContent = 'Saving…';
        try {
          await createEntry(kind, { title: title.value.trim(), deadline: due.value || null, ...preset,
            ...(c ? { zotero: { collection: c.key, collection_id: c.id, name: c.name } } : {}) }, files);
          redraw();
        } catch (err) { status.textContent = `Not saved: ${err.message}`; }
      } }, 'Save')), status);
    return box;
  }

  async function showMine(tab) {
    tab = MINE_TABS.some(([k]) => k === tab) ? tab : 'read';
    await loadMine();
    const redraw = () => showMine(tab);
    const all = mine.entries.filter((e) => e.kind === tab);
    const open = all.filter((e) => !e.done);
    const byPrio = (list) => [...list].sort((a, b) => (dueInfo(a.deadline)?.days ?? 1e9) - (dueInfo(b.deadline)?.days ?? 1e9));
    const tabs = el('nav', { class: 'tabs' }, MINE_TABS.map(([k, l]) => el('a', { href: `#/manual/${k}`, class: k === tab ? 'on' : '' },
      l, el('span', { class: 'n' }, String(mine.entries.filter((e) => e.kind === k && !e.done).length)))));
    const body = el('div', { class: 'mine' });
    if (tab === 'student') {
      const who = safeGet('loop.mine.student') || 'all';
      body.append(el('div', { class: 'switch wrap' }, ['all', ...mine.people].map((p) => el('button', {
        class: p === who ? 'on' : '', onclick: () => { safeSet('loop.mine.student', p); redraw(); } },
      p === 'all' ? `All (${open.length})` : `${p} (${open.filter((e) => e.student === p).length})`))));
      (who === 'all' ? mine.people : [who]).forEach((p) => {
        const mineP = byPrio(open.filter((e) => e.student === p));
        const card = el('section', { class: 'mgroup' }, el('h3', {}, p, el('span', { class: 'n' }, ` ${mineP.length}`)));
        card.append(dropZone(`Drop files to review for ${p}`, (files) => card.insertBefore(newEntryForm('student', files, { student: p }, redraw), card.children[2] || null)),
          linkForm('student', { student: p }, redraw, `+ Add a link for ${p} (Overleaf, …)`));
        mineP.forEach((e) => card.append(entryRow(e, redraw)));
        body.append(card);
      });
    } else {
      if (tab === 'write') {
        const t = el('input', { type: 'text', placeholder: 'Title' });
        const link = el('input', { type: 'url', placeholder: 'Overleaf link (paste)' });
        const pr = el('select', {}, PRIOS.map(([k, l]) => el('option', { value: k, selected: k === 'med' ? true : null }, l)));
        const due = el('input', { type: 'date' });
        const status = el('div', { class: 'status' });
        body.append(el('section', { class: 'newentry' }, el('h3', {}, 'Add writing'), el('label', {}, 'Title', t), el('label', {}, 'Overleaf link', link),
          el('div', { class: 'row' }, el('label', {}, 'Priority', pr), el('label', {}, 'Deadline', due), el('span', { class: 'grow' }),
            el('button', { class: 'primary', onclick: async () => {
              if (!/^https?:\/\//.test(link.value.trim())) { status.textContent = 'Paste the Overleaf link.'; return; }
              await createEntry('write', { title: t.value.trim() || link.value.trim(), link: link.value.trim(), priority: pr.value, deadline: due.value || null }, []);
              redraw();
            } }, 'Add')), status));
      }
      if (tab === 'other') {
        const note = el('textarea', { rows: 2, placeholder: 'A note (optional), then Add, or drop files below' });
        const pr = el('select', {}, PRIOS.map(([k, l]) => el('option', { value: k, selected: k === 'med' ? true : null }, l)));
        body.append(el('section', { class: 'newentry' }, el('h3', {}, 'Add a note'), note, el('div', { class: 'row' }, el('label', {}, 'Priority', pr), el('span', { class: 'grow' }),
          el('button', { class: 'primary', onclick: async () => {
            if (!note.value.trim()) return;
            await createEntry('other', { title: note.value.trim().split('\n')[0].slice(0, 80), note: note.value.trim(), priority: pr.value }, []);
            redraw();
          } }, 'Add'))));
      }
      if (tab === 'read') body.append(newCollectionForm(null, null));
      PRIOS.forEach(([p, label]) => {
        const list = byPrio(open.filter((e) => (e.priority || 'med') === p));
        const card = el('section', { class: `mgroup prio-${p}` }, el('h3', {}, label, el('span', { class: 'n' }, ` ${list.length}`)));
        if (tab === 'read') card.append(dropZone(`Drop papers (PDF) here: ${label.toLowerCase()} priority`, (files) => card.insertBefore(newEntryForm('read', files, { priority: p }, redraw), card.children[2] || null), '.pdf,application/pdf'));
        if (tab === 'other') card.append(dropZone(`Drop files here: ${label.toLowerCase()} priority`, (files) => card.insertBefore(newEntryForm('other', files, { priority: p }, redraw), card.children[2] || null)));
        list.forEach((e) => card.append(entryRow(e, redraw, tab === 'student' ? el('span', { class: 'badge' }, e.student) : null)));
        body.append(card);
      });
    }
    const done = all.filter((e) => e.done).sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
    const hist = el('details', { class: 'history' }, el('summary', {}, `Done (${done.length})`), ...done.map((e) => entryRow(e, redraw)));
    const gone = mine.deleting.filter((x) => x.e.kind === tab);
    const deleting = gone.length ? el('section', { class: 'mdeleting' }, el('h3', {}, 'Deleting'), ...gone.map(({ e, why }) =>
      el('div', { class: 'mrow' }, el('div', { class: 'mmain' }, el('div', { class: 'mtitle' }, e.title || (e.files || [])[0] || 'note'),
        el('div', { class: 'status' }, why ? `Waiting: ${why}` : 'Deleted within about a minute (by the scheduled script)…'))))) : null;
    main().replaceChildren(tabs, ...(deleting ? [deleting] : []), body, hist);
    drawSide().catch(() => {});
    const watched = () => [...tree.sha].filter(([x]) => x.startsWith('personal/') || x.startsWith('delete_requests/')).join();
    setPoll(async () => {
      const before = watched();
      await loadTree();
      if (watched() !== before && !main().querySelector('.newentry input:focus, .newentry textarea:focus, .datein')) redraw();
    }, 30_000);
  }

  // ------------------------------------------------------------ Tree: the growth tree (growth.js)
  // Read papers ticked done grow their Zotero collection's branch, deadlines met grow leaves, submitted Write
  // entries bring animals. The tree is derived from Manual every time; only names and animals are stored.

  const G = window.LoopGrowth;
  const growthState = () => G.derive(mine.entries, growthDocs.tree, growthDocs.cites, new Date());
  const dayText = (d) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  const collName = (b) => (b === 'trunk' ? 'no collection (the trunk)' : b);
  const metres = (h) => (h < 1 ? `${Math.round(h * 100)} cm` : `${h < 10 ? h.toFixed(1) : Math.round(h)} m`);

  // What a tapped or hovered part of the tree is: a paper's segment, a collection's stub, or an animal.
  function growthInfo(state, k, id, b) {
    if (k === 'seg') {
      const p = state.papers.find((x) => x.id === id);
      if (!p) return null;
      return el('div', {}, el('b', {}, p.title || 'untitled paper'), paperSub(p),
        el('div', {}, `Collection: ${collName(p.branch)}`),
        b && b !== p.branch ? el('div', { class: 'who' }, b === 'trunk' ? 'This trunk segment is the rise it caused.' : `This segment is the length it added to ${b}, a collection above its own.`) : null,
        el('div', { class: 'who' }, `Read ${dayText(p.day)} · ${p.mult.toFixed(1)}x`));
    }
    if (k === 'branch') return el('div', {}, el('b', {}, id), el('div', { class: 'who' }, 'A collection with papers only in its subcollections so far.'));
    if (k === 'bird') {
      const bd = (state.birds || []).find((x) => x.id === id);
      if (!bd) return null;
      const due = dueInfo(bd.deadline);
      return el('div', {}, el('b', {}, bd.title || 'untitled'), el('div', {}, due.text),
        el('div', { class: 'who' }, bd.evil ? 'Its deadline passed: the crow sits in the tree and saddens the animals near it until the entry is done.'
          : 'A deadline flying in: it comes closer and grows as the day nears, and lands at the end of the dashed line.'),
        bd.kind ? el('a', { href: `#/manual/${bd.kind}` }, 'Open in Manual') : null);
    }
    if (k === 'creature') {
      const c = state.creatures.find((x) => x.id === id);
      if (!c) return null;
      return el('div', {}, el('b', {}, `${c.name || `An unnamed ${c.animal}`}`, el('span', { class: 'who' }, ` · ${c.animal}`)),
        el('div', {}, c.title || 'untitled'),
        el('div', { class: 'who' }, `Submitted ${dayText(c.day)}`, c.published ? ' · published' : '',
          c.doi ? ` · doi ${c.doi}` : '', c.citations != null ? ` · ${c.citations} citation${c.citations === 1 ? '' : 's'}` : c.doi ? ' · citations not counted yet' : ''));
    }
    return null;
  }

  function growthEvent(ev) {
    const t = `“${ev.title || 'untitled'}”`;
    const text = ev.kind === 'paper' ? `Read ${t}: ${collName(ev.branch)} grew${ev.mult > 1 ? ` (${ev.mult.toFixed(1)}x)` : ''}`
      : ev.kind === 'leaf' ? `${t} done by its deadline: a leaf${ev.mult > 1 ? ` (${ev.mult.toFixed(1)}x)` : ''}`
        : ev.kind === 'passed' ? `${t}'s deadline passed: the streak breaks`
          : `${t} submitted: a ${ev.animal} arrived`;
    return el('li', { class: `gev ${ev.kind}` }, text);
  }

  async function saveTreeDoc() {
    const doc = { seed: growthDocs.tree.seed || G.DEFAULT_SEED, creatures: growthDocs.tree.creatures || {} };
    growthDocs.tree = doc;
    await put('personal/tree.json', new TextEncoder().encode(JSON.stringify(doc, null, 1)), 'tree: creature names');
  }

  function creatureBox(c, redraw) {
    const name = el('input', { type: 'text', placeholder: `Name the ${c.animal}`, value: c.name || '' });
    const animal = el('select', {}, G.ANIMALS.map(([a]) => el('option', { value: a, selected: a === c.animal ? true : null }, a)));
    const st = el('div', { class: 'status' });
    return el('div', { class: 'gcreature', 'data-i': c.id },
      el('div', { class: 'who' }, c.title || 'untitled'),
      el('div', { class: 'row' }, name, animal, el('button', { class: 'primary', onclick: async () => {
        const cs = { ...(growthDocs.tree.creatures || {}) };
        cs[c.id] = { name: name.value.trim() || null, animal: animal.value };
        growthDocs.tree = { ...growthDocs.tree, creatures: cs };
        st.textContent = 'Saving…';
        try { await saveTreeDoc(); redraw(); } catch (err) { st.textContent = `Not saved: ${err.message}`; }
      } }, 'Save')), st);
  }

  // ------------------------------------------------------------ The ant farm (anthills.js), drawn under the tree
  // From state/status.json, a cross-section of the ground: LOOP the fruit pile on the surface, every other session an
  // anthill with its own anthome below, sized by its tokens since the weekly reset and lit in its role's colour; a
  // rock on a blocked anthill, ants on a working one, dark lights when stalled. Hover (tap on a phone) an anthome
  // for its usage, the food inside it for its current focus, a tunnel for its messages. Ants move with
  // requestAnimationFrame (about 20 frames a second, only while the tab shows), and stand still for people who ask
  // for reduced motion.

  const H = window.LoopHills;
  let lastStatus = null;
  const MOOD_TEXT = { working: 'working', blocked: 'blocked: waiting on you', quiet: 'stalled or stopped' };

  const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));

  // An agent's token usage since the weekly reset (status.json agents[].week_tokens, usage.week_start).
  function usageInfo(hl, L) {
    const u = hl.agent.week_tokens, since = (lastStatus && lastStatus.usage || {}).week_start;
    const all = L.hills.reduce((s, h) => s + Number((h.agent.week_tokens || {}).total || 0), 0);
    if (!u || !Number.isFinite(Number(u.total))) return el('div', { class: 'husage who' }, 'No token figures for this session yet.');
    const parts = [['output', u.output], ['input', u.input], ['cache writes', u.cache_write], ['cache reads', u.cache_read]]
      .filter(([, v]) => Number(v) > 0).map(([k, v]) => `${k} ${fmtTok(Number(v))}`);
    return el('div', { class: 'husage' },
      el('div', {}, el('b', {}, `${fmtTok(Number(u.total))} tokens`), ' since the weekly reset',
        all > 0 ? el('span', { class: 'who' }, ` · ${Math.round(100 * Number(u.total) / all)}% of all sessions'`) : null),
      parts.length ? el('div', { class: 'who' }, parts.join(' · ')) : null,
      el('div', { class: 'who' }, [hl.agent.context_tokens ? `context now ${fmtTok(hl.agent.context_tokens)}` : null,
        hl.agent.model ? `model ${hl.agent.model}` : null, since ? `reset ${new Date(since).toLocaleString()}` : null].filter(Boolean).join(' · ')));
  }

  // The food in an anthome: what the agent is focused on now.
  function focusInfo(hl) {
    const a = hl.agent;
    const focus = a.working_on || a.detail || a.why;
    return el('div', {},
      el('div', { class: 'arow' }, el('b', {}, `${a.name}: current focus`), el('span', { class: `badge hmood ${hl.mood}` }, MOOD_TEXT[hl.mood])),
      el('div', { class: 'adetail hfocus' }, focus || 'Nothing reported yet.'),
      a.why && a.why !== focus ? el('div', { class: 'awhy' }, a.why) : null,
      a.updated ? el('div', { class: 'who' }, `last active ${age(a.updated)} ago`) : null);
  }

  let foodUsage = null;
  // The current session's usage (status.json, from /usage), beside the weekly figure on LOOP's food pile.
  const sessionLine = () => {
    const l = ((lastStatus && lastStatus.usage && lastStatus.usage.limits) || []).find((x) => /^session/i.test(x.name));
    return l ? el('div', { class: 'ausage session' }, `session usage ${l.pct}%`, l.resets ? ` · resets ${String(l.resets).replace(/\s*\(.*\)$/, '')}` : '') : null;
  };
  const usageLine = (u) => (!u ? null : el('div', { class: 'ausage' + (u.stale ? ' stale' : '') },
    u.stale ? `usage unknown (last: weekly usage ${Math.round(u.pct)}%)` : `weekly usage ${Math.round(u.pct)}%`,
    u.resets ? ` · resets ${String(u.resets).replace(/\s*\(.*\)$/, '').replace(',', '')}` : ''));
  function hillInfo(hl, L, tapped) {
    const a = hl.agent;
    const titles = new Map(index.items.map((x) => [x.id, x.title]));
    const link = (id, title) => el('a', { href: `#/item/${id}`, class: 'alink' }, el('b', {}, id), title ? ` ${String(title).slice(0, 80)}` : '');
    return el('div', {},
      el('div', { class: 'arow' }, el('b', {}, a.name), el('span', { class: `badge hmood ${hl.mood}` }, MOOD_TEXT[hl.mood]),
        el('span', { class: 'who' }, hl.kind === 'food' ? ' · the food source (LOOP)' : ` · ${H.ROLE_TEXT[hl.role]} anthome`)),
      hl.asleep != null ? el('div', { class: 'who hsleep' }, hl.asleep ? 'Asleep: the usage hold is on until the reset.'
        : 'Awake: woken by an urgent message, while its session works.') : null,
      hl.kind === 'food' ? usageLine(foodUsage) : null,
      hl.kind === 'food' ? sessionLine() : null,
      L ? usageInfo(hl, L) : null,
      a.items && a.items.length ? el('div', { class: 'alinks' }, hl.mood === 'blocked' ? 'Waiting on: ' : 'Will need: ',
        a.items.map((id) => link(id, titles.get(id)))) : null,
      a.why && !(a.items && a.items.length) ? el('div', { class: 'awhy' }, a.why) : null,
      a.working_on ? el('div', { class: 'adetail' }, el('span', { class: 'who' }, hl.mood === 'working' ? 'Working on: ' : 'Last: '), a.working_on) : null,
      (a.recent || []).length ? el('details', { class: 'arecent' }, el('summary', {}, `Its entries (${a.recent.length})`),
        el('div', { class: 'alinks' }, a.recent.map((x) => link(x.id, x.title)))) : null,
      el('div', { class: 'who' }, a.updated ? `last active ${age(a.updated)} ago` : ''),
      a.job ? messageBox(a, tapped) : null);
  }

  // A path's messages, newest first, one at a time: ◀ steps back to older ones, ▶ forward again.
  function pathInfo(pa) {
    const box = el('div', {});
    let k = 0;
    const draw = () => {
      const m = pa.msgs[k];
      const older = el('button', { class: 'ghost hnav', title: 'older message', disabled: k >= pa.msgs.length - 1 ? true : null, onclick: () => { k++; draw(); } }, '◀ older');
      const newer = el('button', { class: 'ghost hnav', title: 'newer message', disabled: k === 0 ? true : null, onclick: () => { k--; draw(); } }, 'newer ▶');
      box.replaceChildren(
        el('div', { class: 'arow' }, el('b', {}, `${pa.a} ↔ ${pa.b}`),
          el('span', { class: 'who' }, ` · ${pa.count} of the last 50 messages (${pa.ab} from ${pa.a}, ${pa.ba} from ${pa.b})`)),
        m ? el('div', { class: 'hmsg' },
          el('div', { class: 'who' }, `${m.from} → ${m.to} · ${new Date(m.at).toLocaleString()} (${age(m.at)} ago)`),
          el('div', { class: 'hmsgtext' }, m.text || '(no text)')) : el('p', { class: 'who' }, 'No messages to show.'),
        pa.msgs.length > 1 ? el('div', { class: 'row hmsgnav' }, older, el('span', { class: 'who' }, `${k + 1} of ${pa.msgs.length}`), newer) : null);
    };
    draw();
    return box;
  }

  let hillsFrame = 0;
  function animateAnts(view, hills, paths) {
    cancelAnimationFrame(hillsFrame);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const ants = [...view.querySelectorAll('.ant:not([data-still])')].map((g) => ({ g, hl: g.dataset.p != null ? paths[+g.dataset.p] : hills[+g.dataset.h], k: +g.dataset.a }));
    if (!ants.length) return;
    let last = 0;
    const step = (now) => {
      if (!view.isConnected) return;
      hillsFrame = requestAnimationFrame(step);
      if (now - last < 50 || document.hidden) return;
      last = now;
      for (const a of ants) a.g.setAttribute('transform', H.antPose(H.antAt(a.hl, a.k, now / 1000)));
    };
    hillsFrame = requestAnimationFrame(step);
  }

  // ------------------------------------------------------------ Tree: the growth tree on the ant farm (scene.js)
  // One drawing: the tree stands in a gap on the surface between LOOP's fruit pile and the first anthill to its right,
  // the sessions' anthills around them, their shafts down to the anthomes. The view is a camera over it (sceneCam, in farm blocks; kept across
  // redraws until Reset): Ctrl+wheel or a trackpad pinch zooms toward the pointer, a mouse drag pans, Shift+wheel
  // (or a sideways swipe) pans sideways; on a phone two fingers pinch and pan, and one finger scrolls the page.
  // It opens on the anthills and the trunk's foot; the tree is above, a drag (or "Whole tree") away.

  const SC = window.LoopScene;
  let treePinnedAgent = null;                   // the agent whose anthome was tapped last (kept across redraws)
  let sceneCam = null, sceneDraw = null;
  let sdrag = null, sdragged = false;           // a mouse drag in progress, and whether the last one moved
  window.addEventListener('pointermove', (ev) => {
    if (!sdrag) return;
    if (Math.abs(ev.clientX - sdrag.x0) + Math.abs(ev.clientY - sdrag.y0) > 4) sdrag.moved = true;
    sdrag.pan(ev.clientX - sdrag.x, ev.clientY - sdrag.y);
    sdrag.x = ev.clientX; sdrag.y = ev.clientY;
  });
  window.addEventListener('pointerup', () => { sdragged = !!(sdrag && sdrag.moved); sdrag = null; });
  window.addEventListener('resize', () => { if (sceneDraw) sceneDraw(); });

  function sceneViewer(sc, show) {
    const view = el('div', { class: 'gview scene' });
    view.innerHTML = sc.svg;
    const svgEl = view.querySelector('svg');
    svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    const size = () => ({ W: view.clientWidth || 1, H: view.clientHeight || 1 });
    const sprout = svgEl.querySelector('.sprout');
    // The closest zoom: 12 blocks across, or a small (young) tree's own frame, so it can be seen up close.
    const narrowest = () => Math.min(12, 0.9 * (sc.tree.x1 - sc.tree.x0));
    const widest = () => { const { W, H } = size(); return 1.1 * Math.max(sc.box.x1 - sc.box.x0, (sc.box.y1 - sc.box.y0) * W / H); };
    // A box shown whole: centred across, its foot at the view's foot.
    const frame = (b) => {
      const { W, H } = size();
      const w = Math.min(widest(), Math.max(b.x1 - b.x0, (b.y1 - b.y0) * W / H));
      return { x: (b.x0 + b.x1) / 2 - w / 2, y: b.y1 - w * H / W, w };
    };
    const draw = () => {
      if (!view.isConnected) return;
      const { W, H } = size(), b = sc.box, c = sceneCam;
      c.w = Math.max(narrowest(), Math.min(widest(), c.w));
      const h = c.w * H / W;
      // Across: inside the scene, or centred on it when wider. Up and down: never below the farm's floor, and the
      // top no higher than the tree's unless the view is taller than the scene.
      c.x = c.w >= b.x1 - b.x0 ? (b.x0 + b.x1 - c.w) / 2 : Math.max(b.x0, Math.min(b.x1 - c.w, c.x));
      c.y = Math.max(Math.min(b.y0, b.y1 - h), Math.min(b.y1 - h, c.y));
      svgEl.setAttribute('viewBox', [c.x, c.y, c.w, h].map((v) => Math.round(v * 100) / 100).join(' '));
      // A young tree's marker ("tree: 7 cm ↓", ~12 blocks wide) points it out in the farm view; zoomed in, the tree is seen.
      if (sprout) sprout.style.display = c.w < 20 ? 'none' : '';
    };
    const zoomAt = (k, px, py) => {               // k > 1 zooms in, about the point (px, py) of the view
      const { W, H } = size(), c = sceneCam;
      if (px == null) { px = W / 2; py = H / 2; }
      const u = c.w / W, wx = c.x + px * u, wy = c.y + py * u;
      c.w = Math.max(narrowest(), Math.min(widest(), c.w / k));
      c.x = wx - px * c.w / W; c.y = wy - py * c.w / W;
      draw();
    };
    const pan = (dx, dy) => { const u = sceneCam.w / size().W; sceneCam.x -= dx * u; sceneCam.y -= dy * u; draw(); };
    const at = (ev) => { const r = view.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
    view.addEventListener('wheel', (ev) => {
      const px = ev.deltaMode === 1 ? 40 : ev.deltaMode === 2 ? 400 : 1;
      if (ev.ctrlKey) { ev.preventDefault(); zoomAt(Math.exp(-ev.deltaY * px * 0.0025), ...at(ev)); }
      else if (ev.shiftKey) { ev.preventDefault(); pan(-(ev.deltaX || ev.deltaY) * px, 0); }
      else if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) { ev.preventDefault(); pan(-ev.deltaX * px, 0); }
    }, { passive: false });
    view.addEventListener('pointerdown', (ev) => {
      if (ev.pointerType !== 'mouse' || ev.button !== 0) return;
      sdrag = { x0: ev.clientX, y0: ev.clientY, x: ev.clientX, y: ev.clientY, moved: false, pan };
    });
    let pinch = null;                              // two fingers: their midpoint and spread on the last move
    const fingers = (ev) => {
      const r = view.getBoundingClientRect(), [a, b] = ev.touches;
      return { x: (a.clientX + b.clientX) / 2 - r.left, y: (a.clientY + b.clientY) / 2 - r.top,
        d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1 };
    };
    const touch = (ev) => {
      if (ev.touches.length !== 2) { pinch = null; return; }
      ev.preventDefault();
      const p = fingers(ev);
      if (pinch) { zoomAt(p.d / pinch.d, p.x, p.y); pan(p.x - pinch.x, p.y - pinch.y); }
      pinch = p;
    };
    for (const t of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) view.addEventListener(t, touch, { passive: false });
    // A young tree's papers are a few pixels wide on screen: the nearest tree target within REACH px (a finger's or
    // a pointer's width) is picked, over the farm's. The young tree's marker keeps its own tap (it zooms to the tree).
    const pick = (ev) => {
      const direct = ev.target.closest('[data-k]');
      if (direct && (direct.dataset.k === 'sprout' || direct.closest('.tree'))) return direct;
      const reach = ev.pointerType === 'mouse' ? 12 : 22;
      let best = null, bd = reach;
      svgEl.querySelectorAll('.tree .hits [data-k]').forEach((n) => {
        const b = n.getBoundingClientRect();
        const d = Math.hypot(Math.max(b.left - ev.clientX, 0, ev.clientX - b.right), Math.max(b.top - ev.clientY, 0, ev.clientY - b.bottom));
        if (d <= bd) { best = n; bd = d; }
      });
      return best || direct;
    };
    svgEl.addEventListener('pointermove', (ev) => { if (ev.pointerType === 'mouse') show(pick(ev)); });
    svgEl.addEventListener('click', (ev) => {
      if (sdragged) { sdragged = false; return; }
      const t = pick(ev);
      if (t && t.dataset.k === 'sprout') { goto(sc.tree); return; }     // a young tree's marker: zoom to the tree
      show(t, true);
    });
    const goto = (b) => { sceneCam = frame(b); draw(); };
    const zoom = el('div', { class: 'gzoom' },
      el('button', { class: 'ghost', title: 'zoom in', onclick: () => zoomAt(1.5) }, '+'),
      el('button', { class: 'ghost', title: 'zoom out', onclick: () => zoomAt(1 / 1.5) }, '−'),
      el('button', { class: 'ghost', title: 'the whole tree', onclick: () => goto(sc.tree) }, 'Whole tree'),
      el('button', { class: 'ghost', title: 'back to the anthills and the trunk', onclick: () => goto(sc.home) }, 'Reset'));
    // The view fills the screen below its top (at least 260 px); the camera starts on the anthills.
    const start = () => {
      const top = view.getBoundingClientRect().top + window.scrollY;
      view.style.height = `${Math.max(260, Math.round(window.innerHeight - top - 10))}px`;
      if (!sceneCam) sceneCam = frame(sc.home);
      draw();
    };
    sceneDraw = start;
    return { el: el('div', { class: 'gwrap' }, view, zoom), view, start };
  }

  async function showTree() {
    await useTree();
    const has = (p) => tree.paths.has(p);
    const [st, msgs, gu] = await Promise.all([has('state/status.json') ? getJSON('state/status.json').catch(() => null) : null,
      has('state/messages.json') ? getJSON('state/messages.json').catch(() => null) : null,
      has('state/usage.json') ? getJSON('state/usage.json').catch(() => null) : null,
      index.items.length ? null : refreshIndex(), loadMine()]);
    lastStatus = st;
    const agents = (st && st.agents) || [];
    const state = growthState();
    const redraw = () => showTree();
    const hint = 'Tap or hover a branch, an animal, a bird (a deadline), an anthome (its usage), the food in it (its focus) or a tunnel (its messages).';
    const info = el('div', { class: 'ginfo hinfo' }, el('span', { class: 'who' }, hint));
    const names = safeGet('loop.tree.names') === '1';
    // LOOP's food pile is the weekly usage left (the usage guard's figure, published by `loop status`); faded when stale.
    foodUsage = gu && gu.pct != null ? { pct: gu.pct, resets: gu.resets, stale: Date.now() / 1000 - gu.at > 2 * 3600 } : null;
    // Night while the usage hold is on (state/usage.json held): every anthill asleep but those woken by an urgent message.
    const night = gu && gu.held ? { woken: gu.woken || [] } : null;
    const sc = SC.scene(state, agents, { messages: msgs, branchNames: names, t: performance.now() / 1000, usage: foodUsage, night });
    const L = sc.L;
    // Hover or tap: the info line. Every segment of the same paper lights up. A tap pins it, so the mouse can cross
    // the scene to its buttons; a tap on open ground unpins it.
    let shown = null, pinned = false;
    const show = (t, tapped) => {
      if (pinned && !tapped) return;
      if (tapped) treePinnedAgent = t && t.dataset.k === 'hill' ? (L.hills[+t.dataset.i] || {}).agent?.name || null : null;
      if (!t && tapped) {                           // a tap on open ground clears the info line
        shown = null; pinned = false;
        viewer.view.querySelectorAll('.hits .on').forEach((n) => n.classList.remove('on'));
        info.classList.remove('on');
        info.replaceChildren(el('span', { class: 'who' }, hint));
        return;
      }
      if (!t || (t === shown && !tapped)) return;
      const k = t.dataset.k, i = t.dataset.i;
      const tree_ = ['seg', 'branch', 'creature', 'bird'].includes(k);
      const body = tree_ ? growthInfo(state, k, i, t.dataset.b)
        : k === 'path' ? pathInfo(L.paths[+i]) : k === 'food' ? focusInfo(L.hills[+i]) : k === 'hill' ? hillInfo(L.hills[+i], L, !!tapped) : null;
      if (!body) return;
      shown = t; pinned = !!tapped;
      viewer.view.querySelectorAll('.hits .on').forEach((n) => n.classList.remove('on'));
      (k === 'seg' ? viewer.view.querySelectorAll(`[data-k="seg"][data-i="${CSS.escape(i)}"]`) : [t]).forEach((n) => n.classList.add('on'));
      info.replaceChildren(body);
      info.classList.add('on');
    };
    const viewer = sceneViewer(sc, show);
    const box = el('input', { type: 'checkbox' });
    box.checked = names;
    box.addEventListener('change', () => { safeSet('loop.tree.names', box.checked ? '1' : null); redraw(); });
    const stat = (k, v) => el('div', { class: 'gstat' }, el('b', {}, v), el('span', {}, k));
    const moods = ['blocked', 'working', 'quiet'].map((m) => [m, agents.filter((a) => H.moodOf(a) === m).length]);
    const head = el('section', { class: 'ghead' },
      stat('stage', state.stage), stat('tall', metres(state.height)),
      stat(`day${state.streak === 1 ? '' : 's'} in a row`, String(state.streak)),
      stat('multiplier now', `${state.mult.toFixed(1)}x`),
      stat('papers', String(state.papers.length)), stat('leaves', String(state.leaves.length)),
      ...(agents.length ? moods.map(([m, n]) => stat(m === 'quiet' ? 'stalled' : m, String(n))) : []));
    const legend = el('div', { class: 'hlegend' },
      el('span', {}, el('b', {}, 'Lights'), ' ', ...H.ROLE_ORDER.filter((r) => r !== 'loop').map((r) =>
        el('span', { class: 'hlight' }, el('i', { style: `background:${H.LIGHTS[r]}` }), H.ROLE_TEXT[r]))),
      el('span', {}, el('b', {}, 'Size'), ' tokens since the weekly reset'), el('span', {}, el('b', {}, 'Rock'), ' blocked on you'),
      el('span', {}, el('b', {}, 'Ants'), ' working'), el('span', {}, el('b', {}, 'Dark'), ' stalled'),
      el('span', {}, el('b', {}, 'Fruit'), ' LOOP, at the tree\'s foot; in a home, its focus'),
      el('span', {}, el('b', {}, 'Tunnels'), ' messages between them (last 50)'),
      el('span', {}, el('b', {}, 'Birds'), ' deadlines: nearer and bigger as they come due; a passed one is a crow in the tree'),
      night ? el('span', {}, el('b', {}, 'Night'), ' usage held until the reset: z\'s asleep; an urgent message wakes its agent') : null);
    const log = el('ol', { class: 'glog' }, state.events.slice(0, 40).map(growthEvent));
    const more = state.events.length > 40 ? el('button', { class: 'link', onclick: () => {
      log.replaceChildren(...state.events.map(growthEvent)); more.remove();
    } }, `Show all ${state.events.length}`) : null;
    const animals = state.creatures.length
      ? el('details', { class: 'pextra ganimals', open: state.creatures.some((c) => !c.name) ? true : null },
        el('summary', {}, `Animals (${state.creatures.length})`), ...state.creatures.map((c) => creatureBox(c, redraw)))
      : el('p', { class: 'who' }, 'Animals arrive when a Write entry is ticked Submitted.');
    main().replaceChildren(head,
      el('div', { class: 'row gtools' }, el('label', { class: 'wstate' }, box, 'Show branch names'), el('span', { class: 'grow' }),
        el('span', { class: 'who' }, 'Drag to move, Ctrl+wheel or pinch to zoom (two fingers on a phone).')),
      viewer.el, info, legend,
      el('p', { class: 'who' }, 'A good day: a paper read and no deadline passed. Each good day in a row adds 0.2x, up to 2x.'),
      animals,
      el('section', { class: 'gloghead' }, el('h3', {}, 'Growth'), state.events.length ? log : el('p', { class: 'empty' }, 'Nothing has grown yet: tick a Read paper done.'), more),
      st ? el('p', { class: 'foot' }, `Agents as of ${new Date(st.generated).toLocaleString()} · refreshed every 2 min by the loop`) : null);
    viewer.start();
    // An anthome tapped before this redraw (a poll, coming back to the tab) stays open, with its message box.
    const again = treePinnedAgent ? L.hills.findIndex((h) => h.agent && h.agent.name === treePinnedAgent) : -1;
    if (again >= 0) show(viewer.view.querySelector(`.hits [data-k="hill"][data-i="${again}"]`), true);
    animateAnts(viewer.view, L.hills, L.paths);
    const key = () => [...tree.sha].filter(([x]) => x.startsWith('personal/') || ['state/citations.json', 'state/status.json', 'state/messages.json', 'state/usage.json'].includes(x)).join();
    const before = key();
    setPoll(async () => {
      await loadTree();
      if (key() !== before && location.hash.startsWith('#/tree') && !main().querySelector('.gcreature input:focus')
        && !info.querySelector('details[open], .hmsg')) redraw();
    }, 60_000);
  }

  // Wide screens: the tree, small, in a right-hand panel on every page, scrolled to its foot.
  const wide = () => matchMedia('(min-width: 1100px)').matches;
  async function drawSide() {
    const side = $('#gside');
    if (!wide() || !cfg.token || /^#\/(tree|hills|settings)/.test(location.hash)) {
      side.hidden = true;
      document.body.classList.remove('with-side');
      if (cfg.token && !mineLoaded) await loadMine();        // so the first Mine, Tree or Hills opens at once
      return;
    }
    if (!mineLoaded) await loadMine();
    const state = growthState();
    const pic = el('a', { class: 'gmini', href: '#/tree', title: 'Open the tree' });
    pic.innerHTML = G.svg(state, { mini: true });
    side.replaceChildren(el('div', { class: 'gsidehead' }, el('a', { href: '#/tree' }, 'Tree'),
      el('span', { class: 'who' }, ` ${state.stage} · ${metres(state.height)}`,
        state.streak ? ` · ${state.streak} d · ${state.mult.toFixed(1)}x` : '')), pic);
    side.style.top = `${$('header.bar').offsetHeight}px`;
    side.hidden = false;
    document.body.classList.add('with-side');
    pic.scrollTop = pic.scrollHeight;
  }

  // Status: upcoming deadlines from Manual (open entries due within 14 days, or overdue).
  function deadlinesCard() {
    const soon = mine.entries.filter((e) => !e.done && e.deadline).map((e) => ({ e, d: dueInfo(e.deadline) }))
      .filter((x) => x.d.days <= 14).sort((a, b) => a.d.days - b.d.days);
    const label = Object.fromEntries(MINE_TABS);
    return el('section', { class: 'status-card deadlines' }, el('h3', {}, 'Upcoming deadlines ', el('span', { class: 'n' }, String(soon.length))),
      soon.length ? soon.map(({ e, d }) => el('a', { class: `dline ${d.level}`, href: `#/manual/${e.kind}` },
        el('b', {}, d.text), ' ', e.title || (e.files || [])[0] || 'note',
        el('span', { class: 'who' }, ` · ${label[e.kind]}${e.student ? ' · ' + e.student : ''}`)))
        : el('p', { class: 'empty' }, 'Nothing due in the next 14 days.'));
  }

  function showSettings(msg) {
    clearInterval(poller);
    const token = el('input', { type: 'password', autocomplete: 'off', placeholder: 'github_pat_…', value: cfg.token });
    const repo = el('input', { type: 'text', placeholder: 'owner/name', value: cfg.repo });
    const branch = el('input', { type: 'text', value: cfg.branch });
    main().replaceChildren(el('section', { class: 'settings' },
      el('h2', {}, 'Sign in'),
      msg ? el('p', { class: 'warn' }, msg) : null,
      el('p', {}, 'A fine-grained GitHub token with access to the loop repo only (Contents: read and write). ',
        'It stays in this browser.'),
      el('label', {}, 'Token', token), el('label', {}, 'Repository', repo), el('label', {}, 'Branch', branch),
      el('div', { class: 'row' },
        el('button', { class: 'primary', onclick: () => {
          safeSet('loop.token', token.value.trim());
          safeSet('loop.repo', repo.value.trim());
          safeSet('loop.branch', branch.value.trim() || 'main');
          location.hash = '#/list';
          route();
        } }, 'Save'),
        el('button', { class: 'ghost', onclick: () => { ['loop.token', 'loop.repo', 'loop.branch'].forEach((k) => safeSet(k, null)); showSettings('Signed out.'); } }, 'Sign out'))));
  }

  // quiet: a redraw after the background tree reload, which keeps the scroll position.
  // Over the weekly limit (the usage guard tripped; state/usage.json "held"): a banner on every tab. What Finbar sends
  // is still saved; the loop delivers it after the reset. Send buttons stay enabled.
  let heldNow = false;
  async function drawHeld() {
    const box = $('#held');
    const u = tree.paths.has('state/usage.json') ? await getJSON('state/usage.json').catch(() => null) : null;
    const was = heldNow;
    heldNow = !!(u && u.held);
    box.hidden = !heldNow;
    if (was !== heldNow && location.hash.startsWith('#/status')) route({ quiet: true });   // show or hide the Urgent ticks
    if (u && u.held) {
      box.textContent = `Weekly usage at ${Math.round(u.pct)}%: messages, answers and papers are saved and reach the agents `
        + `after the reset${u.resets ? ` (${String(u.resets).replace(/\s*\(.*\)$/, '')})` : ''}.`;
    }
  }

  async function route(opts) {
    if (!cfg.token || !cfg.repo) return showSettings();
    const quiet = !!(opts && opts.quiet);
    const hash = location.hash;
    const h = hash.replace(/^#\/?/, '').split('/');
    if (h[0] === 'mine') { location.replace(`#/manual${h[1] ? '/' + h[1] : ''}`); return; }   // the tab's old name
    if (h[0] === 'hills') { location.replace('#/tree'); return; }                               // the farm is under the tree
    refreshItem = null;
    if (!quiet) justSent = null;
    treeWasCached = false;
    try {
      const meta = ['status', 'permission', 'manual', 'tree'].includes(h[0]) ? h[0] : 'work';
      document.querySelectorAll('.meta a').forEach((a) => a.classList.toggle('on', a.dataset.meta === meta));
      if (h[0] === 'item' && h[1]) await showItem(h[1]);
      else if (h[0] === 'status') await showStatus();
      else if (h[0] === 'permission') await showPermission();
      else if (h[0] === 'manual') await showMine(h[1]);
      else if (h[0] === 'tree') await showTree();
      else if (h[0] === 'settings') showSettings();
      else await showList(h[0] === 'list' ? h[1] : null);
      if (!quiet) window.scrollTo(0, 0);
      drawSide().catch(() => {});
      drawHeld().catch(() => {});
      if (treeWasCached && !quiet) revalidate(hash);
    } catch (e) {
      if (e.status === 401 || e.status === 403 || e.status === 404) showSettings(`GitHub said ${e.message}. Check the token and repository.`);
      else main().replaceChildren(el('p', { class: 'warn' }, `Could not load: ${e.message}`), el('button', { class: 'ghost', onclick: route }, 'Try again'));
    }
  }

  async function revalidate(hash) {
    const root = tree.root;
    try { await loadTree(); } catch (e) { return; }
    const typing = document.activeElement && document.activeElement.closest('#main') && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (tree.root !== root && location.hash === hash && !typing) route({ quiet: true });
  }

  window.addEventListener('hashchange', route);
  let resizeTimer = null;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => drawSide().catch(() => {}), 300); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && tree.at && Date.now() - tree.at > 20_000) route({ quiet: true }); });
  $('#refresh').addEventListener('click', () => { tree.at = 0; route(); });
  route();
  window.LoopApp = { route, refresh: () => refreshItem && refreshItem() };
})();
