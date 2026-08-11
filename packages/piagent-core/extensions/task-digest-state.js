import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ensurePrivateStateDirectory, resolveLocalStatePath } from "./local-state-path.js";
import { LEGACY_UNTRUSTED_DIGEST_ALGORITHM, planUnversionedTaskDigestMigration } from "./task-digest-migration.js";
import { meaningfulVerificationCommands } from "./verification-intelligence.js";
import {
  WORKING_TREE_DIGEST_ALGORITHM,
  isCurrentWorkingTreeDigest,
  isUnavailableWorkingTreeDigest,
  unavailableWorkingTreeHash,
  versionWorkingTreeHash,
  workingTreeCarrierDigest,
  workingTreeSnapshotUsesCurrentAlgorithm
} from "./working-tree-digest.js";

function safeRunId(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80).replace(/-+$/g, "") || "task";
}
function stateRoot(cwd) { return path.join(cwd, ".pi", "piagent-state"); }
function migrationRoot(cwd) { return path.join(stateRoot(cwd), "digest-migrations"); }
function archivePath(cwd, runId) { return path.join(migrationRoot(cwd), `${safeRunId(runId)}.legacy.json`); }
function relativeArchivePath(runId) { return `.pi/piagent-state/digest-migrations/${safeRunId(runId)}.legacy.json`; }
function isRecord(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function sortedKeys(value) { return isRecord(value) ? Object.keys(value).sort() : []; }
function sameStrings(left, right) {
  return JSON.stringify([...(Array.isArray(left) ? left : [])].sort()) === JSON.stringify([...(Array.isArray(right) ? right : [])].sort());
}
export function taskDigestMigrationEvidenceBindings(task) {
  const migration = task?.workingTreeDigestMigration;
  if (/^[a-f0-9]{64}$/.test(migration?.baselineEvidenceDigest) && /^[a-f0-9]{64}$/.test(migration?.finalEvidenceDigest)) return { baselineEvidenceDigest: migration.baselineEvidenceDigest, finalEvidenceDigest: migration.finalEvidenceDigest };
  return {
    baselineEvidenceDigest: workingTreeCarrierDigest("baseline", task?.baselineChangedFiles, task?.baselineFileDigests),
    finalEvidenceDigest: workingTreeCarrierDigest("final", task?.finalWorkingTreeFiles, task?.finalFileDigests)
  };
}
function barrierMatchesTask(event, task) {
  const data = event?.data, migration = task?.workingTreeDigestMigration;
  return Boolean(data && migration && data.algorithm === task.workingTreeDigestAlgorithm && data.disposition === migration.status
    && data.reasonCode === migration.reasonCode && data.archivePath === migration.archivePath && data.archiveDigest === migration.archiveDigest
    && data.baselineEvidenceDigest === migration.baselineEvidenceDigest && data.finalEvidenceDigest === migration.finalEvidenceDigest);
}

function acquireLock(cwd, runId) {
  const root = ensurePrivateStateDirectory(cwd, migrationRoot(cwd), "Digest migration archive");
  const target = resolveLocalStatePath(cwd, path.join(root, `${safeRunId(runId)}.lock`), { label: "Digest migration lock" });
  const token = crypto.randomBytes(16).toString("hex");
  try {
    const descriptor = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.writeFileSync(descriptor, `${process.pid}\n${new Date().toISOString()}\n${token}\n`);
    return () => { try { fs.closeSync(descriptor); } catch {} try { if (fs.readFileSync(target, "utf8").split("\n")[2] === token) fs.rmSync(target, { force: true }); } catch {} };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let stale = false;
    try {
      const owner = Number.parseInt(fs.readFileSync(target, "utf8").split("\n")[0] ?? "", 10);
      let alive = Number.isInteger(owner) && owner > 0;
      if (alive) try { process.kill(owner, 0); } catch (ownerError) { alive = ownerError?.code === "EPERM"; }
      stale = !alive && Date.now() - fs.statSync(target).mtimeMs > 30_000;
    } catch {}
    if (!stale) throw new Error("digest migration is already active");
    fs.rmSync(target, { force: true });
    return acquireLock(cwd, runId);
  }
}

function semanticCarrierPresent(cwd, runId) {
  const root = path.join(stateRoot(cwd), "semantic-repair");
  const archive = path.join(migrationRoot(cwd), `${safeRunId(runId)}.carriers`);
  return [
    path.join(root, `${safeRunId(runId)}.json`),
    path.join(root, `${safeRunId(runId)}.origin.json`),
    path.join(archive, "semantic-repair-state.json"),
    path.join(archive, "semantic-repair-origin.json")
  ].some((target) => {
    try { return fs.existsSync(resolveLocalStatePath(cwd, target, { label: "Semantic repair migration evidence" })); }
    catch { return true; }
  });
}

export function archiveOriginalTaskContract(cwd, source, runId) {
  const root = ensurePrivateStateDirectory(cwd, migrationRoot(cwd), "Digest migration archive");
  const target = resolveLocalStatePath(cwd, archivePath(cwd, runId), { label: "Digest migration archive file" });
  if (fs.existsSync(target)) {
    if (!fs.readFileSync(target).equals(fs.readFileSync(source))) throw new Error("digest migration archive conflict");
    return target;
  }
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  try { fs.chmodSync(root, 0o700); fs.chmodSync(target, 0o600); } catch {}
  return target;
}

export function archiveLegacyRunCarriers(cwd, taskRunId) {
  const runId = safeRunId(taskRunId);
  const root = ensurePrivateStateDirectory(cwd, path.join(migrationRoot(cwd), `${runId}.carriers`), "Digest migration carrier archive");
  const carriers = [
    ["trajectory", `${runId}.json`, "trajectory-state.json"],
    ["trajectory", `${runId}.events.jsonl`, "trajectory-events.jsonl"],
    ["trajectory", `${runId}.events.jsonl.1`, "trajectory-events.jsonl.1"],
    ["handoffs", `${runId}.json`, "handoff.json"],
    ["semantic-repair", `${runId}.json`, "semantic-repair-state.json"],
    ["semantic-repair", `${runId}.origin.json`, "semantic-repair-origin.json"]
  ];
  for (const [folder, name, archiveName] of carriers) {
    const source = resolveLocalStatePath(cwd, path.join(stateRoot(cwd), folder, name), { label: "Legacy digest carrier" });
    if (!fs.existsSync(source)) continue;
    const target = resolveLocalStatePath(cwd, path.join(root, archiveName), { label: "Legacy digest carrier archive" });
    if (fs.existsSync(target)) {
      if (!fs.readFileSync(target).equals(fs.readFileSync(source))) throw new Error(`digest carrier archive conflict: ${archiveName}`);
      fs.rmSync(source);
    } else fs.renameSync(source, target);
  }
}

function treeDigestValues(raw) {
  return [
    ...Object.values(isRecord(raw?.baselineFileDigests) ? raw.baselineFileDigests : {}),
    ...Object.values(isRecord(raw?.finalFileDigests) ? raw.finalFileDigests : {}),
    ...(Array.isArray(raw?.verifyEvidence) ? raw.verifyEvidence.flatMap((item) => [item?.preWorkingTreeDigest, item?.workingTreeDigest]) : []),
    ...(Array.isArray(raw?.acceptanceReceipt?.criteria) ? raw.acceptanceReceipt.criteria.flatMap((criterion) => Array.isArray(criterion?.evidence) ? criterion.evidence.map((item) => item?.workingTreeDigest) : []) : [])
  ].filter((value) => typeof value === "string");
}
function legacyDigestForValidation(value) {
  if (typeof value !== "string") return value;
  if (/^[a-f0-9]{64}$/.test(value)) return versionWorkingTreeHash(value);
  if (/^unavailable:[a-f0-9]{64}$/.test(value)) return unavailableWorkingTreeHash(value.slice("unavailable:".length));
  if (value === "missing-or-unavailable") return unavailableWorkingTreeHash(crypto.createHash("sha256").update(value).digest("hex"));
  return versionWorkingTreeHash(crypto.createHash("sha256").update(`legacy-validation-placeholder\0${value}`).digest("hex"));
}
function legacyDigestCarrierShapesKnown(raw) { return treeDigestValues(raw).every((value) => /^[a-f0-9]{64}$/.test(value) || /^unavailable:[a-f0-9]{64}$/.test(value) || value === "missing-or-unavailable"); }
function legacyValidationErrors(raw, sourceName, validate) {
  if (safeRunId(raw.taskRunId) !== sourceName) return ["taskRunId does not match filename"];
  const candidate = structuredClone(raw);
  candidate.workingTreeDigestAlgorithm = WORKING_TREE_DIGEST_ALGORITHM;
  delete candidate.workingTreeDigestMigration;
  for (const field of ["baselineFileDigests", "finalFileDigests"]) {
    if (isRecord(candidate[field])) candidate[field] = Object.fromEntries(Object.entries(candidate[field]).map(([file, digest]) => [file, legacyDigestForValidation(digest)]));
  }
  if (Array.isArray(candidate.verifyEvidence)) candidate.verifyEvidence = candidate.verifyEvidence.map((entry) => ({ ...entry, preWorkingTreeDigest: legacyDigestForValidation(entry?.preWorkingTreeDigest), workingTreeDigest: legacyDigestForValidation(entry?.workingTreeDigest) }));
  if (Array.isArray(candidate.acceptanceReceipt?.criteria)) candidate.acceptanceReceipt.criteria = candidate.acceptanceReceipt.criteria.map((criterion) => ({
    ...criterion,
    evidence: Array.isArray(criterion.evidence) ? criterion.evidence.map((entry) => ({ ...entry, workingTreeDigest: legacyDigestForValidation(entry?.workingTreeDigest) })) : criterion.evidence
  }));
  const errors = validate(candidate);
  if (!sameStrings(raw.baselineChangedFiles, sortedKeys(raw.baselineFileDigests))) errors.push("legacy baseline list/map mismatch");
  return errors;
}

export function taskNeedsDigestMigration(raw) {
  if (raw?.schemaVersion !== 2 || typeof raw?.taskRunId !== "string") return false;
  if (raw.workingTreeDigestAlgorithm === undefined) return true;
  if (![WORKING_TREE_DIGEST_ALGORITHM, LEGACY_UNTRUSTED_DIGEST_ALGORITHM].includes(raw.workingTreeDigestAlgorithm)) return true;
  return raw.workingTreeDigestAlgorithm === WORKING_TREE_DIGEST_ALGORITHM
    && treeDigestValues(raw).some((value) => !isCurrentWorkingTreeDigest(value) && !isUnavailableWorkingTreeDigest(value));
}

export function migrateUnversionedTaskDigestState(cwd, source, raw, dependencies) {
  const taskRunId = safeRunId(raw.taskRunId), release = acquireLock(cwd, taskRunId);
  try {
    const originalBytes = fs.readFileSync(source), sourceName = path.basename(source, ".json");
    const errors = legacyValidationErrors(raw, sourceName, dependencies.validateTask);
    if (errors.length > 0) throw new Error(`legacy task contract is invalid: ${errors.join("; ")}`);
    archiveOriginalTaskContract(cwd, source, taskRunId);
    const currentSnapshot = dependencies.workingTreeSnapshot(cwd);
    const currentValues = treeDigestValues(raw).some((value) => isCurrentWorkingTreeDigest(value) || isUnavailableWorkingTreeDigest(value));
    const planned = planUnversionedTaskDigestMigration(raw, {
      recordedAt: new Date().toISOString(), archivePath: relativeArchivePath(taskRunId),
      archiveDigest: crypto.createHash("sha256").update(originalBytes).digest("hex"), archiveBytes: originalBytes.length,
      currentSnapshot, semanticRepairPresent: semanticCarrierPresent(cwd, taskRunId), evidenceRootSafe: dependencies.isGitWorkingTree(cwd),
      keyBindingSafe: raw.workingTreeDigestAlgorithm === undefined && raw.workingTreeDigestMigration === undefined && !currentValues && legacyDigestCarrierShapesKnown(raw) && sameStrings(raw.finalWorkingTreeFiles, sortedKeys(raw.finalFileDigests)),
      snapshotSafe: workingTreeSnapshotUsesCurrentAlgorithm(currentSnapshot) && !dependencies.snapshotHasUnavailable(currentSnapshot),
      sourceChange: raw.changeMode === "source-change",
      activeBindingSafe: dependencies.activeTaskRunId === taskRunId && dependencies.activeSessionId === raw.sessionId,
      verifierPlanSafe: Array.isArray(raw.verifyCommands) && raw.verifyCommands.length > 0 && raw.verifyCommands.every((command) => typeof command === "string" && command.trim()) && meaningfulVerificationCommands(raw.verifyCommands).length === raw.verifyCommands.length
    });
    const normalized = dependencies.normalizeTask(planned.task);
    if (!normalized) throw new Error("digest migration produced an invalid task contract");
    archiveLegacyRunCarriers(cwd, taskRunId);
    if (!fs.readFileSync(source).equals(originalBytes)) throw new Error("task contract changed during digest migration");
    const existingBarrier = dependencies.findBarrier(cwd, normalized.taskRunId, normalized.workingTreeDigestMigration.archiveDigest);
    if (existingBarrier && !barrierMatchesTask(existingBarrier, normalized)) throw new Error("digest migration barrier descriptor conflict");
    const barrier = existingBarrier ?? dependencies.appendBarrier(cwd, { eventType: "digest-migrated", taskRunId: normalized.taskRunId, taskId: normalized.taskId, sessionId: normalized.sessionId, data: {
      algorithm: normalized.workingTreeDigestAlgorithm, disposition: normalized.workingTreeDigestMigration?.status,
      reasonCode: normalized.workingTreeDigestMigration?.reasonCode, archivePath: normalized.workingTreeDigestMigration?.archivePath,
      archiveDigest: normalized.workingTreeDigestMigration?.archiveDigest, ...taskDigestMigrationEvidenceBindings(normalized)
    }});
    if (!barrier) throw new Error("digest migration journal barrier was not persisted");
    if (!fs.readFileSync(source).equals(originalBytes)) throw new Error("task contract changed after digest migration barrier");
    dependencies.writeAtomic(cwd, source, normalized);
    return normalized;
  } finally { release(); }
}

export function commitLegacySchemaTaskDigestState(cwd, source, target, task, originalBytes, dependencies) {
  const release = acquireLock(cwd, task.taskRunId);
  try {
    archiveOriginalTaskContract(cwd, source, task.taskRunId);
    archiveLegacyRunCarriers(cwd, task.taskRunId);
    if (!fs.readFileSync(source).equals(originalBytes)) throw new Error("legacy task contract changed during digest migration");
    const migration = task.workingTreeDigestMigration;
    const existingBarrier = dependencies.findBarrier(cwd, task.taskRunId, migration.archiveDigest);
    if (existingBarrier && !barrierMatchesTask(existingBarrier, task)) throw new Error("digest migration barrier descriptor conflict");
    const barrier = existingBarrier ?? dependencies.appendBarrier(cwd, { eventType: "digest-migrated", taskRunId: task.taskRunId, taskId: task.taskId, sessionId: task.sessionId, data: {
      algorithm: task.workingTreeDigestAlgorithm, disposition: migration.status, reasonCode: migration.reasonCode,
      archivePath: migration.archivePath, archiveDigest: migration.archiveDigest, ...taskDigestMigrationEvidenceBindings(task)
    }});
    if (!barrier) throw new Error("digest migration journal barrier was not persisted");
    if (!fs.readFileSync(source).equals(originalBytes)) throw new Error("legacy task contract changed after digest migration barrier");
    dependencies.writeAtomic(cwd, target, task);
    return task;
  } finally { release(); }
}

export function taskDigestMigrationArchiveStatus(cwd, task) {
  const migration = task?.workingTreeDigestMigration;
  if (!migration) return { required: false, valid: true, reason: "not-required" };
  try {
    const target = resolveLocalStatePath(cwd, path.join(cwd, migration.archivePath), { label: "Digest migration archive", kind: "file" });
    const bytes = fs.readFileSync(target), digest = crypto.createHash("sha256").update(bytes).digest("hex");
    return bytes.length === migration.archiveBytes && digest === migration.archiveDigest
      ? { required: true, valid: true, reason: migration.status }
      : { required: true, valid: false, reason: "digest migration archive does not match its immutable binding" };
  } catch (error) {
    return { required: true, valid: false, reason: `digest migration archive is unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}
