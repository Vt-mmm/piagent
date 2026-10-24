import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findProjects, folderKey, folderName, rootCommit } from '../packages/piagent-core/managed/workspace-projects.mjs';

// Studio's project warnings know a folder without a readable remote too:
// a git checkout by its root commit (the same on every computer with that
// history), anything else by a hash of the computer and path, each with its
// folder's name and never its path.
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
const temp = t => { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-projects-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return fs.realpathSync(root); };
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { env }).toString().trim();
function repo(dir, { remote, commit = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  if (remote) git(dir, 'remote', 'add', ...remote);
  if (commit) { fs.writeFileSync(path.join(dir, 'README.md'), 'x'); git(dir, 'add', '.'); git(dir, 'commit', '-qm', 'First'); }
}

test('a checkout with a readable remote is its repository; without one, its root commit, shared by every clone', async t => {
  const root = temp(t);
  repo(path.join(root, 'shop'), { remote: ['origin', 'git@github.com:Acme/Shop.git'] });
  assert.deepEqual(await findProjects(path.join(root, 'shop')), [{ key: 'github.com/acme/shop', name: 'shop' }]);
  const local = path.join(root, 'Ví dụ noi bo');
  repo(local);
  const sha = git(local, 'rev-list', '--max-parents=0', 'HEAD');
  assert.equal(await rootCommit(local), sha);
  assert.deepEqual(await findProjects(local), [{ key: `local/git/${sha}`, name: 'Ví dụ noi bo' }]);
  // A clone from a path (a remote repoKey cannot read) and a checkout with
  // two remotes but no origin are the same project as the original.
  const clone = path.join(root, 'copy');
  execFileSync('git', ['clone', '-q', local, clone], { env });
  git(path.join(root, 'shop'), 'remote', 'add', 'mirror', 'git@gitlab.com:x/y.git');
  assert.deepEqual((await findProjects(clone)).map(p => p.key), [`local/git/${sha}`]);
  const two = path.join(root, 'two');
  execFileSync('git', ['clone', '-q', '-o', 'upstream', local, two], { env });
  git(two, 'remote', 'add', 'fork', 'git@github.com:me/fork.git');
  assert.deepEqual((await findProjects(two)).map(p => p.key), [`local/git/${sha}`]);
  // From a subfolder: still the checkout, named by its top folder.
  fs.mkdirSync(path.join(local, 'src'));
  assert.deepEqual(await findProjects(path.join(local, 'src')), [{ key: `local/git/${sha}`, name: 'Ví dụ noi bo' }]);
});

test('a checkout without commits and a plain folder are local to the computer; a folder of checkouts lists each', async t => {
  const root = temp(t);
  const empty = path.join(root, 'empty');
  repo(empty, { commit: false });
  assert.deepEqual(await findProjects(empty, { host: 'pc-a' }), [{ key: folderKey(empty, 'pc-a'), name: 'empty' }]);
  const plain = path.join(root, 'notes');
  fs.mkdirSync(plain);
  const [only] = await findProjects(plain, { host: 'pc-a' });
  assert.match(only.key, /^local\/dir\/[0-9a-f]{24}$/);
  assert.equal(only.key, folderKey(plain, 'pc-a'), 'stable on one computer');
  assert.notEqual(only.key, folderKey(plain, 'pc-b'), 'another computer is another folder');
  assert.ok(!JSON.stringify(only).includes(root), 'the path never leaves the computer');
  const many = path.join(root, 'work');
  repo(path.join(many, 'api'), { remote: ['origin', 'https://github.com/acme/api.git'] });
  repo(path.join(many, 'tool'));
  const sha = git(path.join(many, 'tool'), 'rev-list', '--max-parents=0', 'HEAD');
  assert.deepEqual(await findProjects(many), [{ key: 'github.com/acme/api', name: 'api' }, { key: `local/git/${sha}`, name: 'tool' }]);
  assert.deepEqual(await findProjects(path.join(root, 'missing')), [], 'an unreadable folder has none');
});

test('a folder name is kept readable and short, never a path', () => {
  assert.equal(folderName('/a/b/ shop\tnoi  bo '), 'shop noi bo');
  assert.equal(folderName('/a/' + 'é'.repeat(90)), 'é'.repeat(80));
  assert.equal(folderName('/a/x\u0007y'), 'xy');
});
