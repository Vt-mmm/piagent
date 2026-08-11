import crypto from "node:crypto";

export const FAILURE_SCHEMA_VERSION = 1 as const;
export const FAILURE_PARSER_VERSION = "failure-parser-v1" as const;
export const FAILURE_POLICY_VERSION = "failure-policy-v1" as const;
export const FAILURE_CATEGORIES = Object.freeze(["passed", "compile-typecheck", "test-assertion", "lint-format", "dependency-config", "environment", "provider-network", "permission-policy", "scope-protected-path", "flaky-infrastructure", "unknown"] as const);
export const FAILURE_OWNERS = Object.freeze(["none", "source", "test-expectation", "dependency", "environment", "provider", "permission", "policy", "scope", "infrastructure", "unknown"] as const);
export const FAILURE_STRUCTURED_EVENTS = Object.freeze(["scope-violation", "protected-path", "permission-denied", "policy-block", "provider-network", "environment", "flaky-infrastructure", "stale-verifier", "missing-verifier"] as const);
export const FAILURE_REASON_CODES = Object.freeze(["exit-zero", "structured-scope", "structured-protected-path", "structured-permission", "structured-policy", "structured-provider", "structured-environment", "structured-flaky-infrastructure", "structured-stale-verifier", "structured-missing-verifier", "typescript-diagnostic", "python-type-diagnostic", "go-compile-diagnostic", "rust-compile-diagnostic", "generic-compile-diagnostic", "test-assertion-diagnostic", "lint-format-diagnostic", "dependency-config-diagnostic", "environment-diagnostic", "provider-rate-limit", "provider-transport", "permission-diagnostic", "policy-diagnostic", "scope-diagnostic", "local-port-conflict", "transient-infrastructure", "unknown-diagnostic"] as const);

export type FailureCategory = typeof FAILURE_CATEGORIES[number];
export type FailureOwner = typeof FAILURE_OWNERS[number];
export type FailureStructuredEvent = typeof FAILURE_STRUCTURED_EVENTS[number];
export type FailureReasonCode = typeof FAILURE_REASON_CODES[number];
export type FailureOutputRef = { sha256: string; chars: number; truncated: boolean; captureRef: string | null };
export type FailureEvidence = { schemaVersion: typeof FAILURE_SCHEMA_VERSION; parserVersion: typeof FAILURE_PARSER_VERSION; exitCode: number; signals: FailureReasonCode[]; structuredEvents: FailureStructuredEvent[]; outputRef: FailureOutputRef };
export type FailureClassification = { schemaVersion: typeof FAILURE_SCHEMA_VERSION; policyVersion: typeof FAILURE_POLICY_VERSION; evidenceDigest: string; category: FailureCategory; ownership: FailureOwner; retryable: boolean; sourceMutationPermission: "eligible-in-scope" | "conditional" | "forbidden"; confidence: "low" | "medium" | "high"; reasonCodes: FailureReasonCode[]; authorizesSourceMutation: false; outputRef: FailureOutputRef };

const HASH = /^[a-f0-9]{64}$/;
const CAPTURE = /^[a-z0-9][a-z0-9:._-]{0,255}$/i;
const EVIDENCE_FIELDS = new Set(["schemaVersion", "parserVersion", "exitCode", "signals", "structuredEvents", "outputRef"]);
const CLASSIFICATION_FIELDS = new Set(["schemaVersion", "policyVersion", "evidenceDigest", "category", "ownership", "retryable", "sourceMutationPermission", "confidence", "reasonCodes", "authorizesSourceMutation", "outputRef"]);
const OUTPUT_FIELDS = new Set(["sha256", "chars", "truncated", "captureRef"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function exact(value: Record<string, unknown>, fields: Set<string>, label: string): string[] {
  return [...Object.keys(value).filter((field) => !fields.has(field)).map((field) => `${label} has unknown field: ${field}`), ...[...fields].filter((field) => !(field in value)).map((field) => `${label} missing field: ${field}`)];
}
function uniqueEnum(value: unknown, allowed: readonly string[], max: number, allowEmpty = true): boolean {
  return Array.isArray(value) && value.length <= max && (allowEmpty || value.length > 0) && new Set(value).size === value.length && value.every((item) => typeof item === "string" && allowed.includes(item));
}
function outputRefErrors(input: unknown): string[] {
  const value = record(input);
  if (!value) return ["outputRef must be an object"];
  const errors = exact(value, OUTPUT_FIELDS, "outputRef");
  if (typeof value.sha256 !== "string" || !HASH.test(value.sha256)) errors.push("outputRef.sha256 must be sha256 hex");
  if (!Number.isInteger(value.chars) || Number(value.chars) < 0 || Number(value.chars) > 1_000_000_000) errors.push("outputRef.chars is invalid");
  if (typeof value.truncated !== "boolean") errors.push("outputRef.truncated must be boolean");
  if (value.captureRef !== null && (typeof value.captureRef !== "string" || !CAPTURE.test(value.captureRef))) errors.push("outputRef.captureRef is invalid");
  return errors;
}

export function failureOutputRef(output: unknown, options: { captureRef?: string | null; truncated?: boolean } = {}): FailureOutputRef {
  const text = String(output ?? "");
  return { sha256: crypto.createHash("sha256").update(text).digest("hex"), chars: text.length, truncated: options.truncated === true, captureRef: options.captureRef ?? null };
}
export function failureEvidenceDigest(evidence: FailureEvidence): string {
  return crypto.createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}
export function failureEvidenceValidationErrors(input: unknown): string[] {
  const value = record(input);
  if (!value) return ["failure evidence must be an object"];
  const errors = exact(value, EVIDENCE_FIELDS, "failure evidence");
  if (value.schemaVersion !== FAILURE_SCHEMA_VERSION || value.parserVersion !== FAILURE_PARSER_VERSION) errors.push("failure evidence version is invalid");
  if (!Number.isInteger(value.exitCode) || Number(value.exitCode) < 0 || Number(value.exitCode) > 255) errors.push("exitCode is invalid");
  if (!uniqueEnum(value.signals, FAILURE_REASON_CODES, 16)) errors.push("signals are invalid");
  if (!uniqueEnum(value.structuredEvents, FAILURE_STRUCTURED_EVENTS, 16)) errors.push("structuredEvents are invalid");
  errors.push(...outputRefErrors(value.outputRef));
  return errors;
}
export function validateFailureEvidence(input: unknown, source = "failure evidence"): FailureEvidence {
  const errors = failureEvidenceValidationErrors(input);
  if (errors.length) throw new Error(`${source}: ${errors.join("; ")}`);
  return input as FailureEvidence;
}
export function failureClassificationValidationErrors(input: unknown): string[] {
  const value = record(input);
  if (!value) return ["failure classification must be an object"];
  const errors = exact(value, CLASSIFICATION_FIELDS, "failure classification");
  if (value.schemaVersion !== FAILURE_SCHEMA_VERSION || value.policyVersion !== FAILURE_POLICY_VERSION) errors.push("failure classification version is invalid");
  if (typeof value.evidenceDigest !== "string" || !HASH.test(value.evidenceDigest)) errors.push("evidenceDigest must be sha256 hex");
  if (!FAILURE_CATEGORIES.includes(value.category as FailureCategory)) errors.push("category is invalid");
  if (!FAILURE_OWNERS.includes(value.ownership as FailureOwner)) errors.push("ownership is invalid");
  if (typeof value.retryable !== "boolean") errors.push("retryable must be boolean");
  if (!["eligible-in-scope", "conditional", "forbidden"].includes(String(value.sourceMutationPermission))) errors.push("sourceMutationPermission is invalid");
  if (!["low", "medium", "high"].includes(String(value.confidence))) errors.push("confidence is invalid");
  if (!uniqueEnum(value.reasonCodes, FAILURE_REASON_CODES, 16, false)) errors.push("reasonCodes are invalid");
  if (value.authorizesSourceMutation !== false) errors.push("classification cannot authorize source mutation");
  errors.push(...outputRefErrors(value.outputRef));
  if (["environment", "provider-network", "permission-policy", "scope-protected-path", "flaky-infrastructure", "unknown", "passed"].includes(String(value.category)) && value.sourceMutationPermission !== "forbidden") errors.push("non-source failure cannot permit source mutation");
  return errors;
}
export function validateFailureClassification(input: unknown, source = "failure classification"): FailureClassification {
  const errors = failureClassificationValidationErrors(input);
  if (errors.length) throw new Error(`${source}: ${errors.join("; ")}`);
  return input as FailureClassification;
}
