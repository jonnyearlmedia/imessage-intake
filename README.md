# imessage-intake

Local pipeline that scans new iMessages on Jonny's Mac, finds the ones that are
real tasks, and creates them in TickTick — scheduled the way Jonny schedules.

**Architecture + all scheduling rules live in [`CLAUDE.md`](./CLAUDE.md)** (the single
source of truth). Read that first.

## How it works

```
iMessage (chat.db)  ─┐
                     ├─→ sift → schedule → ✋ APPROVE (you, over iMessage) → TickTick
email (Notion log)  ─┘
```

Cheap where it can be (a free local regex gate + your already-triaged email log
throw out the noise), smart only where it must be (Haiku), and **nothing posts
until you approve it** — each proposal is texted to you and waits for a `y`.

## Setup

1. **Node 18+**, then `npm install`.
2. **Full Disk Access** — the process that runs this needs it to read `chat.db`:
   System Settings → Privacy & Security → Full Disk Access → enable Terminal (or
   whatever runs the script).
3. **Keys** — copy `.env.example` to `.env.local` and fill in. You already have the
   core ones from jonny-os / lexa:
   - `ANTHROPIC_API_KEY`
   - `TICKTICK_CLIENT_ID`, `TICKTICK_CLIENT_SECRET`, `TICKTICK_REFRESH_TOKEN` (or `TICKTICK_RELAY_URL`)
   - `GOOGLE_MAPS_API_KEY` (optional — unset falls back to a static drive-time table)

### 4. Approval over iMessage (BlueBubbles) — the human gate

Proposals reach you as real iMessages via **BlueBubbles**, a free iMessage server
that runs on this same Mac. One-time, no web console / carrier / cost:

1. Install the **BlueBubbles Server** macOS app (`bluebubbles.app`) and sign it into
   the Apple ID already in Messages.
2. Grant it **Full Disk Access** (+ Accessibility if prompted). *Private API mode is
   optional* — AppleScript mode works and needs no SIP changes.
3. Set a **server password** in the app.
4. Fill in `.env.local`:
   - `BLUEBUBBLES_PASSWORD` = that password
   - `APPROVAL_ADDRESS` = your own number (e.g. `+15551234567`) — proposals land in a
     self-thread that pushes to your phone
5. **Smoke-test the self-thread once** (Apple can be flaky sending to yourself):
   confirm a test message from the server reaches your phone. If not, point
   `APPROVAL_ADDRESS` at another handle you own.

**Using it:** you get `🤖 intake · A3 · needs your ok` with the task. Reply **`y`**
or 👍 to add it · **`n`** or 👎 to drop · or just type a correction (**`make it 3pm,
put in VPH`**) — it reschedules and re-asks. Long-press-reply or tapback a specific
proposal and it matches automatically; no id needed.

*If BlueBubbles isn't configured, runs simply print what they'd propose — safe.*

### 5. Email intake (Notion Communications Log) — optional second source

Reads task-flagged rows from your Notion comms-log (both inboxes, already
Claude-triaged). Needs just **one Notion token** — no Gmail OAuth:

1. Create an internal integration at **notion.so/my-integrations**, copy its secret.
2. Open the **Communications Log** DB → `•••` → *Connections* → add your integration.
3. Set `NOTION_TOKEN` in `.env.local`. (Unset = email source off.)

## Run

```bash
npm start          # DRY RUN: show what it would propose (no texts, no posts)
npm start -- --post   # LIVE: drain your replies, send proposals, post approved
```

"Wakeup" = running the `--post` pass on a timer (launchd every ~15 min). See CLAUDE.md.

## Trish relay (texts with Trish → jonny-os Communications Log)

A **second, independent** pipeline in this repo. It watches only the 1:1 iMessage
thread with Trish (**both directions**) and ships new messages to the jonny-os
`/api/imessage/ingest` webhook, which runs the AI pass and writes the Notion
Communications Log row. It does NOT create tasks and shares nothing with the task
pipeline above except the chat.db plumbing — its own watermark (`state.trish.json`)
keeps them fully separate.

Add to `.env.local` (see `.env.example`): `JONNY_OS_INGEST_URL`, `CRON_SECRET`,
and optionally `TRISH_NUMBER` (defaults to Trish's number).

```bash
npm run relay                 # dry run — shows what it WOULD ship, sends nothing
npm run relay -- --post       # for real — POST to jonny-os, then advance watermark
npm run install-relay-timer   # run it automatically every 15 min (set-and-forget)
npm run uninstall-relay-timer # stop the automatic relay runs
tail -f relay.log             # watch the relay timer
```

## Test

```bash
npm test
```

Fixture-based tests cover the sift gate, schema validation, and dedup — the
deterministic core.
