import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { acceptanceLanguageAdapterStatus } from "../packages/piagent-core/extensions/acceptance-language-adapters.js";
import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/working-tree-digest.js";
import { createTrajectoryState } from "../packages/piagent-core/runtime/trajectory/trajectory-state.ts";
import { createTaskAuthoritySnapshot } from "../packages/piagent-core/runtime/policy/authority-manifest.ts";
import {
  createBoundTaskAuthority,
  createEnvironmentBoundTaskAuthority,
  taskAuthorityDecision
} from "../packages/piagent-core/runtime/policy/task-authority-runtime.ts";
import {
  inspectTaskContinuationBudget,
  reserveTaskContinuation
} from "../packages/piagent-core/runtime/recovery/continuation-budget.ts";
import { PhaseToolRuntime } from "../packages/piagent-core/runtime/tools/phase-tool-runtime.ts";

const ADVANCED_CAPABILITIES = Object.freeze(["CAP-08", "CAP-09", "CAP-11", "CAP-12", "CAP-13", "CAP-14", "CAP-15"]);
const PROFILES = Object.freeze(["broad-default", "mechanical-only", "strict-high-risk"]);
const ACTIONS = Object.freeze(["observe", "advise", "block", "mutate", "model-turn", "dispatch"]);

function carrier(profile, suffix = profile) {
  const identity = {
    taskId: `interaction-${suffix}`,
    taskRunId: `interaction-${suffix}-run`,
    createdAt: "2026-08-11T00:00:00.000Z"
  };
  return { ...identity, authoritySnapshot: createBoundTaskAuthority({ ...identity, profile }) };
}

function expectedAction(entry, action) {
  if (entry.authority === "off") return false;
  if (action === "observe") return true;
  if (action === "advise") return ["advise", "enforce", "orchestrate"].includes(entry.authority);
  if (action === "block" || action === "mutate") return ["enforce", "orchestrate"].includes(entry.authority);
  if (action === "dispatch") return entry.authority === "orchestrate" && entry.budgets.automaticDispatches > 0;
  return ["enforce", "orchestrate"].includes(entry.authority)
    && Object.values(entry.budgets).some((amount) => amount > 0);
}

describe("FS3 advanced capability interaction gate", () => {
  it("covers all 21 advanced-capability pairs across all three profiles without hidden authority", () => {
    let pairCases = 0;
    for (const profile of PROFILES) {
      const task = carrier(profile);
      for (let left = 0; left < ADVANCED_CAPABILITIES.length; left += 1) {
        for (let right = left + 1; right < ADVANCED_CAPABILITIES.length; right += 1) {
          pairCases += 1;
          for (const capabilityId of [ADVANCED_CAPABILITIES[left], ADVANCED_CAPABILITIES[right]]) {
            const entry = task.authoritySnapshot.capabilities.find((candidate) => candidate.id === capabilityId);
            assert.ok(entry, `${profile}/${capabilityId} must be manifest-bound`);
            for (const action of ACTIONS) {
              const decision = taskAuthorityDecision(task, capabilityId, action);
              assert.equal(decision.allowed, expectedAction(entry, action), `${profile}/${capabilityId}/${action}`);
              assert.equal(decision.authority, entry.authority);
              assert.equal(decision.mode, entry.mode);
            }
          }
        }
      }
    }
    assert.equal(pairCases, 63);
  });

  it("rejects cross-feature authority escalation and preserves independent rollback switches", () => {
    const identity = { taskId: "interaction-invalid", taskRunId: "interaction-invalid-run", capturedAt: "2026-08-11T00:00:00.000Z" };
    assert.throws(() => createTaskAuthoritySnapshot({
      ...identity,
      profile: "strict-high-risk",
      modeOverrides: { "CAP-09": "shadow" }
    }), /CAP-13 strict enforcement requires CAP-09 enforcement/);
    assert.throws(() => createTaskAuthoritySnapshot({
      ...identity,
      profile: "strict-high-risk",
      modeOverrides: { "CAP-14": "on", "CAP-15": "auto" }
    }), /combined automatic dispatch budget exceeds the task-global ceiling/);

    const base = { taskId: "interaction-switch", taskRunId: "interaction-switch-run", createdAt: identity.capturedAt, profile: "strict-high-risk" };
    const acceptanceOff = { ...base, authoritySnapshot: createEnvironmentBoundTaskAuthority(base, { PIAGENT_ACCEPTANCE_ASSURANCE: "off" }) };
    assert.equal(taskAuthorityDecision(acceptanceOff, "CAP-11", "block").allowed, false);
    assert.equal(taskAuthorityDecision(acceptanceOff, "CAP-13", "model-turn").allowed, false);
    assert.equal(taskAuthorityDecision(acceptanceOff, "CAP-09", "block").allowed, true);
    assert.equal(taskAuthorityDecision(acceptanceOff, "CAP-12", "model-turn").allowed, true);

    const semanticOff = { ...base, authoritySnapshot: createEnvironmentBoundTaskAuthority(base, { PIAGENT_SEMANTIC_REPAIR: "off" }) };
    assert.equal(taskAuthorityDecision(semanticOff, "CAP-13", "model-turn").allowed, false);
    assert.equal(taskAuthorityDecision(semanticOff, "CAP-11", "observe").allowed, true);
    assert.equal(taskAuthorityDecision(semanticOff, "CAP-09", "block").allowed, true);
    assert.equal(taskAuthorityDecision(semanticOff, "CAP-12", "model-turn").allowed, true);
  });

  it("keeps unknown syntax fail-closed while broad observation and advice spend no provider turn", () => {
    for (const file of ["src/main.py", "src/main.go", "src/main.rs", "src/widget.unknown"]) {
      const status = acceptanceLanguageAdapterStatus([file]);
      assert.equal(status.proofCapable, false, file);
      assert.ok(["unsupported", "unresolved"].includes(status.status), file);
    }
    const broad = carrier("broad-default", "advisory");
    for (const capabilityId of ADVANCED_CAPABILITIES) {
      const entry = broad.authoritySnapshot.capabilities.find((candidate) => candidate.id === capabilityId);
      if (["observe", "advise"].includes(entry.authority)) {
        assert.equal(taskAuthorityDecision(broad, capabilityId, "model-turn").allowed, false, capabilityId);
        assert.equal(taskAuthorityDecision(broad, capabilityId, "dispatch").allowed, false, capabilityId);
      }
    }
  });

  it("keeps provider-visible tool schemas stable in off, shadow, and enforced phase modes", () => {
    const active = ["read", "grep", "find", "ls", "edit", "write", "apply_patch", "bash"];
    const ctx = { cwd: "/tmp/fs3-interaction", sessionManager: { getSessionId: () => "session-interaction" } };
    for (const mode of ["off", "shadow", "on"]) {
      let visible = [...active];
      const setCalls = [];
      const pi = {
        getActiveTools: () => [...visible],
        getAllTools: () => active.map((name) => ({ name })),
        setActiveTools: (next) => { visible = [...next]; setCalls.push([...next]); }
      };
      const runtime = new PhaseToolRuntime(pi, mode, () => undefined);
      for (const phase of ["intake", "execute", "verify", "review", "repair"]) {
        const state = { ...createTrajectoryState({
          taskId: `phase-${mode}`,
          taskRunId: `phase-${mode}-run`,
          sessionId: "session-interaction",
          changeMode: "source-change",
          riskLane: "normal",
          createdAt: "2026-08-11T00:00:00.000Z"
        }), currentPhase: phase };
        runtime.apply(ctx, { enforcementSafe: true, state, transitions: [] });
      }
      assert.deepEqual(visible, active, mode);
      assert.equal(setCalls.length, 0, `${mode} must not churn provider schemas`);
    }
  });

  it("shares one global continuation between strict semantic review and recovery", (t) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-fs3-interaction-"));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const task = carrier("strict-high-risk", "continuation");
    task.sessionId = "session-continuation";
    task.sessionName = "FS3 INTERACTION";
    const digest = workingTreeEvidenceDigest({});
    const review = reserveTaskContinuation(cwd, task, {
      capabilityId: "CAP-13",
      classification: "semantic-review",
      action: "review",
      currentWorkingTreeDigest: digest,
      missing: ["semantic review"],
      reasonCodes: ["fs3-interaction"]
    });
    assert.equal(review.allowed, true);
    const recovery = reserveTaskContinuation(cwd, task, {
      capabilityId: "CAP-12",
      classification: "verifier-retry",
      action: "retry",
      currentWorkingTreeDigest: digest,
      missing: ["exact verifier"],
      missingVerifyCommands: ["npm test"],
      reasonCodes: ["fs3-interaction"]
    });
    assert.equal(recovery.allowed, false);
    assert.equal(recovery.reason, "global-budget-exhausted");
    assert.equal(inspectTaskContinuationBudget(cwd, task).consumed, 1);
  });
});
