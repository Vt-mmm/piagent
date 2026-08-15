import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const governance = path.join(root, "governance/piagent-webui");
const evidence = JSON.parse(fs.readFileSync(path.join(governance, "webui0-gate-evidence.v1.json"), "utf8"));
const status = fs.readFileSync(path.join(governance, "STATUS.md"), "utf8");

function unique(records, label) {
  const ids = records.map((record) => record.id);
  assert.equal(new Set(ids).size, ids.length, `${label} IDs must be unique`);
}
function assertEvidenceFiles(records) {
  for (const record of records) {
    assert.ok(record.evidence.length > 0, `${record.id} needs evidence`);
    for (const relative of record.evidence) {
      const target = path.join(root, relative);
      assert.equal(fs.existsSync(target), true, `${record.id}: ${relative} missing`);
      assert.ok(fs.statSync(target).size > 0, `${record.id}: ${relative} empty`);
    }
  }
}

describe("WEBUI-0 gate audit evidence", () => {
  it("keeps every accepted work-item decision present", () => {
    for (let item = 1; item <= 11; item += 1) {
      const prefix = `WUI0-${String(item).padStart(2, "0")}-`;
      const file = fs.readdirSync(path.join(governance, "decisions")).find((candidate) => candidate.startsWith(prefix));
      assert.ok(file, prefix);
      assert.match(fs.readFileSync(path.join(governance, "decisions", file), "utf8"), /^status: accepted$/m, file);
    }
  });

  it("maps every deliverable, fixture and exit gate to nonempty current-tree evidence", () => {
    assert.equal(evidence.version, "piagent-webui0-gate-evidence-v1");
    assert.equal(evidence.implementationVerdict, "pass");
    assert.equal(evidence.openP0, 0); assert.equal(evidence.openP1, 0);
    assert.equal(evidence.deliverables.length, 12);
    assert.equal(evidence.fixtures.length, 8);
    assert.equal(evidence.exitGates.length, 9);
    for (const records of [evidence.deliverables, evidence.fixtures, evidence.exitGates, evidence.closedFindings]) {
      unique(records, "audit"); assertEvidenceFiles(records);
    }
  });

  it("covers the complete Git status, content, repository and race fixture matrix", () => {
    const coverage = new Set(evidence.fixtures.flatMap((fixture) => fixture.covers));
    for (const required of ["A", "M", "D", "R", "U", "C", "rename", "edited-hunks", "staged", "unstaged", "mixed", "binary",
      "symlink", "submodule", "oversized", "spaces", "unicode", "newline", "unborn-head", "detached-head", "no-git", "nested-root",
      "multiple-roots", "pre-existing-dirty", "post-baseline-mutation", "baseline-restore", "concurrent-human-edit", "git-diff-race"]) {
      assert.ok(coverage.has(required), required);
    }
  });

  it("records independent acceptance before advancing beyond WEBUI-0", () => {
    assert.equal(evidence.independentSignoff, "accepted");
    assert.deepEqual({ verdict: evidence.independentReview.verdict, openP0: evidence.independentReview.openP0,
      openP1: evidence.independentReview.openP1, mutation: evidence.independentReview.repositoryMutation },
    { verdict: "accepted", openP0: 0, openP1: 0, mutation: "none" });
    assert.match(status, /\| `WUI0-12` \| `complete` \|/);
    assert.match(status, /\| Current milestone \| `WEBUI-(?:[1-4](?: complete)?|5 Session Hub)` \|/);
    assert.ok(evidence.knownDownstreamGates.some((gate) => /independent/i.test(gate)));
  });
});
