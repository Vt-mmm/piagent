#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/configure-subagents.sh [options]

Purpose:
  Configure pi-subagents with a safe, token-conscious baseline.

Options:
  --preset <minimal|safe|async|parallel>
                                  Runtime preset (default: safe)
  --config <path>                 Subagent config path (default: ~/.pi/agent/extensions/subagent/config.json)
  --settings <path>               Pi settings path (default: ~/.pi/agent/settings.json)
  --model-scope <none|piagent|codex|claude>   model family for subagents
                                  Optional subagent model allowlist written to settings (default: none)
  --dry-run                       Print merged config/settings summary without writing
  --list                          Print available presets
  -h, --help

Recommended:
  piagent-subagents --preset safe

After installing/configuring:
  pi
  /subagents-doctor
  /subagents-models
  /run scout "Map the auth flow"
USAGE
}

PRESET="safe"
CONFIG_PATH="${PI_CODING_AGENT_DIR:-"${HOME}/.pi/agent"}/extensions/subagent/config.json"
SETTINGS_PATH="${PI_CODING_AGENT_DIR:-"${HOME}/.pi/agent"}/settings.json"
MODEL_SCOPE="none"
DRY_RUN=false
LIST=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --preset)
      PRESET="${2:-}"
      shift 2
      ;;
    --config)
      CONFIG_PATH="${2:-}"
      shift 2
      ;;
    --settings)
      SETTINGS_PATH="${2:-}"
      shift 2
      ;;
    --model-scope)
      MODEL_SCOPE="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    --list)
      LIST=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

node --input-type=module - "$CONFIG_PATH" "$SETTINGS_PATH" "$PRESET" "$MODEL_SCOPE" "$DRY_RUN" "$LIST" <<'NODE'
import fs from "node:fs";
import path from "node:path";

const [configPath, settingsPath, presetName, modelScopeName, dryRunRaw, listRaw] = process.argv.slice(2);
const dryRun = dryRunRaw === "true";
const listOnly = listRaw === "true";

const presets = {
  minimal: {
    toolDescriptionMode: "compact",
    asyncByDefault: false,
    asyncWidget: true,
    forceTopLevelAsync: false,
    waitTool: { enabled: true },
    intercomBridge: { mode: "always" },
    globalConcurrencyLimit: 4,
    maxSubagentSpawnsPerSession: 16,
    maxSubagentDepth: 1,
    defaultSessionDir: "~/.pi/agent/sessions/subagent",
    singleRunOutputBaseDir: "~/.pi/agent/subagent-outputs",
    worktreeBaseDir: "~/.pi/agent/worktrees/pi-subagents",
    scheduledRuns: { enabled: false, maxPending: 20, maxLatenessMs: 300000 },
    parallel: { maxTasks: 4, concurrency: 2 },
    completionBatch: { enabled: true, debounceMs: 150, maxWaitMs: 1000 }
  },
  safe: {
    toolDescriptionMode: "compact",
    asyncByDefault: false,
    asyncWidget: true,
    forceTopLevelAsync: false,
    waitTool: { enabled: true },
    intercomBridge: { mode: "always" },
    globalConcurrencyLimit: 8,
    maxSubagentSpawnsPerSession: 32,
    maxSubagentDepth: 1,
    defaultSessionDir: "~/.pi/agent/sessions/subagent",
    singleRunOutputBaseDir: "~/.pi/agent/subagent-outputs",
    worktreeBaseDir: "~/.pi/agent/worktrees/pi-subagents",
    scheduledRuns: { enabled: false, maxPending: 20, maxLatenessMs: 300000 },
    parallel: { maxTasks: 6, concurrency: 3 },
    completionBatch: { enabled: true, debounceMs: 150, maxWaitMs: 1000, stragglerDebounceMs: 75, stragglerMaxWaitMs: 400, stragglerWindowMs: 2000 }
  },
  async: {
    toolDescriptionMode: "compact",
    asyncByDefault: true,
    asyncWidget: true,
    forceTopLevelAsync: false,
    waitTool: { enabled: true },
    intercomBridge: { mode: "always" },
    globalConcurrencyLimit: 8,
    maxSubagentSpawnsPerSession: 32,
    maxSubagentDepth: 1,
    defaultSessionDir: "~/.pi/agent/sessions/subagent",
    singleRunOutputBaseDir: "~/.pi/agent/subagent-outputs",
    worktreeBaseDir: "~/.pi/agent/worktrees/pi-subagents",
    scheduledRuns: { enabled: false, maxPending: 20, maxLatenessMs: 300000 },
    parallel: { maxTasks: 6, concurrency: 3 },
    completionBatch: { enabled: true, debounceMs: 150, maxWaitMs: 1000, stragglerDebounceMs: 75, stragglerMaxWaitMs: 400, stragglerWindowMs: 2000 }
  },
  parallel: {
    toolDescriptionMode: "compact",
    asyncByDefault: false,
    asyncWidget: true,
    forceTopLevelAsync: false,
    waitTool: { enabled: true },
    intercomBridge: { mode: "always" },
    globalConcurrencyLimit: 12,
    maxSubagentSpawnsPerSession: 64,
    maxSubagentDepth: 1,
    defaultSessionDir: "~/.pi/agent/sessions/subagent",
    singleRunOutputBaseDir: "~/.pi/agent/subagent-outputs",
    worktreeBaseDir: "~/.pi/agent/worktrees/pi-subagents",
    scheduledRuns: { enabled: false, maxPending: 20, maxLatenessMs: 300000 },
    parallel: { maxTasks: 10, concurrency: 5 },
    completionBatch: { enabled: true, debounceMs: 150, maxWaitMs: 1000, stragglerDebounceMs: 75, stragglerMaxWaitMs: 400, stragglerWindowMs: 2000 }
  }
};

const modelScopes = {
  none: null,
  piagent: { enforce: true, allow: ["openai-codex/*", "anthropic/*"] },
  codex: { enforce: true, allow: ["openai-codex/*"] },
  claude: { enforce: true, allow: ["anthropic/*"] }
};

if (listOnly) {
  console.log(JSON.stringify({
    presets: Object.keys(presets),
    modelScopes
  }, null, 2));
  process.exit(0);
}

if (!Object.hasOwn(presets, presetName)) {
  console.error(`FAIL: unknown preset: ${presetName}`);
  console.error(`Available presets: ${Object.keys(presets).join(", ")}`);
  process.exit(2);
}

if (!Object.hasOwn(modelScopes, modelScopeName)) {
  console.error(`FAIL: unknown model scope: ${modelScopeName}`);
  console.error(`Available model scopes: ${Object.keys(modelScopes).join(", ")}`);
  process.exit(2);
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return structuredClone(fallback);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`FAIL: cannot parse JSON: ${file}`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function mergeObject(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object" && !Array.isArray(base[key])) {
      out[key] = mergeObject(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

const existingConfig = readJson(configPath, {});
const mergedConfig = mergeObject(existingConfig && typeof existingConfig === "object" && !Array.isArray(existingConfig) ? existingConfig : {}, presets[presetName]);

const existingSettings = readJson(settingsPath, {});
const mergedSettings = existingSettings && typeof existingSettings === "object" && !Array.isArray(existingSettings) ? existingSettings : {};
if (modelScopes[modelScopeName]) {
  mergedSettings.subagents = mergedSettings.subagents && typeof mergedSettings.subagents === "object" && !Array.isArray(mergedSettings.subagents)
    ? mergedSettings.subagents
    : {};
  mergedSettings.subagents.modelScope = modelScopes[modelScopeName];
}

const report = {
  preset: presetName,
  configPath,
  settingsPath,
  modelScope: modelScopeName,
  dryRun,
  config: mergedConfig,
  settingsSubagents: mergedSettings.subagents ?? null
};

if (dryRun) {
  console.log(JSON.stringify(report, null, 2));
} else {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(mergedConfig, null, 2)}\n`);
  if (modelScopes[modelScopeName]) {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, `${JSON.stringify(mergedSettings, null, 2)}\n`);
  }
  console.log(JSON.stringify(report, null, 2));
}
NODE
