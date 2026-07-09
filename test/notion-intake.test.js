const { test } = require('node:test');
const assert = require('node:assert');
const { pageToRow, passesEmailGate, rowToCandidate } = require('../src/notion-intake');

function page(overrides = {}) {
  const props = {
    'Message ID': { rich_text: [{ plain_text: 'msg-1' }] },
    'Direction': { select: { name: 'Incoming' } },
    'Classification': { select: { name: 'Task' } },
    'Action Needed': { checkbox: true },
    'Action Type': { select: { name: 'Scheduling / RSVP' } },
    'Waiting On': { select: { name: 'Jonny' } },
    'Priority': { select: { name: 'High' } },
    'Account': { select: { name: 'media' } },
    'Sender Name': { rich_text: [{ plain_text: 'Trish' }] },
    'Sender Email': { email: 'trish@example.com' },
    'Subject': { rich_text: [{ plain_text: 'Concert shoot Saturday' }] },
    'Short Summary': { rich_text: [{ plain_text: 'Need footage' }] },
    'Detailed Summary': { rich_text: [{ plain_text: 'Please shoot the concert Sat 2pm' }] },
    'Extracted Dates': { rich_text: [{ plain_text: '2026-07-11' }] },
    'Received At': { date: { start: '2026-07-08T09:00:00Z' } },
    ...overrides.properties,
  };
  return { id: 'page-1', created_time: '2026-07-08T10:00:00.000Z', properties: props, ...overrides.top };
}

test('pageToRow — extracts every field type', () => {
  const row = pageToRow(page());
  assert.equal(row.messageId, 'msg-1');
  assert.equal(row.direction, 'Incoming');
  assert.equal(row.classification, 'Task');
  assert.equal(row.actionNeeded, true);
  assert.equal(row.waitingOn, 'Jonny');
  assert.equal(row.senderName, 'Trish');
  assert.equal(row.senderEmail, 'trish@example.com');
  assert.equal(row.subject, 'Concert shoot Saturday');
  assert.equal(row.extractedDates, '2026-07-11');
  assert.equal(row.createdTime, '2026-07-08T10:00:00.000Z');
});

test('passesEmailGate — a Task waiting on Jonny passes', () => {
  assert.equal(passesEmailGate(pageToRow(page())), true);
});

test('passesEmailGate — newsletters and receipts are dropped', () => {
  const news = pageToRow(page({ properties: { Classification: { select: { name: 'Newsletter' } }, 'Action Needed': { checkbox: false } } }));
  assert.equal(passesEmailGate(news), false);
  const receipt = pageToRow(page({ properties: { Classification: { select: { name: 'Receipt' } }, 'Action Needed': { checkbox: false } } }));
  assert.equal(passesEmailGate(receipt), false);
});

test('passesEmailGate — outgoing is dropped', () => {
  const out = pageToRow(page({ properties: { Direction: { select: { name: 'Outgoing' } } } }));
  assert.equal(passesEmailGate(out), false);
});

test('passesEmailGate — a task not pointed at Jonny and with no dates is dropped', () => {
  const row = pageToRow(page({ properties: {
    'Waiting On': { select: { name: 'External' } },
    'Action Type': { select: { name: 'FYI / Status Update' } },
    'Action Needed': { checkbox: false },
    'Extracted Dates': { rich_text: [] },
    'Classification': { select: { name: 'Task' } },
  } }));
  assert.equal(passesEmailGate(row), false);
  // …but the same row passes if the sender is a known playbook contact
  assert.equal(passesEmailGate(row, (e) => e === 'trish@example.com'), true);
});

test('passesEmailGate — extracted dates alone qualify (an appointment)', () => {
  const row = pageToRow(page({ properties: {
    'Waiting On': { select: { name: 'External' } },
    'Action Type': { select: { name: 'No action' } },
    'Action Needed': { checkbox: false },
    'Classification': { select: { name: 'Task' } },
    'Extracted Dates': { rich_text: [{ plain_text: 'July 11 2pm' }] },
  } }));
  assert.equal(passesEmailGate(row), true);
});

test('rowToCandidate — synthesizes scheduler-ready text', () => {
  const c = rowToCandidate(pageToRow(page()));
  assert.equal(c.source, 'email');
  assert.equal(c.messageId, 'msg-1');
  assert.equal(c.sender, 'Trish');
  assert.ok(c.text.includes('Concert shoot Saturday'), 'includes subject');
  assert.ok(c.text.includes('shoot the concert Sat 2pm'), 'includes summary');
  assert.ok(c.text.includes('2026-07-11'), 'includes extracted dates');
  assert.ok(c.text.includes('Trish'), 'names the sender');
});
