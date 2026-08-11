import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  benchmarkAssuranceEvidenceValidationErrors,
  benchmarkAssuranceValidationErrors
} from "../packages/piagent-core/benchmark/benchmark-assurance.js";

const root = path.resolve(import.meta.dirname, "..");
const boundaryRoot = path.join(root, "evals", "private-holdout-v1");
const fixturePath = path.join(root, "evals", "fixtures", "benchmark-assurance-evidence.valid.json");
const script = path.join(root, "scripts", "private-holdout-readiness.mjs");
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const load = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("public E3 boundary enumerates author-visible exposure without private content", () => {
  const policy = load(path.join(boundaryRoot, "access-policy.v1.json"));
  const rubric = load(path.join(boundaryRoot, "human-rubric.v1.json"));
  const exposure = load(path.join(boundaryRoot, "public-exposure.v1.json"));
  assert.equal(policy.state, "external-input-required");
  assert.equal(policy.preFreezeAccess.candidateAuthorPromptAccess, "denied-until-rc-freeze");
  assert.equal(policy.preFreezeAccess.candidateAuthorGraderAccess, "denied-until-rc-freeze");
  assert.equal(policy.preFreezeAccess.candidateAuthorRepositoryAccess, "denied-until-rc-freeze");
  assert.equal(policy.preFreezeAccess.operatorAccess, "execute-only");
  assert.equal(policy.separation.candidateAuthorCannotFillCustodianReviewerOrAdjudicatorRole, true);
  assert.equal(rubric.sample.minimumItems, 12);
  assert.equal(rubric.sample.doubleScoreEveryItem, true);
  assert.equal(rubric.disagreement.unresolvedAllowedForClaim, 0);
  assert.equal(rubric.disagreement.preserveInitialScores, true);
  assert.equal(exposure.taxonomy.sha256, sha256(path.join(root, exposure.taxonomy.path)));
  for (const suite of exposure.visibleSuites) {
    const suitePath = path.join(root, "benchmarks", suite.id, "suite.json");
    const manifest = load(suitePath);
    assert.equal(suite.manifestSha256, sha256(suitePath));
    assert.deepEqual(suite.scenarioIds, manifest.scenarios.map((scenario) => scenario.id));
  }
  assert.equal(exposure.visibleLongHorizon.manifestSha256, sha256(path.join(root, "evals", "long-horizon-v1", "lane.json")));
  const publicText = [policy, rubric, exposure].map(JSON.stringify).join("\n");
  assert.doesNotMatch(publicText, /(?:\/Users\/|\/private\/var\/|file:\/\/|auth\.json|access[_-]?token|refresh[_-]?token|xox[baprs]-)/i);
  assert.doesNotMatch(publicText, /(?:reviewerName|reviewerEmail|privateRepositoryUrl|privatePromptText|graderSource)/);
});

test("custodian handoff refuses self-attestation and exposes one redacted command", () => {
  const runbook = fs.readFileSync(path.join(boundaryRoot, "CUSTODIAN_RUNBOOK.md"), "utf8");
  assert.match(runbook, /candidate author cannot act as custodian, reviewer, adjudicator, or release\s+auditor/i);
  assert.match(runbook, /not a\s+self-authenticating proof/i);
  assert.match(runbook, /independent release\s+auditor must verify the receipt origin/i);
  assert.match(runbook, /node scripts\/private-holdout-readiness\.mjs --evidence <secure-receipt-path>/);
  assert.match(runbook, /No unresolved disagreement is permitted/);
  assert.match(runbook, /authors cannot\s+self-attest E3/i);
  assert.doesNotMatch(runbook, /(?:\/Users\/|\/private\/var\/|file:\/\/|auth\.json|access[_-]?token|refresh[_-]?token|xox[baprs]-)/i);
});

test("v2 custody receipt binds repository disjointness, author non-access, and closed disagreements", () => {
  const valid = load(fixturePath);
  assert.deepEqual(benchmarkAssuranceEvidenceValidationErrors(valid), []);
  assert.equal(valid.accessPolicyDigest, sha256(path.join(boundaryRoot, "access-policy.v1.json")));
  assert.equal(valid.humanRubricDigest, sha256(path.join(boundaryRoot, "human-rubric.v1.json")));
  assert.equal(valid.disjointness.publicExposureDigest, sha256(path.join(boundaryRoot, "public-exposure.v1.json")));

  const variants = [
    ["author prompt access", (value) => { value.accessControl.candidateAuthorPromptAccess = "allowed"; }, /deny candidate-author private access/],
    ["repository overlap", (value) => { value.disjointness.repositoryDisjoint = false; }, /family and repository disjointness/],
    ["too few repositories", (value) => { value.disjointness.repositoryCount = 5; }, /repositoryCount must be at least 6/],
    ["unresolved disagreement", (value) => { value.calibration.resolvedDisagreementCount = 1; value.calibration.unresolvedDisagreementCount = 1; }, /record and resolve every sampled disagreement/],
    ["invented agreement", (value) => { value.calibration.agreement = 0.95; }, /agreement does not match/],
    ["raw private field", (value) => { value.privatePromptText = "SECRET-CANARY"; }, /unsupported field privatePromptText/]
  ];
  for (const [label, mutate, expected] of variants) {
    const value = structuredClone(valid);
    mutate(value);
    assert.match(benchmarkAssuranceEvidenceValidationErrors(value).join("; "), expected, label);
  }
});

test("private suite declaration requires the complete v2 digest boundary", () => {
  const hash = "a".repeat(64);
  const partial = {
    claimTier: "private-holdout", visibility: "external-private-holdout", familyDisjointSplit: true,
    evidenceManifest: "assurance.json", holdoutManifestDigest: hash, referenceSolutionDigest: hash,
    mutationReportDigest: hash, calibrationReportDigest: hash
  };
  const errors = benchmarkAssuranceValidationErrors(partial, 2).join("; ");
  assert.match(errors, /family and repository disjointness/);
  assert.match(errors, /accessPolicyDigest/);
  assert.match(errors, /disjointnessReportDigest/);
  assert.match(errors, /humanRubricDigest/);
  assert.match(errors, /disagreementReportDigest/);
});

test("custodian CLI emits a redacted readiness receipt and never the private input path", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "SECRET-HOLDOUT-CANARY-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const evidence = load(fixturePath);
  evidence.accessControl.issuedAt = new Date(Date.now() - 60_000).toISOString();
  evidence.accessControl.expiresAt = new Date(Date.now() + 60_000).toISOString();
  const evidencePath = path.join(directory, "private-assurance.json");
  fs.writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`, { mode: 0o600 });
  const result = spawnSync(process.execPath, [script, "--evidence", evidencePath], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.ready, true);
  assert.equal(receipt.access.candidateAuthorAccessDenied, true);
  assert.equal(receipt.disjointness.repositoryCount, 6);
  assert.equal(receipt.humanCalibration.disagreementCount, 2);
  assert.equal(receipt.humanCalibration.resolvedDisagreementCount, 2);
  assert.doesNotMatch(result.stdout, /SECRET-HOLDOUT-CANARY|private-assurance\.json|\/tmp\//);

  const rawLeak = structuredClone(evidence);
  rawLeak.privatePromptText = "DO-NOT-PRINT-THIS";
  fs.writeFileSync(evidencePath, `${JSON.stringify(rawLeak)}\n`, { mode: 0o600 });
  const refused = spawnSync(process.execPath, [script, "--evidence", evidencePath], { cwd: root, encoding: "utf8" });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /unsupported field privatePromptText/);
  assert.doesNotMatch(refused.stderr, /DO-NOT-PRINT-THIS|SECRET-HOLDOUT-CANARY|private-assurance\.json/);
});

test("legacy assurance remains parseable but is explicitly refused for E3 readiness", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "piagent-legacy-assurance-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const legacy = {
    schemaVersion: 1, claimTier: "private-holdout", visibility: "external-private-holdout", familyDisjointSplit: true,
    holdoutManifestDigest: "1".repeat(64), referenceSolutionDigest: "2".repeat(64), mutationReportDigest: "3".repeat(64), calibrationReportDigest: "4".repeat(64),
    referenceSolutions: { total: 1, passed: 1 }, mutationChecks: { total: 1, killed: 1 }, calibration: { sampleSize: 1, reviewerCount: 2, agreement: 1 }
  };
  assert.deepEqual(benchmarkAssuranceEvidenceValidationErrors(legacy), []);
  const target = path.join(directory, "legacy.json");
  fs.writeFileSync(target, `${JSON.stringify(legacy)}\n`);
  const result = spawnSync(process.execPath, [script, "--evidence", target], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /historical-only/);
});
