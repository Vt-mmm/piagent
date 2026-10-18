import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {agentWatchRunning, awaitRebind, bindingMismatch, installedAfterBinding} from '../packages/piagent-core/managed/binding-wait.mjs';
import '../scripts/register-typescript-loader.mjs';
import {launchReasonText} from '../packages/piagent-webui/shared/company-copy.ts';

// Right after a Piagent update only the launcher's hash differs from the
// binding until Agent Watch rewrites it (its sync runs every ~5 min). The
// company Terminal waits for the new binding instead of failing, and never
// runs while any pinned hash differs.
const root = path.resolve(import.meta.dirname, '..');
const studioScript = fs.realpathSync(path.join(root, 'scripts/piagent-studio.mjs'));
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const node = fs.realpathSync(process.execPath);

function fixture({entrypointSha256 = sha(studioScript), nodeSha256 = sha(node), bindingAge = 3600} = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-binding-wait-')));
  const agent = path.join(home, '.pi/agent'); fs.mkdirSync(agent, {recursive: true});
  // The broker only records that the launch got past the binding check.
  const broker = path.join(home, 'broker'), ran = path.join(home, 'broker-ran');
  fs.writeFileSync(broker, `#!/bin/sh\necho "$@" >> '${ran}'\nexit 1\n`, {mode: 0o700});
  const config = {schema_version: 1, model: 'agent-watch-auto', profile_id: 'a'.repeat(64), origin: 'https://studio.invalid',
    node, node_sha256: nodeSha256, entrypoint: studioScript, entrypoint_sha256: entrypointSha256,
    sdk_root: path.join(home, 'sdk'), broker, broker_sha256: sha(broker), configuration_revision: 'r1'};
  const file = path.join(agent, 'agent-watch-managed.json');
  fs.writeFileSync(file, JSON.stringify(config));
  // A binding written before the launcher was installed (an update since).
  const then = new Date(Date.now() - bindingAge * 1000); fs.utimesSync(file, then, then);
  return {home, file, config, ran};
}
function launch(home) {
  const child = spawn(process.execPath, [studioScript, '--check'], {env: {HOME: home, PATH: '/usr/bin:/bin'}, stdio: ['ignore', 'pipe', 'pipe']});
  const out = {stdout: '', stderr: ''};
  child.stdout.on('data', d => { out.stdout += d; }); child.stderr.on('data', d => { out.stderr += d; });
  return {out, exited: new Promise(resolve => child.once('exit', code => resolve(code)))};
}

test('only a changed launcher hash after an update counts as waiting for Agent Watch', () => {
  const {file, config} = fixture({entrypointSha256: '0'.repeat(64)});
  const self = {self: studioScript, node};
  assert.equal(bindingMismatch({...config, entrypoint_sha256: sha(studioScript)}, self), null);
  assert.equal(bindingMismatch(config, self), 'entrypoint');
  assert.equal(bindingMismatch({...config, node_sha256: '0'.repeat(64)}, self), 'other');
  assert.equal(bindingMismatch({...config, broker_sha256: '0'.repeat(64)}, self), 'other');
  assert.equal(bindingMismatch({...config, entrypoint: '/elsewhere/piagent-studio.mjs'}, self), 'other');
  assert.equal(bindingMismatch({...config, model: 'gpt-5'}, self), 'other');
  assert.equal(installedAfterBinding(file, studioScript), true);
  fs.utimesSync(file, new Date(), new Date(Date.now() + 3600_000));
  assert.equal(installedAfterBinding(file, studioScript), false, 'binding written after the install');
  const notPiagent = path.join(path.dirname(file), 'scripts/piagent-studio.mjs');
  fs.mkdirSync(path.dirname(notPiagent), {recursive: true}); fs.writeFileSync(notPiagent, '');
  assert.equal(installedAfterBinding(file, notPiagent), false, 'no @piagent/platform package around it');
});

test('Agent Watch counts as running only for the app itself, not its broker subprocesses', () => {
  const broker = '/Applications/Agent Watch.app/Contents/MacOS/AgentWatchMac';
  const list = lines => () => lines.join('\n');
  assert.equal(agentWatchRunning(broker, {platform: 'darwin', list: list(['/sbin/launchd', broker])}), true);
  assert.equal(agentWatchRunning(broker, {platform: 'darwin', list: list([`${broker} -NSDocumentRevisionsDebugMode YES`])}), true);
  assert.equal(agentWatchRunning(broker, {platform: 'darwin', list: list([`${broker} managed-broker --profile ${'a'.repeat(64)}`, `${broker} managed-authorize --profile x`, `${broker} credential get`])}), false);
  assert.equal(agentWatchRunning(broker, {platform: 'darwin', list: list([`${broker}Helper`])}), false);
  assert.equal(agentWatchRunning(broker, {platform: 'darwin', list: () => { throw Error('ps'); }}), null);
  assert.equal(agentWatchRunning(broker, {platform: 'linux', list: list([broker])}), null, 'WSL cannot see Agent Watch for Windows');
});

test('the wait ends with the new binding, or after the time limit, and says whether Watch runs', async () => {
  let clock = 0, watch = false;
  const sleep = async ms => { clock += ms; }, now = () => clock, shown = [];
  let rebinds = 3;
  const found = await awaitRebind({current: () => (--rebinds === 0 ? {ok: true} : null), running: () => watch, waiting: s => shown.push(s), now, sleep, timeoutMs: 90_000});
  assert.deepEqual(found, {ok: true}); assert.equal(clock, 3000); assert.deepEqual(shown, [false]);
  clock = 0; shown.length = 0;
  const timedOut = await awaitRebind({current: () => null, running: () => { watch = clock >= 10_000; return watch; }, waiting: s => shown.push(s), now, sleep, timeoutMs: 90_000});
  assert.equal(timedOut, null); assert.equal(clock, 90_000);
  assert.deepEqual(shown, [false, true], 'the member opened Agent Watch while waiting');
  assert.match(launchReasonText('managed-binding-watch-not-running', 'vi'), /Agent Watch không chạy/);
  assert.match(launchReasonText('managed-binding-update-pending', 'vi'), /Agent Watch đang chạy/);
});

test('piagent studio waits for Agent Watch to rebind after an update, then runs on the new binding', {timeout: 60000}, async () => {
  const {home, file, config, ran} = fixture({entrypointSha256: '0'.repeat(64)});
  const run = launch(home);
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(fs.existsSync(ran), false, 'nothing runs while the launcher hash differs');
  assert.match(run.out.stderr, /\[managed-binding-wait\]/);
  fs.writeFileSync(file, JSON.stringify({...config, entrypoint_sha256: sha(studioScript), configuration_revision: 'r2'}));
  await run.exited;
  assert.match(fs.readFileSync(ran, 'utf8'), /managed-broker/, 'the broker is asked once the binding matches');
  assert.doesNotMatch(run.out.stderr, /managed-launch-binding-changed|managed-binding-update-pending|managed-binding-watch-not-running/);
});

test('a changed launcher without an update, or any other changed pin, fails at once', {timeout: 30000}, async () => {
  for (const options of [{entrypointSha256: '0'.repeat(64), bindingAge: -3600}, {nodeSha256: '0'.repeat(64)}]) {
    const {home, ran} = fixture(options);
    const started = Date.now(), run = launch(home);
    assert.equal(await run.exited, 1);
    assert.ok(Date.now() - started < 10_000, 'no wait');
    assert.match(run.out.stderr, /managed-launch-binding-changed/);
    assert.doesNotMatch(run.out.stderr, /\[managed-binding-wait\]/);
    assert.equal(fs.existsSync(ran), false);
  }
});
