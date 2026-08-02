import crypto from "node:crypto";

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

export function runtimeLifecycleMode(task) {
  if (!Array.isArray(task?.workPlan)) return "manual";
  if (
    task.changeMode === "read-only"
    && task.riskLane === "tiny"
    && task.workPlan.length === AUTOMATIC_READ_ONLY_PLAN.length
    && task.workPlan.every((step, index) => matchesStep(step, AUTOMATIC_READ_ONLY_PLAN[index]))
  ) return "automatic-readonly";
  if (
    task.changeMode === "read-only"
    && task.riskLane === "normal"
    && task.workPlan.length === ASSISTED_READ_ONLY_PLAN.length
    && task.workPlan.every((step, index) => matchesStep(step, ASSISTED_READ_ONLY_PLAN[index]))
  ) return "assisted-readonly";
  if (task.changeMode !== "source-change") return "manual";
  if (
    task.riskLane === "tiny"
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

export function workingTreeEvidenceDigest(snapshot) {
  const entries = Object.entries(snapshot ?? {})
    .filter(([file, digest]) => typeof file === "string" && typeof digest === "string")
    .sort(([left], [right]) => left.localeCompare(right));
  return crypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex");
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
