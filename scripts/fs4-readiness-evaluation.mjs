#!/usr/bin/env node
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateFs4Readiness } from "../packages/piagent-core/benchmark/fs4-readiness-gates.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let matrixPath = path.join(root, "evals", "fs4-readiness-matrix.v1.json");
let outputPath = path.join(root, "governance", "codex-first-product", "evidence", "fs4", "fs4-readiness-gate-report.v1.json");
let runTests = true;
for (let index = 2; index < process.argv.length; index += 1) {
  if (process.argv[index] === "--matrix" && process.argv[index + 1]) matrixPath = path.resolve(process.cwd(), process.argv[++index]);
  else if (process.argv[index] === "--output" && process.argv[index + 1]) outputPath = path.resolve(process.cwd(), process.argv[++index]);
  else if (process.argv[index] === "--skip-tests") runTests = false;
  else if (process.argv[index] === "--help") {
    process.stdout.write("Usage: node scripts/fs4-readiness-evaluation.mjs [--matrix path] [--output path] [--skip-tests]\n");
    process.exit(0);
  } else throw new Error(`Unknown or incomplete argument: ${process.argv[index]}`);
}

const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const readBytes = (relative) => fs.readFileSync(path.join(root, relative));
const readJson = (relative) => JSON.parse(readBytes(relative).toString("utf8"));
const matrixBytes = fs.readFileSync(matrixPath);
const matrix = JSON.parse(matrixBytes.toString("utf8"));
if (matrix.schemaVersion !== 1 || matrix.id !== "fs4-readiness-v1" || matrix.workItem !== "CF-FS4-05") throw new Error("FS4 readiness matrix identity is invalid");
if (!Array.isArray(matrix.artifacts) || matrix.artifacts.length < 10) throw new Error("FS4 readiness artifact set is incomplete");

const artifactManifest = matrix.artifacts.map((artifact) => {
  if (!/^[a-z0-9-]+$/.test(artifact.id) || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error(`Invalid artifact descriptor: ${artifact.id ?? "unknown"}`);
  const bytes = readBytes(artifact.path);
  const actual = digest(bytes);
  if (actual !== artifact.sha256) throw new Error(`Artifact digest mismatch: ${artifact.id}`);
  return { id: artifact.id, path: artifact.path, sha256: actual, bytes: bytes.byteLength };
});
const byId = new Map(matrix.artifacts.map((artifact) => [artifact.id, artifact]));
const artifactJson = (id) => readJson(byId.get(id).path);
const core = artifactJson("e0-core-suite");
const production = artifactJson("e1-public-suite");
const e2Suite = artifactJson("e2-suite");
const reference = artifactJson("e2-reference");
const mutation = artifactJson("e2-mutation");
const alternative = artifactJson("e2-alternative");
const scope = artifactJson("e2-scope");
const sensitivity = artifactJson("e2-sensitivity");
const longReport = artifactJson("long-report");
const accessPolicy = artifactJson("e3-access-policy");
const humanRubric = artifactJson("e3-human-rubric");
const runbook = readBytes(byId.get("e3-runbook").path).toString("utf8");

function executeTestGroup(id, files) {
  const fileDigests = Object.fromEntries(files.map((file) => [file, digest(readBytes(file))]));
  if (!runTests) return { id, files, fileDigests, passed: false, skipped: true, testsPassed: 0, testsFailed: 0, durationMs: 0 };
  const started = performance.now();
  const result = spawnSync(process.execPath, ["--test", ...files], {
    cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PI_OFFLINE: "1", PIAGENT_NO_UPDATE_CHECK: "1" }
  });
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return {
    id, files, fileDigests, passed: result.status === 0, skipped: false,
    testsPassed: Number(text.match(/ℹ pass (\d+)/)?.[1] ?? 0),
    testsFailed: Number(text.match(/ℹ fail (\d+)/)?.[1] ?? (result.status === 0 ? 0 : 1)),
    durationMs: Number((performance.now() - started).toFixed(3))
  };
}
const testGroups = Object.fromEntries(Object.entries(matrix.deterministicTests).map(([id, files]) => [id, executeTestGroup(id, files)]));
const evaluation = evaluateFs4Readiness({
  artifactBindingsCurrent: true,
  e0: { testsPassed: testGroups.e0.passed, suiteId: core.id, scenarioCount: core.scenarios?.length },
  e1: {
    testsPassed: testGroups.e1.passed, suiteId: production.id, scenarioCount: production.scenarios?.length,
    defaultRepeats: production.defaultRepeats, claimTier: production.assurance?.claimTier,
    generatedVariants: production.assurance?.generatedVariants, familyDisjointSplit: production.assurance?.familyDisjointSplit,
    reviewed: production.assurance?.reviewed
  },
  e2: {
    testsPassed: testGroups.e2.passed, suiteId: e2Suite.id, scenarioCount: e2Suite.scenarios?.length, claimTier: e2Suite.assurance?.claimTier,
    referenceCount: reference.scenarioCount, referenceScore: reference.expectedScore,
    mutationCount: mutation.mutationCount, mutationsKilled: mutation.expectedKilled,
    alternativeCount: alternative.scenarioCount, alternativeScore: alternative.expectedScore, structurallyDistinct: alternative.structurallyDistinct,
    scopeCount: scope.scenarioCount, outsideScopeExpected: scope.outsideScopeExpected, vendorMutationAllowed: scope.vendorMutationAllowed,
    rubricChecks: sensitivity.rubricCheckCount, seededExpectedPassing: sensitivity.seededExpectedPassing,
    referenceExpectedPassing: sensitivity.referenceExpectedPassing, alternativeExpectedPassing: sensitivity.alternativeExpectedPassing
  },
  longHorizon: {
    testsPassed: testGroups.longHorizon.passed, providerUsed: longReport.providerUsed, wallClockMinutes: longReport.wallClockMinutes,
    wallClockQualified: longReport.wallClockQualified, completedFromResume: longReport.completedFromResume,
    hardCrashes: longReport.lifecycle?.hardCrashes, processStarts: longReport.lifecycle?.processStarts,
    compactions: longReport.lifecycle?.compactions, handoffReadback: longReport.lifecycle?.handoffReadback,
    continuationConsumed: longReport.continuation?.consumed, continuationMaximum: longReport.continuation?.maximum,
    secondContinuationAllowed: longReport.continuation?.secondAllowed, contextWithinCeiling: longReport.context?.withinCeiling,
    stateWithinCeiling: longReport.stateGrowth?.withinCeiling, stableCurrentTree: longReport.verification?.stableCurrentTree,
    verifierExitCode: longReport.verification?.exitCode
  },
  e3: {
    testsPassed: testGroups.e3.passed, localProtocolVerified: accessPolicy.id === "e3-custody-v1",
    externalInputState: accessPolicy.state === "external-input-required" ? "not-present-and-not-fabricated" : accessPolicy.state,
    selfAttestationAllowed: !/cannot\s+self-attest E3/i.test(runbook),
    operatorAccess: accessPolicy.preFreezeAccess?.operatorAccess,
    authorPromptAccess: accessPolicy.preFreezeAccess?.candidateAuthorPromptAccess,
    authorGraderAccess: accessPolicy.preFreezeAccess?.candidateAuthorGraderAccess,
    authorRepositoryAccess: accessPolicy.preFreezeAccess?.candidateAuthorRepositoryAccess,
    minimumItems: humanRubric.sample?.minimumItems, minimumFamilies: humanRubric.sample?.minimumFamilies,
    minimumReviewers: humanRubric.sample?.minimumReviewers, unresolvedAllowed: humanRubric.disagreement?.unresolvedAllowedForClaim,
    executionStatus: matrix.externalE3?.executionStatus,
    sealedCustodianReceiptPresent: matrix.externalE3?.sealedCustodianReceiptPresent,
    humanCalibrationRecorded: matrix.externalE3?.humanCalibrationRecorded,
    custodyOriginVerified: matrix.externalE3?.custodyOriginVerified,
    privateHoldoutReady: false
  }
});

const report = {
  schemaVersion: 1,
  reportVersion: "fs4-readiness-review-v1",
  generatedAt: new Date().toISOString(),
  workItem: "CF-FS4-05",
  matrix: { path: path.relative(root, matrixPath), sha256: digest(matrixBytes), artifactManifestSha256: digest(JSON.stringify(artifactManifest)), artifacts: artifactManifest },
  tests: Object.values(testGroups),
  evaluation,
  claimBoundary: matrix.claimBoundary,
  authorization: { providerExecution: false, privateHoldoutExecution: false, releaseAction: false },
  handoff: {
    nextLocalWorkItem: evaluation.fs5ProtocolPreparationAllowed ? "CF-FS5-01" : "CF-FS4-05",
    externalE3ExecutionWorkItem: "CF-FS7-01",
    disposition: evaluation.status
  }
};
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o644 });
fs.chmodSync(outputPath, 0o644);
process.stdout.write(`${JSON.stringify({ output: path.relative(root, outputPath), status: evaluation.status, fs4ExitPassed: evaluation.fs4ExitPassed, nextLocalWorkItem: report.handoff.nextLocalWorkItem }, null, 2)}\n`);
if (!evaluation.readinessReviewPassed) process.exit(1);
