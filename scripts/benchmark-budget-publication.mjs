import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { benchmarkBudgetDigest } from "../packages/piagent-core/benchmark/benchmark-budget-governor.js";
import { openProductionBenchmarkCampaign, productionCampaignExpectedAttempts,
  publicProductionBenchmarkCampaignEvidence } from "../packages/piagent-core/benchmark/benchmark-campaign.js";
import { inspectBenchmarkLedger } from "../packages/piagent-core/benchmark/benchmark-ledger.js";
import { writeBenchmarkRunManifest, writePrivateAtomic } from "../packages/piagent-core/benchmark/benchmark-forensics.js";
import { benchmarkTrustChecklist } from "../packages/piagent-core/benchmark/benchmark-matrix.js";
import { renderBenchmarkText, renderBenchmarkHtml, renderBenchmarkMarkdown } from "../packages/piagent-core/benchmark/benchmark-report.js";
import { acquireBenchmarkRunLock } from "../packages/piagent-core/benchmark/benchmark-run-lock.js";
import { BENCHMARK_BUDGET_CONTEXT, assertBenchmarkBudgetPolicyUnchanged } from "./benchmark-budget-runtime.mjs";

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const same = (a, b) => benchmarkBudgetDigest(a) === benchmarkBudgetDigest(b);
const thresholds = new Set(["session-cap", "fresh-token-threshold", "active-wall-threshold"]);
const fields = ["input", "output", "cacheRead", "cacheWrite", "reasoning", "fresh", "total"];
function fail(message) {
  throw Object.assign(new Error(`Benchmark budget publication: ${message}`), { code: "BENCHMARK_BUDGET_PUBLICATION_DENIED", exitCode: 1 });
}
function read(file) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    if (!fs.fstatSync(descriptor).isFile()) fail("receipt or evidence must be a regular file");
    const raw = fs.readFileSync(descriptor); return { value: JSON.parse(raw), sha256: hash(raw) };
  } finally { fs.closeSync(descriptor); }
}
function receiptPath(identity, stageId, suffix = "json") {
  if (!/^[a-f0-9]{32}$/.test(stageId ?? "")) fail("invalid launcher stage identity");
  const root = `${identity.statePath}.launcher-receipts`;
  if (fs.existsSync(root) && (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink())) fail("receipt directory is not canonical");
  return path.join(root, `${stageId}.${suffix}`);
}
function writeNew(file, value) {
  if (fs.existsSync(file)) fail("receipt already exists; refusing favorable regeneration");
  writePrivateAtomic(file, json(value));
}
function readState(control) {
  const envelope = read(control.identity.statePath).value;
  if (envelope.schemaVersion !== 1 || envelope.stateDigest !== benchmarkBudgetDigest(envelope.state)
    || !same(envelope.state.policy, control.policy) || !same(envelope.state.binding, control.binding)
    || envelope.state.policyDigest !== benchmarkBudgetDigest(control.policy)
    || envelope.state.bindingDigest !== benchmarkBudgetDigest(control.binding)) fail("state identity or integrity mismatch");
  return envelope;
}
function stageProof(state, stageId) {
  const index = state.stages.findIndex(stage => stage.stageId === stageId);
  if (index < 0) fail("stage missing from budget state");
  const ids = new Set(state.stages.slice(0, index + 1).map(stage => stage.stageId));
  const prefix = state.attempts.filter(attempt => ids.has(attempt.stageId));
  return { stageDigest: benchmarkBudgetDigest(state.stages[index]), attemptPrefixDigest: benchmarkBudgetDigest(prefix), attemptCount: prefix.length };
}

// A closed governor stage alone is not evidence that its parent completed cleanup.
// A crash after endStage but before the receipt stays fail-closed on later resume.
export function assertBenchmarkBudgetParentReceipts(control) {
  if (!control || !fs.existsSync(control.identity.statePath)) return;
  const { state } = readState(control);
  for (const stage of state.stages) {
    if (stage.status !== "closed") fail("prior launcher stage lacks a closed parent receipt");
    let receipt;
    try { receipt = read(receiptPath(control.identity, stage.stageId)).value; }
    catch { fail("prior launcher-final receipt is missing or corrupt"); }
    if (receipt.kind !== "benchmark-launcher-final-v1" || receipt.closureAllowed !== true
      || !same(receipt.budgetIdentity, control.identity) || receipt.policyDigest !== state.policyDigest
      || receipt.bindingDigest !== state.bindingDigest || !same(receipt.stageProof, stageProof(state, stage.stageId))) {
      fail("prior launcher-final receipt is failed or belongs to a different stage identity");
    }
  }
}

function withhold(report, reason) {
  report.comparison.tokenClaimAllowed = false;
  report.comparison.tokenClaimUnavailableReason = reason;
  if (report.goalAssessment) {
    report.goalAssessment.claimAllowed = false;
    if (report.goalAssessment.status === "GOAL_PASS") report.goalAssessment.status = "GOAL_CLAIM_WITHHELD";
    report.goalAssessment.claimFailures = [...new Set([...(report.goalAssessment.claimFailures ?? []), reason])];
  }
}

// Called only after measurement adjudication. It never alters the verdict or observed metrics.
export function deferBenchmarkBudgetPublication({ report, manifest, runRoot,
  expectedChildExitCode = process.exitCode ?? 0,
  stageId = JSON.parse(process.env[BENCHMARK_BUDGET_CONTEXT] ?? "null")?.stageId }) {
  if (!manifest.budgetControl) return;
  if (path.resolve(runRoot) !== runRoot) fail("noncanonical report root");
  const identity = manifest.budgetControl;
  const checkpointPath = receiptPath(identity, stageId, "pending-report.json");
  const eligibility = { tokenClaimAllowed: report.comparison.tokenClaimAllowed === true,
    tokenClaimUnavailableReason: report.comparison.tokenClaimUnavailableReason ?? null,
    goal: report.goalAssessment ? { claimAllowed: report.goalAssessment.claimAllowed === true,
      status: report.goalAssessment.status, claimFailures: report.goalAssessment.claimFailures ?? [] } : null };
  report.publicationAuthorization = { schemaVersion: 1, status: "pending-launcher-finalization", allowed: false,
    stageId, policySha256: identity.sha256,
    explanation: "Measurement verdict and observed metrics are provisional; no claim until an identity-bound parent receipt confirms cleanup, exact usage, and policy continuity." };
  withhold(report, "pending-launcher-finalization");
  report.trustChecklist = benchmarkTrustChecklist(report);
  writeNew(checkpointPath, { schemaVersion: 1, kind: "benchmark-pending-publication-v1", stageId,
    budgetIdentity: identity, runRoot, runId: manifest.runId, configurationDigest: manifest.configurationDigest,
    reportSha256: hash(json(report)), manifestSha256: read(path.join(runRoot, "run-manifest.json")).sha256,
    expectedChildExitCode, eligibility });
}

function validateAccounting(control, stageId, accounting, state) {
  if (!accounting || accounting.launcherSucceeded !== true || accounting.launcherErrors?.length !== 0
    || accounting.processCleanup?.cleanupConfirmed !== true || accounting.usageComplete !== true
    || accounting.unknownAttempts !== 0 || accounting.inFlightAttempts !== 0 || accounting.activeWallTimeExact !== true
    || state.activeWallTimeExact !== true || state.stages.some(stage => stage.status !== "closed")
    || state.stages.at(-1)?.stageId !== stageId || state.attempts.some(attempt => attempt.status !== "exact")
    || state.stopReasons.some(reason => !thresholds.has(reason))) fail("launcher cleanup, policy, usage, or finalization is not valid");
  const tokens = Object.fromEntries(fields.map(field => [field, state.attempts.reduce((sum, attempt) => sum + attempt.usage[field], 0)]));
  const wall = state.stages.reduce((sum, stage) => sum + stage.elapsedMs, 0);
  if (!same(accounting.stages, state.stages) || !same(accounting.stopReasons, state.stopReasons)
    || accounting.policyDigest !== state.policyDigest || accounting.bindingDigest !== state.bindingDigest
    || accounting.providerStartedAttempts !== state.attempts.length || accounting.exactAttempts !== state.attempts.length
    || accounting.freshTokens !== tokens.fresh || !same(accounting.knownExactTokens, tokens)
    || accounting.activeWallTimeMs !== wall || !same(accounting.overshoot, {
      freshTokens: Math.max(0, tokens.fresh - control.policy.freshTokenThreshold),
      activeWallTimeMs: Math.max(0, wall - control.policy.activeWallTimeMsThreshold) })) fail("final accounting differs from durable budget state");
}

function pendingReport(control, stageId, state) {
  const checkpointFile = receiptPath(control.identity, stageId, "pending-report.json");
  const reportFile = path.join(control.binding.runRoot, "report.json");
  if (!fs.existsSync(checkpointFile) && !fs.existsSync(reportFile)) return null;
  const pending = read(checkpointFile).value, reportData = read(reportFile);
  const manifestData = read(path.join(control.binding.runRoot, "run-manifest.json"));
  const report = reportData.value, manifest = manifestData.value;
  const ledger = inspectBenchmarkLedger(path.join(control.binding.runRoot, "runs.jsonl"));
  const order = manifest.order.map((item, index) => ({ orderIndex: index + 1, ...item }));
  if (pending.kind !== "benchmark-pending-publication-v1" || pending.stageId !== stageId
    || !same(pending.budgetIdentity, control.identity) || !same(manifest.budgetControl, control.identity)
    || pending.runRoot !== control.binding.runRoot || pending.runId !== manifest.runId || report.runId !== manifest.runId
    || pending.reportSha256 !== reportData.sha256 || pending.manifestSha256 !== manifestData.sha256
    || pending.configurationDigest !== manifest.configurationDigest || report.environment.configurationDigest !== manifest.configurationDigest
    || manifest.candidateProvenance?.contentDigest !== control.binding.candidateDigest
    || report.environment.candidateProvenance?.contentDigest !== control.binding.candidateDigest
    || manifest.suiteDigest !== control.binding.suiteDigest || report.environment.suiteDigest !== control.binding.suiteDigest
    || !same(order, control.binding.plannedAttempts) || !same(manifest.ledger, ledger.binding)
    || !same(report.ledger, ledger.binding) || !same(report.runs, ledger.records)
    || state.attempts.length !== order.length || !same(productionCampaignExpectedAttempts(report.runs), state.attempts.map(attempt => {
      const { attemptId, orderIndex, scenarioId, surface, repeat, infrastructureAttempt } = attempt;
      return { attemptId, orderIndex, scenarioId, surface, repeat, infrastructureAttempt };
    })) || report.runs.some((run, index) => fields.some(field => run.usage?.[field] !== state.attempts[index].usage?.[field]))
    || report.publicationAuthorization?.stageId !== stageId || report.publicationAuthorization?.allowed !== false
    || report.comparison.tokenClaimAllowed !== false || report.goalAssessment?.claimAllowed === true) fail("pending report is not the exact verified core publication");
  return { pending, report, manifest };
}

function publish(control, receipt, publication) {
  const { report, manifest, pending } = publication, root = control.binding.runRoot;
  const allowed = receipt.publicationAllowed;
  let campaign;
  try {
    if (manifest.campaign) {
      const binding = manifest.campaign;
      campaign = openProductionBenchmarkCampaign({ registryBase: path.dirname(path.dirname(binding.campaignRoot)),
        ...binding, existingBinding: binding });
      campaign.sealForClaim(report.runs);
      manifest.campaignEvidence = campaign.finalizeClaim({ allowed,
        reason: `launcher-final-receipt:${benchmarkBudgetDigest(receipt)}:${allowed ? "release-token-claim-allowed" : "no-claim"}` });
      writeBenchmarkRunManifest(root, manifest);
      report.environment.campaignEvidence = publicProductionBenchmarkCampaignEvidence(manifest.campaignEvidence);
      report.comparison.campaignEvidence = report.environment.campaignEvidence;
    }
    report.publicationAuthorization = { schemaVersion: 1, status: receipt.closureAllowed ? "launcher-finalized" : "launcher-finalization-failed",
      allowed, stageId: receipt.stageId, policySha256: control.identity.sha256,
      launcherReceiptDigest: benchmarkBudgetDigest(receipt), failures: receipt.failures,
      managementThresholdOvershoot: receipt.accounting?.overshoot ?? null,
      explanation: "Measurement verdict and observed metrics are unchanged. Claim authorization requires the durable exact-report launcher receipt; management-threshold overshoot is disclosed, not a hard-cap guarantee." };
    if (allowed) {
      report.comparison.tokenClaimAllowed = true;
      if (pending.eligibility.tokenClaimUnavailableReason === null) delete report.comparison.tokenClaimUnavailableReason;
      else report.comparison.tokenClaimUnavailableReason = pending.eligibility.tokenClaimUnavailableReason;
    } else withhold(report, receipt.closureAllowed ? "original-measurement-claim-not-eligible" : "launcher-finalization-failed");
    if (report.goalAssessment && receipt.closureAllowed) {
      Object.assign(report.goalAssessment, pending.eligibility.goal, { claimAllowed: allowed && pending.eligibility.goal?.claimAllowed === true });
      if (!report.goalAssessment.claimAllowed && report.goalAssessment.status === "GOAL_PASS") report.goalAssessment.status = "GOAL_CLAIM_WITHHELD";
    }
    report.trustChecklist = benchmarkTrustChecklist(report);
    writePrivateAtomic(path.join(root, "report.html"), renderBenchmarkHtml(report));
    writePrivateAtomic(path.join(root, "report.md"), renderBenchmarkMarkdown(report));
    writePrivateAtomic(path.join(root, "summary.txt"), renderBenchmarkText(report));
    writePrivateAtomic(path.join(root, "report.json"), json(report));
  } catch (error) {
    if (campaign) {
      manifest.campaignEvidence = campaign.invalidateClaimPublication({ reason: "launcher-publication-failed" });
      writeBenchmarkRunManifest(root, manifest);
    }
    // Remove only publication files from this exact run; retained ledgers/checkpoints remain intact.
    for (const name of ["report.html", "report.md", "summary.txt", "report.json"]) {
      try { fs.rmSync(path.join(root, name), { force: true }); } catch { /* Receipt/campaign still prevents unsupported promotion. */ }
    }
    throw error;
  } finally { campaign?.close(); }
}

export function finalizeBenchmarkBudgetPublication({ control, stageId, launcherReceipt,
  childExitCode, outerSucceeded, outerErrorCodes = [] }) {
  const file = receiptPath(control.identity, stageId);
  if (fs.existsSync(file)) fail("launcher-final receipt already exists");
  const release = acquireBenchmarkRunLock(`${control.identity.statePath}.guard`, benchmarkBudgetDigest(control.binding));
  try {
    const failures = [...outerErrorCodes];
    if (outerSucceeded !== true || ![0, 1].includes(childExitCode)) failures.push("outer-launcher-incomplete");
    let envelope, publication = null;
    try {
      envelope = readState(control);
      assertBenchmarkBudgetPolicyUnchanged(control);
      validateAccounting(control, stageId, launcherReceipt, envelope.state);
      publication = pendingReport(control, stageId, envelope.state);
      if (publication && childExitCode !== publication.pending.expectedChildExitCode) fail("child exit differs from adjudicated result; late core cleanup may have failed");
      if (!publication && childExitCode !== 0) fail("a stage without an adjudicated report must have a successful core exit");
    } catch (error) { failures.push(error.message); }
    const closureAllowed = failures.length === 0;
    const receipt = { schemaVersion: 1, kind: "benchmark-launcher-final-v1", stageId,
      budgetIdentity: control.identity, policyDigest: benchmarkBudgetDigest(control.policy), bindingDigest: benchmarkBudgetDigest(control.binding),
      stateDigest: envelope?.stateDigest ?? null, stageProof: envelope ? stageProof(envelope.state, stageId) : null,
      closureAllowed, publicationAllowed: closureAllowed && publication?.pending.eligibility.tokenClaimAllowed === true,
      pendingReportSha256: publication?.pending.reportSha256 ?? null, childExitCode, failures,
      accounting: launcherReceipt ?? null };
    writeNew(file, receipt); // Durable and identity-bound BEFORE any favorable campaign/report transition.
    if (publication) publish(control, receipt, publication);
    return receipt;
  } finally { release(); }
}
