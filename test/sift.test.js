const { test } = require('node:test');
const assert = require('node:assert');
const { classify, siftMessages, threadHasProposal } = require('../src/sift');

test('classify: obvious chatter is dropped', () => {
  for (const t of ['lol', 'ok cool', 'thanks!', 'gn', 'haha yeah', '👍', 'ty']) {
    assert.strictEqual(classify(t), 'drop', `expected drop for "${t}"`);
  }
});

test('classify: too-short is dropped', () => {
  assert.strictEqual(classify('hi'), 'drop');
});

test('classify: verb + intent is a strong task', () => {
  assert.strictEqual(classify('can you send me the invoice tomorrow'), 'task');
  assert.strictEqual(classify("don't forget to call the dentist"), 'task');
});

test('classify: a single signal is ambiguous (goes to Haiku)', () => {
  assert.strictEqual(classify('need to figure this out'), 'maybe');
  assert.strictEqual(classify('review that later'), 'maybe');
});

test('classify: a plain statement with no chatter match stays permissive (maybe)', () => {
  assert.strictEqual(classify('the shoot is at 6pm friday at the venue'), 'maybe');
});

test('siftMessages: drops chatter, keeps strong tasks, asks Haiku on maybes', async () => {
  const messages = [
    { rowId: 1, text: 'lol ok' },                              // drop
    { rowId: 2, text: 'can you send me the deck tomorrow' },   // task (regex)
    { rowId: 3, text: 'the meeting moved to noon' },           // maybe -> Haiku
  ];
  // fake Haiku: only says "yes" for row 3
  const isTaskFn = async (text) => text.includes('meeting moved');
  const out = await siftMessages(messages, { isTaskFn });
  assert.deepStrictEqual(out.map((m) => m.rowId), [2, 3]);
  assert.strictEqual(out.find((m) => m.rowId === 2).via, 'regex');
  assert.strictEqual(out.find((m) => m.rowId === 3).via, 'haiku');
});

test('siftMessages: Haiku failure is fail-safe (maybe dropped, never throws)', async () => {
  const messages = [{ rowId: 9, text: 'the thing is happening' }];
  const isTaskFn = async () => { throw new Error('network down'); };
  const out = await siftMessages(messages, { isTaskFn });
  assert.deepStrictEqual(out, []);
});

// ── the "bare yes" tail ────────────────────────────────────────────────────────
test('classify: a bare confirmation is tagged confirm, not dropped', () => {
  for (const t of ['yeah ok', 'sounds good', 'that works', "i'll be there", 'for sure', 'confirmed']) {
    assert.strictEqual(classify(t), 'confirm', `expected confirm for "${t}"`);
  }
});

test('classify: real chatter is still dropped, not confused for a confirmation', () => {
  for (const t of ['lol ok', 'haha yeah', 'thanks!', 'ok cool']) {
    assert.strictEqual(classify(t), 'drop', `expected drop for "${t}"`);
  }
});

test('threadHasProposal: true when the window has a verb/intent/time cue', () => {
  assert.ok(threadHasProposal([{ text: 'can you shoot the event friday at 6' }]));
  assert.ok(threadHasProposal([{ text: 'therapy is at 2pm' }]));
  assert.ok(threadHasProposal([{ text: 'chatting' }, { text: 'need to grab the prescription' }]));
});

test('threadHasProposal: false for pure chatter windows', () => {
  assert.ok(!threadHasProposal([{ text: 'haha same' }, { text: 'lol' }]));
  assert.ok(!threadHasProposal([]));
  assert.ok(!threadHasProposal(null));
});

test('siftMessages: routes a confirmation through as via:confirm for thread gating', async () => {
  const out = await siftMessages([{ rowId: 5, text: 'sounds good' }], {});
  assert.deepStrictEqual(out.map((m) => m.rowId), [5]);
  assert.strictEqual(out[0].via, 'confirm');
});
