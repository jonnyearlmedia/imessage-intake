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

// Plan-finalizing confirmations — a keyword-less "yeah ok" / "sounds good" that
// AGREES to something proposed earlier in the thread. These overlap CHATTER_ONLY
// (they'd otherwise be dropped for $0), but when the surrounding thread holds an
// open proposal they should re-open that thread for the scheduler. The scheduler
// reads the whole window, so it — not this gate — decides if a task actually
// finalized; here we only flag "this MIGHT be a confirmation". Whole-message only.
const CONFIRMATION = /^((yes|yeah|yep|yup|ya|sure|ok|okay|k|kk|sounds good|that works|works for me|works|i'?m in|i'?ll be there|i'?ll come|i'?ll make it|see you( then| there)?|see ya( then)?|confirmed|deal|down|for sure|will do|let'?s do it|perfect|great|absolutely|definitely)[\s,]*)+[!.\s]*$/i;

// Cues that some concrete plan was proposed in a thread: an action verb, an intent
// phrase, or a time/date reference. Used to decide whether a bare confirmation is
// worth escalating. Pure — takes an already-fetched thread window.
const TIME_REF = /\b(\d{1,2}(:\d{2})?\s*(am|pm)|noon|midnight|tonight|tomorrow|today|mon(day)?|tues?(day)?|wed(nesday)?|thu(r|rs|rsday)?|fri(day)?|sat(urday)?|sun(day)?|next week|this week)\b/i;
function threadHasProposal(thread) {
  if (!Array.isArray(thread)) return false;
  return thread.some((m) => {
    const t = String((m && m.text) || '');
    if (!t) return false;
    const lc = t.toLowerCase();
    return IMPERATIVE_VERBS.test(lc) || INTENT_PHRASES.test(lc) || TIME_REF.test(t);
  });
}

// One classification: 'task' (strong signal, skip Haiku, go schedule),
// 'maybe' (ambiguous, ask Haiku is_task), 'drop' (clear non-task, discard).
function classify(text, minLength = 6) {
  const raw = String(text || '').trim();
  if (raw.length < minLength) return 'drop';

  const lc = raw.toLowerCase();

  // a bare confirmation ("yeah ok", "sounds good") — checked BEFORE chatter so it
  // isn't dropped for $0. It escalates only if its thread has an open proposal
  // (decided by the caller, which has the thread window). Single-word acks under
  // minLength are already gone by here.
  if (CONFIRMATION.test(lc)) return 'confirm';
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
    // bare confirmation → carry it through tagged; the caller gates it on whether
    // the thread window actually holds an open proposal before scheduling.
    if (verdict === 'confirm') { confirmed.push({ ...m, via: 'confirm' }); continue; }
    // 'maybe' → Haiku is_task. No isTaskFn provided (e.g. tests) → conservative drop.
    if (typeof isTaskFn !== 'function') continue;
    let isTask = false;
    try { isTask = await isTaskFn(m.text); } catch { isTask = false; }
    if (isTask) confirmed.push({ ...m, via: 'haiku' });
  }
  return confirmed;
}

module.exports = {
  classify, siftMessages, threadHasProposal,
  IMPERATIVE_VERBS, INTENT_PHRASES, CHATTER_ONLY, CONFIRMATION, TIME_REF,
};
