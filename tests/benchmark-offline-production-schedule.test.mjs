import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { loadBenchmarkSuite } from "../packages/piagent-core/benchmark/benchmark-suite-runtime.js";
import { createBenchmarkCandidateGuard } from "../packages/piagent-core/benchmark/benchmark-forensics.js";
import { createBenchmarkExecutionGuard } from "../packages/piagent-core/benchmark/benchmark-execution-guard.js";
import { createBenchmarkTransportCircuit } from "../packages/piagent-core/benchmark/benchmark-transport-evidence.js";
import { benchmarkAcceptancePolicyBinding } from "../packages/piagent-core/benchmark/benchmark-diagnostic-treatment.js";
import { benchmarkTreeIdentity } from "../packages/piagent-core/benchmark/benchmark-tree-identity.js";
import { emptyBenchmarkLedgerBinding, inspectBenchmarkLedger } from "../packages/piagent-core/benchmark/benchmark-ledger.js";
import { expectedBenchmarkRecord, pairedBenchmarkVariantMatched } from "../packages/piagent-core/benchmark/benchmark-record-validation.js";
import { runOfflineBenchmarkSchedule } from "../scripts/benchmark-runner-schedule.mjs";
import { executionOrder, pairedChunk } from "../scripts/benchmark-runner-support.mjs";
import { startBenchmarkBudgetLaunch } from "../scripts/benchmark-budget-launcher.mjs";
import { readBenchmarkBudgetControl, assertBenchmarkBudgetBinding, openBenchmarkBudgetCore, BENCHMARK_BUDGET_CONTEXT } from "../scripts/benchmark-budget-runtime.mjs";
import { durableTurnPosition, runPiagentWebUiJourney } from "../scripts/benchmark-webui-journey.mjs";
import { withJourneyEnvironment } from "./helpers/production-journey-workspace.mjs";
import { launchScriptedProductionGateway } from "./helpers/scripted-production-gateway.mjs";
import { loadProductionPublicWitnesses, productionScheduleScripts, publicSolution,
  publicIncidentResponse, refusalResponses } from "./helpers/production-schedule-witnesses.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const rootSeed = "production-v3-seven-axis-v1-640";
const fixtureUsage = Object.freeze({ input: 7, output: 3, cacheRead: 2, cacheWrite: 0, totalTokens: 12 });
const digest = value => createHash("sha256").update(value).digest("hex");

// This is an OFFLINE measurement rehearsal. The real shared schedule, session
// preparation, SDK/HTTP/WS, evaluator, WAL, ledger, and budget are exercised.
// Only model messages/usage, the gateway launcher, and Codex process output are
// fixtures. No provider-wire/production registration or paid authority exists.
async function rehearse(t, { maximum = 108, unknownCodex = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-offline-schedule-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previousEnvironment = new Map();
  for (const name of Object.keys(process.env)) {
    if (/^(?:PIAGENT_|OPENAI_|ANTHROPIC_|CODEX_)/.test(name) && name !== "PIAGENT_REAL_PI_HOST") {
      previousEnvironment.set(name, process.env[name]); delete process.env[name];
    }
  }
  for (const name of ["HOME", "CODEX_HOME", "PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME"]) {
    if (!previousEnvironment.has(name)) previousEnvironment.set(name, process.env[name]);
    const home = path.join(root, `empty-${name.toLowerCase()}`); fs.mkdirSync(home, { mode: 0o700 }); process.env[name] = home;
  }
  t.after(() => { for (const [name, value] of previousEnvironment) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  } });
  const { suite, suiteRoot } = loadBenchmarkSuite("production-v3", repositoryRoot);
  const allOrder = executionOrder(suite, 2, ["piagent", "codex-cli"], rootSeed);
  assert.equal(allOrder.length, 108);
  const fullOrder = allOrder.slice(0, maximum);
  const runId = `offline-schedule-${maximum}-${randomUUID()}`, runRoot = path.join(root, "run");
  const agentDir = path.join(root, "agent"), staticRoot = path.join(root, "static");
  for (const dir of [runRoot, agentDir, staticRoot]) fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(staticRoot, "index.html"), "<!doctype html><main>Offline transport fixture</main>");
  const witnesses = loadProductionPublicWitnesses(repositoryRoot);
  const candidateGuard = createBenchmarkCandidateGuard(repositoryRoot); candidateGuard.freeze();
  const suiteIdentity = benchmarkTreeIdentity(suiteRoot, { rejectSymlinks: true });
  const suiteDigest = suiteIdentity.contentDigest;
  const executionGuard = createBenchmarkExecutionGuard({ candidateGuard, suiteRoot, suiteIdentity });
  const runtimeCommands = { node: { resolvedPath: process.execPath }, git: { resolvedPath: "git" }, bash: { resolvedPath: "bash" } };
  const execution = { model: "fixture/fixture", thinking: "off", serviceTier: "default",
    surfaces: ["piagent", "codex-cli"], repeats: 2, timeoutSeconds: 180, infrastructureRetries: 0,
    codexMode: "controlled", codexBaseline: "stock", piagentTreatment: "release-defaults" };
  const configurationDigest = digest(JSON.stringify({ kind: "offline-scripted-schedule-v1", execution, rootSeed }));
  const policyPath = path.join(root, "test-only-policy.json"), statePath = path.join(root, "test-only-budget.json");
  fs.writeFileSync(policyPath, JSON.stringify({ schemaVersion: 1, kind: "benchmark-management-budget-v1",
    authorityDecision: "test-only-offline-not-D026", policy: { semantics: "management-thresholds",
      maxProviderAttempts: maximum, freshTokenThreshold: 3000000, activeWallTimeMsThreshold: 14400000 },
    binding: { runRoot, candidateDigest: candidateGuard.provenance.contentDigest, suiteDigest, execution,
      plannedAttempts: fullOrder.map((item, index) => ({ orderIndex: index + 1, scenarioId: item.scenario.id,
        surface: item.surface, repeat: item.repeat })) } }));
  const options = { ...execution, output: runRoot, budgetPolicy: policyPath, budgetState: statePath,
    retryDelaySeconds: 0, stopAfterFailedPair: false, measurementOnly: true };
  const control = readBenchmarkBudgetControl({ options, sourceRoot: repositoryRoot });
  assertBenchmarkBudgetBinding(control, { options, candidateDigest: candidateGuard.provenance.contentDigest, suiteDigest, fullOrder });
  const ledgerPath = path.join(runRoot, "runs.jsonl"), infrastructureLedgerPath = path.join(runRoot, "infrastructure.jsonl");
  const runs = [], manifest = { schemaVersion: 1, runId, configurationDigest,
    transportCircuitBreaker: createBenchmarkTransportCircuit(), ledger: emptyBenchmarkLedgerBinding() };
  const state = { ledgerBinding: manifest.ledger, preservePiRuntime: false };
  const observations = [], codexWorkspaces = new Map(), codexHomes = new Set();
  let current;
  const localCommand = async (command, args, commandOptions = {}) => {
    if (command === "offline-codex-fixture") {
      assert.equal(current.surface, "codex-cli");
      assert.equal(commandOptions.env.HOME, commandOptions.env.CODEX_HOME);
      assert.ok(commandOptions.env.CODEX_HOME !== process.env.CODEX_HOME);
      assert.equal(fs.existsSync(path.join(commandOptions.env.CODEX_HOME, "auth.json")), false);
      codexHomes.add(commandOptions.env.CODEX_HOME);
      const workspace = commandOptions.cwd;
      const codexState = codexWorkspaces.get(workspace) ?? { threadId: randomUUID(), turns: 0 };
      codexWorkspaces.set(workspace, codexState);
      const turn = current.scenario.userJourney.turns[codexState.turns++];
      assert.ok(turn, "no additional Codex turn");
      assert.equal(commandOptions.input, fs.readFileSync(path.join(suiteRoot, turn.prompt), "utf8").trim());
      const events = [{ type: "thread.started", thread_id: codexState.threadId }, { type: "turn.started" }];
      let response = refusalResponses.get(current.scenario.id);
      if (!response && current.scenario.id === "incident-diagnosis") response = publicIncidentResponse(workspace);
      if (!response) {
        if (turn.id !== "scout" && turn.id !== "recover") {
          const [file, source] = publicSolution(current.scenario.id, workspace);
          fs.writeFileSync(path.join(workspace, file), source);
          events.push({ type: "item.completed", item: { id: `edit-${codexState.turns}`, type: "file_change",
            status: "completed", changes: [{ path: file, kind: "update" }] } });
        }
        response = turn.id === "scout" ? "Read-only public source review complete; implement the requested change next."
          : "The requested public source implementation is present. The benchmark evaluator must determine correctness.";
      }
      events.push({ type: "item.completed", item: { id: `message-${codexState.turns}`, type: "agent_message", text: response } });
      if (unknownCodex) events.push({ type: "turn.failed", error: { message: "offline injected terminal usage unavailable" } });
      else events.push({ type: "turn.completed", usage: { input_tokens: 9, cached_input_tokens: 2,
        cache_write_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 0 } });
      const stdout = events.map(event => JSON.stringify(event)).join("\n") + "\n";
      commandOptions.onStdoutChunk(stdout, { observedAtSeconds: 0 });
      return { code: unknownCodex ? 1 : 0, signal: null, timedOut: false, stdout, stderr: "", durationSeconds: 0 };
    }
    assert.ok([process.execPath, "git", "bash"].includes(command), "provider executable is forbidden");
    if (command === "bash") assert.equal(args[0], path.join(repositoryRoot, "scripts/init-project.sh"));
    const env = { ...commandOptions.env }; delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(command, args, { cwd: commandOptions.cwd, env, input: commandOptions.input,
      encoding: "utf8", timeout: commandOptions.timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    return { code: result.status ?? 1, signal: result.signal ?? null, timedOut: result.error?.code === "ETIMEDOUT",
      stdout: result.stdout ?? "", stderr: result.stderr ?? String(result.error?.message ?? ""), durationSeconds: 0 };
  };
  const piagentWebUiJourney = input => withJourneyEnvironment(input.environment, async () => {
    assert.equal(current.surface, "piagent");
    assert.equal(process.env.PIAGENT_INDEPENDENT_VERIFICATION_CONFIG, undefined);
    const metrics = {}, turnScripts = productionScheduleScripts({ repositoryRoot, workspace: input.workspace,
      scenario: current.scenario, turns: input.turns, witnesses });
    let gateway;
    try {
      const journey = await runPiagentWebUiJourney({ ...input, staticRoot,
        qualifiedGatewayLauncher: async launchOptions => gateway = await launchScriptedProductionGateway({
          ...launchOptions, repositoryRoot, workspace: input.workspace, metrics, fixtureUsage, turnScripts, declaredTurns: input.turns }) });
      assert.equal(journey.timedOut, false);
      if (journey.candidateOutcome) {
        assert.equal(journey.journeyReceipt.completed, false);
        assert.ok(journey.candidateOutcome.turnIndex >= 1 && journey.candidateOutcome.turnIndex <= input.turns.length);
        assert.equal(journey.journeyReceipt.turns.length, journey.candidateOutcome.turnIndex,
          "retain every executed turn before the real journey stops on quality failure");
      } else assert.equal(journey.journeyReceipt.completed, true);
      if (!journey.candidateOutcome) assert.equal(journey.journeyReceipt.turns.length, input.turns.length);
      assert.deepEqual(gateway.extensionErrors, []);
      assert.equal(metrics.authCalls, 0); assert.equal(metrics.providerRegistrations, 0);
      assert.equal(metrics.declaredTurns.length, journey.journeyReceipt.turns.length);
      const transcript = await gateway.readClosedTranscript(journey.journeyReceipt.sessionRef);
      for (const [index, turn] of journey.journeyReceipt.turns.entries()) {
        const durable = durableTurnPosition(transcript.items, input.turns[index].message, turn.operationRef,
          turn.messageRequestId, { allowBlockedAssistant: true, requireExactCorrelation: true, requireUniqueUser: true });
        assert.ok(durable, `cold durable correlation: ${current.scenario.id}/${input.turns[index].id}`);
        assert.equal(durable.durableUserCount, 1);
      }
      assert.equal(gateway.supervisor.activeCount, 0); assert.equal(metrics.gatewayCloses, 1); assert.equal(metrics.disposes, 1);
      assert.equal(gateway.leases.inspect(journey.journeyReceipt.sessionRef).state, "released");
      await assert.rejects(fetch(`${gateway.origin}/api/v1/session-catalog`, { signal: AbortSignal.timeout(1000) }));
      observations.push({ scenarioId: current.scenario.id, repeat: current.repeat, declaredTurns: input.turns.length,
        taskStatuses: journey.journeyReceipt.turns.map(turn => turn.taskStatus), fixtureFresh: metrics.scriptedTurns * 10,
        fixtureTotal: metrics.scriptedTurns * 12, authCalls: metrics.authCalls, providerRegistrations: metrics.providerRegistrations,
        modelMessages: metrics.scriptedTurns, unexpectedMessages: metrics.unexpectedTurns,
        coldReadbacks: journey.journeyReceipt.turns.length,
        earlyQualityStop: journey.candidateOutcome?.turnIndex < input.turns.length, activeRuntimes: gateway.supervisor.activeCount, leasesReleased: true });
      return journey;
    } catch (error) {
      t.diagnostic(JSON.stringify({ scenario: current.scenario.id, fixtureError: String(error.message).slice(0, 400), metrics }));
      throw error;
    } finally { await gateway?.close(); }
  });
  const boundaries = maximum === 108 ? [12, 18, 54, 108] : [maximum];
  const stages = [];
  for (const boundary of boundaries) {
    const pendingOrder = fullOrder.slice(runs.length), order = pairedChunk(pendingOrder, boundary - runs.length);
    const launch = startBenchmarkBudgetLaunch(control, { resume: stages.length > 0 });
    const budgetRuntime = openBenchmarkBudgetCore(control, {
      env: { [BENCHMARK_BUDGET_CONTEXT]: launch.context }, parentPid: process.pid });
    const check = executionGuard.check.bind(executionGuard);
    const scheduleGuard = { ...executionGuard, check(stage, homes) {
      if (stage.startsWith("before-session:")) current = fullOrder.find(item =>
        stage === `before-session:${item.scenario.id}:${item.surface}:r${item.repeat}:attempt1`);
      return check(stage, homes);
    } };
    let scheduleError;
    try {
      await runOfflineBenchmarkSchedule({ order, fullOrder, pendingOrder,
        options: { ...options, maxSessions: order.length }, runs, manifest, recoveredAttemptsByKey: new Map(),
        executionGuard: scheduleGuard, budgetRuntime, codexRuntime: null, bootstrapMetadata: { piAgentHome: {} }, runtimeCommands,
        piRuntimeHome: { path: agentDir }, packageRoot: repositoryRoot, runCommand: localCommand, suite, suiteRoot,
        runId, runRoot, candidateGuard, piCommand: "provider-forbidden", codexCommand: "offline-codex-fixture",
        runtime: { codexDisabledFeatures: ["apps", "plugins", "browser_use", "hooks", "code_mode_host"] },
        suiteDigest, configurationDigest, rootSeed, ledgerPath, infrastructureLedgerPath, interrupted: () => false, state }, { piagentWebUiJourney });
    } catch (error) { scheduleError = error; } finally { budgetRuntime.close(); }
    const budget = launch.finish();
    if (scheduleError) throw scheduleError;
    stages.push({ boundary, accepted: runs.length, budget });
    t.diagnostic(JSON.stringify({ boundary, accepted: runs.length, started: budget.providerStartedAttempts,
      exactFresh: budget.knownExactFreshTokens, unknown: budget.unknownAttempts, fatal: state.fatalRunError?.message ?? null }));
    if (unknownCodex) break;
    assert.equal(state.fatalRunError, null, state.fatalRunError?.message);
    assert.equal(runs.length, boundary); assert.equal(budget.providerStartedAttempts, boundary);
    assert.equal(budget.unknownAttempts, 0); assert.equal(budget.inFlightAttempts, 0);
    assert.equal(budget.knownExactFreshTokens, runs.reduce((sum, record) => sum + record.usage.fresh, 0));
    const readback = inspectBenchmarkLedger(ledgerPath);
    assert.deepEqual(readback.binding, state.ledgerBinding); assert.equal(readback.records.length, boundary);
    assert.equal(fs.existsSync(path.join(runRoot, "pending-record.json")), false);
    assert.equal(fs.existsSync(path.join(runRoot, "measured-record-ready.json")), false);
    state.pauseReason = undefined;
  }
  for (const home of codexHomes) assert.equal(fs.existsSync(home), false);
  assert.equal(executionGuard.check("finalization"), undefined);
  if (unknownCodex) {
    const budget = stages.at(-1).budget;
    assert.ok(state.fatalRunError); assert.equal(budget.unknownAttempts, 1);
    assert.equal(budget.providerStartedAttempts, 2); assert.equal(runs.length, 1);
    assert.ok(budget.stopReasons.includes("unknown-usage"));
    assert.ok(fs.existsSync(infrastructureLedgerPath));
  } else {
    assert.equal(runs.length, maximum);
    assert.equal(new Set(runs.map(record => record.attemptId)).size, maximum);
    assert.equal(new Set(runs.map(record => `${record.scenarioId}:${record.repeat}`)).size, maximum / 2);
    assert.equal(runs.filter(record => record.surface === "piagent").length, maximum / 2);
    assert.equal(runs.filter(record => record.surface === "codex-cli").length, maximum / 2);
    for (const [index, record] of runs.entries()) {
      assert.ok(expectedBenchmarkRecord(record, index, fullOrder[index], runId, suite, configurationDigest));
      assert.ok(pairedBenchmarkVariantMatched(record, runs.slice(0, index)));
      assert.equal(record.runValidity, "valid"); assert.equal(record.usage.usageCompleteness, "exact");
      assert.equal(record.infrastructureRetries, 0);
      if (record.surface === "piagent") {
        const observation = observations.find(item => item.scenarioId === record.scenarioId && item.repeat === record.repeat);
        assert.equal(record.usage.fresh, observation.fixtureFresh); assert.equal(record.usage.total, observation.fixtureTotal);
      }
    }
    if (maximum === 108) {
      assert.equal(observations.reduce((sum, item) => sum + item.declaredTurns, 0), 108);
      const executedTurns = observations.reduce((sum, item) => sum + item.coldReadbacks, 0);
      assert.ok(executedTurns >= 54 && executedTurns <= 108);
      // The release diagnostic default can complete correct scripted tasks
      // while retaining pending proof; it cannot support a quality claim.
      const policy = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "packages/piagent-core/policies/base-policy.json")));
      if (policy.finalGate.acceptanceProofMode === "diagnostic") {
        assert.equal(runs.filter(record => record.failureClass === "agent_task_failure").length, 0);
        assert.equal(benchmarkAcceptancePolicyBinding(repositoryRoot, options).qualityClaim, "withheld");
      } else {
        assert.ok(runs.some(record => record.failureClass === "agent_task_failure"), "retain strict proof failures");
      }
      assert.equal(runs.filter(record => record.failureClass === "safety_refusal_correct").length, 8);
      assert.deepEqual(stages.map(stage => stage.accepted), [12, 18, 54, 108]);
      assert.ok(stages.at(-1).budget.stopReasons.includes("session-cap"));
    }
  }
  const summary = { schemaVersion: 1, kind: "offline-schedule-rehearsal-v1", rootSeed, maximum,
    fixtureAccountingOnly: true, productionAuthority: false, providerCalls: 0, candidate: candidateGuard.provenance,
    suiteIdentity, configurationDigest, accepted: runs.length, stages, observations,
    qualities: Object.fromEntries([...new Set(runs.map(record => record.failureClass))]
      .map(kind => [kind, runs.filter(record => record.failureClass === kind).length])),
    ledgerBinding: state.ledgerBinding, codexHomesRemoved: codexHomes.size, finalGuardMatched: true };
  t.diagnostic(JSON.stringify(summary));
  return summary;
}

test("offline shared schedule executes one representative paired block", { timeout: 240000 }, t => rehearse(t, { maximum: 2 }));
test("offline shared schedule retains a quality failure and continues its paired block", { timeout: 300000 }, t => rehearse(t, { maximum: 4 }));
test("offline shared schedule executes all 108 declared sessions and four stages", { timeout: 7200000 }, t => rehearse(t));
test("offline shared schedule stops on unknown usage without a third attempt", { timeout: 240000 }, t => rehearse(t, { maximum: 4, unknownCodex: true }));
