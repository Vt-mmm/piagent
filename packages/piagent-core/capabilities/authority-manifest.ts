import crypto from "node:crypto";

import bundledManifestJson from "../policy/authority-manifest.v1.json" with { type: "json" };

export const AUTHORITY_MANIFEST_SCHEMA_VERSION = 1 as const;
export const AUTHORITY_MANIFEST_VERSION = "authority-v1" as const;
export const TASK_AUTHORITY_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const TASK_AUTHORITY_SNAPSHOT_VERSION = "task-authority-snapshot-v1" as const;
export const AUTHORITY_VALUES = Object.freeze(["off", "observe", "advise", "enforce", "orchestrate"] as const);
export const AUTHORITY_PROFILE_IDS = Object.freeze(["broad-default", "mechanical-only", "strict-high-risk"] as const);
export const CAPABILITY_IDS = Object.freeze(Array.from({ length: 17 }, (_, index) => `CAP-${String(index + 1).padStart(2, "0")}`));

export type NormalizedAuthority = typeof AUTHORITY_VALUES[number];
export type AuthorityProfileId = typeof AUTHORITY_PROFILE_IDS[number];
export type CapabilityBudget = { systemContinuations: number; automaticDispatches: number; reviewRounds: number };
export type AuthorityModeMapping = { value: string; authority: NormalizedAuthority; budgets: CapabilityBudget };
export type AuthorityCapability = {
  id: string;
  owner: string;
  layer: "L0" | "L1" | "L2" | "L3" | "L4" | "L5";
  configKey: string;
  configSources: string[];
  defaultMode: string;
  killSwitchMode: string;
  dependencies: string[];
  modeMappings: AuthorityModeMapping[];
  constitutionTargetMode: string;
  constitutionTargetAuthority: NormalizedAuthority;
};
export type AuthorityManifest = {
  schemaVersion: typeof AUTHORITY_MANIFEST_SCHEMA_VERSION;
  manifestVersion: typeof AUTHORITY_MANIFEST_VERSION;
  releaseVersion: string;
  status: "pre-release" | "release";
  authorityVocabulary: NormalizedAuthority[];
  sourceProvenance: { decisionDate: string; roadmap: string; constitution: string; constitutionSha256: string; evidenceTier: "local-pre-release" | "release-candidate" };
  globalBudgets: { maxSystemContinuationsPerTask: number; maxAutomaticDispatchesPerTask: number; maxSpecialistReviewRoundsPerTask: number };
  profiles: Array<{ id: AuthorityProfileId; description: string; modes: Record<string, string> }>;
  capabilities: AuthorityCapability[];
};
export type TaskAuthorityEntry = { id: string; owner: string; mode: string; authority: NormalizedAuthority; dependencies: string[]; budgets: CapabilityBudget };
export type AuthorityResolutionSource = "profile" | "explicit-overrides" | "legacy-feature-modes-v0";
export type AuthorityResolution = { source: AuthorityResolutionSource; modeOverrides: Record<string, string> };
export type TaskAuthoritySnapshot = {
  schemaVersion: typeof TASK_AUTHORITY_SNAPSHOT_SCHEMA_VERSION;
  snapshotVersion: typeof TASK_AUTHORITY_SNAPSHOT_VERSION;
  manifestVersion: typeof AUTHORITY_MANIFEST_VERSION;
  manifestDigest: string;
  releaseVersion: string;
  profile: AuthorityProfileId;
  taskId: string;
  taskRunId: string;
  capturedAt: string;
  resolution: AuthorityResolution;
  globalBudgets: AuthorityManifest["globalBudgets"];
  capabilities: TaskAuthorityEntry[];
  snapshotDigest: string;
};
export type LegacyFeatureModes = Partial<Record<"solver" | "phaseTools" | "recovery" | "helpers" | "parentRouting" | "executionBackend", string>>;

const HASH = /^sha256:[a-f0-9]{64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const MANIFEST_FIELDS = new Set(["schemaVersion", "manifestVersion", "releaseVersion", "status", "authorityVocabulary", "sourceProvenance", "globalBudgets", "profiles", "capabilities"]);
const CAPABILITY_FIELDS = new Set(["id", "owner", "layer", "configKey", "configSources", "defaultMode", "killSwitchMode", "dependencies", "modeMappings", "constitutionTargetMode", "constitutionTargetAuthority"]);
const MAPPING_FIELDS = new Set(["value", "authority", "budgets"]);
const BUDGET_FIELDS = new Set(["systemContinuations", "automaticDispatches", "reviewRounds"]);
const PROFILE_FIELDS = new Set(["id", "description", "modes"]);
const SNAPSHOT_FIELDS = new Set(["schemaVersion", "snapshotVersion", "manifestVersion", "manifestDigest", "releaseVersion", "profile", "taskId", "taskRunId", "capturedAt", "resolution", "globalBudgets", "capabilities", "snapshotDigest"]);
const SNAPSHOT_ENTRY_FIELDS = new Set(["id", "owner", "mode", "authority", "dependencies", "budgets"]);
const RESOLUTION_FIELDS = new Set(["source", "modeOverrides"]);
const LEGACY_KEYS = new Set(["solver", "phaseTools", "recovery", "helpers", "parentRouting", "executionBackend"]);
const LEGACY_CAPABILITIES: Record<string, string> = { solver: "CAP-08", phaseTools: "CAP-09", recovery: "CAP-12", helpers: "CAP-14", parentRouting: "CAP-15" };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function exactFields(value: Record<string, unknown>, expected: Set<string>, label: string): string[] {
  return [
    ...Object.keys(value).filter((key) => !expected.has(key)).map((key) => `${label} has unknown field: ${key}`),
    ...[...expected].filter((key) => !(key in value)).map((key) => `${label} missing field: ${key}`)
  ];
}

function rawUtf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  const object = record(value);
  if (!object) return value;
  return Object.fromEntries(Object.keys(object).sort(rawUtf8Compare).map((key) => [key, canonical(object[key])]));
}

function renderedDigest(domain: string, value: unknown): string {
  return `sha256:${crypto.createHash("sha256").update(domain, "utf8").update(JSON.stringify(canonical(value)), "utf8").digest("hex")}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validName(value: unknown): value is string {
  return typeof value === "string" && NAME.test(value);
}

function validateBudget(input: unknown, label: string, errors: string[]): CapabilityBudget | undefined {
  const value = record(input);
  if (!value) { errors.push(`${label} must be an object`); return undefined; }
  errors.push(...exactFields(value, BUDGET_FIELDS, label));
  for (const field of BUDGET_FIELDS) if (!Number.isInteger(value[field]) || Number(value[field]) < 0 || Number(value[field]) > 8) errors.push(`${label}.${field} is invalid`);
  return value as CapabilityBudget;
}

function dependencyCycles(capabilities: AuthorityCapability[]): string[] {
  const graph = new Map(capabilities.map((capability) => [capability.id, capability.dependencies]));
  const visiting = new Set<string>(), visited = new Set<string>(), cycles = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) { cycles.add(id); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of graph.get(id) ?? []) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const id of graph.keys()) visit(id);
  return [...cycles];
}

export function authorityManifestValidationErrors(input: unknown): string[] {
  const value = record(input);
  if (!value) return ["authority manifest must be an object"];
  const errors = exactFields(value, MANIFEST_FIELDS, "authority manifest");
  if (value.schemaVersion !== AUTHORITY_MANIFEST_SCHEMA_VERSION) errors.push("schemaVersion is unsupported");
  if (value.manifestVersion !== AUTHORITY_MANIFEST_VERSION) errors.push("manifestVersion is unsupported");
  if (value.releaseVersion !== "1.3.0") errors.push("releaseVersion must be 1.3.0");
  if (!['pre-release', 'release'].includes(String(value.status))) errors.push("status is invalid");
  if (JSON.stringify(value.authorityVocabulary) !== JSON.stringify(AUTHORITY_VALUES)) errors.push("authorityVocabulary must be exact and ordered");

  const provenance = record(value.sourceProvenance);
  const provenanceFields = new Set(["decisionDate", "roadmap", "constitution", "constitutionSha256", "evidenceTier"]);
  if (!provenance) errors.push("sourceProvenance must be an object");
  else {
    errors.push(...exactFields(provenance, provenanceFields, "sourceProvenance"));
    if (provenance.decisionDate !== "2026-08-10" || !validName(provenance.roadmap) || !validName(provenance.constitution)) errors.push("sourceProvenance paths/date are invalid");
    if (typeof provenance.constitutionSha256 !== "string" || !/^[a-f0-9]{64}$/.test(provenance.constitutionSha256)) errors.push("constitutionSha256 is invalid");
    if (!['local-pre-release', 'release-candidate'].includes(String(provenance.evidenceTier))) errors.push("evidenceTier is invalid");
  }

  const global = record(value.globalBudgets);
  const globalFields = new Set(["maxSystemContinuationsPerTask", "maxAutomaticDispatchesPerTask", "maxSpecialistReviewRoundsPerTask"]);
  if (!global) errors.push("globalBudgets must be an object");
  else {
    errors.push(...exactFields(global, globalFields, "globalBudgets"));
    for (const field of globalFields) if (global[field] !== 1) errors.push(`globalBudgets.${field} must be 1 in authority-v1`);
  }

  const capabilities = Array.isArray(value.capabilities) ? value.capabilities : [];
  if (capabilities.length !== CAPABILITY_IDS.length) errors.push("capabilities must contain exactly CAP-01 through CAP-17");
  const parsed: AuthorityCapability[] = [];
  const configKeys = new Set<string>();
  for (let index = 0; index < capabilities.length; index += 1) {
    const item = record(capabilities[index]); const label = `capabilities[${index}]`;
    if (!item) { errors.push(`${label} must be an object`); continue; }
    errors.push(...exactFields(item, CAPABILITY_FIELDS, label));
    if (item.id !== CAPABILITY_IDS[index]) errors.push(`${label}.id must be ${CAPABILITY_IDS[index]}`);
    if (!validName(item.owner) || !validName(item.configKey)) errors.push(`${label} owner/configKey is invalid`);
    if (typeof item.configKey === "string") { if (configKeys.has(item.configKey)) errors.push(`${label}.configKey is duplicated`); configKeys.add(item.configKey); }
    if (!['L0', 'L1', 'L2', 'L3', 'L4', 'L5'].includes(String(item.layer))) errors.push(`${label}.layer is invalid`);
    if (!Array.isArray(item.configSources) || item.configSources.length === 0 || item.configSources.length > 8 || item.configSources.some((source) => !validName(source)) || new Set(item.configSources).size !== item.configSources.length) errors.push(`${label}.configSources are invalid`);
    if (!Array.isArray(item.dependencies) || item.dependencies.some((dependency) => !CAPABILITY_IDS.includes(String(dependency))) || new Set(item.dependencies).size !== item.dependencies.length || item.dependencies.includes(item.id)) errors.push(`${label}.dependencies are invalid`);
    const mappings = Array.isArray(item.modeMappings) ? item.modeMappings : [];
    if (mappings.length === 0 || mappings.length > 8) errors.push(`${label}.modeMappings are invalid`);
    const modes = new Set<string>();
    for (const [mappingIndex, mappingInput] of mappings.entries()) {
      const mapping = record(mappingInput), mappingLabel = `${label}.modeMappings[${mappingIndex}]`;
      if (!mapping) { errors.push(`${mappingLabel} must be an object`); continue; }
      errors.push(...exactFields(mapping, MAPPING_FIELDS, mappingLabel));
      if (!validName(mapping.value) || modes.has(String(mapping.value))) errors.push(`${mappingLabel}.value is invalid or duplicated`);
      modes.add(String(mapping.value));
      if (!AUTHORITY_VALUES.includes(mapping.authority as NormalizedAuthority)) errors.push(`${mappingLabel}.authority is invalid`);
      const budget = validateBudget(mapping.budgets, `${mappingLabel}.budgets`, errors);
      if (budget && ['off', 'observe', 'advise'].includes(String(mapping.authority)) && Object.values(budget).some((amount) => amount !== 0)) errors.push(`${mappingLabel} non-enforcing authority cannot spend automatic budgets`);
      if (budget && mapping.authority === 'orchestrate' && budget.automaticDispatches < 1) errors.push(`${mappingLabel} orchestrate must declare a dispatch budget`);
      if (budget && global && (budget.systemContinuations > Number(global.maxSystemContinuationsPerTask) || budget.automaticDispatches > Number(global.maxAutomaticDispatchesPerTask) || budget.reviewRounds > Number(global.maxSpecialistReviewRoundsPerTask))) errors.push(`${mappingLabel} exceeds global budgets`);
    }
    if (!modes.has(String(item.defaultMode)) || !modes.has(String(item.killSwitchMode))) errors.push(`${label} default/kill-switch mode is not mapped`);
    if (!AUTHORITY_VALUES.includes(item.constitutionTargetAuthority as NormalizedAuthority) || !validName(item.constitutionTargetMode)) errors.push(`${label} constitution target is invalid`);
    parsed.push(item as AuthorityCapability);
  }
  if (dependencyCycles(parsed).length > 0) errors.push("capability dependencies contain a cycle");

  const profiles = Array.isArray(value.profiles) ? value.profiles : [];
  if (profiles.length !== AUTHORITY_PROFILE_IDS.length) errors.push("profiles must contain exactly the three authority-v1 profiles");
  const byId = new Map(parsed.map((capability) => [capability.id, capability]));
  for (let index = 0; index < profiles.length; index += 1) {
    const profile = record(profiles[index]), label = `profiles[${index}]`;
    if (!profile) { errors.push(`${label} must be an object`); continue; }
    errors.push(...exactFields(profile, PROFILE_FIELDS, label));
    if (profile.id !== AUTHORITY_PROFILE_IDS[index]) errors.push(`${label}.id must be ${AUTHORITY_PROFILE_IDS[index]}`);
    if (typeof profile.description !== "string" || profile.description.length < 12 || profile.description.length > 320) errors.push(`${label}.description is invalid`);
    const modes = record(profile.modes);
    if (!modes || JSON.stringify(Object.keys(modes).sort(rawUtf8Compare)) !== JSON.stringify(CAPABILITY_IDS)) errors.push(`${label}.modes must contain exactly CAP-01 through CAP-17`);
    else for (const [id, mode] of Object.entries(modes)) if (!(byId.get(id)?.modeMappings.some((mapping) => mapping.value === mode))) errors.push(`${label}.${id} mode is not mapped`);
  }
  const broad = record(record(profiles[0])?.modes);
  if (broad) for (const capability of parsed) if (broad[capability.id] !== capability.defaultMode) errors.push(`${capability.id} defaultMode differs from broad-default`);
  return [...new Set(errors)];
}

export function validateAuthorityManifest(input: unknown): AuthorityManifest {
  const errors = authorityManifestValidationErrors(input);
  if (errors.length > 0) throw new Error(`Invalid authority manifest: ${errors.join("; ")}`);
  return structuredClone(input) as AuthorityManifest;
}

export function authorityManifestDigest(input: unknown): string {
  return renderedDigest("piagent-authority-manifest-v1\n", validateAuthorityManifest(input));
}

export function loadBundledAuthorityManifest(): AuthorityManifest {
  return deepFreeze(validateAuthorityManifest(bundledManifestJson));
}

function mappingFor(capability: AuthorityCapability, mode: string): AuthorityModeMapping {
  const mapping = capability.modeMappings.find((candidate) => candidate.value === mode);
  if (!mapping) throw new Error(`${capability.id} does not support mode ${mode}`);
  return mapping;
}

function snapshotInteractionErrors(capabilities: TaskAuthorityEntry[], globalBudgets: AuthorityManifest["globalBudgets"]): string[] {
  const byId = new Map(capabilities.map((entry) => [entry.id, entry]));
  const errors: string[] = [];
  const dispatches = capabilities.reduce((total, entry) => total + Number(entry.budgets?.automaticDispatches ?? 0), 0);
  if (dispatches > globalBudgets.maxAutomaticDispatchesPerTask) errors.push("combined automatic dispatch budget exceeds the task-global ceiling");
  const semantic = byId.get("CAP-13");
  if (semantic?.authority === "enforce") {
    if (byId.get("CAP-09")?.authority !== "enforce") errors.push("CAP-13 strict enforcement requires CAP-09 enforcement");
    if (byId.get("CAP-12")?.authority !== "enforce") errors.push("CAP-13 strict enforcement requires CAP-12 enforcement");
  }
  return errors;
}

export function migrateLegacyFeatureModes(input: unknown, manifestInput: unknown = bundledManifestJson): { profile: "broad-default"; modeOverrides: Record<string, string>; resolutionSource: "legacy-feature-modes-v0" } {
  const manifest = validateAuthorityManifest(manifestInput), value = record(input);
  if (!value) throw new Error("legacy feature modes must be an object");
  const unknown = Object.keys(value).filter((key) => !LEGACY_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`legacy feature modes have unknown keys: ${unknown.join(", ")}`);
  if (value.executionBackend !== undefined && value.executionBackend !== "host") throw new Error("legacy executionBackend must remain host");
  const byId = new Map(manifest.capabilities.map((capability) => [capability.id, capability]));
  const modeOverrides: Record<string, string> = {};
  for (const [legacyKey, capabilityId] of Object.entries(LEGACY_CAPABILITIES)) {
    if (value[legacyKey] === undefined) continue;
    if (typeof value[legacyKey] !== "string") throw new Error(`legacy ${legacyKey} mode must be a string`);
    mappingFor(byId.get(capabilityId) as AuthorityCapability, value[legacyKey] as string);
    modeOverrides[capabilityId] = value[legacyKey] as string;
  }
  return deepFreeze({ profile: "broad-default", modeOverrides, resolutionSource: "legacy-feature-modes-v0" });
}

export function createTaskAuthoritySnapshot(input: { manifest?: unknown; profile?: AuthorityProfileId; modeOverrides?: Record<string, string>; resolutionSource?: AuthorityResolutionSource; taskId: string; taskRunId: string; capturedAt?: string }): TaskAuthoritySnapshot {
  const manifest = validateAuthorityManifest(input.manifest ?? bundledManifestJson);
  const profileId = input.profile ?? "broad-default", profile = manifest.profiles.find((candidate) => candidate.id === profileId);
  if (!profile) throw new Error(`unknown authority profile: ${profileId}`);
  if (!validName(input.taskId) || !validName(input.taskRunId)) throw new Error("taskId/taskRunId are invalid");
  const capturedAt = input.capturedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(capturedAt))) throw new Error("capturedAt is invalid");
  const overrides = input.modeOverrides ?? {}, overrideIds = Object.keys(overrides), unknownOverrides = overrideIds.filter((id) => !CAPABILITY_IDS.includes(id));
  if (unknownOverrides.length > 0) throw new Error(`unknown capability overrides: ${unknownOverrides.join(", ")}`);
  const resolutionSource = input.resolutionSource ?? (overrideIds.length > 0 ? "explicit-overrides" : "profile");
  if (!["profile", "explicit-overrides", "legacy-feature-modes-v0"].includes(resolutionSource)) throw new Error(`unknown authority resolution source: ${resolutionSource}`);
  if (resolutionSource === "profile" && overrideIds.length > 0) throw new Error("profile resolution cannot contain mode overrides");
  if (resolutionSource === "explicit-overrides" && overrideIds.length === 0) throw new Error("explicit override resolution requires at least one mode override");
  const orderedOverrides = Object.fromEntries(CAPABILITY_IDS.filter((id) => id in overrides).map((id) => [id, overrides[id]]));
  const capabilities = manifest.capabilities.map((capability): TaskAuthorityEntry => {
    const mode = overrides[capability.id] ?? profile.modes[capability.id], mapping = mappingFor(capability, mode);
    return { id: capability.id, owner: capability.owner, mode, authority: mapping.authority, dependencies: [...capability.dependencies], budgets: { ...mapping.budgets } };
  });
  const active = new Map(capabilities.map((capability) => [capability.id, capability.authority !== "off"]));
  for (const capability of capabilities) if (active.get(capability.id)) for (const dependency of capability.dependencies) if (!active.get(dependency)) throw new Error(`${capability.id} cannot activate while dependency ${dependency} is off`);
  const interactionErrors = snapshotInteractionErrors(capabilities, manifest.globalBudgets);
  if (interactionErrors.length > 0) throw new Error(interactionErrors.join("; "));
  const withoutDigest = {
    schemaVersion: TASK_AUTHORITY_SNAPSHOT_SCHEMA_VERSION,
    snapshotVersion: TASK_AUTHORITY_SNAPSHOT_VERSION,
    manifestVersion: AUTHORITY_MANIFEST_VERSION,
    manifestDigest: authorityManifestDigest(manifest),
    releaseVersion: manifest.releaseVersion,
    profile: profileId,
    taskId: input.taskId,
    taskRunId: input.taskRunId,
    capturedAt,
    resolution: { source: resolutionSource, modeOverrides: orderedOverrides },
    globalBudgets: structuredClone(manifest.globalBudgets),
    capabilities
  };
  return deepFreeze({ ...withoutDigest, snapshotDigest: renderedDigest("piagent-task-authority-snapshot-v1\n", withoutDigest) });
}

export function taskAuthoritySnapshotValidationErrors(input: unknown, manifestInput: unknown = bundledManifestJson): string[] {
  const value = record(input);
  if (!value) return ["task authority snapshot must be an object"];
  const errors = exactFields(value, SNAPSHOT_FIELDS, "task authority snapshot");
  if (value.schemaVersion !== TASK_AUTHORITY_SNAPSHOT_SCHEMA_VERSION) errors.push("snapshot schemaVersion is unsupported");
  if (value.snapshotVersion !== TASK_AUTHORITY_SNAPSHOT_VERSION) errors.push("snapshotVersion is unsupported");
  if (value.manifestVersion !== AUTHORITY_MANIFEST_VERSION) errors.push("snapshot manifestVersion is unsupported");
  if (typeof value.manifestDigest !== "string" || !HASH.test(value.manifestDigest)) errors.push("manifestDigest is invalid");
  if (value.releaseVersion !== "1.3.0" || !AUTHORITY_PROFILE_IDS.includes(value.profile as AuthorityProfileId)) errors.push("snapshot release/profile is invalid");
  if (!validName(value.taskId) || !validName(value.taskRunId) || typeof value.capturedAt !== "string" || !Number.isFinite(Date.parse(value.capturedAt))) errors.push("snapshot identity/time is invalid");
  if (typeof value.snapshotDigest !== "string" || !HASH.test(value.snapshotDigest)) errors.push("snapshotDigest is invalid");
  const resolution = record(value.resolution), modeOverrides = record(resolution?.modeOverrides);
  if (!resolution) errors.push("snapshot resolution must be an object");
  else {
    errors.push(...exactFields(resolution, RESOLUTION_FIELDS, "snapshot resolution"));
    if (!["profile", "explicit-overrides", "legacy-feature-modes-v0"].includes(String(resolution.source))) errors.push("snapshot resolution source is invalid");
    if (!modeOverrides) errors.push("snapshot resolution modeOverrides must be an object");
    else {
      const unknownOverrides = Object.keys(modeOverrides).filter((id) => !CAPABILITY_IDS.includes(id));
      if (unknownOverrides.length > 0 || Object.values(modeOverrides).some((mode) => !validName(mode))) errors.push("snapshot resolution modeOverrides are invalid");
      if (resolution.source === "profile" && Object.keys(modeOverrides).length > 0) errors.push("profile resolution cannot contain mode overrides");
      if (resolution.source === "explicit-overrides" && Object.keys(modeOverrides).length === 0) errors.push("explicit override resolution requires mode overrides");
    }
  }
  const capabilities = Array.isArray(value.capabilities) ? value.capabilities : [];
  if (capabilities.length !== CAPABILITY_IDS.length) errors.push("snapshot capabilities must contain CAP-01 through CAP-17");
  for (let index = 0; index < capabilities.length; index += 1) {
    const entry = record(capabilities[index]), label = `snapshot capabilities[${index}]`;
    if (!entry) { errors.push(`${label} must be an object`); continue; }
    errors.push(...exactFields(entry, SNAPSHOT_ENTRY_FIELDS, label));
    if (entry.id !== CAPABILITY_IDS[index] || !validName(entry.owner) || !validName(entry.mode) || !AUTHORITY_VALUES.includes(entry.authority as NormalizedAuthority)) errors.push(`${label} identity/mode/authority is invalid`);
    if (!Array.isArray(entry.dependencies) || entry.dependencies.some((dependency) => !CAPABILITY_IDS.includes(String(dependency)))) errors.push(`${label}.dependencies are invalid`);
    validateBudget(entry.budgets, `${label}.budgets`, errors);
  }
  try {
    const manifest = validateAuthorityManifest(manifestInput);
    if (value.manifestDigest !== authorityManifestDigest(manifest)) errors.push("snapshot manifestDigest does not match the supplied manifest");
    if (value.releaseVersion !== manifest.releaseVersion) errors.push("snapshot releaseVersion does not match the supplied manifest");
    if (JSON.stringify(value.globalBudgets) !== JSON.stringify(manifest.globalBudgets)) errors.push("snapshot globalBudgets do not match the supplied manifest");
    const profile = manifest.profiles.find((candidate) => candidate.id === value.profile);
    for (const [index, capability] of manifest.capabilities.entries()) {
      const entry = record(capabilities[index]); if (!entry) continue;
      const mapping = capability.modeMappings.find((candidate) => candidate.value === entry.mode);
      const expectedMode = modeOverrides?.[capability.id] ?? profile?.modes[capability.id];
      if (entry.id !== capability.id || entry.owner !== capability.owner || entry.mode !== expectedMode || JSON.stringify(entry.dependencies) !== JSON.stringify(capability.dependencies) || !mapping || entry.authority !== mapping.authority || JSON.stringify(entry.budgets) !== JSON.stringify(mapping.budgets)) errors.push(`snapshot ${capability.id} does not match its profile resolution and supplied manifest`);
    }
    const active = new Map(capabilities.map((entry) => record(entry)).filter(Boolean).map((entry) => [String(entry?.id), entry?.authority !== "off"]));
    for (const capability of capabilities.map((entry) => record(entry)).filter(Boolean)) for (const dependency of Array.isArray(capability?.dependencies) ? capability.dependencies : []) if (capability?.authority !== "off" && !active.get(String(dependency))) errors.push(`snapshot ${capability?.id} has inactive dependency ${dependency}`);
    if (capabilities.length === CAPABILITY_IDS.length && capabilities.every((entry) => record(entry))) {
      errors.push(...snapshotInteractionErrors(capabilities as TaskAuthorityEntry[], manifest.globalBudgets));
    }
  } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  const { snapshotDigest: _digest, ...withoutDigest } = value;
  if (value.snapshotDigest !== renderedDigest("piagent-task-authority-snapshot-v1\n", withoutDigest)) errors.push("snapshotDigest does not match snapshot content");
  return [...new Set(errors)];
}

export function validateTaskAuthoritySnapshot(input: unknown, manifestInput: unknown = bundledManifestJson): TaskAuthoritySnapshot {
  const errors = taskAuthoritySnapshotValidationErrors(input, manifestInput);
  if (errors.length > 0) throw new Error(`Invalid task authority snapshot: ${errors.join("; ")}`);
  return deepFreeze(structuredClone(input) as TaskAuthoritySnapshot);
}

export function inspectAuthoritySnapshotCompatibility(input: unknown, manifestInput: unknown = bundledManifestJson): { disposition: "resume-pinned" | "new-task-required"; reason: "compatible" | "unknown-snapshot-version" | "unknown-manifest-version" | "manifest-digest-mismatch" | "invalid-snapshot" } {
  const value = record(input);
  if (!value || value.schemaVersion !== 1 || value.snapshotVersion !== TASK_AUTHORITY_SNAPSHOT_VERSION) return { disposition: "new-task-required", reason: "unknown-snapshot-version" };
  if (value.manifestVersion !== AUTHORITY_MANIFEST_VERSION) return { disposition: "new-task-required", reason: "unknown-manifest-version" };
  let manifest: AuthorityManifest;
  try { manifest = validateAuthorityManifest(manifestInput); } catch { return { disposition: "new-task-required", reason: "unknown-manifest-version" }; }
  if (value.manifestDigest !== authorityManifestDigest(manifest)) return { disposition: "new-task-required", reason: "manifest-digest-mismatch" };
  try { validateTaskAuthoritySnapshot(input, manifest); } catch { return { disposition: "new-task-required", reason: "invalid-snapshot" }; }
  return { disposition: "resume-pinned", reason: "compatible" };
}
