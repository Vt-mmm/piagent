#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/pi-model-catalog.sh [--json] [--provider <provider>]

Examples:
  scripts/pi-model-catalog.sh
  scripts/pi-model-catalog.sh --provider openai-codex
  scripts/pi-model-catalog.sh --provider anthropic --json

Notes:
  - Reads Pi's local model catalog at ~/.pi/agent/models-store.json by default.
  - Run `pi update --models` first when you want the newest provider catalog.
  - `pi --list-models` may hide models until a provider credential is available;
    this script reads the local catalog directly so docs/presets can be reviewed.
USAGE
}

FORMAT="text"
PROVIDER=""

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
    --json)
      FORMAT="json"
      shift
      ;;
    --provider)
      require_value "$1" "${2:-}"
      PROVIDER="$2"
      shift 2
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

node --input-type=module - "$FORMAT" "$PROVIDER" <<'NODE'
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [format, providerFilter] = process.argv.slice(2);
const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const catalogPath = path.join(agentDir, "models-store.json");

if (!fs.existsSync(catalogPath)) {
  console.error(`FAIL: Pi model catalog not found: ${catalogPath}`);
  console.error("Hint: run `pi update --models` or open Pi once after login.");
  process.exit(1);
}

const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));
const targetProviders = providerFilter ? [providerFilter] : ["openai-codex", "anthropic"];

function explicitThinkingLevels(model) {
  if (!model.reasoning) return "no";
  const map = model.thinkingLevelMap;
  if (!map || typeof map !== "object") return "yes";
  const levels = Object.entries(map)
    .filter(([, value]) => value !== null && value !== false)
    .map(([key]) => key);
  return levels.length > 0 ? levels.join(",") : "yes";
}

function recommendedThinking(model) {
  if (!model.reasoning) return "";
  const raw = explicitThinkingLevels(model);
  if (raw === "yes") return "xhigh";
  if (raw === "no") return "";
  const levels = raw.split(",");
  for (const preferred of ["xhigh", "max", "high", "medium", "low", "minimal"]) {
    if (levels.includes(preferred)) return preferred;
  }
  return levels[0] ?? "xhigh";
}

function roleFor(provider, id) {
  if (provider === "openai-codex") {
    if (/mini|spark/i.test(id)) return "fast";
    if (/5\.4$/.test(id)) return "balanced";
    if (/5\.5/.test(id)) return "balanced,hard";
    if (/luna/i.test(id)) return "focused-hard";
    if (/sol/i.test(id)) return "strategic-deep";
    if (/terra/i.test(id)) return "huge-context";
    return "general";
  }
  if (provider === "anthropic") {
    if (/haiku/i.test(id)) return "fast";
    if (/sonnet/i.test(id)) return "balanced,hard";
    if (/opus/i.test(id)) return "strategic-deep";
    if (/fable/i.test(id)) return "huge-context,deep";
    return "general";
  }
  return "general";
}

const rows = [];
for (const provider of targetProviders) {
  const models = catalog[provider]?.models ?? [];
  for (const model of models) {
    rows.push({
      provider,
      id: model.id,
      name: model.name ?? model.id,
      contextWindow: model.contextWindow ?? null,
      maxTokens: model.maxTokens ?? null,
      reasoning: Boolean(model.reasoning),
      thinking: explicitThinkingLevels(model),
      recommendedThinking: recommendedThinking(model),
      images: Array.isArray(model.input) && model.input.includes("image"),
      role: roleFor(provider, model.id),
      example: `${provider}/${model.id}${model.reasoning ? `:${recommendedThinking(model)}` : ""}`
    });
  }
}

if (format === "json") {
  console.log(JSON.stringify({ catalogPath, providers: targetProviders, models: rows }, null, 2));
  process.exit(0);
}

const number = (value) => value === null || value === undefined ? "?" : Number(value).toLocaleString("en-US");
console.log(`# Pi Agent model catalog`);
console.log();
console.log(`Source: ${catalogPath}`);
console.log(`Tip: run \`pi update --models\` before checking latest model versions.`);
console.log();
for (const provider of targetProviders) {
  const providerRows = rows.filter((row) => row.provider === provider);
  console.log(`## ${provider}`);
  console.log();
  if (providerRows.length === 0) {
    console.log("_No models found in local catalog._");
    console.log();
    continue;
  }
  console.log("| Model | Role | Context | Max output | Thinking | Images | Command example |");
  console.log("|---|---|---:|---:|---|---|---|");
  for (const row of providerRows) {
    console.log(`| \`${row.id}\` | ${row.role} | ${number(row.contextWindow)} | ${number(row.maxTokens)} | ${row.thinking} | ${row.images ? "yes" : "no"} | \`pi --model ${row.example}\` |`);
  }
  console.log();
}
NODE
