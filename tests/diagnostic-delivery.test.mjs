import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { validDiagnosticDelivery, diagnosticDeliveryStateErrors } from '../packages/piagent-core/runtime/recovery/diagnostic-delivery.ts';

const acceptanceDigest = 'a'.repeat(64);
const delivery = { mode: 'diagnostic', qualityClaim: 'withheld', policySha256: 'b'.repeat(64), acceptanceDigest, pendingCriterionIds: ['ac-1'] };

test('diagnostic delivery metadata cannot assert approval or accept ambiguous bindings', () => {
  assert.equal(validDiagnosticDelivery(delivery, acceptanceDigest), true);
  for (const invalid of [null, {}, { ...delivery, qualityClaim: 'approved' },
    { ...delivery, completionApproved: true }, { ...delivery, policySha256: 'unknown' },
    { ...delivery, pendingCriterionIds: [] }, { ...delivery, pendingCriterionIds: ['ac-1', 'ac-1'] },
    { ...delivery, pendingCriterionIds: [null] }]) {
    assert.equal(validDiagnosticDelivery(invalid, acceptanceDigest), false);
  }
  assert.equal(validDiagnosticDelivery(delivery, 'c'.repeat(64)), false);
});

test('diagnostic state requires operational completion while withholding acceptance approval', () => {
  const state = { diagnosticDelivery: delivery, completionApproved: false, gateDecision: 'pass', taskOutcome: 'completed' };
  const acceptance = { dispositionDigest: acceptanceDigest, satisfied: false, criteriaCount: 1 };
  assert.deepEqual(diagnosticDeliveryStateErrors(state, acceptance), []);
  for (const change of [{ completionApproved: true }, { gateDecision: 'block' }, { taskOutcome: 'pending' }]) {
    assert.equal(diagnosticDeliveryStateErrors({ ...state, ...change }, acceptance).length, 1);
  }
  assert.equal(diagnosticDeliveryStateErrors(state, { ...acceptance, satisfied: true }).length, 1);
  assert.deepEqual(diagnosticDeliveryStateErrors({}, acceptance), []);
});

test('delivery is tied to installed diagnostic policy, pending task criteria and current operational evidence', async t => {
  // Copy only this dependency-free runtime module: never mutate the installed policy.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piagent-delivery-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modulePath = path.join(root, 'runtime/recovery/diagnostic-delivery.ts');
  const policyPath = path.join(root, 'policies/base-policy.json');
  fs.mkdirSync(path.dirname(modulePath), { recursive: true });
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.copyFileSync(new URL('../packages/piagent-core/runtime/recovery/diagnostic-delivery.ts', import.meta.url), modulePath);
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  const runtime = await import(pathToFileURL(modulePath));
  const task = { trace: { outcome: 'completed' }, acceptanceReceipt: { criteria: [{ id: 'ac-1', status: 'pending' }] } };
  const gate = { decision: 'pass', missing: [], missingVerifyCommands: [], acceptanceProof: { mode: 'diagnostic', pendingCriterionIds: ['ac-1'] } };
  const acceptance = { satisfied: false, dispositionDigest: acceptanceDigest };
  fs.writeFileSync(policyPath, '{"finalGate":{"acceptanceProofMode":"enforce"}}');
  assert.equal(runtime.buildDiagnosticDelivery(task, gate, acceptance, true), undefined);
  fs.writeFileSync(policyPath, '{"finalGate":{"acceptanceProofMode":"diagnostic"}}');
  const result = runtime.buildDiagnosticDelivery(task, gate, acceptance, true);
  assert.equal(result.qualityClaim, 'withheld');
  assert.equal(runtime.diagnosticDeliveryMatchesTask(result, task, acceptanceDigest), true);
  assert.equal(runtime.diagnosticDeliveryMatchesTask(result, { ...task, acceptanceReceipt: { criteria: [{ id: 'other', status: 'pending' }] } }, acceptanceDigest), false);
  assert.equal(runtime.buildDiagnosticDelivery(task, gate, acceptance, false), undefined);
  assert.equal(runtime.buildDiagnosticDelivery(task, { ...gate, missingVerifyCommands: ['npm test'] }, acceptance, true), undefined);
  assert.equal(runtime.buildDiagnosticDelivery(task, { ...gate, decision: 'block' }, acceptance, true), undefined);
  fs.writeFileSync(policyPath, '{"finalGate":{"acceptanceProofMode":"enforce"}}');
  assert.equal(runtime.diagnosticDeliveryMatchesTask(result, task, acceptanceDigest), false);
  fs.writeFileSync(policyPath, 'invalid-json');
  assert.equal(runtime.installedDiagnosticPolicyDigest(), undefined);
});
