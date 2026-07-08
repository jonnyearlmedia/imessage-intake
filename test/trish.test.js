const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { last10, appleDateToISO, readNewTrishMessages, loadWatermark, saveWatermark } = require('../src/trish');

test('last10 pulls the final 10 digits regardless of formatting', () => {
  assert.strictEqual(last10('+1 (925) 804-0978'), '9258040978');
  assert.strictEqual(last10('+19258040978'), '9258040978');
  assert.strictEqual(last10('9258040978'), '9258040978');
  assert.strictEqual(last10(''), '');
});

test('appleDateToISO converts ns-since-2001 (past 2^53) without overflow', () => {
  // 780000104 * 1e9 ns after 2001-01-01 → a valid 2025 timestamp
  const iso = appleDateToISO(780000104000000000n);
  assert.match(iso, /^2025-/);
  assert.strictEqual(appleDateToISO(0), null);
  assert.strictEqual(appleDateToISO(null), null);
});

// Build a synthetic chat.db that mimics the real Messages schema, then prove the
// reader: only the 1:1 thread with Trish (not group, not other), both directions,
// GUID + watermark so nothing is read twice.
function buildDb() {
  const dbPath = path.join(os.tmpdir(), 'trish-test-' + process.pid + '.db');
  try { fs.unlinkSync(dbPath); } catch {}
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, style INTEGER, room_name TEXT);
    CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, is_from_me INTEGER, date INTEGER, handle_id INTEGER);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
  `);
  db.prepare(`INSERT INTO handle VALUES (1,'+19258040978')`).run(); // Trish
  db.prepare(`INSERT INTO handle VALUES (2,'+14155551234')`).run(); // someone else
  db.prepare(`INSERT INTO chat VALUES (10,45,NULL)`).run();  // Trish 1:1 (direct)
  db.prepare(`INSERT INTO chat VALUES (11,43,'grp')`).run(); // group incl Trish
  db.prepare(`INSERT INTO chat VALUES (12,45,NULL)`).run();  // other 1:1
  for (const [c, h] of [[10, 1], [11, 1], [11, 2], [12, 2]]) db.prepare(`INSERT INTO chat_handle_join VALUES (?,?)`).run(c, h);
  const BASE = 780000000000000000n;
  const msg = (rowid, guid, text, fromMe, chatId) => {
    db.prepare(`INSERT INTO message VALUES (?,?,?,?,?,?,?)`).run(rowid, guid, text, null, fromMe, BASE + BigInt(rowid) * 1000000000n, fromMe ? 0 : 1);
    db.prepare(`INSERT INTO chat_message_join VALUES (?,?)`).run(chatId, rowid);
  };
  msg(100, 'g100', 'Can you shoot the farmers market Saturday 9am?', 0, 10); // KEEP Trish→me
  msg(101, 'g101', 'Yes I will be there.', 1, 10);                          // KEEP me→Trish
  msg(102, 'g102', 'group chatter here', 0, 11);                            // DROP group
  msg(103, 'g103', 'unrelated direct message', 0, 12);                     // DROP other person
  msg(104, 'g104', 'Also bring the drone please', 0, 10);                   // KEEP Trish→me
  db.close();
  return dbPath;
}

test('reader: Trish 1:1 only, both directions, GUID + watermark dedupe', () => {
  const dbPath = buildDb();
  const statePath = path.join(os.tmpdir(), 'trish-test-' + process.pid + '.state.json');
  try { fs.unlinkSync(statePath); } catch {}
  const env = { TRISH_NUMBER: '+1 (925) 804-0978', CHAT_DB_PATH: dbPath, TRISH_STATE_PATH: statePath };

  const r1 = readNewTrishMessages({ env });
  assert.deepStrictEqual(r1.chatIds, [10], 'only the 1:1 direct thread with Trish');
  const guids = r1.messages.map((m) => m.guid).sort();
  assert.deepStrictEqual(guids, ['g100', 'g101', 'g104'], 'both directions, group + other excluded');
  assert.ok(r1.messages.some((m) => m.fromMe), 'includes an outgoing (to Trish)');
  assert.ok(r1.messages.some((m) => !m.fromMe), 'includes an incoming (from Trish)');
  assert.strictEqual(r1.maxRowId, 104);

  // advance the watermark; a second run past it returns nothing
  saveWatermark(statePath, r1.maxRowId);
  const r2 = readNewTrishMessages({ env });
  assert.strictEqual(r2.messages.length, 0, 'watermark prevents re-reading logged messages');
  assert.strictEqual(loadWatermark(statePath), 104);

  fs.unlinkSync(dbPath);
  fs.unlinkSync(statePath);
});
