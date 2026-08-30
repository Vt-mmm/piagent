import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateHostContractPayload, validateHostContractPlan } from "../packages/piagent-core/extensions/acceptance-host-configuration.js";
import { compileContractSelection, parseContractFamilyLibrary, parseContractSelectionRecipe } from "../packages/piagent-core/extensions/acceptance-contract-selection.js";
import { createHelperRequest, defaultRolePolicy, HELPER_ROLES, validateHelperRequest } from "../packages/piagent-core/runtime/orchestration/role-policy.ts";
import { createRootSchemaRegistry } from "./helpers/root-schema-registry.mjs";

const root = path.resolve(import.meta.dirname, ".."), schemas = createRootSchemaRegistry(root);
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures", `${name}.valid.json`), "utf8"));
const parsers = {
  "approved-host-contracts": validateHostContractPayload,
  "host-contract-plan": validateHostContractPlan,
  "contract-family-library": (value) => parseContractFamilyLibrary(JSON.stringify(value)),
  "contract-selection-recipe": (value) => parseContractSelectionRecipe(JSON.stringify(value))
};

test("published helper v2 accepts actual producer output for every supported role", () => {
  const validate = schemas.get("helper-request");
  for (const role of HELPER_ROLES) {
    const policy = defaultRolePolicy(role, ["src/**"]);
    const request = createHelperRequest({ policy, objective: "Inspect the declared source scope.", taskId: "task-1", taskRunId: "task-1-run-1",
      sessionId: "fixture-only", parentReadScope: ["src/**"], parentWriteScope: [], parentAllowedTools: policy.allowedTools,
      singleWriterOwnership: role === "worker" ? "writer-lease-1" : null });
    assert.equal(validate(request), true, JSON.stringify(validate.errors));
    assert.equal(validateHelperRequest(request), request);
  }
});

test("helper schema and runtime both refuse legacy or unbounded history transfer", () => {
  for (const mutate of [
    (v) => { v.schemaVersion = 1; },
    (v) => { delete v.contextTransfer; },
    (v) => { v.contextTransfer.inheritParentHistory = true; },
    (v) => { v.contextTransfer.maxSeedTokens = 2049; },
    (v) => { v.contextTransfer.maxSeedTokens = 255; },
    (v) => { v.contextTransfer.history = []; }
  ]) {
    const value = fixture("helper-request"); mutate(value);
    assert.equal(schemas.get("helper-request")(value), false);
    assert.throws(() => validateHelperRequest(value));
  }
  const forged = fixture("helper-request"); forged.contextTransfer.estimatedSeedTokens += 1;
  assert.equal(schemas.get("helper-request")(forged), true, "relational checks remain runtime obligations");
  assert.throws(() => validateHelperRequest(forged), /isolated and minimal/);
});

test("new document parsers refuse malformed nested data independently of family/task lookup", () => {
  const cases = [
    ["approved-host-contracts", (v) => { v.backend.timeoutMs = 24; }],
    ["host-contract-plan", (v) => { v.backend.imageId = "worker:latest"; }],
    ["host-contract-plan", (v) => { v.contracts[0].sourcePath = "../outside.js"; }],
    ["contract-family-library", (v) => { v.families[0].parameters = {}; v.families[0].template = { exportName: "identity", checks: [] }; }],
    ["contract-family-library", (v) => { v.families[0].parameters = {}; v.families[0].template = { exportName: 42, checks: [{}] }; }],
    ["contract-family-library", (v) => { v.families[0].template.checks = [null]; }],
    ["contract-selection-recipe", (v) => { v.selections[0].family.id = "unknown-family"; v.selections[0].parameters = []; }],
    ["contract-selection-recipe", (v) => { v.selections[0].parameters = Object.fromEntries(Array.from({ length: 33 }, (_, n) => [`p${n}`, n])); }]
  ];
  for (const [name, mutate] of cases) {
    const value = fixture(name); mutate(value);
    assert.equal(schemas.get(name)(value), false, name);
    assert.throws(() => parsers[name](value), undefined, name);
  }
});

test("valid-looking host contracts still require uniqueness and the aggregate case budget", () => {
  for (const name of ["approved-host-contracts", "host-contract-plan"]) {
    const duplicate = fixture(name); duplicate.contracts.push(structuredClone(duplicate.contracts[0]));
    assert.equal(schemas.get(name)(duplicate), true);
    assert.throws(() => parsers[name](duplicate), /criterion contract/);
    const oversized = fixture(name), contract = oversized.contracts[0], one = contract.checks[0].cases[0];
    contract.checks = ["first", "second"].map((id) => ({ id, cases: Array.from({ length: 129 }, (_, n) => ({ ...one, id: `case-${n}` })) }));
    assert.equal(schemas.get(name)(oversized), true);
    assert.throws(() => parsers[name](oversized), /case|limit/i);
  }
});

test("an unknown but well-formed recipe remains non-authoritative and produces no partial plan", () => {
  const recipe = fixture("contract-selection-recipe"); recipe.selections[0].family.id = "unknown-family";
  assert.doesNotThrow(() => parsers["contract-selection-recipe"](recipe));
  const result = compileContractSelection({ libraryText: JSON.stringify(fixture("contract-family-library")), recipeText: JSON.stringify(recipe),
    taskText: JSON.stringify({ operatorRequestDigest: fixture("host-contract-plan").operatorRequestDigest,
      acceptanceCriteria: [recipe.selections[0].criterion.text], acceptanceReceipt: { criteria: [{ id: "identity-contract",
        hash: createHash("sha256").update(recipe.selections[0].criterion.text).digest("hex"), obligation: "requested-behavior" }] } }) });
  assert.equal(result.status, "unknown"); assert.equal(result.plan, null); assert.equal(result.completionAllowed, false);
});

test("operator CLI refuses a malformed plan before creating an authority directory", (context) => {
  const temporary = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-schema-parity-")));
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const project = path.join(temporary, "project"), planPath = path.join(temporary, "plan.json"), authority = path.join(temporary, "authority");
  fs.mkdirSync(project);
  const plan = fixture("host-contract-plan"); plan.contracts[0].maxAttempts = 9; fs.writeFileSync(planPath, JSON.stringify(plan));
  for (const confirmation of [[], ["--approve"]]) {
    const result = spawnSync(process.execPath, [path.join(root, "scripts/approve-independent-verification.mjs"), "--project", project,
      "--plan", planPath, "--directory", authority, ...confirmation], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 1, result.stderr); assert.match(result.stderr, /Invalid approved criterion contract/);
    assert.equal(fs.existsSync(authority), false);
  }
});
