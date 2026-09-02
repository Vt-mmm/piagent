import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeHostContractApproval } from "../packages/piagent-core/extensions/acceptance-host-configuration.js";
import { independentAcceptanceState } from "../packages/piagent-core/extensions/acceptance-independent-registry.js";
import { IndependentAcceptanceRuntime } from "../packages/piagent-core/runtime/verification/independent-acceptance-runtime.ts";

// Synthetic host authority only. No provider, real credentials, executor or
// candidate source runs. Each test owns its temporary files and runtime slot.
async function fixture(t, mutate, { configure = true } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-recovery-coverage-")));
  const projectRoot = path.join(root, "project"), installedRoot = path.join(root, "installed");
  fs.mkdirSync(projectRoot); fs.mkdirSync(installedRoot);
  fs.writeFileSync(path.join(installedRoot, "package.json"), "{}");
  for (const name of ["acceptance-authenticated-admission.js", "acceptance-durable-execution.js", "acceptance-host-configuration.js"]) {
    const file = path.join(installedRoot, "packages/piagent-core/extensions", name);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "export const fixture=1;\n");
  }
  const digest = value => createHash("sha256").update(value).digest("hex");
  const approvedRequest = `operator-request-v1:${digest("approved request")}`;
  const task = { taskRunId: "coverage-task", sessionId: "coverage-session", trace: { outcome: "pending" },
    operatorRequestDigest: approvedRequest, acceptanceReceipt: { criteria: [{ id: "criterion", hash: digest("criterion") }] } };
  const directory = path.join(root, "authority"), configPath = path.join(directory, "approval.json");
  if (configure) writeHostContractApproval({ directory, projectRoot, installedRoot, approved: true,
    operatorRequestDigest: approvedRequest,
    backend: { imageId: `sha256:${"b".repeat(64)}`, dockerSocket: "/unavailable-recovery-coverage.sock", timeoutMs: 25 },
    contracts: [{ criterionId: "criterion", criterionHash: digest("criterion"), sourcePath: "identity.js", exportName: "identity", maxAttempts: 1,
      checks: [{ id: "identity", cases: [{ id: "one", args: [{ type: "number", value: 1 }], expected: { outcome: "return", value: { type: "number", value: 1 } } }] }] }] });
  const ctx = { cwd: projectRoot, sessionManager: { getSessionId: () => task.sessionId } };
  const observations = { sourceReads: 0, verifierReads: 0 };
  mutate?.({ task, configPath, installedRoot, digest });
  const runtime = new IndependentAcceptanceRuntime({ installedRoot, configPath,
    state: { projectVerification: { currentDigest() { observations.verifierReads++; return null; } } },
    activeTask: () => task, authorizeSourceRead: () => { observations.sourceReads++; return false; } });
  t.after(async () => { await runtime.clear(ctx); fs.rmSync(root, { recursive: true, force: true }); });
  await runtime.activate(ctx); await runtime.prepare(ctx, task);
  return { runtime, ctx, task, observations, result: () => independentAcceptanceState(projectRoot, task, "unobserved-tree") };
}

test("configured runtime exposes unmatched request as an approval stop before any source or verifier work", async t => {
  const f = await fixture(t, ({ task, digest }) => { task.operatorRequestDigest = `operator-request-v1:${digest("unapproved request")}`; });
  const result = f.result();
  assert.equal(result.stopReason, "approval", "an empty runner set must not look like a successful configured intake");
  assert.equal(typeof result.block, "string");
  assert.equal(result.assessments.size, 0);
  assert.deepEqual(f.observations, { sourceReads: 0, verifierReads: 0 });
  await f.runtime.prepare(f.ctx, f.task);
  assert.equal(f.result().stopReason, "approval", "repeating unchanged intake must remain blocked");
});

for (const [name, mutate, options] of [
  ["missing config", undefined, { configure: false }],
  ["forged approval", ({ configPath }) => {
    const envelope = JSON.parse(fs.readFileSync(configPath, "utf8")); envelope.signature = "0".repeat(64);
    fs.writeFileSync(configPath, JSON.stringify(envelope));
  }],
  ["stale installed verifier", ({ installedRoot }) => {
    fs.appendFileSync(path.join(installedRoot, "packages/piagent-core/extensions/acceptance-host-configuration.js"), "// drift\n");
  }],
  ["criterion hash mismatch", ({ task, digest }) => { task.acceptanceReceipt.criteria[0].hash = digest("another criterion"); }]
]) test(`configured runtime rejects ${name} without execution`, async t => {
  const f = await fixture(t, mutate, options), result = f.result();
  assert.equal(result.stopReason, "approval"); assert.equal(typeof result.block, "string");
  assert.equal(result.assessments.size, 0);
  assert.deepEqual(f.observations, { sourceReads: 0, verifierReads: 0 });
});
