import fs from "node:fs";
import path from "node:path";

import { readProjectProfileDocument } from "../../capabilities/project-profile.js";
import { effectiveProtectedPaths } from "../../extensions/context-index-policy.js";
import { collectServers, unreadableLayers } from "../../mcp/mcp-config-layers.js";

function readRequiredJsonObject(file: string): Record<string, unknown> {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576) throw new Error("inspection-policy-unavailable");
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("inspection-policy-unavailable");
  return value as Record<string, unknown>;
}

// A project profile is operator-supplied and may be missing, malformed, a
// symlink, or enormous. Every reader of it needs the same refusal, so both
// callers below go through this one.
function safeProjectProfile(packageRoot: string, cwd: string): Record<string, unknown> {
  const profileFile = path.join(cwd, ".pi", "piagent-profile.json");
  try {
    const stat = fs.lstatSync(profileFile);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1_048_576) {
      return readProjectProfileDocument(packageRoot, profileFile).profile ?? {};
    }
  } catch {
    // Missing or unsafe project profiles never remove the platform policy.
  }
  return {};
}

export function runtimeProtectedPaths(packageRoot: string, cwd: string): string[] {
  const policy = readRequiredJsonObject(path.join(packageRoot, "packages", "piagent-core", "policies", "base-policy.json"));
  return effectiveProtectedPaths(policy, safeProjectProfile(packageRoot, cwd)).readProtectedPaths;
}

// Directories the operator granted for reading documents outside the project.
// Returned raw: resolveDocumentRoots is what decides which of them exist and
// canonicalises them, and duplicating that judgement here would let the two
// answers drift.
export function runtimeDocumentReadRoots(packageRoot: string, cwd: string): string[] {
  const granted = safeProjectProfile(packageRoot, cwd).additionalReadRoots;
  return Array.isArray(granted) ? granted.filter((item): item is string => typeof item === "string") : [];
}

export function runtimeConnectionDefinitions(cwd: string): {
  servers: ReturnType<typeof collectServers>;
  unreadableLayerCount: number;
} {
  return { servers: collectServers({ projectPath: cwd }), unreadableLayerCount: unreadableLayers({ projectPath: cwd }).length };
}
