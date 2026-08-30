import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadBenchmarkVerificationPlan, validateBenchmarkVerificationPlan } from "../scripts/benchmark-independent-verification.mjs";
import { parseBenchmarkArgs } from "../packages/piagent-core/benchmark/benchmark-cli.js";
import { installedContractVerifierDigest, openHostContractConfiguration } from "../packages/piagent-core/extensions/acceptance-host-configuration.js";
import { IndependentAcceptanceRuntime } from "../packages/piagent-core/runtime/verification/independent-acceptance-runtime.ts";
import { operatorRequestDigest } from "../packages/piagent-core/extensions/task-state.js";
import { resolveBenchmarkSuiteEntry } from "../packages/piagent-core/benchmark/benchmark-suite-runtime.js";
import { createRootSchemaRegistry } from "./helpers/root-schema-registry.mjs";
import { benchmarkResumeCommand } from "../scripts/benchmark-runner-support.mjs";
import { benchmarkVerificationRecordMatches, validBenchmarkVerificationObservation } from "../packages/piagent-core/benchmark/benchmark-independent-verification-observation.js";

const root = path.resolve(import.meta.dirname, "..");
const imageId = process.env.PIAGENT_CONTRACT_EXECUTOR_IMAGE_ID, dockerSocket = process.env.PIAGENT_CONTRACT_EXECUTOR_SOCKET;

function fixture(t) {
  const directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-benchmark-verification-")));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const projectRoot = path.join(directory, "project"), suiteRoot = path.join(directory, "suite"), installedRoot = path.join(directory, "installed");
  for (const target of [projectRoot, suiteRoot, installedRoot]) fs.mkdirSync(target);
  fs.writeFileSync(path.join(installedRoot, "package.json"), "{}");
  for (const name of ["acceptance-authenticated-admission.js", "acceptance-durable-execution.js", "acceptance-host-configuration.js"]) {
    const target = path.join(installedRoot, "packages/piagent-core/extensions", name);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, "export const fixture=1;\n");
  }
  const catalog = JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/benchmark-independent-verification-plan.valid.json")));
  catalog.verifierDigest = installedContractVerifierDigest(installedRoot);
  const plan = catalog.scenarios[0].plans[0];
  plan.operatorRequestDigest = operatorRequestDigest("Preserve the number.");
  plan.contracts[0].sourcePath = "identity.js";
  if (imageId && dockerSocket) plan.backend = { imageId, dockerSocket, timeoutMs: 10000 };
  fs.writeFileSync(path.join(suiteRoot, "prompt.md"), "Preserve the number.\n");
  const scenarios = [{ id: "identity", prompt: "prompt.md" }, { id: "unconfigured", prompt: "prompt.md" }];
  const file = path.join(directory, "plan.json"), authority = path.join(directory, "authority");
  const save = () => fs.writeFileSync(file, JSON.stringify(catalog), { mode: 0o600 }); save();
  const options = { file, installedRoot, suiteDigest: catalog.suiteDigest, scenarios, suiteRoot, resolveSuiteEntry: resolveBenchmarkSuiteEntry };
  const load = (overrides = {}) => loadBenchmarkVerificationPlan({ ...options, ...overrides });
  const prepare = (loaded = load(), overrides = {}) => loaded.prepare({ scenarioId: "identity", surface: "piagent", projectRoot, directory: authority, approved: true, ...overrides });
  return { directory, projectRoot, suiteRoot, installedRoot, authority, file, catalog, plan, scenarios, options, save, load, prepare };
}

test("catalog preview binds exact requests and exposes only digests/counts, never expected answers", (t) => {
  const f = fixture(t), loaded = f.load();
  assert.equal(loaded.isCurrent(), true);
  assert.equal(fs.existsSync(f.authority), false);
  assert.equal(loaded.identity.scenarios[0].requests[0].criterionCount, 1);
  for (const privateValue of ["Preserve the number.", "identity.js", "expected", f.file, f.plan.backend.dockerSocket]) {
    assert.equal(JSON.stringify(loaded.identity).includes(privateValue), false);
  }
  assert.throws(() => f.prepare(loaded, { approved: false }), /explicit/);
  assert.equal(fs.existsSync(f.authority), false);
  assert.equal(f.prepare(loaded, { surface: "codex-cli", approved: false }), null);
  assert.equal(f.prepare(loaded, { surface: "raw-pi", approved: false }), null);
  assert.equal(f.prepare(loaded, { scenarioId: "unconfigured" }).observe([]).status, "not-configured");
  assert.equal(fs.existsSync(f.authority), false);
  const prepared = f.prepare(loaded);
  assert.equal(prepared.environment.PIAGENT_INDEPENDENT_VERIFICATION_CONFIG, path.join(f.authority, "approval.json"));
  assert.equal(prepared.observe([]).status, "partial", "provisioned authority is not observed execution");
  assert.equal(prepared.observe([]).attempts, 0);
  assert.throws(() => f.prepare(loaded), /EEXIST/);
});

for (const [name, mutate] of [
  ["wrong suite", f => { f.catalog.suiteDigest = "f".repeat(64); f.save(); }],
  ["wrong verifier", f => { f.catalog.verifierDigest = "f".repeat(64); f.save(); }],
  ["unlisted request", f => { f.plan.operatorRequestDigest = operatorRequestDigest("Another request."); f.save(); }],
  ["duplicate scenario", f => { f.catalog.scenarios.push(structuredClone(f.catalog.scenarios[0])); f.save(); }],
  ["duplicate request", f => { f.catalog.scenarios[0].plans.push(structuredClone(f.plan)); f.save(); }],
  ["unknown scenario", f => { f.catalog.scenarios[0].scenarioId = "unknown"; f.save(); }],
  ["public plan", f => fs.chmodSync(f.file, 0o644)],
  ["linked plan", f => fs.linkSync(f.file, path.join(f.directory, "linked.json"))],
  ["symlinked plan", f => { fs.renameSync(f.file, `${f.file}.retained`); fs.symlinkSync(`${f.file}.retained`, f.file); }]
]) test(`catalog refuses ${name} without minting authority`, (t) => {
  const f = fixture(t); mutate(f); assert.throws(() => f.load()); assert.equal(fs.existsSync(f.authority), false);
});

test("journey approval follows the actual turn prompts and detects post-preview drift", (t) => {
  const f = fixture(t);
  f.scenarios[0].userJourney = { turns: [{ id: "second", prompt: "second.md" }] };
  fs.writeFileSync(path.join(f.suiteRoot, "second.md"), "Second request.\n");
  assert.throws(() => f.load(), /not sent/);
  f.plan.operatorRequestDigest = operatorRequestDigest("Second request."); f.save();
  const loaded = f.load(), prepared = f.prepare(loaded);
  fs.appendFileSync(f.file, " ");
  assert.equal(loaded.isCurrent(), false);
  assert.equal(prepared.observe([]).status, "unavailable");
  assert.throws(() => f.prepare(loaded, { directory: path.join(f.directory, "other") }), /changed/);
});

test("catalog schema and semantic validation agree, including nested plan constraints", (t) => {
  const f = fixture(t), validate = createRootSchemaRegistry(root).get("benchmark-independent-verification-plan");
  assert.equal(validate(f.catalog), true, JSON.stringify(validate.errors));
  assert.equal(validateBenchmarkVerificationPlan(f.catalog), f.catalog);
  f.plan.backend.imageId = "worker:latest";
  assert.equal(validate(f.catalog), false); assert.throws(() => validateBenchmarkVerificationPlan(f.catalog));
});

test("verification approval is separate from cost confirmation and appears explicitly in resume instructions", () => {
  const options = parseBenchmarkArgs(["--verification-plan", "/private/plan.json", "--yes"]);
  assert.equal(options.approveVerification, false);
  assert.equal(parseBenchmarkArgs(["--verification-plan", "/private/plan.json", "--approve-verification"]).approveVerification, true);
  assert.throws(() => parseBenchmarkArgs(["--approve-verification", "--approve-verification"]));
  assert.match(benchmarkResumeCommand({ runRoot: "/private/run", verificationRequired: true }), /--approve-verification --yes$/);
  assert.doesNotMatch(benchmarkResumeCommand({ runRoot: "/private/run" }), /approve-verification/);
});

test("two exact requests use independent runtime contracts and retain actual pass/fail executions", { skip: !imageId || !dockerSocket, timeout: 60000 }, async (t) => {
  const f = fixture(t), second = structuredClone(f.plan);
  fs.writeFileSync(path.join(f.suiteRoot, "second.md"), "Return two instead.\n");
  f.scenarios[0].userJourney = { turns: [{ id: "first", prompt: "prompt.md" }, { id: "second", prompt: "second.md" }] };
  second.operatorRequestDigest = operatorRequestDigest("Return two instead.");
  second.contracts[0].criterionHash = "f".repeat(64); second.contracts[0].checks[0].cases[0].expected.value.value = 2;
  f.catalog.scenarios[0].plans.push(second); f.save();
  fs.writeFileSync(path.join(f.projectRoot, "identity.js"), "export const identity = x => x;\n");
  for (const args of [["init", "-q"], ["add", "identity.js"], ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"]]) {
    execFileSync("git", args, { cwd: f.projectRoot, stdio: "pipe" });
  }
  const prepared = f.prepare(), config = openHostContractConfiguration({ configPath: prepared.environment.PIAGENT_INDEPENDENT_VERIFICATION_CONFIG,
    projectRoot: f.projectRoot, installedRoot: f.installedRoot });
  t.after(() => config.close());
  const tasks = [];
  let active;
  const sessionId = "two-request-session", ctx = { cwd: f.projectRoot, sessionManager: { getSessionId: () => sessionId } };
  // Unit-level host project-verifier state; worker execution and durable
  // request selection are real. Actual project tool hooks have separate E2E coverage.
  const runtime = new IndependentAcceptanceRuntime({ state: { projectVerification: { currentDigest: () => "a".repeat(64) } },
    installedRoot: f.installedRoot, configPath: prepared.environment.PIAGENT_INDEPENDENT_VERIFICATION_CONFIG,
    activeTask: () => active, authorizeSourceRead: () => true });
  await runtime.activate(ctx); t.after(() => runtime.clear(ctx));
  let priorPreparation;
  for (const [index, plan] of f.catalog.scenarios[0].plans.entries()) {
    const approved = config.forRequest(plan.operatorRequestDigest), contract = approved.contracts[0];
    const task = { taskRunId: `request-${index}`, sessionId, trace: { outcome: "pending" }, operatorRequestDigest: plan.operatorRequestDigest,
      acceptanceReceipt: { criteria: [{ id: contract.criterionId, hash: contract.criterionHash }] } };
    tasks.push(task); active = task;
    if (priorPreparation) assert.equal(priorPreparation.isCurrent(), false);
    priorPreparation = await runtime.prepare(ctx, task);
    const event = config.store.latest({ taskRunId: task.taskRunId, criterionId: contract.criterionId });
    assert.equal(event?.phase, "settled");
    const result = JSON.parse(event.evidenceText);
    assert.equal(result.verdict, index === 0 ? "pass" : "fail", JSON.stringify(result));
    if (index === 0) assert.equal(prepared.observe(tasks).status, "partial", "first request cannot cover the second");
  }
  const observation = prepared.observe(tasks);
  assert.equal(observation.status, "observed", JSON.stringify(observation));
  assert.equal(observation.attempts, 2); assert.equal(observation.workersObserved, 2);
  assert.equal(validBenchmarkVerificationObservation(observation), true);
  const identity = f.load().identity, record = { surface: "piagent", scenarioId: "identity", resolved: false, independentVerification: observation };
  assert.equal(benchmarkVerificationRecordMatches(record, identity), true);
  assert.equal(benchmarkVerificationRecordMatches({ ...record, resolved: true }, identity), false, "an observed failure cannot be scored as resolution");
  for (const mutate of [value => { value.attempts += 1; }, value => { value.workersObserved += 1; },
    value => { value.requests[0].runs[0].criteria[0].criterionHash = "0".repeat(64); },
    value => { value.requests.splice(1, 1); }, value => { value.requests[0].runs[0].criteria[0].workerObserved = false; }]) {
    const changed = structuredClone(observation); mutate(changed);
    assert.equal(benchmarkVerificationRecordMatches({ ...record, independentVerification: changed }, identity), false);
  }
  assert.equal(benchmarkVerificationRecordMatches({ ...record, independentVerification: prepared.observe([]), resolved: true }, identity), false);
  assert.equal(benchmarkVerificationRecordMatches({ ...record, independentVerification: undefined }, identity), false);
  assert.equal(benchmarkVerificationRecordMatches({ ...record, surface: "codex-cli" }, identity), false);
  assert.deepEqual(observation.requests.map(entry => entry.runs[0].criteria[0].verdict), ["pass", "fail"]);
  assert.equal(Object.hasOwn(observation, "completionAllowed"), false, "measurement is not completion authority");
  assert.equal(prepared.observe([tasks[0], tasks[0]]).status, "unavailable", "duplicate task IDs cannot inflate measured attempts");
  assert.equal(prepared.observe(tasks.map(task => ({ ...task, taskRunId: `foreign-${task.taskRunId}` }))).status, "partial");
  active = { ...tasks[0], taskRunId: "unapproved", operatorRequestDigest: operatorRequestDigest("Not approved.") };
  await runtime.prepare(ctx, active);
  assert.equal(config.store.latest({ taskRunId: active.taskRunId, criterionId: f.plan.contracts[0].criterionId }), null);
  active = { ...tasks[0], taskRunId: "wrong-criterion", acceptanceReceipt: tasks[1].acceptanceReceipt };
  await runtime.prepare(ctx, active);
  assert.equal(config.store.latest({ taskRunId: active.taskRunId, criterionId: f.plan.contracts[0].criterionId }), null);
});
