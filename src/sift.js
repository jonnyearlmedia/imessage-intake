// Step 2 — the cheap gate. A free local regex classifier runs on every message;
// only genuinely ambiguous ones cost a tiny Haiku "is this a task?" call. Clear
// chatter is dropped for $0. The classifier is PERMISSIVE: when unsure it returns
// 'maybe' (which escalates to Haiku), it does not reject.

// Strong task signals — imperative verbs and intent phrases.
const IMPERATIVE_VERBS = /\b(fix|build|send|review|update|call|email|text|buy|book|schedule|remind|finish|submit|pay|check|bring|clean|wash|grab|pick|drop|order|edit|shoot|film|deliver|invoice|reply|follow up|renew|cancel|confirm|sign|print|upload|download|install|fill out|return|mail|deposit|register)\b/;
const INTENT_PHRASES = /\b(need to|needs to|gotta|have to|has to|got to|don'?t forget|dont forget|remember to|make sure|be sure to|should|supposed to|can you|could you|would you|will you|lmk|let me know|due|deadline|by (mon|tue|wed|thu|fri|sat|sun|tomorrow|today|\d))/;

// Clear non-task chatter — reactions, greetings, acknowledgments (incl. common
// two-word acks like "ok cool" / "sounds good"). Whole-message match only.
const CHATTER_ONLY = /^((lol|lmao|haha|hehe|ok|okay|k|kk|yes|no|yup|nope|yeah|nah|thanks|thank you|ty|thx|np|gn|gm|good ?night|good ?morning|hey|hi|hello|yo|sup|wyd|hbu|nvm|word|bet|facts|fr|same|true|nice|cool|dope|congrats|omg|wow|damn|bruh|ikr|sounds good|got it|will do|for sure|no worries|my bad|all good|omw|on my way|see (you|ya)|talk later|😂|❤️|👍|🙏)[\s,]*)+[!.\s]*$/i;

// One classification: 'task' (strong signal, skip Haiku, go schedule),
// 'maybe' (ambiguous, ask Haiku is_task), 'drop' (clear non-task, discard).
function classify(text, minLength = 6) {
  const raw = String(text || '').trim();
  if (raw.length < minLength) return 'drop';

  const lc = raw.toLowerCase();

  // pure chatter / reactions
  if (CHATTER_ONLY.test(lc)) return 'drop';
  // URL-only or emoji-only messages carry no task
  if (/^https?:\/\/\S+$/.test(lc)) return 'drop';
  if (/^[\p{Extended_Pictographic}\s]+$/u.test(raw)) return 'drop';

  const hasVerb = IMPERATIVE_VERBS.test(lc);
  const hasIntent = INTENT_PHRASES.test(lc);

  // strong, unambiguous: an action verb AND an intent/obligation cue
  if (hasVerb && hasIntent) return 'task';
  // one signal present → ambiguous, let Haiku decide
  if (hasVerb || hasIntent) return 'maybe';
  // no signal at all, but not obvious chatter → still ambiguous, be permissive
  return 'maybe';
}

// Run the gate over scanned messages. `isTaskFn(text)` is the injectable Haiku
// check returning a boolean (fail-safe: caller makes it return false on any error).
// Returns the messages confirmed as tasks, each tagged with how it was confirmed.
async function siftMessages(messages, { isTaskFn, minLength = 6 } = {}) {
  const confirmed = [];
  for (const m of messages) {
    const verdict = classify(m.text, minLength);
    if (verdict === 'drop') continue;
    if (verdict === 'task') { confirmed.push({ ...m, via: 'regex' }); continue; }
    // 'maybe' → Haiku is_task. No isTaskFn provided (e.g. tests) → conservative drop.
    if (typeof isTaskFn !== 'function') continue;
    let isTask = false;
    try { isTask = await isTaskFn(m.text); } catch { isTask = false; }
    if (isTask) confirmed.push({ ...m, via: 'haiku' });
  }
  return confirmed;
}

module.exports = { classify, siftMessages, IMPERATIVE_VERBS, INTENT_PHRASES, CHATTER_ONLY };
