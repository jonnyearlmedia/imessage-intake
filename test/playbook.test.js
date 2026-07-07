const { test } = require('node:test');
const assert = require('node:assert');
const { normalizePhone, lookupContact } = require('../src/playbook');

test('normalizePhone reduces any format to last 10 digits', () => {
  assert.strictEqual(normalizePhone('+1 (707) 419-8989'), '7074198989');
  assert.strictEqual(normalizePhone('17074198989'), '7074198989');
  assert.strictEqual(normalizePhone('7074198989'), '7074198989');
});

test('lookupContact matches known senders regardless of formatting', () => {
  assert.strictEqual(lookupContact('+1 650-703-0319').name, 'Mama (Jonny\'s mom)');
  assert.match(lookupContact('7074198989').hint, /appointment/i);
  assert.ok(lookupContact('ate janel test') === null); // non-number → no match
  assert.ok(lookupContact('+19998887777') === null);   // unknown number → no match
});
