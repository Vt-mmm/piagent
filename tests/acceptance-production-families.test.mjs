import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileContractSelection, parseContractFamilyLibrary } from "../packages/piagent-core/extensions/acceptance-contract-selection.js";
import { openHostContractConfiguration } from "../packages/piagent-core/extensions/acceptance-host-configuration.js";
import { runIndependentContract } from "../packages/piagent-core/extensions/acceptance-independent-contract.js";
import { runSnapshotBoundContract } from "../packages/piagent-core/extensions/acceptance-execution-snapshot.js";
import { productionFamilies } from "./helpers/production-family-catalog.mjs";
import { familyRows, familyMutants } from "./helpers/production-family-programs.mjs";

const root = path.resolve(import.meta.dirname, ".."), hash = text => createHash("sha256").update(text).digest("hex");
const libraryText = fs.readFileSync(path.join(root, "adapters/node-typescript/contract-families.json"), "utf8");
const imageId = process.env.PIAGENT_CONTRACT_EXECUTOR_IMAGE_ID, dockerSocket = process.env.PIAGENT_CONTRACT_EXECUTOR_SOCKET;
const integration = { skip: !imageId || !dockerSocket, timeout: 90000 };
const operatorRequestDigest = `operator-request-v1:${"a".repeat(64)}`;
function inputs(row) {
  const criterion = `Preserve the declared ${row.id}@${row.version} API behavior, including its documented scope.`;
  return {
    task: { operatorRequestDigest, acceptanceCriteria: [criterion], acceptanceReceipt: { criteria: [{ id: "behavior", hash: hash(criterion), obligation: "requested-behavior" }] } },
    recipe: { schemaVersion: 1, backend: { imageId: imageId ?? `sha256:${"b".repeat(64)}`, dockerSocket: dockerSocket ?? "/unavailable.sock", timeoutMs: 10000 },
      selections: [{ criterion: { text: criterion, obligation: "requested-behavior" }, family: { id: row.id, version: row.version },
        parameters: structuredClone(row.parameters), sourcePath: "src/main.js", maxAttempts: 2 }] }
  };
}
function select(row, changes) {
  const input = inputs(row); changes?.(input);
  return compileContractSelection({ libraryText, taskText: JSON.stringify(input.task), recipeText: JSON.stringify(input.recipe) });
}
async function execute(row, source, verdict) {
  const contract = select(row).plan.contracts[0];
  const result = await runIndependentContract({ imageId, dockerSocket, planText: JSON.stringify({ schemaVersion: 1, source,
    exportName: contract.exportName, checks: contract.checks }) });
  assert.equal(result.verdict, verdict, JSON.stringify({ family: row.id, result }));
  assert.equal(result.execution.cleanupConfirmed, true);
  if (verdict === "fail") assert.ok(result.counterexamples.length > 0, "a concrete behavioral mismatch is required");
  return result;
}

test("installed production families are bounded literal authoring data, with complete expansion", () => {
  const library = parseContractFamilyLibrary(libraryText);
  for (const family of productionFamilies()) {
    assert.deepEqual(library.families.find(item => item.id === family.id && item.version === family.version), family);
    const row = familyRows.find(item => item.id === family.id && item.version === family.version), preview = select(row);
    assert.equal(preview.status, "preview-only"); assert.equal(preview.completionAllowed, false);
    assert.equal(preview.selected[0].caseCount, family.template.checks[0].cases.length);
    assert.equal(preview.plan.contracts[0].exportName, row.call);
  }
});

test("four-layer configuration is explicitly versioned and cannot silently change v1 or pinned families", () => {
  const row = familyRows.find(item => item.key === "config"), current = select(row), old = select(row, input => { input.recipe.selections[0].family.version = 1; });
  assert.equal(old.plan.contracts[0].selection.familyVersion, 1);
  assert.equal(old.plan.contracts[0].checks[0].cases[0].args.length, 3);
  assert.equal(current.plan.contracts[0].checks[0].cases[0].args.length, 4);
  assert.notEqual(current.selected[0].familyDigest, old.selected[0].familyDigest);
  const drift = select(row, input => { input.recipe.selections[0].family.digest = old.selected[0].familyDigest; });
  assert.equal(drift.status, "unknown"); assert.equal(drift.plan, null);
  assert.throws(() => select(row, input => { input.recipe.selections[0].parameters.booleanKey = "port"; }), /record/);
});

for (const row of familyRows) test(`${row.id}@${row.version} accepts two equivalent APIs and rejects the unchanged public faulty fixture`, integration, async () => {
  for (const source of row.sources) await execute(row, source, "pass");
  const source = fs.readFileSync(path.join(root, "benchmarks/production-v2/project/src", row.fixture), "utf8");
  await execute(row, source, "fail");
});

for (const mutant of familyMutants()) test(`selected production family rejects ${mutant.key}/${mutant.label} with a concrete counterexample`, integration, async () => {
  await execute(familyRows.find(row => row.key === mutant.key), mutant.source, "fail");
});

test("checkpoint recovery accepts non-enumerable own data across reset but still rejects its first-failure alias", integration, async () => {
  const row = familyRows.find(item => item.key === "checkpoint");
  const source = row.sources[0].replace("error.checkpoint={nextIndex:index,results:[...results]}",
    "Object.defineProperty(error,'checkpoint',{value:{nextIndex:index,results:[...results]}})");
  assert.notEqual(source, row.sources[0]);
  await execute(row, source, "pass");
  const alias = source.replace("value:{nextIndex:index,results:[...results]}", "value:index===checkpoint.nextIndex?checkpoint:{nextIndex:index,results:[...results]}");
  assert.notEqual(alias, source); await execute(row, alias, "fail");
});

test("all six families pass through the installed preview, explicit approval, current signature and captured-source executor", integration, async context => {
  const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-production-families-")));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const project = path.join(temporary, "project"), executable = path.join(temporary, "piagent");
  fs.mkdirSync(path.join(project, "src"), { recursive: true }); fs.symlinkSync(path.join(root, "scripts/piagent-cli.mjs"), executable);
  fs.writeFileSync(path.join(project, "src/main.js"), "export const baseline=0;\n");
  for (const args of [["init", "-q"], ["config", "user.name", "Test"], ["config", "user.email", "test@example.com"],
    ["add", "src/main.js"], ["commit", "-qm", "isolated test baseline"]]) execFileSync("git", ["-C", project, ...args], { stdio: "pipe" });
  const run = args => spawnSync(process.execPath, [executable, ...args], { encoding: "utf8", timeout: 10000 });
  for (const row of familyRows) {
    const input = inputs(row), taskFile = path.join(temporary, `${row.key}-task.json`), recipeFile = path.join(temporary, `${row.key}-recipe.json`);
    const planFile = path.join(temporary, `${row.key}-plan.json`), authority = path.join(temporary, `${row.key}-authority`);
    fs.writeFileSync(taskFile, JSON.stringify(input.task)); fs.writeFileSync(recipeFile, JSON.stringify(input.recipe));
    fs.writeFileSync(path.join(project, "src/main.js"), row.sources[0]);
    const selected = run(["select-verification", "--project", project, "--task", taskFile, "--recipe", recipeFile, "--output", planFile]);
    assert.equal(selected.status, 0, selected.stderr); assert.equal(JSON.parse(selected.stdout).completionAllowed, false);
    const command = ["approve-verification", "--project", project, "--plan", planFile, "--directory", authority];
    assert.equal(run(command).status, 0); assert.equal(fs.existsSync(authority), false);
    const approved = run([...command, "--approve"]); assert.equal(approved.status, 0, approved.stderr);
    const configPath = path.join(authority, "approval.json"), configuration = openHostContractConfiguration({ projectRoot: project, installedRoot: root, configPath });
    try {
      const contract = configuration.forRequest(operatorRequestDigest).contracts[0];
      assert.deepEqual(contract.checks, select(row).plan.contracts[0].checks); assert.equal(configuration.isCurrent(), true);
      const result = await runSnapshotBoundContract({ projectRoot: project, ...contract, authorizeSourceRead: () => true, imageId, dockerSocket });
      assert.equal(result.verdict, "pass", JSON.stringify({ family: row.id, result }));
      assert.equal(configuration.isCurrent(), true); assert.ok(result.binding);
      if (row.key === "checkpoint" || row.key === "request") {
        const stored = JSON.parse(fs.readFileSync(configPath));
        stored.payload.contracts[0].checks[0].cases[0].expected.referenceIdentity[0].same = true;
        fs.writeFileSync(configPath, JSON.stringify(stored));
        assert.equal(configuration.isCurrent(), false);
        assert.throws(() => openHostContractConfiguration({ projectRoot: project, installedRoot: root, configPath }), /unauthenticated/);
      }
    } finally { configuration.close(); }
  }
});
