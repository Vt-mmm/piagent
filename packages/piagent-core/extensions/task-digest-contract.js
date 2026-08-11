import crypto from "node:crypto";

import { DIGEST_MIGRATION_SOURCE, LEGACY_UNTRUSTED_DIGEST_ALGORITHM } from "./task-digest-migration.js";
import { WORKING_TREE_DIGEST_ALGORITHM, workingTreeCarrierDigest } from "./working-tree-digest.js";

const FIELDS = new Set(["status", "source", "reasonCode", "requiredAction", "archivePath", "archiveDigest", "archiveBytes", "baselineEvidenceDigest", "finalEvidenceDigest", "recordedAt", "refreshedAt"]);
const STATUSES = new Set(["verification-refresh-required", "refreshed", "new-attempt-required", "historical-unverifiable"]);
const ACTIONS = {
  "verification-refresh-required": "rerun-exact-verifier", refreshed: "none",
  "new-attempt-required": "start-new-attempt", "historical-unverifiable": "historical-only"
};
const REASONS = {
  "verification-refresh-required": new Set(["clean-baseline-rebound"]), refreshed: new Set(["clean-baseline-rebound"]),
  "new-attempt-required": new Set(["semantic-repair-state-present", "read-only-legacy-task", "exact-verifier-plan-missing", "baseline-not-provably-clean", "evidence-root-unavailable", "current-snapshot-unavailable", "legacy-carrier-key-mismatch", "active-task-binding-unavailable", "schema-v1-unversioned", "legacy-untrusted"]),
  "historical-unverifiable": new Set(["terminal-legacy-evidence", "schema-v1-unversioned", "legacy-untrusted"])
};

function record(value) { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function timestamp(value) { return typeof value === "string" && value.trim().length > 0 && Number.isFinite(Date.parse(value)); }

export function taskDigestContractValidationErrors(input) {
  const errors = [], migration = input.workingTreeDigestMigration;
  if (![WORKING_TREE_DIGEST_ALGORITHM, LEGACY_UNTRUSTED_DIGEST_ALGORITHM].includes(input.workingTreeDigestAlgorithm)) errors.push("workingTreeDigestAlgorithm is invalid or missing");
  if (migration !== undefined) {
    if (!record(migration) || Object.keys(migration).some((field) => !FIELDS.has(field)) || !STATUSES.has(migration.status)
      || migration.source !== DIGEST_MIGRATION_SOURCE || !REASONS[migration.status]?.has(migration.reasonCode)
      || ACTIONS[migration.status] !== migration.requiredAction || typeof migration.archivePath !== "string"
      || migration.archivePath !== `.pi/piagent-state/digest-migrations/${input.taskRunId}.legacy.json`
      || !/^[a-f0-9]{64}$/.test(migration.archiveDigest) || !Number.isInteger(migration.archiveBytes) || migration.archiveBytes < 1
      || !/^[a-f0-9]{64}$/.test(migration.baselineEvidenceDigest) || !/^[a-f0-9]{64}$/.test(migration.finalEvidenceDigest)
      || !timestamp(migration.recordedAt) || (migration.refreshedAt !== undefined && (!timestamp(migration.refreshedAt) || Date.parse(migration.refreshedAt) < Date.parse(migration.recordedAt)))) errors.push("workingTreeDigestMigration is invalid");
  }
  if (input.workingTreeDigestAlgorithm === LEGACY_UNTRUSTED_DIGEST_ALGORITHM) {
    if (!migration || !["new-attempt-required", "historical-unverifiable"].includes(migration.status)) errors.push("legacy-untrusted digest tasks require a terminal migration disposition");
    if (input.trace?.outcome === "pending") errors.push("legacy-untrusted digest tasks cannot remain pending");
    if (["baselineChangedFiles", "observedChangedFiles", "finalWorkingTreeFiles", "changedFiles", "verifyEvidence"].some((field) => Array.isArray(input[field]) && input[field].length > 0)) errors.push("legacy-untrusted task proof carriers must be empty");
    if (input.acceptanceReceipt?.provenance !== undefined || input.acceptanceReceipt?.criteria?.some((criterion) => criterion.status !== "pending" || criterion.evidence?.length > 0)) errors.push("legacy-untrusted acceptance proof must remain pending and empty");
  }
  if (migration?.status === "verification-refresh-required" && (input.workingTreeDigestAlgorithm !== WORKING_TREE_DIGEST_ALGORITHM || input.trace?.outcome !== "pending")) errors.push("digest refresh requires a pending current-algorithm task");
  if (migration?.status === "refreshed" && (input.workingTreeDigestAlgorithm !== WORKING_TREE_DIGEST_ALGORITHM || !timestamp(migration.refreshedAt))) errors.push("refreshed digest migration is incomplete");
  if (["new-attempt-required", "historical-unverifiable"].includes(migration?.status) && input.workingTreeDigestAlgorithm !== LEGACY_UNTRUSTED_DIGEST_ALGORITHM) errors.push("terminal digest migration requires legacy-untrusted algorithm");
  if (migration?.status === "new-attempt-required" && input.trace?.outcome !== "blocked") errors.push("new-attempt-required migration must be terminal blocked");
  if (migration?.status === "historical-unverifiable" && input.trace?.outcome === "pending") errors.push("historical-unverifiable migration cannot be pending");
  return errors;
}

export function normalizedTaskDigestFields(input, context) {
  const current = input.schemaVersion === context.schemaVersion && input.workingTreeDigestAlgorithm === WORKING_TREE_DIGEST_ALGORITHM;
  const legacy = input.schemaVersion !== context.schemaVersion || input.workingTreeDigestAlgorithm === LEGACY_UNTRUSTED_DIGEST_ALGORITHM;
  const versioned = input.schemaVersion === context.schemaVersion && [WORKING_TREE_DIGEST_ALGORITHM, LEGACY_UNTRUSTED_DIGEST_ALGORITHM].includes(input.workingTreeDigestAlgorithm);
  const fallback = legacy ? {
    status: context.trace.outcome === "pending" ? "new-attempt-required" : "historical-unverifiable",
    source: DIGEST_MIGRATION_SOURCE,
    reasonCode: input.schemaVersion === context.schemaVersion ? "legacy-untrusted" : "schema-v1-unversioned",
    requiredAction: context.trace.outcome === "pending" ? "start-new-attempt" : "historical-only",
    archivePath: `.pi/piagent-state/digest-migrations/${context.taskRunId}.legacy.json`,
    archiveDigest: context.options.archiveDigest ?? crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex"),
    baselineEvidenceDigest: workingTreeCarrierDigest("baseline", [], {}), finalEvidenceDigest: workingTreeCarrierDigest("final", [], {}),
    archiveBytes: context.options.archiveBytes ?? Buffer.byteLength(JSON.stringify(input)), recordedAt: context.updatedAt
  } : undefined;
  return {
    current, legacy,
    algorithm: current ? WORKING_TREE_DIGEST_ALGORITHM : LEGACY_UNTRUSTED_DIGEST_ALGORITHM,
    migration: versioned && record(input.workingTreeDigestMigration)
      ? Object.fromEntries(Object.entries(input.workingTreeDigestMigration).filter(([field]) => FIELDS.has(field)))
      : fallback
  };
}

export function acceptanceReceiptWithoutWorkingTreeProof(value, recordedAt) {
  if (!record(value) || !Array.isArray(value.criteria)) return value;
  const receipt = structuredClone(value); delete receipt.provenance;
  receipt.criteria = receipt.criteria.map((criterion) => ({ ...criterion, status: "pending", evidence: [], updatedAt: recordedAt }));
  return receipt;
}
