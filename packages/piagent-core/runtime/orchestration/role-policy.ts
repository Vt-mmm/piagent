import crypto from "node:crypto";
import { globMatchesPath, normalizePathCandidate } from "../../extensions/policy-core.js";

export const ROLE_POLICY_SCHEMA_VERSION = 1 as const;
export const ROLE_POLICY_VERSION = "role-policy-v1" as const;
export const HELPER_REQUEST_SCHEMA_VERSION = 1 as const;
export const HELPER_ROLES = Object.freeze(["retriever", "scout", "planner", "worker", "reviewer", "oracle", "researcher"] as const);
export type HelperRole = typeof HELPER_ROLES[number];
export type HelperAuthority = "read-only" | "single-writer";
export type RolePolicy = {
  schemaVersion: 1; policyVersion: typeof ROLE_POLICY_VERSION; role: HelperRole; authority: HelperAuthority;
  enabledByDefault: boolean; readScope: string[]; writeScope: string[]; allowedTools: string[];
  modelSelectionSource: "runtime-catalog" | "parent"; effortSelectionSource: "runtime-snapshot" | "parent";
  contextBudget: number; ceilings: { timeSeconds: number; calls: number; retries: number };
  outputSchema: string; stoppingRule: string; approvalRestrictions: string[];
};
export type HelperRequest = {
  schemaVersion: 1; policyVersion: typeof ROLE_POLICY_VERSION; role: HelperRole; objectiveHash: string; objectiveText: string;
  taskId: string; taskRunId: string; sessionHash: string; authority: HelperAuthority; readScope: string[]; writeScope: string[];
  allowedTools: string[]; model: { provider: string; modelId: string; effort: string; source: string } | null;
  contextBudget: number; ceilings: { timeSeconds: number; calls: number; retries: number }; outputSchema: string;
  stoppingRule: string; approvalRestrictions: string[]; parentAuthorityDigest: string; singleWriterOwnership: string | null;
  deduplicationKey: string;
};

const READ_TOOLS = ["read", "grep", "find", "ls"];
const MUTATION_TOOLS = new Set(["edit", "write", "apply_patch", "bash", "contact_supervisor"]);
const HASH = /^[a-f0-9]{64}$/;
const REF = /^[a-z0-9][a-z0-9:._/-]{0,255}$/i;
const ROLE_FIELDS = new Set(["schemaVersion", "policyVersion", "role", "authority", "enabledByDefault", "readScope", "writeScope", "allowedTools", "modelSelectionSource", "effortSelectionSource", "contextBudget", "ceilings", "outputSchema", "stoppingRule", "approvalRestrictions"]);
const REQUEST_FIELDS = new Set(["schemaVersion", "policyVersion", "role", "objectiveHash", "objectiveText", "taskId", "taskRunId", "sessionHash", "authority", "readScope", "writeScope", "allowedTools", "model", "contextBudget", "ceilings", "outputSchema", "stoppingRule", "approvalRestrictions", "parentAuthorityDigest", "singleWriterOwnership", "deduplicationKey"]);

function object(value: unknown): Record<string, any> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined; }
function exact(value: Record<string, any>, fields: Set<string>, label: string): string[] { return [...Object.keys(value).filter((field) => !fields.has(field)).map((field) => `${label} unknown field: ${field}`), ...[...fields].filter((field) => !(field in value)).map((field) => `${label} missing field: ${field}`)]; }
function strings(value: unknown, max: number, itemMax = 300): value is string[] { return Array.isArray(value) && value.length <= max && new Set(value).size === value.length && value.every((item) => typeof item === "string" && item.length > 0 && item.length <= itemMax); }
function ceilings(value: unknown): boolean { const item = object(value); return Boolean(item && exact(item, new Set(["timeSeconds", "calls", "retries"]), "ceilings").length === 0 && Number.isInteger(item.timeSeconds) && item.timeSeconds >= 1 && item.timeSeconds <= 3600 && Number.isInteger(item.calls) && item.calls >= 1 && item.calls <= 100 && Number.isInteger(item.retries) && item.retries >= 0 && item.retries <= 3); }
function digest(value: unknown): string { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function boundedObjective(value: unknown): string { return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 1000); }
function safeScopePattern(value: string): boolean {
  const normalized = normalizePathCandidate(value);
  return Boolean(normalized && !/^\/|^[A-Za-z]:\//.test(normalized) && !normalized.split("/").some((part) => part === "." || part === "..") && !/[?\[\]{}\0]/.test(normalized));
}
function scopeCovers(parent: string, child: string): boolean {
  const allowed = normalizePathCandidate(parent), requested = normalizePathCandidate(child);
  if (!safeScopePattern(allowed) || !safeScopePattern(requested)) return false;
  if (allowed === "**" || allowed === requested) return true;
  if (allowed.endsWith("/**")) {
    const prefix = allowed.slice(0, -3); return requested === prefix || requested.startsWith(`${prefix}/`);
  }
  return !requested.includes("*") && globMatchesPath(allowed, requested);
}
function scopeSubset(child: string[], parent: string[]): boolean { return child.every((item) => parent.some((allowed) => scopeCovers(allowed, item))); }

export function rolePolicyValidationErrors(input: unknown): string[] {
  const value = object(input); if (!value) return ["role policy must be an object"];
  const errors = exact(value, ROLE_FIELDS, "role policy");
  if (value.schemaVersion !== 1 || value.policyVersion !== ROLE_POLICY_VERSION || !HELPER_ROLES.includes(value.role)) errors.push("role policy identity is invalid");
  if (!["read-only", "single-writer"].includes(value.authority) || typeof value.enabledByDefault !== "boolean") errors.push("role authority/default is invalid");
  if (!strings(value.readScope, 100) || !strings(value.writeScope, 100) || !strings(value.allowedTools, 32) || !strings(value.approvalRestrictions, 16)) errors.push("role policy collections are invalid");
  if (value.authority === "read-only" && (value.writeScope.length > 0 || value.allowedTools.some((tool: string) => MUTATION_TOOLS.has(tool)))) errors.push("read-only role cannot receive mutation authority");
  if (value.role === "worker" && (value.enabledByDefault || value.authority !== "single-writer")) errors.push("worker must be disabled by default and single-writer");
  if (value.modelSelectionSource !== "runtime-catalog" || !["runtime-snapshot", "parent"].includes(value.effortSelectionSource)) errors.push("selection source is invalid");
  if (!Number.isInteger(value.contextBudget) || value.contextBudget < 256 || value.contextBudget > 100000 || !ceilings(value.ceilings)) errors.push("role budgets are invalid");
  if (typeof value.outputSchema !== "string" || value.outputSchema.length < 3 || value.outputSchema.length > 200 || typeof value.stoppingRule !== "string" || value.stoppingRule.length < 3 || value.stoppingRule.length > 500) errors.push("output/stopping contract is invalid");
  return errors;
}
export function validateRolePolicy(input: unknown): RolePolicy { const errors = rolePolicyValidationErrors(input); if (errors.length) throw new Error(errors.join("; ")); return input as RolePolicy; }

export function helperRequestValidationErrors(input: unknown): string[] {
  const value = object(input); if (!value) return ["helper request must be an object"];
  const errors = exact(value, REQUEST_FIELDS, "helper request");
  if (value.schemaVersion !== 1 || value.policyVersion !== ROLE_POLICY_VERSION || !HELPER_ROLES.includes(value.role) || !HASH.test(String(value.objectiveHash)) || !HASH.test(String(value.sessionHash)) || !HASH.test(String(value.parentAuthorityDigest)) || !HASH.test(String(value.deduplicationKey))) errors.push("helper identity/digests are invalid");
  if (typeof value.objectiveText !== "string" || value.objectiveText.length < 3 || value.objectiveText.length > 1000 || !REF.test(String(value.taskId)) || !REF.test(String(value.taskRunId))) errors.push("helper objective/task identity is invalid");
  if (!["read-only", "single-writer"].includes(value.authority) || !strings(value.readScope, 100) || !strings(value.writeScope, 100) || !value.readScope.every(safeScopePattern) || !value.writeScope.every(safeScopePattern) || !strings(value.allowedTools, 32) || !strings(value.approvalRestrictions, 16)) errors.push("helper authority collections are invalid");
  if (value.authority === "read-only" && (value.writeScope.length > 0 || value.allowedTools.some((tool: string) => MUTATION_TOOLS.has(tool)))) errors.push("read-only helper cannot mutate");
  if (value.role === "worker" && (value.authority !== "single-writer" || typeof value.singleWriterOwnership !== "string" || !REF.test(value.singleWriterOwnership))) errors.push("worker requires explicit single-writer ownership");
  if (value.role !== "worker" && value.singleWriterOwnership !== null) errors.push("read-only helper cannot own a writer lease");
  if (!Number.isInteger(value.contextBudget) || value.contextBudget < 256 || value.contextBudget > 100000 || !ceilings(value.ceilings)) errors.push("helper budgets are invalid");
  if (typeof value.outputSchema !== "string" || value.outputSchema.length > 200 || typeof value.stoppingRule !== "string" || value.stoppingRule.length > 500) errors.push("helper output/stopping contract is invalid");
  const model = value.model === null ? null : object(value.model);
  if (value.model !== null && (!model || exact(model, new Set(["provider", "modelId", "effort", "source"]), "model").length || ![model.provider, model.modelId, model.effort, model.source].every((item) => typeof item === "string" && item.length > 0 && item.length <= 160))) errors.push("helper model binding is invalid");
  return errors;
}
export function validateHelperRequest(input: unknown): HelperRequest { const errors = helperRequestValidationErrors(input); if (errors.length) throw new Error(errors.join("; ")); return input as HelperRequest; }

export function defaultRolePolicy(role: HelperRole, scope: string[] = ["**"]): RolePolicy {
  const readOnly = role !== "worker";
  const policy: RolePolicy = {
    schemaVersion: 1, policyVersion: ROLE_POLICY_VERSION, role, authority: readOnly ? "read-only" : "single-writer",
    enabledByDefault: readOnly, readScope: [...scope], writeScope: [], allowedTools: readOnly ? [...READ_TOOLS] : [...READ_TOOLS, "bash", "edit", "write", "contact_supervisor"],
    modelSelectionSource: "runtime-catalog", effortSelectionSource: "runtime-snapshot", contextBudget: role === "oracle" ? 12000 : role === "reviewer" ? 9000 : 6000,
    ceilings: { timeSeconds: role === "oracle" ? 900 : 600, calls: role === "retriever" ? 20 : 40, retries: 0 },
    outputSchema: `${role}-result-v1`, stoppingRule: "Stop when the bounded objective is answered or evidence is insufficient; return uncertainty.",
    approvalRestrictions: ["no-external-write", "no-destructive-action", "no-permission-expansion"]
  };
  return validateRolePolicy(policy);
}

export function createHelperRequest(input: { policy: RolePolicy; objective: string; taskId: string; taskRunId: string; sessionId: string; parentReadScope: string[]; parentWriteScope: string[]; parentAllowedTools: string[]; requestedReadScope?: string[]; requestedWriteScope?: string[]; model?: HelperRequest["model"]; singleWriterOwnership?: string | null }): HelperRequest {
  const policy = validateRolePolicy(input.policy); const objectiveText = boundedObjective(input.objective);
  const readScope = input.requestedReadScope ?? policy.readScope; const writeScope = input.requestedWriteScope ?? policy.writeScope;
  if (!scopeSubset(readScope, input.parentReadScope) || !scopeSubset(writeScope, input.parentWriteScope)) throw new Error("helper request cannot broaden parent scope");
  if (policy.allowedTools.some((tool) => !input.parentAllowedTools.includes(tool))) throw new Error("helper request cannot broaden parent tools");
  const authority = policy.authority;
  const request: HelperRequest = {
    schemaVersion: 1, policyVersion: ROLE_POLICY_VERSION, role: policy.role, objectiveHash: digest(objectiveText), objectiveText,
    taskId: input.taskId, taskRunId: input.taskRunId, sessionHash: digest(input.sessionId), authority, readScope: [...readScope], writeScope: [...writeScope], allowedTools: [...policy.allowedTools],
    model: input.model ?? null, contextBudget: policy.contextBudget, ceilings: { ...policy.ceilings }, outputSchema: policy.outputSchema, stoppingRule: policy.stoppingRule,
    approvalRestrictions: [...policy.approvalRestrictions], parentAuthorityDigest: digest({ read: input.parentReadScope, write: input.parentWriteScope, tools: input.parentAllowedTools }),
    singleWriterOwnership: input.singleWriterOwnership ?? null, deduplicationKey: digest({ role: policy.role, objective: objectiveText, readScope, writeScope })
  };
  return validateHelperRequest(request);
}
