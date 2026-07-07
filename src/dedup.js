// Dedup: never double-add. A candidate is a duplicate of an existing TickTick task
// when their normalized titles match AND (both undated, or their start times are
// within a small window). Pure comparison so it's fully unit-testable.

// Normalize a title for comparison: strip the leading emoji, lowercase, drop
// punctuation, collapse whitespace. "🎬 MGK Shoot!" -> "mgk shoot".
function normalizeTitle(title) {
  return String(title || '')
    .replace(/^\s*\p{Extended_Pictographic}+\s*/u, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Same clock time within `windowMin` minutes (default 30). Undated matches undated.
function sameTime(aStart, bStart, windowMin = 30) {
  if (!aStart && !bStart) return true;
  if (!aStart || !bStart) return false;
  const da = new Date(aStart).getTime();
  const db = new Date(bStart).getTime();
  if (Number.isNaN(da) || Number.isNaN(db)) return false;
  return Math.abs(da - db) <= windowMin * 60 * 1000;
}

function isDuplicate(candidate, existingTasks, windowMin = 30) {
  const nc = normalizeTitle(candidate.title);
  if (!nc) return false;
  return existingTasks.some((e) =>
    normalizeTitle(e.title) === nc && sameTime(candidate.startDate, e.startDate, windowMin));
}

// Split candidates into {fresh, duplicates} against a pool of existing tasks.
function partitionDuplicates(candidates, existingTasks, windowMin = 30) {
  const fresh = [], duplicates = [];
  for (const c of candidates) {
    if (isDuplicate(c, existingTasks, windowMin)) duplicates.push(c);
    else fresh.push(c);
  }
  return { fresh, duplicates };
}

module.exports = { normalizeTitle, sameTime, isDuplicate, partitionDuplicates };
