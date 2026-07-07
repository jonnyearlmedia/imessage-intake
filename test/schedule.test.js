const { test } = require('node:test');
const assert = require('node:assert');
const { normalizeProjectId } = require('../src/schedule');
const { parseStrictJSON } = require('../src/haiku');

test('normalizeProjectId maps names to real IDs', () => {
  assert.strictEqual(normalizeProjectId('Personal'), '699618ace9edd115282d1114');
  assert.strictEqual(normalizeProjectId('VPH'), '69c84865fb1b112958a4b6d5');
  assert.strictEqual(normalizeProjectId('MATH-182'), '6a28e8818f084696cd480594');
  assert.strictEqual(normalizeProjectId('Chores'), '69962017c71c71000000005e');
});

test('normalizeProjectId leaves real IDs untouched', () => {
  assert.strictEqual(normalizeProjectId('699618ace9edd115282d1114'), '699618ace9edd115282d1114');
});

test('parseStrictJSON salvages an array with trailing prose', () => {
  assert.deepStrictEqual(parseStrictJSON('[{"a":1}]  I\'m done'), [{ a: 1 }]);
});

test('parseStrictJSON parses a clean empty array', () => {
  assert.deepStrictEqual(parseStrictJSON('[]'), []);
});
