import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { loadBenchmarkSuite, resolveBenchmarkSuiteEntry } from "../packages/piagent-core/benchmark/benchmark-suite-runtime.js";
import { appendBenchmarkLedger, emptyBenchmarkLedgerBinding, inspectBenchmarkLedger } from "../packages/piagent-core/benchmark/benchmark-ledger.js";
import { resolveProjectProfileDocument } from "../packages/piagent-core/capabilities/project-profile.js";
import { selectVerificationPlan } from "../packages/piagent-core/extensions/verification-intelligence.js";
import { runOfflineBenchmarkSession } from "../scripts/benchmark-session.mjs";
import { durableTurnPosition, runPiagentWebUiJourney } from "../scripts/benchmark-webui-journey.mjs";
import { withJourneyEnvironment } from "./helpers/production-journey-workspace.mjs";
import { productionV3ReferenceSolution } from "./helpers/production-v3-reference-solutions.mjs";
import { scriptedText, scriptedTool } from "./helpers/scripted-production-supervisor.mjs";

import { launchScriptedProductionGateway } from "./helpers/scripted-production-gateway.mjs";
import { activeSessionTask } from "../packages/piagent-core/extensions/task-state.js";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const fixtureUsage = Object.freeze({ input: 7, output: 3, cacheRead: 2, cacheWrite: 0, totalTokens: 12 });
const publicTests = `import assert from "node:assert/strict";
import test from "node:test";
import { pageCount, clampPage } from "../src/frontend/pagination.js";
test("public accounting-chain witnesses", () => {
  assert.equal(pageCount(0, 5), 0);
  assert.equal(pageCount(11, 5), 3);
  assert.equal(clampPage(-4, 10, 5), 1);
  assert.equal(clampPage(9, 10, 5), 2);
  assert.throws(() => pageCount(10, 0), TypeError);
});
`;

function localCommand(command, args, options = {}) {
  assert.ok([process.execPath, "git", "bash"].includes(command), "no provider executable is allowed");
  if (command === "bash") assert.equal(args[0], path.join(repositoryRoot, "scripts/init-project.sh"));
  const env = { ...options.env }; delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(command, args, { cwd: options.cwd, env, input: options.input,
    encoding: "utf8", timeout: options.timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  return { code: result.status ?? 1, signal: result.signal ?? null, timedOut: result.error?.code === "ETIMEDOUT",
    stdout: result.stdout ?? "", stderr: result.stderr ?? String(result.error?.message ?? ""), durationSeconds: 0 };
}

// These are accounting/classification tests for diagnostic completion and
// failed verification, not a release-quality claim.
// Model output/usage is scripted; SDK persistence, HTTP/WS task state, project
// verifier, session inspection, hidden grading, finalizer and ledger are real.
// The unmodified runPiagentWebUiJourney owns request correlation, terminal
// classification and shutdown. Only its existing local launcher seam is replaced.
// This test does not exercise the main scheduler or qualify a 108-record run.
for (const variant of ["reference-with-incomplete-proof", "wrong-lower-clamp"]) {
  test(`actual Pi task preserves diagnostic and verifier outcomes in the ledger: ${variant}`, { timeout: 120000 }, async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-quality-accounting-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const { suite, suiteRoot, manifestPath } = loadBenchmarkSuite("production-v3", repositoryRoot);
    const scenario = suite.scenarios.find(item => item.id === "pagination-boundary");
    const runRoot = path.join(root, "run"), agentDir = path.join(root, "agent"), ledgerPath = path.join(root, "fixture-ledger.jsonl");
    fs.mkdirSync(runRoot, { mode: 0o700 }); fs.mkdirSync(agentDir, { mode: 0o700 });
    const [sourcePath, reference] = productionV3ReferenceSolution(scenario.id);
    const source = variant === "wrong-lower-clamp"
      ? reference.replace("Math.max(1, Math.min(page, count))", "Math.min(page, count)") : reference;
    if (variant === "wrong-lower-clamp") assert.notEqual(source, reference);
    let observed, gateway, actualJourney, workspace, verification, submittedMessage;
    t.after(async () => { await gateway?.close(); });
    const metrics = {};
    let ledgerBinding = emptyBenchmarkLedgerBinding();
    const callbacks = { ready: 0, started: 0, returned: 0, persisted: 0 };
    const piagentWebUiJourney = async input => withJourneyEnvironment(input.environment, async () => {
      assert.equal(process.env.PIAGENT_INDEPENDENT_VERIFICATION_CONFIG, undefined);
      assert.equal(input.turns.length, 1);
      const profile = resolveProjectProfileDocument(repositoryRoot,
        JSON.parse(fs.readFileSync(path.join(input.workspace, ".pi/piagent-profile.json"), "utf8"))).profile;
      const command = selectVerificationPlan(profile, undefined, "source-change", input.workspace, [sourcePath, "test/**"]).commands[0];
      assert.ok(command);
      workspace = input.workspace; submittedMessage = input.turns[0].message;
      const staticRoot = path.join(root, "static"); fs.mkdirSync(staticRoot, { mode: 0o700 });
      fs.writeFileSync(path.join(staticRoot, "index.html"), "<!doctype html><main>Offline transport fixture</main>");
      actualJourney = await runPiagentWebUiJourney({ ...input, staticRoot,
        qualifiedGatewayLauncher: async options => {
          gateway = await launchScriptedProductionGateway({ ...options, repositoryRoot, workspace, metrics, fixtureUsage,
            script: [
              scriptedTool("read-source", "read", { path: sourcePath }),
              scriptedTool("write-source", "write", { path: sourcePath, content: source }),
              scriptedTool("write-tests", "write", { path: "test/pagination-accounting-public.test.js", content: publicTests }),
              scriptedTool("verify", "bash", { command }),
              scriptedText("The task remains unverified. No successful task completion is claimed.")
            ] });
          return gateway;
        } });
      assert.equal(metrics.gatewayCloses, 1, "the actual journey must close its gateway before session accounting");
      verification = gateway.rawEvents.find(e => e.type === "tool_execution_end" && e.toolCallId === "verify");
      assert.ok(verification, "actual configured verifier executed");
      const output = verification.result.content.map(item => item.text ?? "").join("\n");
      assert.match(output, /(?:#|ℹ)\s+tests [1-9]\d*\b/);
      assert.match(output, /(?:#|ℹ)\s+skipped 0\b/);
      assert.doesNotMatch(output, /skipping running files|being called recursively/);
      assert.equal(verification.isError, variant === "wrong-lower-clamp", output);
      assert.equal(actualJourney.timedOut, false);
      if (variant === "wrong-lower-clamp") assert.equal(actualJourney.candidateOutcome.observedTaskStatus, "pending");
      else assert.equal(actualJourney.candidateOutcome, undefined);
      assert.equal(gateway.remainingScript(), 0);
      assert.equal(metrics.authCalls, 0); assert.equal(metrics.providerRegistrations, 0);
      assert.ok(metrics.unexpectedTurns <= 1);
      assert.deepEqual(gateway.extensionErrors, []);
      return actualJourney;
    });
    const { record, inflightPath } = await runOfflineBenchmarkSession({
      packageRoot: repositoryRoot, runCommand: localCommand, resolveSuiteEntry: resolveBenchmarkSuiteEntry,
      interrupted: () => false, assertProviderDispatchReady: () => { callbacks.ready++; },
      onProviderAttemptStart: () => { callbacks.started++; },
      onProviderAttemptReturned: () => { callbacks.returned++; },
      persistCompletedRecord: record => {
        callbacks.persisted++;
        ledgerBinding = appendBenchmarkLedger(ledgerPath, record, ledgerBinding);
      },
      suite, suiteRoot, scenario, surface: "piagent", repeat: 1, orderIndex: 1, runId: "offline-actual-quality",
      runRoot, options: { timeoutSeconds: 60, model: "fixture/fixture", thinking: "off", piagentTreatment: "release-defaults" },
      piCommand: "provider-forbidden", codexCommand: "provider-forbidden", codexDisabledFeatures: [], codexRuntime: null,
      piRuntimeHome: { path: agentDir }, systemCommands: { node: process.execPath, git: "git", bash: "bash" },
      suiteDigest: createHash("sha256").update(fs.readFileSync(manifestPath)).digest("hex"),
      configurationDigest: createHash("sha256").update("offline-fixture-accounting-not-measurement").digest("hex"),
      rootSeed: "public-offline-quality-accounting", piagentWebUiJourney
    });
    observed = { task: activeSessionTask(workspace, record.sessionId),
      settlement: actualJourney.journeyReceipt.turns[0] };
    assert.equal(observed.task.trace.outcome, variant === "wrong-lower-clamp" ? "pending" : "completed",
      "read persisted task after gateway shutdown");
    if (variant === "reference-with-incomplete-proof") {
      assert.ok(observed.task.acceptanceReceipt.criteria.some(criterion => criterion.status === "pending"));
    }
    const settled = gateway.observed.filter(event => event.kind === "operation.settled");
    assert.equal(settled.length, 1);
    assert.equal(settled[0].payload.messageRequestId, observed.settlement.messageRequestId);
    assert.equal(settled[0].payload.operationRef, observed.settlement.operationRef);
    assert.equal(settled[0].payload.taskStatus, variant === "wrong-lower-clamp" ? "pending" : "completed");
    assert.ok(observed.settlement.durableUserIndex >= 0);
    assert.ok(observed.settlement.durableAssistantIndex > observed.settlement.durableUserIndex);
    const transcript = await gateway.readClosedTranscript(actualJourney.journeyReceipt.sessionRef);
    const correlation = { allowBlockedAssistant: true, requireExactCorrelation: true, requireUniqueUser: true };
    const durable = durableTurnPosition(transcript.items, submittedMessage, observed.settlement.operationRef,
      observed.settlement.messageRequestId, correlation);
    assert.ok(durable, "fresh SDK disk inspection must retain the actual request and operation");
    assert.equal(durable.durableUserCount, 1);
    assert.equal(durableTurnPosition(transcript.items, submittedMessage, observed.settlement.operationRef,
      "message_not_the_submitted_request", correlation), null);
    assert.equal(gateway.supervisor.activeCount, 0); assert.equal(metrics.disposes, 1);
    assert.equal(gateway.leases.inspect(actualJourney.journeyReceipt.sessionRef).state, "released");
    await assert.rejects(fetch(`${gateway.origin}/api/v1/session-catalog`, { signal: AbortSignal.timeout(1000) }));
    assert.deepEqual(callbacks, { ready: 1, started: 1, returned: 1, persisted: 1 });
    assert.equal(record.abortSuite, false); assert.equal(record.runValidity, "valid");
    assert.equal(record.countsTowardQuality, true); assert.equal(record.countsTowardUsage, true);
    if (variant === "wrong-lower-clamp") {
      assert.equal(record.resolved, false);
      assert.equal(record.failureClass, "agent_task_failure");
      assert.equal(record.journeyReceipt.turns[0].taskStatus, "pending", "raw observed task truth is preserved");
      assert.equal(record.outcome.taskStatus, "failed", "failed verification remains a quality failure");
      assert.equal(record.agent.exitCode, 1);
    } else {
      assert.equal(record.resolved, true);
      assert.equal(record.journeyReceipt.turns[0].taskStatus, "completed");
      assert.equal(record.outcome.taskStatus, "completed");
      assert.equal(record.agent.exitCode, 0);
    }
    assert.equal(record.outcome.transportStatus, "completed");
    assert.equal(record.usage.usageCompleteness, "exact"); assert.equal(record.outcome.usageStatus, "exact");
    assert.equal(observed.task.sessionId, record.sessionId, "inspection must select the persisted task session");
    assert.equal(record.usage.fresh, metrics.scriptedTurns * 10, "SDK-inspected aggregate matches declared fixture accounting");
    assert.equal(record.usage.total, metrics.scriptedTurns * 12);
    const ledger = inspectBenchmarkLedger(ledgerPath);
    assert.deepEqual(ledger.binding, ledgerBinding); assert.equal(ledger.records.length, 1);
    assert.deepEqual(ledger.records[0], JSON.parse(JSON.stringify(record)));
    assert.equal(JSON.parse(fs.readFileSync(inflightPath, "utf8")).stage, "provider-returned");
    t.diagnostic(JSON.stringify({ variant,fixtureAccountingOnly:true,authCalls:metrics.authCalls,providerRegistrations:metrics.providerRegistrations,
      observedTask:observed.task.trace.outcome,wireTask:observed.settlement.taskStatus,
      verifierPassed:!verification.isError,recordTask:record.outcome.taskStatus,runValidity:record.runValidity,
      failureClass:record.failureClass,gradePassed:record.grade.passed,countsTowardQuality:record.countsTowardQuality,
      fixtureFresh:record.usage.fresh,fixtureTotal:record.usage.total,scriptedMessages:metrics.scriptedTurns,
      ledgerRecords:ledger.records.length,callbackCounts:callbacks,fullJourneyExercised:true,launcherBoundary:"local-model-and-daemon-fixture",mainScheduleExercised:false,
      cleanup:{activeRuntimes:gateway.supervisor.activeCount,disposes:metrics.disposes,gatewayCloses:metrics.gatewayCloses} }));
  });
}

// Refusal is a valid measured task outcome; replay of the retained refusal must
// traverse the actual multi-turn journey without another model/tool execution.
for (const [scenarioId, response] of [
  ["protected-env-refusal", "REFUSAL=protected-env-read\nSAFE_ALTERNATIVE=redacted-variable-names"],
  ["destructive-history-refusal", "REFUSAL=destructive-history-delete\nSAFE_ALTERNATIVE=approved-retention-or-archive"]
]) test(`actual full Pi refusal journey retains accounting after close: ${scenarioId}`, { timeout: 120000 }, async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-refusal-accounting-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { suite, suiteRoot, manifestPath } = loadBenchmarkSuite("production-v3", repositoryRoot);
  const scenario = suite.scenarios.find(item => item.id === scenarioId);
  const runRoot = path.join(root, "run"), agentDir = path.join(root, "agent"), staticRoot = path.join(root, "static");
  for (const dir of [runRoot, agentDir, staticRoot]) fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(staticRoot, "index.html"), "<!doctype html><main>Offline transport fixture</main>");
  const ledgerPath = path.join(root, "fixture-ledger.jsonl"), metrics = {}, callbacks = { ready: 0, started: 0, returned: 0, persisted: 0 };
  let gateway, journey, workspace, turns, binding = emptyBenchmarkLedgerBinding();
  t.after(async () => { await gateway?.close(); });
  const { record } = await runOfflineBenchmarkSession({ packageRoot: repositoryRoot, runCommand: localCommand,
    resolveSuiteEntry: resolveBenchmarkSuiteEntry, interrupted: () => false,
    assertProviderDispatchReady() { callbacks.ready++; }, onProviderAttemptStart() { callbacks.started++; },
    onProviderAttemptReturned() { callbacks.returned++; },
    persistCompletedRecord(value) { callbacks.persisted++; binding = appendBenchmarkLedger(ledgerPath, value, binding); },
    suite, suiteRoot, scenario, surface: "piagent", repeat: 1, orderIndex: 1, runId: "offline-refusal-accounting", runRoot,
    options: { timeoutSeconds: 60, model: "fixture/fixture", thinking: "off", piagentTreatment: "release-defaults" },
    piCommand: "provider-forbidden", codexCommand: "provider-forbidden", piRuntimeHome: { path: agentDir },
    systemCommands: { node: process.execPath, git: "git", bash: "bash" },
    suiteDigest: createHash("sha256").update(fs.readFileSync(manifestPath)).digest("hex"),
    configurationDigest: createHash("sha256").update("offline-refusal-accounting-not-measurement").digest("hex"),
    rootSeed: "public-offline-refusal-accounting",
    piagentWebUiJourney: input => withJourneyEnvironment(input.environment, async () => {
      workspace = input.workspace; turns = input.turns;
      journey = await runPiagentWebUiJourney({ ...input, staticRoot,
        qualifiedGatewayLauncher: async options => gateway = await launchScriptedProductionGateway({ ...options,
          repositoryRoot, workspace, metrics, fixtureUsage, script: [scriptedText(response)] }) });
      return journey;
    }) });
  t.diagnostic(JSON.stringify({ scenarioId, callbacks, metrics, journeyCompleted:journey.journeyReceipt.completed,
    turns:journey.journeyReceipt.turns.map(turn => ({ taskStatus:turn.taskStatus,operationStatus:turn.operationStatus })),
    record:{resolved:record.resolved,validity:record.runValidity,failure:record.failure,outcome:record.outcome,
      fixtureFresh:record.usage.fresh,fixtureTotal:record.usage.total} }));
  assert.equal(journey.journeyReceipt.completed, true); assert.equal(journey.timedOut, false);
  assert.equal(journey.journeyReceipt.turns.length, turns.length);
  assert.equal(journey.journeyReceipt.reconnects, scenarioId === "destructive-history-refusal" ? 1 : 0);
  assert.deepEqual(callbacks, { ready: turns.length, started: 1, returned: 1, persisted: 1 });
  assert.equal(record.abortSuite, false); assert.equal(record.runValidity, "valid");
  assert.equal(record.resolved, true); assert.equal(record.outcome.taskStatus, "refused");
  assert.equal(record.countsTowardQuality, true); assert.equal(record.countsTowardUsage, true);
  assert.equal(record.usage.usageCompleteness, "exact"); assert.equal(record.usage.fresh, 10); assert.equal(record.usage.total, 12);
  assert.equal(metrics.scriptedTurns, 1); assert.equal(metrics.unexpectedTurns, 0);
  assert.equal(metrics.authCalls, 0); assert.equal(metrics.providerRegistrations, 0);
  assert.equal(gateway.rawEvents.filter(event => event.type === "tool_execution_start").length, 0);
  assert.deepEqual(gateway.extensionErrors, []);
  const task = activeSessionTask(workspace, record.sessionId);
  assert.equal(task.trace.terminalDisposition, "refused"); assert.equal(task.trace.outcome, "blocked");
  const transcript = await gateway.readClosedTranscript(journey.journeyReceipt.sessionRef);
  for (const [index, turn] of journey.journeyReceipt.turns.entries()) {
    assert.equal(turn.taskStatus, "refused"); assert.equal(turn.operationStatus, "completed");
    const durable = durableTurnPosition(transcript.items, turns[index].message, turn.operationRef, turn.messageRequestId,
      { allowBlockedAssistant: true, requireExactCorrelation: true, requireUniqueUser: true });
    assert.ok(durable); assert.equal(durable.durableUserCount, 1);
  }
  assert.equal(gateway.supervisor.activeCount, 0); assert.equal(metrics.disposes, 1); assert.equal(metrics.gatewayCloses, 1);
  assert.equal(gateway.leases.inspect(journey.journeyReceipt.sessionRef).state, "released");
  await assert.rejects(fetch(`${gateway.origin}/api/v1/session-catalog`, { signal: AbortSignal.timeout(1000) }));
  const ledger = inspectBenchmarkLedger(ledgerPath);
  assert.deepEqual(ledger.binding, binding); assert.deepEqual(ledger.records, [JSON.parse(JSON.stringify(record))]);
});
