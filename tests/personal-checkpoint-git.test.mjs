import '../scripts/register-typescript-loader.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { PersonalCheckpointGit } from '../packages/piagent-core/runtime/checkpoints/personal-git.ts';
import { CheckpointStore } from '../packages/piagent-core/runtime/checkpoints/checkpoint-store.mjs';
import { CheckpointRefs } from '../packages/piagent-core/runtime/checkpoints/checkpoint-refs.mjs';
import { PersistentCheckpointHistory } from '../packages/piagent-core/runtime/checkpoints/persistent-history.mjs';
import { TurnCheckpointService } from '../packages/piagent-core/runtime/checkpoints/turn-checkpoints.mjs';
import { pruneStaleCheckpointSessions } from '../packages/piagent-core/runtime/checkpoints/prune.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'personal-checkpoint-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  git('init', '-q');
  const write = (file, content) => { fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true }); fs.writeFileSync(path.join(cwd, file), content); };
  let policy = { policy: { protectedPaths: ['.env', 'secret/**'] }, profile: {} };
  const adapter = new PersonalCheckpointGit(cwd, () => policy);
  return { root, cwd, git, write, adapter, setPolicy: value => { policy = value; } };
}
test('personal snapshot excludes protected/ignored/state files and preserves raw binary, CRLF and staged index', t => {
  const { cwd, write, git, adapter } = fixture(t);
  const binary = Buffer.from([0, 255, 13, 10, 128]);
  write('binary.dat', binary); write('lines.txt', 'one\r\ntwo'); write('.env', 'PRIVATE');
  write('secret/key', 'PRIVATE'); write('.gitignore', 'ignored\n'); write('ignored', 'ignored');
  write('.pi/piagent-state/record', 'private state');
  git('add', 'binary.dat', 'lines.txt', '.env');
  const index = fs.readFileSync(path.join(cwd, '.git/index'));
  const before = adapter.tree();
  const files = git('ls-tree', '-r', '--name-only', before);
  assert.equal(files.includes('.env'), false); assert.equal(files.includes('secret/'), false);
  assert.equal(files.includes('ignored'), false); assert.equal(files.includes('piagent-state'), false);
  write('binary.dat', 'agent'); write('lines.txt', 'changed');
  const after = adapter.tree(); adapter.restore(before, ['binary.dat', 'lines.txt'], [], after);
  assert.deepEqual(fs.readFileSync(path.join(cwd, 'binary.dat')), binary);
  assert.equal(fs.readFileSync(path.join(cwd, 'lines.txt'), 'utf8'), 'one\r\ntwo');
  assert.deepEqual(fs.readFileSync(path.join(cwd, '.git/index')), index);
});
test('personal restore checks live read-only and protected policy before any file change', t => {
  const { cwd, write, adapter, setPolicy } = fixture(t);
  write('a.txt', 'before'); write('b.txt', 'before'); const before = adapter.tree();
  write('a.txt', 'agent'); write('b.txt', 'agent'); const after = adapter.tree();
  for (const policy of [
    { policy: {}, profile: {}, readOnly: true },
    { policy: {}, profile: { permissionProfile: 'read-only' } },
    { policy: {}, profile: { readOnlyPaths: ['b.txt'] } },
    { policy: { protectedPaths: ['b.txt'] }, profile: {} },
  ]) {
    setPolicy(policy); assert.throws(() => adapter.restore(before, ['a.txt', 'b.txt'], [], after));
    assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'agent');
    assert.equal(fs.readFileSync(path.join(cwd, 'b.txt'), 'utf8'), 'agent');
  }
});
test('personal restore refuses stale content, root escape and a symlink ancestor without outside writes', t => {
  const { root, cwd, write, adapter, git } = fixture(t);
  write('dir/a.txt', 'before'); git('add', '.'); const before = adapter.tree();
  write('dir/a.txt', 'agent'); const after = adapter.tree();
  write('dir/a.txt', 'member'); assert.throws(() => adapter.restore(before, ['dir/a.txt'], [], after), /content-changed/);
  assert.equal(fs.readFileSync(path.join(cwd, 'dir/a.txt'), 'utf8'), 'member');
  write('dir/a.txt', 'agent');
  assert.throws(() => adapter.restore(before, ['../outside'], [], after), /path-invalid/);
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'a.txt'), 'outside');
  fs.rmSync(path.join(cwd, 'dir'), { recursive: true }); fs.symlinkSync(outside, path.join(cwd, 'dir'));
  // The link hides dir/a.txt from the snapshot, so the drift check refuses first.
  assert.throws(() => adapter.restore(before, ['dir/a.txt'], [], after), /symbolic link|content-changed/);
  assert.equal(fs.readFileSync(path.join(outside, 'a.txt'), 'utf8'), 'outside');
});
test('personal snapshots in a repository subfolder stay inside that project and never follow link targets', t => {
  const { root, cwd, write, git } = fixture(t);
  write('outside.txt', 'parent'); write('app/a.txt', 'before'); git('add', '.');
  const outside = path.join(root, 'private'); fs.writeFileSync(outside, 'never read');
  fs.symlinkSync(outside, path.join(cwd, 'app/link'));
  const adapter = new PersonalCheckpointGit(path.join(cwd, 'app'), () => ({ policy: {}, profile: {} }));
  const before = adapter.tree();
  assert.deepEqual(git('ls-tree', '-r', '--name-only', before).trim().split('\n'), ['a.txt', 'link']);
  write('app/a.txt', 'agent'); fs.unlinkSync(path.join(cwd, 'app/link')); write('app/link', 'agent file');
  const after = adapter.tree(); adapter.restore(before, ['a.txt', 'link'], [], after);
  assert.equal(fs.readFileSync(path.join(cwd, 'app/a.txt'), 'utf8'), 'before');
  assert.equal(fs.readlinkSync(path.join(cwd, 'app/link')), outside);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'never read');
  assert.equal(fs.readFileSync(path.join(cwd, 'outside.txt'), 'utf8'), 'parent');
});
test('personal adapter composes with durable service and argv-only refs across restart and GC', async t => {
  const { cwd, write, git, adapter } = fixture(t); write('a.txt', 'before');
  const store = new CheckpointStore(cwd, 'session');
  const create = () => new TurnCheckpointService(adapter, { history: new PersistentCheckpointHistory(store, new CheckpointRefs(adapter.refsExecutor, store.key)) });
  const service = create(), run = { turnRef: 'member-turn' }; await service.take(run);
  write('a.txt', 'agent'); write('new/file.txt', 'new'); await service.finish(run);
  git('gc', '--prune=now'); const result = await create().undo();
  assert.equal(result.result, 'done'); assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'before');
  assert.equal(fs.existsSync(path.join(cwd, 'new/file.txt')), false);
});

test('shared service serializes two undo requests over distinct turns instead of restoring one turn twice', async t => {
  const { cwd, write, adapter } = fixture(t); write('a.txt', 'zero');
  const store = new CheckpointStore(cwd, 'serial');
  const service = new TurnCheckpointService(adapter, { history: new PersistentCheckpointHistory(store, new CheckpointRefs(adapter.refsExecutor, store.key)) });
  for (const content of ['one', 'two']) {
    const run = { turnRef: content }; await service.take(run); write('a.txt', content); await service.finish(run);
  }
  const results = await Promise.all([service.undo(), service.undo()]);
  assert.deepEqual(results.map(result => result.result), ['done', 'done']);
  assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'zero');
  assert.equal(store.load().points.length, 0);
});

test('personal snapshot bypasses Git filters and restore preserves unrelated concurrent member edits', t => {
  const { cwd, write, git, adapter } = fixture(t);
  write('a.txt', 'before'); write('other.txt', 'member'); write('.gitattributes', '*.txt filter=checkpoint-fixture\n');
  git('config', 'filter.checkpoint-fixture.clean', 'sh -c "echo invoked > filter-ran; cat"');
  git('config', 'filter.checkpoint-fixture.smudge', 'sh -c "echo invoked > filter-ran; cat"');
  const before = adapter.tree(); write('a.txt', 'agent'); const after = adapter.tree();
  write('other.txt', 'member changed later');
  adapter.restore(before, ['a.txt'], [], after);
  assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'before');
  assert.equal(fs.readFileSync(path.join(cwd, 'other.txt'), 'utf8'), 'member changed later');
  assert.equal(fs.existsSync(path.join(cwd, 'filter-ran')), false);
});

test('personal snapshots keep large tracked files, skip submodules and never block on what Git cannot snapshot', t => {
  const { cwd, write, git, adapter } = fixture(t);
  const large = Buffer.alloc(20 << 20, 7);
  write('large.bin', large); write('a.txt', 'before');
  const nested = path.join(cwd, 'vendor/lib'); fs.mkdirSync(nested, { recursive: true });
  execFileSync('git', ['-C', nested, 'init', '-q']); fs.writeFileSync(path.join(nested, 'x'), 'x');
  execFileSync('git', ['-C', nested, '-c', 'user.name=F', '-c', 'user.email=f@example.com', 'add', 'x']);
  execFileSync('git', ['-C', nested, '-c', 'user.name=F', '-c', 'user.email=f@example.com', 'commit', '-qm', 'x']);
  git('add', 'large.bin', 'a.txt', 'vendor/lib');
  const before = adapter.tree();
  assert.deepEqual(git('ls-tree', '-r', '--name-only', before).trim().split('\n'), ['a.txt', 'large.bin']);
  write('large.bin', 'agent'); write('a.txt', 'agent'); fs.writeFileSync(path.join(nested, 'x'), 'agent');
  const after = adapter.tree(); adapter.restore(before, ['large.bin', 'a.txt'], [], after);
  assert.deepEqual(fs.readFileSync(path.join(cwd, 'large.bin')), large);
  assert.equal(fs.readFileSync(path.join(nested, 'x'), 'utf8'), 'agent', 'undo never reaches into a submodule');
});

test('a file the turn deleted comes back with the mode a new file gets, not owner-only', t => {
  const { cwd, write, adapter } = fixture(t);
  write('a.txt', 'before'); const before = adapter.tree();
  fs.unlinkSync(path.join(cwd, 'a.txt')); const after = adapter.tree();
  adapter.restore(before, ['a.txt'], [], after);
  assert.equal(fs.statSync(path.join(cwd, 'a.txt')).mode & 0o777, 0o666 & ~process.umask());
});

test('the checkpoint store keeps objects and refs out of the project repository and survives its GC', async t => {
  const { cwd, write, git } = fixture(t); write('a.txt', 'before'); write('secret.local', 'untracked');
  const adapter = new PersonalCheckpointGit(cwd, () => ({ policy: {}, profile: {} }), { store: true });
  const store = new CheckpointStore(cwd, 'store-session');
  const create = () => new TurnCheckpointService(adapter, { history: new PersistentCheckpointHistory(store, new CheckpointRefs(adapter.refsExecutor, store.key)) });
  const service = create(), run = { turnRef: 'turn' }; await service.take(run);
  write('a.txt', 'agent'); write('new.txt', 'new'); await service.finish(run);
  assert.equal(git('for-each-ref', 'refs/piagent'), '', 'git push --mirror finds nothing to publish');
  const untracked = execFileSync('git', ['hash-object', '--stdin'], { input: 'untracked', encoding: 'utf8' }).trim();
  assert.throws(() => git('cat-file', '-e', untracked), 'untracked bytes stay out of the project object store');
  await service.close();
  git('gc', '--prune=now', '--quiet');
  const result = await create().undo();
  assert.equal(result.result, 'done'); assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'before');
  assert.equal(fs.existsSync(path.join(cwd, 'new.txt')), false);
});

test('a failed snapshot lets the edit continue and ends the history it would otherwise sit inside', async t => {
  const { cwd, write, adapter } = fixture(t); write('a.txt', 'zero');
  const store = new CheckpointStore(cwd, 'gap');
  let broken = false;
  const git = { available: () => adapter.available(), changed: (a, b) => adapter.changed(a, b),
    restore: (...args) => adapter.restore(...args), tree: () => { if (broken) throw Error('snapshot-failed'); return adapter.tree(); } };
  const service = new TurnCheckpointService(git, { history: new PersistentCheckpointHistory(store, new CheckpointRefs(adapter.refsExecutor, store.key)) });
  const first = { turnRef: 'one' }; await service.take(first); write('a.txt', 'one'); await service.finish(first);
  assert.equal((await service.list()).points.length, 1);
  broken = true; const second = { turnRef: 'two' };
  await service.take(second);
  assert.equal(second.checkpoint, null);
  write('a.txt', 'two'); await service.finish(second); broken = false;
  assert.deepEqual((await service.list()).points, []);
  assert.equal(store.load().points.length, 0);
  assert.equal((await service.undo()).result, 'none');
  assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'two');
});

test('undo and restore refuse files the member saved from the editor after the turn began', async t => {
  const { cwd, write, adapter } = fixture(t); write('a.txt', 'before'); write('readme.md', 'before');
  const edits = new Map();
  const service = new TurnCheckpointService(adapter, { memberEdits: since => new Set([...edits].filter(([, at]) => at >= since).map(([file]) => file)) });
  const run = { turnRef: 'turn' }; await service.take(run);
  write('a.txt', 'agent'); write('readme.md', 'member'); edits.set('readme.md', Date.now());
  await service.finish(run);
  const { points } = await service.list();
  const preview = await service.preview(points[0].id);
  assert.deepEqual(preview.conflicts, ['readme.md']);
  const result = await service.undo();
  assert.equal(result.result, 'refused'); assert.deepEqual(result.files, ['readme.md']);
  assert.equal(fs.readFileSync(path.join(cwd, 'readme.md'), 'utf8'), 'member');
  assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'agent');
});

test('checkpoints of conversations untouched for 30 days are pruned with their refs', async t => {
  const { cwd, write } = fixture(t); write('a.txt', 'zero');
  const adapter = new PersonalCheckpointGit(cwd, () => ({ policy: {}, profile: {} }), { store: true });
  const keys = [];
  for (const name of ['old', 'recent']) {
    const store = new CheckpointStore(cwd, name); keys.push(store.key);
    const service = new TurnCheckpointService(adapter, { history: new PersistentCheckpointHistory(store, new CheckpointRefs(adapter.refsExecutor, store.key)) });
    const run = { turnRef: name }; await service.take(run); write('a.txt', name); await service.finish(run); await service.close();
  }
  const directory = path.join(cwd, '.pi/piagent-state/checkpoints'), old = path.join(directory, `${keys[0]}.json`);
  const month = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000); fs.utimesSync(old, month, month);
  const refs = () => adapter.refsExecutor.run(['for-each-ref', '--format=%(refname)', 'refs/piagent/checkpoints/']);
  assert.equal(pruneStaleCheckpointSessions(directory, adapter.refsExecutor, keys[1]), 1);
  assert.equal(fs.existsSync(old), false); assert.equal(refs().includes(keys[0]), false); assert.equal(refs().includes(keys[1]), true);
});

test('another live owner makes the edit wait and keeps the history', async t => {
  const { cwd, write, adapter } = fixture(t); write('a.txt', 'zero');
  const store = new CheckpointStore(cwd, 'owned');
  const open = () => new TurnCheckpointService(adapter, { history: new PersistentCheckpointHistory(store, new CheckpointRefs(adapter.refsExecutor, store.key)) });
  const first = open(), done = { turnRef: 'done' }; await first.take(done); write('a.txt', 'one'); await first.finish(done);
  const running = { turnRef: 'running' }; await first.take(running);
  const contender = open(), blocked = { turnRef: 'blocked' };
  await assert.rejects(contender.take(blocked), /checkpoint-turn-owned/);
  assert.equal(blocked.checkpoint, undefined, 'the blocked turn may try again');
  write('a.txt', 'two'); await first.finish(running);
  assert.equal(store.load().points.length, 2, 'history is kept');
});

test('a lock or capture owner must predate its record and the last boot', async () => {
  const { ownerAlive } = await import('../packages/piagent-core/runtime/process-owner.mjs');
  const now = Date.now();
  assert.equal(ownerAlive(process.pid, now, { started: () => now - 5000 }), true);
  assert.equal(ownerAlive(process.pid, now, { started: () => now + 60000 }), false, 'a reused process number');
  assert.equal(ownerAlive(process.pid, now - 10 * 3600 * 1000, { now, uptime: 3600, started: () => null }), false, 'written before the last boot');
  assert.equal(ownerAlive(2 ** 22 + 12345, now), false);
});

test('an undo that stopped midway finishes on the next attempt instead of refusing its own work', async t => {
  const { cwd, write, adapter } = fixture(t); write('a.txt', 'a0'); write('b.txt', 'b0');
  const service = new TurnCheckpointService(adapter);
  const run = { turnRef: 'turn' }; await service.take(run); write('a.txt', 'a1'); write('b.txt', 'b1'); write('made/deep/c.txt', 'c'); await service.finish(run);
  write('a.txt', 'a0'); // as if the first undo put a.txt back and then stopped
  const preview = await service.preview((await service.list()).points[0].id);
  assert.deepEqual(preview.conflicts, []); assert.deepEqual(preview.steps[0].restore, ['b.txt']);
  const result = await service.undo();
  assert.equal(result.result, 'done');
  assert.equal(fs.readFileSync(path.join(cwd, 'b.txt'), 'utf8'), 'b0');
  assert.equal(fs.existsSync(path.join(cwd, 'made')), false, 'folders the turn made and its undo emptied are gone');
});

test('a file ignored since the turn is refused rather than overwritten, and refusals are definite', async t => {
  const { cwd, write, adapter } = fixture(t); write('config.json', 'before');
  const service = new TurnCheckpointService(adapter);
  const run = { turnRef: 'turn' }; await service.take(run); write('config.json', 'agent'); await service.finish(run);
  write('.gitignore', 'config.json\n'); write('config.json', 'member kept editing');
  const target = (await service.list()).points[0].id;
  const preview = await service.preview(target);
  const result = await service.restoreTo(target, preview);
  assert.equal(result.result, 'refused'); assert.deepEqual(result.conflicts, ['config.json']);
  assert.equal(fs.readFileSync(path.join(cwd, 'config.json'), 'utf8'), 'member kept editing');
});
