import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { appendContextTelemetry } from "../packages/piagent-core/extensions/context-engine.js";
import { resolveLocalStatePath } from "../packages/piagent-core/extensions/local-state-path.js";
import { appendJsonlBounded, pruneCaptureFiles } from "../packages/piagent-core/extensions/state-retention.js";
import { taskStateMigrationStatus, writeTaskContract } from "../packages/piagent-core/extensions/task-state.js";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("refuses every local-state writer when .pi traverses a symbolic link", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-state-boundary-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const outside = path.join(root, "outside");
  fs.mkdirSync(project);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(project, ".pi"), "dir");
  const target = path.join(project, ".pi", "piagent-state", "events.jsonl");

  assert.throws(
    () => resolveLocalStatePath(project, target, { label: "Fixture state" }),
    /must not traverse a symbolic link/
  );
  assert.throws(
    () => appendJsonlBounded(target, { event: "test" }, { maxBytes: 1024, projectRoot: project }),
    /must not traverse a symbolic link/
  );
  assert.throws(
    () => appendContextTelemetry(project, { event: "test" }),
    /must not traverse a symbolic link/
  );
  assert.throws(
    () => pruneCaptureFiles(path.join(project, ".pi", "piagent-state", "tool-results"), { projectRoot: project }),
    /must not traverse a symbolic link/
  );

  const contract = JSON.parse(fs.readFileSync(path.join(repoRoot, "evals", "fixtures", "task-contract.valid.json"), "utf8"));
  assert.throws(() => writeTaskContract(project, contract), /must not traverse a symbolic link/);
  assert.match(taskStateMigrationStatus(project).unreadable.join("; "), /must not traverse a symbolic link/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("allows local state when the project root itself is reached through a symlink", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-state-root-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "actual-project");
  const alias = path.join(root, "project-alias");
  fs.mkdirSync(project);
  fs.symlinkSync(project, alias, "dir");
  const target = path.join(alias, ".pi", "piagent-state", "events.jsonl");

  appendJsonlBounded(target, { event: "test" }, { maxBytes: 1024, projectRoot: alias });
  const actual = path.join(project, ".pi", "piagent-state", "events.jsonl");
  assert.equal(fs.existsSync(actual), true);
  assert.equal(JSON.parse(fs.readFileSync(actual, "utf8")).event, "test");
});
