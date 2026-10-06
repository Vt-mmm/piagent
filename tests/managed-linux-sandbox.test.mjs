import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {BWRAP, bubblewrapArgs, credentialFiles, credentialName} from '../packages/piagent-core/managed/linux-sandbox.mjs';
import {ManagedToolBoundary} from '../packages/piagent-core/managed/tool-boundary.mjs';

// The company sandbox on Linux and in WSL2 (Windows), with bubblewrap: the
// same promises as Seatbelt on macOS, from mounts.
const text = (result) => (result?.content ?? []).map((part) => part.text ?? '').join('');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), {recursive: true}); fs.writeFileSync(file, value); };
function piSdk() {
  const personal = path.join(os.homedir(), '.pi/npm-global/lib/node_modules/@earendil-works/pi-coding-agent');
  if (process.env.PI_MANAGED_TEST_SDK) return process.env.PI_MANAGED_TEST_SDK;
  if (fs.existsSync(personal)) return personal;
  try { return path.join(execFileSync('npm', ['root', '-g'], {encoding: 'utf8'}).trim(), '@earendil-works/pi-coding-agent'); } catch { return personal; }
}
const sdkRoot = piSdk();
const usable = process.platform === 'linux' && BWRAP && fs.existsSync(sdkRoot)
  && spawnSync(BWRAP, ['--ro-bind', '/', '/', '--unshare-net', 'true']).status === 0;

test('credential files are found by the names the macOS profile closes', () => {
  const roots = ['/p'];
  for (const name of ['.env', '.env.local', '.env.production', 'credentials', 'credentials.json', '.npmrc', '.netrc']) assert.equal(credentialName(name, '/p/a', roots), true, name);
  for (const name of ['.env.example', '.env.sample', '.env.template', 'environment.ts', 'credential-form.tsx', 'auth.ts']) assert.equal(credentialName(name, '/p/a', roots), false, name);
  assert.equal(credentialName('auth.json', '/p', roots), true, 'a project root auth.json (Composer)');
  assert.equal(credentialName('auth.json', '/p/.codex', roots), true, 'in a dot folder');
  assert.equal(credentialName('auth.json', '/p/src/i18n', roots), false, 'a translation file');
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'linux-credentials-')));
  try {
    for (const file of ['.env', 'api/.env.local', 'api/.env.example', 'node_modules/x/.env', 'deep/a/b/credentials']) write(path.join(base, file), 'x');
    assert.deepEqual(credentialFiles([base]).map((item) => path.relative(base, item.path)).sort(), ['.env', 'api/.env.local', 'deep/a/b/credentials']);
  } finally { fs.rmSync(base, {recursive: true, force: true}); }
});

test('mounts go parent first, the project over its reference folder, masks last, then the root read-only', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'linux-args-')));
  try {
    const home = path.join(base, 'home'), project = path.join(home, 'Documents/shop'), cache = path.join(home, '.cache/piagent/sandbox/x');
    for (const dir of [project, cache, path.join(base, 'sdk'), path.join(base, 'runtime'), path.join(base, 'tmp')]) fs.mkdirSync(dir, {recursive: true});
    write(path.join(project, '.env'), 'x');
    const args = (network) => bubblewrapArgs({cwd: project, sdkRoot: path.join(base, 'sdk'), runtimeRoot: path.join(base, 'runtime'), temporary: path.join(base, 'tmp'),
      empty: path.join(base, 'tmp/empty'), node: process.execPath, caches: [cache], references: [path.join(home, 'Documents')], network,
      credentials: [{path: path.join(project, '.env'), directory: false}]});
    const offline = args(false), joined = offline.join(' ');
    assert.ok(offline.includes('--unshare-net')); assert.ok(!args(true).includes('--unshare-net'), 'an approved command has network');
    assert.ok(joined.indexOf(`--ro-bind ${home}/Documents`) < joined.indexOf(`--bind ${project}`), 'the project is writable over its read-only parent');
    assert.ok(joined.indexOf(`--bind ${project}`) < joined.indexOf(`--ro-bind ${base}/tmp/empty ${project}/.env`), 'masks come after mounts');
    assert.deepEqual(offline.slice(-4), ['--remount-ro', '/', '--chdir', project]);
    assert.ok(!joined.includes('/run/WSL'), 'WSL interop is never mounted');
  } finally { fs.rmSync(base, {recursive: true, force: true}); }
});

test('the Linux sandbox: project writable, other folders read-only for reference, secrets and network closed', {skip: !usable, timeout: 180000}, async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'linux-sandbox-')));
  const home = path.join(base, 'home'), project = path.join(home, 'projects/shop');
  for (const [file, value] of [['.ssh/id_ed25519', 'SSH-SECRET'], ['.bashrc', 'BASHRC-SECRET'], ['Documents/old shop/notes.md', 'REFERENCE-OK'],
    ['Documents/old shop/.env', 'REF-SECRET'], ['projects/shop/.env', 'PROJECT-SECRET'], ['projects/shop/app.js', 'export const total = 1;\n']]) write(path.join(home, file), value);
  execFileSync('git', ['init', '-q', project]);
  const boundary = new ManagedToolBoundary({cwd: project, sdkRoot, protectedRoots: [], userHome: home, identity: {name: 'Dev', email: 'dev@example.com'}});
  const helper = new ManagedToolBoundary({cwd: project, sdkRoot, protectedRoots: [], userHome: home, readOnly: true, commands: true});
  const bash = (command, network = false, on = boundary) => on.invoke('bash', {command, timeout: 60}, undefined, undefined, undefined, {network}).then(text);
  try {
    await boundary.invoke('write', {path: 'src/n.txt', content: 'hello'});
    assert.equal(text(await boundary.invoke('read', {path: 'src/n.txt'})).trim(), 'hello');
    // Refused, or (under /tmp, the sandbox's own) kept away from this machine.
    await bash(`echo x > ${JSON.stringify(path.join(home, 'outside.txt'))}`).catch(() => {});
    assert.equal(fs.existsSync(path.join(home, 'outside.txt')), false, 'nothing is written outside the project');
    for (const secret of ['.ssh/id_ed25519', '.bashrc']) assert.doesNotMatch(await bash(`cat ${JSON.stringify(path.join(home, secret))} 2>&1 || true`), /SECRET/);
    assert.equal((await bash('wc -c < .env')).trim(), '0', 'the project .env reads empty');
    assert.match(text(await boundary.invoke('read', {path: '~/Documents/old shop/notes.md'})), /REFERENCE-OK/);
    assert.equal((await bash(`wc -c < ${JSON.stringify(path.join(home, 'Documents/old shop/.env'))}`)).trim(), '0');
    await assert.rejects(bash(`echo x >> ${JSON.stringify(path.join(home, 'Documents/old shop/notes.md'))}`), /Read-only file system/);
    assert.match(await bash('curl -sS -m 5 https://example.com -o /dev/null && echo REACHED || echo blocked'), /blocked/);
    assert.match(await bash(`node -e "const s=require('http').createServer((q,r)=>r.end('own-ok')).listen(0,'127.0.0.1',async()=>{console.log(await (await fetch('http://127.0.0.1:'+s.address().port)).text());s.close()})"`), /own-ok/);
    assert.doesNotMatch(await bash(`cat ${JSON.stringify(path.join(home, 'Documents/old shop/notes.md'))} 2>&1 || true`, true), /REFERENCE-OK/, 'an approved command reads the project only');
    await bash('nohup sleep 271 >/dev/null 2>&1 & echo started');
    assert.equal(execFileSync('ps', ['-eo', 'args'], {encoding: 'utf8'}).split('\n').some((line) => line.startsWith('sleep 271')), false, 'its processes end with the command');
    await assert.rejects(bash('echo x > helper.txt', false, helper), /Read-only file system/);
    assert.match(await bash('git add app.js && git commit -qm init && git log -1 --format=%an'), /Dev/);
  } finally { await boundary.dispose(); await helper.dispose(); fs.rmSync(base, {recursive: true, force: true}); }
});
