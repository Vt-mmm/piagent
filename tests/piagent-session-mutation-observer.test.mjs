import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SessionMutationObserver } from '../packages/piagent-core/runtime/inspection/session-mutation-observer.ts';

const policy = { policy: {}, profile: {} };
function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'session-mutation-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const observer = new SessionMutationObserver(), file = path.join(cwd, 'a.txt');
  fs.writeFileSync(file, 'member baseline\n');
  const begin = (id, content, session = 's') => observer.begin(cwd, session, id, 'write', { path: 'a.txt', content }, ['a.txt'], policy);
  const finish = (id, success = true, session = 's') => observer.finish(cwd, session, id, 'write', success, policy);
  return { cwd, observer, file, begin, finish, current: () => observer.current(cwd, 's', 'a.txt', policy) };
}
test('exact successive writes retain the member baseline; member edits break the chain', t => {
  const f = fixture(t);
  f.begin('one', 'agent one\n'); fs.writeFileSync(f.file, 'agent one\n'); f.finish('one');
  assert.equal(f.current().baseline.content, 'member baseline\n');
  f.begin('two', 'agent two\n'); fs.writeFileSync(f.file, 'agent two\n'); f.finish('two');
  assert.equal(f.current().baseline.content, 'member baseline\n');
  fs.writeFileSync(f.file, 'member intervened\n');
  assert.equal(f.current(), null);
  f.begin('three', 'agent three\n'); fs.writeFileSync(f.file, 'agent three\n'); f.finish('three');
  assert.equal(f.current().baseline.content, 'member intervened\n');
  const copy = f.current(); copy.baseline.content = 'tampered';
  assert.equal(f.current().baseline.content, 'member intervened\n');
  f.observer.clear(f.cwd, 's'); assert.equal(f.current(), null);
});
test('wrong output, failed tools, and mismatched sessions cannot create evidence', t => {
  const f = fixture(t);
  f.begin('wrong', 'expected'); fs.writeFileSync(f.file, 'different'); f.finish('wrong'); assert.equal(f.current(), null);
  f.begin('failed', 'expected'); fs.writeFileSync(f.file, 'expected'); f.finish('failed', false); assert.equal(f.current(), null);
  f.begin('other', 'next', 'other'); fs.writeFileSync(f.file, 'next'); f.finish('other'); assert.equal(f.current(), null);
});
test('exact edit proof uses a safe reader and excludes protected and symlink paths', t => {
  const f = fixture(t);
  const input = { path: 'a.txt', edits: [{ oldText: 'member', newText: 'agent' }] };
  f.observer.begin(f.cwd, 's', 'edit', 'edit', input, ['a.txt'], policy);
  fs.writeFileSync(f.file, 'agent baseline\n'); f.observer.finish(f.cwd, 's', 'edit', 'edit', true, policy);
  assert.equal(f.current().baseline.content, 'member baseline\n');
  const restricted = { policy: { protectedPaths: ['a.txt'] }, profile: {} };
  assert.equal(f.observer.current(f.cwd, 's', 'a.txt', restricted), null);
  fs.symlinkSync(f.cwd, path.join(f.cwd, 'link'));
  f.observer.begin(f.cwd, 's', 'link', 'edit', { ...input, path: 'link/a.txt' }, ['link/a.txt'], policy);
  fs.writeFileSync(f.file, 'agent after link'); f.observer.finish(f.cwd, 's', 'link', 'edit', true, policy);
  assert.equal(f.observer.current(f.cwd, 's', 'link/a.txt', policy), null);
});

test('new files retain an absent baseline when restored between workers', t => {
  const f = fixture(t); fs.unlinkSync(f.file);
  f.begin('create', 'created'); fs.writeFileSync(f.file, 'created'); f.finish('create');
  assert.equal(f.current().baseline.digest, 'absent');
  f.begin('extend', 'extended'); fs.writeFileSync(f.file, 'extended'); f.finish('extend');
  assert.equal(f.current().baseline.digest, 'absent');
  const resumed = new SessionMutationObserver();
  resumed.restore(f.cwd, 's', 'a.txt', f.current(), policy);
  assert.equal(resumed.current(f.cwd, 's', 'a.txt', policy).baseline.digest, 'absent');
  const forged = f.current(); forged.baseline.content = 'not empty';
  resumed.clear(f.cwd, 's'); resumed.restore(f.cwd, 's', 'a.txt', forged, policy);
  assert.equal(resumed.current(f.cwd, 's', 'a.txt', policy), null);
});

test('revert observations require both the recorded preimage and exact committed bytes', async t => {
  const { createHash } = await import('node:crypto');
  const digest = value => createHash('sha256').update(value).digest('hex');
  for (const scenario of ['success', 'wrong-preimage', 'concurrent-member', 'protected', 'fully-restored']) {
    const f = fixture(t);
    f.begin('edit', 'agent one\nagent two\n'); fs.writeFileSync(f.file, 'agent one\nagent two\n'); f.finish('edit');
    const before = f.current();
    const intended = scenario === 'fully-restored' ? 'member baseline\n' : 'agent one\n';
    fs.writeFileSync(f.file, scenario === 'concurrent-member' ? 'member raced\n' : intended);
    f.observer.reverted(f.cwd, 's', 'a.txt', scenario === 'wrong-preimage' ? digest('other') : before.currentDigest,
      digest(intended), scenario === 'protected' ? { policy: { protectedPaths: ['a.txt'] }, profile: {} } : policy);
    const after = f.current();
    if (scenario !== 'success') assert.equal(after, null, scenario);
    else {
      assert.equal(after.baseline.content, before.baseline.content);
      assert.equal(after.currentDigest, digest(intended));
      assert.notEqual(after.evidenceRef, before.evidenceRef);
    }
  }
});
