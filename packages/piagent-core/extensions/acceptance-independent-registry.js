import fs from "node:fs";
import { currentAuthenticatedAssessment } from "./acceptance-authenticated-admission.js";

const providers = new Map();
const key = (cwd, task) => `${fs.realpathSync.native(cwd)}\0${task.sessionId}\0${task.taskRunId}`;

/** Host-only registration; neither this callback nor receipts are model tools. */
export function registerIndependentAcceptanceProvider(cwd, task, read) {
  const identity = key(cwd, task), provider = { read };
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
    const value = provider.read(task, workingTreeDigest);
    if (value.block) return empty(value.block);
    const assessments = new Map();
    for (const entry of value.entries) {
      const criterion = task.acceptanceReceipt?.criteria.find((item) => item.id === entry.criterionId && item.hash === entry.criterionHash);
      if (!criterion) return empty("approved independent criterion no longer matches the task");
      const current = currentAuthenticatedAssessment(entry.receipt, { taskRunId: task.taskRunId, criterionId: criterion.id,
        criterionHash: criterion.hash, workingTreeDigest, projectVerificationDigest: value.projectVerificationDigest, policy: "allow" });
      assessments.set(criterion.id, current ?? { verdict: "unknown", reasons: ["current-independent-evidence-missing"] });
    }
    return { assessments, block: undefined };
  } catch { return empty("independent verification authority is unavailable"); }
}

export function applyIndependentCriterionAssessment(criterion, assessment, workingTreeDigest, recordedAt) {
  if (!assessment) return false;
  const previous = JSON.stringify([criterion.status, criterion.evidence]);
  criterion.status = assessment.verdict === "pass" ? "satisfied" : assessment.verdict === "fail" ? "blocked" : "pending";
  const evidence = assessment.sourcePath ? [{ kind: "independent-contract", paths: [assessment.sourcePath], workingTreeDigest,
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
