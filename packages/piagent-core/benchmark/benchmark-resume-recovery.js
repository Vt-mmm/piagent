import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { hardenPrivateRetentionRoot, retainedWorkspaceMarker, writeBenchmarkRunManifest, writePrivateAtomic } from "./benchmark-forensics.js";
import { appendBenchmarkLedger, assertBenchmarkLedgerBinding, benchmarkLedgerCheckpoint, inspectBenchmarkLedger, validateBenchmarkLedgerPrefix } from "./benchmark-ledger.js";
import { expectedBenchmarkRecord, pairedBenchmarkVariantMatched } from "./benchmark-record-validation.js";
import { canonicalBenchmarkTimingDiagnostics } from "./benchmark-timing-diagnostics.js";

function fail(message) {
  const error = new Error(message);
  error.exitCode = 1;
  throw error;
}

function readJson(file, label) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { fail(`Cannot read ${label} ${file}: ${error.message}`); }
}

function key(value) {
  return `${value.scenarioId ?? value.scenario?.id}\0${value.surface}\0${value.repeat}`;
}

function exactUsage(usage, usageStatus) {
  const nonnegative = (value) => Number.isFinite(value) && value >= 0;
  return !["unknown-after-provider-start", "measured-lower-bound"].includes(usageStatus)
    && Number.isInteger(usage?.sessions) && usage.sessions > 0
    && ["fresh", "input", "output", "cacheRead", "cacheWrite", "reasoning", "total"].every((field) => nonnegative(usage?.[field]))
    && usage.fresh === usage.input + usage.output
    && usage.total === usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function omitInvalidTimingDiagnostics(record) {
  if (!record || typeof record !== "object") return record;
  const timing = canonicalBenchmarkTimingDiagnostics(record.timingDiagnostics, record.surface, record.durationSeconds);
  if (timing === undefined) delete record.timingDiagnostics;
  else record.timingDiagnostics = timing;
  return record;
}

export function persistUnacceptedBenchmarkAttempt({ runRoot, manifest, record, reason, forceTokenUnavailable = false }) {
  const attempt = {
    schemaVersion: 1,
    runId: manifest.runId,
    attemptId: record.attemptId,
    orderIndex: record.orderIndex,
    scenarioId: record.scenarioId,
    surface: record.surface,
    repeat: record.repeat,
    attempt: record.infrastructureAttempt,
    failure: reason ?? record.infrastructureFailure ?? record.failure ?? "unaccepted-provider-attempt",
    class: record.infrastructureClass ?? "infrastructure",
    usage: record.usage,
    usageStatus: record.usageStatus ?? "unknown-after-provider-start",
    retryable: record.infrastructureRetryable === true,
    durationSeconds: record.durationSeconds ?? 0,
    recoveredFromInFlight: false
  };
  const attemptKey = `${key(attempt)}\0${attempt.attempt}`;
  manifest.recoveredProviderAttempts = [
    ...(manifest.recoveredProviderAttempts ?? []).filter((value) => `${key(value)}\0${value.attempt}` !== attemptKey),
    attempt
  ];
  if (forceTokenUnavailable || !exactUsage(attempt.usage, attempt.usageStatus)) {
    manifest.tokenClaimsUnavailableReason ??= reason ?? "one-or-more-provider-attempts-have-unaccepted-or-unknown-usage";
  }
  writeBenchmarkRunManifest(runRoot, manifest);
  return attempt;
}

export function clearRecoveredBenchmarkAttempts(manifest, record) {
  manifest.recoveredProviderAttempts = (manifest.recoveredProviderAttempts ?? []).filter((attempt) => key(attempt) !== key(record));
}

export function stageMeasuredBenchmarkRecord({ runRoot, manifest, ledgerBinding, record, infrastructureFailures, index, expected, runId, suite, configurationDigest, runs }) {
  omitInvalidTimingDiagnostics(record);
  record.infrastructureAttempts = record.infrastructureAttempt ?? 1;
  record.infrastructureRetries = Math.max(0, record.infrastructureAttempts - 1);
  record.infrastructureFailures = infrastructureFailures;
  if (!expectedBenchmarkRecord(record, index, expected, runId, suite, configurationDigest, manifest.verificationPlan?.identity) || !pairedBenchmarkVariantMatched(record, runs)) {
    persistUnacceptedBenchmarkAttempt({ runRoot, manifest, record, reason: "measured-record-identity-or-paired-fixture-mismatch", forceTokenUnavailable: true });
    fail(`Runner produced an incomplete, identity-mismatched, or unpaired-fixture record for ${record.scenarioId}/${record.surface}/r${record.repeat}`);
  }
  writePrivateAtomic(path.join(runRoot, "measured-record-ready.json"), `${JSON.stringify({ schemaVersion: 1, previousLedger: ledgerBinding, record }, null, 2)}\n`);
  return record;
}

export function promoteMeasuredBenchmarkRecord({ runRoot, ledgerBinding, record, postSessionGuard }) {
  const file = path.join(runRoot, "measured-record-ready.json");
  const measured = readJson(file, "measured benchmark record");
  if (measured?.schemaVersion !== 1 || !measured.previousLedger || !measured.record) fail("Measured benchmark record WAL is malformed");
  assertBenchmarkLedgerBinding(measured.previousLedger, ledgerBinding, "measured-record previous ledger");
  if (JSON.stringify(measured.record) !== JSON.stringify(record)) fail("Measured benchmark record WAL differs from the in-memory outcome");
  if (postSessionGuard?.matched !== true || !String(postSessionGuard.stage ?? "").startsWith("after-session:")) {
    fail("Measured benchmark record cannot be promoted without a matched post-session execution guard");
  }
  writePrivateAtomic(path.join(runRoot, "pending-record.json"), `${JSON.stringify({ schemaVersion: 2, previousLedger: ledgerBinding, record, postSessionGuard }, null, 2)}\n`);
  fs.rmSync(file, { force: true });
  return record;
}

export function recoverPendingBenchmarkRecord({ runRoot, manifest, ledgerBinding, completedRuns, pending, measuredReady, fullOrder, suite }) {
  let binding = ledgerBinding;
  const runs = completedRuns;
  let pendingRecordSanitized = false;
  if (pending) {
    if (pending.schemaVersion !== 2 || !pending.previousLedger || !pending.record || pending.postSessionGuard?.matched !== true
      || !String(pending.postSessionGuard.stage ?? "").startsWith("after-session:")) fail("Benchmark pending record is missing its post-session execution guard receipt");
    const expectedIndex = pending.record.orderIndex - 1;
    if (!expectedBenchmarkRecord(pending.record, expectedIndex, fullOrder[expectedIndex], manifest.runId, suite, manifest.configurationDigest, manifest.verificationPlan?.identity)) {
      fail("Benchmark pending record does not match the frozen execution order");
    }
    if (binding.records === pending.previousLedger.records) {
      assertBenchmarkLedgerBinding(pending.previousLedger, binding, "pending-record previous ledger");
      omitInvalidTimingDiagnostics(pending.record);
      pendingRecordSanitized = true;
      binding = appendBenchmarkLedger(path.join(runRoot, "runs.jsonl"), pending.record, binding);
      runs.push(pending.record);
    } else if (binding.records === pending.previousLedger.records + 1) {
      if (manifest.ledger.records === pending.previousLedger.records) {
        assertBenchmarkLedgerBinding(pending.previousLedger, manifest.ledger, "pending-record manifest checkpoint");
      } else {
        assertBenchmarkLedgerBinding(manifest.ledger, binding, "pending-record committed ledger");
      }
      if (JSON.stringify(runs.at(-1)) !== JSON.stringify(pending.record)) fail("Benchmark pending record differs from the durable ledger suffix");
    } else fail("Benchmark pending record is not adjacent to the manifest ledger checkpoint");
    manifest.ledger = binding;
    manifest.recoveredProviderAttempts = (manifest.recoveredProviderAttempts ?? [])
      .filter((attempt) => key(attempt) !== key(pending.record));
    writeBenchmarkRunManifest(runRoot, manifest);
    fs.rmSync(path.join(runRoot, "pending-record.json"), { force: true });
  }
  if (measuredReady) {
    if (measuredReady.schemaVersion !== 1 || !measuredReady.previousLedger || !measuredReady.record) fail("Measured benchmark record WAL is malformed");
    const expectedIndex = measuredReady.record.orderIndex - 1;
    if (!expectedBenchmarkRecord(measuredReady.record, expectedIndex, fullOrder[expectedIndex], manifest.runId, suite, manifest.configurationDigest, manifest.verificationPlan?.identity)) {
      fail("Measured benchmark record WAL does not match the frozen execution order");
    }
    if (pending) {
      if (pendingRecordSanitized) omitInvalidTimingDiagnostics(measuredReady.record);
      assertBenchmarkLedgerBinding(measuredReady.previousLedger, pending.previousLedger, "measured/pending previous ledger");
      if (JSON.stringify(measuredReady.record) !== JSON.stringify(pending.record)) fail("Measured and post-guard pending records differ");
    } else {
      assertBenchmarkLedgerBinding(measuredReady.previousLedger, binding, "unpromoted measured-record ledger");
      persistUnacceptedBenchmarkAttempt({
        runRoot, manifest, record: measuredReady.record,
        reason: "measured-record-ready-without-post-session-guard-receipt"
      });
    }
    fs.rmSync(path.join(runRoot, "measured-record-ready.json"), { force: true });
  }
  const completedKeys = validateBenchmarkLedgerPrefix(
    runs,
    fullOrder,
    (record, index, expected) => expectedBenchmarkRecord(record, index, expected, manifest.runId, suite, manifest.configurationDigest, manifest.verificationPlan?.identity)
  );
  return { ledgerBinding: binding, completedRuns: runs, completedKeys, recoveredPending: Boolean(pending) };
}

function retainedMarker(workspaceRoot, attempt) {
  hardenPrivateRetentionRoot(workspaceRoot);
  writePrivateAtomic(retainedWorkspaceMarker(workspaceRoot), `${JSON.stringify({
    schemaVersion: 1,
    retainedAt: new Date().toISOString(),
    reason: "orphaned-provider-attempt-recovered-after-process-exit",
    scenarioId: attempt.scenarioId,
    surface: attempt.surface,
    repeat: attempt.repeat,
    infrastructureAttempt: attempt.infrastructureAttempt
  }, null, 2)}\n`);
}

export function recoverOrphanedBenchmarkAttempts({ runRoot, manifest, fullOrder, completedKeys }) {
  const workspaces = path.join(runRoot, "workspaces");
  const attemptsByKey = new Map();
  const persisted = Array.isArray(manifest.recoveredProviderAttempts) ? manifest.recoveredProviderAttempts : [];
  const seenAttempts = new Map();
  for (const attempt of persisted) {
    const expected = fullOrder[Number(attempt?.orderIndex) - 1];
    const valid = typeof attempt?.attemptId === "string" && attempt.attemptId.length > 0
      && Number.isInteger(attempt?.attempt) && attempt.attempt > 0
      && attempt.scenarioId === expected?.scenario?.id
      && attempt.surface === expected?.surface
      && attempt.repeat === expected?.repeat;
    if (!valid) fail("Persisted recovered provider attempt is malformed or foreign");
    const runKey = key(attempt);
    if (completedKeys.has(runKey)) continue;
    const attemptKey = `${runKey}\0${attempt.attempt}`;
    if (seenAttempts.has(attemptKey)) fail("Manifest contains duplicate recovered provider attempts");
    seenAttempts.set(attemptKey, attempt);
  }
  if (!fs.existsSync(workspaces)) {
    for (const attempt of seenAttempts.values()) {
      const values = attemptsByKey.get(key(attempt)) ?? [];
      values.push(attempt);
      attemptsByKey.set(key(attempt), values);
    }
    return attemptsByKey;
  }
  const newlyRecovered = [];
  const completedInflight = [];
  for (const name of fs.readdirSync(workspaces).sort()) {
    const workspaceRoot = path.join(workspaces, name);
    const inflightPath = path.join(workspaceRoot, "inflight.json");
    if (!fs.existsSync(inflightPath)) continue;
    const attempt = readJson(inflightPath, "orphaned benchmark attempt");
    const expected = fullOrder[Number(attempt?.orderIndex) - 1];
    const valid = attempt?.schemaVersion === 1
      && attempt.runId === manifest.runId
      && typeof attempt.attemptId === "string" && attempt.attemptId.length > 0
      && Number.isInteger(attempt.orderIndex) && attempt.orderIndex > 0
      && Number.isInteger(attempt.infrastructureAttempt) && attempt.infrastructureAttempt > 0
      && ["provider-may-start", "provider-returned"].includes(attempt.stage)
      && attempt.scenarioId === expected?.scenario?.id
      && attempt.surface === expected?.surface
      && attempt.repeat === expected?.repeat;
    if (!valid) fail(`Orphaned benchmark attempt is malformed or foreign: ${inflightPath}`);
    const runKey = key(attempt);
    const attemptKey = `${runKey}\0${attempt.infrastructureAttempt}`;
    if (completedKeys.has(runKey)) {
      completedInflight.push(inflightPath);
      continue;
    }
    const recovered = {
      schemaVersion: 1,
      runId: manifest.runId,
      attemptId: attempt.attemptId,
      orderIndex: attempt.orderIndex,
      scenarioId: attempt.scenarioId,
      surface: attempt.surface,
      repeat: attempt.repeat,
      attempt: attempt.infrastructureAttempt,
      failure: attempt.stage === "provider-returned" && typeof attempt.infrastructureFailure === "string"
        ? attempt.infrastructureFailure
        : "orphaned-provider-attempt-after-process-exit",
      class: attempt.stage === "provider-returned" && typeof attempt.infrastructureClass === "string"
        ? attempt.infrastructureClass
        : "infrastructure",
      retryable: attempt.stage === "provider-returned" && attempt.infrastructureRetryable === true,
      usage: attempt.stage === "provider-returned" ? attempt.usage : undefined,
      usageStatus: attempt.stage === "provider-returned" && exactUsage(attempt.usage, attempt.usageStatus ?? "measured-but-unaccepted")
        ? (attempt.usageStatus ?? "measured-but-unaccepted")
        : "unknown-after-provider-start",
      durationSeconds: Number.isFinite(attempt.durationSeconds) && attempt.durationSeconds >= 0
        ? attempt.durationSeconds
        : null,
      recoveredFromInFlight: true
    };
    const prior = seenAttempts.get(attemptKey);
    if (prior?.attemptId && prior.attemptId !== recovered.attemptId) fail(`Recovered provider attempt conflicts with its persisted manifest entry: ${name}`);
    if (!prior) {
      seenAttempts.set(attemptKey, recovered);
      newlyRecovered.push({ recovered, workspaceRoot, inflightPath, attempt });
    } else {
      const merged = {
        ...prior,
        ...(exactUsage(recovered.usage, recovered.usageStatus) && !exactUsage(prior.usage, prior.usageStatus)
          ? { usage: recovered.usage, usageStatus: recovered.usageStatus }
          : {}),
        attemptId: recovered.attemptId
      };
      seenAttempts.set(attemptKey, merged);
      newlyRecovered.push({ recovered: merged, workspaceRoot, inflightPath, attempt });
    }
  }
  const retainedAttempts = [...seenAttempts.values()];
  if (retainedAttempts.length > 0) {
    if (retainedAttempts.some((attempt) => !exactUsage(attempt.usage, attempt.usageStatus))) {
      manifest.tokenClaimsUnavailableReason ??= "one-or-more-provider-attempts-were-recovered-after-process-exit";
    }
    manifest.recoveredProviderAttempts = retainedAttempts;
    manifest.recoveredInFlightAttempts = retainedAttempts.length;
    writeBenchmarkRunManifest(runRoot, manifest);
  }
  for (const { workspaceRoot, inflightPath, attempt } of newlyRecovered) {
    retainedMarker(workspaceRoot, attempt);
    fs.rmSync(inflightPath, { force: true });
  }
  for (const inflightPath of completedInflight) fs.rmSync(inflightPath, { force: true });
  for (const attempt of retainedAttempts) {
    const values = attemptsByKey.get(key(attempt)) ?? [];
    values.push(attempt);
    attemptsByKey.set(key(attempt), values);
  }
  return attemptsByKey;
}

const observationProtocol = "runtime-observation-v2";
const observationHash = value => crypto.createHash("sha256").update(value).digest("hex");
const observationEqual = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function observationRequire(value, reason) {
  if (value) return;
  const error = new Error(`Benchmark observation ${reason}`);
  error.code = "BENCHMARK_OBSERVATION_INVALID";
  error.exitCode = 1;
  throw error;
}
function observationObject(value, fields, reason) {
  observationRequire(value && typeof value === "object" && !Array.isArray(value)
    && observationEqual(Object.keys(value).sort(), [...fields].sort()), reason);
}
function observationText(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !value.includes("\0");
}
function observationPrivateFile(file) {
  const stat = fs.lstatSync(file);
  observationRequire(fs.realpathSync(file) === file && stat.isFile() && stat.nlink === 1
    && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600, "private-file-invalid");
  return stat;
}
function observationResumable(state) {
  return state.pending === null && state.runtimes.every(runtime => runtime.retired && !runtime.operationRef
    && (!runtime.wireCheckpoint || runtime.wireCheckpoint.operationActive === false && runtime.wireCheckpoint.inputAccepted === false
      && runtime.wireCheckpoint.pending === false && runtime.wireCheckpoint.fault === null
      && (runtime.wireCheckpoint.task === null || runtime.wireCheckpoint.task.phase === "terminal"
        && ["completed", "blocked", "partial", "failed"].includes(runtime.wireCheckpoint.task.outcome)))
    && runtime.callbacks.every(callback => callback.stage === "outer-rejected" || callback.stage === "settled"));
}
function advanceObservationRuntimes(state, event, requests) {
  observationRequire(event && typeof event === "object" && observationText(event.runtimeInstanceRef), "event-identity-invalid");
  const runtimes = structuredClone(state.runtimes);
  let runtime = runtimes.find(row => row.runtimeInstanceRef === event.runtimeInstanceRef);
  if (event.kind === "generation-created") {
    observationRequire(Number.isSafeInteger(event.runtimeGeneration) && event.runtimeGeneration === (runtime?.runtimeGeneration ?? 0) + 1
      && observationText(event.sessionId) && path.isAbsolute(event.cwd), "generation-reservation-invalid");
    observationRequire(!runtime?.operationRef && (!runtime || observationResumable({ pending: null, runtimes: [runtime] })), "generation-has-unresolved-attempt");
    observationRequire(!runtimes.some(row => row !== runtime && row.sessionId === event.sessionId
      && (!row.retired || !observationResumable({ pending: null, runtimes: [row] }))), "session-generation-still-owned");
    const next = { runtimeInstanceRef: event.runtimeInstanceRef, runtimeGeneration: event.runtimeGeneration,
      sessionId: event.sessionId, cwd: event.cwd, ready: false, retired: false, operationRef: null,
      callbackSequence: runtime?.sessionId === event.sessionId ? runtime.callbackSequence : 0,
      operations: runtime?.operations ?? [], callbacks: runtime?.callbacks ?? [] };
    if (runtime) runtimes[runtimes.indexOf(runtime)] = next;
    else runtimes.push(next);
    return runtimes;
  }
  observationRequire(runtime, "runtime-unreserved");
  if (event.kind === "runtime-retired") {
    observationRequire(event.generation === runtime.runtimeGeneration, "retired-generation-mismatch");
    runtime.retired = true; runtime.ready = false;
    if (runtime.operationRef) runtime.operations.find(row => row.operationRef === runtime.operationRef).ended = true;
    runtime.operationRef = null;
    return runtimes;
  }
  observationRequire(event.runtimeGeneration === runtime.runtimeGeneration
    && (!runtime.retired || ["wire-checkpoint", "outer-rejected"].includes(event.kind)), "generation-mismatch");
  if (event.kind === "generation-bound") {
    observationRequire(!runtime.ready, "generation-already-bound"); runtime.ready = true;
  } else if (event.kind === "operation-accepted") {
    const request = requests.find(row => row.messageRequestId === event.messageRequestId);
    observationRequire(runtime.ready && !runtime.operationRef && observationText(event.operationRef) && request
      && request.operatorInputSha256 === event.operatorInputSha256, "operation-unreserved");
    observationRequire(runtimes.every(row => row.callbacks.every(callback => ["outer-rejected", "settled"].includes(callback.stage))), "prior-callback-unresolved");
    observationRequire(!runtimes.some(row => row.operations.some(operation => operation.operationRef === event.operationRef
      || operation.messageRequestId === event.messageRequestId)), "operation-reused");
    runtime.operations.push({ operationRef: event.operationRef, messageRequestId: event.messageRequestId, ended: false });
    runtime.operationRef = event.operationRef;
  } else if (event.kind === "operation-ended") {
    observationRequire(runtime.operationRef === event.operationRef, "operation-end-mismatch");
    runtime.operations.find(row => row.operationRef === event.operationRef).ended = true;
    runtime.operationRef = null;
  } else if (event.kind === "host-origin") {
    observationRequire(runtime.operationRef || event.event?.type === "task-cached" && event.event.taskRunId === null, "origin-without-reservation");
  } else if (event.kind === "wire-checkpoint") {
    const checkpoint = event.checkpoint;
    observationObject(checkpoint, ["protocol", "schemaVersion", "manifestDigest", "workingDirectory", "sessionId", "runtimeInstanceRef",
      "sequence", "previousReceiptHash", "task", "events", "operationActive", "inputAccepted", "pending", "fault"], "wire-checkpoint-shape");
    observationRequire(checkpoint.protocol === "host-wire-checkpoint-v1" && checkpoint.schemaVersion === 1
      && checkpoint.sessionId === runtime.sessionId && checkpoint.runtimeInstanceRef === runtime.runtimeInstanceRef
      && checkpoint.workingDirectory === runtime.cwd && /^[a-f0-9]{64}$/.test(checkpoint.manifestDigest)
      && Number.isSafeInteger(checkpoint.sequence) && checkpoint.sequence >= 0
      && (checkpoint.previousReceiptHash === null || /^[a-f0-9]{64}$/.test(checkpoint.previousReceiptHash))
      && Array.isArray(checkpoint.events) && ["operationActive", "inputAccepted", "pending"].every(field => typeof checkpoint[field] === "boolean")
      && (checkpoint.fault === null || observationText(checkpoint.fault)), "wire-checkpoint-invalid");
    if (checkpoint.task !== null) {
      observationObject(checkpoint.task, ["taskId", "taskRunId", "phase", "sequence", "outcome", "stateDigest"], "wire-task-shape");
      observationRequire(["taskId", "taskRunId", "phase"].every(field => observationText(checkpoint.task[field]))
        && Number.isSafeInteger(checkpoint.task.sequence) && checkpoint.task.sequence >= 0
        && ["pending", "completed", "blocked", "partial", "failed"].includes(checkpoint.task.outcome)
        && /^[a-f0-9]{64}$/.test(checkpoint.task.stateDigest), "wire-task-invalid");
    }
    runtime.wireCheckpoint = structuredClone(checkpoint);
  } else if (event.kind === "outer-attempt") {
    observationRequire(runtime.ready && runtime.operationRef && Number.isSafeInteger(event.sequence)
      && event.sequence === runtime.callbackSequence + 1, "callback-reservation-invalid");
    runtime.callbackSequence = event.sequence;
    runtime.callbacks.push({ sequence: event.sequence, runtimeGeneration: event.runtimeGeneration,
      operationRef: runtime.operationRef, stage: "outer-attempt" });
  } else {
    observationRequire(["sdk-returned", "return-ready", "outer-rejected"].includes(event.kind), "event-kind-unsupported");
    const callback = runtime.callbacks.find(row => row.sequence === event.sequence && row.runtimeGeneration === event.runtimeGeneration);
    observationRequire(callback && (event.kind === "outer-rejected" && ["outer-attempt", "sdk-returned", "return-ready"].includes(callback.stage)
      || event.kind === "sdk-returned" && callback.stage === "outer-attempt"
      || event.kind === "return-ready" && callback.stage === "sdk-returned"), "callback-order-invalid");
    if (event.kind !== "outer-rejected") observationRequire(runtime.operationRef === callback.operationRef
      && event.operationRef === callback.operationRef, "callback-operation-mismatch");
    callback.stage = event.kind;
  }
  return runtimes;
}

/** Host-only parent capability. Private locked run custody, not journal JSON, supplies the restart anchor. */
export function createBenchmarkObservationCustody({ runRoot, manifest, identity, journalPath, publicKey, requests }) {
  const root = path.resolve(runRoot), journal = path.resolve(journalPath), manifestPath = path.join(root, "run-manifest.json");
  observationObject(identity, ["protocol", "runId", "attemptId", "armId", "candidateDigest", "configurationDigest", "keyId"], "identity-shape-invalid");
  identity = structuredClone(identity); requests = structuredClone(requests);
  observationRequire(identity.protocol === observationProtocol && ["runId", "attemptId", "armId"].every(field => observationText(identity[field]))
    && ["candidateDigest", "configurationDigest", "keyId"].every(field => /^[a-f0-9]{64}$/.test(identity[field])), "identity-invalid");
  observationRequire(Array.isArray(requests) && requests.length > 0 && requests.every(row => observationText(row.messageRequestId)
    && /^[a-f0-9]{64}$/.test(row.operatorInputSha256)) && new Set(requests.map(row => row.messageRequestId)).size === requests.length, "requests-invalid");
  const key = publicKey?.type === "public" ? publicKey : crypto.createPublicKey(publicKey);
  const publicKeyDer = key.export({ type: "spki", format: "der" });
  observationRequire(key.asymmetricKeyType === "ed25519" && observationHash(publicKeyDer) === identity.keyId, "key-mismatch");
  observationRequire(path.isAbsolute(runRoot) && path.isAbsolute(journalPath) && journal.startsWith(root + path.sep), "journal-location-invalid");
  const rootStat = fs.lstatSync(root), lockPath = path.join(root, ".benchmark-run.lock"), lockStat = observationPrivateFile(lockPath);
  const parentPath = path.dirname(journal), parentStat = fs.lstatSync(parentPath), initialJournal = observationPrivateFile(journal);
  observationRequire(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid === process.pid, "run-lock-not-owned");
  const identityDigest = observationHash(JSON.stringify(identity));
  let state, fault = null, token = null;
  const guard = () => {
    if (fault) throw fault;
    for (const [directory, prior] of [[root, rootStat], [parentPath, parentStat]]) {
      const stat = fs.lstatSync(directory);
      observationRequire(fs.realpathSync(directory) === directory && stat.isDirectory() && stat.uid === process.getuid()
        && (stat.mode & 0o777) === 0o700 && stat.dev === prior.dev && stat.ino === prior.ino, "custody-directory-changed");
    }
    const lock = observationPrivateFile(lockPath);
    observationRequire(lock.dev === lockStat.dev && lock.ino === lockStat.ino, "run-lock-changed");
  };
  const readManifest = () => {
    guard(); observationPrivateFile(manifestPath);
    const disk = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    observationRequire(disk.runId === identity.runId && disk.configurationDigest === identity.configurationDigest
      && disk.candidateProvenance?.contentDigest === identity.candidateDigest, "manifest-identity-mismatch");
    observationRequire(disk.observationCheckpoints === undefined || Array.isArray(disk.observationCheckpoints), "checkpoints-invalid");
    const matches = (disk.observationCheckpoints ?? []).filter(row => row.identity?.attemptId === identity.attemptId);
    observationRequire(matches.length <= 1 && (!state || observationEqual(matches[0], state)), "checkpoint-changed");
    return { disk, current: matches[0] };
  };
  const inspect = () => {
    guard(); const before = observationPrivateFile(journal);
    observationRequire(before.dev === initialJournal.dev && before.ino === initialJournal.ino && before.size <= 64 * 1024 * 1024, "journal-replaced-or-oversize");
    const inspection = inspectBenchmarkLedger(journal), after = observationPrivateFile(journal);
    observationRequire(before.dev === after.dev && before.ino === after.ino && before.size === after.size
      && inspection.raw.equals(Buffer.from(inspection.raw.toString("utf8"))), "journal-readback-invalid");
    guard(); return inspection;
  };
  const binding = inspection => ({ path: journal, sha256: observationHash(inspection.raw), bytes: inspection.binding.bytes,
    records: inspection.binding.records, ledger: inspection.binding });
  const commit = next => {
    const { disk } = readManifest();
    disk.observationCheckpoints = [...(disk.observationCheckpoints ?? []).filter(row => row.identity.attemptId !== identity.attemptId), next];
    writeBenchmarkRunManifest(root, disk); observationPrivateFile(manifestPath);
    observationRequire(observationEqual(JSON.parse(fs.readFileSync(manifestPath, "utf8")), disk), "checkpoint-readback-failed");
    state = structuredClone(next); manifest.observationCheckpoints = structuredClone(disk.observationCheckpoints);
  };
  const validateEnvelope = envelope => {
    observationObject(envelope, ["material", "signature"], "envelope-invalid");
    observationRequire(typeof envelope.material === "string" && Buffer.byteLength(envelope.material) <= 4 * 1024 * 1024
      && typeof envelope.signature === "string" && /^[A-Za-z0-9+/]{86}==$/.test(envelope.signature), "envelope-invalid");
    const material = JSON.parse(envelope.material);
    observationObject(material, ["protocol", "armId", "candidateDigest", "custodyIdentity", "sequence", "previousHash", "event"], "material-shape-invalid");
    observationRequire(JSON.stringify(material) === envelope.material && material.protocol === identity.protocol
      && material.armId === identity.armId && material.candidateDigest === identity.candidateDigest
      && material.custodyIdentity === identityDigest && material.sequence === state.sequence + 1
      && material.previousHash === state.previousHash, "envelope-binding-mismatch");
    observationRequire(crypto.verify(null, Buffer.from(envelope.material), key, Buffer.from(envelope.signature, "base64")), "signature-invalid");
    if (material.event.cwd) observationRequire(!journal.startsWith(path.resolve(material.event.cwd) + path.sep), "journal-inside-workspace");
    return material;
  };
  const reconcile = () => {
    readManifest(); const inspection = inspect();
    const checked = benchmarkLedgerCheckpoint(state.journalBinding.ledger, inspection, "observation journal");
    observationRequire(state.journalBinding.path === journal && state.journalBinding.bytes === state.journalBinding.ledger.bytes
      && state.journalBinding.records === state.sequence && state.journalBinding.records === state.journalBinding.ledger.records
      && observationHash(inspection.raw.subarray(0, state.journalBinding.bytes)) === state.journalBinding.sha256
      && state.previousHash === (state.sequence ? observationHash(JSON.stringify(inspection.records[state.sequence - 1])) : null), "checkpoint-prefix-mismatch");
    if (!checked.recovered) return;
    observationRequire(state.pending, "unreserved-journal-append");
    const envelope = inspection.records.at(-1), line = inspection.raw.subarray(state.journalBinding.bytes);
    observationRequire(observationHash(line) === state.pending.envelopeSha256
      && line.equals(Buffer.from(JSON.stringify(envelope) + "\n")), "reserved-append-mismatch");
    const material = validateEnvelope(envelope), runtimes = advanceObservationRuntimes(state, material.event, requests);
    commit({ ...state, journalBinding: binding(inspection), sequence: material.sequence,
      previousHash: observationHash(JSON.stringify(envelope)), pending: null, runtimes });
  };
  const invoke = action => {
    try { guard(); return action(); } catch (error) { fault = error; throw error; }
  };
  const { current } = readManifest();
  if (current) {
    observationRequire(current.schemaVersion === 1 && observationEqual(current.identity, identity) && observationEqual(current.requests, requests)
      && current.publicKey === publicKeyDer.toString("base64") && current.identityDigest === identityDigest
      && Array.isArray(current.runtimes) && (current.pending === null || typeof current.pending === "object"), "checkpoint-identity-mismatch");
    state = structuredClone(current);
    observationRequire(state.journalIdentity.dev === initialJournal.dev && state.journalIdentity.ino === initialJournal.ino
      && state.journalIdentity.parentDev === parentStat.dev && state.journalIdentity.parentIno === parentStat.ino, "journal-custody-mismatch");
    reconcile();
  } else {
    const inspection = inspect(); observationRequire(inspection.raw.length === 0, "nonempty-journal-without-checkpoint");
    commit({ schemaVersion: 1, identity, identityDigest, publicKey: publicKeyDer.toString("base64"), requests,
      journalBinding: binding(inspection), journalIdentity: { dev: initialJournal.dev, ino: initialJournal.ino,
        parentDev: parentStat.dev, parentIno: parentStat.ino }, sequence: 0, previousHash: null, pending: null, runtimes: [] });
  }
  const observer = Object.freeze({
    readCheckpoint: () => invoke(() => { reconcile(); return { ...structuredClone(state), resumable: observationResumable(state) }; }),
    reserve: envelope => invoke(() => {
      reconcile(); observationRequire(!state.pending && token === null, "reservation-pending");
      const material = validateEnvelope(envelope); advanceObservationRuntimes(state, material.event, requests);
      commit({ ...state, pending: { envelopeSha256: observationHash(JSON.stringify(envelope) + "\n"), sequence: material.sequence } });
      token = Object.freeze({}); return token;
    }),
    acknowledge: reservation => invoke(() => {
      observationRequire(token && reservation === token && state.pending, "reservation-token-invalid");
      reconcile(); observationRequire(!state.pending, "reserved-append-missing"); token = null;
    })
  });
  return Object.freeze({ observer,
    settleOperation: outcome => invoke(() => {
      reconcile(); observationRequire(!state.pending && outcome.attemptId === identity.attemptId
        && exactUsage(outcome.usage, outcome.usageStatus), "operation-outcome-unproven");
      const runtimes = structuredClone(state.runtimes), runtime = runtimes.find(row => row.runtimeInstanceRef === outcome.runtimeInstanceRef);
      const operation = runtime?.operations.find(row => row.operationRef === outcome.operationRef && row.messageRequestId === outcome.messageRequestId);
      const callbacks = runtime?.callbacks.filter(row => row.operationRef === outcome.operationRef);
      observationRequire(operation?.ended && callbacks?.some(row => row.stage === "return-ready")
        && callbacks.every(row => ["return-ready", "outer-rejected"].includes(row.stage)), "operation-outcome-mismatch");
      for (const callback of callbacks) callback.stage = "settled";
      operation.outcome = { usage: structuredClone(outcome.usage), usageStatus: outcome.usageStatus };
      commit({ ...state, runtimes });
    })
  });
}

export function recoverBenchmarkObservationCheckpoints({ runRoot, manifest }) {
  if (manifest.observationCheckpoints === undefined) return [];
  observationRequire(Array.isArray(manifest.observationCheckpoints), "checkpoints-invalid");
  return [...manifest.observationCheckpoints].map(checkpoint => {
    const custody = createBenchmarkObservationCustody({ runRoot, manifest, identity: checkpoint.identity,
      journalPath: checkpoint.journalBinding.path, publicKey: { key: Buffer.from(checkpoint.publicKey, "base64"), type: "spki", format: "der" },
      requests: checkpoint.requests });
    const recovered = custody.observer.readCheckpoint();
    observationRequire(recovered.resumable, "resume-has-unresolved-attempt");
    return recovered;
  });
}
