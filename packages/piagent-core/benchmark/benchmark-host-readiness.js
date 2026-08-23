import crypto from "node:crypto";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";

const DIGEST_ALGORITHM = "sha256-canonical-json-v1";
const POLICY_DOMAIN = "piagent-benchmark-host-readiness-policy-v1\0";
const HOST_DOMAIN = "piagent-benchmark-host-fingerprint-v1\0";
const RECEIPT_DOMAIN = "piagent-benchmark-host-readiness-receipt-v1\0";
const TIMING_UNDERRUN_TOLERANCE_RATIO = 0.05;
const POLICY_FIELDS = Object.freeze([
  "schemaVersion", "required", "sampleCount", "sampleIntervalMilliseconds",
  "cpuSampleMilliseconds", "maximumNormalizedLoad1", "minimumCpuIdlePercent",
  "maximumTimingOverrunRatio", "maximumStartDelayMilliseconds", "failFast"
]);
const RECEIPT_FIELDS = Object.freeze([
  "schemaVersion", "kind", "digestAlgorithm", "policyDigest", "hostFingerprint",
  "runId", "configurationDigest", "collectedAt", "completedRuns", "authorizedThroughRuns",
  "expectedSamples", "observedSamples", "status", "failureReasons", "samples", "digest"
]);
const HOST_FIELDS = Object.freeze(["schemaVersion", "platform", "architecture", "logicalCpuCount", "digest"]);
const SAMPLE_FIELDS = Object.freeze([
  "index", "startedOffsetMilliseconds", "cpuWindowMilliseconds", "normalizedLoad1",
  "cpuIdlePercent", "passed", "failures"
]);
const CPU_TIME_FIELDS = Object.freeze(["user", "nice", "sys", "idle", "irq"]);
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_HOST_LABEL = /^[a-z0-9][a-z0-9._-]{0,31}$/i;
const SAFE_RUN_ID = /^[a-z0-9][a-z0-9._:-]{0,255}$/i;

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactFields(value, fields, label, errors) {
  if (!plainObject(value)) {
    errors.push(`${label}-must-be-an-object`);
    return false;
  }
  const allowed = new Set(fields);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) errors.push(`${label}-unsupported-field:${field}`);
  }
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) errors.push(`${label}-missing-field:${field}`);
  }
  return true;
}

function canonicalJson(value, seen = new Set()) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonical JSON refuses non-finite numbers");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value !== "object") throw new TypeError(`canonical JSON refuses ${typeof value}`);
  if (seen.has(value)) throw new TypeError("canonical JSON refuses cycles");
  seen.add(value);
  let encoded;
  if (Array.isArray(value)) {
    encoded = `[${value.map((item) => canonicalJson(item, seen)).join(",")}]`;
  } else {
    const keys = Object.keys(value).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    encoded = `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], seen)}`).join(",")}}`;
  }
  seen.delete(value);
  return encoded;
}

function sha256(domain, value) {
  return crypto.createHash("sha256").update(domain).update(canonicalJson(value)).digest("hex");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalPolicy(policy) {
  return {
    schemaVersion: policy.schemaVersion,
    required: policy.required,
    sampleCount: policy.sampleCount,
    sampleIntervalMilliseconds: policy.sampleIntervalMilliseconds,
    cpuSampleMilliseconds: policy.cpuSampleMilliseconds,
    maximumNormalizedLoad1: policy.maximumNormalizedLoad1,
    minimumCpuIdlePercent: policy.minimumCpuIdlePercent,
    maximumTimingOverrunRatio: policy.maximumTimingOverrunRatio,
    maximumStartDelayMilliseconds: policy.maximumStartDelayMilliseconds,
    failFast: policy.failFast
  };
}

/** Validate the closed, immutable host-readiness policy from spend-control.v1.json. */
export function benchmarkHostReadinessPolicyValidationErrors(policy) {
  const errors = [];
  if (!exactFields(policy, POLICY_FIELDS, "host-readiness-policy", errors)) return deepFreeze(errors);
  if (policy.schemaVersion !== 1) errors.push("host-readiness-policy-schema-version-must-be-1");
  if (policy.required !== true) errors.push("host-readiness-policy-required-must-be-true");
  if (policy.sampleCount !== 3) errors.push("host-readiness-policy-sample-count-must-be-3");
  if (!Number.isSafeInteger(policy.sampleIntervalMilliseconds) || policy.sampleIntervalMilliseconds < 0
    || policy.sampleIntervalMilliseconds > 600_000) {
    errors.push("host-readiness-policy-sample-interval-milliseconds-invalid");
  }
  if (!Number.isSafeInteger(policy.cpuSampleMilliseconds) || policy.cpuSampleMilliseconds <= 0
    || policy.cpuSampleMilliseconds > 60_000) {
    errors.push("host-readiness-policy-cpu-sample-milliseconds-invalid");
  }
  if (!Number.isFinite(policy.maximumNormalizedLoad1) || policy.maximumNormalizedLoad1 <= 0
    || policy.maximumNormalizedLoad1 > 1) {
    errors.push("host-readiness-policy-maximum-normalized-load1-invalid");
  }
  if (!Number.isFinite(policy.minimumCpuIdlePercent) || policy.minimumCpuIdlePercent < 0
    || policy.minimumCpuIdlePercent > 100) {
    errors.push("host-readiness-policy-minimum-cpu-idle-percent-invalid");
  }
  if (!Number.isFinite(policy.maximumTimingOverrunRatio) || policy.maximumTimingOverrunRatio < 0
    || policy.maximumTimingOverrunRatio > 1) {
    errors.push("host-readiness-policy-maximum-timing-overrun-ratio-invalid");
  }
  if (!Number.isSafeInteger(policy.maximumStartDelayMilliseconds)
    || policy.maximumStartDelayMilliseconds <= 0 || policy.maximumStartDelayMilliseconds > 600_000) {
    errors.push("host-readiness-policy-maximum-start-delay-milliseconds-invalid");
  }
  if (policy.failFast !== true) errors.push("host-readiness-policy-fail-fast-must-be-true");
  return deepFreeze(errors);
}

/** Return the order-independent SHA-256 binding for an exact, valid policy. */
export function benchmarkHostReadinessPolicyDigest(policy) {
  const errors = benchmarkHostReadinessPolicyValidationErrors(policy);
  if (errors.length > 0) {
    const error = new Error(`Invalid benchmark host-readiness policy: ${errors.join(", ")}`);
    error.code = "BENCHMARK_HOST_READINESS_POLICY_INVALID";
    throw error;
  }
  return sha256(POLICY_DOMAIN, canonicalPolicy(policy));
}

function finiteNonnegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function measuredCpus(value, expectedCount = null) {
  if (!Array.isArray(value) || value.length === 0 || (expectedCount !== null && value.length !== expectedCount)) {
    throw measurementError("cpu-topology-invalid");
  }
  return value.map((cpu) => {
    if (!plainObject(cpu?.times)) throw measurementError("cpu-times-invalid");
    const times = {};
    for (const field of CPU_TIME_FIELDS) {
      if (!finiteNonnegative(cpu.times[field])) throw measurementError(`cpu-time-${field}-invalid`);
      times[field] = cpu.times[field];
    }
    return times;
  });
}

function measurementError(reason) {
  const error = new Error(`Benchmark host-readiness measurement failed closed: ${reason}`);
  error.code = "BENCHMARK_HOST_READINESS_MEASUREMENT_INVALID";
  return error;
}

function monotonicValue(read) {
  const value = read();
  if (!finiteNonnegative(value)) throw measurementError("monotonic-clock-invalid");
  return value;
}

function cpuIdlePercent(before, after) {
  if (before.length !== after.length) throw measurementError("cpu-topology-drift");
  let idleDelta = 0;
  let totalDelta = 0;
  for (let index = 0; index < before.length; index += 1) {
    for (const field of CPU_TIME_FIELDS) {
      const delta = after[index][field] - before[index][field];
      if (!finiteNonnegative(delta)) throw measurementError(`cpu-time-${field}-not-monotonic`);
      totalDelta += delta;
      if (field === "idle") idleDelta += delta;
    }
  }
  if (!(totalDelta > 0)) throw measurementError("cpu-tick-delta-empty");
  return idleDelta * 100 / totalDelta;
}

function rounded(value, digits) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function hostFingerprint(platform, architecture, logicalCpuCount) {
  if (typeof platform !== "string" || !SAFE_HOST_LABEL.test(platform)) throw measurementError("platform-invalid");
  if (typeof architecture !== "string" || !SAFE_HOST_LABEL.test(architecture)) throw measurementError("architecture-invalid");
  if (!Number.isSafeInteger(logicalCpuCount) || logicalCpuCount <= 0 || logicalCpuCount > 65_536) {
    throw measurementError("logical-cpu-count-invalid");
  }
  const basis = { schemaVersion: 1, platform, architecture, logicalCpuCount };
  return deepFreeze({ ...basis, digest: sha256(HOST_DOMAIN, basis) });
}

function timingBounds(expectedMilliseconds, policy) {
  return {
    minimum: expectedMilliseconds * (1 - TIMING_UNDERRUN_TOLERANCE_RATIO),
    maximum: expectedMilliseconds * (1 + policy.maximumTimingOverrunRatio)
  };
}

function sampleFailures(sample, policy, previous = null) {
  const failures = [];
  const cpuWindow = timingBounds(policy.cpuSampleMilliseconds, policy);
  if (sample.cpuWindowMilliseconds < cpuWindow.minimum) failures.push("cpu-sample-window-underrun");
  if (sample.cpuWindowMilliseconds > cpuWindow.maximum) failures.push("cpu-sample-window-overrun");
  if (previous && policy.sampleIntervalMilliseconds > 0) {
    const startDelta = sample.startedOffsetMilliseconds - previous.startedOffsetMilliseconds;
    const cadence = timingBounds(policy.sampleIntervalMilliseconds, policy);
    if (startDelta < cadence.minimum) failures.push("sample-start-cadence-underrun");
    if (startDelta > cadence.maximum) failures.push("sample-start-cadence-overrun");
  }
  if (sample.normalizedLoad1 > policy.maximumNormalizedLoad1) failures.push("maximum-normalized-load1-exceeded");
  if (sample.cpuIdlePercent < policy.minimumCpuIdlePercent) failures.push("minimum-cpu-idle-percent-not-met");
  return failures;
}

function receiptDigest(receipt) {
  const { digest: _digest, ...basis } = receipt;
  return sha256(RECEIPT_DOMAIN, basis);
}

function collectionDependencies(overrides = {}) {
  const dependencies = {
    loadavg: () => os.loadavg(),
    cpus: () => os.cpus(),
    platform: () => os.platform(),
    arch: () => os.arch(),
    monotonicNow: () => performance.now(),
    wallClockNow: () => Date.now(),
    sleep: (milliseconds) => delay(milliseconds),
    ...overrides
  };
  for (const field of ["loadavg", "cpus", "platform", "arch", "monotonicNow", "wallClockNow", "sleep"]) {
    if (typeof dependencies[field] !== "function") throw new TypeError(`host readiness dependency ${field} must be a function`);
  }
  return dependencies;
}

function validRunId(value) {
  return typeof value === "string" && SAFE_RUN_ID.test(value);
}

function validConfigurationDigest(value) {
  return typeof value === "string" && SHA256.test(value);
}

function canonicalWallClockTimestamp(read) {
  const value = read();
  if (!finiteNonnegative(value)) throw measurementError("wall-clock-invalid");
  try { return new Date(value).toISOString(); }
  catch { throw measurementError("wall-clock-invalid"); }
}

function timestampMilliseconds(value) {
  if (typeof value !== "string") return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  try {
    if (new Date(milliseconds).toISOString() !== value) return null;
  } catch { return null; }
  return milliseconds;
}

function validWindow(completedRuns, authorizedThroughRuns) {
  return Number.isSafeInteger(completedRuns) && completedRuns >= 0
    && Number.isSafeInteger(authorizedThroughRuns) && authorizedThroughRuns > completedRuns;
}

/**
 * Collect a privacy-safe, three-sample host receipt before a provider window.
 * The injected clock and sleeper make tests deterministic without real waiting.
 */
export async function collectBenchmarkHostReadinessReceipt(input, dependencyOverrides = {}) {
  const inputErrors = [];
  if (!exactFields(input, ["policy", "runId", "configurationDigest", "completedRuns", "authorizedThroughRuns"], "host-readiness-input", inputErrors)) {
    throw new TypeError(inputErrors.join(", "));
  }
  const policyErrors = benchmarkHostReadinessPolicyValidationErrors(input.policy);
  if (policyErrors.length > 0) {
    const error = new Error(`Invalid benchmark host-readiness policy: ${policyErrors.join(", ")}`);
    error.code = "BENCHMARK_HOST_READINESS_POLICY_INVALID";
    throw error;
  }
  if (!validWindow(input.completedRuns, input.authorizedThroughRuns)) {
    const error = new Error("Benchmark host-readiness authorization window is invalid");
    error.code = "BENCHMARK_HOST_READINESS_WINDOW_INVALID";
    throw error;
  }
  if (!validRunId(input.runId)) {
    const error = new Error("Benchmark host-readiness run binding is invalid");
    error.code = "BENCHMARK_HOST_READINESS_RUN_ID_INVALID";
    throw error;
  }
  if (!validConfigurationDigest(input.configurationDigest)) {
    const error = new Error("Benchmark host-readiness configuration binding is invalid");
    error.code = "BENCHMARK_HOST_READINESS_CONFIGURATION_DIGEST_INVALID";
    throw error;
  }

  const policy = deepFreeze(canonicalPolicy(input.policy));
  const dependencies = collectionDependencies(dependencyOverrides);
  const firstBefore = measuredCpus(dependencies.cpus());
  const fingerprint = hostFingerprint(dependencies.platform(), dependencies.arch(), firstBefore.length);
  const origin = monotonicValue(dependencies.monotonicNow);
  let before = firstBefore;
  const samples = [];

  for (let index = 0; index < policy.sampleCount; index += 1) {
    if (index > 0) before = measuredCpus(dependencies.cpus(), fingerprint.logicalCpuCount);
    const started = index === 0 ? origin : monotonicValue(dependencies.monotonicNow);
    const load = dependencies.loadavg();
    if (!Array.isArray(load) || !finiteNonnegative(load[0])) throw measurementError("load-average-invalid");
    await dependencies.sleep(policy.cpuSampleMilliseconds);
    const after = measuredCpus(dependencies.cpus(), fingerprint.logicalCpuCount);
    const ended = monotonicValue(dependencies.monotonicNow);
    if (ended < started) throw measurementError("monotonic-clock-regressed");

    const sample = {
      index: index + 1,
      startedOffsetMilliseconds: rounded(started - origin, 3),
      cpuWindowMilliseconds: rounded(ended - started, 3),
      normalizedLoad1: rounded(load[0] / fingerprint.logicalCpuCount, 6),
      cpuIdlePercent: rounded(cpuIdlePercent(before, after), 6)
    };
    if (!(sample.cpuWindowMilliseconds > 0)) throw measurementError("cpu-window-empty");
    const failures = sampleFailures(sample, policy, samples.at(-1) ?? null);
    samples.push(deepFreeze({ ...sample, passed: failures.length === 0, failures: deepFreeze(failures) }));
    if (failures.length > 0) break;

    if (index + 1 < policy.sampleCount) {
      const remainingInterval = Math.max(0, policy.sampleIntervalMilliseconds - (ended - started));
      await dependencies.sleep(remainingInterval);
    }
  }

  const failureReasons = samples.find((sample) => !sample.passed)?.failures ?? [];
  const collectedAt = canonicalWallClockTimestamp(dependencies.wallClockNow);
  const receipt = {
    schemaVersion: 1,
    kind: "benchmark-host-readiness",
    digestAlgorithm: DIGEST_ALGORITHM,
    policyDigest: benchmarkHostReadinessPolicyDigest(policy),
    hostFingerprint: fingerprint,
    runId: input.runId,
    configurationDigest: input.configurationDigest,
    collectedAt,
    completedRuns: input.completedRuns,
    authorizedThroughRuns: input.authorizedThroughRuns,
    expectedSamples: policy.sampleCount,
    observedSamples: samples.length,
    status: failureReasons.length === 0 && samples.length === policy.sampleCount ? "ready" : "blocked",
    failureReasons: [...failureReasons],
    samples
  };
  return deepFreeze({ ...receipt, digest: receiptDigest(receipt) });
}

function validateHostFingerprint(value, errors) {
  if (!exactFields(value, HOST_FIELDS, "host-fingerprint", errors)) return;
  if (value.schemaVersion !== 1) errors.push("host-fingerprint-schema-version-must-be-1");
  if (typeof value.platform !== "string" || !SAFE_HOST_LABEL.test(value.platform)) errors.push("host-fingerprint-platform-invalid");
  if (typeof value.architecture !== "string" || !SAFE_HOST_LABEL.test(value.architecture)) errors.push("host-fingerprint-architecture-invalid");
  if (!Number.isSafeInteger(value.logicalCpuCount) || value.logicalCpuCount <= 0 || value.logicalCpuCount > 65_536) {
    errors.push("host-fingerprint-logical-cpu-count-invalid");
  }
  if (!SHA256.test(String(value.digest ?? ""))) errors.push("host-fingerprint-digest-invalid");
  else {
    try {
      const basis = {
        schemaVersion: value.schemaVersion,
        platform: value.platform,
        architecture: value.architecture,
        logicalCpuCount: value.logicalCpuCount
      };
      if (sha256(HOST_DOMAIN, basis) !== value.digest) errors.push("host-fingerprint-digest-mismatch");
    } catch { errors.push("host-fingerprint-not-canonical"); }
  }
}

function validateSample(sample, index, policy, previous, errors) {
  const label = `host-readiness-sample-${index + 1}`;
  if (!exactFields(sample, SAMPLE_FIELDS, label, errors)) return;
  if (sample.index !== index + 1) errors.push(`${label}-index-invalid`);
  if (!finiteNonnegative(sample.startedOffsetMilliseconds)) errors.push(`${label}-start-offset-invalid`);
  if (index === 0 && sample.startedOffsetMilliseconds !== 0) errors.push(`${label}-first-start-offset-must-be-zero`);
  if (!Number.isFinite(sample.cpuWindowMilliseconds) || sample.cpuWindowMilliseconds <= 0) errors.push(`${label}-cpu-window-invalid`);
  if (!finiteNonnegative(sample.normalizedLoad1)) errors.push(`${label}-normalized-load1-invalid`);
  if (!Number.isFinite(sample.cpuIdlePercent) || sample.cpuIdlePercent < 0 || sample.cpuIdlePercent > 100) {
    errors.push(`${label}-cpu-idle-percent-invalid`);
  }
  if (previous && finiteNonnegative(sample.startedOffsetMilliseconds)
    && sample.startedOffsetMilliseconds < previous.startedOffsetMilliseconds) errors.push(`${label}-clock-regressed`);
  if (!Array.isArray(sample.failures)) errors.push(`${label}-failures-must-be-an-array`);
  if (typeof sample.passed !== "boolean") errors.push(`${label}-passed-must-be-boolean`);
  if (finiteNonnegative(sample.normalizedLoad1) && Number.isFinite(sample.cpuIdlePercent)
    && sample.cpuIdlePercent >= 0 && sample.cpuIdlePercent <= 100
    && Number.isFinite(sample.cpuWindowMilliseconds) && sample.cpuWindowMilliseconds > 0
    && finiteNonnegative(sample.startedOffsetMilliseconds) && Array.isArray(sample.failures)) {
    const expected = sampleFailures(sample, policy, previous);
    if (JSON.stringify(sample.failures) !== JSON.stringify(expected)) errors.push(`${label}-failure-reasons-mismatch`);
    if (sample.passed !== (expected.length === 0)) errors.push(`${label}-decision-mismatch`);
  }
}

/** Validate receipt integrity, policy binding, decision invariants and an optional exact window/host. */
export function validateBenchmarkHostReadinessReceipt(receipt, options = {}) {
  const errors = [];
  const policyErrors = benchmarkHostReadinessPolicyValidationErrors(options.policy);
  if (policyErrors.length > 0) errors.push(...policyErrors);
  if (!exactFields(receipt, RECEIPT_FIELDS, "host-readiness-receipt", errors)) {
    return deepFreeze({ valid: false, ready: false, errors, receipt: null });
  }
  if (receipt.schemaVersion !== 1) errors.push("host-readiness-receipt-schema-version-must-be-1");
  if (receipt.kind !== "benchmark-host-readiness") errors.push("host-readiness-receipt-kind-invalid");
  if (receipt.digestAlgorithm !== DIGEST_ALGORITHM) errors.push("host-readiness-receipt-digest-algorithm-invalid");
  if (!SHA256.test(String(receipt.policyDigest ?? ""))) errors.push("host-readiness-receipt-policy-digest-invalid");
  if (!SHA256.test(String(receipt.digest ?? ""))) errors.push("host-readiness-receipt-digest-invalid");
  validateHostFingerprint(receipt.hostFingerprint, errors);
  if (!validRunId(receipt.runId)) errors.push("host-readiness-receipt-run-id-invalid");
  if (!validConfigurationDigest(receipt.configurationDigest)) errors.push("host-readiness-receipt-configuration-digest-invalid");
  if (timestampMilliseconds(receipt.collectedAt) === null) errors.push("host-readiness-receipt-collected-at-invalid");
  if (!validRunId(options.runId)) errors.push("host-readiness-receipt-expected-run-id-invalid");
  else if (receipt.runId !== options.runId) errors.push("host-readiness-receipt-run-id-mismatch");
  if (!validConfigurationDigest(options.configurationDigest)) {
    errors.push("host-readiness-receipt-expected-configuration-digest-invalid");
  } else if (receipt.configurationDigest !== options.configurationDigest) {
    errors.push("host-readiness-receipt-configuration-digest-mismatch");
  }
  if (!validWindow(receipt.completedRuns, receipt.authorizedThroughRuns)) errors.push("host-readiness-receipt-window-invalid");
  if (options.completedRuns !== undefined && receipt.completedRuns !== options.completedRuns) errors.push("host-readiness-receipt-completed-runs-mismatch");
  if (options.authorizedThroughRuns !== undefined && receipt.authorizedThroughRuns !== options.authorizedThroughRuns) {
    errors.push("host-readiness-receipt-authorized-through-runs-mismatch");
  }
  if (options.hostFingerprintDigest !== undefined && receipt.hostFingerprint?.digest !== options.hostFingerprintDigest) {
    errors.push("host-readiness-receipt-host-drift");
  }

  if (policyErrors.length === 0) {
    const policy = canonicalPolicy(options.policy);
    if (receipt.policyDigest !== benchmarkHostReadinessPolicyDigest(policy)) errors.push("host-readiness-receipt-policy-digest-mismatch");
    if (receipt.expectedSamples !== policy.sampleCount) errors.push("host-readiness-receipt-expected-samples-mismatch");
    if (!Array.isArray(receipt.samples)) errors.push("host-readiness-receipt-samples-must-be-an-array");
    else {
      if (receipt.observedSamples !== receipt.samples.length) errors.push("host-readiness-receipt-observed-samples-mismatch");
      if (receipt.samples.length < 1 || receipt.samples.length > policy.sampleCount) errors.push("host-readiness-receipt-sample-count-invalid");
      receipt.samples.forEach((sample, index) => validateSample(sample, index, policy, receipt.samples[index - 1], errors));
      const firstFailed = receipt.samples.findIndex((sample) => sample?.passed === false);
      const expectedFailures = firstFailed < 0 ? [] : receipt.samples[firstFailed].failures;
      const expectedStatus = firstFailed < 0 && receipt.samples.length === policy.sampleCount ? "ready" : "blocked";
      if (firstFailed >= 0 && firstFailed !== receipt.samples.length - 1) errors.push("host-readiness-receipt-did-not-fail-fast");
      if (firstFailed < 0 && receipt.samples.length !== policy.sampleCount) errors.push("host-readiness-receipt-incomplete-without-failure");
      if (receipt.status !== expectedStatus) errors.push("host-readiness-receipt-status-mismatch");
      if (!Array.isArray(receipt.failureReasons)
        || JSON.stringify(receipt.failureReasons) !== JSON.stringify(expectedFailures)) {
        errors.push("host-readiness-receipt-failure-reasons-mismatch");
      }
    }
  }
  try {
    if (SHA256.test(String(receipt.digest ?? "")) && receiptDigest(receipt) !== receipt.digest) {
      errors.push("host-readiness-receipt-digest-mismatch");
    }
  } catch { errors.push("host-readiness-receipt-not-canonical"); }

  const valid = errors.length === 0;
  let canonicalReceipt = null;
  if (valid) {
    try { canonicalReceipt = deepFreeze(JSON.parse(canonicalJson(receipt))); }
    catch { /* The digest check above already records canonicalization errors. */ }
  }
  return deepFreeze({ valid, ready: valid && receipt.status === "ready", errors, receipt: canonicalReceipt });
}

/**
 * Validate that a ready, bound receipt is still fresh immediately before provider start.
 * `nowMilliseconds` is injectable so tests do not depend on wall-clock time.
 */
export function benchmarkHostReadinessStartValidationErrors(receipt, options = {}) {
  const validation = validateBenchmarkHostReadinessReceipt(receipt, options);
  const errors = [...validation.errors];
  if (validation.valid && !validation.ready) errors.push("host-readiness-start-receipt-not-ready");
  const now = options.nowMilliseconds ?? Date.now();
  if (!finiteNonnegative(now)) errors.push("host-readiness-start-clock-invalid");
  const collectedAt = timestampMilliseconds(receipt?.collectedAt);
  if (validation.valid && finiteNonnegative(now) && collectedAt !== null) {
    const age = now - collectedAt;
    if (age < 0) errors.push("host-readiness-start-receipt-from-future");
    else if (age > options.policy.maximumStartDelayMilliseconds) {
      errors.push("host-readiness-start-delay-exceeded");
    }
  }
  return deepFreeze(errors);
}

function validatedStageBoundaries(value, errors) {
  if (!Array.isArray(value) || value.length < 2) {
    errors.push("host-readiness-history-stage-boundaries-invalid");
    return [];
  }
  if (value[0] !== 0) errors.push("host-readiness-history-stage-boundaries-must-start-at-zero");
  for (let index = 0; index < value.length; index += 1) {
    if (!Number.isSafeInteger(value[index]) || value[index] < 0) {
      errors.push(`host-readiness-history-stage-boundary-invalid:${index + 1}`);
    }
    if (index > 0 && value[index] <= value[index - 1]) {
      errors.push(`host-readiness-history-stage-boundaries-not-increasing:${index + 1}`);
    }
  }
  return value;
}

/** Validate an ordered receipt history, including authorization continuity and host drift. */
export function summarizeBenchmarkHostReadinessHistory(input, options = {}) {
  const request = Array.isArray(input) ? { ...options, receipts: input } : input;
  const errors = [];
  const blockingReasons = [];
  if (!plainObject(request)) {
    return deepFreeze({
      schemaVersion: 1, policyDigest: null, receiptCount: 0, validReceiptCount: 0,
      hostFingerprintDigest: null, completedRuns: null, windowStartedAtRuns: null,
      authorizedThroughRuns: null, windowCoverage: "unavailable",
      valid: false, ready: false, errors: ["host-readiness-history-must-be-an-object"], blockingReasons: []
    });
  }
  const policyErrors = benchmarkHostReadinessPolicyValidationErrors(request.policy);
  if (policyErrors.length > 0) errors.push(...policyErrors);
  if (!validRunId(request.runId)) errors.push("host-readiness-history-run-id-invalid");
  if (!validConfigurationDigest(request.configurationDigest)) {
    errors.push("host-readiness-history-configuration-digest-invalid");
  }
  const stageBoundaries = validatedStageBoundaries(request.stageBoundaries, errors);
  const receipts = Array.isArray(request.receipts) ? request.receipts : [];
  if (!Array.isArray(request.receipts)) errors.push("host-readiness-history-receipts-must-be-an-array");
  if (receipts.length === 0) errors.push("host-readiness-history-empty");

  let hostDigest = null;
  let previous = null;
  let validReceiptCount = 0;
  for (let index = 0; index < receipts.length; index += 1) {
    const result = validateBenchmarkHostReadinessReceipt(receipts[index], {
      policy: request.policy,
      runId: request.runId,
      configurationDigest: request.configurationDigest
    });
    if (!result.valid) errors.push(...result.errors.map((error) => `host-readiness-history-receipt-${index + 1}:${error}`));
    else {
      validReceiptCount += 1;
      const currentHost = result.receipt.hostFingerprint.digest;
      if (hostDigest === null) hostDigest = currentHost;
      else if (currentHost !== hostDigest) errors.push(`host-readiness-history-host-drift:${index + 1}`);
      if (index === 0 && result.receipt.completedRuns !== 0) {
        errors.push("host-readiness-history-does-not-start-at-zero");
      }
      const boundaryIndex = stageBoundaries.indexOf(result.receipt.authorizedThroughRuns);
      if (stageBoundaries.length > 0 && boundaryIndex < 1) {
        errors.push(`host-readiness-history-authorization-not-a-stage-boundary:${index + 1}`);
      }
      if (index === 0 && stageBoundaries.length > 1
        && result.receipt.authorizedThroughRuns !== stageBoundaries[1]) {
        errors.push("host-readiness-history-skipped-stage-window:1");
      }
      if (previous) {
        if (result.receipt.completedRuns < previous.completedRuns) {
          errors.push(`host-readiness-history-completed-runs-regressed:${index + 1}`);
        }
        if (result.receipt.completedRuns > previous.authorizedThroughRuns) {
          errors.push(`host-readiness-history-window-gap:${index + 1}`);
        }
        if (result.receipt.authorizedThroughRuns < previous.authorizedThroughRuns) {
          errors.push(`host-readiness-history-authorization-regressed:${index + 1}`);
        } else if (result.receipt.authorizedThroughRuns > previous.authorizedThroughRuns) {
          const previousBoundaryIndex = stageBoundaries.indexOf(previous.authorizedThroughRuns);
          if (previousBoundaryIndex < 0
            || result.receipt.authorizedThroughRuns !== stageBoundaries[previousBoundaryIndex + 1]) {
            errors.push(`host-readiness-history-skipped-stage-window:${index + 1}`);
          }
          if (result.receipt.completedRuns !== previous.authorizedThroughRuns) {
            errors.push(`host-readiness-history-window-discontinuity:${index + 1}`);
          }
        }
        const previousCollectedAt = timestampMilliseconds(previous.collectedAt);
        const currentCollectedAt = timestampMilliseconds(result.receipt.collectedAt);
        if (previousCollectedAt !== null && currentCollectedAt !== null
          && currentCollectedAt <= previousCollectedAt) {
          errors.push(`host-readiness-history-collected-at-not-increasing:${index + 1}`);
        }
      }
      if (previous?.status === "blocked") errors.push(`host-readiness-history-continued-after-block:${index + 1}`);
      previous = result.receipt;
      if (!result.ready) blockingReasons.push(`host-readiness-history-receipt-blocked:${index + 1}`);
    }
  }
  const last = previous;
  if (!Number.isSafeInteger(request.completedRuns) || request.completedRuns < 0) {
    errors.push("host-readiness-history-completed-runs-invalid");
  } else if (last && (request.completedRuns < last.completedRuns
    || request.completedRuns > last.authorizedThroughRuns)) {
    errors.push("host-readiness-history-completed-runs-outside-authorized-window");
  }
  if (!Number.isSafeInteger(request.authorizedThroughRuns) || request.authorizedThroughRuns <= 0) {
    errors.push("host-readiness-history-authorized-through-runs-invalid");
  } else if (last?.authorizedThroughRuns !== request.authorizedThroughRuns) {
    errors.push("host-readiness-history-authorized-through-runs-mismatch");
  }
  if (request.windowStartedAtRuns !== undefined && last?.completedRuns !== request.windowStartedAtRuns) {
    errors.push("host-readiness-history-window-started-at-runs-mismatch");
  }
  const windowCoverage = !last || !Number.isSafeInteger(request.completedRuns)
    ? "unavailable"
    : request.completedRuns === last.completedRuns
      ? "not-started"
      : request.completedRuns === last.authorizedThroughRuns ? "complete" : "in-progress";
  const valid = errors.length === 0;
  return deepFreeze({
    schemaVersion: 1,
    policyDigest: policyErrors.length === 0 ? benchmarkHostReadinessPolicyDigest(request.policy) : null,
    receiptCount: receipts.length,
    validReceiptCount,
    hostFingerprintDigest: hostDigest,
    completedRuns: Number.isSafeInteger(request.completedRuns) ? request.completedRuns : null,
    windowStartedAtRuns: last?.completedRuns ?? null,
    authorizedThroughRuns: last?.authorizedThroughRuns ?? null,
    windowCoverage,
    valid,
    ready: valid && blockingReasons.length === 0 && receipts.length > 0,
    errors,
    blockingReasons
  });
}
