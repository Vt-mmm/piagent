import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync, execFileSync } from 'node:child_process';
import { BoundaryTerminals } from '../packages/piagent-core/managed/terminal-boundary.mjs';
import { BWRAP } from '../packages/piagent-core/managed/linux-sandbox.mjs';

const runtimeRoot = fileURLToPath(new URL('../packages/piagent-core/managed', import.meta.url));
const worker = path.join(runtimeRoot, 'terminal-worker.mjs');
const usable = process.platform === 'linux' && BWRAP && spawnSync(BWRAP, ['--ro-bind', '/', '/', '--unshare-net', 'true']).status === 0;
const wait = async predicate => {
  for (let count = 0; count < 250; count++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail('terminal observation timed out');
};
function fixture(t, readOnly = false) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-terminal-test-')));
  const cwd = path.join(root, 'project'), temporary = path.join(root, 'boundary-temp');
  fs.mkdirSync(cwd); fs.mkdirSync(temporary);
  fs.writeFileSync(path.join(cwd, '.env'), 'CREDENTIAL_SHOULD_NOT_BE_READ');
  fs.writeFileSync(path.join(cwd, 'private.txt'), 'PROTECTED_SHOULD_NOT_BE_READ');
  const node = fs.realpathSync(process.execPath);
  const boundary = { cwd, temporary, scope: randomUUID(), node, allowed: ['bash'],
    pins: new Map([[node, createHash('sha256').update(fs.readFileSync(node)).digest('hex')]]),
    environment: { offline: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: temporary, TMPDIR: temporary } },
    linuxBase: { cwd, sdkRoot: '/usr/local/lib/node_modules', runtimeRoot, temporary, node, readOnly,
      repository: [], references: [], toolchains: [], caches: [], denied: [path.join(cwd, 'private.txt')] } };
  const owner = new BoundaryTerminals(boundary);
  t.after(async () => { await owner.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, cwd, boundary, owner };
}

test('company worker refuses to allocate a PTY in the host namespaces', () => {
  const namespaces = process.platform === 'linux' ? [fs.readlinkSync('/proc/self/ns/pid'), fs.readlinkSync('/proc/self/ns/net')] : ['pid:[1]', 'net:[1]'];
  const result = spawnSync(process.execPath, [worker, '/must-not-load.js', ...namespaces, '80', '24'], { encoding: 'utf8', timeout: 3000 });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stdout), { kind: 'unavailable', reasonCode: 'managed-terminal-sandbox-unavailable' });
});

test('company terminal runs inside Linux namespaces, blocks network, masks credentials and closes descendants', { skip: !usable, timeout: 30000 }, async t => {
  const { cwd, root, owner } = fixture(t); let output = '', exited = false;
  assert.equal(owner.reasonCode, null);
  const terminal = await owner.open({ cols: 80, rows: 24 }, message => {
    if (message.kind === 'output') output += message.data;
    if (message.kind === 'exit') exited = true;
  });
  const command = async (text, expected) => { output = ''; await terminal.input(text + '\n'); await wait(() => expected.test(output)); };
  await command("printf '\\n%s\\n' 'COMPANY_READY'", /\r\nCOMPANY_READY\r\n/);
  await terminal.resize({ cols: 99, rows: 33 });
  await command("printf '\\nSIZE:'; stty size", /\r\nSIZE:33 99\r\n/);
  await terminal.input('sleep 20\n'); await new Promise(resolve => setTimeout(resolve, 100));
  await terminal.input('\x03');
  await command("printf '\\n%s\\n' 'AFTER_INTERRUPT'", /\r\nAFTER_INTERRUPT\r\n/);
  await command("printf 'inside' > inside.txt; printf '\\nSECRET:'; wc -c < .env; printf 'PROTECTED:'; wc -c < private.txt", /\r\nPROTECTED:0\r\n/);
  assert.match(output, /\r\nSECRET:0\r\n/);
  assert.equal(fs.readFileSync(path.join(cwd, 'inside.txt'), 'utf8'), 'inside');
  await command(`echo denied > ${JSON.stringify(path.join(root, 'outside.txt'))}; printf '\\n%s\\n' 'WRITE_CHECKED'`, /\r\nWRITE_CHECKED\r\n/);
  assert.equal(fs.existsSync(path.join(root, 'outside.txt')), false);
  await command("curl -sS --max-time 2 https://example.com >/dev/null 2>&1 && printf '\\nNETWORK_LEAK\\n' || printf '\\nNETWORK_BLOCKED\\n'", /\r\nNETWORK_BLOCKED\r\n/);
  const childScript = path.join(cwd, 'detached-child.sh');
  fs.writeFileSync(childScript, 'while :; do sleep 1; done\n');
  await command(`setsid /bin/bash ${JSON.stringify(childScript)} >/dev/null 2>&1 & printf '\\n%s\\n' 'DETACHED_STARTED'`, /\r\nDETACHED_STARTED\r\n/);
  let pid;
  await wait(() => {
    const line = execFileSync('/bin/ps', ['-axo', 'pid=,args='], { encoding: 'utf8' }).split('\n').find(line => line.trim().endsWith(`/bin/bash ${childScript}`));
    pid = line ? Number(line.trim().split(/\s+/)[0]) : null; return pid;
  });
  await terminal.close(); assert.equal(exited, true);
  await wait(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  await assert.rejects(terminal.input('echo late\n'), /terminal-exited/);
});

test('company terminal respects read-only profile, four-terminal cap and boundary disposal', { skip: !usable, timeout: 20000 }, async t => {
  const { cwd, owner } = fixture(t, true); let output = '';
  const first = await owner.open({ cols: 80, rows: 24 }, message => { if (message.kind === 'output') output += message.data; });
  await first.input("echo denied > readonly.txt; printf '\\n%s\\n' 'READONLY_CHECKED'\n");
  await wait(() => /\r\nREADONLY_CHECKED\r\n/.test(output));
  assert.equal(fs.existsSync(path.join(cwd, 'readonly.txt')), false);
  for (let i = 0; i < 3; i++) await owner.open({ cols: 80, rows: 24 }, () => {});
  await assert.rejects(owner.open({ cols: 80, rows: 24 }, () => {}), /terminal-limit/);
  await owner.dispose();
  await assert.rejects(first.input('echo late\n'), /terminal-exited/);
  await assert.rejects(owner.open({ cols: 80, rows: 24 }, () => {}), /boundary-closed/);
});

test('natural shell exit removes detached children from the terminal namespace', { skip: !usable, timeout: 15000 }, async t => {
  const { cwd, owner } = fixture(t); let output = '', exited = false;
  const script = path.join(cwd, 'detached-natural.sh');
  fs.writeFileSync(script, 'while :; do sleep 1; done\n');
  const terminal = await owner.open({ cols: 80, rows: 24 }, event => {
    if (event.kind === 'output') output += event.data;
    if (event.kind === 'exit') exited = true;
  });
  await terminal.input(`setsid /bin/bash ${JSON.stringify(script)} >/dev/null 2>&1 & printf '\\n%s\\n' 'NATURAL_READY'\n`);
  await wait(() => /\r\nNATURAL_READY\r\n/.test(output));
  let pid;
  await wait(() => {
    const line = execFileSync('/bin/ps', ['-axo', 'pid=,args='], { encoding: 'utf8' }).split('\n').find(line => line.trim().endsWith(`/bin/bash ${script}`));
    pid = line ? Number(line.trim().split(/\s+/)[0]) : null; return pid;
  });
  await terminal.input('exit\n'); await wait(() => exited);
  await wait(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  await terminal.close();
});

test('macOS company terminal: the PTY is made outside, the shell runs under Seatbelt and reaches no other terminal', { skip: process.platform !== 'darwin' || !process.env.PI_MANAGED_TEST_SDK, timeout: 60000 }, async t => {
  const { ManagedToolBoundary } = await import('../packages/piagent-core/managed/tool-boundary.mjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'seatbelt-terminal-')));
  const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, '.env'), 'CREDENTIAL_SHOULD_NOT_BE_READ');
  const boundary = new ManagedToolBoundary({ cwd, sdkRoot: process.env.PI_MANAGED_TEST_SDK, searchTools: false });
  t.after(async () => { await boundary.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
  assert.equal(boundary.terminals.reasonCode, null);
  let output = '', exited = false;
  const terminal = await boundary.terminals.open({ cols: 80, rows: 24 }, message => {
    if (message.kind === 'output') output += message.data;
    if (message.kind === 'exit') exited = true;
  });
  const command = async (text, expected) => { output = ''; await terminal.input(text + '\n'); await wait(() => expected.test(output)); };
  await command("printf '\\n%s\\n' 'SEATBELT_READY'", /\r\nSEATBELT_READY\r\n/);
  await terminal.resize({ cols: 99, rows: 33 });
  await command("printf '\\nSIZE:'; stty size", /\r\nSIZE:33 99\r\n/);
  await terminal.input('sleep 20\n'); await new Promise(resolve => setTimeout(resolve, 200));
  await terminal.input('\x03');
  await command("printf '\\n%s\\n' 'AFTER_INTERRUPT'", /\r\nAFTER_INTERRUPT\r\n/);
  await command("printf 'inside' > inside.txt; printf '\\n%s\\n' WROTE", /\r\nWROTE\r\n/);
  assert.equal(fs.readFileSync(path.join(cwd, 'inside.txt'), 'utf8'), 'inside');
  const others = fs.readdirSync('/dev').filter(name => /^ttys[0-9]+$/.test(name)).map(name => `/dev/${name}`).slice(0, 3);
  await command(`for tty in ${others.join(' ')}; do echo x > $tty 2>/dev/null && echo OTHER_TTY_$((1+1)); done; echo hi > /dev/tty && printf '\\n%s\\n' OWN_TTY`, /\r\nOWN_TTY\r\n/);
  assert.doesNotMatch(output, /OTHER_TTY_2/, 'another terminal stays closed');
  await command(`echo denied > ${JSON.stringify(path.join(root, 'outside.txt'))} 2>/dev/null; curl -s -m 3 https://example.com >/dev/null && echo NET_$((1+1)); printf '\\n%s\\n' CHECKED`, /\r\nCHECKED\r\n/);
  assert.equal(fs.existsSync(path.join(root, 'outside.txt')), false); assert.doesNotMatch(output, /NET_2/);
  await command("sleep 300 & echo BG:$!", /BG:\d+/);
  const background = Number(/BG:(\d+)/.exec(output)[1]);
  await terminal.close();
  await wait(() => exited);
  await wait(() => { try { process.kill(background, 0); return false; } catch { return true; } });
});
