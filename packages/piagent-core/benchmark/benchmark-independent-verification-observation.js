const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const exact = (value, fields) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));

export function benchmarkVerificationFailure(value) {
  if (!value || value.status === "not-configured") return null;
  if (["partial", "unavailable"].includes(value.status)) return "independent-verification-coverage-incomplete";
  return value.requests.some(request => request.runs.some(run => run.criteria.some(criterion => criterion.verdict !== "pass")))
    ? "independent-verification-did-not-pass" : null;
}

/** Serialized observations are measurement data, never completion/repair capabilities. */
export function validBenchmarkVerificationObservation(value) {
  if (!exact(value, ["schemaVersion", "planDigest", "status", "attempts", "workersObserved", "requests"])
    || value.schemaVersion !== 1 || !hash(value.planDigest) || !Array.isArray(value.requests) || value.requests.length > 32) return false;
  if (value.status === "unavailable") return value.attempts === null && value.workersObserved === null && value.requests.length === 0;
  if (!count(value.attempts) || !count(value.workersObserved)) return false;
  if (value.status === "not-configured") return value.attempts === 0 && value.workersObserved === 0 && value.requests.length === 0;
  if (!["observed", "partial"].includes(value.status) || value.requests.length < 1) return false;
  let attempts = 0, workers = 0, complete = true;
  const requests = new Set(), tasks = new Set();
  for (const request of value.requests) {
    if (!exact(request, ["operatorRequestDigest", "runs"]) || !/^operator-request-v1:[a-f0-9]{64}$/.test(request.operatorRequestDigest)
      || requests.has(request.operatorRequestDigest) || !Array.isArray(request.runs) || request.runs.length > 1000) return false;
    requests.add(request.operatorRequestDigest);
    if (request.runs.length === 0) complete = false;
    for (const run of request.runs) {
      if (!exact(run, ["taskRunId", "criteria"]) || typeof run.taskRunId !== "string" || !run.taskRunId || run.taskRunId.length > 200
        || tasks.has(run.taskRunId) || !Array.isArray(run.criteria) || run.criteria.length < 1 || run.criteria.length > 12) return false;
      tasks.add(run.taskRunId);
      const criteria = new Set();
      for (const criterion of run.criteria) {
        if (!exact(criterion, ["criterionId", "criterionHash", "attempts", "phase", "verdict", "workerObserved"])
          || !/^[a-z0-9][a-z0-9:._-]{0,79}$/.test(criterion.criterionId) || criteria.has(criterion.criterionId)
          || !hash(criterion.criterionHash) || !count(criterion.attempts) || criterion.attempts > 8
          || typeof criterion.workerObserved !== "boolean"
          || !["not-observed", "binding-mismatch", "invalid-evidence", "reserved", "interrupted", "settled"].includes(criterion.phase)) return false;
        criteria.add(criterion.criterionId);
        if (criterion.phase === "settled") {
          if (criterion.attempts < 1 || !["pass", "fail", "unknown", "error"].includes(criterion.verdict)) return false;
        } else if (criterion.verdict !== null || criterion.workerObserved || (criterion.phase === "not-observed" ? criterion.attempts !== 0 : criterion.attempts < 1)) return false;
        attempts += criterion.attempts; workers += Number(criterion.workerObserved);
        if (!criterion.workerObserved) complete = false;
      }
    }
  }
  return value.attempts === attempts && value.workersObserved === workers && (value.status === "observed") === complete;
}

export function benchmarkVerificationRecordMatches(record, identity) {
  if (!identity || record.surface !== "piagent") return !Object.hasOwn(record, "independentVerification");
  const observed = record.independentVerification;
  if (!validBenchmarkVerificationObservation(observed) || observed.planDigest !== identity.contentDigest) return false;
  if (benchmarkVerificationFailure(observed) && record.resolved !== false) return false;
  const scenario = identity.scenarios.find(entry => entry.scenarioId === record.scenarioId);
  if (!scenario) return observed.status === "not-configured";
  if (observed.status === "unavailable") return true;
  return observed.status !== "not-configured" && observed.requests.length === scenario.requests.length
    && observed.requests.every((request, index) => request.operatorRequestDigest === scenario.requests[index].operatorRequestDigest
      && request.runs.every(run => run.criteria.length === scenario.requests[index].criteria.length
        && run.criteria.every((criterion, n) => criterion.criterionId === scenario.requests[index].criteria[n].criterionId
          && criterion.criterionHash === scenario.requests[index].criteria[n].criterionHash)));
}
