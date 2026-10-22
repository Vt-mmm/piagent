#!/usr/bin/env bash
# Soak oracle: (1) the hidden acceptance spec under the oracle's own config,
# (2) the member's own e2e suite under the project's playwright.config.js.
# Each run gets its own free port so parallel runs never collide.
set -euo pipefail
cd "$(dirname "$0")/.."
free_port() { node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }
npx playwright --version
echo "== hidden acceptance spec"
PORT=$(free_port) npx playwright test -c playwright.hidden.config.mjs --reporter=line
echo "== project's own e2e suite"
ls playwright.config.* >/dev/null 2>&1 || { echo "no playwright config in the project"; exit 1; }
PORT=$(free_port) npx playwright test --reporter=line --grep-invert @hidden
