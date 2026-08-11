#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { benchmarkAssuranceEvidenceValidationErrors } from "../packages/piagent-core/benchmark/benchmark-assurance.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const usage = "Usage: node scripts/private-holdout-readiness.mjs --evidence /secure/path/assurance.json";

function digestFile(relativePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(path.join(root, relativePath))).digest("hex");
}

function refuse(message) {
  process.stderr.write(`REFUSED: ${message}\n`);
  process.exit(1);
}

let evidencePath = null;
for (let index = 2; index < process.argv.length; index += 1) {
  const value = process.argv[index];
  if (value === "--help" || value === "-h") {
    process.stdout.write(`${usage}\n`);
    process.exit(0);
  }
  if (value === "--evidence" && process.argv[index + 1]) {
    evidencePath = process.argv[index + 1];
    index += 1;
    continue;
  }
  refuse("unknown or incomplete argument");
}
if (!evidencePath) refuse("--evidence is required");

let buffer;
let evidence;
try {
  buffer = fs.readFileSync(evidencePath);
  evidence = JSON.parse(buffer.toString("utf8"));
} catch {
  refuse("assurance evidence is unreadable or invalid JSON");
}
const errors = benchmarkAssuranceEvidenceValidationErrors(evidence);
if (errors.length > 0) refuse(errors.join("; "));
if (evidence.schemaVersion !== 2) refuse("legacy assurance evidence is historical-only and cannot establish E3 readiness");

const bindings = {
  accessPolicyDigest: digestFile("evals/private-holdout-v1/access-policy.v1.json"),
  humanRubricDigest: digestFile("evals/private-holdout-v1/human-rubric.v1.json"),
  taxonomyDigest: digestFile("evals/real-task-taxonomy.v1.json"),
  publicExposureDigest: digestFile("evals/private-holdout-v1/public-exposure.v1.json")
};
for (const [field, expected] of Object.entries(bindings)) {
  const actual = field in evidence ? evidence[field] : evidence.disjointness?.[field];
  if (actual !== expected) refuse(`${field} does not match the current public boundary`);
}
const now = Date.now();
if (now < Date.parse(evidence.accessControl.issuedAt) || now >= Date.parse(evidence.accessControl.expiresAt)) refuse("access receipt is not currently valid");

const receipt = {
  schemaVersion: 1,
  protocolVersion: "e3-custody-v1",
  ready: true,
  evidenceManifestDigest: crypto.createHash("sha256").update(buffer).digest("hex"),
  claimTier: evidence.claimTier,
  visibility: evidence.visibility,
  access: {
    candidateAuthorAccessDenied: true,
    operatorExecuteOnly: true,
    reviewerBlindedAndIndependent: true,
    issuedAt: evidence.accessControl.issuedAt,
    expiresAt: evidence.accessControl.expiresAt,
    accessLogDigest: evidence.accessControl.accessLogDigest
  },
  disjointness: {
    familyDisjoint: true,
    repositoryDisjoint: true,
    scenarioCount: evidence.disjointness.scenarioCount,
    familyCount: evidence.disjointness.familyCount,
    repositoryCount: evidence.disjointness.repositoryCount,
    reportDigest: evidence.disjointness.reportDigest
  },
  humanCalibration: {
    sampleSize: evidence.calibration.sampleSize,
    reviewerCount: evidence.calibration.reviewerCount,
    disagreementCount: evidence.calibration.disagreementCount,
    resolvedDisagreementCount: evidence.calibration.resolvedDisagreementCount,
    unresolvedDisagreementCount: evidence.calibration.unresolvedDisagreementCount,
    agreement: evidence.calibration.agreement,
    disagreementLogDigest: evidence.calibration.disagreementLogDigest
  },
  claimBoundary: "Readiness receipt only; an exact frozen candidate and the remaining FS5-FS7 gates are still required."
};
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
