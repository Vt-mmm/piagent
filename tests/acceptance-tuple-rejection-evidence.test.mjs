import assert from "node:assert/strict";
import test from "node:test";
import { acceptanceExecutableTestBinding, acceptanceInvalidInputEvidence, sanitizeJavaScriptEvidence } from "../packages/piagent-core/extensions/acceptance-contract-semantics.js";
import { executableRejectionAssertions } from "../packages/piagent-core/extensions/acceptance-executable-evidence.js";

// These are static evidence inputs, never evaluated implementations or tests.
const sourceEntry = { path: "src/deadline.js", text: "export function deadlinePassed(deadline, currentTime) { return false; }" };
const contract = "`deadlinePassed(deadline, currentTime)` accepts an ISO timestamp string or `Date` for `deadline`, and a millisecond number or `Date` for `currentTime`. Invalid dates must throw `TypeError`; do not use the machine's current time when an explicit falsey value is provided.";
const prefix = 'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { deadlinePassed } from "../src/deadline.js";\n';
const rows = '[ ["March 7, 2027", 0], ["2027-02-29T00:00:00Z", 0], [new Date(NaN), 0] ]';
const assertion = "assert.throws(() => deadlinePassed(first, second), TypeError);";
const loop = `for (const [first, second] of ${rows}) { ${assertion} }`;
const nowLoop = 'for (const [first, second] of [["2027-01-01T00:00:00Z", undefined]]) { assert.throws(() => deadlinePassed(first, second), TypeError); }';
const registered = (body) => `${prefix}test("contract", () => { ${body} });`;
const evidence = (text) => acceptanceInvalidInputEvidence({
  taskText: contract, sourceText: sourceEntry.text, testText: text,
  sourceEntries: [sourceEntry], testEntries: [{ path: "test/deadline.test.js", text }],
  namedTargets: ["deadlinePassed"], provenanceTargets: ["deadlinePassed"]
});
const extracted = (text) => executableRejectionAssertions(sanitizeJavaScriptEvidence(text).toLowerCase(), new Set(["deadlinepassed"]));
const linked = (text) => acceptanceExecutableTestBinding({ sourceEntry, testEntry: { path: "test/deadline.test.js", text } }).linked;
const coverage = (text) => extracted(text).map(({ targets, errorClasses, invalidArgumentPartitions }) => ({ targets, errorClasses, invalidArgumentPartitions }));

test("literal tuple rows prove the same argument partitions as direct assertions without granting source proof", () => {
  const tupleText = registered(`${loop}\n${nowLoop}`);
  const directText = registered([
    'assert.throws(() => deadlinePassed("March 7, 2027", 0), TypeError);',
    'assert.throws(() => deadlinePassed("2027-02-29T00:00:00Z", 0), TypeError);',
    'assert.throws(() => deadlinePassed(new Date(NaN), 0), TypeError);',
    'assert.throws(() => deadlinePassed("2027-01-01T00:00:00Z", undefined), TypeError);'
  ].join("\n"));
  assert.deepEqual(evidence(tupleText), { sourceOk: false, testOk: true });
  assert.deepEqual(coverage(tupleText), coverage(directText));
  assert.equal(linked(tupleText), true);
  assert.equal(extracted(tupleText).length, 4);
});

test("tuple proof supports immutable named tables, unbraced loops and alpha-renamed bindings", () => {
  const bodies = [
    `const cases = ${rows}; for (const [first, second] of cases) { ${assertion} }`,
    loop.replace(`{ ${assertion} }`, assertion),
    loop.replaceAll("first", "candidate").replaceAll("second", "reference"),
    loop.replaceAll("new Date(NaN)", 'new Date("invalid")'),
    loop.replace("[first, second]", "[first, second,]")
      .replace(rows, rows.replaceAll(", 0]", ", 0,]").replace(/ \]$/, ", ]"))
  ];
  for (const body of bodies) {
    const text = registered(`${body}\n${nowLoop}`);
    assert.equal(evidence(text).testOk, true, body);
    assert.equal(linked(text), true, body);
  }
});

test("tuple coverage is parameter-bound and does not invent missing semantic partitions", () => {
  const complete = registered(`${loop}\n${nowLoop}`);
  assert.equal(evidence(complete.replace('["2027-02-29T00:00:00Z", 0], ', "")).testOk, false);
  assert.equal(evidence(complete.replace(', [new Date(NaN), 0]', "")).testOk, false);
  assert.equal(evidence(registered(loop)).testOk, false, "explicit supplied undefined is still required");
  assert.equal(evidence(complete.replaceAll("deadlinePassed(first, second)", "deadlinePassed(second, first)")).testOk, false);
  assert.equal(evidence(complete.replaceAll("TypeError", "RangeError")).testOk, false);
  assert.equal(evidence(complete.replace('../src/deadline.js', '../src/unrelated.js')).testOk, false);
  assert.equal(linked(complete.replace('../src/deadline.js', '../src/unrelated.js')), false);
  assert.equal(extracted(registered(loop.replace("deadlinePassed(first, second)", "deadlinePassed(0, second)"))).length, 0);
});

test("tuple rows cannot migrate to another expected error class", () => {
  const text = registered('for (const [first, second] of [[-1, 0]]) { assert.throws(() => deadlinePassed(first, second), TypeError); }\nfor (const [first, second] of [[1.5, 0]]) { assert.throws(() => deadlinePassed(first, second), RangeError); }');
  const assertions = extracted(text);
  assert.equal(assertions.length, 2);
  assert.deepEqual(assertions.map((item) => ({ errors: item.errorClasses, partitions: [...item.partitions].sort() })), [
    { errors: ["typeerror"], partitions: ["negative", "primitive", "zero"] },
    { errors: ["rangeerror"], partitions: ["fractional", "primitive", "zero"] }
  ]);
});

test("tuple expected errors require one closed matcher rather than names in arbitrary assertion arguments", () => {
  const complete = registered(`${loop}\n${nowLoop}`);
  for (const matcher of ['TypeError', '{ name: "TypeError" }', 'TypeError, "case message"']) {
    assert.equal(evidence(complete.replaceAll("), TypeError);", `), ${matcher});`)).testOk, true, matcher);
  }
  for (const matcher of [
    "error => (TypeError, true)", "RangeError, TypeError", '{name:"TypeError", ...{name:"RangeError"}}',
    '{name:"TypeError", name:"RangeError"}', '{ get name() { return "TypeError"; } }',
    "TypeError, message()", 'TypeError, "case message", TypeError', "TypeError || RangeError", "...matchers"
  ]) {
    const text = complete.replaceAll("), TypeError);", `), ${matcher});`);
    assert.equal(extracted(text).length, 0, matcher);
    assert.equal(linked(text), false, matcher);
    assert.equal(evidence(text).testOk, false, matcher);
  }
});

test("tuple evidence requires closed live ancestry and unshadowed imported targets", () => {
  const completeBody = `${loop}\n${nowLoop}`;
  const suitePrefix = prefix.replace('import test from "node:test";', 'import test, { describe } from "node:test";');
  const candidates = [
    ...[
      "if (true) { const sentinel = 1; return; }", "{ return; }", "try { return; } finally {}",
      "stop: return;", "do { return; } while (false);", "for (;;) {}",
      "const { deadlinePassed } = { deadlinePassed: () => { throw new TypeError(); } };",
      "const [deadlinePassed] = [() => { throw new TypeError(); }];"
    ].map((before) => registered(`${before} ${completeBody}`)),
    registered(completeBody).replace('test("contract", ()', 'test("contract", ({deadlinePassed})'),
    registered(completeBody).replace('test("contract", ()', 'test("contract", ([deadlinePassed])'),
    registered(`await new Promise(() => {}); ${completeBody}`).replace('test("contract", ()', 'test("contract", async ()'),
    registered(completeBody).replace('test("contract", ()', 'test("contract", { signal: AbortSignal.abort() }, ()'),
    registered(`t.todo(); ${completeBody}`).replace('test("contract", ()', 'test("contract", (t)'),
    `${suitePrefix}describe("suite", () => { return; test("contract", () => { ${completeBody} }); });`,
    `${suitePrefix}describe("suite", () => { if (true) { const marker = 1; return; } test("contract", () => { ${completeBody} }); });`,
    `${suitePrefix}describe("outer", () => { describe("inner", ({deadlinePassed}) => { test("contract", () => { ${completeBody} }); }); });`
  ];
  for (const text of candidates) {
    assert.equal(extracted(text).length, 0, text);
    assert.equal(linked(text), false, text);
    assert.equal(evidence(text).testOk, false, text);
  }
  assert.equal(evidence(`${suitePrefix}describe("suite", () => { test("contract", () => { ${completeBody} }); });`).testOk, true);
  const namespace = registered(completeBody).replace('import { deadlinePassed }', 'import * as api').replaceAll('() => deadlinePassed(', '() => api.deadlinePassed(');
  assert.equal(evidence(namespace).testOk, true);
  assert.equal(evidence(namespace.replace('test("contract", ()', 'test("contract", ({api})')).testOk, false);
  for (const options of ["{}", "{skip: false}", "{todo: false, skip: false}"]) {
    assert.equal(evidence(registered(completeBody).replace('test("contract", ()', `test("contract", ${options}, ()`)).testOk, true, options);
  }
});

test("Date constructor cells prove their resulting value, never their wrapped string or undefined argument", () => {
  for (const value of ['new Date("01/01/2027")', 'new Date("2027-02-29T00:00:00Z")', 'new Date("March 7, 2027")', "new Date(0)"]) {
    const changed = loop.replace("new Date(NaN)", value);
    assert.equal(extracted(registered(changed)).length, 0, value);
    assert.equal(evidence(registered(`${changed}\n${nowLoop}`)).testOk, false, value);
  }
  for (const value of ['new Date("invalid")', 'new Date("not a date")', 'new Date("")', "new Date(undefined)", "new Date(Infinity)", "new Date(-Infinity)"]) {
    const text = registered(`for (const [first, second] of [[${value}, 0]]) { ${assertion} }`);
    assert.deepEqual(extracted(text)[0]?.invalidArgumentPartitions, [{ index: 0, partitions: ["invalid-date-object"] }], value);
  }
  const standalone = registered(`for (const [first, second] of [["not a date", 0]]) { ${assertion} }`);
  assert.deepEqual(extracted(standalone)[0]?.invalidArgumentPartitions, [{ index: 0, partitions: ["invalid-date-string"] }]);
});

test("tuple proof refuses dynamic, mutable, dead, unresolved, and side-effectful tables", () => {
  const named = `const cases = ${rows}; for (const [first, second] of cases) { ${assertion} }`;
  const mutations = [
    ["skipped registration", registered(loop).replace('test("contract"', 'test.skip("contract"')],
    ["dead loop", registered(`if (false) { ${loop} }`)],
    ["conditional loop", registered(`if (enabled) { ${loop} }`)],
    ["early return", registered(`return; ${loop}`)],
    ["mutable bindings", registered(loop.replace("const [", "let ["))],
    ["binding default", registered(loop.replace("[first, second]", "[first = 0, second]"))],
    ["rest binding", registered(loop.replace("[first, second]", "[first, ...second]"))],
    ["duplicate binding", registered(loop.replace("[first, second]", "[first, first]"))],
    ["sparse binding", registered(loop.replace("[first, second]", "[first, , second]"))],
    ["empty table", registered(loop.replace(rows, "[]"))],
    ["dynamic table", registered(loop.replace(rows, "makeCases()"))],
    ["spread table", registered(loop.replace(rows, `[...${rows}]`))],
    ["ragged row", registered(loop.replace(rows, '[[undefined, 0, 1]]'))],
    ["sparse row", registered(loop.replace(rows, '[[undefined, ]]'))],
    ["dynamic cell", registered(loop.replace("new Date(NaN)", "makeInvalidDate()"))],
    ["dynamic constructor argument", registered(loop.replace("new Date(NaN)", "new Date(readValue())"))],
    ["object cell", registered(loop.replace("new Date(NaN)", "{ get value() { return NaN; } }"))],
    ["nested array cell", registered(loop.replace("new Date(NaN)", "[NaN]"))],
    ["spread row", registered(loop.replace(rows, '[[...inputs, 0]]'))],
    ["non-const table", registered(named.replace("const cases", "let cases"))],
    ["table reassignment", registered(named.replace("; for", "; cases = []; for"))],
    ["nested row write", registered(named.replace("; for", "; cases[0][0] = 0; for"))],
    ["table alias", registered(named.replace("; for", "; const alias = cases; for"))],
    ["table mutation after registration", `${registered(named)}\ncases.splice(0);`],
    ["global table mutation after registration", `${prefix}const cases = ${rows}; test("contract", () => { for (const [first, second] of cases) { ${assertion} } }); cases.splice(0);`],
    ["shadowed table", `${prefix}const cases = ${rows}; test("contract", () => { const cases = ${rows}; for (const [first, second] of cases) { ${assertion} } });`],
    ["unresolved table", registered(loop.replace(rows, "cases"))],
    ["loop mutation", registered(loop.replace(assertion, `first.setTime(0); ${assertion}`))],
    ["unknown effect before", registered(loop.replace(assertion, `audit(); ${assertion}`))],
    ["unknown effect after", registered(loop.replace(assertion, `${assertion} audit();`))],
    ["continue", registered(loop.replace(assertion, `continue; ${assertion}`))],
    ["break after", registered(loop.replace(assertion, `${assertion} break;`))],
    ["callback mutation", registered(loop.replace("() => deadlinePassed(first, second)", "() => { first.setTime(0); return deadlinePassed(first, second); }"))],
    ["callback shadow", registered(loop.replace("() => deadlinePassed(first, second)", "() => { const first = 0; return deadlinePassed(first, second); }"))],
    ["async callback in throws", registered(loop.replace("() => deadlinePassed", "async () => deadlinePassed"))],
    ["unawaited rejects", registered(loop.replace("assert.throws", "assert.rejects"))],
    ["shadowed target", registered(loop.replaceAll("first", "deadlinePassed"))],
    ["shadowed error constructor", registered(loop.replaceAll("first", "TypeError"))],
    ["Date constructor shadow", registered(`const Date = Replacement; ${loop}`)],
    ["Date constructor alias escape", registered(`const Alias = Date; ${loop}`)],
    ["Date prototype poison", registered(`Date.prototype.getTime = () => 0; ${loop}`)],
    ["primitive intrinsic shadow", registered(`const NaN = 0; ${loop}`)],
    ["destructured intrinsic shadow", registered(`const { NaN } = values; ${loop}`)],
    ["arrow parameter intrinsic shadow", registered(loop).replace('test("contract", ()', 'test("contract", (NaN)')],
    ["array iterator poison", registered(`Array.prototype[Symbol.iterator] = replacement; ${loop}`)],
    ["dynamic import", registered(loop).replace('import { deadlinePassed } from "../src/deadline.js";', 'const { deadlinePassed } = await import(modulePath);')]
  ];
  for (const [label, text] of mutations) {
    assert.equal(extracted(text).length, 0, label);
    assert.equal(linked(text), false, label);
    assert.equal(evidence(text).testOk, false, label);
  }
});

test("asynchronous tuple rejection evidence requires a live awaited assertion", () => {
  const text = `${prefix}test("async contract", async () => { ${loop.replace("assert.throws", "await assert.rejects")} });`;
  assert.equal(extracted(text).length, 3);
  assert.equal(extracted(text).every((item) => item.mode === "rejects"), true);
  assert.equal(evidence(text).testOk, false, "an async assertion cannot prove the synchronous source callable");
});

test("tuple expansion has a fixed row bound", () => {
  const text = (count) => registered(loop.replace(rows, `[${Array(count).fill("[undefined, 0]").join(", ")}]`));
  assert.equal(extracted(text(24)).length, 24);
  assert.equal(extracted(text(25)).length, 0);
});
