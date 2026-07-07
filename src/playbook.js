// The playbook: known senders → who they are + how to route their tasks. Fed to the
// scheduler as context so it isn't guessing who texted or where the task belongs.
// Match is by the last 10 digits, so formatting differences ("+1 707…", "7073…")
// don't matter.

function normalizePhone(s) {
  const d = String(s || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : d;
}

// keyed by normalized (last-10) number
const CONTACTS = {
  '6507030319': { name: 'Mama (Jonny\'s mom)', hint: 'Route by what the task is actually about (use judgment).' },
  '7074198989': { name: 'Clinic Ole', hint: 'Medical appointments — project Personal, tag "appointment"; if a specific time is given, build the get-ready + travel + drive-home chain.' },
  '7073345988': { name: 'Ate Janel', hint: 'Route by what the task is actually about (use judgment).' },
};

function lookupContact(number) {
  return CONTACTS[normalizePhone(number)] || null;
}

module.exports = { normalizePhone, lookupContact, CONTACTS };
