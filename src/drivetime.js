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

module.exports = { HOME, estimateDriveMinutes, staticEstimate, roundUp15, pad };
