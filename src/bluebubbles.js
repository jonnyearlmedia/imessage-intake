// The iMessage transport for the approval loop — a thin client over the
// BlueBubbles Server REST API (a free, self-hosted iMessage bridge that runs on
// the same Mac as this pipeline, using the Apple ID already signed into Messages).
//
// We only need two calls:
//   sendText()      → POST /api/v1/message/text   (send Jonny a proposal)
//   queryMessages() → POST /api/v1/message/query  (read his replies, after a cursor)
//
// Auth is a single `?password=` query param on every request. Timestamps are epoch
// MILLISECONDS both ways. Message `text` can be null (real body in attributedBody),
// so we always ask the server to join it.
//
// Kept deliberately small and behind one module so a different transport (Twilio,
// Discord) could be dropped in later without touching the approval logic.

function baseUrl(env) {
  return (env.BLUEBUBBLES_URL || 'http://localhost:1234').replace(/\/$/, '');
}
function password(env) {
  return env.BLUEBUBBLES_PASSWORD || '';
}
// The handle the approval thread lives at (Jonny's own number → a note-to-self
// thread) as a BlueBubbles chat GUID: "iMessage;-;+1XXXXXXXXXX".
function approvalChatGuid(env) {
  const addr = (env.APPROVAL_ADDRESS || '').trim();
  if (!addr) return '';
  if (addr.includes(';')) return addr; // already a full chat GUID
  const service = env.APPROVAL_SERVICE || 'iMessage';
  return `${service};-;${addr}`;
}

function isConfigured(env) {
  return !!(password(env) && approvalChatGuid(env));
}

async function call(path, body, env, fetchImpl = fetch) {
  const url = `${baseUrl(env)}/api/v1${path}?password=${encodeURIComponent(password(env))}`;
  const r = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  let json;
  try { json = txt ? JSON.parse(txt) : {}; } catch { json = { raw: txt }; }
  if (!r.ok || (json && json.status && json.status >= 300)) {
    throw new Error(`BlueBubbles ${path} failed: ${r.status} ${json.message || txt}`);
  }
  return json.data;
}

// Send Jonny a proposal. Returns { guid, tempGuid } — guid is what his inline
// reply / tapback will reference, so the caller stores it on the pending entry.
// method:"private-api" is forced for reliability (plain sends silently fall back to
// AppleScript, which breaks with no established self-chat and on macOS 26).
async function sendText(message, env = process.env, fetchImpl = fetch) {
  const chatGuid = approvalChatGuid(env);
  if (!chatGuid) throw new Error('APPROVAL_ADDRESS not set');
  const tempGuid = 'temp-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const method = env.BLUEBUBBLES_METHOD || 'private-api';
  const data = await call('/message/text', { chatGuid, tempGuid, message, method }, env, fetchImpl);
  return { guid: data && data.guid, tempGuid, chatGuid };
}

// `associatedMessageGuid` comes prefixed ("p:0/<guid>" or "bp:<guid>"); strip it
// back to the bare target GUID so we can match it to a proposal we sent.
function stripAssocPrefix(guid) {
  if (!guid) return '';
  return String(guid).replace(/^p:\d+\//, '').replace(/^bp:/, '');
}

// Read messages in the approval thread newer than `afterMs` (epoch ms), oldest
// first. Normalizes to just the fields the approval matcher needs.
async function queryMessages({ afterMs = 0, limit = 100 } = {}, env = process.env, fetchImpl = fetch) {
  const chatGuid = approvalChatGuid(env);
  if (!chatGuid) throw new Error('APPROVAL_ADDRESS not set');
  const data = await call('/message/query', {
    chatGuid,
    with: ['handle', 'message.attributedBody'],
    sort: 'ASC',
    after: Math.floor(afterMs) || 0,
    limit,
    offset: 0,
  }, env, fetchImpl);
  const rows = Array.isArray(data) ? data : [];
  return rows.map((m) => ({
    guid: m.guid,
    text: (m.text || '').trim(),
    isFromMe: !!m.isFromMe,
    dateCreated: Number(m.dateCreated || 0),
    // inline reply → the message it replies to:
    replyToGuid: m.threadOriginatorGuid ? stripAssocPrefix(m.threadOriginatorGuid) : '',
    // tapback → the message it reacts to + the reaction code:
    tapbackToGuid: m.associatedMessageGuid ? stripAssocPrefix(m.associatedMessageGuid) : '',
    tapbackType: Number(m.associatedMessageType || 0),
  }));
}

module.exports = {
  baseUrl, approvalChatGuid, isConfigured, sendText, queryMessages, stripAssocPrefix,
};
