const PRIVATE_DIGEST_FIELDS = Object.freeze([
  "holdoutManifestDigest", "referenceSolutionDigest", "mutationReportDigest", "calibrationReportDigest",
  "accessPolicyDigest", "disjointnessReportDigest", "humanRubricDigest", "disagreementReportDigest"
]);
const ASSURANCE_FIELDS = new Set([
  "taskSource", "visibility", "generatedVariants", "reviewed", "refreshedAt", "claimTier",
  "familyDisjointSplit", "repositoryDisjointSplit", ...PRIVATE_DIGEST_FIELDS, "evidenceManifest"
]);
const CLAIM_TIERS = new Set(["smoke", "public-regression", "capability", "private-holdout", "production-shadow"]);
const PRIVATE_TIERS = new Set(["private-holdout", "production-shadow"]);
const SHA256 = /^[a-f0-9]{64}$/;

function plainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactFields(value, fields) {
  return plainObject(value) && Object.keys(value).every((field) => fields.has(field));
}

function safeRelativePath(value) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) return false;
  const normalized = value.replaceAll("\\", "/");
  return !normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized) && !normalized.split("/").includes("..");
}

function validTimestamp(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

function validateCompleteResults(value, kind, errors) {
  if (!exactFields(value, new Set(["total", kind])) || !Number.isInteger(value.total) || value.total < 1 || value[kind] !== value.total) {
    errors.push(`assurance evidence ${kind === "passed" ? "referenceSolutions" : "mutationChecks"} must report every declared item ${kind}`);
  }
}

function validateLegacyCalibration(calibration, errors) {
  if (!exactFields(calibration, new Set(["sampleSize", "reviewerCount", "agreement"]))
    || !Number.isInteger(calibration.sampleSize) || calibration.sampleSize < 1
    || !Number.isInteger(calibration.reviewerCount) || calibration.reviewerCount < 2
    || !Number.isFinite(calibration.agreement) || calibration.agreement < 0.8 || calibration.agreement > 1) {
    errors.push("assurance evidence calibration must include a sample, two reviewers, and agreement from 0.8 through 1");
  }
}

function validateAccessControl(access, input, errors) {
  const fields = new Set([
    "protocolVersion", "policyDigest", "candidateAuthorPromptAccess", "candidateAuthorGraderAccess",
    "candidateAuthorRepositoryAccess", "operatorAccess", "reviewerAccess", "custodianIndependent",
    "reviewerIndependent", "appendOnlyAccessLog", "accessLogDigest", "issuedAt", "expiresAt"
  ]);
  if (!exactFields(access, fields)) return errors.push("assurance evidence accessControl must use the closed E3 custody receipt");
  if (access.protocolVersion !== "e3-custody-v1" || access.policyDigest !== input.accessPolicyDigest) errors.push("assurance evidence accessControl policy is not bound");
  if (access.candidateAuthorPromptAccess !== "denied-until-rc-freeze"
    || access.candidateAuthorGraderAccess !== "denied-until-rc-freeze"
    || access.candidateAuthorRepositoryAccess !== "denied-until-rc-freeze") errors.push("assurance evidence must deny candidate-author private access before RC freeze");
  if (access.operatorAccess !== "execute-only" || access.reviewerAccess !== "blinded-rubric-and-output") errors.push("assurance evidence operator/reviewer access is not least privilege");
  if (access.custodianIndependent !== true || access.reviewerIndependent !== true || access.appendOnlyAccessLog !== true) errors.push("assurance evidence custody roles and access log must be independent and append-only");
  if (!SHA256.test(access.accessLogDigest ?? "")) errors.push("assurance evidence accessLogDigest must be a SHA-256 digest");
  if (!validTimestamp(access.issuedAt) || !validTimestamp(access.expiresAt) || Date.parse(access.expiresAt) <= Date.parse(access.issuedAt)) errors.push("assurance evidence access receipt validity window is invalid");
}

function validateDisjointness(disjointness, input, errors) {
  const fields = new Set([
    "taxonomyDigest", "publicExposureDigest", "reportDigest", "familyDisjoint", "repositoryDisjoint",
    "scenarioCount", "familyCount", "repositoryCount", "verifiedAt"
  ]);
  if (!exactFields(disjointness, fields)) return errors.push("assurance evidence disjointness must use the closed E3 audit receipt");
  for (const field of ["taxonomyDigest", "publicExposureDigest", "reportDigest"]) if (!SHA256.test(disjointness[field] ?? "")) errors.push(`assurance evidence disjointness.${field} must be a SHA-256 digest`);
  if (disjointness.reportDigest !== input.disjointnessReportDigest) errors.push("assurance evidence disjointness report is not bound");
  if (disjointness.familyDisjoint !== true || disjointness.repositoryDisjoint !== true) errors.push("assurance evidence must prove family and repository disjointness");
  for (const field of ["scenarioCount", "familyCount", "repositoryCount"]) if (!Number.isInteger(disjointness[field]) || disjointness[field] < 6) errors.push(`assurance evidence disjointness.${field} must be at least 6`);
  if (!validTimestamp(disjointness.verifiedAt)) errors.push("assurance evidence disjointness.verifiedAt is invalid");
}

function validateCalibratedDisagreement(calibration, input, errors) {
  const fields = new Set([
    "sampleSize", "reviewerCount", "sampledFamilyCount", "doubleScoredCount", "agreementCount",
    "disagreementCount", "resolvedDisagreementCount", "unresolvedDisagreementCount", "agreement",
    "blinded", "independentFirstPass", "adjudicatorIndependent", "rubricDigest", "reviewerSetDigest",
    "sampleSelectionDigest", "disagreementLogDigest", "adjudicationPolicyDigest"
  ]);
  if (!exactFields(calibration, fields)) return errors.push("assurance evidence calibration must use the closed sampled-disagreement receipt");
  if (!Number.isInteger(calibration.sampleSize) || calibration.sampleSize < 12
    || !Number.isInteger(calibration.reviewerCount) || calibration.reviewerCount < 2
    || !Number.isInteger(calibration.sampledFamilyCount) || calibration.sampledFamilyCount < 4
    || calibration.doubleScoredCount !== calibration.sampleSize) errors.push("assurance evidence calibration sample must contain 12 double-scored items, two reviewers, and four families");
  for (const field of ["agreementCount", "disagreementCount", "resolvedDisagreementCount", "unresolvedDisagreementCount"]) if (!Number.isInteger(calibration[field]) || calibration[field] < 0) errors.push(`assurance evidence calibration.${field} must be a non-negative integer`);
  if (calibration.agreementCount + calibration.disagreementCount !== calibration.doubleScoredCount
    || calibration.resolvedDisagreementCount !== calibration.disagreementCount
    || calibration.unresolvedDisagreementCount !== 0) errors.push("assurance evidence must record and resolve every sampled disagreement");
  const expectedAgreement = calibration.doubleScoredCount > 0 ? calibration.agreementCount / calibration.doubleScoredCount : -1;
  if (!Number.isFinite(calibration.agreement) || calibration.agreement < 0.8 || calibration.agreement > 1 || Math.abs(calibration.agreement - expectedAgreement) > 0.0001) errors.push("assurance evidence calibration agreement does not match the double-scored record");
  if (calibration.blinded !== true || calibration.independentFirstPass !== true || calibration.adjudicatorIndependent !== true) errors.push("assurance evidence human review must be blinded, independent, and independently adjudicated");
  for (const field of ["rubricDigest", "reviewerSetDigest", "sampleSelectionDigest", "disagreementLogDigest", "adjudicationPolicyDigest"]) if (!SHA256.test(calibration[field] ?? "")) errors.push(`assurance evidence calibration.${field} must be a SHA-256 digest`);
  if (calibration.rubricDigest !== input.humanRubricDigest || calibration.disagreementLogDigest !== input.disagreementReportDigest) errors.push("assurance evidence human rubric or disagreement log is not bound");
}

export function benchmarkAssuranceValidationErrors(assurance, schemaVersion) {
  if (!plainObject(assurance)) return ["assurance must be an object"];
  const errors = [];
  for (const field of Object.keys(assurance)) if (!ASSURANCE_FIELDS.has(field)) errors.push(`assurance has unsupported field ${field}`);
  for (const field of ["taskSource", "visibility", "refreshedAt"]) if (assurance[field] !== undefined && (typeof assurance[field] !== "string" || !assurance[field].trim())) errors.push(`assurance.${field} must be a non-empty string`);
  if (assurance.claimTier !== undefined && !CLAIM_TIERS.has(assurance.claimTier)) errors.push("assurance.claimTier is invalid");
  if (assurance.evidenceManifest !== undefined && !safeRelativePath(assurance.evidenceManifest)) errors.push("assurance.evidenceManifest must stay inside the suite directory");
  for (const field of ["generatedVariants", "reviewed", "familyDisjointSplit", "repositoryDisjointSplit"]) if (assurance[field] !== undefined && typeof assurance[field] !== "boolean") errors.push(`assurance.${field} must be a boolean`);
  for (const field of PRIVATE_DIGEST_FIELDS) if (assurance[field] !== undefined && !SHA256.test(assurance[field])) errors.push(`assurance.${field} must be a SHA-256 digest`);
  if (schemaVersion === 2 && !CLAIM_TIERS.has(assurance.claimTier)) errors.push("schemaVersion 2 requires assurance.claimTier");
  if (PRIVATE_TIERS.has(assurance.claimTier)) {
    if (assurance.visibility !== "external-private-holdout" || assurance.familyDisjointSplit !== true || assurance.repositoryDisjointSplit !== true) errors.push("private assurance requires external visibility plus family and repository disjointness");
    if (!safeRelativePath(assurance.evidenceManifest)) errors.push("private assurance requires a suite-local evidenceManifest");
    for (const field of PRIVATE_DIGEST_FIELDS) if (!SHA256.test(assurance[field] ?? "")) errors.push(`private assurance requires ${field}`);
  }
  return errors;
}

export function benchmarkAssuranceEvidenceValidationErrors(input) {
  if (!plainObject(input)) return ["assurance evidence must be an object"];
  const common = ["schemaVersion", "claimTier", "visibility", "familyDisjointSplit", "holdoutManifestDigest", "referenceSolutionDigest", "mutationReportDigest", "calibrationReportDigest", "referenceSolutions", "mutationChecks", "calibration"];
  const v2 = ["repositoryDisjointSplit", "accessPolicyDigest", "disjointnessReportDigest", "humanRubricDigest", "disagreementReportDigest", "accessControl", "disjointness"];
  const fields = new Set(input.schemaVersion === 2 ? [...common, ...v2] : common);
  const errors = [];
  for (const field of Object.keys(input)) if (!fields.has(field)) errors.push(`assurance evidence has unsupported field ${field}`);
  if (![1, 2].includes(input.schemaVersion)) errors.push("assurance evidence schemaVersion must be 1 or 2");
  if (!PRIVATE_TIERS.has(input.claimTier)) errors.push("assurance evidence claimTier is invalid");
  if (input.visibility !== "external-private-holdout") errors.push("assurance evidence visibility must be external-private-holdout");
  if (input.familyDisjointSplit !== true) errors.push("assurance evidence familyDisjointSplit must be true");
  for (const field of PRIVATE_DIGEST_FIELDS.slice(0, 4)) if (!SHA256.test(input[field] ?? "")) errors.push(`assurance evidence ${field} must be a SHA-256 digest`);
  validateCompleteResults(input.referenceSolutions, "passed", errors);
  validateCompleteResults(input.mutationChecks, "killed", errors);
  if (input.schemaVersion === 1) validateLegacyCalibration(input.calibration, errors);
  if (input.schemaVersion === 2) {
    if (input.repositoryDisjointSplit !== true) errors.push("assurance evidence repositoryDisjointSplit must be true");
    for (const field of PRIVATE_DIGEST_FIELDS.slice(4)) if (!SHA256.test(input[field] ?? "")) errors.push(`assurance evidence ${field} must be a SHA-256 digest`);
    validateAccessControl(input.accessControl, input, errors);
    validateDisjointness(input.disjointness, input, errors);
    validateCalibratedDisagreement(input.calibration, input, errors);
  }
  return errors;
}

function v2PrivateEvidenceChecks(assurance, evidence = {}) {
  const access = evidence.accessControl ?? {};
  const split = evidence.disjointness ?? {};
  const calibration = evidence.calibration ?? {};
  const digestsMatch = PRIVATE_DIGEST_FIELDS.every((field) => assurance[field] === evidence[field]);
  return {
    "assurance-evidence-v2": evidence.schemaVersion === 2,
    "access-receipt-current-at-load": evidence.accessReceiptCurrent === true,
    "repository-disjoint-split": assurance.repositoryDisjointSplit === true && evidence.repositoryDisjointSplit === true && split.repositoryDisjoint === true,
    "family-disjoint-audit": assurance.familyDisjointSplit === true && split.familyDisjoint === true,
    "private-receipt-digests-match-suite": digestsMatch,
    "candidate-author-access-denied": access.candidateAuthorPromptAccess === "denied-until-rc-freeze" && access.candidateAuthorGraderAccess === "denied-until-rc-freeze" && access.candidateAuthorRepositoryAccess === "denied-until-rc-freeze",
    "execute-only-operator": access.operatorAccess === "execute-only",
    "blinded-independent-review": access.reviewerAccess === "blinded-rubric-and-output" && calibration.blinded === true && calibration.independentFirstPass === true,
    "sampled-disagreement-closed": calibration.sampleSize >= 12 && calibration.reviewerCount >= 2 && calibration.unresolvedDisagreementCount === 0 && calibration.resolvedDisagreementCount === calibration.disagreementCount && calibration.agreement >= 0.8
  };
}

export function benchmarkClaimEligibility({ suite, environment = {}, baselineSurface, protocolPassed = false, tokenClaimAllowed = false }) {
  const assurance = suite.assurance ?? {};
  const evidence = environment.assuranceEvidence ?? {};
  const declaredTier = assurance.claimTier ?? (suite.schemaVersion === 2 ? "public-regression" : "smoke");
  const comparisonPurpose = baselineSurface === "codex-cli" ? "external-product-reference" : "causal-harness-ablation";
  const privateChecks = {
    "assurance-manifest-verified": evidence.verified === true && SHA256.test(evidence.manifestDigest ?? ""),
    "external-private-visibility": assurance.visibility === "external-private-holdout",
    "holdout-manifest-bound": SHA256.test(assurance.holdoutManifestDigest ?? ""),
    "reference-solutions-validated": SHA256.test(assurance.referenceSolutionDigest ?? "") && evidence.referenceSolutions?.total >= 1 && evidence.referenceSolutions.passed === evidence.referenceSolutions.total,
    "mutations-killed": SHA256.test(assurance.mutationReportDigest ?? "") && evidence.mutationChecks?.total >= 1 && evidence.mutationChecks.killed === evidence.mutationChecks.total,
    "grader-human-calibrated": SHA256.test(assurance.calibrationReportDigest ?? ""),
    ...v2PrivateEvidenceChecks(assurance, evidence),
    "candidate-frozen": environment.source?.dirty === false && /^[a-f0-9]{40,64}$/.test(environment.source?.commit ?? "")
  };
  const privateHoldoutEligible = PRIVATE_TIERS.has(declaredTier) && Object.values(privateChecks).every(Boolean);
  const productionShadowEligible = declaredTier === "production-shadow" && privateHoldoutEligible && environment.productionShadowEvidence?.passed === true;
  const achievedTier = productionShadowEligible ? "production-shadow" : privateHoldoutEligible ? "private-holdout" : declaredTier === "capability" && assurance.reviewed === true ? "capability" : assurance.reviewed === true && declaredTier !== "smoke" ? "public-regression" : "smoke";
  const limitations = [];
  if (!privateHoldoutEligible) limitations.push("no-generalization-claim-without-external-family-repository-disjoint-calibrated-holdout");
  if (!productionShadowEligible) limitations.push("no-production-stability-claim-without-shadow-or-canary-evidence");
  if (baselineSurface === "codex-cli") limitations.push("codex-comparison-is-external-and-non-causal");
  if ((suite.defaultRepeats ?? 0) <= 3) limitations.push("three-repeats-do-not-support-an-always-claim");
  if (assurance.generatedVariants === true && assurance.familyDisjointSplit !== true) limitations.push("generated-value-variants-are-not-independent-task-families");
  return {
    declaredTier, achievedTier, comparisonPurpose,
    causalAttributionAllowed: comparisonPurpose === "causal-harness-ablation" && protocolPassed,
    generalizationClaimAllowed: privateHoldoutEligible,
    productionStabilityClaimAllowed: productionShadowEligible,
    tokenClaimScope: tokenClaimAllowed ? "bounded-to-observed-comparable-pairs-and-failure-aware-effort" : "unavailable",
    privateHoldoutChecks: privateChecks,
    limitations
  };
}
