#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/configure-model-scope.sh [options]

Options:
  --preset <full|codex|claude>       Model families to enable (default: full = both)
  --default-model <provider/model[:thinking]>
                                     Default model (default: openai-codex/gpt-5.5:xhigh)
  --settings <path>                  Pi settings file (default: ~/.pi/agent/settings.json)
  --dry-run                          Print resulting settings JSON without writing
  -h, --help

Purpose:
  Configure Pi's native model selector/cycling settings:
  - defaultProvider
  - defaultModel
  - defaultThinkingLevel
  - enabledModels

After this, users select models with Pi's built-in UI:
  /model or Ctrl+L       selector
  /scoped-models         edit cycling scope
  Ctrl+P                 cycle scoped models
  Shift+Tab              cycle thinking level
USAGE
}

PRESET="full"
DEFAULT_MODEL="openai-codex/gpt-5.5:xhigh"
SETTINGS_PATH="${PI_CODING_AGENT_DIR:-"${HOME}/.pi/agent"}/settings.json"
DRY_RUN=false

# A flag whose value is missing swallows the next flag instead. `--settings
# --dry-run` used to set the settings path to the string "--dry-run", leave
# DRY_RUN false, then write a file by that name and report success — a run that
# both skipped the dry run it was asked for and never touched the real settings.
require_value() {
  local option="$1"
  local value="${2:-}"
  if [[ -z "$value" || "$value" == --* ]]; then
    echo "Missing value for $option" >&2
    exit 2
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --preset)
      require_value "$1" "${2:-}"
      PRESET="$2"
      shift 2
      ;;
    --default-model)
      require_value "$1" "${2:-}"
      DEFAULT_MODEL="$2"
      shift 2
      ;;
    --settings)
      require_value "$1" "${2:-}"
      SETTINGS_PATH="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$PRESET" in
  full|codex|claude) ;;
  *)
    echo "FAIL: --preset must be full, codex, or claude (model families)" >&2
    exit 2
    ;;
esac

node --input-type=module - "$SETTINGS_PATH" "$PRESET" "$DEFAULT_MODEL" "$DRY_RUN" <<'NODE'
import fs from "node:fs";
import path from "node:path";

const [settingsPath, preset, defaultModelInput, dryRunRaw] = process.argv.slice(2);
const dryRun = dryRunRaw === "true";

const codexModels = [
  "openai-codex/gpt-5.3-codex-spark:minimal",
  "openai-codex/gpt-5.4-mini:minimal",
  "openai-codex/gpt-5.4:xhigh",
  "openai-codex/gpt-5.5:xhigh",
  "openai-codex/gpt-5.6-luna:xhigh",
  "openai-codex/gpt-5.6-sol:xhigh",
  "openai-codex/gpt-5.6-terra:xhigh"
];

const claudeModels = [
  "anthropic/claude-haiku-4-5:low",
  "anthropic/claude-sonnet-4-5:high",
  "anthropic/claude-sonnet-4-6:max",
  "anthropic/claude-sonnet-5:xhigh",
  "anthropic/claude-opus-4-5:xhigh",
  "anthropic/claude-opus-4-6:max",
  "anthropic/claude-opus-4-7:xhigh",
  "anthropic/claude-opus-4-8:xhigh",
  "anthropic/claude-fable-5:xhigh"
];

const enabledModels = preset === "codex"
  ? codexModels
  : preset === "claude"
    ? claudeModels
    : [...codexModels, ...claudeModels];

function parseDefaultModel(input) {
  const match = input.match(/^([^/]+)\/([^:]+)(?::(.+))?$/);
  if (!match) {
    throw new Error(`--default-model must look like provider/model[:thinking], got: ${input}`);
  }
  return {
    provider: match[1],
    model: match[2],
    thinking: match[3] || "xhigh"
  };
}

const parsedDefault = parseDefaultModel(defaultModelInput);
const settings = fs.existsSync(settingsPath)
  ? JSON.parse(fs.readFileSync(settingsPath, "utf8"))
  : {};

settings.defaultProvider = parsedDefault.provider;
settings.defaultModel = parsedDefault.model;
settings.defaultThinkingLevel = parsedDefault.thinking;
settings.enabledModels = enabledModels;

const output = `${JSON.stringify(settings, null, 2)}\n`;
if (dryRun) {
  process.stdout.write(output);
} else {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, output);
  console.log(`Configured Pi model scope: ${settingsPath}`);
  console.log(`  preset: ${preset}`);
  console.log(`  default: ${parsedDefault.provider}/${parsedDefault.model}:${parsedDefault.thinking}`);
  console.log(`  enabledModels: ${enabledModels.length}`);
}
NODE
