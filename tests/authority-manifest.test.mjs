import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  AUTHORITY_PROFILE_IDS,
  AUTHORITY_VALUES,
  CAPABILITY_IDS,
  authorityManifestDigest,
  authorityManifestValidationErrors,
  createTaskAuthoritySnapshot,
  inspectAuthoritySnapshotCompatibility,
  loadBundledAuthorityManifest,
  migrateLegacyFeatureModes,
  taskAuthoritySnapshotValidationErrors,
  validateAuthorityManifest,
  validateTaskAuthoritySnapshot
} from "../packages/piagent-core/runtime/policy/authority-manifest.ts";
import { parentRoutingModeFromEnvironment } from "../packages/piagent-core/runtime/model/model-route-policy.ts";
import { helpersMode } from "../packages/piagent-core/runtime/orchestration/helper-lifecycle.ts";
import { solverModeFromEnvironment } from "../packages/piagent-core/runtime/solver/solver-shadow.ts";
import { phaseToolModeFromEnvironment } from "../packages/piagent-core/runtime/tools/phase-tool-runtime.ts";
import {
  createBoundTaskAuthority,
  createEnvironmentBoundTaskAuthority,
  taskAuthorityDecision,
  taskAuthorityMode,
  taskAuthorityProfileFromEnvironment
} from "../packages/piagent-core/runtime/policy/task-authority-runtime.ts";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(repositoryRoot, "packages", "piagent-core", "policy", "authority-manifest.v1.json");
const constitutionPath = path.join(repositoryRoot, "governance", "codex-first-product", "evidence", "fs0", "capability-constitution.v1.json");
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(repositoryRoot, "evals", "fixtures", name), "utf8"));

function recursivelyReverseKeys(value) {
  if (Array.isArray(value)) return value.map(recursivelyReverseKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, recursivelyReverseKeys(child)]));
}

function capability(snapshot, id) {
  return snapshot.capabilities.find((entry) => entry.id === id);
}

describe("versioned capability authority manifest", () => {
  it("closes all seventeen capability owners, targets, modes, dependencies, budgets, provenance and profiles", () => {
    const manifest = loadBundledAuthorityManifest();
    const constitution = JSON.parse(fs.readFileSync(constitutionPath, "utf8"));
    const constitutionDigest = crypto.createHash("sha256").update(fs.readFileSync(constitutionPath)).digest("hex");
    assert.equal(Object.isFrozen(manifest), true);
    assert.deepEqual(manifest.authorityVocabulary, [...AUTHORITY_VALUES]);
    assert.deepEqual(manifest.profiles.map((profile) => profile.id), [...AUTHORITY_PROFILE_IDS]);
    assert.deepEqual(manifest.capabilities.map((entry) => entry.id), [...CAPABILITY_IDS]);
    assert.equal(manifest.sourceProvenance.constitutionSha256, constitutionDigest);
    assert.equal(new Set(manifest.capabilities.map((entry) => entry.owner)).size, 17);
    assert.equal(new Set(manifest.capabilities.map((entry) => entry.configKey)).size, 17);
    assert.deepEqual(new Set(manifest.capabilities.flatMap((entry) => entry.modeMappings.map((mapping) => mapping.authority))), new Set(AUTHORITY_VALUES));
    for (const [index, entry] of manifest.capabilities.entries()) {
      const source = constitution.capabilities[index];
      assert.equal(entry.owner, source.owner, `${entry.id} owner must stay constitution-bound`);
      assert.equal(entry.constitutionTargetMode, source.targetMode, `${entry.id} target mode must stay provenance-bound`);
      assert.equal(entry.constitutionTargetAuthority, source.targetAuthority, `${entry.id} target authority must stay provenance-bound`);
      assert.equal(entry.modeMappings.some((mapping) => mapping.value === entry.defaultMode), true);
      assert.equal(entry.modeMappings.some((mapping) => mapping.value === entry.killSwitchMode), true);
    }
    assert.equal(manifest.globalBudgets.maxSystemContinuationsPerTask, 1);
    assert.equal(manifest.globalBudgets.maxAutomaticDispatchesPerTask, 1);
    assert.equal(manifest.globalBudgets.maxSpecialistReviewRoundsPerTask, 1);
    const configuredSources = new Set(manifest.capabilities.flatMap((entry) => entry.configSources));
    for (const source of [
      "PIAGENT_AUTO_CONTEXT",
      "PIAGENT_DYNAMIC_TOOLS",
      "PIAGENT_LOCAL_RERANKER",
      "PIAGENT_SOLVER_MODE",
      "PIAGENT_RUNTIME_SNAPSHOT",
      "PIAGENT_PHASE_TOOLS",
      "PIAGENT_ACCEPTANCE_ASSURANCE",
      "PIAGENT_AUTO_RECOVERY",
      "PIAGENT_SEMANTIC_REPAIR",
      "PIAGENT_HELPERS_MODE",
      "PIAGENT_PARENT_ROUTING",
      "PIAGENT_CONTEXT_TELEMETRY"
    ]) assert.equal(configuredSources.has(source), true, `${source} must be provenance-bound`);
    assert.equal([...configuredSources].some((source) => /benchmark|scenario|grader/i.test(source)), false);
  });

  it("uses a domain-separated canonical digest independent of JSON object-key order", () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const reversed = recursivelyReverseKeys(manifest);
    assert.doesNotThrow(() => validateAuthorityManifest(reversed));
    assert.equal(authorityManifestDigest(reversed), authorityManifestDigest(manifest));
    const changed = structuredClone(manifest);
    changed.capabilities[7].owner = "different-owner";
    assert.notEqual(authorityManifestDigest(changed), authorityManifestDigest(manifest));
  });

  it("creates a deterministic deeply immutable broad-default task snapshot", () => {
    const input = { taskId: "task-authority", taskRunId: "run-authority", capturedAt: "2026-08-10T01:02:03.000Z" };
    const first = createTaskAuthoritySnapshot(input), second = createTaskAuthoritySnapshot(input);
    assert.deepEqual(first, second);
    assert.equal(Object.isFrozen(first), true);
    assert.equal(Object.isFrozen(first.capabilities), true);
    assert.equal(Object.isFrozen(first.capabilities[0].budgets), true);
    assert.equal(first.capabilities.length, 17);
    assert.deepEqual(first.resolution, { source: "profile", modeOverrides: {} });
    assert.match(first.manifestDigest, /^sha256:[a-f0-9]{64}$/);
    assert.match(first.snapshotDigest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(capability(first, "CAP-08").authority, "observe");
    assert.equal(capability(first, "CAP-09").authority, "observe");
    assert.equal(capability(first, "CAP-11").authority, "observe");
    assert.equal(capability(first, "CAP-12").authority, "enforce");
    assert.equal(capability(first, "CAP-12").budgets.systemContinuations, 1);
    assert.equal(capability(first, "CAP-13").authority, "off");
    assert.equal(capability(first, "CAP-14").authority, "advise");
    assert.equal(capability(first, "CAP-15").authority, "off");
    assert.throws(() => { first.capabilities[0].mode = "off"; }, TypeError);
    assert.notEqual(createTaskAuthoritySnapshot({ ...input, capturedAt: "2026-08-10T01:02:04.000Z" }).snapshotDigest, first.snapshotDigest);
    assert.doesNotThrow(() => validateTaskAuthoritySnapshot(first));
  });

  it("keeps mechanical rollback and strict high-risk authority explicit without widening the broad default", () => {
    const common = { taskId: "task-profiles", taskRunId: "run-profiles", capturedAt: "2026-08-10T02:00:00.000Z" };
    const broad = createTaskAuthoritySnapshot(common);
    const strict = createTaskAuthoritySnapshot({ ...common, profile: "strict-high-risk" });
    const mechanical = createTaskAuthoritySnapshot({ ...common, profile: "mechanical-only" });
    assert.equal(capability(strict, "CAP-09").mode, "strict");
    assert.equal(capability(strict, "CAP-09").authority, "enforce");
    assert.equal(capability(strict, "CAP-13").mode, "strict");
    assert.equal(capability(strict, "CAP-13").budgets.reviewRounds, 1);
    for (const id of ["CAP-07", "CAP-08", "CAP-09", "CAP-10", "CAP-11", "CAP-12", "CAP-13", "CAP-14", "CAP-15"]) {
      assert.equal(capability(mechanical, id).authority, "off", `${id} must be off in mechanical-only`);
    }
    for (const id of ["CAP-01", "CAP-02", "CAP-03", "CAP-04", "CAP-05", "CAP-06"]) assert.equal(capability(mechanical, id).authority, "enforce");
    assert.equal(capability(broad, "CAP-13").authority, "off", "strict enforcement must remain opt-in");
    assert.equal(capability(broad, "CAP-15").authority, "off", "parent orchestration must remain off");
  });

  it("rejects overrides that are unknown, unsupported, or break an active dependency", () => {
    const base = { taskId: "task-override", taskRunId: "run-override", capturedAt: "2026-08-10T03:00:00.000Z" };
    assert.throws(() => createTaskAuthoritySnapshot({ ...base, modeOverrides: { "CAP-99": "off" } }), /unknown capability overrides/);
    assert.throws(() => createTaskAuthoritySnapshot({ ...base, modeOverrides: { "CAP-08": "strict" } }), /does not support mode/);
    assert.throws(() => createTaskAuthoritySnapshot({ ...base, modeOverrides: { "CAP-08": "off" } }), /CAP-14 cannot activate while dependency CAP-08 is off/);
    assert.throws(() => createTaskAuthoritySnapshot({ ...base, modeOverrides: { "CAP-01": "off" } }), /does not support mode/);
  });

  it("rejects cross-feature authority and budget combinations that exceed their dependencies", () => {
    const base = { taskId: "task-interactions", taskRunId: "run-interactions", capturedAt: "2026-08-10T03:30:00.000Z" };
    assert.throws(() => createTaskAuthoritySnapshot({
      ...base,
      profile: "strict-high-risk",
      modeOverrides: { "CAP-09": "shadow" }
    }), /CAP-13 strict enforcement requires CAP-09 enforcement/);
    assert.throws(() => createTaskAuthoritySnapshot({
      ...base,
      modeOverrides: { "CAP-14": "on", "CAP-15": "auto" }
    }), /combined automatic dispatch budget exceeds the task-global ceiling/);
    assert.doesNotThrow(() => createTaskAuthoritySnapshot({ ...base, modeOverrides: { "CAP-15": "auto" } }));
  });

  it("migrates only the closed historical feature-mode surface for a new task", () => {
    const migration = migrateLegacyFeatureModes({ solver: "assist", phaseTools: "on", recovery: "on", helpers: "recommend", parentRouting: "off", executionBackend: "host" });
    assert.deepEqual(migration, {
      profile: "broad-default",
      modeOverrides: { "CAP-08": "assist", "CAP-09": "on", "CAP-12": "on", "CAP-14": "recommend", "CAP-15": "off" },
      resolutionSource: "legacy-feature-modes-v0"
    });
    const snapshot = createTaskAuthoritySnapshot({ taskId: "task-migrated", taskRunId: "run-migrated", capturedAt: "2026-08-10T04:00:00.000Z", ...migration });
    assert.deepEqual(snapshot.resolution, {
      source: "legacy-feature-modes-v0",
      modeOverrides: { "CAP-08": "assist", "CAP-09": "on", "CAP-12": "on", "CAP-14": "recommend", "CAP-15": "off" }
    });
    assert.equal(capability(snapshot, "CAP-08").authority, "advise");
    assert.equal(capability(snapshot, "CAP-09").authority, "enforce");
    assert.throws(() => migrateLegacyFeatureModes({ solver: "strict" }), /does not support mode/);
    assert.throws(() => migrateLegacyFeatureModes({ executionBackend: "docker" }), /must remain host/);
    assert.throws(() => migrateLegacyFeatureModes({ hiddenMode: "on" }), /unknown keys/);
  });

  it("fails closed for unknown versions, manifest drift, or snapshot tampering", () => {
    const snapshot = createTaskAuthoritySnapshot({ taskId: "task-compat", taskRunId: "run-compat", capturedAt: "2026-08-10T05:00:00.000Z" });
    assert.deepEqual(inspectAuthoritySnapshotCompatibility(snapshot), { disposition: "resume-pinned", reason: "compatible" });
    const unknownSnapshot = structuredClone(snapshot); unknownSnapshot.snapshotVersion = "task-authority-snapshot-v2";
    assert.deepEqual(inspectAuthoritySnapshotCompatibility(unknownSnapshot), { disposition: "new-task-required", reason: "unknown-snapshot-version" });
    const unknownManifest = structuredClone(snapshot); unknownManifest.manifestVersion = "authority-v2";
    assert.deepEqual(inspectAuthoritySnapshotCompatibility(unknownManifest), { disposition: "new-task-required", reason: "unknown-manifest-version" });
    const mismatched = structuredClone(snapshot); mismatched.manifestDigest = `sha256:${"f".repeat(64)}`;
    assert.deepEqual(inspectAuthoritySnapshotCompatibility(mismatched), { disposition: "new-task-required", reason: "manifest-digest-mismatch" });
    const unboundOverride = structuredClone(snapshot); unboundOverride.capabilities[7].mode = "recommend";
    unboundOverride.capabilities[7].authority = "advise";
    unboundOverride.snapshotDigest = `sha256:${"0".repeat(64)}`;
    assert.match(taskAuthoritySnapshotValidationErrors(unboundOverride).join("; "), /profile resolution/);
    const tampered = structuredClone(snapshot); tampered.capabilities[7].authority = "orchestrate";
    assert.deepEqual(inspectAuthoritySnapshotCompatibility(tampered), { disposition: "new-task-required", reason: "invalid-snapshot" });
  });

  it("does not mutate a pinned active snapshot when a later task selects mechanical rollback", () => {
    const common = { taskId: "task-pinned", taskRunId: "run-pinned", capturedAt: "2026-08-10T06:00:00.000Z" };
    const pinned = createTaskAuthoritySnapshot({ ...common, profile: "strict-high-risk" });
    const bytes = JSON.stringify(pinned);
    const rollback = createTaskAuthoritySnapshot({ ...common, taskRunId: "run-rollback", profile: "mechanical-only" });
    assert.equal(JSON.stringify(pinned), bytes);
    assert.equal(inspectAuthoritySnapshotCompatibility(pinned).disposition, "resume-pinned");
    assert.notEqual(rollback.snapshotDigest, pinned.snapshotDigest);
    assert.equal(capability(rollback, "CAP-13").authority, "off");
  });

  it("rejects malformed manifests and snapshots adversarially", () => {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const unknown = structuredClone(manifest); unknown.extra = true;
    assert.match(authorityManifestValidationErrors(unknown).join("; "), /unknown field/);
    const cycle = structuredClone(manifest); cycle.capabilities[0].dependencies = ["CAP-13"];
    assert.match(authorityManifestValidationErrors(cycle).join("; "), /cycle/);
    const budget = structuredClone(manifest); budget.capabilities[7].modeMappings[1].budgets.systemContinuations = 1;
    assert.match(authorityManifestValidationErrors(budget).join("; "), /non-enforcing authority/);
    const profile = structuredClone(manifest); delete profile.profiles[0].modes["CAP-17"];
    assert.match(authorityManifestValidationErrors(profile).join("; "), /exactly CAP-01 through CAP-17/);
    assert.throws(() => validateAuthorityManifest(fixture("authority-manifest.invalid.json")), /Invalid authority manifest/);
    assert.throws(() => validateTaskAuthoritySnapshot(fixture("task-authority-snapshot.invalid.json")), /Invalid task authority snapshot/);
    const validSnapshot = fixture("task-authority-snapshot.valid.json");
    assert.deepEqual(taskAuthoritySnapshotValidationErrors(validSnapshot), []);
  });

  it("preserves closed legacy mode normalizers while task start captures their output", () => {
    assert.equal(solverModeFromEnvironment("recommend"), "recommend");
    assert.equal(solverModeFromEnvironment("assist"), "shadow");
    assert.equal(phaseToolModeFromEnvironment("on"), "on");
    assert.equal(phaseToolModeFromEnvironment("strict"), "shadow");
    assert.equal(helpersMode("on"), "on");
    assert.equal(parentRoutingModeFromEnvironment("auto"), "auto");
    assert.equal(parentRoutingModeFromEnvironment("orchestrate"), "off");
  });

  it("binds closed cross-mode runtime authority and never lets observe or advise block, mutate, dispatch, or trigger a turn", () => {
    const carrier = (profile) => {
      const task = { taskId: `task-${profile}`, taskRunId: `run-${profile}`, createdAt: "2026-08-10T08:00:00.000Z" };
      return { ...task, authoritySnapshot: createBoundTaskAuthority({ ...task, profile }) };
    };
    const broad = carrier("broad-default"), strict = carrier("strict-high-risk"), mechanical = carrier("mechanical-only");
    for (const entry of broad.authoritySnapshot.capabilities) {
      if (entry.authority !== "observe" && entry.authority !== "advise") continue;
      assert.equal(taskAuthorityDecision(broad, entry.id, "observe").allowed, true, `${entry.id} must remain observable`);
      for (const action of ["block", "mutate", "model-turn", "dispatch"]) {
        assert.equal(taskAuthorityDecision(broad, entry.id, action).allowed, false, `${entry.id} ${entry.authority} must not ${action}`);
      }
    }
    assert.equal(taskAuthorityMode(broad, "CAP-09"), "shadow");
    assert.equal(taskAuthorityDecision(broad, "CAP-09", "observe").allowed, true);
    assert.equal(taskAuthorityDecision(broad, "CAP-09", "block").allowed, false);
    assert.equal(taskAuthorityDecision(broad, "CAP-11", "model-turn").allowed, false);
    assert.equal(taskAuthorityDecision(broad, "CAP-13", "mutate").allowed, false);
    assert.equal(taskAuthorityDecision(broad, "CAP-14", "advise").allowed, true);
    assert.equal(taskAuthorityDecision(broad, "CAP-14", "dispatch").allowed, false);
    assert.equal(taskAuthorityDecision(broad, "CAP-12", "model-turn").allowed, true);
    assert.equal(taskAuthorityDecision(strict, "CAP-09", "block").allowed, true);
    assert.equal(taskAuthorityDecision(strict, "CAP-13", "block").allowed, true);
    assert.equal(taskAuthorityDecision(strict, "CAP-13", "model-turn").allowed, true);
    assert.equal(taskAuthorityDecision(mechanical, "CAP-12", "model-turn").allowed, false);
  });

  it("fails advanced authority closed for legacy, tampered, or cross-task snapshots while preserving L0 hard invariants", () => {
    const task = { taskId: "task-bound", taskRunId: "run-bound", createdAt: "2026-08-10T09:00:00.000Z" };
    assert.equal(taskAuthorityDecision(task, "CAP-03", "block").allowed, true);
    assert.equal(taskAuthorityDecision(task, "CAP-09", "block").allowed, false);
    assert.equal(taskAuthorityDecision(task, "CAP-12", "model-turn").allowed, false);
    const authoritySnapshot = createBoundTaskAuthority(task);
    const wrongTask = { ...task, taskId: "other-task", authoritySnapshot };
    assert.equal(taskAuthorityDecision(wrongTask, "CAP-03", "block").allowed, true);
    assert.equal(taskAuthorityDecision(wrongTask, "CAP-13", "block").reason, "task-identity-mismatch");
    const tampered = structuredClone(authoritySnapshot); tampered.capabilities[8].authority = "enforce";
    assert.equal(taskAuthorityDecision({ ...task, authoritySnapshot: tampered }, "CAP-09", "block").reason, "invalid-task-snapshot");
  });

  it("selects only closed task authority profiles from operator environment input", () => {
    assert.equal(taskAuthorityProfileFromEnvironment("strict-high-risk"), "strict-high-risk");
    assert.equal(taskAuthorityProfileFromEnvironment("mechanical-only"), "mechanical-only");
    assert.equal(taskAuthorityProfileFromEnvironment("unknown"), "broad-default");
    assert.equal(taskAuthorityProfileFromEnvironment(undefined), "broad-default");
    const task = { taskId: "task-environment", taskRunId: "run-environment", createdAt: "2026-08-10T10:00:00.000Z" };
    const captured = createEnvironmentBoundTaskAuthority(task, { PIAGENT_PHASE_TOOLS: "on", PIAGENT_AUTO_RECOVERY: "off", PIAGENT_HELPERS_MODE: "recommend" });
    assert.equal(captured.resolution.source, "explicit-overrides");
    assert.equal(capability(captured, "CAP-09").authority, "enforce");
    assert.equal(capability(captured, "CAP-12").authority, "off");
    assert.equal(capability(captured, "CAP-13").authority, "off");
    assert.equal(capability(captured, "CAP-14").authority, "advise");
    const mechanical = createEnvironmentBoundTaskAuthority({ ...task, taskRunId: "run-mechanical" }, {
      PIAGENT_AUTHORITY_PROFILE: "mechanical-only",
      PIAGENT_PHASE_TOOLS: "on",
      PIAGENT_AUTO_RECOVERY: "on",
      PIAGENT_SOLVER_MODE: "recommend",
      PIAGENT_AUTO_CONTEXT: "0"
    });
    assert.equal(capability(mechanical, "CAP-05").authority, "off", "explicit off remains a valid mechanical kill switch");
    for (const capabilityId of ["CAP-08", "CAP-09", "CAP-12", "CAP-13", "CAP-14", "CAP-15"]) {
      assert.equal(capability(mechanical, capabilityId).authority, "off", `${capabilityId} cannot be re-enabled above the mechanical ceiling`);
    }
    const independent = createEnvironmentBoundTaskAuthority({ ...task, taskRunId: "run-independent", profile: "strict-high-risk" }, {
      PIAGENT_ACCEPTANCE_ASSURANCE: "off",
      PIAGENT_SEMANTIC_REPAIR: "off"
    });
    assert.equal(capability(independent, "CAP-09").authority, "enforce");
    assert.equal(capability(independent, "CAP-11").authority, "off");
    assert.equal(capability(independent, "CAP-12").authority, "enforce");
    assert.equal(capability(independent, "CAP-13").authority, "off");
    const noPromotion = createEnvironmentBoundTaskAuthority({ ...task, taskRunId: "run-no-promotion" }, {
      PIAGENT_ACCEPTANCE_ASSURANCE: "recommend",
      PIAGENT_SEMANTIC_REPAIR: "strict"
    });
    assert.equal(capability(noPromotion, "CAP-11").mode, "advisory");
    assert.equal(capability(noPromotion, "CAP-13").mode, "off");
  });
});
