// The approval brain — SOURCE-AGNOSTIC. It doesn't know or care whether a task
// came from iMessage or email; it only formats a proposal and interprets Jonny's
// reply. All the functions here are PURE (no I/O), so the whole decision layer is
// unit-tested against fixtures. The effectful glue (send, post, reschedule) lives
// in index.js and injects the transport.
//
// The loop:
//   1. a planned task → formatProposal() → sent to Jonny's iMessage (a proposal)
//   2. Jonny replies in the thread — three ways, in priority order:
//        • tapback   👍/👎 on the proposal  (associatedMessageType)
//        • inline reply (long-press → Reply) → threadOriginatorGuid
//        • plain text ("A3 yes", "no", "edit 3pm and put in VPH")
//   3. collectDecisions() matches each reply to a pending proposal and returns a
//      decision: approve | reject | snooze | edit(instruction)

const { PROJECT_NAMES } = require('./schema');

const TZ = 'America/Los_Angeles';
const BOT_MARKER = '🤖 intake';

// Tapback integers (BlueBubbles / IMCore). 2000s = added, 3000s = removed.
const TAPBACK = { LOVE: 2000, LIKE: 2001, DISLIKE: 2002, LAUGH: 2003, EMPHASIZE: 2004, QUESTION: 2005 };
const TAPBACK_APPROVE = new Set([TAPBACK.LOVE, TAPBACK.LIKE]);
const TAPBACK_REJECT = new Set([TAPBACK.DISLIKE]);

// A 👍 or ❤️ on a proposal approves it; 👎 rejects. Everything else (laugh,
// emphasize, question, or any removal in the 3000s) is not a decision.
function parseTapback(type) {
  if (TAPBACK_APPROVE.has(type)) return 'approve';
  if (TAPBACK_REJECT.has(type)) return 'reject';
  return null;
}

// ── reply-text parsing ─────────────────────────────────────────────────────────
// A "pure yes / pure no / pure snooze" reply is a clean decision. ANYTHING else
// substantive is treated as an EDIT instruction — safe by design: an edit re-runs
// the scheduler with Jonny's correction and re-asks, so a misread just bounces back
// for another confirm rather than posting the wrong thing.
// AFFIRM includes action-intent verbs ("do it", "add it", "send it"). These are
// safe as approvals because any real correction ("add Trish", "make it 3pm") also
// carries a non-filler word, which fails the allIn() guard and drops to 'edit'.
const AFFIRM = new Set(['y', 'ye', 'yes', 'yea', 'yeah', 'yep', 'yup', 'ya', 'yah', 'ok', 'okay', 'k', 'kk', 'sure', 'approve', 'approved', 'good', 'bet', 'word', 'confirm', 'confirmed', 'do', 'add', 'send', 'book', 'go', '👍', '✅', '🙏', '💯', '👌', '❤️', '🔥']);
const DENY = new Set(['n', 'no', 'nope', 'nah', 'naw', 'skip', 'drop', 'delete', 'cancel', 'pass', 'nvm', '👎', '❌', '🚫', '🙅']);
const SNOOZE = new Set(['snooze', 'later', 'wait', 'hold', 'pending', 'pause']);
// filler words allowed to ride along with a decision word ("sounds good", "do it")
const FILLER = new Set(['please', 'pls', 'plz', 'thanks', 'thx', 'ty', 'it', 'that', 'this', 'one', 'sounds', 'sound', 'fine', 'cool', 'the', 'a', 'em', 'all', 'them']);

function tokenize(text) {
  return String(text || '').toLowerCase().match(/\p{L}+|\p{Extended_Pictographic}/gu) || [];
}

// Returns { decision: 'approve'|'reject'|'snooze'|'edit'|'unknown', editText }
function parseReply(text) {
  const raw = String(text || '').trim();
  const toks = tokenize(raw);
  if (!toks.length) return { decision: 'unknown', editText: '' };

  const allIn = (set) => toks.every((t) => set.has(t) || FILLER.has(t));
  const anyIn = (set) => toks.some((t) => set.has(t));

  if (anyIn(AFFIRM) && allIn(AFFIRM)) return { decision: 'approve', editText: '' };
  if (anyIn(DENY) && allIn(DENY)) return { decision: 'reject', editText: '' };
  if (anyIn(SNOOZE) && allIn(SNOOZE)) return { decision: 'snooze', editText: '' };
  // substantive reply → a correction to fold back into the scheduler
  return { decision: 'edit', editText: raw };
}

// An explicit "A7" id if Jonny typed one (fallback matching for plain replies).
function extractProposalId(text) {
  const m = String(text || '').match(/\b[Aa](\d{1,6})\b/);
  return m ? 'A' + m[1] : null;
}

// ── proposal formatting ─────────────────────────────────────────────────────────
function fmtRange(task) {
  if (!task.startDate) return '🗓 undated (no time set)';
  try {
    const start = new Date(task.startDate);
    const end = task.dueDate ? new Date(task.dueDate) : null;
    const day = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: TZ });
    const time = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ });
    if (!end) return `🗓 ${day.format(start)} · ${time.format(start)}`;
    const sameDay = day.format(start) === day.format(end);
    return sameDay
      ? `🗓 ${day.format(start)} · ${time.format(start)}–${time.format(end)}`
      : `🗓 ${day.format(start)} ${time.format(start)} → ${day.format(end)} ${time.format(end)}`;
  } catch { return '🗓 (date parse error)'; }
}

function sourceLabel(meta = {}) {
  const via = meta.source === 'email' ? 'email' : meta.source === 'imessage' ? 'iMessage' : (meta.source || '');
  const who = meta.sender ? ` from ${meta.sender}` : '';
  return via ? `via ${via}${who}` : (who ? who.trim() : '');
}

// The message Jonny actually receives. Scannable on a lock screen; branded so the
// self-thread reads like a bot inbox, not him talking to himself.
function formatProposal(task, id, meta = {}) {
  const proj = PROJECT_NAMES[task.projectId] || 'Inbox?';
  const prio = task.priority ? ` · P${task.priority}` : '';
  const src = sourceLabel(meta);
  const lines = [
    `${BOT_MARKER} · ${id} · needs your ok`,
    task.title,
    fmtRange(task),
    `📁 ${proj}${prio}${src ? ` · ${src}` : ''}`,
  ];
  // an away-event schedules a chain (get-ready → travel → event → drive home); the
  // proposal represents the whole chain as ONE decision.
  if (meta.extraBlocks > 0) lines.push(`   + ${meta.extraBlocks} prep/travel block${meta.extraBlocks > 1 ? 's' : ''}`);
  if (meta.excerpt) lines.push(`“${String(meta.excerpt).slice(0, 140)}”`);
  lines.push('↩︎ reply  y / n / edit <change>   (or 👍 / 👎)');
  return lines.join('\n');
}

// Is this message one of OUR proposals (not a reply from Jonny)? Both sides of a
// self-thread are isFromMe, so we identify proposals by guid or the bot marker.
function isOwnProposal(msg, proposalGuids) {
  if (msg.guid && proposalGuids.has(msg.guid)) return true;
  return typeof msg.text === 'string' && msg.text.startsWith(BOT_MARKER);
}

// ── matching replies → pending proposals ────────────────────────────────────────
// Given the messages read since the cursor and the current state, produce an
// ordered list of { id, decision, editText } actions and the newest timestamp seen
// (to advance the cursor). Pure: no posting happens here.
function collectDecisions(messages, awaiting) {
  const byGuid = new Map();
  for (const p of awaiting) if (p.proposalGuid) byGuid.set(p.proposalGuid, p);
  const proposalGuids = new Set(awaiting.map((p) => p.proposalGuid).filter(Boolean));
  const byId = new Map(awaiting.map((p) => [p.id, p]));

  const actions = [];
  const unmatched = [];
  let maxDate = 0;

  for (const msg of messages) {
    maxDate = Math.max(maxDate, msg.dateCreated || 0);
    if (isOwnProposal(msg, proposalGuids)) continue;

    // 1) tapback on a specific proposal
    if (msg.tapbackToGuid && byGuid.has(msg.tapbackToGuid)) {
      const decision = parseTapback(msg.tapbackType);
      if (decision) { actions.push({ id: byGuid.get(msg.tapbackToGuid).id, decision, editText: '' }); }
      continue;
    }
    if (msg.tapbackType) continue; // a tapback we don't act on (laugh, removal, on a non-proposal)

    // 2) inline reply to a specific proposal
    if (msg.replyToGuid && byGuid.has(msg.replyToGuid)) {
      const { decision, editText } = parseReply(msg.text);
      actions.push({ id: byGuid.get(msg.replyToGuid).id, decision, editText });
      continue;
    }

    // 3) plain text — match by explicit id, else the sole pending proposal
    if (!msg.text) continue;
    const explicit = extractProposalId(msg.text);
    let entry = null;
    if (explicit && byId.has(explicit)) entry = byId.get(explicit);
    else if (awaiting.length === 1) entry = awaiting[0];

    if (!entry) { unmatched.push(msg.text); continue; }
    // strip a leading "A7" id token before parsing the decision
    const body = explicit ? msg.text.replace(/\b[Aa]\d{1,6}\b/, '').trim() : msg.text;
    const { decision, editText } = parseReply(body || msg.text);
    actions.push({ id: entry.id, decision, editText });
  }

  return { actions, unmatched, maxDate };
}

// A candidate can schedule a CHAIN (get-ready 👔 → travel 🚗 → event → drive home 🚗).
// The "primary" task — the one Jonny recognizes — is the first non-travel/prep block.
const CHAIN_PREFIXES = ['🚗', '👔'];
function primaryOf(tasks) {
  if (!Array.isArray(tasks) || !tasks.length) return null;
  const event = tasks.find((t) => t && t.title && !CHAIN_PREFIXES.some((p) => t.title.startsWith(p)));
  return event || tasks[0];
}

module.exports = {
  TZ, BOT_MARKER, TAPBACK,
  parseTapback, parseReply, extractProposalId,
  fmtRange, sourceLabel, formatProposal, isOwnProposal, collectDecisions, primaryOf,
};
