#!/usr/bin/env bash
# Release pricing-py, web-js and ledger-go at the same version.
#   bash scripts/release.sh --dry-run   # check and print, change nothing
#   bash scripts/release.sh             # check, then tag v<version>
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS="$ROOT/shared/contracts"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

die() { echo "release: $*" >&2; exit 1; }

: "${ACCOUNT_API_URL:?ACCOUNT_API_URL must be set (see .env.example)}"

# The newest contract version among order*.schema.json.
contract_version=0
for schema in "$CONTRACTS"/order*.schema.json; do
  v="$(sed -n 's/.*"x-contract-version": *\([0-9][0-9]*\).*/\1/p' "$schema")"
  [ -n "$v" ] || die "no x-contract-version in $(basename "$schema")"
  [ "$v" -gt "$contract_version" ] && contract_version="$v"
done
[ "$contract_version" -gt 0 ] || die "no order schema in $CONTRACTS"

web_version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/services/web-js/package.json" | head -n 1)"
py_version="$(sed -n 's/^__version__ = "\(.*\)"$/\1/p' "$ROOT/services/pricing-py/pricing/__init__.py")"
go_version="$(sed -n 's/^const Version = "\(.*\)"$/\1/p' "$ROOT"/services/ledger-go/ledger/*.go | head -n 1)"
[ "$web_version" = "$py_version" ] || die "web-js is $web_version but pricing-py is $py_version"
[ "$web_version" = "$go_version" ] || die "web-js is $web_version but ledger-go is ${go_version:-missing}"

grep -q "^## \[$web_version\]" "$ROOT/CHANGELOG.md" || die "CHANGELOG.md has no section for $web_version"

# v2 samples (legacy v1 *compat* samples are read only through the compat shims).
for sample in "$CONTRACTS"/fixtures/*.json; do
  case "$(basename "$sample")" in *compat*) continue ;; esac
  grep -q '"contract_version": *2\b' "$sample" || die "$(basename "$sample") is not contract_version 2"
  grep -q '"account_id"' "$sample" || die "$(basename "$sample") has no account_id"
  grep -q '"account_tier"' "$sample" || die "$(basename "$sample") has no account_tier"
done
# v3 samples.
for sample in "$CONTRACTS"/fixtures/v3/*.json; do
  [ -e "$sample" ] || die "no v3 sample in fixtures/v3/"
  grep -q '"contract_version": *3\b' "$sample" || die "v3/$(basename "$sample") is not contract_version 3"
  grep -q '"settlement_currency"' "$sample" || die "v3/$(basename "$sample") has no settlement_currency"
  grep -q '"fx_rate_ppm"' "$sample" || die "v3/$(basename "$sample") has no fx_rate_ppm"
done

echo "release $web_version contract_version=$contract_version account_api=$ACCOUNT_API_URL"
if [ "$DRY_RUN" = 1 ]; then
  echo "dry run: nothing tagged"
  exit 0
fi
git -C "$ROOT" tag -a "v$web_version" -m "Release $web_version (contract v$contract_version)"
echo "tagged v$web_version"
