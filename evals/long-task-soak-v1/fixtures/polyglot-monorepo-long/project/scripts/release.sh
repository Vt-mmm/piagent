#!/usr/bin/env bash
# Release both services at the same version.
#   bash scripts/release.sh --dry-run   # check and print, change nothing
#   bash scripts/release.sh             # check, then tag v<version>
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCHEMA="$ROOT/shared/contracts/order.schema.json"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

die() { echo "release: $*" >&2; exit 1; }

: "${CUSTOMER_API_URL:?CUSTOMER_API_URL must be set (see .env.example)}"

contract_version="$(sed -n 's/.*"x-contract-version": *\([0-9][0-9]*\).*/\1/p' "$SCHEMA")"
[ -n "$contract_version" ] || die "no x-contract-version in $SCHEMA"

web_version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$ROOT/services/web-js/package.json" | head -n 1)"
py_version="$(sed -n 's/^__version__ = "\(.*\)"$/\1/p' "$ROOT/services/pricing-py/pricing/__init__.py")"
[ "$web_version" = "$py_version" ] || die "web-js is $web_version but pricing-py is $py_version"

grep -q "^## \[$web_version\]" "$ROOT/CHANGELOG.md" || die "CHANGELOG.md has no section for $web_version"

# Every sample payload must be on the current contract version and carry the customer fields.
for sample in "$ROOT"/shared/contracts/fixtures/*.json; do
  grep -q "\"contract_version\": *$contract_version\b" "$sample" || die "$(basename "$sample") is not contract_version $contract_version"
  grep -q '"customer_id"' "$sample" || die "$(basename "$sample") has no customer_id"
  grep -q '"customer_tier"' "$sample" || die "$(basename "$sample") has no customer_tier"
done

echo "release $web_version contract_version=$contract_version customer_api=$CUSTOMER_API_URL"
if [ "$DRY_RUN" = 1 ]; then
  echo "dry run: nothing tagged"
  exit 0
fi
git -C "$ROOT" tag -a "v$web_version" -m "Release $web_version (contract v$contract_version)"
echo "tagged v$web_version"
