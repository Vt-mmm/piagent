import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";

import { buildAcceptanceReceipt, refreshAcceptanceReceipt } from "../packages/piagent-core/extensions/acceptance-receipt.js";
import { compileCriterionGraph } from "../packages/piagent-core/extensions/criterion-graph.js";
import { versionWorkingTreeHash, WORKING_TREE_DIGEST_ALGORITHM } from "../packages/piagent-core/extensions/working-tree-digest.js";

const CLI = "Support --name value, --name=value, and boolean --flag.";
const FOLLOWED = "A flag followed by another flag is boolean true.";
const UNCHANGED = "Inputs must remain unchanged.";
const source = `
import { appendFileSync } from 'node:fs';
function observed() { appendFileSync(new URL('../calls.txt', import.meta.url), 'x'); }
export function readOptions(argv) {
  observed();
  const flags = {}, positional = [];
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) { positional.push(token); continue; }
    const equal = token.indexOf('=');
    if (equal >= 0) flags[token.slice(2, equal)] = token.slice(equal + 1);
    else flags[token.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return { flags, positional };
}
export function classify(event, window) {
  observed();
  if (event.at < window.start || event.at >= window.end) return 'outside';
  if (event.received >= window.end + window.margin) return 'late';
  return 'current';
}
`;
const imports = `import assert from 'node:assert/strict';
import test from 'node:test';
import { readOptions as parse, classify as bucket } from '../src/subject.js';
`;
const cliInput = "['--name', 'first', '--mode=fast', '--verbose', '--other', '--name', 'last']";
const cliExpected = "{ flags: { name: 'last', mode: 'fast', verbose: true, other: true }, positional: [] }";

// Every fixture is fresh trusted synthetic code, actually run with node --test.
// The receipt is refreshed through the production API using that real exit code.
function prove(t, { body, criteria, code = source, expectedExit = 0, expectedCalls = true }) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-bound-literal-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, "src")); fs.mkdirSync(path.join(cwd, "test"));
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ type: "module" }));
  fs.writeFileSync(path.join(cwd, "src/subject.js"), code);
  const testSource = imports + body;
  fs.writeFileSync(path.join(cwd, "test/subject.test.js"), testSource);
  const projectEnv = { ...process.env };
  delete projectEnv.NODE_TEST_CONTEXT;
  const verification = spawnSync(process.execPath, ["--test", "test/subject.test.js"], { cwd, env: projectEnv, encoding: "utf8", timeout: 10000 });
  assert.equal(verification.error, undefined);
  assert.equal(verification.status, expectedExit, verification.stdout + verification.stderr);
  assert.equal(fs.existsSync(path.join(cwd, "calls.txt")), expectedCalls, "actual imported API execution marker");
  const digest = versionWorkingTreeHash(crypto.createHash("sha256").update(code).update(testSource).digest("hex"));
  const built = buildAcceptanceReceipt({ source: "runtime", changeMode: "source-change",
    summary: "Implement the requested behavior.", acceptanceCriteria: criteria, generatedAt: "2026-09-05T00:00:00.000Z" });
  built.receipt.criteria.forEach((criterion) => { criterion.priority = "critical"; });
  const changedFiles = ["src/subject.js", "test/subject.test.js"];
  const task = { schemaVersion: 2, changeMode: "source-change", summary: "Implement the requested behavior.",
    acceptanceCriteria: built.acceptanceCriteria, acceptanceReceipt: built.receipt,
    criterionGraph: compileCriterionGraph({ acceptanceCriteria: built.acceptanceCriteria, scope: changedFiles,
      verifyCommands: ["node --test test/subject.test.js"], changeMode: "source-change", createdAt: "2026-09-05T00:00:00.000Z" }),
    scope: changedFiles, changedFiles, observedChangedFiles: changedFiles, protectedPaths: [], outOfScope: [],
    verifyCommands: ["node --test test/subject.test.js"],
    verifyEvidence: [{ command: "node --test test/subject.test.js", exitCode: verification.status,
      observed: true, matchedProfileCommand: true, preWorkingTreeDigest: digest, workingTreeDigest: digest,
      recordedAt: "2026-09-05T00:00:01.000Z" }], workingTreeDigestAlgorithm: WORKING_TREE_DIGEST_ALGORITHM,
    trace: { outcome: "completed" } };
  const result = refreshAcceptanceReceipt(task, { cwd, changedFiles, currentWorkingTreeDigest: digest });
  for (const criterion of result.receipt.criteria.filter((entry) => entry.status === "satisfied")) {
    assert.ok(criterion.evidence.some((entry) => entry.kind === "verifier-backed-focused-test"), JSON.stringify(criterion));
  }
  return result.receipt.criteria.map((criterion) => criterion.status);
}

test("local const string arrays bind real imported CLI calls and result assertions", (t) => {
  assert.deepEqual(prove(t, { criteria: [CLI, FOLLOWED], body: `test('ordinary example', () => {
    const argv = ${cliInput}; const original = [...argv]; const result = parse(argv);
    assert.deepEqual(result, ${cliExpected}); assert.deepEqual(argv, original);
  });` }), ["satisfied", "satisfied"]);
});

for (const [label, setup, invoke, expectedCalls = true] of [
  ["mutable declaration", `let argv = ${cliInput};`, "assert.deepEqual(parse(argv), " + cliExpected + ");"],
  ["reassigned declaration", `let argv = []; argv = ${cliInput};`, "assert.deepEqual(parse(argv), " + cliExpected + ");"],
  ["mutated const", `const argv = []; argv.push(...${cliInput});`, "assert.deepEqual(parse(argv), " + cliExpected + ");"],
  ["escaped alias", `const argv = ${cliInput}; const alias = argv;`, "assert.deepEqual(parse(argv), " + cliExpected + ");"],
  ["reference alias as argument", `const original = ${cliInput}; const argv = original;`, "assert.deepEqual(parse(argv), " + cliExpected + ");"],
  ["cross-scope shadow", `const argv = ${cliInput};`, "((argv) => assert.deepEqual(parse(argv), " + cliExpected + "))(argv);"],
  ["unexecuted false branch", `const argv = ${cliInput};`, "if (false) { assert.deepEqual(parse(argv), " + cliExpected + "); }", false],
  ["unbraced false branch", `const argv = ${cliInput};`, "if (false) assert.deepEqual(parse(argv), " + cliExpected + ");", false],
  ["short-circuit false branch", `const argv = ${cliInput};`, "false && assert.deepEqual(parse(argv), " + cliExpected + ");", false],
  ["object in false condition", `const argv = ${cliInput};`, "if (false && {}) assert.deepEqual(parse(argv), " + cliExpected + ");", false],
  ["semicolons in false loop", `const argv = ${cliInput};`, "for (; false;) assert.deepEqual(parse(argv), " + cliExpected + ");", false],
  ["prior return", `return; const argv = ${cliInput};`, "assert.deepEqual(parse(argv), " + cliExpected + ");", false],
  ["uninvoked helper", `const argv = ${cliInput};`, "function unused() { assert.deepEqual(parse(argv), " + cliExpected + "); }", false]
]) test(`bound CLI literals abstain for ${label}`, (t) => {
  assert.deepEqual(prove(t, { criteria: [CLI, FOLLOWED], expectedCalls,
    body: `test('ordinary example', () => { ${setup} ${invoke} });` }), ["pending", "pending"]);
});

test("real wrong CLI execution cannot borrow an unexecuted result assertion", (t) => {
  const wrong = source.replace("return { flags, positional };", "return { flags: {}, positional: [] };");
  assert.deepEqual(prove(t, { criteria: [CLI], code: wrong, body: `test('ordinary example', () => {
    const argv = ${cliInput}; const result = parse(argv);
    if (false) assert.deepEqual(result, ${cliExpected});
  });` }), ["pending"]);
});

test("false assertions cannot gain proof from a failing verifier", (t) => {
  assert.deepEqual(prove(t, { criteria: [CLI], expectedExit: 1, body: `test('ordinary example', () => {
    const argv = ${cliInput}; assert.deepEqual(parse(argv), { flags: {}, positional: [] });
  });` }), ["pending"]);
});

test("enum examples alone do not establish natural-language conditional clauses", (t) => {
  assert.deepEqual(prove(t, { criteria: ["Return outside for an occurrence outside that interval.",
    "return late when receipt is at or after the end plus margin;", "otherwise return current."],
    body: `const window = { start: 10, end: 20, margin: 2 };
    test('ordinary examples', () => {
      assert.equal(bucket({ at: 9, received: 9 }, window), 'outside');
      assert.equal(bucket({ at: 20, received: 20 }, window), 'outside');
      assert.equal(bucket({ at: 15, received: 22 }, window), 'late');
      const result = bucket({ at: 15, received: 21 }, window); assert.equal(result, 'current');
    });` }), ["pending", "pending", "pending"]);
});

for (const [label, body, expectedCalls = true] of [
  ["assertion message", "assert.equal(bucket({ at: 15, received: 15 }, { start: 10, end: 20, margin: 2 }), 'current', 'outside');"],
  ["detached constant", "bucket({ at: 15, received: 15 }, { start: 10, end: 20, margin: 2 }); assert.equal('outside', 'outside');"],
  ["reassigned result", "let result = bucket({ at: 15, received: 15 }, { start: 10, end: 20, margin: 2 }); result = 'outside'; assert.equal(result, 'outside');"],
  ["false branch", "if (false) { assert.equal(bucket({ at: 9, received: 9 }, { start: 10, end: 20, margin: 2 }), 'outside'); }", false],
  ["unbraced false branch", "if (false) assert.equal(bucket({ at: 9, received: 9 }, { start: 10, end: 20, margin: 2 }), 'outside');", false],
  ["short-circuit false branch", "false && assert.equal(bucket({ at: 9, received: 9 }, { start: 10, end: 20, margin: 2 }), 'outside');", false],
  ["shadowed import", "const bucket = () => 'outside'; assert.equal(bucket(), 'outside');", false],
  ["hoisted shadowed import", "assert.equal(bucket(), 'outside'); function bucket() { return 'outside'; }", false],
  ["sibling block assertion", "{ const result = bucket({ at: 15, received: 15 }, { start: 10, end: 20, margin: 2 }); } { const result = 'outside'; assert.equal(result, 'outside'); }"]
]) test(`enum evidence rejects ${label}`, (t) => {
  assert.deepEqual(prove(t, { criteria: ["Return outside."], expectedCalls,
    body: `test('ordinary example', () => { ${body} });` }), ["pending"]);
});

for (const [label, replacement, update] of [
  ["logical or", "return null;", "result ||= 'outside';"],
  ["nullish", "return null;", "result ??= 'outside';"],
  ["logical and", "return 'current';", "result &&= 'outside';"],
  ["compound addition", "return '';", "result += 'outside';"],
  ["destructuring", "return null;", "[result] = ['outside'];"]
]) test(`enum evidence rejects ${label} result reassignment`, (t) => {
  const wrong = source.replace("return 'current';", replacement);
  assert.deepEqual(prove(t, { criteria: ["Return outside."], code: wrong,
    body: `test('ordinary example', () => {
      let result = bucket({ at: 15, received: 15 }, { start: 10, end: 20, margin: 2 });
      ${update} assert.equal(result, 'outside');
    });` }), ["pending"]);
});

test("green wrong-condition and constant enum examples cannot prove conditional clauses", (t) => {
  const constant = source.replace("if (event.at < window.start || event.at >= window.end) return 'outside';", "return 'outside';");
  assert.deepEqual(prove(t, { code: constant, criteria: ["Return outside for an occurrence outside that interval."],
    body: `test('ordinary example', () => {
      assert.equal(bucket({ at: 15, received: 15 }, { start: 10, end: 20, margin: 2 }), 'outside');
    });` }), ["pending"]);
});

const objectSetup = `const template = { start: 10, end: 20, margin: 2 };
  const event = { at: 15, received: 15 }; const window = { ...template };
  const beforeEvent = { ...event }; const beforeWindow = { ...window };`;
test("flat own-data object copies independently prove all input snapshots", (t) => {
  assert.deepEqual(prove(t, { criteria: [UNCHANGED], body: `test('ordinary example', () => {
    ${objectSetup} bucket(event, window);
    assert.deepEqual(event, beforeEvent); assert.deepEqual(window, beforeWindow);
  });` }), ["satisfied"]);
});

for (const [label, setup, assertions, code = source] of [
  ["only one input", objectSetup, "assert.deepEqual(event, beforeEvent);"],
  ["nested reference", objectSetup.replace("at: 15, received: 15", "at: 15, received: 15, nested: { count: 1 }"),
    "assert.deepEqual(event, beforeEvent); assert.deepEqual(window, beforeWindow);"],
  ["alias instead of snapshot", objectSetup.replace("{ ...event }", "event"),
    "assert.deepEqual(event, beforeEvent); assert.deepEqual(window, beforeWindow);"],
  ["mutated input", objectSetup + " event.extra = 1;", "assert.deepEqual(window, beforeWindow);"],
  ["escaped template", "const template = { start: 10, end: 20, margin: 2 }; (() => {})(template);" + objectSetup.slice(objectSetup.indexOf("const event")),
    "assert.deepEqual(event, beforeEvent); assert.deepEqual(window, beforeWindow);"],
  ["mutating second input", objectSetup, "assert.deepEqual(event, beforeEvent);",
    source.replace("export function classify(event, window) {", "export function classify(event, window) { window.changed = true;")]
]) test(`all-input immutability abstains for ${label}`, (t) => {
  assert.deepEqual(prove(t, { criteria: [UNCHANGED], code, body: `test('ordinary example', () => {
    ${setup} bucket(event, window); ${assertions}
  });` }), ["pending"]);
});

for (const [label, checks] of [
  ["unbraced false branches", "if (false) assert.deepEqual(event, beforeEvent); if (false) assert.deepEqual(window, beforeWindow);"],
  ["short-circuit branches", "false && assert.deepEqual(event, beforeEvent); false && assert.deepEqual(window, beforeWindow);"],
  ["unused closure", "function unused() { assert.deepEqual(event, beforeEvent); assert.deepEqual(window, beforeWindow); }"]
]) test(`real mutation cannot be hidden behind ${label}`, (t) => {
  const mutating = source.replace("export function classify(event, window) {", "export function classify(event, window) { event.changed = true; window.changed = true;");
  assert.deepEqual(prove(t, { criteria: [UNCHANGED], code: mutating, body: `test('ordinary example', () => {
    ${objectSetup} bucket(event, window); ${checks}
  });` }), ["pending"]);
});

const takeSource = source + `
export function take(items, options = {}) {
  observed();
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options');
  const limit = options.limit === undefined ? 20 : options.limit;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('limit');
  return items.slice(0, limit);
}
`;
const takeCriterion = "Implement take and focused tests without mutating caller inputs.";
test("immediate copied primitive-array witness proves immutability independently of later loop", (t) => {
  assert.deepEqual(prove(t, { code: takeSource, criteria: [takeCriterion], body: `
    import { take } from '../src/subject.js';
    const items = Array.from({ length: 25 }, (_, index) => index);
    const itemsBefore = [...items];
    test('ordinary examples', () => {
      assert.equal(take(items).length, 20);
      assert.deepEqual(take(items, { limit: 2 }), [0, 1]);
      assert.deepEqual(items, itemsBefore);
      for (const limit of [null, 0, -1, 1.5]) assert.throws(() => take(items, { limit }), TypeError);
      assert.deepEqual(items, itemsBefore);
      assert.throws(() => take(items, null), TypeError);
    });` }), ["satisfied"]);
});

test("post-loop-only copied-array witness remains unknown without trusted liveness", (t) => {
  assert.deepEqual(prove(t, { code: takeSource, criteria: [takeCriterion], body: `
    import { take } from '../src/subject.js';
    const items = Array.from({ length: 25 }, (_, index) => index);
    const itemsBefore = [...items];
    test('ordinary examples', () => {
      assert.equal(take(items).length, 20);
      assert.deepEqual(take(items, { limit: 2 }), [0, 1]);
      for (const limit of [null, 0, -1, 1.5]) assert.throws(() => take(items, { limit }), TypeError);
      assert.deepEqual(items, itemsBefore);
    });` }), ["pending"]);
});

for (const [label, intervening] of [
  ["early return in earlier loop", "for (const value of [0]) { return; }"],
  ["unbraced early return", "for (const value of [0]) return;"],
  ["unbraced dead snapshot", "if (false)"],
  ["header object dead snapshot", "if (false && {})"],
  ["header semicolon dead snapshot", "for (; false;)"]
]) test(`copied array still abstains for ${label}`, (t) => {
  const mutating = takeSource.replace("return items.slice(0, limit);", "items.push(99); return items.slice(0, limit);");
  assert.deepEqual(prove(t, { code: mutating, criteria: [takeCriterion], body: `
    import { take } from '../src/subject.js';
    const items = Array.from({ length: 25 }, (_, index) => index);
    const itemsBefore = [...items];
    test('ordinary examples', () => {
      take(items); ${intervening} assert.deepEqual(items, itemsBefore);
    });` }), ["pending"]);
});

for (const [label, setup, loop, comparison = "assert.deepEqual(items, itemsBefore);"] of [
  ["dead comparison after valid loop", "", "for (const limit of [0]) assert.throws(() => take(items, { limit }), TypeError);", "if (false) assert.deepEqual(items, itemsBefore);"],
  ["false branch wrapping valid loop", "", "if (false) for (const limit of [0]) assert.throws(() => take(items, { limit }), TypeError);"],
  ["short-circuit preceding valid loop", "false && assert.equal(1, 2);", "for (const limit of [0]) assert.throws(() => take(items, { limit }), TypeError);"],
  ["callback block", "", "for (const limit of [0]) assert.throws(() => { take(items, { limit }); }, TypeError);"],
  ["extra loop statement", "", "for (const limit of [0]) { assert.throws(() => take(items, { limit }), TypeError); Math.abs(limit); }"],
  ["shadowed assertion", "const assert = { throws() {}, deepEqual() {} };", "for (const limit of [0]) assert.throws(() => take(items, { limit }), TypeError);"],
  ["empty literal loop", "", "for (const limit of []) assert.throws(() => take(items, { limit }), TypeError);"]
]) test(`unsupported loop continuation stays unproven for ${label}`, (t) => {
  assert.deepEqual(prove(t, { code: takeSource, criteria: [takeCriterion], body: `
    import { take } from '../src/subject.js';
    const items = Array.from({ length: 25 }, (_, index) => index);
    const itemsBefore = [...items];
    test('ordinary examples', () => {
      ${setup} take(items); ${loop} ${comparison}
    });` }), ["pending"]);
});

for (const helper of [false, true]) test(`early process exit ${helper ? "through helper" : "in callback target"} cannot prove post-loop input stability`, (t) => {
  let code = takeSource.replace("return items.slice(0, limit);", "items.push(99); return items.slice(0, limit);");
  if (helper) code += "\nexport function stop() { process.exit(0); }\n";
  else code = code.replace("throw new TypeError('limit');", "process.exit(0);");
  assert.deepEqual(prove(t, { code, criteria: [takeCriterion], body: `
    import { take${helper ? ", stop" : ""} } from '../src/subject.js';
    const items = Array.from({ length: 25 }, (_, index) => index);
    const itemsBefore = [...items];
    test('ordinary examples', () => {
      take(items);
      for (const limit of [null, 0, -1, 1.5]) assert.throws(() => ${helper ? "stop" : "take"}(items, { limit }), TypeError);
      assert.deepEqual(items, itemsBefore);
    });` }), ["pending"]);
});
