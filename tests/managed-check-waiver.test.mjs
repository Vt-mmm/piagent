import assert from 'node:assert/strict';
import test from 'node:test';

import { waiveChecksTool } from '../packages/piagent-core/managed/check-waiver.mjs';
import { RunProcess, completionGate } from '../packages/piagent-core/managed/workflow.mjs';

// Only the member waives the checks a Harness requires: the agent asks with
// waive_checks, the member answers on a card, and the waiver holds for the
// code as it was then.
const REQUIRE = { plan: 'off', verify: 'require', review: 'off', maxFixLoops: 2, lanes: false };
const newRun = (policy = REQUIRE) => new RunProcess(policy, { request: 'commit and push, skip the tests', complex: false, checks: { commands: ['npm test'], source: 'declared' } });
const answer = (value, seen = []) => ({ ui: { confirm: async (title, text) => { seen.push({ title, text }); return value; } } });

function member(run, digest = 'd'.repeat(64)) {
  const self = { permission: 'bypass', cwd: process.cwd(), grant: {}, run, code: digest,
    session: { sessionManager: { getSessionId: () => 'waiver-session' } } };
  self.digest = async () => self.code;
  return self;
}

test('waive_checks asks the member every time and binds the waiver to the current code', async () => {
  const run = newRun(), self = member(run), seen = [];
  const tool = waiveChecksTool(self);
  await assert.rejects(tool.execute('w1', { member_words: 'bỏ qua test, đẩy luôn', reason: 'npm test' }, undefined, undefined, answer(false, seen)), /managed-operation-denied/);
  assert.equal(run.waivedDigest, undefined, 'a declined waiver waives nothing');
  assert.equal(seen[0].title, 'Bỏ qua kiểm tra?');
  assert.match(seen[0].text, /Bạn đã nói: "bỏ qua test, đẩy luôn"/);
  assert.match(seen[0].text, /Push vẫn hỏi bạn như thường/);
  await tool.execute('w2', { member_words: 'bỏ qua test, đẩy luôn', reason: 'npm test' }, undefined, undefined, answer(true, seen));
  assert.equal(run.waivedDigest, 'd'.repeat(64));
  // Never granted for the rest of the conversation: the same words ask again.
  await tool.execute('w3', { member_words: 'bỏ qua test, đẩy luôn', reason: 'npm test' }, undefined, undefined, answer(true, seen));
  assert.equal(seen.length, 3);
});

test('without a running request or with checks off there is nothing to waive', async () => {
  await assert.rejects(waiveChecksTool(member(null)).execute('w1', { member_words: 'skip', reason: 'x' }, undefined, undefined, answer(true)), /managed-checks-waiver-no-run/);
  const seen = [], off = newRun({ ...REQUIRE, verify: 'off' });
  const result = await waiveChecksTool(member(off)).execute('w2', { member_words: 'skip', reason: 'x' }, undefined, undefined, answer(true, seen));
  assert.match(result.content[0].text, /nothing to waive/);
  assert.equal(seen.length, 0);
});

// A ManagedSession reduced to what the completion gate reads.
function gateSession(digest) {
  const notes = [], entries = [];
  const managed = { code: digest, ownPaths: new Set(['src/app.js']), review: null, base: null,
    changeDigest: async () => managed.code, patchDigest: async () => managed.code,
    session: { messages: [], sessionManager: { getEntries: () => entries, appendCustomEntry: (customType, data) => entries.push({ type: 'custom', customType, data }) },
      sendCustomMessage: async (message, options) => { notes.push({ ...message, triggerTurn: options?.triggerTurn }); } } };
  return { managed, notes };
}

test('the gate stops asking for checks on waived code and reports the waiver; changed code is asked again', async () => {
  const start = 's'.repeat(64), changed = 'c'.repeat(64);
  // Not waived: sent back for checks until the fix rounds run out.
  let { managed, notes } = gateSession(changed), run = newRun();
  run.startDigest = start;
  await completionGate(managed, run, undefined);
  assert.equal(notes.filter(n => n.details.phase === 'verify').length, 2);
  assert.match(notes.at(-1).content, /no check passed on the final code\.$/);
  assert.equal(notes.at(-1).details.checksWaived, undefined);
  // Waived on this exact code: no round is spent, the status says who waived it.
  ({ managed, notes } = gateSession(changed)); run = newRun();
  run.startDigest = start; run.waivedDigest = changed;
  await completionGate(managed, run, undefined);
  assert.deepEqual(notes.map(n => n.details.phase), ['final']);
  assert.match(notes[0].content, /no check passed on the final code: the member waived the checks/);
  assert.equal(notes[0].details.checksWaived, true);
  assert.equal(notes[0].details.outcome, 'unverified', 'a waiver is not a passed check');
  // The code moved after the waiver: the checks are required again.
  ({ managed, notes } = gateSession(changed)); run = newRun();
  run.startDigest = start; run.waivedDigest = 'w'.repeat(64);
  await completionGate(managed, run, undefined);
  assert.equal(notes.filter(n => n.details.phase === 'verify').length, 2);
});
