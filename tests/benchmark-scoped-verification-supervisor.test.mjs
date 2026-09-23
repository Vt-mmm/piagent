import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { WORKER_VERSION } from "../packages/piagent-core/extensions/acceptance-executor/protocol.mjs";
import { createScopedVerificationHostDispatcher, createScopedVerificationRemoteBridge,
  createScopedProjectVerificationSupervisor,
  createScopedVerificationSupervisor, createScopedVerificationUnixRequest, listenScopedVerificationBridge,
  scopedProjectVerificationPlanBinding,
  scopedVerificationPlanBinding, scopedVerificationReceiptKeyDigest,
  scopedCommonRuntimeClosureIdentity, scopedQualificationIdentity, scopedTrackedSourceIdentity,
  scopedTreeIdentity, verifyScopedVerificationEnvelope,
  SCOPED_PROJECT_VERIFICATION_PROTOCOL, SCOPED_PROJECT_VERIFICATION_RECEIPT,
  SCOPED_PROJECT_VERIFIER_POLICY, SCOPED_PROJECT_VERIFIER_WORKER
} from "../scripts/benchmark-scoped-verification-supervisor.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const requestText = JSON.stringify({ schemaVersion: 1, source: "export const run=()=>true", exportName: "run",
  cases: [{ id: "one", args: [] }] });
const imageId = `sha256:${"b".repeat(64)}`, dockerSocket = "/host-only/docker.sock";
const verifierDigest = "c".repeat(64), timeoutMs = 100;
const completedExecution = input => ({ runId: input.executionRunId, requestDigest: sha(input.requestText),
  sourceDigest: scopedVerificationPlanBinding({ requestText: input.requestText, imageId: input.imageId,
    dockerSocket: input.dockerSocket, verifierDigest, timeoutMs: input.timeoutMs }).sourceDigest,
  imageId: input.imageId, status: "completed", cleanupConfirmed: true,
  observation: { schemaVersion: 1, workerVersion: WORKER_VERSION, requestDigest: sha(input.requestText), status: "completed",
    cases: [{ id: "one", outcome: "return", value: { type: "boolean", value: true }, dateArgsAfter: [], clockReads: 0 }] } });

function fixture(execute = async input => completedExecution(input), timeout = timeoutMs, clock = Date.now) {
  const key = generateKeyPairSync("ed25519"), binding = scopedVerificationPlanBinding({ requestText, imageId,
    dockerSocket, verifierDigest, timeoutMs: timeout });
  const manifest = { id: "check", protocol: binding.protocol, capabilityDigest: binding.capabilityDigest,
    receiptKeyDigest: scopedVerificationReceiptKeyDigest(key.publicKey), timeoutMs: timeout };
  const manifestSha256 = "1".repeat(64), brokerIdentitySha256 = "2".repeat(64), brokerSourceSha256 = "3".repeat(64);
  const bridge = createScopedVerificationSupervisor({ manifestSha256, brokerIdentitySha256, brokerSourceSha256,
    receiptPrivateKey: key.privateKey, verifications: [{ manifest,
      plan: { requestText, imageId, dockerSocket, verifierDigest } }], execute, clock });
  const begin = action => bridge.begin({ verificationId: "check", action, brokerIdentitySha256,
    brokerSourceSha256, manifestSha256, capabilityDigest: binding.capabilityDigest });
  return { key, binding, manifest, bridge, begin };
}

function projectPolicy(projectRoot) {
  const files = directory => {
    const base = path.join(projectRoot, directory), result = [], pending = [base];
    while (pending.length) {
      const current = pending.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const target = path.join(current, entry.name);
        if (entry.isDirectory()) pending.push(target);
        else if (entry.isFile() && target.endsWith(".js"))
          result.push(path.relative(projectRoot, target).split(path.sep).join("/"));
      }
    }
    return result;
  };
  const testFiles = files("test").sort();
  return { version: SCOPED_PROJECT_VERIFIER_POLICY, configuredScripts: {
    "type-check": "node scripts/check.mjs", lint: "node scripts/check.mjs",
    test: "node --test test/*.test.js", "test:e2e": "node --test test/*.test.js"
  }, configurationFiles: ["package.json", "scripts/check.mjs"],
  syntaxFiles: [...files("src"), ...testFiles].sort(), testFiles };
}

function projectFixture(t, { timeout = 10000, mutate } = {}) {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scoped-project-verifier-")));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const projectRoot = path.join(temporary, "project"), stagingRoot = path.join(temporary, "staging");
  fs.cpSync(path.resolve(import.meta.dirname, "../benchmarks/production-v1/project"), projectRoot,
    { recursive: true, errorOnExist: true });
  fs.mkdirSync(stagingRoot, { mode: 0o700 });
  mutate?.(projectRoot);
  const policy = projectPolicy(projectRoot), key = generateKeyPairSync("ed25519"),
    binding = scopedProjectVerificationPlanBinding({ projectRoot, nodeCommand: process.execPath, policy, timeoutMs: timeout }),
    manifest = { id: "project-current", protocol: binding.protocol, capabilityDigest: binding.capabilityDigest,
      receiptKeyDigest: scopedVerificationReceiptKeyDigest(key.publicKey), timeoutMs: timeout },
    manifestSha256 = "4".repeat(64), brokerIdentitySha256 = "5".repeat(64), brokerSourceSha256 = "6".repeat(64),
    bridge = createScopedProjectVerificationSupervisor({ manifestSha256, brokerIdentitySha256,
      brokerSourceSha256, receiptPrivateKey: key.privateKey, verifications: [{ manifest,
        plan: { projectRoot, nodeCommand: process.execPath, stagingRoot, policy,
          expectedPlanDigest: binding.planDigest } }] }),
    begin = action => bridge.begin({ verificationId: manifest.id, action, brokerIdentitySha256,
      brokerSourceSha256, manifestSha256, capabilityDigest: binding.capabilityDigest });
  return { temporary, projectRoot, stagingRoot, policy, key, binding, manifest, bridge, begin };
}

test("common runtime closure follows static and constant-template transitive imports and changes on helper drift", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g0-runtime-closure-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scripts = path.join(root, "scripts"), helpers = path.join(scripts, "helpers");
  fs.mkdirSync(helpers, { recursive: true });
  fs.writeFileSync(path.join(helpers, "pure.mjs"), "export const pure = 1;\n");
  fs.writeFileSync(path.join(helpers, "dynamic-child.mjs"), "export const child = 1;\n");
  fs.writeFileSync(path.join(helpers, "dynamic.mjs"),
    'import { child } from "./dynamic-child.mjs"; export const dynamic = child;\n');
  fs.writeFileSync(path.join(scripts, "benchmark-scoped-tool-broker.mjs"),
    'import { pure } from "./helpers/pure.mjs"; export const broker = pure;\n');
  fs.writeFileSync(path.join(scripts, "benchmark-scoped-verification-supervisor.mjs"),
    'export { broker } from "./benchmark-scoped-tool-broker.mjs";\n');
  fs.writeFileSync(path.join(scripts, "benchmark-arm-observer.mjs"),
    'export const observer = import("./helpers/pure.mjs");\n');
  fs.writeFileSync(path.join(scripts, "benchmark-webui-journey.mjs"),
    'const HELPERS = "./helpers"; export const journey = import(`${HELPERS}/dynamic.mjs`);\n');
  const before = scopedCommonRuntimeClosureIdentity(root), repeat = scopedCommonRuntimeClosureIdentity(root);
  assert.equal(before.sha256, repeat.sha256); assert.equal(before.files, 7);
  assert.ok(before.entries.some(row => row.path === "scripts/helpers/pure.mjs"));
  assert.ok(before.entries.some(row => row.path === "scripts/helpers/dynamic.mjs"));
  assert.ok(before.entries.some(row => row.path === "scripts/helpers/dynamic-child.mjs"));
  fs.writeFileSync(path.join(helpers, "dynamic-child.mjs"), "export const child = 2;\n");
  const after = scopedCommonRuntimeClosureIdentity(root);
  assert.notEqual(after.sha256, before.sha256); assert.equal(after.files, before.files);
});

test("qualification recomputes tracked source, ignored assets and SDK as separate identities", {
  timeout: 60000
}, t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "g0-qualification-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const candidateRoot = path.join(root, "candidate"), assetsRoot = path.join(candidateRoot,
    "packages/piagent-webui/dist/client"), sdkRoot = path.join(root, "sdk");
  fs.mkdirSync(assetsRoot, { recursive: true }); fs.mkdirSync(sdkRoot);
  fs.writeFileSync(path.join(candidateRoot, ".gitignore"), "packages/piagent-webui/dist/client/\n");
  fs.writeFileSync(path.join(candidateRoot, "source.mjs"), "export const source = 1;\n");
  fs.writeFileSync(path.join(assetsRoot, "index.html"), "asset-one\n");
  fs.writeFileSync(path.join(sdkRoot, "sdk.mjs"), "export const sdk = 1;\n");
  execFileSync("git", ["-C", candidateRoot, "init", "-q"]);
  execFileSync("git", ["-C", candidateRoot, "add", "."]);
  execFileSync("git", ["-C", candidateRoot, "-c", "user.name=G0", "-c", "user.email=g0@invalid",
    "commit", "-qm", "fixture"]);
  const roots = { candidateRoot: fs.realpathSync(candidateRoot), assetsRoot: fs.realpathSync(assetsRoot),
    sdkRoot: fs.realpathSync(sdkRoot) };
  const tracked = scopedTrackedSourceIdentity(roots.candidateRoot), initial = scopedQualificationIdentity(roots);
  assert.equal(initial.sourceSha256, tracked.sha256);
  assert.equal(initial.assetTreeSha256, scopedTreeIdentity(roots.assetsRoot).sha256);
  assert.equal(initial.sdkTreeSha256, scopedTreeIdentity(roots.sdkRoot).sha256);
  fs.writeFileSync(path.join(assetsRoot, "index.html"), "asset-two\n");
  const assetDrift = scopedQualificationIdentity(roots);
  assert.equal(assetDrift.sourceSha256, initial.sourceSha256);
  assert.notEqual(assetDrift.assetTreeSha256, initial.assetTreeSha256);
  assert.equal(assetDrift.sdkTreeSha256, initial.sdkTreeSha256);
  fs.writeFileSync(path.join(assetsRoot, "index.html"), "asset-one\n");
  fs.writeFileSync(path.join(sdkRoot, "sdk.mjs"), "export const sdk = 2;\n");
  const sdkDrift = scopedQualificationIdentity(roots);
  assert.equal(sdkDrift.assetTreeSha256, initial.assetTreeSha256);
  assert.notEqual(sdkDrift.sdkTreeSha256, initial.sdkTreeSha256);
  fs.writeFileSync(path.join(candidateRoot, "source.mjs"), "export const source = 2;\n");
  assert.throws(() => scopedQualificationIdentity(roots), /tracked-source-dirty/);
});

test("scoped verification signs every required binding without exposing host authority", async () => {
  let executionInput;
  const value = fixture(async input => { executionInput = input; return completedExecution(input); });
  const prepared = value.begin(7), result = await value.bridge.execute(prepared.attemptId);
  const verified = verifyScopedVerificationEnvelope(result.envelope, value.key.publicKey);
  assert.equal(verified.receipt.verificationId, "check"); assert.equal(verified.receipt.action, 7);
  assert.equal(verified.receipt.attemptId, prepared.attemptId);
  assert.equal(verified.receipt.capabilityDigest, value.binding.capabilityDigest);
  assert.equal(verified.receipt.planDigest, value.binding.planDigest);
  assert.equal(value.binding.dockerSocketDigest, sha(dockerSocket));
  assert.equal(verified.receipt.requestDigest, value.binding.requestDigest);
  assert.equal(verified.receipt.sourceDigest, value.binding.sourceDigest);
  assert.equal(verified.receipt.imageId, imageId); assert.equal(verified.receipt.verifierDigest, verifierDigest);
  assert.deepEqual(verified.receipt.worker, { runId: prepared.attemptId, version: WORKER_VERSION });
  assert.equal(verified.receipt.status, "completed"); assert.equal(verified.receipt.verdict, "observation-recorded");
  assert.deepEqual(verified.receipt.cleanup, { confirmed: true }); assert.equal(verified.receipt.completionAllowed, false);
  assert.equal(verified.receipt.evidence.observationSha256, sha(JSON.stringify(result.observation)));
  assert.equal(executionInput.dockerSocket, "/host-only/docker.sock");
  const publicBridge = JSON.stringify(value.bridge);
  assert.ok(!publicBridge.includes("docker.sock")); assert.ok(!publicBridge.includes(requestText));
  assert.ok(!publicBridge.includes("PRIVATE KEY"));
});

test("receipt JSON schema and cryptographic verifier agree", async () => {
  const value = fixture(), prepared = value.begin(1), result = await value.bridge.execute(prepared.attemptId);
  const schema = JSON.parse(fs.readFileSync(new URL("../schemas/scoped-verification-receipt-v1.schema.json", import.meta.url)));
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
  assert.equal(validate(result.envelope), true, JSON.stringify(validate.errors));
  const malformed = structuredClone(result.envelope); malformed.signature = "A";
  assert.equal(validate(malformed), false);
  assert.deepEqual(verifyScopedVerificationEnvelope(result.envelope, value.bridge.receiptPublicKey), result.envelope);
});

test("project verifier runs the pinned configured footprint and emits a schema-valid passed observation", {
  timeout: 30000
}, async t => {
  const value = projectFixture(t), prepared = value.begin(21), result = await value.bridge.execute(prepared.attemptId),
    receipt = result.envelope.receipt;
  assert.equal(receipt.kind, SCOPED_PROJECT_VERIFICATION_RECEIPT);
  assert.equal(receipt.protocol, SCOPED_PROJECT_VERIFICATION_PROTOCOL);
  assert.equal(receipt.planDigest, value.binding.planDigest);
  assert.equal(receipt.environmentDigest, value.binding.environmentDigest);
  assert.equal(receipt.worker.version, SCOPED_PROJECT_VERIFIER_WORKER);
  assert.equal(receipt.status, "completed"); assert.equal(receipt.verdict, "observation-recorded");
  assert.equal(receipt.evidence.outcome, "passed"); assert.deepEqual(receipt.evidence.failedCommands, []);
  assert.deepEqual(result.observation.commands.map(item => [item.id, item.invocationCount, item.outcome]), [
    ["type-check", value.policy.syntaxFiles.length, "passed"],
    ["lint", value.policy.syntaxFiles.length, "passed"], ["test", 1, "passed"], ["test:e2e", 1, "passed"]
  ]);
  assert.deepEqual(fs.readdirSync(value.stagingRoot), []);
  const schema = JSON.parse(fs.readFileSync(new URL("../schemas/scoped-project-verification-receipt-v2.schema.json",
    import.meta.url)));
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
  assert.equal(validate(result.envelope), true, JSON.stringify(validate.errors));
  assert.deepEqual(verifyScopedVerificationEnvelope(result.envelope, value.key.publicKey), result.envelope);
});

test("project verifier authenticates configured test failure without promoting it to infrastructure error", {
  timeout: 30000
}, async t => {
  const value = projectFixture(t, { mutate(projectRoot) {
    fs.writeFileSync(path.join(projectRoot, "test/smoke.test.js"),
      'import test from "node:test"; test("expected failure",()=>{ throw new Error("fixture-failure"); });\n');
  } }), prepared = value.begin(22), result = await value.bridge.execute(prepared.attemptId),
    receipt = result.envelope.receipt;
  assert.equal(receipt.status, "completed"); assert.equal(receipt.verdict, "observation-recorded");
  assert.equal(receipt.evidence.reason, null); assert.equal(receipt.evidence.outcome, "failed");
  assert.deepEqual(receipt.evidence.failedCommands, ["test", "test:e2e"]);
  assert.equal(receipt.cleanup.confirmed, true); assert.deepEqual(fs.readdirSync(value.stagingRoot), []);
  verifyScopedVerificationEnvelope(result.envelope, value.key.publicKey);
});

test("fixed project policy rejects a different configured checker before issuing a plan", t => {
  // The fixed worker expands --check over syntaxFiles; it never executes an
  // arbitrary replacement scripts/check.mjs. A new script identity therefore
  // requires another policy, even if package.json retains the same names.
  for (const checker of ["process.exit(7);\n", "// equivalent is not automatically approved\n"]) {
    assert.throws(() => projectFixture(t, { mutate(projectRoot) {
      fs.writeFileSync(path.join(projectRoot, "scripts/check.mjs"), checker);
    } }), /project-configured-checker-unsupported/);
  }
});

test("project verifier signs source drift before execution only as unavailable", async t => {
  const value = projectFixture(t), prepared = value.begin(23);
  fs.appendFileSync(path.join(value.projectRoot, "src/backend/auth.js"), "\n// drift\n");
  const result = await value.bridge.execute(prepared.attemptId), receipt = result.envelope.receipt;
  assert.equal(receipt.status, "error"); assert.equal(receipt.verdict, "observation-unavailable");
  assert.equal(receipt.evidence.reason, "project-verifier-binding-drift");
  assert.equal(receipt.evidence.outcome, null); assert.deepEqual(receipt.evidence.failedCommands, []);
  assert.equal(receipt.cleanup.confirmed, true); assert.deepEqual(fs.readdirSync(value.stagingRoot), []);
  verifyScopedVerificationEnvelope(result.envelope, value.key.publicKey);
});

test("project verifier cancellation reaps the child and removes its private stage", {
  timeout: 30000
}, async t => {
  const value = projectFixture(t), prepared = value.begin(24), running = value.bridge.execute(prepared.attemptId);
  assert.equal(value.bridge.cancel(prepared.attemptId), true);
  const result = await running, receipt = result.envelope.receipt;
  assert.equal(receipt.status, "cancelled"); assert.equal(receipt.verdict, "observation-unavailable");
  assert.equal(receipt.evidence.reason, "supervisor-cancelled"); assert.equal(receipt.cleanup.confirmed, true);
  assert.deepEqual(fs.readdirSync(value.stagingRoot), []);
});

test("project verifier deadline cannot admit a late command observation", { timeout: 30000 }, async t => {
  const value = projectFixture(t, { timeout: 25 }), prepared = value.begin(25),
    result = await value.bridge.execute(prepared.attemptId), receipt = result.envelope.receipt;
  assert.equal(receipt.status, "timeout"); assert.equal(receipt.verdict, "observation-unavailable");
  assert.equal(receipt.evidence.reason, "supervisor-deadline"); assert.equal(receipt.evidence.outcome, null);
  assert.deepEqual(receipt.evidence.failedCommands, []); assert.deepEqual(fs.readdirSync(value.stagingRoot), []);
});

test("forged or stale receipt fields cannot retain a valid signature", async () => {
  const value = fixture(), prepared = value.begin(2), result = await value.bridge.execute(prepared.attemptId);
  for (const mutate of [
    envelope => { envelope.receipt.action++; },
    envelope => { envelope.receipt.manifestSha256 = "0".repeat(64); },
    envelope => { envelope.receipt.cleanup.confirmed = false; },
    envelope => { envelope.signature = Buffer.alloc(64).toString("base64"); }
  ]) {
    const forged = structuredClone(result.envelope); mutate(forged);
    assert.throws(() => verifyScopedVerificationEnvelope(forged, value.key.publicKey));
  }
  assert.throws(() => verifyScopedVerificationEnvelope(result.envelope, generateKeyPairSync("ed25519").publicKey));
});

test("one supervisor admits only one active attempt and reconciles cancellation", async () => {
  let release;
  const value = fixture(input => new Promise(resolve => {
    release = () => resolve({ runId: input.executionRunId, requestDigest: sha(input.requestText),
      sourceDigest: value.binding.sourceDigest, imageId, status: "cancelled", reason: "cancelled",
      cleanupConfirmed: true });
  }));
  const prepared = value.begin(3), running = value.bridge.execute(prepared.attemptId);
  assert.throws(() => value.begin(4), /verification-inflight/);
  assert.equal(value.bridge.cancel(prepared.attemptId), true); release();
  const result = await running;
  assert.equal(result.envelope.receipt.status, "cancelled");
  assert.equal(result.envelope.receipt.verdict, "observation-unavailable");
  assert.equal(result.envelope.receipt.cleanup.confirmed, true);
  assert.equal(await value.bridge.reconcile(prepared.attemptId), result);
  assert.equal(value.bridge.status().active, null);
});

test("manual cancellation strictly before deadline wins when the executor ignores abort", async () => {
  for (const cleanupConfirmed of [true, false]) {
    let now = 1_000, release, started;
    const began = new Promise(resolve => { started = resolve; });
    const value = fixture(input => new Promise(resolve => {
      release = () => resolve({ ...completedExecution(input), cleanupConfirmed }); started();
    }), 100, () => now);
    const prepared = value.begin(cleanupConfirmed ? 12 : 13);
    const running = value.bridge.execute(prepared.attemptId);
    await began;
    assert.equal(value.bridge.cancel(prepared.attemptId), true);
    now = prepared.deadlineAtMs - 1;
    release();
    const result = await running;
    assert.equal(result.envelope.receipt.settledAtMs, prepared.deadlineAtMs - 1);
    assert.equal(result.envelope.receipt.status, "cancelled");
    assert.equal(result.envelope.receipt.evidence.reason, "supervisor-cancelled");
    assert.equal(result.envelope.receipt.cleanup.confirmed, cleanupConfirmed);
    assert.equal(result.envelope.receipt.evidence.observationSha256, null);
    assert.equal(result.envelope.receipt.verdict, "observation-unavailable");
    assert.equal(result.observation, null);
  }
});

test("deadline wins over a manual cancel flag at and after the signed deadline", async () => {
  for (const offset of [0, 1]) {
    let now = 1_000, release, started;
    const began = new Promise(resolve => { started = resolve; });
    const value = fixture(input => new Promise(resolve => {
      release = () => resolve(completedExecution(input)); started();
    }), 100, () => now);
    const prepared = value.begin(14 + offset), running = value.bridge.execute(prepared.attemptId);
    await began;
    assert.equal(value.bridge.cancel(prepared.attemptId), true);
    now = prepared.deadlineAtMs + offset; release();
    const result = await running;
    assert.equal(result.envelope.receipt.settledAtMs, prepared.deadlineAtMs + offset);
    assert.equal(result.envelope.receipt.status, "timeout");
    assert.equal(result.envelope.receipt.evidence.reason, "supervisor-deadline");
    assert.equal(result.envelope.receipt.evidence.observationSha256, null);
    assert.equal(result.envelope.receipt.verdict, "observation-unavailable");
    assert.equal(result.observation, null);
  }
});

test("supervisor deadline aborts the pinned execution and records no completion authority", async () => {
  const value = fixture(input => new Promise(resolve => input.signal.addEventListener("abort", () => resolve({
    ...completedExecution(input) }), { once: true })), 25);
  const prepared = value.begin(5), result = await value.bridge.execute(prepared.attemptId);
  assert.equal(result.envelope.receipt.status, "timeout");
  assert.equal(result.envelope.receipt.evidence.reason, "supervisor-deadline");
  assert.equal(result.envelope.receipt.verdict, "observation-unavailable");
  assert.equal(result.observation, null);
  assert.equal(result.envelope.receipt.completionAllowed, false);
});

test("hard deadline settles an executor that ignores abort and reconciliation preserves unconfirmed cleanup", async () => {
  let aborted = false;
  const value = fixture(input => { input.signal.addEventListener("abort", () => { aborted = true; }, { once: true });
    return new Promise(() => {}); }, 25);
  const prepared = value.begin(14), started = Date.now(), result = await value.bridge.execute(prepared.attemptId);
  assert.equal(aborted, true); assert.ok(Date.now() - started < 1000);
  assert.equal(result.envelope.receipt.status, "timeout");
  assert.equal(result.envelope.receipt.evidence.reason, "supervisor-deadline");
  assert.equal(result.envelope.receipt.cleanup.confirmed, false);
  assert.equal(result.envelope.receipt.verdict, "observation-unavailable");
  assert.equal(value.bridge.status().active, null); assert.equal(await value.bridge.reconcile(prepared.attemptId), result);
});

test("executor crash is signed as unavailable and remains exactly reconcilable", async () => {
  const value = fixture(() => { throw new Error("executor-crash"); });
  const prepared = value.begin(15), result = await value.bridge.execute(prepared.attemptId);
  assert.equal(result.envelope.receipt.status, "error"); assert.equal(result.envelope.receipt.evidence.reason, "executor-threw");
  assert.equal(result.envelope.receipt.cleanup.confirmed, false); assert.equal(result.envelope.receipt.verdict, "observation-unavailable");
  assert.equal(await value.bridge.reconcile(prepared.attemptId), result);
});

test("a delayed event-loop timer cannot admit an observation settled at the signed deadline", async () => {
  let now = 1_000;
  const value = fixture(async input => { now = 1_100; return completedExecution(input); }, 100, () => now);
  const prepared = value.begin(11), result = await value.bridge.execute(prepared.attemptId);
  assert.equal(prepared.deadlineAtMs, 1_100);
  assert.equal(result.envelope.receipt.settledAtMs, 1_100);
  assert.equal(result.envelope.receipt.status, "timeout");
  assert.equal(result.envelope.receipt.verdict, "observation-unavailable");
  assert.equal(result.observation, null);
});

test("an unclaimed reservation expires without starting the isolated executor and remains reconcilable", async () => {
  let executions = 0;
  const value = fixture(async input => { executions++; return completedExecution(input); }, 25);
  const prepared = value.begin(10);
  await new Promise(resolve => setTimeout(resolve, 50));
  const result = await value.bridge.execute(prepared.attemptId);
  assert.equal(executions, 0);
  assert.equal(result.envelope.receipt.status, "timeout");
  assert.equal(result.envelope.receipt.evidence.reason, "supervisor-deadline");
  assert.equal(result.envelope.receipt.cleanup.confirmed, true);
  assert.equal(result.envelope.receipt.verdict, "observation-unavailable");
  assert.equal(value.bridge.status().active, null);
  assert.equal(await value.bridge.reconcile(prepared.attemptId), result);
});

test("malformed execution or cleanup ambiguity is signed only as unavailable", async () => {
  for (const execute of [async () => ({ forged: true }), async input => ({ runId: randomUUID(),
    requestDigest: sha(input.requestText), sourceDigest: "0".repeat(64), imageId, status: "completed",
    cleanupConfirmed: true, observation: {} })]) {
    const value = fixture(execute), prepared = value.begin(6), result = await value.bridge.execute(prepared.attemptId);
    assert.equal(result.integrityFailure, true);
    assert.equal(result.envelope.receipt.status, "error");
    assert.equal(result.envelope.receipt.cleanup.confirmed, false);
    assert.equal(result.envelope.receipt.verdict, "observation-unavailable");
    assert.equal(result.envelope.receipt.evidence.reason, "execution-binding-invalid");
    verifyScopedVerificationEnvelope(result.envelope, value.key.publicKey);
  }
});

test("manifest capability and receipt key pins are mandatory", () => {
  const value = fixture();
  assert.throws(() => createScopedVerificationSupervisor({ manifestSha256: "1".repeat(64),
    brokerIdentitySha256: "2".repeat(64), brokerSourceSha256: "3".repeat(64),
    receiptPrivateKey: value.key.privateKey, verifications: [{ manifest: { ...value.manifest,
      capabilityDigest: "0".repeat(64) }, plan: { requestText, imageId, dockerSocket: "/host/docker.sock", verifierDigest } }] }),
  /capability-mismatch/);
  const foreign = generateKeyPairSync("ed25519");
  assert.throws(() => createScopedVerificationSupervisor({ manifestSha256: "1".repeat(64),
    brokerIdentitySha256: "2".repeat(64), brokerSourceSha256: "3".repeat(64),
    receiptPrivateKey: foreign.privateKey, verifications: [{ manifest: value.manifest,
    plan: { requestText, imageId, dockerSocket: "/host/docker.sock", verifierDigest } }] }), /configuration/);
  assert.throws(() => createScopedVerificationSupervisor({ manifestSha256: "1".repeat(64),
    brokerIdentitySha256: "2".repeat(64), brokerSourceSha256: "3".repeat(64),
    receiptPrivateKey: value.key.privateKey, verifications: [{ manifest: value.manifest,
      plan: { requestText, imageId, dockerSocket: "/different/docker.sock", verifierDigest } }] }),
  /capability-mismatch/);
});

test("host dispatcher keeps plan and backend authority outside the child bridge", async () => {
  const value = fixture(), authorization = "a".repeat(64);
  const dispatch = createScopedVerificationHostDispatcher({ supervisor: value.bridge, authorization });
  const remote = createScopedVerificationRemoteBridge({ receiptPublicKey: value.bridge.receiptPublicKey,
    receiptKeyDigest: value.bridge.receiptKeyDigest, authorization, request: dispatch });
  const prepared = await remote.begin({ verificationId: "check", action: 8,
    brokerIdentitySha256: "2".repeat(64), brokerSourceSha256: "3".repeat(64),
    manifestSha256: "1".repeat(64), capabilityDigest: value.binding.capabilityDigest });
  const result = await remote.execute(prepared.attemptId);
  verifyScopedVerificationEnvelope(result.envelope, remote.receiptPublicKey);
  const exposed = JSON.stringify(remote);
  assert.ok(!exposed.includes("docker.sock")); assert.ok(!exposed.includes(requestText));
  assert.ok(!exposed.includes(imageId)); assert.ok(!exposed.includes(verifierDigest));
});

test("private Unix bridge carries bounded verification RPC without backend paths", async t => {
  const value = fixture(), authorization = "d".repeat(64);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scoped-verify-bridge-")); fs.chmodSync(directory, 0o700);
  const socketPath = path.join(directory, "supervisor.sock");
  const listener = await listenScopedVerificationBridge({ supervisor: value.bridge, authorization, socketPath });
  t.after(async () => { await listener.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const remote = createScopedVerificationRemoteBridge({ receiptPublicKey: value.bridge.receiptPublicKey,
    receiptKeyDigest: value.bridge.receiptKeyDigest, authorization,
    request: createScopedVerificationUnixRequest({ socketPath, timeoutMs: 1000 }) });
  const prepared = await remote.begin({ verificationId: "check", action: 9,
    brokerIdentitySha256: "2".repeat(64), brokerSourceSha256: "3".repeat(64),
    manifestSha256: "1".repeat(64), capabilityDigest: value.binding.capabilityDigest });
  const result = await remote.execute(prepared.attemptId);
  assert.equal(result.envelope.receipt.verdict, "observation-recorded");
  verifyScopedVerificationEnvelope(result.envelope, remote.receiptPublicKey);
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
  const exposed = JSON.stringify(remote);
  assert.ok(!exposed.includes("docker.sock")); assert.ok(!exposed.includes(requestText));
});

test("Unix bridge rejects an overlong pathname before binding a listener", async t => {
  const value = fixture(), directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "verify-long-")));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const socketPath = path.join(directory, `${"x".repeat(100)}.sock`);
  await assert.rejects(listenScopedVerificationBridge({ supervisor: value.bridge,
    authorization: "e".repeat(64), socketPath }), /invalid-bridge-socket/);
  assert.equal(fs.existsSync(socketPath), false);
});
