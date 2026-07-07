# imessage-intake — Roadmap & Plain-English Rundown

This is the human-readable story of what this thing is, what we built, what's done,
and what's left. For the exact architecture + scheduling rules, see `CLAUDE.md`
(that's the technical source of truth; this file is the plain-English version).

---

## What it is, in one breath

A small program that lives on Jonny's Mac. Every 15 minutes it wakes up, looks at
the new text messages that came in, figures out which ones are actually **tasks**
("pick up the prescription Friday," "shoot the event at 6"), and drops them into
TickTick — already scheduled the way Jonny schedules. It ignores small talk, and it
never adds the same thing twice.

It is NOT a chatbot, a server, or a replacement for lexa/Tomo. It's a quiet janitor
that turns "stuff people text you to do" into real calendar tasks so nothing slips.

---

## How it works (the 4 steps)

1. **Scan** — reads a *copy* of your Messages database (so it never locks Messages),
   and only looks at messages newer than the last time it ran. It skips your own
   sent texts and the AI lines (lexa + Tomo), because those are never real tasks.

2. **Sift** — the cheap filter. A free, instant pattern check throws out obvious
   chatter ("lol," "ok cool") for zero cost. Only the genuinely maybe-a-task ones
   get sent to Haiku (the small, cheap AI) for a yes/no. This is why it's cheap: the
   expensive brain only runs on the few messages that might matter.

3. **Schedule** — for each real task, Haiku turns the text into a fully-scheduled
   TickTick task following your rules: right project, emoji title, start/end times,
   travel blocks for away events, reminders, priority, tags. It reads the surrounding
   conversation (both sides) so multi-message plans come together and things you
   already handled get skipped. Everything it produces is checked against a strict
   format before anything is allowed out.

4. **Post + dedup** — before posting it drops anything that matches a task you already
   have (and anything that repeated inside the same run), then creates the survivors
   in TickTick. Then it saves its place so nothing gets processed twice.

**Design promise:** a bad text, a weird AI reply, or a network blip results in
"skip it and move on" — never a crash and never garbage in your calendar.

---

## The decisions we locked (and why)

- **Cheap + accurate, not fancy.** Local pattern-filter first, Haiku only on the
  maybes. We deliberately did NOT use a local Ollama model — nothing else in your
  stack uses one, and Haiku is your proven cheap layer.
- **Reuse your real scheduling brain.** The scheduler is a corrected port of your
  jonny-os `dump.js` engine, updated to the *current* rules (no BOOKED-tt, MATH-182
  is the only class, Internship dropped).
- **Capture-first.** If someone asks you to do a concrete thing, it becomes a task
  even if you never reply. Silence does not mean "handled." You'd rather delete a
  dud than miss something real. (You do not have to reply to your texts to train it.)
- **Auto-post straight to real projects (your call: option B).** No separate "Intake"
  list, no daily digest. The guardrails — dedup, format checks, the once-only
  watermark — are what make auto-posting safe.
- **Block the AI lines.** lexa (+1 321-297-3385) and Tomo/"Tamara" (+1 415-770-0156)
  are hard-ignored, because their texts are about building/automation and were the
  main source of junk tasks.
- **Runs every ~15 minutes** via a macOS launchd timer. Set-and-forget.

---

## What's DONE ✅

- [x] The full 4-step pipeline (scan → sift → schedule → post), committed and tested
- [x] Reads your real `chat.db` with a once-only watermark; caps each run to the most
      recent messages so it never chews through your whole history
- [x] Uses Node's built-in SQLite (works on your Node 26 — no native build to break)
- [x] Cheap regex gate + Haiku task-check, fail-safe on any error
- [x] Scheduler ported to your current rules, strict-JSON validated before posting
- [x] Conversation-window context (reads the thread, both directions)
- [x] Dedup against existing tasks AND within a single run (the "double sunglasses" fix)
- [x] Tighter filter that rejects instructions-to-an-AI / spec / build-software talk
- [x] AI lines (lexa + Tomo) permanently blocked
- [x] TickTick posting working (authorized via the one-time OAuth helper)
- [x] Auto-timer (launchd) — `npm run install-timer`
- [x] 24 automated tests covering the sift, schema, dedup, and scheduler helpers
- [x] Cleaned up the first live run: removed the 13 junk tasks and cleared 103 overdue

---

## What's LEFT / future ideas

Nothing is *required* — it works and runs itself. These are upgrades:

1. **The playbook (rules for specific senders/patterns).** Teach it "texts from Trish
   about a shoot → VPH shoot ecosystem," "Renee → therapy chain in Fairfield," known
   people = known routing. Skips the AI for known patterns (cheaper) and makes it more
   accurate. This is the biggest quality lever and pairs with everything above.
2. **Richer posted tasks.** Right now the posted task carries title/time/project/
   priority/tags/reminders. Filling in the full `content` notes (addresses, contacts,
   gear, links) end-to-end is a polish pass.
3. **Live drive times.** The scheduler uses your static drive table today. Wiring the
   live Google Routes lookup (traffic-aware, +pad) is built in `drivetime.js` and just
   needs to be fed into the travel blocks. Optional — needs the Maps key.
4. **The "bare yes" tail.** If a plan finalizes with a keyword-less "yeah ok," nothing
   trips the gate to re-check that thread. Rare; would need light "pending thread"
   memory to catch.
5. **Confirm the extra projects.** Old `dump.js` had Fitness / Shopping / Wish List as
   separate TickTick projects. Your manuals list only 6. Decide: real projects or fold
   into Personal/Chores.

---

## How to run it (cheat sheet)

All from `~/imessage-intake` on your Mac:

```
npm start                 # dry run — shows what it WOULD create, posts nothing
npm start -- --post       # for real — creates the tasks in TickTick
npm run install-timer     # run it automatically every 15 min (set-and-forget)
npm run uninstall-timer   # stop the automatic runs
npm run ticktick-auth     # re-authorize TickTick if the token ever expires
tail -f run.log           # watch what the timer is doing
git pull                  # pick up any code updates
```

---

## Gotchas we hit (so future-you remembers)

- **Node 26 + native modules = pain.** We dropped `better-sqlite3` for Node's built-in
  `node:sqlite`. Don't add native-compiled dependencies.
- **API keys copied out of a chat get masked into dots/•.** Always copy a fresh key
  straight from the provider's own page (Anthropic console, TickTick console), never
  from a chat window.
- **This tool runs on YOUR Mac, not in the cloud.** The cloud Claude that built it can't
  touch your laptop — that's why setup steps run in your Terminal. A `claude` session
  started *on your Mac* can do local steps hands-off.
- **AI-to-AI chatter pollutes it.** Tomo/lexa texting you about builds looked like tasks.
  They're blocked now; if you add another AI text line, add its number to the ignore list.
