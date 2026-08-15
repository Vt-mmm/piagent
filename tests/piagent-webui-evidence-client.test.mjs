import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { compactNumber, contextLabel, incompleteReason, usageLabel, verifierSummary } from "../packages/piagent-webui/client/src/evidence-view-model.ts";

const root = path.resolve(import.meta.dirname, "..");
const fixture = JSON.parse(fs.readFileSync(path.join(root, "evals/fixtures/piagent-webui/snapshot-v1.valid.json"), "utf8"));
const verifier = {
  attemptRef: "attempt.1", command: "npm test", commandDigest: "sha256:test", exact: true, state: "passed", exitCode: 0, exitCodeExact: true,
  treeDigest: "sha256:tree", startedAt: "2026-08-13T09:00:00.000Z", finishedAt: "2026-08-13T09:01:00.000Z",
  staleByFileRefs: [], staleByPaths: [], staleFilesKnown: true
};

describe("Piagent WebUI completion evidence", () => {
  it("never estimates unknown token or continuation values", () => {
    assert.equal(compactNumber(null), "Không có dữ liệu");
    assert.equal(compactNumber(12500), "13k");
    assert.equal(contextLabel(fixture.usage.context), "1.0k / 200k · 0.5%");
    assert.equal(usageLabel(fixture.usage.sessionTotal), "Không có dữ liệu");
  });

  it("shows exact verifier results and names stale-file uncertainty", () => {
    assert.equal(verifierSummary(verifier), "Pass · exit 0");
    assert.equal(verifierSummary({ ...verifier, state: "failed", exitCode: 2 }), "Fail · exit 2");
    assert.equal(verifierSummary({ ...verifier, state: "stale", staleFilesKnown: false }), "Stale · file chưa xác định");
    assert.equal(verifierSummary(null), "Chưa có verifier gần nhất");
  });

  it("prioritizes the task blocker and renders handoff/evidence as text", () => {
    const snapshot = structuredClone(fixture);
    snapshot.task = { blocker: "Waiting for approval", reasonCode: "approval-required" };
    assert.equal(incompleteReason(snapshot), "Waiting for approval");
    const panel = fs.readFileSync(path.join(root, "packages/piagent-webui/client/src/EvidencePanels.tsx"), "utf8");
    assert.match(panel, /Continuation budget/);
    assert.match(panel, /File làm stale/);
    assert.match(panel, /Bước an toàn tiếp theo/);
    assert.match(panel, /role="progressbar"/);
    assert.doesNotMatch(panel, /dangerouslySetInnerHTML|estimate/i);
  });
});
