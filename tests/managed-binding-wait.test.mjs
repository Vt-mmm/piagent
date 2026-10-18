import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {AGENT_WATCH_BUNDLE_ID, agentWatchRunning, awaitRebind, bindingMismatch, brokerUpdatedAfterBinding, installedAfterBinding} from '../packages/piagent-core/managed/binding-wait.mjs';
import '../scripts/register-typescript-loader.mjs';
import {launchReasonText} from '../packages/piagent-webui/shared/company-copy.ts';
import {ensureCompanyGateway} from '../packages/piagent-webui/gateway/managed-launch.ts';

// Right after a Piagent update only the launcher's hash differs from the
// binding until Agent Watch rewrites it (its sync runs every ~5 min). The
// company Terminal waits for the new binding instead of failing, and never
// runs while any pinned hash differs.
const root = path.resolve(import.meta.dirname, '..');
const studioScript = fs.realpathSync(path.join(root, 'scripts/piagent-studio.mjs'));
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const node = fs.realpathSync(process.execPath);

// The Agent Watch app as Sparkle installs it: …/X.app/Contents/MacOS/<exe>.
function watchApp(home, {bundleId = AGENT_WATCH_BUNDLE_ID, executable = 'AgentWatchMac'} = {}) {
  const macos = path.join(home, 'Applications/AgentWatch.app/Contents/MacOS'); fs.mkdirSync(macos, {recursive: true});
  fs.writeFileSync(path.join(path.dirname(macos), 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleExecutable</key><string>${executable}</string></dict></plist>\n`);
  return path.join(macos, 'AgentWatchMac');
}
function fixture({entrypointSha256 = sha(studioScript), nodeSha256 = sha(node), brokerSha256, app, bindingAge = 3600} = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-binding-wait-')));
  const agent = path.join(home, '.pi/agent'); fs.mkdirSync(agent, {recursive: true});
  // The broker only records that the launch got past the binding check.
  const broker = app ? watchApp(home, app) : path.join(home, 'broker'), ran = path.join(home, 'broker-ran');
  fs.writeFileSync(broker, `#!/bin/sh\necho "$@" >> '${ran}'\nexit 1\n`, {mode: 0o700});
  const config = {schema_version: 1, model: 'agent-watch-auto', profile_id: 'a'.repeat(64), origin: 'https://studio.invalid',
    node, node_sha256: nodeSha256, entrypoint: studioScript, entrypoint_sha256: entrypointSha256,
    sdk_root: path.join(home, 'sdk'), broker, broker_sha256: brokerSha256 ?? sha(broker), configuration_revision: 'r1'};
  const file = path.join(agent, 'agent-watch-managed.json');
  fs.writeFileSync(file, JSON.stringify(config));
  // A binding written before the launcher was installed (an update since).
  const then = new Date(Date.now() - bindingAge * 1000); fs.utimesSync(file, then, then);
  return {home, agent, file, config, ran, broker};
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
  assert.equal(bindingMismatch({...config, entrypoint_sha256: sha(studioScript), broker_sha256: '0'.repeat(64)}, self), 'broker');
  assert.equal(bindingMismatch({...config, broker_sha256: '0'.repeat(64)}, self), 'other', 'launcher and broker both changed');
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

// After an Agent Watch update (Sparkle) only the broker's hash differs until
// the relaunched Watch rewrites the binding (46–71 s on 2026-10-18).
test('a changed broker counts as an Agent Watch update only for the Agent Watch app replaced after the binding', () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-binding-wait-')));
  const broker = watchApp(home); fs.writeFileSync(broker, '#!/bin/sh\n', {mode: 0o700});
  const file = path.join(home, 'binding.json'); fs.writeFileSync(file, '{}');
  const then = new Date(Date.now() - 3600_000); fs.utimesSync(file, then, then);
  const plist = {CFBundleIdentifier: AGENT_WATCH_BUNDLE_ID, CFBundleExecutable: 'AgentWatchMac'};
  const read = values => (_file, key) => values[key];
  assert.equal(brokerUpdatedAfterBinding(file, broker, {platform: 'darwin', read: read(plist)}), true);
  assert.equal(brokerUpdatedAfterBinding(file, broker, {platform: 'linux', read: read(plist)}), false, 'macOS only');
  assert.equal(brokerUpdatedAfterBinding(file, broker, {platform: 'darwin', read: read({...plist, CFBundleIdentifier: 'com.example.other'})}), false, 'another app');
  assert.equal(brokerUpdatedAfterBinding(file, broker, {platform: 'darwin', read: read({...plist, CFBundleExecutable: 'Other'})}), false, 'not the app executable');
  assert.equal(brokerUpdatedAfterBinding(file, broker, {platform: 'darwin', read: () => { throw Error('plutil'); }}), false);
  const loose = path.join(home, 'broker'); fs.writeFileSync(loose, '');
  assert.equal(brokerUpdatedAfterBinding(file, loose, {platform: 'darwin', read: read(plist)}), false, 'not inside an app bundle');
  const link = path.join(home, 'link'); fs.symlinkSync(broker, link);
  assert.equal(brokerUpdatedAfterBinding(file, link, {platform: 'darwin', read: read(plist)}), false, 'a symlink is not the bound app');
  fs.utimesSync(file, new Date(), new Date(Date.now() + 3600_000));
  assert.equal(brokerUpdatedAfterBinding(file, broker, {platform: 'darwin', read: read(plist)}), false, 'binding written after the update');
  if (process.platform === 'darwin') {
    fs.utimesSync(file, then, then);
    assert.equal(brokerUpdatedAfterBinding(file, broker), true, 'the real Info.plist is read');
  }
});

const darwin = {skip: process.platform !== 'darwin' && 'Agent Watch updates itself on macOS only'};

test('piagent studio waits for Agent Watch to rebind after its own update, then runs the new broker', {...darwin, timeout: 60000}, async () => {
  const {home, file, config, ran, broker} = fixture({app: {}, brokerSha256: '0'.repeat(64)});
  const run = launch(home);
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(fs.existsSync(ran), false, 'the broker never runs while its hash differs');
  assert.match(run.out.stderr, /Agent Watch vừa cập nhật nhưng Agent Watch không chạy.*\[managed-binding-wait\]/);
  fs.writeFileSync(file, JSON.stringify({...config, broker_sha256: sha(broker), configuration_revision: 'r2'}));
  await run.exited;
  assert.match(fs.readFileSync(ran, 'utf8'), /managed-broker/, 'the broker is asked once the binding matches');
  assert.doesNotMatch(run.out.stderr, /managed-launch-binding-changed|managed-binding-update-pending|managed-binding-watch-not-running/);
});

test('a changed broker that is not an Agent Watch update fails at once', {...darwin, timeout: 30000}, async () => {
  for (const options of [{brokerSha256: '0'.repeat(64)}, {app: {bundleId: 'com.example.other'}, brokerSha256: '0'.repeat(64)},
    {app: {}, brokerSha256: '0'.repeat(64), bindingAge: -3600}, {app: {}, brokerSha256: '0'.repeat(64), entrypointSha256: '0'.repeat(64)}]) {
    const {home, ran} = fixture(options);
    const started = Date.now(), run = launch(home);
    assert.equal(await run.exited, 1);
    assert.ok(Date.now() - started < 10_000, 'no wait');
    assert.match(run.out.stderr, /managed-launch-binding-changed/);
    assert.doesNotMatch(run.out.stderr, /\[managed-binding-wait\]/);
    assert.equal(fs.existsSync(ran), false);
  }
});

// The dashboard asks the broker (managed-authorize) before starting the
// entrypoint: it waits the same way and never runs a broker whose hash differs.
test('the dashboard waits for Agent Watch to rebind after its own update before asking the broker', {...darwin, timeout: 60000}, async () => {
  const {home, agent, file, config, ran, broker} = fixture({app: {}, brokerSha256: '0'.repeat(64)});
  // The rebound broker approves; the entrypoint is a stand-in that reports ready.
  fs.writeFileSync(broker, `#!/bin/sh\necho "$@" >> '${ran}'\nexit 0\n`, {mode: 0o700});
  const platform = path.join(home, 'platform'); fs.mkdirSync(path.join(platform, 'scripts'), {recursive: true});
  fs.writeFileSync(path.join(platform, 'package.json'), fs.readFileSync(path.join(root, 'package.json')));
  const entrypoint = path.join(platform, 'scripts/piagent-studio.mjs');
  fs.writeFileSync(entrypoint, "process.stdout.write('Agent Watch Auto: ready\\n');");
  const pinned = {...config, entrypoint, entrypoint_sha256: sha(entrypoint)};
  fs.writeFileSync(file, JSON.stringify(pinned));
  const then = new Date(Date.now() - 3600_000); fs.utimesSync(file, then, then);
  let settled = false;
  const started = ensureCompanyGateway(agent, home, 10_000).finally(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(settled, false, 'still waiting for the new binding');
  assert.equal(fs.existsSync(ran), false, 'the broker never runs while its hash differs');
  fs.writeFileSync(file, JSON.stringify({...pinned, broker_sha256: sha(broker), configuration_revision: 'r2'}));
  assert.match(await started, /\.sock$/);
  assert.match(fs.readFileSync(ran, 'utf8'), /managed-authorize/);
});
