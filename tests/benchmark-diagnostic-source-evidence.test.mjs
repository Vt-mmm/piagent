import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticS0SourceEvidence } from '../packages/piagent-core/benchmark/benchmark-diagnostic-source-evidence.js';
import { candidateProvenance } from '../packages/piagent-core/benchmark/benchmark-candidate.js';
import { deriveDiagnosticCandidateEntries, DIAGNOSTIC_POLICY_PATH } from '../packages/piagent-core/benchmark/benchmark-diagnostic-treatment.js';
function fixture() {
 const source = { kind: 'git-working-tree', dirty: true, commit: 'a'.repeat(40) };
 const entries = [{ path: DIAGNOSTIC_POLICY_PATH, kind: 'regular', mode: '100644', indexMode: '100644', payload: Buffer.from('{"finalGate":{"requireTrace":true}}') },
 { path: 'runtime.js', kind: 'regular', mode: '100644', indexMode: '100644', payload: Buffer.from('original') }];
 const derived = deriveDiagnosticCandidateEntries(entries, { piagentTreatment: 'acceptance-diagnostic', measurementOnly: true });
 const candidate = candidateProvenance(derived.entries);
 return { source, entries, candidate, derivation: { ...derived.derivation, sourceCandidateProvenance: candidateProvenance(entries), derivedCandidateProvenance: candidate } };
}
test('dirty source stays dirty while its exact diagnostic transform is proven', () => {
 const f = fixture(), evidence = diagnosticS0SourceEvidence(f);
 assert.equal(evidence.clean, false);
 assert.notEqual(evidence.conformanceSourceDigest, evidence.treeDigest);
 assert.match(evidence.conformanceScope, /qualified-separately/);
});
test('same Git status cannot hide a non-policy source edit', () => {
 const f=fixture(); f.entries[1].payload=Buffer.from('modified');
 assert.throws(()=>diagnosticS0SourceEvidence(f), /changed/);
});
test('a changed policy obligation is rejected', () => {
 const f=fixture(); f.entries[0].payload=Buffer.from('{"finalGate":{"requireTrace":false}}');
 assert.throws(()=>diagnosticS0SourceEvidence(f), /changed/);
});
test('candidate mismatch cannot reuse source conformance', () => {
 const f=fixture();f.candidate={...f.candidate,contentDigest:'b'.repeat(64)};
 assert.throws(()=>diagnosticS0SourceEvidence(f), /changed/);
});
test('forged provenance cannot substitute for actual bytes', () => {
 const f=fixture();f.derivation.sourceCandidateProvenance.contentDigest='c'.repeat(64);
 assert.throws(()=>diagnosticS0SourceEvidence(f), /changed/);
});
test('missing derivation is rejected even for a clean source', () => {
 const f=fixture();f.source.dirty=false;f.derivation=null;
 assert.throws(()=>diagnosticS0SourceEvidence(f), /changed/);
});
