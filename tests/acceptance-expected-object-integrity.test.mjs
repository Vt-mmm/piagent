import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { genericCriterionEvidence } from "../packages/piagent-core/extensions/acceptance-behavior-proof.js";
import { sanitizeJavaScriptEvidence } from "../packages/piagent-core/extensions/acceptance-contract-semantics.js";

const requirement = "Repeated flags use the last value.";
// This deliberately wrong implementation keeps the first value. A duplicate
// expected key can make its test pass while the recognizer reads the first key.
const source = "export function parseArgs(argv) { return { flags: { mode: argv[0].split('=')[1] }, positional: [] }; }";
const body = expected => `assert.deepEqual(parseArgs(['--mode=first', '--mode=last']), ${expected});`;
function evidence(expected) {
  const raw = "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { parseArgs } from '../src/args.js';\n"
    + `test('repeated flags', () => { ${body(expected)} });`;
  const entry = (path, text) => ({ path, text, evidenceText: sanitizeJavaScriptEvidence(text) });
  return genericCriterionEvidence({ obligation: "requested-behavior",
    task: { changeMode: "source-change", acceptanceCriteria: [requirement], verifyCommands: ["node --test test/args.test.js"] },
    criterion: { hash: crypto.createHash("sha256").update(requirement).digest("hex"), priority: "critical" },
    taskText: requirement, passingVerifier: true, verifierEvidence: { kind: "verify-command", exitCode: 0 },
    corpus: { adapter: { proofCapable: true }, sourceFiles: ["src/args.js"], testFiles: ["test/args.test.js"],
      sourceEntries: [entry("src/args.js", source)], testEntries: [entry("test/args.test.js", raw)] }
  }).evidence;
}

for (const [name, expected] of [
  ["duplicate nested key", "{ flags: { mode: 'last', mode: 'first' }, positional: [] }"],
  ["duplicate quoted key", "{ flags: { mode: 'last', 'mode': 'first' }, positional: [] }"],
  ["escaped hexadecimal alias", "{ flags: { mode: 'last', 'm\\x6fde': 'first' }, positional: [] }"],
  ["escaped unicode alias", "{ flags: { mode: 'last', 'm\\u006fde': 'first' }, positional: [] }"],
  ["nested spread", "{ flags: { mode: 'last', ...{ mode: 'first' } }, positional: [] }"],
  ["duplicate outer key", "{ flags: { mode: 'last' }, flags: { mode: 'first' }, positional: [] }"],
  ["computed override", "{ flags: { mode: 'last', ['mode']: 'first' }, positional: [] }"]
]) test(`${name} cannot turn a passing but incorrect test into requirement evidence`, () => {
  const run = spawnSync(process.execPath, ["--input-type=module", "--eval",
    `import assert from 'node:assert/strict'; ${source} ${body(expected)}`], { encoding: "utf8" });
  assert.equal(run.status, 0, "the corrupted expectation really passes the wrong implementation");
  assert.equal(evidence(expected), undefined);
});

test("unambiguous object expectations remain available in the legacy evidence lane", () => {
  assert.ok(evidence("{ flags: { mode: 'last' }, positional: [] }"));
  assert.ok(evidence("{ 'flags': { 'mode': 'last', }, positional: [], }"));
  assert.equal(evidence("{ flags: { mode: 'last', __proto__: null }, positional: [] }"), undefined);
});
