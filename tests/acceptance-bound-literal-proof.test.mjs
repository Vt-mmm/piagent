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

for (const clause of ['Do not mutate either argument.', 'Do not mutate both arguments.',
  'Do not mutate all inputs.', 'Do not mutate either of the arguments.', 'Do not mutate any argument.']) {
  for (const [label, mutation, checks, expected] of [
    ['first argument changes', 'event.changed = true;', 'assert.deepEqual(window, beforeWindow);', 'pending'],
    ['second argument changes', 'window.changed = true;', 'assert.deepEqual(event, beforeEvent);', 'pending'],
    ['both arguments checked', '', 'assert.deepEqual(event, beforeEvent); assert.deepEqual(window, beforeWindow);', 'satisfied']
  ]) test(`non-mutation quantifier ${clause}: ${label}`, t => {
    const code = source.replace('export function classify(event, window) {', `export function classify(event, window) { ${mutation}`);
    assert.deepEqual(prove(t, { criteria: [clause], code, body: `test('ordinary example', () => {
      ${objectSetup} bucket(event, window); ${checks}
    });` }), [expected]);
  });
}

const deepSetup = "const event = { at: 15, received: 15 }; const window = { start: 10, end: 20, margin: 2 }; const beforeEvent = structuredClone(event); const beforeWindow = structuredClone(window);";
const deepChecks = "assert.deepEqual(event, beforeEvent); assert.deepEqual(window, beforeWindow);";
for (const [label, setup, mutation] of [
  ['edited snapshot', deepSetup + " beforeWindow.changed = true;", 'window.changed = true;'],
  ['snapshot alias escape', deepSetup + " const alias = beforeWindow; alias.changed = true;", 'window.changed = true;'],
  ['shadowed structuredClone', "const structuredClone = value => value; " + deepSetup, 'window.changed = true;'],
]) test('deep snapshot integrity: ' + label, t => {
  const code = source.replace('export function classify(event, window) {', 'export function classify(event, window) { ' + mutation);
  const actual = prove(t, { criteria: [UNCHANGED], code, body: "test('ordinary example', () => { " + setup + " bucket(event, window); " + deepChecks + " });" });
  t.diagnostic(JSON.stringify({ label, receiptStatus: actual, publicVerifier: 'PASS', inputMutation: mutation }));
  assert.deepEqual(actual, ['pending']);
});
test('deep snapshot integrity: independent deep clones still work', t => {
  assert.deepEqual(prove(t, { criteria: [UNCHANGED], body: "test('ordinary example', () => { " + deepSetup + " bucket(event, window); " + deepChecks + " });" }), ['satisfied']);
});
for (const [label, before, after, checks = deepChecks, mutation = 'window.changed = true;'] of [
  ['stale capture after later input change', 'window.changed = true;', '', deepChecks, 'delete window.changed;'],
  ['restored input', '', 'delete window.changed;'],
  ['restored input through alias', 'const alias = window;', 'delete alias.changed;'],
  ['comparison message restores input', '', '', 'assert.deepEqual(event, beforeEvent); assert.deepEqual(window, beforeWindow, (delete window.changed, "message"));'],
  ['local assertion shim', 'const assert = { deepEqual() {} };', ''],
]) test('deep snapshot temporal control: ' + label, t => {
  const code = source.replace('export function classify(event, window) {', 'export function classify(event, window) { ' + mutation);
  const actual = prove(t, { criteria: [UNCHANGED], code, body: "test('ordinary example', () => { " + deepSetup + before + " bucket(event, window); " + after + checks + " });" });
  assert.deepEqual(actual, ['pending']);
});
test('deep snapshot temporal control: source cannot replace the assertion implementation', t => {
  const code = "import assert from 'node:assert/strict'; assert.deepEqual = function () {};\n" + source.replace('export function classify(event, window) {', 'export function classify(event, window) { window.changed = true;');
  assert.deepEqual(prove(t, { criteria: [UNCHANGED], code, body: "test('ordinary example', () => { " + deepSetup + " bucket(event, window); " + deepChecks + " });" }), ['pending']);
});
test('deep snapshot temporal control: source cannot replace structuredClone with an alias', t => {
  const code = "globalThis.structuredClone = value => value;\n" + source.replace('export function classify(event, window) {', 'export function classify(event, window) { window.changed = true;');
  assert.deepEqual(prove(t, { criteria: [UNCHANGED], code, body: "test('ordinary example', () => { " + deepSetup + " bucket(event, window); " + deepChecks + " });" }), ['pending']);
});
test('deep snapshot temporal control: native clone cannot silently drop an accessor descriptor', t => {
  const setup = "const event = { at: 15, received: 15 }; const window = { start: 10, end: 20, margin: 2, get hidden() { return 1; } }; const beforeEvent = structuredClone(event); const beforeWindow = structuredClone(window);";
  const code = source.replace('export function classify(event, window) {', 'export function classify(event, window) { Object.defineProperty(window, "hidden", {value:1,writable:true,enumerable:true,configurable:true});');
  assert.deepEqual(prove(t, { criteria: [UNCHANGED], code, body: "test('ordinary example', () => { " + setup + " bucket(event, window); " + deepChecks + " });" }), ['pending']);
});
test('deep snapshot temporal control: a primitive result assertion still permits stable clones', t => {
  assert.deepEqual(prove(t, { criteria: [UNCHANGED], body: "test('ordinary example', () => { " + deepSetup + " assert.equal(bucket(event, window), 'current'); " + deepChecks + " });" }), ['satisfied']);
});
test('deep snapshot temporal control: a nested array and identity copy retain the original deep snapshot', t => {
  const code = source + "\nexport function select(events) { observed(); return [events[2],events[1]]; }\n";
  const body = "import {select} from '../src/subject.js'; test('ordinary example', () => { const events = [{id:'b',value:{n:1}},{id:'a'},{id:'b'}]; const before = structuredClone(events), identities = [...events]; assert.deepEqual(select(events), [events[2],events[1]]); assert.deepEqual(events,before); events.forEach((event,index) => assert.strictEqual(event,identities[index])); });";
  assert.deepEqual(prove(t, {criteria:[UNCHANGED],code,body}), ['satisfied']);
});
test('deep snapshot temporal control: an escaping assertion method stays unsupported', t => {
  const body = "test('ordinary example', () => { " + deepSetup + " bucket(event,window); " + deepChecks + " const carrier = () => assert.deepEqual; });";
  assert.deepEqual(prove(t,{criteria:[UNCHANGED],body}), ['pending']);
});

// Finite interval records: field identity comes from the task and real imports.
function intervalFixture(options = {}) {
  const source = options.source ?? `function whole(value) { return Number.isFinite(value) && Number.isInteger(value); }
export function classifyArrival(packet, frame) {
  if (!packet || typeof packet !== 'object' || !frame || typeof frame !== 'object'
    || ![packet.stamp, packet.receipt, frame.lo, frame.hi, frame.tolerance].every(whole)
    || frame.tolerance < 0 || frame.lo >= frame.hi) throw new TypeError('invalid interval');
  if (packet.stamp < frame.lo || packet.stamp >= frame.hi) return 'outside';
  if (packet.receipt < packet.stamp - frame.tolerance) return 'early';
  if (packet.receipt >= frame.hi + frame.tolerance) return 'late';
  return 'current';
}`;
  const tests = options.tests ?? `import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyArrival } from '../src/interval.js';
const sample = (changes = {}) => ({ stamp: 10, receipt: 10, ...changes });
const range = (changes = {}) => ({ lo: 10, hi: 20, tolerance: 2, ...changes });
test('typed fields and interval relations', () => {
  for (const invalid of [NaN, Infinity, -Infinity, 0.5, '10', null, undefined]) {
    for (const field of ['stamp', 'receipt']) assert.throws(() => classifyArrival(sample({ [field]: invalid }), range()), TypeError);
    for (const field of ['lo', 'hi', 'tolerance']) assert.throws(() => classifyArrival(sample(), range({ [field]: invalid })), TypeError);
  }
  assert.throws(() => classifyArrival(sample(), range({ tolerance: -1 })), TypeError);
  assert.throws(() => classifyArrival(sample(), range({ hi: 10 })), TypeError);
  assert.throws(() => classifyArrival(sample(), range({ hi: 9 })), TypeError);
  for (const invalid of [null, undefined, 1, '', {}]) {
    assert.throws(() => classifyArrival(invalid, range()), TypeError);
    assert.throws(() => classifyArrival(sample(), invalid), TypeError);
  }
});`;
  const context = options.context ?? 'Preserve `classifyArrival(packet, frame)`. Use the half-open interval `lo <= stamp < hi`. '
    + '`receipt` is earlier than `stamp` by more than `tolerance`. Receipt at or after `hi + tolerance` is late. '
    + 'All timestamps and the skew must be finite integers; the skew must be non-negative; require `lo < hi`; malformed values throw `TypeError`.';
  return {taskText: options.selected ?? 'malformed values throw `TypeError`.', contextText: context,
    sourceText: source, testText: tests, sourceEntries: [{path:'src/interval.js',text:source}],
    testEntries: [{path:'test/interval.test.js',text:tests}], namedTargets: options.inferred ? [] : ['classifyArrival']};
}

function fallbackFixture() {
  const original=intervalFixture();
  const context='Preserve `classifyArrival(packet, frame)`. The interval is half-open: `lo <= stamp < hi`. '
    +'Return `outside` for an occurrence outside that interval. For an in-period event, return `early` when `receipt` is earlier than `stamp` by more than `tolerance`; '
    +'return `late` when receipt is at or after `hi + tolerance`; otherwise return `current`. '
    +'All timestamps and the skew must be finite integers, the skew must be non-negative, and the period must have `lo < hi`; malformed values throw `TypeError`.';
  const tests=original.testText.slice(0,original.testText.indexOf("test('typed"))+"test('default result', () => { assert.equal(classifyArrival(sample({stamp:11,receipt:11}),range()),'current'); });";
  return {source:original.sourceText,tests,context,selected:'otherwise return `current`.'};
}

function snapshotFixture() {
  const fixture=fallbackFixture(),prefix=fixture.tests.slice(0,fixture.tests.indexOf("test('default"));
  return {...fixture,selected:'Inputs must remain unchanged.',tests:prefix+`test('all outcomes preserve both records', () => {
  for (const changes of [{}, { stamp: 9 }, { receipt: 7 }, { receipt: 22 }, { receipt: '10' }]) {
    const input = sample(changes), window = range(), before = structuredClone([input, window]);
    if (typeof input.receipt === 'string') assert.throws(() => classifyArrival(input, window), TypeError);
    else classifyArrival(input, window);
    assert.deepEqual([input, window], before);
  }
});`};
}
const snapshotCases=[
 ['five outcomes and both arguments',x=>x,'satisfied'],
 ['input mutated and restored inside source',x=>({...x,source:x.source.replace("return 'current';","const prior = packet.stamp; packet.stamp = 100; packet.stamp = prior; return 'current';")}),'pending'],
 ['event mutation hidden by snapshot alias',x=>({...x,source:x.source.replace("return 'current';","packet.stamp += 1; return 'current';"),tests:x.tests.replace('structuredClone([input, window])','[input, window]')}),'pending'],
 ['period mutation hidden by snapshot alias',x=>({...x,source:x.source.replace("return 'current';","frame.tolerance += 1; return 'current';"),tests:x.tests.replace('structuredClone([input, window])','[input, window]')}),'pending'],
 ['snapshot aliases both arguments',x=>({...x,tests:x.tests.replace('structuredClone([input, window])','[input, window]')}),'pending'],
 ['snapshot taken after invocation',x=>({...x,tests:x.tests.replace(', before = structuredClone([input, window])','').replace('    assert.deepEqual','    const before = structuredClone([input, window]); assert.deepEqual')}),'pending'],
 ['snapshot overwritten with live input',x=>({...x,tests:x.tests.replace('    assert.deepEqual','    before[0] = input; assert.deepEqual')}),'pending'],
 ['comparison uses actual as expected',x=>({...x,tests:x.tests.replace('assert.deepEqual([input, window], before)','assert.deepEqual([input, window], [input, window])')}),'pending'],
 ['only first argument compared',x=>({...x,tests:x.tests.replace('assert.deepEqual([input, window], before)','assert.deepEqual(input, before[0])')}),'pending'],
 ['only second argument compared',x=>({...x,tests:x.tests.replace('assert.deepEqual([input, window], before)','assert.deepEqual(window, before[1])')}),'pending'],
 ['loop skipped',x=>({...x,tests:x.tests.replace('  for (const changes','  if (false) for (const changes')}),'pending'],
 ['assertion skipped',x=>({...x,tests:x.tests.replace('    assert.deepEqual','    if (false) assert.deepEqual')}),'pending'],
 ['whole test skipped',x=>({...x,tests:x.tests.replace("test('all outcomes", "test.skip('all outcomes") }),'pending'],
 ['current outcome absent',x=>({...x,tests:x.tests.replace('[{}, { stamp: 9 }','[{ stamp: 9 }')}),'pending'],
 ['outside outcome absent',x=>({...x,tests:x.tests.replace(', { stamp: 9 }','')}),'pending'],
 ['early outcome absent',x=>({...x,tests:x.tests.replace(', { receipt: 7 }','')}),'pending'],
 ['late outcome absent',x=>({...x,tests:x.tests.replace(', { receipt: 22 }','')}),'pending'],
 ['throw outcome absent',x=>({...x,tests:x.tests.replace(", { receipt: '10' }",'')}),'pending'],
 ['local clone replacement hides source writes',x=>({...x,source:x.source.replace("return 'current';","packet.stamp += 1; return 'current';"),tests:x.tests.replace("test('all outcomes", "const structuredClone = value => value; test('all outcomes") }),'pending'],
 ['assert replacement hides source writes',x=>({...x,source:x.source.replace("return 'current';","packet.stamp += 1; return 'current';"),tests:x.tests.replace('    assert.deepEqual','    assert.deepEqual = () => {}; assert.deepEqual')}),'pending'],
 ['factory getter has no literal data ownership',x=>({...x,tests:x.tests.replace('stamp: 10, receipt: 10, ...changes','get stamp() { return 10; }, receipt: 10, ...changes')}),'pending'],
 ['frozen-only tests lack snapshot evidence',x=>({...x,tests:x.tests.replace('input = sample(changes), window = range()','input = Object.freeze(sample(changes)), window = Object.freeze(range())').replace('    assert.deepEqual([input, window], before);','')}),'pending'],
 ['clone alias is not the native primitive',x=>({...x,tests:x.tests.replace("test('all outcomes", "const clone = structuredClone; test('all outcomes").replace('before = structuredClone(', 'before = clone(')}),'pending'],
 ['local window renamed',x=>({...x,tests:x.tests.replaceAll('window','intervalValue')}),'satisfied'],
 ['strict grouped deep comparison',x=>({...x,tests:x.tests.replace('assert.deepEqual','assert.deepStrictEqual')}),'satisfied'],
];
for(const [label,change,expected] of snapshotCases) test(`grouped interval snapshot after actual verifier: ${label}`,t=>{
  const fixture=change(snapshotFixture()),cwd=fs.mkdtempSync(path.join(os.tmpdir(),'piagent-interval-snapshot-'));
  t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
  const sourcePath='interval.mjs',testPath='interval.test.mjs',command=`node --test ${testPath}`;
  fs.writeFileSync(path.join(cwd,sourcePath),fixture.source);fs.writeFileSync(path.join(cwd,testPath),fixture.tests.replace('../src/interval.js','./interval.mjs'));
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/(^PI_|^PIAGENT_|^OPENAI_|^ANTHROPIC_|^CODEX_|API_KEY|TOKEN|SECRET|AUTH|NODE_OPTIONS|NODE_TEST_CONTEXT)/.test(key)));
  const run=spawnSync(process.execPath,['--test','--test-reporter=tap',testPath],{cwd,env,encoding:'utf8',timeout:10000});
  assert.equal(run.status,0,run.stdout+run.stderr);
  const built=buildAcceptanceReceipt({summary:'Preserve both input records.',expectedOutput:fixture.context,acceptanceCriteria:[fixture.selected],changeMode:'source-change',source:'runtime'});
  const digest=versionWorkingTreeHash('7'.repeat(64)),scope=[sourcePath,testPath];
  const task={...built,acceptanceReceipt:built.receipt,scope,criterionGraph:compileCriterionGraph({acceptanceCriteria:built.acceptanceCriteria,scope,verifyCommands:[command],changeMode:'source-change',createdAt:'2026-09-07T00:00:00.000Z'}),summary:'Preserve both input records.',expectedOutput:fixture.context,changeMode:'source-change',workingTreeDigestAlgorithm:'wt-content-v2',changedFiles:scope,verifyCommands:[command],
    verifyEvidence:[{command,exitCode:run.status,observed:true,matchedProfileCommand:true,preWorkingTreeDigest:digest,workingTreeDigest:digest,recordedAt:'2026-09-07T00:00:00.000Z'}]};
  const refresh=changed=>refreshAcceptanceReceipt(changed,{cwd,currentWorkingTreeDigest:digest});
  assert.equal(refresh(task).receipt.criteria[0].status,expected);
  if(expected==='satisfied') for(const changed of [{...task,verifyEvidence:[]},{...task,verifyEvidence:[{...task.verifyEvidence[0],exitCode:1}]},
    {...task,verifyEvidence:[{...task.verifyEvidence[0],workingTreeDigest:versionWorkingTreeHash('6'.repeat(64))}]}]) assert.equal(refresh(changed).receipt.criteria[0].status,'pending');
});
import { compileCriterionGraph as compileCachedGraph } from "../packages/piagent-core/extensions/criterion-graph.js";

function cacheFixture(options={}) {
  const source=options.source ?? `function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function label(value) { return typeof value === 'string' && value.length > 0; }
function whole(value) { return Number.isFinite(value) && Number.isInteger(value); }
export function canReuse(grant, query) {
  if (!object(grant) || !object(query)
    || ![grant.teamId, grant.subjectId, grant.action, query.teamId, query.subjectId, query.action].every(label)
    || ![grant.policyRevision, grant.evaluationTime, grant.until, query.currentPolicyRevision, query.at].every(whole)
    || (query.revocation !== null && !whole(query.revocation))) throw new TypeError('invalid grant');
  return grant.teamId === query.teamId && grant.subjectId === query.subjectId && grant.action === query.action
    && grant.policyRevision === query.currentPolicyRevision && grant.evaluationTime <= query.at && query.at < grant.until
    && !(query.revocation !== null && query.revocation <= query.at);
}`;
  const context=options.context ?? 'Preserve `canReuse(grant, query)`. Both inputs have matching non-empty team, subject, and action identifiers; '
    +'the cached policy revision equals the current policy revision; evaluation is not in the future; and `query.at` is strictly before `grant.until`. '
    +'A revocation at or before `query.at` invalidates the entry. Validate all time and revision fields as finite integers; '
    +'`query.revocation` must be either null or a finite integer. Throw `TypeError` for malformed input. Do not mutate either argument.';
  const imports=`import assert from 'node:assert/strict'; import test from 'node:test'; import {canReuse} from '../src/grant.js';
const makeGrant = (changes = {}) => ({ teamId:'north',subjectId:'person',action:'edit',policyRevision:3,evaluationTime:10,until:20,...changes });
const makeQuery = (changes = {}) => ({ teamId:'north',subjectId:'person',action:'edit',currentPolicyRevision:3,at:10,revocation:null,...changes });\n`;
  const matrix=`test('object and every declared field', () => {
 for(const invalid of [null,undefined,[],1,'',{}]) {
  assert.throws(()=>canReuse(invalid,makeQuery()),TypeError); assert.throws(()=>canReuse(makeGrant(),invalid),TypeError);
 }
 for(const field of ['teamId','subjectId','action']) for(const invalid of ['',null,1,undefined]) {
  assert.throws(()=>canReuse(makeGrant({[field]:invalid}),makeQuery()),TypeError);
  assert.throws(()=>canReuse(makeGrant(),makeQuery({[field]:invalid})),TypeError);
 }
 for(const invalid of [NaN,Infinity,-Infinity,0.25,'10',null,undefined]) {
  for(const field of ['policyRevision','evaluationTime','until']) assert.throws(()=>canReuse(makeGrant({[field]:invalid}),makeQuery()),TypeError);
  for(const field of ['currentPolicyRevision','at']) assert.throws(()=>canReuse(makeGrant(),makeQuery({[field]:invalid})),TypeError);
  if(invalid !== null) assert.throws(()=>canReuse(makeGrant(),makeQuery({revocation:invalid})),TypeError);
 }
});`;
  const snapshots=`test('true false and throwing calls preserve both records', () => {
 for(const input of [makeQuery(),makeQuery({revocation:10}),makeQuery({at:'10'})]) {
  const cached=makeGrant(), beforeGrant=structuredClone(cached), beforeQuery=structuredClone(input);
  if(typeof input.at === 'string') assert.throws(()=>canReuse(cached,input),TypeError);
  else canReuse(cached,input);
  assert.deepEqual(cached,beforeGrant); assert.deepEqual(input,beforeQuery);
 }
});`;
  const tests=options.tests ?? imports+matrix+snapshots;
  return {source,context,imports,matrix,snapshots,tests,input:{taskText:'Throw `TypeError` for malformed input.',contextText:context,sourceText:source,testText:tests,
    sourceEntries:[{path:'src/grant.js',text:source}],testEntries:[{path:'test/grant.test.js',text:tests}],namedTargets:options.inferred?[]:['canReuse']}};
}

function runCacheReceipt(t,fixture,selected,expected) {
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'piagent-cached-record-control-'));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
 const sourcePath='grant.mjs',testPath='grant.test.mjs',command=`node --test ${testPath}`,scope=[sourcePath,testPath];
 fs.writeFileSync(path.join(cwd,sourcePath),fixture.source);fs.writeFileSync(path.join(cwd,testPath),fixture.tests.replace('../src/grant.js','./grant.mjs'));
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/(^PI_|^PIAGENT_|^OPENAI_|^ANTHROPIC_|^CODEX_|API_KEY|TOKEN|SECRET|AUTH|NODE_OPTIONS|NODE_TEST_CONTEXT)/.test(key)));
 const run=spawnSync(process.execPath,['--test','--test-reporter=tap',testPath],{cwd,env,encoding:'utf8',timeout:10000});assert.equal(run.status,0,run.stdout+run.stderr);
 const built=buildAcceptanceReceipt({summary:'Validate cached grant records.',expectedOutput:fixture.context,acceptanceCriteria:[selected],changeMode:'source-change',source:'runtime'});
 const digest=versionWorkingTreeHash('5'.repeat(64));
 const task={...built,acceptanceReceipt:built.receipt,scope,criterionGraph:compileCachedGraph({acceptanceCriteria:built.acceptanceCriteria,scope,verifyCommands:[command],changeMode:'source-change',createdAt:'2026-09-07T00:00:00.000Z'}),summary:'Validate cached grant records.',expectedOutput:fixture.context,changeMode:'source-change',workingTreeDigestAlgorithm:'wt-content-v2',changedFiles:scope,verifyCommands:[command],verifyEvidence:[{command,exitCode:run.status,observed:true,matchedProfileCommand:true,preWorkingTreeDigest:digest,workingTreeDigest:digest,recordedAt:'2026-09-07T00:00:00.000Z'}]};
 const refresh=changed=>refreshAcceptanceReceipt(changed,{cwd,currentWorkingTreeDigest:digest});
 assert.equal(refresh(task).receipt.criteria[0].status,expected);
 if(expected==='satisfied')for(const changed of [{...task,verifyEvidence:[]},{...task,verifyEvidence:[{...task.verifyEvidence[0],exitCode:1}]},{...task,verifyEvidence:[{...task.verifyEvidence[0],workingTreeDigest:versionWorkingTreeHash('4'.repeat(64))}]}])assert.equal(refresh(changed).receipt.criteria[0].status,'pending');
 if(fixture.arrayWitness){
  const script="import {canReuse} from './grant.mjs';const grant=Object.assign([],{teamId:'north',subjectId:'person',action:'edit',policyRevision:3,evaluationTime:10,until:20});const query={teamId:'north',subjectId:'person',action:'edit',currentPolicyRevision:3,at:10,revocation:null};console.log(canReuse(grant,query));";
  const witness=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd,env,encoding:'utf8',timeout:10000});assert.equal(witness.status,0,witness.stderr);assert.equal(witness.stdout.trim(),'true','Array with valid-looking properties was wrongly accepted by this source');
 }
}
for(const [label,change,expected] of [
 ['both separate snapshots through true false throw',x=>x,'satisfied'],
 ['wrapped context whitespace',x=>({...x,context:x.context.replace('all time and revision','all time\nand revision')}),'satisfied'],
 ['source writes and restores grant',x=>({...x,source:x.source.replace('  return grant.teamId',"  const saved=grant.teamId; grant.teamId='changed'; grant.teamId=saved; return grant.teamId")}),'pending'],
 ['grant mutation hidden by grant snapshot alias',x=>({...x,source:x.source.replace('  return grant.teamId',"  grant.teamId='changed'; return grant.teamId"),tests:x.tests.replace('beforeGrant=structuredClone(cached)','beforeGrant=cached')}),'pending'],
 ['query mutation hidden by query snapshot alias',x=>({...x,source:x.source.replace('  return grant.teamId',"  query.teamId='changed'; return grant.teamId"),tests:x.tests.replace('beforeQuery=structuredClone(input)','beforeQuery=input')}),'pending'],
 ['grant snapshot is an alias',x=>({...x,tests:x.tests.replace('beforeGrant=structuredClone(cached)','beforeGrant=cached')}),'pending'],
 ['query snapshot is an alias',x=>({...x,tests:x.tests.replace('beforeQuery=structuredClone(input)','beforeQuery=input')}),'pending'],
 ['only grant is compared',x=>({...x,tests:x.tests.replace(' assert.deepEqual(input,beforeQuery);','')}),'pending'],
 ['only query is compared',x=>({...x,tests:x.tests.replace('assert.deepEqual(cached,beforeGrant); ','')}),'pending'],
 ['grant compared to itself',x=>({...x,tests:x.tests.replace('assert.deepEqual(cached,beforeGrant)','assert.deepEqual(cached,cached)')}),'pending'],
 ['snapshot values refreshed after call',x=>({...x,tests:x.tests.replace('  assert.deepEqual(cached,beforeGrant);',"  beforeGrant.teamId=cached.teamId; assert.deepEqual(cached,beforeGrant);")}),'pending'],
 ['false outcome absent',x=>({...x,tests:x.tests.replace(',makeQuery({revocation:10})','')}),'pending'],
 ['true outcome absent',x=>({...x,tests:x.tests.replace('[makeQuery(),makeQuery({revocation:10})','[makeQuery({revocation:10})')}),'pending'],
 ['throw outcome absent',x=>({...x,tests:x.tests.replace(",makeQuery({at:'10'})",'')}),'pending'],
 ['snapshots skipped',x=>({...x,tests:x.tests.replace("test('true false", "test.skip('true false")}),'pending'],
 ['clone replaced by identity',x=>({...x,tests:x.tests.replace("test('object", "const structuredClone=value=>value; test('object")}),'pending'],
 ['assert replaced to hide mutation',x=>({...x,source:x.source.replace('  return grant.teamId',"  grant.teamId='changed'; return grant.teamId"),tests:x.tests.replace("test('object", "assert.deepEqual=()=>{}; test('object")}),'pending'],
 ['strict independent deep comparisons',x=>({...x,tests:x.tests.replaceAll('assert.deepEqual','assert.deepStrictEqual')}),'satisfied']
]) test(`cached record snapshots after actual passing verifier: ${label}`,t=>runCacheReceipt(t,change(cacheFixture()),'Do not mutate either argument.',expected));

function byteFixture() {
 const source=`export function readFrames(pieces) {
  if (!Array.isArray(pieces) || pieces.some(part => !(part instanceof Uint8Array))) throw new TypeError('byte chunks required');
  const converter = new TextDecoder('utf-8', {fatal:true});
  const rows = []; let buffered = '';
  const collect = () => { for (const line of buffered.split('\n')) { if (line.length > 0) rows.push(JSON.parse(line)); } };
  for (const part of pieces) { buffered += converter.decode(part, {stream:true}); }
  buffered += converter.decode(); collect(); return rows;
}`.replace("split('\n')","split('\\n')");
 const tests=`import assert from 'node:assert/strict';
import test from 'node:test';
import {readFrames} from '../src/frames.js';
const bytesOf = value => new TextEncoder().encode(value);
test('byte buffers and view identities survive decoding', () => {
 const storage = bytesOf('x{"n":1}\\ny'), view = storage.subarray(1,storage.length-1);
 const tail = bytesOf('{"n":2}'), pieces = [view,tail];
 const originalBytes = [Array.from(storage),Array.from(tail)];
 const originalPieces = [...pieces];
 assert.deepEqual(readFrames(pieces),[{n:1},{n:2}]);
 assert.equal(pieces.length,originalPieces.length);
 assert.deepEqual(pieces,originalPieces);
 assert.strictEqual(pieces[0],view); assert.strictEqual(pieces[1],tail);
 assert.deepEqual([Array.from(storage),Array.from(tail)],originalBytes);
});`;
 return {source,tests};
}
function runByteReceipt(t,fixture,expected) {
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'piagent-byte-snapshot-'));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
 const sourcePath='src/frames.js',testPath='test/frames.test.js',command=`node --test ${testPath}`,scope=[sourcePath,testPath,...(fixture.manifestChange?['package.json']:[])];
 fs.writeFileSync(path.join(cwd,'package.json'),JSON.stringify({type:'module',...(fixture.manifestChange?{dependencies:{unrequested:'1.0.0'}}:{})}));
 for(const [name,text] of [[sourcePath,fixture.source],[testPath,fixture.tests]]){const file=path.join(cwd,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);}
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/(^PI_|^PIAGENT_|^OPENAI_|^ANTHROPIC_|^CODEX_|API_KEY|TOKEN|SECRET|AUTH|NODE_OPTIONS|NODE_TEST_CONTEXT)/.test(key)));
 const run=spawnSync(process.execPath,['--test','--test-reporter=tap',testPath],{cwd,env,encoding:'utf8',timeout:10000});assert.equal(run.status,0,run.stdout+run.stderr);assert.match(run.stdout,fixture.skipped?/^# skipped 1$/m:/^# pass 1$/m);
 const selected='Do not mutate the chunk array or its buffers and do not add dependencies.';
 const built=buildAcceptanceReceipt({summary:'Read byte frames without mutating inputs.',acceptanceCriteria:[selected],changeMode:'source-change',source:'runtime'}),digest=versionWorkingTreeHash(crypto.createHash('sha256').update(fixture.source).update(fixture.tests).digest('hex'));
 const task={...built,acceptanceReceipt:built.receipt,summary:'Read byte frames without mutating inputs.',scope,criterionGraph:compileCriterionGraph({acceptanceCriteria:built.acceptanceCriteria,scope,verifyCommands:[command],changeMode:'source-change',createdAt:'2026-09-07T00:00:00.000Z'}),changeMode:'source-change',workingTreeDigestAlgorithm:'wt-content-v2',changedFiles:scope,verifyCommands:[command],verifyEvidence:[{command,exitCode:run.status,observed:true,matchedProfileCommand:true,preWorkingTreeDigest:digest,workingTreeDigest:digest,recordedAt:'2026-09-07T00:00:00.000Z'}]};
 const refresh=changed=>refreshAcceptanceReceipt(changed,{cwd,currentWorkingTreeDigest:digest});assert.equal(refresh(task).receipt.criteria[0].status,expected);
 if(expected==='satisfied')for(const changed of [{...task,verifyEvidence:[]},{...task,verifyEvidence:[{...task.verifyEvidence[0],exitCode:1}]},{...task,verifyEvidence:[{...task.verifyEvidence[0],workingTreeDigest:versionWorkingTreeHash('e'.repeat(64))}]}])assert.equal(refresh(changed).receipt.criteria[0].status,'pending');
}
for(const [label,change,expected] of [
 ['native backing coverage and identities',x=>x,'satisfied'],
 ['renamed API and input bindings',x=>({...x,source:x.source.replaceAll('readFrames','decodeMessages').replaceAll('pieces','segments'),tests:x.tests.replaceAll('readFrames','decodeMessages').replaceAll('pieces','segments')}),'satisfied'],
 ['strict deep byte comparisons',x=>({...x,tests:x.tests.replaceAll('assert.deepEqual','assert.deepStrictEqual')}),'satisfied'],
 ['omitted backing byte comparison',x=>({...x,tests:x.tests.replace(' assert.deepEqual([Array.from(storage),Array.from(tail)],originalBytes);','')}),'pending'],
 ['view-only snapshot misses surrounding bytes',x=>({...x,tests:x.tests.replaceAll('Array.from(storage)','Array.from(view)')}),'pending'],
 ['backing mutation hidden by view-only snapshot',x=>({...x,source:x.source.replace('  const converter',"  new Uint8Array(pieces[0].buffer)[0]=0; const converter"),tests:x.tests.replaceAll('Array.from(storage)','Array.from(view)')}),'pending'],
 ['backing mutation hidden by aliased snapshots',x=>({...x,source:x.source.replace('  const converter',"  new Uint8Array(pieces[0].buffer)[0]=0; const converter"),tests:x.tests.replaceAll('[Array.from(storage),Array.from(tail)]','[storage,tail]')}),'pending'],
 ['source array mutation followed by restoration',x=>({...x,source:x.source.replace('  const converter',"  pieces.reverse();pieces.reverse(); const converter")}),'pending'],
 ['input mutation and restoration inside validation callback',x=>({...x,source:x.source.replace('part => !(part instanceof Uint8Array)',"part => {part.reverse();part.reverse();return !(part instanceof Uint8Array);}")}),'pending'],
 ['chunk identities are an alias',x=>({...x,tests:x.tests.replace('originalPieces = [...pieces]','originalPieces = pieces')}),'pending'],
 ['missing array length check',x=>({...x,tests:x.tests.replace(' assert.equal(pieces.length,originalPieces.length);','')}),'pending'],
 ['missing array comparison',x=>({...x,tests:x.tests.replace(' assert.deepEqual(pieces,originalPieces);','')}),'pending'],
 ['missing first chunk identity',x=>({...x,tests:x.tests.replace('assert.strictEqual(pieces[0],view); ','')}),'pending'],
 ['missing second chunk identity',x=>({...x,tests:x.tests.replace(' assert.strictEqual(pieces[1],tail);','')}),'pending'],
 ['chunk compared only to itself',x=>({...x,tests:x.tests.replace('assert.strictEqual(pieces[0],view)','assert.strictEqual(pieces[0],pieces[0])')}),'pending'],
 ['byte projection patched to return no data',x=>({...x,source:x.source.replace('  const converter',"  new Uint8Array(pieces[0].buffer)[0]=0; const converter"),tests:x.tests.replace("test('byte", "Array.from=()=>[];test('byte")}),'pending'],
 ['deep assertion patched to hide byte mutation',x=>({...x,source:x.source.replace('  const converter',"  new Uint8Array(pieces[0].buffer)[0]=0; const converter"),tests:x.tests.replace("test('byte", "assert.deepEqual=()=>{};test('byte")}),'pending'],
 ['snapshot refreshed after the call',x=>({...x,tests:x.tests.replace(' const originalBytes = [Array.from(storage),Array.from(tail)];\n','').replace(' assert.equal(pieces.length',' const originalBytes = [Array.from(storage),Array.from(tail)];\n assert.equal(pieces.length')}),'pending'],
 ['whole buffer view does not exercise partial view ownership',x=>({...x,tests:x.tests.replace("bytesOf('x{\"n\":1}\\ny'), view = storage.subarray(1,storage.length-1)","bytesOf('{\"n\":1}\\n'), view = storage.subarray(0,storage.length)")}),'pending'],
 ['skipped snapshot test',x=>({...x,tests:x.tests.replace("test('byte", "test.skip('byte"),skipped:true}),'pending'],
 ['unrequested dependency remains conjunctive',x=>({...x,manifestChange:true}),'pending'],
 ['encoder native escapes through alias',x=>({...x,tests:x.tests.replace('const bytesOf =','const borrowed = TextEncoder;const bytesOf =')}),'pending']
])test(`byte ownership after actual verifier: ${label}`,t=>runByteReceipt(t,change(byteFixture()),expected));

function immutableReducerFixture() {
 const source=`export const seed = Object.freeze({items:[],counter:0});
export function change(input = seed, event) {
 if (event.tag === 'set') {
  if (!Number.isInteger(event.version) || event.version < input.counter) return input;
  return {...input, counter:event.version, items:[...event.items]};
 }
 return input;
}`;
 const tests=`import assert from 'node:assert/strict';
import test from 'node:test';
import {seed,change} from '../src/reducer.js';
test('records and array values remain unchanged', () => {
 const state = Object.freeze({items:Object.freeze(['old']),counter:1});
 for (const [tag,version] of [['set',2],['ignored',0]]) {
  const action = Object.freeze({tag,version,items:Object.freeze(['new'])});
  const result = change(state,action);
  assert.deepEqual(state.items,['old']); assert.deepEqual(action.items,['new']);
  if (tag === 'set') { assert.deepEqual(result.items,['new']); assert.notStrictEqual(result.items,action.items); }
  else assert.strictEqual(result,state);
 }
});`;
 return {source,tests};
}
function runImmutableReducerReceipt(t,fixture,expected) {
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'piagent-immutable-reducer-'));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
 const sourcePath='src/reducer.js',testPath='test/reducer.test.js',command=`node --test ${testPath}`,scope=[sourcePath,testPath];
 fs.writeFileSync(path.join(cwd,'package.json'),'{"type":"module"}');
 for(const [name,text] of [[sourcePath,fixture.source],[testPath,fixture.tests]]){const file=path.join(cwd,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);}
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/(^PI_|^PIAGENT_|^OPENAI_|^ANTHROPIC_|^CODEX_|API_KEY|TOKEN|SECRET|AUTH|NODE_OPTIONS|NODE_TEST_CONTEXT)/.test(key)));
 const run=spawnSync(process.execPath,['--test','--test-reporter=tap',testPath],{cwd,env,encoding:'utf8',timeout:10000});assert.equal(run.status,0,run.stdout+run.stderr);assert.match(run.stdout,fixture.skipped?/^# skipped 1$/m:/^# pass 1$/m);
 if(fixture.witness){const witness=spawnSync(process.execPath,['--input-type=module','-e',"import assert from 'node:assert/strict';import {change} from './src/reducer.js';const state={items:['old'],counter:1},action={tag:'set',version:2,items:['new']};"+fixture.witness],{cwd,env,encoding:'utf8',timeout:10000});assert.equal(witness.status,0,witness.stdout+witness.stderr);}
 const selected='Do not mutate state, actions, or result arrays.',built=buildAcceptanceReceipt({summary:'Preserve reducer input records.',acceptanceCriteria:[selected],changeMode:'source-change',source:'runtime'}),digest=versionWorkingTreeHash(crypto.createHash('sha256').update(fixture.source).update(fixture.tests).digest('hex'));
 const task={...built,acceptanceReceipt:built.receipt,summary:'Preserve reducer input records.',scope,criterionGraph:compileCriterionGraph({acceptanceCriteria:built.acceptanceCriteria,scope,verifyCommands:[command],changeMode:'source-change',createdAt:'2026-09-07T00:00:00.000Z'}),changeMode:'source-change',workingTreeDigestAlgorithm:'wt-content-v2',changedFiles:scope,verifyCommands:[command],verifyEvidence:[{command,exitCode:run.status,observed:true,matchedProfileCommand:true,preWorkingTreeDigest:digest,workingTreeDigest:digest,recordedAt:'2026-09-07T00:00:00.000Z'}]};
 const refresh=changed=>refreshAcceptanceReceipt(changed,{cwd,currentWorkingTreeDigest:digest});assert.equal(refresh(task).receipt.criteria[0].status,expected);
 if(expected==='satisfied') for(const changed of [{...task,verifyEvidence:[]},{...task,verifyEvidence:[{...task.verifyEvidence[0],exitCode:1}]},{...task,verifyEvidence:[{...task.verifyEvidence[0],workingTreeDigest:versionWorkingTreeHash('a'.repeat(64))}]}])assert.equal(refresh(changed).receipt.criteria[0].status,'pending');
}
for(const [label,change,expected] of [
 ['source branches contain no input writes',x=>x,'satisfied'],
 ['ordinary mutable records',x=>({...x,tests:x.tests.replace("Object.freeze({items:Object.freeze(['old']),counter:1})","{items:['old'],counter:1}").replace("Object.freeze({tag,version,items:Object.freeze(['new'])})","{tag,version,items:['new']}")}),'satisfied'],
 ['renamed exports and field names',x=>({...x,source:x.source.replaceAll('change','advance').replaceAll('input','current').replaceAll('event','command').replaceAll('items','entries'),tests:x.tests.replaceAll('change','advance').replaceAll('items','entries')}),'satisfied'],
 ['strict deep input comparisons',x=>({...x,tests:x.tests.replaceAll('assert.deepEqual','assert.deepStrictEqual')}),'satisfied'],
 ['conditional mutable state write',x=>({...x,source:x.source.replace(" if (event.tag", " if (!Object.isFrozen(input)) input.extra=true;\n if (event.tag"),witness:'change(state,action);assert.equal(state.extra,true);'}),'pending'],
 ['conditional mutable action write',x=>({...x,source:x.source.replace(" if (event.tag", " if (!Object.isFrozen(event)) event.extra=true;\n if (event.tag"),witness:'change(state,action);assert.equal(action.extra,true);'}),'pending'],
 ['conditional input array mutation',x=>({...x,source:x.source.replace(" if (event.tag", " if (!Object.isFrozen(input.items)) input.items.push('changed');\n if (event.tag"),witness:"change(state,action);assert.deepEqual(state.items,['old','changed']);"}),'pending'],
 ['conditional action array mutation',x=>({...x,source:x.source.replace(" if (event.tag", " if (!Object.isFrozen(event.items)) event.items.push('changed');\n if (event.tag"),witness:"change(state,action);assert.deepEqual(action.items,['new','changed']);"}),'pending'],
 ['freezing the input is also a source effect',x=>({...x,source:x.source.replace(" if (event.tag", " Object.freeze(input);\n if (event.tag"),witness:'assert.equal(Object.isFrozen(state),false);change(state,action);assert.equal(Object.isFrozen(state),true);'}),'pending'],
 ['input write and restoration',x=>({...x,source:x.source.replace(" if (event.tag", " if (!Object.isFrozen(input)) {const saved=input.counter;input.counter=99;input.counter=saved;}\n if (event.tag")}),'pending'],
 ['unknown helper cannot replace source proof',x=>({...x,source:'function isWhole(value){return Number.isInteger(value);}\n'+x.source.replace('Number.isInteger(event.version)','isWhole(event.version)')}),'pending'],
 ['input default can call an effectful helper',x=>({...x,source:'function defaultState(){return seed;}\n'+x.source.replace('input = seed','input = defaultState()')}),'pending'],
 ['unobserved source branch still has a write',x=>({...x,source:x.source.replace(" if (event.tag", " if (event.tag === 'unobserved') input.extra=true;\n if (event.tag"),witness:"change(state,{...action,tag:'unobserved'});assert.equal(state.extra,true);"}),'pending'],
 ['missing state array input',x=>({...x,tests:x.tests.replace("items:Object.freeze(['old'])","items:'old'").replace("assert.deepEqual(state.items,['old'])","assert.deepEqual(state.items,'old')")}),'pending'],
 ['missing action array input',x=>({...x,tests:x.tests.replace("items:Object.freeze(['new'])","items:'new'").replace("assert.deepEqual(action.items,['new'])","assert.deepEqual(action.items,'new')").replace("assert.deepEqual(result.items,['new'])","assert.deepEqual(result.items,['n','e','w'])")}),'pending'],
 ['skipped witness',x=>({...x,tests:x.tests.replace("test('records", "test.skip('records"),skipped:true}),'pending'],
 ['unreachable witness',x=>({...x,tests:x.tests.replace(' for (const [tag,version]', ' if (false) for (const [tag,version]')}),'pending'],
 ['empty literal loop',x=>({...x,tests:x.tests.replace("[['set',2],['ignored',0]]","[]")}),'pending'],
 ['live assertions compare only fixture values',x=>({...x,tests:x.tests.replace('const result = change(state,action)','const result = tag === \'set\' ? {...state,items:[...action.items]} : state')}),'pending'],
 ['shadowed freeze helper',x=>({...x,tests:x.tests.replace("test('records", "const Object={freeze:value=>value};test('records")}),'pending'],
 ['replaced assertion carrier',x=>({...x,tests:x.tests.replace("test('records", "assert.deepEqual=()=>{};test('records")}),'pending']
])test(`pure reducer after actual verifier: ${label}`,t=>runImmutableReducerReceipt(t,change(immutableReducerFixture()),expected));

import {parse as parseFactoryProgram,parseExpression as parseFactoryExpression} from '@babel/parser';
import {flatRecordFactories as readRecordFactories,flatRecordValue as readRecordFact} from '../packages/piagent-core/extensions/acceptance-literal-dataflow.js';
const recordFactorySource=`const empty=()=>({entities:{},applied:[]});const event=(overrides={})=>({id:'one',owner:'account',revision:0,payload:{count:1},...overrides});`;
function factoryFact(expression,{source=recordFactorySource,nested=true,before=Infinity,bindings=new Map()}={}){
 const program=parseFactoryProgram(source,{sourceType:'module'});return readRecordFact(parseFactoryExpression(expression),bindings,readRecordFactories(program,nested),before,0,nested);
}
function unpackRecordFact(value){
 if(value?.kind==='record')return Object.fromEntries([...value.fields].map(([name,item])=>[name,unpackRecordFact(item)]));
 if(value?.kind==='array')return value.elements.map(unpackRecordFact);return value?.value;
}
for(const [label,expression,wanted] of [
 ['zero-argument nested state','empty()',{entities:{},applied:[]}],
 ['nested default payload','event()',{id:'one',owner:'account',revision:0,payload:{count:1}}],
 ['empty identifier override',"event({id:''})",{id:'',owner:'account',revision:0,payload:{count:1}}],
 ['wrong-type identifier override','event({owner:1})',{id:'one',owner:1,revision:0,payload:{count:1}}],
 ['two independently allocated events',"[event(),event({id:'two',payload:{count:2}})]",[{id:'one',owner:'account',revision:0,payload:{count:1}},{id:'two',owner:'account',revision:0,payload:{count:2}}]],
 ['nested array payload','event({payload:{rows:[1,null,false]}})',{id:'one',owner:'account',revision:0,payload:{rows:[1,null,false]}}],
 ['explicit undefined override','event({owner:undefined})',{id:'one',owner:undefined,revision:0,payload:{count:1}}],
 ['explicit undefined factory argument','event(undefined)',{id:'one',owner:'account',revision:0,payload:{count:1}}],
 ['literal computed key',"event({['owner']:''})",{id:'one',owner:'',revision:0,payload:{count:1}}],
 ['case-sensitive fields',"({id:'one',ID:'two'})",{id:'one',ID:'two'}]
])test(`nested record facts: ${label}`,()=>assert.deepEqual(unpackRecordFact(factoryFact(expression)),wanted));

for(const [label,expression,options] of [
 ['effectful argument to zero-argument factory','empty(sideEffect())',{}],
 ['ignored literal argument to zero-argument factory','empty({id:1})',{}],
 ['factory before declaration','event()',{before:0}],
 ['getter payload','event({payload:{get count(){throw new Error("must not run");}}})',{}],
 ['method payload','event({payload:{count(){return 1;}}})',{}],
 ['function payload','event({payload:()=>1})',{}],
 ['unknown invocation','event({payload:make()})',{}],
 ['unknown value alias','event({payload:saved})',{}],
 ['unknown factory alias','alias()',{source:recordFactorySource+'const alias=event;'}],
 ['factory closes over an unknown value','event()',{source:"const seed={count:1};const event=(overrides={})=>({payload:seed,...overrides});"}],
 ['effectful factory body','event()',{source:"const event=()=>{sideEffect();return {id:1};};"}],
 ['async factory','event()',{source:"const event=async()=>({id:1});"}],
 ['sparse array','event({payload:[,1]})',{}],
 ['array spread','event({payload:[...[1]]})',{}],
 ['record spread override','event({...{id:1}})',{}],
 ['duplicate field names',"event({id:'one',id:'two'})",{}],
 ['prototype field','event({__proto__:null})',{}],
 ['nested prototype field','event({payload:{constructor:1}})',{}],
 ['unknown computed key','event({[key]:1})',{}],
 ['array expansion bound',`[${'event(),'.repeat(32)}event()]`,{}],
 ['depth bound','({a:{b:{c:{d:{e:{f:{g:{h:1}}}}}}}})',{}],
 ['numeric expression','event({revision:1+1})',{}],
 ['second factory argument','event({}, sideEffect())',{}]
])test(`nested record facts refuse ${label}`,()=>assert.equal(factoryFact(expression,options),undefined));

test('nested record mode preserves missing versus explicitly undefined fields',()=>{
 const absent=factoryFact('({id:"one"})'),present=factoryFact('({id:"one",owner:undefined})');
 assert.equal(absent.fields.has('owner'),false);assert.equal(present.fields.has('owner'),true);
 assert.equal(present.fields.get('owner').kind,'primitive');assert.equal(present.fields.get('owner').value,undefined);
});
test('nested records preserve bound loop values without reading unrelated aliases',()=>{
 const row=factoryFact("event({id:''})");const value=factoryFact('[item]',{bindings:new Map([['item',row]])});
 assert.equal(value.elements[0].fields.get('id').value,'');assert.equal(factoryFact('[other]',{bindings:new Map([['item',row]])}),undefined);
});
test('default flat mode retains its existing boundary',()=>{
 for(const expression of ['({payload:{count:1}})','[1]','empty()','event()'])assert.equal(factoryFact(expression,{nested:false}),undefined);
 assert.deepEqual(unpackRecordFact(factoryFact('({id:"one",revision:0})',{nested:false})),{id:'one',revision:0});
 const source="const event=(overrides={})=>({id:'one',revision:0,...overrides});";
 assert.deepEqual(unpackRecordFact(factoryFact("event({id:''})",{source,nested:false})),{id:'',revision:0});
});

function orderedRecordFixture(){
 const source=`function object(value){return value && typeof value === 'object' && !Array.isArray(value);}
function key(value){return typeof value === 'string' && value.length > 0;}
export function applyRecords(seed, records){
 if(!object(seed)||!object(seed.nodes)||!Array.isArray(seed.seenIds)||seed.seenIds.some(value=>!key(value))||!Array.isArray(records))throw new TypeError('state');
 const output=structuredClone(seed);const seen=new Set(output.seenIds);
 for(const item of records){
  if(!object(item)||!key(item.recordKey)||!key(item.parentKey)||!Number.isInteger(item.expectedRevision)||item.expectedRevision<0)throw new TypeError('record');
  if(seen.has(item.recordKey))continue;
  const current=output.nodes[item.parentKey];
  if(current!==undefined&&(!object(current)||!Number.isInteger(current.revision)||current.revision<0))throw new TypeError('node');
  const revision=current?.revision??0;
  if(revision!==item.expectedRevision)throw new Error('version conflict');
  output.nodes[item.parentKey]={revision:revision+1,payload:structuredClone(item.value)};
  output.seenIds.push(item.recordKey);seen.add(item.recordKey);
 }
 return output;
}`;
 const tests=`import assert from 'node:assert/strict';import test from 'node:test';import {applyRecords} from '../src/records.js';
const empty=()=>({nodes:{},seenIds:[]});
const entry=(changes={})=>({recordKey:'one',parentKey:'parent',expectedRevision:0,value:{n:1},...changes});
test('preserves accepted record order',()=>{
 const state=empty(),records=[entry(),entry({recordKey:'two',expectedRevision:1,value:{n:2}})];
 const before=structuredClone([state,records]);const result=applyRecords(state,records);
 assert.deepEqual(result,{nodes:{parent:{revision:2,payload:{n:2}}},seenIds:['one','two']});assert.deepEqual([state,records],before);
});
test('rejects malformed containers and declared fields',()=>{
 for(const state of [null,[],{},{nodes:null,seenIds:[]},{nodes:{},seenIds:''},{nodes:{},seenIds:['']}])assert.throws(()=>applyRecords(state,[]),TypeError);
 for(const item of [null,[],{},entry({recordKey:''}),entry({recordKey:1}),entry({parentKey:''}),entry({parentKey:null}),entry({expectedRevision:0.5}),entry({expectedRevision:'0'})]){
  assert.throws(()=>applyRecords(empty(),[item]),TypeError);
 }
});`;
 const definition='Each event has a unique non-empty string `recordKey`, a non-empty string `parentKey`, an integer `expectedRevision`, and `value`.';
 const selected='Preserve applied-event order and reject malformed state or event shapes, including empty IDs, with `TypeError`.';
 return {source,tests,definition,selected,signature:'applyRecords(seed, records)'};
}
function runOrderedRecordReceipt(t,fixture,wanted){
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'piagent-ordered-record-'));t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}));
 const sourcePath='src/records.js',testPath='test/records.test.js',scope=[sourcePath,testPath],command=`node --test ${testPath}`;
 fs.writeFileSync(path.join(cwd,'package.json'),'{"type":"module"}');
 for(const [name,text]of [[sourcePath,fixture.source],[testPath,fixture.tests]]){const file=path.join(cwd,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,text);}
 const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/(^PI_|^PIAGENT_|^OPENAI_|^ANTHROPIC_|^CODEX_|API_KEY|TOKEN|SECRET|AUTH|NODE_OPTIONS|NODE_TEST_CONTEXT)/.test(key)));
 const run=spawnSync(process.execPath,['--test','--test-reporter=tap',testPath],{cwd,env,encoding:'utf8',timeout:10000});assert.equal(run.status,0,run.stdout+run.stderr);
 if(fixture.witness){const result=spawnSync(process.execPath,['--input-type=module','-e',"import assert from 'node:assert/strict';import {applyRecords} from './src/records.js';"+fixture.witness],{cwd,env,encoding:'utf8',timeout:10000});assert.equal(result.status,0,result.stdout+result.stderr);}
 const expectedOutput=`Fix src/records.js without changing \`${fixture.signature}\`. ${fixture.definition} ${fixture.selected}`;
 const built=buildAcceptanceReceipt({summary:'Apply versioned records.',expectedOutput,acceptanceCriteria:[fixture.definition,fixture.selected],changeMode:'source-change',source:'runtime'});
 const digest=versionWorkingTreeHash(crypto.createHash('sha256').update(fixture.source).update(fixture.tests).digest('hex'));
 const task={...built,acceptanceReceipt:built.receipt,summary:'Apply versioned records.',expectedOutput,scope,criterionGraph:compileCriterionGraph({acceptanceCriteria:built.acceptanceCriteria,scope,verifyCommands:[command],changeMode:'source-change',createdAt:'2026-09-07T00:00:00.000Z'}),changeMode:'source-change',workingTreeDigestAlgorithm:'wt-content-v2',changedFiles:scope,verifyCommands:[command],verifyEvidence:[{command,exitCode:run.status,observed:true,matchedProfileCommand:true,preWorkingTreeDigest:digest,workingTreeDigest:digest,recordedAt:'2026-09-07T00:00:00.000Z'}]};
 const index=built.acceptanceCriteria.indexOf(fixture.selected),refresh=value=>refreshAcceptanceReceipt(value,{cwd,currentWorkingTreeDigest:digest}).receipt.criteria[index].status;
 assert.ok(index>=0);assert.equal(refresh(task),wanted);
 if(wanted==='satisfied')for(const other of [{...task,verifyEvidence:[]},{...task,verifyEvidence:[{...task.verifyEvidence[0],exitCode:1}]},{...task,verifyEvidence:[{...task.verifyEvidence[0],workingTreeDigest:versionWorkingTreeHash('a'.repeat(64))}]}])assert.equal(refresh(other),'pending');
}
for(const [label,change,wanted]of [
 ['closed guards and actual order witness',x=>x,'satisfied'],
 ['renamed API and declared fields',x=>Object.fromEntries(Object.entries(x).map(([k,v])=>[k,v.replaceAll('applyRecords','transition').replaceAll('recordKey','itemId').replaceAll('parentKey','groupId').replaceAll('expectedRevision','expectedVersion')])),'satisfied'],
 ['renamed test assertion import',x=>({...x,tests:x.tests.replace('import assert','import check').replaceAll('assert.','check.')}),'satisfied'],
 ['renamed source import alias',x=>({...x,tests:x.tests.replace('import {applyRecords}', 'import {applyRecords as transition}').replaceAll('applyRecords(', 'transition(')}),'satisfied'],
 ['native strict deep order assertion',x=>({...x,tests:x.tests.replaceAll('assert.deepEqual','assert.deepStrictEqual')}),'satisfied'],
 ['missing identifiers accepted by predicate',x=>({...x,source:x.source.replace("return typeof value === 'string'", "return value === undefined || typeof value === 'string'"),witness:"const output=applyRecords({nodes:{},seenIds:[]},[{parentKey:'parent',expectedRevision:0,value:1}]);assert.equal(output.seenIds[0],undefined);"}),'pending'],
 ['missing event-array source guard',x=>({...x,source:x.source.replace('||!Array.isArray(records)','')}),'pending'],
 ['missing lower-bound guard',x=>({...x,source:x.source.replace('||item.expectedRevision<0','')}),'pending'],
 ['missing existing-node guard',x=>({...x,source:x.source.replace("  if(current!==undefined&&(!object(current)||!Number.isInteger(current.revision)||current.revision<0))throw new TypeError('node');\n",'')}),'pending'],
 ['safe-integer guard changes the domain',x=>({...x,source:x.source.replaceAll('Number.isInteger','Number.isSafeInteger')}),'pending'],
 ['unknown source helper',x=>({...x,source:'function copy(value){return structuredClone(value);}\n'+x.source.replace('const output=structuredClone(seed)','const output=copy(seed)')}),'pending'],
 ['unobserved input mutation',x=>({...x,source:x.source.replace(' const output='," if(records.length===777)seed.extra=true;\n const output=")}),'pending'],
 ['sorting loses original order outside the public order sample',x=>({...x,source:x.source.replace(' return output;', ' output.seenIds.sort();return output;'),witness:"const result=applyRecords({nodes:{},seenIds:[]},[{recordKey:'z',parentKey:'p',expectedRevision:0,value:1},{recordKey:'a',parentKey:'p',expectedRevision:1,value:2}]);assert.deepEqual(result.seenIds,['a','z']);"}),'pending'],
 ['early source return before guards',x=>({...x,source:x.source.replace(' if(!object(seed)', ' if(records.length===777)return seed;\n if(!object(seed)')}),'pending'],
 ['missing empty first-ID witness',x=>({...x,tests:x.tests.replace("entry({recordKey:''})",'entry({recordKey:1})')}),'pending'],
 ['missing wrong-type first-ID witness',x=>({...x,tests:x.tests.replace('entry({recordKey:1})',"entry({recordKey:''})")}),'pending'],
 ['missing empty second-ID witness',x=>({...x,tests:x.tests.replace("entry({parentKey:''})",'entry({parentKey:null})')}),'pending'],
 ['missing wrong-type second-ID witness',x=>({...x,tests:x.tests.replace('entry({parentKey:null})',"entry({parentKey:''})")}),'pending'],
 ['wrong-type ID cannot borrow another invalid field',x=>({...x,tests:x.tests.replace('entry({parentKey:null})',"entry({parentKey:null,recordKey:''})")}),'pending'],
 ['fractional version cannot borrow invalid ID',x=>({...x,tests:x.tests.replace('entry({expectedRevision:0.5})',"entry({expectedRevision:0.5,recordKey:''})")}),'pending'],
 ['missing fractional witness',x=>({...x,tests:x.tests.replace('entry({expectedRevision:0.5})',"entry({expectedRevision:'0'})")}),'pending'],
 ['missing non-number witness',x=>({...x,tests:x.tests.replace("entry({expectedRevision:'0'})",'entry({expectedRevision:0.5})')}),'pending'],
 ['missing state-array witness',x=>({...x,tests:x.tests.replace('state of [null,[],{}','state of [null,null,{}')}),'pending'],
 ['missing event-object witness',x=>({...x,tests:x.tests.replace('item of [null,[],{}','item of [null,[],[]')}),'pending'],
 ['missing applied-ID witness',x=>({...x,tests:x.tests.replace("{nodes:{},seenIds:['']}","{nodes:{},seenIds:''}")}),'pending'],
 ['unexecuted rejection registration',x=>({...x,tests:x.tests.replace("test('rejects", "test.skip('rejects")}),'pending'],
 ['unreachable malformed-state loop',x=>({...x,tests:x.tests.replace(' for(const state of', ' if(false)for(const state of')}),'pending'],
 ['missing executable target rejection',x=>({...x,tests:x.tests.replaceAll('assert.throws(()=>applyRecords(', 'assert.throws(()=>{throw new TypeError();applyRecords(').replaceAll(',TypeError);', '},TypeError);')}),'pending'],
 ['assertion replacement',x=>({...x,tests:x.tests.replace("test('rejects", "assert.throws=()=>{};test('rejects")}),'pending'],
 ['factory initializer changed',x=>({...x,tests:x.tests.replace('value:{n:1},...changes','value:{n:1},...changes,recordKey:changes.recordKey??\'one\'')}),'pending'],
 ['fixture-only positive order assertion',x=>({...x,tests:x.tests.replace('const result=applyRecords(state,records)',"const result={nodes:{parent:{revision:2,payload:{n:2}}},seenIds:['one','two']}")}),'pending'],
 ['order assertion compares only one accepted identifier',x=>({...x,tests:x.tests.replace("entry(),entry({recordKey:'two',expectedRevision:1,value:{n:2}})","entry({value:{n:2}})").replace("revision:2,payload:{n:2}","revision:1,payload:{n:2}").replace("seenIds:['one','two']","seenIds:['one']")}),'pending'],
 ['additional selected clause must remain required',x=>({...x,selected:x.selected+' Also reject whitespace-only identifiers.'}),'pending']
])test(`ordered record proof after actual verifier: ${label}`,t=>runOrderedRecordReceipt(t,change(orderedRecordFixture()),wanted));
