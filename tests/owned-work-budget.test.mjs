import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createHelperRequest, defaultRolePolicy } from "../packages/piagent-core/runtime/orchestration/role-policy.ts";
import { ABSOLUTE_OWNED_WORK_CEILINGS, AUTOMATIC_OWNED_WORK_CEILINGS, DEFAULT_OWNED_WORK_CEILINGS, OwnedWorkBudgetController } from "../packages/piagent-core/runtime/orchestration/owned-work-budget.ts";
function cwd() { return fs.mkdtempSync(path.join(os.tmpdir(), "piagent-helper-budget-")); }
function request(role, objective, run = "run-1") { const policy = defaultRolePolicy(role, ["src/**"]); if (role === "worker") policy.writeScope = ["src/**"]; return createHelperRequest({ policy, objective, taskId: "task-1", taskRunId: run, sessionId: "private", parentReadScope: ["src/**"], parentWriteScope: ["src/**"], parentAllowedTools: ["read", "grep", "find", "ls", "bash", "edit", "write", "apply_patch", "contact_supervisor"], requestedWriteScope: role === "worker" ? ["src/**"] : [], singleWriterOwnership: role === "worker" ? "writer-lease-1" : null }); }
describe("Piagent-owned helper budget", () => {
  it("deduplicates one request and blocks every additional helper or writer", () => { const root = cwd(), controller = new OwnedWorkBudgetController(); const scout = request("scout", "Map source"); const first = controller.reserve(root, scout); assert.equal(first.decision, "reserved"); assert.equal(controller.reserve(root, scout).decision, "duplicate"); assert.equal(controller.reserve(root, request("scout", "Map other source")).decision, "blocked"); assert.equal(controller.reserve(root, request("worker", "Implement bounded source", "run-worker")).decision, "blocked"); });
  it("cannot be loosened by caller-provided ceilings", () => {
    const root = cwd(), controller = new OwnedWorkBudgetController();
    const roomy = { ...DEFAULT_OWNED_WORK_CEILINGS, maxScoutPasses: 99, maxConcurrentHelpers: 99, maxTotalHelpers: 99, maxWriters: 99 };
    assert.equal(controller.reserve(root, request("scout", "Map source", "run-ceilings"), undefined, roomy).decision, "reserved");
    assert.equal(controller.reserve(root, request("planner", "Plan source", "run-ceilings"), undefined, roomy).decision, "blocked");
    assert.equal(controller.reserve(root, request("worker", "Write source", "run-writer"), undefined, roomy).decision, "blocked");
  });

  it("does not loosen automatic mode by reading its ceilings", () => {
    for (const field of ["maxScoutPasses", "maxPlannerPasses", "maxReviewPasses", "maxOracleCalls"]) assert.equal(AUTOMATIC_OWNED_WORK_CEILINGS[field], 1, field);
    assert.equal(AUTOMATIC_OWNED_WORK_CEILINGS.maxWriters, 0);
    assert.equal(AUTOMATIC_OWNED_WORK_CEILINGS.maxRepairPasses, 0);
    assert.equal(AUTOMATIC_OWNED_WORK_CEILINGS.maxConcurrentHelpers, 1);
    assert.equal(AUTOMATIC_OWNED_WORK_CEILINGS.maxTotalHelpers, 1);
    const root = cwd(), controller = new OwnedWorkBudgetController();
    assert.equal(controller.reserve(root, request("scout", "one", "run-auto"), undefined, AUTOMATIC_OWNED_WORK_CEILINGS).decision, "reserved");
    assert.equal(controller.reserve(root, request("planner", "two", "run-auto"), undefined, AUTOMATIC_OWNED_WORK_CEILINGS).decision, "blocked");
  });

  it("publishes the same one-helper hard cap for default and automatic modes", () => { assert.strictEqual(DEFAULT_OWNED_WORK_CEILINGS, ABSOLUTE_OWNED_WORK_CEILINGS); assert.strictEqual(AUTOMATIC_OWNED_WORK_CEILINGS, ABSOLUTE_OWNED_WORK_CEILINGS); });

  it("recovers expired reservations without granting a retry", () => { const root = cwd(), controller = new OwnedWorkBudgetController(); const scout = request("scout", "Map source", "run-orphan"); controller.reserve(root, scout, "2026-08-08T00:00:00.000Z"); const result = controller.reserve(root, request("planner", "Plan source", "run-orphan"), "2026-08-08T01:00:00.000Z"); assert.equal(result.recoveredOrphans, 1); assert.equal(result.decision, "blocked"); assert.equal(controller.snapshot(root, scout).reservations.filter((item) => item.status === "active").length, 0); });
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
    assert.deepEqual(results.map((item) => item.decision).sort(), ["blocked", "reserved"]);
    const state = new OwnedWorkBudgetController().snapshot(root, request("scout", "Map source", "concurrent-run"));
    assert.equal(state.reservations.filter((item) => item.status === "active").length, 1);
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
