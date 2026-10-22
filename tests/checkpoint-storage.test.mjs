import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { CheckpointStore, MAX_CHECKPOINTS } from '../packages/piagent-core/runtime/checkpoints/checkpoint-store.mjs';
import { CheckpointRefs } from '../packages/piagent-core/runtime/checkpoints/checkpoint-refs.mjs';
import { CheckpointGitAdapter } from '../packages/piagent-core/runtime/checkpoints/git-adapter.mjs';
import { PersistentCheckpointHistory } from '../packages/piagent-core/runtime/checkpoints/persistent-history.mjs';
import { TurnCheckpointService } from '../packages/piagent-core/runtime/checkpoints/turn-checkpoints.mjs';

const point = () => ({ id: randomUUID(), turnRef: randomUUID(), before: 'a'.repeat(40), after: 'b'.repeat(40), at: Date.now() });
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-store-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('checkpoint stack survives restart, rotates at its bound and refuses a stale writer', t => {
  const root = fixture(t), store = new CheckpointStore(root, 'one');
  assert.deepEqual(store.load(), { revision: 'absent', points: [] });
  assert.equal(fs.existsSync(path.join(root, '.pi')), false, 'reading an absent stack has no effects');
  const points = Array.from({ length: MAX_CHECKPOINTS + 1 }, point);
  const saved = store.save(points, 'absent');
  assert.deepEqual(saved.dropped, points.slice(0, 1));
  assert.deepEqual(new CheckpointStore(root, 'one').load().points, points.slice(1));
  assert.deepEqual(new CheckpointStore(root, 'two').load().points, []);
  assert.throws(() => store.save([], 'absent'), /checkpoint-state-stale/);
  assert.equal(fs.statSync(store.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(store.directory).mode & 0o777, 0o700);
  assert.deepEqual(store.save([], saved.revision).points, []);
  assert.equal(fs.readdirSync(store.directory).some(name => /\.(tmp|lock)$/.test(name)), false);
});
test('checkpoint state refuses unsafe paths, public files, hardlinks, malformed and oversized state', t => {
  const root = fixture(t), store = new CheckpointStore(root, 'session');
  store.save([point()], 'absent');
  const original = fs.readFileSync(store.file);
  fs.chmodSync(store.file, 0o644);
  assert.throws(() => store.load(), /not-private/);
  fs.chmodSync(store.file, 0o600);
  fs.linkSync(store.file, path.join(root, 'alias'));
  assert.throws(() => store.load(), /not-private/);
  fs.unlinkSync(path.join(root, 'alias'));
  fs.writeFileSync(store.file, Buffer.alloc(128 * 1024 + 1));
  assert.throws(() => store.load(), /not-private/);
  fs.writeFileSync(store.file, '{broken');
  assert.throws(() => store.load());
  fs.writeFileSync(store.file, original);
  fs.renameSync(store.directory, store.directory + '-real');
  fs.symlinkSync(store.directory + '-real', store.directory);
  assert.throws(() => store.load(), /symbolic link/);
  assert.throws(() => store.save([], 'absent'), /symbolic link/);
});
test('checkpoint state validates every entry and refuses active transaction locks', t => {
  const root = fixture(t), store = new CheckpointStore(root, 'session');
  const saved = store.save([point()], 'absent');
  const bad = { ...point(), before: 'HEAD; echo unsafe' };
  assert.throws(() => store.save([bad], saved.revision), /invalid/);
  const duplicate = point();
  assert.throws(() => store.save([duplicate, duplicate], saved.revision), /invalid/);
  fs.writeFileSync(store.lock, JSON.stringify({ pid: process.pid, token: randomUUID() }), { mode: 0o600 });
  assert.throws(() => store.save([], saved.revision), /busy/);
  assert.equal(store.load().revision, saved.revision);
  fs.unlinkSync(store.lock);
  const deadPid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
  fs.writeFileSync(store.lock, JSON.stringify({ pid: deadPid, token: randomUUID() }), { mode: 0o600 });
  assert.deepEqual(store.save([], saved.revision).points, [], 'an exited writer does not permanently block restart');
});
test('checkpoint refs preserve real before/after trees across GC without touching member HEAD or index', t => {
  const root = fixture(t), temporary = path.join(root, 'private-temp');
  fs.mkdirSync(temporary);
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  const git = (...args) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8' });
  git('init', '-q'); fs.writeFileSync(path.join(project, 'file.txt'), 'original\n'); git('add', 'file.txt');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'member');
  fs.writeFileSync(path.join(project, 'file.txt'), 'member staged\n'); git('add', 'file.txt');
  const head = git('rev-parse', 'HEAD'), index = fs.readFileSync(path.join(project, '.git/index'));
  const execute = command => execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', command], {
    cwd: project, env: { ...process.env, TMPDIR: temporary }, encoding: 'utf8', timeout: 10000,
  });
  return (async () => {
    const adapter = new CheckpointGitAdapter(execute), store = new CheckpointStore(project, 'session');
    const refs = new CheckpointRefs(execute, store.key), before = await adapter.tree();
    fs.writeFileSync(path.join(project, 'file.txt'), 'agent\n');
    fs.writeFileSync(path.join(project, 'new.txt'), 'agent created\n');
    const savedPoint = { ...point(), before, after: await adapter.tree() };
    await refs.pin(savedPoint); store.save([savedPoint], 'absent');
    git('gc', '--prune=now');
    const restarted = new CheckpointStore(project, 'session').load().points[0];
    assert.equal(git('cat-file', '-t', restarted.before).trim(), 'tree');
    assert.equal(git('cat-file', '-t', restarted.after).trim(), 'tree');
    git('update-ref', `${refs.prefix}${savedPoint.id}/before`, savedPoint.after);
    await assert.rejects(refs.pin(savedPoint), /checkpoint-ref-changed/);
    await assert.rejects(refs.release(savedPoint), /checkpoint-ref-changed/);
    assert.equal(git('rev-parse', `${refs.prefix}${savedPoint.id}/before`).trim(), savedPoint.after);
    git('update-ref', `${refs.prefix}${savedPoint.id}/before`, savedPoint.before);
    await adapter.restore(restarted.before, ['file.txt'], ['new.txt']);
    assert.equal(fs.readFileSync(path.join(project, 'file.txt'), 'utf8'), 'member staged\n');
    assert.equal(fs.existsSync(path.join(project, 'new.txt')), false);
    assert.equal(git('rev-parse', 'HEAD'), head);
    assert.deepEqual(fs.readFileSync(path.join(project, '.git/index')), index);
    // Recover cleanup interrupted after one ref was already removed.
    git('update-ref', '-d', `${refs.prefix}${savedPoint.id}/before`, savedPoint.before);
    await refs.release(savedPoint);
    await refs.release(savedPoint);
    assert.equal(git('for-each-ref', '--format=%(refname)', refs.prefix), '');
    assert.equal(git('status', '--porcelain', '--', '.pi'), '', 'runtime state does not enter snapshots or commits');
  })();
});

test('history retires only evicted refs after durable state and refuses a stale history instance', async t => {
  const root = fixture(t), store = new CheckpointStore(root, 'bounded'), released = [], pinned = [];
  const refs = { pin: async value => pinned.push(value.id), release: async value => {
    assert.equal(store.load().points.some(point => point.id === value.id), false, 'never drop a still-published tree');
    released.push(value.id);
  } };
  const history = new PersistentCheckpointHistory(store, refs), stale = new PersistentCheckpointHistory(store, refs);
  const first = Array.from({ length: MAX_CHECKPOINTS }, point); await history.save(first);
  const next = point(); const result = await history.save([...first, next]);
  assert.equal(result.length, MAX_CHECKPOINTS); assert.deepEqual(released, [first[0].id]);
  assert.ok(pinned.includes(next.id));
  await assert.rejects(stale.save([]), /checkpoint-state-stale/);
  assert.deepEqual(store.load().points, result);
});

test('published undo survives ref cleanup failure and retries cleanup before another file effect', async t => {
  const store = new CheckpointStore(fixture(t), 'cleanup');
  let failCleanup = true, restores = 0, pins = 0;
  const released = [];
  const history = new PersistentCheckpointHistory(store, {
    pin: async () => { pins++; },
    release: async value => {
      if (failCleanup) throw Error('fixture-ref-unavailable');
      released.push(value.id);
    },
  });
  const first = point(), second = { ...point(), before: first.after, after: 'c'.repeat(40) };
  await history.save([first, second]);
  let tree = second.after;
  const service = new TurnCheckpointService({
    tree: async () => tree,
    changed: async (before, after) => before === after ? [] : [{ status: 'M', path: 'file.txt' }],
    restore: async before => { restores++; tree = before; },
  }, { history });
  assert.equal((await service.undo()).result, 'done', 'cleanup cannot undo durable publication');
  assert.deepEqual(store.load().points, [first]);
  assert.deepEqual(history.load(), [first]);
  assert.equal(restores, 1);
  await assert.rejects(service.undo(), /fixture-ref-unavailable/);
  assert.equal(restores, 1, 'ref cleanup is retried before touching files');
  const previousPins = pins;
  await assert.rejects(history.begin(point()), /fixture-ref-unavailable/);
  assert.equal(pins, previousPins, 'blocked cleanup cannot accumulate new refs');
  failCleanup = false;
  assert.equal((await service.undo()).result, 'done');
  assert.equal(tree, first.before);
  assert.equal(restores, 2);
  assert.deepEqual(released, [second.id, first.id]);
  assert.deepEqual(store.load().points, []);
  assert.equal((await service.undo()).result, 'none');
});

function repositoryService(t, { initialize = true } = {}) {
  const root = fixture(t), cwd = path.join(root, 'project'), temporary = path.join(root, 'temporary');
  fs.mkdirSync(cwd); fs.mkdirSync(temporary);
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (initialize) git('init', '-q');
  const execute = command => execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', command], {
    cwd, env: { ...process.env, TMPDIR: temporary }, encoding: 'utf8', timeout: 10000,
  });
  const store = new CheckpointStore(cwd, 'session');
  const service = () => new TurnCheckpointService(new CheckpointGitAdapter(execute), {
    history: new PersistentCheckpointHistory(store, new CheckpointRefs(execute, store.key)),
  });
  return { cwd, git, store, service };
}

test('durable shared service undoes successive turns after restart and preserves a member commit and index', async t => {
  const { cwd, git, store, service } = repositoryService(t);
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'before\n'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'original');
  let checkpoints = service();
  const first = { turnRef: 'first' }; await checkpoints.take(first);
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'turn one\n'); await checkpoints.finish(first);
  await checkpoints.finish(first);
  assert.equal(store.load().points.length, 1, 'settlement is not recorded twice');
  const second = { turnRef: 'second' }; await checkpoints.take(second);
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'turn two\n'); fs.writeFileSync(path.join(cwd, 'new.txt'), 'new\n');
  git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'commit during turn');
  await checkpoints.finish(second);
  const head = git('rev-parse', 'HEAD'), index = fs.readFileSync(path.join(cwd, '.git/index'));
  git('gc', '--prune=now'); checkpoints = service();
  assert.equal((await checkpoints.undo()).result, 'done');
  assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'turn one\n');
  assert.equal(fs.existsSync(path.join(cwd, 'new.txt')), false);
  checkpoints = service(); assert.equal((await checkpoints.undo()).result, 'done');
  assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'before\n');
  assert.equal(git('rev-parse', 'HEAD'), head); assert.deepEqual(fs.readFileSync(path.join(cwd, '.git/index')), index);
  assert.equal(store.load().points.length, 0);
  assert.equal(git('for-each-ref', '--format=%(refname)', `refs/piagent/checkpoints/${store.key}`), '');
});

test('durable service refuses member drift with filenames, handles unborn Git and does nothing outside Git', async t => {
  const { cwd, store, service } = repositoryService(t);
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'member before\n');
  const checkpoints = service(), run = { turnRef: 'unborn' }; await checkpoints.take(run);
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'agent\n'); await checkpoints.finish(run);
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'member after\n');
  const result = await service().undo();
  assert.equal(result.result, 'refused'); assert.deepEqual(result.files, ['a.txt']);
  assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'member after\n');
  assert.equal(store.load().points.length, 1);
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'agent\n'); assert.equal((await service().undo()).result, 'done');
  assert.equal(fs.readFileSync(path.join(cwd, 'a.txt'), 'utf8'), 'member before\n');
  const plain = repositoryService(t, { initialize: false }), noGit = plain.service(), noRun = {};
  await noGit.take(noRun); await noGit.finish(noRun);
  assert.equal((await noGit.undo()).result, 'none'); assert.equal(fs.existsSync(path.join(plain.cwd, '.pi')), false);
});

test('checkpoint operation lock spans file effects and publication across processes', { timeout: 15000 }, async t => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const root = fixture(t), store = new CheckpointStore(root, 'operation'), savedPoint = point();
  store.save([savedPoint], 'absent');
  const file = path.join(root, 'member.txt'); fs.writeFileSync(file, 'after');
  const refs = { pin: async () => {}, release: async () => {} };
  let parentEffects = 0;
  const staleService = new TurnCheckpointService({ tree: async () => savedPoint.after,
    changed: async () => [{ status: 'M', path: 'member.txt' }], restore: async () => { parentEffects++; } },
  { history: new PersistentCheckpointHistory(store, refs) });
  const base = new URL('../packages/piagent-core/runtime/checkpoints/', import.meta.url);
  const source = `
    import fs from 'node:fs';
    import { once } from 'node:events';
    import { CheckpointStore } from ${JSON.stringify(new URL('checkpoint-store.mjs', base).href)};
    import { PersistentCheckpointHistory } from ${JSON.stringify(new URL('persistent-history.mjs', base).href)};
    import { TurnCheckpointService } from ${JSON.stringify(new URL('turn-checkpoints.mjs', base).href)};
    const point = ${JSON.stringify(savedPoint)}, store = new CheckpointStore(${JSON.stringify(root)}, 'operation');
    const service = new TurnCheckpointService({ tree: async () => point.after,
      changed: async (before, after) => before === after ? [] : [{ status: 'M', path: 'member.txt' }],
      restore: async () => {
        fs.writeFileSync(${JSON.stringify(file)}, 'before');
        process.send('effect-applied'); await once(process, 'message');
      } }, { history: new PersistentCheckpointHistory(store, { pin: async () => {}, release: async () => {} }) });
    const result = await service.undo(); process.send(result.result); process.disconnect();
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const exited = once(child, 'exit');
  let errors = ''; child.stderr.on('data', chunk => { errors += chunk; });
  assert.deepEqual(await once(child, 'message'), ['effect-applied', undefined]);
  assert.equal(fs.readFileSync(file, 'utf8'), 'before');
  assert.equal(store.load().points.length, 1, 'child has not published the new stack yet');
  await assert.rejects(staleService.undo(), /checkpoint-store-busy/);
  assert.equal(parentEffects, 0, 'second process cannot apply another effect during publication gap');
  const settled = once(child, 'message'); child.send('continue');
  assert.equal((await settled)[0], 'done');
  assert.equal((await exited)[0], 0, errors);
  assert.deepEqual(store.load().points, []);
  await assert.rejects(staleService.undo(), /checkpoint-state-stale/);
  assert.equal(parentEffects, 0); assert.equal(fs.existsSync(store.lock), false);
});

test('retired refs survive restart and deletion-before-acknowledgement without deleting retained refs', async t => {
  const root = fixture(t), temporary = path.join(root, 'temporary'), cwd = path.join(root, 'project');
  fs.mkdirSync(temporary); fs.mkdirSync(cwd);
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  git('init', '-q'); fs.writeFileSync(path.join(cwd, 'file'), 'before');
  const execute = command => execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', command], {
    cwd, env: { ...process.env, TMPDIR: temporary }, encoding: 'utf8', timeout: 10000,
  });
  const adapter = new CheckpointGitAdapter(execute), store = new CheckpointStore(cwd, 'cleanup-restart');
  const refs = new CheckpointRefs(execute, store.key), before = await adapter.tree();
  fs.writeFileSync(path.join(cwd, 'file'), 'after');
  const removed = { ...point(), before, after: await adapter.tree() }, kept = { ...removed, id: randomUUID() };
  const first = new PersistentCheckpointHistory(store, { pin: p => refs.pin(p), release: async () => { throw Error('cleanup offline'); } });
  await first.save([removed, kept]); await first.save([kept]);
  assert.deepEqual(new CheckpointStore(cwd, 'cleanup-restart').load().retired, [removed]);
  assert.equal(git('for-each-ref', '--format=%(refname)', refs.prefix).trim().split('\n').length, 4);
  const coldStore = new CheckpointStore(cwd, 'cleanup-restart'), save = coldStore.save.bind(coldStore);
  coldStore.save = (...args) => { if (args[2]?.clearRetired) throw Error('lost cleanup acknowledgement'); return save(...args); };
  const cold = new PersistentCheckpointHistory(coldStore, refs);
  await assert.rejects(cold.prepare(), /lost cleanup acknowledgement/);
  assert.deepEqual(store.load().retired, [removed], 'cleanup intent survives after refs were deleted');
  assert.equal(git('for-each-ref', '--format=%(refname)', `${refs.prefix}${removed.id}/`), '');
  assert.equal(git('for-each-ref', '--format=%(refname)', `${refs.prefix}${kept.id}/`).trim().split('\n').length, 2);
  const recovered = new PersistentCheckpointHistory(new CheckpointStore(cwd, 'cleanup-restart'), refs);
  await recovered.prepare();
  assert.deepEqual(store.load().retired, []); assert.deepEqual(recovered.load(), [kept]);
  git('gc', '--prune=now');
  assert.equal(git('cat-file', '-t', kept.before).trim(), 'tree');
  assert.equal(git('cat-file', '-t', kept.after).trim(), 'tree');
  assert.equal(fs.readFileSync(path.join(cwd, 'file'), 'utf8'), 'after');
  for (const failure of ['pin-response-lost', 'publication-failed']) {
    const unpublished = { ...kept, id: randomUUID() };
    const failedStore = new CheckpointStore(cwd, 'cleanup-restart'), publish = failedStore.save.bind(failedStore);
    failedStore.save = (...args) => {
      if (failure === 'publication-failed' && args[0].some(point => point.id === unpublished.id)) throw Error(failure);
      return publish(...args);
    };
    const failedHistory = new PersistentCheckpointHistory(failedStore, {
      pin: async point => { await refs.pin(point); if (failure === 'pin-response-lost' && point.id === unpublished.id) throw Error(failure); },
      release: point => refs.release(point),
    });
    await assert.rejects(failedHistory.save([kept, unpublished]), new RegExp(failure));
    const disk = store.load(); assert.deepEqual(disk.points, [kept]); assert.deepEqual(disk.staged, [unpublished]);
    assert.equal(git('for-each-ref', '--format=%(refname)', `${refs.prefix}${unpublished.id}/`).trim().split('\n').length, 2);
    const restarted = new PersistentCheckpointHistory(new CheckpointStore(cwd, 'cleanup-restart'), refs);
    await restarted.prepare();
    assert.deepEqual(store.load().staged, []); assert.deepEqual(store.load().retired, []);
    assert.equal(git('for-each-ref', '--format=%(refname)', `${refs.prefix}${unpublished.id}/`), '');
    assert.equal(git('for-each-ref', '--format=%(refname)', `${refs.prefix}${kept.id}/`).trim().split('\n').length, 2);
  }
});

test('checkpoint store reads version-one history and validates durable retired entries', t => {
  const root = fixture(t), store = new CheckpointStore(root, 'migration'), retained = point();
  store.save([retained], 'absent');
  fs.writeFileSync(store.file, JSON.stringify({ version: 1, sessionKey: store.key, points: [retained] }));
  const legacy = store.load(); assert.deepEqual(legacy.points, [retained]); assert.deepEqual(legacy.retired, []);
  const saved = store.save([], legacy.revision); assert.deepEqual(saved.retired, [retained]);
  assert.equal(JSON.parse(fs.readFileSync(store.file)).version, 4);
  for (const retired of [[{ ...retained, before: 'invalid' }], [retained, retained], Array(66).fill(retained)]) {
    fs.writeFileSync(store.file, JSON.stringify({ version: 2, sessionKey: store.key, points: [], retired }));
    assert.throws(() => store.load(), /checkpoint-state-invalid/);
  }
  fs.writeFileSync(store.file, JSON.stringify({ version: 2, sessionKey: store.key, points: [retained], retired: [retained] }));
  assert.throws(() => store.load(), /checkpoint-state-invalid/);
  for (const staged of [[{ ...retained, after: null }], [retained, retained], Array(66).fill(retained)]) {
    fs.writeFileSync(store.file, JSON.stringify({ version: 3, sessionKey: store.key, points: [], retired: [], staged }));
    assert.throws(() => store.load(), /checkpoint-state-invalid/);
  }
  fs.writeFileSync(store.file, JSON.stringify({ version: 3, sessionKey: store.key, points: [retained], retired: [], staged: [retained] }));
  assert.throws(() => store.load(), /checkpoint-state-invalid/);
});

for (const termination of ['killed', 'closed']) test(`live capture ownership blocks another process and a ${termination} owner releases unfinished refs`, { timeout: 15000 }, async t => {
  await import('../scripts/register-typescript-loader.mjs');
  const { PersonalCheckpointGit } = await import('../packages/piagent-core/runtime/checkpoints/personal-git.ts');
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const cwd = fixture(t), git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  git('init', '-q'); const file = path.join(cwd, 'file'); fs.writeFileSync(file, 'before');
  const store = new CheckpointStore(cwd, 'capture-owner');
  const open = () => {
    const adapter = new PersonalCheckpointGit(cwd, () => ({ policy: {}, profile: {}, readOnly: false }));
    return new TurnCheckpointService(adapter, { history: new PersistentCheckpointHistory(new CheckpointStore(cwd, 'capture-owner'), new CheckpointRefs(adapter.refsExecutor, store.key)) });
  };
  const first = open(), run = { turnRef: 'completed' }; await first.take(run);
  fs.writeFileSync(file, 'completed edit'); await first.finish(run);
  const completed = store.load().points;
  const base = new URL('../packages/piagent-core/runtime/checkpoints/', import.meta.url);
  const source = `
    import fs from 'node:fs';
    import { CheckpointStore } from ${JSON.stringify(new URL('checkpoint-store.mjs', base).href)};
    import { CheckpointRefs } from ${JSON.stringify(new URL('checkpoint-refs.mjs', base).href)};
    import { PersonalCheckpointGit } from ${JSON.stringify(new URL('personal-git.ts', base).href)};
    import { PersistentCheckpointHistory } from ${JSON.stringify(new URL('persistent-history.mjs', base).href)};
    import { TurnCheckpointService } from ${JSON.stringify(new URL('turn-checkpoints.mjs', base).href)};
    const cwd = ${JSON.stringify(cwd)}, store = new CheckpointStore(cwd, 'capture-owner');
    const adapter = new PersonalCheckpointGit(cwd, () => ({ policy: {}, profile: {}, readOnly: false }));
    const service = new TurnCheckpointService(adapter, { history: new PersistentCheckpointHistory(store, new CheckpointRefs(adapter.refsExecutor, store.key)) });
    await service.take({ turnRef: 'unfinished' });
    fs.writeFileSync(${JSON.stringify(file)}, 'unfinished edit');
    process.send('captured'); await new Promise(resolve => process.once('message', resolve));
    await service.close(); process.send('closed'); await new Promise(resolve => process.once('message', resolve));
  `;
  const child = spawn(process.execPath, ['--import', new URL('../scripts/register-typescript-loader.mjs', import.meta.url).href,
    '--input-type=module', '--eval', source], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const exited = once(child, 'exit');
  assert.equal((await once(child, 'message'))[0], 'captured');
  const pending = store.load().capture; assert.equal(pending.pid, child.pid); assert.equal(pending.point.after, null);
  assert.equal(git('for-each-ref', '--format=%(refname)', `refs/piagent/checkpoints/${store.key}/`).trim().split('\n').length, 3);
  const contender = open();
  await assert.rejects(contender.list(), /checkpoint-turn-owned/);
  await assert.rejects(contender.take({ turnRef: 'competitor' }), /checkpoint-turn-owned/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'unfinished edit');
  if (termination === 'killed') { child.kill('SIGKILL'); await exited; }
  else {
    const closed = once(child, 'message'); child.send('close'); assert.equal((await closed)[0], 'closed');
    assert.doesNotThrow(() => process.kill(child.pid, 0), 'the old Gateway process is still alive');
  }
  assert.deepEqual((await contender.list()).points.map(p => p.id), completed.map(p => p.id));
  assert.equal(store.load().capture, null); assert.deepEqual(store.load().retired, []);
  assert.equal(git('for-each-ref', '--format=%(refname)', `refs/piagent/checkpoints/${store.key}/`).trim().split('\n').length, 2);
  assert.equal(fs.readFileSync(file, 'utf8'), 'unfinished edit', 'recovery must not attribute later edits to a crashed turn');
  assert.equal((await contender.undo()).result, 'refused');
  assert.deepEqual(store.load().points, completed);
  if (termination === 'closed') { child.kill('SIGKILL'); await exited; }
});
