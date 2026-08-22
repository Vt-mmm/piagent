export { workingTreeEvidenceDigest } from "./working-tree-digest.js";

function sameValues(left, right) {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
}

function matchesStep(step, expected) {
  return step?.id === expected.id
    && step?.role === expected.role
    && step?.mode === expected.mode
    && sameValues(step?.dependsOn, expected.dependsOn);
}

const AUTOMATIC_TINY_PLAN = [
  { id: "implement", role: "parent", mode: "single-writer", dependsOn: undefined },
  { id: "verify", role: "parent", mode: "review", dependsOn: ["implement"] }
];

const ASSISTED_NORMAL_PLAN = [
  { id: "plan", role: "parent", mode: "read-only", dependsOn: undefined },
  { id: "implement", role: "parent", mode: "single-writer", dependsOn: ["plan"] },
  { id: "review", role: "piagent-reviewer", mode: "review", dependsOn: ["implement"] }
];

const AUTOMATIC_READ_ONLY_PLAN = [
  { id: "scout", role: "parent", mode: "read-only", dependsOn: undefined }
];

const ASSISTED_READ_ONLY_PLAN = [
  { id: "scout", role: "parent", mode: "read-only", dependsOn: undefined },
  { id: "review", role: "piagent-reviewer", mode: "review", dependsOn: ["scout"] }
];

function mutationForbidden(task) {
  return task?.changeMode === "read-only" || task?.mutationPolicy === "forbidden";
}

export function runtimeLifecycleMode(task) {
  if (!Array.isArray(task?.workPlan)) return "manual";
  if (
    mutationForbidden(task)
    && (task.riskLane === "tiny" || (task.intakeMode === "runtime" && task.riskLane === "normal"))
    && task.workPlan.length === AUTOMATIC_READ_ONLY_PLAN.length
    && task.workPlan.every((step, index) => matchesStep(step, AUTOMATIC_READ_ONLY_PLAN[index]))
  ) return "automatic-readonly";
  if (
    mutationForbidden(task)
    && task.riskLane === "normal"
    && task.workPlan.length === ASSISTED_READ_ONLY_PLAN.length
    && task.workPlan.every((step, index) => matchesStep(step, ASSISTED_READ_ONLY_PLAN[index]))
  ) return "assisted-readonly";
  if (task.changeMode !== "source-change") return "manual";
  if (
    (task.riskLane === "tiny" || (task.intakeMode === "runtime" && task.riskLane === "normal"))
    && task.workPlan.length === AUTOMATIC_TINY_PLAN.length
    && task.workPlan.every((step, index) => matchesStep(step, AUTOMATIC_TINY_PLAN[index]))
  ) return "automatic";
  if (
    task.riskLane === "normal"
    && task.workPlan.length === ASSISTED_NORMAL_PLAN.length
    && task.workPlan.every((step, index) => matchesStep(step, ASSISTED_NORMAL_PLAN[index]))
  ) return "assisted";
  return "manual";
}

function nonEmptyStrings(value) {
  return Array.isArray(value)
    && value.length > 0
    && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function sourceContractReady(task) {
  return task?.schemaVersion === 2
    && task.changeMode === "source-change"
    && task.mutationPolicy !== "forbidden"
    && task.trace?.outcome === "pending"
    && nonEmptyStrings(task.acceptanceCriteria)
    && nonEmptyStrings(task.scope)
    && nonEmptyStrings(task.verifyCommands)
    && Array.isArray(task.workPlan);
}

function dependencyReadyStep(task, predicate) {
  if (!sourceContractReady(task)) return false;
  const byId = new Map(task.workPlan.map((step) => [step?.id, step]));
  return task.workPlan.some((step) => (
    predicate(step)
    && (step.dependsOn ?? []).every((dependency) => {
      const status = byId.get(dependency)?.status;
      return status === "done";
    })
  ));
}

/** A persisted read-only plan step is the active pre-mutation gate. */
export function sourcePlanningAuthorized(task) {
  return dependencyReadyStep(task, (step) => (
    step?.id === "plan"
    && step.mode === "read-only"
    && step.status === "in-progress"
  ));
}

/**
 * A source phase is executable when the persisted work plan, rather than a
 * claimed mutation, has opened one dependency-ready single-writer step.
 * Active tasks have already passed Task Contract validation; the checks here
 * retain the source-specific contract, scope, and verifier prerequisites that
 * authorize mutation at call time.
 */
export function sourceExecutionAuthorized(task) {
  return dependencyReadyStep(task, (step) => (
    step?.mode === "single-writer"
    && step.status === "in-progress"
  ));
}

/** Runtime-owned automatic tasks may bypass a phase that is absent by design. */
export function runtimeAutomaticSourceExecutionReady(task) {
  return sourceExecutionAuthorized(task)
    && task.intakeMode === "runtime"
    && task.acceptanceReceipt?.source === "runtime"
    && Array.isArray(task.acceptanceReceipt.criteria)
    && task.acceptanceReceipt.criteria.length > 0
    && runtimeLifecycleMode(task) === "automatic";
}

function setStep(step, status, note, recordedAt) {
  if (!step || (step.status === status && step.note === note)) return false;
  step.status = status;
  step.note = note;
  step.updatedAt = recordedAt;
  return true;
}

export function applyRuntimeLifecycleObservation(task, observation, recordedAt = new Date().toISOString()) {
  const mode = runtimeLifecycleMode(task);
  if (mode === "manual") return { changed: false, mode };

  const byId = new Map(task.workPlan.map((step) => [step.id, step]));
  let changed = false;
  if (observation === "context-complete") {
    if (mode === "automatic-readonly") {
      changed = setStep(byId.get("scout"), "done", "Runtime observed bounded read-only evidence for this scout.", recordedAt) || changed;
    } else if (mode === "assisted-readonly") {
      changed = setStep(byId.get("scout"), "done", "Runtime observed bounded read-only evidence for this scout.", recordedAt) || changed;
      const review = byId.get("review");
      if (review?.status === "pending") {
        changed = setStep(review, "in-progress", "Review the evidence and stated unknowns before handoff.", recordedAt) || changed;
      }
    }
    return { changed, mode };
  }

  if (mode === "automatic-readonly" || mode === "assisted-readonly") {
    return { changed: false, mode };
  }
  if (observation === "mutation") {
    if (mode === "assisted") {
      changed = setStep(byId.get("plan"), "done", "Runtime observed bounded context followed by a project mutation.", recordedAt) || changed;
    }
    changed = setStep(byId.get("implement"), "in-progress", "Runtime observed a project mutation; current verification is required.", recordedAt) || changed;
    const terminalStep = byId.get(mode === "automatic" ? "verify" : "review");
    if (terminalStep && terminalStep.status !== "pending") {
      changed = setStep(terminalStep, "pending", "A later mutation invalidated the previous terminal evidence.", recordedAt) || changed;
    }
    return { changed, mode };
  }

  if (observation === "verification-pending") {
    if (mode === "assisted") {
      changed = setStep(byId.get("plan"), "done", "Runtime observed bounded context followed by implementation.", recordedAt) || changed;
    }
    changed = setStep(byId.get("implement"), "done", "Runtime observed project changes and an exact configured verifier.", recordedAt) || changed;
    const verifyStep = byId.get(mode === "automatic" ? "verify" : "review");
    if (verifyStep?.status === "pending") {
      changed = setStep(verifyStep, "in-progress", "Waiting for current passing verification or explicit review evidence.", recordedAt) || changed;
    }
    return { changed, mode };
  }

  if (observation === "verification-complete") {
    if (mode === "assisted") {
      changed = setStep(byId.get("plan"), "done", "Runtime observed bounded context followed by implementation.", recordedAt) || changed;
    }
    changed = setStep(byId.get("implement"), "done", "All configured verifiers passed against the current working tree.", recordedAt) || changed;
    if (mode === "automatic") {
      changed = setStep(byId.get("verify"), "done", "Runtime observed every configured verifier passing against the current working tree.", recordedAt) || changed;
    } else {
      const review = byId.get("review");
      if (review?.status === "pending") {
        changed = setStep(review, "in-progress", "Verification passed; complete the explicit review lens before handoff.", recordedAt) || changed;
      }
    }
  }
  return { changed, mode };
}
