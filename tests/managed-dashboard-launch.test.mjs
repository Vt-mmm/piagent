import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import '../scripts/register-typescript-loader.mjs';
import {agentWatchCompanyConnector, attachCompanyGateway, ensureCompanyGateway, managedLaunchStatus} from '../packages/piagent-webui/gateway/managed-launch.ts';
import {startGatewayControlSocket} from '../packages/piagent-webui/gateway/control-socket.ts';
import {gatewayProfileState} from '../packages/piagent-webui/ownership/profile-state.ts';

// The personal dashboard starts the pinned company entrypoint in `--serve`
// mode (no browser, no project). These fixtures stand in for Agent Watch's
// broker and the managed entrypoint.
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const RELEASE = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../package.json'), 'utf8')).version;
// The entrypoint sits in an installed package, as Watch pins it.
function fixture({broker = 'exit 0', entry, version = RELEASE}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-dashboard-launch-')));
  const agent = path.join(home, '.pi/agent');
  fs.mkdirSync(agent, {recursive: true});
  fs.mkdirSync(path.join(home, 'platform/scripts'), {recursive: true});
  fs.writeFileSync(path.join(home, 'platform/package.json'), JSON.stringify({name: '@piagent/platform', version}));
  const brokerFile = path.join(home, 'broker'), entrypoint = path.join(home, 'platform/scripts/piagent-studio.mjs');
  fs.writeFileSync(brokerFile, `#!/bin/sh\n${broker}\n`, {mode: 0o700});
  fs.writeFileSync(entrypoint, entry ?? `import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(path.join(home, 'started'))}, process.argv.slice(2).join(' '));
process.stdout.write('Agent Watch Auto: ready\\n');`);
  const config = {schema_version: 1, model: 'agent-watch-auto', profile_id: 'a'.repeat(64), node: fs.realpathSync(process.execPath),
    entrypoint, broker: brokerFile, broker_sha256: sha(brokerFile)};
  fs.writeFileSync(path.join(agent, 'agent-watch-managed.json'), JSON.stringify(config));
  return {home, agent, config, file: path.join(agent, 'agent-watch-managed.json')};
}
const launchLogs = home => { try { return fs.readdirSync(path.join(home, 'Library/Application Support/AgentWatch/ManagedLaunch')); } catch { return []; } };

test('company sessions are offered only when Watch imported a valid binding into this Pi folder', () => {
  const {agent, file, config} = fixture({});
  assert.deepEqual(managedLaunchStatus(agent), {schemaVersion: 1, version: 'piagent-managed-launch-status-v1', available: true, model: 'agent-watch-auto'});
  assert.equal(agentWatchCompanyConnector(agent).configured(), true);
  assert.equal(agentWatchCompanyConnector(path.join(agent, 'elsewhere')).configured(), false);
  fs.writeFileSync(file, JSON.stringify({...config, model: 'gpt-5'}));
  assert.equal(managedLaunchStatus(agent).available, false);
  fs.rmSync(file);
  assert.equal(managedLaunchStatus(agent).available, false);
});

test('the company Gateway starts without a browser or project and the launch log is removed', async () => {
  const {home, agent} = fixture({});
  assert.match(await ensureCompanyGateway(agent, home, 5000), /\.sock$/);
  assert.match(fs.readFileSync(path.join(home, 'started'), 'utf8'), /^--config .*agent-watch-managed\.json --serve$/);
  assert.deepEqual(launchLogs(home), []);
});

test('launch reports Watch-side failures by code and never runs a changed broker', async () => {
  const denied = fixture({broker: 'exit 77'});
  await assert.rejects(ensureCompanyGateway(denied.agent, denied.home, 5000), process.platform === 'linux' ? /managed-key-unavailable/ : /managed-keychain-approval-required/);
  const disconnected = fixture({broker: 'exit 67'});
  await assert.rejects(ensureCompanyGateway(disconnected.agent, disconnected.home, 5000), /managed-profile-disconnected/);
  const changed = fixture({});
  fs.appendFileSync(changed.config.broker, 'echo tampered\n');
  await assert.rejects(ensureCompanyGateway(changed.agent, changed.home, 5000), /managed-launch-binding-changed/);
  const stale = fixture({entry: 'process.stderr.write("Agent Watch: managed-launch-binding-changed. Refresh the Studio import or check Keychain access.\\n"); process.exitCode = 1;'});
  await assert.rejects(ensureCompanyGateway(stale.agent, stale.home, 5000), /managed-launch-binding-changed/);
  assert.deepEqual(launchLogs(stale.home), []);
  const missing = fixture({}); fs.rmSync(missing.file);
  await assert.rejects(ensureCompanyGateway(missing.agent, missing.home, 5000), /managed-config-missing/);
});

test('the dashboard and the company Gateway are always the same Piagent release', async () => {
  // Watch still points at another install (e.g. an older nvm copy).
  const other = fixture({version: '0.0.1'});
  await assert.rejects(ensureCompanyGateway(other.agent, other.home, 5000), /managed-launch-version-mismatch/);
  assert.equal(await attachCompanyGateway(other.agent, other.home), null);
  assert.equal(fs.existsSync(path.join(other.home, 'started')), false);
  // A company Gateway started before an update is not reused: it is stopped
  // and this release starts.
  const updated = fixture({});
  const socketPath = gatewayProfileState(path.join(updated.home, 'Library/Application Support/AgentWatch/ManagedSessions', 'a'.repeat(64))).controlSocket;
  let stopped = false, control;
  control = await startGatewayControlSocket({socketPath, handle: async (request) => {
    if (request.action === 'health') return {ok: true, value: {packageVersion: '0.0.1'}};
    if (request.action === 'stop') { stopped = true; setTimeout(() => control.close(), 50); return {ok: true, value: {stopping: true}}; }
    return {ok: false, error: 'unexpected'};
  }});
  try {
    assert.equal(await attachCompanyGateway(updated.agent, updated.home), null, 'an old Gateway is never attached');
    assert.match(await ensureCompanyGateway(updated.agent, updated.home, 5000), /\.sock$/);
    assert.equal(stopped, true);
    assert.match(fs.readFileSync(path.join(updated.home, 'started'), 'utf8'), /--serve$/);
  } finally { try { await control.close(); } catch {} }
});
