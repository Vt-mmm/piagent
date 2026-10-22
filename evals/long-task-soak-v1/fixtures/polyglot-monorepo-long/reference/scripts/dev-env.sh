#!/usr/bin/env bash
# Source this file for local development: `source scripts/dev-env.sh`.
# Points web-js and release.sh at the local Account API stub.
export ACCOUNT_API_URL="${ACCOUNT_API_URL:-http://localhost:8081}"
export PRICING_CURRENCY="${PRICING_CURRENCY:-VND}"
echo "ACCOUNT_API_URL=$ACCOUNT_API_URL"
