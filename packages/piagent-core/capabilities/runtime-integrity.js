import fs from "node:fs";
import path from "node:path";

export const CORE_RUNTIME_INTEGRITY_FILES = Object.freeze([
  "packages/piagent-core/runtime/context/adaptive-planner.ts",
  "packages/piagent-core/runtime/context/retrieval-route-policy.ts",
  "packages/piagent-core/extensions/acceptance-contract-semantics.js",
  "packages/piagent-core/extensions/acceptance-executable-evidence.js",
  "packages/piagent-core/extensions/acceptance-language-adapters.js",
  "packages/piagent-core/extensions/acceptance-receipt.js",
  "packages/piagent-core/extensions/criterion-graph.js",
  "packages/piagent-core/extensions/criterion-context-pack.js",
  "packages/piagent-core/extensions/document-intake.ts",
  "packages/piagent-core/extensions/execution-backend.js",
  "packages/piagent-core/extensions/failure-types.ts",
  "packages/piagent-core/extensions/repository-memory.js",
  "packages/piagent-core/extensions/state-retention.js",
  "packages/piagent-core/extensions/task-contract-view.js",
  "packages/piagent-core/extensions/task-authority-contract.js",
  "packages/piagent-core/extensions/task-digest-migration.js",
  "packages/piagent-core/extensions/task-journal.js",
  "packages/piagent-core/extensions/task-runtime-audit.js",
  "packages/piagent-core/extensions/task-state.js",
  "packages/piagent-core/extensions/tenant-contract.js",
  "packages/piagent-core/extensions/verification-intelligence.js",
  "packages/piagent-core/extensions/working-tree-digest.js",
  "packages/piagent-core/policy/authority-manifest.v1.json",
  "packages/piagent-core/capabilities/authority-manifest.ts",
  "packages/piagent-core/capabilities/capability-verification-cache.js",
  "packages/piagent-core/runtime/hooks/agent-start-hook.ts",
  "packages/piagent-core/runtime/hooks/completion-hook.ts",
  "packages/piagent-core/runtime/hooks/input-hook.ts",
  "packages/piagent-core/runtime/hooks/session-hooks.ts",
  "packages/piagent-core/runtime/hooks/session-start-hook.ts",
  "packages/piagent-core/runtime/hooks/tool-call-hook.ts",
  "packages/piagent-core/runtime/hooks/tool-result-hook.ts",
  "packages/piagent-core/runtime/hooks/tool-result-metadata.ts",
  "packages/piagent-core/runtime/input/chat-images.ts",
  "packages/piagent-core/runtime/inspection/activity-event-adapter.ts",
  "packages/piagent-core/runtime/inspection/approval-broker.ts",
  "packages/piagent-core/runtime/inspection/criteria-links.ts",
  "packages/piagent-core/runtime/inspection/commit-summary-projection.ts",
  "packages/piagent-core/runtime/inspection/diff-projection.ts",
  "packages/piagent-core/runtime/inspection/git-numstat-adapter.ts",
  "packages/piagent-core/runtime/inspection/git-filter-safety.ts",
  "packages/piagent-core/runtime/inspection/git-status-adapter.ts",
  "packages/piagent-core/runtime/inspection/git-tree-adapter.ts",
  "packages/piagent-core/runtime/inspection/mcp-control.ts",
  "packages/piagent-core/runtime/inspection/mutation-provenance-contract.ts",
  "packages/piagent-core/runtime/inspection/mutation-provenance-recorder.ts",
  "packages/piagent-core/runtime/inspection/mutation-provenance-store.ts",
  "packages/piagent-core/runtime/inspection/project-runtime-inspection.ts",
  "packages/piagent-core/runtime/inspection/review-state-contract.ts",
  "packages/piagent-core/runtime/inspection/review-state-projection.ts",
  "packages/piagent-core/runtime/inspection/review-state-store.ts",
  "packages/piagent-core/runtime/inspection/runtime-event-store.ts",
  "packages/piagent-core/runtime/inspection/same-process-bridge-proof.ts",
  "packages/piagent-core/runtime/inspection/zero-turn-conformance.ts",
  "packages/piagent-core/runtime/inspection/source-evidence-contract.ts",
  "packages/piagent-core/runtime/inspection/source-evidence-store.ts",
  "packages/piagent-core/runtime/inspection/source-inspection-plan.ts",
  "packages/piagent-core/runtime/inspection/source-mutation-projection.ts",
  "packages/piagent-core/runtime/inspection/source-mutation-store.ts",
  "packages/piagent-core/runtime/inspection/source-revert-projection.ts",
  "packages/piagent-core/runtime/inspection/source-handoff-store.ts",
  "packages/piagent-core/runtime/inspection/source-open-target.ts",
  "packages/piagent-core/runtime/inspection/task-run-index.ts",
  "packages/piagent-core/runtime/inspection/task-recovery-timeline.ts",
  "packages/piagent-core/runtime/inspection/task-compaction-history.ts",
  "packages/piagent-core/runtime/inspection/context-telemetry-inspection.ts",
  "packages/piagent-core/runtime/inspection/task-handoff-history.ts",
  "packages/piagent-core/runtime/inspection/task-subagent-tree.ts",
  "packages/piagent-core/runtime/inspection/task-baseline-start-capture.ts",
  "packages/piagent-core/runtime/inspection/task-control-journal.ts",
  "packages/piagent-core/runtime/inspection/task-source-projection.ts",
  "packages/piagent-core/runtime/inspection/task-provenance-projection.ts",
  "packages/piagent-core/runtime/inspection/verifier-snapshot-contract.ts",
  "packages/piagent-core/runtime/inspection/verifier-snapshot-store.ts",
  "packages/piagent-core/runtime/inspection/webui-snapshot.ts",
  "packages/piagent-core/runtime/inspection/text-diff.ts",
  "packages/piagent-core/runtime/inspection/source-change-projection.ts",
  "packages/piagent-core/runtime/inspection/workspace-file-reader.ts",
  "packages/piagent-core/runtime/inspection/workspace-source-projection.ts",
  "packages/piagent-core/runtime/model/capabilities.ts",
  "packages/piagent-core/runtime/model/authenticated-catalog.ts",
  "packages/piagent-core/runtime/model/model-route-policy.ts",
  "packages/piagent-core/runtime/model/model-route-runtime.ts",
  "packages/piagent-core/runtime/model/model-route-types.ts",
  "packages/piagent-core/runtime/model/model-selection-provenance.ts",
  "packages/piagent-core/runtime/model/runtime-snapshot.ts",
  "packages/piagent-core/runtime/model/snapshot-telemetry.ts",
  "packages/piagent-core/runtime/policy/authority-manifest.ts",
  "packages/piagent-core/runtime/policy/authority-resume-policy.ts",
  "packages/piagent-core/runtime/policy/source-index-transaction.ts",
  "packages/piagent-core/runtime/policy/source-mutation-guard-binding.ts",
  "packages/piagent-core/runtime/policy/source-mutation-guard.ts",
  "packages/piagent-core/runtime/policy/source-worktree-transaction.ts",
  "packages/piagent-core/runtime/policy/task-authority-runtime.ts",
  "packages/piagent-core/runtime/orchestration/role-policy.ts",
  "packages/piagent-core/runtime/orchestration/role-binder.ts",
  "packages/piagent-core/runtime/orchestration/owned-work-budget.ts",
  "packages/piagent-core/runtime/orchestration/helper-lifecycle.ts",
  "packages/piagent-core/runtime/product/activity-inspector-footer.ts",
  "packages/piagent-core/runtime/product/activity-inspector.ts",
  "packages/piagent-core/runtime/product/efficiency-metrics.ts",
  "packages/piagent-core/runtime/product/operator-projections.ts",
  "packages/piagent-core/runtime/quality/exact-output-contract.ts",
  "packages/piagent-core/runtime/quality/model-mutation-proof.ts",
  "packages/piagent-core/runtime/quality/performance-assurance.ts",
  "packages/piagent-core/runtime/quality/performance-review-evidence.ts",
  "packages/piagent-core/runtime/recovery/continuation-budget.ts",
  "packages/piagent-core/runtime/recovery/recovery-policy.ts",
  "packages/piagent-core/runtime/recovery/handoff-projection.ts",
  "packages/piagent-core/runtime/recovery/resume-state.ts",
  "packages/piagent-core/runtime/recovery/semantic-repair-handshake.ts",
  "packages/piagent-core/runtime/recovery/semantic-repair-runtime.ts",
  "packages/piagent-core/runtime/registration/activity-inspector-command.ts",
  "packages/piagent-core/runtime/registration/extension-registration.ts",
  "packages/piagent-core/runtime/registration/context-commands.ts",
  "packages/piagent-core/runtime/registration/knowledge-tools.ts",
  "packages/piagent-core/runtime/registration/memory-mcp-commands.ts",
  "packages/piagent-core/runtime/registration/onboarding-tools.ts",
  "packages/piagent-core/runtime/registration/operator-catalogs.ts",
  "packages/piagent-core/runtime/registration/permission-commands.ts",
  "packages/piagent-core/runtime/registration/policy-tools.ts",
  "packages/piagent-core/runtime/registration/profile-commands.ts",
  "packages/piagent-core/runtime/registration/runtime-model-status.ts",
  "packages/piagent-core/runtime/registration/session-commands.ts",
  "packages/piagent-core/runtime/registration/task-completion-tools.ts",
  "packages/piagent-core/runtime/registration/task-evidence-tools.ts",
  "packages/piagent-core/runtime/registration/task-start-tool.ts",
  "packages/piagent-core/runtime/registration/workflow-commands.ts",
  "packages/piagent-core/runtime/runtime-limits.ts",
  "packages/piagent-core/runtime/session/message-signals.ts",
  "packages/piagent-core/runtime/session/model-authorship-state.ts",
  "packages/piagent-core/runtime/session/performance-review-state.ts",
  "packages/piagent-core/runtime/session/runtime-state.ts",
  "packages/piagent-core/runtime/session/system-prompt.ts",
  "packages/piagent-core/runtime/session/tool-result-compaction.ts",
  "packages/piagent-core/runtime/session/usage.ts",
  "packages/piagent-core/runtime/solver/solver-types.ts",
  "packages/piagent-core/runtime/solver/task-features.ts",
  "packages/piagent-core/runtime/solver/solver-policy.ts",
  "packages/piagent-core/runtime/solver/solver-shadow.ts",
  "packages/piagent-core/runtime/solver/runtime-features.ts",
  "packages/piagent-core/runtime/solver/solver-explanation.ts",
  "packages/piagent-core/runtime/registration/task-preflight.ts",
  "packages/piagent-core/runtime/trajectory/trajectory-types.ts",
  "packages/piagent-core/runtime/trajectory/trajectory-state.ts",
  "packages/piagent-core/runtime/trajectory/trajectory-store.ts",
  "packages/piagent-core/runtime/trajectory/trajectory-runtime.ts",
  "packages/piagent-core/runtime/trajectory/trajectory-observability.ts",
  "packages/piagent-core/runtime/tools/tool-groups.ts",
  "packages/piagent-core/runtime/tools/phase-tools.ts",
  "packages/piagent-core/runtime/tools/phase-tool-runtime.ts",
  "packages/piagent-core/runtime/workflows/input-routing.ts",
  "packages/piagent-core/runtime/workflows/task-intake.ts",
  "scripts/piagent-cli.mjs",
  "scripts/register-typescript-loader.mjs",
  "scripts/typescript-loader.mjs"
]);

const EXECUTABLE_SOURCE = /\.(?:[cm]?js|ts|json|sh)$/;
const IMPORT_SPECIFIER = /(?:\bimport\s*(?:type\s+)?(?:[^"'`]*?\s+from\s*)?|\bexport\s+(?:type\s+)?[^"'`]*?\s+from\s*)["']([^"']+)["']/g;
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/g;
const RUNTIME_LITERAL = /["']((?:packages|scripts)\/[A-Za-z0-9_./-]+\.(?:[cm]?js|ts|json|sh))["']/g;
// A shell entrypoint reaches a sibling program through the directory it computed
// for itself -- `"$SCRIPT_DIR/pi-usage-history.mjs"` -- so the repository-relative
// literal the scanner above looks for never appears in the source. `piagent-usage`
// is a pinned command that ran a 567-line unpinned program this way.
const SHELL_SIBLING = /\$(?:\{)?(?:SCRIPT_DIR|ROOT|REPO_ROOT|PLATFORM_ROOT)(?:\})?\/([A-Za-z0-9_./-]+\.(?:[cm]?js|ts|json|sh))/g;
const MAX_INTEGRITY_FILES = 5_000;

function normalizedRelative(root, absolute) {
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep).join("/");
}

// A served bundle is more than its scripts: the document names which script runs,
// so pinning the JavaScript while leaving the HTML free would leave the choice of
// program unpinned.
const SERVED_BUNDLE_ASSET = /\.(?:[cm]?js|css|html|json|svg|woff2)$/;

function bundleFilesBelow(root, relativeDirectory) {
  return executableFilesBelow(root, relativeDirectory, SERVED_BUNDLE_ASSET);
}

function executableFilesBelow(root, relativeDirectory, accept = EXECUTABLE_SOURCE) {
  const directory = path.join(root, relativeDirectory);
  if (!fs.existsSync(directory)) return [];
  const files = [];
  const visit = (absolute) => {
    const entries = fs.readdirSync(absolute, { withFileTypes: true });
    for (const entry of entries) {
      const target = path.join(absolute, entry.name), stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) throw new Error(`runtime-integrity-symlink:${normalizedRelative(root, target) ?? "outside-root"}`);
      if (stat.isDirectory()) visit(target);
      else if (stat.isFile() && accept.test(entry.name)) files.push(normalizedRelative(root, target));
    }
  };
  visit(directory);
  return files.filter(Boolean);
}

function localImportTarget(root, importer, specifier) {
  if (!specifier.startsWith(".")) return undefined;
  const base = path.resolve(path.dirname(path.join(root, importer)), specifier);
  // TypeScript sources import a sibling module by its emitted name, so `./x.js`
  // is how a `.ts` file refers to `x.ts`. Without that rewrite the specifier
  // resolves to nothing and the reference is dropped in silence -- a module
  // that decides what the guard enforces would then sit outside the lock while
  // this list still claimed to cover the whole import graph.
  const rewritten = base.endsWith(".js") ? [`${base.slice(0, -3)}.ts`] : [];
  const candidates = [base, ...rewritten, `${base}.ts`, `${base}.js`, `${base}.mjs`, path.join(base, "index.ts"), path.join(base, "index.js")];
  for (const candidate of candidates) {
    const relative = normalizedRelative(root, candidate);
    if (!relative || !fs.existsSync(candidate)) continue;
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) throw new Error(`runtime-integrity-symlink:${relative}`);
    if (stat.isFile() && EXECUTABLE_SOURCE.test(candidate)) return relative;
  }
  return undefined;
}

function sourceReferences(root, relativeFile) {
  // Shell entrypoints are scanned too. They were skipped here, so a pinned
  // command could execute an unpinned program and the lock reported a complete
  // graph while missing it.
  const shell = relativeFile.endsWith(".sh");
  if (!shell && !/\.(?:[cm]?js|ts)$/.test(relativeFile)) return [];
  const source = fs.readFileSync(path.join(root, relativeFile), "utf8"), references = new Set();
  if (shell) {
    const directory = path.posix.dirname(relativeFile);
    for (const pattern of [RUNTIME_LITERAL, SHELL_SIBLING]) {
      pattern.lastIndex = 0;
      for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
        const candidate = pattern === SHELL_SIBLING ? path.posix.join(directory, match[1]) : match[1];
        const absolute = path.join(root, candidate), relative = normalizedRelative(root, absolute);
        if (relative && fs.existsSync(absolute) && fs.lstatSync(absolute).isFile()) references.add(relative);
      }
    }
    return [...references];
  }
  for (const pattern of [IMPORT_SPECIFIER, DYNAMIC_IMPORT]) {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
      const target = localImportTarget(root, relativeFile, match[1]);
      if (target) references.add(target);
    }
  }
  RUNTIME_LITERAL.lastIndex = 0;
  for (let match = RUNTIME_LITERAL.exec(source); match; match = RUNTIME_LITERAL.exec(source)) {
    const target = path.join(root, match[1]), relative = normalizedRelative(root, target);
    if (relative && fs.existsSync(target) && fs.lstatSync(target).isFile()) references.add(relative);
  }
  return [...references];
}

export function discoverRuntimeIntegrityFiles(root) {
  const packageDocument = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const declaredExtensions = Array.isArray(packageDocument.pi?.extensions) ? packageDocument.pi.extensions : [];
  const declaredBins = packageDocument.bin && typeof packageDocument.bin === "object" ? Object.values(packageDocument.bin) : [];
  const declaredEntrypoints = Array.isArray(packageDocument.piagent?.runtimeIntegrityEntrypoints)
    ? packageDocument.piagent.runtimeIntegrityEntrypoints : [];
  const seeds = new Set([
    ...CORE_RUNTIME_INTEGRITY_FILES,
    "packages/piagent-core/extensions/piagent-guard.ts",
    ...executableFilesBelow(root, "packages/piagent-core/runtime"),
    // The browser bundle the WebUI serves. The published package ships the built
    // assets and not the sources they came from, so on an installed platform
    // this code cannot be regenerated or cross-checked against anything -- and it
    // runs inside the origin that holds the session cookie and the CSRF token,
    // with the authority to drive session commands, source mutation and provider
    // auth. The server that serves it was pinned; what it serves was not.
    //
    // The tree is absent in a source checkout until the workspace is built, and
    // absence is not a failure here: a lock recorded with these entries still
    // fails verification if they later disappear.
    ...bundleFilesBelow(root, "packages/piagent-webui/dist/client"),
    ...declaredExtensions,
    ...declaredBins,
    ...declaredEntrypoints
  ].filter((entry) => typeof entry === "string" && !path.isAbsolute(entry)));
  const files = new Set(), pending = [...seeds];
  while (pending.length) {
    if (files.size >= MAX_INTEGRITY_FILES) throw new Error("runtime-integrity-file-limit");
    const relative = pending.pop();
    if (files.has(relative)) continue;
    const absolute = path.join(root, relative), contained = normalizedRelative(root, absolute);
    if (!contained || !fs.existsSync(absolute)) continue;
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`runtime-integrity-file-unsafe:${relative}`);
    files.add(contained);
    for (const reference of sourceReferences(root, contained)) if (!files.has(reference)) pending.push(reference);
  }
  return [...files].sort((left, right) => left.localeCompare(right, "en"));
}
