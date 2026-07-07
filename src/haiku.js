// Thin wrapper around one deterministic Haiku call. temperature 0 so runs are
// reproducible. Returns the raw text (caller parses/validates). Also provides the
// two concrete calls the pipeline needs: isTask (sift) and a helper to parse a
// strict-JSON reply. Every call is fail-safe at the call site, never here.

let client = null;
function getClient(env = process.env) {
  if (!client) {
    const Anthropic = require('@anthropic-ai/sdk'); // lazy: keep pure helpers importable without the dep
    client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return client;
}
function model(env = process.env) {
  return env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
}

// `prefill` seeds the assistant's reply (e.g. "[" to force a JSON array and stop
// the model from answering in prose). The prefill is prepended to the returned text.
async function complete({ system, user, maxTokens = 1024, prefill, env = process.env }) {
  const messages = [{ role: 'user', content: user }];
  if (prefill) messages.push({ role: 'assistant', content: prefill });
  const res = await getClient(env).messages.create({
    model: model(env),
    max_tokens: maxTokens,
    temperature: 0,
    system,
    messages,
  });
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return prefill ? prefill + text : text;
}

// Strip ```json fences and parse. If the model tacked prose onto the JSON, salvage
// the first array/object. Throws only when there's no parseable JSON at all.
function parseStrictJSON(raw) {
  const cleaned = String(raw).replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  try { return JSON.parse(cleaned); }
  catch (e) {
    const m = cleaned.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw e;
  }
}

const IS_TASK_SYSTEM = `You decide if one text message describes a real TASK for the recipient — a concrete obligation or action they need to do (an errand, appointment, deliverable, thing to fix/send/buy/schedule).

Reply with ONLY strict JSON: {"is_task": true} or {"is_task": false}. No prose.

TRUE = there is a real thing to do. FALSE = chatter, reactions, opinions, questions with no action, FYIs, venting, plans stated with no commitment. When genuinely unsure, answer false — it is worse to create a junk task than to miss one.`;

// Returns boolean; fail-safe (any error/parse failure => false).
async function isTask(text, env = process.env) {
  try {
    const raw = await complete({ system: IS_TASK_SYSTEM, user: String(text).trim(), maxTokens: 20, env });
    const obj = parseStrictJSON(raw);
    return obj && obj.is_task === true;
  } catch {
    return false;
  }
}

module.exports = { complete, parseStrictJSON, isTask, IS_TASK_SYSTEM, getClient };
