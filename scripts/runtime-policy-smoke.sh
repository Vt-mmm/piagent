#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

PROJECT="$TMP_ROOT/sample-project"
PLATFORM_VERSION="$(node -p "require(process.argv[1]).version" "$ROOT/package.json")"
mkdir -p "$PROJECT"
cat > "$PROJECT/README.md" <<'README'
# Sample Project
README
cat > "$PROJECT/AGENTS.md" <<'AGENTS'
# Sample Agent Instructions

Use project profile and verify before done.
AGENTS

bash "$ROOT/scripts/init-project.sh" "$PROJECT" --profile generic --package-source "git:github.com/Vt-mmm/piagent@v${PLATFORM_VERSION}" >/dev/null
bash "$ROOT/scripts/profile-doctor.sh" "$PROJECT" >/dev/null
bash "$ROOT/scripts/quality-benchmark.sh" "$PROJECT" --init >/dev/null
bash "$ROOT/scripts/quality-benchmark.sh" "$PROJECT" --record --scenario smoke --surface pi --result pass --tokens 1 --verify "test -s README.md" >/dev/null

node --input-type=module - "$PROJECT/.pi/piagent-profile.json" "$PROJECT/.pi/benchmarks/quality-runs.jsonl" "$ROOT" <<'NODE'
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [profilePath, benchmarkPath, platformRoot] = process.argv.slice(2);
const stored = JSON.parse(fs.readFileSync(profilePath, "utf8"));

// A project that names an adapter stores identity and overrides only. The policy
// the runtime enforces is the resolved document, so that is what gets checked.
const { resolveProjectProfileDocument } = await import(
  pathToFileURL(path.join(platformRoot, "packages", "piagent-core", "capabilities", "project-profile.js")).href
);
const profile = resolveProjectProfileDocument(platformRoot, stored).profile;
for (const capability of ["filesystem-readonly", "filesystem-write", "shell", "memory"]) {
  if (!profile.mcpCapabilities.includes(capability)) {
    throw new Error(`missing capability ${capability}`);
  }
}
const runtimePolicy = profile.runtimePolicy ?? {};
for (const key of ["execPolicy", "contextBudget", "toolRegistry", "finalGate"]) {
  if (!runtimePolicy[key]) throw new Error(`missing runtimePolicy.${key}`);
}
const runs = fs.readFileSync(benchmarkPath, "utf8").trim().split(/\n+/).map((line) => JSON.parse(line));
if (runs.length !== 1 || runs[0].scenario !== "smoke" || runs[0].surface !== "pi" || runs[0].result !== "pass") {
  throw new Error("benchmark smoke record is invalid");
}
NODE

echo "PASS: runtime policy smoke"
