import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repositoryRoot, "scripts", "verify-release-identity.mjs");
// The script is run against this repository, not a fixture, so the tag under
// test is whatever this release is. Hardcoding it would fail every version bump
// for a reason that has nothing to do with release identity.
const releaseTag = `v${JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8")).version}`;

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: repositoryRoot, encoding: "utf8" });
}

describe("release identity", () => {
  it("keeps package, lock, capability lock, changelog, and docs versions aligned", () => {
    const result = run([]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), `PASS: release identity ${releaseTag}`);
  });

  it("binds tag verification to both package version and checked-out commit", () => {
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
    const valid = run(["--tag", releaseTag, "--commit", head]);
    assert.equal(valid.status, 0, valid.stderr);

    const wrongTag = run(["--tag", "v9.9.9", "--commit", head]);
    assert.equal(wrongTag.status, 1);
    assert.match(wrongTag.stderr, /does not match package version/);

    const wrongCommit = run(["--tag", releaseTag, "--commit", "1111111111111111111111111111111111111111"]);
    assert.equal(wrongCommit.status, 1);
    assert.match(wrongCommit.stderr, /checked-out commit does not match/);
  });

  it("fails closed on incomplete, duplicate, or malformed release arguments", () => {
    for (const args of [
      ["--tag", releaseTag],
      ["--commit", "1111111111111111111111111111111111111111"],
      ["--tag", releaseTag, "--tag", releaseTag, "--commit", "1111111111111111111111111111111111111111"],
      ["--tag", releaseTag, "--commit", "short"]
    ]) {
      const result = run(args);
      assert.equal(result.status, 1, `${args.join(" ")} should fail`);
      assert.match(result.stderr, /^FAIL:/);
    }
  });
});

describe("release history coverage", () => {
  // docs/publishing-for-teams.md carries the team-facing release history. It
  // stopped at 1.2.11 while the changelog went on to 1.4.0, because nothing
  // connected the two. Derive the expected versions from CHANGELOG.md so the
  // list cannot fall behind again. Prereleases are deliberately excluded: the
  // history is for teams choosing a stable pin.
  const changelog = fs.readFileSync(path.join(repositoryRoot, "CHANGELOG.md"), "utf8");
  const stableReleases = [...changelog.matchAll(/^## v(\d+\.\d+\.\d+) - /gm)].map(([, v]) => v);

  it("reads a plausible set of stable releases out of the changelog", () => {
    assert.ok(stableReleases.length >= 20, `only found ${stableReleases.length} stable releases`);
    assert.ok(stableReleases.includes(releaseTag.slice(1)), `${releaseTag} is missing from the changelog`);
  });

  it("lists every stable release from the point the history starts", () => {
    const history = fs.readFileSync(path.join(repositoryRoot, "docs/publishing-for-teams.md"), "utf8");
    const listed = [...history.matchAll(/^- `(\d+\.\d+\.\d+)`:/gm)].map(([, v]) => v);
    assert.ok(listed.length > 0, "the release history has no version entries");

    const order = (v) => v.split(".").map(Number).reduce((a, n) => a * 1000 + n, 0);
    // Pre-1.0.2 releases are summarised as a single `0.2.x` line on purpose;
    // the itemised history begins at whatever its own oldest entry is. Anything
    // released at or after that point has to be there.
    const floor = Math.min(...listed.map(order));
    const known = new Set(listed);
    const missing = stableReleases.filter((v) => order(v) >= floor && !known.has(v));
    assert.deepEqual(missing, [], `released but absent from the team history: ${missing.join(", ")}`);
  });
});
