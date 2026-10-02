import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';

// Agent Watch binds the company runtime to the Piagent a member actually runs,
// wherever npm put it (nvm, Volta, Homebrew, a custom prefix). The installed
// `piagent` command records its entrypoint, Node and Pi host for Watch.
const repo = path.resolve(import.meta.dirname, '..');
function installed(base) {
  // An nvm-style prefix with Piagent and Pi installed globally.
  const prefix = path.join(base, '.nvm/versions/node/v24.11.1');
  const pkg = path.join(prefix, 'lib/node_modules/@piagent/platform');
  fs.mkdirSync(path.join(pkg, 'scripts'), {recursive: true});
  fs.copyFileSync(path.join(repo, 'scripts/piagent-cli.mjs'), path.join(pkg, 'scripts/piagent-cli.mjs'));
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({name: '@piagent/platform', version: '9.9.9-test'}));
  fs.writeFileSync(path.join(pkg, 'scripts/piagent-studio.mjs'), '#!/usr/bin/env node\n', {mode: 0o755});
  fs.writeFileSync(path.join(pkg, 'scripts/register-typescript-loader.mjs'), '');
  fs.writeFileSync(path.join(pkg, 'scripts/explain-command.mjs'), '');
  const pi = path.join(prefix, 'lib/node_modules/@earendil-works/pi-coding-agent');
  fs.mkdirSync(path.join(pi, 'dist/bundle'), {recursive: true});
  fs.writeFileSync(path.join(pi, 'package.json'), JSON.stringify({name: '@earendil-works/pi-coding-agent', version: '0.87.1'}));
  fs.writeFileSync(path.join(pi, 'dist/bundle/cli.js'), '#!/usr/bin/env node\n', {mode: 0o755});
  fs.mkdirSync(path.join(prefix, 'bin'), {recursive: true});
  fs.symlinkSync('../lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', path.join(prefix, 'bin/pi'));
  fs.symlinkSync('../lib/node_modules/@piagent/platform/scripts/piagent-cli.mjs', path.join(prefix, 'bin/piagent'));
  return {prefix, pkg, pi};
}

test('the installed piagent command records where it runs for Agent Watch; source checkouts do not', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-registration-')));
  const agentDir = path.join(base, '.pi/agent'); fs.mkdirSync(agentDir, {recursive: true});
  const {prefix, pkg, pi} = installed(base);
  // The fixture install sits under the OS temporary directory, which the CLI
  // never records; the child gets its own TMPDIR so this install counts as real.
  const childTemp = path.join(base, 'child-tmp'); fs.mkdirSync(childTemp);
  const env = {PATH: `${path.join(prefix, 'bin')}:/usr/bin:/bin`, HOME: base, PI_CODING_AGENT_DIR: agentDir, TMPDIR: childTemp};
  const record = path.join(agentDir, 'piagent-runtime.json');
  try {
    execFileSync(process.execPath, [path.join(prefix, 'bin/piagent'), 'explain'], {env, stdio: 'ignore'});
    const value = JSON.parse(fs.readFileSync(record, 'utf8'));
    assert.deepEqual(value, {schema_version: 1, version: '9.9.9-test', entrypoint: path.join(pkg, 'scripts/piagent-studio.mjs'),
      node: fs.realpathSync(process.execPath), pi_sdk_root: pi});
    assert.equal(fs.statSync(record).mode & 0o777, 0o600);
    // Unchanged installs do not rewrite the record.
    const before = fs.statSync(record).mtimeMs;
    execFileSync(process.execPath, [path.join(prefix, 'bin/piagent'), 'explain'], {env, stdio: 'ignore'});
    assert.equal(fs.statSync(record).mtimeMs, before);
    // Asking an installed command for help writes nothing to the agent directory.
    fs.rmSync(record);
    execFileSync(process.execPath, [path.join(prefix, 'bin/piagent'), 'explain', '--help'], {env, stdio: 'ignore'});
    assert.equal(fs.existsSync(record), false);
    // An install inside the OS temporary directory is never recorded either:
    // it is about to be deleted and would leave Agent Watch a dead entrypoint.
    execFileSync(process.execPath, [path.join(prefix, 'bin/piagent'), 'explain'], {env: {...env, TMPDIR: os.tmpdir()}, stdio: 'ignore'});
    assert.equal(fs.existsSync(record), false);
    // Running from this source checkout never registers it.
    const checkout = path.join(base, 'checkout-bin'); fs.mkdirSync(checkout);
    fs.symlinkSync(path.join(repo, 'scripts/piagent-cli.mjs'), path.join(checkout, 'piagent'));
    execFileSync(process.execPath, [path.join(checkout, 'piagent'), 'explain', '--help'], {env: {...env, PATH: '/usr/bin:/bin'}, stdio: 'ignore'});
    assert.equal(fs.existsSync(record), false);
  } finally { fs.rmSync(base, {recursive: true, force: true}); }
});
