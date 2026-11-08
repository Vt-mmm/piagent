import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { ManagedToolBoundary } from '../packages/piagent-core/managed/tool-boundary.mjs';
import { cloneProject, takeBack, takeBackText, sweepGeneral, recordGeneral, discardClone } from '../packages/piagent-core/managed/general-clone.mjs';
import { piSdkRoot } from './helpers/pi-sdk.mjs';

const sdkRoot = piSdkRoot();
const supported = process.platform === 'darwin' && fs.existsSync(path.join(sdkRoot, 'dist/index.js'));
const text = result => result.content.filter(x => x.type === 'text').map(x => x.text).join('\n');
const identity = { name: 'Fixture', email: 'fixture@example.test' };

function projectFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'general-clone-')));
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  const git = (...args) => execFileSync('/usr/bin/git', ['-C', project, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); fs.writeFileSync(path.join(project, 'a.txt'), 'one\n');
  git('add', '.'); git('-c', 'user.name=F', '-c', 'user.email=f@example.test', 'commit', '-qm', 'base');
  const snapshot = () => ({ refs: git('for-each-ref'), head: git('rev-parse', 'HEAD'), status: git('status', '--porcelain'), file: fs.readFileSync(path.join(project, 'a.txt'), 'utf8') });
  return { root, project, git, snapshot, managed: { cwd: project, boundary: { git: '/usr/bin/git', userHome: os.homedir() } } };
}
const writerOn = clone => new ManagedToolBoundary({ cwd: clone.dir, sdkRoot, readOnly: false, commands: true, identity, readRoots: [clone.objects] });

test('a writer in the clone commits there; the project is unreachable and its refs are untouched', { skip: !supported, timeout: 120000 }, async () => {
  const f = projectFixture(), before = f.snapshot();
  fs.writeFileSync(path.join(f.project, 'dirty.txt'), 'uncommitted\n');
  const clone = await cloneProject(f.managed), writer = writerOn(clone);
  try {
    assert.deepEqual(clone.dirty, ['dirty.txt']);
    assert.ok(!fs.existsSync(path.join(clone.dir, 'dirty.txt')), 'uncommitted project work is not in the clone');
    await writer.invoke('write', { path: 'b.txt', content: 'new\n' });
    // Every way to reach the project from inside the sandbox.
    const attempts = [
      `echo x > '${f.project}/a.txt'`,
      `echo x > '${f.project}/.git/refs/heads/main'`,
      `/usr/bin/git -C '${f.project}' update-ref refs/heads/hijack HEAD`,
      `/usr/bin/git -C '${f.project}' commit --allow-empty -m x`,
      `/usr/bin/git push '${f.project}' HEAD:refs/heads/main`,
    ];
    for (const command of attempts) await writer.invoke('bash', { command: `${command}; true`, timeout: 20 });
    // The borrowed objects are readable but not writable, whatever the helper tries.
    assert.match(text(await writer.invoke('bash', { command: `/usr/bin/git cat-file -t HEAD; echo x > '${clone.objects}/pack/zz'; echo "write:$?"; /usr/bin/git gc --prune=now -q; /usr/bin/git fsck 2>&1 | head -3`, timeout: 60 })), /commit[\s\S]*write:1/);
    assert.ok(!fs.existsSync(path.join(clone.objects, 'pack/zz')));
    const commit = text(await writer.invoke('bash', { command: '/usr/bin/git add -A && /usr/bin/git commit -qm "general work" && /usr/bin/git log --oneline | head -1', timeout: 30 }));
    assert.match(commit, /general work/, commit);
    assert.deepEqual(f.snapshot(), { ...before, status: '?? dirty.txt' }, 'the project, its refs and HEAD are exactly as before');
    const back = await takeBack(f.managed, clone);
    assert.match(back.ref, /^refs\/general\//);
    assert.equal(f.git('show', `${back.ref}:b.txt`), 'new'); f.git('fsck', '--no-dangling');
    assert.equal(f.git('rev-parse', 'HEAD'), before.head); assert.equal(f.git('rev-parse', 'refs/heads/main'), before.head);
    assert.deepEqual(f.git('for-each-ref', '--format=%(refname)').split('\n').sort(), ['refs/general/' + clone.id, 'refs/heads/main'].sort());
    assert.match(takeBackText(clone, back), /dirty\.txt/);
    assert.ok(!fs.existsSync(clone.root) && !fs.existsSync(clone.cache), 'the clone and its package cache are gone once its commits are back');
  } finally { await writer.dispose(); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('a clone the helper tampered with is refused and removed; its config starts nothing on the host', { skip: !supported }, async () => {
  const f = projectFixture(), before = f.snapshot(), marker = path.join(f.root, 'ran');
  const clone = await cloneProject(f.managed);
  try {
    execFileSync('/usr/bin/git', ['-C', clone.dir, '-c', 'user.name=F', '-c', 'user.email=f@example.test', 'commit', '-q', '--allow-empty', '-m', 'work']);
    execFileSync('/usr/bin/git', ['-C', clone.dir, 'config', 'core.fsmonitor', `touch ${marker}; echo`]);
    execFileSync('/usr/bin/git', ['-C', clone.dir, 'config', 'core.alternateRefsCommand', `touch ${marker}`]);
    fs.mkdirSync(path.join(clone.dir, '.git/hooks'), { recursive: true }); fs.writeFileSync(path.join(clone.dir, '.git/hooks/reference-transaction'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    const ok = await takeBack(f.managed, clone);
    assert.ok(ok.ref && !fs.existsSync(marker), 'the helper-written config and hooks did not run');
    assert.ok(!fs.existsSync(clone.root));
    f.git('update-ref', '-d', ok.ref); assert.deepEqual(f.snapshot(), before);
    // Pointing the clone's objects at another path is refused: nothing comes back.
    const second = await cloneProject(f.managed);
    // Borrowing another repository's objects than the project's own is refused: nothing comes back.
    const other = path.join(f.root, 'other'); fs.mkdirSync(other);
    execFileSync('/usr/bin/git', ['-C', other, 'init', '-q']);
    fs.writeFileSync(path.join(second.dir, '.git/objects/info/alternates'), path.join(other, '.git/objects') + '\n');
    await assert.rejects(takeBack(f.managed, second), /point outside/);
    assert.ok(!fs.existsSync(second.root)); assert.deepEqual(f.snapshot(), before);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('a project that is not a repository with a commit gets no clone', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'general-nogit-')));
  // Off macOS the platform gate refuses first; either way nothing is cloned.
  const refusal = process.platform === 'darwin' ? /managed-general-needs-git/ : /managed-general-unavailable/;
  try { await assert.rejects(cloneProject({ cwd: root, boundary: { git: '/usr/bin/git', userHome: os.homedir() } }), refusal); assert.deepEqual(fs.readdirSync(root), []); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('recovery removes only a clone the session recorded and the folder proves it made; the rest is reported', { skip: !supported }, async () => {
  const f = projectFixture(), tmp = fs.realpathSync(os.tmpdir()), entries = [];
  const managed = { ...f.managed, session: { sessionManager: { appendCustomEntry: (customType, data) => entries.push({ type: 'custom', customType, data }), getEntries: () => entries } } };
  const crashed = await cloneProject(managed); recordGeneral(managed, crashed, 'running');      // a run that died
  const foreign = fs.mkdtempSync(path.join(tmp, 'piagent-general-')); fs.writeFileSync(path.join(foreign, 'keep.txt'), 'not ours');
  recordGeneral(managed, { id: 'forged', base: 'x', token: 'wrong', root: foreign }, 'running');  // a record naming a folder that does not prove it
  const unrelated = fs.mkdtempSync(path.join(tmp, 'piagent-general-')); // matches the name, was never recorded
  try {
    const swept = sweepGeneral(managed);
    assert.deepEqual(swept.removed, [crashed.id]); assert.deepEqual(swept.unproven, [foreign]);
    assert.ok(!fs.existsSync(crashed.root) && fs.existsSync(path.join(foreign, 'keep.txt')) && fs.existsSync(unrelated));
    // A run this process is still running is not recovered.
    const running = await cloneProject(managed); recordGeneral(managed, running, 'running'); managed.liveClones = new Set([running.root]);
    assert.deepEqual(sweepGeneral(managed).removed, []); assert.ok(fs.existsSync(running.root));
    discardClone(running);
  } finally { for (const d of [foreign, unrelated]) fs.rmSync(d, { recursive: true, force: true }); fs.rmSync(f.root, { recursive: true, force: true }); }
});
