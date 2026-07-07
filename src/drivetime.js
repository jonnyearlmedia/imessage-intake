// Drive-time estimate for away events. Live Google Routes API when a key is set,
// static table as fallback. Always: round UP to 15 min, then +10 min pad. Jonny is
// chronically late on purpose over-cushion (padding stacks on top of arrival buffers).

const HOME = '98 Castellina Cir, American Canyon, CA 94503';

// Static fallback (one-way minutes, pre-pad) keyed by loose destination match.
const STATIC_TABLE = [
  { match: /golf club rd|pleasant hill|\bdvc\b|\bvph\b|ellinwood/i, min: 27 },
  { match: /concord|solano way|kirker pass/i, min: 30 },
  { match: /fairfield|chadbourne|renee|therapy/i, min: 19 },
  { match: /american canyon|vallejo|mare island|napa/i, min: 10 },
];
const UNKNOWN_MIN = 30;

function roundUp15(min) { return Math.ceil(min / 15) * 15; }
function pad(min) { return roundUp15(min) + 10; }

function staticEstimate(destination) {
  const hit = STATIC_TABLE.find((r) => r.match.test(String(destination || '')));
  return pad(hit ? hit.min : UNKNOWN_MIN);
}

// Live traffic-aware estimate for the actual departure time via Routes API.
// Falls back to the static table on any error or missing key. Returns padded minutes.
async function estimateDriveMinutes(destination, departISO, env = process.env, fetchImpl = fetch) {
  const key = env.GOOGLE_MAPS_API_KEY;
  if (!key || !destination) return staticEstimate(destination);
  try {
    const r = await fetchImpl('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'routes.duration',
      },
      body: JSON.stringify({
        origin: { address: HOME },
        destination: { address: destination },
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_AWARE',
        departureTime: departISO || undefined,
      }),
    });
    if (!r.ok) return staticEstimate(destination);
    const d = await r.json();
    const dur = d.routes && d.routes[0] && d.routes[0].duration; // e.g. "1234s"
    if (!dur) return staticEstimate(destination);
    const seconds = parseInt(String(dur).replace('s', ''), 10);
    if (!Number.isFinite(seconds)) return staticEstimate(destination);
    return pad(Math.round(seconds / 60));
  } catch {
    return staticEstimate(destination);
  }
}

// ── The "later pass" the scheduler prompt promises ─────────────────────────────
// The Haiku scheduler emits away-event chains with travel blocks sized off the
// STATIC baseline baked into its prompt (one-way, un-padded). This pass replaces
// those durations with the real, traffic-aware (or padded-static) estimate and
// slides the neighbouring "Get Ready" block so the chain stays tight. The event
// itself never moves — only the travel/prep around it flex.

function isoOffset(iso) { return String(iso).slice(19); } // "-07:00" / "+00:00"
function minutesBetween(aISO, bISO) {
  return (new Date(bISO).getTime() - new Date(aISO).getTime()) / 60000;
}
// Shift an offset-bearing ISO string by N minutes, KEEPING its original offset.
function shiftISO(iso, deltaMin) {
  const offset = isoOffset(iso);
  const ms = new Date(iso).getTime() + deltaMin * 60000;
  const sign = offset[0] === '-' ? -1 : 1;
  const offMin = sign * (parseInt(offset.slice(1, 3), 10) * 60 + parseInt(offset.slice(4, 6), 10));
  const local = new Date(ms + offMin * 60000); // wall-clock in the target offset
  const p = (n) => String(n).padStart(2, '0');
  return `${local.getUTCFullYear()}-${p(local.getUTCMonth() + 1)}-${p(local.getUTCDate())}` +
    `T${p(local.getUTCHours())}:${p(local.getUTCMinutes())}:${p(local.getUTCSeconds())}${offset}`;
}

function isTravelBlock(t) {
  if (!t || typeof t !== 'object') return false;
  if (Array.isArray(t.tags) && t.tags.map((s) => String(s).toLowerCase()).includes('travel')) return true;
  return /^🚗/u.test(String(t.title || ''));
}
function isHomebound(t) { return /home/i.test(String((t && t.title) || '')); }
function isGetReady(t) {
  const title = String((t && t.title) || '');
  return /^👔/u.test(title) || /get ready/i.test(title);
}

// Pull a street address out of a task's content notes (the "📍" line the scheduler
// writes), falling back to any address-shaped substring. '' when none found.
function extractAddress(content) {
  const s = String(content || '');
  const pin = s.split('\n').find((l) => /📍/u.test(l));
  if (pin) {
    const a = pin.replace(/^[\s\S]*?📍\s*/u, '').trim();
    if (a) return a;
  }
  const m = s.match(/\d+\s+[^\n,]+?(?:Rd|Road|St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Ln|Lane|Way|Ct|Court|Cir|Circle|Pl|Place|Hwy|Highway)\b[^\n]*/i);
  return m ? m[0].trim() : '';
}

// Rewrite the travel blocks in one scheduler chain with live/padded drive times.
// Mutates + returns the same array (unknown shapes pass through untouched). Safe:
// any missing field / bad date on a block just skips that block.
async function applyLiveDriveTimes(items, { env = process.env, fetchImpl = fetch } = {}) {
  if (!Array.isArray(items) || !items.length) return items;
  const travel = items.filter(isTravelBlock);
  if (!travel.length) return items;
  // one destination per chain: the first travel block that names an address.
  const destination = travel.map((t) => extractAddress(t.content)).find(Boolean) || '';
  if (!destination) return items;

  for (const block of travel) {
    if (!block.startDate || !block.dueDate) continue;
    const oldMin = minutesBetween(block.startDate, block.dueDate);
    if (!Number.isFinite(oldMin) || oldMin <= 0) continue;
    const liveMin = await estimateDriveMinutes(destination, block.startDate, env, fetchImpl);
    if (!Number.isFinite(liveMin) || liveMin === oldMin) continue;

    if (isHomebound(block)) {
      // departure (right after the event) is fixed → move the arrival-home time.
      block.dueDate = shiftISO(block.startDate, liveMin);
    } else {
      // arrival (event start − buffer) is fixed → move the departure earlier/later,
      // and slide the "Get Ready" block that ended exactly when travel used to start.
      const oldStart = block.startDate;
      const newStart = shiftISO(block.dueDate, -liveMin);
      block.startDate = newStart;
      const deltaMin = minutesBetween(oldStart, newStart);
      if (deltaMin) {
        const gr = items.find((x) => isGetReady(x) && x.dueDate === oldStart);
        if (gr && gr.startDate && gr.dueDate) {
          gr.startDate = shiftISO(gr.startDate, deltaMin);
          gr.dueDate = shiftISO(gr.dueDate, deltaMin);
        }
      }
    }
  }
  return items;
}

module.exports = {
  HOME, estimateDriveMinutes, staticEstimate, roundUp15, pad,
  applyLiveDriveTimes, extractAddress, shiftISO, minutesBetween,
  isTravelBlock, isGetReady, isHomebound,
};
