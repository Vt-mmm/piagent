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
  "$ROOT/README.vi.md"
  "$ROOT/SECURITY.md"
  "$ROOT/AGENTS.md"
  "$ROOT/CHANGELOG.md"
  "$ROOT/.npmignore"
  "$ROOT/package.json"
  "$ROOT/package-lock.json"
  "$ROOT/playwright.webui.config.mjs"
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
  "$ROOT/packages/piagent-core/runtime/runtime-limits.ts"
  "$ROOT/packages/piagent-core/runtime/hooks/agent-start-hook.ts"
  "$ROOT/packages/piagent-core/runtime/hooks/completion-hook.ts"
  "$ROOT/packages/piagent-core/runtime/hooks/input-hook.ts"
  "$ROOT/packages/piagent-core/runtime/hooks/session-hooks.ts"
  "$ROOT/packages/piagent-core/runtime/hooks/session-start-hook.ts"
  "$ROOT/packages/piagent-core/runtime/hooks/tool-result-hook.ts"
  "$ROOT/packages/piagent-core/runtime/input/chat-images.ts"
  "$ROOT/packages/piagent-core/runtime/session/message-signals.ts"
  "$ROOT/packages/piagent-core/runtime/session/runtime-state.ts"
  "$ROOT/packages/piagent-core/runtime/session/system-prompt.ts"
  "$ROOT/packages/piagent-core/runtime/session/tool-result-compaction.ts"
  "$ROOT/packages/piagent-core/runtime/session/usage.ts"
  "$ROOT/packages/piagent-core/runtime/tools/tool-groups.ts"
  "$ROOT/packages/piagent-core/runtime/workflows/input-routing.ts"
  "$ROOT/packages/piagent-core/runtime/workflows/task-intake.ts"
  "$ROOT/packages/piagent-core/extensions/context-engine.js"
  "$ROOT/packages/piagent-core/extensions/context-index-policy.js"
  "$ROOT/packages/piagent-core/extensions/local-state-path.js"
  "$ROOT/packages/piagent-core/extensions/policy-core.js"
  "$ROOT/packages/piagent-core/extensions/redaction-core.js"
  "$ROOT/packages/piagent-core/extensions/runtime-evidence.js"
  "$ROOT/packages/piagent-core/extensions/state-retention.js"
  "$ROOT/packages/piagent-core/extensions/task-state.js"
  "$ROOT/packages/piagent-core/security/sensitive-data.js"
  "$ROOT/packages/piagent-core/capabilities/capability-core.js"
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
  "$ROOT/docs/README.md"
  "$ROOT/docs/languages.json"
  "$ROOT/docs/en/README.md"
  "$ROOT/docs/en/architecture.md"
  "$ROOT/docs/en/maintainer-guide.md"
  "$ROOT/docs/vi/README.md"
  "$ROOT/docs/vi/architecture.md"
  "$ROOT/docs/vi/maintainer-guide.md"
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
  "$ROOT/docs/context-engine.md"
  "$ROOT/docs/task-implementation-contract.md"
  "$ROOT/docs/runtime-quality-baseline.md"
  "$ROOT/docs/quality-benchmark.md"
  "$ROOT/docs/package-architecture-notes.md"
  "$ROOT/docs/capability-packs.md"
  "$ROOT/docs/runtime-policy-design.md"
  "$ROOT/docs/third-party-neutrality.md"
  "$ROOT/docs-site/index.html"
  "$ROOT/docs-site/mcp.html"
  "$ROOT/docs-site/en/index.html"
  "$ROOT/docs-site/en/context-engine.html"
  "$ROOT/docs-site/en/mcp.html"
  "$ROOT/docs-site/favicon.svg"
  "$ROOT/docs-site/assets/piagent-logo.svg"
  "$ROOT/docs-site/assets/docs.css"
  "$ROOT/docs-site/assets/docs.js"
  "$ROOT/docs-site/content/index.html"
  "$ROOT/docs-site/content/context-engine.html"
  "$ROOT/docs-site/content/mcp.html"
  "$ROOT/docs-site/content/en/index.html"
  "$ROOT/docs-site/content/en/context-engine.html"
  "$ROOT/docs-site/content/en/mcp.html"
  "$ROOT/docs-site/vercel.json"
  "$ROOT/scripts/build-docs-site.mjs"
  "$ROOT/scripts/check-architecture.mjs"
  "$ROOT/scripts/check-doc-languages.mjs"
  "$ROOT/scripts/check-third-party-neutrality.mjs"
  "$ROOT/governance/piagent-webui/wui5-18-acceptance-matrix.v1.json"
  "$ROOT/tests/piagent-webui-wui5-18-gate.test.mjs"
  "$ROOT/architecture/layers.json"
  "$ROOT/scripts/context-engine.mjs"
  "$ROOT/scripts/preview-docs-site.mjs"
  "$ROOT/schemas/project-profile.schema.json"
  "$ROOT/schemas/task-contract.schema.json"
  "$ROOT/schemas/capability-pack.schema.json"
  "$ROOT/schemas/capability-recipe.schema.json"
  "$ROOT/schemas/eval-scenario.schema.json"
  "$ROOT/schemas/action-proposal.schema.json"
  "$ROOT/schemas/piagent-webui/catalog-v1.json"
  "$ROOT/schemas/piagent-webui/common-v1.schema.json"
  "$ROOT/schemas/piagent-webui/snapshot-v1.schema.json"
  "$ROOT/schemas/piagent-webui/runtime-event-v2.schema.json"
  "$ROOT/schemas/piagent-webui/source-change-v1.schema.json"
  "$ROOT/schemas/piagent-webui/diff-v1.schema.json"
  "$ROOT/schemas/piagent-webui/review-state-v1.schema.json"
  "$ROOT/schemas/piagent-webui/source-mutation-v1.schema.json"
  "$ROOT/schemas/piagent-webui/source-revert-v1.schema.json"
  "$ROOT/schemas/piagent-webui/commit-summary-v1.schema.json"
  "$ROOT/schemas/piagent-webui/task-index-v1.schema.json"
  "$ROOT/schemas/piagent-webui/task-timeline-v1.schema.json"
  "$ROOT/schemas/piagent-webui/recovery-history-v1.schema.json"
  "$ROOT/schemas/piagent-webui/handoff-history-v1.schema.json"
  "$ROOT/schemas/piagent-webui/subagent-tree-v1.schema.json"
  "$ROOT/schemas/piagent-webui/release-monitor-v1.schema.json"
  "$ROOT/schemas/piagent-webui/transcript-v1.schema.json"
  "$ROOT/schemas/piagent-webui/queue-v1.schema.json"
  "$ROOT/schemas/piagent-webui/model-catalog-v1.schema.json"
  "$ROOT/schemas/piagent-webui/attachment-v1.schema.json"
  "$ROOT/schemas/piagent-webui/control-command-v1.schema.json"
  "$ROOT/schemas/piagent-webui/approval-v1.schema.json"
  "$ROOT/schemas/piagent-webui/capabilities-v1.schema.json"
  "$ROOT/schemas/piagent-webui/session-catalog-v1.schema.json"
  "$ROOT/schemas/piagent-webui/session-command-v1.schema.json"
  "$ROOT/schemas/piagent-webui/gateway-capabilities-v1.schema.json"
  "$ROOT/schemas/piagent-webui/gateway-protocol-v1.schema.json"
  "$ROOT/packages/piagent-webui/package.json"
  "$ROOT/packages/piagent-webui/tsconfig.json"
  "$ROOT/packages/piagent-webui/vite.config.ts"
  "$ROOT/packages/piagent-webui/scripts/generate-contracts.mjs"
  "$ROOT/packages/piagent-webui/benchmark/benchmark.mjs"
  "$ROOT/packages/piagent-webui/contracts/generated/index.ts"
  "$ROOT/packages/piagent-webui/contracts/generated/review-state-v1.ts"
  "$ROOT/packages/piagent-webui/contracts/generated/source-mutation-v1.ts"
  "$ROOT/packages/piagent-webui/contracts/generated/source-revert-v1.ts"
  "$ROOT/packages/piagent-webui/contracts/generated/commit-summary-v1.ts"
  "$ROOT/packages/piagent-webui/contracts/generated/task-index-v1.ts"
  "$ROOT/packages/piagent-webui/contracts/generated/task-timeline-v1.ts"
  "$ROOT/packages/piagent-webui/contracts/generated/recovery-history-v1.ts"
  "$ROOT/packages/piagent-webui/contracts/generated/handoff-history-v1.ts"
  "$ROOT/packages/piagent-webui/contracts/generated/subagent-tree-v1.ts"
  "$ROOT/packages/piagent-webui/contracts/generated/release-monitor-v1.ts"
  "$ROOT/packages/piagent-webui/contracts/generated/queue-v1.ts"
  "$ROOT/packages/piagent-webui/contracts/generated/model-catalog-v1.ts"
  "$ROOT/packages/piagent-webui/contracts/generated/attachment-v1.ts"
  "$ROOT/packages/piagent-webui/contracts/generated/session-catalog-v1.ts"
  "$ROOT/packages/piagent-webui/contracts/generated/session-command-v1.ts"
  "$ROOT/packages/piagent-webui/contracts/generated/gateway-capabilities-v1.ts"
  "$ROOT/packages/piagent-webui/contracts/generated/gateway-protocol-v1.ts"
  "$ROOT/packages/piagent-webui/client/index.html"
  "$ROOT/packages/piagent-webui/client/src/App.tsx"
  "$ROOT/packages/piagent-webui/client/src/api.ts"
  "$ROOT/packages/piagent-webui/client/src/use-inspection.ts"
  "$ROOT/packages/piagent-webui/client/src/view-model.ts"
  "$ROOT/packages/piagent-webui/client/src/source-view-model.ts"
  "$ROOT/packages/piagent-webui/client/src/SourceWorkspace.tsx"
  "$ROOT/packages/piagent-webui/client/src/TaskRunIndexPanel.tsx"
  "$ROOT/packages/piagent-webui/client/src/activity-view-model.ts"
  "$ROOT/packages/piagent-webui/client/src/ActivityPanel.tsx"
  "$ROOT/packages/piagent-webui/client/src/evidence-view-model.ts"
  "$ROOT/packages/piagent-webui/client/src/EvidencePanels.tsx"
  "$ROOT/packages/piagent-webui/client/src/ChatPanel.tsx"
  "$ROOT/packages/piagent-webui/client/src/chat-view-model.ts"
  "$ROOT/packages/piagent-webui/client/src/chat-command.ts"
  "$ROOT/packages/piagent-webui/client/src/review-command.ts"
  "$ROOT/packages/piagent-webui/client/src/source-mutation-command.ts"
  "$ROOT/packages/piagent-webui/client/src/source-revert-command.ts"
  "$ROOT/packages/piagent-webui/client/src/source-open-command.ts"
  "$ROOT/packages/piagent-webui/client/src/approval-command.ts"
  "$ROOT/packages/piagent-webui/client/src/ApprovalPanel.tsx"
  "$ROOT/packages/piagent-webui/client/src/SessionOptionsPanel.tsx"
  "$ROOT/packages/piagent-webui/client/src/LifecyclePanel.tsx"
  "$ROOT/packages/piagent-webui/client/src/SessionHubApp.tsx"
  "$ROOT/packages/piagent-webui/client/src/NewSessionPage.tsx"
  "$ROOT/packages/piagent-webui/client/src/SessionComposerControls.tsx"
  "$ROOT/packages/piagent-webui/client/src/McpConnectionActions.tsx"
  "$ROOT/packages/piagent-webui/client/src/ProviderAccounts.tsx"
  "$ROOT/packages/piagent-webui/client/src/SettingsPage.tsx"
  "$ROOT/packages/piagent-webui/client/src/SessionInspectorDrawer.tsx"
  "$ROOT/packages/piagent-webui/client/src/ServiceIcon.tsx"
  "$ROOT/packages/piagent-webui/client/src/use-session-hub.ts"
  "$ROOT/packages/piagent-webui/server/http-security.ts"
  "$ROOT/packages/piagent-webui/server/session-auth.ts"
  "$ROOT/packages/piagent-webui/server/static-bundle.ts"
  "$ROOT/packages/piagent-webui/server/loopback-server.ts"
  "$ROOT/packages/piagent-webui/server/read-model-provider.ts"
  "$ROOT/packages/piagent-webui/server/read-only-router.ts"
  "$ROOT/packages/piagent-webui/server/sse-hub.ts"
  "$ROOT/packages/piagent-webui/server/core-inspection-provider.ts"
  "$ROOT/packages/piagent-webui/server/ipc-read-model-client.ts"
  "$ROOT/packages/piagent-webui/server/sidecar-main.ts"
  "$ROOT/packages/piagent-webui/server/transcript-projection.ts"
  "$ROOT/packages/piagent-webui/gateway/control-socket.ts"
  "$ROOT/packages/piagent-webui/gateway/gateway-service.ts"
  "$ROOT/packages/piagent-webui/gateway/gateway-events.ts"
  "$ROOT/packages/piagent-webui/gateway/gateway-protocol-service.ts"
  "$ROOT/packages/piagent-webui/gateway/gateway-session-stream.ts"
  "$ROOT/packages/piagent-webui/gateway/pi-host.ts"
  "$ROOT/packages/piagent-webui/gateway/profile-state.ts"
  "$ROOT/packages/piagent-webui/gateway/project-registry.ts"
  "$ROOT/packages/piagent-webui/gateway/native-project-picker.ts"
  "$ROOT/packages/piagent-webui/gateway/provider-auth-broker.ts"
  "$ROOT/packages/piagent-webui/gateway/mcp-auth-broker.ts"
  "$ROOT/tests/piagent-webui-mcp-auth.test.mjs"
  "$ROOT/packages/piagent-webui/gateway/session-catalog.ts"
  "$ROOT/packages/piagent-webui/gateway/session-command-controller.ts"
  "$ROOT/packages/piagent-webui/gateway/session-command-store.ts"
  "$ROOT/packages/piagent-webui/gateway/session-lease-store.ts"
  "$ROOT/packages/piagent-webui/gateway/session-metadata-store.ts"
  "$ROOT/packages/piagent-webui/gateway/session-runtime-supervisor.ts"
  "$ROOT/packages/piagent-webui/server/gateway-websocket.ts"
  "$ROOT/packages/piagent-webui/extension/piagent-webui.ts"
  "$ROOT/packages/piagent-webui/extension/review-controller.ts"
  "$ROOT/packages/piagent-webui/extension/source-mutation-controller.ts"
  "$ROOT/packages/piagent-webui/extension/source-revert-controller.ts"
  "$ROOT/packages/piagent-webui/extension/source-open-controller.ts"
  "$ROOT/packages/piagent-webui/extension/vscode-handoff.ts"
  "$ROOT/packages/piagent-core/runtime/inspection/review-state-contract.ts"
  "$ROOT/packages/piagent-core/runtime/inspection/mcp-control.ts"
  "$ROOT/packages/piagent-core/runtime/inspection/review-state-projection.ts"
  "$ROOT/packages/piagent-core/runtime/inspection/review-state-store.ts"
  "$ROOT/packages/piagent-core/runtime/inspection/source-mutation-projection.ts"
  "$ROOT/packages/piagent-core/runtime/inspection/source-mutation-store.ts"
  "$ROOT/packages/piagent-core/runtime/inspection/source-revert-projection.ts"
  "$ROOT/packages/piagent-core/runtime/inspection/source-handoff-store.ts"
  "$ROOT/packages/piagent-core/runtime/inspection/source-open-target.ts"
  "$ROOT/packages/piagent-core/runtime/inspection/commit-summary-projection.ts"
  "$ROOT/packages/piagent-core/runtime/inspection/task-run-index.ts"
  "$ROOT/packages/piagent-core/runtime/inspection/task-recovery-timeline.ts"
  "$ROOT/packages/piagent-core/runtime/inspection/task-compaction-history.ts"
  "$ROOT/packages/piagent-core/runtime/inspection/context-telemetry-inspection.ts"
  "$ROOT/packages/piagent-core/runtime/inspection/task-handoff-history.ts"
  "$ROOT/packages/piagent-core/runtime/inspection/task-subagent-tree.ts"
  "$ROOT/packages/piagent-webui/server/benchmark-release-monitor.ts"
  "$ROOT/packages/piagent-webui/client/src/ReleaseMonitorPanel.tsx"
  "$ROOT/packages/piagent-core/runtime/inspection/git-filter-safety.ts"
  "$ROOT/packages/piagent-core/runtime/policy/source-index-transaction.ts"
  "$ROOT/packages/piagent-core/runtime/policy/source-mutation-guard-binding.ts"
  "$ROOT/packages/piagent-core/runtime/policy/source-mutation-guard.ts"
  "$ROOT/packages/piagent-core/runtime/policy/source-worktree-transaction.ts"
  "$ROOT/tests/piagent-webui-review-state.test.mjs"
  "$ROOT/tests/piagent-webui-source-mutation.test.mjs"
  "$ROOT/tests/piagent-webui-source-revert.test.mjs"
  "$ROOT/tests/piagent-webui-source-open.test.mjs"
  "$ROOT/tests/piagent-webui-commit-summary.test.mjs"
  "$ROOT/tests/piagent-webui-mutation-invalidation.test.mjs"
  "$ROOT/tests/piagent-webui-task-index.test.mjs"
  "$ROOT/tests/piagent-webui-task-timeline.test.mjs"
  "$ROOT/tests/piagent-webui-recovery-history.test.mjs"
  "$ROOT/tests/piagent-webui-handoff-history.test.mjs"
  "$ROOT/tests/piagent-webui-subagent-tree.test.mjs"
  "$ROOT/tests/piagent-webui-release-monitor.test.mjs"
  "$ROOT/tests/piagent-webui-long-task-scale.test.mjs"
  "$ROOT/governance/piagent-webui/decisions/WUI4-06-benchmark-release-monitoring.md"
  "$ROOT/governance/piagent-webui/decisions/WUI4-07-retention-corrupt-scale-gate.md"
  "$ROOT/governance/piagent-webui/decisions/WUI4-08-independent-webui4-gate.md"
  "$ROOT/packages/piagent-webui/extension/same-session-bridge.ts"
  "$ROOT/packages/piagent-webui/extension/held-message-queue.ts"
  "$ROOT/packages/piagent-webui/extension/session-options-controller.ts"
  "$ROOT/packages/piagent-webui/extension/session-stream-adapter.ts"
  "$ROOT/packages/piagent-webui/extension/attachment-store.ts"
  "$ROOT/packages/piagent-webui/extension/lifecycle-controller.ts"
  "$ROOT/packages/piagent-webui/extension/lifecycle-event-adapter.ts"
  "$ROOT/packages/piagent-core/runtime/inspection/approval-broker.ts"
  "$ROOT/packages/piagent-core/runtime/inspection/task-control-journal.ts"
  "$ROOT/tests/piagent-webui-production-bridge.test.mjs"
  "$ROOT/tests/piagent-webui-bridge-message-e2e.test.mjs"
  "$ROOT/tests/piagent-webui-transcript-projection.test.mjs"
  "$ROOT/tests/piagent-webui-session-stream.test.mjs"
  "$ROOT/tests/piagent-webui-chat-client.test.mjs"
  "$ROOT/tests/piagent-webui-held-message-queue.test.mjs"
  "$ROOT/tests/piagent-webui-session-options.test.mjs"
  "$ROOT/tests/piagent-webui-attachment-store.test.mjs"
  "$ROOT/tests/piagent-webui-approval-broker.test.mjs"
  "$ROOT/tests/piagent-webui-lifecycle-control.test.mjs"
  "$ROOT/tests/piagent-webui-lifecycle-client.test.mjs"
  "$ROOT/scripts/piagent-webui-launcher.mjs"
  "$ROOT/tests/piagent-webui-package-boundary.test.mjs"
  "$ROOT/tests/helpers/piagent-webui-build.mjs"
  "$ROOT/tests/piagent-webui-loopback-server.test.mjs"
  "$ROOT/tests/piagent-webui-project-registry.test.mjs"
  "$ROOT/tests/piagent-webui-provider-auth.test.mjs"
  "$ROOT/tests/piagent-webui-session-hub.e2e.mjs"
  "$ROOT/governance/piagent-webui/decisions/WUI5-11-session-first-mui-shell.md"
  "$ROOT/tests/piagent-webui-read-routes-sse.test.mjs"
  "$ROOT/tests/piagent-webui-task-dashboard.test.mjs"
  "$ROOT/tests/piagent-webui-source-diff-client.test.mjs"
  "$ROOT/tests/piagent-webui-activity-client.test.mjs"
  "$ROOT/tests/piagent-webui-evidence-client.test.mjs"
  "$ROOT/tests/piagent-webui-accessibility-client.test.mjs"
  "$ROOT/tests/piagent-webui-isolation.test.mjs"
  "$ROOT/tests/piagent-webui-launcher-integration.test.mjs"
  "$ROOT/tests/piagent-webui-browser.e2e.mjs"
  "$ROOT/tests/piagent-webui-session-hub.e2e.mjs"
  "$ROOT/tests/piagent-webui-session-hub-schema.test.mjs"
  "$ROOT/tests/piagent-webui-session-runtime-spike.test.mjs"
  "$ROOT/tests/piagent-webui-gateway.test.mjs"
  "$ROOT/tests/piagent-webui-session-metadata.test.mjs"
  "$ROOT/tests/piagent-webui-session-lease-runtime.test.mjs"
  "$ROOT/tests/piagent-webui-session-command-admission.test.mjs"
  "$ROOT/tests/piagent-webui-gateway-transport.test.mjs"
  "$ROOT/scripts/piagent-dashboard.mjs"
  "$ROOT/governance/piagent-webui/40-session-hub-master-plan.md"
  "$ROOT/governance/piagent-webui/decisions/WUI5-01-session-hub-product-contract.md"
  "$ROOT/governance/piagent-webui/decisions/WUI5-02-gateway-wire-contract.md"
  "$ROOT/governance/piagent-webui/decisions/WUI5-03-pi-sdk-session-runtime-proof.md"
  "$ROOT/governance/piagent-webui/decisions/WUI5-04-gateway-lease-crash-threat-model.md"
  "$ROOT/governance/piagent-webui/decisions/WUI5-05-one-per-profile-gateway-cli.md"
  "$ROOT/governance/piagent-webui/decisions/WUI5-06-bounded-session-catalog-metadata.md"
  "$ROOT/governance/piagent-webui/decisions/WUI5-07-authenticated-gateway-transport.md"
  "$ROOT/governance/piagent-webui/decisions/WUI5-08-owner-lease-runtime-supervisor.md"
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
  "$ROOT/scripts/check-published-site.mjs"
  "$ROOT/scripts/piagent-cli.mjs"
  "$ROOT/scripts/init-project.sh"
  "$ROOT/scripts/uninstall-global.sh"
  "$ROOT/scripts/setup.sh"
  "$ROOT/scripts/team-doctor.sh"
  "$ROOT/scripts/link-project.sh"
  "$ROOT/scripts/profile-doctor.sh"
  "$ROOT/scripts/benchmark-runner.mjs"
  "$ROOT/scripts/quality-benchmark.sh"
  "$ROOT/scripts/runtime-policy-smoke.sh"
  "$ROOT/scripts/pi-session-stats.sh"
  "$ROOT/scripts/pi-usage-history.mjs"
  "$ROOT/scripts/pi-auto.sh"
  "$ROOT/scripts/pi-model-catalog.sh"
  "$ROOT/scripts/configure-model-scope.sh"
  "$ROOT/scripts/mcp-manage.mjs"
  "$ROOT/scripts/configure-subagents.sh"
  "$ROOT/scripts/capability-catalog.mjs"
  "$ROOT/scripts/private-holdout-readiness.mjs"
  "$ROOT/scripts/fs4-readiness-evaluation.mjs"
  "$ROOT/scripts/evaluate-fs-release-transition.mjs"
  "$ROOT/scripts/migrate-project-state.mjs"
  "$ROOT/scripts/import-agent-instructions.mjs"
  "$ROOT/tests/capability-core.test.mjs"
  "$ROOT/tests/piagent-guard-integration.test.mjs"
  "$ROOT/tests/context-engine.test.mjs"
  "$ROOT/tests/benchmark-core.test.mjs"
  "$ROOT/tests/benchmark-treatment.test.mjs"
  "$ROOT/tests/benchmark-runner.test.mjs"
  "$ROOT/tests/benchmark-suite.test.mjs"
  "$ROOT/tests/production-benchmark-suite.test.mjs"
  "$ROOT/tests/workflow-prompts.test.mjs"
  "$ROOT/tests/install-global.test.mjs"
  "$ROOT/tests/package-distribution.test.mjs"
  "$ROOT/tests/release-identity.test.mjs"
  "$ROOT/tests/policy-core.test.mjs"
  "$ROOT/tests/redaction-core.test.mjs"
  "$ROOT/tests/runtime-evidence.test.mjs"
  "$ROOT/tests/golden-enforcement.test.mjs"
  "$ROOT/packages/piagent-core/benchmark/benchmark-core.js"
  "$ROOT/packages/piagent-core/benchmark/benchmark-assurance.js"
  "$ROOT/packages/piagent-core/benchmark/benchmark-comparison.js"
  "$ROOT/packages/piagent-core/benchmark/benchmark-report.js"
  "$ROOT/packages/piagent-core/benchmark/benchmark-suite.js"
  "$ROOT/benchmarks/core-v1/suite.json"
  "$ROOT/benchmarks/capability-v1/suite.json"
  "$ROOT/benchmarks/capability-v1/grade.mjs"
  "$ROOT/tests/capability-benchmark-suite.test.mjs"
  "$ROOT/tests/private-holdout-readiness.test.mjs"
  "$ROOT/tests/fs4-readiness-gates.test.mjs"
  "$ROOT/tests/fs5-pilot-protocol.test.mjs"
  "$ROOT/tests/ie6-release-protocol.test.mjs"
  "$ROOT/tests/ie6-release-freeze.test.mjs"
  "$ROOT/tests/fs5-causal-arm.test.mjs"
  "$ROOT/tests/fs-release-transition.test.mjs"
  "$ROOT/schemas/benchmark-assurance-evidence.schema.json"
  "$ROOT/evals/private-holdout-v1/access-policy.v1.json"
  "$ROOT/evals/private-holdout-v1/human-rubric.v1.json"
  "$ROOT/evals/private-holdout-v1/public-exposure.v1.json"
  "$ROOT/evals/private-holdout-v1/README.md"
  "$ROOT/evals/private-holdout-v1/CUSTODIAN_RUNBOOK.md"
  "$ROOT/evals/fs4-readiness-matrix.v1.json"
  "$ROOT/packages/piagent-core/benchmark/fs4-readiness-gates.js"
  "$ROOT/evals/fs5-pilot-protocol.v1.json"
  "$ROOT/evals/fs5-pilot-protocol.v2.json"
  "$ROOT/evals/fs5-pilot-protocol.v3.json"
  "$ROOT/evals/fs5-pilot-protocol.v4.json"
  "$ROOT/evals/fs5-pilot-protocol.v5.json"
  "$ROOT/evals/ie6-release-protocol.v1.json"
  "$ROOT/evals/fs5-causal-arm.v1.json"
  "$ROOT/evals/fs-release-transition.v1.json"
  "$ROOT/packages/piagent-core/benchmark/fs5-pilot-protocol.js"
  "$ROOT/packages/piagent-core/benchmark/ie6-release-protocol.js"
  "$ROOT/packages/piagent-core/benchmark/fs5-causal-arm.js"
  "$ROOT/packages/piagent-core/benchmark/fs-release-transition.js"
  "$ROOT/benchmarks/production-v1/suite.json"
  "$ROOT/benchmarks/production-v1/grade.mjs"
  "$ROOT/benchmarks/production-v1/variant.mjs"
  "$ROOT/tests/capability-sources.test.mjs"
  "$ROOT/packages/piagent-core/capabilities/capability-sources.js"
  "$ROOT/packages/piagent-core/extensions/guard-shell-analysis.ts"
  "$ROOT/packages/piagent-core/extensions/document-intake.ts"
  "$ROOT/tests/guard-shell-analysis.test.mjs"
  "$ROOT/tests/document-intake.test.mjs"
  "$ROOT/tests/runtime-advisories.test.mjs"
  "$ROOT/scripts/check-runtime-advisories.mjs"
  "$ROOT/packages/piagent-core/mcp/mcp-session-view.js"
  "$ROOT/packages/piagent-core/mcp/mcp-command-actions.js"
  "$ROOT/tests/mcp-session-command.test.mjs"
  "$ROOT/tests/migrate-project-state.test.mjs"
  "$ROOT/tests/uninstall-global.test.mjs"
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
  "packages/piagent-webui/package.json",
  "packages/piagent-webui/tsconfig.json",
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
  "schemas/benchmark-assurance-evidence.schema.json",
  "schemas/piagent-webui/catalog-v1.json",
  "schemas/piagent-webui/common-v1.schema.json",
  "schemas/piagent-webui/snapshot-v1.schema.json",
  "schemas/piagent-webui/runtime-event-v2.schema.json",
  "schemas/piagent-webui/source-change-v1.schema.json",
  "schemas/piagent-webui/diff-v1.schema.json",
  "schemas/piagent-webui/review-state-v1.schema.json",
  "schemas/piagent-webui/source-mutation-v1.schema.json",
  "schemas/piagent-webui/source-revert-v1.schema.json",
  "schemas/piagent-webui/commit-summary-v1.schema.json",
  "schemas/piagent-webui/task-index-v1.schema.json",
  "schemas/piagent-webui/task-timeline-v1.schema.json",
  "schemas/piagent-webui/recovery-history-v1.schema.json",
  "schemas/piagent-webui/handoff-history-v1.schema.json",
  "schemas/piagent-webui/subagent-tree-v1.schema.json",
  "schemas/piagent-webui/release-monitor-v1.schema.json",
  "schemas/piagent-webui/transcript-v1.schema.json",
  "schemas/piagent-webui/queue-v1.schema.json",
  "schemas/piagent-webui/model-catalog-v1.schema.json",
  "schemas/piagent-webui/control-command-v1.schema.json",
  "schemas/piagent-webui/approval-v1.schema.json",
  "schemas/piagent-webui/capabilities-v1.schema.json",
  "schemas/piagent-webui/session-catalog-v1.schema.json",
  "schemas/piagent-webui/session-command-v1.schema.json",
  "schemas/piagent-webui/gateway-capabilities-v1.schema.json",
  "schemas/piagent-webui/gateway-protocol-v1.schema.json",
  "schemas/task-baseline-manifest.schema.json",
  "schemas/mutation-provenance-record.schema.json",
  "schemas/verifier-file-snapshot.schema.json",
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
  "@earendil-works/pi-ai": "0.84.1",
  "@earendil-works/pi-coding-agent": "0.84.1",
  typebox: "1.3.7"
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

# Documentation-coverage gates: a name that ships has to be findable in the docs
# that teach it. Each of these was a bare `grep >/dev/null` under `set -e`, which
# fails with exit 1 and no output, so a doc edit that dropped a term produced an
# unexplained failure and a bisect. Naming the term and the files searched turns
# that into a one-line fix.
# Repository-relative paths, so the message reads the same on every machine.
# Word-by-word because prefix removal on "$*" only strips the first word.
relative_paths() {
  local out=""
  for path in "$@"; do
    out+="${path#"$ROOT/"} "
  done
  printf '%s' "${out% }"
}

require_documented() {
  local term="$1"
  shift
  if ! grep -R "$term" "$@" >/dev/null; then
    echo "documentation gate: \"$term\" is no longer mentioned in $(relative_paths "$@"); restore it or update this gate in the same change" >&2
    exit 1
  fi
}

# Long-running repo commands stay quiet on success so the gate output stays
# readable, but discarding their output on failure leaves this script exiting 1
# with nothing to read. Capture, then replay only when the command fails.
run_quietly() {
  local label="$1"
  shift
  local output
  if ! output="$(cd "$ROOT" && "$@" 2>&1)"; then
    printf '%s\n' "$output" >&2
    echo "$label failed; the output above is why" >&2
    exit 1
  fi
}

require_documented "auth.json" "$ROOT/docs" "$ROOT/packages/piagent-core" "$ROOT/templates"
require_documented "piagent_context" "$ROOT/packages/piagent-core"
require_documented "piagent_permission_status" "$ROOT/packages/piagent-core" "$ROOT/docs" "$ROOT/README.md"
require_documented "/full-access" "$ROOT/docs" "$ROOT/README.md" "$ROOT/packages/piagent-core/README.md"
require_documented "piagent_exec_policy_check" "$ROOT/packages/piagent-core" "$ROOT/docs" "$ROOT/templates/project/AGENTS.md"
require_documented "piagent_context_budget" "$ROOT/packages/piagent-core" "$ROOT/docs" "$ROOT/templates/project/AGENTS.md"
require_documented "piagent_tool_policy_check" "$ROOT/packages/piagent-core" "$ROOT/docs" "$ROOT/templates/project/AGENTS.md"
require_documented "piagent_task_gate_check" "$ROOT/packages/piagent-core" "$ROOT/docs" "$ROOT/templates/project/AGENTS.md"
require_documented "piagent_usage_snapshot" "$ROOT/packages/piagent-core" "$ROOT/docs" "$ROOT/templates/project/AGENTS.md"
require_documented "/usage" "$ROOT/packages/piagent-core" "$ROOT/docs" "$ROOT/README.md"
require_documented "piagent_document_read" "$ROOT/packages/piagent-core" "$ROOT/docs"
require_documented "additionalReadRoots" "$ROOT/docs" "$ROOT/schemas/project-profile.schema.json"
require_documented "/commands" "$ROOT/README.md" "$ROOT/docs" "$ROOT/packages/piagent-core/extensions/piagent-guard.ts"
require_documented "/workflow" "$ROOT/README.md" "$ROOT/docs" "$ROOT/packages/piagent-core/extensions/piagent-guard.ts"
require_documented "/name" "$ROOT/README.md" "$ROOT/docs" "$ROOT/packages/piagent-core/extensions/piagent-guard.ts"
require_documented "/fresh" "$ROOT/README.md" "$ROOT/docs" "$ROOT/packages/piagent-core/extensions/piagent-guard.ts"
require_documented "/context" "$ROOT/README.md" "$ROOT/docs" "$ROOT/packages/piagent-core/extensions/piagent-guard.ts"
require_documented "/permission" "$ROOT/README.md" "$ROOT/docs" "$ROOT/packages/piagent-core/extensions/piagent-guard.ts"
require_documented "auto-delegation" "$ROOT/README.md" "$ROOT/docs" "$ROOT/packages/piagent-core/prompts" "$ROOT/templates/project/AGENTS.md"
require_documented "Subagents used/not used" "$ROOT/packages/piagent-core/prompts" "$ROOT/docs/auto-delegation-policy.md"
require_documented "Subagent orchestration capabilities" "$ROOT/README.md" "$ROOT/docs/subagent-orchestration-capabilities.md"
require_documented "pi-web-access" "$ROOT/README.md" "$ROOT/docs" "$ROOT/scripts/install-global.sh" "$ROOT/scripts/setup.sh"
grep -F 'PI_MCP_ADAPTER_SOURCE="npm:pi-mcp-adapter@2.15.0"' "$ROOT/scripts/install-global.sh" >/dev/null
grep -F 'PI_SUBAGENTS_SOURCE="npm:pi-subagents@0.38.0"' "$ROOT/scripts/install-global.sh" >/dev/null
grep -F 'PI_WEB_ACCESS_SOURCE="npm:pi-web-access@0.17.0"' "$ROOT/scripts/install-global.sh" >/dev/null
grep -F 'PI_MCP_ADAPTER_VERSION="2.15.0"' "$ROOT/scripts/audit-runtime-host.sh" >/dev/null
grep -F 'PI_SUBAGENTS_VERSION="0.38.0"' "$ROOT/scripts/audit-runtime-host.sh" >/dev/null
grep -F 'PI_WEB_ACCESS_VERSION="0.17.0"' "$ROOT/scripts/audit-runtime-host.sh" >/dev/null
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
# Each reviewed action revision is asserted by hand so that a swapped action is
# a verification failure rather than a silent change. A dependency bot updating
# an action therefore needs the pin here updated in the same change; without a
# message naming the pin, that failure reads as an unexplained exit.
require_action_pin() {
  local pin="$1"
  shift
  if ! grep -F "$pin" "$@" >/dev/null; then
    echo "reviewed GitHub Actions pin $pin is missing from $(relative_paths "$@"); update this pin in the same change that bumps the action" >&2
    exit 1
  fi
}
require_action_pin 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1' "$ROOT/.github/workflows/verify.yml" "$ROOT/.github/workflows/codeql.yml"
require_action_pin 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020' "$ROOT/.github/workflows/verify.yml"
require_action_pin 'github/codeql-action/init@e4fba868fa4b1b91e1fdab776edc8cfbe6e9fb81' "$ROOT/.github/workflows/codeql.yml"
require_action_pin 'github/codeql-action/analyze@e4fba868fa4b1b91e1fdab776edc8cfbe6e9fb81' "$ROOT/.github/workflows/codeql.yml"
grep -F 'git cat-file -t "refs/tags/$RELEASE_TAG"' "$ROOT/.github/workflows/verify.yml" >/dev/null
if grep -R -E '^[[:space:]]*uses:[[:space:]]+[^@[:space:]]+@(main|master|v[0-9]+([.][0-9]+)*)[[:space:]]*(#.*)?$' "$ROOT/.github/workflows" >/dev/null; then
  echo "GitHub Actions workflow contains a mutable action reference" >&2
  exit 1
fi
# A single-line `run:` whose value contains ": " ends the plain scalar early and
# makes the whole workflow unparseable. GitHub reports that as an instant
# failure with no job, so the gate stops running while still looking present.
# Use a block scalar or quote the value.
if grep -R -n -E '^[[:space:]]*run:[[:space:]]+[^|>"'"'"'].*:[[:space:]]' "$ROOT/.github/workflows" >/dev/null; then
  echo "GitHub Actions workflow has an unquoted run: value containing a colon-space; use a block scalar" >&2
  grep -R -n -E '^[[:space:]]*run:[[:space:]]+[^|>"'"'"'].*:[[:space:]]' "$ROOT/.github/workflows" >&2
  exit 1
fi
grep -F 'p.peerDependencies?.["@earendil-works/pi-coding-agent"]' "$ROOT/scripts/setup.sh" >/dev/null
grep -F 'run_cmd npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@$expected_pi_version"' "$ROOT/scripts/setup.sh" >/dev/null
grep -F 'validate-source --package-source "$PACKAGE_SOURCE"' "$ROOT/scripts/install-global.sh" >/dev/null
grep -F 'verify_npm_integrity "$PI_MCP_ADAPTER_SOURCE" "$PI_MCP_ADAPTER_INTEGRITY"' "$ROOT/scripts/install-global.sh" >/dev/null
grep -F 'verify_npm_integrity "$PI_SUBAGENTS_SOURCE" "$PI_SUBAGENTS_INTEGRITY"' "$ROOT/scripts/install-global.sh" >/dev/null
grep -F 'verify_npm_integrity "$PI_WEB_ACCESS_SOURCE" "$PI_WEB_ACCESS_INTEGRITY"' "$ROOT/scripts/install-global.sh" >/dev/null
require_documented "parallel-review" "$ROOT/docs" "$ROOT/README.md"
require_documented "intercomBridge" "$ROOT/scripts/configure-subagents.sh" "$ROOT/docs/subagents-and-multiagent.md"
require_documented "waitTool" "$ROOT/scripts/configure-subagents.sh" "$ROOT/docs/subagents-and-multiagent.md"
require_documented "piagent_profile_options" "$ROOT/packages/piagent-core" "$ROOT/docs"
require_documented "piagent_profile_apply" "$ROOT/packages/piagent-core" "$ROOT/docs"
require_documented "/profile auto" "$ROOT/README.md" "$ROOT/docs" "$ROOT/packages/piagent-core"
require_documented "piagent_profile_tech_context_record" "$ROOT/packages/piagent-core" "$ROOT/docs" "$ROOT/README.md"
require_documented "/profile tech" "$ROOT/README.md" "$ROOT/docs" "$ROOT/packages/piagent-core/prompts"
require_documented "/commit" "$ROOT/README.md" "$ROOT/docs" "$ROOT/packages/piagent-core/prompts"
require_documented "/pr" "$ROOT/README.md" "$ROOT/docs" "$ROOT/packages/piagent-core/prompts"
require_documented "piagent_project_onboarding_record" "$ROOT/packages/piagent-core" "$ROOT/docs"
require_documented "piagent_memory_status" "$ROOT/packages/piagent-core" "$ROOT/docs" "$ROOT/templates/project/AGENTS.md"
require_documented "piagent_memory_note" "$ROOT/packages/piagent-core" "$ROOT/docs"
require_documented "piagent_memory_search" "$ROOT/packages/piagent-core" "$ROOT/docs"
require_documented "piagent_memory_citation_record" "$ROOT/packages/piagent-core" "$ROOT/docs"
require_documented "piagent_context_index_status" "$ROOT/packages/piagent-core" "$ROOT/docs"
require_documented "piagent_context_index_record" "$ROOT/packages/piagent-core" "$ROOT/docs"
require_documented "piagent_context_index_search" "$ROOT/packages/piagent-core" "$ROOT/docs"
require_documented "/context index" "$ROOT/README.md" "$ROOT/docs" "$ROOT/packages/piagent-core/extensions/piagent-guard.ts"
require_documented "/onboard" "$ROOT/README.md" "$ROOT/docs" "$ROOT/templates/project/AGENTS.md"
require_documented "/memory" "$ROOT/README.md" "$ROOT/docs" "$ROOT/packages/piagent-core/extensions/piagent-guard.ts"
require_documented "/model-options" "$ROOT/README.md" "$ROOT/docs" "$ROOT/packages/piagent-core/extensions/piagent-guard.ts"
require_documented "anthropic/claude" "$ROOT/README.md" "$ROOT/docs/model-options.md" "$ROOT/packages/piagent-core/extensions/piagent-guard.ts"
require_documented "gpt-5.6" "$ROOT/README.md" "$ROOT/docs/model-options.md" "$ROOT/packages/piagent-core/extensions/piagent-guard.ts"
require_documented "claude-fable-5" "$ROOT/README.md" "$ROOT/docs/model-options.md" "$ROOT/packages/piagent-core/extensions/piagent-guard.ts"
require_documented "piagent-models" "$ROOT/README.md" "$ROOT/docs/model-options.md"
require_documented "enabledModels" "$ROOT/templates/global/settings.json" "$ROOT/docs/model-options.md" "$ROOT/scripts/configure-model-scope.sh"
require_documented "piagent-mcp" "$ROOT/README.md" "$ROOT/docs/mcp-and-tools.md" "$ROOT/scripts/mcp-manage.mjs"
require_documented "pi-mcp-adapter" "$ROOT/README.md" "$ROOT/docs/mcp-and-tools.md" "$ROOT/scripts/install-global.sh"
require_documented "piagent-subagents" "$ROOT/README.md" "$ROOT/docs/subagents-and-multiagent.md" "$ROOT/scripts/configure-subagents.sh"
require_documented "subagents-fleet" "$ROOT/docs/command-reference-vietnamese.md" "$ROOT/docs/subagents-and-multiagent.md" "$ROOT/README.md"
require_documented "health check" "$ROOT/docs/command-reference-vietnamese.md" "$ROOT/docs/subagents-and-multiagent.md" "$ROOT/README.md"
require_documented "pi-subagents" "$ROOT/README.md" "$ROOT/docs/subagents-and-multiagent.md" "$ROOT/scripts/install-global.sh" "$ROOT/scripts/setup.sh"
require_documented "piagent-scout" "$ROOT/README.md" "$ROOT/docs/subagents-and-multiagent.md" "$ROOT/packages/piagent-core/subagents"
grep -F "@upstash/context7-mcp@3.2.4" "$ROOT/packages/piagent-core/mcp/mcp-server-catalog.js" >/dev/null
grep -F "@upstash/context7-mcp@3.2.4" "$ROOT/docs/mcp-and-tools.md" >/dev/null
grep -F "chrome-devtools-mcp@1.6.0" "$ROOT/packages/piagent-core/mcp/mcp-server-catalog.js" >/dev/null
grep -F "chrome-devtools-mcp@1.6.0" "$ROOT/docs/mcp-and-tools.md" >/dev/null
grep -F "@playwright/mcp@0.0.78" "$ROOT/packages/piagent-core/mcp/mcp-server-catalog.js" >/dev/null
grep -F "@playwright/mcp@0.0.78" "$ROOT/docs/mcp-and-tools.md" >/dev/null
require_documented "https://mcp.figma.com/mcp" "$ROOT/packages/piagent-core/mcp/mcp-server-catalog.js" "$ROOT/docs/mcp-and-tools.md"
grep -F "ghcr.io/github/github-mcp-server@sha256:2b0c48b070f61e9d3969269ead600f62d00fb237b60ac849ef3d166ee7de9ad3" "$ROOT/packages/piagent-core/mcp/mcp-server-catalog.js" >/dev/null
grep -F "ghcr.io/github/github-mcp-server@sha256:2b0c48b070f61e9d3969269ead600f62d00fb237b60ac849ef3d166ee7de9ad3" "$ROOT/docs/mcp-and-tools.md" >/dev/null
grep -F '"GITHUB_READ_ONLY=1"' "$ROOT/packages/piagent-core/mcp/mcp-server-catalog.js" >/dev/null
grep -F '"GITHUB_READ_ONLY=1"' "$ROOT/docs/mcp-and-tools.md" >/dev/null
grep -F '"GITHUB_LOCKDOWN_MODE=1"' "$ROOT/packages/piagent-core/mcp/mcp-server-catalog.js" >/dev/null
grep -F '"GITHUB_LOCKDOWN_MODE=1"' "$ROOT/docs/mcp-and-tools.md" >/dev/null
grep -F 'CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: "1"' "$ROOT/packages/piagent-core/mcp/mcp-server-catalog.js" >/dev/null
grep -F '"CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS": "1"' "$ROOT/docs/mcp-and-tools.md" >/dev/null
grep -F 'CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1"' "$ROOT/packages/piagent-core/mcp/mcp-server-catalog.js" >/dev/null
grep -F '"CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS": "1"' "$ROOT/docs/mcp-and-tools.md" >/dev/null
grep -F 'mcp-manage.mjs" --scope global --preset "$MCP_PRESET" --replace' "$ROOT/scripts/install-global.sh" >/dev/null
grep -F 'piagent-mcp --preset core --scope global --replace' "$ROOT/scripts/mcp-manage.mjs" >/dev/null
if grep -E '@latest|"@upstash/context7-mcp"|"chrome-devtools-mcp"|"@playwright/mcp"|"ghcr\.io/github/github-mcp-server"' "$ROOT/packages/piagent-core/mcp/mcp-server-catalog.js" >/dev/null; then
  echo "MCP production presets contain a mutable dependency source"
  exit 1
fi
require_documented "Ctrl+L" "$ROOT/README.md" "$ROOT/docs/model-options.md" "$ROOT/docs/team-onboarding.md" "$ROOT/docs/quickstart-vietnamese.md"
require_documented "/workflow platform-improve" "$ROOT/README.md" "$ROOT/docs" "$ROOT/packages/piagent-core/extensions/piagent-guard.ts"
require_documented "/workflow be-to-fe" "$ROOT/README.md" "$ROOT/docs" "$ROOT/packages/piagent-core/extensions/piagent-guard.ts"
require_documented "/workflow scout" "$ROOT/README.md" "$ROOT/docs" "$ROOT/packages/piagent-core/extensions/piagent-guard.ts"
require_documented "piagent_context_preflight" "$ROOT/packages/piagent-core" "$ROOT/docs"
require_documented ".pi/task-inbox" "$ROOT/.gitignore" "$ROOT/templates/project/.pi/.gitignore" "$ROOT/docs"
require_documented "Task Implementation Contract" "$ROOT/docs" "$ROOT/packages/piagent-core/prompts"
require_documented "piagent-task-trace" "$ROOT/packages/piagent-core/extensions/piagent-guard.ts" "$ROOT/docs"
require_documented "piagent-source-cache" "$ROOT/packages/piagent-core/skills" "$ROOT/templates/project/AGENTS.md"
require_documented "piagent_source_checkout" "$ROOT/packages/piagent-core"
require_documented "scripts/setup.sh" "$ROOT/README.md" "$ROOT/docs"
require_documented "piagent-benchmark" "$ROOT/README.md" "$ROOT/docs"
require_documented "quality-benchmark.sh" "$ROOT/README.md" "$ROOT/docs"
require_documented "piagent-capabilities" "$ROOT/README.md" "$ROOT/docs/capability-packs.md"
require_documented ".pi-subagents/" "$ROOT/.gitignore" "$ROOT/docs/subagents-and-multiagent.md" "$ROOT/docs/distribution-standard.md" "$ROOT/scripts/init-project.sh"
test -s "$ROOT/tests/policy-core.test.mjs"

# Every gate below this line is a grep, and grep skips a file it decides is
# binary. One control byte written into a string literal — a NUL used as a key
# separator is the easy way to do it by accident — takes the whole file out of
# every one of them, and out of the diff a reviewer reads on a pull request. The
# file still runs, so nothing else notices. Escapes carry the same bytes and keep
# the file readable.
non_text_sources="$(
  cd "$ROOT" && git ls-files -z -- '*.js' '*.mjs' '*.ts' '*.json' '*.md' '*.sh' '*.html' '*.css' \
    | LC_ALL=C xargs -0 -n 1 sh -c '[ ! -f "$1" ] || [ ! -s "$1" ] || grep -qI "" "$1" 2>/dev/null || echo "$1"' sh
)"
if [[ -n "$non_text_sources" ]]; then
  echo "Source files contain control bytes, so grep-based gates and diffs skip them:"
  echo "$non_text_sources" | sed 's/^/  /'
  echo "Write the byte as an escape (\\u0000, \\x03) instead of embedding it."
  exit 1
fi

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
  ["Claude", " Code"].join(""),
  ["claude", " mcp"].join(""),
  ["codex", " mcp"].join(""),
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

# Every surface an outsider reads: the published docs, the site, and the strings
# the runtime prints back at an operator. The site is checked at its source,
# since `build-docs-site.mjs --check` separately proves the committed pages match
# it; the builder itself is listed too, because navigation labels and page titles
# live there rather than in a content fragment.
if grep -R -E -i \
  "$public_wording_pattern" \
  "$ROOT/README.md" \
  "$ROOT/docs" \
  "$ROOT/docs-site/content" \
  "$ROOT/scripts/build-docs-site.mjs" \
  "$ROOT/packages/piagent-core/README.md" \
  "$ROOT/packages/piagent-core/prompts" \
  "$ROOT/packages/piagent-core/mcp" \
  "$ROOT/packages/piagent-core/extensions" \
  "$ROOT/packages/piagent-core/runtime" \
  "$ROOT/templates/project/AGENTS.md" >/dev/null; then
  echo "Public docs contain non-neutral platform wording"
  exit 1
fi

node --check "$ROOT/packages/piagent-core/extensions/piagent-guard.ts" >/dev/null
node --check "$ROOT/packages/piagent-core/extensions/context-engine.js" >/dev/null
node --check "$ROOT/packages/piagent-core/extensions/context-index-policy.js" >/dev/null
node --check "$ROOT/packages/piagent-core/extensions/local-state-path.js" >/dev/null
node --check "$ROOT/packages/piagent-core/extensions/policy-core.js" >/dev/null
node --check "$ROOT/packages/piagent-core/extensions/redaction-core.js" >/dev/null
node --check "$ROOT/packages/piagent-core/extensions/runtime-evidence.js" >/dev/null
node --check "$ROOT/packages/piagent-core/extensions/state-retention.js" >/dev/null
node --check "$ROOT/packages/piagent-core/extensions/task-state.js" >/dev/null
node --check "$ROOT/packages/piagent-core/benchmark/benchmark-core.js" >/dev/null
node --check "$ROOT/packages/piagent-core/benchmark/benchmark-assurance.js" >/dev/null
node --check "$ROOT/packages/piagent-core/benchmark/benchmark-comparison.js" >/dev/null
node --check "$ROOT/packages/piagent-core/benchmark/benchmark-report.js" >/dev/null
node --check "$ROOT/packages/piagent-core/benchmark/benchmark-suite.js" >/dev/null
node --check "$ROOT/packages/piagent-core/benchmark/ie6-release-protocol.js" >/dev/null
node --check "$ROOT/scripts/ie6-release-freeze.mjs" >/dev/null
node --check "$ROOT/packages/piagent-core/security/sensitive-data.js" >/dev/null
node --check "$ROOT/packages/piagent-core/capabilities/capability-core.js" >/dev/null
node --check "$ROOT/packages/piagent-core/capabilities/capability-sources.js" >/dev/null
node --check "$ROOT/scripts/capability-catalog.mjs" >/dev/null
node --check "$ROOT/scripts/piagent-cli.mjs" >/dev/null
node --check "$ROOT/scripts/piagent-webui-launcher.mjs" >/dev/null
node --check "$ROOT/playwright.webui.config.mjs" >/dev/null
node --check "$ROOT/scripts/benchmark-runner.mjs" >/dev/null
node --check "$ROOT/scripts/context-engine.mjs" >/dev/null
node --check "$ROOT/scripts/pi-usage-history.mjs" >/dev/null
node --check "$ROOT/scripts/migrate-project-state.mjs" >/dev/null
node --check "$ROOT/scripts/import-agent-instructions.mjs" >/dev/null
node --check "$ROOT/scripts/check-runtime-advisories.mjs" >/dev/null
node --check "$ROOT/scripts/check-published-site.mjs" >/dev/null
node --check "$ROOT/scripts/build-docs-site.mjs" >/dev/null
node --check "$ROOT/scripts/preview-docs-site.mjs" >/dev/null
node "$ROOT/scripts/check-architecture.mjs" >/dev/null
node "$ROOT/scripts/check-doc-languages.mjs" >/dev/null
node "$ROOT/scripts/check-third-party-neutrality.mjs" >/dev/null
run_quietly "npm run build --workspace @piagent/webui" npm run build --workspace @piagent/webui
run_quietly "npm test" npm test
run_quietly "npm run test:webui:e2e" npm run test:webui:e2e
if [[ -x "$ROOT/node_modules/.bin/tsc" ]]; then
  run_quietly "npm run typecheck" npm run typecheck
fi
bash -n "$ROOT/scripts/quality-benchmark.sh"
bash -n "$ROOT/scripts/runtime-policy-smoke.sh"
bash -n "$ROOT/scripts/pi-session-stats.sh"
bash -n "$ROOT/scripts/pi-auto.sh"
bash -n "$ROOT/scripts/pi-model-catalog.sh"
bash -n "$ROOT/scripts/configure-model-scope.sh"
node --check "$ROOT/scripts/mcp-manage.mjs"
node --check "$ROOT/packages/piagent-core/mcp/mcp-session-view.js"
node --check "$ROOT/packages/piagent-core/mcp/mcp-command-actions.js"
bash -n "$ROOT/scripts/configure-subagents.sh"
bash -n "$ROOT/scripts/install-global.sh"
bash -n "$ROOT/scripts/init-project.sh"
bash -n "$ROOT/scripts/uninstall-global.sh"
bash -n "$ROOT/scripts/setup.sh"
if [[ "$OFFLINE" == true || "${PIAGENT_VERIFY_OFFLINE:-}" == "1" || "${CI:-}" == "true" ]]; then
  echo "WARN: skipping local Pi model catalog check in offline/CI mode" >&2
else
  bash "$ROOT/scripts/pi-model-catalog.sh" --json >/dev/null
fi
bash "$ROOT/scripts/configure-model-scope.sh" --dry-run --preset full --default-model openai-codex/gpt-5.5:high >/dev/null
node "$ROOT/scripts/mcp-manage.mjs" --list >/dev/null
node "$ROOT/scripts/mcp-manage.mjs" --dry-run --preset popular --scope project --project "$ROOT" >/dev/null
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
  execFileSync(process.execPath, [
    path.join(root, "scripts", "mcp-manage.mjs"),
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

node "$ROOT/scripts/build-docs-site.mjs" --check >/dev/null
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
