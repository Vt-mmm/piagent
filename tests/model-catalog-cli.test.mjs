import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, it } from "node:test";

import { parsePiModelTable } from "../scripts/model-catalog.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const roots = new Set();

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots.clear();
});

function fakePi() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-models-"));
  roots.add(root);
  fs.writeFileSync(path.join(root, "pi"), `#!/usr/bin/env bash
if [[ " $* " == *" --version "* ]]; then echo 0.82.0; exit 0; fi
printf '%s\\n' 'provider      model          context  max-out  thinking  images'
printf '%s\\n' 'openai-codex  z-model        272K     128K     yes       yes'
printf '%s\\n' 'openai-codex  a-model        128K     64K      no        no'
`, { mode: 0o755 });
  return root;
}

function initializedProject() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-model-project-"));
  roots.add(project);
  assert.equal(spawnSync("git", ["init", "-q", project], { encoding: "utf8" }).status, 0);
  const initialized = spawnSync("bash", ["scripts/init-project.sh", project, "--profile", "generic",
    "--package-source", repositoryRoot, "--skip-agents", "--skip-review-guidelines"], {
    cwd: repositoryRoot,
    encoding: "utf8"
  });
  assert.equal(initialized.status, 0, initialized.stderr || initialized.stdout);
  return project;
}

function run(args, extra = {}) {
  return spawnSync("/bin/bash", ["scripts/pi-model-catalog.sh", ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, ...extra }
  });
}

describe("piagent-models", () => {
  it("parses the authenticated Pi table deterministically", () => {
    const models = parsePiModelTable("provider      model    context  max-out  thinking  images\np  z        2M       8K       yes       no\np  a        128K     4K       no        yes\n");
    assert.deepEqual(models.map((model) => model.modelId), ["a", "z"]);
    assert.equal(models[1].contextWindow, 2_000_000);
  });

  it("emits versioned machine-readable authenticated output", () => {
    const bin = fakePi();
    const result = run(["--json", "--provider", "openai-codex"], { PATH: `${bin}:${process.env.PATH}` });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.source, "authenticated-catalog");
    assert.equal(report.availability, "authenticated");
    assert.equal(report.piHostVersion, "0.82.0");
    assert.deepEqual(report.models.map((model) => model.modelId), ["a-model", "z-model"]);
  });

  it("reports offline unknowns without invoking Pi", () => {
    const result = run(["--json", "--offline"], { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.availability, "offline");
    assert.equal(report.piHostVersion, null);
  });

  it("adds the same bounded unknown/provenance fields to offline doctor JSON", () => {
    const project = initializedProject();
    const result = spawnSync("bash", ["scripts/team-doctor.sh", project, "--json", "--offline"], {
      cwd: repositoryRoot,
      encoding: "utf8"
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.runtimeModel.schemaVersion, 1);
    assert.equal(report.runtimeModel.authenticatedCatalog.availability, "offline");
    assert.equal(report.runtimeModel.provider, null);
    assert.ok(report.runtimeModel.provenance.every((item) => item.source));
  });

  it("rejects malformed options without reading runtime state", () => {
    const result = run(["--provider", "--json"]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Missing value for/);
  });
});
