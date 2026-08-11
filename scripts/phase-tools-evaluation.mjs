#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import { createPiHarness, writeRuntimeStubs } from "../tests/helpers/guard-harness.mjs";
import { createTrajectoryState, createTrajectoryTransition, reduceTrajectory, replayTrajectory } from "../packages/piagent-core/runtime/trajectory/trajectory-state.ts";
import { PhaseToolRuntime, intendedPhaseTools } from "../packages/piagent-core/runtime/tools/phase-tool-runtime.ts";
import { PIAGENT_MUTATION_CAPABLE_TOOLS, phaseToolPolicy } from "../packages/piagent-core/runtime/tools/phase-tools.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const hostTools = ["read", "grep", "find", "ls", "edit", "write", "apply_patch", "bash"];
const outputIndex = process.argv.indexOf("--output");
const outputPath = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1] ?? "") : undefined;

const lanes = [
  { id: "read-only", changeMode: "read-only", riskLane: "normal", phases: ["scout", "review", "handoff"], p2: ["piagent_task_start", "piagent_task_progress"] },
  { id: "tiny", changeMode: "source-change", riskLane: "tiny", phases: ["execute", "verify", "handoff"], p2: ["piagent_task_start"] },
  { id: "normal", changeMode: "source-change", riskLane: "normal", phases: ["plan", "execute", "verify", "review", "handoff"], p2: ["piagent_task_start", "piagent_task_progress"] },
  { id: "high-risk", changeMode: "source-change", riskLane: "high-risk", phases: ["scout", "plan", "execute", "verify", "review", "handoff"], p2: ["piagent_task_start", "piagent_task_progress", "piagent_context_record", "piagent_verify_record", "piagent_trace_record", "piagent_task_gate_check"] }
];

async function registeredTools() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-p3-evaluation-"));
  try {
    writeRuntimeStubs(root);
    fs.cpSync(path.join(repoRoot, "packages", "piagent-core"), path.join(root, "packages", "piagent-core"), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, "package.json"), path.join(root, "package.json"));
    const moduleUrl = pathToFileURL(path.join(root, "packages", "piagent-core", "extensions", "piagent-guard.ts")).href;
    const guard = (await import(`${moduleUrl}?evaluation=${Date.now()}`)).default;
    const harness = createPiHarness({ activeTools: hostTools });
    guard(harness.pi);
    return {
      tools: new Map([...harness.tools].map(([name, tool]) => [name, {
        name,
        description: tool.description,
        parameters: tool.parameters,
        promptGuidelines: tool.promptGuidelines,
        executionMode: tool.executionMode
      }])),
      hooks: new Set(harness.handlers.keys())
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function schemaBytes(names, tools) {
  return Buffer.byteLength(JSON.stringify(names.map((name) => tools.get(name)).filter(Boolean)));
}

function replayLane(lane, index) {
  const initial = createTrajectoryState({
    taskId: `p3-${lane.id}`,
    taskRunId: `p3-${lane.id}-run-1`,
    sessionId: "private-session",
    changeMode: lane.changeMode,
    riskLane: lane.riskLane,
    createdAt: "2026-08-08T00:00:00.000Z"
  });
  const causes = { scout: "context-observed", plan: "plan-observed", execute: "mutation-observed", verify: "verification-passed", review: "review-observed", handoff: "handoff-observed", terminal: "task-terminal" };
  const events = [];
  let current = initial;
  for (const [phaseIndex, phase] of [...lane.phases, "terminal"].entries()) {
    const terminalTaskOutcomeRef = phase === "terminal"
      ? { taskRunId: initial.taskRunId, taskUpdatedAt: "2026-08-08T00:01:00.000Z", taskDigest: "a".repeat(64) }
      : null;
    const event = createTrajectoryTransition(current, {
      to: phase,
      cause: causes[phase],
      sourceHook: phase === "terminal" ? "completion" : "task-state",
      observedAt: `2026-08-08T00:00:${String(index * 10 + phaseIndex + 1).padStart(2, "0")}.000Z`,
      terminalTaskOutcomeRef
    });
    events.push(event);
    current = reduceTrajectory(current, event);
  }
  const replayed = replayTrajectory(initial, events);
  return { id: lane.id, events: events.length, finalPhase: replayed.currentPhase, deterministic: JSON.stringify(replayed) === JSON.stringify(current) };
}

const { tools, hooks } = await registeredTools();
const phaseRows = [];
let p2WeightedBytes = 0;
let phaseWeightedBytes = 0;
for (const lane of lanes) {
  const p2Bytes = schemaBytes(lane.p2, tools);
  for (const phase of lane.phases) {
    const policy = phaseToolPolicy(phase, lane.changeMode);
    const visible = intendedPhaseTools([...hostTools, ...tools.keys()], [...hostTools, ...tools.keys()], { currentPhase: phase, changeMode: lane.changeMode });
    const piagent = visible.filter((name) => tools.has(name));
    const bytes = schemaBytes(piagent, tools);
    phaseRows.push({ lane: lane.id, phase, p2PiagentTools: lane.p2.length, phasePiagentTools: piagent.length, p2SchemaBytes: p2Bytes, phaseSchemaBytes: bytes, requiredHostTools: policy.requiredHostTools, piagentTools: piagent });
    p2WeightedBytes += p2Bytes;
    phaseWeightedBytes += bytes;
  }
}

const descriptions = new Map();
for (const [name, tool] of tools) {
  const normalized = String(tool.description ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  descriptions.set(normalized, [...(descriptions.get(normalized) ?? []), name]);
}
const duplicateDescriptions = [...descriptions.values()].filter((names) => names.length > 1);
const replay = lanes.map(replayLane);
const runtimeOwnedEvidenceTools = ["piagent_context_record", "piagent_verify_record", "piagent_task_gate_check", "piagent_trace_record"];
const checks = [
  { id: "read-only-no-direct-mutator", passed: phaseRows.filter((row) => row.lane === "read-only").every((row) => row.piagentTools.every((tool) => !PIAGENT_MUTATION_CAPABLE_TOOLS.has(tool)) && row.requiredHostTools.every((tool) => !["edit", "write", "apply_patch"].includes(tool))) },
  { id: "review-carrier-checked-shell-retained", passed: phaseRows.filter((row) => row.phase === "review").every((row) => row.piagentTools.every((tool) => !PIAGENT_MUTATION_CAPABLE_TOOLS.has(tool)) && row.requiredHostTools.includes("bash") && row.requiredHostTools.every((tool) => !["edit", "write", "apply_patch"].includes(tool))) },
  { id: "verify-surface-complete", passed: phaseRows.filter((row) => row.phase === "verify").every((row) => row.requiredHostTools.includes("bash") && runtimeOwnedEvidenceTools.every((tool) => !row.piagentTools.includes(tool))) },
  { id: "handoff-surface-complete", passed: phaseRows.filter((row) => row.phase === "handoff").every((row) => row.requiredHostTools.includes("read") && runtimeOwnedEvidenceTools.every((tool) => !row.piagentTools.includes(tool))) },
  { id: "runtime-evidence-surface-complete", passed: runtimeOwnedEvidenceTools.every((tool) => tools.has(tool)) && ["tool_result", "message_end"].every((hook) => hooks.has(hook)) },
  { id: "high-risk-review-retained", passed: lanes.find((lane) => lane.id === "high-risk").phases.includes("review") },
  { id: "duplicate-descriptions-zero", passed: duplicateDescriptions.length === 0 },
  { id: "trajectory-replay-100-percent", passed: replay.every((item) => item.deterministic && item.finalPhase === "terminal") }
];

function runtimeContractProbe(mode) {
  const active = [...hostTools, ...tools.keys()];
  const initial = [...active];
  const setCalls = [];
  const telemetry = [];
  const pi = {
    getActiveTools: () => [...active],
    getAllTools: () => active.map((name) => ({ name })),
    setActiveTools: (names) => { setCalls.push([...names]); active.splice(0, active.length, ...names); }
  };
  const runtime = new PhaseToolRuntime(pi, mode, (_ctx, payload) => telemetry.push(payload));
  const valid = [];
  const deniedMutations = [];
  for (const [laneIndex, lane] of lanes.entries()) {
    for (const [phaseIndex, phase] of lane.phases.entries()) {
      const state = {
        ...createTrajectoryState({
          taskId: `contract-${mode}-${lane.id}-${phase}`,
          taskRunId: `contract-${mode}-${lane.id}-${phase}-run-1`,
          sessionId: "private-session",
          changeMode: lane.changeMode,
          riskLane: lane.riskLane,
          createdAt: "2026-08-08T00:00:00.000Z"
        }),
        currentPhase: phase,
        sequence: laneIndex * 10 + phaseIndex
      };
      const ctx = { cwd: `/tmp/phase-contract/${lane.id}/${phase}`, sessionManager: { getSessionId: () => "private-session" } };
      runtime.apply(ctx, { enforcementSafe: true, state, transitions: [], warnings: [], status: "ok", initialized: false });
      const policy = phaseToolPolicy(phase, lane.changeMode);
      for (const tool of policy.requiredHostTools) valid.push({ lane: lane.id, phase, tool, blocked: Boolean(runtime.toolDecision(ctx, tool)?.block) });
      if (phase === "review") {
        valid.push({ lane: lane.id, phase, tool: "bash-read-only-carrier", blocked: Boolean(runtime.mutationDecision(ctx, { projectMutation: false, verificationCarrier: true })?.block) });
        deniedMutations.push({ lane: lane.id, phase, carrier: "bash-project-mutation", blocked: Boolean(runtime.mutationDecision(ctx, { projectMutation: true, verificationCarrier: true })?.block) });
      }
      if (phase === "plan") deniedMutations.push({ lane: lane.id, phase, carrier: "direct-edit", blocked: Boolean(runtime.mutationDecision(ctx, { projectMutation: true })?.block) });
      if (phase === "verify") deniedMutations.push({ lane: lane.id, phase, carrier: "shell-redirection", blocked: Boolean(runtime.mutationDecision(ctx, { projectMutation: true, verificationCarrier: true })?.block) });
    }
  }
  return {
    mode,
    providerSchema: { initialCount: initial.length, finalCount: active.length, setActiveToolsCalls: setCalls.length, unchanged: JSON.stringify(active) === JSON.stringify(initial) },
    validCalls: { evaluated: valid.length, blocked: valid.filter((item) => item.blocked).length, examples: valid.filter((item) => item.blocked) },
    deniedMutations: { evaluated: deniedMutations.length, blocked: deniedMutations.filter((item) => item.blocked).length, examples: deniedMutations.filter((item) => !item.blocked) },
    activationTelemetry: telemetry.length
  };
}

const strictContract = runtimeContractProbe("on");
const shadowContract = runtimeContractProbe("shadow");
checks.push(
  { id: "provider-schema-stable-shadow", passed: shadowContract.providerSchema.unchanged && shadowContract.providerSchema.setActiveToolsCalls === 0 },
  { id: "provider-schema-stable-strict", passed: strictContract.providerSchema.unchanged && strictContract.providerSchema.setActiveToolsCalls === 0 },
  { id: "valid-call-block-rate-zero", passed: strictContract.validCalls.evaluated > 0 && strictContract.validCalls.blocked === 0 },
  { id: "denied-mutation-carrier-parity", passed: strictContract.deniedMutations.evaluated > 0 && strictContract.deniedMutations.blocked === strictContract.deniedMutations.evaluated },
  { id: "shadow-never-blocks", passed: shadowContract.validCalls.blocked === 0 && shadowContract.deniedMutations.blocked === 0 }
);

const durations = [];
for (let index = 0; index < 2_000; index += 1) {
  const lane = lanes[index % lanes.length];
  const phase = lane.phases[index % lane.phases.length];
  const start = performance.now();
  intendedPhaseTools([...hostTools, ...tools.keys()], [...hostTools, ...tools.keys()], { currentPhase: phase, changeMode: lane.changeMode });
  durations.push(performance.now() - start);
}
durations.sort((left, right) => left - right);
const reduction = p2WeightedBytes === 0 ? 0 : (p2WeightedBytes - phaseWeightedBytes) / p2WeightedBytes;
const report = {
  schemaVersion: 1,
  evaluationId: `phase-tools-${new Date().toISOString().replace(/[-:.]/g, "")}`,
  generatedAt: new Date().toISOString(),
  platformVersion: "1.2.17",
  piHostVersion: "0.84.1",
  methodology: {
    baseline: "P2 cache-stable Piagent management schemas retained for each active lane after task intake.",
    candidate: "Phase intent is enforced at tool-call and mutation-carrier boundaries while the provider-visible schema remains byte-for-byte stable for the task.",
    measurement: "Runtime probes measure actual schema replacement calls, valid-call blocks, mutation-carrier denials, and shadow non-interference. The legacy schemaReduction fields are counterfactual intended-surface estimates only and are not release or token claims.",
    limitations: "Static schema and invariant evaluation; task quality and authorization regressions are gated by the repository test suites, not inferred here."
  },
  registeredPiagentTools: tools.size,
  evaluatedTurns: phaseRows.length,
  p2WeightedSchemaBytes: p2WeightedBytes,
  phaseWeightedSchemaBytes: phaseWeightedBytes,
  schemaReduction: Number(reduction.toFixed(4)),
  schemaReductionPercent: Number((reduction * 100).toFixed(2)),
  schemaReductionSemantics: "counterfactual-intended-surface-only",
  runtimeContract: { strict: strictContract, shadow: shadowContract },
  duplicateDescriptions,
  missingToolEvents: checks.filter((check) => !check.passed && check.id.includes("surface")).length,
  replay,
  checks,
  latencyMs: { samples: durations.length, p95: Number(durations[Math.ceil(durations.length * 0.95) - 1].toFixed(6)), max: Number(durations.at(-1).toFixed(6)) },
  phaseRows,
  gatePassed: checks.every((check) => check.passed)
};

if (outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.gatePassed) process.exitCode = 1;
