import crypto from "node:crypto";
import type { AuthenticatedModelCatalog, AuthenticatedModelCatalogEntry } from "../model/authenticated-catalog.ts";
import type { RuntimeModelSnapshot } from "../model/runtime-snapshot.ts";
import type { SolverDecision, TaskFeatures } from "../solver/solver-types.ts";
import type { HelperRole, RolePolicy } from "./role-policy.ts";
import { validateRolePolicy } from "./role-policy.ts";

export const ROLE_BINDER_VERSION = "role-binder-v1" as const;
export const PROVIDER_ROLE_MAPPING_VERSION = "openai-codex-role-map-v1" as const;
export type RoleBinding = {
  version: typeof ROLE_BINDER_VERSION; mappingVersion: typeof PROVIDER_ROLE_MAPPING_VERSION; role: HelperRole;
  disposition: "recommended" | "unavailable" | "parent-no-helper"; provider: string | null; modelId: string | null; effort: string | null;
  parentPreserved: true; reasonCodes: string[]; bindingDigest: string;
};

const ROLE_CANDIDATES: Record<HelperRole, Array<{ tier: "luna" | "terra" | "sol"; effort: string }>> = {
  retriever: [{ tier: "luna", effort: "low" }, { tier: "luna", effort: "medium" }],
  scout: [{ tier: "luna", effort: "medium" }],
  planner: [{ tier: "terra", effort: "high" }],
  worker: [{ tier: "terra", effort: "medium" }],
  reviewer: [{ tier: "terra", effort: "high" }],
  oracle: [{ tier: "sol", effort: "xhigh" }, { tier: "sol", effort: "high" }],
  researcher: [{ tier: "terra", effort: "medium" }]
};

function digest(value: unknown): string { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function tier(entry: AuthenticatedModelCatalogEntry, expected: string): boolean { return new RegExp(`(?:^|[-_/])${expected}(?:$|[-_/])`, "i").test(entry.modelId); }
function result(role: HelperRole, disposition: RoleBinding["disposition"], parent: RuntimeModelSnapshot, reasonCodes: string[], model?: AuthenticatedModelCatalogEntry, effort?: string): RoleBinding {
  const base = { version: ROLE_BINDER_VERSION, mappingVersion: PROVIDER_ROLE_MAPPING_VERSION, role, disposition, provider: model?.provider ?? null, modelId: model?.modelId ?? null, effort: effort ?? null, parentPreserved: true as const, reasonCodes };
  return { ...base, bindingDigest: digest(base) };
}

export function bindRole(input: { policy: RolePolicy; features: TaskFeatures; solver: SolverDecision; runtime: RuntimeModelSnapshot; catalog: AuthenticatedModelCatalog; helperBudgetAvailable: boolean; workerExplicitlyEnabled?: boolean }): RoleBinding {
  const policy = validateRolePolicy(input.policy); const parent = input.runtime;
  if (!input.helperBudgetAvailable) return result(policy.role, "parent-no-helper", parent, ["helper-budget-unavailable"]);
  if (input.features.riskLane === "tiny") return result(policy.role, "parent-no-helper", parent, ["tiny-task-solo"]);
  if (policy.role === "worker" && !input.workerExplicitlyEnabled) return result(policy.role, "parent-no-helper", parent, ["worker-disabled-default"]);
  if (input.features.externalAction || input.features.destructiveAction || input.features.permissionExpansion) return result(policy.role, "parent-no-helper", parent, ["approval-action-not-delegated"]);
  if (input.catalog.availability !== "authenticated") return result(policy.role, "unavailable", parent, ["authenticated-catalog-unavailable"]);
  for (const candidate of ROLE_CANDIDATES[policy.role]) {
    const matches = input.catalog.models.filter((model) => tier(model, candidate.tier));
    for (const model of matches) {
      if (model.supportedThinkingLevels !== null && !model.supportedThinkingLevels.includes(candidate.effort)) continue;
      return result(policy.role, "recommended", parent, [`role-${policy.role}`, `tier-${candidate.tier}`, "runtime-catalog-match"], model, candidate.effort);
    }
  }
  return result(policy.role, "unavailable", parent, ["preferred-model-or-effort-unavailable", "parent-preserved-no-substitution"]);
}
