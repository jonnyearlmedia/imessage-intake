// Source #2 — EMAIL, read from Jonny's Notion "Communications Log".
//
// His Make scenario already ingests every email (both inboxes) and has Claude
// triage it at intake, writing rich fields: Classification, Action Needed/Type,
// Waiting On, Extracted Dates, Priority, Sender, Message ID. So we don't touch
// Gmail at all — we just query the rows already flagged as real action items and
// hand them to the same SIFT-lite → SCHEDULE → APPROVE spine as iMessage.
//
// Auth is a single Notion integration token (no OAuth/console). The heavy lifting
// (page→row extraction, the gate, row→candidate) is PURE so it's unit-testable
// without hitting Notion.

const COMMS_DB_ID = '9231f18e-510e-4bdd-b846-0b9d92946e52'; // Communications Log
const NOTION_VERSION = '2022-06-28';

// Triage buckets that count as "a task for Jonny". Deliberately conservative — he
// said "there isn't much I want": dr appts, VPH/Trish to-dos, appointments.
const CLASS_TASK = new Set(['Task', 'Assignment', 'Opportunity']);
const CLASS_DROP = new Set(['Newsletter', 'Receipt', 'Shipping']);
const WAITING_TASK = new Set(['Jonny', 'Trish']);
const ACTION_TASK = new Set([
  'Follow-up Needed', 'Deliverable Request', 'Invoice / Payment', 'Scheduling / RSVP',
  'Approval Request', 'Logistics Check', 'Reply Needed', 'Proceed with Shoot',
]);

function isConfigured(env = process.env) {
  return !!env.NOTION_TOKEN && (env.EMAIL_INTAKE_ENABLED !== '0');
}
function dbId(env = process.env) {
  return env.NOTION_COMMS_DB_ID || COMMS_DB_ID;
}

// ── pure: Notion page → flat row ────────────────────────────────────────────────
function rt(prop) {
  if (!prop) return '';
  const arr = prop.rich_text || prop.title || [];
  return arr.map((t) => t.plain_text || '').join('').trim();
}
function sel(prop) { return prop && prop.select ? prop.select.name : ''; }
function chk(prop) { return !!(prop && prop.checkbox); }
function dt(prop) { return prop && prop.date ? prop.date.start : ''; }

function pageToRow(page) {
  const p = page.properties || {};
  return {
    pageId: page.id,
    createdTime: page.created_time,
    messageId: rt(p['Message ID']) || page.id,
    direction: sel(p['Direction']),
    classification: sel(p['Classification']),
    actionNeeded: chk(p['Action Needed']),
    actionType: sel(p['Action Type']),
    waitingOn: sel(p['Waiting On']),
    priority: sel(p['Priority']),
    account: sel(p['Account']),
    senderName: rt(p['Sender Name']),
    senderEmail: (p['Sender Email'] && p['Sender Email'].email) || '',
    subject: rt(p['Subject']),
    shortSummary: rt(p['Short Summary']),
    detailedSummary: rt(p['Detailed Summary']),
    extractedDates: rt(p['Extracted Dates']),
    followUpDate: dt(p['Follow-up Date']),
    receivedAt: dt(p['Received At']) || page.created_time,
    permalink: (p['Permalink'] && p['Permalink'].url) || '',
  };
}

// ── pure: the conservative gate ─────────────────────────────────────────────────
// isKnown(email) lets a playbook sender (Trish, a clinic) always pass.
function passesEmailGate(row, isKnown = () => false) {
  if (row.direction && row.direction !== 'Incoming') return false;
  if (CLASS_DROP.has(row.classification)) return false;
  const taskish = CLASS_TASK.has(row.classification) || row.actionNeeded;
  if (!taskish) return false;
  const pointedAtJonny =
    WAITING_TASK.has(row.waitingOn) ||
    ACTION_TASK.has(row.actionType) ||
    !!row.extractedDates ||
    !!row.followUpDate ||
    isKnown(row.senderEmail);
  return pointedAtJonny;
}

// ── pure: row → candidate the scheduler can read ────────────────────────────────
// We synthesize a natural-language task description from the triage fields so the
// existing Haiku scheduler (built for free-text) needs no email-specific path.
function rowToCandidate(row) {
  const who = row.senderName || row.senderEmail || 'someone';
  const summary = row.detailedSummary || row.shortSummary || row.subject || '';
  const parts = [
    `Email from ${who}${row.account ? ` (${row.account} inbox)` : ''}.`,
    row.subject ? `Subject: ${row.subject}.` : '',
    summary,
    row.extractedDates ? `Dates mentioned: ${row.extractedDates}.` : '',
    row.followUpDate ? `Follow-up date: ${row.followUpDate}.` : '',
    row.actionType && row.actionType !== 'No action' ? `Action: ${row.actionType}.` : '',
  ].filter(Boolean);
  return {
    source: 'email',
    messageId: row.messageId,
    sender: who,
    senderEmail: row.senderEmail,
    account: row.account,
    text: parts.join(' '),
    receivedAt: row.receivedAt,
    createdTime: row.createdTime,
    hint: { classification: row.classification, actionType: row.actionType, priority: row.priority },
  };
}

// ── I/O: query the DB for rows newer than the cursor ────────────────────────────
async function queryDatabase(env, cursorISO, fetchImpl = fetch) {
  const filter = {
    and: [
      { property: 'Direction', select: { equals: 'Incoming' } },
      { or: [
        { property: 'Classification', select: { equals: 'Task' } },
        { property: 'Classification', select: { equals: 'Assignment' } },
        { property: 'Classification', select: { equals: 'Opportunity' } },
        { property: 'Action Needed', checkbox: { equals: true } },
      ] },
    ],
  };
  if (cursorISO) filter.and.push({ timestamp: 'created_time', created_time: { after: cursorISO } });

  const out = [];
  let start_cursor;
  for (let guard = 0; guard < 20; guard++) { // page cap so a first run can't run away
    const body = {
      filter,
      sorts: [{ timestamp: 'created_time', direction: 'ascending' }],
      page_size: 50,
    };
    if (start_cursor) body.start_cursor = start_cursor;
    const r = await fetchImpl(`https://api.notion.com/v1/databases/${dbId(env)}/query`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Notion query failed: ${r.status} ${await r.text()}`);
    const d = await r.json();
    out.push(...(d.results || []));
    if (!d.has_more) break;
    start_cursor = d.next_cursor;
  }
  return out;
}

// Returns { candidates, maxCursor, seenIds } — maxCursor advances the email
// watermark; seenIds guards against reprocessing a boundary row next run.
async function readNewEmails({ env = process.env, cursorISO = '', isKnown, seen = new Set() } = {}, fetchImpl = fetch) {
  const pages = await queryDatabase(env, cursorISO, fetchImpl);
  let maxCursor = cursorISO || '';
  const candidates = [];
  for (const page of pages) {
    const row = pageToRow(page);
    if (row.createdTime > maxCursor) maxCursor = row.createdTime;
    if (seen.has(row.messageId)) continue;          // already processed (boundary dupe)
    if (!passesEmailGate(row, isKnown)) continue;
    candidates.push(rowToCandidate(row));
  }
  return { candidates, maxCursor };
}

module.exports = {
  COMMS_DB_ID, isConfigured, dbId,
  pageToRow, passesEmailGate, rowToCandidate, readNewEmails,
};
