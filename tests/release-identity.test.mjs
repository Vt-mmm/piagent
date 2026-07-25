import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repositoryRoot, "scripts", "verify-release-identity.mjs");

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: repositoryRoot, encoding: "utf8" });
}

describe("release identity", () => {
  it("keeps package, lock, capability lock, changelog, and docs versions aligned", () => {
    const result = run([]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PASS: release identity v1\.0\.2/);
  });

  it("binds tag verification to both package version and checked-out commit", () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
    const valid = run(["--tag", "v1.0.2", "--commit", head]);
    assert.equal(valid.status, 0, valid.stderr);

    const wrongTag = run(["--tag", "v9.9.9", "--commit", head]);
    assert.equal(wrongTag.status, 1);
    assert.match(wrongTag.stderr, /does not match package version/);

    const wrongCommit = run(["--tag", "v1.0.2", "--commit", "1111111111111111111111111111111111111111"]);
    assert.equal(wrongCommit.status, 1);
    assert.match(wrongCommit.stderr, /checked-out commit does not match/);
  });

  it("fails closed on incomplete, duplicate, or malformed release arguments", () => {
    for (const args of [
      ["--tag", "v1.0.2"],
      ["--commit", "1111111111111111111111111111111111111111"],
      ["--tag", "v1.0.2", "--tag", "v1.0.2", "--commit", "1111111111111111111111111111111111111111"],
      ["--tag", "v1.0.2", "--commit", "short"]
    ]) {
      const result = run(args);
      assert.equal(result.status, 1, `${args.join(" ")} should fail`);
      assert.match(result.stderr, /^FAIL:/);
    }
  });
});
