import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createSecretKey, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openAcceptanceEvidenceStore } from "../packages/piagent-core/extensions/acceptance-evidence-store.js";
import { createDurableContractRunner } from "../packages/piagent-core/extensions/acceptance-durable-execution.js";

const imageId = process.env.PIAGENT_CONTRACT_EXECUTOR_IMAGE_ID;
const dockerSocket = process.env.PIAGENT_CONTRACT_EXECUTOR_SOCKET;
const integration = { skip: !imageId || !dockerSocket, timeout: 60000 };
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" });
const scope = { taskRunId: "task-1", criterionId: "sum" };
const request = { scope, criterionHash: "a".repeat(64), maxAttempts: 3 };
const checks = () => [{ id: "sum", cases: [{ id: "sum-1", args: [{ type: "number", value: 2 }, { type: "number", value: 3 }],
  expected: { outcome: "return", value: { type: "number", value: 5 } } }] }];

function fixture(context) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-durable-execution-")));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const projectRoot = path.join(directory, "project"), authority = path.join(directory, "authority");
  fs.mkdirSync(projectRoot, { mode: 0o700 }); fs.mkdirSync(authority, { mode: 0o700 });
  git(projectRoot, "init", "-q"); git(projectRoot, "config", "user.name", "Test"); git(projectRoot, "config", "user.email", "test@example.com");
  const sourceFile = path.join(projectRoot, "sum.mjs"); fs.writeFileSync(sourceFile, "export const sum = (a, b) => a + b;\n");
  git(projectRoot, "add", "sum.mjs"); git(projectRoot, "commit", "-qm", "test baseline");
  const storeOptions = { filePath: path.join(authority, "evidence.sqlite"), projectRoot, key: createSecretKey(randomBytes(32)) };
  const stores = []; context.after(() => { for (const store of stores) store.close(); });
  const open = () => { const store = openAcceptanceEvidenceStore(storeOptions); stores.push(store); return store; };
  const store = open();
  const options = { projectRoot, sourcePath: "sum.mjs", authorizeSourceRead: () => true, checks: checks(), exportName: "sum",
    imageId: imageId ?? `sha256:${"b".repeat(64)}`, dockerSocket: dockerSocket ?? "/unavailable-piagent-test.sock", verifierDigest: "c".repeat(64),
    getProjectVerificationDigest: () => "d".repeat(64), store };
  return { projectRoot, sourceFile, options, open, store, storeOptions };
}

test("missing current project verification and pre-cancellation reserve no attempt", async (context) => {
  const { options, store } = fixture(context);
  const missing = createDurableContractRunner({ ...options, getProjectVerificationDigest: () => null });
  assert.equal((await missing.run(request)).reason, "current-project-verifier-missing");
  assert.equal(store.latest(scope), null);
  const cancelled = createDurableContractRunner(options);
  assert.equal((await cancelled.run({ ...request, signal: AbortSignal.abort() })).reason, "cancelled-before-reservation");
  assert.equal(store.latest(scope), null);
});

test("unavailable backend errors are durably settled without implicit retries", async (context) => {
  const { options, store } = fixture(context);
  const runner = createDurableContractRunner({ ...options, dockerSocket: "/piagent-test-backend-does-not-exist.sock" });
  const first = await runner.run(request);
  assert.equal(first.verdict, "error"); assert.equal(first.reused, false); assert.equal(first.completionAllowed, false);
  const second = await runner.run(request);
  assert.equal(second.verdict, "error"); assert.equal(second.reused, true);
  assert.equal(store.latest(scope).attempt, 1);
  assert.equal((await runner.run({ ...request, retry: true })).reused, false);
  assert.equal(store.latest(scope).attempt, 2);
});

test("real execution can be authenticated and reused after reopening the host store", integration, async (context) => {
  const { options, open, store } = fixture(context);
  const runner = createDurableContractRunner(options);
  // Constructor retains a detached host plan, not a mutable caller reference.
  options.checks[0].cases[0].expected.value.value = 999;
  const first = await runner.run(request);
  assert.equal(first.verdict, "pass", JSON.stringify(first));
  assert.equal(first.reused, false); assert.equal(first.completionAllowed, false);
  const runId = first.evidence.observed.result.execution.runId;
  assert.equal(runId, first.attemptId);
  store.close();
  const reopened = open(), resumed = createDurableContractRunner({ ...options, checks: checks(), store: reopened });
  const cached = await resumed.run(request);
  assert.equal(cached.verdict, "pass", JSON.stringify(cached)); assert.equal(cached.reused, true);
  assert.equal(cached.evidence.observed.result.execution.runId, runId);
  assert.equal(cached.attemptId, first.attemptId); assert.equal(reopened.latest(scope).sequence, 2);
});

test("a changed clean commit runs again and its captured counterexample replaces the cached pass", integration, async (context) => {
  const { options, projectRoot, sourceFile, store } = fixture(context), runner = createDurableContractRunner(options);
  const first = await runner.run(request); assert.equal(first.verdict, "pass");
  fs.writeFileSync(sourceFile, "export const sum = (a, b) => a - b;\n");
  git(projectRoot, "add", "sum.mjs"); git(projectRoot, "commit", "-qm", "invalid new baseline");
  const changed = await runner.run(request);
  assert.equal(changed.verdict, "fail", JSON.stringify(changed)); assert.equal(changed.reused, false);
  assert.equal(changed.evidence.observed.result.counterexamples.length, 1);
  const cachedFailure = await runner.run(request);
  assert.equal(cachedFailure.verdict, "fail"); assert.equal(cachedFailure.reused, true);
  assert.equal(store.latest(scope).attempt, 2);
});

test("project-verifier drift during execution or cache admission never reuses a passing verdict", integration, async (context) => {
  const { options, store } = fixture(context);
  let calls = 0;
  const runner = createDurableContractRunner({ ...options, getProjectVerificationDigest: () => ++calls === 1 ? "d".repeat(64) : null });
  const result = await runner.run(request);
  assert.equal(result.evidence.observed.verdict, "pass"); assert.equal(result.verdict, "unknown");
  assert.equal(store.latest(scope).phase, "settled");
  const fixed = createDurableContractRunner(options);
  assert.equal((await fixed.run({ ...request, retry: true })).verdict, "pass");
  calls = 0;
  const cached = await runner.run(request);
  assert.equal(cached.verdict, "unknown"); assert.equal(cached.reason, "cached-evidence-binding-drift");
  assert.equal(store.latest(scope).attempt, 2);
});

test("concurrent runner calls share one reservation and do not spawn duplicate executions", integration, async (context) => {
  const { options, store } = fixture(context), runner = createDurableContractRunner(options);
  const results = await Promise.all([runner.run(request), runner.run(request)]);
  assert.deepEqual(results.map((value) => value.verdict).sort(), ["pass", "unknown"]);
  assert.ok(results.some((value) => value.reason === "evidence-pending"));
  assert.equal(store.latest(scope).attempt, 1);
});

test("host death during a real worker run preserves its exact identity and blocks duplicate execution", integration, async (context) => {
  const { projectRoot, sourceFile, options, open, store, storeOptions } = fixture(context);
  fs.writeFileSync(sourceFile, "export function sum(a, b) { const start=Date.now(); while(Date.now()-start<75) {} return a+b; }\n");
  git(projectRoot, "add", "sum.mjs"); git(projectRoot, "commit", "-qm", "bounded slow test worker");
  const slowChecks = checks();
  slowChecks[0].cases = Array.from({ length: 64 }, (_, index) => ({ ...checks()[0].cases[0], id: `case-${index}` }));
  const runnerPath = fileURLToPath(new URL("../packages/piagent-core/extensions/acceptance-durable-execution.js", import.meta.url));
  const storePath = fileURLToPath(new URL("../packages/piagent-core/extensions/acceptance-evidence-store.js", import.meta.url));
  const script = `import {createDurableContractRunner} from ${JSON.stringify(runnerPath)};
    import {openAcceptanceEvidenceStore} from ${JSON.stringify(storePath)}; import {createSecretKey} from 'node:crypto';
    const input=JSON.parse(process.env.PIAGENT_DURABLE_TEST_INPUT);
    const raw=openAcceptanceEvidenceStore({...input.store,key:createSecretKey(Buffer.from(input.key,'hex'))});
    const store={...raw,reserve(value){const result=raw.reserve(value); if(result.status==='reserved') process.send(result.event.attemptId); return result;}};
    const runner=createDurableContractRunner({...input.runner,store,authorizeSourceRead:()=>true,getProjectVerificationDigest:()=>input.verification});
    await runner.run(input.request); raw.close();`;
  const input = { store: { filePath: storeOptions.filePath, projectRoot }, key: storeOptions.key.export().toString("hex"),
    runner: { projectRoot, sourcePath: options.sourcePath, exportName: options.exportName, checks: slowChecks,
      imageId, dockerSocket, verifierDigest: options.verifierDigest }, verification: "d".repeat(64), request };
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: { ...process.env, PIAGENT_DURABLE_TEST_INPUT: JSON.stringify(input) } });
  let attemptId, errors = "";
  child.stderr.on("data", (data) => { errors = (errors + data).slice(-4096); });
  const docker = (...args) => execFileSync("docker", ["--host", `unix://${dockerSocket}`, ...args], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", timeout: 5000 });
  function ownedContainer() {
    if (!attemptId) return null;
    try {
      const [container] = JSON.parse(docker("inspect", "--type", "container", `piagent-contract-${attemptId}`));
      if (container.Image === imageId && container.Config?.Labels?.["io.piagent.contract-execution"] === attemptId) return container;
    } catch {}
    return null;
  }
  context.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolve) => { child.once("exit", resolve); child.kill("SIGKILL"); });
    }
    const owned = ownedContainer();
    if (owned) docker("rm", "--force", owned.Id);
  });
  attemptId = await new Promise((resolve, reject) => { child.once("message", resolve); child.once("error", reject); child.once("exit", () => reject(new Error(errors))); });
  let container = null;
  const startedDeadline = Date.now() + 7000;
  while (Date.now() < startedDeadline) {
    container = ownedContainer();
    if (container?.State?.Running) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.equal(container?.State?.Running, true, "the actual isolated worker must have started before killing its host");
  await new Promise((resolve) => { child.once("exit", resolve); child.kill("SIGKILL"); });
  assert.equal(store.latest(scope).phase, "reserved");
  assert.equal(store.latest(scope).attemptId, attemptId);
  const reopened = open();
  const resumed = createDurableContractRunner({ ...options, checks: slowChecks, store: reopened });
  assert.equal((await resumed.run(request)).reason, "evidence-pending");
  assert.equal(reopened.latest(scope).attempt, 1);
  const stoppedDeadline = Date.now() + 12000;
  while (Date.now() < stoppedDeadline && ownedContainer()?.State?.Running) await new Promise((resolve) => setTimeout(resolve, 50));
  const stopped = ownedContainer();
  assert.ok(stopped && stopped.State.Running === false, "the isolated worker terminates even after host death");
  docker("rm", stopped.Id);
  assert.equal(ownedContainer(), null);
  reopened.recordStoppedAttempt({ scope, attemptId, executorStopped: true });
  assert.equal((await resumed.run(request)).reason, "evidence-interrupted");
  assert.equal(reopened.latest(scope).attempt, 1);
});
