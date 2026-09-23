import assert from "node:assert/strict";
import test from "node:test";
import { acceptanceInvalidInputEvidence } from "../packages/piagent-core/extensions/acceptance-contract-semantics.js";
import { declaredIntegerDomains } from "../packages/piagent-core/extensions/acceptance-integer-domains.js";

const domainText = "`bucketCount(totalUnits, unitSize)` must throw `TypeError` unless total units is a non-negative integer and unit size is a positive integer.";
const mixedText = "`bucketCount(totalUnits, unitSize)` must use exact ceiling division, return zero for zero units, and throw `TypeError` unless total units is a non-negative integer and unit size is a positive integer.";
const helper = "function integer(value, minimum) { if (!Number.isInteger(value) || value < minimum) throw new TypeError('invalid integer'); return value; }";
const source = `${helper}\nexport function bucketCount(totalUnits, unitSize) { integer(totalUnits, 0); integer(unitSize, 1); return Math.ceil(totalUnits / unitSize); }`;
const invalidCalls = ["-1, 5", "1.5, 5", "'1', 5", "Infinity, 5", "10, -1", "10, 0", "10, 1.5", "10, '5'", "10, Infinity"];
const tests = calls => "import assert from 'node:assert/strict'; import { bucketCount } from '../src/numeric.js';\n"
  + calls.map(args => `assert.throws(() => bucketCount(${args}), TypeError);`).join("\n");
function evidence(options = {}) {
  const sourceText = options.source ?? source, testText = options.tests ?? tests(options.calls ?? invalidCalls);
  return acceptanceInvalidInputEvidence({ taskText: options.text ?? domainText, sourceText, testText,
    sourceEntries: [{ path: "src/numeric.js", text: sourceText }, ...(options.sourceEntries ?? [])],
    testEntries: [{ path: "test/numeric.test.js", text: testText }, ...(options.testEntries ?? [])],
    namedTargets: [options.target ?? "bucketCount"], provenanceTargets: [], includeDiagnostics: options.diagnostics === true });
}

test("declared integer domains bind each parameter and literal helper minimum", () => {
  assert.deepEqual(evidence(), { sourceOk: true, testOk: true });
  const inline = "export function bucketCount(totalUnits, unitSize) { if (!Number.isInteger(totalUnits) || totalUnits < 0) throw new TypeError(); if (!Number.isInteger(unitSize) || unitSize < 1) throw new TypeError(); return Math.ceil(totalUnits / unitSize); }";
  assert.deepEqual(evidence({ source: inline }), { sourceOk: true, testOk: true });
});

test("rejection evidence never silently proves additional arithmetic and zero-result clauses", () => {
  for (const implementation of [source, source.replace("Math.ceil", "Math.floor"), source.replace("Math.ceil(totalUnits / unitSize)", "1")]) {
    const result = evidence({ text: mixedText, source: implementation, diagnostics: true });
    assert.equal(result.sourceOk, false);
    assert.equal(result.testOk, true);
    assert.equal(result.integerDomainProof?.rejectionEstablished, true);
    assert.equal(result.integerDomainProof?.wholeCriterionEstablished, false);
    assert.match(result.integerDomainProof?.unprovedClauses.join(" ") ?? "", /ceiling division.*zero/);
  }
});

test("domain proof follows declared names and argument positions, not fixture identities", () => {
  const renamedSource = source.replaceAll("bucketCount", "segmentTotal").replaceAll("totalUnits", "itemTotal").replaceAll("unitSize", "capacity");
  const text = "`segmentTotal(capacity, itemTotal)` must throw `TypeError` unless item total is a non-negative integer and capacity is a positive integer.";
  const swappedSource = renamedSource.replace("segmentTotal(itemTotal, capacity)", "segmentTotal(capacity, itemTotal)");
  const swappedCalls = invalidCalls.map(args => args.split(", ").reverse().join(", "));
  assert.deepEqual(evidence({ source: swappedSource, text, target: "segmentTotal",
    tests: tests(swappedCalls).replaceAll("bucketCount", "segmentTotal") }), { sourceOk: true, testOk: true });
});

test("isolated invalid witnesses are required separately for each declared parameter", () => {
  for (const missing of invalidCalls) assert.equal(evidence({ calls: invalidCalls.filter(call => call !== missing) }).testOk, false, missing);
  assert.equal(evidence({ calls: ["-1, -1", "1.5, 1.5", "'1', '5'", "Infinity, Infinity", "0, 0"] }).testOk, false);
  assert.equal(evidence({ calls: ["...[1], 1.5", "...[], 1.5", ...invalidCalls.filter(call => !call.includes("1.5"))] }).testOk, false);
});

test("wrong guard, threshold, error, binding, control flow or helper argument cannot supply source proof", () => {
  for (const changed of [
    source.replace("integer(totalUnits, 0)", "integer(totalUnits, 1)"),
    source.replace("integer(unitSize, 1)", "integer(unitSize, 0)"),
    source.replace("integer(unitSize, 1)", "integer(totalUnits, 1)"),
    source.replace("integer(unitSize, 1);", ""),
    source.replace("value < minimum", "value <= minimum"),
    source.replace("Number.isInteger(value)", "Number.isSafeInteger(value)"),
    source.replace("Number.isInteger(value)", "Number.isFinite(value)"),
    source.replace("Number.isInteger(value)", "Number.isInteger(Number(value))"),
    source.replace("TypeError('invalid integer')", "RangeError('invalid integer')"),
    source.replace("TypeError('invalid integer')", "TypeError(makeMessage())"),
    source.replace("integer(totalUnits, 0);", "return 0; integer(totalUnits, 0);"),
    source.replace("integer(totalUnits, 0);", "totalUnits = 0; integer(totalUnits, 0);"),
    source.replace("integer(totalUnits, 0);", "try { integer(totalUnits, 0); } catch {}"),
    source.replace("integer(totalUnits, 0)", "integer(totalUnits, minimum)"),
    source.replace("integer(totalUnits, 0)", "integer(...[totalUnits, 0])"),
    source.replace("function integer(value, minimum)", "async function integer(value, minimum)"),
    source + "\ninteger = () => 1;",
    source + "\nfunction mutate() { integer = () => 1; }",
    source + "\nfunction mutate(Number) { return Number.isInteger(1); }"
  ]) assert.equal(evidence({ source: changed }).sourceOk, false, changed);
});

test("wrong-module, skipped, dead, rebound or wrong-error tests do not prove the parameter domains", () => {
  const validTests = tests(invalidCalls);
  for (const changed of [
    validTests.replace("../src/numeric.js", "../src/unrelated.js"),
    validTests.replaceAll("TypeError", "RangeError"),
    validTests.replace("assert.throws", "if (false) assert.throws"),
    validTests + "\nbucketCount = () => 1;"
  ]) assert.equal(evidence({ tests: changed }).testOk, false);
  const skipped = "import assert from 'node:assert/strict'; import test from 'node:test'; import { bucketCount } from '../src/numeric.js';\n"
    + "test.skip('numeric', () => {" + validTests.slice(validTests.indexOf("\n") + 1) + "});";
  assert.equal(evidence({ tests: skipped }).testOk, false);
});

test("unparsed domain constraints and ambiguous parameter labels do not fall back to name overlap", () => {
  for (const text of [domainText.replace("positive integer", "positive safe integer"),
    domainText.replace("positive integer.", "positive integer and unit size is below ten."),
    domainText.replace("unit size is", "unknown field is")]) {
    assert.equal(evidence({ text }).sourceOk, false);
  }
});

test("non-numeric rejection clauses remain with their existing proof routes", () => {
  assert.equal(declaredIntegerDomains("`readName(input)` must throw `TypeError` unless input is a non-empty string."), null);
});

test("bounded literal loop witnesses remain tied to the original isolated argument", () => {
  const loopTests = tests(invalidCalls.filter(call => !call.includes("Infinity") && !call.includes("'")))
    + "\nfor (const value of [undefined, null, true, {}, [], NaN, Infinity, -Infinity]) { assert.throws(() => bucketCount(value, 5), TypeError); assert.throws(() => bucketCount(10, value), TypeError); }";
  assert.deepEqual(evidence({ tests: loopTests }), { sourceOk: true, testOk: true });
});

test("test-side intrinsic mutation or shadowed special literals cannot manufacture domain witnesses", () => {
  for (const prefix of ["const Infinity = 5;", "const NaN = 5;", "function shadow(undefined) { return undefined; }",
    "Number.isInteger = () => false;", "const numeric = Number; numeric.isInteger = () => false;", "Math.ceil = () => 1;"]) {
    assert.equal(evidence({ tests: prefix + "\n" + tests(invalidCalls) }).testOk, false, prefix);
  }
});

test("type rejection must short-circuit before a lower-bound comparison can coerce an object", async () => {
  const reversedHelper = source.replace("!Number.isInteger(value) || value < minimum", "value < minimum || !Number.isInteger(value)");
  const reversedInline = "export function bucketCount(totalUnits, unitSize) { if (totalUnits < 0 || !Number.isInteger(totalUnits)) throw new TypeError(); if (!Number.isInteger(unitSize) || unitSize < 1) throw new TypeError(); return Math.ceil(totalUnits / unitSize); }";
  for (const implementation of [reversedHelper, reversedInline]) {
    const module = await import("data:text/javascript," + encodeURIComponent(implementation));
    const hostile = { valueOf() { throw new RangeError("coercion ran before type rejection"); } };
    assert.throws(() => module.bucketCount(hostile, 5), RangeError, "executed counterexample establishes wrong error, not merely missing analyzer coverage");
    assert.equal(evidence({ source: implementation }).sourceOk, false);
  }
  const correct = await import("data:text/javascript," + encodeURIComponent(source));
  assert.throws(() => correct.bucketCount({ valueOf() { throw new RangeError(); } }, 5), TypeError);
});

test("lowercasing a local identifier cannot turn a negative-number witness into an intrinsic non-finite value", () => {
  for (const alias of ["infinity", "nan", "INFINITY", "Nan"]) {
    const aliased = tests(invalidCalls.filter(call => !call.includes("Infinity")))
      + `\nconst ${alias} = -1; assert.throws(() => bucketCount(${alias}, 5), TypeError); assert.throws(() => bucketCount(10, ${alias}), TypeError);`;
    assert.equal(evidence({ tests: aliased }).testOk, false, alias);
  }
});

// Explicit Number arithmetic and the declared rejection domains must both hold.
{
const text = '`bucketCount(totalUnits, unitSize)` must return `Math.ceil(totalUnits / unitSize)` using JavaScript Number division, return zero for zero units, and throw `TypeError` unless total units is a non-negative integer and unit size is a positive integer.';
const source = 'function integer(value, minimum) { if (!Number.isInteger(value) || value < minimum) throw new TypeError("invalid integer"); return value; }\nexport function bucketCount(totalUnits, unitSize) { integer(totalUnits, 0); integer(unitSize, 1); return Math.ceil(totalUnits / unitSize); }';
const prelude = "import assert from 'node:assert/strict'; import test from 'node:test'; import { bucketCount } from '../src/numeric.js';\n";
const success = ['0, 5', '10, 5', '11, 5', '2 ** 54, 3'].map((args, i) => `assert.equal(bucketCount(${args}), ${[0,2,3,6004799503160661][i]});`).join('\n');
const rejected = ['-1, 5', '1.5, 5', "'1', 5", 'Infinity, 5', '10, -1', '10, 0', '10, 1.5', "10, '5'", '10, Infinity'].map(args => `assert.throws(() => bucketCount(${args}), TypeError);`).join('\n');
const tests = prelude + "test('complete domain and calculation', () => {\n" + success + '\n' + rejected + '\n});';
function evidence(options = {}) {
  const input = { taskText: options.text ?? text, sourceText: options.source ?? source, testText: options.tests ?? tests,
    namedTargets: [options.name ?? 'bucketCount'], provenanceTargets: [], includeDiagnostics: true };
  return acceptanceInvalidInputEvidence({ ...input, sourceEntries: [{ path: options.sourcePath ?? 'src/numeric.js', text: input.sourceText }, ...(options.extraSources ?? [])],
    testEntries: [{ path: 'test/numeric.test.js', text: input.testText }] });
}
test('explicit Number formula, zero clause and input domains are established together', () => {
  const result = evidence();
  assert.equal(result.sourceOk, true, JSON.stringify(result));
  assert.equal(result.testOk, true, JSON.stringify(result));
  assert.equal(result.integerDomainProof.wholeCriterionEstablished, true);
});
for (const [label, next] of [
  ['floor', source.replace('Math.ceil', 'Math.floor')],
  ['constant', source.replace('Math.ceil(totalUnits / unitSize)', '1')],
  ['reversed division', source.replace('totalUnits / unitSize', 'unitSize / totalUnits')],
  ['ceil before division', source.replace('Math.ceil(totalUnits / unitSize)', 'Math.ceil(totalUnits) / unitSize')],
  ['coerced', source.replace('totalUnits / unitSize', 'Number(totalUnits) / unitSize')],
  ['integer arithmetic', source.replace('Math.ceil(totalUnits / unitSize)', 'Number((BigInt(totalUnits) + BigInt(unitSize) - 1n) / BigInt(unitSize))')],
  ['missing domain', source.replace('integer(unitSize, 1);', '')],
  ['safe integer only', source.replace('Number.isInteger', 'Number.isSafeInteger')],
  ['mutated intrinsic', source + '\nfunction mutate() { Math.ceil = () => 0; }'],
  ['shadowed Math', source.replace('bucketCount(totalUnits, unitSize)', 'bucketCount(totalUnits, unitSize, Math)')],
]) test(`calculation or rejection counterexample remains unproved: ${label}`, () => {
  assert.equal(evidence({ source: next }).sourceOk, false);
});
for (const omitted of success.split('\n')) test(`requires a live calculation witness: ${omitted}`, () => {
  const result = evidence({ tests: tests.replace(omitted, '') });
  assert.equal(result.testOk, false, JSON.stringify(result));
});
for (const [label, next] of [
  ['skipped', tests.replace("test('complete", "test.skip('complete")],
  ['dead success', tests.replace(success, 'if (false) {\n' + success + '\n}')],
  ['wrong module', tests.replace('../src/numeric.js', '../src/elsewhere.js')],
  ['rebound target', tests + '\nbucketCount = () => 1;'],
  ['test intrinsic mutation', 'Math.ceil = () => 1;\n' + tests],
  ['missing rejection', tests.replace("assert.throws(() => bucketCount('1', 5), TypeError);", '')],
]) test(`untrusted or incomplete witnesses do not complete: ${label}`, () => {
  const result = evidence({ tests: next }); assert.equal(result.sourceOk && result.testOk, false);
});
for (const next of [
  text.replace('zero units', 'zero size'),
  text.replace('zero units', 'zero inputs'),
  text.replace('using JavaScript Number division', 'using exact integer division'),
  text.replace('Math.ceil', 'math.ceil'),
  text.replace('Math.ceil(totalUnits / unitSize)', 'Math.ceil(unitSize / totalUnits)'),
  text.replace('return zero for zero units', 'return zero for zero units and write a log'),
]) test(`additional or mismatched clauses stay unproved: ${next}`, () => assert.equal(evidence({ text: next }).sourceOk, false));
test('binding follows names and argument positions', () => {
  const replace = value => value.replaceAll('bucketCount','segmentCount').replaceAll('totalUnits','entryTotal').replaceAll('unitSize','capacity').replaceAll('total units','entry total').replaceAll('unit size','capacity').replace('zero units', 'zero total');
  const result = evidence({ text: replace(text), source: replace(source), tests: replace(tests), name: 'segmentCount' });
  assert.equal(result.sourceOk && result.testOk, true, JSON.stringify(result));
});
test('other supplied source modules cannot mutate arithmetic intrinsics', () => {
  for (const entry of [
    'Math.ceil = () => 0;',
    'function mutate() { Math.ceil = () => 0; }',
    'const numeric = Math; numeric.ceil = () => 0;',
  ]) assert.equal(evidence({ extraSources: [{ path: 'src/other.js', text: entry }] }).sourceOk, false, entry);
});
test('swapping the declared positions keeps expression and witness bindings exact', () => {
  const nextText = text.replace('bucketCount(totalUnits, unitSize)', 'bucketCount(unitSize, totalUnits)');
  const nextSource = source.replace('bucketCount(totalUnits, unitSize)', 'bucketCount(unitSize, totalUnits)');
  const nextTests = tests.replace(/bucketCount\(([^,()]+), ([^()]+)\)/g, (_, a, b) => `bucketCount(${b}, ${a})`);
  const result = evidence({ text: nextText, source: nextSource, tests: nextTests });
  assert.equal(result.sourceOk && result.testOk, true, JSON.stringify(result));
});
test('Number rounding witness distinguishes integer quotient arithmetic', async () => {
  const correct = (await import('data:text/javascript,' + encodeURIComponent(source))).bucketCount;
  const wrong = (await import('data:text/javascript,' + encodeURIComponent(source.replace('Math.ceil(totalUnits / unitSize)', 'Number((BigInt(totalUnits) + BigInt(unitSize) - 1n) / BigInt(unitSize))')))).bucketCount;
  assert.equal(correct(2 ** 54, 3), 6004799503160661);
  assert.notEqual(wrong(2 ** 54, 3), correct(2 ** 54, 3));
});
}
