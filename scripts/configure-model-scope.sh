#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/configure-model-scope.sh [options]

Options:
  --preset <full|codex|claude>       Model families to enable (default: full = both)
  --default-model <provider/model[:thinking]>
                                     Default model (default: openai-codex/gpt-6-sol:high)
  --settings <path>                  Pi settings file (default: ~/.pi/agent/settings.json)
  --dry-run                          Print resulting settings JSON without writing
  --prune                            Only remove enabledModels patterns that match no model
                                     Pi knows (Pi warns about each on every start); keep the rest
  --keep-member-choices              Install/update mode: set the default model and model list
                                     only where Pi has none yet; otherwise keep the member's and
                                     add only models this release offers for the first time
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
DEFAULT_MODEL="openai-codex/gpt-6-sol:high"
SETTINGS_PATH="${PI_CODING_AGENT_DIR:-"${HOME}/.pi/agent"}/settings.json"
DRY_RUN=false
PRUNE=false
KEEP=false

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
    --prune)
      PRUNE=true
      shift
      ;;
    --keep-member-choices)
      KEEP=true
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

if [[ "$PRUNE" == true ]]; then
  if [[ "$DRY_RUN" == true ]]; then
    exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/model-scope-prune.mjs" --settings "$SETTINGS_PATH"
  fi
  exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/model-scope-prune.mjs" --settings "$SETTINGS_PATH" --fix
fi

case "$PRESET" in
  full|codex|claude) ;;
  *)
    echo "FAIL: --preset must be full, codex, or claude (model families)" >&2
    exit 2
    ;;
esac

PIAGENT_SCOPE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)" node --input-type=module - "$SETTINGS_PATH" "$PRESET" "$DEFAULT_MODEL" "$DRY_RUN" "$KEEP" <<'NODE'
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
const { prepareClaudeModelAdditions } = await import(pathToFileURL(process.env.PIAGENT_SCOPE_ROOT + "/scripts/claude-model-additions.mjs"));

const [settingsPath, preset, defaultModelInput, dryRunRaw, keepRaw] = process.argv.slice(2);
const dryRun = dryRunRaw === "true";
const keep = keepRaw === "true";

const codexModels = [
  "openai-codex/gpt-5.3-codex-spark:minimal",
  "openai-codex/gpt-5.5:high",
  "openai-codex/gpt-5.6-luna:medium",
  "openai-codex/gpt-5.6-terra:high",
  "openai-codex/gpt-5.6-sol:high",
  "openai-codex/gpt-6-luna:medium",
  "openai-codex/gpt-6-sol:medium",
  "openai-codex/gpt-6-sol:high",
  "openai-codex/gpt-6-astra:xhigh",
  "openai-codex/*"
];

const claudeModels = [
  "anthropic/claude-haiku-4-5:low",
  "anthropic/claude-sonnet-4-5:high",
  "anthropic/claude-sonnet-4-6:max",
  "anthropic/claude-sonnet-5:xhigh",
  "anthropic/claude-sonnet-5-5:high",
  "anthropic/claude-opus-5-5:high",
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
    thinking: match[3] || "high"
  };
}

const parsedDefault = parseDefaultModel(defaultModelInput);
const settingsBefore = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, "utf8") : null;
const settings = settingsBefore === null ? {} : JSON.parse(settingsBefore);

// What Piagent last offered, so an update adds only models new to this
// release and never puts back one the member removed.
const recordPath = path.join(path.dirname(settingsPath), "piagent-model-scope.json");
let offered = null;
try { const record = JSON.parse(fs.readFileSync(recordPath, "utf8")); if (Array.isArray(record.offered)) offered = record.offered; } catch { /* none yet */ }
const notes = [];
if (!keep || !settings.defaultModel) {
  settings.defaultProvider = parsedDefault.provider;
  settings.defaultModel = parsedDefault.model;
  settings.defaultThinkingLevel = parsedDefault.thinking;
} else {
  notes.push(`kept the member's default: ${settings.defaultProvider ?? "?"}/${settings.defaultModel}${settings.defaultThinkingLevel ? `:${settings.defaultThinkingLevel}` : ""}`);
}
if (!keep || !Array.isArray(settings.enabledModels) || settings.enabledModels.length === 0) {
  settings.enabledModels = enabledModels;
} else {
  // Installed before this record existed: the member's list stays, and the
  // record starts now.
  const fresh = offered ? enabledModels.filter((model) => !offered.includes(model) && !settings.enabledModels.includes(model)) : [];
  settings.enabledModels = [...settings.enabledModels, ...fresh];
  notes.push(fresh.length ? `kept the member's model list, added ${fresh.join(", ")}` : "kept the member's model list");
}

const catalogEdit = preset === "codex" ? null : prepareClaudeModelAdditions(path.join(path.dirname(settingsPath), "models.json"));
const output = `${JSON.stringify(settings, null, 2)}\n`;
if (dryRun) {
  process.stdout.write(output);
} else {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, output);
  try { if (catalogEdit) catalogEdit.apply(); }
  catch (error) {
    if (fs.readFileSync(settingsPath, "utf8") === output) {
      if (settingsBefore === null) fs.unlinkSync(settingsPath);
      else fs.writeFileSync(settingsPath, settingsBefore);
    }
    throw error;
  }
  fs.writeFileSync(recordPath, `${JSON.stringify({ version: 1, preset, offered: enabledModels }, null, 2)}\n`);
  console.log(`Configured Pi model scope: ${settingsPath}`);
  console.log(`  preset: ${preset}`);
  console.log(`  default: ${settings.defaultProvider}/${settings.defaultModel}:${settings.defaultThinkingLevel}`);
  console.log(`  enabledModels: ${settings.enabledModels.length}`);
  for (const note of notes) console.log(`  ${note}`);
}
NODE
