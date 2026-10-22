#!/usr/bin/env bash
# Source this file for local development: `source scripts/dev-env.sh`.
# Points web-js and release.sh at the local Customer API stub.
export CUSTOMER_API_URL="${CUSTOMER_API_URL:-http://localhost:8081}"
export PRICING_CURRENCY="${PRICING_CURRENCY:-VND}"
echo "CUSTOMER_API_URL=$CUSTOMER_API_URL"
