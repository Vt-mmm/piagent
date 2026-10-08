import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { containerEngine, dockerConfirmation, engineEnvironment } from '../packages/piagent-core/managed/container-engine.mjs';
import { commandTools, servicesPrompt } from '../packages/piagent-core/managed/command-tools.mjs';
import { sandboxDiagnostic } from '../packages/piagent-core/managed/sandbox-diagnostic.mjs';
import { ManagedToolBoundary } from '../packages/piagent-core/managed/tool-boundary.mjs';

// Unix socket paths are short (104 bytes on macOS): the fixture lives in /tmp.
const base = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'pa-engine-')));
const servers = [];
after(async () => { for (const server of servers) await new Promise(resolve => server.close(resolve)); fs.rmSync(base, { recursive: true, force: true }); });
const write = (file, content = 'x', mode = 0o644) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content, { mode }); };
async function listen(file, reply = 'ENGINE-FIXTURE') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const server = net.createServer(socket => socket.end(reply)); servers.push(server);
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

test('Bypass still asks about host folders, the engine socket and host privileges', () => {
  const cwd = path.join(base, 'shop'), home = path.join(base, 'member');
  fs.mkdirSync(cwd, { recursive: true });
  const ask = command => dockerConfirmation(command, { cwd, home });
  assert.equal(ask('docker compose up -d postgres'), null);
  assert.equal(ask('docker run --rm -v ./data:/data -v pgdata:/var/lib/postgresql/data postgres:17'), null);
  assert.equal(ask(`docker run --rm -v ${cwd}/src:/src node:22 npm test`), null);
  assert.equal(ask('docker build -t shop .'), null);
  assert.match(ask('docker run --rm -v ~/.ssh:/keys alpine cat /keys/id_ed25519'), /outside the project/);
  assert.match(ask('docker run --rm --volume=/Users:/host alpine ls /host'), /outside the project/);
  assert.match(ask('docker run --rm -v ../other:/x alpine ls'), /outside the project/);
  assert.match(ask('docker run --rm -v "$HOME":/h alpine ls'), /outside the project/);
  assert.match(ask('docker run --rm --mount type=bind,source=/etc,target=/e alpine ls'), /outside the project/);
  assert.match(ask('docker run --rm -v /var/run/docker.sock:/var/run/docker.sock docker:cli ps'), /outside the project/);
  assert.match(ask('docker run --rm --privileged alpine true'), /privileges/);
  assert.match(ask('docker run --rm --network host alpine true'), /network/);
  // The project's compose file is read for the same.
  write(path.join(cwd, 'compose.yaml'), 'services:\n  db:\n    image: postgres:17\n    ports:\n      - "5432:5432"\n    volumes:\n      - ./pg:/var/lib/postgresql/data\n      - pgdata:/data\nvolumes:\n  pgdata: {}\n');
  assert.equal(ask('docker compose up -d'), null);
  write(path.join(cwd, 'compose.yaml'), 'services:\n  app:\n    image: alpine\n    volumes:\n      - ~/.aws:/root/.aws:ro\n');
  assert.match(ask('docker compose up -d'), /compose\.yaml mounts a folder outside the project/);
  assert.equal(ask('docker ps'), null, 'a command that is not compose does not read it');
  write(path.join(cwd, 'compose.yaml'), 'services:\n  app:\n    image: alpine\n    privileged: true\n');
  assert.match(ask('docker compose up'), /privileges/);
});

test('a failure names the way to Docker: run_with_docker, or the engine is not running', () => {
  const refused = 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?';
  assert.match(sandboxDiagnostic(refused, { engine: true }), /^managed-docker-blocked: .*run_with_docker/);
  assert.match(sandboxDiagnostic(refused, {}), /^managed-docker-unavailable/);
  assert.match(sandboxDiagnostic(refused, { network: true, docker: true }), /^managed-docker-unreachable/);
  assert.match(sandboxDiagnostic('Could not find a valid Docker environment', { engine: true }), /^managed-docker-blocked/);
});

test('run_with_docker is offered only with an engine; Bypass runs a safe command and asks about a host folder', async () => {
  const calls = [];
  const self = { permission: 'trusted-full-access', cwd: path.join(base, 'tools-project'), grant: {}, session: { sessionManager: { getSessionId: () => 'session' } },
    boundary: { engine: null, userHome: path.join(base, 'member'), invoke: async (...args) => { calls.push(args); return { content: [{ type: 'text', text: 'ok' }] }; } },
    changedFiles: async () => [], claimChanges: async () => {}, refreshReview: async () => {} };
  assert.deepEqual(commandTools(self).map(tool => tool.name), ['run_with_network']);
  assert.match(servicesPrompt(self.boundary), /Docker is not running on this machine/);
  self.boundary.engine = { socket: '/x.sock' };
  const docker = commandTools(self).find(tool => tool.name === 'run_with_docker');
  assert.ok(docker && /Testcontainers/.test(docker.description));
  assert.match(servicesPrompt(self.boundary), /run_with_docker/);
  await docker.execute('call_1', { command: 'docker compose up -d', reason: 'database for tests' }, undefined, undefined, {});
  assert.deepEqual(calls[0].slice(0, 2), ['bash', { command: 'docker compose up -d' }]);
  assert.deepEqual(calls[0][5], { docker: true });
  let asked = null;
  await assert.rejects(docker.execute('call_2', { command: 'docker run -v ~/.ssh:/k alpine ls /k', reason: 'x' }, undefined, undefined,
    { ui: { confirm: async (title, text) => { asked = text; return false; } } }), /managed-operation-denied/);
  assert.match(asked, /Bypass vẫn hỏi: it mounts a folder outside the project/);
  assert.equal(calls.length, 1, 'the declined command never ran');
});

// The sandbox opens the engine's socket to an approved Docker command only:
// a plain command and an approved network command are refused.
const sdkRoot = process.env.PI_MANAGED_TEST_SDK ?? path.join(os.homedir(), '.pi/npm-global/lib/node_modules/@earendil-works/pi-coding-agent');
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
