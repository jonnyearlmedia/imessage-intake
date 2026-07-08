// Trish relay — read Jonny's 1:1 iMessage thread with Trish (BOTH directions) from
// a read-only COPY of chat.db, past a SEPARATE watermark from the task pipeline.
//
// This is the source half of the "texts with Trish → Communications Log" feed. It
// does NOT filter to inbound and does NOT try to guess tasks — it captures every
// message in the one thread (his and hers) so the cloud webhook can log + triage it.
// Its own state file (state.trish.json) keeps it fully independent of index.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { extractText } = require('./scan');

const DEFAULT_DB = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
// Apple's Core Data epoch (2001-01-01 UTC) in unix ms. message.date is ns since then.
const APPLE_EPOCH_MS = 978307200000;

const last10 = (s) => ((String(s || '').match(/\d/g) || []).join('').slice(-10));

function defaultState(env = process.env) {
  return env.TRISH_STATE_PATH || path.join(process.cwd(), 'state.trish.json');
}
function loadWatermark(statePath) {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')).lastRowId || 0; }
  catch { return 0; }
}
function saveWatermark(statePath, lastRowId) {
  fs.writeFileSync(statePath, JSON.stringify({ lastRowId }, null, 2));
}

// message.date → ISO string. Modern macOS stores nanoseconds since 2001; older
// builds stored seconds. Detect by magnitude and normalize to ms.
function appleDateToISO(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n > 1e12 ? Math.round(n / 1e6) : n * 1000; // ns vs seconds
  return new Date(ms + APPLE_EPOCH_MS).toISOString();
}

// Find the ROWIDs of chats that are the 1:1 direct thread with Trish.
// style 45 = direct (1:1), 43 = group — we want ONLY the direct thread so group
// chats Trish happens to be in never leak in. Matched on the last 10 digits of the
// handle so formatting (+1, spaces, dashes) never matters.
function findTrishChatIds(db, trishNumber) {
  const want = last10(trishNumber);
  if (!want) return [];
  const handles = db.prepare(`SELECT ROWID as id, id as addr FROM handle`).all();
  const handleIds = handles.filter((h) => last10(h.addr) === want).map((h) => h.id);
  if (!handleIds.length) return [];
  const ph = handleIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT DISTINCT chj.chat_id AS chatId
    FROM chat_handle_join chj
    JOIN chat c ON c.ROWID = chj.chat_id
    WHERE chj.handle_id IN (${ph}) AND c.style = 45
  `).all(...handleIds);
  return rows.map((r) => Number(r.chatId));
}

// Read new messages (both directions) in Trish's 1:1 thread past the watermark.
// Returns { messages: [{ guid, threadId, fromMe, text, ts, handle }], maxRowId, ... }.
function readNewTrishMessages({ env = process.env, dbPath, statePath } = {}) {
  const src = dbPath || env.CHAT_DB_PATH || DEFAULT_DB;
  const state = statePath || defaultState(env);
  const trishNumber = env.TRISH_NUMBER || '+19258040978';
  const maxMessages = Number(env.MAX_MESSAGES || 200);
  const watermark = loadWatermark(state);

  // Copy so we never lock the live DB (include -wal / -shm if present).
  const copy = path.join(os.tmpdir(), 'chat.trish.copy.db');
  fs.copyFileSync(src, copy);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(src + suffix)) { try { fs.copyFileSync(src + suffix, copy + suffix); } catch {} }
  }

  const db = new DatabaseSync(copy, { readOnly: true });
  let rows = [], totalNew = 0, trueMax = watermark, chatIds = [];
  try {
    chatIds = findTrishChatIds(db, trishNumber);
    if (chatIds.length) {
      const ph = chatIds.map(() => '?').join(',');
      const c = db.prepare(`
        SELECT COUNT(*) AS n, MAX(m.ROWID) AS mx
        FROM message m
        JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        WHERE cmj.chat_id IN (${ph}) AND m.ROWID > ?
      `).get(...chatIds, watermark);
      totalNew = Number(c.n || 0);
      trueMax = c.mx != null ? Number(c.mx) : watermark;
      // read as BigInt: message.date is ns since 2001 (~7.8e17), well past 2^53.
      const stmt = db.prepare(`
        SELECT m.ROWID AS rowId, m.guid AS guid, m.text AS text,
               m.attributedBody AS attributedBody, m.is_from_me AS isFromMe,
               m.date AS date, cmj.chat_id AS chatId
        FROM message m
        JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        WHERE cmj.chat_id IN (${ph}) AND m.ROWID > ?
        ORDER BY m.ROWID DESC
        LIMIT ?
      `);
      stmt.setReadBigInts(true);
      rows = stmt.all(...chatIds.map(BigInt), BigInt(watermark), BigInt(maxMessages));
      rows.reverse(); // oldest → newest within the recent slice
    }
  } finally {
    db.close();
  }

  const messages = rows.map((r) => ({
    guid: String(r.guid || ''),
    threadId: r.chatId != null ? 'imessage:chat:' + Number(r.chatId) : 'imessage:trish',
    fromMe: !!r.isFromMe,
    text: extractText(r),
    ts: appleDateToISO(r.date),
    handle: trishNumber
  })).filter((m) => m.guid && m.text && m.text.trim());

  const capped = totalNew > rows.length;
  return { messages, maxRowId: trueMax, watermark, totalNew, capped, chatIds, statePath: state };
}

module.exports = {
  DEFAULT_DB, last10, appleDateToISO, findTrishChatIds,
  loadWatermark, saveWatermark, readNewTrishMessages, defaultState
};
