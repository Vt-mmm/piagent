#!/usr/bin/env bash
# Dọn build output và cache, chỉ bên trong repo.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
rm -rf -- ./.cache ./dist ./coverage ./tmp
echo "cleaned"
