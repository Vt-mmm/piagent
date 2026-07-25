#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/team-doctor.sh [project-path] [--strict-share]

Checks:
  - Pi/Herdr availability
  - Root package Pi manifest
  - MCP adapter/baseline visibility
  - Subagents package/config visibility
  - Foreign skill directories wired into .pi/settings.json skills
  - Agent instruction files this platform does not read
  - Project .pi/settings.json package source
  - Project piagent profile
  - No local-machine paths in share-critical files when --strict-share is used
USAGE
}

PROJECT_PATH=""
STRICT_SHARE=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --strict-share)
      STRICT_SHARE=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -z "$PROJECT_PATH" ]]; then
        PROJECT_PATH="$1"
        shift
      else
        echo "Unknown argument: $1" >&2
        usage >&2
        exit 2
      fi
      ;;
  esac
done

PLATFORM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_PATH="${PROJECT_PATH:-$PWD}"

node --input-type=module - "$PLATFORM_ROOT" "$PROJECT_PATH" "$STRICT_SHARE" <<'NODE'
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const [platformRoot, projectPath, strictShareRaw] = process.argv.slice(2);
const strictShare = strictShareRaw === "true";
const errors = [];
const warnings = [];
const { verifyCapabilityLock } = await import(pathToFileURL(path.join(platformRoot, "packages", "piagent-core", "capabilities", "capability-core.js")).href);

function exists(rel) {
  return fs.existsSync(path.join(platformRoot, rel));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function commandExists(command) {
  const result = spawnSync("sh", ["-lc", `command -v ${command} >/dev/null 2>&1`], { stdio: "ignore" });
  return result.status === 0;
}

function isWslRuntime() {
  if (process.platform !== "linux") return false;
  try {
    return /microsoft|wsl/i.test(fs.readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

function runtimeMatrixStatus() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === "darwin" && arch === "arm64") {
    return {
      surface: "macos-apple-silicon/darwin-arm64",
      status: "verified",
      teamRolloutReady: true,
      note: "Apple Silicon macOS with Bash is in the current supported matrix."
    };
  }
  if (platform === "darwin" && arch === "x64") {
    return {
      surface: "macos-intel/darwin-x64",
      status: "supported-target",
      teamRolloutReady: false,
      note: "Node.js is available for this target, but this release has not been gated on an Intel Mac runner."
    };
  }
  if (platform === "linux" && isWslRuntime()) {
    return {
      surface: `wsl2/${arch}`,
      status: "experimental",
      teamRolloutReady: false,
      note: "WSL2 has Linux-like Node/Bash behavior, but it is not part of the release gate."
    };
  }
  if (platform === "linux" && arch === "x64") {
    return {
      surface: "linux-x64",
      status: "verified-ci",
      teamRolloutReady: true,
      note: "Ubuntu x64 with Bash is covered by CI release gates."
    };
  }
  if (platform === "linux" && arch === "arm64") {
    return {
      surface: "linux-arm64",
      status: "supported-target",
      teamRolloutReady: false,
      note: "Node.js is available for this target, but this release has not been gated on Linux ARM64."
    };
  }
  if (platform === "win32") {
    return {
      surface: `native-windows/${arch}`,
      status: "not-supported-for-team-rollout",
      teamRolloutReady: false,
      note: "The Node runtime is available, but platform helper scripts and shell policy rely on Bash/POSIX semantics."
    };
  }
  return {
    surface: `${platform}/${arch}`,
    status: "outside-release-matrix",
    teamRolloutReady: false,
    note: "This runtime is outside the documented v1.0.0 support matrix."
  };
}

const runtime = runtimeMatrixStatus();
if (!runtime.teamRolloutReady) {
  warnings.push(`runtime surface ${runtime.surface} is ${runtime.status}: ${runtime.note}`);
}

for (const rel of [
  "package.json",
  "packages/piagent-core/extensions/piagent-guard.ts",
  "packages/piagent-core/prompts/onboard-project.md",
  "packages/piagent-core/prompts/memory-policy.md",
  "packages/piagent-core/prompts/platform-improve.md",
  "packages/piagent-core/prompts/be-to-fe.md",
  "packages/piagent-core/prompts/task.md",
  "packages/piagent-core/prompts/discuss.md",
  "packages/piagent-core/subagents/piagent-scout.md",
  "packages/piagent-core/subagents/piagent-planner.md",
  "packages/piagent-core/subagents/piagent-worker.md",
  "packages/piagent-core/subagents/piagent-reviewer.md",
  "packages/piagent-core/subagents/piagent-oracle.md",
  "templates/project/.pi/settings.json",
  "templates/project/.pi/piagent-profile.json",
  "templates/project/.mcp.json",
  "templates/project/.pi/mcp.json",
  "templates/project/.pi/project-context.md",
  "templates/project/.pi/context-index.json",
  "templates/project/.pi/memory/memory_summary.md",
  "templates/project/.pi/memory/MEMORY.md",
  "scripts/setup.sh",
  "scripts/configure-mcp.sh",
  "scripts/configure-subagents.sh"
]) {
  if (!exists(rel)) errors.push(`missing platform file: ${rel}`);
}

const rootPackage = readJson(path.join(platformRoot, "package.json"));
if (!rootPackage.pi?.extensions?.length) errors.push("root package.json missing pi.extensions");
if (!rootPackage.pi?.skills?.length) errors.push("root package.json missing pi.skills");
if (!rootPackage.pi?.prompts?.length) errors.push("root package.json missing pi.prompts");
if (!rootPackage.pi?.subagents?.agents?.length) errors.push("root package.json missing pi.subagents.agents");

if (!commandExists("pi")) warnings.push("pi is not on PATH");
if (!commandExists("herdr")) warnings.push("herdr is not on PATH; Herdr integration optional");

function readJsonIfPresent(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    warnings.push(`cannot parse JSON: ${file}`);
    return null;
  }
}

function profileOptionalArrayOrEmpty(profile, field, profileLabel) {
  if (profile[field] === undefined) return [];
  if (!Array.isArray(profile[field])) {
    errors.push(`${profileLabel} ${field} must be array when provided`);
    return [];
  }
  return profile[field];
}

function warnShellOnlyProtectedPaths(profile, profileLabel) {
  const protectedPaths = Array.isArray(profile.protectedPaths) ? profile.protectedPaths : [];
  const shellProtectedPaths = profileOptionalArrayOrEmpty(profile, "shellProtectedPaths", profileLabel);
  const readOnlyPaths = profileOptionalArrayOrEmpty(profile, "readOnlyPaths", profileLabel);
  const writeGuardedPaths = new Set([...protectedPaths, ...readOnlyPaths]);
  for (const candidate of shellProtectedPaths) {
    if (typeof candidate !== "string" || candidate.trim().length === 0) continue;
    if (writeGuardedPaths.has(candidate)) continue;
    warnings.push(`${profileLabel} shellProtectedPaths-only path ${candidate} blocks shell access only; add it to protectedPaths to block read/write, or readOnlyPaths to allow read but block write/shell`);
  }
}

function mcpSummary(file) {
  const json = readJsonIfPresent(file);
  if (!json) return { file, exists: fs.existsSync(file), serverCount: 0, servers: [] };
  const mcpServers = json.mcpServers && typeof json.mcpServers === "object" && !Array.isArray(json.mcpServers)
    ? json.mcpServers
    : {};
  return { file, exists: true, serverCount: Object.keys(mcpServers).length, servers: Object.keys(mcpServers).sort() };
}

let piHasMcpAdapter = false;
let piHasSubagents = false;
if (commandExists("pi")) {
  const piList = spawnSync("pi", ["list"], { encoding: "utf8" });
  const combined = `${piList.stdout ?? ""}\n${piList.stderr ?? ""}`;
  piHasMcpAdapter = combined.includes("pi-mcp-adapter");
  piHasSubagents = combined.includes("pi-subagents");
  if (!piHasMcpAdapter) warnings.push("Pi MCP adapter not found in `pi list`; run setup with --with-mcp or `pi install npm:pi-mcp-adapter@2.11.0`");
  if (!piHasSubagents) warnings.push("Pi subagents package not found in `pi list`; run setup with --with-subagents or `pi install npm:pi-subagents@0.35.1`");
}

const mcpFiles = [
  path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || "", ".config"), "mcp", "mcp.json"),
  path.join(process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME || "", ".pi", "agent"), "mcp.json"),
  path.join(projectPath, ".mcp.json"),
  path.join(projectPath, ".pi", "mcp.json")
];
const mcp = mcpFiles.map(mcpSummary);
const totalMcpServers = mcp.reduce((sum, item) => sum + item.serverCount, 0);
if (piHasMcpAdapter && totalMcpServers === 0) {
  warnings.push("Pi MCP adapter is installed but no MCP servers are configured; run `piagent-mcp --preset core --scope global` or `/mcp setup`");
}

const subagentConfigPath = path.join(process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME || "", ".pi", "agent"), "extensions", "subagent", "config.json");
const subagentConfig = readJsonIfPresent(subagentConfigPath);
if (piHasSubagents && !subagentConfig) {
  warnings.push("Pi subagents package is installed but config is missing; run `piagent-subagents --preset safe`");
}
if (subagentConfig && subagentConfig.toolDescriptionMode !== "compact") {
  warnings.push("Pi subagents toolDescriptionMode is not compact; token use may be higher");
}

const projectSettingsPath = path.join(projectPath, ".pi", "settings.json");
let projectPackageSource = "workspace";
let projectSkillPaths = [];
if (fs.existsSync(projectSettingsPath)) {
  const settings = readJson(projectSettingsPath);
  projectSkillPaths = Array.isArray(settings.skills) ? settings.skills.filter((entry) => typeof entry === "string") : [];
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  if (packages.length === 0) errors.push("project .pi/settings.json has no packages");
  const declaredSource = packages.find((source) => typeof source === "string" && source.length > 0);
  if (declaredSource) projectPackageSource = declaredSource;
  for (const source of packages) {
    if (typeof source === "string" && source.includes("__PIAGENT_PACKAGE_SOURCE__")) {
      errors.push("project .pi/settings.json still has package source placeholder");
    }
    if (strictShare && typeof source === "string" && source.startsWith("/")) {
      warnings.push(`project package source is absolute path, not team-portable: ${source}`);
    }
  }
} else {
  warnings.push("project has no .pi/settings.json");
}

// Pi already scans ~/.pi/agent/skills, ~/.agents/skills, .pi/skills, .agents/skills,
// and package.json entries. Only foreign-agent locations need an explicit settings entry,
// so re-declaring the native ones would only produce name-collision warnings.
function countSkillDirs(dir) {
  if (!fs.existsSync(dir)) return 0;
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, "SKILL.md")))
      .length;
  } catch {
    return 0;
  }
}

const skillWiring = [".claude/skills", ".codex/skills"].map((rel) => {
  const absolute = path.join(projectPath, rel);
  const skillCount = countSkillDirs(absolute);
  const wired = projectSkillPaths.includes(rel);
  if (skillCount > 0 && !wired) {
    warnings.push(`${skillCount} skill(s) exist in ${rel} but it is not listed in .pi/settings.json skills; Pi will not load them`);
  }
  return { path: rel, exists: fs.existsSync(absolute), skillCount, wired };
});

// Instruction files written for other agents. Onboarding reads AGENTS.md and README.md,
// so these are currently ignored; report them instead of skipping silently.
const foreignAgentConfig = ["CLAUDE.md", ".claude/rules", ".claude/agents", ".cursor/rules", ".github/copilot-instructions.md"]
  .filter((rel) => fs.existsSync(path.join(projectPath, rel)));
if (foreignAgentConfig.length > 0) {
  warnings.push(`project has agent instruction files this platform does not read: ${foreignAgentConfig.join(", ")}; onboarding uses AGENTS.md, so their rules are not enforced`);
}

const projectProfilePath = path.join(projectPath, ".pi", "piagent-profile.json");
let projectProfile = null;
if (fs.existsSync(projectProfilePath)) {
  const profile = readJson(projectProfilePath);
  projectProfile = profile;
  for (const field of ["schemaVersion", "projectId", "displayName", "mode"]) {
    if (profile[field] === undefined || profile[field] === "") errors.push(`project profile missing ${field}`);
  }
  for (const field of ["rootMarkers", "protectedPaths", "requiredContext", "mcpCapabilities"]) {
    if (!Array.isArray(profile[field])) errors.push(`project profile ${field} must be array`);
  }
  warnShellOnlyProtectedPaths(profile, "project profile");
  if (Array.isArray(profile.requiredContext) && !profile.requiredContext.includes(".pi/project-context.md")) {
    warnings.push("project profile does not require .pi/project-context.md");
  }
  if (Array.isArray(profile.capabilityPacks)) {
    const projectLockPath = path.join(projectPath, ".pi", "piagent-profile.lock.json");
    if (!fs.existsSync(projectLockPath)) {
      errors.push("project capability lock is missing");
    } else {
      try {
        const lock = readJson(projectLockPath);
        const verification = verifyCapabilityLock(platformRoot, projectProfilePath, lock, { packageSource: projectPackageSource });
        if (!verification.ok) errors.push("project capability lock is stale or does not match the configured package source");
      } catch (error) {
        errors.push(`project capability lock validation failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } else {
    warnings.push("project profile uses the legacy capability contract; apply a current profile to create a capability lock");
  }
} else {
  warnings.push("project has no .pi/piagent-profile.json");
}

const projectContextPath = path.join(projectPath, ".pi", "project-context.md");
if (fs.existsSync(projectContextPath)) {
  const projectContext = fs.readFileSync(projectContextPath, "utf8");
  if (/Generated:\s*not yet/i.test(projectContext)) {
    warnings.push("project onboarding snapshot is still pending; run /onboard-project in Pi after login/model selection");
  }
} else {
  warnings.push("project has no .pi/project-context.md; run setup/init or /onboard-project");
}

const contextIndexConfig = projectProfile && typeof projectProfile.contextIndex === "object" && !Array.isArray(projectProfile.contextIndex)
  ? projectProfile.contextIndex
  : {};
const contextIndexEnabled = contextIndexConfig.enabled !== false && contextIndexConfig.writePolicy !== "off";
const contextIndexRelativePath = typeof contextIndexConfig.path === "string" && contextIndexConfig.path.trim()
  ? contextIndexConfig.path.trim()
  : ".pi/context-index.json";
const contextIndexAbsolutePath = path.resolve(projectPath, contextIndexRelativePath);
const contextIndexEscapes = path.relative(projectPath, contextIndexAbsolutePath).startsWith("..") || path.isAbsolute(path.relative(projectPath, contextIndexAbsolutePath));
if (contextIndexEscapes) {
  errors.push(`project contextIndex.path escapes project root: ${contextIndexRelativePath}`);
} else if (!contextIndexEnabled) {
  warnings.push("project context index is disabled by profile");
} else if (fs.existsSync(contextIndexAbsolutePath)) {
  const contextIndex = readJsonIfPresent(contextIndexAbsolutePath);
  if (!contextIndex) {
    warnings.push(`project context index exists but cannot be parsed: ${contextIndexRelativePath}`);
  } else {
    const nodes = Array.isArray(contextIndex.nodes) ? contextIndex.nodes : [];
    const edges = Array.isArray(contextIndex.edges) ? contextIndex.edges : [];
    const citations = Array.isArray(contextIndex.citations) ? contextIndex.citations : [];
    if (contextIndex.schemaVersion !== 1) warnings.push("project context index schemaVersion should be 1");
    if (contextIndex.summary === "Pending. Run /onboard-project after login/model selection to generate the compact project context index.") {
      warnings.push("project context index is still pending; run /onboard-project after login/model selection");
    }
    if (nodes.length === 0) warnings.push("project context index has no nodes yet");
    if (contextIndex?.policy?.requireCitations !== false && citations.length === 0) warnings.push("project context index has no citations yet");
    if (nodes.length > (contextIndex?.policy?.maxNodes ?? 120)) warnings.push("project context index has more nodes than policy maxNodes");
    if (edges.length > (contextIndex?.policy?.maxEdges ?? 240)) warnings.push("project context index has more edges than policy maxEdges");
  }
} else {
  warnings.push(`project has no ${contextIndexRelativePath}; run setup/init or /onboard-project`);
}

const memorySummaryPath = path.join(projectPath, ".pi", "memory", "memory_summary.md");
const memoryHandbookPath = path.join(projectPath, ".pi", "memory", "MEMORY.md");
if (!fs.existsSync(memorySummaryPath) || !fs.existsSync(memoryHandbookPath)) {
  warnings.push("project has no .pi/memory scaffold; run setup/init or use /memory-policy before relying on project memory");
}

if (strictShare) {
  const shareCriticalFiles = [
    "README.md",
    "docs/quickstart-vietnamese.md",
    "docs/team-onboarding.md",
    "docs/project-onboarding.md",
    "docs/workflow-recipes.md",
    "docs/memory-policy.md",
    "docs/context-window-policy.md",
    "docs/publishing-for-teams.md",
    "templates/project/.pi/settings.json",
    "templates/project/.pi/context-index.json",
    "templates/global/settings.json",
    "packages/piagent-core/skills/piagent-source-cache/SKILL.md"
  ];
  const forbidden = [
    /\/Users\/[^/\s]+\/Documents\/Working\b/,
    /Documents\/Working/
  ];
  for (const rel of shareCriticalFiles) {
    const file = path.join(platformRoot, rel);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      if (pattern.test(text)) {
        errors.push(`share-critical file has local/default-forbidden reference ${pattern}: ${rel}`);
      }
    }
  }
}

const report = {
  platformRoot,
  projectPath,
  strictShare,
  runtime: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    surface: runtime.surface,
    status: runtime.status,
    teamRolloutReady: runtime.teamRolloutReady,
    note: runtime.note
  },
  piOnPath: commandExists("pi"),
  herdrOnPath: commandExists("herdr"),
  piHasMcpAdapter,
  piHasSubagents,
  mcp,
  skillWiring,
  foreignAgentConfig,
  subagents: {
    configPath: subagentConfigPath,
    configExists: Boolean(subagentConfig),
    config: subagentConfig
  },
  rootPiManifest: rootPackage.pi,
  warnings,
  errors
};

console.log(JSON.stringify(report, null, 2));
if (errors.length > 0) process.exit(1);
NODE
