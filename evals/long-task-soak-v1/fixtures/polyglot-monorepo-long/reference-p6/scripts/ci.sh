#!/usr/bin/env bash
# Run every check of the monorepo: bash scripts/ci.sh (from anywhere).
# Each step prints "ci: <step> ok|FAIL"; all steps run; exit 1 if any failed.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GO_IMAGE="golang:1.26.3-alpine3.23"
LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/shopflow-ci.XXXXXX")"
trap 'rm -rf "$LOG_DIR"' EXIT
failed=0

step() {
  local name="$1"; shift
  if ( cd "$ROOT" && "$@" ) >"$LOG_DIR/$name.log" 2>&1; then
    echo "ci: $name ok"
  else
    echo "ci: $name FAIL"
    tail -n 40 "$LOG_DIR/$name.log" | sed "s/^/  [$name] /"
    failed=$((failed + 1))
  fi
}

python_tests() { cd services/pricing-py && python3 -m unittest discover -s tests; }
script_tests() { python3 -m unittest discover -s scripts/tests; }
node_tests() { cd services/web-js && node --test 'test/*.test.js'; }
# The repo is streamed into the container (works even outside Docker's shared folders).
go_tests() {
  COPYFILE_DISABLE=1 tar -cf - services/ledger-go shared | docker run -i --rm "$GO_IMAGE" \
    sh -c 'mkdir -p /src && tar -xf - -C /src && cd /src/services/ledger-go && go vet ./... && go test -count=1 ./...'
}
release_dry_run() { ACCOUNT_API_URL="${ACCOUNT_API_URL:-http://localhost:8081}" bash scripts/release.sh --dry-run; }
log_report() { python3 scripts/log_report.py logs/prod-2025-10.log | python3 -c 'import json, sys; json.load(sys.stdin)'; }

step python python_tests
step scripts script_tests
step node node_tests
step go go_tests
step release release_dry_run
step log-report log_report

if [ "$failed" -eq 0 ]; then
  echo "ci: all ok"
  exit 0
fi
echo "ci: $failed failed"
exit 1
