import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MAX_VERIFY_COMMAND_BYTES,
  MAX_VERIFY_COMMAND_CHARS,
  MAX_VERIFY_COMMAND_TOTAL_BYTES,
  selectVerificationPlan,
  utf8ByteLength
} from "../packages/piagent-core/extensions/verification-intelligence.js";

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

function utf8BoundaryCommand(prefix, glyph) {
  const remaining = MAX_VERIFY_COMMAND_BYTES - Buffer.byteLength(prefix, "utf8");
  const glyphBytes = Buffer.byteLength(glyph, "utf8");
  const repeated = glyph.repeat(Math.floor(remaining / glyphBytes));
  return `${prefix}${repeated}${"x".repeat(remaining - Buffer.byteLength(repeated, "utf8"))}`;
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
  for (const name of ["node-typescript", "fullstack", "backend-api", "be-readonly-fe", "web-frontend"]) {
    const cwd = fixture();
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }));
    const group = name === "be-readonly-fe" ? "frontendSource" : "source";
    const commands = profile(name).verifyCommands[group];
    assert.equal(commands.length, 1, `${name}.${group} must record one composite verifier result`);
    const command = commands[0];
    const result = run(command, cwd);
    assert.equal(result.status, 0, `${name} did not run its configured test: ${result.stderr || result.stdout}`);
  }
});

test("web frontend narrows its fail-closed source verifier to scripts the project declares", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  assert.deepEqual(
    selectVerificationPlan(profile("web-frontend"), undefined, "source-change", cwd, ["src/stream.js"]),
    { group: "source", commands: ["npm test"] }
  );
});

test("task intake rejects verifier plans that cannot be injected exactly within the runtime cap", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const oversized = selectVerificationPlan({ verifyCommands: { source: [`node --test ${"test/fixture.mjs ".repeat(300)}`] } }, undefined, "source-change", cwd, ["src/value.js"]);
  assert.match(oversized.error, new RegExp(`exceeds ${MAX_VERIFY_COMMAND_CHARS} characters`));
  assert.match(oversized.error, /checked-in script/);

  assert.equal(MAX_VERIFY_COMMAND_TOTAL_BYTES, MAX_VERIFY_COMMAND_BYTES * 2);
  const valid = "x".repeat(MAX_VERIFY_COMMAND_BYTES - "node --test ".length);
  const secondValid = "y".repeat(MAX_VERIFY_COMMAND_BYTES - "npm test -- ".length);
  assert.deepEqual(
    selectVerificationPlan({ verifyCommands: { source: [`node --test ${valid}`, `npm test -- ${secondValid}`] } }, undefined, "source-change", cwd, ["src/value.js"]),
    { group: "source", commands: [`node --test ${valid}`, `npm test -- ${secondValid}`] }
  );
  const multiline = selectVerificationPlan({ verifyCommands: { source: ["npm test\nnpm run lint"] } }, undefined, "source-change", cwd, ["src/value.js"]);
  assert.match(multiline.error, /single-line values without CR or LF/);
  for (const [name, unicodeBoundary] of [
    ["Vietnamese", utf8BoundaryCommand("node -e 'process.exit(0)' # ", "ế")],
    ["emoji", utf8BoundaryCommand("node -e 'process.exit(0)' # ", "🧪")]
  ]) {
    assert.equal(utf8ByteLength(unicodeBoundary), MAX_VERIFY_COMMAND_BYTES, name);
    assert.deepEqual(
      selectVerificationPlan({ verifyCommands: { source: [unicodeBoundary] } }, undefined, "source-change", cwd, ["src/value.js"]),
      { group: "source", commands: [unicodeBoundary] },
      name
    );
    const overflow = selectVerificationPlan({ verifyCommands: { source: [`${unicodeBoundary}x`] } }, undefined, "source-change", cwd, ["src/value.js"]);
    assert.match(overflow.error, new RegExp(`exceeds ${MAX_VERIFY_COMMAND_BYTES} UTF-8 bytes`), name);
  }
  const schemaDefense = "🧪".repeat(MAX_VERIFY_COMMAND_CHARS);
  assert.match(
    selectVerificationPlan({ verifyCommands: { source: [schemaDefense] } }, undefined, "source-change", cwd, ["src/value.js"]).error,
    /exceeds 900 UTF-8 bytes/
  );
  const byteExact = "  node -e 'process.exit(0)'  ";
  assert.deepEqual(
    selectVerificationPlan({ verifyCommands: { source: [byteExact] } }, undefined, "source-change", cwd, ["src/value.js"]),
    { group: "source", commands: [byteExact] }
  );
});

test("Node-family source verification keeps declared scripts in one ordered fail-fast command", (t) => {
  const cwd = fixture();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({
    scripts: {
      "type-check": "node -e \"require('fs').appendFileSync('verify.log','type\\n')\"",
      lint: "node -e \"require('fs').appendFileSync('verify.log','lint\\n')\"",
      test: "node -e \"require('fs').appendFileSync('verify.log','test\\n')\""
    }
  }));
  const plan = selectVerificationPlan(profile("node-typescript"), undefined, "source-change", cwd, ["src/value.js"]);
  assert.deepEqual(plan, {
    group: "source",
    commands: ["npm run type-check && npm run lint && npm test"]
  });
  const result = run(plan.commands[0], cwd);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(fs.readFileSync(path.join(cwd, "verify.log"), "utf8"), "type\nlint\ntest\n");

  fs.rmSync(path.join(cwd, "verify.log"));
  fs.writeFileSync(path.join(cwd, "package.json"), JSON.stringify({
    scripts: {
      "type-check": "node -e \"require('fs').appendFileSync('verify.log','type\\n')\"",
      lint: "node -e \"require('fs').appendFileSync('verify.log','lint\\n');process.exit(7)\"",
      test: "node -e \"require('fs').appendFileSync('verify.log','test\\n')\""
    }
  }));
  const failed = run(plan.commands[0], cwd);
  assert.equal(failed.status, 7);
  assert.equal(fs.readFileSync(path.join(cwd, "verify.log"), "utf8"), "type\nlint\n");
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
