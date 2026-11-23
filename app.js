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
  const getJSON = async (p) => (await gh(repoPath(p), { raw: true })).json();

  const blobCache = new Map();
  async function fileUrl(p) {
    if (!blobCache.has(p)) {
      blobCache.set(p, gh(repoPath(p), { raw: true }).then((r) => r.blob()).then((b) => URL.createObjectURL(b)));
    }
    return blobCache.get(p);
  }

  let tree = { paths: new Set(), sha: new Map(), at: 0 };
  async function loadTree() {
    const t = await (await gh(`/repos/${cfg.repo}/git/trees/${cfg.branch}?recursive=1`)).json();
    const blobs = t.tree.filter((x) => x.type === 'blob');
    tree = { paths: new Set(blobs.map((x) => x.path)), sha: new Map(blobs.map((x) => [x.path, x.sha])), at: Date.now() };
    return tree;
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
    }).then((r) => r.json()).then((j) => { if (j && j.content && j.content.sha) tree.sha.set(path, j.content.sha); }).catch(() => {});
    tree.paths.add(path);
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

  // A text box that takes images (attach, paste, drop). onSend(text, images) -> Promise.
  function composer({ placeholder, onSend, enterSends, sendLabel, extra }) {
    const imgs = [];
    const ta = el('textarea', { rows: 2, placeholder });
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
        await onSend(text, imgs.slice());
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
    box.append(extra ? extra.el : '', ta, thumbs,
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
    [index] = await Promise.all([getJSON('index.json'), loadTree()]);
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
        it.requests_open ? el('span', { class: 'badge wait' }, 'detail requested') : null,
        it.n_details ? el('span', { class: 'badge' }, `${it.n_details} detail`) : null,
        sent && !partial ? el('span', { class: 'badge ok' }, 'sent to LOOP') : null,
        el('span', { class: 'grow' }), el('span', { class: 'age' }, age(it.created))),
      el('div', { class: 'title', html: inline(it.title) }),
      el('div', { class: 'from' }, it.from.name, it.holds_up ? ` · holds up: ${it.holds_up}` : ''));
  }

  async function showList(tab) {
    await refreshIndex();
    const groups = Object.fromEntries(SECTIONS.map(([k]) => [k, []]));
    index.items.forEach((it) => { const s = sectionOf(it); if (groups[s]) groups[s].push(it); });
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
    return el('details', { class: 'detail revisit' },
      el('summary', {}, 'Revisit with the agent'),
      composer({
        placeholder: 'What should the agent look at again? Only this item is sent to it. Enter sends.',
        enterSends: true,
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

  // Open items in board order, for Next.
  function boardOrder() {
    const order = ['question', 'content', 'pr'];
    return index.items.filter((x) => order.includes(sectionOf(x)))
      .sort((a, b) => order.indexOf(sectionOf(a)) - order.indexOf(sectionOf(b)));
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
      el('div', { class: 'from' }, `From ${it.from.name}`, it.source === 'harvested' ? ' (found by the sweep)' : ''),
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
        qb, opts, note, thread,
        detailBox(id, { question: i, open: qs.length === 1 }, qs.length === 1 ? 'More detail before you answer?' : 'More detail on this question'));
    });
    const thread = el('section', { class: 'thread' });
    const answerPanel = el('section', { class: 'answer' });
    const redraw = async () => {
      await drawThread(thread, it, ctx, (x) => x.question == null);
      for (let i = 0; i < threads.length; i++) await drawThread(threads[i], it, ctx, (x) => x.question === i);
      await drawAnswers(answerPanel, it, qs, picks, notes, st);
    };
    await redraw();
    const generalBox = !['open'].includes(it.status) ? revisitBox(id)
      : qs.length ? null : detailBox(id, {}, 'More detail before you review?');
    main().replaceChildren(head, body, ...cards, thread, generalBox || '', answerPanel);
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
    return el('details', { class: 'detail', open: (where.open ?? where.quiz == null) ? true : null },
      el('summary', {}, label),
      composer({
        placeholder: 'What do you want to know before answering? Enter sends; Shift+Enter for a new line. Paste or attach images.',
        enterSends: true,
        sendLabel: 'Ask',
        onSend: async (text, imgs) => {
          await send('requests', id, { kind: 'detail', quiz: where.quiz ?? null, question: where.question ?? null, text }, imgs);
          if (refreshItem) await refreshItem();
        },
      }));
  }

  async function drawAnswers(box, it, qs, picks, notes, st) {
    const prev = filesIn(`answers/${it.id}`);
    const shown = [];
    for (const name of prev) {
      const a = await getJSON(`answers/${it.id}/${name}`).catch(() => null);
      if (!a) continue;
      const rows = (a.answers || []).filter((x) => x.choice || x.text).map((x) => el('div', { class: 'choice' },
        qs.length > 1 ? `${x.question + 1}. ` : '', x.choice || '', x.choice && x.text ? ' — ' : '', x.text || ''));
      shown.push(el('div', { class: 'given' }, el('div', { class: 'who' }, `Your answer · ${age(a.at)} ago`),
        ...rows, a.choice ? el('div', { class: 'choice' }, a.choice) : null,
        a.text ? el('div', { html: inline(a.text) }) : null,
        el('div', { class: 'thumbs' }, (a.images || []).map((n) => {
          const img = el('img', { alt: '' });
          fileUrl(`answers/${it.id}/${n}`).then((u) => { img.src = u; });
          return img;
        }))));
    }
    const done = el('div', { class: 'status' });
    let reviewChoice = null;
    let extra = null;
    if (it.kind === 'review') {
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
      sendLabel: it.kind === 'review' ? 'Send review' : prev.length ? 'Send follow-up' : qs.length > 1 ? 'Send answers' : 'Send answer',
      extra,
      onSend: async (text, imgs) => {
        const body = { kind: 'answer', text };
        if (it.kind === 'review') body.choice = reviewChoice;
        else {
          body.answers = qs.map((q, i) => ({ question: i, asked: q.text, choice: picks[i] || null, text: (notes[i] || '').trim() }));
          if (qs.length === 1) body.choice = picks[0] || null;
        }
        await send('answers', it.id, body, imgs);
        justSent = it.id;
        if (refreshItem) await refreshItem();
      },
    });
    box.replaceChildren(el('h3', {}, it.kind === 'review' ? 'Your review' : qs.length > 1 ? 'Send your answers' : 'Your answer'), ...shown, comp, sent);
  }

  // ------------------------------------------------------------ Status: usage and each agent's state

  function bar(pct) {
    const level = pct >= 90 ? 'hi' : pct >= 70 ? 'mid' : 'lo';
    return el('div', { class: 'ubar' }, el('div', { class: `ufill ${level}`, style: `width:${Math.min(100, pct)}%` }));
  }

  async function showStatus() {
    const [st] = await Promise.all([getJSON('state/status.json'), index.items.length ? null : refreshIndex()]);
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
    const label = { blocked: 'Blocked', working: 'Working', stalled: 'Stalled' };
    const sections = Object.keys(groups).map((k) => el('section', { class: 'status-card' },
      el('h3', {}, `${label[k]} `, el('span', { class: 'n' }, String(groups[k].length))),
      groups[k].length ? groups[k].map((r) => el('div', { class: `agent ${r.state}` },
        el('div', { class: 'arow' },
          el('span', { class: `dot ${r.running ? 'on' : 'off'}`, title: r.running ? 'running' : 'not running' }),
          el('b', {}, r.name), r.loop ? el('span', { class: 'badge' }, 'LOOP') : null,
          el('span', { class: 'grow' }),
          r.context_tokens ? el('span', { class: 'who' }, `${Math.round(r.context_tokens / 1000)}k ctx`) : null,
          r.model ? el('span', { class: 'who' }, ` · ${r.model}`) : null),
        r.items && r.items.length ? el('div', { class: 'alinks' }, r.state === 'blocked' ? 'Waiting on: ' : 'Will need (soon blocking): ', r.items.map((id) =>
          el('a', { href: `#/item/${id}`, class: 'alink' }, el('b', {}, id), titles.has(id) ? ` ${titles.get(id).slice(0, 70)}` : ''))) : null,
        r.why && !(r.items && r.items.length) ? el('div', { class: 'awhy' }, r.why) : null,
        r.working_on ? el('div', { class: 'adetail' }, el('span', { class: 'who' }, r.state === 'working' ? 'Working on: ' : 'Last: '), r.working_on) : null,
        el('div', { class: 'who' }, r.running ? '' : 'not running · ', r.updated ? `last active ${age(r.updated)} ago` : ''),
        (r.recent || []).length ? el('details', { class: 'arecent' }, el('summary', {}, `Its entries (${r.recent.length})`),
          el('div', { class: 'alinks' }, r.recent.map((x) => el('a', { href: `#/item/${x.id}`, class: 'alink' + (x.blocking_now ? ' blocking' : '') },
            el('b', {}, x.id), ` ${x.title.slice(0, 70)} `,
            el('span', { class: 'who' }, `${{ question: 'question', content: 'content', pr: 'review' }[x.tab] || x.tab}${['answered', 'closed'].includes(x.status) ? ' · ' + x.status : ''}`))))) : null,
        el('details', { class: 'detail amsg' }, el('summary', {}, `Message ${r.name}`),
          composer({
            placeholder: 'Guide this agent. It is typed into its session within seconds (or restarts it). Images welcome.',
            enterSends: false,
            sendLabel: 'Send',
            onSend: async (text, imgs) => { await send('messages', r.job, { kind: 'message', to: r.name, text }, imgs); },
          }))))
        : el('p', { class: 'empty' }, 'None.')));
    await loadMine().catch(() => {});
    main().replaceChildren(deadlinesCard(), usage, ...sections,
      el('p', { class: 'foot' }, `Updated ${new Date(st.generated).toLocaleString()} · refreshed every 2 min by the loop`));
    setPoll(async () => { if (location.hash.startsWith('#/status')) await showStatus(); }, 60_000);
  }

  // ------------------------------------------------------------ Mine: Read, Write, Students, Other
  // Finbar's own entries: personal/<id>/entry.json plus the files dropped with it. The app writes them;
  // loop-cron saves papers to Zotero and writes personal/<id>/zotero.json.

  const MINE_TABS = [['read', 'Read'], ['write', 'Write'], ['student', 'Students'], ['other', 'Other']];
  const PRIOS = [['high', 'High'], ['med', 'Medium'], ['low', 'Low']];
  let mine = { entries: [], zotero: {}, people: [], collections: [] };

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
    await loadTree();
    const ids = [...tree.paths].filter((p) => /^personal\/[^/]+\/entry\.json$/.test(p)).map((p) => p.split('/')[1]);
    const [entries, people, cols] = await Promise.all([
      Promise.all(ids.map((id) => getJSON(`personal/${id}/entry.json`).catch(() => null))),
      getJSON('state/people.json').catch(() => ({ students: [] })),
      getJSON('state/zotero_collections.json').catch(() => ({ collections: [] })),
    ]);
    const zot = {};
    await Promise.all(ids.filter((id) => tree.paths.has(`personal/${id}/zotero.json`)).map(async (id) => {
      zot[id] = await getJSON(`personal/${id}/zotero.json`).catch(() => null);
    }));
    mine = { entries: entries.filter(Boolean), zotero: zot, people: people.students || [], collections: cols.collections || [] };
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

  function fileLinks(e) {
    return (e.files || []).map((n) => el('a', { href: '#', class: 'flink', onclick: async (ev) => {
      ev.preventDefault();
      const u = await fileUrl(`personal/${e.id}/${n}`);
      window.open(u, '_blank');
    } }, n));
  }

  function entryRow(e, redraw, extra) {
    const done = el('input', { type: 'checkbox', title: 'done', onchange: async () => { e.done = done.checked; await saveEntry(e, `${e.id}: ${e.done ? 'done' : 'not done'}`); redraw(); } });
    done.checked = !!e.done;
    const prio = el('select', { class: 'prio', title: 'priority', onchange: async () => { e.priority = prio.value; await saveEntry(e, `${e.id}: priority`); redraw(); } },
      PRIOS.map(([k, l]) => el('option', { value: k, selected: e.priority === k ? true : null }, l)));
    const z = mine.zotero[e.id];
    const zb = e.kind === 'read' && e.zotero ? el('span', { class: `badge z ${z ? z.status : 'waiting'}`, title: (z && z.why) || '' },
      z && z.status === 'saved' ? `in Zotero: ${e.zotero.name || ''}` : z && z.status === 'error' ? 'Zotero: error' : `to Zotero: ${e.zotero.name || ''} (waiting)`) : null;
    return el('div', { class: 'mrow' + (e.done ? ' done' : '') },
      el('label', { class: 'mcheck' }, done),
      el('div', { class: 'mmain' },
        el('div', { class: 'mtitle' }, e.link ? el('a', { href: e.link, target: '_blank', rel: 'noopener' }, e.title || e.link) : (e.title || (e.files || [])[0] || 'note')),
        e.note ? el('div', { class: 'mnote', html: inline(e.note) }) : null,
        el('div', { class: 'mmeta' }, ...fileLinks(e), zb, extra || null, deadlineChip(e, redraw), prio),
        e.kind === 'read' ? paperExtras(e) : null));
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
    notes.addEventListener('toggle', async () => {
      if (!notes.open || loaded) return;
      loaded = true;
      if (tree.paths.has(notesPath)) ta.value = await (await gh(repoPath(notesPath), { raw: true })).text();
    });
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
    return el('div', { class: 'pextras' }, summary, notes);
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
          st.textContent = `Asked for "${path}": the loop creates it within about a minute…`;
          clearInterval(timer);
          timer = setInterval(async () => {
            const cols = (await getJSON('state/zotero_collections.json').catch(() => ({}))).collections || [];
            const made = cols.find((c) => c.name === path);
            if (made) { clearInterval(timer); mine.collections = cols; st.textContent = `Created "${path}".`; if (onMade) onMade(made); }
          }, 5000);
        } }, 'Create')), st));
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

  // The short form shown after a drop: title, Zotero collection (Read), deadline.
  function newEntryForm(kind, files, preset, redraw) {
    const title = el('input', { type: 'text', value: files.length === 1 ? files[0].name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ') : '', placeholder: 'Title' });
    const due = el('input', { type: 'date' });
    let colSel = null;
    const parts = [el('div', { class: 'who' }, files.map((f) => f.name).join(', ')), el('label', {}, 'Title', title)];
    if (kind === 'read') {
      const filter = el('input', { type: 'search', placeholder: `Filter ${mine.collections.length} Zotero collections…` });
      colSel = el('select', { size: 6, class: 'colsel' }, mine.collections.map((c) => el('option', { value: c.key }, c.name)));
      filter.addEventListener('input', () => {
        const q = filter.value.toLowerCase();
        [...colSel.options].forEach((o) => { o.hidden = q && !o.textContent.toLowerCase().includes(q); });
      });
      parts.push(el('label', {}, 'Save to Zotero collection', filter, colSel));
      parts.push(newCollectionForm(null, (c) => {
        if (![...colSel.options].some((o) => o.value === c.key)) colSel.append(el('option', { value: c.key }, c.name));
        colSel.value = c.key;
      }));
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
    const tabs = el('nav', { class: 'tabs' }, MINE_TABS.map(([k, l]) => el('a', { href: `#/mine/${k}`, class: k === tab ? 'on' : '' },
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
    main().replaceChildren(tabs, body, hist);
    setPoll(async () => {
      const before = [...tree.paths].filter((x) => x.startsWith('personal/')).join();
      await loadTree();
      if ([...tree.paths].filter((x) => x.startsWith('personal/')).join() !== before && !main().querySelector('.newentry input:focus, .newentry textarea:focus, .datein')) redraw();
    }, 30_000);
  }

  // Status: upcoming deadlines from Mine (open entries due within 14 days, or overdue).
  function deadlinesCard() {
    const soon = mine.entries.filter((e) => !e.done && e.deadline).map((e) => ({ e, d: dueInfo(e.deadline) }))
      .filter((x) => x.d.days <= 14).sort((a, b) => a.d.days - b.d.days);
    const label = Object.fromEntries(MINE_TABS);
    return el('section', { class: 'status-card deadlines' }, el('h3', {}, 'Upcoming deadlines ', el('span', { class: 'n' }, String(soon.length))),
      soon.length ? soon.map(({ e, d }) => el('a', { class: `dline ${d.level}`, href: `#/mine/${e.kind}` },
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

  async function route() {
    if (!cfg.token || !cfg.repo) return showSettings();
    const h = location.hash.replace(/^#\/?/, '').split('/');
    refreshItem = null;
    justSent = null;
    try {
      const meta = h[0] === 'status' ? 'status' : h[0] === 'mine' ? 'mine' : 'work';
      document.querySelectorAll('.meta a').forEach((a) => a.classList.toggle('on', a.dataset.meta === meta));
      if (h[0] === 'item' && h[1]) await showItem(h[1]);
      else if (h[0] === 'status') await showStatus();
      else if (h[0] === 'mine') await showMine(h[1]);
      else if (h[0] === 'settings') showSettings();
      else await showList(h[0] === 'list' ? h[1] : null);
      window.scrollTo(0, 0);
    } catch (e) {
      if (e.status === 401 || e.status === 403 || e.status === 404) showSettings(`GitHub said ${e.message}. Check the token and repository.`);
      else main().replaceChildren(el('p', { class: 'warn' }, `Could not load: ${e.message}`), el('button', { class: 'ghost', onclick: route }, 'Try again'));
    }
  }

  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && tree.at && Date.now() - tree.at > 20_000) route(); });
  $('#refresh').addEventListener('click', route);
  route();
  window.LoopApp = { route, refresh: () => refreshItem && refreshItem() };
})();
