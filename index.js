#!/usr/bin/env node
// The "wakeup" entry point — runs the 4 steps in order.
//
// SAFE BY DEFAULT: a dry run. It scans, sifts, schedules, and dedups, then PRINTS
// the tasks it would create — it does NOT post to TickTick and does NOT advance the
// watermark. To actually post, run with `--post` (or POST=1). Only a real posting
// run advances the watermark.
//
//   npm start            # dry run: show what it would do
//   npm start -- --post  # for real: create tasks in TickTick

const path = require('path');
require('dotenv').config({ path: path.join(process.cwd(), '.env.local') });
require('dotenv').config(); // also load .env if present, without overriding

const scan = require('./src/scan');
const { siftMessages } = require('./src/sift');
const { isTask } = require('./src/haiku');
const { scheduleTask } = require('./src/schedule');
const { partitionScheduled } = require('./src/schema');
const { partitionDuplicates } = require('./src/dedup');
const ticktick = require('./src/ticktick');

const POST = process.argv.includes('--post') || process.env.POST === '1';

function log(...a) { console.log(...a); }

async function main() {
  const env = process.env;

  const contextWindow = Number(env.CONTEXT_WINDOW || 10);

  // 1. SCAN
  const { messages, maxRowId, watermark, totalNew, capped, statePath, copyPath } = scan.readNewMessages({ env });
  log(`[scan] ${totalNew} new inbound since ROWID ${watermark}; ${messages.length} kept for sifting${capped ? ' (capped to recent slice — raise MAX_MESSAGES to reach further back)' : ''}`);
  if (!messages.length) { log('[done] nothing to sift.'); return; }

  // 2. SIFT (regex gate → Haiku only on the maybes)
  const confirmed = await siftMessages(messages, { isTaskFn: (t) => isTask(t, env), minLength: Number(env.MIN_MESSAGE_LENGTH || 6) });
  log(`[sift] ${confirmed.length} of ${messages.length} look like tasks`);
  if (!confirmed.length) { log('[done] no tasks found.'); advance(); return; }

  // 3. SCHEDULE (one Haiku call per task → strict JSON → validate)
  const planned = [];
  for (const m of confirmed) {
    // pull the surrounding thread (both directions) so the scheduler has context:
    // multi-turn plans, and things Jonny already handled in his replies.
    let thread = [];
    try { thread = scan.readThreadWindow(copyPath, m.chatId, m.rowId, contextWindow); } catch {}
    let items = [];
    try { items = await scheduleTask(m.text, { env, thread }); }
    catch (e) { log(`[schedule] skip (bad JSON) "${clip(m.text)}": ${e.message}`); continue; }
    const { valid, rejected } = partitionScheduled(items);
    for (const r of rejected) log(`[schedule] dropped invalid task from "${clip(m.text)}": ${r.errors.join('; ')}`);
    for (const v of valid) planned.push(v);
  }
  log(`[schedule] ${planned.length} valid task object(s) planned`);
  if (!planned.length) { log('[done] nothing valid to post.'); advance(); return; }

  // 4. DEDUP (pull existing tasks in the involved projects, drop matches)
  const projectIds = [...new Set(planned.map((t) => t.projectId))];
  let existing = [];
  if (POST) {
    for (const pid of projectIds) {
      try { existing = existing.concat(await ticktick.listProjectTasks(pid, env)); } catch {}
    }
  }
  const { fresh, duplicates } = partitionDuplicates(planned, existing);
  duplicates.forEach((d) => log(`[dedup] skip duplicate: ${d.title}`));

  // POST or DRY-RUN
  if (!POST) {
    log(`\n[DRY RUN] would create ${fresh.length} task(s) (run with --post to actually create):\n`);
    fresh.forEach((t) => log(render(t)));
    log(`\n[dry run] watermark NOT advanced. Re-run with --post when the output looks right.`);
    return;
  }

  let created = 0;
  for (const t of fresh) {
    try { await ticktick.createTask(t, env); created++; log(`[post] created: ${t.title}`); }
    catch (e) { log(`[post] FAILED: ${t.title} — ${e.message}`); }
  }
  log(`[post] created ${created}/${fresh.length}`);
  advance();

  function advance() {
    if (!POST) return; // dry runs never move the watermark
    scan.saveWatermark(statePath, maxRowId);
    log(`[watermark] advanced to ROWID ${maxRowId}`);
  }
}

function clip(s) { return String(s).slice(0, 50); }
function render(t) {
  const when = t.startDate ? `${t.startDate} → ${t.dueDate}` : '(undated)';
  const tags = t.tags && t.tags.length ? ` #${t.tags.join(' #')}` : '';
  return `  • ${t.title}\n      ${when}  p${t.priority ?? 0}${tags}`;
}

main().catch((e) => { console.error('[fatal]', e.message); process.exitCode = 1; });
