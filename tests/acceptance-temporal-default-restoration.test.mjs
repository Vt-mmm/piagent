import assert from 'node:assert/strict';
import test from 'node:test';
import { productionV3ReferenceSolution } from './helpers/production-v3-reference-solutions.mjs';
import { acceptanceInvalidInputEvidence } from '../packages/piagent-core/extensions/acceptance-contract-semantics.js';
import { contextualTemporalCriterion } from '../packages/piagent-core/extensions/acceptance-temporal-contract.js';

const [, source] = productionV3ReferenceSolution('expiry-boundary');
const criteria = [
  'Fix `isExpired(expiresAt, now)`.',
  'Accept an ISO timestamp string or `Date` for `expiresAt`, and a millisecond number or `Date` for `now`.',
  'Invalid dates must throw `TypeError`;',
  'If the second argument is omitted, read `Date.now()` after validating `expiresAt`.',
  "do not use the machine's current time when an explicit falsey value is provided.",
  'If the second argument is explicitly supplied as `undefined`, throw `TypeError` without reading the clock.'
];
const focused = `import assert from 'node:assert/strict';
import test from 'node:test';
import { isExpired } from './expiry.js';
test('invalid expiry values', () => {
  for (const value of ['not-a-date', '2023-02-29T00:00:00Z', new Date(NaN)]) {
    assert.throws(() => isExpired(value, 0), TypeError);
  }
});
test('explicit undefined does not read the clock', () => {
  const original = Date.now;
  Date.now = () => { throw new Error('clock read'); };
  try {
    for (const value of [undefined, null, false, NaN]) {
      assert.throws(() => isExpired('1970-01-01T00:00:00Z', value), TypeError);
    }
  } finally { Date.now = original; }
});`;
const proof = (sourceText = source, testText = focused, selected = criteria[2]) => acceptanceInvalidInputEvidence({
  taskText: contextualTemporalCriterion(selected, selected, { acceptanceCriteria: criteria }),
  sourceText, testText, sourceEntries: [{path: 'expiry.js', text: sourceText}],
  testEntries: [{path: 'expiry.test.js', text: testText}], namedTargets: ['isExpired']
});

test('identity default and catch-free clock restoration retain source and executable test proof', () => {
  for (const selected of [criteria[2], criteria[5]]) assert.deepEqual(proof(source, focused, selected), {sourceOk: true, testOk: true});
});

for (const [name, from, to] of [
  ['clock default', 'now = undefined', 'now = Date.now()'],
  ['numeric default', 'now = undefined', 'now = 0'],
  ['truthy fallback', 'arguments.length < 2 ? Date.now() : nowTimestamp(now)', 'now || Date.now()'],
  ['clock before validation', '  const timestamp = expiryTimestamp(expiresAt);\n  const current = arguments.length < 2 ? Date.now() : nowTimestamp(now);', '  const current = arguments.length < 2 ? Date.now() : nowTimestamp(now);\n  const timestamp = expiryTimestamp(expiresAt);'],
  ['wrong omission boundary', 'arguments.length < 2', 'arguments.length < 3'],
  ['wrong calendar bound', 'day > daysInMonth[month - 1]', 'day > 31'],
  ['wrong leap century', 'year % 400', 'year % 300'],
  ['swapped offset', 'const offset = match[8]', 'const offset = match[7]'],
  ['wrong error class', 'new TypeError', 'new RangeError'],
  ['wrong inclusive boundary', 'return current >= timestamp;', 'return current > timestamp;'],
  ['shadowed undefined', 'const timestamp = expiryTimestamp(expiresAt);', 'const undefined = 0; const timestamp = expiryTimestamp(expiresAt);']
]) test(`temporal source proof rejects ${name}`, () => {
  assert.ok(source.includes(from));
  assert.equal(proof(source.replace(from, to)).sourceOk, false);
});

for (const [name, from, to] of [
  ['catch swallows assertions', '} finally { Date.now = original; }', '} catch (error) {} finally { Date.now = original; }'],
  ['return in finally', 'Date.now = original; }', 'Date.now = original; return; }'],
  ['return before try', '  try {', '  return; try {'],
  ['return inside try', '  try {', '  try { return;'],
  ['disabled try', '  try {', '  if (false) try {'],
  ['uncalled try', '  try {', '  const unused = () => { try {'],
  ['missing undefined partition', '[undefined, null, false, NaN]', '[null, false, NaN]'],
  ['mutated loop input', '    for (const value of', '    for (let value of']
]) test(`temporal test proof abstains for ${name}`, () => {
  let changed = focused.replace(from, to);
  if (name === 'uncalled try') changed = changed.replace('} finally { Date.now = original; }', '} finally { Date.now = original; } };');
  if (name === 'mutated loop input') changed = changed.replace("      assert.throws", "      value = null; assert.throws");
  assert.equal(proof(source, changed).testOk, false);
});
