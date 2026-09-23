import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareProductionJourneyWorkspace, withJourneyEnvironment } from "./helpers/production-journey-workspace.mjs";
import { scriptedProductionSupervisor, scriptedText, scriptedTool } from "./helpers/scripted-production-supervisor.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
// This is a test-host qualification check, not scenario completion evidence.
// Exact generated package configuration must reach the real SDK resource loader.
for (const id of ["schema-migration", "invoice-rounding", "unicode-search", "cli-double-dash", "repository-prompt-injection"]) {
  test(`generated project packages reach the actual journey host: ${id}`, { timeout: 90000 }, async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "piagent-journey-packages-")));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const prepared = await prepareProductionJourneyWorkspace(root, repositoryRoot, id);
    const settingsPath = path.join(prepared.workspace, ".pi/settings.json");
    const originalSettings = fs.readFileSync(settingsPath, "utf8"), settings = JSON.parse(originalSettings);
    assert.ok(settings.packages.length > 0);
    await withJourneyEnvironment(prepared.environment, async () => {
      assert.equal(process.env.PIAGENT_INDEPENDENT_VERIFICATION_CONFIG, undefined);
      const runtime = await scriptedProductionSupervisor({ root, cwd: prepared.workspace,
        agentDir: prepared.agentDir, repositoryRoot, transport: "loopback" });
      try {
        const result = await runtime.turn(prepared.turns[0], [
          scriptedTool("packages-read", "read", { path: "package.json" }),
          scriptedText("Inspected the project configuration only. No implementation or completed task is claimed.")
        ]);
        t.diagnostic(JSON.stringify({ scenario: id, profile: prepared.scenario.profile,
          generatedPackages: settings.packages, loadedResources: runtime.projectResources,
          metrics: runtime.metrics, taskOutcome: result.task?.trace.outcome,
          transport: runtime.transport.snapshot(), completionEvidence: false }));
        assert.equal(result.wireSettlement.kind, "operation.settled");
        assert.equal(runtime.metrics.realProviderCalls, 0);
        assert.deepEqual(runtime.extensionErrors, []); assert.deepEqual(runtime.serviceErrors, []);
        assert.equal(runtime.projectResources.length, 1);
        assert.deepEqual(runtime.projectResources[0].packages, settings.packages,
          "the journey test host must load the generated project packages, not a guard-only facade");
        for (const entry of ["packages/piagent-core/extensions/piagent-guard.ts", "packages/piagent-webui/extension/piagent-webui.ts"]) {
          assert.ok(runtime.projectResources[0].extensions.includes(path.join(repositoryRoot, entry)),
            `the generated package must load its actual extension: ${entry}`);
        }
        assert.equal(fs.readFileSync(settingsPath, "utf8"), originalSettings,
          "qualification must not activate or rewrite project settings");
      } finally { await runtime.close(); }
    });
  });
}
