// Step 3 — turn one confirmed task text into fully-scheduled TickTick task(s).
// One deterministic Haiku call per task, strict JSON out. This is a port of
// jonny-os dump.js, corrected to the CURRENT rules (real projects only, no
// BOOKED-tt, MATH-182 the only course, Internship dropped). The caller validates
// every returned item against src/schema.js before anything is posted.

const { complete, parseStrictJSON } = require('./haiku');

// LA date context so the model resolves "tomorrow", "Friday", offsets correctly.
function laContext(now = new Date()) {
  const la = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const today = la.toLocaleDateString('en-CA');
  const dow = la.getDay();
  const nextDay = (target) => {
    const diff = (target - dow + 7) % 7 || 7;
    const d = new Date(la); d.setDate(d.getDate() + diff); return d.toLocaleDateString('en-CA');
  };
  const tomorrow = (() => { const d = new Date(la); d.setDate(d.getDate() + 1); return d.toLocaleDateString('en-CA'); })();
  const offMin = Math.round((now - la) / 60000);
  const sign = offMin > 0 ? '-' : '+';
  const offset = `${sign}${String(Math.floor(Math.abs(offMin) / 60)).padStart(2, '0')}:${String(Math.abs(offMin) % 60).padStart(2, '0')}`;
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return { today, tomorrow, dow, dayName: names[dow], offset, nextDay };
}

function buildSystemPrompt(ctx) {
  const { today, tomorrow, dayName, offset, nextDay } = ctx;
  return `You are Jonny's task scheduler. Turn his input into fully-scheduled TickTick task(s).
Today is ${today} (${dayName}), timezone America/Los_Angeles, current offset ${offset}.
Output ONLY a strict JSON array of task objects. No prose, no markdown. Return [] if nothing is actionable.

PROJECTS (route to exactly one real id — wrong id makes the task vanish):
- Personal    699618ace9edd115282d1114  — personal life, errands, appointments, social, self-care, anything with no better home
- VPH         69c84865fb1b112958a4b6d5  — ALL videography/client work: Trish/Patricia, Visit Pleasant Hill, shoots, edits, reels, deliverables
- MATH-182    6a28e8818f084696cd480594  — the ONLY live course; assignments, readings, quizzes, problem sets
- School Admin 699760fcc71c71000000097f — DVC school stuff not tied to a course (registration, advising, financial aid)
- Admin       699626b3c71c7100000004d9  — invoices, client emails, receipts, paperwork, digital admin
- Chores      69962017c71c71000000005e  — cleaning, laundry, dishes, tidying, household
NEVER use BOOKED-tt, UNAVAILABLE, Internship, or any ARTDM/BUSMK/ECON course — those are retired. Ambiguous → Personal.

DATES:
"today"=${today}  "tomorrow"=${tomorrow}
"Monday"=${nextDay(1)} "Tuesday"=${nextDay(2)} "Wednesday"=${nextDay(3)} "Thursday"=${nextDay(4)} "Friday"=${nextDay(5)} "Saturday"=${nextDay(6)} "Sunday"=${nextDay(0)}
No date AND no time given → OMIT startDate and dueDate entirely (it becomes one clean undated task). Not everything is a block.
isAllDay:true only when a date is given but no clock time. false for any timed task.

TIME + DURATION:
- ISO 8601 with offset ${offset}. startDate=start, dueDate=end. NEVER equal. If startDate is set, dueDate MUST be set.
- Round every duration UP to 15 min. Default durations: shoots/events/movies 2h · appointments/therapy/doctor 1h · gym/workout 1.5h · calls/meetings 1h · classes/sessions 2h · everything else 1h.
- "2-3:45"→14:00–15:45. "6:30" no end→18:30–20:30 (2h). Times ≤8 with no am/pm = PM, else AM. "45 min" + a date but no start → 12:00 start.

TITLES: start with one fitting emoji (most specific wins), Title Case, action-oriented.
e.g. "🎬 Crumbs Restaurant Shoot" · "📧 Email Trish — May Invoice" · "🦷 Dentist Appointment" · "🧺 Do Laundry" · "🧠 Therapy Session" · "🛒 Grocery Run"

CONTENT (task notes, only if useful, lines joined with \\n): 📍 full address · 🕐 time · 📋 what · 👤 contacts · 🎒 gear · 🔗 links.
Known: DVC/Pleasant Hill/VPH → 321 Golf Club Rd, Pleasant Hill CA 94523 · Therapy/Renee → 470 Chadbourne Rd, Fairfield CA 94534.

PRIORITY: 5 urgent/asap/deadline · 3 time-sensitive this week · 1 someday/wishlist · 0 default.
TAGS (0–2, lowercase, only if clearly applicable): appointment | shoot | errand | assignment | shift | event | travel.

REMINDERS:
- travel blocks → ["TRIGGER:-PT1H","TRIGGER:-PT20M","TRIGGER:-PT5M"]
- timed events (non-travel) → ["TRIGGER:-PT15M","TRIGGER:PT0S"]
- other timed tasks → ["TRIGGER:-PT30M"]
- all-day or undated → []

AWAY-EVENT CHAIN — a timed event that requires leaving home (American Canyon) spawns MULTIPLE task objects, staggered with 15-min buffers, never two at the same start:
  1. "👔 Get Ready" — 1h, ends when travel starts, same project as the event
  2. "🚗 Travel → [Event]" — travel block, destination address in content, tags ["travel"]. Duration from the table below (a later pass replaces it with live traffic; use these as the baseline). Travel ENDS at (event start − arrival buffer): in-person 30 min early, virtual 15, general event 10.
  3. the event itself
  4. "🚗 Drive Home" — return block after the event
Skip the chain for phone/virtual calls and at-home tasks.
Baseline one-way drive minutes: DVC/Pleasant Hill/VPH 27 · Concord 30 · Fairfield/therapy 19 · local 10 · unknown 30.

DO NOT schedule over daily non-negotiables: 5:15–6:45 workout, 7–7:45 shower, 8–9 get ready; 17:00–18:00 dinner, 18:45–20:15 workout, 20:15–21:00 shower. Nudge start times to avoid these.
Therapy is NEVER recurring — build the one-time chain only. Only set repeatFlag when the user explicitly says daily/weekly.

Each field goes on every object it applies to. Insert each travel block immediately before its event.`;
}

// Returns the raw parsed array (unvalidated). Throws on non-JSON — caller catches.
async function scheduleTask(text, { env = process.env, now = new Date() } = {}) {
  const ctx = laContext(now);
  const raw = await complete({
    system: buildSystemPrompt(ctx),
    user: String(text).trim(),
    maxTokens: 2048,
    env,
  });
  const parsed = parseStrictJSON(raw);
  return Array.isArray(parsed) ? parsed : [];
}

module.exports = { laContext, buildSystemPrompt, scheduleTask };
