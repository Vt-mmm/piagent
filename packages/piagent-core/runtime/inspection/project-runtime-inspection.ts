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

export function runtimeProtectedPaths(packageRoot: string, cwd: string): string[] {
  const policy = readRequiredJsonObject(path.join(packageRoot, "packages", "piagent-core", "policies", "base-policy.json"));
  const profileFile = path.join(cwd, ".pi", "piagent-profile.json");
  let profile: Record<string, unknown> = {};
  try {
    const stat = fs.lstatSync(profileFile);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1_048_576) {
      profile = readProjectProfileDocument(packageRoot, profileFile).profile ?? {};
    }
  } catch {
    // Missing or unsafe project profiles never remove the platform policy.
  }
  return effectiveProtectedPaths(policy, profile).readProtectedPaths;
}

export function runtimeConnectionDefinitions(cwd: string): {
  servers: ReturnType<typeof collectServers>;
  unreadableLayerCount: number;
} {
  return { servers: collectServers({ projectPath: cwd }), unreadableLayerCount: unreadableLayers({ projectPath: cwd }).length };
}
