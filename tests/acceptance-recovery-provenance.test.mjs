import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  acceptanceCriticalRecoveryProjection,
  acceptanceSemanticConflicts,
  acceptanceReceiptValidationErrors,
  applyAcceptanceRecoveryProvenance,
  buildAcceptanceReceipt,
  invalidateAcceptanceReceiptAfterMutation,
  refreshAcceptanceReceipt
} from "../packages/piagent-core/extensions/acceptance-receipt.js";
import {
  acceptanceExecutableTestBinding,
  acceptanceInvalidInputEvidence,
  sanitizeJavaScriptEvidence
} from "../packages/piagent-core/extensions/acceptance-contract-semantics.js";
import { classifyVerificationFailure } from "../packages/piagent-core/extensions/verification-intelligence.js";
import { allVerifyCommandsPassCurrentTree } from "../packages/piagent-core/extensions/task-contract-view.js";
import { taskContractValidationErrors } from "../packages/piagent-core/extensions/task-state.js";
import { versionWorkingTreeHash } from "../packages/piagent-core/extensions/working-tree-digest.js";
import { decideSemanticRepairHandshake } from "../packages/piagent-core/runtime/recovery/semantic-repair-handshake.ts";

const fixture = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "../evals/fixtures/task-contract.valid.json"), "utf8"));
const treeDigest = (value) => versionWorkingTreeHash(value.repeat(64));

function task(outcome = "completed") {
  const receipt = buildAcceptanceReceipt({
    summary: "Verify bounded recovery provenance for the acceptance receipt.",
    expectedOutput: "The runtime-observed receipt remains strict and does not alter acceptance truth.",
    acceptanceCriteria: ["The configured verifier passes on the current tree."],
    changeMode: "source-change",
    source: "runtime",
    generatedAt: "2026-08-08T00:00:00.000Z"
  }).receipt;
  return {
    ...structuredClone(fixture),
    acceptanceCriteria: ["The configured verifier passes on the current tree."],
    acceptanceReceipt: receipt,
    trace: { outcome, recordedAt: "2026-08-08T00:00:01.000Z" }
  };
}

const handoffRef = ".pi/piagent-state/handoffs/task-123-run-1.json";

describe("acceptance receipt recovery provenance", () => {
  it("requires current namespaced tree evidence for verifier and receipt proof", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-acceptance-digest-"));
    const currentDigest = treeDigest("a");
    const candidate = task("pending");
    candidate.verifyEvidence = [{
      command: candidate.verifyCommands[0], exitCode: 0, observed: true, matchedProfileCommand: true,
      recordedAt: "2026-08-08T00:00:01.000Z", preWorkingTreeDigest: currentDigest, workingTreeDigest: currentDigest
    }];
    assert.equal(allVerifyCommandsPassCurrentTree(candidate, currentDigest), true);
    assert.equal(allVerifyCommandsPassCurrentTree(candidate, "a".repeat(64)), false);
    const current = refreshAcceptanceReceipt(candidate, { cwd, changedFiles: [], currentWorkingTreeDigest: currentDigest });
    assert.equal(current.receipt.criteria[0].status, "satisfied");

    candidate.verifyEvidence.push({
      ...candidate.verifyEvidence[0], exitCode: 1,
      recordedAt: "2026-08-08T00:00:03.000Z", observedAt: "2026-08-08T00:00:03.000Z"
    });
    candidate.verifyEvidence.push({
      ...candidate.verifyEvidence[0], exitCode: 0,
      recordedAt: "2026-08-08T00:00:02.000Z", observedAt: "2026-08-08T00:00:02.000Z"
    });
    assert.equal(allVerifyCommandsPassCurrentTree(candidate, currentDigest), false);
    assert.equal(refreshAcceptanceReceipt(candidate, { cwd, changedFiles: [], currentWorkingTreeDigest: currentDigest }).receipt.criteria[0].status, "pending");
    candidate.verifyEvidence.push({
      ...candidate.verifyEvidence[0], exitCode: 0,
      recordedAt: "2026-08-08T00:00:04.000Z", observedAt: "2026-08-08T00:00:04.000Z"
    });
    assert.equal(allVerifyCommandsPassCurrentTree(candidate, currentDigest), true);
    assert.equal(refreshAcceptanceReceipt(candidate, { cwd, changedFiles: [], currentWorkingTreeDigest: currentDigest }).receipt.criteria[0].status, "satisfied");

    candidate.workingTreeDigestAlgorithm = "legacy-untrusted";
    assert.equal(allVerifyCommandsPassCurrentTree(candidate, currentDigest), false);
    const legacyRoot = refreshAcceptanceReceipt(candidate, { cwd, changedFiles: [], currentWorkingTreeDigest: currentDigest });
    assert.equal(legacyRoot.receipt.criteria[0].status, "pending");
    candidate.workingTreeDigestAlgorithm = "wt-content-v2";

    candidate.verifyEvidence = [{ ...candidate.verifyEvidence.at(-1), workingTreeDigest: "a".repeat(64) }];
    const legacy = refreshAcceptanceReceipt(candidate, { cwd, changedFiles: [], currentWorkingTreeDigest: "a".repeat(64) });
    assert.equal(legacy.receipt.criteria[0].status, "pending");
    const invalidReceipt = structuredClone(current.receipt);
    invalidReceipt.criteria[0].evidence[0].workingTreeDigest = "a".repeat(64);
    assert.match(acceptanceReceiptValidationErrors(invalidReceipt).join("; "), /workingTreeDigest is invalid/);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("distinguishes first-pass and repaired success without changing criterion truth", () => {
    const first = task();
    const originalCriteria = structuredClone(first.acceptanceReceipt.criteria);
    const firstPass = applyAcceptanceRecoveryProvenance(first, {
      outcome: "completed", gateDecision: "pass", handoffRef, recordedAt: "2026-08-08T00:00:02.000Z"
    });
    assert.equal(firstPass.acceptanceReceipt.provenance.assurance, "runtime-observed");
    assert.equal(firstPass.acceptanceReceipt.provenance.disposition, "first-pass-success");
    assert.equal(firstPass.acceptanceReceipt.provenance.finalRecoveryDisposition, "not-needed");
    assert.deepEqual(firstPass.acceptanceReceipt.criteria, originalCriteria);

    const classification = classifyVerificationFailure("SECRET_TOKEN=do-not-store TS2322", 2, { captureRef: "capture:verify-2" });
    const repaired = applyAcceptanceRecoveryProvenance(task(), {
      outcome: "completed",
      gateDecision: "pass",
      handoffRef,
      recordedAt: "2026-08-08T00:00:03.000Z",
      failureClassification: classification,
      recoveryDecision: { action: "repair", reasonCodes: ["source-repair-eligible"] },
      recoveryHistory: [{
        taskId: fixture.taskId, taskRunId: fixture.taskRunId, taskAttempt: 1,
        evidenceDigest: classification.evidenceDigest, failureCategory: classification.category,
        action: "repair", disposition: "scheduled", phase: "repair", hypothesisRef: null
      }]
    });
    assert.equal(repaired.acceptanceReceipt.provenance.disposition, "repaired-success");
    assert.equal(repaired.acceptanceReceipt.provenance.finalRecoveryDisposition, "succeeded");
    assert.equal(repaired.acceptanceReceipt.provenance.repairCount, 1);
    assert.equal(repaired.acceptanceReceipt.provenance.retryCount, 0);
    assert.equal(repaired.acceptanceReceipt.provenance.failureRef.evidenceDigest, classification.evidenceDigest);
    assert.equal(repaired.acceptanceReceipt.provenance.recoveryRef.action, "repair");
    assert.equal(JSON.stringify(repaired).includes("do-not-store"), false);
    assert.deepEqual(acceptanceReceiptValidationErrors(repaired.acceptanceReceipt), []);
    assert.deepEqual(taskContractValidationErrors(repaired), []);
  });

  it("labels blocked, partial, and failed terminal receipts accurately", () => {
    for (const outcome of ["blocked", "partial", "failed"]) {
      const projected = applyAcceptanceRecoveryProvenance(task(outcome), {
        outcome, gateDecision: "fail", handoffRef, recordedAt: "2026-08-08T00:00:04.000Z"
      });
      assert.equal(projected.acceptanceReceipt.provenance.disposition, outcome);
      assert.equal(projected.acceptanceReceipt.provenance.finalRecoveryDisposition, outcome);
      assert.deepEqual(acceptanceReceiptValidationErrors(projected.acceptanceReceipt), []);
    }
  });

  it("treats a failed final gate as blocked and rejects unbounded provenance fields", () => {
    const projected = applyAcceptanceRecoveryProvenance(task("completed"), {
      outcome: "completed", gateDecision: "fail", handoffRef, recordedAt: "2026-08-08T00:00:05.000Z"
    });
    assert.equal(projected.acceptanceReceipt.provenance.disposition, "blocked");
    projected.acceptanceReceipt.provenance.rawLog = "must not be accepted";
    assert.match(acceptanceReceiptValidationErrors(projected.acceptanceReceipt).join("; "), /provenance is invalid/);
  });

  it("invalidates retained old-tree proof and rebuilds criterion evidence only for the current tree", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-receipt-rebind-"));
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "test"), { recursive: true });
    const criterion = "`limit` defaults to 20 and must be a positive safe integer or throw `TypeError`.";
    const receipt = buildAcceptanceReceipt({
      summary: "Implement a bounded option limit contract and preserve caller input.",
      expectedOutput: "The configured verifier proves the exact limit contract.",
      acceptanceCriteria: [criterion],
      changeMode: "source-change",
      source: "runtime",
      generatedAt: "2026-08-08T00:00:00.000Z"
    }).receipt;
    const oldDigest = treeDigest("a");
    const finalDigest = treeDigest("b");
    const base = {
      ...task("pending"),
      summary: "Implement a bounded option limit contract and preserve caller input.",
      expectedOutput: "The configured verifier proves the exact limit contract.",
      acceptanceCriteria: [criterion],
      acceptanceReceipt: receipt,
      changedFiles: ["src/limit.js", "test/limit.test.js"],
      observedChangedFiles: ["src/limit.js", "test/limit.test.js"],
      verifyCommands: ["node --test test/limit.test.js"],
      verifyEvidence: [{
        command: "node --test test/limit.test.js", exitCode: 0, summary: "pass",
        recordedAt: "2026-08-08T00:00:01.000Z", observed: true,
        matchedProfileCommand: true, preWorkingTreeDigest: oldDigest, workingTreeDigest: oldDigest
      }]
    };
    fs.writeFileSync(path.join(cwd, "src", "limit.js"), [
      "export function take(items, options = {}) {",
      "  const limit = options.limit ?? 20;",
      "  if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('limit');",
      "  return items.slice(0, limit);",
      "}",
      ""
    ].join("\n"));
    fs.writeFileSync(path.join(cwd, "test", "limit.test.js"), [
      "import assert from 'node:assert/strict';",
      "import { take } from '../src/limit.js';",
      "for (const limit of [0, -1, 1.5]) assert.throws(() => take([], { limit }), TypeError);",
      "assert.throws(() => take([], { limit: null }), TypeError);",
      ""
    ].join("\n"));

    const flawed = refreshAcceptanceReceipt(base, {
      cwd,
      changedFiles: base.changedFiles,
      currentWorkingTreeDigest: oldDigest,
      recordedAt: "2026-08-08T00:00:02.000Z"
    });
    assert.equal(flawed.criticalMissing.length, 1, "a passing generic verifier must not ratify nullish fallback that contradicts the contract");
    assert.equal(flawed.receipt.criteria[0].status, "pending");

    const retained = structuredClone(base);
    retained.acceptanceReceipt.criteria[0].status = "satisfied";
    retained.acceptanceReceipt.criteria[0].evidence = [{
      kind: "verifier-backed-focused-test", summary: "stale proof", paths: retained.changedFiles,
      command: retained.verifyCommands[0], exitCode: 0, workingTreeDigest: oldDigest,
      recordedAt: "2026-08-08T00:00:02.000Z"
    }];
    const invalidated = invalidateAcceptanceReceiptAfterMutation(retained, "2026-08-08T00:00:03.000Z");
    assert.equal(invalidated.changed, true);
    assert.equal(invalidated.task.acceptanceReceipt.criteria[0].status, "pending");
    assert.deepEqual(invalidated.task.acceptanceReceipt.criteria[0].evidence, []);

    fs.writeFileSync(path.join(cwd, "src", "limit.js"), fs.readFileSync(path.join(cwd, "src", "limit.js"), "utf8").replace("options.limit ?? 20", "options.limit === undefined ? 20 : options.limit"));
    const repaired = structuredClone(retained);
    repaired.verifyEvidence.push({
      command: repaired.verifyCommands[0], exitCode: 0, summary: "final pass",
      recordedAt: "2026-08-08T00:00:04.000Z", observed: true,
      matchedProfileCommand: true, preWorkingTreeDigest: finalDigest, workingTreeDigest: finalDigest
    });
    const rebound = refreshAcceptanceReceipt(repaired, {
      cwd,
      changedFiles: repaired.changedFiles,
      currentWorkingTreeDigest: finalDigest,
      recordedAt: "2026-08-08T00:00:05.000Z"
    });
    assert.equal(rebound.criticalMissing.length, 0);
    assert.equal(rebound.receipt.criteria[0].status, "satisfied");
    assert.deepEqual([...new Set(rebound.receipt.criteria[0].evidence.map((entry) => entry.workingTreeDigest))], [finalDigest]);
  });

  it("derives repaired-success from durable trajectory repair transitions", () => {
    const events = ["verification-failed", "recovery-requested"].map((cause, index) => ({
      eventId: String(index + 1).repeat(64),
      from: "verify",
      to: "repair",
      cause
    }));
    const projected = applyAcceptanceRecoveryProvenance(task(), {
      outcome: "completed",
      gateDecision: "pass",
      trajectoryTransitions: events,
      handoffRef,
      recordedAt: "2026-08-08T00:00:06.000Z"
    });
    assert.equal(projected.acceptanceReceipt.provenance.disposition, "repaired-success");
    assert.equal(projected.acceptanceReceipt.provenance.repairCount, 2);
    assert.equal(projected.acceptanceReceipt.provenance.finalRecoveryDisposition, "succeeded");
    assert.equal(projected.acceptanceReceipt.provenance.recoveryRef.action, "repair");
  });

  it("projects validated semantic repair origin without relying on a trajectory transition", () => {
    const repaired = applyAcceptanceRecoveryProvenance(task(), {
      outcome: "completed",
      gateDecision: "pass",
      semanticRepair: { enforcementSafe: true, repairCount: 1, retryCount: 0, passed: true },
      recordedAt: "2026-08-08T00:00:06.500Z"
    });
    assert.equal(repaired.acceptanceReceipt.provenance.disposition, "repaired-success");
    assert.equal(repaired.acceptanceReceipt.provenance.repairCount, 1);
    assert.deepEqual(repaired.acceptanceReceipt.provenance.recoveryRef.reasonCodes, ["validated-semantic-repair-origin"]);

    for (const semanticRepair of [
      { enforcementSafe: false, repairCount: 1, retryCount: 0, passed: true },
      { enforcementSafe: true, repairCount: 1, retryCount: 0, passed: false },
      undefined
    ]) {
      const blocked = applyAcceptanceRecoveryProvenance(task(), {
        outcome: "completed",
        gateDecision: "pass",
        semanticRepair,
        recordedAt: "2026-08-08T00:00:06.500Z"
      });
      assert.equal(blocked.acceptanceReceipt.provenance.disposition, "blocked");
      assert.notEqual(blocked.acceptanceReceipt.provenance.disposition, "first-pass-success");
    }
  });

  it("projects hash-bound critical recovery dimensions and clears them only after executable proof", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-acceptance-guidance-"));
    try {
      fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
      fs.mkdirSync(path.join(cwd, "test"), { recursive: true });
      const criterion = "`parseCount(value)` rejects fractional values with `TypeError`.";
      const source = "export function parseCount(value) { if (!Number.isSafeInteger(value)) throw new TypeError('value'); return value; }\n";
      const changedFiles = ["src/count.js", "test/contract.test.js"];
      const built = buildAcceptanceReceipt({
        summary: criterion, expectedOutput: "Focused executable tests prove the final contract.",
        acceptanceCriteria: [criterion], changeMode: "source-change", source: "runtime"
      });
      const candidate = {
        ...task("pending"), summary: criterion, expectedOutput: "Focused executable tests prove the final contract.",
        acceptanceCriteria: built.acceptanceCriteria, acceptanceReceipt: built.receipt,
        changedFiles, observedChangedFiles: changedFiles, verifyCommands: ["node --test test/contract.test.js"],
        verifyEvidence: [{
          command: "node --test test/contract.test.js", exitCode: 0, summary: "pass",
          recordedAt: "2026-08-08T01:00:01.000Z", observed: true, matchedProfileCommand: true,
          preWorkingTreeDigest: treeDigest("d"), workingTreeDigest: treeDigest("d")
        }]
      };
      fs.writeFileSync(path.join(cwd, "src", "count.js"), source);
      fs.writeFileSync(path.join(cwd, "test", "contract.test.js"), [
        "import assert from 'node:assert/strict';",
        "import { parseCount } from '../src/count.js';",
        "let cases = [1.5];",
        "for (const value of cases) assert.throws(() => parseCount(value), TypeError);",
        ""
      ].join("\n"));
      const pending = acceptanceCriticalRecoveryProjection(candidate, {
        cwd, changedFiles, currentWorkingTreeDigest: treeDigest("d")
      });
      assert.equal(pending.length, 1);
      assert.equal(pending[0].criterionText, criterion);
      assert.deepEqual(pending[0].targets, ["parseCount"]);
      assert.deepEqual(pending[0].missingDimensions, ["executable-focused-test"]);
      assert.match(pending[0].proofHints.join(" "), /live entrypoint-bound rejection assertions/i);

      fs.writeFileSync(path.join(cwd, "test", "contract.test.js"), fs.readFileSync(path.join(cwd, "test", "contract.test.js"), "utf8").replace("let cases", "const cases"));
      assert.deepEqual(acceptanceCriticalRecoveryProjection(candidate, {
        cwd, changedFiles, currentWorkingTreeDigest: treeDigest("d")
      }), []);
      assert.deepEqual(acceptanceCriticalRecoveryProjection({ ...candidate, acceptanceCriteria: ["different operator criterion"] }, {
        cwd, changedFiles, currentWorkingTreeDigest: treeDigest("d")
      }), []);
      assert.deepEqual(acceptanceCriticalRecoveryProjection(candidate, { cwd, changedFiles }), []);
      assert.deepEqual(acceptanceCriticalRecoveryProjection(candidate, {
        cwd, changedFiles: ["src/missing.js"], currentWorkingTreeDigest: treeDigest("d")
      }), []);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("links an untouched exact-declared repair target to its own semantic conflict", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-linked-repair-"));
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    fs.mkdirSync(path.join(cwd, "test"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "src", "limit.js"), "export function take(items, options = {}) { const limit = options.limit ?? 20; return items.slice(0, limit); }\n");
    fs.writeFileSync(path.join(cwd, "src", "sibling.js"), "export const sibling = true;\n");
    fs.writeFileSync(path.join(cwd, "test", "limit.test.js"), "// current task delta\n");
    const criterion = "`limit` defaults to 20 and must be a positive safe integer or throw `TypeError`.";
    const linkedTask = {
      ...task("pending"),
      summary: "Implement a bounded limit contract.",
      expectedOutput: "Focused tests prove the limit contract.",
      acceptanceCriteria: [criterion],
      acceptanceReceipt: buildAcceptanceReceipt({
        summary: "Implement a bounded limit contract.",
        expectedOutput: "Focused tests prove the limit contract.",
        acceptanceCriteria: [criterion],
        changeMode: "source-change",
        source: "runtime"
      }).receipt,
      scope: ["src/limit.js", "src/sibling.js", "test/limit.test.js", "test/new-limit.test.js"]
    };
    const decide = (target) => decideSemanticRepairHandshake({
      cwd,
      task: linkedTask,
      mutationTargets: [target],
      currentDeltaPaths: ["test/limit.test.js"],
      verifierCurrent: true
    });
    assert.equal(decide("src/limit.js").authorized, true);
    assert.equal(decide("src/sibling.js").authorized, false);
    assert.equal(decide("test/new-limit.test.js").authorized, false);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe("acceptance evidence lexical truth", () => {
  function invalidInputTask(criterion, changedFiles, digest = treeDigest("d")) {
    const summary = `Implement the requested input contract. ${criterion}`;
    const built = buildAcceptanceReceipt({
      summary,
      expectedOutput: "Focused executable tests prove the final contract.",
      acceptanceCriteria: [criterion],
      changeMode: "source-change",
      source: "runtime",
      generatedAt: "2026-08-08T01:00:00.000Z"
    });
    return {
      ...task("pending"),
      summary,
      expectedOutput: "Focused executable tests prove the final contract.",
      acceptanceCriteria: built.acceptanceCriteria,
      acceptanceReceipt: built.receipt,
      changedFiles,
      observedChangedFiles: changedFiles,
      verifyCommands: ["node --test test/contract.test.js"],
      verifyEvidence: [{
        command: "node --test test/contract.test.js",
        exitCode: 0,
        summary: "pass",
        recordedAt: "2026-08-08T01:00:01.000Z",
        observed: true,
        matchedProfileCommand: true,
        preWorkingTreeDigest: digest,
        workingTreeDigest: digest
      }]
    };
  }

  function directInvalidEvidence(source, testText, criterion, target = "parseCount") {
    const sourceEntry = { path: "src/count.js", text: source };
    const testEntry = { path: "test/contract.test.js", text: testText };
    return acceptanceInvalidInputEvidence({
      taskText: criterion,
      sourceText: source,
      testText,
      sourceEntries: [sourceEntry],
      testEntries: [testEntry],
      namedTargets: [target],
      provenanceTargets: [target]
    });
  }

  it("erases comment, string, template, and regex payloads before semantic conflict analysis", () => {
    const source = [
      "export function take(limit) {",
      "  // Number.isSafeInteger(limit); throw new TypeError('fake'); RangeError",
      "  const quoted = \"Number.isSafeInteger(limit); throw new TypeError('fake'); RangeError\";",
      "  const templated = `Number.isSafeInteger(limit); TypeError`;",
      "  const patterned = /Number\\.isSafeInteger\\(limit\\)|TypeError/;",
      "  return limit;",
      "}",
      ""
    ].join("\n");
    const lexical = sanitizeJavaScriptEvidence(source);
    assert.doesNotMatch(lexical, /Number\.isSafeInteger|TypeError|RangeError|fake/);
    assert.match(lexical, /__pi_string_literal__/);
    assert.match(lexical, /__pi_template_literal__/);
    assert.match(lexical, /__pi_regex_literal__/);

    const criterion = "`limit` must be a positive safe integer or throw `TypeError`.";
    const conflicts = acceptanceSemanticConflicts(invalidInputTask(criterion, ["src/limit.js"]), { sourceText: source });
    assert.ok(conflicts.includes("missing-integer-guard:limit"));
    assert.equal(conflicts.includes("rangeerror-conflicts-with-requested-typeerror"), false);

    const localOptionSource = [
      "export function take(items, options = {}) {",
      "  const limit = options.limit === undefined ? 20 : options.limit;",
      "  return items.slice(0, limit);",
      "}",
      ""
    ].join("\n");
    const localConflicts = acceptanceSemanticConflicts(invalidInputTask(
      "`limit` must be a positive safe integer or throw `TypeError`.",
      ["src/limit.js"]
    ), { sourceText: localOptionSource });
    assert.ok(localConflicts.includes("missing-integer-guard:limit"), "an option-derived local remains a contract target even though it is not a formal parameter");
  });

  it("does not ratify comment/string/TODO decoys or an unrelated passing verifier", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-acceptance-decoy-"));
    try {
      fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
      fs.mkdirSync(path.join(cwd, "test"), { recursive: true });
      fs.writeFileSync(path.join(cwd, "src", "limit.js"), [
        "export function take(items, options = {}) {",
        "  const limit = options.limit === undefined ? 20 : options.limit;",
        "  if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('limit');",
        "  return items.slice(0, limit);",
        "}",
        ""
      ].join("\n"));
      fs.writeFileSync(path.join(cwd, "test", "contract.test.js"), [
        "import assert from 'node:assert/strict';",
        "import test from 'node:test';",
        "// TODO assert.throws(() => take([], { limit: 1.5 }), TypeError); negative zero fractional",
        "const quotedProof = \"assert.throws(() => take([], { limit: -1 }), TypeError)\";",
        "const TODO_fractional_TypeError = true;",
        "function neverRuns() { assert.throws(() => take([], { limit: 1.5 }), TypeError); }",
        "test.skip('decoy', () => assert.throws(() => take([], { limit: -1 }), TypeError));",
        "assert.throws(() => Number(Symbol()), TypeError);",
        ""
      ].join("\n"));
      const criterion = "`limit` defaults to 20 and must be a positive safe integer or throw `TypeError`.";
      const candidate = invalidInputTask(criterion, ["src/limit.js", "test/contract.test.js"]);
      const refreshed = refreshAcceptanceReceipt(candidate, {
        cwd,
        changedFiles: candidate.changedFiles,
        currentWorkingTreeDigest: treeDigest("d")
      });
      assert.ok(refreshed.criticalMissing.some((item) => item.obligation === "invalid-input-rejection"));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("accepts a bounded assertion helper only when it executes the named callable and requested partitions", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-acceptance-helper-"));
    try {
      fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
      fs.mkdirSync(path.join(cwd, "test"), { recursive: true });
      fs.writeFileSync(path.join(cwd, "src", "limit.js"), [
        "export function take(items, options = {}) {",
        "  const limit = options.limit === undefined ? 20 : options.limit;",
        "  if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('limit');",
        "  return items.slice(0, limit);",
        "}",
        ""
      ].join("\n"));
      fs.writeFileSync(path.join(cwd, "test", "contract.test.js"), [
        "import assert from 'node:assert/strict';",
        "import { take } from '../src/limit.js';",
        "const expectTypeError = (operation) => assert.throws(operation, TypeError);",
        "for (const limit of [0, -1, 1.5]) expectTypeError(() => take([], { limit }));",
        ""
      ].join("\n"));
      const criterion = "`take(items, options)` rejects zero, negative, and fractional `limit` values with `TypeError`.";
      const candidate = invalidInputTask(criterion, ["src/limit.js", "test/contract.test.js"]);
      const refreshed = refreshAcceptanceReceipt(candidate, {
        cwd,
        changedFiles: candidate.changedFiles,
        currentWorkingTreeDigest: treeDigest("d")
      });
      assert.equal(refreshed.criticalMissing.some((item) => item.obligation === "invalid-input-rejection"), false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("accepts an independently shaped async rejection assertion tied to its entrypoint", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-acceptance-async-"));
    try {
      fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
      fs.mkdirSync(path.join(cwd, "test"), { recursive: true });
      fs.writeFileSync(path.join(cwd, "src", "count.js"), "export async function parseCount(value) { if (!Number.isSafeInteger(value)) throw new TypeError('value'); return value; }\n");
      fs.writeFileSync(path.join(cwd, "test", "contract.test.js"), [
        "import assert from 'node:assert/strict';",
        "import { parseCount } from '../src/count.js';",
        "await assert.rejects(parseCount(1.5), TypeError);",
        "await assert.rejects(parseCount(2.5), TypeError);",
        ""
      ].join("\n"));
      const criterion = "`parseCount(value)` rejects fractional integer values with `TypeError`.";
      const candidate = invalidInputTask(criterion, ["src/count.js", "test/contract.test.js"]);
      const refreshed = refreshAcceptanceReceipt(candidate, {
        cwd,
        changedFiles: candidate.changedFiles,
        currentWorkingTreeDigest: treeDigest("d")
      });
      assert.equal(refreshed.criticalMissing.some((item) => item.obligation === "invalid-input-rejection"), false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("binds aliased imports to the changed export and rejects a same-name local shadow", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-acceptance-binding-"));
    try {
      fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
      fs.mkdirSync(path.join(cwd, "test"), { recursive: true });
      fs.writeFileSync(path.join(cwd, "src", "limit.js"), [
        "export function take(value) {",
        "  if (!Number.isSafeInteger(value)) throw new TypeError('value');",
        "  return value;",
        "}",
        ""
      ].join("\n"));
      const criterion = "`take(value)` rejects fractional values with `TypeError`.";
      const changedFiles = ["src/limit.js", "test/contract.test.js"];
      const candidate = () => invalidInputTask(criterion, changedFiles);
      fs.writeFileSync(path.join(cwd, "test", "contract.test.js"), [
        "import assert from 'node:assert/strict';",
        "import test from 'node:test';",
        "import { take as productTake } from '../src/limit.js';",
        "test('fractional input', () => assert.throws(() => productTake(1.5), TypeError));",
        ""
      ].join("\n"));
      const aliased = refreshAcceptanceReceipt(candidate(), { cwd, changedFiles, currentWorkingTreeDigest: treeDigest("d") });
      assert.equal(aliased.criticalMissing.some((item) => item.obligation === "invalid-input-rejection"), false);

      fs.writeFileSync(path.join(cwd, "test", "contract.test.js"), [
        "import assert from 'node:assert/strict';",
        "import test from 'node:test';",
        "import { take as productTake } from '../src/limit.js';",
        "function take(value) { if (!Number.isSafeInteger(value)) throw new TypeError('shadow'); return value; }",
        "test('shadow decoy', () => assert.throws(() => take(1.5), TypeError));",
        ""
      ].join("\n"));
      const shadowed = refreshAcceptanceReceipt(candidate(), { cwd, changedFiles, currentWorkingTreeDigest: treeDigest("d") });
      assert.ok(shadowed.criticalMissing.some((item) => item.obligation === "invalid-input-rejection"));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("binds CommonJS exports through destructured, direct, namespace, and dynamic literal imports", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-acceptance-cjs-"));
    try {
      fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
      fs.mkdirSync(path.join(cwd, "test"), { recursive: true });
      const cjsSource = [
        "function take(value) {",
        "  if (!Number.isSafeInteger(value)) throw new TypeError('value');",
        "  return value;",
        "}",
        "module.exports = { take };",
        ""
      ].join("\n");
      fs.writeFileSync(path.join(cwd, "src", "limit.cjs"), cjsSource);
      const criterion = "`take(value)` rejects fractional values with `TypeError`.";
      const changedFiles = ["src/limit.cjs", "test/contract.test.js"];
      const variants = [
        "const { take: productTake } = require('../src/limit.cjs');\nassert.throws(() => productTake(1.5), TypeError);",
        "const productTake = require('../src/limit.cjs').take;\nassert.throws(() => productTake(1.5), TypeError);",
        "const product = require('../src/limit.cjs');\nassert.throws(() => product.take(1.5), TypeError);"
      ];
      for (const body of variants) {
        fs.writeFileSync(path.join(cwd, "test", "contract.test.js"), `const assert = require('node:assert/strict');\n${body}\n`);
        const refreshed = refreshAcceptanceReceipt(invalidInputTask(criterion, changedFiles), { cwd, changedFiles, currentWorkingTreeDigest: treeDigest("d") });
        assert.equal(refreshed.criticalMissing.some((item) => item.obligation === "invalid-input-rejection"), false, body);
      }

      fs.writeFileSync(path.join(cwd, "src", "limit.cjs"), cjsSource.replace("module.exports = { take };", "exports.take = take;"));
      fs.writeFileSync(path.join(cwd, "test", "contract.test.js"), "const { take: productTake } = require('../src/limit.cjs');\nconst assert = require('node:assert/strict');\nassert.throws(() => productTake(1.5), TypeError);\n");
      const propertyExport = refreshAcceptanceReceipt(invalidInputTask(criterion, changedFiles), { cwd, changedFiles, currentWorkingTreeDigest: treeDigest("d") });
      assert.equal(propertyExport.criticalMissing.some((item) => item.obligation === "invalid-input-rejection"), false);

      fs.writeFileSync(path.join(cwd, "test", "contract.test.js"), [
        "const { take: productTake } = require('../src/limit.cjs');",
        "const assert = require('node:assert/strict');",
        "function take(value) { if (!Number.isSafeInteger(value)) throw new TypeError('shadow'); return value; }",
        "assert.throws(() => take(1.5), TypeError);",
        ""
      ].join("\n"));
      const shadowed = refreshAcceptanceReceipt(invalidInputTask(criterion, changedFiles), { cwd, changedFiles, currentWorkingTreeDigest: treeDigest("d") });
      assert.ok(shadowed.criticalMissing.some((item) => item.obligation === "invalid-input-rejection"));

      fs.writeFileSync(path.join(cwd, "src", "limit.cjs"), cjsSource);
      for (const body of [
        "let { take } = require('../src/limit.cjs');\ntake = () => { throw new TypeError('decoy'); };\nassert.throws(() => take(1.5), TypeError);",
        "const product = require('../src/limit.cjs');\nproduct.take = () => { throw new TypeError('decoy'); };\nassert.throws(() => product.take(1.5), TypeError);"
      ]) {
        const testText = `const assert = require('node:assert/strict');\n${body}\n`;
        fs.writeFileSync(path.join(cwd, "test", "contract.test.js"), testText);
        const mutable = refreshAcceptanceReceipt(invalidInputTask(criterion, changedFiles), { cwd, changedFiles, currentWorkingTreeDigest: treeDigest("d") });
        assert.ok(mutable.criticalMissing.some((item) => item.obligation === "invalid-input-rejection"), body);
        assert.equal(acceptanceExecutableTestBinding({
          sourceEntry: { path: "src/limit.cjs", text: cjsSource },
          testEntry: { path: "test/contract.test.js", text: testText }
        }).linked, false, body);
      }

      fs.writeFileSync(path.join(cwd, "src", "limit.js"), cjsSource.replace("module.exports = { take };", "export { take };"));
      fs.writeFileSync(path.join(cwd, "test", "contract.test.js"), [
        "import assert from 'node:assert/strict';",
        "const { take: productTake } = await import('../src/limit.js');",
        "assert.throws(() => productTake(1.5), TypeError);",
        ""
      ].join("\n"));
      const dynamicFiles = ["src/limit.js", "test/contract.test.js"];
      const dynamic = refreshAcceptanceReceipt(invalidInputTask(criterion, dynamicFiles), { cwd, changedFiles: dynamicFiles, currentWorkingTreeDigest: treeDigest("d") });
      assert.equal(dynamic.criticalMissing.some((item) => item.obligation === "invalid-input-rejection"), false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("credits executed braced iterations and exact Node error-name matchers without crediting disabled or message decoys", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-acceptance-iteration-"));
    try {
      fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
      fs.mkdirSync(path.join(cwd, "test"), { recursive: true });
      fs.writeFileSync(path.join(cwd, "src", "count.js"), "export function parseCount(value) { if (!Number.isSafeInteger(value)) throw new TypeError('value'); return value; }\n");
      const criterion = "`parseCount(value)` rejects fractional values with `TypeError`.";
      const changedFiles = ["src/count.js", "test/contract.test.js"];
      const prefix = "import assert from 'node:assert/strict';\nimport { parseCount } from '../src/count.js';\n";
      const validBodies = [
        "for (const candidate of [-1, 1.25]) {\n  assert.throws(() => parseCount(candidate), TypeError);\n}",
        "[-1, 1.25].forEach((candidate) => {\n  assert.throws(() => parseCount(candidate), TypeError);\n});",
        "assert.throws(() => parseCount(1.25), { name: 'TypeError' });"
      ];
      for (const body of validBodies) {
        fs.writeFileSync(path.join(cwd, "test", "contract.test.js"), `${prefix}${body}\n`);
        const refreshed = refreshAcceptanceReceipt(invalidInputTask(criterion, changedFiles), { cwd, changedFiles, currentWorkingTreeDigest: treeDigest("d") });
        assert.equal(refreshed.criticalMissing.some((item) => item.obligation === "invalid-input-rejection"), false, body);
      }

      fs.writeFileSync(path.join(cwd, "test", "contract.test.js"), [
        prefix,
        "if (false) { for (const candidate of [1.25]) { assert.throws(() => parseCount(candidate), TypeError); } }",
        "assert.throws(() => parseCount(1.25), { message: 'TypeError' });",
        ""
      ].join("\n"));
      const decoys = refreshAcceptanceReceipt(invalidInputTask(criterion, changedFiles), { cwd, changedFiles, currentWorkingTreeDigest: treeDigest("d") });
      assert.ok(decoys.criticalMissing.some((item) => item.obligation === "invalid-input-rejection"));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("limits source proof to input-derived guards while preserving inverse and predicate forms", () => {
    const criterion = "`parseCount(candidate)` rejects negative and fractional values with `TypeError`.";
    const testText = [
      "import assert from 'node:assert/strict';",
      "import { parseCount } from '../src/count.js';",
      "assert.throws(() => parseCount(-1), TypeError);",
      "assert.throws(() => parseCount(1.5), TypeError);"
    ].join("\n");
    const rejectedSources = [
      "export function parseCount(candidate) { if (false) throw new TypeError('x'); return candidate; }",
      "export function parseCount(candidate) { if (1 === 2) throw new TypeError('x'); return candidate; }",
      "export function parseCount(candidate) { if (process.env.NEVER) throw new TypeError('x'); return candidate; }",
      "export function parseCount(candidate) { if (candidate < 0) throw new TypeError('x'); return candidate; }",
      "export function parseCount(candidate) { const unrelated = 1; if (!Number.isSafeInteger(unrelated) || unrelated < 0) throw new TypeError('x'); return candidate; }",
      "export function parseCount(candidate) { const count = globalThis.someValue; if (!Number.isSafeInteger(count) || count < 0) throw new TypeError('x'); return candidate; }",
      "export function parseCount(candidate) { candidate = 1; if (!Number.isSafeInteger(candidate) || candidate < 0) throw new TypeError('x'); return candidate; }",
      "export function parseCount(candidate) { let checked = candidate; checked = 1; if (!Number.isSafeInteger(checked) || checked < 0) throw new TypeError('x'); return checked; }",
      "export function parseCount(candidate) { const checked = candidate; checked++; if (!Number.isSafeInteger(checked) || checked < 0) throw new TypeError('x'); return checked; }"
    ];
    for (const source of rejectedSources) assert.equal(directInvalidEvidence(source, testText, criterion).sourceOk, false, source);

    const acceptedSources = [
      "export function parseCount(candidate) { if (!(Number.isSafeInteger(candidate) && candidate >= 0)) throw new TypeError('x'); return candidate; }",
      "export function parseCount(candidate) { if (Number.isSafeInteger(candidate) && candidate >= 0) return candidate; throw new TypeError('x'); }",
      "function validCount(value) { return Number.isSafeInteger(value) && value >= 0; } export function parseCount(candidate) { if (!validCount(candidate)) throw new TypeError('x'); return candidate; }",
      "export function parseCount(options) { const candidate = options.value; if (!Number.isSafeInteger(candidate) || candidate < 0) throw new TypeError('x'); return candidate; }"
    ];
    for (const source of acceptedSources) assert.equal(directInvalidEvidence(source, testText, criterion).sourceOk, true, source);
  });

  it("shares one fail-closed executable binding grammar with repair authorization", () => {
    const sourceEntry = {
      path: "src/count.js",
      text: "export function parseCount(value) { if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('value'); return value; }"
    };
    const prefix = [
      "import assert from 'node:assert/strict';",
      "import test, { describe } from 'node:test';",
      "import { parseCount } from '../src/count.js';"
    ].join("\n");
    const disabledBodies = [
      "if (false) assert.throws(() => parseCount(1.5), TypeError);",
      "while (false) { assert.throws(() => parseCount(1.5), TypeError); }",
      "for (let index = 0; index < 0; index += 1) { assert.throws(() => parseCount(1.5), TypeError); }",
      "test('dead', () => { return; assert.throws(() => parseCount(1.5), TypeError); });",
      "test('skip', { skip: 'reason' }, () => assert.throws(() => parseCount(1.5), TypeError));",
      "test('todo', { todo: 'later' }, () => assert.throws(() => parseCount(1.5), TypeError));",
      "test('skip expression', { skip: 1 === 1 }, () => assert.throws(() => parseCount(1.5), TypeError));",
      "describe('disabled suite', { skip: true }, () => { test('nested', () => assert.throws(() => parseCount(1.5), TypeError)); });",
      "test('dead comparison', () => { if (false === true) assert.throws(() => parseCount(1.5), TypeError); });",
      "test('dead logical', () => { (1 === 2) && assert.throws(() => parseCount(1.5), TypeError); });",
      "const options = { skip: true }; test('unknown options', options, () => assert.throws(() => parseCount(1.5), TypeError));",
      "true ? void 0 : assert.throws(() => parseCount(1.5), TypeError);",
      "class NeverCreated { verify() { assert.throws(() => parseCount(1.5), TypeError); } }",
      "[].map(() => assert.throws(() => parseCount(1.5), TypeError));",
      "process.exit(0); assert.throws(() => parseCount(1.5), TypeError);",
      "assert.throws(() => { parseCount(1.5); Number(Symbol()); }, TypeError);",
      "assert.throws(() => { try { parseCount(1.5); } catch {} Number(Symbol()); }, TypeError);",
      "const expectTypeError = (operation) => assert.throws(() => Number(Symbol(operation)), TypeError); expectTypeError(() => parseCount(1.5));"
    ];
    for (const body of disabledBodies) {
      const testEntry = { path: "test/contract.test.js", text: `${prefix}\n${body}\n` };
      assert.deepEqual(acceptanceExecutableTestBinding({ sourceEntry, testEntry }), { linked: false, sourceNames: [], testNames: [] }, body);
      assert.equal(directInvalidEvidence(sourceEntry.text, testEntry.text, "`parseCount(value)` rejects fractional values with `TypeError`.").testOk, false, body);
    }

    const liveTest = {
      path: "test/contract.test.js",
      text: `${prefix}\nfor (const candidate of [-1, 1.5]) { assert.throws(() => parseCount(candidate), { name: 'TypeError' }); }\n`
    };
    assert.deepEqual(acceptanceExecutableTestBinding({ sourceEntry, testEntry: liveTest }), {
      linked: true,
      sourceNames: ["parsecount"],
      testNames: ["parsecount"]
    });
  });

  it("rejects disabled assertions, unrelated source throws, and unresolved product imports", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-acceptance-disabled-"));
    try {
      fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
      fs.mkdirSync(path.join(cwd, "test"), { recursive: true });
      fs.writeFileSync(path.join(cwd, "src", "limit.js"), [
        "export function take(value) { return value; }",
        "export function unrelated(value) { if (value === null) throw new TypeError('unrelated'); return value; }",
        ""
      ].join("\n"));
      fs.writeFileSync(path.join(cwd, "test", "contract.test.js"), [
        "import assert from 'node:assert/strict';",
        "import { take as productTake } from '../src/limit.js';",
        "if (false) assert.throws(() => productTake(1.5), TypeError);",
        "false && assert.throws(() => productTake(-1), TypeError);",
        ""
      ].join("\n"));
      const criterion = "`take(value)` rejects fractional values with `TypeError`.";
      const changedFiles = ["src/limit.js", "test/contract.test.js"];
      const disabled = refreshAcceptanceReceipt(invalidInputTask(criterion, changedFiles), { cwd, changedFiles, currentWorkingTreeDigest: treeDigest("d") });
      assert.ok(disabled.criticalMissing.some((item) => item.obligation === "invalid-input-rejection"));

      fs.writeFileSync(path.join(cwd, "test", "contract.test.js"), [
        "import assert from 'node:assert/strict';",
        "assert.throws(() => take(1.5), TypeError);",
        ""
      ].join("\n"));
      const unresolved = refreshAcceptanceReceipt(invalidInputTask(criterion, changedFiles), { cwd, changedFiles, currentWorkingTreeDigest: treeDigest("d") });
      assert.ok(unresolved.criticalMissing.some((item) => item.obligation === "invalid-input-rejection"));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not turn valid undefined/default or empty-query clauses into rejection partitions", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-acceptance-polarity-"));
    try {
      fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
      fs.mkdirSync(path.join(cwd, "test"), { recursive: true });
      fs.writeFileSync(path.join(cwd, "src", "limit.js"), [
        "export function take(items, options = {}) {",
        "  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('options');",
        "  const limit = options.limit === undefined ? 20 : options.limit;",
        "  if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError('limit');",
        "  return items.slice(0, limit);",
        "}",
        ""
      ].join("\n"));
      fs.writeFileSync(path.join(cwd, "test", "contract.test.js"), [
        "import assert from 'node:assert/strict';",
        "import { take } from '../src/limit.js';",
        "for (const limit of [null, 0, -1, 1.5]) assert.throws(() => take([], { limit }), TypeError);",
        "assert.throws(() => take([], null), TypeError);",
        ""
      ].join("\n"));
      const criterion = "`take(items, options)` accepts omitted options as a new empty object. Omitted or undefined `limit` defaults to 20; when supplied it must be a positive safe integer or throw `TypeError`. An empty normalized query matches every item.";
      const changedFiles = ["src/limit.js", "test/contract.test.js"];
      const refreshed = refreshAcceptanceReceipt(invalidInputTask(criterion, changedFiles), { cwd, changedFiles, currentWorkingTreeDigest: treeDigest("d") });
      assert.equal(refreshed.criticalMissing.some((item) => item.obligation === "invalid-input-rejection"), false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("proves immutable named literal rejection corpora without trusting mutable, spread, shadowed, or skipped iterables", () => {
    const sourceEntry = {
      path: "src/count.js",
      text: "export function parseCount(value) { if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('value'); return value; }"
    };
    const criterion = "`parseCount(value)` rejects negative and fractional values with `TypeError`.";
    const prefix = [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      "import { parseCount } from '../src/count.js';"
    ].join("\n");
    const liveBodies = [
      "test('for-of', () => { const cases = [-1, 1.5]; for (const candidate of cases) assert.throws(() => parseCount(candidate), TypeError); });",
      "test('forEach', () => { const cases = [-1, 1.5]; cases.forEach((candidate) => { assert.throws(() => parseCount(candidate), TypeError); }); });"
    ];
    for (const body of liveBodies) {
      const testEntry = { path: "test/contract.test.js", text: `${prefix}\n${body}\n` };
      assert.equal(directInvalidEvidence(sourceEntry.text, testEntry.text, criterion).testOk, true, body);
      assert.equal(acceptanceExecutableTestBinding({ sourceEntry, testEntry }).linked, true, body);
    }

    const rejectedBodies = [
      "test('let', () => { let cases = [-1, 1.5]; for (const candidate of cases) assert.throws(() => parseCount(candidate), TypeError); });",
      "test('assignment', () => { const cases = [-1, 1.5]; cases = [1]; for (const candidate of cases) assert.throws(() => parseCount(candidate), TypeError); });",
      "test('mutation', () => { const cases = [-1, 1.5]; cases.splice(0); for (const candidate of cases) assert.throws(() => parseCount(candidate), TypeError); });",
      "test('index write', () => { const cases = [-1, 1.5]; cases[0] = 1; for (const candidate of cases) assert.throws(() => parseCount(candidate), TypeError); });",
      "test('push', () => { const cases = [-1, 1.5]; cases.push(1); for (const candidate of cases) assert.throws(() => parseCount(candidate), TypeError); });",
      "test('alias mutation', () => { const cases = [-1, 1.5]; const alias = cases; alias.length = 0; for (const candidate of cases) assert.throws(() => parseCount(candidate), TypeError); });",
      "test('spread', () => { const cases = [...[]]; for (const candidate of cases) assert.throws(() => parseCount(candidate), TypeError); });",
      "test('empty', () => { const cases = []; for (const candidate of cases) assert.throws(() => parseCount(candidate), TypeError); });",
      "test('after use', () => { for (const candidate of cases) assert.throws(() => parseCount(candidate), TypeError); const cases = [-1, 1.5]; });",
      "const cases = [-1, 1.5]; test('shadow', () => { const cases = [1]; for (const candidate of cases) assert.throws(() => parseCount(candidate), TypeError); });",
      "test('shadowed loop value', () => { const cases = [-1, 1.5]; for (const candidate of cases) assert.throws(() => { const candidate = 1; return parseCount(candidate); }, TypeError); });",
      "test('reassigned loop value', () => { const cases = [-1, 1.5]; for (let candidate of cases) { candidate = 1; assert.throws(() => parseCount(candidate), TypeError); } });",
      "test.skip('skipped', () => { const cases = [-1, 1.5]; for (const candidate of cases) assert.throws(() => parseCount(candidate), TypeError); });",
      "test('dead', () => { const cases = [-1, 1.5]; if (false) for (const candidate of cases) assert.throws(() => parseCount(candidate), TypeError); });",
      "test('continue before', () => { const cases = [-1, 1.5]; for (const candidate of cases) { continue; assert.throws(() => parseCount(candidate), TypeError); } });",
      "test('break before', () => { const cases = [-1, 1.5]; for (const candidate of cases) { break; assert.throws(() => parseCount(candidate), TypeError); } });",
      "test('conditional continue', () => { const cases = [-1, 1.5]; for (const candidate of cases) { if (true) continue; assert.throws(() => parseCount(candidate), TypeError); } });",
      "test('in-loop mutation before', () => { const cases = [-1, 1.5]; for (const candidate of cases) { cases.splice(0); assert.throws(() => parseCount(candidate), TypeError); } });",
      "test('break after', () => { const cases = [-1, 1.5]; for (const candidate of cases) { assert.throws(() => parseCount(candidate), TypeError); break; } });",
      "test('in-loop mutation after', () => { const cases = [-1, 1.5]; for (const candidate of cases) { assert.throws(() => parseCount(candidate), TypeError); cases.splice(0); } });",
      "test('unawaited direct rejection', async () => { assert.rejects(() => parseCount(1.5), TypeError); });",
      "test('unawaited loop rejection', async () => { const cases = [-1, 1.5]; for (const candidate of cases) assert.rejects(() => parseCount(candidate), TypeError); });",
      "test('unawaited forEach rejection', () => { const cases = [-1, 1.5]; cases.forEach((candidate) => { assert.rejects(() => Promise.resolve(parseCount(candidate)), TypeError); }); });",
      "test('unawaited async forEach', () => { const cases = [-1, 1.5]; cases.forEach(async (candidate) => { await assert.rejects(() => Promise.resolve(parseCount(candidate)), TypeError); }); });"
    ];
    for (const body of rejectedBodies) {
      const testEntry = { path: "test/contract.test.js", text: `${prefix}\n${body}\n` };
      assert.equal(directInvalidEvidence(sourceEntry.text, testEntry.text, criterion).testOk, false, body);
      assert.equal(acceptanceExecutableTestBinding({ sourceEntry, testEntry }).linked, false, body);
    }
    const nestedMetadata = `${prefix}\ntest('nested metadata', () => { const cases = [{ fallback: -1 }, { fallback: 1.5 }]; for (const candidate of cases) assert.throws(() => parseCount(candidate), TypeError); });\n`;
    assert.equal(directInvalidEvidence(sourceEntry.text, nestedMetadata, criterion).testOk, false);
  });

  it("accepts the retained migration entrypoint contracts without promoting adapter callbacks to product entrypoints", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-acceptance-migration-"));
    try {
      fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
      fs.mkdirSync(path.join(cwd, "test"), { recursive: true });
      const planSource = [
        "function validateSteps(steps) {",
        "  if (!Array.isArray(steps)) throw new TypeError('steps');",
        "  for (const step of steps) if (!step || typeof step !== 'object' || typeof step.id !== 'string' || !step.id.trim() || typeof step.apply !== 'function' || !Array.isArray(step.dependsOn)) throw new TypeError('step');",
        "}",
        "export function migrationPlan(steps) {",
        "  validateSteps(steps);",
        "  if (steps.some((step) => step.dependsOn.includes(step.id))) throw new TypeError('cycle');",
        "  return [...steps];",
        "}",
        ""
      ].join("\n");
      const runnerSource = [
        "function validatePlannedOrder(steps) { if (!Array.isArray(steps)) throw new TypeError('steps'); }",
        "export async function runMigration({ steps, checkpoint, apply } = {}) {",
        "  validatePlannedOrder(steps);",
        "  if (!checkpoint || typeof checkpoint.read !== 'function' || typeof checkpoint.write !== 'function') throw new TypeError('checkpoint');",
        "  if (typeof apply !== 'function') throw new TypeError('apply');",
        "  const state = await checkpoint.read();",
        "  if (!Array.isArray(state)) throw new TypeError('state');",
        "  if (state.some((id) => !steps.some((step) => step.id === id))) throw new TypeError('id');",
        "  return { completed: [...state] };",
        "}",
        ""
      ].join("\n");
      const testText = [
        "import assert from 'node:assert/strict';",
        "import test from 'node:test';",
        "import { migrationPlan } from '../src/plan.js';",
        "import { runMigration } from '../src/runner.js';",
        "const step = (id, dependsOn = []) => ({ id, dependsOn, apply() {} });",
        "test('invalid plans', () => {",
        "  const malformed = [null, {}, [null], [{ id: ' ', dependsOn: [], apply() {} }], [step('a', ['a'])]];",
        "  for (const value of malformed) assert.throws(() => migrationPlan(value), TypeError);",
        "});",
        "test('invalid runner adapters', async () => {",
        "  const steps = [step('a')];",
        "  for (const checkpoint of [null, {}, { read() {}, write() {} }]) await assert.rejects(() => runMigration({ steps, checkpoint, apply() {} }), TypeError);",
        "});",
        ""
      ].join("\n");
      fs.writeFileSync(path.join(cwd, "src", "plan.js"), planSource);
      fs.writeFileSync(path.join(cwd, "src", "runner.js"), runnerSource);
      fs.writeFileSync(path.join(cwd, "test", "contract.test.js"), testText);
      const criteria = [
        "[M1] `migrationPlan(steps)` requires an array of objects with unique string ids that contain at least one non-whitespace character, callable `apply` functions, and `dependsOn` arrays that contain only known string ids. Reject malformed plans and cycles with `TypeError`.",
        "[M3] `runMigration({ steps, checkpoint, apply })` requires a planned step array in the exact stable order returned by `migrationPlan`, an async-compatible checkpoint adapter with callable `read()` and `write(completedIds)`, and a callable `apply(step)`. Reject malformed, dependency-unsafe, or unordered step arrays, non-array checkpoint state, and unknown checkpoint ids with `TypeError`.",
        "The adapter callback `read()` supplies state before `runMigration({ steps, checkpoint, apply })` rejects non-array checkpoint state with `TypeError`."
      ];
      const changedFiles = ["src/plan.js", "src/runner.js", "test/contract.test.js"];
      for (const criterion of criteria) {
        const refreshed = refreshAcceptanceReceipt(invalidInputTask(criterion, changedFiles), {
          cwd, changedFiles, currentWorkingTreeDigest: treeDigest("d")
        });
        assert.equal(refreshed.criticalMissing.some((item) => item.obligation === "invalid-input-rejection"), false, criterion);
      }

      fs.writeFileSync(path.join(cwd, "src", "runner.js"), "export function read() { throw new TypeError('decoy'); }\nexport function write() { throw new TypeError('decoy'); }\nexport function apply() { throw new TypeError('decoy'); }\n");
      const missingPrimary = refreshAcceptanceReceipt(invalidInputTask(criteria[1], changedFiles), {
        cwd, changedFiles, currentWorkingTreeDigest: treeDigest("d")
      });
      assert.ok(missingPrimary.criticalMissing.some((item) => item.obligation === "invalid-input-rejection"));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not infer rejected array evidence from valid array nouns or qualified unordered arrays", () => {
    const source = "export function parseSteps(value) { if (!Array.isArray(value)) throw new TypeError('value'); return value; }";
    const testText = "import assert from 'node:assert/strict'; import { parseSteps } from '../src/count.js'; assert.throws(() => parseSteps(null), TypeError);";
    const validNouns = "`parseSteps(value)` requires arrays in stable order. Reject unordered step arrays and non-array checkpoint state with `TypeError`.";
    assert.deepEqual(directInvalidEvidence(source, testText, validNouns, "parseSteps"), { sourceOk: true, testOk: true });

    const explicitArraySource = "export function parseSteps(value) { if (Array.isArray(value)) throw new TypeError('value'); return value; }";
    const explicitArray = "`parseSteps(value)` rejects arrays with `TypeError`.";
    assert.equal(directInvalidEvidence(explicitArraySource, testText, explicitArray, "parseSteps").testOk, false);
    assert.equal(directInvalidEvidence(
      explicitArraySource,
      "import assert from 'node:assert/strict'; import { parseSteps } from '../src/count.js'; assert.throws(() => parseSteps([]), TypeError);",
      explicitArray,
      "parseSteps"
    ).testOk, true);
    assert.equal(directInvalidEvidence(
      explicitArraySource,
      "import assert from 'node:assert/strict'; import { parseSteps } from '../src/count.js'; const cases = [[1], []]; for (const value of cases) assert.throws(() => parseSteps(value), TypeError);",
      explicitArray,
      "parseSteps"
    ).testOk, true);
  });
});
