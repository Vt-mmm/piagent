#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  piagent-auto [--read-only|--workspace-write|--full-access] [--no-approve] [--] [pi args...]

Purpose:
  Launch Pi with project-local trust approved for this run.

Examples:
  piagent-auto
  piagent-auto --name "payment scout"
  piagent-auto --read-only -p "Scout payment mapping. Do not edit source."
  piagent-auto --full-access -p "Run the trusted local benchmark suite."
  piagent-auto -- --model openai-codex/gpt-5.5:xhigh

Notes:
  - This wraps `pi --approve`; it does not disable Piagent guardrails.
  - Protected paths, destructive shell checks, task gates, and verify evidence still run.
  - Use `--read-only` for guard-enforced read-only mode.
  - Use `--full-access` only for trusted projects in an externally safe environment.
  - Use `--no-approve` to force Pi to ignore project-local resources for this run.
USAGE
}

PERMISSION_PROFILE="workspace-write"
APPROVE_FLAG="--approve"
ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      usage
      exit 0
      ;;
    --read-only)
      PERMISSION_PROFILE="read-only"
      shift
      ;;
    --workspace-write)
      PERMISSION_PROFILE="workspace-write"
      shift
      ;;
    --full-access|--trusted-full-access)
      PERMISSION_PROFILE="trusted-full-access"
      shift
      ;;
    --no-approve|-na)
      APPROVE_FLAG="--no-approve"
      shift
      ;;
    --approve|-a)
      APPROVE_FLAG="--approve"
      shift
      ;;
    --)
      shift
      ARGS+=("$@")
      break
      ;;
    *)
      ARGS+=("$1")
      shift
      ;;
  esac
done

if ! command -v pi >/dev/null 2>&1; then
  echo "FAIL: pi is not on PATH. Run piagent-setup or follow the exact-version install flow in docs/release-install-policy.md." >&2
  exit 1
fi

if [[ "$PERMISSION_PROFILE" == "read-only" ]]; then
  exec env PIAGENT_PERMISSION_PROFILE="$PERMISSION_PROFILE" pi "$APPROVE_FLAG" --exclude-tools bash,write,edit "${ARGS[@]}"
fi

exec env PIAGENT_PERMISSION_PROFILE="$PERMISSION_PROFILE" pi "$APPROVE_FLAG" "${ARGS[@]}"
