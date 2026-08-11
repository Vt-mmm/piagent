import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { buildAcceptanceReceipt } from "../packages/piagent-core/extensions/acceptance-receipt.js";
import { runtimeAutomaticSourceExecutionReady, sourceExecutionAuthorized } from "../packages/piagent-core/extensions/task-lifecycle.js";
import { taskContractValidationErrors } from "../packages/piagent-core/extensions/task-state.js";
import { createTrajectoryState } from "../packages/piagent-core/runtime/trajectory/trajectory-state.ts";
import { TrajectoryRuntime } from "../packages/piagent-core/runtime/trajectory/trajectory-runtime.ts";
import { readTrajectoryStore } from "../packages/piagent-core/runtime/trajectory/trajectory-store.ts";
import { PhaseToolRuntime, intendedPhaseTools, phaseToolModeFromEnvironment } from "../packages/piagent-core/runtime/tools/phase-tool-runtime.ts";
import { PIAGENT_TOOL_ORDER } from "../packages/piagent-core/runtime/tools/tool-groups.ts";

const hostTools = ["read", "grep", "find", "ls", "edit", "write", "apply_patch", "bash", "shell", "exec", "browser"];
const state = (phase, changeMode = "source-change", riskLane = "normal") => ({
  ...createTrajectoryState({ taskId: `task-${phase}`, taskRunId: `task-${phase}-run-1`, sessionId: "private", changeMode, riskLane, createdAt: "2026-08-08T00:00:00.000Z" }),
  currentPhase: phase
});
const context = {
  cwd: "/tmp/phase-tools",
  sessionManager: { getSessionId: () => "session-1" }
};

function runtimeHarness(initial) {
  let active = [...initial];
  const setCalls = [];
  const telemetry = [];
  const pi = {
    getActiveTools: () => [...active],
    getAllTools: () => [...hostTools, ...PIAGENT_TOOL_ORDER].map((name) => ({ name })),
    setActiveTools: (tools) => { active = [...tools]; setCalls.push([...tools]); }
  };
  return { pi, setCalls, telemetry, active: () => active, emit: (_ctx, payload) => telemetry.push(payload) };
}

function taskContract({
  id,
  changeMode = "source-change",
  riskLane = "normal",
  intakeMode = "runtime",
  workPlan
}) {
  const createdAt = "2026-08-09T00:00:00.000Z";
  const acceptance = buildAcceptanceReceipt({
    summary: `Implement bounded behavior for ${id}.`,
    expectedOutput: `The bounded ${id} behavior is complete and verified.`,
    acceptanceCriteria: [`The requested ${id} behavior passes its exact verifier.`],
    changeMode,
    source: intakeMode,
    generatedAt: createdAt
  });
  return {
    schemaVersion: 2,
    taskRunId: `${id}-run-1`,
    taskId: id,
    sessionId: "session-1",
    sessionName: `TEST ${id}`,
    changeMode,
    attempt: 1,
    maxAttempts: 3,
    previousAttempts: [],
    summary: `Implement bounded behavior for ${id}.`,
    riskLane,
    intakeMode,
    expectedOutput: `The bounded ${id} behavior is complete and verified.`,
    acceptanceCriteria: acceptance.acceptanceCriteria,
    scope: ["src/**"],
    outOfScope: ["Unrelated files."],
    protectedPaths: [],
    requiredContext: [],
    contextManifest: [],
    memoryCitations: [],
    mcpCapabilities: [],
    verifyGroup: changeMode === "source-change" ? "source" : "read-only",
    verifyCommands: changeMode === "source-change" ? ["npm test"] : [],
    workPlan,
    reviewLenses: ["correctness", "tests", "scope"],
    acceptanceReceipt: acceptance.receipt,
    workingTreeDigestAlgorithm: "wt-content-v2",
    baselineChangedFiles: [],
    baselineFileDigests: {},
    observedChangedFiles: [],
    finalWorkingTreeFiles: [],
    finalFileDigests: {},
    changedFiles: [],
    verifyEvidence: [],
    trace: { outcome: "pending" },
    createdAt,
    updatedAt: createdAt
  };
}

function phaseContext(cwd, sessionId = "session-1") {
  return { cwd, sessionManager: { getSessionId: () => sessionId } };
}

function automaticWorkPlan() {
  return [
    { id: "implement", title: "Implement the bounded change.", role: "parent", mode: "single-writer", status: "in-progress" },
    { id: "verify", title: "Verify the bounded change.", role: "parent", mode: "review", status: "pending", dependsOn: ["implement"] }
  ];
}

describe("phase tool activation runtime", () => {
  it("defaults invalid or absent configuration to observational shadow mode", () => {
    assert.equal(phaseToolModeFromEnvironment(undefined), "shadow");
    assert.equal(phaseToolModeFromEnvironment("unexpected"), "shadow");
    assert.equal(phaseToolModeFromEnvironment(" OFF "), "off");
    assert.equal(phaseToolModeFromEnvironment("on"), "on");
  });

  it("builds stable rollout surfaces for read-only, tiny, normal, and high-risk phases", () => {
    const available = [...hostTools, ...PIAGENT_TOOL_ORDER];
    const cases = [
      state("scout", "read-only", "normal"),
      state("execute", "source-change", "tiny"),
      state("plan", "source-change", "normal"),
      state("review", "source-change", "high-risk")
    ];
    for (const current of cases) {
      const first = intendedPhaseTools(["read", "bash", "edit", "write", "browser", ...PIAGENT_TOOL_ORDER], available, current);
      const second = intendedPhaseTools(first, available, current);
      assert.deepEqual(second, first);
      assert.equal(first[0], "browser", "unclassified builtins retain host visibility and order");
    }
    const readOnly = intendedPhaseTools([...hostTools, ...PIAGENT_TOOL_ORDER], available, state("scout", "read-only"));
    const review = intendedPhaseTools([...hostTools, ...PIAGENT_TOOL_ORDER], available, state("review", "source-change", "high-risk"));
    assert.equal(readOnly.some((tool) => ["edit", "write", "apply_patch", "bash", "piagent_source_checkout", "piagent_context_engine"].includes(tool)), false);
    assert.equal(review.some((tool) => ["edit", "write", "apply_patch", "piagent_source_checkout", "piagent_context_engine"].includes(tool)), false);
    assert.ok(review.includes("bash"), "review retains read-only shell inspection while carrier authorization blocks writes");
    const intake = intendedPhaseTools([...hostTools, ...PIAGENT_TOOL_ORDER], available, state("intake"));
    const plan = intendedPhaseTools([...hostTools, ...PIAGENT_TOOL_ORDER], available, state("plan", "source-change", "high-risk"));
    for (const surface of [intake, plan]) {
      for (const tool of ["read", "grep", "find", "ls"]) assert.ok(surface.includes(tool));
      for (const tool of ["edit", "write", "apply_patch", "bash", "shell", "exec"]) assert.equal(surface.includes(tool), false);
    }
    for (const phase of ["execute", "repair"]) {
      const surface = intendedPhaseTools([...hostTools, ...PIAGENT_TOOL_ORDER], available, state(phase));
      for (const tool of ["read", "grep", "find", "ls", "edit", "write", "apply_patch", "bash", "shell", "exec"]) assert.ok(surface.includes(tool));
    }
    const verify = intendedPhaseTools(hostTools, available, state("verify"));
    assert.ok(verify.includes("bash"));
    assert.equal(verify.some((tool) => tool.startsWith("piagent_")), false);
  });

  it("authorizes a runtime-owned normal task into execute before its first mutation with an audited plan skip", (t) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-auto-normal-phase-"));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const task = taskContract({ id: "auto-normal", riskLane: "normal", workPlan: automaticWorkPlan() });
    assert.deepEqual(taskContractValidationErrors(task), []);
    assert.equal(runtimeAutomaticSourceExecutionReady(task), true);

    const result = new TrajectoryRuntime().sync(cwd, "session-1", task, {
      sourceHook: "agent-start",
      observedAt: "2026-08-09T00:00:00.001Z"
    });
    assert.equal(result.state.currentPhase, "execute");
    assert.deepEqual(result.transitions.map(({ from, to, cause, skippedPhases }) => ({ from, to, cause, skippedPhases })), [{
      from: "intake",
      to: "execute",
      cause: "execution-authorized",
      skippedPhases: ["plan"]
    }]);
    assert.match(result.transitions[0].skipReason, /runtime-owned automatic work plan/i);
    assert.equal(readTrajectoryStore(cwd, task.taskRunId).state.currentPhase, "execute");

    const harness = runtimeHarness([...hostTools, ...PIAGENT_TOOL_ORDER]);
    const phaseRuntime = new PhaseToolRuntime(harness.pi, "on", harness.emit);
    const ctx = phaseContext(cwd);
    phaseRuntime.apply(ctx, result);
    for (const tool of ["read", "grep", "find", "ls", "edit", "write", "apply_patch", "bash", "shell", "exec"]) {
      assert.equal(phaseRuntime.toolDecision(ctx, tool), undefined);
    }
    assert.equal(harness.setCalls.length, 0, "provider-visible schemas stay stable");
  });

  it("authorizes a runtime-owned tiny task through the adjacent executable edge", (t) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-auto-tiny-phase-"));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const task = taskContract({ id: "auto-tiny", riskLane: "tiny", workPlan: automaticWorkPlan() });
    assert.deepEqual(taskContractValidationErrors(task), []);
    const result = new TrajectoryRuntime().sync(cwd, "session-1", task, {
      sourceHook: "agent-start",
      observedAt: "2026-08-09T00:00:00.001Z"
    });
    assert.equal(result.state.currentPhase, "execute");
    assert.equal(result.transitions[0].cause, "execution-authorized");
    assert.deepEqual(result.transitions[0].skippedPhases, []);
    assert.equal(result.transitions[0].skipReason, null);

    const harness = runtimeHarness([...hostTools, ...PIAGENT_TOOL_ORDER]);
    const phaseRuntime = new PhaseToolRuntime(harness.pi, "on", harness.emit);
    const ctx = phaseContext(cwd);
    phaseRuntime.apply(ctx, result);
    assert.equal(phaseRuntime.toolDecision(ctx, "apply_patch"), undefined);
    assert.equal(harness.setCalls.length, 0);
  });

  it("starts the exact manual high-risk plan in discovery-only mode and opens mutation only after every writer dependency", (t) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-manual-high-phase-"));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const task = taskContract({
      id: "manual-high",
      riskLane: "high-risk",
      intakeMode: "model",
      workPlan: [
        { id: "plan", title: "Confirm the high-risk plan.", role: "parent", mode: "read-only", status: "in-progress" },
        { id: "challenge", title: "Challenge the high-risk plan.", role: "piagent-oracle", mode: "review", status: "pending", dependsOn: ["plan"] },
        { id: "implement", title: "Implement the approved plan.", role: "parent", mode: "single-writer", status: "pending", dependsOn: ["plan", "challenge"] },
        { id: "review", title: "Review the implementation.", role: "piagent-reviewer", mode: "review", status: "pending", dependsOn: ["implement"] }
      ]
    });
    assert.deepEqual(taskContractValidationErrors(task), []);
    assert.equal(runtimeAutomaticSourceExecutionReady(task), false);
    assert.equal(sourceExecutionAuthorized(task), false);

    const trajectory = new TrajectoryRuntime();
    let result = trajectory.sync(cwd, "session-1", task, {
      sourceHook: "agent-start",
      observedAt: "2026-08-09T00:00:00.001Z"
    });
    assert.equal(result.state.currentPhase, "plan");
    assert.equal(result.transitions[0].cause, "explicit-skip");
    assert.deepEqual(result.transitions[0].skippedPhases, ["scout"]);

    const harness = runtimeHarness([...hostTools, ...PIAGENT_TOOL_ORDER]);
    const phaseRuntime = new PhaseToolRuntime(harness.pi, "on", harness.emit);
    const ctx = phaseContext(cwd);
    phaseRuntime.apply(ctx, result);
    for (const tool of ["read", "grep", "find", "ls", "piagent_task_progress"]) assert.equal(phaseRuntime.toolDecision(ctx, tool), undefined);
    for (const tool of ["edit", "write", "apply_patch", "bash", "shell", "exec"]) assert.match(phaseRuntime.toolDecision(ctx, tool).reason, /Phase plan does not allow/);

    task.workPlan.find((step) => step.id === "plan").status = "done";
    task.workPlan.find((step) => step.id === "challenge").status = "in-progress";
    result = trajectory.sync(cwd, "session-1", task, { sourceHook: "task-state", observedAt: "2026-08-09T00:00:00.002Z" });
    assert.equal(result.state.currentPhase, "plan");
    assert.equal(sourceExecutionAuthorized(task), false);

    task.workPlan.find((step) => step.id === "challenge").status = "skipped";
    task.workPlan.find((step) => step.id === "implement").status = "in-progress";
    assert.equal(sourceExecutionAuthorized(task), false, "a skipped high-risk dependency is not execution authorization");
    result = trajectory.sync(cwd, "session-1", task, { sourceHook: "task-state", observedAt: "2026-08-09T00:00:00.003Z" });
    assert.equal(result.state.currentPhase, "plan");
    assert.match(phaseRuntime.toolDecision(ctx, "edit").reason, /Phase plan does not allow/);

    task.workPlan.find((step) => step.id === "challenge").status = "done";
    result = trajectory.sync(cwd, "session-1", task, { sourceHook: "task-state", observedAt: "2026-08-09T00:00:00.004Z" });
    assert.equal(sourceExecutionAuthorized(task), true);
    assert.equal(result.state.currentPhase, "execute");
    assert.equal(result.transitions[0].cause, "execution-authorized");
    phaseRuntime.apply(ctx, result);
    assert.equal(phaseRuntime.toolDecision(ctx, "apply_patch"), undefined);
  });

  it("keeps runtime-owned read-only tasks outside executable phases and strips every mutator", (t) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-readonly-phase-"));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const task = taskContract({
      id: "auto-readonly",
      changeMode: "read-only",
      riskLane: "normal",
      workPlan: [{ id: "scout", title: "Inspect bounded evidence.", role: "parent", mode: "read-only", status: "in-progress" }]
    });
    assert.deepEqual(taskContractValidationErrors(task), []);
    assert.equal(runtimeAutomaticSourceExecutionReady(task), false);
    assert.equal(sourceExecutionAuthorized(task), false);
    const result = new TrajectoryRuntime().sync(cwd, "session-1", task, {
      sourceHook: "agent-start",
      observedAt: "2026-08-09T00:00:00.001Z"
    });
    assert.equal(result.state.currentPhase, "scout");
    assert.equal(result.transitions.some((event) => event.to === "execute"), false);

    const harness = runtimeHarness([...hostTools, ...PIAGENT_TOOL_ORDER]);
    const phaseRuntime = new PhaseToolRuntime(harness.pi, "on", harness.emit);
    const ctx = phaseContext(cwd);
    phaseRuntime.apply(ctx, result);
    for (const tool of ["read", "grep", "find", "ls"]) assert.equal(phaseRuntime.toolDecision(ctx, tool), undefined);
    for (const tool of ["edit", "write", "apply_patch", "bash", "shell", "exec"]) assert.match(phaseRuntime.toolDecision(ctx, tool).reason, /does not allow/);
    assert.equal(harness.setCalls.length, 0);
  });

  it("records shadow differences without changing visible tools and deduplicates observations", () => {
    const harness = runtimeHarness(["read", "bash", "edit", "write", "browser"]);
    const runtime = new PhaseToolRuntime(harness.pi, "shadow", harness.emit);
    const result = { enforcementSafe: true, state: state("review"), transitions: [], warnings: [], status: "ok", initialized: false };
    runtime.apply(context, result);
    runtime.apply(context, result);
    assert.deepEqual(harness.active(), ["read", "bash", "edit", "write", "browser"]);
    assert.equal(harness.setCalls.length, 0);
    assert.equal(harness.telemetry.length, 1);
    assert.equal(harness.telemetry[0].applied, false);
  });

  it("keeps schemas stable in on mode and enforces phase policy at tool-call time", () => {
    const onHarness = runtimeHarness(["read", "bash", "edit", "write", "browser"]);
    const on = new PhaseToolRuntime(onHarness.pi, "on", onHarness.emit);
    const result = { enforcementSafe: true, state: state("verify"), transitions: [], warnings: [], status: "ok", initialized: false };
    on.apply(context, result);
    on.apply(context, result);
    assert.equal(onHarness.setCalls.length, 0);
    assert.deepEqual(onHarness.active(), ["read", "bash", "edit", "write", "browser"]);
    assert.equal(on.toolDecision(context, "bash"), undefined);
    assert.match(on.toolDecision(context, "edit").reason, /Phase verify does not allow/);
    assert.match(on.toolDecision(context, "piagent_task_progress").reason, /Phase verify does not allow/);
    assert.equal(onHarness.telemetry[0].enforcement, "tool-call-guard");

    const offHarness = runtimeHarness(["read", "bash", "edit", "write"]);
    new PhaseToolRuntime(offHarness.pi, "off", offHarness.emit).apply(context, result);
    new PhaseToolRuntime(offHarness.pi, "on", offHarness.emit).apply(context, { ...result, enforcementSafe: false, state: undefined, status: "corrupt" });
    assert.deepEqual(offHarness.active(), ["read", "bash", "edit", "write"]);
    assert.equal(offHarness.setCalls.length, 0);
  });

  it("allows review inspection but blocks review mutation through the carrier policy", () => {
    const harness = runtimeHarness(["read", "bash", "edit", "write", "browser"]);
    const runtime = new PhaseToolRuntime(harness.pi, "on", harness.emit);
    runtime.apply(context, { enforcementSafe: true, state: state("review"), transitions: [], warnings: [], status: "ok", initialized: false });
    assert.equal(runtime.toolDecision(context, "bash"), undefined);
    assert.equal(runtime.mutationDecision(context, { projectMutation: false, verificationCarrier: true }), undefined);
    assert.match(runtime.mutationDecision(context, { projectMutation: true, verificationCarrier: true }).reason, /allowed only in execute or repair/);
    assert.equal(harness.setCalls.length, 0, "review policy never rewrites provider-visible schemas");

    const readOnly = new PhaseToolRuntime(harness.pi, "on", harness.emit);
    readOnly.apply(context, { enforcementSafe: true, state: state("review", "read-only"), transitions: [], warnings: [], status: "ok", initialized: false });
    assert.equal(readOnly.toolDecision(context, "bash"), undefined);
    assert.equal(readOnly.mutationDecision(context, { projectMutation: false, verificationCarrier: true }), undefined);
    assert.match(readOnly.mutationDecision(context, { projectMutation: true, verificationCarrier: true }).reason, /read-only/);
  });

  it("uses the task-pinned authority mode instead of a stronger process-wide phase setting", () => {
    const harness = runtimeHarness(["read", "bash", "edit", "write"]);
    let pinnedMode = "shadow";
    const runtime = new PhaseToolRuntime(harness.pi, "on", harness.emit, () => undefined, () => pinnedMode);
    const result = { enforcementSafe: true, state: state("verify"), transitions: [], warnings: [], status: "ok", initialized: false };
    runtime.apply(context, result);
    assert.equal(runtime.toolDecision(context, "edit"), undefined, "observe authority cannot block a model call");
    assert.equal(runtime.mutationDecision(context, { projectMutation: true }), undefined, "observe authority cannot block mutation");
    assert.equal(harness.telemetry[0].mode, "shadow");
    pinnedMode = "on";
    assert.match(runtime.toolDecision(context, "edit").reason, /Phase verify does not allow/);
    assert.match(runtime.mutationDecision(context, { projectMutation: true }).reason, /does not authorize project mutation/);
  });

  it("enforces detected project mutation independently from the provider tool name", () => {
    const decisionFor = (phase, input, changeMode = "source-change") => {
      const harness = runtimeHarness([...hostTools, ...PIAGENT_TOOL_ORDER]);
      const runtime = new PhaseToolRuntime(harness.pi, "on", harness.emit);
      runtime.apply(context, { enforcementSafe: true, state: state(phase, changeMode), transitions: [], warnings: [], status: "ok", initialized: false });
      return runtime.mutationDecision(context, input);
    };

    assert.equal(decisionFor("execute", { projectMutation: true }), undefined);
    assert.equal(decisionFor("repair", { projectMutation: true }), undefined);
    assert.match(decisionFor("plan", { projectMutation: true }).reason, /allowed only in execute or repair/);
    assert.equal(decisionFor("execute", { projectMutation: false, exactSourceVerifier: true }), undefined);
    assert.equal(decisionFor("verify", { projectMutation: false, exactSourceVerifier: true }), undefined);
    assert.equal(decisionFor("repair", { projectMutation: false, exactSourceVerifier: true }), undefined);
    const exactNodeTestInVerify = { projectMutation: true, exactSourceVerifier: true };
    const nonExactRedirectionInVerify = { projectMutation: true, exactSourceVerifier: false };
    assert.equal(decisionFor("verify", exactNodeTestInVerify), undefined, "an exact node --test command remains usable under conservative interpreter classification");
    assert.match(decisionFor("verify", nonExactRedirectionInVerify).reason, /does not authorize project mutation/);
    assert.match(decisionFor("scout", { projectMutation: true }, "read-only").reason, /read-only/);
    assert.equal(decisionFor("plan", { projectMutation: false }), undefined);
  });

  it("opens only the bounded migration exit under phase-tools on", () => {
    const harness = runtimeHarness([...hostTools, ...PIAGENT_TOOL_ORDER]);
    let migrationStatus = "new-attempt-required";
    const runtime = new PhaseToolRuntime(harness.pi, "on", harness.emit, () => migrationStatus);
    runtime.apply(context, { enforcementSafe: true, state: state("terminal"), transitions: [], warnings: [], status: "ok", initialized: false });
    assert.equal(runtime.toolDecision(context, "piagent_task_start"), undefined);
    assert.match(runtime.toolDecision(context, "edit").reason, /Phase terminal/);

    migrationStatus = "verification-refresh-required";
    assert.equal(runtime.mutationDecision(context, { projectMutation: false, exactSourceVerifier: true, verificationCarrier: true }), undefined);
    assert.match(runtime.mutationDecision(context, { projectMutation: false, exactSourceVerifier: false, verificationCarrier: true }).reason, /exact configured verifier/);
    assert.equal(runtime.mutationDecision(context, { projectMutation: true, exactSourceVerifier: true, verificationCarrier: true }), undefined);
    assert.equal(runtime.mutationDecision(context, { projectMutation: false, verificationCarrier: false }), undefined);

    migrationStatus = "refreshed";
    assert.match(runtime.mutationDecision(context, { projectMutation: false, exactSourceVerifier: true, verificationCarrier: true }).reason, /verification is allowed only/);
  });

  it("uses native execution metadata without adding hook-time lock state", () => {
    const root = path.resolve(import.meta.dirname, "..");
    const sources = [
      "packages/piagent-core/runtime/hooks/tool-call-hook.ts",
      "packages/piagent-core/runtime/hooks/tool-result-hook.ts",
      "packages/piagent-core/runtime/registration/extension-registration.ts"
    ].map((file) => fs.readFileSync(path.join(root, file), "utf8")).join("\n");
    assert.doesNotMatch(sources, /\bRwLock\b|\bacquire(?:Read|Write|Lock)\b|\brelease(?:Read|Write|Lock)\b/);
  });
});
