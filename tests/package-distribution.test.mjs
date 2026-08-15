import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoots = new Set();
const webUiSchemaPackageFiles = [
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
  "schemas/piagent-webui/attachment-v1.schema.json",
  "schemas/piagent-webui/control-command-v1.schema.json",
  "schemas/piagent-webui/approval-v1.schema.json",
  "schemas/piagent-webui/capabilities-v1.schema.json",
  "schemas/piagent-webui/session-catalog-v1.schema.json",
  "schemas/piagent-webui/session-command-v1.schema.json",
  "schemas/piagent-webui/gateway-capabilities-v1.schema.json",
  "schemas/piagent-webui/gateway-protocol-v1.schema.json",
  "schemas/task-baseline-manifest.schema.json",
  "schemas/mutation-provenance-record.schema.json",
  "schemas/verifier-file-snapshot.schema.json"
];
const webUiInspectionPackageFiles = [
  "packages/piagent-core/runtime/inspection/activity-event-adapter.ts",
  "packages/piagent-core/runtime/inspection/commit-summary-projection.ts",
  "packages/piagent-core/runtime/inspection/criteria-links.ts",
  "packages/piagent-core/runtime/inspection/git-numstat-adapter.ts",
  "packages/piagent-core/runtime/inspection/git-filter-safety.ts",
  "packages/piagent-core/runtime/inspection/git-status-adapter.ts",
  "packages/piagent-core/runtime/inspection/git-tree-adapter.ts",
  "packages/piagent-core/runtime/inspection/mutation-provenance-contract.ts",
  "packages/piagent-core/runtime/inspection/mutation-provenance-recorder.ts",
  "packages/piagent-core/runtime/inspection/mutation-provenance-store.ts",
  "packages/piagent-core/runtime/inspection/runtime-event-store.ts",
  "packages/piagent-core/runtime/inspection/same-process-bridge-proof.ts",
  "packages/piagent-core/runtime/inspection/zero-turn-conformance.ts",
  "packages/piagent-core/runtime/inspection/source-evidence-contract.ts",
  "packages/piagent-core/runtime/inspection/source-evidence-store.ts",
  "packages/piagent-core/runtime/inspection/source-mutation-projection.ts",
  "packages/piagent-core/runtime/inspection/source-mutation-store.ts",
  "packages/piagent-core/runtime/inspection/source-revert-projection.ts",
  "packages/piagent-core/runtime/inspection/source-handoff-store.ts",
  "packages/piagent-core/runtime/inspection/source-open-target.ts",
  "packages/piagent-core/runtime/inspection/task-baseline-start-capture.ts",
  "packages/piagent-core/runtime/inspection/task-run-index.ts",
  "packages/piagent-core/runtime/inspection/task-recovery-timeline.ts",
  "packages/piagent-core/runtime/inspection/task-compaction-history.ts",
  "packages/piagent-core/runtime/inspection/context-telemetry-inspection.ts",
  "packages/piagent-core/runtime/inspection/task-handoff-history.ts",
  "packages/piagent-core/runtime/inspection/task-subagent-tree.ts",
  "packages/piagent-core/runtime/inspection/task-source-projection.ts",
  "packages/piagent-core/runtime/inspection/task-provenance-projection.ts",
  "packages/piagent-core/runtime/inspection/verifier-snapshot-contract.ts",
  "packages/piagent-core/runtime/inspection/verifier-snapshot-store.ts",
  "packages/piagent-core/runtime/inspection/webui-snapshot.ts",
  "packages/piagent-core/runtime/inspection/text-diff.ts",
  "packages/piagent-core/runtime/inspection/source-change-projection.ts",
  "packages/piagent-core/runtime/inspection/workspace-file-reader.ts",
  "packages/piagent-core/runtime/inspection/workspace-source-projection.ts",
  "packages/piagent-core/runtime/inspection/mcp-control.ts",
  "packages/piagent-core/runtime/inspection/diff-projection.ts",
  "packages/piagent-core/runtime/inspection/review-state-contract.ts",
  "packages/piagent-core/runtime/inspection/review-state-projection.ts",
  "packages/piagent-core/runtime/inspection/review-state-store.ts",
  "packages/piagent-core/runtime/policy/source-index-transaction.ts",
  "packages/piagent-core/runtime/policy/source-mutation-guard-binding.ts",
  "packages/piagent-core/runtime/policy/source-mutation-guard.ts",
  "packages/piagent-core/runtime/policy/source-worktree-transaction.ts"
];
const webUiGatewayPackageFiles = [
  "packages/piagent-webui/gateway/control-socket.ts",
  "packages/piagent-webui/gateway/gateway-service.ts",
  "packages/piagent-webui/gateway/gateway-events.ts",
  "packages/piagent-webui/gateway/gateway-protocol-service.ts",
  "packages/piagent-webui/gateway/gateway-session-stream.ts",
  "packages/piagent-webui/gateway/pi-host.ts",
  "packages/piagent-webui/gateway/profile-state.ts",
  "packages/piagent-webui/gateway/project-registry.ts",
  "packages/piagent-webui/gateway/native-project-picker.ts",
  "packages/piagent-webui/gateway/provider-auth-broker.ts",
  "packages/piagent-webui/gateway/mcp-auth-broker.ts",
  "packages/piagent-webui/gateway/session-catalog.ts",
  "packages/piagent-webui/gateway/session-command-controller.ts",
  "packages/piagent-webui/gateway/session-command-store.ts",
  "packages/piagent-webui/gateway/session-lease-store.ts",
  "packages/piagent-webui/gateway/session-metadata-store.ts",
  "packages/piagent-webui/gateway/session-runtime-supervisor.ts",
  "packages/piagent-webui/ownership/profile-state.ts",
  "packages/piagent-webui/ownership/session-lease-store.ts",
  "packages/piagent-webui/ownership/session-refs.ts",
  "packages/piagent-webui/extension/terminal-session-adapter.ts",
  "packages/piagent-webui/server/gateway-websocket.ts",
  "scripts/piagent-dashboard.mjs"
];

function dryRunPackageFiles(cwd = repositoryRoot) {
  const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd, encoding: "utf8" });
  assert.equal(packed.status, 0, packed.stderr);
  return new Set(JSON.parse(packed.stdout)[0].files.map((file) => file.path));
}

function localModuleSpecifiers(source) {
  const patterns = [
    /\b(?:import|export)\s+(?!type\b)[\w*{},\s]+?\s+from\s+["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g
  ];
  return patterns.flatMap((pattern) => [...source.matchAll(pattern)].map((match) => match[1]))
    .filter((specifier) => specifier.startsWith("."));
}

function importedProductionModules(entrypoints) {
  const visited = new Set();
  const pending = [...entrypoints];
  while (pending.length > 0) {
    const relative = pending.pop();
    if (visited.has(relative)) continue;
    visited.add(relative);
    const absolute = path.join(repositoryRoot, relative);
    const source = fs.readFileSync(absolute, "utf8");
    for (const specifier of localModuleSpecifiers(source)) {
      const target = path.relative(repositoryRoot, path.resolve(path.dirname(absolute), specifier));
      if (fs.existsSync(path.join(repositoryRoot, target)) && !visited.has(target)) pending.push(target);
    }
  }
  return visited;
}

after(() => {
  for (const root of temporaryRoots) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("pi-package-bin-")) continue;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("package distribution", () => {
  it("keeps maintainer working notes out of the published tarball", () => {
    // npm packs from the working directory, so these stay on disk even though
    // they are untracked. The files allowlist takes precedence over .npmignore
    // for top-level entries, which is why the exclusions live in package.json.
    const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: repositoryRoot,
      encoding: "utf8"
    });
    assert.equal(packed.status, 0, packed.stderr);
    const entries = JSON.parse(packed.stdout)[0].files.map((file) => file.path);

    const shipsInternalNotes = entries.filter((entry) =>
      /^plans\//.test(entry)
      || /^docs\/journals\//.test(entry)
      || /^docs\/decisions\//.test(entry)
      || /^docs\/readiness-assessment\.md$/.test(entry));
    assert.deepEqual(shipsInternalNotes, []);
    const shippedWebUi = entries.filter((entry) => entry.startsWith("packages/piagent-webui/"));
    assert.ok(shippedWebUi.includes("packages/piagent-webui/package.json"));
    assert.ok(shippedWebUi.includes("packages/piagent-webui/extension/piagent-webui.ts"));
    assert.ok(shippedWebUi.includes("packages/piagent-webui/extension/same-session-bridge.ts"));
    assert.ok(shippedWebUi.includes("packages/piagent-webui/extension/held-message-queue.ts"));
    assert.ok(shippedWebUi.includes("packages/piagent-webui/extension/session-options-controller.ts"));
    assert.ok(shippedWebUi.includes("packages/piagent-webui/extension/session-stream-adapter.ts"));
    assert.ok(shippedWebUi.includes("packages/piagent-webui/extension/attachment-store.ts"));
    assert.ok(shippedWebUi.includes("packages/piagent-webui/extension/lifecycle-controller.ts"));
    assert.ok(shippedWebUi.includes("packages/piagent-webui/extension/lifecycle-event-adapter.ts"));
    assert.ok(shippedWebUi.includes("packages/piagent-webui/extension/source-mutation-controller.ts"));
    assert.ok(shippedWebUi.includes("packages/piagent-webui/extension/source-revert-controller.ts"));
    assert.ok(shippedWebUi.includes("packages/piagent-webui/extension/source-open-controller.ts"));
    assert.ok(shippedWebUi.includes("packages/piagent-webui/extension/vscode-handoff.ts"));
    assert.ok(entries.includes("packages/piagent-core/runtime/inspection/approval-broker.ts"));
    assert.ok(entries.includes("packages/piagent-core/runtime/inspection/task-control-journal.ts"));
    assert.ok(shippedWebUi.includes("packages/piagent-webui/server/transcript-projection.ts"));
    assert.ok(shippedWebUi.includes("packages/piagent-webui/server/benchmark-release-monitor.ts"));
    assert.ok(shippedWebUi.includes("packages/piagent-webui/server/sidecar-main.ts"));
    assert.ok(shippedWebUi.includes("packages/piagent-webui/dist/client/index.html"));
    assert.ok(entries.includes("scripts/piagent-webui-launcher.mjs"));
    assert.equal(shippedWebUi.some((entry) => /\/(?:client\/src|benchmark|scripts|contracts)\//.test(entry)), false,
      "the public root package may ship only the reviewed WebUI runtime and static bundle");

    // The exclusions must not swallow the documentation users install for.
    assert.ok(entries.includes("docs/capability-packs.md"));
    assert.ok(entries.includes("benchmarks/core-v1/suite.json"));
    assert.ok(entries.includes("benchmarks/capability-v1/suite.json"));
    assert.ok(entries.includes("benchmarks/capability-v1/grade.mjs"));
    assert.ok(entries.includes("benchmarks/e2-framework-v1/project/vendor/hono/dist/index.js"));
    assert.ok(entries.includes("benchmarks/production-v1/suite.json"));
    assert.ok(entries.includes("benchmarks/production-v1/variant.mjs"));
    assert.ok(entries.includes("scripts/benchmark-runner.mjs"));
    assert.ok(entries.includes("scripts/rc-readiness-evaluation.mjs"));
    assert.ok(entries.includes("scripts/ie6-release-freeze.mjs"));
    assert.ok(entries.includes("scripts/private-holdout-readiness.mjs"));
    assert.ok(entries.includes("scripts/fs4-readiness-evaluation.mjs"));
    assert.ok(entries.includes("evals/rc-evaluation-matrix.v1.json"));
    assert.ok(entries.includes("evals/private-holdout-v1/access-policy.v1.json"));
    assert.ok(entries.includes("evals/private-holdout-v1/human-rubric.v1.json"));
    assert.ok(entries.includes("evals/private-holdout-v1/public-exposure.v1.json"));
    assert.ok(entries.includes("evals/private-holdout-v1/CUSTODIAN_RUNBOOK.md"));
    assert.ok(entries.includes("evals/fs4-readiness-matrix.v1.json"));
    assert.ok(entries.includes("evals/fs5-pilot-protocol.v1.json"));
    assert.ok(entries.includes("evals/fs5-pilot-protocol.v5.json"));
    assert.ok(entries.includes("evals/ie6-release-protocol.v1.json"));
    assert.ok(entries.includes("evals/fs5-causal-arm.v1.json"));
    assert.ok(entries.includes("schemas/benchmark-assurance-evidence.schema.json"));
    for (const file of webUiSchemaPackageFiles) assert.ok(entries.includes(file), `missing WebUI wire contract: ${file}`);
    for (const file of webUiInspectionPackageFiles) assert.ok(entries.includes(file), `missing WebUI inspection module: ${file}`);
    for (const file of webUiGatewayPackageFiles) assert.ok(entries.includes(file), `missing WebUI Gateway module: ${file}`);
    assert.ok(entries.includes("packages/piagent-core/benchmark/benchmark-core.js"));
    assert.ok(entries.includes("packages/piagent-core/benchmark/fs4-readiness-gates.js"));
    assert.ok(entries.includes("packages/piagent-core/benchmark/fs5-pilot-protocol.js"));
    assert.ok(entries.includes("packages/piagent-core/benchmark/ie6-release-protocol.js"));
    assert.ok(entries.includes("packages/piagent-core/benchmark/fs5-causal-arm.js"));
    assert.ok(entries.includes("packages/piagent-core/benchmark/benchmark-report.js"));
    assert.equal(entries.some((entry) => /(?:^|\/)\.env(?:$|\.)/.test(entry)), false);
    assert.ok(entries.some((entry) => entry.startsWith("templates/project/")));
    assert.ok(entries.some((entry) => entry.startsWith("adapters/")));
  });

  it("ships the complete production import graph and no private runtime state", () => {
    const files = dryRunPackageFiles();
    const imported = importedProductionModules([
      "packages/piagent-core/extensions/piagent-guard.ts",
      "packages/piagent-webui/extension/piagent-webui.ts",
      "packages/piagent-webui/server/sidecar-main.ts",
      "scripts/piagent-cli.mjs",
      "scripts/piagent-dashboard.mjs",
      "scripts/piagent-webui-launcher.mjs"
    ]);
    for (const relative of imported) {
      assert.equal(files.has(relative), true, `imported production module is missing from package: ${relative}`);
    }
    assert.equal(
      files.has("packages/piagent-core/extensions/core-services.js"),
      false,
      "the test-only aggregation barrel must not ship as an unbound production module"
    );

    const forbidden = [
      /(?:^|\/)auth\.json$/i,
      /(?:^|\/)trust\.json$/i,
      /(?:^|\/)\.env(?:$|\.)/i,
      /(?:^|\/)\.pi\/piagent-state(?:\/|$)/i,
      /(?:^|\/)examples\/private(?:\/|$)/i,
      /(?:^|\/)docs\/(?:journals|decisions)(?:\/|$)/i,
      /(?:^|\/)plans(?:\/|$)/i
    ];
    const leaked = [...files].filter((relative) => forbidden.some((pattern) => pattern.test(relative)));
    assert.deepEqual(leaked, []);
  });

  it("declares a publishable package", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
    assert.equal(pkg.private, undefined, "private would block publishing entirely");
    assert.equal(pkg.name, "@piagent/platform");
    // A scoped package defaults to restricted; publishing publicly is explicit.
    assert.equal(pkg.publishConfig?.access, "public");
    assert.equal(pkg.publishConfig?.provenance, true);
    if (pkg.version.includes("-")) {
      assert.equal(pkg.publishConfig?.tag, "next", "prerelease must not replace npm latest");
    } else {
      assert.equal(pkg.publishConfig?.tag, undefined, "stable release must publish to npm latest");
    }
    const workflow = fs.readFileSync(path.join(repositoryRoot, ".github", "workflows", "publish.yml"), "utf8");
    assert.match(workflow, /fetch-depth:\s*0/, "publish checkout must include release-tag history");
    assert.match(workflow, /apt-get install --yes ripgrep/, "publish job must install its Linux test prerequisite");
    assert.match(workflow, /- name: Install WebUI Chromium\s*\n\s*run: npx playwright install --with-deps chromium/,
      "publish job must install the browser used by local verification");
    assert.match(workflow, /if \[\[ "\$version" == \*-\* \]\]; then tag="next"; fi/);
    assert.match(workflow, /npm publish --tag "\$\{\{ steps\.npm-tag\.outputs\.value \}\}"/);
  });

  it("declares only real extension entry points in every pi manifest", () => {
    // Pi loads every path pi.extensions matches and calls its default export as
    // an extension factory. The modules the guard imports live beside it in
    // extensions/, so a directory glob would hand Pi a module that exports
    // helpers and no factory, and the pack would fail to load.
    const manifests = [
      { root: repositoryRoot, name: "package.json" },
      { root: path.join(repositoryRoot, "packages", "piagent-core"), name: "packages/piagent-core/package.json" }
    ];

    for (const manifest of manifests) {
      const pkg = JSON.parse(fs.readFileSync(path.join(manifest.root, "package.json"), "utf8"));
      const patterns = pkg.pi?.extensions ?? [];
      assert.ok(patterns.length > 0, `${manifest.name} declares no extensions`);

      const matched = patterns.flatMap((pattern) => fs.globSync(pattern, { cwd: manifest.root }));
      assert.ok(matched.length > 0, `${manifest.name} matches no files`);

      for (const relative of matched) {
        const source = fs.readFileSync(path.join(manifest.root, relative), "utf8");
        assert.match(
          source,
          /^export default /m,
          `${manifest.name} declares ${relative} as an extension, but it has no default export for Pi to call`
        );
      }
    }
  });

  it("keeps the guard's own modules out of the extension entry points", () => {
    // The inverse of the check above: proving the manifest is narrow, not just
    // that everything it currently happens to match is loadable.
    const packageRoot = path.join(repositoryRoot, "packages", "piagent-core");
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    const matched = new Set(pkg.pi.extensions.flatMap((pattern) => fs.globSync(pattern, { cwd: packageRoot })));

    const libraryModules = fs
      .readdirSync(path.join(packageRoot, "extensions"))
      .filter((entry) => entry !== "piagent-guard.ts")
      .map((entry) => path.join("extensions", entry));

    assert.ok(libraryModules.length > 0, "the guard should still have modules beside it");
    for (const relative of libraryModules) {
      assert.equal(matched.has(relative), false, `${relative} is a library module, not an extension entry point`);
    }
    assert.equal(matched.has(path.join("extensions", "piagent-guard.ts")), true);
  });

  it("routes all global bin commands through the package-root dispatcher", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
    const bins = Object.entries(pkg.bin);
    assert.ok(bins.length > 0);
    for (const [name, target] of bins) {
      assert.match(name, /^piagent(?:-|$)/);
      assert.equal(target, "scripts/piagent-cli.mjs");
    }
    assert.equal(fs.statSync(path.join(repositoryRoot, "scripts", "piagent-cli.mjs")).mode & 0o111, 0o111);
  });

  it("includes runtime templates that npm may otherwise omit as dotfiles", () => {
    const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: repositoryRoot,
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr);
    const pack = JSON.parse(result.stdout)[0];
    const files = new Set(pack.files.map((file) => file.path));
    assert.equal(files.has("SECURITY.md"), true);
    assert.equal(files.has("scripts/piagent-cli.mjs"), true);
    assert.equal(files.has("scripts/benchmark-runner.mjs"), true);
    assert.equal(files.has("scripts/rc-readiness-evaluation.mjs"), true);
    assert.equal(files.has("scripts/ie6-release-freeze.mjs"), true);
    assert.equal(files.has("scripts/private-holdout-readiness.mjs"), true);
    assert.equal(files.has("scripts/fs4-readiness-evaluation.mjs"), true);
    assert.equal(files.has("evals/rc-evaluation-matrix.v1.json"), true);
    assert.equal(files.has("evals/private-holdout-v1/access-policy.v1.json"), true);
    assert.equal(files.has("evals/private-holdout-v1/human-rubric.v1.json"), true);
    assert.equal(files.has("evals/private-holdout-v1/public-exposure.v1.json"), true);
    assert.equal(files.has("evals/private-holdout-v1/CUSTODIAN_RUNBOOK.md"), true);
    assert.equal(files.has("evals/fs4-readiness-matrix.v1.json"), true);
    assert.equal(files.has("evals/fs5-pilot-protocol.v1.json"), true);
    assert.equal(files.has("evals/fs5-pilot-protocol.v5.json"), true);
    assert.equal(files.has("evals/ie6-release-protocol.v1.json"), true);
    assert.equal(files.has("evals/fs5-causal-arm.v1.json"), true);
    assert.equal(files.has("schemas/benchmark-assurance-evidence.schema.json"), true);
    for (const file of webUiSchemaPackageFiles) assert.equal(files.has(file), true, `missing WebUI wire contract: ${file}`);
    for (const file of webUiInspectionPackageFiles) assert.equal(files.has(file), true, `missing WebUI inspection module: ${file}`);
    for (const file of webUiGatewayPackageFiles) assert.equal(files.has(file), true, `missing WebUI Gateway module: ${file}`);
    assert.equal(files.has("packages/piagent-core/benchmark/benchmark-core.js"), true);
    assert.equal(files.has("packages/piagent-core/benchmark/fs4-readiness-gates.js"), true);
    assert.equal(files.has("packages/piagent-core/benchmark/fs5-pilot-protocol.js"), true);
    assert.equal(files.has("packages/piagent-core/benchmark/ie6-release-protocol.js"), true);
    assert.equal(files.has("packages/piagent-core/benchmark/fs5-causal-arm.js"), true);
    assert.equal(files.has("packages/piagent-core/benchmark/benchmark-report.js"), true);
    assert.equal(files.has("benchmarks/core-v1/suite.json"), true);
    assert.equal(files.has("benchmarks/core-v1/tasks/invoice-quantity/grade.mjs"), true);
    assert.equal(files.has("benchmarks/capability-v1/suite.json"), true);
    assert.equal(files.has("benchmarks/capability-v1/references/concurrent-lease-lifecycle/packages/lease/src/store.js"), true);
    assert.equal(files.has("benchmarks/e2-framework-v1/project/vendor/hono/dist/index.js"), true);
    assert.equal(files.has("benchmarks/production-v1/suite.json"), true);
    assert.equal(files.has("benchmarks/production-v1/grade.mjs"), true);
    assert.equal(files.has("benchmarks/production-v1/project/package.json"), true);
    assert.equal(files.has("scripts/verify-vercel-link.mjs"), true);
    assert.equal(files.has("templates/project/.pi/gitignore.template"), true);
    assert.equal(files.has("templates/project/.pi/context-index.json"), true);
    assert.equal(files.has("templates/project/.pi/tech-stack.json"), true);
    assert.equal(files.has("templates/project/.pi/tech-context/README.md"), true);
    assert.equal(files.has("templates/project/.pi/npmignore.template"), false);
  });

  it("resolves package root correctly when invoked through a global-bin style symlink", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-package-bin-"));
    temporaryRoots.add(root);
    const link = path.join(root, "piagent-capabilities");
    fs.symlinkSync(path.join(repositoryRoot, "scripts", "piagent-cli.mjs"), link);
    const result = spawnSync(link, ["--help"], {
      cwd: repositoryRoot,
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /piagent-capabilities catalog/);
  });

  it("routes the primary piagent dashboard subcommand through the installed dispatcher", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-package-bin-"));
    temporaryRoots.add(root);
    const link = path.join(root, "piagent");
    fs.symlinkSync(path.join(repositoryRoot, "scripts", "piagent-cli.mjs"), link);
    const result = spawnSync(link, ["dashboard", "--help"], {
      cwd: repositoryRoot,
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: piagent dashboard/);
  });

  it("shows help successfully for every global command without requiring project state", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-package-bin-"));
    temporaryRoots.add(root);
    const packed = spawnSync("npm", ["pack", "--json", "--pack-destination", root], {
      cwd: repositoryRoot,
      encoding: "utf8"
    });
    assert.equal(packed.status, 0, packed.stderr);
    const tarball = path.join(root, JSON.parse(packed.stdout)[0].filename);
    const installed = spawnSync("npm", ["install", "--global", "--ignore-scripts", "--prefix", root, tarball], {
      cwd: root,
      encoding: "utf8"
    });
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);

    for (const name of Object.keys(pkg.bin)) {
      const executable = path.join(root, "bin", name);
      const result = spawnSync(executable, ["--help"], {
        cwd: root,
        encoding: "utf8"
      });
      assert.equal(result.status, 0, `${name} --help failed:\n${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /Usage:/, `${name} should print usage`);
      assert.equal(result.stderr, "", `${name} --help should not emit an error`);
    }

    const agentRoot = path.join(root, "agent");
    const benchmarkSource = path.join(agentRoot, "git", "github.com", "Vt-mmm", "piagent");
    fs.mkdirSync(path.dirname(benchmarkSource), { recursive: true });
    fs.cpSync(path.join(root, "lib", "node_modules", "@piagent", "platform"), benchmarkSource, { recursive: true });
    const gitEnvironment = {
      ...process.env,
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Piagent Package Test",
      GIT_AUTHOR_EMAIL: "package-test@invalid.example",
      GIT_COMMITTER_NAME: "Piagent Package Test",
      GIT_COMMITTER_EMAIL: "package-test@invalid.example"
    };
    for (const args of [["init"], ["add", "-A"], ["commit", "-m", "package fixture"]]) {
      const git = spawnSync("git", args, { cwd: benchmarkSource, env: gitEnvironment, encoding: "utf8" });
      assert.equal(git.status, 0, git.stderr || git.stdout);
    }
    const dryRun = spawnSync(path.join(root, "bin", "piagent-benchmark"), ["--dry-run"], {
      cwd: root,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentRoot },
      encoding: "utf8"
    });
    assert.equal(dryRun.status, 0, dryRun.stderr || dryRun.stdout);
    assert.match(dryRun.stdout, /DRY RUN: no model session started\./);
  });

  it("reports a controlled error when a command runner is unavailable", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-package-bin-"));
    temporaryRoots.add(root);
    const link = path.join(root, "piagent-install");
    fs.symlinkSync(path.join(repositoryRoot, "scripts", "piagent-cli.mjs"), link);
    const result = spawnSync(process.execPath, [link, "--help"], {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PATH: root
      },
      encoding: "utf8"
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not start bash \(ENOENT\)/);
    assert.doesNotMatch(result.stderr, /Unhandled 'error' event|node:events/);
  });

  it("does not create a project npmignore that re-includes local Pi runtime state", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-package-bin-"));
    temporaryRoots.add(root);
    fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ name: "package-fixture", version: "1.0.2" }, null, 2)}\n`);

    const initialized = spawnSync("bash", [
      path.join(repositoryRoot, "scripts", "init-project.sh"),
      root,
      "--profile", "generic",
      "--package-source", "git:github.com/Vt-mmm/piagent@v1.0.2",
      "--skip-agents",
      "--skip-review-guidelines"
    ], { cwd: repositoryRoot, encoding: "utf8" });
    assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
    assert.equal(fs.existsSync(path.join(root, ".pi", ".npmignore")), false);
    assert.equal(fs.existsSync(path.join(root, ".pi", "context-index.json")), true);
    assert.equal(fs.existsSync(path.join(root, ".pi", "tech-stack.json")), true);
    assert.equal(fs.existsSync(path.join(root, ".pi", "tech-context", "README.md")), true);

    const sensitivePaths = [
      ".pi/auth.json",
      ".pi/trust.json",
      ".pi/piagent-state/observed-bash.jsonl",
      ".pi/memory/state.sqlite"
    ];
    for (const relative of sensitivePaths) {
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "synthetic-sensitive-state\n");
    }

    const packed = spawnSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: root,
      encoding: "utf8"
    });
    assert.equal(packed.status, 0, packed.stderr);
    const files = new Set(JSON.parse(packed.stdout)[0].files.map((file) => file.path));
    for (const relative of sensitivePaths) assert.equal(files.has(relative), false, `${relative} must not be packed`);
  });
});
