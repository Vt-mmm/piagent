import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts", "migrate-project-state.mjs");

function makeLegacyProject(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-migrate-"));
  fs.mkdirSync(path.join(root, ".pi", "company-state"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".pi", "company-profile.json"),
    JSON.stringify({ schemaVersion: 1, projectId: "legacy", protectedPaths: [".pi/company-state/**", ".pi/company-profile.json"] })
  );
  fs.writeFileSync(path.join(root, ".pi", "company-profile.lock.json"), JSON.stringify({ core: { packageSource: "../" } }));
  fs.writeFileSync(path.join(root, ".pi", "company-state", "task.json"), JSON.stringify({ task: "x" }));
  fs.writeFileSync(path.join(root, "AGENTS.md"), "Use `company_context` then `company_task_start`.\nSee .pi/company-profile.json\n");
  for (const [rel, contents] of Object.entries(overrides)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), contents);
  }
  return root;
}

function run(root, ...args) {
  const stdout = execFileSync(process.execPath, [scriptPath, root, ...args], { encoding: "utf8" });
  return JSON.parse(stdout);
}

describe("project state migration", () => {
  it("defaults to a dry run that changes nothing", () => {
    const root = makeLegacyProject();
    const result = run(root);
    assert.equal(result.dryRun, true);
    assert.equal(result.wouldRename.length, 3);
    assert.deepEqual(result.wouldRewrite, ["AGENTS.md"]);
    assert.ok(fs.existsSync(path.join(root, ".pi", "company-profile.json")));
    assert.ok(!fs.existsSync(path.join(root, ".pi", "piagent-profile.json")));
  });

  it("rewrites namespaced identifiers inside migrated content", () => {
    const root = makeLegacyProject();
    run(root, "--apply");
    const profile = JSON.parse(fs.readFileSync(path.join(root, ".pi", "piagent-profile.json"), "utf8"));
    assert.deepEqual(profile.protectedPaths, [".pi/piagent-state/**", ".pi/piagent-profile.json"]);
    const agents = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
    assert.match(agents, /piagent_context/);
    assert.match(agents, /piagent_task_start/);
    assert.doesNotMatch(agents, /company/);
  });

  it("keeps the originals until cleanup is explicitly requested", () => {
    const root = makeLegacyProject();
    const result = run(root, "--apply");
    assert.deepEqual(result.removedOld, []);
    assert.ok(fs.existsSync(path.join(root, ".pi", "company-profile.json")));
    assert.ok(fs.existsSync(path.join(root, ".pi", "piagent-profile.json")));
    assert.match(result.next, /--remove-old/);
  });

  it("completes the two-step workflow when cleanup runs as a separate pass", () => {
    const root = makeLegacyProject();
    run(root, "--apply");
    const cleanup = run(root, "--apply", "--remove-old");
    assert.equal(cleanup.removedOld.length, 3);
    assert.ok(!fs.existsSync(path.join(root, ".pi", "company-profile.json")));
    assert.ok(!fs.existsSync(path.join(root, ".pi", "company-state")));
    assert.ok(fs.existsSync(path.join(root, ".pi", "piagent-state", "task.json")));
  });

  it("reports an already-current project without touching it", () => {
    const root = makeLegacyProject();
    run(root, "--apply", "--remove-old");
    const before = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
    const result = run(root);
    assert.equal(result.migrated, false);
    assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), before);
  });

  it("updates only the managed AGENTS block and preserves project instructions", () => {
    const root = makeLegacyProject();
    run(root, "--apply", "--remove-old");
    fs.writeFileSync(path.join(root, "AGENTS.md"), [
      "# Project instructions",
      "",
      "Keep this team-specific preface.",
      "<!-- piagent-managed:start -->",
      "## Operating model",
      "Old managed checklist.",
      "<!-- piagent-managed:end -->",
      "",
      "## Team rule",
      "Never replace this line.",
      ""
    ].join("\n"));

    const preview = run(root);
    assert.deepEqual(preview.wouldRewrite, ["AGENTS.md"]);
    run(root, "--apply");
    const agents = fs.readFileSync(path.join(root, "AGENTS.md"), "utf8");
    assert.match(agents, /piagent_task_start` exactly once/);
    assert.match(agents, /Keep this team-specific preface/);
    assert.match(agents, /Never replace this line/);
    assert.doesNotMatch(agents, /Old managed checklist/);
    assert.equal(run(root).migrated, false);
  });

  it("upgrades the exact generated v1.2.10 instructions without requiring markers", () => {
    const root = makeLegacyProject();
    run(root, "--apply", "--remove-old");
    fs.copyFileSync(
      path.join(repoRoot, "tests", "fixtures", "AGENTS.v1.2.10.md"),
      path.join(root, "AGENTS.md")
    );

    assert.deepEqual(run(root).wouldRewrite, ["AGENTS.md"]);
    run(root, "--apply");
    assert.equal(
      fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"),
      fs.readFileSync(path.join(repoRoot, "templates", "project", "AGENTS.md"), "utf8")
    );
  });

  it("migrates nested state directories", () => {
    const root = makeLegacyProject({ ".pi/company-state/traces/one.jsonl": '{"tool":"company_task_start"}\n' });
    run(root, "--apply", "--remove-old");
    const trace = fs.readFileSync(path.join(root, ".pi", "piagent-state", "traces", "one.jsonl"), "utf8");
    assert.match(trace, /piagent_task_start/);
  });

  it("refuses to delete originals without an explicit apply", () => {
    const root = makeLegacyProject();
    assert.throws(
      () => execFileSync(process.execPath, [scriptPath, root, "--remove-old"], { encoding: "utf8", stdio: "pipe" }),
      /--remove-old requires --apply/
    );
    assert.ok(fs.existsSync(path.join(root, ".pi", "company-profile.json")));
  });

  it("does not follow symlinks out of the project", () => {
    const root = makeLegacyProject();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-outside-"));
    fs.writeFileSync(path.join(outside, "secret.json"), '{"token":"real"}');
    fs.rmSync(path.join(root, ".pi", "company-state"), { recursive: true, force: true });
    fs.symlinkSync(outside, path.join(root, ".pi", "company-state"));
    const result = run(root, "--apply");
    assert.deepEqual(result.skipped, [{ path: ".pi/company-state", reason: "symlink" }]);
    assert.ok(!fs.existsSync(path.join(root, ".pi", "piagent-state", "secret.json")));
  });

  it("previews and applies task-contract v2 migration on an otherwise current project", () => {
    const root = makeLegacyProject();
    run(root, "--apply", "--remove-old");
    const tasks = path.join(root, ".pi", "piagent-state", "tasks");
    fs.mkdirSync(tasks, { recursive: true });
    fs.writeFileSync(path.join(tasks, "ticket-9.json"), `${JSON.stringify({
      taskId: "TICKET-9",
      summary: "Migrate the existing task evidence safely",
      riskLane: "normal",
      expectedOutput: "A v2 task contract is written.",
      acceptanceCriteria: ["Migration is durable"],
      scope: ["src/**"],
      outOfScope: [],
      protectedPaths: [],
      requiredContext: [],
      contextManifest: [],
      memoryCitations: [],
      mcpCapabilities: [],
      verifyCommands: ["npm test"],
      workPlan: [],
      reviewLenses: [],
      changedFiles: [],
      verifyEvidence: [],
      trace: { outcome: "pending" },
      createdAt: "2026-07-30T01:00:00.000Z",
      updatedAt: "2026-07-30T01:00:00.000Z"
    })}\n`);

    const preview = run(root);
    assert.equal(preview.dryRun, true);
    assert.equal(preview.wouldMigrateTaskContracts, 1);
    const applied = run(root, "--apply");
    assert.equal(applied.taskMigration.migrated, 1);
    const current = fs.readdirSync(tasks).filter((name) => name.endsWith(".json"));
    const migrated = JSON.parse(fs.readFileSync(path.join(tasks, current[0]), "utf8"));
    assert.equal(migrated.schemaVersion, 2);
    assert.equal(migrated.sessionId, "legacy");
    assert.ok(fs.existsSync(path.join(root, ".pi", "piagent-state", "migrations.json")));
  });
});
