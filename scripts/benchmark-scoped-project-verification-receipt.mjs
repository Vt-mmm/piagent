import { SCOPED_DOCS_RECEIPT, SCOPED_DOCS_WORKER, DOCS_COMMAND_IDS, validateScopedDocsScope } from "./benchmark-scoped-docs-verifier.mjs";
const RECEIPT_FIELDS = ["version", "kind", "protocol", "verificationId", "action", "attemptId", "broker",
  "manifestSha256", "capabilityDigest", "planDigest", "requestDigest", "sourceDigest", "environmentDigest",
  "verifierDigest", "worker", "status", "verdict", "cleanup", "evidence", "startedAtMs", "deadlineAtMs",
  "settledAtMs", "completionAllowed"];

export function validateProjectReceipt(receipt, h) {
  const { exact, plain, requireThat, validHash, validTime, HASH, ID, UUID_V4, SCOPED_PROJECT_VERIFICATION_PROTOCOL,
    SCOPED_PROJECT_VERIFICATION_RECEIPT, SCOPED_PROJECT_VERIFIER_WORKER } = h;
  requireThat(plain(receipt), "invalid-verification-receipt");
  const docs = Object.getOwnPropertyDescriptor(receipt, "kind")?.value === SCOPED_DOCS_RECEIPT,
    worker = docs ? SCOPED_DOCS_WORKER : SCOPED_PROJECT_VERIFIER_WORKER,
    ids = docs ? DOCS_COMMAND_IDS : ["type-check", "lint", "test", "test:e2e"];
  exact(receipt, docs ? [...RECEIPT_FIELDS, "scope"] : RECEIPT_FIELDS, "invalid-verification-receipt");
  exact(receipt.broker, ["identitySha256", "sourceSha256"], "invalid-verification-receipt");
  exact(receipt.worker, ["runId", "version"], "invalid-verification-receipt");
  exact(receipt.cleanup, ["confirmed"], "invalid-verification-receipt");
  exact(receipt.evidence, ["executionSha256", "observationSha256", "reason", "outcome", "failedCommands"],
    "invalid-verification-receipt");
  requireThat(receipt.version === (docs ? 3 : 2) && receipt.kind === (docs ? SCOPED_DOCS_RECEIPT : SCOPED_PROJECT_VERIFICATION_RECEIPT)
    && receipt.protocol === SCOPED_PROJECT_VERIFICATION_PROTOCOL && typeof receipt.verificationId === "string"
    && ID.test(receipt.verificationId) && Number.isSafeInteger(receipt.action) && receipt.action > 0
    && UUID_V4.test(receipt.attemptId) && validHash(receipt.broker.identitySha256)
    && validHash(receipt.broker.sourceSha256) && [receipt.manifestSha256, receipt.capabilityDigest,
      receipt.planDigest, receipt.requestDigest, receipt.sourceDigest, receipt.environmentDigest,
      receipt.verifierDigest, receipt.evidence.executionSha256].every(validHash)
    && receipt.worker.runId === receipt.attemptId
    && (receipt.worker.version === null || receipt.worker.version === worker)
    && ["completed", "timeout", "cancelled", "error"].includes(receipt.status)
    && ["observation-recorded", "observation-unavailable"].includes(receipt.verdict)
    && typeof receipt.cleanup.confirmed === "boolean"
    && (receipt.evidence.observationSha256 === null || validHash(receipt.evidence.observationSha256))
    && (receipt.evidence.reason === null || typeof receipt.evidence.reason === "string"
      && /^[a-z0-9-]{1,80}$/.test(receipt.evidence.reason))
    && (receipt.evidence.outcome === null || ["passed", "failed"].includes(receipt.evidence.outcome))
    && Array.isArray(receipt.evidence.failedCommands) && receipt.evidence.failedCommands.length <= ids.length
    && new Set(receipt.evidence.failedCommands).size === receipt.evidence.failedCommands.length
    && receipt.evidence.failedCommands.every(item => ids.includes(item))
    && (receipt.evidence.outcome === "failed") === (receipt.evidence.failedCommands.length > 0)
    && [receipt.startedAtMs, receipt.deadlineAtMs, receipt.settledAtMs].every(validTime)
    && receipt.deadlineAtMs >= receipt.startedAtMs && receipt.settledAtMs >= receipt.startedAtMs
    && receipt.completionAllowed === false, "invalid-verification-receipt");
  const observed = receipt.status === "completed" && receipt.cleanup.confirmed
    && receipt.worker.version === worker && validHash(receipt.evidence.observationSha256)
    && receipt.evidence.reason === null && ["passed", "failed"].includes(receipt.evidence.outcome);
  requireThat((receipt.verdict === "observation-recorded") === observed, "invalid-verification-receipt");
  if (docs) validateScopedDocsScope(receipt.scope, receipt.sourceDigest, h);
  return true;
}
