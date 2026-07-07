const { test } = require('node:test');
const assert = require('node:assert');
const {
  staticEstimate, roundUp15, pad, extractAddress, shiftISO, minutesBetween,
  isTravelBlock, isGetReady, isHomebound, applyLiveDriveTimes, estimateDriveMinutes,
} = require('../src/drivetime');

test('staticEstimate: rounds up to 15 then pads +10', () => {
  assert.strictEqual(roundUp15(27), 30);
  assert.strictEqual(pad(27), 40);
  assert.strictEqual(staticEstimate('321 Golf Club Rd, Pleasant Hill CA 94523'), 40); // 27→30→40
  assert.strictEqual(staticEstimate('470 Chadbourne Rd, Fairfield CA 94534'), 40);    // 19→30→40
  assert.strictEqual(staticEstimate('somewhere unknown'), 40);                        // 30→30→40
});

test('extractAddress: pulls the 📍 line, else an address-shaped substring', () => {
  assert.strictEqual(
    extractAddress('📍 321 Golf Club Rd, Pleasant Hill CA 94523\n🕐 6pm'),
    '321 Golf Club Rd, Pleasant Hill CA 94523');
  assert.strictEqual(
    extractAddress('meet at 470 Chadbourne Rd, Fairfield'),
    '470 Chadbourne Rd, Fairfield');
  assert.strictEqual(extractAddress('no address here'), '');
  assert.strictEqual(extractAddress(null), '');
});

test('shiftISO keeps the original offset and moves the wall clock', () => {
  assert.strictEqual(shiftISO('2026-07-10T08:00:00-07:00', -13), '2026-07-10T07:47:00-07:00');
  assert.strictEqual(shiftISO('2026-07-10T08:27:00-07:00', 40), '2026-07-10T09:07:00-07:00');
  // crosses midnight, offset preserved
  assert.strictEqual(shiftISO('2026-07-10T23:50:00-08:00', 20), '2026-07-11T00:10:00-08:00');
});

test('minutesBetween is signed and offset-aware', () => {
  assert.strictEqual(minutesBetween('2026-07-10T08:00:00-07:00', '2026-07-10T08:27:00-07:00'), 27);
  assert.strictEqual(minutesBetween('2026-07-10T08:27:00-07:00', '2026-07-10T08:00:00-07:00'), -27);
});

test('block classifiers key off tags and title', () => {
  assert.ok(isTravelBlock({ title: '🚗 Travel → Shoot', tags: ['travel'] }));
  assert.ok(isTravelBlock({ title: '🚗 Drive Home' }));
  assert.ok(!isTravelBlock({ title: '🎬 Shoot' }));
  assert.ok(isGetReady({ title: '👔 Get Ready' }));
  assert.ok(isHomebound({ title: '🚗 Drive Home' }));
  assert.ok(!isHomebound({ title: '🚗 Travel → Shoot' }));
});

// Static fallback (no GOOGLE_MAPS_API_KEY) still corrects the prompt's un-padded
// baseline: an outbound 27-min block becomes the padded 40, arrival stays fixed,
// and the Get Ready block slides to stay adjacent.
test('applyLiveDriveTimes: resizes outbound travel + slides Get Ready, event fixed', async () => {
  const chain = [
    { title: '👔 Get Ready', startDate: '2026-07-10T07:00:00-07:00', dueDate: '2026-07-10T08:00:00-07:00' },
    { title: '🚗 Travel → Shoot', tags: ['travel'],
      content: '📍 321 Golf Club Rd, Pleasant Hill CA 94523',
      startDate: '2026-07-10T08:00:00-07:00', dueDate: '2026-07-10T08:27:00-07:00' },
    { title: '🎬 VPH Shoot', startDate: '2026-07-10T08:27:00-07:00', dueDate: '2026-07-10T10:27:00-07:00' },
    { title: '🚗 Drive Home', tags: ['travel'],
      content: '📍 321 Golf Club Rd, Pleasant Hill CA 94523',
      startDate: '2026-07-10T10:27:00-07:00', dueDate: '2026-07-10T10:54:00-07:00' },
  ];
  const out = await applyLiveDriveTimes(chain, { env: {} }); // no key → padded static (40 min)

  const travel = out.find((t) => /Travel/.test(t.title));
  assert.strictEqual(travel.dueDate, '2026-07-10T08:27:00-07:00', 'arrival (event start) unchanged');
  assert.strictEqual(travel.startDate, '2026-07-10T07:47:00-07:00', 'departure moved back to 40 min');

  const gr = out.find((t) => /Get Ready/.test(t.title));
  assert.strictEqual(gr.dueDate, '2026-07-10T07:47:00-07:00', 'Get Ready still ends when travel starts');
  assert.strictEqual(gr.startDate, '2026-07-10T06:47:00-07:00', 'Get Ready keeps its 1h length');

  const event = out.find((t) => /Shoot/.test(t.title) && !/Travel/.test(t.title));
  assert.strictEqual(event.startDate, '2026-07-10T08:27:00-07:00', 'the event itself never moves');

  const home = out.find((t) => /Drive Home/.test(t.title));
  assert.strictEqual(home.startDate, '2026-07-10T10:27:00-07:00', 'drive-home departure fixed after event');
  assert.strictEqual(home.dueDate, '2026-07-10T11:07:00-07:00', 'drive-home arrival = +40 min');
});

test('applyLiveDriveTimes: leaves chains with no travel block untouched', async () => {
  const single = [{ title: '🦷 Dentist', startDate: '2026-07-10T09:00:00-07:00', dueDate: '2026-07-10T10:00:00-07:00' }];
  const out = await applyLiveDriveTimes(single, { env: {} });
  assert.deepStrictEqual(out, single);
});

test('estimateDriveMinutes: falls back to static on a failing Routes call', async () => {
  const fakeFetch = async () => ({ ok: false, status: 500, text: async () => 'err' });
  const min = await estimateDriveMinutes('somewhere', '2026-07-10T08:00:00-07:00', { GOOGLE_MAPS_API_KEY: 'x' }, fakeFetch);
  assert.strictEqual(min, 40); // unknown → 30 → padded 40
});
