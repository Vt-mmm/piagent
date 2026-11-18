#!/usr/bin/env bash
# Repository dependency audit for CI.
# Published dependencies: no high or critical advisory, no exceptions.
# Whole tree (build tools included): the runtime advisory policy, with the
# dated owner exceptions in dev-advisory-exceptions.json.
set -euo pipefail
cd "$(dirname "$0")/.."
npm audit --audit-level=high --omit=dev
report="$(npm audit --json || true)"
printf '%s' "$report" | PIAGENT_ADVISORY_EXCEPTIONS=scripts/dev-advisory-exceptions.json node scripts/check-runtime-advisories.mjs
