// Step 1 — read new inbound iMessages from a read-only COPY of chat.db (never the
// live file, so Messages never locks). Selects rows past the saved ROWID watermark,
// inbound only, and filters out lexa's line + junk. The watermark is source-level
// dedup: each message is processed exactly once, ever.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite'); // built into Node 22.5+, no native build

const DEFAULT_DB = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');

function defaultState(env = process.env) {
  return env.STATE_PATH || path.join(process.cwd(), 'state.json');
}
function loadWatermark(statePath) {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')).lastRowId || 0; }
  catch { return 0; }
}
function saveWatermark(statePath, lastRowId) {
  fs.writeFileSync(statePath, JSON.stringify({ lastRowId }, null, 2));
}

// Modern macOS stores the body in attributedBody (a typedstream blob) when `text`
// is NULL. Best-effort: pull the human-readable run out of the blob.
function extractText(row) {
  if (row.text && row.text.trim()) return row.text;
  if (!row.attributedBody) return '';
  const buf = Buffer.isBuffer(row.attributedBody) ? row.attributedBody : Buffer.from(row.attributedBody);
  const s = buf.toString('utf8');
  const m = s.match(/NSString\b.*?([\x20-\x7E -￿]{2,})/);
  return m ? m[1].replace(/\+$/, '').trim() : '';
}

// Pure filter — testable without a DB. Drops lexa's line, empty/short bodies.
function keepMessage(msg, { ignoreNumbers = [], minLength = 6 } = {}) {
  if (!msg || msg.isFromMe) return false;
  const body = (msg.text || '').trim();
  if (body.length < minLength) return false;
  const sender = (msg.sender || '').replace(/[\s()-]/g, '');
  if (ignoreNumbers.map((n) => n.replace(/[\s()-]/g, '')).includes(sender)) return false;
  return true;
}

function parseIgnoreNumbers(env = process.env) {
  return (env.IGNORE_NUMBERS || '+13212973385').split(',').map((s) => s.trim()).filter(Boolean);
}

// Read new inbound messages. Returns [{ rowId, text, sender, isGroup, isFromMe, date }].
function readNewMessages({ env = process.env, dbPath, statePath } = {}) {
  const src = dbPath || env.CHAT_DB_PATH || DEFAULT_DB;
  const state = statePath || defaultState(env);
  const minLength = Number(env.MIN_MESSAGE_LENGTH || 6);
  const ignoreNumbers = parseIgnoreNumbers(env);
  const watermark = loadWatermark(state);

  // Copy so we never lock the live DB (include -wal / -shm if present).
  const copy = path.join(os.tmpdir(), 'chat.copy.db');
  fs.copyFileSync(src, copy);
  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(src + suffix)) { try { fs.copyFileSync(src + suffix, copy + suffix); } catch {} }
  }

  // Cap each run to the most recent N inbound messages so a first run (watermark 0)
  // never tries to chew through the whole history. The watermark still advances to
  // the true max, so skipped-old messages are not reprocessed next time. Raise
  // MAX_MESSAGES to reach further back in one run.
  const maxMessages = Number(env.MAX_MESSAGES || 200);
  const db = new DatabaseSync(copy, { readOnly: true });
  let rows, totalNew, trueMax;
  try {
    const c = db.prepare(
      `SELECT COUNT(*) AS n, MAX(ROWID) AS mx FROM message WHERE ROWID > ? AND is_from_me = 0`
    ).get(watermark);
    totalNew = Number(c.n || 0);
    trueMax = c.mx != null ? Number(c.mx) : watermark;
    rows = db.prepare(`
      SELECT m.ROWID as rowId, m.text as text, m.attributedBody as attributedBody,
             m.is_from_me as isFromMe, cmj.chat_id as chatId,
             h.id as sender, c.room_name as roomName, c.style as chatStyle
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      LEFT JOIN chat c ON c.ROWID = cmj.chat_id
      WHERE m.ROWID > ? AND m.is_from_me = 0
      ORDER BY m.ROWID DESC
      LIMIT ?
    `).all(watermark, maxMessages);
    rows.reverse(); // process oldest-to-newest within the recent slice
  } finally {
    db.close();
  }

  const messages = rows.map((r) => ({
    rowId: Number(r.rowId),
    text: extractText(r),
    sender: r.sender || '',
    isFromMe: !!r.isFromMe,
    isGroup: !!r.roomName || Number(r.chatStyle) === 43,
    chatId: r.chatId != null ? Number(r.chatId) : null,
  }));

  const kept = messages.filter((m) => keepMessage(m, { ignoreNumbers, minLength }));
  const maxRowId = trueMax;
  const capped = totalNew > rows.length;
  return { messages: kept, maxRowId, watermark, totalNew, capped, statePath: state, copyPath: copy };
}

// Pull the last `limit` messages in one chat up to (and including) beforeRowId —
// BOTH directions, so the scheduler sees Jonny's own replies for context. Reuses
// the copy already made by readNewMessages (no second copy). Returns ascending.
function readThreadWindow(copyPath, chatId, beforeRowId, limit = 10) {
  if (chatId == null || !copyPath) return [];
  const db = new DatabaseSync(copyPath, { readOnly: true });
  try {
    const rows = db.prepare(`
      SELECT m.ROWID as rowId, m.text as text, m.attributedBody as attributedBody,
             m.is_from_me as isFromMe, h.id as sender
      FROM message m
      LEFT JOIN handle h ON m.handle_id = h.ROWID
      JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      WHERE cmj.chat_id = ? AND m.ROWID <= ?
      ORDER BY m.ROWID DESC
      LIMIT ?
    `).all(chatId, beforeRowId, limit);
    rows.reverse();
    return rows
      .map((r) => ({ rowId: Number(r.rowId), text: extractText(r), sender: r.sender || '', isFromMe: !!r.isFromMe }))
      .filter((m) => m.text && m.text.trim());
  } finally {
    db.close();
  }
}

module.exports = {
  DEFAULT_DB, extractText, keepMessage, parseIgnoreNumbers,
  loadWatermark, saveWatermark, readNewMessages, readThreadWindow, defaultState,
};
