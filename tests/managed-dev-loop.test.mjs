import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { ManagedToolBoundary } from '../packages/piagent-core/managed/tool-boundary.mjs';
import { piSdkRoot } from './helpers/pi-sdk.mjs';

// One developer loop in one company sandbox, the way a member works in an
// IDE: a branch, an edit, the tests, a build, make, the app's own server, a
// local database, a Python environment. Each step runs without asking; the
// internet is the one step that names its approval. No network is used.
const sdkRoot = piSdkRoot();
const has = tool => { try { execFileSync('/usr/bin/which', [tool], { stdio: 'ignore' }); return true; } catch { return false; } };
const text = result => (result.content ?? []).map(part => part.text ?? '').join('').trim();

function project() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-dev-loop-'))), app = path.join(base, 'app');
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0', type: 'module', scripts: { test: 'node --test', build: 'node build.mjs' } }, null, 2));
  fs.writeFileSync(path.join(app, 'sum.mjs'), 'export const sum = (a, b) => a - b;\n');
  fs.writeFileSync(path.join(app, 'sum.test.mjs'), "import test from 'node:test'; import assert from 'node:assert'; import { sum } from './sum.mjs';\ntest('sum', () => assert.equal(sum(2, 3), 5));\n");
  fs.writeFileSync(path.join(app, 'build.mjs'), "import fs from 'node:fs'; import { sum } from './sum.mjs'; fs.mkdirSync('dist', { recursive: true }); fs.writeFileSync('dist/out.txt', String(sum(2, 3)));\n");
  fs.writeFileSync(path.join(app, 'Makefile'), 'check:\n\tnode --test\n');
  fs.writeFileSync(path.join(app, 'server.mjs'), "import http from 'node:http'; const s = http.createServer((q, r) => r.end('ok')); s.listen(0, '127.0.0.1', async () => { console.log('server:' + await (await fetch(`http://127.0.0.1:${s.address().port}/`)).text()); s.close(); });\n");
  execFileSync('git', ['-C', app, 'init', '-q', '-b', 'main']);
  execFileSync('git', ['-C', app, 'add', '-A']);
  execFileSync('git', ['-C', app, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'init']);
  return { base, app };
}

test('a developer loop runs in the company sandbox without asking; only the internet names its approval', { skip: process.platform !== 'darwin' || !fs.existsSync(sdkRoot), timeout: 180000 }, async () => {
  const { base, app } = project();
  const boundary = new ManagedToolBoundary({ cwd: app, sdkRoot, protectedRoots: [] });
  const bash = async command => text(await boundary.invoke('bash', { command, timeout: 120 }));
  try {
    // A branch, a failing test, the fix, the test again.
    assert.match(await bash('git switch -c fix/sum 2>&1'), /Switched to a new branch 'fix\/sum'/);
    await assert.rejects(bash('npm test 2>&1'), /fail 1/);
    await boundary.invoke('edit', { path: 'sum.mjs', edits: [{ oldText: 'a - b', newText: 'a + b' }] });
    assert.match(await bash('npm test 2>&1'), /pass 1/);
    assert.match(await bash('make check 2>&1'), /pass 1/);
    assert.equal(await bash('npm run build >/dev/null && cat dist/out.txt'), '5');
    // Commit on the branch, stash and log read the project's own history.
    assert.match(await bash('git add sum.mjs && git -c user.name=Fixture -c user.email=fixture@example.com commit -qm "Fix sum" && git log --oneline -2'), /Fix sum\n[0-9a-f]+ init/);
    assert.match(await bash('echo scratch > notes.txt && git stash -u -q && git stash list'), /stash@\{0\}/);
    // The app's own server on this Mac, and a process left in the background is still reachable within the command.
    assert.equal(await bash('node server.mjs'), 'server:ok');
    assert.equal(await bash(`node -e "require('http').createServer((q, r) => r.end('bg')).listen(0, '127.0.0.1', function () { require('fs').writeFileSync('port', String(this.address().port)) })" & for i in 1 2 3 4 5 6 7 8 9 10; do [ -s port ] && break; sleep 0.2; done; curl -s "127.0.0.1:$(cat port)"; kill %1`), 'bg');
    // A local database and a Python environment inside the project.
    if (has('sqlite3')) assert.equal(await bash('sqlite3 app.db "create table t(id integer); insert into t values (1); select count(*) from t;"'), '1');
    if (has('python3')) assert.match(await bash('python3 -m venv --without-pip .venv && .venv/bin/python -c "import sys; print(sys.prefix)"'), /\.venv$/);
    // The internet is not reached without approval, and the refusal says which tool asks for it.
    await assert.rejects(bash('curl -sS -m 10 https://example.com -o /dev/null'), /managed-domain-blocked: .*example\.com.*run_with_network/s);
  } finally { await boundary.dispose(); fs.rmSync(base, { recursive: true, force: true }); }
});
