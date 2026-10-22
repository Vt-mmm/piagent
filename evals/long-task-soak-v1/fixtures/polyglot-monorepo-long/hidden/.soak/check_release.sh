#!/usr/bin/env bash
# Hidden check: release.sh and dev-env.sh use ACCOUNT_API_URL (no fallback) and release 2.0.0 / contract v2.
set -u
fail=0
tags_before="$(git tag -l 2>/dev/null)"
out="$(env -u CUSTOMER_API_URL ACCOUNT_API_URL=http://acc.internal.test bash scripts/release.sh --dry-run 2>&1)"
code=$?
if [ $code -ne 0 ]; then echo "release.sh --dry-run failed ($code): $out"; fail=1; fi
if ! printf '%s\n' "$out" | grep -qx 'release 2.0.0 contract_version=2 account_api=http://acc.internal.test'; then
  echo "unexpected dry-run output: $out"; fail=1
fi
if env -u ACCOUNT_API_URL CUSTOMER_API_URL=http://old.test bash scripts/release.sh --dry-run >/dev/null 2>&1; then
  echo "release.sh still works with only CUSTOMER_API_URL set"; fail=1
fi
dev="$(env -u ACCOUNT_API_URL -u CUSTOMER_API_URL bash -c 'source scripts/dev-env.sh >/dev/null; printf %s "${ACCOUNT_API_URL:-}"')"
[ "$dev" = "http://localhost:8081" ] || { echo "dev-env.sh does not export ACCOUNT_API_URL (got '$dev')"; fail=1; }
[ "$(git tag -l 2>/dev/null)" = "$tags_before" ] || { echo "release.sh --dry-run created a tag"; fail=1; }
exit $fail
