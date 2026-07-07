// TickTick Open API: get an access token, create a task, list a project's tasks
// (for dedup). Mirrors jonny-os's proven token logic: use TICKTICK_ACCESS_TOKEN
// directly if present, else refresh via client id/secret + refresh token.
// Single-task create only — batch_add_tasks does not persist dates reliably.

const TASK_URL = 'https://api.ticktick.com/open/v1/task';

let cachedToken = null;

async function getToken(env = process.env) {
  if (cachedToken) return cachedToken;
  if (env.TICKTICK_ACCESS_TOKEN) { cachedToken = env.TICKTICK_ACCESS_TOKEN; return cachedToken; }

  const { TICKTICK_CLIENT_ID, TICKTICK_CLIENT_SECRET, TICKTICK_REFRESH_TOKEN } = env;
  if (!TICKTICK_CLIENT_ID || !TICKTICK_CLIENT_SECRET || !TICKTICK_REFRESH_TOKEN) {
    throw new Error('TickTick not configured: set TICKTICK_ACCESS_TOKEN, or CLIENT_ID+SECRET+REFRESH_TOKEN');
  }
  const basic = Buffer.from(`${TICKTICK_CLIENT_ID}:${TICKTICK_CLIENT_SECRET}`).toString('base64');
  const r = await fetch('https://ticktick.com/oauth/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: TICKTICK_REFRESH_TOKEN }),
  });
  if (!r.ok) throw new Error(`TickTick token refresh failed: ${r.status} ${await r.text()}`);
  const d = await r.json();
  if (!d.access_token) throw new Error('TickTick token refresh returned no access_token');
  cachedToken = d.access_token;
  return cachedToken;
}

// Build the exact POST payload from a validated scheduled task. Only known fields.
function toPayload(t) {
  const p = { title: t.title, projectId: t.projectId, timeZone: t.timeZone || 'America/Los_Angeles' };
  if (t.startDate) p.startDate = t.startDate;
  if (t.dueDate) p.dueDate = t.dueDate;
  if (typeof t.isAllDay === 'boolean') p.isAllDay = t.isAllDay;
  if (t.content) p.content = t.content;
  if (t.priority != null) p.priority = Number(t.priority);
  if (Array.isArray(t.tags) && t.tags.length) p.tags = t.tags;
  if (Array.isArray(t.reminders) && t.reminders.length) p.reminders = t.reminders;
  if (t.repeatFlag) p.repeatFlag = t.repeatFlag;
  return p;
}

async function createTask(t, env = process.env, fetchImpl = fetch) {
  const token = await getToken(env);
  const r = await fetchImpl(TASK_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(toPayload(t)),
  });
  if (!r.ok) throw new Error(`TickTick create failed: ${r.status} ${await r.text()}`);
  return r.json();
}

async function listProjectTasks(projectId, env = process.env, fetchImpl = fetch) {
  const token = await getToken(env);
  const r = await fetchImpl(`https://api.ticktick.com/open/v1/project/${projectId}/tasks`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return [];
  const d = await r.json();
  return Array.isArray(d) ? d : (d.tasks || []);
}

function _resetTokenCache() { cachedToken = null; }

module.exports = { getToken, toPayload, createTask, listProjectTasks, _resetTokenCache };
