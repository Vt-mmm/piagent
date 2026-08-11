import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { taskJournalPaths } from "../packages/piagent-core/extensions/task-journal.js";
import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/working-tree-digest.js";
import { createBoundTaskAuthority } from "../packages/piagent-core/runtime/policy/task-authority-runtime.ts";
import {
  continuationClassForRecovery,
  continuationProgressSignature,
  inspectTaskContinuationBudget,
  reserveTaskContinuation
} from "../packages/piagent-core/runtime/recovery/continuation-budget.ts";

const roots = new Set();
const execFileAsync = promisify(execFile);
afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-continuation-"));
  roots.add(root);
  return root;
}

function task(profile = "broad-default", suffix = "one") {
  const carrier = {
    taskId: `task-${suffix}`,
    taskRunId: `run-${suffix}`,
    createdAt: "2026-08-10T11:00:00.000Z",
    sessionId: `session-${suffix}`,
    sessionName: `TASK-${suffix.toUpperCase()}`
  };
  return { ...carrier, authoritySnapshot: createBoundTaskAuthority({ ...carrier, profile }) };
}

const emptyTree = workingTreeEvidenceDigest({});
const changedTree = workingTreeEvidenceDigest({ "src/value.ts": `wt-content-v2:${"a".repeat(64)}` });
const recoveryRequest = {
  capabilityId: "CAP-12",
  classification: "verifier-retry",
  action: "retry",
  currentWorkingTreeDigest: emptyTree,
  missing: ["exact verifier: npm test"],
  missingVerifyCommands: ["npm test"],
  evidenceDigest: "b".repeat(64),
  reasonCodes: ["transient-verifier-retry"]
};

describe("one global task continuation budget", () => {
  it("atomically consumes one task-wide unit and hands off repeated or changed signatures", () => {
    const cwd = project(), currentTask = task();
    const first = reserveTaskContinuation(cwd, currentTask, recoveryRequest);
    assert.deepEqual({ allowed: first.allowed, reason: first.reason, consumed: first.consumed, maximum: first.maximum }, {
      allowed: true, reason: "reserved", consumed: 1, maximum: 1
    });
    const repeated = reserveTaskContinuation(cwd, structuredClone(currentTask), recoveryRequest);
    assert.equal(repeated.allowed, false);
    assert.equal(repeated.reason, "repeated-progress-signature");
    assert.equal(repeated.progressSignature, first.progressSignature);
    const progressed = reserveTaskContinuation(cwd, currentTask, { ...recoveryRequest, currentWorkingTreeDigest: changedTree });
    assert.equal(progressed.allowed, false);
    assert.equal(progressed.reason, "global-budget-exhausted");
    assert.notEqual(progressed.progressSignature, first.progressSignature);
    assert.deepEqual(inspectTaskContinuationBudget(cwd, currentTask), {
      enforcementSafe: true, consumed: 1, maximum: 1, signatures: [first.progressSignature], reason: "ok"
    });
  });

  it("allows only one winner when separate runtime processes reserve concurrently", async () => {
    const cwd = project(), currentTask = task("broad-default", "concurrent");
    const moduleUrl = pathToFileURL(path.resolve("packages/piagent-core/runtime/recovery/continuation-budget.ts")).href;
    const source = [
      `import { reserveTaskContinuation } from ${JSON.stringify(moduleUrl)};`,
      "const result = reserveTaskContinuation(process.env.CONTINUATION_CWD, JSON.parse(process.env.CONTINUATION_TASK), JSON.parse(process.env.CONTINUATION_REQUEST));",
      "process.stdout.write(JSON.stringify(result));"
    ].join("\n");
    const run = async (missing) => {
      const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", source], {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          CONTINUATION_CWD: cwd,
          CONTINUATION_TASK: JSON.stringify(currentTask),
          CONTINUATION_REQUEST: JSON.stringify({ ...recoveryRequest, missing: [missing] })
        }
      });
      return JSON.parse(stdout);
    };
    const results = await Promise.all([run("verifier-a"), run("verifier-b")]);
    assert.equal(results.filter((result) => result.allowed).length, 1);
    assert.equal(results.filter((result) => result.reason === "global-budget-exhausted").length, 1);
    assert.equal(inspectTaskContinuationBudget(cwd, currentTask).consumed, 1);
  });

  it("shares the same unit between semantic review and completion recovery", () => {
    const cwd = project(), strict = task("strict-high-risk", "shared");
    const review = reserveTaskContinuation(cwd, strict, {
      capabilityId: "CAP-13",
      classification: "semantic-review",
      action: "review",
      currentWorkingTreeDigest: emptyTree,
      missing: ["semantic-review:src/value.ts"],
      reasonCodes: ["graph-order"]
    });
    assert.equal(review.allowed, true);
    const recovery = reserveTaskContinuation(cwd, strict, { ...recoveryRequest, currentWorkingTreeDigest: changedTree });
    assert.equal(recovery.allowed, false);
    assert.equal(recovery.reason, "global-budget-exhausted");
    assert.equal(inspectTaskContinuationBudget(cwd, strict).consumed, 1);
  });

  it("does not let advisory, off, legacy, or invalid tree evidence spend a turn", () => {
    const cwd = project(), broad = task("broad-default", "advisory");
    const advisory = reserveTaskContinuation(cwd, broad, {
      capabilityId: "CAP-13", classification: "semantic-review", action: "review", currentWorkingTreeDigest: emptyTree
    });
    assert.equal(advisory.reason, "authority-denied");
    const mechanical = task("mechanical-only", "mechanical");
    assert.equal(reserveTaskContinuation(cwd, mechanical, recoveryRequest).reason, "authority-denied");
    const legacy = { ...task("broad-default", "legacy"), authoritySnapshot: undefined };
    assert.equal(reserveTaskContinuation(cwd, legacy, recoveryRequest).reason, "authority-denied");
    assert.equal(reserveTaskContinuation(cwd, broad, { ...recoveryRequest, currentWorkingTreeDigest: "bad" }).reason, "invalid-progress-evidence");
    assert.equal(inspectTaskContinuationBudget(cwd, broad).consumed, 0);
  });

  it("classifies model, infrastructure, policy, repair, verifier, and diagnostic retries separately", () => {
    const decision = (failureCategory, action = "retry", reasonCodes = []) => ({ failureCategory, action, reasonCodes });
    assert.equal(continuationClassForRecovery(decision("provider-network")), "model-retry");
    assert.equal(continuationClassForRecovery(decision("flaky-infrastructure")), "infrastructure-retry");
    assert.equal(continuationClassForRecovery(decision("permission-policy", "ask-operator", ["permission-expansion-forbidden"])), "policy-blocked");
    assert.equal(continuationClassForRecovery(decision("test-assertion", "repair")), "source-repair");
    assert.equal(continuationClassForRecovery(decision("test-assertion")), "verifier-retry");
    assert.equal(continuationClassForRecovery(decision("unknown")), "diagnostic-retry");
  });

  it("normalizes progress evidence deterministically and fails closed on journal corruption", () => {
    const cwd = project(), currentTask = task("broad-default", "corrupt");
    const left = continuationProgressSignature(currentTask, { ...recoveryRequest, missing: ["b", "a", "a"] });
    const right = continuationProgressSignature(currentTask, { ...recoveryRequest, missing: ["a", "b"] });
    assert.equal(left, right);
    assert.equal(reserveTaskContinuation(cwd, currentTask, recoveryRequest).allowed, true);
    fs.appendFileSync(taskJournalPaths(cwd).events, "{not-json}\n");
    assert.equal(inspectTaskContinuationBudget(cwd, currentTask).enforcementSafe, false);
    assert.equal(reserveTaskContinuation(cwd, currentTask, { ...recoveryRequest, currentWorkingTreeDigest: changedTree }).reason, "journal-unavailable");
  });
});
