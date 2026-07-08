#!/usr/bin/env node
// The "wakeup" for the Trish relay — ships new messages in Jonny's 1:1 thread with
// Trish (both directions) up to the jonny-os Communications Log webhook, which runs
// the AI pass and writes the Notion row. This process is a DUMB trigger: no AI, no
// Notion token here — just read chat.db and POST.
//
// SAFE BY DEFAULT: a dry run. It reads and PRINTS what it would send, but does NOT
// POST and does NOT advance the watermark. Run with `--post` (or POST=1) to send for
// real; only a real send advances the watermark.
//
//   npm run relay              # dry run: show what it would ship
//   npm run relay -- --post    # for real: POST to jonny-os, then advance watermark
//
// Needs in .env.local:
//   JONNY_OS_INGEST_URL   e.g. https://jonny-os.vercel.app/api/imessage/ingest
//   CRON_SECRET           the same secret jonny-os uses to gate /api/*/ingest
//   TRISH_NUMBER          defaults to +19258040978

const path = require('path');
require('dotenv').config({ path: path.join(process.cwd(), '.env.local') });
require('dotenv').config();

const trish = require('./src/trish');

const POST = process.argv.includes('--post') || process.env.POST === '1';
const log = (...a) => console.log(...a);

async function main() {
  const env = process.env;
  const url = env.JONNY_OS_INGEST_URL;
  const secret = env.CRON_SECRET;

  const { messages, maxRowId, watermark, totalNew, capped, chatIds, statePath } =
    trish.readNewTrishMessages({ env });

  if (!chatIds.length) {
    log('[trish] no 1:1 thread found for', env.TRISH_NUMBER || '+19258040978',
        '— check the number, and that Full Disk Access is granted so chat.db is readable.');
    return;
  }
  log(`[trish] ${totalNew} new since ROWID ${watermark}; ${messages.length} to ship` +
      `${capped ? ' (capped — raise MAX_MESSAGES to reach further back)' : ''}`);
  if (!messages.length) { log('[done] nothing new.'); return; }

  if (!POST) {
    log(`\n[DRY RUN] would POST ${messages.length} message(s) to ${url || '(JONNY_OS_INGEST_URL unset)'}:\n`);
    messages.forEach((m) => log(`  • [${m.fromMe ? 'me→Trish' : 'Trish→me'}] ${m.ts || '(no ts)'}  ${clip(m.text)}`));
    log(`\n[dry run] watermark NOT advanced. Re-run with --post when it looks right.`);
    return;
  }

  if (!url) { console.error('[fatal] JONNY_OS_INGEST_URL not set'); process.exitCode = 1; return; }
  if (!secret) { console.error('[fatal] CRON_SECRET not set'); process.exitCode = 1; return; }

  let res, data;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cron-secret': secret },
      body: JSON.stringify({ messages })
    });
    data = await res.json().catch(() => ({}));
  } catch (e) {
    console.error('[fatal] POST failed, watermark NOT advanced:', e.message);
    process.exitCode = 1;
    return;
  }
  if (!res.ok) {
    console.error(`[fatal] webhook ${res.status}, watermark NOT advanced:`, JSON.stringify(data).slice(0, 300));
    process.exitCode = 1;
    return;
  }

  log(`[post] webhook ok — received ${data.received}, ingested ${data.ingested}, skipped ${data.skipped}` +
      `${data.errors && data.errors.length ? `, errors ${data.errors.length}` : ''}`);
  // The webhook dedupes on GUID, so advancing past already-logged messages is safe.
  trish.saveWatermark(statePath, maxRowId);
  log(`[watermark] advanced to ROWID ${maxRowId}`);
}

function clip(s) { return String(s).replace(/\s+/g, ' ').slice(0, 60); }

main().catch((e) => { console.error('[fatal]', e.message); process.exitCode = 1; });
