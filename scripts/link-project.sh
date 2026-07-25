#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <project-path> <adapter-profile-json> [package-source]" >&2
  echo "Deprecated wrapper. Prefer scripts/init-project.sh <project-path> --profile <name-or-json> --package-source <source>" >&2
  exit 2
fi

PROJECT_PATH="$1"
ADAPTER_PROFILE="$2"
PACKAGE_SOURCE="${3:-${PIAGENT_PACKAGE_SOURCE:-}}"
PLATFORM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

args=(
  "$PROJECT_PATH"
  --profile "$ADAPTER_PROFILE"
)

if [[ -n "$PACKAGE_SOURCE" ]]; then
  args+=(--package-source "$PACKAGE_SOURCE")
fi

echo "WARN: link-project.sh is deprecated; forwarding to init-project.sh" >&2
exec "$PLATFORM_ROOT/scripts/init-project.sh" "${args[@]}"
