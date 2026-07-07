const { test } = require('node:test');
const assert = require('node:assert');
const { validateTaskCheck, validateScheduledTask, partitionScheduled } = require('../src/schema');

const PERSONAL = '699618ace9edd115282d1114';
const BOOKED_TT = '69c7aa7f5f7411209aedd74d';

test('validateTaskCheck: strict boolean', () => {
  assert.ok(validateTaskCheck({ is_task: true }).ok);
  assert.ok(validateTaskCheck({ is_task: false }).ok);
  assert.ok(!validateTaskCheck({ is_task: 'yes' }).ok);
  assert.ok(!validateTaskCheck({}).ok);
});

test('valid undated task passes', () => {
  const r = validateScheduledTask({ title: '📝 Review Resume', projectId: PERSONAL });
  assert.ok(r.ok, r.errors.join('; '));
});

test('valid timed task passes', () => {
  const r = validateScheduledTask({
    title: '🧠 Therapy Session', projectId: PERSONAL,
    startDate: '2026-07-09T14:00:00-07:00', dueDate: '2026-07-09T15:00:00-07:00',
    isAllDay: false, priority: 3, tags: ['appointment'],
  });
  assert.ok(r.ok, r.errors.join('; '));
});

test('title must start with an emoji', () => {
  const r = validateScheduledTask({ title: 'Review Resume', projectId: PERSONAL });
  assert.ok(!r.ok);
  assert.match(r.errors.join(), /emoji/);
});

test('retired project (BOOKED-tt) is rejected', () => {
  const r = validateScheduledTask({ title: '🎬 Shoot', projectId: BOOKED_TT });
  assert.ok(!r.ok);
  assert.match(r.errors.join(), /retired|banned/);
});

test('start without due is rejected; start must precede due', () => {
  assert.ok(!validateScheduledTask({ title: '🎬 X', projectId: PERSONAL, startDate: '2026-07-09T14:00:00-07:00' }).ok);
  const bad = validateScheduledTask({
    title: '🎬 X', projectId: PERSONAL,
    startDate: '2026-07-09T15:00:00-07:00', dueDate: '2026-07-09T14:00:00-07:00',
  });
  assert.ok(!bad.ok);
  assert.match(bad.errors.join(), /before/);
});

test('partitionScheduled splits valid from invalid', () => {
  const { valid, rejected } = partitionScheduled([
    { title: '📝 Do Thing', projectId: PERSONAL },
    { title: 'no emoji', projectId: PERSONAL },
    { title: '🎬 Bad Project', projectId: BOOKED_TT },
  ]);
  assert.strictEqual(valid.length, 1);
  assert.strictEqual(rejected.length, 2);
});
