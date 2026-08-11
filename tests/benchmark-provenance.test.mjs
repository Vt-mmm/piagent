import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  benchmarkCandidateProvenance,
  candidateProvenanceMismatch,
  materializeBenchmarkCandidate,
  retainWorkspaceForensics,
  verifyBenchmarkCandidateProvenance
} from "../packages/piagent-core/benchmark/benchmark-forensics.js";
import { candidateProvenance } from "../packages/piagent-core/benchmark/benchmark-candidate.js";
import { assertBenchmarkModuleGraphBound } from "../packages/piagent-core/benchmark/benchmark-suite-assets.js";
import { createBenchmarkExecutionGuard } from "../packages/piagent-core/benchmark/benchmark-execution-guard.js";
import { benchmarkTreeIdentity } from "../packages/piagent-core/benchmark/benchmark-tree-identity.js";
import { workingTreeSnapshot } from "../packages/piagent-core/extensions/task-state.js";
import { workingTreeEvidenceDigest } from "../packages/piagent-core/extensions/working-tree-digest.js";

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function removeTree(root) {
  if (!fs.existsSync(root)) return;
  const pending = [root];
  while (pending.length) {
    const current = pending.pop();
    const stat = fs.lstatSync(current);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      try { fs.chmodSync(current, 0o700); } catch { /* Non-POSIX filesystem. */ }
      for (const name of fs.readdirSync(current)) pending.push(path.join(current, name));
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
}

function candidateRepository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-benchmark-candidate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "benchmark@piagent.local"]);
  git(root, ["config", "user.name", "Piagent Benchmark"]);
  fs.writeFileSync(path.join(root, ".gitignore"), "evidence-output/\n");
  fs.writeFileSync(path.join(root, "candidate.js"), "export const value = 1;\n");
  git(root, ["add", ".gitignore", "candidate.js"]);
  git(root, ["commit", "-qm", "candidate"]);
  return root;
}

test("candidate provenance is deterministic for clean and unchanged dirty trees and ignores excluded evidence", (t) => {
  const root = candidateRepository(t);
  const clean = benchmarkCandidateProvenance(root);
  assert.match(clean.contentDigest, /^[a-f0-9]{64}$/);
  assert.equal(clean.fileCount, 2);
  assert.deepEqual(benchmarkCandidateProvenance(root), clean);

  fs.writeFileSync(path.join(root, "candidate.js"), "export const value = 2;\n");
  const dirty = benchmarkCandidateProvenance(root);
  assert.notEqual(dirty.contentDigest, clean.contentDigest);
  assert.equal(dirty.fileCount, clean.fileCount);
  assert.deepEqual(benchmarkCandidateProvenance(root), dirty, "the same dirty content must freeze identically");

  fs.mkdirSync(path.join(root, "evidence-output"));
  fs.writeFileSync(path.join(root, "evidence-output", "runs.jsonl"), "measured evidence\n");
  assert.deepEqual(benchmarkCandidateProvenance(root), dirty, "Git-ignored benchmark output must not move the candidate");
});

test("candidate Git selection ignores inherited Git index and work-tree overrides", (t) => {
  const root = candidateRepository(t);
  const expected = benchmarkCandidateProvenance(root);
  const prior = { index: process.env.GIT_INDEX_FILE, workTree: process.env.GIT_WORK_TREE, directory: process.env.GIT_DIR };
  process.env.GIT_INDEX_FILE = path.join(root, "alternate-index");
  process.env.GIT_WORK_TREE = os.tmpdir();
  process.env.GIT_DIR = path.join(root, "missing-git-dir");
  try { assert.deepEqual(benchmarkCandidateProvenance(root), expected); }
  finally {
    for (const [key, value] of [["GIT_INDEX_FILE", prior.index], ["GIT_WORK_TREE", prior.workTree], ["GIT_DIR", prior.directory]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("candidate provenance detects mid-run content/count drift and resume/finalization mismatch", (t) => {
  const root = candidateRepository(t);
  const expected = benchmarkCandidateProvenance(root);
  assert.deepEqual(verifyBenchmarkCandidateProvenance(root, expected, "initial"), expected);

  fs.writeFileSync(path.join(root, "candidate.js"), "export const value = 3;\n");
  assert.throws(
    () => verifyBenchmarkCandidateProvenance(root, expected, "before-session:next"),
    (error) => {
      assert.equal(error.code, "BENCHMARK_CANDIDATE_PROVENANCE_MISMATCH");
      assert.equal(candidateProvenanceMismatch(error).stage, "before-session:next");
      assert.deepEqual(candidateProvenanceMismatch(error).mismatches, ["contentDigest"]);
      return true;
    }
  );

  fs.writeFileSync(path.join(root, "new-untracked.js"), "export const extra = true;\n");
  assert.throws(
    () => verifyBenchmarkCandidateProvenance(root, expected, "resume"),
    (error) => {
      assert.equal(candidateProvenanceMismatch(error).stage, "resume");
      assert.deepEqual(candidateProvenanceMismatch(error).mismatches, ["contentDigest", "fileCount"]);
      return true;
    }
  );

  assert.throws(
    () => verifyBenchmarkCandidateProvenance(root, { ...expected, contentDigest: "0".repeat(64) }, "finalization"),
    (error) => candidateProvenanceMismatch(error).stage === "finalization"
  );
});

test("candidate encoder is unambiguous for NUL-delimited content and binds executable mode", (t) => {
  const entry = (file, content) => ({ path: file, kind: "regular", mode: "100644", indexMode: "000000", payload: Buffer.from(content) });
  const left = candidateProvenance([entry("a", "x\0b"), entry("c", "y")]);
  const right = candidateProvenance([entry("a", "x"), entry("b", "c\0y")]);
  assert.notEqual(left.contentDigest, right.contentDigest);

  if (process.platform !== "win32") {
    const root = candidateRepository(t);
    const regular = benchmarkCandidateProvenance(root);
    fs.chmodSync(path.join(root, "candidate.js"), 0o755);
    assert.notEqual(benchmarkCandidateProvenance(root).contentDigest, regular.contentDigest);
  }
});

test("retained workspace privacy preserves measured project modes and working-tree evidence", (t) => {
  if (process.platform === "win32") return;
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-retained-workspace-"));
  t.after(() => fs.rmSync(runRoot, { recursive: true, force: true }));
  const workspaceRoot = path.join(runRoot, "workspaces", "case");
  const project = path.join(workspaceRoot, "project");
  fs.mkdirSync(project, { recursive: true });
  git(project, ["init", "-q"]);
  git(project, ["config", "user.email", "benchmark@piagent.local"]);
  git(project, ["config", "user.name", "Piagent Benchmark"]);
  fs.writeFileSync(path.join(project, "regular.js"), "export const value = 1;\n");
  fs.writeFileSync(path.join(project, "executable.sh"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(project, "regular.js"), 0o644);
  fs.chmodSync(path.join(project, "executable.sh"), 0o755);
  git(project, ["add", "."]);
  git(project, ["commit", "-qm", "fixture"]);
  fs.writeFileSync(path.join(project, "regular.js"), "export const value = 2;\n");
  fs.writeFileSync(path.join(project, "executable.sh"), "#!/bin/sh\nexit 1\n");
  const before = workingTreeEvidenceDigest(workingTreeSnapshot(project));
  const record = { scenarioId: "mode-proof", surface: "piagent", repeat: 1, infrastructureAttempt: 1, workflow: { checks: [{ id: "terminal-completion", passed: false }] } };
  retainWorkspaceForensics({ runRoot, workspaceRoot, key: "case", record });
  const after = workingTreeEvidenceDigest(workingTreeSnapshot(project));
  assert.equal(after, before);
  assert.equal(fs.statSync(path.join(project, "regular.js")).mode & 0o777, 0o644);
  assert.equal(fs.statSync(path.join(project, "executable.sh")).mode & 0o777, 0o755);
  assert.equal(fs.statSync(workspaceRoot).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(workspaceRoot, ".piagent-retain.json")).mode & 0o777, 0o600);
});

test("snapshot materializes internal symlinks, rejects unbound targets, and contains only bound nodes", (t) => {
  if (process.platform === "win32") return;
  const root = candidateRepository(t);
  fs.writeFileSync(path.join(root, "target.js"), "bound target\n");
  fs.symlinkSync("target.js", path.join(root, "link.js"));
  const snapshot = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-candidate-snapshot-"));
  t.after(() => removeTree(snapshot));
  const frozen = materializeBenchmarkCandidate(root, snapshot);
  assert.equal(fs.readlinkSync(path.join(snapshot, "link.js")), "target.js");
  assert.equal(fs.readFileSync(path.join(snapshot, "target.js"), "utf8"), "bound target\n");
  assert.deepEqual(frozen.provenance, benchmarkCandidateProvenance(root));

  fs.writeFileSync(path.join(root, "target.js"), "changed then reverted later\n");
  assert.equal(fs.readFileSync(path.join(snapshot, "target.js"), "utf8"), "bound target\n", "execution snapshot must not read later live-tree bytes");

  const external = candidateRepository(t);
  fs.symlinkSync(path.join(os.tmpdir(), "outside.js"), path.join(external, "external.js"));
  assert.throws(() => benchmarkCandidateProvenance(external), /symlink must be relative/);

  const ignored = candidateRepository(t);
  fs.mkdirSync(path.join(ignored, "evidence-output"));
  fs.writeFileSync(path.join(ignored, "evidence-output", "hidden.js"), "ignored\n");
  fs.symlinkSync("evidence-output/hidden.js", path.join(ignored, "ignored-link.js"));
  assert.throws(() => benchmarkCandidateProvenance(ignored), /target is ignored or absent/);

  const nonempty = candidateRepository(t);
  const destination = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-candidate-nonempty-"));
  t.after(() => fs.rmSync(destination, { recursive: true, force: true }));
  fs.writeFileSync(path.join(destination, "extra.txt"), "unbound\n");
  assert.throws(() => materializeBenchmarkCandidate(nonempty, destination), /snapshot tree mismatch/);
});

test("tracked tombstones and file-to-directory replacements snapshot deterministically", (t) => {
  const deleted = candidateRepository(t);
  fs.unlinkSync(path.join(deleted, "candidate.js"));
  const deletedProvenance = benchmarkCandidateProvenance(deleted);
  const deletedSnapshot = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-candidate-deleted-"));
  t.after(() => removeTree(deletedSnapshot));
  assert.doesNotThrow(() => materializeBenchmarkCandidate(deleted, deletedSnapshot));
  assert.equal(fs.existsSync(path.join(deletedSnapshot, "candidate.js")), false);
  assert.equal(deletedProvenance.fileCount, 2);

  const replaced = candidateRepository(t);
  fs.unlinkSync(path.join(replaced, "candidate.js"));
  fs.mkdirSync(path.join(replaced, "candidate.js"));
  fs.writeFileSync(path.join(replaced, "candidate.js", "child.txt"), "replacement\n");
  const replacementSnapshot = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-candidate-replaced-"));
  t.after(() => removeTree(replacementSnapshot));
  materializeBenchmarkCandidate(replaced, replacementSnapshot);
  assert.equal(fs.statSync(path.join(replacementSnapshot, "candidate.js")).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(replacementSnapshot, "candidate.js", "child.txt"), "utf8"), "replacement\n");
});

test("candidate snapshot rejects unsupported gitlinks explicitly", (t) => {
  const root = candidateRepository(t);
  const commit = git(root, ["rev-parse", "HEAD"]);
  git(root, ["update-index", "--add", "--cacheinfo", `160000,${commit},vendor/submodule`]);
  assert.throws(() => benchmarkCandidateProvenance(root), /unsupported gitlink: vendor\/submodule/);
});

test("suite static module graph rejects multiline bare imports and relative escapes", (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-suite-graph-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const suite = path.join(parent, "suite");
  fs.mkdirSync(suite);
  const entry = path.join(suite, "grade.mjs");
  const helper = path.join(suite, "helper.mjs");
  fs.writeFileSync(entry, 'import { grade }\n  from "./helper.mjs";\nexport { grade };\n');
  fs.writeFileSync(helper, 'import { value }\n  from "external-package";\nexport const grade = value;\n');
  assert.throws(() => assertBenchmarkModuleGraphBound(entry, suite, "grader"), /unbound external module/);

  fs.writeFileSync(helper, 'export { value as grade } from "../outside.mjs";\n');
  fs.writeFileSync(path.join(parent, "outside.mjs"), "export const value = 1;\n");
  assert.throws(() => assertBenchmarkModuleGraphBound(entry, suite, "grader"), /escapes the frozen suite root/);

  fs.writeFileSync(helper, 'import fs from "node:fs";\nexport const grade = Boolean(fs);\n');
  assert.doesNotThrow(() => assertBenchmarkModuleGraphBound(entry, suite, "grader"));
});

test("execution assets are checked again at the report prepublish boundary", (t) => {
  const suite = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-prepublish-suite-"));
  t.after(() => fs.rmSync(suite, { recursive: true, force: true }));
  const file = path.join(suite, "suite.json");
  fs.writeFileSync(file, "{}\n");
  const candidateGuard = { check: () => undefined, stamp: (stage) => ({ stage, matched: true }) };
  const guard = createBenchmarkExecutionGuard({ candidateGuard, suiteRoot: suite, suiteIdentity: benchmarkTreeIdentity(suite), commands: {} });
  assert.equal(guard.check("finalization"), undefined);
  fs.writeFileSync(file, '{"changed":true}\n');
  const error = guard.check("prepublish");
  assert.equal(error.code, "BENCHMARK_EXECUTION_ASSET_MISMATCH");
  assert.equal(error.executionAsset.stage, "prepublish");
});

test("an execution receipt preserves the first causal mismatch without observing twice", (t) => {
  const suite = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-single-receipt-suite-"));
  t.after(() => fs.rmSync(suite, { recursive: true, force: true }));
  fs.writeFileSync(path.join(suite, "suite.json"), "{}\n");
  let observations = 0;
  const firstError = Object.assign(new Error("first causal mismatch"), {
    code: "BENCHMARK_EXECUTION_ASSET_MISMATCH",
    executionAsset: {
      stage: "after-session",
      asset: "pi-agent-home",
      reason: "asset-identity-mismatch",
      piHomeMismatch: { classification: "unreleased-lock", entry: "auth.json.lock" }
    }
  });
  const candidateGuard = {
    receipt(stage) {
      observations += 1;
      return observations === 1
        ? { error: firstError, stamp: { stage, matched: false } }
        : { error: undefined, stamp: { stage, matched: true } };
    },
    check() { throw new Error("receipt must not fall back to a second check"); },
    stamp() { throw new Error("receipt must not fall back to a second stamp"); }
  };
  const guard = createBenchmarkExecutionGuard({ candidateGuard, suiteRoot: suite, suiteIdentity: benchmarkTreeIdentity(suite), commands: {} });
  const receipt = guard.receipt("after-session");
  assert.equal(observations, 1);
  assert.equal(receipt.error, firstError);
  assert.deepEqual(receipt.stamp.failure.piHomeMismatch, { classification: "unreleased-lock", entry: "auth.json.lock" });
});
