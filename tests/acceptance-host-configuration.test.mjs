import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv from "ajv";
import { installedContractVerifierDigest, openHostContractConfiguration, prepareHostContractApproval, writeHostContractApproval } from "../packages/piagent-core/extensions/acceptance-host-configuration.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

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
