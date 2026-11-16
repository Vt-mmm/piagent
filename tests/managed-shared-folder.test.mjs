import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { claimCommand, claimEdit, claimState, commandRepositories, FOREIGN_MS, restoreWorkRepos, saveWorkRepos } from '../packages/piagent-core/managed/claim-scope.mjs';
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

const map = obj => new Map(Object.entries(obj));
test('work across repositories is kept; only a repository seen changing between commands is left out', () => {
  assert.deepEqual([...commandRepositories(root, `cd ${root}/wt/ea-fe && npm test && git -C app status`)].sort(), ['app', 'wt/ea-fe']);
  const state = claimState();
  // A generator in the front end writes into the back end: nothing else touches app, so it is this conversation's.
  let r = claimCommand(root, state, 'cd wt/ea-fe && npm run gen', map({}), map({ 'wt/ea-fe/src/a.ts': '1', 'app/src/gen.ts': '1' }), 1000);
  assert.deepEqual(r.owned.sort(), ['app/src/gen.ts', 'wt/ea-fe/src/a.ts']); assert.equal(r.skipped.size, 0);
  // Between commands portal changed (another session); this conversation's own edit in wt/ea-fe is not taken for another process.
  claimEdit(root, state, 'wt/ea-fe/src/b.ts');
  const before = map({ 'wt/ea-fe/src/a.ts': '1', 'app/src/gen.ts': '1', 'wt/ea-fe/src/b.ts': '1', 'portal/shot.webp': '1' });
  r = claimCommand(root, state, 'npm test', before, map({ ...Object.fromEntries(before), 'portal/shot.webp': '2', 'portal/new.webp': '1', 'app/src/gen.ts': '2' }), 2000);
  assert.deepEqual(r.owned, ['app/src/gen.ts'], 'app: nobody else seen there');
  assert.deepEqual([...r.skipped], [['portal', ['portal/shot.webp', 'portal/new.webp']]]);
  assert.ok(!state.foreign.has('wt/ea-fe'), 'its own edit is not another process');
  // The conversation turns to portal itself: what was left out is taken back.
  r = claimCommand(root, state, 'cd portal && npm run build', map({}), map({}), 3000);
  assert.deepEqual(r.owned.sort(), ['portal/new.webp', 'portal/shot.webp']);
  // Seen long ago: no longer held against the repository.
  const old = claimState(); old.foreign.set('portal', 0); old.last = map({});
  assert.deepEqual(claimCommand(root, old, 'make', map({}), map({ 'portal/x': '1' }), FOREIGN_MS + 1).owned, ['portal/x']);
  const single = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-one-repo-')); fs.writeFileSync(path.join(single, '.git'), 'gitdir: x\n');
  try { assert.deepEqual(claimCommand(single, claimState(), 'x', map({}), map({ a: '1', 'b/c': '1' })).owned, ['a', 'b/c'], 'one repository: everything'); } finally { fs.rmSync(single, { recursive: true, force: true }); }
});

test('the repositories worked in are kept with the conversation, not read from carried files', () => {
  const entries = [], manager = { getEntries: () => entries, appendCustomEntry: (customType, data) => entries.push({ type: 'custom', customType, data }) };
  const state = claimState(); claimEdit(root, state, 'app/src/a.ts');
  const saved = saveWorkRepos(manager, state, '');
  assert.equal(saveWorkRepos(manager, state, saved), saved); assert.equal(entries.length, 1, 'written once');
  assert.deepEqual(restoreWorkRepos(manager), ['app']);
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
