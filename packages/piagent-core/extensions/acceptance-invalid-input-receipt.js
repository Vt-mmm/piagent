import { acceptanceInvalidInputEvidence } from "./acceptance-contract-semantics.js";

// Keep acceptance truth and recovery diagnosis separate. A source analyzer's
// abstention is not an observed implementation defect. This route only asks
// for assessment after the current verifier executed live, bound assertions;
// failed/stale verification and absent tests retain their existing routes.
export function invalidInputReceiptProof({ proofInput, passingVerifier, verifierCoversTests,
  verifierEvidence, sourceFiles, testFiles }) {
  const { sourceOk, testOk } = acceptanceInvalidInputEvidence(proofInput);
  const verified = passingVerifier && sourceFiles.length > 0 && verifierCoversTests;
  return {
    sourceProofRequired: verified && testOk && !sourceOk,
    evidence: verified && sourceOk && testOk ? {
      ...verifierEvidence,
      kind: "verifier-backed-focused-test",
      summary: "Configured verifier passed with focused invalid-input tests for named entrypoints.",
      paths: [...new Set([...sourceFiles, ...testFiles])]
    } : undefined
  };
}
