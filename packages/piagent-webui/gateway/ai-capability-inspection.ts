import fs from "node:fs";
import path from "node:path";

const PACKAGE_NAME = "pi-web-access";
const VERSION = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
const MAX_PACKAGE_MANIFEST_BYTES = 32 * 1024;

export type WebSearchCapabilityProjection = {
  state: "configured" | "unavailable";
  route: "codex-first" | "automatic" | null;
  provider: "openai-codex" | null;
  fallbackProvider: "exa" | null;
  integration: { name: "pi-web-access"; version: string } | null;
  reasonCode: string | null;
};

function installedWebAccess(agentDir: string | undefined): { name: "pi-web-access"; version: string } | null {
  if (!agentDir) return null;
  const root = path.resolve(agentDir), manifest = path.resolve(root, "npm", "node_modules", PACKAGE_NAME, "package.json");
  if (path.relative(root, manifest).startsWith("..")) return null;
  try {
    const canonicalRoot = fs.realpathSync.native(root), canonicalManifest = fs.realpathSync.native(manifest);
    const relative = path.relative(canonicalRoot, canonicalManifest);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    const inspected = fs.lstatSync(manifest);
    if (!inspected.isFile() || inspected.isSymbolicLink() || inspected.size < 2 || inspected.size > MAX_PACKAGE_MANIFEST_BYTES) return null;
    const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: unknown; version?: unknown };
    if (parsed.name !== PACKAGE_NAME || typeof parsed.version !== "string" || parsed.version.length > 64 || !VERSION.test(parsed.version)) return null;
    return { name: PACKAGE_NAME, version: parsed.version };
  } catch {
    return null;
  }
}

export function inspectWebSearchCapability(input: {
  agentDir?: string;
  models: readonly Record<string, unknown>[];
}): WebSearchCapabilityProjection {
  const integration = installedWebAccess(input.agentDir);
  if (!integration) return {
    state: "unavailable", route: null, provider: null, fallbackProvider: null, integration: null,
    reasonCode: "web-search-integration-not-installed"
  };
  const codexAvailable = input.models.some((model) => model.provider === "openai-codex");
  return {
    state: "configured",
    route: codexAvailable ? "codex-first" : "automatic",
    provider: codexAvailable ? "openai-codex" : null,
    fallbackProvider: "exa",
    integration,
    reasonCode: codexAvailable ? null : "codex-auth-not-available"
  };
}
