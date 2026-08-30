import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv from "ajv";
import { compileContractSelection, parseContractFamilyLibrary } from "../packages/piagent-core/extensions/acceptance-contract-selection.js";
import { prepareHostContractApproval, openHostContractConfiguration } from "../packages/piagent-core/extensions/acceptance-host-configuration.js";
import { compileIndependentContract, runIndependentContract } from "../packages/piagent-core/extensions/acceptance-independent-contract.js";
import { runSnapshotBoundContract } from "../packages/piagent-core/extensions/acceptance-execution-snapshot.js";
import { developmentCorpus } from "../evals/harness-next/development-corpus.mjs";

const root = path.resolve(import.meta.dirname, ".."), hash = (text) => createHash("sha256").update(text).digest("hex");
const libraryText = fs.readFileSync(path.join(root, "adapters/node-typescript/contract-families.json"), "utf8");
const imageId = process.env.PIAGENT_CONTRACT_EXECUTOR_IMAGE_ID, dockerSocket = process.env.PIAGENT_CONTRACT_EXECUTOR_SOCKET;
const integration = { skip: !imageId || !dockerSocket, timeout: 90000 };
const backend = { imageId: imageId ?? `sha256:${"b".repeat(64)}`, dockerSocket: dockerSocket ?? "/unavailable.sock", timeoutMs: 10000 };
const criterionText = "Compute the declared behavior and reject the specified invalid inputs.";
function task(texts = [criterionText, "Keep unrelated requirements separately verified."]) {
  return { operatorRequestDigest: `operator-request-v1:${"a".repeat(64)}`, acceptanceCriteria: texts,
    acceptanceReceipt: { criteria: texts.map((text, index) => ({ id: `criterion-${index}`, hash: hash(text), obligation: "requested-behavior" })) } };
}
function recipe(id = "finite-list-sum", parameters = { call: "run" }) {
  return { schemaVersion: 1, backend: structuredClone(backend), selections: [{ criterion: { text: criterionText, obligation: "requested-behavior" },
    family: { id, version: 1 }, parameters, sourcePath: "src/main.js", modulePaths: ["src/logic.js"], maxAttempts: 2 }] };
}
const select = (value = recipe(), snapshot = task(), library = libraryText) => compileContractSelection({
  libraryText: library, taskText: JSON.stringify(snapshot), recipeText: JSON.stringify(value)
});

test("families bind exact task criteria, preserve unrelated obligations and never grant completion", () => {
  const preview = select(), selected = preview.plan.contracts[0];
  assert.equal(preview.status, "preview-only"); assert.equal(preview.completionAllowed, false);
  assert.equal(selected.criterionHash, hash(criterionText));
  assert.equal(preview.unselectedCriteria.length, 1);
  assert.equal(selected.selection.familyId, "finite-list-sum");
  assert.equal(selected.selection.criterionText, criterionText);
  const compiled = compileIndependentContract(JSON.stringify({ schemaVersion: 1, source: "export const run=()=>0", exportName: selected.exportName, checks: selected.checks }));
  assert.ok(JSON.parse(compiled.requestText).cases.every((item) => !Object.hasOwn(item, "expected")));
  assert.throws(() => { selected.checks[0].cases[0].expected.value.value = 99; }, TypeError);
  assert.deepEqual(select(), preview, "selection is deterministic without reading candidate source");
});

test("missing, ambiguous, duplicate and drifted selections never produce a partial approval plan", () => {
  const cases = [
    [(r) => { r.selections[0].criterion.text += " different"; }, task(), "criterion-not-found"],
    [(r) => { r.selections[0].criterion.obligation = "verification-evidence"; }, task(), "criterion-not-found"],
    [() => {}, task([criterionText, criterionText]), "criterion-ambiguous"],
    [(r) => { r.selections.push(structuredClone(r.selections[0])); }, task(), "criterion-selected-twice"],
    [(r) => { r.selections[0].family.version = 2; }, task(), "family-not-found"],
    [(r) => { r.selections[0].family.digest = "0".repeat(64); }, task(), "family-drift"]
  ];
  for (const [mutate, snapshot, reason] of cases) {
    const r = recipe(); mutate(r); const result = select(r, snapshot);
    assert.equal(result.status, "unknown"); assert.equal(result.plan, null); assert.equal(result.completionAllowed, false);
    assert.ok(result.issues.some((issue) => issue.reason === reason));
  }
  const snapshot = task(); snapshot.acceptanceCriteria[0] += " forged";
  assert.throws(() => select(recipe(), snapshot), /Unbound/);
});

test("library templates and parameter substitution reject executable, malformed or unbounded data", () => {
  const family = JSON.parse(libraryText).families[0];
  for (const mutate of [
    (lib) => { lib.families.push(structuredClone(lib.families[0])); },
    (lib) => { lib.families[0].template.source = "export const forged=1"; },
    (lib) => { lib.families[0].template.exportName = { $parameter: "missing" }; },
    (lib) => { lib.families[0].parameters.unused = "string"; },
    (lib) => { lib.families[0].template.exportName.extra = "ignored"; },
    (lib) => { lib.families[0].id = 12; }
  ]) {
    const lib = { schemaVersion: 1, families: [structuredClone(family)] }; mutate(lib);
    assert.throws(() => parseContractFamilyLibrary(JSON.stringify(lib)));
  }
  for (const mutate of [
    (r) => { r.selections[0].parameters.call = "run();process.exit()"; },
    (r) => { r.selections[0].parameters.source = "unused"; },
    (r) => { r.selections[0].modulePaths = null; },
    (r) => { r.selections[0].sourcePath = "../other.js"; },
    (r) => { r.selections[0].maxAttempts = 9; },
    (r) => { r.backend.imageId = "worker:latest"; }
  ]) { const r = recipe(); mutate(r); assert.throws(() => select(r)); }
  const r = recipe("defined-config-precedence", { call: "choose", numericKey: "__proto__", booleanKey: "active", textKey: "caption" });
  const compiled = select(r).plan.contracts[0];
  assert.equal(compiled.exportName, "choose");
  assert.equal(compiled.checks[0].cases[0].expected.value.value[0].key, "__proto__");
  r.selections[0].parameters.booleanKey = "__proto__";
  assert.throws(() => select(r), /record/);
});

test("published recipe/library/approval schemas and authenticated metadata agree", () => {
  const ajv = new Ajv({ allErrors: true, strict: false });
  for (const name of ["approved-host-contracts", "contract-selection-recipe", "contract-family-library"]) {
    ajv.addSchema(JSON.parse(fs.readFileSync(path.join(root, `schemas/${name}.schema.json`))));
  }
  assert.equal(ajv.validate("https://piagent.dev/schemas/contract-family-library.schema.json", JSON.parse(libraryText)), true, JSON.stringify(ajv.errors));
  assert.equal(ajv.validate("https://piagent.dev/schemas/contract-selection-recipe.schema.json", recipe()), true, JSON.stringify(ajv.errors));
  const preview = select(), payload = prepareHostContractApproval({ projectRoot: root, installedRoot: root, ...preview.plan });
  assert.equal(ajv.validate("https://piagent.dev/schemas/approved-host-contracts.schema.json", payload), true, JSON.stringify(ajv.errors));
  const changed = structuredClone(preview.plan); changed.contracts[0].selection.criterionText += " stale";
  assert.throws(() => prepareHostContractApproval({ projectRoot: root, installedRoot: root, ...changed }), /bind the criterion/);
});

test("typed value bindings remain literal data instead of becoming nested template instructions", () => {
  const literal = { type: "record", value: [{ key: "$parameter", value: { type: "string", value: "call" } }] };
  const library = { schemaVersion: 1, families: [{ id: "literal-identity", version: 1, domain: "pure-function", description: "Return the supplied bounded value.",
    parameters: { call: "export", argument: "value" }, template: { exportName: { $parameter: "call" }, checks: [{ id: "identity", cases: [{ id: "literal",
      args: [{ $parameter: "argument" }], expected: { outcome: "return", value: { $parameter: "argument" } } }] }] } }] };
  const selected = select(recipe("literal-identity", { call: "identity", argument: literal }), task(), JSON.stringify(library));
  assert.deepEqual(selected.plan.contracts[0].checks[0].cases[0].args, [literal]);
  assert.deepEqual(selected.plan.contracts[0].checks[0].cases[0].expected.value, literal);
  assert.throws(() => select(recipe("literal-identity", { call: "identity", argument: { type: "code", value: "process.exit()" } }), task(), JSON.stringify(library)));
});

function directory(context) {
  const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-contract-selection-")));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true })); return temporary;
}

test("installed command previews without writes, emits a new plan and requires separate explicit approval", (context) => {
  const temporary = directory(context), project = path.join(temporary, "project"); fs.mkdirSync(project);
  const executable = path.join(temporary, "piagent"), taskFile = path.join(temporary, "task.json"), recipeFile = path.join(temporary, "recipe.json");
  fs.symlinkSync(path.join(root, "scripts/piagent-cli.mjs"), executable);
  fs.writeFileSync(taskFile, JSON.stringify(task())); fs.writeFileSync(recipeFile, JSON.stringify(recipe()));
  const command = [executable, "select-verification", "--project", project, "--task", taskFile, "--recipe", recipeFile];
  const run = (args) => spawnSync(process.execPath, args, { encoding: "utf8", timeout: 10000 });
  const before = fs.readdirSync(temporary), preview = run(command);
  assert.equal(preview.status, 0, preview.stderr); assert.equal(JSON.parse(preview.stdout).completionAllowed, false);
  assert.deepEqual(fs.readdirSync(temporary), before);
  const output = path.join(temporary, "plan.json"), result = run([...command, "--output", output]);
  assert.equal(result.status, 0, result.stderr); assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  const bytes = fs.readFileSync(output); assert.notEqual(run([...command, "--output", output]).status, 0);
  assert.deepEqual(fs.readFileSync(output), bytes);
  assert.notEqual(run([...command, "--approve"]).status, 0);
  const authority = path.join(temporary, "authority"), approval = [executable, "approve-verification", "--project", project, "--plan", output, "--directory", authority];
  assert.equal(run(approval).status, 0); assert.equal(fs.existsSync(authority), false);
  const approved = run([...approval, "--approve"]); assert.equal(approved.status, 0, approved.stderr);
  const configuration = openHostContractConfiguration({ projectRoot: project, installedRoot: root, configPath: path.join(authority, "approval.json") });
  try { assert.equal(configuration.payload.contracts[0].selection.familyId, "finite-list-sum"); assert.equal(configuration.isCurrent(), true); }
  finally { configuration.close(); }
  const wrong = recipe(); wrong.selections[0].family.id = "absent"; fs.writeFileSync(recipeFile, JSON.stringify(wrong));
  const unavailable = path.join(temporary, "unknown.json"), unknown = run([...command, "--output", unavailable]);
  assert.equal(unknown.status, 2, unknown.stderr); assert.equal(fs.existsSync(unavailable), false);
  assert.equal(JSON.parse(unknown.stdout).plan, null);
});

test("selected families execute against the 21 labelled development variants without reading their outputs as expectations", integration, async () => {
  const families = {
    "pure-function": ["finite-list-sum", { call: "run" }],
    "temporal-input": ["deadline-status", { call: "run" }],
    "configuration-precedence": ["defined-config-precedence", { call: "run", numericKey: "limit", booleanKey: "enabled", textKey: "label" }],
    "stateful-recovery": ["idempotent-accumulator-checkpoint", { apply: "apply", snapshot: "snapshot", restore: "restore", read: "read" }]
  };
  const corpus = developmentCorpus(); assert.equal(corpus.heldOut, false); assert.equal(corpus.claimEligible, false);
  for (const row of corpus.rows) {
    const [id, parameters] = families[row.domain], selected = select(recipe(id, parameters)).plan.contracts[0];
    const result = await runIndependentContract({ imageId, dockerSocket, planText: JSON.stringify({ schemaVersion: 1,
      source: row.plan.source, exportName: selected.exportName, checks: selected.checks }) });
    assert.equal(result.verdict, row.expectedVerdict, JSON.stringify({ id: row.id, result }));
    assert.equal(result.execution.cleanupConfirmed, true);
    if (row.expectedVerdict === "fail") assert.ok(result.counterexamples.length > 0);
  }
});

test("one selected family runs the existing five-file production redactor without rewriting or inlining source", integration, async () => {
  const r = recipe("secret-redaction-literals", { text: "redactSensitiveText", storage: "redactForStorage", source: "redactSensitiveProjectFileText" });
  const prefix = "packages/piagent-core/security/"; r.selections[0].sourcePath = prefix + "sensitive-data.js";
  r.selections[0].modulePaths = ["sensitive-text.js", "sensitive-project-file.js", "sensitive-source-formats.js", "sensitive-source-expression.js"].map((file) => prefix + file);
  const contract = select(r).plan.contracts[0];
  const result = await runSnapshotBoundContract({ projectRoot: root, ...contract, authorizeSourceRead: () => true, imageId, dockerSocket });
  assert.equal(result.verdict, "pass", JSON.stringify(result));
  assert.equal(result.binding.moduleFiles.length, 5);
});

test("review mutation: finite-list contracts reject negative infinity, not only positive infinity", integration, async () => {
  const contract = select(recipe()).plan.contracts[0];
  const source = "export function run(xs){let total=0;for(const x of xs){if(typeof x!=='number'||Number.isNaN(x)||x===Infinity)throw new TypeError();total+=x;}return total}";
  const result = await runIndependentContract({ imageId, dockerSocket, planText: JSON.stringify({ schemaVersion: 1,
    source, exportName: contract.exportName, checks: contract.checks }) });
  assert.equal(result.verdict, "fail", JSON.stringify(result));
  assert.ok(result.counterexamples.length > 0);
});

test("review mutation: checkpoint contracts reject sorted serialization and changed-payload replay", integration, async () => {
  const contract = select(recipe("idempotent-accumulator-checkpoint", { apply: "apply", snapshot: "snapshot", restore: "restore", read: "read" })).plan.contracts[0];
  const original = developmentCorpus().rows.find((row) => row.id === "stateful-recovery:indexed").plan.source;
  for (const source of [original.replace("entries:[...entries]", "entries:[...entries].sort()"),
    original.replace("if(!entries.has(id))", "if(!entries.has(id)||entries.get(id)!==delta)")]) {
    const result = await runIndependentContract({ imageId, dockerSocket, planText: JSON.stringify({ schemaVersion: 1,
      source, exportName: contract.exportName, checks: contract.checks }) });
    assert.equal(result.verdict, "fail", JSON.stringify(result));
    assert.ok(result.counterexamples.length > 0);
  }
});
