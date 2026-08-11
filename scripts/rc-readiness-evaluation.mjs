#!/usr/bin/env node
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateExecPolicyCore } from "../packages/piagent-core/extensions/policy-core.js";
import { evaluateRcLocalGates } from "../packages/piagent-core/benchmark/rc-readiness-gates.js";
import { evaluateFsReleaseTransition } from "../packages/piagent-core/benchmark/fs-release-transition.js";
import { solveTaskFeatures } from "../packages/piagent-core/runtime/solver/solver-policy.ts";
import { extractTaskFeatures } from "../packages/piagent-core/runtime/solver/task-features.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const matrixPath = path.join(root, "evals", "rc-evaluation-matrix.v1.json");
const matrix = JSON.parse(fs.readFileSync(matrixPath, "utf8"));
const transitionBytes = fs.readFileSync(path.join(root, matrix.transitionContract.path));
const transition = JSON.parse(transitionBytes);
if (digestBytes(transitionBytes) !== matrix.transitionContract.sha256) throw new Error("FS release transition digest mismatch");
const transitionGate = evaluateFsReleaseTransition(transition);
if (transitionGate.status !== "passed") throw new Error(`FS release transition invalid: ${transitionGate.errors.join("; ")}`);
const outputIndex = process.argv.indexOf("--output");
const output = outputIndex >= 0 && process.argv[outputIndex + 1]
  ? path.resolve(process.cwd(), process.argv[outputIndex + 1])
  : path.join(root, "plans", "codex-first-product", "evidence", "p7-local-readiness", "report.json");

function digestBytes(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function digestFile(relative) { return digestBytes(fs.readFileSync(path.join(root, relative))); }
function candidateDigest() {
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root })
    .toString("utf8").split("\0").filter(Boolean).sort();
  const hash = crypto.createHash("sha256");
  for (const relative of files) {
    const absolute = path.join(root, relative); const stat = fs.lstatSync(absolute);
    hash.update(relative).update("\0");
    hash.update(stat.isSymbolicLink() ? fs.readlinkSync(absolute) : fs.readFileSync(absolute));
    hash.update("\0");
  }
  return { digest: hash.digest("hex"), files: files.length };
}
function runTests(id, files) {
  const started = performance.now();
  const result = spawnSync(process.execPath, ["--test", ...files], {
    cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, PIAGENT_NO_UPDATE_CHECK: "1", PI_OFFLINE: "1" }
  });
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return {
    id, command: `node --test ${files.join(" ")}`, passed: result.status === 0,
    durationMs: Number((performance.now() - started).toFixed(3)),
    testsPassed: Number(text.match(/ℹ pass (\d+)/)?.[1] ?? 0),
    testsFailed: Number(text.match(/ℹ fail (\d+)/)?.[1] ?? (result.status === 0 ? 0 : 1))
  };
}
function p95(values) { return values.sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * 0.95) - 1)] ?? null; }
function benchmarkPolicy() {
  const policy = JSON.parse(fs.readFileSync(path.join(root, "packages/piagent-core/policies/base-policy.json"), "utf8"));
  const commands = ["npm test", "git push origin feature", "cat .env", "rm -rf /", "git add .", "docker volume prune", "bash -lc 'cat src/a.ts'", "terraform apply"];
  const samples = [];
  for (let repeat = 0; repeat < 500; repeat += 1) for (const command of commands) {
    const started = performance.now(); evaluateExecPolicyCore(command, { policy, mode: "enforce" }); samples.push(performance.now() - started);
  }
  return { samples: samples.length, p95Ms: Number(p95(samples).toFixed(6)), ceilingMs: 20 };
}
function benchmarkRoutes() {
  const corpus = JSON.parse(fs.readFileSync(path.join(root, "benchmarks/solver-v1/route-corpus.json"), "utf8"));
  const samples = [];
  for (let repeat = 0; repeat < 40; repeat += 1) for (const item of corpus.adversarialCases) {
    const started = performance.now();
    solveTaskFeatures(extractTaskFeatures({ ...corpus.defaults, ...item.overrides, request: item.request }));
    samples.push(performance.now() - started);
  }
  return { samples: samples.length, p95Ms: Number(p95(samples).toFixed(6)), ceilingMs: 50 };
}
function loadEvidenceInput(item) {
  const bytes = fs.readFileSync(path.join(root, item.path));
  const sha256 = digestBytes(bytes);
  if (item.sha256 !== sha256) throw new Error(`Evidence digest mismatch for ${item.id}: ${item.path}`);
  return {
    manifest: { id: item.id, path: item.path, sha256, bytes: bytes.byteLength },
    report: JSON.parse(bytes.toString("utf8"))
  };
}
function privacyScan(reports) {
  const forbiddenKeys = new Set(["rawPrompt", "rawRequest", "promptText", "sourceText", "childOutput", "credential", "oauthToken", "apiKey", "authorization"]);
  const findings = [];
  function walk(value, location) {
    if (Array.isArray(value)) return value.forEach((item, index) => walk(item, `${location}[${index}]`));
    if (!value || typeof value !== "object") {
      if (typeof value === "string" && /(?:sk-proj-|ghp_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{20,})/.test(value)) findings.push(`${location}:secret-pattern`);
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      if (forbiddenKeys.has(key) && item !== null && item !== false && item !== "") findings.push(`${location}.${key}:raw-field`);
      walk(item, `${location}.${key}`);
    }
  }
  reports.forEach((report, index) => walk(report, `report${index + 1}`));
  return { reportsScanned: reports.length, findings, passed: findings.length === 0 };
}

const testGroups = [
  runTests("quality-routing", ["tests/benchmark-core.test.mjs", "tests/solver-route-corpus.test.mjs", "tests/solver-shadow-pilot.test.mjs", "tests/operator-product-ux.test.mjs", "tests/rc-evaluation-matrix.test.mjs", "tests/rc-readiness-gates.test.mjs"]),
  runTests("safety-privacy", ["tests/golden-enforcement.test.mjs", "tests/guard-shell-analysis.test.mjs", "tests/policy-shell-differential.test.mjs", "tests/redaction-core.test.mjs", "tests/mcp-approval-gate.test.mjs", "tests/role-policy-binder.test.mjs", "tests/subagent-policy.test.mjs"]),
  runTests("reliability", ["tests/recovery-chaos.test.mjs", "tests/resume-state.test.mjs", "tests/trajectory-runtime.test.mjs", "tests/owned-work-budget.test.mjs", "tests/state-retention.test.mjs", "tests/local-state-failure-modes.test.mjs"]),
  runTests("install-migration-rollback", ["tests/install-global.test.mjs", "tests/update-global.test.mjs", "tests/global-update.test.mjs", "tests/migrate-project-state.test.mjs", "tests/uninstall-global.test.mjs", "tests/package-distribution.test.mjs", "tests/package-install-rollback.test.mjs", "tests/release-identity.test.mjs"])
];
const loadedEvidence = matrix.evidenceInputs.map(loadEvidenceInput);
const evidenceFiles = loadedEvidence.map((item) => item.manifest);
const evidenceManifest = {
  digest: digestBytes(JSON.stringify(evidenceFiles)),
  files: evidenceFiles
};
const evidence = loadedEvidence.map((item) => item.report);
const [baseline, solverPilot, phaseTools, recovery, helpers, usability] = evidence;
const privacy = privacyScan(evidence);
const policyPerformance = benchmarkPolicy();
const routePerformance = benchmarkRoutes();
const modelResult = spawnSync(process.execPath, [path.join(root, "scripts/model-catalog.mjs"), "--json"], { cwd: root, encoding: "utf8" });
let modelCatalog = { availability: "unavailable", models: [], warnings: ["catalog command failed"] };
try { if (modelResult.status === 0) modelCatalog = JSON.parse(modelResult.stdout); } catch {}
const candidate = candidateDigest();
const currentPlatform = `${process.platform}-${process.arch}`;
const allLocalTestsPassed = testGroups.every((group) => group.passed);
const localPerformancePassed = policyPerformance.p95Ms < policyPerformance.ceilingMs && routePerformance.p95Ms < routePerformance.ceilingMs;
const localGate = evaluateRcLocalGates({
  allLocalTestsPassed,
  localPerformancePassed,
  privacyPassed: privacy.passed,
  routeCoverage: solverPilot.metrics.eligibleDecisionCoverage,
  routeRegret: solverPilot.metrics.routeRegret,
  safetyRouteFalseNegatives: solverPilot.metrics.safetyRouteFalseNegatives,
  helperBudgetViolations: helpers.metrics.budgetViolations,
  writerInvariantViolations: helpers.metrics.writerInvariantViolations,
  recoveryGatePassed: recovery.gatePassed,
  phaseToolGatePassed: phaseTools.gatePassed,
  hostBoundaryCovered: usability.localGate.hostBoundaryStringCovered
});
const matrixDigest = digestFile("evals/rc-evaluation-matrix.v1.json");
const evaluationInputDigest = digestBytes(JSON.stringify({ matrix: matrixDigest, transition: matrix.transitionContract.sha256, candidate: candidate.digest, evidence: evidenceManifest.digest }));

const report = {
  schemaVersion: 1,
  reportVersion: "rc-local-readiness-v1",
  generatedAt: new Date().toISOString(),
  matrix: {
    version: matrix.matrixVersion,
    digest: matrixDigest,
    evaluationInputDigest,
    repository: { head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), candidateContentDigest: candidate.digest, candidateFiles: candidate.files, cleanReleaseCommit: null },
    evidenceManifest,
    versions: matrix.versions,
    scenarioRevisions: matrix.scenarioRevisions.map((item) => ({ ...item, digest: digestFile(item.path) })),
    profiles: matrix.profiles.map((name) => ({ name, digest: digestFile(`adapters/${name}/profile.json`) })),
    modelCatalog: { source: modelCatalog.source ?? "authenticated-catalog", availability: modelCatalog.availability, modelCount: modelCatalog.models?.length ?? 0, digest: digestBytes(JSON.stringify((modelCatalog.models ?? []).map((item) => ({ provider: item.provider, modelId: item.modelId })).sort((a, b) => `${a.provider}/${a.modelId}`.localeCompare(`${b.provider}/${b.modelId}`)))), credentialMaterialRead: false },
    model: matrix.model,
    featureModes: matrix.featureModes,
    verifiers: matrix.verifiers,
    platforms: matrix.platforms.map((item) => ({ ...item, locallyObserved: item.id === currentPlatform })),
    grading: matrix.grading,
    transitionContract: { ...matrix.transitionContract, status: transitionGate.status },
    exclusions: ["no clean release commit", "no 1.3.0 RC package", "no independent human pilot", "no maintainer/internal/opt-in cohorts", "linux-x64 not executed on this darwin-arm64 host", "no new authenticated paired model benchmark", "no publish/tag/push/provider configuration"]
  },
  tests: testGroups,
  gates: {
    qualityRouting: {
      status: "pending-controlled-candidate-benchmark",
      localDeterministicPassed: testGroups[0].passed && localGate.checks["route-coverage"] && localGate.checks["route-regret"] && localGate.checks["safety-route-false-negatives"],
      baselineQualityGate: baseline.comparison?.qualityGate === true,
      baselineTokenClaimAllowed: baseline.comparison?.tokenClaimAllowed === true,
      routeCoverage: solverPilot.metrics.eligibleDecisionCoverage,
      routeRegret: solverPilot.metrics.routeRegret,
      safetyRouteFalseNegatives: solverPilot.metrics.safetyRouteFalseNegatives,
      currentCandidateExactQualityComparison: null
    },
    safetyPrivacy: {
      status: testGroups[1].passed && localGate.checks["privacy-scan"] && localGate.checks["safety-route-false-negatives"] && localGate.checks["helper-budget-violations"] && localGate.checks["writer-invariant-violations"] && localGate.checks["host-boundary-coverage"] ? "passed-local" : "failed-local",
      goldenAndAdversarialPassed: testGroups[1].passed,
      telemetryPrivacy: privacy,
      hostBoundaryCovered: usability.localGate.hostBoundaryStringCovered,
      helperBudgetViolations: helpers.metrics.budgetViolations,
      writerInvariantViolations: helpers.metrics.writerInvariantViolations
    },
    reliabilityPerformance: {
      status: testGroups[2].passed && localGate.checks["performance-ceilings"] && localGate.checks["recovery-gate"] && localGate.checks["phase-tool-gate"] ? "passed-local-current-platform" : "failed-local",
      interruptionAndResumePassed: testGroups[2].passed,
      recoveryGate: recovery.gatePassed,
      phaseToolGate: phaseTools.gatePassed === true,
      policyPerformance,
      routePerformance,
      boundedStateGrowthCoveredByTests: true,
      linuxX64Observed: currentPlatform === "linux-x64"
    },
    installMigrationRollback: {
      status: testGroups[3].passed ? "passed-disposable-fixtures-rc-package-pending" : "failed-local",
      fixtureTestsPassed: testGroups[3].passed,
      rcPackageBuilt: false,
      stableTagIdentity: null,
      actualPublishedRollbackRehearsal: false
    },
    usability: {
      status: usability.humanExitGate.status,
      scriptedFixtures: usability.localGate.fixturesPassed,
      independentHumans: usability.participantDisclosure.independentHumanParticipants,
      humanTiming: null,
      humanComprehension: null
    }
  },
  defaultDecision: {
    status: "frozen-local-safe-defaults-pending-ga-evidence",
    solver: { value: "shadow", candidate: "assist", reason: "117-decision shadow evidence exists; Cohorts A-C and candidate benchmark do not." },
    phaseTools: { value: "shadow", candidate: "on", reason: "Deterministic local gate exists; controlled cross-project cohorts do not." },
    recovery: { value: "on", candidate: "on", reason: "Bounded recovery and feature-off chaos gates pass; operator can set off." },
    helpers: { value: "recommend", candidate: "recommend", reason: "Local retrieval improves, but no provider-backed beta evidence authorizes automatic dispatch." },
    parentRouting: { value: "off", candidate: "off", reason: "Parent remains user-pinned." },
    executionBackend: { value: "host", candidate: "host", reason: "No isolation adapter is installed; host execution is not a sandbox." },
    automaticWorkerDelegation: "off"
  },
  cohorts: {
    maintainers: { required: "20-30 controlled tasks", observed: 0 },
    internalProjects: { required: "100 attempts / 5 profiles", observed: 0 },
    optInBeta: { required: "200 terminal / 30 high-risk / 30 recovery", observed: 0 }
  },
  readiness: {
    localSafeGate: localGate.status,
    rcAssembly: transitionGate.rcAssemblyAllowed ? "allowed-local-not-built" : "blocked",
    beta: "blocked-pending-exact-rc-migration-gate",
    localGateChecks: localGate.checks,
    failedLocalGateChecks: localGate.failedChecks,
    localGateThresholds: localGate.thresholds,
    gaRelease: "blocked",
    blockers: ["clean approved release commit missing", "1.3.0 RC package missing", "exact-RC three-pair Migration gate missing", "controlled cohorts A-C not run", "independent five-person usability pilot not run", "linux-x64 candidate run missing", "authenticated candidate benchmark comparison missing", "explicit operator release approval missing"]
  },
  authorization: { rcAssembly: true, providerExecution: false, cohortExecution: false, releaseCommit: false, tag: false, publish: false, push: false, docsPromotion: false, providerConfiguration: false }
};

fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ output: path.relative(root, output), localSafeGate: report.readiness.localSafeGate, gaRelease: report.readiness.gaRelease, blockers: report.readiness.blockers }, null, 2));
if (report.readiness.localSafeGate !== "passed") process.exit(1);
