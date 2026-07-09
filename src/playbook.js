// The playbook: known senders → who they are + how to route their tasks. Fed to the
// scheduler as context so it isn't guessing who texted or where the task belongs.
// Match is by the last 10 digits, so formatting differences ("+1 707…", "7073…")
// don't matter.

function normalizePhone(s) {
  const d = String(s || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : d;
}

// keyed by normalized (last-10) number.
// `autoApprove: true` skips the approval loop and posts straight to TickTick — the
// graduated-trust fast path, reserved for senders whose tasks are always right
// (e.g. a clinic's appointment confirmations). Everything else waits for Jonny.
const CONTACTS = {
  '6507030319': { name: 'Mama (Jonny\'s mom)', hint: 'Route by what the task is actually about (use judgment).' },
  '7074198989': { name: 'Clinic Ole', hint: 'Medical appointments — project Personal, tag "appointment"; if a specific time is given, build the get-ready + travel + drive-home chain.' },
  '7073345988': { name: 'Ate Janel', hint: 'Route by what the task is actually about (use judgment).' },
};

// keyed by lowercased email address — the email (Notion comms-log) equivalent.
const EMAIL_CONTACTS = {
  // 'trish@example.com': { name: 'Trish (VPH)', hint: 'VPH client work — route to VPH; deliverables, invoices, scheduling.' },
};

function lookupContact(number) {
  return CONTACTS[normalizePhone(number)] || null;
}

function normalizeEmail(s) {
  return String(s || '').trim().toLowerCase();
}
function lookupEmail(email) {
  return EMAIL_CONTACTS[normalizeEmail(email)] || null;
}
function isKnownEmail(email) {
  return !!lookupEmail(email);
}

module.exports = {
  normalizePhone, lookupContact, CONTACTS,
  normalizeEmail, lookupEmail, isKnownEmail, EMAIL_CONTACTS,
};
