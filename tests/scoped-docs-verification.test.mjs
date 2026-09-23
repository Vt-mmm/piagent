import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { scopedProjectVerificationPlanBinding, createScopedProjectVerificationSupervisor }
  from "../scripts/benchmark-scoped-project-verifier.mjs";
import { verifyScopedVerificationEnvelope, scopedVerificationReceiptKeyDigest }
  from "../scripts/benchmark-scoped-verification-supervisor.mjs";
import { SCOPED_DOCS_POLICY, DOCS_COMMANDS, SCOPED_DOCS_WORKER }
  from "../scripts/benchmark-scoped-docs-verifier.mjs";
import { scopedProjectReceiptCoversTask }
  from "../packages/piagent-core/runtime/verification/composite-scoped-mediation.ts";
import { workingTreeSnapshot } from "../packages/piagent-core/extensions/task-state.js";
const repo = path.resolve(import.meta.dirname, ".."), sha = value => createHash("sha256").update(value).digest("hex");
const toolchain = { gitCommand: "/Applications/Xcode.app/Contents/Developer/usr/bin/git", shellCommand: "/bin/sh",
  npmRoot: "/usr/local/lib/node_modules/npm" };
const integration = { timeout: 60000, skip: Object.values(toolchain).some(file => !fs.existsSync(file))
  ? "requires explicitly pinned local Git/shell/npm; missing execution is not qualification" : false };
function setup(t, { mutate, timeoutMs = 15000 } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scoped-docs-current-"))),
    projectRoot = path.join(root, "project"), stagingRoot = path.join(root, "stage");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(repo, "benchmarks/production-v1/project"), projectRoot, { recursive: true, errorOnExist: true });
  fs.mkdirSync(stagingRoot); fs.mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "docs/ops.md"), "# Operations\n"); mutate?.(projectRoot);
  const gitEnv = { HOME: root, PATH: "/usr/bin:/bin", LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  execFileSync(toolchain.gitCommand, ["init", "-q"], { cwd: projectRoot, env: gitEnv });
  execFileSync(toolchain.gitCommand, ["add", "--", "docs/ops.md", "src", "scripts", "test", "package.json"], { cwd: projectRoot, env: gitEnv });
  const files = dir => fs.readdirSync(path.join(projectRoot, dir), { recursive: true }).filter(name => name.endsWith(".js"))
    .map(name => `${dir}/${name}`).sort();
  const policy = { version: SCOPED_DOCS_POLICY, configuredCommands: [...DOCS_COMMANDS], currentFiles: ["docs/ops.md"],
    frozenPolicy: { version: "scoped-project-verifier-policy-v1", configuredScripts: { "type-check": "node scripts/check.mjs",
      lint: "node scripts/check.mjs", test: "node --test test/*.test.js", "test:e2e": "node --test test/*.test.js" },
      configurationFiles: ["package.json", "scripts/check.mjs"], syntaxFiles: [...files("src"), ...files("test")].sort(), testFiles: files("test") },
    toolchain };
  const options = { projectRoot, nodeCommand: process.execPath, policy, timeoutMs }, binding = scopedProjectVerificationPlanBinding(options),
    key = generateKeyPairSync("ed25519"), manifest = { id: "docs-current", protocol: binding.protocol,
      capabilityDigest: binding.capabilityDigest, receiptKeyDigest: scopedVerificationReceiptKeyDigest(key.publicKey), timeoutMs },
    identity = { manifestSha256: "1".repeat(64), brokerIdentitySha256: "2".repeat(64), brokerSourceSha256: "3".repeat(64) };
  const bridge = createScopedProjectVerificationSupervisor({ ...identity, receiptPrivateKey: key.privateKey,
    verifications: [{ manifest, plan: { projectRoot, nodeCommand: process.execPath, stagingRoot, policy,
      expectedPlanDigest: binding.planDigest } }] });
  return { root, projectRoot, stagingRoot, policy, options, binding, key, bridge,
    write: text => fs.writeFileSync(path.join(projectRoot, "docs/ops.md"), text),
    begin: action => bridge.begin({ ...identity, verificationId: manifest.id, action, capabilityDigest: manifest.capabilityDigest }) };
}
const taskInput = (receipt, text, projectRoot) => ({ projectRoot, task: { verifyCommands: [...DOCS_COMMANDS] },
  contract: { facts: [{ kind: "workspace-scope", parameters: { allowedWriteMaterialIds: ["document"] } }] },
  plan: { materialBindings: [{ id: "document", relativePath: "docs/ops.md", mode: "current" }] },
  materials: [{ id: "document", relativePath: "docs/ops.md", sha256: sha(text), text }],
  workspace: workingTreeSnapshot(projectRoot) });

test("docs policy runs exact Git and conditional npm commands and signs the changed current document", integration, async t => {
  const f = setup(t), text = "# Operations\n\nService: public-fixture\n\nRestart: `documented only`\n";
  f.write(text); assert.deepEqual(scopedProjectVerificationPlanBinding(f.options), f.binding);
  const begin = f.begin(1), result = await f.bridge.execute(begin.attemptId), receipt = result.envelope.receipt;
  assert.equal(receipt.version, 3); assert.equal(receipt.worker.version, SCOPED_DOCS_WORKER);
  assert.equal(receipt.status, "completed", JSON.stringify(receipt)); assert.equal(receipt.evidence.outcome, "passed");
  assert.equal(receipt.cleanup.confirmed, true); assert.notEqual(receipt.sourceDigest, f.binding.sourceDigest);
  assert.deepEqual(receipt.scope.commands, DOCS_COMMANDS); assert.equal(receipt.scope.files[0].sha256, sha(text));
  assert.deepEqual(result.observation.commands.map(row => [row.id, row.outcome]), [["git-diff-check", "passed"], ["conditional-project-test", "passed"]]);
  verifyScopedVerificationEnvelope(result.envelope, f.key.publicKey);
  const schema = JSON.parse(fs.readFileSync(path.join(repo, "schemas/scoped-project-verification-receipt-v3.schema.json")));
  const validate = new Ajv2020({ strict: true }).compile(schema); assert.equal(validate(result.envelope), true, JSON.stringify(validate.errors));
  assert.equal(scopedProjectReceiptCoversTask(receipt, taskInput(receipt, text, f.projectRoot)), true);
  assert.deepEqual(fs.readdirSync(f.stagingRoot), []);
});
test("Git whitespace failure cannot be replaced by passing npm checks", integration, async t => {
  const f = setup(t); f.write("# Operations\n\nTrailing whitespace  \n");
  const result = await f.bridge.execute(f.begin(1).attemptId), receipt = result.envelope.receipt;
  assert.equal(receipt.status, "completed", JSON.stringify(receipt)); assert.equal(receipt.evidence.outcome, "failed");
  assert.deepEqual(receipt.evidence.failedCommands, ["git-diff-check"]); assert.equal(receipt.cleanup.confirmed, true);
  assert.equal(result.observation.commands[1].outcome, "passed"); verifyScopedVerificationEnvelope(result.envelope, f.key.publicKey);
});
test("actual conditional npm failure stays failed despite a clean Git diff", integration, async t => {
  const f = setup(t, { mutate(root) { fs.writeFileSync(path.join(root, "test/smoke.test.js"),
    "import test from 'node:test';test('intentional failure',()=>{throw new Error('fixture failure')});\n"); } });
  f.write("# Operations\n\nClean diff\n"); const result = await f.bridge.execute(f.begin(1).attemptId);
  assert.equal(result.envelope.receipt.status, "completed", JSON.stringify(result.envelope.receipt));
  assert.deepEqual(result.envelope.receipt.evidence.failedCommands, ["conditional-project-test"]);
  assert.equal(result.envelope.receipt.cleanup.confirmed, true);
});
test("document drift during an attempt and after signed verification invalidates current coverage", integration, async t => {
  const f = setup(t), text = "# Operations\n\nCurrent text\n"; f.write(text);
  const good = await f.bridge.execute(f.begin(1).attemptId);
  assert.equal(good.envelope.receipt.evidence.outcome, "passed");
  const changed = text + "Changed after verification\n"; f.write(changed);
  assert.equal(scopedProjectReceiptCoversTask(good.envelope.receipt, taskInput(good.envelope.receipt, changed, f.projectRoot)), false);
  const second = f.begin(2); f.write(changed + "Mid-attempt drift\n");
  const result = await f.bridge.execute(second.attemptId);
  assert.equal(result.envelope.receipt.status, "error"); assert.equal(result.envelope.receipt.evidence.outcome, null);
  assert.equal(result.envelope.receipt.cleanup.confirmed, true);
});
test("raw content hashes and stale metadata cannot masquerade as current workspace evidence", integration, async t => {
  const f = setup(t), text = "# Operations\n\nCurrent document\n"; f.write(text);
  const receipt = (await f.bridge.execute(f.begin(1).attemptId)).envelope.receipt;
  const current = taskInput(receipt, text, f.projectRoot);
  assert.equal(scopedProjectReceiptCoversTask(receipt, current), true);
  assert.equal(scopedProjectReceiptCoversTask(receipt, { ...current,
    workspace: { "docs/ops.md": `wt-content-v2:${sha(text)}` } }), false);
  assert.equal(scopedProjectReceiptCoversTask(receipt, { ...current, projectRoot: undefined }), false);
  fs.chmodSync(path.join(f.projectRoot, "docs/ops.md"), 0o700);
  assert.equal(scopedProjectReceiptCoversTask(receipt, current), false);
});
test("changed frozen checker, extra configuration and foreign commands cannot inherit the docs policy", integration, t => {
  const f = setup(t), foreign = structuredClone(f.options); foreign.policy.configuredCommands = ["npm test"];
  assert.throws(() => scopedProjectVerificationPlanBinding(foreign), /unsupported-docs-commands/);
  fs.writeFileSync(path.join(f.projectRoot, ".npmrc"), "offline=true\n");
  assert.throws(() => f.begin(1), /docs-extra-configuration-unsupported/); fs.unlinkSync(path.join(f.projectRoot, ".npmrc"));
  fs.appendFileSync(path.join(f.projectRoot, "scripts/check.mjs"), "\n// changed checker\n");
  assert.throws(() => f.begin(1), /project-configured-checker-unsupported|docs-frozen-source-drift/);
});
test("signed docs receipt cannot be replayed for another command set or altered source and cancellation remains finite", integration, async t => {
  const f = setup(t), text = "# Operations\n\nVerified\n"; f.write(text);
  const result = await f.bridge.execute(f.begin(1).attemptId), receipt = result.envelope.receipt;
  const wrongTask = taskInput(receipt, text, f.projectRoot); wrongTask.task.verifyCommands = ["npm test"];
  assert.equal(scopedProjectReceiptCoversTask(receipt, wrongTask), false);
  const forged = structuredClone(result.envelope); forged.receipt.scope.files[0].sha256 = "f".repeat(64);
  assert.throws(() => verifyScopedVerificationEnvelope(forged, f.key.publicKey), /invalid-docs-receipt-scope|invalid-verification-signature/);
  const begin = f.begin(2); assert.equal(f.bridge.cancel(begin.attemptId), true);
  const cancelled = await f.bridge.execute(begin.attemptId);
  assert.equal(cancelled.envelope.receipt.status, "cancelled"); assert.equal(cancelled.envelope.receipt.evidence.outcome, null);
  assert.equal(cancelled.envelope.receipt.cleanup.confirmed, true); assert.equal(f.bridge.status().active, null);
});
