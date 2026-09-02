import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TaskContract } from "../../extensions/guard-types.ts";
import { createDurableContractRunner } from "../../extensions/acceptance-durable-execution.js";
import { FACT_EVIDENCE_SCOPE_VERSION } from "../../extensions/acceptance-evidence-store.js";
import { captureExecutionSnapshot } from "../../extensions/acceptance-execution-snapshot.js";
import { captureWorkspaceVerificationSnapshot } from "../../extensions/workspace-verification-snapshot.js";
import { validateModulePaths } from "../../extensions/acceptance-executor/module-graph.mjs";
import type { RuntimeSessionState } from "../session/runtime-state.ts";

type ApprovedConfiguration = Omit<Parameters<typeof createDurableContractRunner>[0], "projectRoot" | "getProjectVerificationDigest">;
type CompositeCodePlan = Readonly<{ digest: string; backendProfileDigest: string; caseCount: number;
  sourcePath: string; modulePaths: readonly string[]; exportName: string; checks: readonly unknown[]; profile: object }>;
type CompositeCodeFact = Readonly<{ id: string; parameters: Readonly<{ codePlanDigest: string; backendProfileDigest: string }> }>;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * Host-only bridge from actual tool hooks to the durable independent runner.
 * Configuration, contract checks, store, and source authorization must already
 * be approved by the host; none are taken from a model tool or candidate file.
 * This does not enable production contract selection or completion admission.
 */
export function createRuntimeContractRunner({ state, context, getTask, approved }: {
  state: RuntimeSessionState; context: ExtensionContext; getTask: () => TaskContract | undefined; approved: ApprovedConfiguration;
}) {
  if (!state?.projectVerification || typeof getTask !== "function") throw new TypeError("Actual runtime verification state is required");
  const cwd = context.cwd, sessionId = context.sessionManager.getSessionId();
  const sourcePath = approved.sourcePath, authorizeSourceRead = approved.authorizeSourceRead;
  const modulePaths = approved.modulePaths === undefined ? undefined : Object.freeze(validateModulePaths(sourcePath, approved.modulePaths));
  const sourcePaths = [sourcePath, ...(modulePaths ?? [])];
  return createDurableContractRunner({ ...approved, projectRoot: cwd,
    getProjectVerificationDigest(request) {
      try {
        if (context.cwd !== cwd || context.sessionManager.getSessionId() !== sessionId) return null;
        const task = getTask();
        if (!task || task.taskRunId !== request.taskRunId || task.sessionId !== sessionId || task.trace.outcome !== "pending"
          || !task.acceptanceReceipt?.criteria.some((criterion) => criterion.id === request.criterionId && criterion.hash === request.criterionHash)) return null;
        // Ignored source bytes are absent from ordinary project-verifier dirt.
        // Until approved targets are captured at tool start, do not claim they
        // were tested just because an independent execution captured them now.
        const covered = execFileSync("git", ["-c", "core.fsmonitor=false", "--no-optional-locks", "-C", cwd,
          "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...sourcePaths],
        { encoding: "utf8", timeout: 3000, maxBuffer: 65536, stdio: ["ignore", "pipe", "pipe"] });
        const coveredPaths = new Set(covered.split("\0"));
        if (!sourcePaths.every((candidate) => coveredPaths.has(candidate))) return null;
        const before = captureWorkspaceVerificationSnapshot(cwd);
        const source = captureExecutionSnapshot({ projectRoot: cwd, sourcePath, modulePaths, authorizeSourceRead });
        const current = captureWorkspaceVerificationSnapshot(cwd);
        if (!before.proofCapable || !current.proofCapable || before.digest !== current.digest
          || before.workspaceRevisionDigest !== current.workspaceRevisionDigest
          || source.snapshotDigest !== request.snapshotDigest || source.binding.workingTreeDigest !== current.digest) return null;
        return state.projectVerification.currentDigest(context, task, current);
      } catch { return null; }
    }
  });
}

/** A code receipt is consumed here as one fact observation, never registered as root criterion authority. */
export function createCompositeCodeChildCollector({ state, context, getTask, approved, plan, fact,
  criterionId, criterionHash, maxAttempts }: {
  state: RuntimeSessionState; context: ExtensionContext; getTask: () => TaskContract | undefined;
  approved: Omit<ApprovedConfiguration, "sourcePath" | "modulePaths" | "exportName" | "checks" | "profile">;
  plan: CompositeCodePlan; fact: CompositeCodeFact; criterionId: string; criterionHash: string; maxAttempts: number;
}) {
  if (fact.parameters.codePlanDigest !== plan.digest || fact.parameters.backendProfileDigest !== plan.backendProfileDigest) {
    throw new TypeError("Composite code fact does not match its approved child plan");
  }
  const expectedPaths = [plan.sourcePath, ...plan.modulePaths];
  const runner = createRuntimeContractRunner({ state, context, getTask, approved: { ...approved,
    sourcePath: plan.sourcePath, modulePaths: plan.modulePaths, exportName: plan.exportName,
    checks: plan.checks, profile: plan.profile } as ApprovedConfiguration });
  const unavailable = (reason: string) => ({ status: "unknown", observationDigest: sha(JSON.stringify({
    version: "composite-code-child-observation-v1", factId: fact.id, codePlanDigest: plan.digest, reason })),
    counterexampleRef: null, reasonCodes: [reason] });
  return Object.freeze({ factId: fact.id, async collect(task: TaskContract, signal: AbortSignal) {
    const result = await runner.run({ scope: { version: FACT_EVIDENCE_SCOPE_VERSION, taskRunId: task.taskRunId,
      criterionId, factId: fact.id }, criterionHash, maxAttempts, signal });
    if (result.reason) return unavailable(result.reason.includes("binding") ? "stale-binding" : "unavailable-native-boundary");
    const assessment = await runner.assess(result, { policy: "allow" });
    const checks = assessment.checks ?? [], observedPaths = assessment.sourcePaths ?? (assessment.sourcePath ? [assessment.sourcePath] : []);
    const current = assessment.taskRunId === task.taskRunId && assessment.criterionId === criterionId
      && assessment.criterionHash === criterionHash && assessment.factId === fact.id
      && assessment.profileDigest === plan.backendProfileDigest && assessment.planDigest === result.evidence?.planDigest
      && checks.length === plan.checks.length && checks.reduce((total, check) => total + check.caseCount, 0) === plan.caseCount
      && expectedPaths.length === observedPaths.length && expectedPaths.every((sourcePath, index) => sourcePath === observedPaths[index]);
    if (!current) return unavailable(assessment.reasons.some(reason => reason.includes("binding") || reason.includes("current"))
      ? "stale-binding" : "invalid-approval");
    const detail = { version: "composite-code-child-observation-v1", factId: fact.id,
      codePlanDigest: plan.digest, backendProfileDigest: plan.backendProfileDigest, approvedCaseCount: plan.caseCount,
      attemptId: assessment.attemptId, snapshotDigest: assessment.snapshotDigest, workingTreeDigest: assessment.workingTreeDigest,
      projectVerificationDigest: assessment.projectVerificationDigest, executionPlanDigest: assessment.planDigest,
      backendDigest: assessment.backendDigest, sourcePaths: observedPaths, checks, counterexamples: assessment.counterexamples ?? [] };
    if (assessment.verdict === "pass" && assessment.completionAllowed && assessment.assurance === "bounded-contract-tested"
      && checks.every(check => check.status === "pass")) {
      return { status: "pass", observationDigest: sha(JSON.stringify(detail)), counterexampleRef: null, reasonCodes: [] };
    }
    if (assessment.verdict === "fail" && (assessment.counterexamples?.length ?? 0) > 0) {
      return { status: "fail", observationDigest: sha(JSON.stringify(detail)),
        counterexampleRef: sha(JSON.stringify(assessment.counterexamples)), reasonCodes: ["observed-counterexample"] };
    }
    if (assessment.verdict === "error") return { status: "error", observationDigest: sha(JSON.stringify(detail)),
      counterexampleRef: null, reasonCodes: [assessment.executionDiagnostics?.cleanupConfirmed === false ? "cleanup-ambiguous" : "producer-crash"] };
    return unavailable(assessment.reasons.some(reason => reason.includes("binding") || reason.includes("current"))
      ? "stale-binding" : assessment.executionDiagnostics?.unsupportedCaseCount ? "unsupported-input" : "unavailable-native-boundary");
  } });
}
