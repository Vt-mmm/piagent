#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OFFLINE=false

usage() {
  cat <<'USAGE'
Usage:
  scripts/verify-local.sh [--offline]

Options:
  --offline   Skip checks that require a local Pi login/model catalog.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --offline)
      OFFLINE=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

required_files=(
  "$ROOT/README.md"
  "$ROOT/SECURITY.md"
  "$ROOT/AGENTS.md"
  "$ROOT/CHANGELOG.md"
  "$ROOT/.npmignore"
  "$ROOT/package.json"
  "$ROOT/package-lock.json"
  "$ROOT/tsconfig.json"
  "$ROOT/.github/workflows/verify.yml"
  "$ROOT/.github/workflows/codeql.yml"
  "$ROOT/.github/dependabot.yml"
  "$ROOT/types/pi-runtime-shims.d.ts"
  "$ROOT/.pi/settings.json"
  "$ROOT/.pi/piagent-profile.json"
  "$ROOT/.pi/piagent-profile.lock.json"
  "$ROOT/.pi/project-context.md"
  "$ROOT/packages/piagent-core/package.json"
  "$ROOT/packages/piagent-core/extensions/piagent-guard.ts"
  "$ROOT/packages/piagent-core/extensions/policy-core.js"
  "$ROOT/packages/piagent-core/extensions/redaction-core.js"
  "$ROOT/packages/piagent-core/extensions/runtime-evidence.js"
  "$ROOT/packages/piagent-core/security/sensitive-data.js"
  "$ROOT/packages/piagent-core/capabilities/capability-core.js"
  "$ROOT/packages/piagent-core/prompts/onboard-project.md"
  "$ROOT/packages/piagent-core/prompts/piagent-commands.md"
  "$ROOT/packages/piagent-core/prompts/model-options.md"
  "$ROOT/packages/piagent-core/prompts/memory-policy.md"
  "$ROOT/packages/piagent-core/prompts/platform-improve.md"
  "$ROOT/packages/piagent-core/prompts/be-to-fe.md"
  "$ROOT/packages/piagent-core/prompts/scout.md"
  "$ROOT/packages/piagent-core/prompts/task.md"
  "$ROOT/packages/piagent-core/prompts/commit.md"
  "$ROOT/packages/piagent-core/prompts/pr.md"
  "$ROOT/packages/piagent-core/prompts/discuss.md"
  "$ROOT/packages/piagent-core/prompts/plan.md"
  "$ROOT/packages/piagent-core/prompts/review.md"
  "$ROOT/packages/piagent-core/skills/piagent-ops/SKILL.md"
  "$ROOT/packages/piagent-core/skills/piagent-source-cache/SKILL.md"
  "$ROOT/packages/piagent-core/skills/piagent-source-cache/checkout-source-repo.sh"
  "$ROOT/packages/piagent-core/subagents/piagent-scout.md"
  "$ROOT/packages/piagent-core/subagents/piagent-planner.md"
  "$ROOT/packages/piagent-core/subagents/piagent-worker.md"
  "$ROOT/packages/piagent-core/subagents/piagent-reviewer.md"
  "$ROOT/packages/piagent-core/subagents/piagent-oracle.md"
  "$ROOT/adapters/generic/profile.json"
  "$ROOT/adapters/backend-api/profile.json"
  "$ROOT/adapters/be-readonly-fe/profile.json"
  "$ROOT/adapters/data/profile.json"
  "$ROOT/adapters/devops/profile.json"
  "$ROOT/adapters/docs/profile.json"
  "$ROOT/adapters/fullstack/profile.json"
  "$ROOT/adapters/mobile/profile.json"
  "$ROOT/adapters/node-typescript/profile.json"
  "$ROOT/adapters/python/profile.json"
  "$ROOT/adapters/web-frontend/profile.json"
  "$ROOT/templates/project/.pi/settings.json"
  "$ROOT/templates/project/.pi/piagent-profile.json"
  "$ROOT/templates/project/.mcp.json"
  "$ROOT/templates/project/.pi/mcp.json"
  "$ROOT/templates/project/.pi/project-context.md"
  "$ROOT/templates/project/.pi/context-index.json"
  "$ROOT/templates/project/.pi/tech-stack.json"
  "$ROOT/templates/project/.pi/tech-context/README.md"
  "$ROOT/templates/project/.pi/.npmignore"
  "$ROOT/templates/project/.pi/memory/memory_summary.md"
  "$ROOT/templates/project/.pi/memory/MEMORY.md"
  "$ROOT/templates/project/.pi/.gitignore"
  "$ROOT/templates/project/.pi/gitignore.template"
  "$ROOT/templates/project/REVIEW_GUIDELINES.md"
  "$ROOT/docs/quickstart-vietnamese.md"
  "$ROOT/docs/command-reference-vietnamese.md"
  "$ROOT/docs/auto-delegation-policy.md"
  "$ROOT/docs/subagent-orchestration-capabilities.md"
  "$ROOT/docs/project-onboarding.md"
  "$ROOT/docs/workflow-recipes.md"
  "$ROOT/docs/memory-policy.md"
  "$ROOT/docs/model-options.md"
  "$ROOT/docs/oauth-providers.md"
  "$ROOT/docs/subagents-and-multiagent.md"
  "$ROOT/docs/distribution-standard.md"
  "$ROOT/docs/release-install-policy.md"
  "$ROOT/docs/security-threat-model.md"
  "$ROOT/docs/vercel-docs-site.md"
  "$ROOT/docs/publishing-for-teams.md"
  "$ROOT/docs/herdr-workflow.md"
  "$ROOT/docs/runtime-harness-standard.md"
  "$ROOT/docs/task-implementation-contract.md"
  "$ROOT/docs/runtime-quality-baseline.md"
  "$ROOT/docs/quality-benchmark.md"
  "$ROOT/docs/package-architecture-notes.md"
  "$ROOT/docs/capability-packs.md"
  "$ROOT/docs/runtime-policy-design.md"
  "$ROOT/docs-site/index.html"
  "$ROOT/docs-site/favicon.svg"
  "$ROOT/docs-site/assets/piagent-logo.svg"
  "$ROOT/docs-site/vercel.json"
  "$ROOT/schemas/project-profile.schema.json"
  "$ROOT/schemas/task-contract.schema.json"
  "$ROOT/schemas/capability-pack.schema.json"
  "$ROOT/schemas/capability-recipe.schema.json"
  "$ROOT/schemas/eval-scenario.schema.json"
  "$ROOT/schemas/action-proposal.schema.json"
  "$ROOT/packs/engineering-base/pack.json"
  "$ROOT/packs/engineering-base/recipes/bounded-change.json"
  "$ROOT/packs/web-delivery/pack.json"
  "$ROOT/packs/web-delivery/recipes/verified-web-change.json"
  "$ROOT/evals/scenarios/capability-resolution.json"
  "$ROOT/catalog/capabilities.json"
  "$ROOT/templates/project/.pi/task-contract.template.json"
  "$ROOT/scripts/install-global.sh"
  "$ROOT/scripts/audit-runtime-host.sh"
  "$ROOT/scripts/verify-release-identity.mjs"
  "$ROOT/scripts/verify-vercel-link.mjs"
  "$ROOT/scripts/piagent-cli.mjs"
  "$ROOT/scripts/init-project.sh"
  "$ROOT/scripts/setup.sh"
  "$ROOT/scripts/team-doctor.sh"
  "$ROOT/scripts/link-project.sh"
  "$ROOT/scripts/profile-doctor.sh"
  "$ROOT/scripts/quality-benchmark.sh"
  "$ROOT/scripts/runtime-policy-smoke.sh"
  "$ROOT/scripts/pi-session-stats.sh"
  "$ROOT/scripts/pi-auto.sh"
  "$ROOT/scripts/pi-model-catalog.sh"
  "$ROOT/scripts/configure-model-scope.sh"
  "$ROOT/scripts/configure-mcp.sh"
  "$ROOT/scripts/configure-subagents.sh"
  "$ROOT/scripts/capability-catalog.mjs"
  "$ROOT/scripts/migrate-project-state.mjs"
  "$ROOT/scripts/import-agent-instructions.mjs"
  "$ROOT/tests/capability-core.test.mjs"
  "$ROOT/tests/piagent-guard-integration.test.mjs"
  "$ROOT/tests/install-global.test.mjs"
  "$ROOT/tests/package-distribution.test.mjs"
  "$ROOT/tests/release-identity.test.mjs"
  "$ROOT/tests/policy-core.test.mjs"
  "$ROOT/tests/redaction-core.test.mjs"
  "$ROOT/tests/runtime-evidence.test.mjs"
  "$ROOT/tests/golden-enforcement.test.mjs"
  "$ROOT/tests/capability-sources.test.mjs"
  "$ROOT/packages/piagent-core/capabilities/capability-sources.js"
  "$ROOT/packages/piagent-core/extensions/guard-shell-analysis.ts"
  "$ROOT/tests/migrate-project-state.test.mjs"
  "$ROOT/tests/import-agent-instructions.test.mjs"
  "$ROOT/evals/golden/enforcement-decisions.json"
)

for file in "${required_files[@]}"; do
  if [[ ! -s "$file" ]]; then
    echo "Missing required file: $file"
    exit 1
  fi
done

node --input-type=module - "$ROOT" <<'NODE'
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2];
const jsonFiles = [
  "package.json",
  ".mcp.json",
  ".pi/settings.json",
  ".pi/piagent-profile.json",
  ".pi/piagent-profile.lock.json",
  "packages/piagent-core/package.json",
  "packages/piagent-core/policies/base-policy.json",
  "adapters/generic/profile.json",
  "adapters/backend-api/profile.json",
  "adapters/be-readonly-fe/profile.json",
  "adapters/data/profile.json",
  "adapters/devops/profile.json",
  "adapters/docs/profile.json",
  "adapters/fullstack/profile.json",
  "adapters/mobile/profile.json",
  "adapters/node-typescript/profile.json",
  "adapters/python/profile.json",
  "adapters/web-frontend/profile.json",
  "templates/project/.pi/settings.json",
  "templates/project/.pi/piagent-profile.json",
  "templates/project/.mcp.json",
  "templates/project/.pi/task-contract.template.json",
  "templates/project/.pi/mcp.json",
  "templates/global/settings.json",
  "templates/global/mcp.json",
  "schemas/project-profile.schema.json",
  "schemas/task-contract.schema.json",
  "schemas/capability-pack.schema.json",
  "schemas/capability-recipe.schema.json",
  "schemas/eval-scenario.schema.json",
  "schemas/action-proposal.schema.json",
  "packs/engineering-base/pack.json",
  "packs/engineering-base/recipes/bounded-change.json",
  "packs/web-delivery/pack.json",
  "packs/web-delivery/recipes/verified-web-change.json",
  "evals/scenarios/capability-resolution.json",
  "catalog/capabilities.json"
];

for (const rel of jsonFiles) {
  const target = path.join(root, rel);
  JSON.parse(fs.readFileSync(target, "utf8"));
}

const rootPkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (!rootPkg.pi || !rootPkg.pi.extensions || !rootPkg.pi.prompts || !rootPkg.pi.skills) {
  throw new Error("root package.json missing pi manifest");
}
if (!rootPkg.pi.subagents?.agents?.length) {
  throw new Error("root package.json missing pi.subagents.agents");
}
const expectedPeers = {
  "@earendil-works/pi-ai": "0.81.1",
  "@earendil-works/pi-coding-agent": "0.81.1",
  typebox: "1.1.38"
};
for (const [name, version] of Object.entries(expectedPeers)) {
  if (rootPkg.peerDependencies?.[name] !== version) throw new Error(`root package peer ${name} must be pinned to ${version}`);
  if (rootPkg.peerDependenciesMeta?.[name]?.optional !== true) throw new Error(`root package peer ${name} must remain optional`);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, "packages/piagent-core/package.json"), "utf8"));
if (!pkg.pi || !pkg.pi.extensions || !pkg.pi.prompts || !pkg.pi.skills) {
  throw new Error("packages/piagent-core/package.json missing pi manifest");
}
if (!pkg.pi.subagents?.agents?.length) {
  throw new Error("packages/piagent-core/package.json missing pi.subagents.agents");
}
NODE

grep -R "auth.json" "$ROOT/docs" "$ROOT/packages/piagent-core" "$ROOT/templates" >/dev/null
grep -R "piagent_context" "$ROOT/packages/piagent-core" >/dev/null
grep -R "piagent_permission_status" "$ROOT/packages/piagent-core" "$ROOT/docs" "$ROOT/README.md" >/dev/null
grep -R "/full-access" "$ROOT/docs" "$ROOT/README.md" "$ROOT/packages/piagent-core/README.md" >/dev/null
grep -R "piagent_exec_policy_check" "$ROOT/packages/piagent-core" "$ROOT/docs" "$ROOT/templates/project/AGENTS.md" >/dev/null
grep -R "piagent_context_budget" "$ROOT/packages/piagent-core" "$ROOT/docs" "$ROOT/templates/project/AGENTS.md" >/dev/null
grep -R "piagent_tool_policy_check" "$ROOT/packages/piagent-core" "$ROOT/docs" "$ROOT/templates/project/AGENTS.md" >/dev/null
grep -R "piagent_task_gate_check" "$ROOT/packages/piagent-core" "$ROOT/docs" "$ROOT/templates/project/AGENTS.md" >/dev/null
grep -R "piagent_usage_snapshot" "$ROOT/packages/piagent-core" "$ROOT/docs" "$ROOT/templates/project/AGENTS.md" >/dev/null
grep -R "/piagent-usage" "$ROOT/packages/piagent-core" "$ROOT/docs" "$ROOT/README.md" >/dev/null
grep -R "/piagent-commands" "$ROOT/README.md" "$ROOT/docs" "$ROOT/packages/piagent-core/prompts" >/dev/null
grep -R "auto-delegation" "$ROOT/README.md" "$ROOT/docs" "$ROOT/packages/piagent-core/prompts" "$ROOT/templates/project/AGENTS.md" >/dev/null
grep -R "Subagents used/not used" "$ROOT/packages/piagent-core/prompts" "$ROOT/docs/auto-delegation-policy.md" >/dev/null
grep -R "Subagent orchestration capabilities" "$ROOT/README.md" "$ROOT/docs/subagent-orchestration-capabilities.md" >/dev/null
grep -R "pi-web-access" "$ROOT/README.md" "$ROOT/docs" "$ROOT/scripts/install-global.sh" "$ROOT/scripts/setup.sh" >/dev/null
grep -F 'PI_MCP_ADAPTER_SOURCE="npm:pi-mcp-adapter@2.11.0"' "$ROOT/scripts/install-global.sh" >/dev/null
grep -F 'PI_SUBAGENTS_SOURCE="npm:pi-subagents@0.35.1"' "$ROOT/scripts/install-global.sh" >/dev/null
grep -F 'PI_WEB_ACCESS_SOURCE="npm:pi-web-access@0.13.0"' "$ROOT/scripts/install-global.sh" >/dev/null
grep -F 'PI_MCP_ADAPTER_VERSION="2.11.0"' "$ROOT/scripts/audit-runtime-host.sh" >/dev/null
grep -F 'PI_SUBAGENTS_VERSION="0.35.1"' "$ROOT/scripts/audit-runtime-host.sh" >/dev/null
grep -F 'PI_WEB_ACCESS_VERSION="0.13.0"' "$ROOT/scripts/audit-runtime-host.sh" >/dev/null
node --input-type=module - "$ROOT/scripts/install-global.sh" "$ROOT/scripts/audit-runtime-host.sh" <<'NODE'
import fs from "node:fs";

const installer = fs.readFileSync(process.argv[2], "utf8");
const audit = fs.readFileSync(process.argv[3], "utf8");
const pins = [
  ["PI_MCP_ADAPTER_SOURCE", "PI_MCP_ADAPTER_VERSION", "pi-mcp-adapter"],
  ["PI_SUBAGENTS_SOURCE", "PI_SUBAGENTS_VERSION", "pi-subagents"],
  ["PI_WEB_ACCESS_SOURCE", "PI_WEB_ACCESS_VERSION", "pi-web-access"]
];
for (const [sourceName, versionName, packageName] of pins) {
  const source = installer.match(new RegExp(`^${sourceName}="npm:${packageName}@([^"]+)"$`, "m"))?.[1];
  const audited = audit.match(new RegExp(`^${versionName}="([^"]+)"$`, "m"))?.[1];
  if (!source || !audited || source !== audited) {
    throw new Error(`${packageName} installer pin (${source ?? "missing"}) does not match runtime audit pin (${audited ?? "missing"})`);
  }
}
NODE
grep -F 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262' "$ROOT/.github/workflows/verify.yml" "$ROOT/.github/workflows/codeql.yml" >/dev/null
grep -F 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020' "$ROOT/.github/workflows/verify.yml" >/dev/null
grep -F 'github/codeql-action/init@e4fba868fa4b1b91e1fdab776edc8cfbe6e9fb81' "$ROOT/.github/workflows/codeql.yml" >/dev/null
grep -F 'github/codeql-action/analyze@e4fba868fa4b1b91e1fdab776edc8cfbe6e9fb81' "$ROOT/.github/workflows/codeql.yml" >/dev/null
grep -F 'git cat-file -t "refs/tags/$RELEASE_TAG"' "$ROOT/.github/workflows/verify.yml" >/dev/null
if grep -R -E '^[[:space:]]*uses:[[:space:]]+[^@[:space:]]+@(main|master|v[0-9]+([.][0-9]+)*)[[:space:]]*(#.*)?$' "$ROOT/.github/workflows" >/dev/null; then
  echo "GitHub Actions workflow contains a mutable action reference" >&2
  exit 1
fi
grep -F 'p.peerDependencies?.["@earendil-works/pi-coding-agent"]' "$ROOT/scripts/setup.sh" >/dev/null
grep -F 'run_cmd npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@$expected_pi_version"' "$ROOT/scripts/setup.sh" >/dev/null
grep -F 'validate-source --package-source "$PACKAGE_SOURCE"' "$ROOT/scripts/install-global.sh" >/dev/null
grep -F 'verify_npm_integrity "$PI_MCP_ADAPTER_SOURCE" "$PI_MCP_ADAPTER_INTEGRITY"' "$ROOT/scripts/install-global.sh" >/dev/null
grep -F 'verify_npm_integrity "$PI_SUBAGENTS_SOURCE" "$PI_SUBAGENTS_INTEGRITY"' "$ROOT/scripts/install-global.sh" >/dev/null
grep -F 'verify_npm_integrity "$PI_WEB_ACCESS_SOURCE" "$PI_WEB_ACCESS_INTEGRITY"' "$ROOT/scripts/install-global.sh" >/dev/null
grep -R "parallel-review" "$ROOT/docs" "$ROOT/README.md" >/dev/null
grep -R "intercomBridge" "$ROOT/scripts/configure-subagents.sh" "$ROOT/docs/subagents-and-multiagent.md" >/dev/null
grep -R "waitTool" "$ROOT/scripts/configure-subagents.sh" "$ROOT/docs/subagents-and-multiagent.md" >/dev/null
grep -R "piagent_profile_options" "$ROOT/packages/piagent-core" "$ROOT/docs" >/dev/null
grep -R "piagent_profile_apply" "$ROOT/packages/piagent-core" "$ROOT/docs" >/dev/null
grep -R "/profile auto" "$ROOT/README.md" "$ROOT/docs" "$ROOT/packages/piagent-core" >/dev/null
grep -R "piagent_profile_tech_context_record" "$ROOT/packages/piagent-core" "$ROOT/docs" "$ROOT/README.md" >/dev/null
grep -R "/profile tech" "$ROOT/README.md" "$ROOT/docs" "$ROOT/packages/piagent-core/prompts" >/dev/null
grep -R "/commit" "$ROOT/README.md" "$ROOT/docs" "$ROOT/packages/piagent-core/prompts" >/dev/null
grep -R "/pr" "$ROOT/README.md" "$ROOT/docs" "$ROOT/packages/piagent-core/prompts" >/dev/null
grep -R "piagent_project_onboarding_record" "$ROOT/packages/piagent-core" "$ROOT/docs" >/dev/null
grep -R "piagent_memory_status" "$ROOT/packages/piagent-core" "$ROOT/docs" "$ROOT/templates/project/AGENTS.md" >/dev/null
grep -R "piagent_memory_note" "$ROOT/packages/piagent-core" "$ROOT/docs" >/dev/null
grep -R "piagent_memory_search" "$ROOT/packages/piagent-core" "$ROOT/docs" >/dev/null
grep -R "piagent_memory_citation_record" "$ROOT/packages/piagent-core" "$ROOT/docs" >/dev/null
grep -R "piagent_context_index_status" "$ROOT/packages/piagent-core" "$ROOT/docs" >/dev/null
grep -R "piagent_context_index_record" "$ROOT/packages/piagent-core" "$ROOT/docs" >/dev/null
grep -R "piagent_context_index_search" "$ROOT/packages/piagent-core" "$ROOT/docs" >/dev/null
grep -R "/context-index" "$ROOT/README.md" "$ROOT/docs" "$ROOT/packages/piagent-core/prompts" >/dev/null
grep -R "/onboard-project" "$ROOT/README.md" "$ROOT/docs" "$ROOT/templates/project/AGENTS.md" >/dev/null
grep -R "/memory-policy" "$ROOT/README.md" "$ROOT/docs" "$ROOT/packages/piagent-core/prompts" >/dev/null
grep -R "/model-options" "$ROOT/README.md" "$ROOT/docs" "$ROOT/packages/piagent-core/prompts" >/dev/null
grep -R "anthropic/claude" "$ROOT/README.md" "$ROOT/docs/model-options.md" "$ROOT/packages/piagent-core/prompts/model-options.md" >/dev/null
grep -R "gpt-5.6" "$ROOT/README.md" "$ROOT/docs/model-options.md" "$ROOT/packages/piagent-core/prompts/model-options.md" >/dev/null
grep -R "claude-fable-5" "$ROOT/README.md" "$ROOT/docs/model-options.md" "$ROOT/packages/piagent-core/prompts/model-options.md" >/dev/null
grep -R "piagent-models" "$ROOT/README.md" "$ROOT/docs/model-options.md" >/dev/null
grep -R "enabledModels" "$ROOT/templates/global/settings.json" "$ROOT/docs/model-options.md" "$ROOT/scripts/configure-model-scope.sh" >/dev/null
grep -R "piagent-mcp" "$ROOT/README.md" "$ROOT/docs/mcp-and-tools.md" "$ROOT/scripts/configure-mcp.sh" >/dev/null
grep -R "pi-mcp-adapter" "$ROOT/README.md" "$ROOT/docs/mcp-and-tools.md" "$ROOT/scripts/install-global.sh" >/dev/null
grep -R "piagent-subagents" "$ROOT/README.md" "$ROOT/docs/subagents-and-multiagent.md" "$ROOT/scripts/configure-subagents.sh" >/dev/null
grep -R "subagents-fleet" "$ROOT/docs/command-reference-vietnamese.md" "$ROOT/docs/subagents-and-multiagent.md" "$ROOT/README.md" >/dev/null
grep -R "health check" "$ROOT/docs/command-reference-vietnamese.md" "$ROOT/docs/subagents-and-multiagent.md" "$ROOT/README.md" >/dev/null
grep -R "pi-subagents" "$ROOT/README.md" "$ROOT/docs/subagents-and-multiagent.md" "$ROOT/scripts/install-global.sh" "$ROOT/scripts/setup.sh" >/dev/null
grep -R "piagent-scout" "$ROOT/README.md" "$ROOT/docs/subagents-and-multiagent.md" "$ROOT/packages/piagent-core/subagents" >/dev/null
grep -F "@upstash/context7-mcp@3.2.4" "$ROOT/scripts/configure-mcp.sh" >/dev/null
grep -F "@upstash/context7-mcp@3.2.4" "$ROOT/docs/mcp-and-tools.md" >/dev/null
grep -F "chrome-devtools-mcp@1.6.0" "$ROOT/scripts/configure-mcp.sh" >/dev/null
grep -F "chrome-devtools-mcp@1.6.0" "$ROOT/docs/mcp-and-tools.md" >/dev/null
grep -F "@playwright/mcp@0.0.78" "$ROOT/scripts/configure-mcp.sh" >/dev/null
grep -F "@playwright/mcp@0.0.78" "$ROOT/docs/mcp-and-tools.md" >/dev/null
grep -R "https://mcp.figma.com/mcp" "$ROOT/scripts/configure-mcp.sh" "$ROOT/docs/mcp-and-tools.md" >/dev/null
grep -F "ghcr.io/github/github-mcp-server@sha256:2b0c48b070f61e9d3969269ead600f62d00fb237b60ac849ef3d166ee7de9ad3" "$ROOT/scripts/configure-mcp.sh" >/dev/null
grep -F "ghcr.io/github/github-mcp-server@sha256:2b0c48b070f61e9d3969269ead600f62d00fb237b60ac849ef3d166ee7de9ad3" "$ROOT/docs/mcp-and-tools.md" >/dev/null
grep -F '"GITHUB_READ_ONLY=1"' "$ROOT/scripts/configure-mcp.sh" >/dev/null
grep -F '"GITHUB_READ_ONLY=1"' "$ROOT/docs/mcp-and-tools.md" >/dev/null
grep -F '"GITHUB_LOCKDOWN_MODE=1"' "$ROOT/scripts/configure-mcp.sh" >/dev/null
grep -F '"GITHUB_LOCKDOWN_MODE=1"' "$ROOT/docs/mcp-and-tools.md" >/dev/null
grep -F 'CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1"' "$ROOT/scripts/configure-mcp.sh" >/dev/null
grep -F '"CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS": "1"' "$ROOT/docs/mcp-and-tools.md" >/dev/null
grep -F 'CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1"' "$ROOT/scripts/configure-mcp.sh" >/dev/null
grep -F '"CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS": "1"' "$ROOT/docs/mcp-and-tools.md" >/dev/null
grep -F 'configure-mcp.sh" --scope global --preset "$MCP_PRESET" --replace' "$ROOT/scripts/install-global.sh" >/dev/null
grep -F 'piagent-mcp --preset core --scope global --replace' "$ROOT/scripts/configure-mcp.sh" >/dev/null
if grep -E '@latest|"@upstash/context7-mcp"|"chrome-devtools-mcp"|"@playwright/mcp"|"ghcr\.io/github/github-mcp-server"' "$ROOT/scripts/configure-mcp.sh" >/dev/null; then
  echo "MCP production presets contain a mutable dependency source"
  exit 1
fi
grep -R "Ctrl+L" "$ROOT/README.md" "$ROOT/docs/model-options.md" "$ROOT/docs/team-onboarding.md" "$ROOT/docs/quickstart-vietnamese.md" >/dev/null
grep -R "/platform-improve" "$ROOT/packages/piagent-core/prompts" "$ROOT/docs" >/dev/null
grep -R "/be-to-fe" "$ROOT/packages/piagent-core/prompts" "$ROOT/docs" >/dev/null
grep -R "/scout" "$ROOT/packages/piagent-core/prompts" "$ROOT/docs" "$ROOT/README.md" >/dev/null
grep -R "piagent_context_preflight" "$ROOT/packages/piagent-core" "$ROOT/docs" >/dev/null
grep -R ".pi/task-inbox" "$ROOT/.gitignore" "$ROOT/templates/project/.pi/.gitignore" "$ROOT/docs" >/dev/null
grep -R "Task Implementation Contract" "$ROOT/docs" "$ROOT/packages/piagent-core/prompts" >/dev/null
grep -R "piagent-task-trace" "$ROOT/packages/piagent-core/extensions/piagent-guard.ts" "$ROOT/docs" >/dev/null
grep -R "piagent-source-cache" "$ROOT/packages/piagent-core/skills" "$ROOT/templates/project/AGENTS.md" >/dev/null
grep -R "piagent_source_checkout" "$ROOT/packages/piagent-core" >/dev/null
grep -R "scripts/setup.sh" "$ROOT/README.md" "$ROOT/docs" >/dev/null
grep -R "quality-benchmark.sh" "$ROOT/README.md" "$ROOT/docs" >/dev/null
grep -R "piagent-capabilities" "$ROOT/README.md" "$ROOT/docs/capability-packs.md" >/dev/null
grep -R ".pi-subagents/" "$ROOT/.gitignore" "$ROOT/docs/subagents-and-multiagent.md" "$ROOT/docs/distribution-standard.md" "$ROOT/scripts/init-project.sh" >/dev/null
test -s "$ROOT/tests/policy-core.test.mjs"

public_wording_pattern="$(
  node --input-type=module <<'NODE'
const terms = [
  ["platform-", "mig", "ration"].join(""),
  ["codex-", "mig", "ration"].join(""),
  ["codex-", "par", "ity"].join(""),
  ["benchmark-", "par", "ity"].join(""),
  ["harness-", "mig", "ration"].join(""),
  ["agent-", "stuff"].join(""),
  ["mit", "suhiko"].join(""),
  ["Cod", "ex CLI"].join(""),
  ["Claude", " CLI"].join(""),
  ["Cod", "ex-inspired"].join(""),
  ["Cod", "ex-grade"].join(""),
  ["Pi vs ", "Codex"].join(""),
  ["vs ", "Claude"].join(""),
  ["reference ", "repo"].join(""),
  ["repo ", "tham ", "khảo"].join(""),
  ["nguồn ", "tham ", "khảo"].join(""),
  ["tham ", "khảo"].join("")
];
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
console.log(terms.map(escapeRegex).join("|"));
NODE
)"

if grep -R -E -i \
  "$public_wording_pattern" \
  "$ROOT/README.md" \
  "$ROOT/docs" \
  "$ROOT/packages/piagent-core/README.md" \
  "$ROOT/packages/piagent-core/prompts" \
  "$ROOT/templates/project/AGENTS.md" >/dev/null; then
  echo "Public docs contain non-neutral platform wording"
  exit 1
fi

node --check "$ROOT/packages/piagent-core/extensions/piagent-guard.ts" >/dev/null
node --check "$ROOT/packages/piagent-core/extensions/policy-core.js" >/dev/null
node --check "$ROOT/packages/piagent-core/extensions/redaction-core.js" >/dev/null
node --check "$ROOT/packages/piagent-core/extensions/runtime-evidence.js" >/dev/null
node --check "$ROOT/packages/piagent-core/security/sensitive-data.js" >/dev/null
node --check "$ROOT/packages/piagent-core/capabilities/capability-core.js" >/dev/null
node --check "$ROOT/packages/piagent-core/capabilities/capability-sources.js" >/dev/null
node --check "$ROOT/scripts/capability-catalog.mjs" >/dev/null
node --check "$ROOT/scripts/piagent-cli.mjs" >/dev/null
node --check "$ROOT/scripts/migrate-project-state.mjs" >/dev/null
node --check "$ROOT/scripts/import-agent-instructions.mjs" >/dev/null
(cd "$ROOT" && npm test) >/dev/null
if [[ -x "$ROOT/node_modules/.bin/tsc" ]]; then
  (cd "$ROOT" && npm run typecheck) >/dev/null
fi
bash -n "$ROOT/scripts/quality-benchmark.sh"
bash -n "$ROOT/scripts/runtime-policy-smoke.sh"
bash -n "$ROOT/scripts/pi-session-stats.sh"
bash -n "$ROOT/scripts/pi-auto.sh"
bash -n "$ROOT/scripts/pi-model-catalog.sh"
bash -n "$ROOT/scripts/configure-model-scope.sh"
bash -n "$ROOT/scripts/configure-mcp.sh"
bash -n "$ROOT/scripts/configure-subagents.sh"
bash -n "$ROOT/scripts/install-global.sh"
bash -n "$ROOT/scripts/init-project.sh"
bash -n "$ROOT/scripts/setup.sh"
if [[ "$OFFLINE" == true || "${PIAGENT_VERIFY_OFFLINE:-}" == "1" || "${CI:-}" == "true" ]]; then
  echo "WARN: skipping local Pi model catalog check in offline/CI mode" >&2
else
  bash "$ROOT/scripts/pi-model-catalog.sh" --json >/dev/null
fi
bash "$ROOT/scripts/configure-model-scope.sh" --dry-run --preset full --default-model openai-codex/gpt-5.5:xhigh >/dev/null
bash "$ROOT/scripts/configure-mcp.sh" --list >/dev/null
bash "$ROOT/scripts/configure-mcp.sh" --dry-run --preset popular --scope project --project "$ROOT" >/dev/null
node --input-type=module - "$ROOT" <<'NODE'
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = process.argv[2];
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-mcp-upgrade-"));
const configPath = path.join(fixtureRoot, "mcp.json");
try {
  fs.writeFileSync(configPath, `${JSON.stringify({
    mcpServers: {
      context7: { command: "npx", args: ["-y", "@upstash/context7-mcp"] },
      "chrome-devtools": { command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] },
      playwright: { command: "npx", args: ["-y", "@playwright/mcp@latest"] },
      github: { command: "docker", args: ["run", "ghcr.io/github/github-mcp-server"] },
      internal: { url: "https://mcp.example.invalid/api" }
    }
  }, null, 2)}\n`);
  execFileSync("bash", [
    path.join(root, "scripts", "configure-mcp.sh"),
    "--config", configPath,
    "--preset", "popular",
    "--replace"
  ], { stdio: "ignore" });
  const upgraded = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(upgraded.mcpServers.context7.args[1], "@upstash/context7-mcp@3.2.4");
  assert.equal(upgraded.mcpServers["chrome-devtools"].args[1], "chrome-devtools-mcp@1.6.0");
  assert.equal(upgraded.mcpServers["chrome-devtools"].env.CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS, "1");
  assert.equal(upgraded.mcpServers["chrome-devtools"].env.CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS, "1");
  assert.equal(upgraded.mcpServers.playwright.args[1], "@playwright/mcp@0.0.78");
  assert.ok(upgraded.mcpServers.github.args.includes("GITHUB_READ_ONLY=1"));
  assert.ok(upgraded.mcpServers.github.args.includes("GITHUB_LOCKDOWN_MODE=1"));
  assert.ok(upgraded.mcpServers.github.args.includes("ghcr.io/github/github-mcp-server@sha256:2b0c48b070f61e9d3969269ead600f62d00fb237b60ac849ef3d166ee7de9ad3"));
  assert.deepEqual(upgraded.mcpServers.internal, { url: "https://mcp.example.invalid/api" });
} finally {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
NODE
bash "$ROOT/scripts/configure-subagents.sh" --list >/dev/null
bash "$ROOT/scripts/configure-subagents.sh" --dry-run --preset safe >/dev/null
bash "$ROOT/scripts/runtime-policy-smoke.sh" >/dev/null

node "$ROOT/scripts/capability-catalog.mjs" catalog --check >/dev/null
node "$ROOT/scripts/capability-catalog.mjs" doctor --profile "$ROOT/.pi/piagent-profile.json" --lock "$ROOT/.pi/piagent-profile.lock.json" >/dev/null
node "$ROOT/scripts/capability-catalog.mjs" doctor --profile "$ROOT/adapters/generic/profile.json" >/dev/null
node "$ROOT/scripts/capability-catalog.mjs" doctor --profile "$ROOT/adapters/web-frontend/profile.json" >/dev/null

bash "$ROOT/scripts/profile-doctor.sh" "$ROOT" "$ROOT/.pi/piagent-profile.json" >/dev/null
bash "$ROOT/scripts/profile-doctor.sh" "$ROOT" "$ROOT/adapters/generic/profile.json" >/dev/null
bash "$ROOT/scripts/profile-doctor.sh" "$ROOT" "$ROOT/adapters/backend-api/profile.json" >/dev/null
bash "$ROOT/scripts/profile-doctor.sh" "$ROOT" "$ROOT/adapters/be-readonly-fe/profile.json" >/dev/null
bash "$ROOT/scripts/profile-doctor.sh" "$ROOT" "$ROOT/adapters/data/profile.json" >/dev/null
bash "$ROOT/scripts/profile-doctor.sh" "$ROOT" "$ROOT/adapters/devops/profile.json" >/dev/null
bash "$ROOT/scripts/profile-doctor.sh" "$ROOT" "$ROOT/adapters/docs/profile.json" >/dev/null
bash "$ROOT/scripts/profile-doctor.sh" "$ROOT" "$ROOT/adapters/fullstack/profile.json" >/dev/null
bash "$ROOT/scripts/profile-doctor.sh" "$ROOT" "$ROOT/adapters/mobile/profile.json" >/dev/null
bash "$ROOT/scripts/profile-doctor.sh" "$ROOT" "$ROOT/adapters/node-typescript/profile.json" >/dev/null
bash "$ROOT/scripts/profile-doctor.sh" "$ROOT" "$ROOT/adapters/python/profile.json" >/dev/null
bash "$ROOT/scripts/profile-doctor.sh" "$ROOT" "$ROOT/adapters/web-frontend/profile.json" >/dev/null
bash "$ROOT/scripts/team-doctor.sh" "$ROOT" --strict-share >/dev/null

echo "PASS: piagent-platform scaffold is complete"
