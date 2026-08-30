import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createSecretKey, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { openAcceptanceEvidenceStore } from "../packages/piagent-core/extensions/acceptance-evidence-store.js";
import { captureWorkspaceVerificationSnapshot } from "../packages/piagent-core/extensions/workspace-verification-snapshot.js";
import { RuntimeSessionState } from "../packages/piagent-core/runtime/session/runtime-state.ts";
import { registerToolResultHook } from "../packages/piagent-core/runtime/hooks/tool-result-hook.ts";
import { createRuntimeContractRunner } from "../packages/piagent-core/runtime/verification/runtime-contract-runner.ts";
import { reuseCurrentTreeExactVerifier } from "../packages/piagent-core/runtime/verification/exact-verifier-reuse.ts";

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
const imageId = process.env.PIAGENT_CONTRACT_EXECUTOR_IMAGE_ID;
const dockerSocket = process.env.PIAGENT_CONTRACT_EXECUTOR_SOCKET;
const integration = { skip: !imageId || !dockerSocket, timeout: 60000 };
const request = { scope: { taskRunId: "sum-run", criterionId: "sum" }, criterionHash: "a".repeat(64), maxAttempts: 3 };

function fixture(context) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-runtime-contract-")));
  const projectRoot = path.join(root, "project"), privateRoot = path.join(root, "authority");
  fs.mkdirSync(projectRoot, { mode: 0o700 }); fs.mkdirSync(privateRoot, { mode: 0o700 });
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(projectRoot, "init", "-q"); git(projectRoot, "config", "user.email", "test@example.com"); git(projectRoot, "config", "user.name", "Test");
  fs.writeFileSync(path.join(projectRoot, "sum.mjs"), "export const sum = (a, b) => a + b;\n");
  // Intentionally shallow project tests: independent tests must add real value.
  fs.writeFileSync(path.join(projectRoot, "sum.test.mjs"), "import assert from 'node:assert/strict'; import {sum} from './sum.mjs'; console.log('PIAGENT_PROJECT_VERIFIER_RAN'); assert.equal(typeof sum(2,3), 'number');\n");
  fs.writeFileSync(path.join(projectRoot, ".gitignore"), ".pi/\nignored.mjs\n");
  git(projectRoot, "add", "sum.mjs", "sum.test.mjs", ".gitignore"); git(projectRoot, "commit", "-qm", "baseline");
  const state = new RuntimeSessionState({ maxObservedContext: 10 });
  const ctx = { cwd: projectRoot, ui: { notify() {} }, getContextUsage: () => undefined,
    sessionManager: { getSessionId: () => "session-1", getSessionFile: () => undefined, getEntries: () => [], getBranch: () => [] } };
  const task = { taskId: "sum", taskRunId: "sum-run", sessionId: "session-1", trace: { outcome: "pending" },
    verifyCommands: ["node --test sum.test.mjs"], verifyEvidence: [], changeMode: "source-change", workingTreeDigestAlgorithm: "wt-content-v2",
    baselineFileDigests: captureWorkspaceVerificationSnapshot(projectRoot).snapshot,
    acceptanceReceipt: { promptHash: "b".repeat(64), criteria: [{ id: "sum", hash: request.criterionHash }] } };
  state.cacheTaskIdentity(ctx, task);
  const store = openAcceptanceEvidenceStore({ filePath: path.join(privateRoot, "evidence.sqlite"), projectRoot, key: createSecretKey(randomBytes(32)) });
  context.after(() => store.close());
  const approved = { store, sourcePath: "sum.mjs", authorizeSourceRead: () => true, exportName: "sum",
    imageId: imageId ?? `sha256:${"c".repeat(64)}`, dockerSocket: dockerSocket ?? "/unavailable-piagent-runtime.sock", verifierDigest: "d".repeat(64),
    checks: [{ id: "sum", cases: [{ id: "sum-2-3", args: [{ type: "number", value: 2 }, { type: "number", value: 3 }],
      expected: { outcome: "return", value: { type: "number", value: 5 } } }] }] };
  const handlers = new Map(), pi = { on: (name, handler) => handlers.set(name, handler) };
  registerToolResultHook(pi, { state, activeTask: () => task, maxManifestFiles: 10, flushObservedTaskContext: () => undefined,
    readProtectedPaths: () => [], recordObservedBash() {}, observedBashLedgerPath: () => path.join(projectRoot, ".pi", "test-bash.jsonl"),
    redactText: (value) => value, observedTaskContext: () => undefined, recordObservedTaskChanges() {}, recordObservedTaskVerification() {},
    extractLikelyPath: () => undefined, mutationTargets: () => [], isShellTool: (tool) => tool === "bash", telemetry() {}, now: () => new Date().toISOString() });
  let invocation = 0;
  function begin(command = task.verifyCommands[0]) {
    const event = { toolCallId: `verifier-${++invocation}`, toolName: "bash", input: { command } };
    state.rememberShellMutationSnapshot(ctx, event.toolName, event.input, event.toolCallId);
    return event;
  }
  async function verify(command = task.verifyCommands[0]) {
    const event = begin(command);
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync("/bin/sh", ["-c", command], { cwd: projectRoot, env, encoding: "utf8", timeout: 5000, maxBuffer: 65536 });
    if (result.error) throw result.error;
    assert.ok(Number.isInteger(result.status));
    if (command.includes("--test")) assert.match(result.stdout + result.stderr, /PIAGENT_PROJECT_VERIFIER_RAN/, "the nested test process must really execute its assertions");
    await handlers.get("tool_result")({ ...event, content: [{ type: "text", text: result.stdout + result.stderr }],
      details: { exitCode: result.status }, isError: result.status !== 0 }, ctx);
    return result.status;
  }
  const digest = () => state.projectVerification.currentDigest(ctx, task, captureWorkspaceVerificationSnapshot(projectRoot));
  const runner = (overrides = {}) => createRuntimeContractRunner({ state, context: ctx, getTask: () => task, approved, ...overrides });
  return { projectRoot, state, ctx, task, approved, store, handlers, begin, verify, digest, runner };
}

test("only actual matched tool hooks, not task JSON, supply current project-verifier evidence", async (context) => {
  const value = fixture(context), { task, digest, verify, state, ctx } = value;
  const current = captureWorkspaceVerificationSnapshot(ctx.cwd);
  task.verifyEvidence = [{ observed: true, exitCode: 0, matchedProfileCommand: true, command: task.verifyCommands[0],
    recordedAt: "2026-08-30T00:00:00.000Z", observedAt: "2026-08-30T00:00:00.000Z",
    preWorkingTreeDigest: current.digest, workingTreeDigest: current.digest,
    preWorkspaceRevisionDigest: current.workspaceRevisionDigest, workspaceRevisionDigest: current.workspaceRevisionDigest }];
  assert.equal(digest(), null);
  const reuse = (owner) => reuseCurrentTreeExactVerifier({ cwd: ctx.cwd, task, toolName: "bash", toolInput: { command: task.verifyCommands[0] },
    getHostProjectVerificationDigest: (snapshot, command) => owner.projectVerification.currentDigest(ctx, task, snapshot, command) });
  assert.equal(reuse(state).reused, false);
  assert.equal((await value.runner().run(request)).reason, "current-project-verifier-missing");
  assert.equal(value.store.latest(request.scope), null);
  assert.equal(await verify(), 0);
  assert.match(digest(), /^[a-f0-9]{64}$/);
  assert.equal(reuse(state).reused, true);
  const stable = digest();
  assert.equal(await verify(), 0); assert.equal(digest(), stable, "equivalent fresh passing observations do not waste another independent attempt");
  assert.equal(new RuntimeSessionState({ maxObservedContext: 10 }).projectVerification.currentDigest(ctx, task, current), null,
    "restart cannot promote copied JSON into a live observation");
  assert.equal(reuse(new RuntimeSessionState({ maxObservedContext: 10 })).reused, false, "restart must permit a real verifier refresh, not replace it with a no-op");
  state.clearSession(ctx); assert.equal(digest(), null);
});

test("all exact commands and the current task contract must have actual passing observations", async (context) => {
  const { task, verify, digest, ctx, state } = fixture(context);
  task.verifyCommands.push("node --check sum.mjs");
  await verify(); assert.equal(digest(), null);
  await verify(task.verifyCommands[1]); assert.match(digest(), /^[a-f0-9]{64}$/);
  const hash = task.acceptanceReceipt.criteria[0].hash;
  task.acceptanceReceipt.criteria[0].hash = "e".repeat(64); assert.equal(digest(), null);
  task.acceptanceReceipt.criteria[0].hash = hash;
  assert.match(digest(), /^[a-f0-9]{64}$/);
  const snapshot = captureWorkspaceVerificationSnapshot(ctx.cwd);
  for (const changed of [{ ...task, taskRunId: "another-run" }, { ...task, sessionId: "another-session" }, { ...task, trace: { outcome: "completed" } }]) {
    assert.equal(state.projectVerification.currentDigest(ctx, changed, snapshot), null);
  }
});

test("completed projections retain existing live observations but cannot mint new verification authority", async (context) => {
  const { task, verify, digest, ctx, state, runner } = fixture(context);
  await verify(); const observed = digest(); assert.ok(observed);
  task.trace.outcome = "completed";
  const projection = () => state.projectVerification.currentDigest(ctx, task, captureWorkspaceVerificationSnapshot(ctx.cwd), undefined, { completedProjection: true });
  assert.equal(digest(), null, "normal execution/reuse still requires a pending task");
  assert.equal(projection(), observed);
  assert.equal((await runner().run(request)).reason, "current-project-verifier-missing");
  await verify();
  assert.equal(projection(), null, "even a successful new result after completion invalidates the old observation");
  assert.equal(new RuntimeSessionState({ maxObservedContext: 10 }).projectVerification.currentDigest(ctx, task,
    captureWorkspaceVerificationSnapshot(ctx.cwd), undefined, { completedProjection: true }), null);
});

test("copied before-snapshots, duplicate results, contradictory success, and absent status invalidate old passes", async (context) => {
  const { state, ctx, task, verify, digest, begin, handlers } = fixture(context);
  await verify(); assert.ok(digest());
  const event = begin(), before = state.consumeShellVerificationSnapshot(ctx, event.toolName, event.input, event.toolCallId);
  state.projectVerification.observe(ctx, task, { ...event, details: { exitCode: 0 } }, structuredClone(before), captureWorkspaceVerificationSnapshot(ctx.cwd));
  assert.equal(digest(), null);
  await verify(); assert.ok(digest());
  for (const flags of [{ details: { exitCode: 0 }, isError: true }, {}]) {
    const called = begin(); await handlers.get("tool_result")({ ...called, content: [], ...flags }, ctx);
    assert.equal(digest(), null); await verify(); assert.ok(digest());
  }
  const duplicate = begin();
  await handlers.get("tool_result")({ ...duplicate, details: { exitCode: 0 }, content: [], isError: false }, ctx);
  assert.ok(digest());
  await handlers.get("tool_result")({ ...duplicate, details: { exitCode: 0 }, content: [], isError: false }, ctx);
  assert.equal(digest(), null, "a replay has no live before-invocation capability");
});

test("the actual installed Pi bash tool's success/error flags bind observations without invented exit details", {
  skip: !process.env.PIAGENT_REAL_PI_BASH_MODULE, timeout: 15000
}, async (context) => {
  const { createBashTool } = await import(pathToFileURL(process.env.PIAGENT_REAL_PI_BASH_MODULE).href);
  const { projectRoot, begin, handlers, ctx, digest } = fixture(context);
  const tool = createBashTool(projectRoot, { exposeSessionEnvironment: false, spawnHook: (input) => {
    const env = { ...input.env }; delete env.NODE_TEST_CONTEXT; return { ...input, env };
  } });
  async function execute() {
    const event = begin();
    let result, isError = false;
    try { result = await tool.execute(event.toolCallId, event.input); }
    catch (error) { isError = true; result = { content: [{ type: "text", text: error.message }] }; }
    assert.equal(result.details?.exitCode, undefined, "native Pi does not expose a numeric exit status here");
    assert.match(result.content.map((entry) => entry.text ?? "").join("\n"), /PIAGENT_PROJECT_VERIFIER_RAN/);
    // Pi's extension dispatcher supplies this explicit boolean after execute
    // resolves or throws; candidate stdout cannot set it.
    await handlers.get("tool_result")({ ...event, ...result, isError }, ctx);
    return isError;
  }
  assert.equal(await execute(), false); assert.ok(digest());
  fs.writeFileSync(path.join(projectRoot, "sum.mjs"), "export const sum = () => { throw new Error('bad'); };\n");
  assert.equal(await execute(), true); assert.equal(digest(), null);
});

test("a real failed project verifier replaces earlier success and drift during an invocation stays unknown", async (context) => {
  const { projectRoot, verify, digest, begin, handlers, ctx } = fixture(context);
  await verify(); assert.ok(digest());
  fs.writeFileSync(path.join(projectRoot, "sum.mjs"), "export const sum = () => { throw new TypeError('broken'); };\n");
  assert.equal(await verify(), 1); assert.equal(digest(), null);
  fs.writeFileSync(path.join(projectRoot, "sum.mjs"), "export const sum = (a,b) => a+b;\n");
  git(projectRoot, "add", "sum.mjs"); git(projectRoot, "commit", "-qm", "fixed baseline");
  const event = begin();
  fs.writeFileSync(path.join(projectRoot, "sum.mjs"), "export const sum = (a,b) => a-b;\n");
  git(projectRoot, "add", "sum.mjs"); git(projectRoot, "commit", "-qm", "changed during verifier");
  await handlers.get("tool_result")({ ...event, content: [], details: { exitCode: 0 }, isError: false }, ctx);
  assert.equal(digest(), null);
});

test("an in-flight verifier blocks old evidence, including overlapping equal commands", async (context) => {
  const { verify, digest, begin, handlers, ctx } = fixture(context);
  await verify(); assert.ok(digest());
  const first = begin(), second = begin();
  assert.equal(digest(), null);
  await handlers.get("tool_result")({ ...second, content: [], details: { exitCode: 0 }, isError: false }, ctx);
  assert.equal(digest(), null, "the older verifier is still active");
  await handlers.get("tool_result")({ ...first, content: [], details: { exitCode: 1 }, isError: true }, ctx);
  assert.equal(digest(), null);
  await verify(); assert.ok(digest());
});

test("the runtime callback refuses wrong criteria, ignored source, and source authorization denial before reserving", async (context) => {
  const { verify, runner, approved, projectRoot, store } = fixture(context);
  await verify();
  assert.equal((await runner().run({ ...request, criterionHash: "f".repeat(64) })).reason, "current-project-verifier-missing");
  fs.writeFileSync(path.join(projectRoot, "ignored.mjs"), "export const sum = (a,b) => a+b;\n");
  assert.equal((await runner({ approved: { ...approved, sourcePath: "ignored.mjs" } }).run(request)).reason, "current-project-verifier-missing");
  await assert.rejects(runner({ approved: { ...approved, authorizeSourceRead: () => false } }).run(request), /not authorized/);
  assert.equal(store.latest(request.scope), null);
});

test("actual runtime project tests feed independent execution; a shallow test pass cannot hide a real counterexample", integration, async (context) => {
  const { verify, runner, projectRoot, store, task, ctx } = fixture(context);
  await verify(); const active = runner();
  const pass = await active.run(request);
  assert.equal(pass.verdict, "pass", JSON.stringify(pass)); assert.equal(pass.completionAllowed, false);
  assert.equal(pass.evidence.observed.result.execution.cleanupConfirmed, true);
  await verify(); const cached = await active.run(request);
  assert.equal(cached.reused, true); assert.equal(cached.attemptId, pass.attemptId);
  fs.writeFileSync(path.join(projectRoot, "sum.mjs"), "export const sum = (a,b) => a-b;\n");
  git(projectRoot, "add", "sum.mjs"); git(projectRoot, "commit", "-qm", "incorrect clean implementation");
  assert.equal((await active.run(request)).reason, "current-project-verifier-missing");
  assert.equal(store.latest(request.scope).attempt, 1);
  assert.equal(await verify(), 0, "the real but shallow project test still passes");
  const failed = await active.run(request);
  assert.equal(failed.verdict, "fail", JSON.stringify(failed)); assert.equal(failed.reused, false);
  assert.equal(failed.evidence.observed.result.counterexamples.length, 1); assert.equal(store.latest(request.scope).attempt, 2);
  const restarted = runner({ state: new RuntimeSessionState({ maxObservedContext: 10 }), getTask: () => structuredClone(task), context: ctx });
  assert.equal((await restarted.run(request)).reason, "current-project-verifier-missing");
  assert.equal(store.latest(request.scope).attempt, 2, "a lost live observation cannot consume another execution implicitly");
});
