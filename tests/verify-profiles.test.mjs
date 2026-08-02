import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

function profile(name) {
  return JSON.parse(fs.readFileSync(path.join(repositoryRoot, "adapters", name, "profile.json"), "utf8"));
}

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-verify-profile-"));
  execFileSync("git", ["init", "-q", cwd]);
  return cwd;
}

function run(command, cwd) {
  return spawnSync(command, { cwd, shell: true, encoding: "utf8", env: process.env });
}

function runWithEnv(command, cwd, env) {
  return spawnSync(command, { cwd, shell: true, encoding: "utf8", env: { ...process.env, ...env } });
}

test("default source verify plans fail closed when a project has no applicable verifier", (t) => {
  const groups = {
    generic: "source",
    "node-typescript": "source",
    fullstack: "source",
    "backend-api": "source",
    data: "source",
    mobile: "source",
    "be-readonly-fe": "frontendSource",
    devops: "source",
    "web-frontend": "source"
  };
  for (const [name, group] of Object.entries(groups)) {
    const cwd = fixture();
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    const commands = profile(name).verifyCommands[group];
    assert.ok(Array.isArray(commands) && commands.length > 0, `${name}.${group} must not be empty`);
    for (const command of commands) {
      const result = run(command, cwd);
      assert.notEqual(result.status, 0, `${name}.${group} falsely passed without a verifier: ${command}`);
    }
  }
});

test("Node-family defaults run configured checks and tolerate only missing optional siblings", (t) => {
  for (const name of ["node-typescript", "fullstack", "backend-api", "be-readonly-fe"]) {
    const cwd = fixture();
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }));
    const group = name === "be-readonly-fe" ? "frontendSource" : "source";
    const command = profile(name).verifyCommands[group][0];
    const result = run(command, cwd);
    assert.equal(result.status, 0, `${name} did not run its configured test: ${result.stderr || result.stdout}`);
  }
});

test("docs verification remains usable for a repository with explicit documentation", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, "README.md"), "# Docs\n");
  for (const command of profile("docs").verifyCommands.source) {
    const result = run(command, cwd);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
});

test("DevOps verification cannot hide one failing verifier behind another passing verifier", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const bin = path.join(cwd, "test-bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(cwd, "compose.yaml"), "services: {}\n");
  fs.mkdirSync(path.join(cwd, "terraform"));
  fs.writeFileSync(path.join(bin, "docker"), "#!/bin/sh\nexit 7\n", { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "terraform"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });

  const command = profile("devops").verifyCommands.source[0];
  const result = runWithEnv(command, cwd, { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  assert.equal(result.status, 7, `failing docker verification was masked: ${result.stderr || result.stdout}`);
});
