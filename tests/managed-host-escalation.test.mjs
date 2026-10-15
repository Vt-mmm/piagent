import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { commandTools } from '../packages/piagent-core/managed/command-tools.mjs';
import { engineAlive, engineLauncher } from '../packages/piagent-core/managed/container-engine.mjs';
import { memberOnlyReason, runHostCommand } from '../packages/piagent-core/managed/host-command.mjs';
import { sandboxDiagnostic } from '../packages/piagent-core/managed/sandbox-diagnostic.mjs';

// An environment failure is never a dead end (owner, 2026-10-13): the agent
// asks for the approval that makes the command run, and once the member
// approves it runs, outside the sandbox when it has to. Only what needs the
// member themselves (a password, an interactive sign-in) goes back to them.
const base = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'pa-host-')));
const servers = [];
after(async () => { for (const server of servers) await new Promise(resolve => server.close(resolve)); fs.rmSync(base, { recursive: true, force: true }); });
async function engine(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const server = net.createServer(socket => { socket.resume(); socket.end('HTTP/1.0 200 OK\r\n\r\nOK'); }); servers.push(server);
  await new Promise(resolve => server.listen(file, resolve));
}
function member(permission = 'workspace-write') {
  const self = { permission, cwd: base, grant: {}, session: { sessionManager: { getSessionId: () => 'session' } }, refreshed: 0,
    boundary: { engine: null, dockerCli: '/usr/local/bin/docker', userHome: os.homedir(), refreshEnvironment: () => { self.refreshed += 1; return Boolean(self.boundary.engine); },
      invoke: async () => { throw Error('the sandbox was used'); } },
    changedFiles: async () => [], claimChanges: async () => {}, refreshReview: async () => {} };
  return self;
}
const tool = (self, name, options) => commandTools(self, options).find(item => item.name === name);
const never = { ui: { confirm: async () => { throw Error('asked'); } } };
const answer = (value, seen = []) => ({ ui: { confirm: async (title, text) => { seen.push({ title, text }); return value; } } });

test('every environment failure names an approval or a question, never a stop', () => {
  const java = 'The operation couldn’t be completed. Unable to locate a Java Runtime.\nPlease visit http://www.java.com for information on installing Java.\n\nCommand exited with code 1';
  assert.match(sandboxDiagnostic(java), /^managed-toolchain-missing: .*run_on_host.*brew install openjdk@21/);
  for (const text of ['/bin/bash: line 1: mvn: command not found', 'zsh: command not found: pnpm', 'env: node: No such file or directory', '[ERROR] invalid target release: 21', 'error: The engine "node" is incompatible with this module'])
    assert.match(sandboxDiagnostic(text), /^managed-toolchain-missing:/, text);
  // ./mvnw downloading its Maven with wget (the 13/10 failures in Studio's log).
  assert.match(sandboxDiagnostic('wget: Failed to fetch https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.14/apache-maven-3.9.14-bin.tar.gz'), /^managed-network-blocked:.*run_with_network/);
  // The member's sign-in: fetch_origin, else run_on_host.
  for (const text of ["fatal: could not read Username for 'https://github.com': Device not configured", 'git@github.com: Permission denied (publickey).', 'npm error code E401', 'pull access denied for acme/api',
    // gh and ssh-agent have no sign-in in the sandbox: "gh auth login" there cannot work.
    'You are not logged into any GitHub hosts. To log in, run: gh auth login', 'To get started with GitHub CLI, please run:  gh auth login', 'Could not open a connection to your authentication agent.'])
    assert.match(sandboxDiagnostic(text, { network: true }), /^managed-credentials-unavailable: .*fetch_origin.*run_on_host/, text);
  // A blocked write outside the project, Keychain: run_on_host.
  assert.match(sandboxDiagnostic('touch: /Users/a/Library/x: Operation not permitted'), /^managed-sandbox-denied: .*run_on_host/);
  assert.match(sandboxDiagnostic('/bin/bash: /tmp/x.log: Operation not permitted'), /\$TMPDIR/);
  // Docker stopped: start_docker; the network down after approval: ask_user.
  assert.match(sandboxDiagnostic('Cannot connect to the Docker daemon at unix:///x.sock', { network: true, docker: true }), /^managed-docker-unreachable: .*start_docker/);
  assert.match(sandboxDiagnostic('Cannot connect to the Docker daemon at unix:///x.sock'), /^managed-docker-unavailable: .*start_docker/);
  assert.match(sandboxDiagnostic('npm error code ENOTFOUND', { network: true }), /^managed-network-unreachable: .*ask_user/);
  // A local proxy listens: a test's own localhost server is out of reach, and node --test prints only "fetch failed".
  assert.match(sandboxDiagnostic("not ok 1 - own server\n  error: 'fetch failed'", { isolated: true }), /^managed-loopback-blocked:.*run_with_network/);
  assert.doesNotMatch(sandboxDiagnostic("error: 'fetch failed'"), /managed-loopback-blocked/, 'only while a local proxy listens');
  for (const text of [java, 'zsh: command not found: pnpm', 'npm error code E401', 'touch: /x: Operation not permitted', 'Cannot connect to the Docker daemon'])
    assert.doesNotMatch(sandboxDiagnostic(text, { network: true, docker: true }), /Không xin duyệt lại|báo người dùng|Không tự chạy lại/);
});

test('commands only the member can do are told apart', () => {
  for (const command of ['sudo installer -pkg x.pkg -target /', 'brew update && sudo xcode-select -s /Applications/Xcode.app', 'gh auth login', 'docker login ghcr.io', 'npm login', 'FOO=1 env su root', 'installer -pkg a.pkg -target /'])
    assert.ok(memberOnlyReason(command), command);
  for (const command of ['brew install openjdk@21', 'git pull --ff-only', 'git push origin feat/x', 'echo $TOKEN | docker login ghcr.io -u me --password-stdin', 'sdk install java 21-tem', 'gh auth status'])
    assert.equal(memberOnlyReason(command), null, command);
});

test('a host command runs as the member, without Piagent\'s environment, and reports how it ended', async () => {
  process.env.PIAGENT_TEST_SECRET = 'studio-token';
  try {
    const done = await runHostCommand({ command: 'echo "host-$((1+1))"; pwd; echo "secret=${PIAGENT_TEST_SECRET:-none}"', cwd: base });
    assert.match(done.content[0].text, new RegExp(`host-2\\n${base}\\nsecret=none`));
  } finally { delete process.env.PIAGENT_TEST_SECRET; }
  await assert.rejects(runHostCommand({ command: 'echo broken; exit 3', cwd: base }), /broken\n\nCommand exited with code 3$/);
  await assert.rejects(runHostCommand({ command: 'sleep 5', cwd: base, timeout: 1 }), /Command timed out after 1 seconds$/);
  const stop = new AbortController(); setTimeout(() => stop.abort(), 200);
  await assert.rejects(runHostCommand({ command: 'sleep 5', cwd: base, signal: stop.signal }), /Command aborted$/);
  // A prompt for a password ends the command (no input) and says it needs the member.
  await assert.rejects(runHostCommand({ command: "printf 'Password:'; read x; exit 1", cwd: base }), /managed-host-member-only: .*ask_user/);
});

test('run_on_host always asks, even in Bypass, runs on the host once approved and looks the machine up again', async () => {
  const self = member();
  await assert.rejects(tool(self, 'run_on_host').execute('c1', { command: 'sudo softwareupdate -i -a', reason: 'x' }, undefined, undefined, never), /^Error: managed-host-member-only: sudo needs the member's password.*ask_user/);
  const seen = [];
  await assert.rejects(tool(self, 'run_on_host').execute('c2', { command: 'brew install openjdk@21', reason: 'build needs JDK 21' }, undefined, undefined, answer(false, seen)), /managed-operation-denied/);
  assert.equal(seen[0].title, 'Chạy lệnh trên máy (ngoài sandbox)');
  assert.match(seen[0].text, /brew install openjdk@21\n\nLý do: build needs JDK 21\n\nĐồng ý: chạy đúng lệnh này một lần trên máy bạn, ngoài sandbox/);
  const bypass = member('trusted-full-access'), asked = [];
  const result = await tool(bypass, 'run_on_host').execute('c3', { command: 'echo installed', reason: 'x' }, undefined, undefined, answer(true, asked));
  assert.equal(asked.length, 1, 'Bypass asks too');
  assert.equal(result.content[0].text, 'installed');
  assert.equal(bypass.refreshed, 1, 'what it installed is looked up');
  // What Bypass would still have asked about is said.
  await tool(bypass, 'run_on_host').execute('c4', { command: 'git push origin main --dry-run || true', reason: 'x' }, undefined, undefined, answer(true, asked));
  assert.match(asked[1].text, /Bypass vẫn hỏi: .*git/);
});

test('start_docker starts the installed engine after approval and waits until it answers', async () => {
  const socket = path.join(base, 'engine/docker.sock'), started = [];
  const self = member();
  const options = { wait: 3000, every: 20, launcher: () => ({ label: 'Docker Desktop', command: '/usr/bin/open', args: ['-g', '-a', '/Applications/Docker.app'] }),
    spawnImpl: (command, args) => { started.push([command, ...args]); setTimeout(() => { void engine(socket).then(() => { self.boundary.engine = { socket }; }); }, 100); return { on() { return this; }, unref() {} }; } };
  const seen = [];
  await assert.rejects(tool(self, 'start_docker', options).execute('d1', { reason: 'database for tests' }, undefined, undefined, answer(false, seen)), /managed-operation-denied/);
  assert.equal(seen[0].title, 'Mở Docker Desktop');
  assert.equal(started.length, 0, 'nothing started when declined');
  const result = await tool(self, 'start_docker', options).execute('d2', { reason: 'database for tests' }, undefined, undefined, answer(true));
  assert.match(result.content[0].text, /Docker Desktop is running.*run_with_docker/);
  assert.deepEqual(started, [['/usr/bin/open', '-g', '-a', '/Applications/Docker.app']]);
  assert.equal(await engineAlive(socket), true);
  // Running already: nothing to ask. run_with_docker then reaches it.
  assert.match((await tool(self, 'start_docker', options).execute('d3', { reason: 'x' }, undefined, undefined, never)).content[0].text, /already|is running/);
  // Bypass starts it without asking; one that never answers ends in a question to the member.
  const quiet = member('trusted-full-access');
  await assert.rejects(tool(quiet, 'start_docker', { ...options, wait: 200, spawnImpl: () => ({ on() { return this; }, unref() {} }) }).execute('d4', { reason: 'x' }, undefined, undefined, never),
    /managed-docker-start-timeout: .*ask_user/);
  // Nothing to start: installing Docker is the member's (a password), or only the system service exists.
  const bare = member(); bare.boundary.dockerCli = null;
  await assert.rejects(tool(bare, 'start_docker', { launcher: () => null }).execute('d5', { reason: 'x' }, undefined, undefined, never), /managed-docker-not-installed: .*ask_user/);
  await assert.rejects(tool(member(), 'start_docker', { launcher: () => null }).execute('d6', { reason: 'x' }, undefined, undefined, never), /managed-host-member-only/);
});

test('the launcher is the engine the member installed', () => {
  const has = files => file => files.includes(file);
  assert.deepEqual(engineLauncher({ userHome: '/Users/a', platform: 'darwin', exists: has(['/Applications/OrbStack.app']) }), { label: 'OrbStack', command: '/usr/bin/open', args: ['-g', '-a', '/Applications/OrbStack.app'] });
  assert.deepEqual(engineLauncher({ userHome: '/Users/a', platform: 'darwin', exists: has(['/opt/homebrew/bin/colima']) }), { label: 'Colima', command: '/opt/homebrew/bin/colima', args: ['start'] });
  assert.equal(engineLauncher({ userHome: '/Users/a', platform: 'darwin', exists: has([]) }), null);
  assert.equal(engineLauncher({ userHome: '/home/a', platform: 'linux', exists: has(['/usr/lib/systemd/user/docker.service']) }).args.join(' '), '--user start docker.service');
  assert.equal(engineLauncher({ userHome: '/home/a', platform: 'linux', exists: has(['/proc/sys/fs/binfmt_misc/WSLInterop', '/mnt/c/Program Files/Docker/Docker/Docker Desktop.exe']) }).command, '/mnt/c/Windows/System32/cmd.exe');
});
