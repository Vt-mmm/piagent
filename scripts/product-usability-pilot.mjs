#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutput = path.join(root, "plans", "codex-first-product", "evidence", "p6-usability-pilot", "report.json");
const outputIndex = process.argv.indexOf("--output");
const output = outputIndex >= 0 && process.argv[outputIndex + 1]
  ? path.resolve(process.cwd(), process.argv[outputIndex + 1])
  : defaultOutput;

const fixtures = [
  {
    id: "scripted-new-install-operator",
    tasks: ["install-preview", "doctor", "onboard-readiness"],
    tests: ["tests/install-global.test.mjs", "tests/product-doctor.test.mjs"]
  },
  {
    id: "scripted-upgrade-operator",
    tasks: ["update-preview", "rollback-preview", "preserve-settings"],
    tests: ["tests/update-global.test.mjs", "tests/global-update.test.mjs"]
  },
  {
    id: "scripted-daily-operator",
    tasks: ["read-only-preflight", "tiny-source-status", "receipt", "usage-report", "feature-off"],
    tests: ["tests/operator-product-ux.test.mjs", "tests/solver-shadow.test.mjs", "tests/helper-lifecycle.test.mjs"]
  },
  {
    id: "scripted-recovery-operator",
    tasks: ["understand-verifier-failure", "resume-task", "inspect-handoff"],
    tests: ["tests/recovery-chaos.test.mjs", "tests/resume-state.test.mjs", "tests/handoff-projection.test.mjs"]
  },
  {
    id: "scripted-release-maintainer",
    tasks: ["confirmation-policy", "distribution-check", "release-identity-check"],
    tests: ["tests/policy-core.test.mjs", "tests/mcp-approval-gate.test.mjs", "tests/package-distribution.test.mjs", "tests/release-identity.test.mjs"]
  }
];

function run(fixture) {
  const started = performance.now();
  const result = spawnSync(process.execPath, ["--test", ...fixture.tests], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PIAGENT_NO_UPDATE_CHECK: "1", PI_OFFLINE: "1" },
    maxBuffer: 8 * 1024 * 1024
  });
  const durationMs = Math.round((performance.now() - started) * 1000) / 1000;
  const summary = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return {
    id: fixture.id,
    participantType: "scripted-fixture-not-human",
    tasks: fixture.tasks,
    testFiles: fixture.tests,
    passed: result.status === 0,
    durationMs,
    testSummary: {
      pass: Number(summary.match(/ℹ pass (\d+)/)?.[1] ?? 0),
      fail: Number(summary.match(/ℹ fail (\d+)/)?.[1] ?? (result.status === 0 ? 0 : 1))
    },
    failure: result.status === 0 ? null : summary.slice(-2000)
  };
}

const results = fixtures.map(run);
const passed = results.filter((item) => item.passed).length;
const sortedDurations = results.map((item) => item.durationMs).sort((a, b) => a - b);
const report = {
  schemaVersion: 1,
  reportVersion: "product-usability-pilot-v1",
  generatedAt: new Date().toISOString(),
  execution: "local-offline-read-only-fixtures",
  participantDisclosure: {
    scriptedFixtures: results.length,
    independentHumanParticipants: 0,
    requiredIndependentHumanParticipants: 5,
    externalHumanPilotRequired: true,
    note: "Scripted fixtures validate deterministic journeys but cannot measure human comprehension or human task time."
  },
  results,
  localGate: {
    status: passed === results.length ? "passed" : "failed",
    fixturesPassed: `${passed}/${results.length}`,
    medianFixtureDurationMs: sortedDurations[Math.floor(sortedDurations.length / 2)] ?? null,
    hostBoundaryStringCovered: true,
    confirmationPolicyCovered: true,
    distributionAndReleaseIdentityCovered: true,
    noHighSeverityLocalBlocker: passed === results.length
  },
  humanExitGate: {
    status: "pending-external-human-pilot",
    medianInstallOnboardMinutes: null,
    medianFirstVerifiedTaskMinutes: null,
    hostVersusSandboxComprehension: null,
    destructiveExternalConfirmationComprehension: null,
    highSeverityUsabilityBlockers: null
  },
  releaseAuthorization: {
    publishAuthorized: false,
    tagAuthorized: false,
    pushAuthorized: false,
    providerConfigurationAuthorized: false
  }
};

fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({ output: path.relative(root, output), localGate: report.localGate, humanExitGate: report.humanExitGate }, null, 2));
if (passed !== results.length) process.exit(1);
