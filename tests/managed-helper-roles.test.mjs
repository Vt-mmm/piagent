import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HELPER_ROLES, helperRoles, helperPrompt, delegateDescription } from '../packages/piagent-core/managed/helper-roles.mjs';
import { verifyVerdicts } from '../packages/piagent-core/managed/workflow.mjs';
import { describeFailure, parseFailure, failureKind } from '../packages/piagent-core/runtime/managed-failure.mjs';

const manifest = configuration => ({ harness: { configuration: { main: { model_ids: ['m'] }, ...configuration } } });

test('the helpers offered are the ones the Harness enables, in Harness order', () => {
  assert.deepEqual(HELPER_ROLES, ['scout', 'research', 'verify', 'review']);
  assert.deepEqual(helperRoles(manifest({ review: { model_ids: ['m'] }, scout: { model_ids: ['m'] }, research: null })), ['scout', 'review']);
  // A Harness from before scout and verify, or an older Agent Watch that drops them.
  assert.deepEqual(helperRoles(manifest({ research: { model_ids: ['m'] }, review: { model_ids: ['m'] } })), ['research', 'review']);
  assert.deepEqual(helperRoles(manifest({})), []);
  assert.deepEqual(helperRoles(undefined), []);
});

test('the prompt and the delegate tool describe only enabled helpers, and research gives way to scout for reading code', () => {
  assert.equal(helperPrompt([]), '');
  const alone = helperPrompt(['research', 'review']);
  assert.match(alone, /research helper \(delegate role "research"\) when understanding the task needs more reading/);
  assert.doesNotMatch(alone, /scout|verify/);
  const all = helperPrompt(['scout', 'research', 'verify', 'review']);
  assert.match(all, /scout helper \(delegate role "scout"\) when understanding the task needs more reading/);
  assert.match(all, /research helper \(delegate role "research"\) for questions that need external documentation/);
  assert.match(all, /verify helper \(delegate role "verify"\)/);
  const tool = delegateDescription(['scout', 'verify']);
  assert.match(tool, /^Hand work to a helper/);
  assert.match(tool, /scout: .*no web/); assert.match(tool, /verify: .*read-only for its commands/);
  assert.doesNotMatch(tool, /research:|review:/);
  assert.match(delegateDescription(['research']), /research: before changing an area .* It also searches the web\./);
});

test('verify verdicts are read from the last valid JSON block, with unknown statuses dropped', () => {
  assert.equal(verifyVerdicts('no json here'), null);
  assert.equal(verifyVerdicts('```json\n{"findings":[]}\n```'), null);
  const text = 'first\n```json\n{"verdicts":[{"claim":"old","status":"pass"}]}\n```\nthen\n```json\n{"verdicts":[{"claim":"tests pass","status":"pass","evidence":"npm test: 12 passed"},{"claim":"docs say v5","status":"fail","evidence":"https://example.test/docs"},{"claim":"x","status":"maybe"},{"claim":" ","status":"pass"}],"summary":"s"}\n```';
  assert.deepEqual(verifyVerdicts(text), [
    { status: 'pass', claim: 'tests pass', evidence: 'npm test: 12 passed' },
    { status: 'fail', claim: 'docs say v5', evidence: 'https://example.test/docs' }]);
});

test('a scout or verify failure names its role, and a helper the Harness lacks is a tool failure', () => {
  for (const role of ['scout', 'verify']) {
    const text = describeFailure(role, 'managed-helper-failed');
    assert.match(text, new RegExp(`^Agent Watch ${role} subagent: `));
    assert.equal(parseFailure(text).role, role);
    assert.equal(parseFailure(`Error: managed-helper-failed: ${text}`).role, role);
  }
  assert.equal(failureKind('managed-helper-not-configured'), 'tool');
  assert.equal(parseFailure('managed-helper-not-configured: the company Harness has no scout subagent; use research.').code, 'managed-helper-not-configured');
});
