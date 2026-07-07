# imessage-intake

Local task-capture pipeline. On a timer, it reads new iMessages on Jonny's Mac,
finds the ones that are real tasks, and creates them in TickTick — scheduled the
way Jonny schedules things.

**This file is the single source of truth for this repo's architecture.** Do not
add a `SKILL.md` here, and do not copy scheduling rules into a second file that
can drift out of sync. If a rule changes, change it here. (`ROADMAP.md` is the
plain-English companion — the story and operator's cheat sheet, not the rules.)

---

## What this is (and is NOT)

- IT IS: a small local Node script. iMessage in → real tasks out → TickTick.
- IT IS NOT: a chat assistant, a server, or a replacement for lexa.

### Relationship to Jonny's other tools

- **lexa** (`jonnyearlmedia/assistant`) receives texts sent *to lexa's own Linq
  line* (+1 321-297-3385) and acts on them. This pipeline scans Jonny's *whole*
  incoming iMessage history from *everyone else*. Different input, same TickTick
  sink — so this pipeline **ignores lexa's line** to avoid both tools acting on
  the same text and creating duplicates.
- **jonny-os `dump.js`** is the proven "text → fully-scheduled TickTick task"
  engine. This repo's scheduling step is a port of that engine, corrected to the
  current rules below (no BOOKED-tt, current projects only).

---

## The pipeline (4 steps)

```
chat.db (new messages since watermark)
  1. SCAN    → read new inbound messages, ignore lexa's line + self
  2. SIFT    → regex gate (free) → Haiku "is this a task?" only on the maybes
  3. SCHEDULE→ Haiku parses each task into a fully-scheduled TickTick payload
              (strict JSON, validated) + live drive-time for away events
  4. DEDUP   → compare vs existing TickTick tasks, then POST survivors
  → advance watermark
```

### 1. Scan
- Reads a **read-only copy** of `~/Library/Messages/chat.db` (never touch the live
  DB — copy first so Messages never locks).
- Requires **Full Disk Access** on the process (see README / setup).
- Selects inbound messages (`is_from_me = 0`) with `ROWID` greater than the saved
  **watermark**. The watermark is the source-level dedup: a message is processed
  exactly once, ever.
- Filters out **AI/automation lines whose texts are never real tasks** — lexa's Linq
  line (+1 321-297-3385), Tomo / "Tamara" (+1 415-770-0156), and Lindy
  (+1 415-434-9162) — plus Jonny's own sends and empty/too-short bodies. Records
  sender + whether it's a group or 1:1. **Scans group chats too.**

### 2. Sift (the cheap gate — no Ollama)
Deliberately two-tier so we pay for intelligence only when we must:
- **Regex gate (local, free):** imperative verbs (fix, build, send, review,
  update, call…) + intent words (need to, gotta, have to, don't forget, should…).
  Clear non-tasks are dropped here for $0. The gate is **permissive** — when in
  doubt it passes the text down, it does not reject.
- **Haiku task-check (only on ambiguous passes):** one small call returning strict
  JSON `{ "is_task": boolean }`. **Fail-safe:** any error, timeout, or unparseable
  response drops the text (never crash, never post junk). Mirrors lexa's
  `triage.ts` pattern.

Ollama / a local 3B model was considered and **rejected**: nothing else in Jonny's
stack uses it, and Haiku already is the proven cheap layer. The regex gate provides
the "free filtering" that Ollama was meant to provide.

### 3. Schedule (Haiku — the ported engine)
For each confirmed task, one Haiku call turns the raw text into a fully-scheduled
TickTick task following **the scheduling rules below**. Output is **strict JSON,
validated against a schema before anything is posted.** Malformed output → that
item is skipped and logged, never posted, never crashes the run.

Away events get a **live drive-time** lookup (Google Routes API) with the static
table as fallback, plus Jonny's padding stack (see rules).

### 4. Dedup + Post
- Collapse repeats **within the run** (one plan discussed over several texts → one
  task), then pull existing tasks from the relevant TickTick projects and drop any
  candidate matching an existing task by normalized title + time. Jonny's #1 rule:
  **never double-add.**
- POST survivors to the TickTick Open API (`https://api.ticktick.com/open/v1/task`).
- Advance the watermark only after a successful run; log created/skipped/errors.

---

## Design guarantees

- **Deterministic + testable:** all model calls use `temperature 0`. The regex gate,
  schema validation, and dedup are pure functions with fixture-based tests.
- **Resilient to malformed input:** every stage that emits machine-readable output
  validates strict JSON before the next stage consumes it. A bad message, a bad AI
  response, or a network failure degrades to "skip + log", never a crash or a bad
  write.
- **Additive + idempotent:** the watermark guarantees each message is seen once;
  dedup guarantees each task lands once.

---

## Scheduling rules (the current source of truth)

These are Jonny's live rules. `dump.js` in jonny-os is stale on taxonomy — THIS is
correct.

### Live projects (real project IDs)
| Project | ID |
|---|---|
| Personal | `699618ace9edd115282d1114` |
| VPH (all videography/client work) | `69c84865fb1b112958a4b6d5` |
| MATH-182 (the only live course) | `6a28e8818f084696cd480594` |
| School Admin | `699760fcc71c71000000097f` |
| Admin | `699626b3c71c7100000004d9` |
| Chores | `69962017c71c71000000005e` |

**Retired — NEVER write here:** BOOKED-tt (`69c7aa7f5f7411209aedd74d`),
UNAVAILABLE (`69b91cf5ebdf7a0000000434`), Internship / Berk's Beans
(`69b91c69ebdf7a00000003fa`, internship is done), all ARTDM / BUSMK / ECON courses.
Never create standalone Google Calendar or iOS calendar events. Never write to
`jonny@jonnyearl.com`.

### Core rules
- **One task = its own real project** with a specific time. Wrong project ID = task
  vanishes into the invisible Inbox, so route carefully; truly ambiguous → Personal.
- **Emoji prefix on every title.** Most-specific wins (shoot at a concert = 🎬 not 🎤).
  Title case, action-oriented.
- **Timezone:** always `America/Los_Angeles`, explicit offset (`-07:00` PDT /
  `-08:00` PST). `isAllDay:false` for timed tasks. Always name the day of week when
  referencing a date.
- **Durations round UP to 15 min.** `startDate` = start, `dueDate` = end; never equal;
  if start is set, end must be too. Defaults: shoots/events/movies 2h · appts/therapy
  1h · gym 1.5h · calls/meetings 1h · classes 2h · else 1h.
- **A timed away-event spawns a chain**, not one task: `👔 Get Ready` (1h) → `🚗`
  travel block (address in it) → the event → `🚗` drive home. Stagger with 15-min
  buffers, never two tasks at the same start.
- **Arrival buffers:** in-person 30 min early · virtual 15 min · general events 10 min.
- **Drive times:** live Google Routes lookup for the real departure time; round up to
  15 min; **+10 min pad**; static table fallback (DVC/PH/VPH ~27 · Concord ~30 ·
  Fairfield ~19 · local ~10 · unknown ~30). Padding stacks on top of arrival buffers —
  Jonny is chronically late, over-cushion on purpose.
- **Reminders:** travel → −1h/−20m/−5m · timed events → −15m/at-time · other timed
  tasks → −30m · all-day & undated → none.
- **Priority:** 5 urgent/asap/deadline · 3 time-sensitive this week · 1 someday/wishlist
  · 0 default. **Tags** (1–2 max): appointment/shoot/errand/assignment/shift/event/travel.
- **No time given → omit dates entirely.** Not everything becomes a block; an undated
  obligation is one clean task.
- **Never schedule over the daily non-negotiables:** morning 5:15–6:45 workout /
  7–7:45 shower / 8–9 get ready; evening 5–6 dinner / 6:45–8:15 workout / 8:15–9
  shower / 9+ wind down. Sunday is light (chores/reset only).
- **Therapy (Renee, Fairfield):** never recurring, confirm each session; builds the
  full chain when a session is named.
- **VPH shoots** spawn the ecosystem: night-before prep + dashboard, day-of get-ready
  + drive, shoot, upload/organize, delivery (Box + email Trish), edit block only if
  needed, invoice only after all deliverables are in Box.

### Content field
Fleshed notes when they add value: 📍 location (full address) · 🕐 time · 📋 what ·
👤 contacts · 🎒 gear · 🔗 links · 🚗 travel · 📝 notes. Known addresses — DVC/PH/VPH:
321 Golf Club Rd, Pleasant Hill CA 94523 · Therapy: 470 Chadbourne Rd, Fairfield CA
94534 · Home (travel origin): 98 Castellina Cir, American Canyon CA 94503.

### TickTick quirks
- Inbox is invisible to the API — always a named project.
- `batch_add_tasks` doesn't persist dates reliably; single-task create is the safe path.

---

## Layout

```
index.js        # the "wakeup" entry point — runs the 4 steps in order
src/scan.js     # chat.db reader + watermark + thread-window context
src/playbook.js # known senders → name + routing hint (phone-normalized)
src/sift.js     # regex gate + Haiku task-check
src/haiku.js    # one deterministic Haiku call (temp 0) + is-task check
src/schedule.js # Haiku scheduler (ported dump.js) + drive times
src/dedup.js    # normalize + compare (vs existing AND within-run)
src/ticktick.js # token / relay + task create
src/drivetime.js# Google Routes lookup + static fallback
src/schema.js   # JSON schemas + strict validation
scripts/        # ticktick-auth (OAuth), install-timer / uninstall-timer (launchd)
state.json      # { lastRowId } watermark (gitignored)
test/           # fixture-based tests for sift, schema, dedup, scheduler
```

## Decisions (locked)
- **Capture-first:** a concrete ask directed at Jonny becomes a task even if he never
  replies. Only skip on positive done/declined evidence or no ask at all. Jonny does
  not reply to everything, so silence must not drop real tasks.
- **Post destination = real projects, auto (option B).** No separate "Intake" list, no
  digest. Survivors post straight into their real TickTick project. The guardrails
  (dedup, schema validation, watermark) are what make auto-posting safe; an occasional
  dud is acceptable and deleted by hand.
- **Conversation context:** each candidate is scheduled with its surrounding thread
  window (both directions) so multi-turn plans assemble and already-handled things drop.
- **Cadence:** every ~15 min via a macOS **launchd** timer (`npm run install-timer`).
- **AI lines are hard-ignored:** lexa (+1 321-297-3385), Tomo/"Tamara"
  (+1 415-770-0156), Lindy (+1 415-434-9162) — build/automation chatter, never tasks.
- **Playbook (`src/playbook.js`):** known senders map to a name + routing hint that's
  fed to the scheduler (e.g. Clinic Ole → appointments; Mama/Ate Janel → route by
  content). Matched by last-10 digits so number formatting doesn't matter. Grow it as
  new task-senders show up.

## Open questions (confirm before they matter)
- **Extra Personal-area projects:** `dump.js` referenced Fitness / Shopping / Wish
  List as separate TickTick projects. The scheduling manuals list only the 6 above.
  Are Fitness/Shopping/Wish List still real projects to route into, or fold into
  Personal/Chores?
- **Task content richness:** posts carry title/time/project/priority/tags/reminders;
  full `content` notes (addresses, gear, links) is a polish pass still to wire end-to-end.

## Setup
See `README.md` and `.env.example`. Requires macOS Full Disk Access on the running
process to read `chat.db`.
