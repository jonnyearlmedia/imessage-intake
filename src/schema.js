// Strict JSON schemas + validators for every machine-readable boundary in the
// pipeline. Pure functions, no deps — so they're trivially unit-testable and the
// same validation runs in tests and in production. A failed validation NEVER
// throws into the pipeline; callers get {ok:false, errors} and skip+log the item.

const LIVE_PROJECT_IDS = new Set([
  '699618ace9edd115282d1114', // Personal
  '69c84865fb1b112958a4b6d5', // VPH
  '6a28e8818f084696cd480594', // MATH-182
  '699760fcc71c71000000097f', // School Admin
  '699626b3c71c7100000004d9', // Admin
  '69962017c71c71000000005e', // Chores
]);

// Retired / hidden — a task routed here is a hard reject (never post).
const BANNED_PROJECT_IDS = new Set([
  '69c7aa7f5f7411209aedd74d', // BOOKED-tt
  '69b91cf5ebdf7a0000000434', // UNAVAILABLE
  '69b91c69ebdf7a00000003fa', // Internship / Berk's Beans (done)
]);

const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

// { is_task: boolean } — the sift Haiku check.
function validateTaskCheck(obj) {
  const errors = [];
  if (obj === null || typeof obj !== 'object') errors.push('not an object');
  else if (typeof obj.is_task !== 'boolean') errors.push('is_task must be boolean');
  return { ok: errors.length === 0, errors };
}

// One scheduled TickTick task from the scheduler. Validated before it can be posted.
function validateScheduledTask(t) {
  const errors = [];
  const push = (m) => errors.push(m);

  if (t === null || typeof t !== 'object') return { ok: false, errors: ['not an object'] };

  if (typeof t.title !== 'string' || !t.title.trim()) push('title required');
  else if (!/^\p{Extended_Pictographic}/u.test(t.title.trim())) push('title must start with an emoji');

  if (typeof t.projectId !== 'string') push('projectId required');
  else if (BANNED_PROJECT_IDS.has(t.projectId)) push(`projectId ${t.projectId} is retired/banned`);
  else if (!LIVE_PROJECT_IDS.has(t.projectId)) push(`projectId ${t.projectId} is not a live project`);

  const hasStart = t.startDate != null;
  const hasDue = t.dueDate != null;
  // Dates are optional (undated task) but if one is present both must be, valid, and start < due.
  if (hasStart || hasDue) {
    if (!hasStart || !hasDue) push('startDate and dueDate must both be set or both omitted');
    if (hasStart && !ISO_WITH_OFFSET.test(String(t.startDate))) push('startDate not ISO-8601 with offset');
    if (hasDue && !ISO_WITH_OFFSET.test(String(t.dueDate))) push('dueDate not ISO-8601 with offset');
    if (hasStart && hasDue && ISO_WITH_OFFSET.test(String(t.startDate)) && ISO_WITH_OFFSET.test(String(t.dueDate))) {
      if (new Date(t.startDate).getTime() >= new Date(t.dueDate).getTime()) push('startDate must be before dueDate');
    }
    if (t.isAllDay === true) push('timed task cannot be isAllDay:true');
  }

  if (t.priority != null && ![0, 1, 3, 5].includes(t.priority)) push('priority must be 0|1|3|5');
  if (t.tags != null && !Array.isArray(t.tags)) push('tags must be an array');
  if (t.reminders != null && !Array.isArray(t.reminders)) push('reminders must be an array');

  return { ok: errors.length === 0, errors };
}

// A whole scheduler response = array of scheduled tasks. Returns the valid subset
// plus the rejects (with reasons) so the caller can post the good ones and log the bad.
function partitionScheduled(arr) {
  if (!Array.isArray(arr)) return { valid: [], rejected: [{ item: arr, errors: ['response is not an array'] }] };
  const valid = [], rejected = [];
  for (const item of arr) {
    const r = validateScheduledTask(item);
    if (r.ok) valid.push(item);
    else rejected.push({ item, errors: r.errors });
  }
  return { valid, rejected };
}

module.exports = {
  LIVE_PROJECT_IDS,
  BANNED_PROJECT_IDS,
  validateTaskCheck,
  validateScheduledTask,
  partitionScheduled,
};
