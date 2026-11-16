import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { commandRepositories, ownedChanges } from '../packages/piagent-core/managed/claim-scope.mjs';
import { reviewOvertaken } from '../packages/piagent-core/managed/review-overtaken.mjs';
import { turnEnd } from '../packages/piagent-core/managed/continuation.mjs';
import { turnEndCopy, turnEndOf, turnEndShort } from '../packages/piagent-webui/shared/turn-end.ts';
import { helperLines, receiptText } from '../scripts/company-terminal.mjs';
import { helperEnded } from '../packages/piagent-core/managed/helper-run.mjs';

// Owner, 2026-11-16: in a folder of several repositories another conversation
// regenerated screenshots while this one ran its tests; the files became this
// conversation's, its review went stale four times and its end said "done".
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pa-shared-folder-')));
for (const repo of ['app', 'portal', 'wt/ea-fe']) { fs.mkdirSync(path.join(root, repo), { recursive: true }); fs.writeFileSync(path.join(root, repo, '.git'), 'gitdir: x\n'); }
after(() => fs.rmSync(root, { recursive: true, force: true }));

test('a command owns the changes of the repositories it names or already works in', () => {
  assert.deepEqual([...commandRepositories(root, `cd ${root}/wt/ea-fe && npm test && git -C app status`)].sort(), ['app', 'wt/ea-fe']);
  assert.deepEqual([...commandRepositories(root, 'npm test')], []);
  const changed = ['app/src/a.ts', 'portal/shots/1.webp', 'portal/shots/2.webp', 'wt/ea-fe/src/b.tsx'];
  assert.deepEqual(ownedChanges(root, 'cd app && npm test', changed, new Set()), ['app/src/a.ts']);
  assert.deepEqual(ownedChanges(root, 'npm test', changed, new Set(['wt/ea-fe/src/x.ts'])), ['wt/ea-fe/src/b.tsx'], 'no repository named: the ones it already works in');
  assert.deepEqual(ownedChanges(root, 'npm test', changed, new Set()), changed, 'nothing to go by yet: the old rule');
  const single = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-one-repo-')); fs.writeFileSync(path.join(single, '.git'), 'gitdir: x\n');
  try { assert.deepEqual(ownedChanges(single, 'cd sub && x', ['a', 'b/c'], new Set()), ['a', 'b/c'], 'one repository: everything'); } finally { fs.rmSync(single, { recursive: true, force: true }); }
});

test('a review stale twice while the main agent waits stops, naming what changed', async () => {
  const notes = [], run = {}, before = new Map([['app/a.ts', '1'], ['portal/s.webp', '1']]);
  const managed = { review: { stale: true }, changedFiles: async () => new Map([['app/a.ts', '1'], ['portal/s.webp', '2'], ['portal/t.webp', '1']]) };
  const note = async (text, details) => notes.push([text, details]);
  assert.equal(await reviewOvertaken(managed, run, before, note), false, 'once: reviewed again');
  assert.equal(await reviewOvertaken(managed, run, before, note), true);
  assert.deepEqual(run.reviewOvertaken, ['portal/s.webp', 'portal/t.webp']); assert.equal(run.reviewSettled, true);
  assert.equal(notes[0][1].phase, 'review-overtaken'); assert.match(notes[0][0], /stale 2 times/);
  assert.equal(await reviewOvertaken({ review: { stale: false } }, {}, before, note), false, 'a fresh review goes on');
});

test('done without a passing check on the final code says so', () => {
  const plan = { plan: [{ step: 'a', status: 'completed' }] }, end = turnEnd({ touched: true, rounds: 0 }, plan, { stopped: false, failure: null, unchecked: true });
  assert.equal(end.unchecked, true);
  const read = turnEndOf(end), copy = turnEndCopy(read, 'vi');
  assert.equal(copy.tone, 'warning'); assert.equal(copy.title, 'Xong 1/1 bước · chưa có check pass trên code cuối');
  assert.equal(turnEndShort(read, 'vi'), 'Xong 1/1, chưa check');
  assert.equal(turnEnd({ touched: true, rounds: 0 }, { plan: [{ step: 'a', status: 'pending' }] }, { unchecked: true }).unchecked, undefined, 'only a finished turn');
  assert.equal(turnEndCopy(turnEndOf(turnEnd({ touched: true, rounds: 0 }, plan, {})), 'vi').title, 'Hoàn thành · 1/1 bước');
});

test('a stale review reads as stale, and a job run again is one line', () => {
  assert.equal(receiptText('Review: 231,977 tokens (mới 31k · đọc lại cache 199k · output 1k) · review is stale (code changed during the review).'),
    'Review: 231,977 token (mới 31k · đọc lại cache 199k · output 1k) · đã cũ (code đổi trong lúc review).');
  assert.equal(receiptText('Review: 9 tokens · 3 parts · patch abc · done.'), 'Review: 9 token · 3 phần · patch abc · xong.');
  const managed = {};
  for (let i = 0; i < 4; i += 1) helperEnded(managed, 'review', { job: 'Review patch cuối của lượt', outcome: 'unverifiable', stale: true, tokens: 200000 });
  helperEnded(managed, 'review', { job: 'Review patch cuối của lượt', outcome: 'succeeded', tokens: 160000 });
  assert.equal(managed.helperDone.length, 1);
  assert.deepEqual(helperLines([], managed.helperDone), ['Subagent · 0 đang chạy · 1 đã xong', '  ✓ Review · Review patch cuối của lượt · 5 lần, 4 lần đã cũ · 960k token · xong']);
});
