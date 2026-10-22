#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
docker rm -f "phong-hop-pg-$(pwd | shasum | cut -c1-10)" >/dev/null 2>&1 || true
