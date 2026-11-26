// Unit tests for tasks.js (the Tasks tab's logic): node --test tests/tasks.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../tasks.js');

const PR = 'https://github.com/physiomelinks/CUFLynx/pull/424';
const items = [
  { id: 'Q-0001', kind: 'question', section: 'question', links: [] },
  { id: 'R-0091', kind: 'review', section: 'answered', links: [] },
  { id: 'R-0099', kind: 'review', section: 'pr', links: [`${PR}/files`] },
];
const tasks = [{ id: 'T-0041', for: 'IMPLEMENT-x', status: 'doing' },
  { id: 'T-0050', for: 'HIGH-merge-coordination-3', status: 'waiting', pr: 'https://github.com/physiomelinks/CAM/pull/89' }];
const w = (on) => T.waitOf({ status: 'waiting', waiting_on: on }, items, tasks);

test('only an open, unanswered loop item is waiting on Finbar', () => {
  assert.deepEqual(w('Q-0001'), { kind: 'item', on: 'Q-0001', finbar: true, answered: false });
  assert.deepEqual(w('R-0091'), { kind: 'item', on: 'R-0091', finbar: false, answered: true });      // approved already
  assert.equal(w('C-0404').finbar, false);                                                         // not in the index
  assert.deepEqual(w(''), { kind: 'none', on: '', finbar: false });                                  // "waiting", not "Finbar"
});

test('a PR names the open review item that covers it; a task names its owner; anything else is text', () => {
  assert.deepEqual(w(PR), { kind: 'pr', on: PR, finbar: false, repo: 'CUFLynx', n: '424', review: 'R-0099' });
  assert.equal(w('https://github.com/o/r/pull/7').review, null);
  assert.deepEqual(w('T-0041'), { kind: 'task', on: 'T-0041', finbar: false, owner: 'IMPLEMENT-x', merge: null });
  assert.equal(w('T-0050').merge, 'CAM #89');                                                      // a merge task
  assert.deepEqual(w('CI on #424'), { kind: 'text', on: 'CI on #424', finbar: false });
});

test('agents are grouped under their live state; todo reads as queued', () => {
  const rows = [{ name: 'A', state: 'working' }, { name: 'B', state: 'blocked', items: ['Q-0001'] },
    { name: 'C', state: 'blocked', items: [], why: 'permission prompt in the session' }, { name: 'D', state: 'stalled', why: 'idle: parked until asked' }];
  assert.deepEqual(T.agentState('A', rows), { key: 'working', label: 'working now' });
  assert.deepEqual(T.agentState('B', rows), { key: 'blocked', label: 'blocked on Q-0001' });
  assert.deepEqual(T.agentState('C', rows), { key: 'blocked', label: 'blocked: permission prompt in the session' });
  assert.deepEqual(T.agentState('D', rows), { key: 'idle', label: 'idle: parked until asked' });
  assert.deepEqual(T.agentState('E', rows), { key: 'idle', label: 'idle: not seen recently' });
  assert.equal(T.STATUS_LABEL.todo, 'queued');
  assert.deepEqual(T.GROUPS.map(([k]) => k), ['working', 'blocked', 'idle']);
});
