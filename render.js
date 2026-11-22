// Block templates for loop items: text, figure, file, provenance, quiz, checklist.
// LoopRender.blocks(container, blocks, ctx) renders a list of blocks into container.
// ctx.fileUrl(name) -> Promise<url> resolves a file stored beside the item.
// ctx.detailBox(opts) -> element: a "More detail" box (used per quiz question).
// ctx.store: a namespace for remembered per-item state (quiz picks, checklist ticks).
(function () {
  'use strict';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      e.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return e;
  }

  // ------------------------------------------------------------ markdown (a small, escaping subset)

  function math(tex, display) {
    try {
      return window.katex.renderToString(tex, { displayMode: display, throwOnError: false });
    } catch (e) {
      return `<code>${esc(tex)}</code>`;
    }
  }

  function inline(s) {
    const keep = [];
    const stash = (html) => `\u0000${keep.push(html) - 1}\u0000`;
    s = s.replace(/`([^`]+)`/g, (_, c) => stash(`<code>${esc(c)}</code>`));
    s = s.replace(/\$\$([^$]+)\$\$/g, (_, t) => stash(math(t, true)));
    s = s.replace(/(^|[^\\\w])\$([^$\s](?:[^$]*[^$\s])?)\$/g, (_, pre, t) => pre + stash(math(t, false)));
    s = esc(s);
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
      (_, t, u) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`);
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
      (_, pre, u) => `${pre}<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[+i]);
  }

  function md(text) {
    const lines = String(text ?? '').replace(/\r/g, '').split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^```/.test(line)) {
        const buf = [];
        for (i++; i < lines.length && !/^```/.test(lines[i]); i++) buf.push(lines[i]);
        i++;
        out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      } else if (/^\$\$\s*$/.test(line)) {
        const buf = [];
        for (i++; i < lines.length && !/^\$\$\s*$/.test(lines[i]); i++) buf.push(lines[i]);
        i++;
        out.push(`<div class="math">${math(buf.join('\n'), true)}</div>`);
      } else if (/^#{1,4}\s/.test(line)) {
        const n = line.match(/^#+/)[0].length;
        out.push(`<h${n + 2}>${inline(line.replace(/^#+\s*/, ''))}</h${n + 2}>`);
        i++;
      } else if (/^\s*\|.*\|\s*$/.test(line)) {
        const rows = [];
        for (; i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]); i++) rows.push(lines[i]);
        const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        const head = cells(rows[0]);
        const body = rows.slice(/^[\s|:-]+$/.test(rows[1] || '') ? 2 : 1).map(cells);
        out.push('<div class="tablewrap"><table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('')
          + '</tr></thead><tbody>' + body.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('')
          + '</tr>').join('') + '</tbody></table></div>');
      } else if (/^\s*([-*]|\d+\.)\s/.test(line)) {
        const ordered = /^\s*\d+\./.test(line);
        const items = [];
        for (; i < lines.length && /^\s*([-*]|\d+\.)\s|^\s{2,}\S/.test(lines[i]); i++) {
          if (/^\s*([-*]|\d+\.)\s/.test(lines[i])) items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s/, ''));
          else items[items.length - 1] += ' ' + lines[i].trim();
        }
        const tag = ordered ? 'ol' : 'ul';
        out.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${tag}>`);
      } else if (/^>\s?/.test(line)) {
        const buf = [];
        for (; i < lines.length && /^>\s?/.test(lines[i]); i++) buf.push(lines[i].replace(/^>\s?/, ''));
        out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
      } else if (!line.trim()) {
        i++;
      } else {
        const buf = [];
        for (; i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*\||\s*([-*]|\d+\.)\s|>|\$\$\s*$)/.test(lines[i]); i++) {
          buf.push(lines[i]);
        }
        if (!buf.length) { buf.push(lines[i]); i++; }
        out.push(`<p>${inline(buf.join(' '))}</p>`);
      }
    }
    return out.join('\n');
  }

  // ------------------------------------------------------------ blocks

  const MARK_LABEL = {
    calibrated: 'calibrated', measured: 'measured', derived: 'derived', inherited: 'inherited',
    set_by_hand: 'set by hand', unclassified: 'unclassified',
  };

  function figure(b, ctx) {
    const img = el('img', { alt: b.alt || b.caption || '', loading: 'lazy' });
    const box = el('figure', { class: 'figure' }, img, b.caption ? el('figcaption', { html: inline(b.caption) }) : null);
    ctx.fileUrl(b.src).then((u) => {
      img.src = u;
      img.addEventListener('click', () => window.open(u, '_blank'));
    }).catch(() => box.append(el('p', { class: 'warn' }, `Could not load ${b.src}`)));
    return box;
  }

  function fileBlock(b) {
    const start = +(b.start || (String(b.ref).match(/:(\d+)/) || [])[1] || 1);
    const lines = String(b.code).replace(/\n$/, '').split('\n');
    const hl = new Set((b.highlight || []).map(Number));
    const pre = el('pre', { class: 'code' });
    lines.forEach((l, k) => {
      const n = start + k;
      pre.append(el('span', { class: 'ln' + (hl.has(n) ? ' hl' : '') }, el('i', {}, String(n)), l + '\n'));
    });
    return el('div', { class: 'file' }, el('div', { class: 'ref' }, b.ref), pre,
      b.note ? el('div', { class: 'note', html: inline(b.note) }) : null);
  }

  function provBox(title, mark, lines, kind) {
    const more = lines.length > 4;
    const ul = el('ul', {}, lines.slice(0, 4).map((l) => el('li', { html: inline(l) })));
    const box = el('div', { class: `pbox ${mark || 'none'} ${kind || ''}` },
      el('div', { class: 'ptitle' }, el('span', {}, title),
        mark ? el('span', { class: `mark ${mark}` }, MARK_LABEL[mark] || mark) : null),
      ul);
    if (more) {
      const btn = el('button', { class: 'link', onclick: () => {
        ul.replaceChildren(...lines.map((l) => el('li', { html: inline(l) })));
        btn.remove();
      } }, `show all ${lines.length} lines`);
      box.append(btn);
    }
    return box;
  }

  function topo(nodes, edges) {
    const indeg = new Map(nodes.map((n) => [n.id, 0]));
    edges.forEach((e) => indeg.set(e.to, (indeg.get(e.to) || 0) + 1));
    const order = [];
    const ready = nodes.filter((n) => !indeg.get(n.id));
    const byId = new Map(nodes.map((n) => [n.id, n]));
    while (ready.length) {
      const n = ready.shift();
      order.push(n);
      edges.filter((e) => e.from === n.id).forEach((e) => {
        indeg.set(e.to, indeg.get(e.to) - 1);
        if (!indeg.get(e.to) && byId.has(e.to)) ready.push(byId.get(e.to));
      });
    }
    nodes.forEach((n) => { if (!order.includes(n)) order.push(n); });
    return order;
  }

  function provenance(b, ctx) {
    const wrap = el('section', { class: 'prov' }, el('h3', {}, b.title || 'How this result was produced'));
    const flow = el('div', { class: 'flow' });
    wrap.append(flow);
    const draw = (steps, meta) => {
      steps.forEach((s, k) => {
        if (k) flow.append(el('div', { class: 'arrow', 'aria-hidden': 'true' }, s.via ? el('span', {}, s.via) : null));
        flow.append(provBox(s.title, s.mark, s.lines, s.kind));
      });
      wrap.append(el('div', { class: 'pmeta' },
        meta.output_dir ? el('div', {}, 'Output: ', el('code', {}, meta.output_dir)) : null,
        meta.commit ? el('div', {}, 'Commit: ', el('code', {}, meta.commit)) : null));
      wrap.append(el('div', { class: 'legend' }, Object.keys(MARK_LABEL).map((m) => el('span', { class: `mark ${m}` }, MARK_LABEL[m]))));
    };
    if (b.graph) {
      ctx.fileUrl(b.graph).then((u) => fetch(u)).then((r) => r.json()).then((g) => {
        const ins = new Map();
        (g.edges || []).forEach((e) => { if (e.label) ins.set(e.to, e.label); });
        const steps = topo(g.nodes || [], g.edges || []).map((n) => ({
          title: n.title, mark: n.mark, lines: n.lines || [], kind: n.kind, via: ins.get(n.id),
        }));
        const code = g.code || {};
        draw(steps, {
          output_dir: b.output_dir || (g.workflow || {}).output_dir,
          commit: b.commit || [(code.libcuflynx_git || {}).commit && `libcuflynx ${code.libcuflynx_git.commit.slice(0, 10)}`,
            (code.project_git || {}).commit && `project ${code.project_git.commit.slice(0, 10)}`].filter(Boolean).join(', '),
        });
      }).catch(() => wrap.append(el('p', { class: 'warn' }, `Could not load ${b.graph}`)));
    } else {
      draw((b.steps || []).map((s) => ({
        title: s.name, mark: s.mark, kind: s.kind,
        lines: [s.does, s.detail].concat(s.lines || []).filter(Boolean),
      })), b);
    }
    return wrap;
  }

  function quiz(b, ctx) {
    const qs = b.questions || [];
    const key = 'quiz';
    const picks = ctx.store.get(key) || {};
    const score = el('div', { class: 'score' });
    const wrap = el('section', { class: 'quiz' });
    const update = () => {
      const done = Object.keys(picks).length;
      const right = Object.entries(picks).filter(([j, p]) => qs[j] && qs[j].correct === p).length;
      score.replaceChildren(`Score: ${right} / ${done} answered (of ${qs.length})`,
        el('button', { class: 'link', onclick: () => {
          for (const k of Object.keys(picks)) delete picks[k];
          ctx.store.set(key, picks);
          render();
        } }, 'start again'));
    };
    const render = () => {
      wrap.replaceChildren(el('div', { class: 'qhead' }, el('h3', {}, b.title || 'Check your understanding'), score));
      qs.forEach((q, j) => {
        const card = el('div', { class: 'qcard' });
        card.append(el('div', { class: 'qtext', html: `<b>${j + 1}.</b> ` + inline(q.q) }));
        if (q.show && q.show.length) {
          const show = el('div', { class: 'show' });
          LoopRender.blocks(show, q.show, ctx);
          card.append(show);
        }
        const opts = el('div', { class: 'opts' });
        const why = el('div', { class: 'why' });
        const reveal = (p) => {
          [...opts.children].forEach((btn, k) => {
            btn.disabled = true;
            btn.classList.toggle('right', k === q.correct);
            btn.classList.toggle('wrong', k === p && p !== q.correct);
          });
          why.innerHTML = `<b>${p === q.correct ? 'Right.' : 'Not quite.'}</b> ${inline(q.why)}`
            + (q.ref ? ` <span class="ref">${esc(q.ref)}</span>` : '');
        };
        q.options.forEach((o, k) => opts.append(el('button', {
          class: 'opt', onclick: () => { picks[j] = k; ctx.store.set(key, picks); reveal(k); update(); },
        }, el('b', {}, 'ABCD'[k] + '. '), el('span', { html: inline(o) }))));
        card.append(opts, why);
        if (ctx.detailBox) card.append(ctx.detailBox({ quiz: j, label: 'More detail on this question' }));
        if (picks[j] != null) reveal(picks[j]);
        wrap.append(card);
      });
      update();
    };
    render();
    return wrap;
  }

  function checklist(b, ctx) {
    const ticks = ctx.store.get('checklist') || {};
    return el('section', { class: 'checklist' }, el('h3', {}, b.title || 'Before you merge'),
      el('ul', {}, (b.items || []).map((t, k) => {
        const cb = el('input', { type: 'checkbox', onchange: () => { ticks[k] = cb.checked; ctx.store.set('checklist', ticks); } });
        cb.checked = !!ticks[k];
        return el('li', {}, el('label', {}, cb, el('span', { html: inline(t) })));
      })));
  }

  const LoopRender = {
    esc, el, md, inline,
    block(b, ctx) {
      switch (b.type) {
        case 'text': return el('div', { class: 'md', html: md(b.md) });
        case 'figure': case 'image': return figure(b, ctx);
        case 'file': return fileBlock(b);
        case 'provenance': return provenance(b, ctx);
        case 'quiz': return quiz(b, ctx);
        case 'checklist': return checklist(b, ctx);
        default: return el('p', { class: 'warn' }, `Unknown block ${b.type}`);
      }
    },
    blocks(container, blocks, ctx) {
      for (const b of blocks || []) container.append(LoopRender.block(b, ctx));
    },
  };
  window.LoopRender = LoopRender;
})();
