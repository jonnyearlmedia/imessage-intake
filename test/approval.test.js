const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseReply, parseTapback, extractProposalId,
  formatProposal, isOwnProposal, collectDecisions, BOT_MARKER, TAPBACK,
} = require('../src/approval');

test('parseReply — pure affirmations approve', () => {
  for (const t of ['y', 'yes', 'yeah', 'yep', 'ok', 'sure', '👍', '✅', 'yeah do it', 'sounds good', 'approve', 'do it please']) {
    assert.equal(parseReply(t).decision, 'approve', `"${t}" should approve`);
  }
});

test('parseReply — pure negations reject', () => {
  for (const t of ['n', 'no', 'nope', 'nah', 'skip', 'drop', '👎', '❌', 'no thanks', 'cancel']) {
    assert.equal(parseReply(t).decision, 'reject', `"${t}" should reject`);
  }
});

test('parseReply — snooze words', () => {
  for (const t of ['snooze', 'later', 'wait', 'hold']) {
    assert.equal(parseReply(t).decision, 'snooze', `"${t}" should snooze`);
  }
});

test('parseReply — substantive replies are edits carrying the full text', () => {
  const cases = ['no make it 3pm', 'put it in VPH', '3pm not 2', 'change to Fairfield and add Trish', 'actually next week'];
  for (const t of cases) {
    const r = parseReply(t);
    assert.equal(r.decision, 'edit', `"${t}" should edit`);
    assert.equal(r.editText, t, 'edit text preserved verbatim');
  }
});

test('parseReply — empty is unknown', () => {
  assert.equal(parseReply('').decision, 'unknown');
  assert.equal(parseReply('   ').decision, 'unknown');
});

test('parseTapback — 👍/❤️ approve, 👎 reject, others null', () => {
  assert.equal(parseTapback(TAPBACK.LOVE), 'approve');
  assert.equal(parseTapback(TAPBACK.LIKE), 'approve');
  assert.equal(parseTapback(TAPBACK.DISLIKE), 'reject');
  assert.equal(parseTapback(TAPBACK.LAUGH), null);
  assert.equal(parseTapback(3000), null); // a removed love
  assert.equal(parseTapback(0), null);
});

test('extractProposalId', () => {
  assert.equal(extractProposalId('A7 yes'), 'A7');
  assert.equal(extractProposalId('yes A12 do it'), 'A12');
  assert.equal(extractProposalId('yes'), null);
});

test('formatProposal — branded, scannable, names the project', () => {
  const task = { title: '📸 Shoot Concert', projectId: '699618ace9edd115282d1114', priority: 3,
    startDate: '2026-07-11T14:00:00-07:00', dueDate: '2026-07-11T16:00:00-07:00' };
  const msg = formatProposal(task, 'A3', { source: 'imessage', sender: 'Marcus', excerpt: 'shoot the concert sat 2pm' });
  assert.ok(msg.startsWith(BOT_MARKER), 'starts with bot marker');
  assert.ok(msg.includes('A3'));
  assert.ok(msg.includes('📸 Shoot Concert'));
  assert.ok(msg.includes('Personal'), 'project name, not raw id');
  assert.ok(msg.includes('P3'));
  assert.ok(/iMessage from Marcus/.test(msg));
});

test('isOwnProposal — detects our sent proposals in a self-thread', () => {
  const guids = new Set(['g1']);
  assert.equal(isOwnProposal({ guid: 'g1', text: 'anything' }, guids), true);
  assert.equal(isOwnProposal({ guid: 'x', text: `${BOT_MARKER} · A9 · needs your ok` }, guids), true);
  assert.equal(isOwnProposal({ guid: 'x', text: 'yes' }, guids), false);
});

test('collectDecisions — tapback on a specific proposal', () => {
  const awaiting = [{ id: 'A1', proposalGuid: 'g1' }, { id: 'A2', proposalGuid: 'g2' }];
  const msgs = [{ guid: 'r1', text: '', dateCreated: 10, tapbackToGuid: 'g1', tapbackType: TAPBACK.LOVE }];
  const { actions } = collectDecisions(msgs, awaiting);
  assert.deepEqual(actions, [{ id: 'A1', decision: 'approve', editText: '' }]);
});

test('collectDecisions — inline reply routes by threadOriginator', () => {
  const awaiting = [{ id: 'A1', proposalGuid: 'g1' }, { id: 'A2', proposalGuid: 'g2' }];
  const msgs = [{ guid: 'r1', text: 'no', dateCreated: 20, replyToGuid: 'g2' }];
  const { actions } = collectDecisions(msgs, awaiting);
  assert.deepEqual(actions, [{ id: 'A2', decision: 'reject', editText: '' }]);
});

test('collectDecisions — our own proposal echo is ignored', () => {
  const awaiting = [{ id: 'A1', proposalGuid: 'g1' }];
  const msgs = [
    { guid: 'g1', text: `${BOT_MARKER} · A1 · needs your ok`, dateCreated: 5 },
    { guid: 'r1', text: 'yes', dateCreated: 6 },
  ];
  const { actions } = collectDecisions(msgs, awaiting);
  assert.deepEqual(actions, [{ id: 'A1', decision: 'approve', editText: '' }]);
});

test('collectDecisions — plain text is ambiguous with >1 pending, matched with id', () => {
  const awaiting = [{ id: 'A1', proposalGuid: 'g1' }, { id: 'A2', proposalGuid: 'g2' }];
  const ambiguous = collectDecisions([{ guid: 'r', text: 'yes', dateCreated: 1 }], awaiting);
  assert.equal(ambiguous.actions.length, 0);
  assert.equal(ambiguous.unmatched.length, 1);

  const explicit = collectDecisions([{ guid: 'r', text: 'A2 yes', dateCreated: 2 }], awaiting);
  assert.deepEqual(explicit.actions, [{ id: 'A2', decision: 'approve', editText: '' }]);
});

test('collectDecisions — plain text with a single pending needs no id', () => {
  const awaiting = [{ id: 'A5', proposalGuid: 'g5' }];
  const { actions } = collectDecisions([{ guid: 'r', text: 'make it 3pm', dateCreated: 9 }], awaiting);
  assert.deepEqual(actions, [{ id: 'A5', decision: 'edit', editText: 'make it 3pm' }]);
});

test('collectDecisions — advances cursor to newest message seen', () => {
  const awaiting = [{ id: 'A1', proposalGuid: 'g1' }];
  const { maxDate } = collectDecisions([
    { guid: 'a', text: 'x', dateCreated: 100 },
    { guid: 'b', text: 'y', dateCreated: 250 },
  ], awaiting);
  assert.equal(maxDate, 250);
});
