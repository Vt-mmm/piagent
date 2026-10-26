import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { reviewParts, reviewText, reviewUnavailableReason } from '../packages/piagent-core/managed/patch-snapshot.mjs';

const worker = path.resolve(import.meta.dirname, '../packages/piagent-core/managed/review-snapshot-worker.mjs');
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', ...args], { stdio: 'pipe' });

function repository(folder, name, files) {
  const dir = path.join(folder, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  for (const [file, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); }
  git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'baseline');
}

// Runs the worker as the boundary does: the folder as cwd, the scope file in
// its temporary directory. Returns the snapshot, or the error line.
function snapshot(folder, scope) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'review-worker-tmp-'));
  try {
    const extra = [];
    if (scope) { const name = `scope-${randomUUID()}.json`; fs.writeFileSync(path.join(temporary, name), JSON.stringify(scope)); extra.push(name); }
    const run = spawnSync(process.execPath, [worker, 'file', ...extra], { cwd: folder, encoding: 'utf8', env: { ...process.env, TMPDIR: temporary, LANG: 'vi_VN.UTF-8' } });
    if (run.status !== 0) return { error: run.stderr };
    const [, , name] = run.stdout.trim().split(' ');
    return { value: JSON.parse(fs.readFileSync(path.join(temporary, name), 'utf8')) };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

test('a folder of several repositories is reviewed per repository, paths relative to the folder', t => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-multi-repo-')));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  repository(folder, 'api', { 'src/a.js': 'one\n', 'src/b.js': 'two\n' });
  repository(folder, 'web', { 'app.ts': 'old\n' });
  fs.writeFileSync(path.join(folder, 'api/src/a.js'), 'one changed\n');
  fs.writeFileSync(path.join(folder, 'api/src/b.js'), 'two changed\n');
  fs.writeFileSync(path.join(folder, 'api/src/new.js'), 'brand new\n');
  fs.writeFileSync(path.join(folder, 'web/app.ts'), 'new\n');
  fs.writeFileSync(path.join(folder, 'notes.md'), 'scratch\n');

  const { value, error } = snapshot(folder, ['api/src/a.js', 'api/src/b.js', 'api/src/new.js', 'web/app.ts', 'notes.md']);
  assert.equal(error, undefined, error);
  assert.deepEqual(value.repositories, ['api', 'web']);
  assert.match(value.patch, /^diff --git a\/api\/src\/a\.js b\/api\/src\/a\.js$/m);
  assert.match(value.patch, /^\+two changed$/m);
  assert.match(value.patch, /^diff --git a\/web\/app\.ts b\/web\/app\.ts$/m);
  assert.deepEqual(value.untracked.map(f => [f.path, f.mode === 'outside' ? 'outside' : f.encoding]), [['api/src/new.js', 'utf8'], ['notes.md', 'outside']]);

  const text = reviewText({ patch: JSON.stringify(value), digest: 'd' });
  assert.match(text, /diff against HEAD of each repository in this folder \(api, web\)/);
  assert.match(text, /notes\.md \(outside any Git repository, not reviewed\)/);
  const parts = reviewParts({ patch: JSON.stringify(value), digest: 'd' });
  assert.deepEqual(parts.omitted, [{ path: 'notes.md', bytes: 8, outside: true }]);
  assert.match(parts.parts[0].text, /Not read: notes\.md \(outside any Git repository, not reviewed\)/);
});

test('a folder with no repository for the change says not_git in one line, whatever the locale', t => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-no-repo-')));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  fs.writeFileSync(path.join(folder, 'a.txt'), 'x\n'); fs.writeFileSync(path.join(folder, 'b.txt'), 'y\n');
  for (const scope of [['a.txt', 'b.txt'], null]) {
    const { error } = snapshot(folder, scope);
    assert.equal(error.trim().split('\n').length, 1, error);
    assert.doesNotMatch(error, /usage|no-index/);
    assert.equal(reviewUnavailableReason(error), 'not_git', error);
  }
});

test('inside one repository the snapshot is unchanged', t => {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-one-repo-')));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  repository(folder, '.', { 'a.js': 'one\n' });
  fs.writeFileSync(path.join(folder, 'a.js'), 'two\n');
  const { value, error } = snapshot(folder, ['a.js']);
  assert.equal(error, undefined, error);
  assert.equal(value.repositories, undefined);
  assert.match(value.patch, /^diff --git a\/a\.js b\/a\.js$/m);
});
