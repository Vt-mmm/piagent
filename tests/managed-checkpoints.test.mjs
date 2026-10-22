import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { ManagedToolBoundary } from '../packages/piagent-core/managed/tool-boundary.mjs';
import { TurnCheckpoints } from '../packages/piagent-core/managed/checkpoints.mjs';
import { processEditTools, RunProcess } from '../packages/piagent-core/managed/workflow.mjs';
import { piSdkRoot } from './helpers/pi-sdk.mjs';

// /undo puts back what the agent's last turn changed, through the command
// sandbox, without touching the member's index, HEAD or later edits.
const sdkRoot = piSdkRoot();
const supported = process.platform === 'darwin' && fs.existsSync(sdkRoot);
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });

function repository() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-undo-')));
  for (const [name, text] of [['a.txt', 'a0\n'], ['b.txt', 'b0\n'], ['d.txt', 'd0\n']]) fs.writeFileSync(path.join(root, name), text);
  git(root, 'init', '-q', '-b', 'main'); git(root, 'add', '-A');
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'init');
  return root;
}
const read = (root, name) => fs.existsSync(path.join(root, name)) ? fs.readFileSync(path.join(root, name), 'utf8') : null;

test('/undo restores the files of the last turn, one turn at a time, and leaves the member\'s index and files alone', { skip: !supported, timeout: 180000 }, async () => {
  const root = repository(), boundary = new ManagedToolBoundary({ cwd: root, sdkRoot, protectedRoots: [], proxyPorts: [] });
  const managed = { boundary, activePrompt: false }, checkpoints = new TurnCheckpoints(managed);
  const turn = async change => { const run = {}; await checkpoints.take(run); change(); await checkpoints.finish(run); return run; };
  try {
    // The member's own work before the agent: a staged change and an untracked note.
    fs.writeFileSync(path.join(root, 'd.txt'), 'd-staged\n'); git(root, 'add', 'd.txt');
    fs.writeFileSync(path.join(root, 'notes.txt'), 'mine\n');
    const head = git(root, 'rev-parse', 'HEAD'), staged = git(root, 'diff', '--cached');
    // Turn 1 edits a.txt; turn 2 edits it again, deletes b.txt and creates c.txt.
    await turn(() => fs.writeFileSync(path.join(root, 'a.txt'), 'a1\n'));
    await turn(() => { fs.writeFileSync(path.join(root, 'a.txt'), 'a2\n'); fs.rmSync(path.join(root, 'b.txt')); fs.writeFileSync(path.join(root, 'c.txt'), 'new\n'); });
    assert.match((await checkpoints.undo()).text, /^Đã hoàn tác lượt trước: 2 file trả về như trước lượt đó, 1 file lượt đó tạo đã xoá\. \/undo lần nữa/);
    assert.deepEqual([read(root, 'a.txt'), read(root, 'b.txt'), read(root, 'c.txt')], ['a1\n', 'b0\n', null]);
    assert.match((await checkpoints.undo()).text, /^Đã hoàn tác lượt trước: 1 file/);
    assert.equal(read(root, 'a.txt'), 'a0\n');
    assert.match((await checkpoints.undo()).text, /^Không có lượt nào để hoàn tác/);
    // Nothing of the member's changed: staged change, untracked file, HEAD.
    assert.equal(git(root, 'diff', '--cached'), staged);
    assert.equal(read(root, 'notes.txt'), 'mine\n');
    assert.equal(git(root, 'rev-parse', 'HEAD'), head);
    // A file the member changed after the turn is never overwritten.
    await turn(() => fs.writeFileSync(path.join(root, 'a.txt'), 'agent\n'));
    fs.writeFileSync(path.join(root, 'a.txt'), 'member\n');
    assert.match((await checkpoints.undo()).text, /^Không hoàn tác: 1 file lượt trước đã sửa lại thay đổi sau đó \(a\.txt\)/);
    assert.equal(read(root, 'a.txt'), 'member\n');
    // Not while a turn runs.
    managed.activePrompt = true;
    assert.match((await checkpoints.undo()).text, /^Đang có một lượt chạy/);
  } finally { await boundary.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('the first change of a run takes its checkpoint once; outside git there is none', { skip: !supported, timeout: 120000 }, async () => {
  const root = repository(), boundary = new ManagedToolBoundary({ cwd: root, sdkRoot, protectedRoots: [], proxyPorts: [] });
  const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-undo-plain-'))), outside = new ManagedToolBoundary({ cwd: plain, sdkRoot, protectedRoots: [], proxyPorts: [] });
  try {
    const run = new RunProcess({ plan: 'off', verify: 'off', review: 'off', maxFixLoops: 0 }, { request: 'x', complex: false, checks: { commands: [] } }), session = { boundary, run, session: { sessionManager: { getBranch: () => [], getEntries: () => [] } }, refreshReview: async () => {} };
    let calls = 0;
    const [write] = processEditTools(session, [{ name: 'write', execute: async (_id, args) => { calls += 1; fs.writeFileSync(path.join(root, args.path), 'x\n'); return { content: [{ type: 'text', text: 'Written.' }] }; } }]);
    await write.execute('1', { path: 'a.txt' });
    const first = run.checkpoint;
    assert.match(first?.before ?? '', /^[0-9a-f]{40,64}$/);
    await write.execute('2', { path: 'b.txt' });
    assert.equal(run.checkpoint, first, 'one checkpoint per run'); assert.equal(calls, 2);
    // Outside a git repository no checkpoint is taken and /undo says why.
    const none = new TurnCheckpoints({ boundary: outside, activePrompt: false }), noRun = {};
    await none.take(noRun);
    assert.equal(noRun.checkpoint, null);
    assert.match((await none.undo()).text, /git repository/);
  } finally { await boundary.dispose(); await outside.dispose(); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(plain, { recursive: true, force: true }); }
});

test('/undo sent as a message is answered with a note and no model request', async () => {
  const { memberTurn } = await import('../packages/piagent-core/managed/continuation.mjs');
  const sent = [], rounds = [];
  const self = { checkpoints: { undo: async () => ({ result: 'done', restored: 1, removed: 0, files: ['a.txt'], text: 'Đã hoàn tác lượt trước: 1 file.' }) },
    notify: () => {}, session: { sendCustomMessage: async (message, options) => sent.push({ message, options }), messages: [] } };
  const runRound = async () => { rounds.push('round'); return {}; };
  await memberTurn(self, { manager: { getBranch: () => [] }, prompt: async () => {}, runRound }, '  /undo ', async () => {});
  assert.deepEqual(rounds, [], 'no round, so no model request');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].message.details, { phase: 'undo', undo: { result: 'done', restored: 1, removed: 0, files: ['a.txt'] } });
  assert.equal(sent[0].message.customType, 'agent-watch-process'); assert.equal(sent[0].options.triggerTurn, false);
  // Anything else is a turn as before.
  await assert.rejects(memberTurn(self, { manager: { getBranch: () => [], getEntries: () => [] }, prompt: async () => {}, runRound: async () => { rounds.push('round'); throw Error('ran'); } }, '/undo now', async () => {}), /ran/);
  assert.deepEqual(rounds, ['round']);
});
