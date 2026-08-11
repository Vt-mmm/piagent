import crypto from "node:crypto";

export const WORKING_TREE_DIGEST_ALGORITHM = "wt-content-v2";
const CURRENT_PREFIX = `${WORKING_TREE_DIGEST_ALGORITHM}:`;
const UNAVAILABLE_PREFIX = `${WORKING_TREE_DIGEST_ALGORITHM}-unavailable:`;
const LEGACY_UNTRUSTED_PREFIX = "legacy-untrusted:";
const HASH = /^[a-f0-9]{64}$/;
const CURRENT = /^wt-content-v2:[a-f0-9]{64}$/;
const UNAVAILABLE = /^wt-content-v2-unavailable:[a-f0-9]{64}$/;
const LEGACY = /^legacy-untrusted:[a-f0-9]{64}$/;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
function canonicalCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
function plainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function versionWorkingTreeHash(value) {
  const digest = String(value ?? "");
  if (!HASH.test(digest)) throw new Error("Working-tree hash must be SHA-256 hex");
  return `${CURRENT_PREFIX}${digest}`;
}

export function unavailableWorkingTreeHash(value) {
  const digest = String(value ?? "");
  if (!HASH.test(digest)) throw new Error("Unavailable working-tree hash must be SHA-256 hex");
  return `${UNAVAILABLE_PREFIX}${digest}`;
}

export function isCurrentWorkingTreeDigest(value) {
  return typeof value === "string" && CURRENT.test(value);
}

export function isUnavailableWorkingTreeDigest(value) {
  return typeof value === "string" && UNAVAILABLE.test(value);
}

export function isLegacyWorkingTreeDigest(value) {
  return typeof value === "string" && (HASH.test(value) || LEGACY.test(value));
}

export function workingTreeEvidenceDigest(snapshot) {
  const candidate = snapshot;
  if (!plainRecord(candidate)) return `${LEGACY_UNTRUSTED_PREFIX}${sha256(`invalid\0${String(candidate)}`)}`;
  const entries = Object.entries(candidate).sort(([left], [right]) => canonicalCompare(left, right));
  const material = `tree\0${WORKING_TREE_DIGEST_ALGORITHM}\0${JSON.stringify(entries)}`;
  if (entries.some(([file, digest]) => !file || typeof digest !== "string")) return `${LEGACY_UNTRUSTED_PREFIX}${sha256(material)}`;
  if (entries.some(([, digest]) => isUnavailableWorkingTreeDigest(digest))) {
    return unavailableWorkingTreeHash(sha256(material));
  }
  if (entries.some(([, digest]) => !isCurrentWorkingTreeDigest(digest))) {
    return `${LEGACY_UNTRUSTED_PREFIX}${sha256(material)}`;
  }
  return versionWorkingTreeHash(sha256(material));
}

export function workingTreeCarrierDigest(label, files, digests) {
  if (typeof label !== "string" || !Array.isArray(files) || files.some((file) => typeof file !== "string") || !plainRecord(digests) || Object.entries(digests).some(([file, digest]) => !file || typeof digest !== "string")) throw new Error("Working-tree carrier evidence is malformed");
  const material = { files: [...files].sort(canonicalCompare), digests: Object.entries(digests).sort(([left], [right]) => canonicalCompare(left, right)) };
  return sha256(`task-tree-carrier\0${WORKING_TREE_DIGEST_ALGORITHM}\0${label}\0${JSON.stringify(material)}`);
}

export function workingTreeSnapshotUsesCurrentAlgorithm(snapshot) {
  return plainRecord(snapshot) && Object.values(snapshot).every((digest) => isCurrentWorkingTreeDigest(digest));
}

export function workingTreeObservation(snapshot) {
  if (!plainRecord(snapshot)) throw new Error("Working-tree observation requires a snapshot record");
  const captured = Object.freeze(Object.fromEntries(
    Object.entries(snapshot).sort(([left], [right]) => canonicalCompare(left, right))
  ));
  const digest = workingTreeEvidenceDigest(captured);
  return Object.freeze({
    snapshot: captured,
    digest,
    proofCapable: workingTreeSnapshotUsesCurrentAlgorithm(captured) && isCurrentWorkingTreeDigest(digest)
  });
}
