import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { buildAcceptanceReceipt, refreshAcceptanceReceipt, acceptanceCriticalRecoveryProjection } from "../packages/piagent-core/extensions/acceptance-receipt.js";
import { independentAcceptanceState, registerIndependentAcceptanceProvider } from "../packages/piagent-core/extensions/acceptance-independent-registry.js";
import { writeHostContractApproval } from "../packages/piagent-core/extensions/acceptance-host-configuration.js";
import { captureWorkspaceVerificationSnapshot } from "../packages/piagent-core/extensions/workspace-verification-snapshot.js";
import { operatorRequestDigest } from "../packages/piagent-core/extensions/task-state.js";
import { RuntimeSessionState } from "../packages/piagent-core/runtime/session/runtime-state.ts";
import { registerToolResultHook } from "../packages/piagent-core/runtime/hooks/tool-result-hook.ts";
import { IndependentAcceptanceRuntime } from "../packages/piagent-core/runtime/verification/independent-acceptance-runtime.ts";
import { independentVerificationRecovery } from "../packages/piagent-core/runtime/recovery/independent-verification-recovery.ts";

const imageId = process.env.PIAGENT_CONTRACT_EXECUTOR_IMAGE_ID;
const dockerSocket = process.env.PIAGENT_CONTRACT_EXECUTOR_SOCKET;
const bashModule = process.env.PIAGENT_REAL_PI_BASH_MODULE;
const integration = { skip: !imageId || !dockerSocket || !bashModule, timeout: 60000 };
const installedRoot = path.resolve(import.meta.dirname, "..");
const functional = "`take(items, options)` rejects zero, negative, and fractional `limit` values with `TypeError`.";
const unrelated = "`take(items, options)` rejects string `limit` values with `TypeError`.";
const correctSource = "function bound(o){const n=o.limit===undefined?20:o.limit;if(!Number.isSafeInteger(n)||n<=0)throw new TypeError('limit');return n} export function take(items,options={}){return items.slice(0,bound(options))}\n";
const badSource = "export function take(items,options={}){return items.slice(0,options.limit)}\n";

// This deliberately small public contract is a development canary, not a
// production-v2 mapping. Authority lives outside the test-owned project.
async function fixture(t, source = correctSource) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-assurance-projection-")));
  const projectRoot = path.join(root, "project"); fs.mkdirSync(projectRoot, { mode: 0o700 });
  const git = (...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-C", projectRoot, ...args], { stdio: "pipe" });
  git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  fs.writeFileSync(path.join(projectRoot, ".gitignore"), ".pi/\n");
  fs.writeFileSync(path.join(projectRoot, "limit.mjs"), source);
  // Actual project verifier runs, but does not prove the negative partitions.
  fs.writeFileSync(path.join(projectRoot, "limit.test.mjs"), "import assert from 'node:assert/strict';import {take} from './limit.mjs';assert.deepEqual(take([7],{limit:1}),[7]);console.log('ACTUAL_ASSURANCE_PROJECT_TEST');\n");
  git("add", "."); git("commit", "-qm", "development canary baseline");
  const built = buildAcceptanceReceipt({ summary: functional, expectedOutput: "A tested function.",
    acceptanceCriteria: [functional, unrelated], changeMode: "source-change", source: "runtime" });
  const task = { taskId: "assurance", taskRunId: "assurance-run", sessionId: "assurance-session", attempt: 1, maxAttempts: 2,
    summary: functional, expectedOutput: "A tested function.", acceptanceCriteria: built.acceptanceCriteria, acceptanceReceipt: built.receipt,
    operatorRequestDigest: operatorRequestDigest(`${functional}\n${unrelated}`), trace: { outcome: "pending" },
    changeMode: "source-change", mutationPolicy: "required", workingTreeDigestAlgorithm: "wt-content-v2",
    baselineFileDigests: captureWorkspaceVerificationSnapshot(projectRoot).snapshot,
    changedFiles: ["limit.mjs", "limit.test.mjs"], observedChangedFiles: ["limit.mjs", "limit.test.mjs"],
    verifyCommands: ["node --test limit.test.mjs"], verifyEvidence: [] };
  const criterion = task.acceptanceReceipt.criteria[0];
  assert.equal(criterion.obligation, "invalid-input-rejection");
  const { configPath } = writeHostContractApproval({ directory: path.join(root, "authority"), projectRoot, installedRoot,
    approved: true, operatorRequestDigest: task.operatorRequestDigest, backend: { imageId, dockerSocket, timeoutMs: 10000 },
    contracts: [{ criterionId: criterion.id, criterionHash: criterion.hash, sourcePath: "limit.mjs", exportName: "take", maxAttempts: 2,
      checks: [{ id: "explicit-invalid-limits", cases: [0, -1, 1.5].map((value, index) => ({ id: `invalid-${index}`,
        args: [{ type: "array", value: [] }, { type: "record", value: [{ key: "limit", value: { type: "number", value } }] }],
        expected: { outcome: "throw", errorClass: "TypeError" } })) }] }] });
  const state = new RuntimeSessionState({ maxObservedContext: 10 });
  const ctx = { cwd: projectRoot, ui: { notify() {} }, getContextUsage: () => undefined,
    sessionManager: { getSessionId: () => task.sessionId, getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] } };
  state.cacheTaskIdentity(ctx, task);
  const handlers = new Map(), pi = { on: (name, handler) => handlers.set(name, handler) };
  registerToolResultHook(pi, { state, activeTask: () => task, maxManifestFiles: 10, flushObservedTaskContext() {},
    readProtectedPaths: () => [], recordObservedBash() {}, observedBashLedgerPath: () => path.join(projectRoot, ".pi", "test-bash.jsonl"),
    redactText: value => value, observedTaskContext: () => undefined, recordObservedTaskChanges() {}, recordObservedTaskVerification() {},
    extractLikelyPath: () => undefined, mutationTargets: () => [], isShellTool: tool => tool === "bash", telemetry() {}, now: () => new Date().toISOString() });
  const { createBashTool } = await import(pathToFileURL(bashModule).href);
  const bash = createBashTool(projectRoot, { exposeSessionEnvironment: false, spawnHook: input => {
    const env = { ...input.env }; delete env.NODE_TEST_CONTEXT; return { ...input, env };
  } });
  const runtime = new IndependentAcceptanceRuntime({ state, installedRoot, configPath, activeTask: () => task, authorizeSourceRead: () => true });
  await runtime.activate(ctx);
  t.after(async () => { await runtime.clear(ctx); state.clearSession(ctx); fs.rmSync(root, { recursive: true, force: true }); });
  let invocation = 0;
  async function verify() {
    const before = captureWorkspaceVerificationSnapshot(projectRoot), command = task.verifyCommands[0];
    const event = { toolCallId: `verify-${++invocation}`, toolName: "bash", input: { command } };
    state.rememberShellMutationSnapshot(ctx, event.toolName, event.input, event.toolCallId);
    const result = await bash.execute(event.toolCallId, event.input);
    assert.match(result.content.map(x => x.text ?? "").join("\n"), /ACTUAL_ASSURANCE_PROJECT_TEST/);
    await handlers.get("tool_result")({ ...event, ...result, isError: false }, ctx);
    const after = captureWorkspaceVerificationSnapshot(projectRoot), recordedAt = new Date().toISOString();
    assert.equal(after.digest, before.digest);
    assert.ok(state.projectVerification.currentDigest(ctx, task, after));
    // Projection evidence comes from the just-executed tool, not a model claim.
    task.verifyEvidence.push({ command, observed: true, matchedProfileCommand: true, exitCode: 0, recordedAt, observedAt: recordedAt,
      preWorkingTreeDigest: before.digest, workingTreeDigest: after.digest,
      preWorkspaceRevisionDigest: before.workspaceRevisionDigest, workspaceRevisionDigest: after.workspaceRevisionDigest });
  }
  const digest = () => captureWorkspaceVerificationSnapshot(projectRoot).digest;
  const options = () => ({ cwd: projectRoot, changedFiles: task.changedFiles, currentWorkingTreeDigest: digest() });
  const assessment = () => independentAcceptanceState(projectRoot, task, digest()).assessments.get(criterion.id);
  return { root, projectRoot, task, criterion, state, ctx, runtime, verify, digest, options, assessment,
    refresh: () => refreshAcceptanceReceipt(task, options()), project: () => acceptanceCriticalRecoveryProjection(task, options()) };
}

test("current approved bounded execution supersedes syntax abstention in recovery guidance without satisfying sibling obligations", integration, async t => {
  const f = await fixture(t);
  await f.runtime.prepare(f.ctx, f.task);
  assert.notEqual(f.assessment()?.verdict, "pass", "approval alone cannot replace a current project verifier");
  await f.verify();
  assert.equal(f.refresh().receipt.criteria[0].status, "pending", "helper-based proof remains outside the legacy recognizer");
  assert.ok(f.project().some(x => x.criterionId === f.criterion.id));
  await f.runtime.prepare(f.ctx, f.task);
  const receipt = f.assessment(); assert.equal(receipt.verdict, "pass", JSON.stringify(receipt));
  assert.equal(receipt.assurance, "bounded-contract-tested"); assert.equal(receipt.sourceMutationAllowed, false);
  const refreshed = f.refresh(); assert.equal(refreshed.receipt.criteria[0].status, "satisfied");
  assert.ok(refreshed.criticalMissing.some(x => x.id !== f.criterion.id), "a partial plan must not cover a sibling criterion");
  assert.equal(f.project().some(x => x.criterionId === f.criterion.id), false, "current independent PASS must not prompt another static-proof repair");
  assert.ok(f.project().some(x => x.criterionId !== f.criterion.id), "other missing obligations remain visible");
});

test("a serialized receipt or task-authored satisfied status cannot suppress current recovery guidance", integration, async t => {
  const f = await fixture(t); await f.verify(); await f.runtime.prepare(f.ctx, f.task);
  const receipt = f.assessment(); assert.equal(receipt.verdict, "pass");
  const projectVerificationDigest = f.state.projectVerification.currentDigest(f.ctx, f.task, captureWorkspaceVerificationSnapshot(f.projectRoot));
  t.after(registerIndependentAcceptanceProvider(f.projectRoot, f.task, () => ({ projectVerificationDigest,
    entries: [{ criterionId: f.criterion.id, criterionHash: f.criterion.hash, receipt: structuredClone(receipt) }] })));
  f.criterion.status = "satisfied";
  assert.equal(f.refresh().receipt.criteria[0].status, "pending");
  assert.ok(f.project().some(x => x.criterionId === f.criterion.id));
});

test("source drift invalidates a current PASS and restores the missing-proof projection", integration, async t => {
  const f = await fixture(t); await f.verify(); await f.runtime.prepare(f.ctx, f.task);
  assert.equal(f.assessment().verdict, "pass");
  fs.appendFileSync(path.join(f.projectRoot, "limit.mjs"), "// source changed after verification\n");
  assert.equal(f.assessment().verdict, "unknown");
  assert.equal(f.refresh().receipt.criteria[0].status, "pending");
  assert.ok(f.project().some(x => x.criterionId === f.criterion.id));
});

test("a concrete independent counterexample remains blocked and repair guidance remains available", integration, async t => {
  const f = await fixture(t, badSource); await f.verify(); await f.runtime.prepare(f.ctx, f.task);
  assert.equal(f.assessment().verdict, "fail");
  assert.equal(f.refresh().receipt.criteria[0].status, "blocked");
  assert.ok(f.project().some(x => x.criterionId === f.criterion.id));
  const recovery = independentVerificationRecovery(f.projectRoot, f.task, f.digest());
  assert.match(recovery.hypothesisRef, /^counterexample:/);
  assert.equal(recovery.classification.sourceMutationPermission, "eligible-in-scope");
  assert.equal(recovery.classification.authorizesSourceMutation, false);
});
