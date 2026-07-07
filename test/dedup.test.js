const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeTitle, sameTime, isDuplicate, partitionDuplicates, dedupeWithinBatch } = require('../src/dedup');

test('normalizeTitle strips emoji + punctuation + case', () => {
  assert.strictEqual(normalizeTitle('🎬 MGK Shoot!'), 'mgk shoot');
  assert.strictEqual(normalizeTitle('📧 Email Trish — May Invoice'), 'email trish may invoice');
});

test('sameTime: undated matches undated, within window matches', () => {
  assert.ok(sameTime(null, null));
  assert.ok(!sameTime('2026-07-09T14:00:00-07:00', null));
  assert.ok(sameTime('2026-07-09T14:00:00-07:00', '2026-07-09T14:20:00-07:00', 30));
  assert.ok(!sameTime('2026-07-09T14:00:00-07:00', '2026-07-09T16:00:00-07:00', 30));
});

test('isDuplicate: same normalized title + close time', () => {
  const existing = [{ title: '🧠 Therapy Session', startDate: '2026-07-09T14:00:00-07:00' }];
  assert.ok(isDuplicate({ title: '🧠 Therapy Session', startDate: '2026-07-09T14:10:00-07:00' }, existing));
  assert.ok(!isDuplicate({ title: '🧠 Therapy Session', startDate: '2026-07-10T14:00:00-07:00' }, existing));
  assert.ok(!isDuplicate({ title: '🛒 Grocery Run', startDate: '2026-07-09T14:00:00-07:00' }, existing));
});

test('dedupeWithinBatch drops same-title repeats in one run (the double sunglasses)', () => {
  const out = dedupeWithinBatch([
    { title: "📮 Mail Richard's Sunglasses" },
    { title: "📬 Mail Richard's Sunglasses" },
    { title: '🧺 Do Laundry' },
  ]);
  assert.strictEqual(out.length, 2);
  assert.deepStrictEqual(out.map((t) => normalizeTitle(t.title)), ['mail richard s sunglasses', 'do laundry']);
});

test('partitionDuplicates separates fresh from dupes', () => {
  const existing = [{ title: '🧺 Do Laundry' }];
  const { fresh, duplicates } = partitionDuplicates(
    [{ title: '🧺 Do Laundry' }, { title: '📝 New Task' }],
    existing,
  );
  assert.strictEqual(fresh.length, 1);
  assert.strictEqual(duplicates.length, 1);
  assert.strictEqual(fresh[0].title, '📝 New Task');
});
