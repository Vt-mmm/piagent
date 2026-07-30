#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <project-path> [profile-json]"
  exit 2
fi

PROJECT_PATH="$1"
PROFILE_PATH="${2:-"$PROJECT_PATH/.pi/piagent-profile.json"}"

if [[ ! -d "$PROJECT_PATH" ]]; then
  echo "FAIL: project path does not exist: $PROJECT_PATH"
  exit 1
fi

if [[ ! -f "$PROFILE_PATH" ]]; then
  echo "FAIL: profile not found: $PROFILE_PATH"
  exit 1
fi

PLATFORM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

node --input-type=module - "$PROJECT_PATH" "$PROFILE_PATH" "$PLATFORM_ROOT" <<'NODE'
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [projectPath, profilePath, platformRoot] = process.argv.slice(2);
const stored = JSON.parse(fs.readFileSync(profilePath, "utf8"));

// A profile that names an adapter is checked as the document that will actually
// be enforced, not as the few lines the project happens to store.
const { resolveProjectProfileDocument } = await import(
  pathToFileURL(path.join(platformRoot, "packages", "piagent-core", "capabilities", "project-profile.js")).href
);
const profile = resolveProjectProfileDocument(platformRoot, stored).profile;

const errors = [];
const warnings = [];

function requireArray(name) {
  if (!Array.isArray(profile[name])) {
    errors.push(`${name} must be an array`);
    return [];
  }
  return profile[name];
}

function optionalArray(name) {
  if (profile[name] === undefined) return [];
  if (!Array.isArray(profile[name])) {
    errors.push(`${name} must be an array when provided`);
    return [];
  }
  return profile[name];
}

function warnShellOnlyProtectedPaths(shellProtectedPaths, protectedPaths, readOnlyPaths) {
  const writeGuardedPaths = new Set([...protectedPaths, ...readOnlyPaths]);
  for (const candidate of shellProtectedPaths) {
    if (typeof candidate !== "string" || candidate.trim().length === 0) continue;
    if (writeGuardedPaths.has(candidate)) continue;
    warnings.push(`shellProtectedPaths-only path ${candidate} blocks shell access only; add it to protectedPaths to block read/write, or readOnlyPaths to allow read but block write/shell`);
  }
}

if (profile.schemaVersion !== 1) errors.push("schemaVersion must be 1");
if (!profile.projectId) errors.push("projectId is required");
if (!profile.displayName) errors.push("displayName is required");
if (!profile.mode) errors.push("mode is required");

const rootMarkers = requireArray("rootMarkers");
const protectedPaths = requireArray("protectedPaths");
const shellProtectedPaths = optionalArray("shellProtectedPaths");
const readOnlyPaths = optionalArray("readOnlyPaths");
const requiredContext = requireArray("requiredContext");
const mcpCapabilities = requireArray("mcpCapabilities");

warnShellOnlyProtectedPaths(shellProtectedPaths, protectedPaths, readOnlyPaths);

const capabilityPacks = profile.capabilityPacks ?? [];
if (!Array.isArray(capabilityPacks)) {
  errors.push("capabilityPacks must be an array");
} else {
  const seenPacks = new Set();
  for (const [index, pack] of capabilityPacks.entries()) {
    if (!pack || typeof pack !== "object" || Array.isArray(pack)) {
      errors.push(`capabilityPacks[${index}] must be an object`);
      continue;
    }
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(pack.name ?? "")) {
      errors.push(`capabilityPacks[${index}].name is invalid`);
    }
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(pack.version ?? "")) {
      errors.push(`capabilityPacks[${index}].version is invalid`);
    }
    const key = `${pack.name}@${pack.version}`;
    if (seenPacks.has(key)) errors.push(`capabilityPacks contains duplicate ${key}`);
    seenPacks.add(key);
  }
}

const defaultCapabilityPolicy = {
  allowedOwners: [],
  allowedLifecycles: [],
  allowedFilesystemRead: [],
  allowedFilesystemWrite: [],
  allowedNetworkDomains: [],
  allowedExternalActions: []
};
const capabilityPolicy = profile.capabilityPolicy && typeof profile.capabilityPolicy === "object" && !Array.isArray(profile.capabilityPolicy)
  ? profile.capabilityPolicy
  : defaultCapabilityPolicy;
if (profile.capabilityPolicy !== undefined && capabilityPolicy === defaultCapabilityPolicy) errors.push("capabilityPolicy must be an object");
for (const key of ["allowedOwners", "allowedLifecycles", "allowedFilesystemRead", "allowedFilesystemWrite", "allowedNetworkDomains", "allowedExternalActions"]) {
  if (!Array.isArray(capabilityPolicy[key])) errors.push(`capabilityPolicy.${key} must be an array`);
}
for (const lifecycle of Array.isArray(capabilityPolicy.allowedLifecycles) ? capabilityPolicy.allowedLifecycles : []) {
  if (!["experimental", "stable", "deprecated"].includes(lifecycle)) {
    errors.push(`capabilityPolicy.allowedLifecycles contains invalid value ${lifecycle}`);
  }
}

if (!profile.verifyCommands || typeof profile.verifyCommands !== "object" || Array.isArray(profile.verifyCommands)) {
  errors.push("verifyCommands must be an object");
}

const existingRootMarkers = rootMarkers.filter((marker) => fs.existsSync(path.join(projectPath, marker)));
if (existingRootMarkers.length === 0) {
  warnings.push(`no rootMarkers found in project: ${rootMarkers.join(", ")}`);
}

for (const contextPath of requiredContext) {
  if (contextPath.includes("<")) {
    warnings.push(`requiredContext has placeholder: ${contextPath}`);
    continue;
  }
  if (!fs.existsSync(path.join(projectPath, contextPath))) {
    warnings.push(`requiredContext missing in project: ${contextPath}`);
  }
}

if (protectedPaths.length === 0) warnings.push("protectedPaths is empty");
if (mcpCapabilities.length === 0) warnings.push("mcpCapabilities is empty");

const defaultRuntimePolicy = {
  execPolicy: "enforce",
  contextBudget: "enforce",
  toolRegistry: "advisory",
  finalGate: "advisory"
};
const runtimePolicyOverrides = profile.runtimePolicy === undefined
  ? {}
  : profile.runtimePolicy && typeof profile.runtimePolicy === "object" && !Array.isArray(profile.runtimePolicy)
    ? profile.runtimePolicy
    : {};
if (profile.runtimePolicy !== undefined && runtimePolicyOverrides !== profile.runtimePolicy) errors.push("runtimePolicy must be an object");
const runtimePolicy = { ...defaultRuntimePolicy, ...runtimePolicyOverrides };
for (const [key, value] of Object.entries(runtimePolicy)) {
  if (!["off", "advisory", "enforce"].includes(value)) {
    errors.push(`runtimePolicy.${key} must be off, advisory, or enforce`);
  }
}

const contextIndexDefaults = {
  enabled: true,
  path: ".pi/context-index.json",
  writePolicy: "onboarding-record",
  requireCitations: true,
  maxNodes: 120,
  maxEdges: 240,
  includeTechStack: true,
  includeMemoryPointers: true
};
let contextIndex = contextIndexDefaults;
if (profile.contextIndex !== undefined) {
  if (!profile.contextIndex || typeof profile.contextIndex !== "object" || Array.isArray(profile.contextIndex)) {
    errors.push("contextIndex must be an object");
  } else {
    contextIndex = { ...contextIndexDefaults, ...profile.contextIndex };
    if (typeof contextIndex.enabled !== "boolean") errors.push("contextIndex.enabled must be boolean");
    if (typeof contextIndex.path !== "string" || contextIndex.path.trim().length === 0) errors.push("contextIndex.path must be a non-empty string");
    if (!["onboarding-record", "approved-workflow", "off"].includes(contextIndex.writePolicy)) {
      errors.push("contextIndex.writePolicy must be onboarding-record, approved-workflow, or off");
    }
    if (typeof contextIndex.requireCitations !== "boolean") errors.push("contextIndex.requireCitations must be boolean");
    if (!Number.isInteger(contextIndex.maxNodes) || contextIndex.maxNodes < 1 || contextIndex.maxNodes > 500) errors.push("contextIndex.maxNodes must be an integer from 1 to 500");
    if (!Number.isInteger(contextIndex.maxEdges) || contextIndex.maxEdges < 0 || contextIndex.maxEdges > 1000) errors.push("contextIndex.maxEdges must be an integer from 0 to 1000");
    if (typeof contextIndex.includeTechStack !== "boolean") errors.push("contextIndex.includeTechStack must be boolean");
    if (typeof contextIndex.includeMemoryPointers !== "boolean") errors.push("contextIndex.includeMemoryPointers must be boolean");
  }
}

if (contextIndex.enabled && contextIndex.writePolicy !== "off") {
  const indexPath = path.resolve(projectPath, contextIndex.path);
  const relativeIndexPath = path.relative(projectPath, indexPath);
  if (relativeIndexPath.startsWith("..") || path.isAbsolute(relativeIndexPath)) {
    errors.push(`contextIndex.path escapes project root: ${contextIndex.path}`);
  } else if (!fs.existsSync(indexPath)) {
    warnings.push(`context index missing: ${contextIndex.path}; run /onboard run or record piagent_context_index_record`);
  }
}

const verifyEntries = Object.entries(profile.verifyCommands ?? {});
if (verifyEntries.length === 0) {
  errors.push("verifyCommands has no entries");
}
for (const [key, commands] of verifyEntries) {
  if (!Array.isArray(commands) || commands.length === 0) {
    errors.push(`verifyCommands.${key} must be a non-empty array`);
    continue;
  }
  for (const command of commands) {
    if (typeof command !== "string" || command.trim().length === 0) {
      errors.push(`verifyCommands.${key} contains an empty command`);
    }
  }
}

const report = {
  projectPath,
  profilePath,
  projectId: profile.projectId,
  mode: profile.mode,
  rootMarkersFound: existingRootMarkers,
  requiredContextCount: requiredContext.length,
  protectedPathCount: protectedPaths.length,
  shellProtectedPathCount: shellProtectedPaths.length,
  readOnlyPathCount: readOnlyPaths.length,
  verifyProfiles: verifyEntries.map(([key]) => key),
  mcpCapabilities,
  capabilityPacks: Array.isArray(capabilityPacks)
    ? capabilityPacks
      .filter((pack) => pack && typeof pack === "object" && !Array.isArray(pack))
      .map((pack) => `${String(pack.name ?? "<invalid>")}@${String(pack.version ?? "<invalid>")}`)
    : [],
  capabilityPolicy,
  runtimePolicy,
  contextIndex,
  warnings,
  errors
};

console.log(JSON.stringify(report, null, 2));

if (errors.length > 0) process.exit(1);
NODE
