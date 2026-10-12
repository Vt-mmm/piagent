import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {workingTreeSnapshot} from '../packages/piagent-core/extensions/task-state.js';

// Found live on Windows: a project on /mnt/d seen from WSL. Git's walk of the
// tree took far longer than the page waits, the scan is synchronous, and the
// company Gateway answered nobody meanwhile. A `git` whose diff takes 5 s
// stands in for that file system.
test('an inspection gives up on a working tree Git cannot scan in time, and does not start again at once', {skip: process.platform === 'win32', timeout: 60000}, () => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'slow-git-'))), repo = path.join(temp, 'repo'), bin = path.join(temp, 'bin');
  const realGit = execFileSync('/usr/bin/env', ['which', 'git'], {encoding: 'utf8'}).trim(), calls = path.join(temp, 'diff-calls');
  fs.mkdirSync(repo); fs.mkdirSync(bin);
  const git = (...args) => execFileSync(realGit, ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {stdio: 'ignore'});
  git('init', '-q'); fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n'); git('add', '-A'); git('commit', '-qm', 'first');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nfor arg in "$@"; do if [ "$arg" = diff ]; then echo x >> ${JSON.stringify(calls)}; sleep 5; fi; done\nexec ${JSON.stringify(realGit)} "$@"\n`, {mode: 0o755});
  const previous = process.env.PATH; process.env.PATH = `${bin}${path.delimiter}${previous}`;
  try {
    let started = Date.now();
    const first = workingTreeSnapshot(repo, {gitTimeoutMs: 400});
    assert.ok(Date.now() - started < 3000, `the scan was stopped (${Date.now() - started} ms)`);
    const unavailable = Object.entries(first).find(([file]) => file.endsWith('.working-tree-enumeration-unavailable'));
    assert.ok(unavailable, 'the snapshot says the tree could not be enumerated');
    assert.equal(first['a.txt'], undefined);
    started = Date.now();
    const second = workingTreeSnapshot(repo, {gitTimeoutMs: 400});
    assert.ok(Date.now() - started < 300, `a slow root is not scanned again by the next inspection (${Date.now() - started} ms)`);
    assert.deepEqual(Object.keys(second), Object.keys(first));
    assert.equal(fs.readFileSync(calls, 'utf8').trim().split('\n').length, 1);
    // Completion evidence passes no limit: it waits for Git and reads the change.
    assert.ok(workingTreeSnapshot(repo)['a.txt'], 'without a limit the scan completes as before');
  } finally { process.env.PATH = previous; fs.rmSync(temp, {recursive: true, force: true}); }
});
