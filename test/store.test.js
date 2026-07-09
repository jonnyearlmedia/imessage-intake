const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../src/store');

function tmpState() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'store-')), 'state.json');
}

test('load — missing file returns default shape', () => {
  const s = store.load(path.join(os.tmpdir(), 'does-not-exist-xyz.json'));
  assert.equal(s.lastRowId, 0);
  assert.deepEqual(s.approval.pending, {});
  assert.equal(s.approval.seq, 0);
});

test('normalize — upgrades an old { lastRowId } file', () => {
  const p = tmpState();
  fs.writeFileSync(p, JSON.stringify({ lastRowId: 42 }));
  const s = store.load(p);
  assert.equal(s.lastRowId, 42);
  assert.deepEqual(s.approval.pending, {});
});

test('save — merges without clobbering sibling keys', () => {
  const p = tmpState();
  // simulate scan advancing the watermark
  store.save(p, { lastRowId: 100 });
  // now the approval loop writes pending — must NOT drop lastRowId
  const s = store.load(p);
  store.addPending(s, { id: 'A1', task: { title: 'x' }, proposalGuid: 'g1', sentAt: '2026-07-08T00:00:00Z' });
  store.save(p, { approval: s.approval });

  const after = store.load(p);
  assert.equal(after.lastRowId, 100, 'watermark preserved');
  assert.ok(after.approval.pending.A1, 'pending preserved');

  // and advancing the watermark again must NOT drop pending
  store.save(p, { lastRowId: 200 });
  const final = store.load(p);
  assert.equal(final.lastRowId, 200);
  assert.ok(final.approval.pending.A1, 'pending survives a watermark write');
});

test('nextProposalId — monotonic', () => {
  const s = store.defaultState();
  assert.equal(store.nextProposalId(s), 'A1');
  assert.equal(store.nextProposalId(s), 'A2');
  assert.equal(s.approval.seq, 2);
});

test('pending lifecycle — add, list awaiting, resolve', () => {
  const s = store.defaultState();
  store.addPending(s, { id: 'A1', sentAt: '2026-07-08T00:00:01Z', task: {} });
  store.addPending(s, { id: 'A2', sentAt: '2026-07-08T00:00:02Z', task: {} });
  assert.equal(store.listAwaiting(s).length, 2);
  assert.equal(store.listAwaiting(s)[0].id, 'A1', 'oldest first');

  store.resolvePending(s, 'A1');
  const awaiting = store.listAwaiting(s);
  assert.equal(awaiting.length, 1);
  assert.equal(awaiting[0].id, 'A2');
});
