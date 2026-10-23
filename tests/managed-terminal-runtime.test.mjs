import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { companyTerminalRuntime, companyTerminalDiagnostic } from '../packages/piagent-core/managed/terminal-runtime.mjs';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'company-terminal-runtime-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'lib'));
  fs.mkdirSync(path.join(root, 'prebuilds/linux-arm64'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@lydell/node-pty-linux-arm64', version: '1.2.0-beta.15' }));
  fs.writeFileSync(path.join(root, 'lib/index.js'), 'throw Error("must never load on host");');
  fs.writeFileSync(path.join(root, 'prebuilds/linux-arm64/pty.node'), 'native fixture');
  const options = { platform: 'linux', arch: 'arm64', bubblewrap: '/usr/bin/bwrap', resolve: () => path.join(root, 'lib/index.js') };
  return { root, options };
}

test('company PTY prerequisite inspection never loads code or claims a successful sandbox spawn', t => {
  const { root, options } = fixture(t), runtime = companyTerminalRuntime(options);
  assert.equal(runtime.root, root); runtime.assertCurrent();
  assert.deepEqual(companyTerminalDiagnostic(options), { supported: true, reasonCode: null, platform: 'linux',
    scope: 'company', probe: 'runtime-files', ptySpawnVerified: false });
  fs.writeFileSync(path.join(root, 'prebuilds/linux-arm64/pty.node'), 'changed');
  assert.throws(() => runtime.assertCurrent(), /runtime-changed/);
});

test('company runtime pin detects added files and refuses symlinks, versions and external dependencies', t => {
  const { root, options } = fixture(t), runtime = companyTerminalRuntime(options);
  const extra = path.join(root, 'lib/extra.js'); fs.writeFileSync(extra, 'added');
  assert.throws(() => runtime.assertCurrent(), /runtime-changed/);
  fs.rmSync(extra); fs.symlinkSync(path.join(root, 'package.json'), extra);
  assert.throws(() => companyTerminalRuntime(options), /runtime-invalid/);
  fs.rmSync(extra);
  const manifest = path.join(root, 'package.json');
  fs.writeFileSync(manifest, JSON.stringify({ name: '@lydell/node-pty-linux-arm64', version: 'unqualified' }));
  assert.throws(() => companyTerminalRuntime(options), /runtime-invalid/);
  fs.writeFileSync(manifest, JSON.stringify({ name: '@lydell/node-pty-linux-arm64', version: '1.2.0-beta.15', dependencies: { external: '*' } }));
  assert.throws(() => companyTerminalRuntime(options), /runtime-invalid/);
});

test('unsupported sandbox or absent native files fail closed before native resolution where possible', () => {
  const resolve = () => { throw Error('absent'); };
  for (const [platform, bubblewrap, reason] of [
    ['darwin', null, 'native-unavailable'], ['win32', null, 'platform-unavailable'],
    ['linux', null, 'bubblewrap-unavailable'], ['linux', '/usr/bin/bwrap', 'native-unavailable']
  ]) {
    const diagnostic = companyTerminalDiagnostic({ platform, arch: 'arm64', bubblewrap, resolve });
    assert.equal(diagnostic.supported, false);
    assert.equal(diagnostic.reasonCode, `managed-terminal-${reason}`);
    assert.equal(diagnostic.ptySpawnVerified, false);
  }
});
