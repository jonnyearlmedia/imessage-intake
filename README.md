# imessage-intake

Local pipeline that scans new iMessages on Jonny's Mac, finds the ones that are
real tasks, and creates them in TickTick — scheduled the way Jonny schedules.

**Architecture + all scheduling rules live in [`CLAUDE.md`](./CLAUDE.md)** (the single
source of truth). Read that first.

## How it works

```
chat.db → scan → sift (regex + Haiku) → schedule (Haiku) → dedup → TickTick
```

Cheap where it can be (a free local regex gate throws out the ~95% of texts that
aren't tasks), smart only where it must be (Haiku fires on real candidates).

## Setup

1. **Node 18+**, then `npm install`.
2. **Full Disk Access** — the process that runs this needs it to read `chat.db`:
   System Settings → Privacy & Security → Full Disk Access → enable Terminal (or
   whatever runs the script).
3. **Keys** — copy `.env.example` to `.env.local` and fill in. You already have all
   of these from jonny-os / lexa:
   - `ANTHROPIC_API_KEY`
   - `TICKTICK_CLIENT_ID`, `TICKTICK_CLIENT_SECRET`, `TICKTICK_REFRESH_TOKEN`
   - `GOOGLE_MAPS_API_KEY` (optional — unset falls back to a static drive-time table)

## Run

```bash
npm start          # one pass: process everything new since the last run
```

"Wakeup" = running it on a timer (cron or launchd every N minutes). See CLAUDE.md.

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
