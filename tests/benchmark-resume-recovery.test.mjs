import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { expectedBenchmarkRecord } from "../packages/piagent-core/benchmark/benchmark-record-validation.js";
import { emptyBenchmarkLedgerBinding, inspectBenchmarkLedger } from "../packages/piagent-core/benchmark/benchmark-ledger.js";
import {
  persistUnacceptedBenchmarkAttempt,
  promoteMeasuredBenchmarkRecord,
  recoverOrphanedBenchmarkAttempts,
  recoverPendingBenchmarkRecord,
  stageMeasuredBenchmarkRecord
} from "../packages/piagent-core/benchmark/benchmark-resume-recovery.js";
import { workingTreeSnapshot } from "../packages/piagent-core/extensions/task-state.js";
import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/working-tree-digest.js";
import * as observationRecovery from "../packages/piagent-core/benchmark/benchmark-resume-recovery.js";
import { acquireBenchmarkRunLock } from "../packages/piagent-core/benchmark/benchmark-run-lock.js";
import { writeBenchmarkRunManifest } from "../packages/piagent-core/benchmark/benchmark-forensics.js";
import { loadResumeState } from "../scripts/benchmark-runner-support.mjs";

const hash = "a".repeat(64);

function observationFixture(t) {
  const runRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-observation-custody-")));
  fs.chmodSync(runRoot, 0o700);
  let release = acquireBenchmarkRunLock(runRoot, "public-run");
  t.after(() => { release(); fs.rmSync(runRoot, { recursive: true, force: true }); });
  const keys = crypto.generateKeyPairSync("ed25519"), journalPath = path.join(runRoot, "observer.jsonl");
  fs.writeFileSync(journalPath, "", { mode: 0o600 });
  const digest = value => crypto.createHash("sha256").update(value).digest("hex");
  const identity = { protocol: "runtime-observation-v2", runId: "public-run", attemptId: "public-attempt", armId: "public-arm",
    candidateDigest: hash, configurationDigest: "b".repeat(64), keyId: digest(keys.publicKey.export({ type: "spki", format: "der" })) };
  const manifest = { schemaVersion: 1, runId: identity.runId, configurationDigest: identity.configurationDigest,
    candidateProvenance: { contentDigest: identity.candidateDigest }, ledger: emptyBenchmarkLedgerBinding() };
  writeBenchmarkRunManifest(runRoot, manifest);
  const options = { runRoot, manifest, identity, journalPath, publicKey: keys.publicKey,
    requests: [{ messageRequestId: "request", operatorInputSha256: hash }] };
  const open = () => observationRecovery.createBenchmarkObservationCustody(options);
  const envelope = (checkpoint, event, changes = {}) => {
    const material = JSON.stringify({ protocol: identity.protocol, armId: identity.armId, candidateDigest: identity.candidateDigest,
      custodyIdentity: checkpoint.identityDigest, sequence: checkpoint.sequence + 1, previousHash: checkpoint.previousHash, event, ...changes });
    return { material, signature: crypto.sign(null, Buffer.from(material), keys.privateKey).toString("base64") };
  };
  const append = (custody, event) => {
    const row = envelope(custody.observer.readCheckpoint(), event), token = custody.observer.reserve(row);
    const fd = fs.openSync(journalPath, fs.constants.O_WRONLY | fs.constants.O_APPEND);
    try { fs.writeSync(fd, JSON.stringify(row) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    custody.observer.acknowledge(token);
    return row;
  };
  return { runRoot, manifest, journalPath, identity, keys, digest, options, open, envelope, append,
    release: () => release(), relock: () => { release = acquireBenchmarkRunLock(runRoot, "public-run"); } };
}

const generationEvent = (overrides = {}) => ({ kind: "generation-created", runtimeInstanceRef: "runtime", runtimeGeneration: 1,
  sessionId: "session", cwd: "/public-workspace", ...overrides });

test("observation custody reserves a signed append before child write and resumes the exact tail", t => {
  const f = observationFixture(t), custody = f.open();
  const empty = custody.observer.readCheckpoint();
  assert.equal(empty.sequence, 0); assert.equal(empty.resumable, true);
  const row = f.envelope(empty, generationEvent()), token = custody.observer.reserve(row);
  const stored = JSON.parse(fs.readFileSync(path.join(f.runRoot, "run-manifest.json")));
  assert.equal(stored.observationCheckpoints[0].pending.envelopeSha256, f.digest(JSON.stringify(row) + "\n"));
  assert.equal(fs.readFileSync(f.journalPath, "utf8"), "", "reservation is durable before child journal write");
  fs.appendFileSync(f.journalPath, JSON.stringify(row) + "\n"); custody.observer.acknowledge(token);
  const checkpoint = custody.observer.readCheckpoint();
  assert.equal(checkpoint.sequence, 1); assert.equal(checkpoint.previousHash, f.digest(JSON.stringify(row)));
  assert.equal(checkpoint.journalBinding.sha256, f.digest(fs.readFileSync(f.journalPath)));
  const reopened = f.open().observer.readCheckpoint();
  assert.deepEqual(reopened, checkpoint); assert.equal(reopened.runtimes[0].runtimeGeneration, 1);
});

function observationOperation(f, custody) {
  f.append(custody, generationEvent());
  f.append(custody, { kind: "generation-bound", runtimeInstanceRef: "runtime", runtimeGeneration: 1 });
  f.append(custody, { kind: "operation-accepted", runtimeInstanceRef: "runtime", runtimeGeneration: 1,
    operationRef: "operation", messageRequestId: "request", operatorInputSha256: hash });
}
function observationCallback(kind, fields = {}) {
  return { kind, runtimeInstanceRef: "runtime", runtimeGeneration: 1, sequence: 1, operationRef: "operation", ...fields };
}
const observationRetire = () => ({ kind: "runtime-retired", runtimeInstanceRef: "runtime", generation: 1, reason: "test-closed" });

for (const [name, changes] of [
  ["foreign custody", { custodyIdentity: "c".repeat(64) }],
  ["wrong sequence", { sequence: 2 }],
  ["wrong predecessor", { previousHash: "d".repeat(64) }],
  ["wrong candidate", { candidateDigest: "e".repeat(64) }]
]) test(`observation custody rejects ${name} before reserving`, t => {
  const f = observationFixture(t), custody = f.open(), row = f.envelope(custody.observer.readCheckpoint(), generationEvent(), changes);
  assert.throws(() => custody.observer.reserve(row), /envelope-binding-mismatch/);
  assert.equal(fs.readFileSync(f.journalPath, "utf8"), "");
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.runRoot, "run-manifest.json"))).observationCheckpoints[0].pending, null);
});

test("observation custody rejects forged signature and stale opaque acknowledgement", t => {
  const f = observationFixture(t), custody = f.open(), row = f.envelope(custody.observer.readCheckpoint(), generationEvent());
  row.signature = Buffer.alloc(64).toString("base64");
  assert.throws(() => custody.observer.reserve(row), /signature-invalid/);
  const fresh = f.open(), valid = f.envelope(fresh.observer.readCheckpoint(), generationEvent());
  fresh.observer.reserve(valid);
  assert.throws(() => fresh.observer.acknowledge({}), /reservation-token-invalid/);
  assert.equal(f.open().observer.readCheckpoint().resumable, false);
});

test("observation custody missing append remains reserved across reopen and cannot dispatch again", t => {
  const f = observationFixture(t), custody = f.open(), row = f.envelope(custody.observer.readCheckpoint(), generationEvent());
  const token = custody.observer.reserve(row);
  assert.throws(() => custody.observer.acknowledge(token), /reserved-append-missing/);
  const reopened = f.open(), checkpoint = reopened.observer.readCheckpoint();
  assert.equal(checkpoint.sequence, 0); assert.ok(checkpoint.pending); assert.equal(checkpoint.resumable, false);
  assert.throws(() => reopened.observer.reserve(row), /reservation-pending/);
});

test("observation custody recovers only the reserved adjacent append without rewriting journal bytes", t => {
  const f = observationFixture(t), custody = f.open(), row = f.envelope(custody.observer.readCheckpoint(), generationEvent());
  custody.observer.reserve(row); fs.appendFileSync(f.journalPath, JSON.stringify(row) + "\n");
  const bytes = fs.readFileSync(f.journalPath), reopened = f.open().observer.readCheckpoint();
  assert.equal(reopened.sequence, 1); assert.equal(reopened.pending, null);
  assert.deepEqual(fs.readFileSync(f.journalPath), bytes);
  assert.equal(reopened.resumable, false, "unfinished generation is not a clean restart");
});

test("observation custody rejects valid signed prefix rollback and unreserved append", t => {
  const f = observationFixture(t), custody = f.open(); f.append(custody, generationEvent());
  fs.writeFileSync(f.journalPath, "");
  assert.throws(f.open, /shorter than its committed manifest checkpoint/);
  const g = observationFixture(t), other = g.open(), row = g.envelope(other.observer.readCheckpoint(), generationEvent());
  fs.appendFileSync(g.journalPath, JSON.stringify(row) + "\n");
  assert.throws(g.open, /unreserved-journal-append/);
});

test("observation custody rejects a second suffix and a reserved row substitution", t => {
  const f = observationFixture(t), custody = f.open(), row = f.envelope(custody.observer.readCheckpoint(), generationEvent());
  custody.observer.reserve(row); fs.appendFileSync(f.journalPath, JSON.stringify(row) + "\n" + JSON.stringify(row) + "\n");
  assert.throws(f.open, /single recoverable append/);
  const g = observationFixture(t), other = g.open(), planned = g.envelope(other.observer.readCheckpoint(), generationEvent());
  other.observer.reserve(planned);
  fs.appendFileSync(g.journalPath, JSON.stringify(g.envelope(other.observer.readCheckpoint(), generationEvent({ sessionId: "other" }))) + "\n");
  assert.throws(g.open, /reserved-append-mismatch/);
});

test("observation custody detects lock loss, parent alias and journal inode replacement", t => {
  const f = observationFixture(t), custody = f.open();
  const lock = path.join(f.runRoot, ".benchmark-run.lock");
  fs.renameSync(lock, `${lock}.displaced`);
  f.release(); f.relock();
  assert.throws(() => custody.observer.readCheckpoint(), /run-lock-changed/);
  const g = observationFixture(t); g.open(); const bytes = fs.readFileSync(g.journalPath);
  fs.renameSync(g.journalPath, g.journalPath + ".old"); fs.writeFileSync(g.journalPath, bytes, { mode: 0o600 });
  assert.throws(g.open, /journal-custody-mismatch/);
  const h = observationFixture(t), active = h.open(), moved = h.runRoot + "-moved";
  fs.renameSync(h.runRoot, moved); fs.symlinkSync(moved, h.runRoot);
  try { assert.throws(() => active.observer.readCheckpoint(), /custody-directory-changed/); }
  finally { fs.unlinkSync(h.runRoot); fs.renameSync(moved, h.runRoot); }
});

test("observation custody copied checkpoint does not confer authority and wrong key cannot resume", t => {
  const f = observationFixture(t), custody = f.open(), checkpoint = custody.observer.readCheckpoint();
  checkpoint.identity.armId = "forged"; checkpoint.journalBinding.records = 20;
  assert.equal(custody.observer.readCheckpoint().identity.armId, "public-arm");
  assert.equal(custody.observer.readCheckpoint().sequence, 0);
  const wrong = crypto.generateKeyPairSync("ed25519");
  assert.throws(() => observationRecovery.createBenchmarkObservationCustody({ ...f.options, publicKey: wrong.publicKey }), /key-mismatch/);
});

test("observation custody does not settle a returned callback through operation end or retirement", t => {
  const f = observationFixture(t), custody = f.open(); observationOperation(f, custody);
  for (const kind of ["outer-attempt", "sdk-returned", "return-ready"]) f.append(custody, observationCallback(kind));
  f.append(custody, { kind: "operation-ended", runtimeInstanceRef: "runtime", runtimeGeneration: 1, operationRef: "operation", reason: "completed" });
  f.append(custody, observationRetire());
  assert.equal(f.open().observer.readCheckpoint().resumable, false);
  assert.equal(Object.hasOwn(custody.observer, "settleOperation"), false, "child cannot access parent settlement");
  const outcome = { attemptId: f.identity.attemptId, runtimeInstanceRef: "runtime", operationRef: "operation", messageRequestId: "request",
    usageStatus: "measured", usage: record().usage };
  assert.throws(() => custody.settleOperation({ ...outcome, usageStatus: "unknown-after-provider-start" }), /operation-outcome-unproven/);
  const reopened = f.open(); reopened.settleOperation(outcome);
  assert.equal(f.open().observer.readCheckpoint().resumable, true);
  assert.deepEqual(f.manifest.observationCheckpoints[0].runtimes[0].operations[0].outcome.usage, record().usage);
});

test("observation custody records late rejection after retirement without fabricating callback return", t => {
  const f = observationFixture(t), custody = f.open(); observationOperation(f, custody);
  f.append(custody, observationCallback("outer-attempt")); f.append(custody, observationRetire());
  assert.equal(custody.observer.readCheckpoint().resumable, false);
  f.append(custody, observationCallback("outer-rejected"));
  assert.equal(f.open().observer.readCheckpoint().resumable, true);
});

test("observation custody clean wire metadata cannot close an outstanding callback", t => {
  const f = observationFixture(t), custody = f.open(); observationOperation(f, custody);
  f.append(custody, observationCallback("outer-attempt")); f.append(custody, observationRetire());
  const checkpoint = { protocol: "host-wire-checkpoint-v1", schemaVersion: 1, manifestDigest: hash,
    workingDirectory: "/public-workspace", sessionId: "session", runtimeInstanceRef: "runtime", sequence: 0,
    previousReceiptHash: null, task: null, events: [{ type: "operation-closed" }], operationActive: false,
    inputAccepted: false, pending: false, fault: null };
  const event = { kind: "wire-checkpoint", runtimeInstanceRef: "runtime", runtimeGeneration: 1, checkpoint };
  f.append(custody, event); assert.equal(custody.observer.readCheckpoint().resumable, false);
  f.append(custody, observationCallback("outer-rejected")); assert.equal(custody.observer.readCheckpoint().resumable, true);
  const broken = structuredClone(event); delete broken.checkpoint.pending;
  assert.throws(() => f.append(custody, broken), /wire-checkpoint-shape/);
});

for (const appendBeforeCrash of [false, true]) test(`observation custody survives actual child interruption ${appendBeforeCrash ? "after" : "before"} append`, t => {
  const f = observationFixture(t), custody = f.open(), row = f.envelope(custody.observer.readCheckpoint(), generationEvent());
  const recoveryModule = new URL("../packages/piagent-core/benchmark/benchmark-resume-recovery.js", import.meta.url).href;
  const lockModule = new URL("../packages/piagent-core/benchmark/benchmark-run-lock.js", import.meta.url).href;
  const input = { identity: f.identity, requests: f.options.requests, row, journalPath: f.journalPath,
    publicKey: f.keys.publicKey.export({ type: "spki", format: "pem" }) };
  const fixture = path.join(f.runRoot, "public-crash-fixture.json"); fs.writeFileSync(fixture, JSON.stringify(input), { mode: 0o600 });
  f.release();
  const program = `import fs from 'node:fs';
    import {createBenchmarkObservationCustody} from ${JSON.stringify(recoveryModule)};
    import {acquireBenchmarkRunLock} from ${JSON.stringify(lockModule)};
    const root=process.argv[1], fixture=JSON.parse(fs.readFileSync(root+'/public-crash-fixture.json'));
    acquireBenchmarkRunLock(root,'public-run');
    const manifest=JSON.parse(fs.readFileSync(root+'/run-manifest.json'));
    const custody=createBenchmarkObservationCustody({runRoot:root,manifest,...fixture});
    custody.observer.reserve(fixture.row);
    if(process.argv[2]==='append') {
      const fd=fs.openSync(fixture.journalPath,fs.constants.O_WRONLY|fs.constants.O_APPEND);
      fs.writeSync(fd,JSON.stringify(fixture.row)+'\\n');fs.fsyncSync(fd);fs.closeSync(fd);
    }
    process.kill(process.pid,'SIGKILL');`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", program, f.runRoot, appendBeforeCrash ? "append" : "reserved"],
    { encoding: "utf8", timeout: 5000, maxBuffer: 64 * 1024, env: { ...process.env, JITI_FS_CACHE: "0" } });
  assert.equal(child.error, undefined); assert.equal(child.signal, "SIGKILL"); assert.equal(child.status, null);
  assert.equal(child.stdout, ""); assert.equal(child.stderr, "");
  f.relock(); const checkpoint = f.open().observer.readCheckpoint();
  assert.equal(checkpoint.sequence, appendBeforeCrash ? 1 : 0);
  assert.equal(checkpoint.pending === null, appendBeforeCrash);
  assert.equal(checkpoint.resumable, false, "interruption never manufactures completed generation or provider usage");
  console.log(JSON.stringify({ observationCrash: appendBeforeCrash ? "after-append" : "before-append", signal: child.signal,
    checkpointSequence: checkpoint.sequence, pending: checkpoint.pending !== null, providerCalls: 0 }));
});

test("observation custody resume loader preserves legacy no-config and blocks unresolved state under run lock", t => {
  const legacy = observationFixture(t); legacy.release();
  const old = loadResumeState(legacy.runRoot);
  try { assert.deepEqual(old.observationCheckpoints, []); } finally { old.releaseRunLock(); }
  const f = observationFixture(t), custody = f.open(); f.append(custody, generationEvent()); f.release();
  assert.throws(() => loadResumeState(f.runRoot), /resume-has-unresolved-attempt/);
  assert.equal(fs.existsSync(path.join(f.runRoot, ".benchmark-run.lock")), false, "blocked load releases only its owned lock");
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.runRoot, "run-manifest.json"))).observationCheckpoints[0].sequence, 1);
});

test("production-v3 resume corruption writes INVALID_MEASUREMENT even with missing or wrong stop policy", t => {
  for (const [label, campaignStopPolicy] of [["missing", undefined], ["wrong", "paired-outcome-floor"]]) {
    const runRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `piagent-invalid-resume-${label}-`)));
    t.after(() => fs.rmSync(runRoot, { recursive: true, force: true }));
    writeBenchmarkRunManifest(runRoot, {
      schemaVersion: 1,
      runId: `production-v3-invalid-resume-${label}`,
      suite: { id: "production-v3" },
      measurementOnly: false,
      ...(campaignStopPolicy === undefined ? {} : { campaignStopPolicy }),
      ledger: emptyBenchmarkLedgerBinding(),
      order: Array.from({ length: 108 }, (_, index) => ({ scenarioId: `scenario-${index}`, surface: "piagent", repeat: 1 }))
    });
    fs.writeFileSync(path.join(runRoot, "runs.jsonl"), "{invalid-json}\n", { mode: 0o600 });
    assert.throws(() => loadResumeState(runRoot), /Cannot parse benchmark ledger/);
    const aborted = JSON.parse(fs.readFileSync(path.join(runRoot, "aborted.json"), "utf8"));
    assert.equal(aborted.measurementValidity.status, "INVALID_MEASUREMENT");
    assert.equal(aborted.verdict.status, "INVALID_MEASUREMENT");
    assert.deepEqual(aborted.verdict.measurementValidity,
      { passed: false, failures: ["fatal:BENCHMARK_LEDGER_INVALID"] });
    assert.equal(fs.existsSync(path.join(runRoot, ".benchmark-run.lock")), false);
  }
});

test("a finalized production-v3 report or campaign is terminal and resume cannot add an INVALID verdict", t => {
  for (const [label, writeReport, status] of [
    ["published-pass", true, "claim-passed"],
    ["claim-passed", false, "claim-passed"],
    ["published-fail", true, "no-claim"]
  ]) {
    const runRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `piagent-finalized-resume-${label}-`)));
    t.after(() => fs.rmSync(runRoot, { recursive: true, force: true }));
    writeBenchmarkRunManifest(runRoot, {
      schemaVersion: 1,
      runId: `production-v3-finalized-${label}`,
      suite: { id: "production-v3" },
      measurementOnly: false,
      campaignStopPolicy: "paired-outcome-floor",
      campaignEvidence: { status },
      ledger: emptyBenchmarkLedgerBinding(),
      order: Array.from({ length: 108 }, (_, index) => ({ scenarioId: `scenario-${index}`, surface: "piagent", repeat: 1 }))
    });
    const reportBytes = `${JSON.stringify({ verdict: { status: status === "claim-passed" ? "PASS_VALID" : "FAIL_VALID" } })}\n`;
    if (writeReport) fs.writeFileSync(path.join(runRoot, "report.json"), reportBytes, { mode: 0o600 });
    fs.writeFileSync(path.join(runRoot, "runs.jsonl"), "{invalid-json}\n", { mode: 0o600 });
    assert.throws(() => loadResumeState(runRoot), /already has a finalized report or campaign outcome/);
    assert.equal(fs.existsSync(path.join(runRoot, "aborted.json")), false);
    assert.equal(fs.existsSync(path.join(runRoot, ".benchmark-run.lock")), false);
    if (writeReport) assert.equal(fs.readFileSync(path.join(runRoot, "report.json"), "utf8"), reportBytes);
  }
});

test("observation custody clean retired history resumes through actual parent loader without new generation", t => {
  const f = observationFixture(t), custody = f.open(); f.append(custody, generationEvent()); f.append(custody, observationRetire());
  const journalBytes = fs.readFileSync(f.journalPath); f.release(); const resumed = loadResumeState(f.runRoot);
  try {
    assert.equal(resumed.observationCheckpoints[0].resumable, true);
    assert.equal(resumed.observationCheckpoints[0].sequence, 2);
    assert.equal(resumed.observationCheckpoints[0].runtimes[0].runtimeGeneration, 1);
    assert.deepEqual(fs.readFileSync(f.journalPath), journalBytes);
  } finally { resumed.releaseRunLock(); }
});

function notApplicableCausalContextReceipt() {
  return {
    schemaVersion: 1,
    evidenceSource: "not-applicable",
    applicability: "not-applicable",
    available: false,
    coverage: {
      status: "not-applicable",
      telemetryTruncated: false,
      telemetryIntegrityFailures: 0,
      recoverableTailBytes: 0,
      criterionExpected: false,
      sessionEventsObserved: 0,
      observedLanes: 0,
      requiredLanes: 0,
      missingLanes: []
    },
    aggregates: null
  };
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function record(overrides = {}) {
  return {
    schemaVersion: 1, runId: "run", attemptId: "attempt", configurationDigest: hash, orderIndex: 1,
    scenarioId: "task", scenarioTitle: "Task", scenarioKind: "source-change", category: "code", difficulty: "small",
    profile: "node", lifecycle: "steady-state", surface: "raw-pi", repeat: 1, infrastructureAttempt: 1,
    infrastructureAttempts: 1, infrastructureRetries: 0, infrastructureFailures: [], sessionId: "session", abortSuite: false,
    resolved: true, agent: { exitCode: 0, timedOut: false, stdoutHash: hash, stderrHash: hash },
    grade: { passed: true, score: 10, checks: [] }, graderIntegrity: { passed: true },
    scope: { passed: true, changedFiles: [], outsideScope: [] }, outputSafety: { passed: true, forbiddenHits: [] },
    outputEvidence: { passed: true, requiredCount: 0 }, durationSeconds: 1, promptHash: hash,
    causalContextReceipt: notApplicableCausalContextReceipt(),
    variant: { generated: false, fixtureDigest: hash },
    usageStatus: "measured", usage: { sessions: 1, fresh: 3, input: 2, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 3, cost: null, costSource: "unavailable" },
    ...overrides
  };
}

test("expected record binds exact surface and repeat before append", () => {
  const suite = { profile: "node" };
  const expected = { scenario: { id: "task", title: "Task", kind: "source-change", category: "code", difficulty: "small" }, surface: "raw-pi", repeat: 1 };
  assert.equal(expectedBenchmarkRecord(record(), 0, expected, "run", suite, hash), true);
  assert.equal(expectedBenchmarkRecord(record({ timingDiagnostics: { schemaVersion: "malformed-observational-only" } }), 0, expected, "run", suite, hash), true);
  assert.equal(expectedBenchmarkRecord(record({ surface: "piagent" }), 0, expected, "run", suite, hash), false);
  assert.equal(expectedBenchmarkRecord(record({ repeat: 2 }), 0, expected, "run", suite, hash), false);
});

test("known failed-attempt usage remains claimable while unknown usage closes claims", (t) => {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-known-attempt-"));
  t.after(() => fs.rmSync(runRoot, { recursive: true, force: true }));
  const known = { schemaVersion: 1, runId: "run", ledger: null };
  persistUnacceptedBenchmarkAttempt({ runRoot, manifest: known, record: record({ abortSuite: true, infrastructureFailure: "transport-after-usage" }) });
  assert.equal(known.tokenClaimsUnavailableReason, undefined);
  assert.equal(known.recoveredProviderAttempts[0].usage.fresh, 3);

  const unknownRoot = path.join(runRoot, "unknown");
  fs.mkdirSync(unknownRoot);
  const unknown = { schemaVersion: 1, runId: "run", ledger: null };
  persistUnacceptedBenchmarkAttempt({
    runRoot: unknownRoot,
    manifest: unknown,
    record: record({ abortSuite: true, usageStatus: "unknown-after-provider-start", usage: { sessions: 0, fresh: 0 }, infrastructureFailure: "transport-unknown" })
  });
  assert.equal(unknown.tokenClaimsUnavailableReason, "one-or-more-provider-attempts-have-unaccepted-or-unknown-usage");
});

test("measured-session WAL without a post-session guard stays unaccepted on resume", (t) => {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-session-wal-"));
  t.after(() => fs.rmSync(runRoot, { recursive: true, force: true }));
  const suite = { profile: "node" };
  const expected = { scenario: { id: "task", title: "Task", kind: "source-change", category: "code", difficulty: "small" }, surface: "raw-pi", repeat: 1 };
  const ledger = emptyBenchmarkLedgerBinding();
  const manifest = { schemaVersion: 1, runId: "run", configurationDigest: hash, ledger };
  const measured = record({ timingDiagnostics: { schemaVersion: "malformed-observational-only" } });
  stageMeasuredBenchmarkRecord({ runRoot, manifest, ledgerBinding: ledger, record: measured, infrastructureFailures: [], index: 0, expected, runId: "run", suite, configurationDigest: hash, runs: [] });
  assert.equal(Object.hasOwn(measured, "timingDiagnostics"), false, "invalid timing is omitted without rejecting the paid result");
  const measuredPath = path.join(runRoot, "measured-record-ready.json");
  const measuredReady = JSON.parse(fs.readFileSync(measuredPath));
  const recovered = recoverPendingBenchmarkRecord({ runRoot, manifest, ledgerBinding: ledger, completedRuns: [], pending: null, measuredReady, fullOrder: [expected], suite });
  assert.equal(recovered.completedRuns.length, 0);
  assert.equal(recovered.ledgerBinding.records, 0);
  assert.equal(manifest.recoveredProviderAttempts[0].attemptId, measured.attemptId);
  assert.equal(manifest.tokenClaimsUnavailableReason, undefined);
  assert.equal(fs.existsSync(measuredPath), false);
});

test("post-session guard receipt makes the completed WAL promotable byte-identically", (t) => {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-guarded-session-wal-"));
  t.after(() => fs.rmSync(runRoot, { recursive: true, force: true }));
  const suite = { profile: "node" };
  const expected = { scenario: { id: "task", title: "Task", kind: "source-change", category: "code", difficulty: "small" }, surface: "raw-pi", repeat: 1 };
  const ledger = emptyBenchmarkLedgerBinding();
  const manifest = { schemaVersion: 1, runId: "run", configurationDigest: hash, ledger };
  const measured = record({ timingDiagnostics: { schemaVersion: "malformed-observational-only" } });
  stageMeasuredBenchmarkRecord({ runRoot, manifest, ledgerBinding: ledger, record: measured, infrastructureFailures: [], index: 0, expected, runId: "run", suite, configurationDigest: hash, runs: [] });
  assert.equal(Object.hasOwn(measured, "timingDiagnostics"), false);
  promoteMeasuredBenchmarkRecord({ runRoot, ledgerBinding: ledger, record: measured, postSessionGuard: { stage: "after-session:task:raw-pi:r1:attempt1", matched: true } });
  const pendingPath = path.join(runRoot, "pending-record.json");
  const pendingBytes = fs.readFileSync(pendingPath);
  const pending = JSON.parse(pendingBytes);
  pending.record.timingDiagnostics = { rawPayload: "legacy invalid timing must not survive resume promotion" };
  const recovered = recoverPendingBenchmarkRecord({ runRoot, manifest, ledgerBinding: ledger, completedRuns: [], pending, measuredReady: null, fullOrder: [expected], suite });
  assert.equal(recovered.completedRuns.length, 1);
  assert.deepEqual(recovered.completedRuns[0], measured);
  assert.equal(Object.hasOwn(recovered.completedRuns[0], "timingDiagnostics"), false);
  assert.equal(fs.existsSync(pendingPath), false);
  assert.deepEqual(inspectBenchmarkLedger(path.join(runRoot, "runs.jsonl")).records, [measured]);
  assert.ok(pendingBytes.length > 0);
});

test("orphan recovery is idempotent and preserves exact usage without disabling claims", (t) => {
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-orphan-wal-"));
  t.after(() => fs.rmSync(runRoot, { recursive: true, force: true }));
  const workspace = path.join(runRoot, "workspaces", "01-task-raw-pi");
  fs.mkdirSync(workspace, { recursive: true });
  const project = path.join(workspace, "project");
  fs.mkdirSync(project);
  git(project, ["init", "-q"]);
  git(project, ["config", "user.email", "benchmark@piagent.local"]);
  git(project, ["config", "user.name", "Piagent Benchmark"]);
  fs.writeFileSync(path.join(project, "task.js"), "export const value = 1;\n");
  git(project, ["add", "task.js"]);
  git(project, ["commit", "-qm", "fixture"]);
  fs.writeFileSync(path.join(project, "task.js"), "export const value = 2;\n");
  if (process.platform !== "win32") fs.chmodSync(path.join(project, "task.js"), 0o644);
  const projectDigest = workingTreeEvidenceDigest(workingTreeSnapshot(project));
  const sessions = path.join(workspace, "sessions");
  fs.mkdirSync(sessions);
  fs.writeFileSync(path.join(sessions, "session.jsonl"), "{}\n", { mode: 0o644 });
  const inflight = {
    schemaVersion: 1, runId: "run", attemptId: "attempt", orderIndex: 1, scenarioId: "task",
    surface: "raw-pi", repeat: 1, infrastructureAttempt: 1, stage: "provider-returned", usage: record().usage
  };
  const inflightPath = path.join(workspace, "inflight.json");
  fs.writeFileSync(inflightPath, `${JSON.stringify(inflight)}\n`, { mode: 0o600 });
  const manifest = { schemaVersion: 1, runId: "run", configurationDigest: hash, ledger: emptyBenchmarkLedgerBinding() };
  const fullOrder = [{ scenario: { id: "task" }, surface: "raw-pi", repeat: 1 }];
  const first = recoverOrphanedBenchmarkAttempts({ runRoot, manifest, fullOrder, completedKeys: new Set() });
  assert.equal(first.get(["task", "raw-pi", "1"].join("\0")).length, 1);
  assert.equal(manifest.tokenClaimsUnavailableReason, undefined);
  assert.equal(manifest.recoveredProviderAttempts[0].usageStatus, "measured-but-unaccepted");
  assert.equal(workingTreeEvidenceDigest(workingTreeSnapshot(project)), projectDigest);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(path.join(project, "task.js")).mode & 0o777, 0o644);
    assert.equal(fs.statSync(workspace).mode & 0o777, 0o700);
    assert.equal(fs.statSync(sessions).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(sessions, "session.jsonl")).mode & 0o777, 0o600);
  }

  fs.writeFileSync(inflightPath, `${JSON.stringify(inflight)}\n`, { mode: 0o600 });
  const second = recoverOrphanedBenchmarkAttempts({ runRoot, manifest, fullOrder, completedKeys: new Set() });
  assert.equal(second.get(["task", "raw-pi", "1"].join("\0")).length, 1);
  assert.equal(manifest.recoveredProviderAttempts.length, 1);
});
