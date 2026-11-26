// The Tasks tab's logic: what a waiting task waits on, and the live state each agent's tasks are shown under.
// Pure functions of state/tasks.json, index.json and state/status.json. Loaded in the browser (window.LoopTasks)
// and by Node (tests/tasks.test.js).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LoopTasks = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const ITEM = /^[QRC]-\d+$/;
  const TASK = /^T-\d+$/;
  const PR = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i;
  const OPEN = ['question', 'content', 'pr'];
  // todo reads as "queued": a queue behind a working agent is not a stall.
  const STATUS_LABEL = { todo: 'queued', doing: 'doing', waiting: 'waiting', done: 'done' };
  const GROUPS = [['working', 'Working now'], ['blocked', 'Blocked'], ['idle', 'Idle']];

  const prKey = (url) => { const m = PR.exec(url || ''); return m ? `${m[1]}/${m[2]}#${m[3]}`.toLowerCase() : null; };

  // What waiting task `t` waits on -> {kind: item | pr | task | text | none, on, finbar, review?, owner?, merge?, repo?, n?}.
  // Only an open, unanswered loop item is Finbar's to act on (finbar: true). A PR names the open review item that
  // covers it, if any (an approved PR has a merge task, which waits name instead); a task names its owner, and a
  // merge task (one with a `pr`) the PR it merges. items: index.json items; tasks: all tasks.
  function waitOf(t, items, tasks) {
    const on = t.waiting_on || '';
    if (!on) return { kind: 'none', on, finbar: false };
    if (ITEM.test(on)) {
      const it = items.find((x) => x.id === on);
      return { kind: 'item', on, finbar: !!it && OPEN.includes(it.section), answered: !!it && !OPEN.includes(it.section) };
    }
    const pr = PR.exec(on);
    if (pr) {
      const key = prKey(on);
      const review = items.find((x) => x.kind === 'review' && OPEN.includes(x.section) && (x.links || []).some((l) => prKey(l) === key));
      return { kind: 'pr', on, finbar: false, repo: pr[2], n: pr[3], review: review ? review.id : null };
    }
    if (TASK.test(on)) {
      const other = tasks.find((x) => x.id === on);
      const m = other && PR.exec(other.pr || '');
      return { kind: 'task', on, finbar: false, owner: other ? other.for : null, merge: m ? `${m[2]} #${m[3]}` : null };
    }
    return { kind: 'text', on, finbar: false };
  }

  // The live state an agent's tasks are shown under -> {key: working | blocked | idle, label}. rows: status.json agents.
  function agentState(name, rows) {
    const r = (rows || []).find((x) => x.name === name);
    if (!r) return { key: 'idle', label: 'idle: not seen recently' };
    if (r.state === 'working') return { key: 'working', label: 'working now' };
    if (r.state === 'blocked') return { key: 'blocked', label: r.items && r.items.length ? `blocked on ${r.items.join(', ')}` : `blocked: ${r.why || 'waiting'}` };
    return { key: 'idle', label: `idle${r.why ? `: ${r.why.replace(/^idle: /, '')}` : ''}` };
  }

  return { STATUS_LABEL, GROUPS, waitOf, agentState, prKey };
});
