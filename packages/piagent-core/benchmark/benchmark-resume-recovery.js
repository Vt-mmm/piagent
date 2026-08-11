import fs from "node:fs";
import path from "node:path";

import { hardenPrivateRetentionRoot, retainedWorkspaceMarker, writeBenchmarkRunManifest, writePrivateAtomic } from "./benchmark-forensics.js";
import { appendBenchmarkLedger, assertBenchmarkLedgerBinding, validateBenchmarkLedgerPrefix } from "./benchmark-ledger.js";
import { expectedBenchmarkRecord, pairedBenchmarkVariantMatched } from "./benchmark-record-validation.js";

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
  return usageStatus !== "unknown-after-provider-start"
    && Number.isInteger(usage?.sessions) && usage.sessions > 0
    && ["fresh", "input", "output", "cacheRead", "cacheWrite", "reasoning", "total"].every((field) => nonnegative(usage?.[field]))
    && usage.fresh === usage.input + usage.output
    && usage.total === usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
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
  record.infrastructureAttempts = record.infrastructureAttempt ?? 1;
  record.infrastructureRetries = Math.max(0, record.infrastructureAttempts - 1);
  record.infrastructureFailures = infrastructureFailures;
  if (!expectedBenchmarkRecord(record, index, expected, runId, suite, configurationDigest) || !pairedBenchmarkVariantMatched(record, runs)) {
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
  if (pending) {
    if (pending.schemaVersion !== 2 || !pending.previousLedger || !pending.record || pending.postSessionGuard?.matched !== true
      || !String(pending.postSessionGuard.stage ?? "").startsWith("after-session:")) fail("Benchmark pending record is missing its post-session execution guard receipt");
    const expectedIndex = pending.record.orderIndex - 1;
    if (!expectedBenchmarkRecord(pending.record, expectedIndex, fullOrder[expectedIndex], manifest.runId, suite, manifest.configurationDigest)) {
      fail("Benchmark pending record does not match the frozen execution order");
    }
    if (binding.records === pending.previousLedger.records) {
      assertBenchmarkLedgerBinding(pending.previousLedger, binding, "pending-record previous ledger");
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
    if (!expectedBenchmarkRecord(measuredReady.record, expectedIndex, fullOrder[expectedIndex], manifest.runId, suite, manifest.configurationDigest)) {
      fail("Measured benchmark record WAL does not match the frozen execution order");
    }
    if (pending) {
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
    (record, index, expected) => expectedBenchmarkRecord(record, index, expected, manifest.runId, suite, manifest.configurationDigest)
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
      failure: "orphaned-provider-attempt-after-process-exit",
      class: "infrastructure",
      usage: attempt.stage === "provider-returned" ? attempt.usage : undefined,
      usageStatus: attempt.stage === "provider-returned" && exactUsage(attempt.usage, "measured-but-unaccepted") ? "measured-but-unaccepted" : "unknown-after-provider-start",
      durationSeconds: 0,
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
