import assert from 'node:assert/strict';
import { test } from 'node:test';
import { answeredSettlement, failedSettlement, settleHelper, delegateArgs, delegateParameters } from '../packages/piagent-core/managed/helper-settlement.mjs';

// How a helper's attempt ended: succeeded only with what its role needs,
// unverifiable without it (or for a stale review), failed on an error,
// cancelled when stopped; sent once with the attempt's own token, only to a
// Studio that lists managed.settle.v1.
test('outcome rules per role', () => {
  const verify = answeredSettlement('verify', 'Checked.\n```json\n{"verdicts":[{"claim":"tests pass","status":"pass","evidence":"npm test: 12 passing"},{"claim":"docs","status":"fail","evidence":"README.md:3 says otherwise"}],"brief_issues":[],"summary":"One claim fails."}\n```');
  assert.equal(verify.outcome, 'succeeded', 'a failed claim is a verify that did its job');
  assert.equal(verify.summary, 'One claim fails.');
  assert.deepEqual(verify.evidence, ['pass: tests pass — npm test: 12 passing', 'fail: docs — README.md:3 says otherwise']);
  assert.deepEqual(verify.files, ['README.md']);
  assert.equal(answeredSettlement('verify', 'I looked around and it seems fine.').outcome, 'unverifiable', 'no verdicts');
  const review = answeredSettlement('review', 'Review.', { parsed: true, findings: [{ severity: 'blocking', file: 'src/a.ts', line: 4, issue: 'drops the error' }] });
  assert.equal(review.outcome, 'succeeded'); assert.deepEqual(review.files, ['src/a.ts']); assert.match(review.evidence[0], /^blocking src\/a\.ts:4 drops the error/);
  assert.equal(answeredSettlement('review', 'x', { parsed: false }).outcome, 'unverifiable');
  const stale = answeredSettlement('review', 'x', { parsed: true, stale: true, findings: [] });
  assert.equal(stale.outcome, 'unverifiable'); assert.match(stale.summary, /stale/);
  const scout = answeredSettlement('scout', '## Findings\n- Tokens are stored in `src/auth/store.ts:42` and read in src/auth/read.ts:7.\n```json\n{"brief_issues":[]}\n```', {}, { target: 'src/auth', acceptance: 'file:line' });
  assert.equal(scout.outcome, 'succeeded');
  assert.match(scout.summary, /^Findings$/);
  assert.deepEqual(scout.files, ['src/auth/store.ts', 'src/auth/read.ts']);
  assert.deepEqual(scout.spec, { target: 'src/auth', acceptance: 'file:line' });
  assert.ok(answeredSettlement('research', 'x'.repeat(2000)).summary.length <= 600);
});

test('an attempt without an answer: failed, or cancelled when stopped', () => {
  assert.equal(failedSettlement('scout', Error('managed-helper-failed: The scout subagent hit its account limit')).outcome, 'failed');
  assert.match(failedSettlement('scout', Error('managed-helper-failed: The scout subagent hit its account limit')).summary, /hit its account limit/);
  assert.equal(failedSettlement('verify', Error('managed-helper-cancelled')).outcome, 'cancelled');
  const stopped = new AbortController(); stopped.abort();
  assert.equal(failedSettlement('verify', Error('anything'), stopped.signal).outcome, 'cancelled');
});

test('sent with the attempt token, only to a Studio that lists managed.settle.v1', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) }); return new Response('{}', { status: 200 }); };
  const report = failedSettlement('scout', Error('x'));
  assert.equal(await settleHelper({ origin: 'http://s', capabilities: new Set(['capabilities.v1']) }, { token: 'as_run_t' }, report, fetchImpl), false);
  assert.equal(await settleHelper({ origin: 'http://s', capabilities: null }, { token: 'as_run_t' }, report, fetchImpl), false, 'an older Studio');
  assert.equal(sent.length, 0);
  assert.equal(await settleHelper({ origin: 'http://s', capabilities: new Set(['managed.settle.v1']) }, { token: 'as_run_t' }, report, fetchImpl), true);
  assert.deepEqual(sent, [{ url: 'http://s/v1/managed/settle', auth: 'Bearer as_run_t', body: report }]);
  const failing = async () => { throw Error('offline'); };
  assert.equal(await settleHelper({ origin: 'http://s', capabilities: new Set(['managed.settle.v1']) }, { token: 'as_run_t' }, report, failing), false, 'never fails the helper');
});

test('the delegate tool takes the five task fields and puts them at the head of the brief', () => {
  const params = delegateParameters();
  assert.deepEqual(params.required, ['role', 'task']);
  for (const f of ['target', 'change', 'constraints', 'ownership', 'acceptance']) assert.equal(params.properties[f].maxLength, 1000, f);
  const self = {};
  const args = delegateArgs(self, { role: 'scout', task: 'Find where tokens are stored.', target: ' src/auth ', acceptance: 'file:line facts', ownership: '' });
  assert.equal(args.task, 'Target: src/auth\nAcceptance: file:line facts\n\nFind where tokens are stored.');
  assert.deepEqual(self.helperSpecs.get('scout'), { target: 'src/auth', acceptance: 'file:line facts' });
  const plain = { role: 'verify', task: 'Check it.' };
  assert.equal(delegateArgs(self, plain), plain, 'no fields: the brief is unchanged');
});
