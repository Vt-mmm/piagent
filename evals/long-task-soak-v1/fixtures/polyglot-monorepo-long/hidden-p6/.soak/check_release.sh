#!/usr/bin/env bash
# Hidden check (p6 regression): release 3.0.0 across three services, contract v3, ACCOUNT_API_URL only, v3 samples checked.
set -u
fail=0
tags_before="$(git tag -l 2>/dev/null)"
out="$(env -u CUSTOMER_API_URL ACCOUNT_API_URL=http://acc.internal.test bash scripts/release.sh --dry-run 2>&1)"
code=$?
if [ $code -ne 0 ]; then echo "release.sh --dry-run failed ($code): $out"; fail=1; fi
if ! printf '%s\n' "$out" | grep -qx 'release 3.0.0 contract_version=3 account_api=http://acc.internal.test'; then
  echo "unexpected dry-run output: $out"; fail=1
fi
if env -u ACCOUNT_API_URL CUSTOMER_API_URL=http://old.test bash scripts/release.sh --dry-run >/dev/null 2>&1; then
  echo "release.sh still works with only CUSTOMER_API_URL set"; fail=1
fi
dev="$(env -u ACCOUNT_API_URL -u CUSTOMER_API_URL bash -c 'source scripts/dev-env.sh >/dev/null; printf %s "${ACCOUNT_API_URL:-}"')"
[ "$dev" = "http://localhost:8081" ] || { echo "dev-env.sh does not export ACCOUNT_API_URL (got '$dev')"; fail=1; }
[ "$(git tag -l 2>/dev/null)" = "$tags_before" ] || { echo "release.sh --dry-run created a tag"; fail=1; }

# Negative cases on a scratch copy: a broken v3 sample, and a ledger-go version that lags behind.
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/repo" && tar -cf - --exclude=./logs --exclude=./.git . | tar -xf - -C "$scratch/repo"
sample="$(ls "$scratch"/repo/shared/contracts/fixtures/v3/*.json 2>/dev/null | head -n 1)"
if [ -z "$sample" ]; then echo "no v3 sample in shared/contracts/fixtures/v3/"; fail=1
else
  cp "$sample" "$scratch/sample.bak"
  /usr/bin/python3 -c 'import json,sys; p=sys.argv[1]; d=json.load(open(p)); d.pop("fx_rate_ppm", None); json.dump(d, open(p, "w"), indent=2)' "$sample"
  if ACCOUNT_API_URL=http://x.test bash "$scratch/repo/scripts/release.sh" --dry-run >/dev/null 2>&1; then
    echo "release.sh accepts a v3 sample without fx_rate_ppm"; fail=1
  fi
  cp "$scratch/sample.bak" "$sample"
fi
if grep -rlq 'Version = "3.0.0"' "$scratch/repo/services/ledger-go/ledger/" 2>/dev/null; then
  grep -rl 'Version = "3.0.0"' "$scratch/repo/services/ledger-go/ledger/" | xargs sed -i.bak 's/Version = "3.0.0"/Version = "2.9.0"/'
  if ACCOUNT_API_URL=http://x.test bash "$scratch/repo/scripts/release.sh" --dry-run >/dev/null 2>&1; then
    echo "release.sh does not compare the ledger-go version"; fail=1
  fi
else
  echo "services/ledger-go/ledger has no Version = \"3.0.0\""; fail=1
fi
exit $fail
