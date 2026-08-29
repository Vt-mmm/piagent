import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { evaluateAllAttemptPooledFreshEfficiency } from "../packages/piagent-core/benchmark/benchmark-all-attempt-efficiency.js";
import { parseBenchmarkArgs } from "../packages/piagent-core/benchmark/benchmark-cli.js";
import { codexExecArgs, codexExecResumeArgs } from "../packages/piagent-core/benchmark/benchmark-codex.js";
import {
  buildCodexInvocationReceipt,
  inspectCodexRolloutServiceTierEvidence
} from "../packages/piagent-core/benchmark/benchmark-codex-rollout.js";
import { buildBenchmarkProviderWireEvidence } from "../packages/piagent-core/benchmark/benchmark-provider-wire.js";
import { summarizeBenchmarkServiceTierEvidence } from "../packages/piagent-core/benchmark/benchmark-service-tier.js";
import { validateBenchmarkSuite } from "../packages/piagent-core/benchmark/benchmark-suite.js";
import {
  benchmarkInfrastructureFailureLedgerIssues,
  benchmarkTokenAccounting,
  parseCodexExecJsonl
} from "../packages/piagent-core/benchmark/benchmark-usage.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function exactUsage(fresh) {
  return {
    input: fresh,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    fresh,
    total: fresh,
    sessions: 1,
    usageCompleteness: "exact"
  };
}

function codexUsage(requestedServiceTier = "fast", observedServiceTier) {
  const usage = parseCodexExecJsonl([
    JSON.stringify({ type: "thread.started", thread_id: "thread-fast" }),
    JSON.stringify({ type: "turn.completed", usage: {
      input_tokens: 20,
      cached_input_tokens: 5,
      output_tokens: 10,
      reasoning_output_tokens: 2
    } })
  ].join("\n"), {
    model: "openai-codex/gpt-5.6-luna",
    thinkingLevel: "medium",
    requestedServiceTier
  });
  if (observedServiceTier === undefined) return usage;
  return {
    ...usage,
    serviceTierEvidence: {
      schemaVersion: 1,
      source: "codex-controlled-invocation-rollout-settings",
      events: 1,
      requestedTiers: [requestedServiceTier],
      observedRequestTiers: [observedServiceTier],
      providerResponseTiers: [],
      responseEvidence: ["unavailable-codex-rollout-thread-settings"],
      defaultFallbackEvents: observedServiceTier === "default" ? 1 : 0,
      identityBound: true,
      invocationBound: true,
      coverageBound: true,
      settingsBound: true,
      providerStartedEvents: 1,
      invocationEvents: 1,
      initialInvocationEvents: 1,
      resumeInvocationEvents: 0,
      resumeSettingsEvents: 0,
      turnContextEvents: 1,
      diagnostics: []
    }
  };
}

function piWireEvent() {
  return {
    event: "provider_request_wire_surface",
    state: "known",
    providerModelId: "gpt-5.6-luna",
    providerReasoningEffort: "medium",
    instructionsHash: "a".repeat(64),
    baseInstructionsHash: "b".repeat(64),
    orderedToolSurfaceHash: "c".repeat(64),
    deferredToolSurfaceHash: "d".repeat(64),
    deferredToolBatchCount: 0,
    deferredToolCount: 0
  };
}

function piTierEvent(overrides = {}) {
  return {
    event: "provider_request_service_tier",
    fastMode: "fast",
    requestedServiceTier: "fast",
    observedRequestServiceTier: "priority",
    providerResponseServiceTier: null,
    providerResponseEvidence: "unavailable-host-api",
    applied: true,
    ...overrides
  };
}

function piEvidence(observedRequestServiceTier = "priority", providerResponseServiceTier = null) {
  return buildBenchmarkProviderWireEvidence({
    requestedModel: "openai-codex/gpt-5.6-luna",
    requestedThinking: "medium",
    events: [
      piWireEvent(),
      piTierEvent({
        observedRequestServiceTier,
        providerResponseServiceTier,
        providerResponseEvidence: providerResponseServiceTier ? "provider-response" : "unavailable-host-api",
        applied: observedRequestServiceTier === "priority"
      })
    ]
  });
}

function piRun(providerWireEvidence = piEvidence()) {
  return {
    scenarioId: "s",
    repeat: 1,
    surface: "piagent",
    providerWireEvidence,
    usage: { execution: { providerStartedAttempts: providerWireEvidence.wireEvents } }
  };
}

function receiptUsage(threadId) {
  return parseCodexExecJsonl([
    JSON.stringify({ type: "thread.started", thread_id: threadId }),
    JSON.stringify({ type: "turn.completed", usage: {
      input_tokens: 20,
      cached_input_tokens: 5,
      output_tokens: 10,
      reasoning_output_tokens: 2
    } })
  ].join("\n"), {
    model: "openai-codex/gpt-5.6-luna",
    thinkingLevel: "medium",
    requestedServiceTier: "fast"
  });
}

function codexReceipt({ home, workspace, threadId, resumed = false, mutateArgs } = {}) {
  const command = path.join(home, "codex-test");
  if (!fs.existsSync(command)) {
    fs.writeFileSync(command, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(command, 0o700);
  }
  const options = {
    model: "openai-codex/gpt-5.6-luna",
    thinking: "medium",
    codexMode: "controlled",
    serviceTier: "fast"
  };
  const originalArgs = resumed
    ? codexExecResumeArgs({ threadId, options })
    : codexExecArgs({ workspace, options, persistent: true });
  const args = mutateArgs ? mutateArgs([...originalArgs]) : originalArgs;
  const usage = receiptUsage(threadId);
  return buildCodexInvocationReceipt({
    command,
    args,
    runtime: { mode: "controlled", home, credentialBridge: "test-auth-copy" },
    environment: { CODEX_HOME: home },
    workspace,
    requestedModel: options.model,
    requestedThinking: options.thinking,
    requestedServiceTier: options.serviceTier,
    resumed,
    result: { code: 0, timedOut: false },
    usage
  });
}

function turnContext(workspace, overrides = {}) {
  return {
    type: "turn_context",
    payload: {
      model: "gpt-5.6-luna",
      effort: "medium",
      cwd: workspace,
      ...overrides
    }
  };
}

function appliedSettings(workspace, overrides = {}) {
  return {
    type: "event_msg",
    payload: {
      type: "thread_settings_applied",
      thread_settings: {
        model: "gpt-5.6-luna",
        reasoning_effort: "medium",
        cwd: workspace,
        service_tier: "priority",
        ...overrides
      }
    }
  };
}

test("pins Fast mode on the exact Codex model and thinking without relying on user config", () => {
  assert.equal(parseBenchmarkArgs(["--fast"]).serviceTier, "fast");
  assert.equal(parseBenchmarkArgs(["--service-tier", "default"]).serviceTier, "default");
  const args = codexExecArgs({
    workspace: root,
    options: {
      model: "openai-codex/gpt-5.6-luna",
      thinking: "medium",
      codexMode: "controlled",
      serviceTier: "fast"
    },
    persistent: true
  });
  assert.ok(args.includes("--ignore-user-config"));
  assert.ok(args.includes("--strict-config"));
  assert.ok(args.includes("model_reasoning_effort=\"medium\""));
  assert.ok(args.includes("service_tier=\"fast\""));
  assert.equal(args.includes("--ephemeral"), false);
  assert.deepEqual(args.slice(args.indexOf("--enable"), args.indexOf("--enable") + 2), ["--enable", "fast_mode"]);
  const resumeArgs = codexExecResumeArgs({
    threadId: "thread-fast",
    options: {
      model: "openai-codex/gpt-5.6-luna",
      thinking: "medium",
      codexMode: "controlled",
      serviceTier: "fast"
    }
  });
  assert.ok(resumeArgs.includes("service_tier=\"fast\""));
  assert.ok(resumeArgs.includes("--strict-config"));
  assert.ok(resumeArgs.includes("model_reasoning_effort=\"medium\""));
  assert.deepEqual(resumeArgs.slice(resumeArgs.indexOf("--enable"), resumeArgs.indexOf("--enable") + 2), ["--enable", "fast_mode"]);
});

test("proves Fast execution configuration parity while keeping provider processing tier claim separate", () => {
  const evidence = summarizeBenchmarkServiceTierEvidence([
    piRun(),
    { scenarioId: "s", repeat: 1, surface: "codex-cli", usage: codexUsage("fast", "priority") }
  ], { requestedServiceTier: "fast", requestedModel: "openai-codex/gpt-5.6-luna", required: true });
  assert.equal(evidence.executionConfigurationParityGate, true);
  assert.equal(evidence.providerResponseEvidenceGate, null);
  assert.equal(evidence.passed, true);
  assert.equal(evidence.claimBoundary, "fast-execution-configuration-parity");
  assert.equal(evidence.actualProviderProcessingTierClaimAllowed, false);
  assert.equal(evidence.subscriptionCreditAccounting.includedInTokenRatio, false);
  assert.equal(evidence.subscriptionCreditAccounting.actualBillingMode, "unverified");
  assert.equal(evidence.subscriptionCreditAccounting.applicableMultiplier, null);
  assert.equal(evidence.subscriptionCreditAccounting.referenceRates.chatgptSubscriptionCredits.multiplier, 2.5);
  assert.equal(evidence.subscriptionCreditAccounting.referenceRates.apiFastTokenPricing.multiplier, 2);
});

test("fails Fast execution configuration parity when any Pi provider request is missing its tier receipt", () => {
  const providerWireEvidence = buildBenchmarkProviderWireEvidence({
    requestedModel: "openai-codex/gpt-5.6-luna",
    requestedThinking: "medium",
    events: [piWireEvent(), piTierEvent(), piWireEvent()]
  });
  const evidence = summarizeBenchmarkServiceTierEvidence([
    piRun(providerWireEvidence),
    { scenarioId: "s", repeat: 1, surface: "codex-cli", usage: codexUsage("fast", "priority") }
  ], { requestedServiceTier: "fast", requestedModel: "openai-codex/gpt-5.6-luna", required: true });
  const piRecord = evidence.records.find((record) => record.surface === "piagent");
  assert.equal(piRecord.providerStartedEvents, 2);
  assert.equal(piRecord.wireEvents, 2);
  assert.equal(piRecord.events, 1);
  assert.equal(piRecord.executionConfigurationCoverageVerified, false);
  assert.equal(evidence.executionConfigurationParityGate, false);
  assert.equal(evidence.passed, false);
});

test("fails Fast execution configuration parity when one of multiple Pi requests did not apply Fast", () => {
  const providerWireEvidence = buildBenchmarkProviderWireEvidence({
    requestedModel: "openai-codex/gpt-5.6-luna",
    requestedThinking: "medium",
    events: [
      piWireEvent(),
      piTierEvent(),
      piWireEvent(),
      piTierEvent({ observedRequestServiceTier: null, applied: false, reasonCode: "provider-not-supported" })
    ]
  });
  const evidence = summarizeBenchmarkServiceTierEvidence([
    piRun(providerWireEvidence),
    { scenarioId: "s", repeat: 1, surface: "codex-cli", usage: codexUsage("fast", "priority") }
  ], { requestedServiceTier: "fast", requestedModel: "openai-codex/gpt-5.6-luna", required: true });
  const piRecord = evidence.records.find((record) => record.surface === "piagent");
  assert.equal(piRecord.events, 2);
  assert.equal(piRecord.appliedEvents, 1);
  assert.equal(piRecord.appliedFastEvents, 1);
  assert.equal(piRecord.executionConfigurationCoverageVerified, false);
  assert.equal(evidence.executionConfigurationParityGate, false);
  assert.equal(evidence.passed, false);
});

test("fails Fast execution configuration parity on an explicit default fallback", () => {
  const evidence = summarizeBenchmarkServiceTierEvidence([
    piRun(),
    { scenarioId: "s", repeat: 1, surface: "codex-cli", usage: codexUsage("fast", "default") }
  ], { requestedServiceTier: "fast", required: true });
  assert.equal(evidence.executionConfigurationParityGate, false);
  assert.equal(evidence.passed, false);
  assert.equal(evidence.bySurface["codex-cli"].defaultFallbackRuns, 1);
});

test("rejects a literal fast Pi wire tier because OpenAI Fast maps to priority", () => {
  const evidence = summarizeBenchmarkServiceTierEvidence([
    piRun(piEvidence("fast")),
    { scenarioId: "s", repeat: 1, surface: "codex-cli", usage: codexUsage("fast", "priority") }
  ], { requestedServiceTier: "fast", required: true });
  assert.equal(evidence.executionConfigurationParityGate, false);
  assert.equal(evidence.records.find((record) => record.surface === "piagent")?.executionConfigurationVerified, false);
});

test("does not promote a Codex Fast command binding into effective thread-settings evidence", () => {
  const evidence = summarizeBenchmarkServiceTierEvidence([
    piRun(),
    { scenarioId: "s", repeat: 1, surface: "codex-cli", usage: codexUsage("fast") }
  ], { requestedServiceTier: "fast", required: true });
  assert.equal(evidence.executionConfigurationParityGate, false);
  assert.equal(evidence.bySurface["codex-cli"].missingExecutionConfigurationEvidenceRuns, 1);
});

test("binds effective Fast evidence to the exact controlled Codex rollout thread", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-codex-rollout-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const threadId = "thread-fast";
  const workspace = path.join(home, "workspace");
  const directory = path.join(home, "sessions", "2026", "08", "28");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `rollout-test-${threadId}.jsonl`), [
    JSON.stringify({ type: "session_meta", payload: { id: threadId, cwd: workspace } }),
    JSON.stringify(turnContext(workspace)),
    JSON.stringify(appliedSettings(workspace)),
    JSON.stringify(turnContext(workspace))
  ].join("\n"));
  const invocationReceipts = [
    codexReceipt({ home, workspace, threadId }),
    codexReceipt({ home, workspace, threadId, resumed: true })
  ];
  const evidence = inspectCodexRolloutServiceTierEvidence({
    codexHome: home,
    threadId,
    workspace,
    requestedModel: "openai-codex/gpt-5.6-luna",
    requestedThinking: "medium",
    requestedServiceTier: "fast",
    providerStartedAttempts: 2,
    invocationReceipts
  });
  assert.equal(evidence.identityBound, true);
  assert.equal(evidence.invocationBound, true);
  assert.equal(evidence.coverageBound, true);
  assert.equal(evidence.settingsBound, true);
  assert.equal(evidence.events, 2);
  assert.equal(evidence.initialInvocationEvents, 1);
  assert.equal(evidence.resumeSettingsEvents, 1);
  assert.equal(evidence.turnContextEvents, 2);
  assert.deepEqual(evidence.requestedTiers, ["fast"]);
  assert.deepEqual(evidence.observedRequestTiers, ["priority"]);
  assert.deepEqual(evidence.providerResponseTiers, []);
});

test("binds a one-turn Fast run through its strict initial invocation without inventing a resume event", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-codex-initial-rollout-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const threadId = "thread-initial-fast";
  const workspace = path.join(home, "workspace");
  const directory = path.join(home, "sessions", "2026", "08", "28");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `rollout-test-${threadId}.jsonl`), [
    JSON.stringify({ type: "session_meta", payload: { id: threadId, cwd: workspace } }),
    JSON.stringify(turnContext(workspace))
  ].join("\n"));
  const evidence = inspectCodexRolloutServiceTierEvidence({
    codexHome: home,
    threadId,
    workspace,
    requestedModel: "openai-codex/gpt-5.6-luna",
    requestedThinking: "medium",
    requestedServiceTier: "fast",
    providerStartedAttempts: 1,
    invocationReceipts: [codexReceipt({ home, workspace, threadId })]
  });
  assert.equal(evidence.settingsBound, true);
  assert.equal(evidence.events, 1);
  assert.equal(evidence.initialInvocationEvents, 1);
  assert.equal(evidence.resumeSettingsEvents, 0);
  assert.equal(evidence.coverageBound, true);
  assert.deepEqual(evidence.observedRequestTiers, ["priority"]);
  assert.deepEqual(evidence.diagnostics, []);
});

test("rejects a missing strict-config binding or incomplete initial invocation receipt", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-codex-initial-invalid-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const threadId = "thread-initial-invalid";
  const workspace = path.join(home, "workspace");
  const directory = path.join(home, "sessions", "2026", "08", "28");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `rollout-test-${threadId}.jsonl`), [
    JSON.stringify({ type: "session_meta", payload: { id: threadId, cwd: workspace } }),
    JSON.stringify(turnContext(workspace))
  ].join("\n"));
  const receipt = codexReceipt({
    home,
    workspace,
    threadId,
    mutateArgs: (args) => args.filter((value) => value !== "--strict-config")
  });
  assert.equal(receipt.valid, false);
  assert.ok(receipt.diagnostics.includes("codex-strict-config-not-bound"));
  const evidence = inspectCodexRolloutServiceTierEvidence({
    codexHome: home,
    threadId,
    workspace,
    requestedModel: "openai-codex/gpt-5.6-luna",
    requestedThinking: "medium",
    requestedServiceTier: "fast",
    providerStartedAttempts: 1,
    invocationReceipts: [receipt]
  });
  assert.equal(evidence.settingsBound, false);
  assert.equal(evidence.invocationBound, false);
  assert.ok(evidence.diagnostics.includes("codex-invocation-receipt-mismatch"));
});

test("rejects missing or identity-mutated resume evidence instead of under-counting provider starts", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-codex-resume-invalid-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const threadId = "thread-resume-invalid";
  const workspace = path.join(home, "workspace");
  const directory = path.join(home, "sessions", "2026", "08", "28");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `rollout-test-${threadId}.jsonl`), [
    JSON.stringify({ type: "session_meta", payload: { id: threadId, cwd: workspace } }),
    JSON.stringify(turnContext(workspace)),
    JSON.stringify(appliedSettings(workspace)),
    JSON.stringify(turnContext(workspace))
  ].join("\n"));
  const initial = codexReceipt({ home, workspace, threadId });
  const resume = codexReceipt({ home, workspace, threadId, resumed: true });
  const input = {
    codexHome: home,
    threadId,
    workspace,
    requestedModel: "openai-codex/gpt-5.6-luna",
    requestedThinking: "medium",
    requestedServiceTier: "fast",
    providerStartedAttempts: 2
  };
  const missing = inspectCodexRolloutServiceTierEvidence({ ...input, invocationReceipts: [initial] });
  assert.equal(missing.settingsBound, false);
  assert.ok(missing.diagnostics.includes("codex-invocation-receipt-coverage-mismatch"));
  assert.ok(missing.diagnostics.includes("codex-resume-invocation-receipt-count-mismatch"));

  const mutatedResume = structuredClone(resume);
  mutatedResume.bindings.threadId = "other-thread";
  const mutated = inspectCodexRolloutServiceTierEvidence({ ...input, invocationReceipts: [initial, mutatedResume] });
  assert.equal(mutated.settingsBound, false);
  assert.equal(mutated.invocationBound, false);
  assert.ok(mutated.diagnostics.includes("codex-invocation-receipt-mismatch"));
});

test("rejects rollout tier, model, thinking, or workspace drift", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-codex-rollout-drift-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const threadId = "thread-drift";
  const workspace = path.join(home, "workspace");
  const directory = path.join(home, "sessions", "2026", "08", "28");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `rollout-test-${threadId}.jsonl`), [
    JSON.stringify({ type: "session_meta", payload: { id: threadId, cwd: workspace } }),
    JSON.stringify(turnContext(workspace)),
    JSON.stringify(appliedSettings(workspace)),
    JSON.stringify(turnContext(workspace, { model: "wrong-model", effort: "high", cwd: path.join(home, "other") })),
    JSON.stringify(appliedSettings(workspace, { model: "wrong-model", reasoning_effort: "high", cwd: path.join(home, "other"), service_tier: "fast" }))
  ].join("\n"));
  const invocationReceipts = [
    codexReceipt({ home, workspace, threadId }),
    codexReceipt({ home, workspace, threadId, resumed: true })
  ];
  const rollout = inspectCodexRolloutServiceTierEvidence({
    codexHome: home,
    threadId,
    workspace,
    requestedModel: "openai-codex/gpt-5.6-luna",
    requestedThinking: "medium",
    requestedServiceTier: "fast",
    providerStartedAttempts: 2,
    invocationReceipts
  });
  assert.equal(rollout.settingsBound, false);
  assert.ok(rollout.diagnostics.includes("codex-rollout-service-tier-conflict"));
  assert.ok(rollout.diagnostics.includes("codex-rollout-model-mismatch"));
  assert.ok(rollout.diagnostics.includes("codex-rollout-reasoning-mismatch"));
  assert.ok(rollout.diagnostics.includes("codex-rollout-workspace-mismatch"));
  assert.ok(rollout.diagnostics.includes("codex-rollout-turn-context-model-mismatch"));
  assert.ok(rollout.diagnostics.includes("codex-rollout-turn-context-reasoning-mismatch"));
  assert.ok(rollout.diagnostics.includes("codex-rollout-turn-context-workspace-mismatch"));
  const summary = summarizeBenchmarkServiceTierEvidence([
    piRun(),
    { scenarioId: "s", repeat: 1, surface: "codex-cli", usage: { ...codexUsage(), serviceTierEvidence: rollout } }
  ], { requestedServiceTier: "fast", required: true });
  assert.equal(summary.executionConfigurationParityGate, false);
});

test("net-35 gate pools accepted plus exact failed and retry fresh tokens", () => {
  const runs = [
    { surface: "codex-cli", usage: exactUsage(100), usageStatus: "measured", infrastructureRetries: 1,
      infrastructureAttempt: 2, infrastructureAttempts: 2,
      infrastructureFailures: [{ attempt: 1, usage: exactUsage(20), usageStatus: "measured-but-unaccepted" }] },
    { surface: "piagent", usage: exactUsage(60), usageStatus: "measured", infrastructureRetries: 1,
      infrastructureAttempt: 2, infrastructureAttempts: 2,
      infrastructureFailures: [{ attempt: 1, usage: exactUsage(18), usageStatus: "measured-but-unaccepted" }] }
  ];
  const accounting = benchmarkTokenAccounting(runs);
  const atThreshold = evaluateAllAttemptPooledFreshEfficiency({
    tokenAccounting: accounting,
    baselineSurface: "codex-cli",
    candidateSurface: "piagent",
    maximumRatio: 0.65
  });
  assert.equal(atThreshold.baseline.freshTokens, 120);
  assert.equal(atThreshold.candidate.freshTokens, 78);
  assert.equal(atThreshold.ratioRaw, 0.65);
  assert.equal(atThreshold.passed, true);
  const aboveThreshold = evaluateAllAttemptPooledFreshEfficiency({
    tokenAccounting: benchmarkTokenAccounting([{ ...runs[1], usage: exactUsage(61) }, runs[0]]),
    baselineSurface: "codex-cli",
    candidateSurface: "piagent",
    maximumRatio: 0.65
  });
  assert.equal(aboveThreshold.passed, false);
});

test("fails all-attempt accounting closed on malformed retry attempt identities", async (t) => {
  const valid = {
    scenarioId: "s",
    repeat: 1,
    surface: "piagent",
    usage: exactUsage(60),
    usageStatus: "measured",
    infrastructureRetries: 2,
    infrastructureAttempt: 3,
    infrastructureAttempts: 3,
    infrastructureFailures: [
      { attempt: 1, usage: exactUsage(10), usageStatus: "measured-but-unaccepted" },
      { attempt: 2, usage: exactUsage(11), usageStatus: "measured-but-unaccepted" }
    ]
  };
  assert.deepEqual(benchmarkInfrastructureFailureLedgerIssues([valid]), []);

  const cases = [
    {
      name: "missing attempt identity",
      mutate(run) { delete run.infrastructureFailures[1].attempt; },
      issue: "invalid-infrastructure-failure-attempt"
    },
    {
      name: "missing retry entry",
      mutate(run) { run.infrastructureFailures.pop(); },
      issue: "retry-ledger-count-mismatch"
    },
    {
      name: "duplicate attempt identity",
      mutate(run) { run.infrastructureFailures[1].attempt = 1; },
      issue: "duplicate-infrastructure-failure-attempt"
    },
    {
      name: "out-of-range attempt identity",
      mutate(run) { run.infrastructureFailures[1].attempt = 3; },
      issue: "out-of-range-infrastructure-failure-attempt"
    },
    {
      name: "unordered attempt identity",
      mutate(run) { run.infrastructureFailures = [run.infrastructureFailures[1], run.infrastructureFailures[0]]; },
      issue: "infrastructure-failure-attempt-order-mismatch"
    },
    {
      name: "accepted attempt is not bound to the terminal attempt",
      mutate(run) { run.infrastructureAttempt = 2; },
      issue: "accepted-infrastructure-attempt-mismatch"
    }
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, () => {
      const malformed = structuredClone(valid);
      fixture.mutate(malformed);
      const issues = benchmarkInfrastructureFailureLedgerIssues([malformed]);
      assert.ok(issues[0]?.issues.includes(fixture.issue), JSON.stringify(issues));
      const accounting = benchmarkTokenAccounting([malformed]);
      assert.equal(accounting.allAttempts.ledgerExact, false);
      assert.equal(accounting.allAttempts.complete, false);
      const efficiency = evaluateAllAttemptPooledFreshEfficiency({
        tokenAccounting: accounting,
        baselineSurface: "codex-cli",
        candidateSurface: "piagent",
        maximumRatio: 0.65
      });
      assert.equal(efficiency.exact, false);
      assert.equal(efficiency.passed, false);
    });
  }
});

test("production-v2 freezes Luna medium Fast and the all-attempt net-35 release gate", () => {
  const suite = validateBenchmarkSuite(JSON.parse(fs.readFileSync(path.join(root, "benchmarks/production-v2/suite.json"), "utf8")));
  assert.equal(suite.executionContract.model, "openai-codex/gpt-5.6-luna");
  assert.equal(suite.executionContract.thinking, "medium");
  assert.equal(suite.executionContract.serviceTier, "fast");
  assert.equal(suite.releaseGate.requireFastServiceTier, true);
  assert.equal(suite.releaseGate.requireCampaignAccounting, true);
  assert.equal(suite.releaseGate.maximumAllAttemptPooledFreshTokenRatio, 0.65);
  assert.equal(suite.releaseGate.maximumFreshTokenRatioUpper95, 0.6);
});
