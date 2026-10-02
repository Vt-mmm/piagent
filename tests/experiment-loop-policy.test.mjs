import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { experimentLoopDecision } from "../packages/piagent-core/extensions/experiment-loop-policy.ts";

function repository() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "experiment-loop-")));
  const cwd = path.join(root, "app"); fs.mkdirSync(cwd);
  const git = (...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", ...args], { stdio: "ignore" });
  git("init", "-q", "-b", "main"); fs.writeFileSync(path.join(cwd, "a.txt"), "a\n"); git("add", "-A"); git("commit", "-qm", "init");
  return { root, cwd, git };
}

test("a linked worktree may run the loop on any branch; the main checkout may not", (t) => {
  const { root, cwd, git } = repository(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const worktree = path.join(root, "app-experiment");
  git("worktree", "add", "-q", "-b", "experiments", worktree);
  assert.equal(experimentLoopDecision(worktree, "log_experiment"), undefined);
  assert.equal(experimentLoopDecision(worktree, "init_experiment"), undefined);
  assert.match(experimentLoopDecision(cwd, "log_experiment").reason, /branch main/);
  // Tools of other packages are not this policy's business.
  assert.equal(experimentLoopDecision(cwd, "bash"), undefined);
});

test("a detached checkout, a folder outside git and a moved working directory are refused", (t) => {
  const { root, cwd, git } = repository(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git("checkout", "-q", "--detach");
  assert.match(experimentLoopDecision(cwd, "log_experiment").reason, /detached checkout/);
  const plain = path.join(root, "plain"); fs.mkdirSync(plain);
  assert.match(experimentLoopDecision(plain, "init_experiment").reason, /not a git repository/);
  // run_experiment is refused when the loop's config moves its commands elsewhere.
  fs.mkdirSync(path.join(cwd, ".auto"));
  fs.writeFileSync(path.join(cwd, ".auto", "config.json"), JSON.stringify({ workingDir: "/tmp" }));
  assert.match(experimentLoopDecision(cwd, "run_experiment").reason, /Start Pi in that folder/);
  fs.writeFileSync(path.join(cwd, ".auto", "config.json"), JSON.stringify({ workingDir: "." }));
  assert.equal(experimentLoopDecision(cwd, "run_experiment"), undefined);
});
