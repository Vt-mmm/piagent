import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertJourneyAcceptance } from "./helpers/production-journey-acceptance-mode.mjs";

test("journey expectations distinguish enforced proof from diagnostic pending proof", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-journey-policy-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const policy = path.join(root, "packages/piagent-core/policies/base-policy.json");
  fs.mkdirSync(path.dirname(policy), { recursive: true });
  const task = status => ({ trace: { notes: status === "pending" ? "Diagnostic acceptance: 1 criteria remain unproved; no quality claim." : "" },
    acceptanceReceipt: { criteria: [{ status }] } });
  for (const mode of [undefined, "enforce", "unknown-mode"]) {
    fs.writeFileSync(policy, JSON.stringify({ finalGate: { acceptanceProofMode: mode } }));
    assert.throws(() => assertJourneyAcceptance(root, task("pending")));
    assert.doesNotThrow(() => assertJourneyAcceptance(root, task("satisfied")));
  }
  fs.writeFileSync(policy, JSON.stringify({ finalGate: { acceptanceProofMode: "diagnostic" } }));
  assert.doesNotThrow(() => assertJourneyAcceptance(root, task("pending")));
  assert.throws(() => assertJourneyAcceptance(root, { ...task("pending"), trace: { notes: "approved" } }));
  assert.doesNotThrow(() => assertJourneyAcceptance(root, task("satisfied")));
  assert.throws(() => assertJourneyAcceptance(root, { ...task("satisfied"), trace: task("pending").trace }));
});
