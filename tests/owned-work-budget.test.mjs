import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createHelperRequest, defaultRolePolicy } from "../packages/piagent-core/runtime/orchestration/role-policy.ts";
import { AUTOMATIC_OWNED_WORK_CEILINGS, DEFAULT_OWNED_WORK_CEILINGS, OwnedWorkBudgetController } from "../packages/piagent-core/runtime/orchestration/owned-work-budget.ts";
function cwd() { return fs.mkdtempSync(path.join(os.tmpdir(), "piagent-helper-budget-")); }
function request(role, objective, run = "run-1") { const policy = defaultRolePolicy(role, ["src/**"]); if (role === "worker") policy.writeScope = ["src/**"]; return createHelperRequest({ policy, objective, taskId: "task-1", taskRunId: run, sessionId: "private", parentReadScope: ["src/**"], parentWriteScope: ["src/**"], parentAllowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor"], requestedWriteScope: role === "worker" ? ["src/**"] : [], singleWriterOwnership: role === "worker" ? "writer-lease-1" : null }); }
describe("Piagent-owned helper budget", () => {
  it("deduplicates requests and enforces total, role, and one-writer ceilings", () => { const root = cwd(), controller = new OwnedWorkBudgetController(); const scout = request("scout", "Map source"); const first = controller.reserve(root, scout); assert.equal(first.decision, "reserved"); assert.equal(controller.reserve(root, scout).decision, "duplicate"); assert.equal(controller.reserve(root, request("scout", "Map other source")).decision, "blocked"); const worker = request("worker", "Implement bounded source"); assert.equal(controller.reserve(root, worker).decision, "reserved"); assert.equal(controller.reserve(root, request("worker", "Second writer")).decision, "blocked"); });
  it("honours the per-role ceilings it is given instead of a fixed one", () => {
    // These six numbers were declared and never read: the per-role limits were
    // real but fixed at one apiece, so raising `maxScoutPasses` in a profile did
    // nothing while `maxTotalHelpers` beside it took effect. Half-honoured
    // configuration reads as working configuration.
    const root = cwd(), controller = new OwnedWorkBudgetController();
    const ceilings = { ...DEFAULT_OWNED_WORK_CEILINGS, maxScoutPasses: 2, maxConcurrentHelpers: 3, maxTotalHelpers: 4 };
    assert.equal(controller.reserve(root, request("scout", "Map source", "run-ceilings"), undefined, ceilings).decision, "reserved");
    assert.equal(controller.reserve(root, request("scout", "Map other source", "run-ceilings"), undefined, ceilings).decision, "reserved");
    // The raised ceiling still ends somewhere.
    assert.equal(controller.reserve(root, request("scout", "Map a third source", "run-ceilings"), undefined, ceilings).decision, "blocked");
  });

  it("stops each role at its own ceiling, not at a neighbouring one", () => {
    // The total ceiling masks a per-role ceiling unless it is raised out of the
    // way: an assertion that passes because a different limit fired proves
    // nothing about the limit it names.
    const root = cwd(), controller = new OwnedWorkBudgetController();
    const roomy = { ...DEFAULT_OWNED_WORK_CEILINGS, maxConcurrentHelpers: 12, maxTotalHelpers: 12 };
    assert.equal(controller.reserve(root, request("planner", "Plan one", "run-planner"), undefined, roomy).decision, "reserved");
    assert.equal(controller.reserve(root, request("planner", "Plan two", "run-planner"), undefined, roomy).decision, "blocked");
    assert.equal(controller.reserve(root, request("planner", "Plan two", "run-planner"), undefined, { ...roomy, maxPlannerPasses: 2 }).decision, "reserved");
    // Every role the object names, not just the ones a test happened to reach.
    for (const [role, field] of [["reviewer", "maxReviewPasses"], ["oracle", "maxOracleCalls"], ["scout", "maxScoutPasses"]]) {
      const run = `run-${role}`;
      assert.equal(controller.reserve(root, request(role, "first", run), undefined, roomy).decision, "reserved", role);
      assert.equal(controller.reserve(root, request(role, "second", run), undefined, roomy).decision, "blocked", role);
      assert.equal(controller.reserve(root, request(role, "second", run), undefined, { ...roomy, [field]: 2 }).decision, "reserved", field);
    }
  });

  it("counts a finished writer against the writer ceiling", () => {
    // The single-writer check only looks at active reservations, so it hides the
    // writer ceiling for every case except this one: a writer that already
    // finished still consumed the budget.
    const root = cwd(), controller = new OwnedWorkBudgetController();
    const roomy = { ...DEFAULT_OWNED_WORK_CEILINGS, maxConcurrentHelpers: 12, maxTotalHelpers: 12 };
    const first = request("worker", "Write one", "run-writer");
    const reserved = controller.reserve(root, first, undefined, roomy);
    assert.equal(reserved.decision, "reserved");
    controller.release(root, first, reserved.reservationId, "succeeded", {});
    assert.equal(controller.reserve(root, request("worker", "Write two", "run-writer"), undefined, roomy).decision, "blocked");
    assert.equal(controller.reserve(root, request("worker", "Write two", "run-writer"), undefined, { ...roomy, maxWriters: 2 }).decision, "reserved");
  });

  it("does not loosen automatic mode by reading its ceilings", () => {
    // Automatic mode is the one that dispatches without an operator in the loop,
    // so making the per-role numbers configurable must not have widened it. Its
    // ceilings differ from the default only in the two totals.
    for (const field of ["maxScoutPasses", "maxPlannerPasses", "maxReviewPasses", "maxOracleCalls", "maxWriters"]) {
      assert.equal(AUTOMATIC_OWNED_WORK_CEILINGS[field], 1, field);
    }
    assert.equal(AUTOMATIC_OWNED_WORK_CEILINGS.maxConcurrentHelpers, 1);
    assert.equal(AUTOMATIC_OWNED_WORK_CEILINGS.maxTotalHelpers, 1);
    const root = cwd(), controller = new OwnedWorkBudgetController();
    assert.equal(controller.reserve(root, request("scout", "one", "run-auto"), undefined, AUTOMATIC_OWNED_WORK_CEILINGS).decision, "reserved");
    assert.equal(controller.reserve(root, request("planner", "two", "run-auto"), undefined, AUTOMATIC_OWNED_WORK_CEILINGS).decision, "blocked");
  });

  it("keeps the shipped behaviour when the default ceilings are used", () => {
    // The mapping must reproduce the constants it replaced, or this is a
    // behavioural change wearing a refactor's clothes.
    const root = cwd(), controller = new OwnedWorkBudgetController();
    assert.equal(controller.reserve(root, request("scout", "Map source", "run-default")).decision, "reserved");
    assert.equal(controller.reserve(root, request("scout", "Map other", "run-default")).decision, "blocked");
  });

  it("recovers expired reservations without creating extra budget", () => { const root = cwd(), controller = new OwnedWorkBudgetController(); const scout = request("scout", "Map source", "run-orphan"); controller.reserve(root, scout, "2026-08-08T00:00:00.000Z"); const result = controller.reserve(root, request("planner", "Plan source", "run-orphan"), "2026-08-08T01:00:00.000Z"); assert.equal(result.recoveredOrphans, 1); assert.equal(result.decision, "reserved"); assert.equal(controller.snapshot(root, scout).reservations.filter((item) => item.status === "active").length, 1); });
  it("cancels active helpers at parent terminal and ignores late release", () => { const root = cwd(), controller = new OwnedWorkBudgetController(); const scout = request("scout", "Map source", "run-terminal"); const reserved = controller.reserve(root, scout); controller.markParentTerminal(root, scout); controller.release(root, scout, reserved.reservationId, "succeeded", { output: "late raw output" }); const state = controller.snapshot(root, scout); assert.equal(state.terminal, true); assert.equal(state.reservations[0].status, "cancelled"); assert.equal(JSON.stringify(state).includes("late raw output"), false); assert.equal(controller.reserve(root, request("planner", "late", "run-terminal")).decision, "blocked"); });
  it("serializes concurrent read-only reservations across processes without deadlock", async () => {
    const root = cwd();
    const worker = path.resolve(import.meta.dirname, "fixtures/helper-budget-worker.mjs");
    const run = (role, objective) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [worker, root, role, objective], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", reject);
      child.on("exit", (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr || `worker exited ${code}`)));
    });
    let timeout;
    const timeoutPromise = new Promise((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error("concurrent budget reservation timed out")), 5_000);
      timeout.unref();
    });
    let results;
    try {
      results = await Promise.race([Promise.all([run("scout", "Map source"), run("planner", "Plan source")]), timeoutPromise]);
    } finally {
      clearTimeout(timeout);
    }
    assert.deepEqual(results.map((item) => item.decision), ["reserved", "reserved"]);
    const state = new OwnedWorkBudgetController().snapshot(root, request("scout", "Map source", "concurrent-run"));
    assert.equal(state.reservations.filter((item) => item.status === "active").length, 2);
  });
  it("recovers a stale owner lock left by an interrupted process", () => {
    const root = cwd();
    const stale = path.join(root, ".pi", "piagent-state", "helper-budgets", "stale-run.json.lock");
    fs.mkdirSync(path.dirname(stale), { recursive: true });
    fs.writeFileSync(stale, "interrupted\n", { mode: 0o600 });
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(stale, old, old);
    const result = new OwnedWorkBudgetController().reserve(root, request("scout", "Map source", "stale-run"));
    assert.equal(result.decision, "reserved");
    assert.equal(fs.existsSync(stale), false);
  });
  it("rejects late release and records bounded evidence for direct budget overflow", () => {
    const root = cwd(), controller = new OwnedWorkBudgetController();
    const scout = request("scout", "Budget source", "run-budget");
    const first = controller.reserve(root, scout);
    const overflow = controller.release(root, scout, first.reservationId, "succeeded", {
      calls: scout.ceilings.calls + 1000, tokens: scout.contextBudget + 1000, output: "private overflow output"
    });
    assert.equal(overflow.status, "failed"); assert.equal(overflow.reason, "helper-call-budget-exceeded");
    const reservation = controller.snapshot(root, scout).reservations[0];
    assert.equal(reservation.usageRef.calls, scout.ceilings.calls + 1);
    assert.equal(reservation.usageRef.tokens, scout.contextBudget + 1);
    assert.equal(reservation.usageRef.outputDigest, null);
    const late = controller.release(root, scout, first.reservationId, "succeeded", { output: "late raw output" });
    assert.equal(late.accepted, false); assert.equal(late.reason, "reservation-not-active");
    assert.equal(JSON.stringify(controller.snapshot(root, scout)).includes("late raw output"), false);
  });
});
