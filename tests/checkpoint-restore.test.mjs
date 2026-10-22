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
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-restore-')));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  git('init', '-q');
  const write = (file, text) => fs.writeFileSync(path.join(cwd, file), text);
  const read = file => fs.readFileSync(path.join(cwd, file), 'utf8');
  const adapter = new PersonalCheckpointGit(cwd, () => ({ policy: {}, profile: {}, readOnly: false }));
  const store = new CheckpointStore(cwd, 'session');
  let busy = false;
  const open = () => new TurnCheckpointService(adapter, { busy: () => busy,
    history: new PersistentCheckpointHistory(store, new CheckpointRefs(adapter.refsExecutor, store.key)) });
  const service = open();
  const turn = async (turnRef, change) => { const run = { turnRef }; await service.take(run); change(); await service.finish(run); };
  return { cwd, git, write, read, adapter, store, service, open, turn, setBusy: value => { busy = value; } };
}

test('one confirmed restore undoes two turns after restart, preserves intermediate member changes, HEAD and index', async t => {
  const f = fixture(t); f.write('a', 'before'); f.write('member', 'initial');
  await f.turn('first', () => f.write('a', 'one'));
  f.write('member', 'member between turns');
  await f.turn('second', () => { f.write('a', 'two'); f.write('new', 'agent created'); });
  f.git('add', '.'); f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'member');
  const head = f.git('rev-parse', 'HEAD'), index = fs.readFileSync(path.join(f.cwd, '.git/index'));
  const service = f.open(), target = (await service.list()).points[0].id;
  const preview = await service.preview(target);
  assert.equal(preview.result, 'ready');
  assert.deepEqual(preview.steps.map(step => step.turnRef), ['second', 'first']);
  assert.deepEqual(preview.files, ['a', 'new']);
  assert.equal(f.read('a'), 'two', 'preview cannot mutate the workspace');
  const result = await service.restoreTo(target, preview);
  assert.equal(result.result, 'done'); assert.equal(result.completed.length, 2);
  assert.equal(f.read('a'), 'before'); assert.equal(f.read('member'), 'member between turns');
  assert.equal(fs.existsSync(path.join(f.cwd, 'new')), false);
  assert.equal(f.git('rev-parse', 'HEAD'), head); assert.deepEqual(fs.readFileSync(path.join(f.cwd, '.git/index')), index);
  assert.deepEqual((await f.open().list()).points, []);
  assert.equal((await service.restoreTo(target, preview)).result, 'stale', 'old confirmation cannot run twice');
});

test('preview shows the exact earlier conflict and restore stops after the safe newer turn', async t => {
  const f = fixture(t); f.write('a', 'before'); f.write('b', 'before');
  await f.turn('first', () => f.write('a', 'agent one'));
  f.write('a', 'member between turns');
  await f.turn('second', () => f.write('b', 'agent two'));
  const target = (await f.service.list()).points[0].id;
  const preview = await f.service.preview(target);
  assert.equal(preview.result, 'conflict'); assert.deepEqual(preview.conflicts, ['a']);
  assert.equal(preview.stoppedAt, target); assert.equal(preview.steps.length, 1);
  const result = await f.service.restoreTo(target, preview);
  assert.equal(result.result, 'refused'); assert.equal(result.completed.length, 1);
  assert.deepEqual(result.conflicts, ['a']);
  assert.equal(f.read('a'), 'member between turns'); assert.equal(f.read('b'), 'before');
  assert.equal(f.store.load().points.length, 1);
});

test('changed preview, missing confirmation and busy runtime refuse before effects; late member drift stops remaining turns', async t => {
  const f = fixture(t); f.write('a', 'before'); f.write('b', 'before');
  await f.turn('first', () => f.write('a', 'one'));
  await f.turn('second', () => f.write('b', 'two'));
  const target = (await f.service.list()).points[0].id;
  let preview = await f.service.preview(target);
  assert.equal((await f.service.restoreTo(target, null)).result, 'stale');
  f.write('unrelated', 'new member file');
  assert.equal((await f.service.restoreTo(target, preview)).result, 'stale');
  assert.equal(f.read('b'), 'two');
  preview = await f.service.preview(target); f.setBusy(true);
  assert.equal((await f.service.restoreTo(target, preview)).result, 'busy');
  f.setBusy(false);
  const restore = f.adapter.restore.bind(f.adapter);
  f.adapter.restore = (...args) => { restore(...args); f.write('a', 'member concurrent'); };
  const result = await f.service.restoreTo(target, preview);
  assert.equal(result.result, 'refused'); assert.equal(result.completed.length, 1);
  assert.deepEqual(result.files, ['a']);
  assert.equal(f.read('a'), 'member concurrent'); assert.equal(f.read('b'), 'before');
  assert.equal(f.store.load().points.length, 1);
});

test('adapter failure after an effect reports uncertainty and does not claim or repeat a completed turn', async t => {
  const f = fixture(t); f.write('a', 'before');
  await f.turn('first', () => f.write('a', 'agent'));
  const target = (await f.service.list()).points[0].id;
  const preview = await f.service.preview(target), restore = f.adapter.restore.bind(f.adapter);
  let effects = 0;
  f.adapter.restore = (...args) => { restore(...args); effects++; throw Error('fixture-lost-completion'); };
  const result = await f.service.restoreTo(target, preview);
  assert.equal(result.result, 'uncertain'); assert.deepEqual(result.completed, []);
  assert.equal(result.stoppedAt, target); assert.match(result.reason, /fixture-lost-completion/);
  assert.equal(f.read('a'), 'before'); assert.equal(f.store.load().points.length, 1);
  assert.equal((await f.service.restoreTo(target, preview)).result, 'stale');
  assert.equal(effects, 1);
});

for (const publication of ['before-save', 'after-save']) {
  test(`restore with ${publication} failure stays uncertain and cannot replay after restart`, async t => {
    const f = fixture(t); f.write('a', 'before');
    f.git('add', 'a'); f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'member');
    const head = f.git('rev-parse', 'HEAD'), index = fs.readFileSync(path.join(f.cwd, '.git/index'));
    await f.turn('first', () => f.write('a', 'agent'));
    const target = (await f.service.list()).points[0].id, preview = await f.service.preview(target);
    const save = f.store.save.bind(f.store), restore = f.adapter.restore.bind(f.adapter); let effects = 0;
    f.adapter.restore = (...args) => { effects++; return restore(...args); };
    f.store.save = (...args) => {
      if (publication === 'after-save') save(...args);
      throw Error(`fixture-${publication}`);
    };
    const result = await f.service.restoreTo(target, preview);
    assert.equal(result.result, 'uncertain'); assert.deepEqual(result.completed, []);
    assert.equal(result.stoppedAt, target); assert.equal(f.read('a'), 'before');
    f.store.save = save;
    const reopened = f.open();
    assert.equal((await reopened.restoreTo(target, preview)).result, 'stale');
    assert.equal((await reopened.undo()).result, publication === 'before-save' ? 'refused' : 'none');
    assert.equal(effects, 1); assert.equal(f.read('a'), 'before');
    assert.equal(f.git('rev-parse', 'HEAD'), head); assert.deepEqual(fs.readFileSync(path.join(f.cwd, '.git/index')), index);
  });
}

test('partial file effect remains inspectable after restart and never silently resumes a restore', async t => {
  const f = fixture(t); f.write('a', 'before a'); f.write('b', 'before b');
  await f.turn('first', () => { f.write('a', 'agent a'); f.write('b', 'agent b'); });
  const target = (await f.service.list()).points[0].id, preview = await f.service.preview(target);
  const restore = f.adapter.restore.bind(f.adapter); let effects = 0;
  f.adapter.restore = (before, paths, _remove, expected, guard) => {
    effects++; restore(before, paths.slice(0, 1), [], expected, guard); throw Error('fixture-partial-effect');
  };
  const result = await f.service.restoreTo(target, preview);
  assert.equal(result.result, 'uncertain'); assert.deepEqual(result.completed, []);
  assert.equal(f.read('a'), 'before a'); assert.equal(f.read('b'), 'agent b');
  const reopened = f.open();
  assert.equal((await reopened.restoreTo(target, preview)).result, 'stale');
  const inspection = await reopened.preview(target);
  assert.equal(inspection.result, 'conflict'); assert.deepEqual(inspection.conflicts, ['a']);
  assert.equal((await reopened.restoreTo(target, inspection)).result, 'refused');
  assert.equal(effects, 1); assert.equal(f.read('b'), 'agent b');
  assert.equal((await reopened.list()).points.length, 1, 'history remains available for inspection');
});
