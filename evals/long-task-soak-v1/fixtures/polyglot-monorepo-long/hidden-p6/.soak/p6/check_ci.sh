#!/usr/bin/env bash
# Hidden check (p6): scripts/ci.sh runs every step and passes; a failing Python test
# or a failing Go test makes it fail. Runs on scratch copies of the repo without
# the hidden acceptance files (those are checked by the other checks).
set -u
[ -f scripts/ci.sh ] || { echo "scripts/ci.sh is missing"; exit 1; }
scratch="$(mktemp -d)"; trap 'rm -rf "$scratch"' EXIT
copy() { # $1 destination: the repo minus .git and the hidden overlay
  mkdir -p "$1"
  tar -cf - --exclude=./.git --exclude=./.soak --exclude='*hidden*' --exclude=./services/ledger-go/cmd/zzsoakeval . | tar -xf - -C "$1"
}
want_steps="python scripts node go release log-report"

copy "$scratch/clean"
out="$(cd / && bash "$scratch/clean/scripts/ci.sh" 2>&1)"; code=$?
[ $code -eq 0 ] || { echo "ci.sh exit $code (run from /)"; printf '%s\n' "$out" | tail -n 60; exit 1; }
for s in $want_steps; do
  printf '%s\n' "$out" | grep -qx "ci: $s ok" || { echo "ci.sh does not report 'ci: $s ok'"; printf '%s\n' "$out" | tail -n 40; exit 1; }
done
printf '%s\n' "$out" | tail -n 1 | grep -qx 'ci: all ok' || { echo "last line is not 'ci: all ok'"; exit 1; }

copy "$scratch/canary"
cat > "$scratch/canary/services/pricing-py/tests/test_zz_ci_canary.py" <<'PY'
import unittest
class Canary(unittest.TestCase):
    def test_fails(self):
        self.fail("canary")
PY
cat > "$scratch/canary/services/ledger-go/ledger/zz_ci_canary_test.go" <<'GO'
package ledger

import "testing"

func TestCICanary(t *testing.T) { t.Fatal("canary") }
GO
out="$(bash "$scratch/canary/scripts/ci.sh" 2>&1)"; code=$?
[ $code -ne 0 ] || { echo "ci.sh passes with a failing Python test and a failing Go test"; exit 1; }
printf '%s\n' "$out" | grep -qx 'ci: python FAIL' || { echo "ci.sh does not report 'ci: python FAIL' for a failing Python test"; printf '%s\n' "$out" | grep '^ci:'; exit 1; }
printf '%s\n' "$out" | grep -qx 'ci: go FAIL' || { echo "ci.sh does not report 'ci: go FAIL' for a failing Go test"; printf '%s\n' "$out" | grep '^ci:'; exit 1; }
printf '%s\n' "$out" | grep -qx 'ci: node ok' || { echo "ci.sh stopped after the first failing step"; exit 1; }
printf '%s\n' "$out" | tail -n 1 | grep -qx 'ci: 2 failed' || { echo "last line should be 'ci: 2 failed'"; exit 1; }
exit 0
