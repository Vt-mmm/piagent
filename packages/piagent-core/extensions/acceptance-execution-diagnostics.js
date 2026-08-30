const EXECUTOR_REASONS = new Set([
  "local-backend-unavailable", "cancelled-before-create", "reserved-execution-id-conflict", "container-create-failed",
  "container-configuration-rejected", "container-create-incomplete", "cancelled", "timeout", "output-limit", "spawn-error",
  "container-memory-limit", "worker-exit-failed", "invalid-worker-observation", "container-cleanup-unconfirmed"
]);
const CASE_REASONS = new Set([
  "guest-timeout", "module-import-unsupported", "module-initialization-failed", "async-module-unsupported",
  "callable-export-missing", "guest-resource-error", "returned-string-limit", "return-type-unsupported", "guest-observation-failed",
  "structured-value-unsupported", "value-observation-limit", "referenced-result-unavailable", "async-job-unsupported"
]);

/** Formatting of authenticated host observations, never a source-failure oracle. */
export function executionDiagnostics(result) {
  const execution = result?.execution;
  if (!execution || !["completed", "timeout", "cancelled", "error"].includes(execution.status)
    || typeof execution.cleanupConfirmed !== "boolean") throw new TypeError("Invalid executor diagnostic identity");
  const reasons = new Set();
  if (execution.status !== "completed") reasons.add(`executor-${execution.status}`);
  if (!execution.cleanupConfirmed) reasons.add("container-cleanup-unconfirmed");
  if (execution.reason !== undefined) reasons.add(EXECUTOR_REASONS.has(execution.reason) ? execution.reason : "unrecognized-executor-reason");
  let unsupportedCaseCount = 0, errorCaseCount = 0;
  for (const observation of execution.observation?.cases ?? []) {
    if (!["unsupported", "error"].includes(observation.outcome)) continue;
    if (observation.outcome === "unsupported") unsupportedCaseCount += 1; else errorCaseCount += 1;
    reasons.add(CASE_REASONS.has(observation.reason) ? observation.reason : "unrecognized-case-reason");
  }
  if (result.checks.some((check) => check.status === "unknown") && !unsupportedCaseCount) reasons.add("required-check-coverage-missing");
  if (result.checks.some((check) => check.status === "error") && !errorCaseCount) reasons.add("check-execution-error");
  return Object.freeze({ status: execution.status, cleanupConfirmed: execution.cleanupConfirmed,
    reasons: Object.freeze([...reasons]), unsupportedCaseCount, errorCaseCount });
}
