#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  echo "Usage: scripts/audit-runtime-host.sh"
  echo "Audit the exact Pi host and pinned optional add-ons used by the installer; requires registry access."
  exit 0
fi
if [[ $# -gt 0 ]]; then
  echo "Unknown argument: $1" >&2
  exit 2
fi

require_exact_peer() {
  local name="$1"
  local value
  value="$(node -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(p.peerDependencies?.[process.argv[2]] ?? "");' "$ROOT/package.json" "$name")"
  if [[ ! "$value" =~ ^[0-9]+\.[0-9]+\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]]; then
    echo "FAIL: peer dependency $name must use an exact version." >&2
    exit 1
  fi
  printf '%s' "$value"
}

PI_CODING_VERSION="$(require_exact_peer "@earendil-works/pi-coding-agent")"
PI_AI_VERSION="$(require_exact_peer "@earendil-works/pi-ai")"
TYPEBOX_VERSION="$(require_exact_peer "typebox")"
PI_MCP_ADAPTER_VERSION="2.11.0"
PI_SUBAGENTS_VERSION="0.35.1"
PI_WEB_ACCESS_VERSION="0.13.0"

if [[ "$PI_CODING_VERSION" != "$PI_AI_VERSION" ]]; then
  echo "FAIL: Pi Coding Agent and Pi AI host versions must match." >&2
  exit 1
fi

AUDIT_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/piagent-runtime-audit.XXXXXX")"
cleanup() {
  node --input-type=module - "$AUDIT_ROOT" <<'NODE'
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const target = path.resolve(process.argv[2]);
const tempRoot = fs.realpathSync(os.tmpdir());
const targetParent = fs.realpathSync(path.dirname(target));
if (targetParent !== tempRoot || !/^piagent-runtime-audit\.[A-Za-z0-9]+$/.test(path.basename(target))) {
  throw new Error(`refusing to remove unexpected audit directory: ${target}`);
}
fs.rmSync(target, { recursive: true, force: true });
NODE
}
trap cleanup EXIT

node --input-type=module - "$AUDIT_ROOT/package.json" <<'NODE'
import fs from "node:fs";
const target = process.argv[2];
fs.writeFileSync(target, `${JSON.stringify({ name: "piagent-runtime-audit", version: "0.0.0", private: true }, null, 2)}\n`);
NODE

echo "Auditing Pi host ${PI_CODING_VERSION} and pinned add-ons at severity high and above..."
(
  cd "$AUDIT_ROOT"
  npm install --package-lock-only --ignore-scripts --no-audit --no-fund \
    "@earendil-works/pi-coding-agent@${PI_CODING_VERSION}" \
    "@earendil-works/pi-ai@${PI_AI_VERSION}" \
    "typebox@${TYPEBOX_VERSION}" \
    "pi-mcp-adapter@${PI_MCP_ADAPTER_VERSION}" \
    "pi-subagents@${PI_SUBAGENTS_VERSION}" \
    "pi-web-access@${PI_WEB_ACCESS_VERSION}" >/dev/null
  # npm audit exits non-zero when it finds anything, so its status says nothing
  # about whether the finding is one this project has accepted. The policy check
  # decides that, and its exit status is the one that counts.
  npm audit --json > audit.json || true
  node "$ROOT/scripts/check-runtime-advisories.mjs" < audit.json
)
