import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const DIAGNOSTIC_TREATMENT = "acceptance-diagnostic";
export const DIAGNOSTIC_POLICY_PATH = "packages/piagent-core/policies/base-policy.json";

export function deriveDiagnosticCandidateEntries(entries, options = {}) {
  if (options.piagentTreatment !== DIAGNOSTIC_TREATMENT) return { entries };
  if (options.measurementOnly !== true) throw new Error("Diagnostic candidate derivation requires --measurement-only");
  const policyEntries = entries.filter(entry => entry.path === DIAGNOSTIC_POLICY_PATH);
  if (policyEntries.length !== 1 || policyEntries[0].kind !== "regular") {
    throw new Error("Diagnostic candidate requires one regular base policy entry");
  }
  const entry = policyEntries[0], policy = JSON.parse(entry.payload.toString("utf8"));
  if (!policy.finalGate || typeof policy.finalGate !== "object" || Array.isArray(policy.finalGate)) {
    throw new Error("Diagnostic candidate requires a valid finalGate policy");
  }
  const prior = policy.finalGate.acceptanceProofMode;
  if (prior !== undefined && prior !== "enforce") {
    throw new Error("Diagnostic derivation requires an enforce source policy");
  }
  policy.finalGate.acceptanceProofMode = "diagnostic";
  const payload = Buffer.from(`${JSON.stringify(policy, null, 2)}\n`);
  const hash = value => crypto.createHash("sha256").update(value).digest("hex");
  return {
    entries: entries.map(value => value === entry ? { ...entry, payload } : value),
    derivation: {
      schemaVersion: 1, treatment: DIAGNOSTIC_TREATMENT,
      transform: "installed-base-policy-acceptance-diagnostic-v1",
      changes: [{ path: DIAGNOSTIC_POLICY_PATH, beforeSha256: hash(entry.payload), afterSha256: hash(payload) }]
    }
  };
}

export function assertDiagnosticBenchmarkMatrix(options, { builtInId, fullMatrix, expectedSessions }) {
  if (options.piagentTreatment !== DIAGNOSTIC_TREATMENT) return;
  const failedReplay = options.failedAttemptsOnly === true
    && options.replaySource?.selection === "failed-attempts"
    && options.replaySource?.evidenceComplete === true
    && options.replaySource?.originalAttemptCount === 108
    && options.replayRuns?.length > 0
    && options.replayRuns.length === options.replaySource.selectedAttempts;
  if (builtInId !== "production-v3" || (!fullMatrix && !failedReplay) || expectedSessions !== 108
    || options.codexMode !== "controlled" || options.measurementOnly !== true) {
    throw new Error("Diagnostic acceptance requires the complete production-v3 controlled 108-session measurement matrix or a bound failed-attempt-only diagnostic replay");
  }
}

// Policy is part of the immutable candidate, never an inherited environment override.
export function benchmarkAcceptancePolicyBinding(installedRoot, options) {
  const file = path.join(installedRoot, DIAGNOSTIC_POLICY_PATH);
  if (!fs.lstatSync(file).isFile() || fs.realpathSync(file) !== path.resolve(file)) {
    throw new Error("Benchmark acceptance policy must be a regular file in the candidate");
  }
  const bytes = fs.readFileSync(file);
  const policy = JSON.parse(bytes.toString("utf8"));
  const diagnostic = policy.finalGate?.acceptanceProofMode === "diagnostic";
  const selected = options.piagentTreatment === DIAGNOSTIC_TREATMENT;
  const installedDefault = diagnostic && !selected;
  if (diagnostic !== selected && !installedDefault) {
    throw new Error("Benchmark treatment does not match the installed acceptance proof policy");
  }
  if (!diagnostic) return null;
  if (!installedDefault && options.measurementOnly !== true) {
    throw new Error("Diagnostic acceptance policy requires --measurement-only");
  }
  return {
    mode: "diagnostic", ...(installedDefault ? { origin: "installed-release-policy" } : {}),
    policyPath: DIAGNOSTIC_POLICY_PATH,
    policySha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    pendingProof: "retained", qualityClaim: "withheld"
  };
}

export function validDiagnosticPolicyBinding(binding) {
  return binding?.mode === "diagnostic" && binding.policyPath === DIAGNOSTIC_POLICY_PATH
    && (binding.origin === undefined || binding.origin === "installed-release-policy")
    && /^[a-f0-9]{64}$/.test(binding.policySha256)
    && binding.pendingProof === "retained" && binding.qualityClaim === "withheld";
}

export function assertDiagnosticCandidateDerivation(binding, derivation, candidate) {
  if (!binding) return;
  if (!validDiagnosticPolicyBinding(binding)) {
    throw new Error("Diagnostic candidate derivation does not match frozen source, policy and candidate identities");
  }
  if (binding.origin === "installed-release-policy") {
    if (derivation !== undefined) throw new Error("Installed diagnostic policy cannot claim a treatment derivation");
    return;
  }
  const change = derivation?.changes?.[0];
  if (derivation?.schemaVersion !== 1
    || derivation.treatment !== DIAGNOSTIC_TREATMENT
    || derivation.transform !== "installed-base-policy-acceptance-diagnostic-v1"
    || derivation.changes.length !== 1 || change.path !== binding.policyPath
    || change.afterSha256 !== binding.policySha256 || !/^[a-f0-9]{64}$/.test(change.beforeSha256)
    || change.beforeSha256 === change.afterSha256
    || !/^[a-f0-9]{64}$/.test(derivation.sourceCandidateProvenance?.contentDigest)
    || derivation.sourceCandidateProvenance.contentDigest === candidate?.contentDigest
    || JSON.stringify(derivation.derivedCandidateProvenance) !== JSON.stringify(candidate)) {
    throw new Error("Diagnostic candidate derivation does not match frozen source, policy and candidate identities");
  }
}
