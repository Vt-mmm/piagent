#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/quality-benchmark.sh <project-path> --init
  scripts/quality-benchmark.sh <project-path> --record --scenario <name> --surface <name> --result <pass|fail|partial> [options]

Options:
  --task-file <path>      File containing task prompt/spec.
  --verify <command>      Verification command used for the run.
  --tokens <number>       Total tokens reported by the agent/provider.
  --input-tokens <number> Fresh input tokens reported by the provider.
  --output-tokens <number>
                          Output tokens reported by the provider.
  --cache-read-tokens <number>
                          Cached input tokens reported by the provider.
  --cost <number>         Cost reported for the run.
  --duration <seconds>    Wall-clock duration.
  --first-correct-edit <seconds>
                          Time until the first edit retained in the final fix.
  --rework <number>       Number of discarded/reworked edit attempts.
  --notes <text>          Short notes or quality observations.
  --agent <name>          Backward-compatible alias for --surface.

Output:
  <project-path>/.pi/benchmarks/quality-runs.jsonl
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

PROJECT_PATH="${1:-}"
if [[ -z "$PROJECT_PATH" ]]; then
  usage
  exit 2
fi
# The project path is positional and comes first, so omitting it hands the first
# flag to `cd` and the run dies somewhere further down complaining about an
# option. Say what is actually wrong instead.
if [[ "$PROJECT_PATH" == -* ]]; then
  echo "FAIL: the project path comes first, before any flag; received: $PROJECT_PATH" >&2
  usage >&2
  exit 2
fi
shift || true

PROJECT_PATH="$(cd "$PROJECT_PATH" && pwd)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE=""
SCENARIO=""
SURFACE=""
RESULT=""
TASK_FILE=""
VERIFY_CMD=""
TOKENS=""
INPUT_TOKENS=""
OUTPUT_TOKENS=""
CACHE_READ_TOKENS=""
COST=""
DURATION=""
FIRST_CORRECT_EDIT=""
REWORK=""
NOTES=""

# A flag left without a value otherwise consumes the next flag as its value, and
# the run continues on a record that says something nobody typed.
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
    --init)
      MODE="init"
      shift
      ;;
    --record)
      MODE="record"
      shift
      ;;
    --scenario)
      require_value "$1" "${2:-}"
      SCENARIO="$2"
      shift 2
      ;;
    --surface|--agent)
      require_value "$1" "${2:-}"
      SURFACE="$2"
      shift 2
      ;;
    --result)
      require_value "$1" "${2:-}"
      RESULT="$2"
      shift 2
      ;;
    --task-file)
      require_value "$1" "${2:-}"
      TASK_FILE="$2"
      shift 2
      ;;
    --verify)
      require_value "$1" "${2:-}"
      VERIFY_CMD="$2"
      shift 2
      ;;
    --tokens)
      require_value "$1" "${2:-}"
      TOKENS="$2"
      shift 2
      ;;
    --input-tokens)
      require_value "$1" "${2:-}"
      INPUT_TOKENS="$2"
      shift 2
      ;;
    --output-tokens)
      require_value "$1" "${2:-}"
      OUTPUT_TOKENS="$2"
      shift 2
      ;;
    --cache-read-tokens)
      require_value "$1" "${2:-}"
      CACHE_READ_TOKENS="$2"
      shift 2
      ;;
    --cost)
      require_value "$1" "${2:-}"
      COST="$2"
      shift 2
      ;;
    --duration)
      require_value "$1" "${2:-}"
      DURATION="$2"
      shift 2
      ;;
    --first-correct-edit)
      require_value "$1" "${2:-}"
      FIRST_CORRECT_EDIT="$2"
      shift 2
      ;;
    --rework)
      require_value "$1" "${2:-}"
      REWORK="$2"
      shift 2
      ;;
    --notes)
      require_value "$1" "${2:-}"
      NOTES="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

BENCHMARK_DIR="$PROJECT_PATH/.pi/benchmarks"
mkdir -p "$BENCHMARK_DIR"

if [[ "$MODE" == "init" ]]; then
  cat > "$BENCHMARK_DIR/quality-scenarios.md" <<'SCENARIOS'
# Agent quality benchmark scenarios

Use the same scenario, acceptance criteria, and verification command across approved agent surfaces before making quality, token, or cost claims.

## Scenario 1: read-only scout

- Goal: inspect repo structure and produce implementation plan.
- Must not edit files.
- Evidence: context files read, plan, risks, verify command proposal.

## Scenario 2: bounded source fix

- Goal: implement a small bugfix with clear acceptance criteria.
- Evidence: changed files, verify command exit 0, trace/handoff.

## Scenario 3: backend-readonly to frontend implementation

- Goal: scout backend/spec read-only, implement frontend mapping only.
- Evidence: backend contract snapshot, frontend changed files, frontend verify pass.
SCENARIOS
  echo "Initialized benchmark scenarios: $BENCHMARK_DIR/quality-scenarios.md"
  exit 0
fi

if [[ "$MODE" != "record" || -z "$SCENARIO" || -z "$SURFACE" || -z "$RESULT" ]]; then
  usage
  exit 2
fi

case "$RESULT" in
  pass|fail|partial) ;;
  *)
    echo "--result must be pass, fail, or partial" >&2
    exit 2
    ;;
esac

# Keep benchmark evidence and context-efficiency evidence in the same record.
# Failure here does not invalidate a task result; it leaves the optional
# contextEfficiency field null for older hosts or telemetry-disabled runs.
if [[ -f "$SCRIPT_DIR/context-engine.mjs" ]]; then
  node "$SCRIPT_DIR/context-engine.mjs" efficiency --project "$PROJECT_PATH" --json >/dev/null 2>&1 || true
fi

export PI_BENCHMARK_PROJECT_PATH="$PROJECT_PATH"
export PI_BENCHMARK_SCENARIO="$SCENARIO"
export PI_BENCHMARK_SURFACE="$SURFACE"
export PI_BENCHMARK_RESULT="$RESULT"
export PI_BENCHMARK_TASK_FILE="$TASK_FILE"
export PI_BENCHMARK_VERIFY="$VERIFY_CMD"
export PI_BENCHMARK_TOKENS="$TOKENS"
export PI_BENCHMARK_INPUT_TOKENS="$INPUT_TOKENS"
export PI_BENCHMARK_OUTPUT_TOKENS="$OUTPUT_TOKENS"
export PI_BENCHMARK_CACHE_READ_TOKENS="$CACHE_READ_TOKENS"
export PI_BENCHMARK_COST="$COST"
export PI_BENCHMARK_DURATION="$DURATION"
export PI_BENCHMARK_FIRST_CORRECT_EDIT="$FIRST_CORRECT_EDIT"
export PI_BENCHMARK_REWORK="$REWORK"
export PI_BENCHMARK_NOTES="$NOTES"

node --input-type=module <<'NODE'
import fs from "node:fs";
import path from "node:path";

const root = process.env.PI_BENCHMARK_PROJECT_PATH;
const target = path.join(root, ".pi", "benchmarks", "quality-runs.jsonl");
const numberOrNull = (value) => {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const contextReportPath = path.join(root, ".pi", "piagent-state", "context-engine", "efficiency-report.json");
let contextReport = null;
try {
  contextReport = JSON.parse(fs.readFileSync(contextReportPath, "utf8"));
} catch {
  // Context telemetry is optional and may be disabled for a baseline run.
}
const payload = {
  schemaVersion: 2,
  recordedAt: new Date().toISOString(),
  scenario: process.env.PI_BENCHMARK_SCENARIO,
  surface: process.env.PI_BENCHMARK_SURFACE,
  result: process.env.PI_BENCHMARK_RESULT,
  taskFile: process.env.PI_BENCHMARK_TASK_FILE || null,
  verifyCommand: process.env.PI_BENCHMARK_VERIFY || null,
  tokens: numberOrNull(process.env.PI_BENCHMARK_TOKENS),
  inputTokens: numberOrNull(process.env.PI_BENCHMARK_INPUT_TOKENS),
  outputTokens: numberOrNull(process.env.PI_BENCHMARK_OUTPUT_TOKENS),
  cacheReadTokens: numberOrNull(process.env.PI_BENCHMARK_CACHE_READ_TOKENS),
  cost: numberOrNull(process.env.PI_BENCHMARK_COST),
  durationSeconds: numberOrNull(process.env.PI_BENCHMARK_DURATION),
  firstCorrectEditSeconds: numberOrNull(process.env.PI_BENCHMARK_FIRST_CORRECT_EDIT),
  reworkCount: numberOrNull(process.env.PI_BENCHMARK_REWORK),
  contextEfficiency: contextReport
    ? {
        generatedAt: contextReport.generatedAt ?? null,
        sample: contextReport.sample ?? null,
        metrics: contextReport.metrics ?? null
      }
    : null,
  notes: process.env.PI_BENCHMARK_NOTES || null
};
fs.appendFileSync(target, `${JSON.stringify(payload)}\n`);
console.log(`Recorded benchmark run: ${target}`);
NODE
