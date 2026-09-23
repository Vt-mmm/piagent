import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv from "ajv";
import { HOST_CONTRACT_SET_VERSION, NODE_HOST_CONTRACT_CONFIGURATION_VERSION, NODE_HOST_CONTRACT_SET_VERSION, installedContractVerifierDigest, openHostContractConfiguration, prepareHostContractApproval, validateHostContractPlan, writeHostContractApproval } from "../packages/piagent-core/extensions/acceptance-host-configuration.js";
import { expectedNodeProfile } from "../packages/piagent-core/extensions/acceptance-executor/node-profile.mjs";
import { discoverRuntimeIntegrityFiles } from "../packages/piagent-core/capabilities/runtime-integrity.js";
import { checkpointCases } from "./helpers/async-production-cases.mjs";
import { BENCHMARK_VERIFICATION_PLAN_VERSION, NODE_BENCHMARK_VERIFICATION_PLAN_VERSION,
  validateBenchmarkVerificationPlan } from "../scripts/benchmark-independent-verification.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

test("signed host approval preserves async observations and revokes modified callback plans", t => {
  const f = fixture(t); f.options.contracts[0].exportName = "resumeWork";
  f.options.contracts[0].checks = [{ id: "checkpoint", cases: checkpointCases() }];
  const preview = prepareHostContractApproval(f.options);
  assert.deepEqual(preview.contracts[0].checks, f.options.contracts[0].checks);
  const schema = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "schemas/approved-host-contracts.schema.json")));
  const ajv = new Ajv({ allErrors: true, strict: false });
  assert.equal(ajv.validate(schema, preview), true, JSON.stringify(ajv.errors));
  writeHostContractApproval(f.options); const configuration = f.open();
  const selected = configuration.forRequest(f.options.operatorRequestDigest);
  assert.equal(selected.contracts[0].checks[0].cases[1].args[1].type, "error-property");
  assert.ok(Object.isFrozen(selected.contracts[0].checks[0].cases[0].callbacks[0].steps));
  const stored = JSON.parse(fs.readFileSync(f.configPath));
  stored.payload.contracts[0].checks[0].cases[0].callbacks[0].settleAfterJobs = 2;
  fs.writeFileSync(f.configPath, JSON.stringify(stored));
  assert.equal(configuration.isCurrent(), false); assert.throws(() => f.open(), /unauthenticated/);
});

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-host-approval-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, "project"), installedRoot = path.join(root, "installed"), directory = path.join(root, "authority");
  fs.mkdirSync(projectRoot); fs.mkdirSync(installedRoot);
  fs.writeFileSync(path.join(installedRoot, "package.json"), "{}");
  for (const file of ["extensions/acceptance-authenticated-admission.js", "extensions/acceptance-durable-execution.js",
    "extensions/acceptance-host-configuration.js", "runtime/entry.ts"]) {
    const target = path.join(installedRoot, "packages/piagent-core", file);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, "export const fixture = 1;\n");
  }
  const options = { directory, projectRoot, installedRoot, approved: true, operatorRequestDigest: `operator-request-v1:${"a".repeat(64)}`,
    backend: { imageId: `sha256:${"b".repeat(64)}`, dockerSocket: "/host/docker.sock", timeoutMs: 10000 },
    contracts: [{ criterionId: "sum", criterionHash: "c".repeat(64), sourcePath: "src/sum.js", exportName: "sum", maxAttempts: 2,
      checks: [{ id: "sum", cases: [{ id: "one", args: [{ type: "number", value: 1 }, { type: "number", value: 2 }],
        expected: { outcome: "return", value: { type: "number", value: 3 } } }] }] }] };
  const configPath = path.join(directory, "approval.json"), keyPath = path.join(directory, "authority.key");
  const opened = [];
  t.after(() => { for (const config of opened) config.close(); });
  const open = (overrides = {}) => { const config = openHostContractConfiguration({ configPath, projectRoot, installedRoot, ...overrides }); opened.push(config); return config; };
  return { root, options, directory, projectRoot, installedRoot, configPath, keyPath, open };
}

function requestSet(options) {
  const { operatorRequestDigest, backend, contracts, ...host } = options;
  const first = { schemaVersion: 1, operatorRequestDigest, backend, contracts };
  const second = structuredClone(first);
  second.operatorRequestDigest = `operator-request-v1:${"d".repeat(64)}`;
  // The same criterion ID on another request is not the same authority.
  second.contracts[0].criterionHash = "e".repeat(64);
  second.contracts[0].checks[0].cases[0].expected.value.value = 4;
  return { ...host, plans: [first, second] };
}

function nodePlan(options, request = options.operatorRequestDigest) {
  const contracts = structuredClone(options.contracts);
  for (const contract of contracts) {
    contract.route = "code";
    for (const check of contract.checks) for (const item of check.cases) item.invocation = { kind: "call" };
  }
  return { schemaVersion: 3, operatorRequestDigest: request,
    backend: { ...options.backend, profile: expectedNodeProfile() }, contracts };
}

test("host plans 3/4 and approvals v2 bind the exact Node profile while legacy 1/2 remain distinct", t => {
  const f = fixture(t), first = nodePlan(f.options), second = nodePlan(f.options, `operator-request-v1:${"d".repeat(64)}`);
  second.contracts[0].criterionHash = "e".repeat(64);
  assert.equal(validateHostContractPlan(first), first);
  assert.equal(validateHostContractPlan({ schemaVersion: 4, plans: [first, second] }).plans.length, 2);
  const single = prepareHostContractApproval({ ...f.options, backend: first.backend, contracts: first.contracts });
  assert.equal(single.version, NODE_HOST_CONTRACT_CONFIGURATION_VERSION);
  const set = prepareHostContractApproval({ ...requestSet(f.options), plans: [first, second] });
  assert.equal(set.version, NODE_HOST_CONTRACT_SET_VERSION);
  const ajv = new Ajv({ allErrors: true, strict: false });
  const approvalSchema = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "schemas/approved-host-contracts.schema.json")));
  ajv.addSchema(approvalSchema);
  const planSchema = ajv.compile(JSON.parse(fs.readFileSync(path.join(repositoryRoot, "schemas/host-contract-plan.schema.json"))));
  assert.equal(planSchema(first), true, JSON.stringify(planSchema.errors));
  assert.equal(planSchema({ schemaVersion: 4, plans: [first, second] }), true, JSON.stringify(planSchema.errors));
  assert.equal(ajv.validate(approvalSchema.$id, single), true, JSON.stringify(ajv.errors));
  assert.equal(ajv.validate(approvalSchema.$id, set), true, JSON.stringify(ajv.errors));
  writeHostContractApproval({ ...requestSet(f.options), plans: [first, second] });
  const config = f.open();
  assert.deepEqual(config.forRequest(first.operatorRequestDigest).backend.profile, expectedNodeProfile());
  for (const mutate of [value => { value.backend.harness = "legacy"; }, value => { value.backend.profile.digest = "0".repeat(64); },
    value => { delete value.contracts[0].route; }, value => { value.contracts[0].route = "composite"; },
    value => { delete value.contracts[0].checks[0].cases[0].invocation; }]) {
    const invalid = structuredClone(first); mutate(invalid); assert.throws(() => validateHostContractPlan(invalid));
  }
  assert.throws(() => validateHostContractPlan({ schemaVersion: 4, plans: [first, { ...second, schemaVersion: 1 }] }));
});

test("Node host plans bind an exact optional Docker command while legacy plans reject it", t => {
  const f = fixture(t), plan = nodePlan(f.options), dockerCommand = {
    path: "/Applications/Docker.app/Contents/Resources/bin/docker", sha256: "f".repeat(64)
  };
  plan.backend = { imageId: plan.backend.imageId, dockerSocket: plan.backend.dockerSocket,
    dockerCommand, timeoutMs: plan.backend.timeoutMs, profile: plan.backend.profile };
  assert.equal(validateHostContractPlan(plan), plan);
  const ajv = new Ajv({ allErrors: true, strict: false });
  ajv.addSchema(JSON.parse(fs.readFileSync(path.join(repositoryRoot, "schemas/approved-host-contracts.schema.json"))));
  const validate = ajv.compile(JSON.parse(fs.readFileSync(path.join(repositoryRoot, "schemas/host-contract-plan.schema.json"))));
  assert.equal(validate(plan), true, JSON.stringify(validate.errors));
  for (const mutate of [
    value => { value.backend.dockerCommand = { sha256: dockerCommand.sha256, path: dockerCommand.path }; },
    value => { value.backend.dockerCommand.path = "docker"; },
    value => { value.backend.dockerCommand.path += "/../docker"; },
    value => { value.backend.dockerCommand.sha256 = "F".repeat(64); },
    value => { value.backend.dockerCommand.extra = true; }
  ]) {
    const invalid = structuredClone(plan); mutate(invalid); assert.throws(() => validateHostContractPlan(invalid));
  }
  const legacy = structuredClone(f.options); legacy.backend.dockerCommand = dockerCommand;
  assert.throws(() => validateHostContractPlan({ schemaVersion: 1, operatorRequestDigest: legacy.operatorRequestDigest,
    backend: legacy.backend, contracts: legacy.contracts }));
});

test("benchmark catalogs version host plan sets symmetrically for legacy and Node profile execution", t => {
  const f = fixture(t), legacy = requestSet(f.options).plans[0], node = nodePlan(f.options);
  const base = { suiteDigest: "d".repeat(64), verifierDigest: "e".repeat(64) };
  const v1 = { schemaVersion: 1, kind: BENCHMARK_VERIFICATION_PLAN_VERSION, ...base,
    scenarios: [{ scenarioId: "legacy", plans: [legacy] }] };
  const v2 = { schemaVersion: 2, kind: NODE_BENCHMARK_VERIFICATION_PLAN_VERSION, ...base,
    scenarios: [{ scenarioId: "node", plans: [node] }] };
  assert.equal(validateBenchmarkVerificationPlan(v1), v1);
  assert.equal(validateBenchmarkVerificationPlan(v2), v2);
  for (const invalid of [{ ...structuredClone(v2), kind: BENCHMARK_VERIFICATION_PLAN_VERSION },
    { ...structuredClone(v2), scenarios: [{ scenarioId: "node", plans: [legacy] }] },
    { ...structuredClone(v1), scenarios: [{ scenarioId: "legacy", plans: [node] }] }]) {
    assert.throws(() => validateBenchmarkVerificationPlan(invalid));
  }
  const ajv = new Ajv({ allErrors: true, strict: false });
  ajv.addSchema(JSON.parse(fs.readFileSync(path.join(repositoryRoot, "schemas/approved-host-contracts.schema.json"))));
  const validate = ajv.compile(JSON.parse(fs.readFileSync(path.join(repositoryRoot, "schemas/benchmark-independent-verification-plan.schema.json"))));
  assert.equal(validate(v1), true, JSON.stringify(validate.errors));
  assert.equal(validate(v2), true, JSON.stringify(validate.errors));
});

test("a host-owned request set selects only exact requests with isolated immutable contracts", (t) => {
  const f = fixture(t), options = requestSet(f.options);
  const preview = prepareHostContractApproval(options);
  assert.equal(preview.version, HOST_CONTRACT_SET_VERSION);
  assert.equal(fs.existsSync(f.directory), false);
  writeHostContractApproval(options);
  const config = f.open();
  for (const plan of options.plans) {
    const selected = config.forRequest(plan.operatorRequestDigest);
    assert.equal(selected.projectId, preview.projectId);
    assert.equal(selected.verifierDigest, preview.verifierDigest);
    assert.deepEqual(selected.contracts, plan.contracts);
    assert.deepEqual(selected.backend, plan.backend);
    assert.throws(() => { selected.contracts[0].maxAttempts = 8; }, TypeError);
  }
  for (const request of [undefined, null, "", "a".repeat(64), `operator-request-v1:${"f".repeat(64)}`]) {
    assert.equal(config.forRequest(request), null, "unapproved requests never borrow the first plan");
  }
  options.plans[0].contracts[0].maxAttempts = 8;
  assert.equal(config.forRequest(options.plans[0].operatorRequestDigest).contracts[0].maxAttempts, 2);
  assert.equal(config.isCurrent(), true);
});

test("legacy single-request authority uses the same exact selector without changing its payload", (t) => {
  const f = fixture(t); writeHostContractApproval(f.options); const config = f.open();
  assert.equal(config.forRequest(f.options.operatorRequestDigest), config.payload);
  assert.equal(config.forRequest(`operator-request-v1:${"d".repeat(64)}`), null);
});

for (const [name, mutate] of [
  ["empty sets", (o) => { o.plans = []; }],
  ["oversized sets", (o) => { o.plans = Array.from({ length: 33 }, (_, n) => ({ ...o.plans[0], operatorRequestDigest: `operator-request-v1:${n.toString(16).padStart(64, "0")}` })); }],
  ["duplicate requests", (o) => { o.plans[1].operatorRequestDigest = o.plans[0].operatorRequestDigest; }],
  ["nested sets", (o) => { o.plans = [{ schemaVersion: 2, plans: o.plans }]; }],
  ["mixed single and set authority", (o) => { o.operatorRequestDigest = o.plans[0].operatorRequestDigest; }],
  ["unknown request fields", (o) => { o.plans[0].modelApproved = true; }],
  ["an invalid later request", (o) => { o.plans[1].contracts[0].sourcePath = "../outside.js"; }]
]) test(`host request sets reject ${name} atomically before creating authority`, (t) => {
  const f = fixture(t), options = requestSet(f.options); mutate(options);
  assert.throws(() => writeHostContractApproval(options));
  assert.equal(fs.existsSync(f.directory), false);
});

test("changing any approved request invalidates the entire signed set", (t) => {
  const f = fixture(t), options = requestSet(f.options); writeHostContractApproval(options);
  const config = f.open(), doc = JSON.parse(fs.readFileSync(f.configPath));
  doc.payload.plans[1].contracts[0].maxAttempts = 3;
  fs.writeFileSync(f.configPath, JSON.stringify(doc));
  assert.equal(config.isCurrent(), false);
  assert.throws(() => f.open(), /unauthenticated/);
});

test("schema v2 sets match runtime validation without allowing nested or mixed plans", (t) => {
  const f = fixture(t), options = requestSet(f.options), payload = prepareHostContractApproval(options);
  const ajv = new Ajv({ allErrors: true, strict: false });
  const approval = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "schemas/approved-host-contracts.schema.json")));
  ajv.addSchema(approval);
  const validate = ajv.compile(JSON.parse(fs.readFileSync(path.join(repositoryRoot, "schemas/host-contract-plan.schema.json"))));
  const plan = { schemaVersion: 2, plans: options.plans };
  assert.equal(validate(plan), true, JSON.stringify(validate.errors));
  assert.equal(validateHostContractPlan(plan), plan);
  assert.equal(ajv.validate(approval.$id, payload), true, JSON.stringify(ajv.errors));
  for (const bad of [{ ...plan, contracts: [] }, { schemaVersion: 2, plans: [plan] }, { schemaVersion: 2, plans: [] }]) {
    assert.equal(validate(bad), false);
    assert.throws(() => validateHostContractPlan(bad));
  }
  const duplicate = { schemaVersion: 2, plans: [options.plans[0], options.plans[0]] };
  assert.equal(validate(duplicate), true, "request uniqueness is a semantic runtime check");
  assert.throws(() => validateHostContractPlan(duplicate), /Ambiguous/);
});

test("operator CLI previews a request set and requires separate explicit approval before writing", (t) => {
  const f = fixture(t), options = requestSet(f.options), planPath = path.join(f.root, "plan.json");
  fs.writeFileSync(planPath, JSON.stringify({ schemaVersion: 2, plans: options.plans }), { mode: 0o600 });
  const command = [path.join(repositoryRoot, "scripts/approve-independent-verification.mjs"), "--project", f.projectRoot,
    "--plan", planPath, "--directory", f.directory];
  const run = (extra = []) => spawnSync(process.execPath, [...command, ...extra], { encoding: "utf8", timeout: 15000 });
  const preview = run(); assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).payload.version, HOST_CONTRACT_SET_VERSION);
  assert.equal(fs.existsSync(f.directory), false);
  const approved = run(["--approve"]); assert.equal(approved.status, 0, approved.stderr);
  const config = f.open({ installedRoot: repositoryRoot });
  assert.equal(config.forRequest(options.plans[1].operatorRequestDigest).contracts[0].criterionHash, "e".repeat(64));
});

test("host approval is explicit, private, immutable to callers, and never overwrites authority", (t) => {
  const f = fixture(t);
  assert.throws(() => writeHostContractApproval({ ...f.options, approved: false }), /Explicit/);
  assert.equal(fs.existsSync(f.directory), false);
  const saved = writeHostContractApproval(f.options), config = f.open();
  assert.equal(saved.verifierDigest, installedContractVerifierDigest(f.installedRoot));
  assert.equal(config.isCurrent(), true);
  assert.equal(fs.statSync(f.directory).mode & 0o777, 0o700);
  for (const file of [f.configPath, f.keyPath]) assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => { config.payload.contracts[0].checks[0].cases[0].expected.value.value = 999; }, TypeError);
  const previous = fs.readFileSync(f.configPath);
  assert.throws(() => writeHostContractApproval(f.options), /EEXIST/);
  assert.deepEqual(fs.readFileSync(f.configPath), previous);
});

for (const [name, mutate] of [
  ["unknown payload fields", (o) => { o.contracts[0].modelApproved = true; }],
  ["duplicate criteria", (o) => { o.contracts.push(structuredClone(o.contracts[0])); }],
  ["unbound request", (o) => { o.operatorRequestDigest = "a".repeat(64); }],
  ["mutable image tag", (o) => { o.backend.imageId = "worker:latest"; }],
  ["unbounded attempts", (o) => { o.contracts[0].maxAttempts = 9; }],
  ["parent traversal", (o) => { o.contracts[0].sourcePath = "../source.js"; }],
  ["protected runtime source", (o) => { o.contracts[0].sourcePath = ".pi/receipt.js"; }],
  ["missing expected result", (o) => { delete o.contracts[0].checks[0].cases[0].expected; }]
]) test(`host approval rejects ${name} before creating authority`, (t) => {
  const f = fixture(t), options = structuredClone(f.options); mutate(options);
  assert.throws(() => writeHostContractApproval(options));
  assert.equal(fs.existsSync(f.directory), false);
});

test("authority cannot be placed in the project or through a noncanonical parent", (t) => {
  const f = fixture(t);
  assert.throws(() => writeHostContractApproval({ ...f.options, directory: path.join(f.projectRoot, "authority") }), /outside/);
  const alias = path.join(f.root, "alias"); fs.symlinkSync(f.root, alias);
  assert.throws(() => writeHostContractApproval({ ...f.options, directory: path.join(alias, "authority") }), /canonical/);
});

for (const [name, mutate] of [
  ["changed approval", (f) => { const doc = JSON.parse(fs.readFileSync(f.configPath)); doc.payload.contracts[0].maxAttempts = 8; fs.writeFileSync(f.configPath, JSON.stringify(doc)); }],
  ["missing key", (f) => fs.renameSync(f.keyPath, `${f.keyPath}.retained`)],
  ["replaced key", (f) => fs.writeFileSync(f.keyPath, Buffer.alloc(32, 42))],
  ["public directory", (f) => fs.chmodSync(f.directory, 0o755)],
  ["public approval", (f) => fs.chmodSync(f.configPath, 0o644)],
  ["public key", (f) => fs.chmodSync(f.keyPath, 0o644)],
  ["hard-linked approval", (f) => fs.linkSync(f.configPath, path.join(f.root, "approval-copy"))],
  ["symlinked key", (f) => { fs.renameSync(f.keyPath, `${f.keyPath}.retained`); fs.symlinkSync(`${f.keyPath}.retained`, f.keyPath); }],
  ["changed installed verifier", (f) => fs.appendFileSync(path.join(f.installedRoot, "packages/piagent-core/runtime/entry.ts"), "export const changed = true;\n")]
]) test(`existing host approval fails closed after ${name}`, (t) => {
  const f = fixture(t); writeHostContractApproval(f.options); const config = f.open();
  mutate(f);
  assert.equal(config.isCurrent(), false);
  assert.throws(() => f.open());
  if (name === "missing key") assert.equal(fs.existsSync(f.keyPath), false, "opening never silently re-keys authority");
});

test("approval cannot be transplanted to another project or another authority path", (t) => {
  const f = fixture(t); writeHostContractApproval(f.options);
  const other = path.join(f.root, "other-project"); fs.mkdirSync(other);
  assert.throws(() => f.open({ projectRoot: other }), /project/);
  const copied = path.join(f.root, "copied-authority"); fs.mkdirSync(copied, { mode: 0o700 });
  for (const name of ["authority.key", "approval.json"]) fs.copyFileSync(path.join(f.directory, name), path.join(copied, name));
  assert.throws(() => f.open({ configPath: path.join(copied, "approval.json") }), /unauthenticated/);
});

test("installed reusable family data is part of verifier identity and revokes old approvals on drift", (t) => {
  const f = fixture(t), file = path.join(f.installedRoot, "adapters/node-typescript/contract-families.json");
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify({ fixture: 1 }));
  writeHostContractApproval(f.options); const configuration = f.open();
  assert.equal(configuration.isCurrent(), true);
  fs.writeFileSync(file, JSON.stringify({ fixture: 2 }));
  assert.equal(configuration.isCurrent(), false);
  assert.throws(() => f.open(), /verifier changed/);
});

test("declared worker source, budget and dependency identities revoke approval on resource-policy drift", (t) => {
  const f = fixture(t), directory = "packages/piagent-core/extensions/acceptance-executor";
  const { piagent } = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
  fs.writeFileSync(path.join(f.installedRoot, "package.json"), JSON.stringify({ piagent }));
  fs.cpSync(path.join(repositoryRoot, directory), path.join(f.installedRoot, directory), {
    recursive: true, filter: (source) => !source.split(path.sep).includes("node_modules")
  });
  const files = discoverRuntimeIntegrityFiles(f.installedRoot);
  for (const name of ["worker.mjs", "guest.mjs", "budget.mjs", "protocol.mjs", "intrinsics.mjs", "values.mjs",
    "module-graph.mjs", "package.json", "package-lock.json"]) assert.ok(files.includes(directory + "/" + name), name);
  writeHostContractApproval(f.options); const config = f.open();
  assert.equal(config.isCurrent(), true);
  const budgetPath = path.join(f.installedRoot, directory, "budget.mjs"), original = fs.readFileSync(budgetPath, "utf8");
  const changed = original.replace("300000", "1"); assert.notEqual(changed, original);
  fs.writeFileSync(budgetPath, changed);
  assert.equal(config.isCurrent(), false);
  assert.throws(() => f.open(), /verifier changed/);
});

test("published schemas describe the host plan and approval without treating JSON as authority", (t) => {
  const f = fixture(t), payload = prepareHostContractApproval(f.options);
  const ajv = new Ajv({ allErrors: true, strict: false });
  const approvalSchema = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "schemas/approved-host-contracts.schema.json")));
  const planSchema = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "schemas/host-contract-plan.schema.json")));
  ajv.addSchema(approvalSchema);
  const validate = ajv.compile(planSchema);
  const plan = { schemaVersion: 1, operatorRequestDigest: payload.operatorRequestDigest, backend: payload.backend, contracts: payload.contracts };
  assert.equal(validate(plan), true, JSON.stringify(validate.errors));
  assert.equal(ajv.validate(approvalSchema.$id, payload), true, JSON.stringify(ajv.errors));
  for (const sourcePath of ["/source.js", "../source.js", "src//source.js", "src/", ".pi/file.js", "src/../file.js", "src\\file.js"]) {
    const changed = structuredClone(plan); changed.contracts[0].sourcePath = sourcePath;
    assert.equal(validate(changed), false, sourcePath);
    assert.throws(() => prepareHostContractApproval({ ...f.options, contracts: changed.contracts }));
  }
  const wrong = structuredClone(plan); wrong.contracts[0].checks[0].cases[0].expected.errorClass = "TypeError";
  assert.equal(validate(wrong), false);
  assert.equal(fs.existsSync(f.directory), false, "preview/schema validation creates no authority");
});

test("host approval binds structured histories and rejects references or snapshots outside their contract", (t) => {
  const f = fixture(t), value = { type: "record", value: [{ key: "value", value: { type: "number", value: 1 } }] };
  f.options.contracts[0].checks[0].cases = [
    { id: "saved", sequence: "history", exportName: "snapshot", args: [], expected: { outcome: "return", value } },
    { id: "restored", sequence: "history", exportName: "restore", reset: true, args: [{ type: "result", value: "saved" }], observeArgs: true,
      expected: { outcome: "return", value, argsAfter: [value] } }
  ];
  const payload = prepareHostContractApproval(f.options), schema = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "schemas/approved-host-contracts.schema.json")));
  const ajv = new Ajv({ allErrors: true, strict: false });
  assert.equal(ajv.validate(schema, payload), true, JSON.stringify(ajv.errors));
  for (const mutate of [
    (cases) => { cases[1].sequence = "foreign"; },
    (cases) => { cases[1].observeArgs = false; },
    (cases) => { cases[0].expected.value.value.push(structuredClone(cases[0].expected.value.value[0])); }
  ]) {
    const wrong = structuredClone(f.options); mutate(wrong.contracts[0].checks[0].cases);
    assert.throws(() => prepareHostContractApproval(wrong));
    assert.equal(fs.existsSync(f.directory), false);
  }
  writeHostContractApproval(f.options);
  assert.deepEqual(f.open().payload.contracts[0].checks[0].cases, payload.contracts[0].checks[0].cases);
});

test("host module allowlists are explicit schema-bound approval data, not inferred imports", (t) => {
  const f = fixture(t);
  f.options.contracts[0].modulePaths = ["src/lib/math.js", "shared/types.js"];
  const payload = prepareHostContractApproval(f.options);
  const schema = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "schemas/approved-host-contracts.schema.json")));
  const ajv = new Ajv({ allErrors: true, strict: false });
  assert.equal(ajv.validate(schema, payload), true, JSON.stringify(ajv.errors));
  for (const modulePaths of [["src/sum.js"], ["src/lib.js", "src/lib.js"], ["../outside.js"], [".pi/auth.json"], ["src/lib.js?other"]]) {
    const wrong = structuredClone(f.options); wrong.contracts[0].modulePaths = modulePaths;
    assert.throws(() => prepareHostContractApproval(wrong));
    assert.equal(fs.existsSync(f.directory), false);
  }
  writeHostContractApproval(f.options);
  assert.deepEqual(f.open().payload.contracts[0].modulePaths, f.options.contracts[0].modulePaths);
  const envelope = JSON.parse(fs.readFileSync(f.configPath)); envelope.payload.contracts[0].modulePaths.push("src/new.js");
  fs.writeFileSync(f.configPath, JSON.stringify(envelope));
  assert.throws(() => f.open(), /unauthenticated/);
});

test("the installed dispatcher previews approval without writes, then creates authority only with --approve", (t) => {
  const f = fixture(t), executable = path.join(f.root, "piagent"), planPath = path.join(f.root, "plan.json");
  fs.symlinkSync(path.join(repositoryRoot, "scripts/piagent-cli.mjs"), executable);
  const plan = { schemaVersion: 1, operatorRequestDigest: f.options.operatorRequestDigest, backend: f.options.backend, contracts: f.options.contracts };
  fs.writeFileSync(planPath, JSON.stringify(plan), { mode: 0o600 });
  const command = [executable, "approve-verification", "--project", f.projectRoot, "--plan", planPath, "--directory", f.directory];
  const run = (extra = []) => spawnSync(process.execPath, [...command, ...extra], { cwd: f.projectRoot, encoding: "utf8", timeout: 15000 });
  const preview = run(); assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).status, "preview-only");
  assert.equal(fs.existsSync(f.directory), false);
  const duplicate = run(["--plan", planPath]); assert.equal(duplicate.status, 1); assert.equal(fs.existsSync(f.directory), false);
  const approved = run(["--approve"]); assert.equal(approved.status, 0, approved.stderr);
  const result = JSON.parse(approved.stdout); assert.equal(result.status, "approved"); assert.equal(result.configPath, f.configPath);
  assert.deepEqual(Object.keys(result).sort(), ["configPath", "status", "verifierDigest"]);
  assert.equal(f.open({ installedRoot: repositoryRoot }).isCurrent(), true);
  assert.equal(run(["--approve"]).status, 1, "existing authority is never overwritten");
});

test("explicit native-only request sets carry no receipts and cannot weaken legacy or code plans", t => {
  const f = fixture(t), code = nodePlan(f.options), native = {
    ...nodePlan(f.options, `operator-request-v1:${"d".repeat(64)}`), nativeOnly: true, contracts: [] };
  const input = { ...requestSet(f.options), plans: [native, code] };
  const plan = { schemaVersion: 4, plans: input.plans };
  const ajv = new Ajv({ allErrors: true, strict: false });
  const approvalSchema = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "schemas/approved-host-contracts.schema.json")));
  ajv.addSchema(approvalSchema);
  const validPlan = ajv.compile(JSON.parse(fs.readFileSync(path.join(repositoryRoot, "schemas/host-contract-plan.schema.json"))));
  assert.equal(validateHostContractPlan(plan), plan); assert.equal(validPlan(plan), true, JSON.stringify(validPlan.errors));
  assert.throws(() => validateHostContractPlan(native), /explicit request set/); assert.equal(validPlan(native), false);
  const payload = prepareHostContractApproval(input);
  assert.equal(ajv.validate(approvalSchema.$id, payload), true, JSON.stringify(ajv.errors));
  writeHostContractApproval(input); const config = f.open();
  assert.equal(config.forRequest(native.operatorRequestDigest).nativeOnly, true);
  assert.deepEqual(config.forRequest(native.operatorRequestDigest).contracts, []);
  assert.deepEqual(config.forRequest(code.operatorRequestDigest).contracts, code.contracts);
  assert.equal(config.forRequest(`operator-request-v1:${"f".repeat(64)}`), null);
  for (const bad of [{ ...native, nativeOnly: false }, { ...native, contracts: code.contracts },
    { ...code, contracts: [] }, { ...native, schemaVersion: 1 }]) {
    assert.throws(() => validateHostContractPlan({ schemaVersion: 4, plans: [bad] }));
    assert.equal(validPlan({ schemaVersion: 4, plans: [bad] }), false);
  }
  const stored = JSON.parse(fs.readFileSync(f.configPath));
  delete stored.payload.plans[0].nativeOnly;
  fs.writeFileSync(f.configPath, JSON.stringify(stored));
  assert.equal(config.isCurrent(), false); assert.throws(() => f.open(), /unauthenticated/);
});

test("startup allowance is schema checked, signed and revoked on modification", t => {
  const f = fixture(t);
  const schema = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "schemas/approved-host-contracts.schema.json")));
  const ajv = new Ajv({ allErrors: true, strict: false });
  for (const startupAllowanceMs of [-1, 60001, 1.5, null, "60000"]) {
    assert.throws(() => prepareHostContractApproval({ ...f.options,
      backend: { ...f.options.backend, startupAllowanceMs } }), /Invalid host contract/);
  }
  f.options.backend.startupAllowanceMs = 60000;
  const preview = prepareHostContractApproval(f.options);
  assert.equal(ajv.validate(schema, preview), true, JSON.stringify(ajv.errors));
  assert.equal(preview.backend.startupAllowanceMs, 60000);
  writeHostContractApproval(f.options);
  const configuration = f.open();
  assert.equal(configuration.forRequest(f.options.operatorRequestDigest).backend.startupAllowanceMs, 60000);
  const stored = JSON.parse(fs.readFileSync(f.configPath));
  stored.payload.backend.startupAllowanceMs = 0;
  fs.writeFileSync(f.configPath, JSON.stringify(stored));
  assert.equal(configuration.isCurrent(), false);
  assert.throws(() => f.open(), /unauthenticated/);
});
