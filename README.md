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

## Test

```bash
npm test
```

Fixture-based tests cover the sift gate, schema validation, and dedup — the
deterministic core.
