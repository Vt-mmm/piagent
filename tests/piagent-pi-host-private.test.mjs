import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PI_HOST_VERSION, compareVersions, hostPlan, privateHostPrefix, privateHostRoot } from '../packages/piagent-core/managed/pi-host.mjs';

// A member who keeps a newer Pi of their own keeps it: Piagent installs the
// pinned host privately under ~/.piagent/pi-host/<version> and runs that one
// (company sessions, the dashboard, `piagent pi`), never replacing theirs.
const HOST = '@earendil-works/pi-coding-agent';
const bump = (version, by) => version.split('.').map((part, index) => index === 1 ? String(Number(part) + by) : index === 2 ? '0' : part).join('.');

// A fake host package with a `pi` bin that prints its version.
function fakeHost(prefix, version) {
  const root = path.join(prefix, 'node_modules', ...HOST.split('/'));
  fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: HOST, version, bin: { pi: 'dist/cli.js' } }));
  fs.writeFileSync(path.join(root, 'dist', 'cli.js'), `#!/usr/bin/env node\nconsole.log(${JSON.stringify(version)});\n`, { mode: 0o755 });
  const bin = path.join(prefix, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(path.join(root, 'dist', 'cli.js'), path.join(bin, 'pi'));
  return { root: fs.realpathSync(root), bin };
}

function machine(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pi-host-private-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return base;
}

test('versions compare by number and the plan keeps only a newer pi', () => {
  assert.ok(compareVersions('1.10.0', '1.9.3') > 0);
  assert.ok(compareVersions('1.3.0', '1.4.0') < 0);
  assert.equal(compareVersions('1.3.0', '1.3.0'), 0);
  assert.equal(hostPlan(PI_HOST_VERSION), 'current');
  assert.equal(hostPlan(bump(PI_HOST_VERSION, 1)), 'private');
  assert.equal(hostPlan('0.87.1'), 'global');
  assert.equal(hostPlan(null), 'global');
});

test('the private copy counts only when it holds exactly the pinned release', (t) => {
  const home = machine(t);
  assert.equal(privateHostRoot(PI_HOST_VERSION, home), null);
  const { root } = fakeHost(privateHostPrefix(PI_HOST_VERSION, home), PI_HOST_VERSION);
  assert.equal(privateHostRoot(PI_HOST_VERSION, home), root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: HOST, version: '0.0.1' }));
  assert.equal(privateHostRoot(PI_HOST_VERSION, home), null);
});

test('a member with a newer pi: Piagent runs its private host and theirs stays first on PATH', async (t) => {
  const home = machine(t), newer = bump(PI_HOST_VERSION, 1);
  const own = fakeHost(path.join(home, 'own'), newer);
  const env = { ...process.env, HOME: home, PATH: `${own.bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}/usr/bin:/bin` };
  const { pathHost, activeHostRoot, status } = await import('../scripts/pi-host.mjs');
  assert.deepEqual(pathHost(env), { root: own.root, version: newer });
  // Before the private copy exists, Piagent still names the member's host.
  assert.equal(activeHostRoot({ env, home }), own.root);
  const privateCopy = fakeHost(privateHostPrefix(PI_HOST_VERSION, home), PI_HOST_VERSION);
  assert.equal(activeHostRoot({ env, home }), privateCopy.root);
  assert.equal(status({ env, home }).plan, 'private');

  const cli = path.resolve('scripts/pi-host.mjs');
  const run = spawnSync(process.execPath, [cli, 'run', '--', '--version'], { env, encoding: 'utf8', timeout: 15_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), PI_HOST_VERSION);
  const theirs = spawnSync('pi', ['--version'], { env, encoding: 'utf8', timeout: 15_000 });
  assert.equal(theirs.stdout.trim(), newer);
  const report = spawnSync(process.execPath, [cli, 'status'], { env, encoding: 'utf8', timeout: 15_000 });
  assert.match(report.stdout, new RegExp(`Your pi is ${newer.replaceAll('.', '\\.')}: kept as it is`));
});

test('the pinned release on PATH is used as it is', async (t) => {
  const home = machine(t);
  const own = fakeHost(path.join(home, 'own'), PI_HOST_VERSION);
  fakeHost(privateHostPrefix(PI_HOST_VERSION, home), PI_HOST_VERSION);
  const env = { ...process.env, HOME: home, PATH: `${own.bin}${path.delimiter}/usr/bin:/bin` };
  const { activeHostRoot } = await import('../scripts/pi-host.mjs');
  assert.equal(activeHostRoot({ env, home }), own.root);
});

test('the dashboard and Gateway load the private host when the installed one is another release', (t) => {
  const home = machine(t), newer = bump(PI_HOST_VERSION, 1);
  const own = fakeHost(path.join(home, 'own'), newer);
  const privateCopy = fakeHost(privateHostPrefix(PI_HOST_VERSION, home), PI_HOST_VERSION);
  const script = `const { pinnedPiHostRoot } = await import(${JSON.stringify(path.resolve('packages/piagent-webui/gateway/pi-host.ts'))});
    process.stdout.write(pinnedPiHostRoot(${JSON.stringify(PI_HOST_VERSION)}));`;
  const child = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--disable-warning=DEP0205', '--import', path.resolve('scripts/register-typescript-loader.mjs'), '--input-type=module', '-e', script], {
    env: { ...process.env, HOME: home, PATH: `${own.bin}${path.delimiter}/usr/bin:/bin`, PI_CODING_AGENT_DIR: path.join(home, '.pi', 'agent') }, encoding: 'utf8', timeout: 20_000, cwd: home });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, privateCopy.root);
});
