import { candidateProvenance } from './benchmark-candidate.js';
import { deriveDiagnosticCandidateEntries, DIAGNOSTIC_TREATMENT } from './benchmark-diagnostic-treatment.js';

// Prove the source-to-treatment transformation from actual bytes.
export function diagnosticS0SourceEvidence({ source, entries, derivation, candidate }) {
  if (source?.kind !== 'git-working-tree' || typeof source.dirty !== 'boolean'
    || !/^[a-f0-9]{40,64}$/.test(source.commit ?? '')) throw new Error('Invalid source identity');
  const observedSource = candidateProvenance(entries);
  const derived = deriveDiagnosticCandidateEntries(entries, { piagentTreatment: DIAGNOSTIC_TREATMENT, measurementOnly: true });
  const observedCandidate = candidateProvenance(derived.entries);
  const expected = { ...derived.derivation, sourceCandidateProvenance: observedSource,
    derivedCandidateProvenance: observedCandidate };
  if (JSON.stringify(derivation) !== JSON.stringify(expected)
    || JSON.stringify(candidate) !== JSON.stringify(observedCandidate)) {
    throw new Error('Diagnostic S0 source or fixed policy derivation changed');
  }
  return { kind: source.kind, commit: source.commit, clean: !source.dirty,
    treeDigest: candidate.contentDigest, treeAlgorithm: candidate.algorithm,
    conformanceSourceDigest: observedSource.contentDigest,
    conformanceScope: 'source-runtime; diagnostic-policy-runtime-qualified-separately',
    treatmentDerivation: expected };
}

export function validDiagnosticS0SourceEvidence(value) {
  const hash = item => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item);
  const d = value?.treatmentDerivation, change = d?.changes?.[0];
  return value?.kind === 'git-working-tree' && typeof value.clean === 'boolean'
    && /^[a-f0-9]{40,64}$/.test(value.commit ?? '')
    && value.conformanceScope === 'source-runtime; diagnostic-policy-runtime-qualified-separately'
    && hash(value.conformanceSourceDigest) && hash(value.treeDigest)
    && value.conformanceSourceDigest !== value.treeDigest
    && d?.schemaVersion === 1 && d.treatment === DIAGNOSTIC_TREATMENT
    && d.transform === 'installed-base-policy-acceptance-diagnostic-v1'
    && d.changes?.length === 1
    && change.path === 'packages/piagent-core/policies/base-policy.json'
    && hash(change.beforeSha256) && hash(change.afterSha256) && change.beforeSha256 !== change.afterSha256
    && d.sourceCandidateProvenance?.contentDigest === value.conformanceSourceDigest
    && d.derivedCandidateProvenance?.contentDigest === value.treeDigest
    && d.derivedCandidateProvenance?.algorithm === value.treeAlgorithm;
}
