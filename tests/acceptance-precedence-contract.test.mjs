import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acceptancePrecedenceContractEvidence,
  acceptancePrecedenceContractGuidance
} from "../packages/piagent-core/extensions/acceptance-precedence-contract.js";
import {
  acceptanceBaselineGuidance,
  buildAcceptanceReceipt,
  refreshAcceptanceReceipt
} from "../packages/piagent-core/extensions/acceptance-receipt.js";
import { versionWorkingTreeHash } from "../packages/piagent-core/extensions/working-tree-digest.js";

const TASK_TEXT = [
  "Fix configuration resolution in `src/platform/config.js` and preserve `resolveConfig`.",
  "For each key, precedence is CLI, environment, file, then defaults.",
  "A value is absent only when it is undefined; false, 0, an empty string, and null must not fall through."
].join(" ");

const GOOD_SOURCE = [
  "export function resolveConfig(cli = {}, environment = {}, file = {}, defaults = {}) {",
  "  const firstDefined = (...values) => values.find((value) => value !== undefined);",
  "  return {",
  "    port: firstDefined(cli.port, environment.port, file.port, defaults.port),",
  "    debug: firstDefined(cli.debug, environment.debug, file.debug, defaults.debug),",
  "    label: firstDefined(cli.label, environment.label, file.label, defaults.label)",
  "  };",
  "}", ""
].join("\n");

const LOOP_TEST = [
  "import assert from 'node:assert/strict';",
  "import { resolveConfig } from '../src/platform/config.js';",
  "for (const key of ['port', 'debug', 'label']) {",
  "  for (const value of [false, 0, '', null]) {",
  "    assert.equal(resolveConfig({ [key]: value }, { [key]: 'environment' }, { [key]: 'file' }, { [key]: 'default' })[key], value);",
  "  }",
  "  assert.equal(resolveConfig({ [key]: undefined }, { [key]: 'environment' }, { [key]: 'file' }, { [key]: 'default' })[key], 'environment');",
  "}", ""
].join("\n");

const CONST_LOOP_TEST = [
  "import assert from 'node:assert/strict';",
  "import { resolveConfig } from '../src/platform/config.js';",
  "const keys = ['port', 'debug', 'label'];",
  "const falsey = [false, 0, '', null];",
  "for (const key of keys) {",
  "  for (const value of falsey) {",
  "    assert.equal(resolveConfig({ [key]: value }, { [key]: 'environment' }, { [key]: 'file' }, { [key]: 'default' })[key], value);",
  "  }",
  "  assert.equal(resolveConfig({ [key]: undefined }, { [key]: 'environment' }, { [key]: 'file' }, { [key]: 'default' })[key], 'environment');",
  "}", ""
].join("\n");

function evidence(source = GOOD_SOURCE, testText = LOOP_TEST, taskText = TASK_TEXT) {
  return acceptancePrecedenceContractEvidence({
    taskText,
    sourceEntries: [{ path: "src/platform/config.js", text: source }],
    testEntries: [{ path: "test/config.test.js", text: testText }]
  });
}

function directTest() {
  const lines = [
    "import assert from 'node:assert/strict';",
    "import { resolveConfig } from '../src/platform/config.js';"
  ];
  const literals = [["false", "false"], ["0", "0"], ["''", "''"], ["null", "null"]];
  for (const key of ["port", "debug", "label"]) {
    for (const [input, expected] of literals) {
      lines.push(`assert.equal(resolveConfig({ ${key}: ${input} }, { ${key}: 'environment' }, { ${key}: 'file' }, { ${key}: 'default' }).${key}, ${expected});`);
    }
    lines.push(`assert.equal(resolveConfig({ ${key}: undefined }, { ${key}: 'environment' }, { ${key}: 'file' }, { ${key}: 'default' }).${key}, 'environment');`);
  }
  lines.push("assert.deepEqual(resolveConfig({ port: false, debug: 0, label: null }, {}, {}, {}), { port: false, debug: 0, label: null });", "");
  return lines.join("\n");
}

function writeProject(source, testText) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-precedence-"));
  for (const [file, text] of [["src/platform/config.js", source], ["test/config.test.js", testText]]) {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), text);
  }
  return cwd;
}

test("proves every static key with direct, deepEqual, inline-loop, and const-literal-loop assertions", () => {
  for (const [name, testText] of [["inline-loop", LOOP_TEST], ["const-loop", CONST_LOOP_TEST], ["direct", directTest()]]) {
    const result = evidence(GOOD_SOURCE, testText);
    assert.equal(result.disposition, "applicable", name);
    assert.equal(result.sourceOk, true, name);
    assert.equal(result.testOk, true, name);
    assert.equal(result.proved, true, name);
    assert.deepEqual(result.keys, ["port", "debug", "label"]);
    assert.deepEqual(result.layers, ["cli", "environment", "file", "defaults"]);
  }
  const primitiveObserver = evidence(`const observe = (value) => value;\n${GOOD_SOURCE.replace("  return {", "  observe(cli.port);\n  return {")}`);
  assert.equal(primitiveObserver.sourceOk, true, "a helper receiving a primitive member is not input-object mutation");
  assert.equal(primitiveObserver.proved, true);
});

test("keeps partial, decoy, skipped, dead, dynamic, mutable, and wrongly imported proof pending", () => {
  const partial = [
    "import assert from 'node:assert/strict';",
    "import { resolveConfig } from '../src/platform/config.js';",
    "for (const value of [false, 0, '', null]) assert.equal(resolveConfig({ debug: value }, { debug: true }, { debug: true }, { debug: true }).debug, value);",
    "assert.equal(resolveConfig({ debug: undefined }, { debug: true }, { debug: false }, { debug: false }).debug, true);"
  ].join("\n");
  const directLines = directTest().split("\n"), conditionalDirect = [...directLines.slice(0, 2), "if (1 === 2) {", ...directLines.slice(2), "}"].join("\n");
  const variants = [
    partial,
    `${partial}\n// port label false 0 null undefined; assert.equal(resolveConfig(), false);`,
    LOOP_TEST.replace("../src/platform/config.js", "../src/platform/not-config.js"),
    LOOP_TEST.replace("{ resolveConfig }", "{ otherHelper as resolveConfig }"),
    LOOP_TEST.replace("for (const key", "assert.equal = () => {};\nfor (const key"),
    LOOP_TEST.replace("for (const key", "return;\nfor (const key"),
    LOOP_TEST.replace("for (const key", "if (true) return;\nfor (const key"),
    conditionalDirect,
    directTest().replaceAll("assert.", "false && assert."),
    LOOP_TEST.replace("for (const key", "test.skip('disabled', () => {});\nfor (const key"),
    LOOP_TEST.replace("for (const key", "if (false) assert.equal(resolveConfig({}, {}, {}, {}).port, 1);\nfor (const key"),
    CONST_LOOP_TEST.replace("const keys = ['port', 'debug', 'label'];", "const keys = Object.keys({ port: 1, debug: 1, label: 1 });"),
    CONST_LOOP_TEST.replace("const falsey = [false, 0, '', null];", "const falsey = [false, 0, '', null];\nfalsey.push('decoy');")
  ];
  for (const testText of variants) {
    const result = evidence(GOOD_SOURCE, testText);
    assert.equal(result.proved, false, testText);
    assert.equal(result.testOk, false, testText);
  }
});

test("rejects unsafe selectors, inconsistent order, and input mutation", () => {
  const helperLine = "const firstDefined = (...values) => values.find((value) => value !== undefined);";
  const parameterShadow = GOOD_SOURCE
    .replace("export function resolveConfig", `${helperLine}\nexport function resolveConfig`)
    .replace(`  ${helperLine}\n`, "")
    .replace("defaults = {})", "defaults = {}, firstDefined = (...values) => values[0])");
  const reassignedSelector = GOOD_SOURCE.replace(
    "  const firstDefined = (...values) => values.find((value) => value !== undefined);",
    "  const firstDefined = (...values) => values.find((value) => value !== undefined);\n  firstDefined = (...values) => values[0];"
  );
  const variants = [
    GOOD_SOURCE.replaceAll("firstDefined", "truthy").replace("values.find((value) => value !== undefined)", "values.find(Boolean)"),
    GOOD_SOURCE.replace("values.find((value) => value !== undefined)", "values.find((value) => value ?? false)"),
    GOOD_SOURCE.replace("firstDefined(cli.port, environment.port, file.port, defaults.port)", "firstDefined(cli.port, file.port, environment.port, defaults.port)"),
    GOOD_SOURCE.replace("  return {", "  cli.port = 9999;\n  return {"),
    GOOD_SOURCE.replace("  return {", "  mutate(cli);\n  return {"),
    parameterShadow,
    reassignedSelector
  ];
  for (const source of variants) {
    const result = evidence(source);
    assert.equal(result.disposition, "applicable");
    assert.equal(result.sourceOk, false);
    assert.equal(result.proved, false);
  }
  const orSource = GOOD_SOURCE.replace("  const firstDefined = (...values) => values.find((value) => value !== undefined);\n", "")
    .replaceAll(/firstDefined\(([^)]*)\)/g, (_match, args) => args.split(", ").join(" || "));
  const nullishSource = orSource.replaceAll(" || ", " ?? ");
  for (const source of [orSource, nullishSource]) assert.equal(evidence(source).sourceOk, false);
  const conditionalReturn = GOOD_SOURCE.replace("  return {", "  if (cli.force) return { port: defaults.port, debug: defaults.debug, label: defaults.label };\n  return {");
  const asynchronous = GOOD_SOURCE.replace("export function resolveConfig", "export async function resolveConfig");
  for (const source of [conditionalReturn, asynchronous]) assert.equal(evidence(source).disposition, "abstain");
});

test("abstains on computed, spread, and unresolved wrapper source, and leaves unrelated boundaries alone", () => {
  const computed = GOOD_SOURCE.replace("    port:", "    ['port']:");
  const spread = GOOD_SOURCE.replace("  return {", "  const inherited = {};\n  return { ...inherited,");
  const wrapper = GOOD_SOURCE.replace("  const firstDefined = (...values) => values.find((value) => value !== undefined);\n", "");
  for (const source of [computed, spread, wrapper]) assert.equal(evidence(source).disposition, "abstain");
  for (const taskText of [
    "Round each invoice total to an inclusive maximum boundary.",
    "Treat an expiry equal to now as expired and verify the exact boundary."
  ]) assert.equal(evidence(GOOD_SOURCE, LOOP_TEST, taskText).disposition, "not-applicable");
});

test("source-derived guidance is emitted once, bounded, and names every key and layer", (t) => {
  const brokenSource = GOOD_SOURCE.replace("  const firstDefined = (...values) => values.find((value) => value !== undefined);\n", "")
    .replaceAll(/firstDefined\(([^)]*)\)/g, (_match, args) => args.split(", ").join(" || "));
  const cwd = writeProject(brokenSource, LOOP_TEST);
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const task = { summary: TASK_TEXT, expectedOutput: "Preserve the public export.", scope: ["src/platform/config.js", "test/**"] };
  const guidance = acceptanceBaselineGuidance(task, { cwd });
  const precedence = guidance.filter((line) => line.startsWith("Defined-fallback proof"));
  assert.equal(precedence.length, 1);
  assert.ok(precedence[0].split(/\s+/).length <= 120);
  assert.match(precedence[0], /port, debug, label/);
  assert.match(precedence[0], /cli > environment > file > defaults/);
  assert.deepEqual(acceptancePrecedenceContractGuidance({
    taskText: TASK_TEXT,
    sourceEntries: [{ path: "src/platform/config.js", text: brokenSource }]
  }), precedence);
});

test("an applicable precedence adapter cannot be overridden by generic boundary regex evidence", (t) => {
  const partial = [
    "import assert from 'node:assert/strict';",
    "import { resolveConfig } from '../src/platform/config.js';",
    "for (const value of [false, 0, '', null]) assert.equal(resolveConfig({ debug: value }, { debug: true }, { debug: true }, { debug: true }).debug, value);",
    "assert.equal(resolveConfig({ debug: undefined }, { debug: true }, { debug: false }, { debug: false }).debug, true);"
  ].join("\n");
  const cwd = writeProject(GOOD_SOURCE, partial);
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const built = buildAcceptanceReceipt({ summary: TASK_TEXT, expectedOutput: "Per-key proof.", changeMode: "source-change", source: "runtime" });
  const digest = versionWorkingTreeHash("d".repeat(64));
  const candidate = {
    summary: TASK_TEXT, expectedOutput: "Per-key proof.", acceptanceCriteria: built.acceptanceCriteria,
    acceptanceReceipt: built.receipt, changeMode: "source-change", workingTreeDigestAlgorithm: "wt-content-v2",
    changedFiles: ["src/platform/config.js", "test/config.test.js"],
    verifyCommands: ["node --test test/config.test.js"],
    verifyEvidence: [{ command: "node --test test/config.test.js", exitCode: 0, observed: true, matchedProfileCommand: true,
      recordedAt: "2026-08-29T00:00:00.000Z", preWorkingTreeDigest: digest, workingTreeDigest: digest }]
  };
  const partialReceipt = refreshAcceptanceReceipt(candidate, { cwd, changedFiles: candidate.changedFiles, currentWorkingTreeDigest: digest });
  assert.ok(partialReceipt.criticalMissing.some((criterion) => criterion.obligation === "boundary-case"));
  fs.writeFileSync(path.join(cwd, "test/config.test.js"), LOOP_TEST);
  const completeReceipt = refreshAcceptanceReceipt(candidate, { cwd, changedFiles: candidate.changedFiles, currentWorkingTreeDigest: digest });
  assert.equal(completeReceipt.criticalMissing.some((criterion) => criterion.obligation === "boundary-case"), false);
});
