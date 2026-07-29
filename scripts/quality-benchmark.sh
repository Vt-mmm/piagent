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
  --cost <number>         Cost reported for the run.
  --duration <seconds>    Wall-clock duration.
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
MODE=""
SCENARIO=""
SURFACE=""
RESULT=""
TASK_FILE=""
VERIFY_CMD=""
TOKENS=""
COST=""
DURATION=""
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

export PI_BENCHMARK_PROJECT_PATH="$PROJECT_PATH"
export PI_BENCHMARK_SCENARIO="$SCENARIO"
export PI_BENCHMARK_SURFACE="$SURFACE"
export PI_BENCHMARK_RESULT="$RESULT"
export PI_BENCHMARK_TASK_FILE="$TASK_FILE"
export PI_BENCHMARK_VERIFY="$VERIFY_CMD"
export PI_BENCHMARK_TOKENS="$TOKENS"
export PI_BENCHMARK_COST="$COST"
export PI_BENCHMARK_DURATION="$DURATION"
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
const payload = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  scenario: process.env.PI_BENCHMARK_SCENARIO,
  surface: process.env.PI_BENCHMARK_SURFACE,
  result: process.env.PI_BENCHMARK_RESULT,
  taskFile: process.env.PI_BENCHMARK_TASK_FILE || null,
  verifyCommand: process.env.PI_BENCHMARK_VERIFY || null,
  tokens: numberOrNull(process.env.PI_BENCHMARK_TOKENS),
  cost: numberOrNull(process.env.PI_BENCHMARK_COST),
  durationSeconds: numberOrNull(process.env.PI_BENCHMARK_DURATION),
  notes: process.env.PI_BENCHMARK_NOTES || null
};
fs.appendFileSync(target, `${JSON.stringify(payload)}\n`);
console.log(`Recorded benchmark run: ${target}`);
NODE
