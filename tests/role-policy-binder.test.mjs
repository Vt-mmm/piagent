import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHelperRequest, defaultRolePolicy, helperRequestValidationErrors, rolePolicyValidationErrors } from "../packages/piagent-core/runtime/orchestration/role-policy.ts";
import { bindRole } from "../packages/piagent-core/runtime/orchestration/role-binder.ts";

const features = { schemaVersion: 1, featureHash: "a".repeat(64), workflowIntent: "implement", changeMode: "source-change", riskLane: "normal", riskSignals: [], ambiguity: "low", explicitPathCount: 1, scopeEstimate: "bounded", profileMode: null, projectShape: [], gitReady: true, dirtyTree: false, verifierReady: true, contextPressure: 0.2, activeTaskState: "pending", runtimeSnapshotDigest: null, runtimeCapabilitiesKnown: true, userPinnedProvider: "openai-codex", userPinnedModel: "gpt-5.6-sol", userPinnedEffort: "high", protectedTarget: false, externalAction: false, destructiveAction: false, permissionExpansion: false };
const solver = { helper: { needed: true, role: "planner" }, route: "plan-first" };
const runtime = { provider: "openai-codex", modelId: "gpt-5.6-sol", effectiveThinkingLevel: "high", availability: "authenticated" };
const catalog = { availability: "authenticated", models: [{ provider: "openai-codex", modelId: "gpt-5.6-terra", supportedThinkingLevels: ["medium", "high"] }] };

describe("role policy and deterministic binder", () => {
  it("keeps read-only roles free of mutation tools and worker disabled", () => {
    for (const role of ["retriever", "scout", "planner", "reviewer", "oracle", "researcher"]) assert.deepEqual(rolePolicyValidationErrors(defaultRolePolicy(role)), []);
    const worker = defaultRolePolicy("worker"); assert.equal(worker.enabledByDefault, false); assert.equal(worker.authority, "single-writer");
  });
  it("refuses helper scope/tool broadening and requires writer ownership", () => {
    const policy = defaultRolePolicy("scout", ["src/**"]);
    assert.throws(() => createHelperRequest({ policy, objective: "Map source", taskId: "t-1", taskRunId: "t-1-r-1", sessionId: "secret", parentReadScope: ["docs/**"], parentWriteScope: [], parentAllowedTools: ["read", "grep", "find", "ls"] }), /broaden parent scope/);
    const request = createHelperRequest({ policy, objective: "Map source", taskId: "t-1", taskRunId: "t-1-r-1", sessionId: "secret", parentReadScope: ["src/**"], parentWriteScope: [], parentAllowedTools: ["read", "grep", "find", "ls"] });
    assert.deepEqual(helperRequestValidationErrors(request), []); assert.equal(JSON.stringify(request).includes("secret"), false);
    for (const requestedReadScope of [["src/../.env"], ["/tmp/outside"], ["src/**", "docs/**"]]) {
      assert.throws(() => createHelperRequest({ policy, objective: "Map source", taskId: "t-1", taskRunId: "t-1-r-1", sessionId: "secret", parentReadScope: ["src/**"], parentWriteScope: [], parentAllowedTools: ["read", "grep", "find", "ls"], requestedReadScope }), /broaden parent scope/);
    }
    const narrowed = createHelperRequest({ policy, objective: "Map one source", taskId: "t-1", taskRunId: "t-1-r-1", sessionId: "secret", parentReadScope: ["src/**"], parentWriteScope: [], parentAllowedTools: ["read", "grep", "find", "ls"], requestedReadScope: ["src/feature/**"] });
    assert.deepEqual(narrowed.readScope, ["src/feature/**"]);
  });
  it("binds only exact authenticated candidates and preserves the pinned parent", () => {
    const input = { policy: defaultRolePolicy("planner"), features, solver, runtime, catalog, helperBudgetAvailable: true };
    const first = bindRole(input); const second = bindRole(input);
    assert.deepEqual(first, second); assert.equal(first.disposition, "recommended"); assert.equal(first.modelId, "gpt-5.6-terra"); assert.equal(first.parentPreserved, true);
    const missing = bindRole({ ...input, catalog: { availability: "authenticated", models: [] } });
    assert.equal(missing.disposition, "unavailable"); assert.equal(missing.modelId, null); assert.ok(missing.reasonCodes.includes("parent-preserved-no-substitution"));
  });
  it("never delegates approvals and keeps worker off unless explicit", () => {
    assert.equal(bindRole({ policy: defaultRolePolicy("worker"), features, solver, runtime, catalog, helperBudgetAvailable: true }).disposition, "parent-no-helper");
    assert.equal(bindRole({ policy: defaultRolePolicy("planner"), features: { ...features, externalAction: true }, solver, runtime, catalog, helperBudgetAvailable: true }).disposition, "parent-no-helper");
  });
});
