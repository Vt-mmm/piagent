import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { after, describe, it } from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const script = path.join(repositoryRoot, "scripts", "pi-auto.sh");
const temporaryRoots = new Set();

after(() => {
  for (const root of temporaryRoots) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("piagent-auto-test-")) continue;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function runAuto(argv) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-auto-test-"));
  temporaryRoots.add(root);
  const fakePi = path.join(root, "pi");
  fs.writeFileSync(fakePi, [
    "#!/bin/sh",
    "printf 'PROFILE=%s\\n' \"$PIAGENT_PERMISSION_PROFILE\"",
    "for value in \"$@\"; do printf 'ARG=%s\\n' \"$value\"; done",
    ""
  ].join("\n"));
  fs.chmodSync(fakePi, 0o755);
  const result = spawnSync("bash", [script, ...argv], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, PATH: `${root}${path.delimiter}/usr/bin${path.delimiter}/bin` }
  });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n");
  return {
    profile: lines.find((line) => line.startsWith("PROFILE="))?.slice("PROFILE=".length),
    args: lines.filter((line) => line.startsWith("ARG=")).map((line) => line.slice("ARG=".length))
  };
}

describe("piagent-auto read-only tool surface", () => {
  it("enables Pi's complete non-mutating discovery surface", () => {
    const result = runAuto(["--read-only", "-p", "Scout the repository"]);
    assert.equal(result.profile, "read-only");
    assert.deepEqual(result.args, [
      "--approve",
      "--tools",
      "read,grep,find,ls",
      "-p",
      "Scout the repository"
    ]);
    assert.equal(result.args.includes("--exclude-tools"), false);
  });

  it("keeps explicit caller tool options after the safe default", () => {
    const result = runAuto(["--read-only", "--", "--tools", "read,grep", "--exclude-tools", "grep", "--no-tools"]);
    assert.deepEqual(result.args, [
      "--approve",
      "--tools",
      "read,grep,find,ls",
      "--tools",
      "read,grep",
      "--exclude-tools",
      "grep",
      "--no-tools"
    ]);
  });

  it("does not narrow writable profiles at the CLI layer", () => {
    const result = runAuto(["--workspace-write", "--no-approve", "--tools", "read,bash"]);
    assert.equal(result.profile, "workspace-write");
    assert.deepEqual(result.args, ["--no-approve", "--tools", "read,bash"]);
  });
});
