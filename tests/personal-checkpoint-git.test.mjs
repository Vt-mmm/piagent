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
  assert.throws(() => adapter.restore(before, ['dir/a.txt'], [], after), /symbolic link/);
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
