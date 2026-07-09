#!/usr/bin/env node
// The "wakeup" entry point — now a 5-step pipeline with a human APPROVAL gate.
//
//   chat.db + Notion comms-log (new messages / emails since watermark)
//     0. DRAIN    → read Jonny's iMessage replies to past proposals; post the y's,
//                   drop the n's, reschedule the edits (approval loop close)
//     1. SCAN     → new inbound iMessages + new task-flagged emails
//     2. SIFT     → iMessage: regex→Haiku · email: already Claude-triaged (light)
//     3. SCHEDULE → Haiku → fully-scheduled TickTick payload (strict JSON, validated)
//     4. APPROVE  → text each proposal to Jonny's iMessage; autoApprove senders skip
//     (post happens on his "y", or immediately for autoApprove)
//   → advance watermarks
//
// SAFE BY DEFAULT: a dry run (scan/sift/schedule/dedup, then PRINT the proposals it
// would send). It does NOT text Jonny, does NOT post, does NOT advance anything.
// Run with `--post` (or POST=1) for the real loop — this is what launchd runs.
//
//   npm start            # dry run: show what it would propose
//   npm start -- --post  # for real: drain replies, send proposals, post approved

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(process.cwd(), '.env.local') });
require('dotenv').config();

const scan = require('./src/scan');
const store = require('./src/store');
const { siftMessages, threadHasProposal } = require('./src/sift');
const { isTask } = require('./src/haiku');
const { scheduleTask } = require('./src/schedule');
const { partitionScheduled } = require('./src/schema');
const { partitionDuplicates, dedupeWithinBatch } = require('./src/dedup');
const { lookupContact, lookupEmail, isKnownEmail } = require('./src/playbook');
const { applyLiveDriveTimes } = require('./src/drivetime');
const notion = require('./src/notion-intake');
const bb = require('./src/bluebubbles');
const approval = require('./src/approval');
const ticktick = require('./src/ticktick');

const POST = process.argv.includes('--post') || process.env.POST === '1';
const log = (...a) => console.log(...a);
const clip = (s) => String(s).slice(0, 50);

async function main() {
  const env = process.env;
  const statePath = scan.defaultState(env);
  const state = store.load(statePath);
  const contextWindow = Number(env.CONTEXT_WINDOW || 10);

  log(`[mode] ${POST ? 'LIVE (--post)' : 'DRY RUN (no send/post/advance)'}`);
  log(`[drivetime] ${env.GOOGLE_MAPS_API_KEY ? 'live Google Routes' : 'static table'}`);

  // ── 0. DRAIN — close the loop on past proposals ────────────────────────────────
  if (POST && bb.isConfigured(env)) {
    try { await drainReplies(state, statePath, env); }
    catch (e) { log(`[approve] reply drain skipped: ${e.message}`); }
  } else if (POST) {
    log('[approve] BlueBubbles not configured (BLUEBUBBLES_PASSWORD + APPROVAL_ADDRESS) — cannot send/read; will print instead');
  }

  // ── 1. SCAN (iMessage) + read email candidates ─────────────────────────────────
  const candidates = [];

  const { messages, maxRowId, watermark, totalNew, capped, copyPath } = scan.readNewMessages({ env, statePath });
  log(`[scan] ${totalNew} new inbound iMessages since ROWID ${watermark}; ${messages.length} kept${capped ? ' (capped)' : ''}`);
  const confirmed = await siftMessages(messages, { isTaskFn: (t) => isTask(t, env), minLength: Number(env.MIN_MESSAGE_LENGTH || 6) });
  log(`[sift] ${confirmed.length} of ${messages.length} iMessages look like tasks`);
  for (const m of confirmed) {
    let thread = [];
    try { thread = scan.readThreadWindow(copyPath, m.chatId, m.rowId, contextWindow); } catch {}
    if (m.via === 'confirm' && !threadHasProposal(thread)) {
      log(`[sift] confirm "${clip(m.text)}" — no open proposal in thread, skipped`);
      continue;
    }
    const contact = lookupContact(m.sender);
    candidates.push({ source: 'imessage', text: m.text, sender: m.sender, thread,
      contact, autoApprove: !!(contact || {}).autoApprove });
  }

  // email candidates from the Notion comms-log (already triaged)
  let emailCursor = state.approval.emailCursor || '';
  if (notion.isConfigured(env)) {
    try {
      const { candidates: emails, maxCursor } = await notion.readNewEmails({ env, cursorISO: emailCursor, isKnown: isKnownEmail });
      log(`[email] ${emails.length} task-flagged email(s) from Notion comms-log since ${emailCursor || 'beginning'}`);
      for (const c of emails) {
        const contact = lookupEmail(c.senderEmail);
        candidates.push({ source: 'email', text: c.text, sender: c.sender, thread: [],
          contact, autoApprove: !!(contact || {}).autoApprove, messageId: c.messageId });
      }
      emailCursor = maxCursor || emailCursor;
    } catch (e) { log(`[email] Notion read skipped: ${e.message}`); }
  } else {
    log('[email] Notion not configured (NOTION_TOKEN) — email source off');
  }

  if (!candidates.length) {
    log('[done] no new candidates.');
    if (POST) advanceWatermarks(state, statePath, maxRowId, emailCursor);
    return;
  }

  // ── 3. SCHEDULE each candidate → a validated task (or chain) ────────────────────
  const proposals = []; // { tasks, candidate }
  for (const c of candidates) {
    let items = [];
    try { items = await scheduleTask(c.text, { env, thread: c.thread, contact: c.contact }); }
    catch (e) { log(`[schedule] skip (bad JSON) "${clip(c.text)}": ${e.message}`); continue; }
    try { items = await applyLiveDriveTimes(items, { env }); }
    catch (e) { log(`[drivetime] live lookup skipped for "${clip(c.text)}": ${e.message}`); }
    const { valid, rejected } = partitionScheduled(items);
    for (const r of rejected) log(`[schedule] dropped invalid task from "${clip(c.text)}": ${r.errors.join('; ')}`);
    if (valid.length) proposals.push({ tasks: valid, candidate: c });
  }
  log(`[schedule] ${proposals.length} valid proposal(s) planned`);
  if (!proposals.length) { if (POST) advanceWatermarks(state, statePath, maxRowId, emailCursor); return; }

  // ── 4. DEDUP (within run + vs existing TickTick), then APPROVE ──────────────────
  // collapse repeats within this run by the primary task's title+time — keep the
  // FIRST occurrence of each (dedupeWithinBatch settles the canonical set; we then
  // pick one proposal per surviving key).
  const canonical = new Set(
    dedupeWithinBatch(proposals.map((p) => approval.primaryOf(p.tasks)))
      .map((t) => t && t.title + '|' + (t.startDate || '')),
  );
  const seenKeys = new Set();
  const deduped = proposals.filter((p) => {
    const t = approval.primaryOf(p.tasks);
    const key = t && t.title + '|' + (t.startDate || '');
    if (!canonical.has(key) || seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });
  if (deduped.length < proposals.length) log(`[dedup] collapsed ${proposals.length - deduped.length} repeat(s) within this run`);

  let existing = [];
  if (POST) {
    const pids = [...new Set(deduped.flatMap((p) => p.tasks.map((t) => t.projectId)))];
    for (const pid of pids) { try { existing = existing.concat(await ticktick.listProjectTasks(pid, env)); } catch {} }
  }
  const fresh = deduped.filter((p) => {
    const { duplicates } = partitionDuplicates([approval.primaryOf(p.tasks)], existing);
    if (duplicates.length) { log(`[dedup] skip duplicate of existing task: ${duplicates[0].title}`); return false; }
    return true;
  });

  if (!POST) {
    log(`\n[DRY RUN] would send ${fresh.length} proposal(s) to your iMessage (run with --post):\n`);
    fresh.forEach((p) => log(renderProposal(p)));
    log(`\n[dry run] nothing sent, nothing posted, watermark NOT advanced.`);
    return;
  }

  // LIVE: autoApprove → post now; everything else → send proposal + enqueue
  for (const p of fresh) {
    const primary = approval.primaryOf(p.tasks);
    if (p.candidate.autoApprove) {
      await postChain(p.tasks, env, `[auto:${p.candidate.sender || p.candidate.source}]`);
      logDecision(statePath, { decision: 'auto-approved', source: p.candidate.source, title: primary.title });
      continue;
    }
    if (!bb.isConfigured(env)) { log(`[approve] (no transport) would propose: ${primary.title}`); continue; }
    try {
      const id = store.nextProposalId(state);
      const meta = proposalMeta(p);
      const { guid } = await bb.sendText(approval.formatProposal(primary, id, meta), env);
      store.addPending(state, {
        id, proposalGuid: guid, sentAt: new Date().toISOString(), status: 'awaiting',
        tasks: p.tasks, source: p.candidate.source, sender: p.candidate.sender || '',
        sourceText: p.candidate.text, thread: p.candidate.thread || [],
      });
      log(`[approve] sent ${id}: ${primary.title}`);
    } catch (e) { log(`[approve] FAILED to send proposal for "${clip(primary.title)}": ${e.message}`); }
  }

  advanceWatermarks(state, statePath, maxRowId, emailCursor);
  store.save(statePath, { approval: state.approval });
  log('[done] live run complete.');
}

// ── DRAIN: read replies, act, resolve pending ─────────────────────────────────────
async function drainReplies(state, statePath, env) {
  const awaiting = store.listAwaiting(state);
  const cursor = Number(state.approval.cursor || 0);
  if (!awaiting.length) {
    // nothing pending — fast-forward the cursor so old history is never re-read
    store.setCursor(state, Date.now());
    store.save(statePath, { approval: state.approval });
    return;
  }
  const msgs = await bb.queryMessages({ afterMs: cursor, limit: 200 }, env);
  const { actions, unmatched, maxDate } = approval.collectDecisions(msgs, awaiting);
  for (const u of unmatched) log(`[approve] unmatched reply (ignored): "${clip(u)}"`);

  for (const a of actions) {
    const entry = store.getPending(state, a.id);
    if (!entry) continue;
    const primary = approval.primaryOf(entry.tasks) || {};
    if (a.decision === 'approve') {
      await postChain(entry.tasks, env, `[approved:${a.id}]`);
      logDecision(statePath, { decision: 'approved', id: a.id, source: entry.source, title: primary.title });
      store.resolvePending(state, a.id);
      try { await bb.sendText(`✅ added: ${primary.title}`, env); } catch {}
    } else if (a.decision === 'reject') {
      logDecision(statePath, { decision: 'rejected', id: a.id, source: entry.source });
      store.resolvePending(state, a.id);
    } else if (a.decision === 'snooze') {
      log(`[approve] ${a.id} snoozed — left pending`);
    } else if (a.decision === 'edit') {
      await handleEdit(state, statePath, env, entry, a.editText);
    } else {
      log(`[approve] ${a.id} — unclear reply, left pending`);
    }
  }
  if (maxDate) store.setCursor(state, maxDate);
  store.save(statePath, { approval: state.approval });
}

// An edit re-runs the scheduler with Jonny's correction and re-proposes (new id).
async function handleEdit(state, statePath, env, entry, editText) {
  store.resolvePending(state, entry.id); // retire the old proposal
  logDecision(statePath, { decision: 'edited', id: entry.id, correction: editText });
  const corrected = `${entry.sourceText}\n\nCORRECTION FROM JONNY: ${editText}`;
  let items = [];
  try {
    items = await scheduleTask(corrected, { env, thread: entry.thread || [], contact: null });
    items = await applyLiveDriveTimes(items, { env });
  } catch (e) {
    log(`[approve] edit reschedule failed for ${entry.id}: ${e.message}`);
    try { await bb.sendText(`⚠️ couldn't reschedule ${entry.id} — text it again?`, env); } catch {}
    return;
  }
  const { valid } = partitionScheduled(items);
  if (!valid.length) { try { await bb.sendText(`⚠️ your edit to ${entry.id} didn't produce a valid task — try again?`, env); } catch {} return; }
  const id = store.nextProposalId(state);
  const primary = approval.primaryOf(valid);
  const meta = proposalMeta({ tasks: valid, candidate: entry });
  try {
    const { guid } = await bb.sendText(approval.formatProposal(primary, id, meta), env);
    store.addPending(state, { id, proposalGuid: guid, sentAt: new Date().toISOString(), status: 'awaiting',
      tasks: valid, source: entry.source, sender: entry.sender, sourceText: entry.sourceText, thread: entry.thread || [] });
    log(`[approve] re-proposed as ${id} after edit of ${entry.id}: ${primary.title}`);
  } catch (e) { log(`[approve] failed to send edited proposal: ${e.message}`); }
}

// ── helpers ───────────────────────────────────────────────────────────────────
function proposalMeta(p) {
  const c = p.candidate || {};
  return { source: c.source, sender: c.sender, excerpt: c.text || c.sourceText, extraBlocks: p.tasks.length - 1 };
}

async function postChain(tasks, env, tag) {
  for (const t of tasks) {
    try { await ticktick.createTask(t, env); log(`[post] ${tag} created: ${t.title}`); }
    catch (e) { log(`[post] ${tag} FAILED: ${t.title} — ${e.message}`); }
  }
}

function advanceWatermarks(state, statePath, maxRowId, emailCursor) {
  state.approval.emailCursor = emailCursor || state.approval.emailCursor || '';
  store.save(statePath, { lastRowId: maxRowId, approval: state.approval });
  log(`[watermark] iMessage ROWID → ${maxRowId}${emailCursor ? `, email → ${emailCursor}` : ''}`);
}

function logDecision(statePath, entry) {
  try {
    const p = path.join(path.dirname(statePath), 'decisions.jsonl');
    fs.appendFileSync(p, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');
  } catch {}
}

function renderProposal(p) {
  const t = approval.primaryOf(p.tasks);
  const when = t.startDate ? `${t.startDate} → ${t.dueDate}` : '(undated)';
  const extra = p.tasks.length > 1 ? `  (+${p.tasks.length - 1} block${p.tasks.length > 2 ? 's' : ''})` : '';
  return `  • [${p.candidate.source}] ${t.title}\n      ${when}  p${t.priority ?? 0}${extra}`;
}

main().catch((e) => { console.error('[fatal]', e.message); process.exitCode = 1; });
