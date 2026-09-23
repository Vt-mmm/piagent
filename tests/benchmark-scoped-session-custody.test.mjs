import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { materializeBenchmarkCandidate } from "../packages/piagent-core/benchmark/benchmark-candidate.js";
import { bindSessionTask, operatorRequestDigest, writeTaskContract, workingTreeSnapshot
} from "../packages/piagent-core/extensions/task-state.js";
import { benchmarkVerificationOperatorRequest } from "../scripts/benchmark-independent-verification.mjs";
import { openScopedMediationEvidence, scopedBrokerArmDigest, scopedBrokerProfileDigest,
  scopedMediationFactObservation
} from "../packages/piagent-core/runtime/verification/composite-scoped-mediation.ts";
import { BENCHMARK_SCOPED_SESSION_CUSTODY_VERSION, createBenchmarkScopedSessionCustody
} from "../scripts/benchmark-scoped-session-custody.mjs";
import { BENCHMARK_SCOPED_SESSION_FACTORY_VERSION, BENCHMARK_SCOPED_SESSION_REQUEST_VERSION
} from "../scripts/benchmark-codex-journey.mjs";
import { resolveBenchmarkScopedSessionControls } from "../scripts/benchmark-session.mjs";
import { scopedFrozenQualificationIdentity } from "../scripts/benchmark-scoped-frozen-qualification.mjs";
import { scopedCommonRuntimeClosureIdentity, scopedContextPolicySha256,
  scopedProjectVerificationPlanBinding, scopedToolDefinitionsSha256,
  SCOPED_PROJECT_VERIFIER_POLICY
} from "../scripts/benchmark-scoped-verification-supervisor.mjs";

import { captureTaskBaselineManifest } from "../packages/piagent-core/runtime/inspection/source-evidence-store.ts";
import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/working-tree-digest.js";

async function captureVerifierBaseline(f, source) {
  execFileSync("git", ["-C", f.workspace, "init", "-q"]);
  fs.writeFileSync(path.join(f.workspace, ".gitignore"), ".pi/\nprotected.env\n");
  execFileSync("git", ["-C", f.workspace, "add", "--", ".gitignore", "input.txt", "package.json", "src", "scripts", "test"]);
  source.createdAt = new Date().toISOString();
  source.baselineFileDigests = workingTreeSnapshot(f.workspace);
  source.baselineChangedFiles = Object.keys(source.baselineFileDigests);
  await captureTaskBaselineManifest({ projectRoot: f.workspace, taskId: source.taskId,
    taskRunId: source.taskRunId, sessionId: source.sessionId, capturedAt: source.createdAt,
    baselineTreeDigest: workingTreeEvidenceDigest(source.baselineFileDigests),
    isProtectedProjectPath: candidate => candidate === "protected.env" });
  f.mediationTask = source;
}

const root = path.resolve(import.meta.dirname, ".."),
  nodeCommand = fs.realpathSync(process.execPath),
  brokerScript = path.join(root, "scripts", "benchmark-scoped-tool-broker.mjs"),
  taskTemplate = JSON.parse(fs.readFileSync(path.join(root, "evals", "fixtures", "task-contract.valid.json"), "utf8"));
const sha = value => createHash("sha256").update(value).digest("hex");

function writableTree(rootPath) {
  if (!fs.existsSync(rootPath)) return;
  const pending = [rootPath], directories = [];
  while (pending.length) {
    const current = pending.pop(), info = fs.lstatSync(current);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) { directories.push(current);
      for (const name of fs.readdirSync(current)) pending.push(path.join(current, name)); }
    else fs.chmodSync(current, 0o600);
  }
  for (const directory of directories) fs.chmodSync(directory, 0o700);
}

function projectPolicy(projectRoot) {
  const files = directory => {
    const result = [], pending = [path.join(projectRoot, directory)];
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

function setup(t, surface, { projectVerification = false, projectVerificationOutcome = "passed" } = {}) {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "session-custody-")));
  t.after(() => { writableTree(temporary); fs.rmSync(temporary, { recursive: true, force: true }); });
  const source = path.join(temporary, "source"), candidateRoot = path.join(temporary, "candidate"),
    assetsRoot = path.join(temporary, "assets"), sdkRoot = path.join(temporary, "sdk"),
    workspace = path.join(temporary, "workspace"), custodyRoot = path.join(temporary, "custody");
  for (const directory of [source, assetsRoot, sdkRoot, custodyRoot])
    fs.mkdirSync(directory, { mode: 0o700 });
  if (projectVerification) fs.cpSync(path.join(root, "benchmarks", "production-v1", "project"), workspace,
    { recursive: true, errorOnExist: true });
  else fs.mkdirSync(workspace, { mode: 0o700 });
  fs.chmodSync(workspace, 0o700);
  if (projectVerificationOutcome === "failed") fs.writeFileSync(path.join(workspace, "test/smoke.test.js"),
    'import test from "node:test"; test("expected failure",()=>{ throw new Error("fixture-failure"); });\n');
  fs.writeFileSync(path.join(source, ".gitignore"), "evidence/\n");
  fs.writeFileSync(path.join(source, "candidate.js"), "export const value = 1;\n");
  execFileSync("git", ["-C", source, "init", "-q"]); execFileSync("git", ["-C", source, "add", "."]);
  execFileSync("git", ["-C", source, "-c", "user.name=G0", "-c", "user.email=g0@invalid",
    "commit", "-qm", "fixture"]);
  const frozenCandidate = materializeBenchmarkCandidate(source, candidateRoot),
    indexPath = path.join(temporary, "candidate-index.json"), indexBytes = Buffer.from(`${JSON.stringify(frozenCandidate.index)}\n`);
  fs.writeFileSync(indexPath, indexBytes, { mode: 0o400 });
  fs.writeFileSync(path.join(assetsRoot, "asset.txt"), "asset\n");
  fs.writeFileSync(path.join(sdkRoot, "sdk.mjs"), "export const sdk = 1;\n");
  const materialPath = path.join(workspace, "input.txt"), protectedPath = path.join(workspace, "protected.env");
  fs.writeFileSync(materialPath, "visible\n", { mode: 0o600 });
  fs.writeFileSync(protectedPath, "SYNTHETIC_SECRET\n", { mode: 0o600 });
  const planPath = path.join(temporary, "plan.json"), publicContractPath = path.join(temporary, "contract.json");
  fs.writeFileSync(planPath, '{"version":1,"authority":"none","scenarioId":"scenario-one"}\n');
  fs.writeFileSync(publicContractPath, '{"version":"public-contract-addendum-v2"}\n');
  const message = "Turn one", operatorRequest = benchmarkVerificationOperatorRequest({ message, workflow: null }),
    turnBody = { version: 1, suiteId: "suite-one", scenarioId: "scenario-one",
      planRef: "plan:scenario-one", variantRole: "boundary", turnIndex: 1, turnId: "request",
      promptPath: "prompts/scenario-one.md", promptSha256: sha(message), promptBytes: Buffer.byteLength(message),
      workflow: null, reconnectBefore: false, receiptUncertain: false,
      operatorRequestDigest: operatorRequestDigest(operatorRequest) },
    catalog = { schemaVersion: 1, kind: "benchmark-public-input-catalog-v1", authority: "none",
      suiteId: "suite-one", scenarioCount: 1, publicInputCount: 1,
      variantRoleCounts: { boundary: 1, interaction: 0, "adversarial-recovery": 0 }, scenarios: [{
        scenarioId: "scenario-one", variantRole: "boundary", planRef: "plan:scenario-one", turnCount: 1,
        turns: [{ index: 1, turnId: "request", promptPath: turnBody.promptPath,
          promptSha256: turnBody.promptSha256, promptBytes: turnBody.promptBytes, workflow: null,
          reconnectBefore: false, receiptUncertain: false, operatorRequestDigest: turnBody.operatorRequestDigest,
          bindingDigest: sha(JSON.stringify(turnBody)) }] }] },
    qualification = { version: 4, candidateRoot: fs.realpathSync(candidateRoot),
      assetsRoot: fs.realpathSync(assetsRoot), sdkRoot: fs.realpathSync(sdkRoot), candidateIndexPath: indexPath,
      candidateIndexSha256: sha(indexBytes) }, actual = scopedFrozenQualificationIdentity(qualification,
      scopedCommonRuntimeClosureIdentity().sha256),
    modelIdentity = { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "medium", serviceTier: null },
    contextPolicySha256 = scopedContextPolicySha256({ version: 2, systemPrompt: "Use only scoped tools.",
      allowedUserMessages: [operatorRequest], removableUserMessages: [] }),
    expectedArmBinding = { turnIndex: 1, sha256: scopedBrokerArmDigest({
      armId: surface === "piagent" ? "B" : "A", sourceSha256: actual.sourceSha256,
      assetTreeSha256: actual.assetTreeSha256, brokerClosureSha256: actual.brokerClosureSha256,
      toolDefinitionsSha256: scopedToolDefinitionsSha256(), contextPolicySha256,
      sdkTreeSha256: actual.sdkTreeSha256 }) };
  const verifierPolicy = projectVerification ? projectPolicy(workspace) : null, verifierTimeoutMs = 10000,
    verifierPlanDigest = projectVerification ? scopedProjectVerificationPlanBinding({ projectRoot: workspace,
      nodeCommand, policy: verifierPolicy, timeoutMs: verifierTimeoutMs }).planDigest : null;
  const resolveResources = ({ expectedUserMessages }) => {
    const bytes = fs.readFileSync(materialPath), materials = [{ id: "input", relativePath: "input.txt",
      sha256: sha(bytes), bytes: bytes.length, readable: true, writable: false, protected: false },
      { id: "protected", relativePath: "protected.env", sha256: null, bytes: null,
        readable: false, writable: false, protected: true }];
    return { profile: "document", contextPolicy: { version: 2, systemPrompt: "Use only scoped tools.",
      allowedUserMessages: [...expectedUserMessages], removableUserMessages: [] }, materialRoot: workspace,
      materials, verifications: [], verificationBridge: null,
      verificationHost: projectVerification ? { version: "scoped-project-verification-host-v1",
        verificationId: "project-current", timeoutMs: verifierTimeoutMs, policy: verifierPolicy,
        expectedPlanDigest: verifierPlanDigest } : null };
  };
  const create = (overrides = {}) => createBenchmarkScopedSessionCustody({ custodyRoot, nodeCommand, brokerScript,
    runtimePath: surface === "codex-cli" ? nodeCommand : null, qualification, catalog,
    runId: "run-one", armId: surface === "piagent" ? "B" : "A", suiteId: "suite-one",
    expectedArmBinding,
    scenarioId: "scenario-one", surface, repeat: 1, infrastructureAttempt: 1,
    configurationSha256: "1".repeat(64), planPath, publicContractPath, workspace, modelIdentity,
    turns: [{ id: "request", message }], resolveResources, ...overrides });
  return { temporary, workspace, custodyRoot, planPath, protectedPath, message, operatorRequest, catalog,
    qualification, actual, modelIdentity, verifierPlanDigest, create };
}

function piFixture(router) {
  const handlers = new Map(), definitions = [], state = { active: [] };
  const pi = { registerTool(tool) { definitions.push(tool); }, on(name, handler) { handlers.set(name, handler); },
    setActiveTools(names) { state.active = [...names]; },
    getActiveTools() { return state.active.map(name => ({ name })); } };
  router.extensionFactory(pi);
  return { handlers, definitions };
}

function projectVerifierDisposition(f, evidence, verifyCommands = ["npm run type-check", "npm run lint", "npm test", "npm run test:e2e"]) {
  const manifest = JSON.parse(evidence.manifestBytes), inputSha256 = sha(fs.readFileSync(path.join(f.workspace, "input.txt"))),
    verifier = { id: "verifier", kind: "project-verifier-current",
      parameters: { commandSetDigest: f.verifierPlanDigest } },
    context = { id: "context", kind: "context-current",
      parameters: { requiredMaterialIds: ["input"], delivery: "actual-tool-result-or-prompt" } },
    scope = { id: "scope", kind: "workspace-scope",
      parameters: { allowedWriteMaterialIds: [], requireCompleteMutationJournal: true } },
    policy = { id: "policy", kind: "tool-policy-complete",
      parameters: { profileDigest: scopedBrokerProfileDigest("document"), requireExclusiveMediation: true } },
    materials = [{ id: "input", relativePath: "input.txt", mode: "current", sha256: inputSha256 },
      { id: "protected", relativePath: "protected.env", mode: "protected", sha256: null }],
    plan = { identity: { configDigest: manifest.identity.measurementConfigurationSha256,
      armDigest: scopedBrokerArmDigest(manifest.identity) }, materialBindings: materials.map(item => ({ ...item })) },
    contract = { facts: [verifier, context, scope, policy] }, task = { ...f.mediationTask, verifyCommands },
    capability = openScopedMediationEvidence(evidence, { projectRoot: f.workspace, task,
      operationRef: manifest.identity.operationId, messageRequestId: manifest.identity.nonce,
      plan, contract, materials });
  return scopedMediationFactObservation(capability, { fact: verifier, plan, contract, task, materials, workspace: {} });
}

function boundaryInput(t, overrides = {}) {
  const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "scoped-session-boundary-")));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  return { factory: null, directCodexScopedBroker: null, directPiScopedBrokerRouter: null,
    journeyTurns: [{ id: "request", message: "Turn one" }], runId: "run-one", suiteId: "suite-one",
    scenarioId: "scenario-one", surface: "codex-cli", repeat: 1, infrastructureAttempt: 1,
    configurationSha256: "1".repeat(64), workspace: temporary,
    model: "openai-codex/gpt-5.6-luna", thinking: "medium", serviceTier: null, ...overrides };
}

function boundaryCodexController() {
  return { version: BENCHMARK_SCOPED_SESSION_CUSTODY_VERSION, authority: "none", surface: "codex-cli",
    piScopedBrokerRouter: null, codexScopedBroker: {
      version: "codex-scoped-broker-turn-factory-v1", authority: "none", async openTurn() {}
    } };
}

function boundaryPiController() {
  const router = { version: "scoped-pi-operation-router-v1", authority: "none", toolNames: [],
    extensionFactory() {}, beginOperation() {}, settlementEvidence() {}, assertProviderDispatchReady() { return true; },
    takeFatalProviderBoundaryError() { return null; }, assertOwnership() {},
    async dispose() {}, status() {} };
  return { version: BENCHMARK_SCOPED_SESSION_CUSTODY_VERSION, authority: "none", surface: "piagent",
    piScopedBrokerRouter: router, codexScopedBroker: null };
}

test("session custody opens one just-in-time Codex turn with exact catalog and workspace binding", async t => {
  const f = setup(t, "codex-cli"), controller = f.create();
  assert.equal(controller.authority, "none"); assert.equal(controller.piScopedBrokerRouter, null);
  const originalOpen = fs.openSync; let protectedOpens = 0, custody;
  fs.openSync = (file, ...args) => {
    if (file === f.protectedPath) { protectedOpens++; throw Object.assign(new Error("protected-open"), { code: "EACCES" }); }
    return originalOpen(file, ...args);
  };
  try { custody = await controller.codexScopedBroker.openTurn({ turnIndex: 1, turnId: "request",
    inputText: f.message, threadId: null, workspace: f.workspace }); }
  finally { fs.openSync = originalOpen; }
  assert.equal(protectedOpens, 0);
  assert.equal(custody.measurementBinding.catalogSha256, sha(JSON.stringify(f.catalog)));
  assert.equal(custody.measurementBinding.turnBindingSha256, f.catalog.scenarios[0].turns[0].bindingDigest);
  assert.equal(custody.measurementBinding.operatorRequestDigest, operatorRequestDigest(f.operatorRequest));
  assert.equal(custody.measurementBinding.runtimeSha256, sha(fs.readFileSync(nodeCommand)));
  await assert.rejects(controller.codexScopedBroker.openTurn({ turnIndex: 1, turnId: "request",
    inputText: f.message, threadId: null, workspace: f.workspace }), /session-custody-(codex-turn|turn-order)/);
  await custody.dispose();
});

test("session custody rejects a selected signed arm mismatch before creating turn custody", async t => {
  const f = setup(t, "codex-cli"), controller = f.create({
    expectedArmBinding: { turnIndex: 1, sha256: "f".repeat(64) }
  });
  await assert.rejects(controller.codexScopedBroker.openTurn({ turnIndex: 1, turnId: "request",
    inputText: f.message, threadId: null, workspace: f.workspace }), /session-custody-arm-drift/);
  assert.deepEqual(fs.readdirSync(f.custodyRoot), []);
});

test("Codex turn custody rechecks static files and selected arm immediately before dispatch", async t => {
  const f = setup(t, "codex-cli"), controller = f.create(), custody = await controller.codexScopedBroker.openTurn({
    turnIndex: 1, turnId: "request", inputText: f.message, threadId: null, workspace: f.workspace
  });
  assert.equal(custody.assertPredispatch(), true);
  fs.appendFileSync(custody.brokerConfigPath, " ");
  assert.throws(() => custody.assertPredispatch(), /custody-static-drift/);
  await custody.dispose();
});

test("session custody binds the native Pi task and operation before opening its journal", async t => {
  const f = setup(t, "piagent"), controller = f.create(), router = controller.piScopedBrokerRouter,
    runtime = piFixture(router), sessionId = "session-native";
  const source = { ...structuredClone(taskTemplate), taskId: "task-one", taskRunId: "task-one-run",
    sessionId, sessionName: "Benchmark task", operatorRequest: f.operatorRequest,
    operatorRequestDigest: operatorRequestDigest(f.operatorRequest), trace: { outcome: "pending" } };
  delete source.authoritySnapshot;
  const task = writeTaskContract(f.workspace, source); bindSessionTask(f.workspace, sessionId, task.sessionName, task);
  await runtime.handlers.get("session_start")();
  const finish = router.beginOperation({ sessionId, operationRef: "operation-one",
    messageRequestId: "message-one", inputText: f.message });
  await runtime.handlers.get("before_agent_start")({}, { cwd: f.workspace,
    sessionManager: { getSessionId: () => sessionId } });
  const observed = await runtime.definitions[0].execute("call-one", { materialId: "input" });
  assert.equal(Buffer.from(observed.details.bytes, "base64").toString(), "visible\n");
  await runtime.handlers.get("agent_end")(); finish("operation-settled");
  const evidence = router.settlementEvidence();
  assert.equal(evidence.status.actions, 1); assert.equal(evidence.status.ended, true);
});

test("session custody hosts one real project verifier and removes its private listener at Pi settlement", {
  timeout: 30000
}, async t => {
  const f = setup(t, "piagent", { projectVerification: true }), controller = f.create(),
    router = controller.piScopedBrokerRouter, runtime = piFixture(router), sessionId = "session-project-verifier";
  const source = { ...structuredClone(taskTemplate), taskId: "task-project-verifier",
    taskRunId: "task-project-verifier-run", sessionId, sessionName: "Project verifier task",
    operatorRequest: f.operatorRequest, operatorRequestDigest: operatorRequestDigest(f.operatorRequest),
    trace: { outcome: "pending" } };
  delete source.authoritySnapshot;
  await captureVerifierBaseline(f, source);
  const task = writeTaskContract(f.workspace, source); bindSessionTask(f.workspace, sessionId, task.sessionName, task);
  await runtime.handlers.get("session_start")();
  const finish = router.beginOperation({ sessionId, operationRef: "operation-project-verifier",
    messageRequestId: "message-project-verifier", inputText: f.message });
  await runtime.handlers.get("before_agent_start")({}, { cwd: f.workspace,
    sessionManager: { getSessionId: () => sessionId } });
  const observed = await runtime.definitions[2].execute("call-project-verifier",
    { verificationId: "project-current" });
  assert.equal(observed.details.commandSetDigest, f.verifierPlanDigest);
  assert.equal(observed.details.status, "completed");
  assert.equal(observed.details.verdict, "observation-recorded");
  assert.equal(observed.details.receipt.evidence.outcome, "passed");
  await runtime.handlers.get("agent_end")(); finish("operation-settled");
  const evidence = router.settlementEvidence(), rows = new TextDecoder().decode(evidence.journalBytes).trim()
    .split("\n").map(JSON.parse).map(row => row.body), receipt = rows.find(row => row.type === "receipt")?.receipt;
  assert.equal(evidence.status.actions, 1); assert.equal(receipt.planDigest, f.verifierPlanDigest);
  assert.equal(receipt.evidence.outcome, "passed");
  const disposition = projectVerifierDisposition(f, evidence);
  assert.equal(disposition.status, "pass"); assert.equal(disposition.counterexampleRef, null);
  assert.deepEqual(disposition.reasonCodes, []); assert.match(disposition.observationDigest, /^[a-f0-9]{64}$/);
  // A signed PASS for the fixed Node worker cannot cover different native
  // commands. In particular the docs profile also requires git diff checking.
  for (const verifyCommands of [["git diff --check", "npm test"], ["npm test -- --different-suite"], [], undefined]) {
    const observed = projectVerifierDisposition(f, evidence, verifyCommands === undefined ? null : verifyCommands);
    assert.equal(observed.status, "unknown", JSON.stringify({ verifyCommands, observed }));
    assert.ok(observed.reasonCodes.includes("incomplete-mediation"));
  }
  assert.equal(projectVerifierDisposition(f, evidence, ["npm test"]).status, "pass");
  const turnRoots = fs.readdirSync(f.custodyRoot).map(name => path.join(f.custodyRoot, name));
  assert.equal(turnRoots.length, 1);
  const brokerConfig = JSON.parse(fs.readFileSync(path.join(turnRoots[0], "config.json"), "utf8"));
  assert.equal(fs.existsSync(path.dirname(brokerConfig.verificationBridge.socketPath)), false);
  assert.equal(fs.existsSync(path.join(turnRoots[0], "verification.sock")), false);
  assert.equal(fs.readdirSync(turnRoots[0]).some(name => name.startsWith("project-verifier-")), false);
});

test("signed project-verifier failure becomes composite FAIL rather than infrastructure UNKNOWN", {
  timeout: 30000
}, async t => {
  const f = setup(t, "piagent", { projectVerification: true, projectVerificationOutcome: "failed" }),
    controller = f.create(), router = controller.piScopedBrokerRouter, runtime = piFixture(router),
    sessionId = "session-project-failure";
  const source = { ...structuredClone(taskTemplate), taskId: "task-project-failure",
    taskRunId: "task-project-failure-run", sessionId, sessionName: "Project failure task",
    operatorRequest: f.operatorRequest, operatorRequestDigest: operatorRequestDigest(f.operatorRequest),
    trace: { outcome: "pending" } };
  delete source.authoritySnapshot;
  await captureVerifierBaseline(f, source);
  const task = writeTaskContract(f.workspace, source); bindSessionTask(f.workspace, sessionId, task.sessionName, task);
  await runtime.handlers.get("session_start")();
  const finish = router.beginOperation({ sessionId, operationRef: "operation-project-failure",
    messageRequestId: "message-project-failure", inputText: f.message });
  await runtime.handlers.get("before_agent_start")({}, { cwd: f.workspace,
    sessionManager: { getSessionId: () => sessionId } });
  const observed = await runtime.definitions[2].execute("call-project-failure",
    { verificationId: "project-current" });
  assert.equal(observed.details.status, "completed");
  assert.equal(observed.details.verdict, "observation-recorded");
  assert.equal(observed.details.receipt.evidence.outcome, "failed");
  assert.deepEqual(observed.details.receipt.evidence.failedCommands, ["test", "test:e2e"]);
  await runtime.handlers.get("agent_end")(); finish("operation-settled");
  const evidence = router.settlementEvidence(), disposition = projectVerifierDisposition(f, evidence);
  assert.equal(disposition.status, "fail"); assert.deepEqual(disposition.reasonCodes, ["verification-failed"]);
  assert.match(disposition.counterexampleRef, /^[a-f0-9]{64}$/);
  const turnRoot = path.join(f.custodyRoot, fs.readdirSync(f.custodyRoot)[0]),
    config = JSON.parse(fs.readFileSync(path.join(turnRoot, "config.json"), "utf8"));
  assert.equal(fs.existsSync(path.dirname(config.verificationBridge.socketPath)), false);
});

test("session custody rejects plan drift before creating any turn custody", async t => {
  const f = setup(t, "codex-cli"), controller = f.create();
  fs.appendFileSync(f.planPath, " \n");
  await assert.rejects(controller.codexScopedBroker.openTurn({ turnIndex: 1, turnId: "request",
    inputText: f.message, threadId: null, workspace: f.workspace }), /session-custody-static-drift/);
  assert.deepEqual(fs.readdirSync(f.custodyRoot), []);
});

test("session boundary preserves legacy controls when no registered factory is present", async t => {
  const direct = { legacy: true }, controls = await resolveBenchmarkScopedSessionControls(boundaryInput(t, {
    directCodexScopedBroker: direct, journeyTurns: null
  }));
  assert.equal(controls.codexScopedBroker, direct);
  assert.equal(controls.piScopedBrokerRouter, null);
});

test("session boundary passes one frozen exact request to a registered Codex factory", async t => {
  let observed;
  const factory = { version: BENCHMARK_SCOPED_SESSION_FACTORY_VERSION, authority: "none",
    async openSession(request) { observed = request; return boundaryCodexController(); } };
  const controls = await resolveBenchmarkScopedSessionControls(boundaryInput(t, { factory }));
  assert.equal(controls.codexScopedBroker.version, "codex-scoped-broker-turn-factory-v1");
  assert.equal(controls.piScopedBrokerRouter, null);
  assert.deepEqual(Object.keys(observed), ["version", "authority", "runId", "suiteId", "scenarioId",
    "surface", "repeat", "infrastructureAttempt", "configurationSha256", "workspace", "model",
    "thinking", "serviceTier", "turns"]);
  assert.equal(observed.version, BENCHMARK_SCOPED_SESSION_REQUEST_VERSION);
  assert.equal(Object.isFrozen(observed), true);
  assert.equal(Object.isFrozen(observed.turns), true);
  assert.equal(Object.isFrozen(observed.turns[0]), true);
  assert.deepEqual(observed.turns[0], { id: "request", message: "Turn one", workflow: null,
    reconnectBefore: false, receiptUncertain: false });
});

test("session boundary validates the Pi controller and denies conflicts before factory work", async t => {
  const piFactory = { version: BENCHMARK_SCOPED_SESSION_FACTORY_VERSION, authority: "none",
    async openSession() { return boundaryPiController(); } };
  const controls = await resolveBenchmarkScopedSessionControls(boundaryInput(t, { factory: piFactory,
    surface: "piagent" }));
  assert.equal(controls.piScopedBrokerRouter.version, "scoped-pi-operation-router-v1");
  let opened = 0;
  const denied = { ...piFactory, async openSession() { opened++; return boundaryPiController(); } };
  await assert.rejects(resolveBenchmarkScopedSessionControls(boundaryInput(t, { factory: denied,
    directPiScopedBrokerRouter: {}, surface: "piagent" })), /session-boundary-direct-control-conflict/);
  assert.equal(opened, 0);
  await assert.rejects(resolveBenchmarkScopedSessionControls(boundaryInput(t, { factory: piFactory,
    journeyTurns: null, surface: "piagent" })), /session-boundary-journey-required/);
});

test("session boundary rejects widened factories and mismatched controllers", async t => {
  await assert.rejects(resolveBenchmarkScopedSessionControls(boundaryInput(t, { factory: {
    version: BENCHMARK_SCOPED_SESSION_FACTORY_VERSION, authority: "none", async openSession() {
      return boundaryCodexController();
    }, extra: true
  } })), /session-boundary-factory/);
  const factory = { version: BENCHMARK_SCOPED_SESSION_FACTORY_VERSION, authority: "none",
    async openSession() { return { ...boundaryCodexController(), authority: "approve" }; } };
  await assert.rejects(resolveBenchmarkScopedSessionControls(boundaryInput(t, { factory })),
    /session-boundary-controller/);
});
