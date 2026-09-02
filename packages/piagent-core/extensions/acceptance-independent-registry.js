import fs from "node:fs";
import { currentAuthenticatedAssessment } from "./acceptance-authenticated-admission.js";

const providers = new Map();
const compositeAssessments = new WeakMap();
const key = (cwd, task) => `${fs.realpathSync.native(cwd)}\0${task.sessionId}\0${task.taskRunId}`;

function issueCompositeAssessment(provider, entry, workingTreeDigest, assessment) {
  const verdicts = ["pass", "fail", "unknown", "error"];
  if (!entry || typeof entry.criterionId !== "string" || typeof entry.criterionHash !== "string"
    || !assessment || !verdicts.includes(assessment.verdict) || !Array.isArray(assessment.reasons)
    || !Array.isArray(assessment.failedChecks) || typeof assessment.sourcePath !== "string"
    || !Array.isArray(assessment.sourcePaths) || !assessment.sourcePaths.includes(assessment.sourcePath)) {
    throw new Error("invalid live composite assessment");
  }
  const capability = Object.freeze({ version: "live-composite-assessment-v1", criterionId: entry.criterionId,
    criterionHash: entry.criterionHash, workingTreeDigest });
  compositeAssessments.set(capability, { provider, criterionId: entry.criterionId,
    criterionHash: entry.criterionHash, workingTreeDigest, assessment: structuredClone(assessment) });
  return capability;
}

/** Host-only registration; neither this callback nor receipts are model tools. */
export function registerIndependentAcceptanceProvider(cwd, task, read) {
  const callbacks = typeof read === "function" ? { read } : read;
  if (!callbacks || typeof callbacks.read !== "function"
    || callbacks.settleWebUi !== undefined && typeof callbacks.settleWebUi !== "function") {
    throw new TypeError("invalid independent acceptance provider");
  }
  const identity = key(cwd, task), provider = { read: callbacks.read, settleWebUi: callbacks.settleWebUi };
  providers.set(identity, provider);
  while (providers.size > 100) providers.delete(providers.keys().next().value);
  return () => { if (providers.get(identity) === provider) providers.delete(identity); };
}

export function independentAcceptanceState(cwd, task, workingTreeDigest) {
  const empty = (block) => ({ assessments: new Map(), block });
  if (!cwd || !task) return empty(undefined);
  try {
    const provider = providers.get(key(cwd, task));
    if (!provider) return empty(process.env.PIAGENT_INDEPENDENT_VERIFICATION_CONFIG ? "independent verification has not been prepared" : undefined);
    const value = provider.read(task, workingTreeDigest,
      (entry, assessment) => issueCompositeAssessment(provider, entry, workingTreeDigest, assessment));
    if (value.block) {
      const stopped = empty(value.block);
      if (["stopping", "approval", "pending", "interrupted", "exhausted", "unavailable"].includes(value.stopReason)) {
        stopped.stopReason = value.stopReason;
        if (typeof value.stopAttemptId === "string" && /^[a-f0-9-]{36}$/.test(value.stopAttemptId)) stopped.stopAttemptId = value.stopAttemptId;
      }
      return stopped;
    }
    const assessments = new Map();
    for (const entry of value.entries) {
      const criterion = task.acceptanceReceipt?.criteria.find((item) => item.id === entry.criterionId && item.hash === entry.criterionHash);
      if (!criterion) return empty("approved independent criterion no longer matches the task");
      const issued = compositeAssessments.get(entry.assessment);
      const current = issued
        ? issued.provider === provider && issued.criterionId === criterion.id && issued.criterionHash === criterion.hash
          && issued.workingTreeDigest === workingTreeDigest ? structuredClone(issued.assessment) : undefined
        : currentAuthenticatedAssessment(entry.receipt, { taskRunId: task.taskRunId, criterionId: criterion.id,
          criterionHash: criterion.hash, workingTreeDigest, projectVerificationDigest: value.projectVerificationDigest, policy: "allow" });
      assessments.set(criterion.id, current ?? { verdict: "unknown", reasons: ["current-independent-evidence-missing"] });
    }
    return { assessments, block: undefined };
  } catch { return empty("independent verification authority is unavailable"); }
}

/** Host gateway bridge. Operation labels remain data; the registered runtime must validate native evidence. */
export async function settleIndependentWebUiOperation(cwd, task, input) {
  if (!cwd || !task) return { status: "not-applicable" };
  try {
    const provider = providers.get(key(cwd, task));
    if (!provider?.settleWebUi) return { status: "not-applicable" };
    const value = await provider.settleWebUi(task, input);
    return value?.status === "settled" ? value : { status: "blocked", reason: value?.reason ?? "composite settlement unavailable" };
  } catch {
    return { status: "blocked", reason: "composite settlement unavailable" };
  }
}

export function applyIndependentCriterionAssessment(criterion, assessment, workingTreeDigest, recordedAt) {
  if (!assessment) return false;
  const previous = JSON.stringify([criterion.status, criterion.evidence]);
  criterion.status = assessment.verdict === "pass" ? "satisfied" : assessment.verdict === "fail" ? "blocked" : "pending";
  const evidence = assessment.sourcePath ? [{ kind: "independent-contract", paths: assessment.sourcePaths ?? [assessment.sourcePath], workingTreeDigest,
    summary: assessment.verdict === "pass" ? "Authenticated current independent checks passed; bounded contract-tested assurance."
      : assessment.verdict === "fail" ? `Authenticated independent counterexample: ${assessment.failedChecks.join(", ")}`.slice(0, 240)
        : `Independent verification ${assessment.verdict}: ${assessment.reasons.join(", ")}`.slice(0, 240) }] : [];
  criterion.evidence = evidence.map((entry) => {
    const existing = criterion.evidence?.find(({ recordedAt: _time, ...old }) => JSON.stringify(old) === JSON.stringify(entry));
    return { ...entry, recordedAt: existing?.recordedAt ?? recordedAt };
  });
  if (JSON.stringify([criterion.status, criterion.evidence]) !== previous) { criterion.updatedAt = recordedAt; return true; }
  return false;
}
