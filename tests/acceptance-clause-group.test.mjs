import assert from 'node:assert/strict';
import test from 'node:test';
import { boundAcceptanceClauseGroup, allClauseEvidence } from '../packages/piagent-core/extensions/acceptance-clause-group.js';
import { acceptanceTextHash } from '../packages/piagent-core/extensions/acceptance-behavior-proof.js';
import { operatorRequestDigest } from '../packages/piagent-core/extensions/task-state.js';
const text = 'Validate every field before checking duplicates.\nAfter that validation, return the existing object for duplicates.\nDo not mutate input except the error checkpoint.';
function fixture() {
  const request = `Fix the reducer.\n${text}\nRun verification.`;
  const criterion = {id: 'parent', hash: acceptanceTextHash(text), status: 'pending', evidence: []};
  const receipt = {criteria: [criterion]};
  const task = {operatorRequest: request, operatorRequestDigest: operatorRequestDigest(request), acceptanceCriteria: [text], acceptanceReceipt: receipt};
  return {task, receipt, criterion};
}
const derive = input => boundAcceptanceClauseGroup(input.task, input.receipt, input.criterion, 0);
const current = 'wt-content-v2:' + 'a'.repeat(64);
const evidence = group => group.children.map(child => ({id: child.id, hash: child.hash,
  evidence: {kind: 'verifier-backed-focused-test', command: 'npm test', exitCode: 0, workingTreeDigest: current, paths: ['src/reducer.js']}}));

test('clause projection is lossless and retains full context, order and exceptions', () => {
  const input = fixture(), before = JSON.stringify(input), group = derive(input);
  assert.equal(group.children.map(child => child.text).join('\n'), text);
  assert.equal(group.context, input.task.operatorRequest);
  for (const child of group.children) assert.equal(text.slice(child.start, child.end), child.text);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(derive(structuredClone(input)), group, 'resume does not create different child identities');
  const result = allClauseEvidence(group, evidence(group), current);
  assert.equal(result.kind, 'all-clause-proof'); assert.deepEqual(result.paths, ['src/reducer.js']);
});

for (const [name, alter] of [
  ['missing child', values => values.pop()],
  ['missing evidence', values => {delete values[1].evidence;}],
  ['reordered children', values => values.reverse()],
  ['duplicate child', values => {values[1] = values[0];}],
  ['wrong child hash', values => {values[1].hash = '0'.repeat(64);}],
  ['stale tree', values => {values[1].evidence.workingTreeDigest = 'wt-content-v2:' + 'b'.repeat(64);}],
  ['failed verifier', values => {values[1].evidence.exitCode = 1;}]
]) test(`all-clause proof refuses ${name}`, () => {
  const group = derive(fixture()), values = evidence(group); alter(values);
  assert.equal(allClauseEvidence(group, values, current), undefined);
});

for (const [name, alter] of [
  ['stale parent', x => {x.task.acceptanceCriteria[0] += ' Changed.';}],
  ['stale request', x => {x.task.operatorRequest += ' Changed.';}],
  ['invented criteria', x => {x.task.operatorRequest = 'Do something else.'; x.task.operatorRequestDigest = operatorRequestDigest(x.task.operatorRequest);}],
  ['duplicate parent id', x => {x.task.acceptanceCriteria.push(text); x.receipt.criteria.push({...x.criterion});}],
  ['unclosed code span', x => {x.task.acceptanceCriteria[0] = 'Use `the\nvalue`.'; x.criterion.hash = acceptanceTextHash(x.task.acceptanceCriteria[0]);}]
]) test(`clause binding refuses ${name}`, () => {const input = fixture(); alter(input); assert.equal(derive(input), null);});
