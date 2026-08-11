import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts/ie6-release-freeze.mjs");

test("reports a valid provider-closed IE6 freeze plan without writing evidence", () => {
  const result = spawnSync(process.execPath, [script, "--check"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "valid-provider-closed");
  assert.equal(report.expectedPackageVersion, "1.3.0-ie.2");
  assert.equal(report.totalSessions, 108);
  assert.equal(report.chunks, 18);
  assert.equal(report.sessionsPerChunk, 6);
  assert.equal(report.providerSessionsStarted, 0);
  assert.equal(report.providerExecutionAuthorized, false);
  assert.equal(report.prerequisiteBlockers.includes("platform:linux-x64"), true);
});

test("fails closed on missing output, mixed check/output and unknown options", () => {
  for (const args of [[], ["--check", "--output", "/tmp/forbidden"], ["--unknown"]]) {
    const result = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^FAIL:/);
  }
});

test("contains no external release mutation command", () => {
  const source = fs.readFileSync(script, "utf8");
  assert.doesNotMatch(source, /npm["'],\s*\[[^\]]*["']publish|git["'],\s*\[[^\]]*["'](?:tag|push)|vercel["']/);
  assert.match(source, /providerExecution: false/);
  assert.match(source, /O_EXCL/);
  assert.match(source, /Object\.fromEntries\(protocol\.prerequisites\.local/);
  assert.match(source, /platforms: \{ \[`\$\{process\.platform\}-\$\{process\.arch\}`\]: true \}/);
  assert.doesNotMatch(source, /blockers: emptyPrerequisites\.blockers/);
});
