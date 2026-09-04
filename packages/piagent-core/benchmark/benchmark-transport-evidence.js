import { exactBenchmarkMeasuredUsage } from "./benchmark-usage.js";

const benchmarkSurfaces = new Set(["raw-pi", "piagent", "codex-cli"]);
const BENCHMARK_TRANSPORT_FAILURE_CLASSES = new Set([
  "provider-transport",
  "provider-infrastructure",
  "transport-timeout"
]);

export const BENCHMARK_TRANSPORT_CIRCUIT_POLICY = Object.freeze({ schemaVersion: 1, maximumFailures: 2 });

export function createBenchmarkTransportCircuit() {
  return {
    ...BENCHMARK_TRANSPORT_CIRCUIT_POLICY,
    failures: 0,
    state: "closed",
    lastFailure: null
  };
}

export function validBenchmarkTransportCircuit(value) {
  const lastFailureValid = value?.failures === 0
    ? value.lastFailure === null
    : Boolean(value?.lastFailure
      && Number.isSafeInteger(value.lastFailure.orderIndex) && value.lastFailure.orderIndex > 0
      && typeof value.lastFailure.scenarioId === "string" && value.lastFailure.scenarioId.length > 0
      && benchmarkSurfaces.has(value.lastFailure.surface)
      && Number.isSafeInteger(value.lastFailure.repeat) && value.lastFailure.repeat > 0
      && Number.isSafeInteger(value.lastFailure.infrastructureAttempt) && value.lastFailure.infrastructureAttempt > 0
      && typeof value.lastFailure.failure === "string" && value.lastFailure.failure.length > 0);
  return value?.schemaVersion === BENCHMARK_TRANSPORT_CIRCUIT_POLICY.schemaVersion
    && value.maximumFailures === BENCHMARK_TRANSPORT_CIRCUIT_POLICY.maximumFailures
    && Number.isSafeInteger(value.failures)
    && value.failures >= 0
    && value.failures <= value.maximumFailures
    && ["closed", "open"].includes(value.state)
    && value.state === (value.failures >= value.maximumFailures ? "open" : "closed")
    && lastFailureValid;
}

export function observeBenchmarkTransportFailure(circuit, record) {
  if (!validBenchmarkTransportCircuit(circuit)) throw new Error("Benchmark transport circuit-breaker state is malformed");
  if (!BENCHMARK_TRANSPORT_FAILURE_CLASSES.has(record?.infrastructureClass)) return circuit;
  const failures = Math.min(circuit.maximumFailures, circuit.failures + 1);
  return {
    ...circuit,
    failures,
    state: failures >= circuit.maximumFailures ? "open" : "closed",
    lastFailure: {
      orderIndex: record.orderIndex,
      scenarioId: record.scenarioId,
      surface: record.surface,
      repeat: record.repeat,
      infrastructureAttempt: record.infrastructureAttempt,
      failure: record.infrastructureFailure ?? record.failure ?? "provider-transport-failure"
    }
  };
}

export function validBenchmarkCandidateOutcome(candidateOutcome) {
  const validLifecycleOutcome = candidateOutcome?.schemaVersion === 2
    && candidateOutcome.kind === "terminal-lifecycle-mismatch"
    && ["completed", "blocked", "aborted", "error", "unknown"].includes(candidateOutcome.expectedOperationStatus)
    && ["completed", "blocked", "aborted", "error", "unknown"].includes(candidateOutcome.observedOperationStatus)
    && ["pending", "completed", "refused", "failed", "unknown"].includes(candidateOutcome.expectedTaskStatus)
    && ["pending", "completed", "refused", "failed", "unknown"].includes(candidateOutcome.observedTaskStatus)
    && (candidateOutcome.expectedOperationStatus !== candidateOutcome.observedOperationStatus
      || candidateOutcome.expectedTaskStatus !== candidateOutcome.observedTaskStatus)
    && Number.isSafeInteger(candidateOutcome.turnIndex) && candidateOutcome.turnIndex > 0;
  const validLegacyOutcome = candidateOutcome?.schemaVersion === 1
    && candidateOutcome.kind === "terminal-settlement-mismatch"
    && ["completed", "blocked", "aborted", "error", "unknown", "refused"].includes(candidateOutcome.expectedSettlement)
    && ["completed", "blocked", "aborted", "error", "unknown"].includes(candidateOutcome.observedSettlement)
    && candidateOutcome.expectedSettlement !== candidateOutcome.observedSettlement
    && Number.isSafeInteger(candidateOutcome.turnIndex) && candidateOutcome.turnIndex > 0;
  return validLifecycleOutcome || validLegacyOutcome;
}

export function classifyPreUsageFailure(agent, usage, diagnosticInput,
  { terminalProviderError = false, usageParsingError = false, candidateOutcome = null } = {}) {
  const diagnostic = String(diagnosticInput ?? "").toLowerCase();
  const measuredUsage = exactBenchmarkMeasuredUsage(usage);
  const measuredCoreUsage = Number.isSafeInteger(usage?.sessions) && usage.sessions > 0
    && ["input", "output", "cacheRead", "cacheWrite", "total", "fresh"]
      .every((field) => Number.isSafeInteger(usage?.[field]) && usage[field] >= 0)
    && usage.fresh === usage.input + usage.output
    && usage.total === usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  const measuredZeroUsage = measuredCoreUsage
    && ["input", "output", "cacheRead", "cacheWrite", "reasoning", "total", "fresh"]
      .every((field) => Number(usage[field]) === 0);
  const measuredStatus = measuredUsage ? "measured-but-unaccepted" : "measured-lower-bound";
  if (agent.timedOut) {
    return measuredCoreUsage
      ? {
          failure: "agent-timeout-after-observed-usage",
          class: "transport-timeout",
          // The recorded tokens remain a useful floor, but a timed-out stream
          // may have an unobserved suffix and therefore is never exact.
          usageStatus: "measured-lower-bound",
          retryable: false
        }
      : {
          failure: "agent-timeout-with-terminal-usage-unknown",
          class: "transport-timeout",
          usageStatus: "unknown-after-provider-start",
          retryable: false
        };
  }
  const codexOutcome = usage?.codexEventOutcome;
  const providerUnavailable = /\b(?:server(?:s)? (?:are )?(?:currently )?overloaded|temporarily unavailable|service unavailable|try again later)\b/.test(diagnostic);
  const providerFetchFailed = /(?:\bfetch failed\b|\bnetwork(?: request)? (?:error|failed)\b|\bsocket hang up\b|\bconnection (?:reset|closed|terminated)\b|\beconnreset\b|\betimedout\b|\bund_err_[a-z_]+\b)/.test(diagnostic);
  if ((terminalProviderError || agent.code !== 0) && measuredCoreUsage && providerFetchFailed) {
    const afterUsage = Number(usage.fresh) > 0;
    return {
      failure: afterUsage
        ? "provider-fetch-failed-after-measured-usage"
        : "provider-fetch-failed-with-zero-measured-usage",
      class: "provider-transport",
      // A zero-shaped local usage record after a broken transport is not an
      // authoritative provider receipt. The request may have been accepted
      // before the stream failed, so zero cannot be claimed or replayed.
      usageStatus: afterUsage ? measuredStatus : "unknown-after-provider-start",
      retryable: false
    };
  }
  if ((terminalProviderError || agent.code !== 0) && providerFetchFailed) {
    return {
      failure: "provider-fetch-failed-with-usage-unavailable",
      class: "provider-transport",
      usageStatus: "unknown-after-provider-start",
      // A transport exception cannot prove that the provider did not accept
      // the request. Never replay it blindly as a new paid attempt.
      retryable: false
    };
  }
  if ((terminalProviderError || agent.code !== 0) && measuredCoreUsage && providerUnavailable) {
    const afterUsage = Number(usage.fresh) > 0;
    return {
      failure: afterUsage
        ? "provider-temporarily-unavailable-after-measured-usage"
        : "provider-temporarily-unavailable-with-zero-measured-usage",
      class: "provider-infrastructure",
      usageStatus: afterUsage ? measuredStatus : "unknown-after-provider-start",
      retryable: false
    };
  }
  if (agent.code === 0 && measuredZeroUsage && providerFetchFailed) {
    return {
      failure: "provider-fetch-failed-with-zero-measured-usage",
      class: "provider-transport",
      usageStatus: "unknown-after-provider-start",
      retryable: false
    };
  }
  if (agent.code === 0 && measuredZeroUsage && providerUnavailable) {
    return {
      failure: "provider-temporarily-unavailable-with-zero-measured-usage",
      class: "provider-infrastructure",
      usageStatus: "unknown-after-provider-start",
      retryable: false
    };
  }
  if (usageParsingError) {
    return measuredCoreUsage
      ? {
          failure: "pi-session-usage-incomplete-after-provider-start",
          class: "usage-accounting",
          usageStatus: measuredStatus,
          retryable: false
        }
      : {
          failure: "pi-session-usage-unavailable-after-provider-start",
          class: "unknown-cost",
          usageStatus: "unknown-after-provider-start",
          retryable: false
        };
  }
  if (codexOutcome?.runValidity === "valid" && codexOutcome.failureClass && measuredUsage) return undefined;
  const validCandidateOutcome = validBenchmarkCandidateOutcome(candidateOutcome);
  if (agent.code !== 0 && validCandidateOutcome && measuredUsage && usage.fresh > 0) return undefined;
  const explicitProviderPolicyRefusal = (
    /\b(?:provider|safety|cyber safety)\b.{0,96}\b(?:refus(?:al|ed|e)|disallowed|not allowed|blocked)\b/.test(diagnostic)
    || /\b(?:refus(?:al|ed|e)|disallowed|not allowed|blocked)\b.{0,96}\b(?:provider|safety|cyber safety)\b/.test(diagnostic)
    || /\b(?:cannot assist|can't assist)\b/.test(diagnostic)
    || (terminalProviderError && /\b(?:policy|refus(?:al|ed|e)|disallowed|not allowed|cyber safety)\b/.test(diagnostic))
  );
  if ((terminalProviderError || agent.code !== 0) && explicitProviderPolicyRefusal) {
    return measuredCoreUsage
      ? { failure: "provider-policy-refusal-after-measured-usage", class: "provider-policy", usageStatus: measuredStatus, retryable: false }
      : { failure: "provider-policy-refusal-with-usage-unavailable", class: "provider-policy", usageStatus: "unknown-after-provider-start", retryable: false };
  }
  if (codexOutcome?.runValidity === "invalid_harness") {
    return {
      failure: `codex-event-contract-invalid:${(codexOutcome.reasonCodes ?? []).join(",") || "unspecified"}`,
      class: "harness-contract",
      usageStatus: measuredUsage ? "measured-but-unaccepted" : "unknown-after-provider-start",
      retryable: false
    };
  }
  if (agent.code === 0) return undefined;
  if (measuredCoreUsage) return { failure: `agent-exit-${agent.code}-after-measured-usage`, class: "agent-process", usageStatus: measuredStatus, retryable: false };
  return { failure: `agent-exit-${agent.code}-with-usage-unavailable`, class: "unknown-cost", usageStatus: "unknown-after-provider-start", retryable: true };
}
