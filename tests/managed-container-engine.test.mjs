import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { containerEngine, engineEnvironment } from '../packages/piagent-core/managed/container-engine.mjs';
import { commandTools, servicesPrompt } from '../packages/piagent-core/managed/command-tools.mjs';
import { sandboxDiagnostic } from '../packages/piagent-core/managed/sandbox-diagnostic.mjs';
import { ManagedToolBoundary } from '../packages/piagent-core/managed/tool-boundary.mjs';
import { piSdkRoot } from './helpers/pi-sdk.mjs';

// Unix socket paths are short (104 bytes on macOS): the fixture lives in /tmp.
const base = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'pa-engine-')));
const servers = [];
after(async () => { for (const server of servers) await new Promise(resolve => server.close(resolve)); fs.rmSync(base, { recursive: true, force: true }); });
const write = (file, content = 'x', mode = 0o644) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content, { mode }); };
async function listen(file, reply = 'ENGINE-FIXTURE') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // It reads what a client sends (engineAlive's ping), so a closed client closes it.
  const server = net.createServer(socket => { socket.resume(); socket.end(reply); }); servers.push(server);
  await new Promise(resolve => server.listen(file, resolve));
  return server;
}

function machine(name) {
  const home = path.join(base, name), bin = path.join(home, 'bin'), app = path.join(home, 'Docker.app/Contents/Resources');
  write(path.join(bin, 'docker'), '#!/bin/sh\n', 0o755);
  write(path.join(app, 'cli-plugins/docker-compose'), '#!/bin/sh\n', 0o755);
  fs.mkdirSync(path.join(home, '.docker/cli-plugins'), { recursive: true });
  fs.symlinkSync(path.join(app, 'cli-plugins/docker-compose'), path.join(home, '.docker/cli-plugins/docker-compose'));
  fs.symlinkSync(path.join(app, 'cli-plugins/missing'), path.join(home, '.docker/cli-plugins/docker-broken'));
  return { home, bin, app };
}

test('the engine is a socket the member runs and a CLI on this machine; its plugins come along', async () => {
  const { home, bin, app } = machine('found');
  assert.equal(containerEngine({ userHome: home, env: {}, paths: [bin], system: false }), null, 'no socket: no engine');
  write(path.join(home, '.docker/run/docker.sock'));
  assert.equal(containerEngine({ userHome: home, env: {}, paths: [bin], system: false }), null, 'a plain file is not a socket');
  fs.rmSync(path.join(home, '.docker/run/docker.sock'));
  await listen(path.join(home, '.docker/run/docker.sock'));
  assert.equal(containerEngine({ userHome: home, env: {}, paths: [path.join(home, 'nowhere')], system: false }), null, 'no CLI: no engine');
  const engine = containerEngine({ userHome: home, env: {}, paths: [bin], system: false });
  assert.equal(engine.socket, path.join(home, '.docker/run/docker.sock'));
  assert.equal(engine.cli, path.join(bin, 'docker'));
  assert.deepEqual([...engine.plugins.keys()], ['docker-compose'], 'a broken link is skipped');
  assert.equal(engine.plugins.get('docker-compose'), path.join(app, 'cli-plugins/docker-compose'));
  assert.ok(engine.readRoots.includes(bin) && engine.readRoots.includes(path.join(app, 'cli-plugins')));
  // DOCKER_HOST wins when it names a socket.
  const other = path.join(base, 'other.sock'); await listen(other);
  assert.equal(containerEngine({ userHome: home, env: { DOCKER_HOST: `unix://${other}` }, paths: [bin], system: false }).socket, other);
  assert.equal(containerEngine({ userHome: home, env: { DOCKER_HOST: 'tcp://10.0.0.2:2375' }, paths: [bin], system: false }).socket, path.join(home, '.docker/run/docker.sock'));
});

test('the CLI gets its own configuration: no registry credentials, the plugins linked', async () => {
  const { home, bin } = machine('config');
  await listen(path.join(home, '.docker/run/docker.sock'));
  write(path.join(home, '.docker/config.json'), JSON.stringify({ credsStore: 'desktop', auths: { 'ghcr.io': { auth: 'FIXTURE' } } }));
  const engine = containerEngine({ userHome: home, env: {}, paths: [bin], system: false }), sandboxHome = path.join(base, 'config-sandbox');
  fs.mkdirSync(sandboxHome);
  const env = engineEnvironment(engine, sandboxHome);
  assert.equal(env.DOCKER_HOST, `unix://${engine.socket}`);
  assert.equal(env.DOCKER_CONFIG, path.join(sandboxHome, '.docker'));
  assert.equal(fs.readFileSync(path.join(env.DOCKER_CONFIG, 'config.json'), 'utf8'), '{}\n');
  assert.equal(fs.readlinkSync(path.join(env.DOCKER_CONFIG, 'cli-plugins/docker-compose')), engine.plugins.get('docker-compose'));
  assert.equal(env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE, process.platform === 'darwin' ? '/var/run/docker.sock' : undefined);
  engineEnvironment(engine, sandboxHome); // a second conversation turn finds the links there
});

test('a failure names the way to Docker: run_with_docker, or the engine is not running', () => {
  const refused = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?';
  assert.match(sandboxDiagnostic(refused, { engine: true }), /^managed-docker-blocked: .*run_with_docker/);
  assert.match(sandboxDiagnostic(refused, {}), /^managed-docker-unavailable/);
  assert.match(sandboxDiagnostic(refused, { network: true, docker: true }), /^managed-docker-unreachable/);
  assert.match(sandboxDiagnostic('Could not find a valid Docker environment', { engine: true }), /^managed-docker-blocked/);
});

test('run_with_docker is offered with Docker on the machine; Full access runs it without asking, the default mode asks', async () => {
  const calls = [];
  const self = { permission: 'trusted-full-access', cwd: path.join(base, 'tools-project'), grant: {}, session: { sessionManager: { getSessionId: () => 'session' } },
    boundary: { engine: null, dockerCli: null, userHome: path.join(base, 'member'), refreshEnvironment: () => Boolean(self.boundary.engine), invoke: async (...args) => { calls.push(args); return { content: [{ type: 'text', text: 'ok' }] }; } },
    changedFiles: async () => [], claimChanges: async () => {}, refreshReview: async () => {} };
  // Background processes (background-process.mjs) are offered where the macOS sandbox runs them.
  assert.deepEqual(commandTools(self).map(tool => tool.name), ['run_with_network', 'start_docker', 'run_on_host', 'run_on_simulator', ...(process.platform === 'darwin' ? ['start_process', 'process_output', 'stop_process'] : [])]);
  assert.match(servicesPrompt(self.boundary), /Docker is not installed.*ask_user/);
  self.boundary.dockerCli = '/usr/local/bin/docker';
  assert.match(servicesPrompt(self.boundary), /installed but not running.*start_docker/);
  // The engine stopped (its socket file left behind): told before anything is asked.
  self.boundary.engine = { socket: path.join(base, 'stopped.sock') };
  const stopped = commandTools(self).find(tool => tool.name === 'run_with_docker');
  await assert.rejects(stopped.execute('call_0', { command: 'docker ps', reason: 'x' }, undefined, undefined, { ui: { confirm: async () => { throw Error('asked'); } } }), /^Error: managed-docker-unreachable: .*start_docker/);
  const alive = path.join(base, 'alive/docker.sock'); await listen(alive, 'HTTP/1.0 200 OK\r\n\r\nOK');
  self.boundary.engine = { socket: alive };
  const docker = commandTools(self).find(tool => tool.name === 'run_with_docker');
  assert.ok(docker && /Testcontainers/.test(docker.description));
  assert.match(servicesPrompt(self.boundary), /run_with_docker/);
  await docker.execute('call_1', { command: 'docker compose up -d', reason: 'database for tests' }, undefined, undefined, {});
  assert.deepEqual(calls[0].slice(0, 2), ['bash', { command: 'docker compose up -d' }]);
  assert.deepEqual(calls[0][5], { docker: true });
  // Full access: no question, whatever the container mounts (owner, 2026-10-09).
  await docker.execute('call_2', { command: 'docker run --rm -v "$HOME/.cache":/c --privileged alpine ls /c', reason: 'x' }, undefined, undefined,
    { ui: { confirm: async () => { throw Error('Full access asked'); } } });
  assert.equal(calls.length, 2);
  // What must be confirmed for any command still is (a push to a registry).
  let asked = null;
  await assert.rejects(docker.execute('call_3', { command: 'docker push ghcr.io/x/y', reason: 'x' }, undefined, undefined,
    { ui: { confirm: async (title, text) => { asked = text; return false; } } }), /managed-operation-denied/);
  assert.match(asked, /Full access vẫn hỏi: docker push sends to a registry/, 'the card names the mode that asks');
  self.permission = 'bypass'; self.manifest = { harness: { configuration: { bypass_mode: true } } }; asked = null;
  await assert.rejects(docker.execute('call_3b', { command: 'docker push ghcr.io/x/y', reason: 'x' }, undefined, undefined,
    { ui: { confirm: async (title, text) => { asked = text; return false; } } }), /managed-operation-denied/);
  assert.match(asked, /Bypass vẫn hỏi: docker push sends to a registry/, 'Bypass stops at the handoff too');
  // The default mode asks before each command.
  self.permission = 'workspace-write'; asked = null;
  await assert.rejects(docker.execute('call_4', { command: 'docker compose up -d', reason: 'database' }, undefined, undefined,
    { ui: { confirm: async (title, text) => { asked = title; return false; } } }), /managed-operation-denied/);
  assert.equal(asked, 'Chạy lệnh dùng Docker');
  assert.equal(calls.length, 2, 'declined commands never ran');
});

// The sandbox opens the engine's socket to an approved Docker command only:
// a plain command and an approved network command are refused.
const sdkRoot = piSdkRoot();
const cli = ['/usr/local/bin/docker', '/opt/homebrew/bin/docker', '/usr/bin/docker'].some(file => fs.existsSync(file));
test('only an approved Docker command reaches the engine socket', { skip: process.platform !== 'darwin' || !fs.existsSync(path.join(sdkRoot, 'dist/index.js')) || !cli, timeout: 60000 }, async () => {
  const home = path.join(base, 'live'), cwd = path.join(base, 'live-project');
  fs.mkdirSync(cwd, { recursive: true });
  await listen(path.join(home, '.docker/run/docker.sock'), 'ENGINE-REACHED');
  const boundary = new ManagedToolBoundary({ cwd, sdkRoot, userHome: home, identity: null });
  try {
    assert.equal(boundary.engine.socket, path.join(home, '.docker/run/docker.sock'));
    const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
    const probe = `const s=require('node:net').connect(process.env.DOCKER_HOST?process.env.DOCKER_HOST.slice(7):${JSON.stringify(boundary.engine.socket)});s.on('data',d=>{console.log(String(d));process.exit(0)});s.on('error',e=>{console.log('DENIED '+e.code);process.exit(0)});setTimeout(()=>process.exit(2),1500);`;
    const run = options => boundary.invoke('bash', { command: `${quote(process.execPath)} -e ${quote(probe)}; echo "config=$DOCKER_CONFIG"`, timeout: 5 }, undefined, undefined, undefined, options)
      .then(result => result.content.map(part => part.text).join('\n'));
    assert.match(await run({}), /DENIED/);
    assert.match(await run({ network: true }), /DENIED/);
    const reached = await run({ docker: true });
    assert.match(reached, /ENGINE-REACHED/);
    assert.match(reached, new RegExp(`config=${boundary.home}/\\.docker`));
  } finally { await boundary.dispose(); }
});

test('a read-only helper has no engine', { skip: process.platform !== 'darwin' || !fs.existsSync(path.join(sdkRoot, 'dist/index.js')) || !cli }, async () => {
  const home = path.join(base, 'live'), cwd = path.join(base, 'live-project');
  const boundary = new ManagedToolBoundary({ cwd, sdkRoot, userHome: home, identity: null, readOnly: true, commands: true });
  try {
    assert.equal(boundary.engine, null);
    await assert.rejects(boundary.invoke('bash', { command: 'true' }, undefined, undefined, undefined, { docker: true }), /managed-tool-unavailable/);
  } finally { await boundary.dispose(); }
});

// Docker started after the conversation opened (start_docker): looked up
// again, the next approved Docker command reaches it in the same conversation.
test('an engine started later is found without a new conversation', { skip: process.platform !== 'darwin' || !fs.existsSync(path.join(sdkRoot, 'dist/index.js')) || !cli, timeout: 60000 }, async () => {
  const home = path.join(base, 'later'), cwd = path.join(base, 'later-project');
  fs.mkdirSync(cwd, { recursive: true }); fs.mkdirSync(home, { recursive: true });
  const boundary = new ManagedToolBoundary({ cwd, sdkRoot, userHome: home, identity: null });
  try {
    // (This Mac's own engine, when it runs, is found until the member's starts.)
    const socket = path.join(home, '.docker/run/docker.sock');
    assert.notEqual(boundary.engine?.socket, socket);
    await listen(socket, 'ENGINE-LATER');
    assert.equal(boundary.refreshEnvironment(), true);
    assert.equal(boundary.engine.socket, socket);
    const probe = `const s=require('node:net').connect(process.env.DOCKER_HOST.slice(7));s.on('data',d=>{console.log(String(d));process.exit(0)});s.on('error',e=>{console.log('DENIED '+e.code);process.exit(0)});`;
    const result = await boundary.invoke('bash', { command: `'${process.execPath}' -e "${probe.replaceAll('"', '\\"')}"`, timeout: 5 }, undefined, undefined, undefined, { docker: true });
    assert.match(result.content.map(part => part.text).join('\n'), /ENGINE-LATER/);
    // Plain commands keep the package proxy after the lookup.
    const plain = await boundary.invoke('bash', { command: 'echo "proxy=${HTTPS_PROXY:-${https_proxy:-none}}"', timeout: 5 });
    assert.match(plain.content.map(part => part.text).join('\n'), /proxy=http:\/\/127\.0\.0\.1:\d+/);
  } finally { await boundary.dispose(); }
});
