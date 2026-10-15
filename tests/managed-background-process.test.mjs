import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { ManagedToolBoundary } from '../packages/piagent-core/managed/tool-boundary.mjs';
import { BackgroundProcesses, MAX_PROCESSES, processTools } from '../packages/piagent-core/managed/background-process.mjs';
import { piSdkRoot } from './helpers/pi-sdk.mjs';

// A dev server the agent starts keeps running across commands and turns,
// in the plain sandbox, until it is stopped or the conversation closes.
const sdkRoot = piSdkRoot();
const text = result => (result.content ?? []).map(part => part.text ?? '').join('').trim();
const probe = `bgprobe${process.pid}`, rows = () => execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 64 << 20 }).split('\n');
const running = () => rows().filter(row => row.includes(probe)).length;
const sleepers = () => rows().filter(row => row.trim().endsWith(`sleep 3${process.pid % 1000}`)).length;

test('a dev server outlives its command and the turn, and stops with stop_process or the conversation', { skip: process.platform !== 'darwin' || !fs.existsSync(sdkRoot), timeout: 120000 }, async () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'managed-background-')));
  fs.writeFileSync(path.join(base, 'dev.mjs'), "import http from 'node:http'; import fs from 'node:fs'; const s = http.createServer((q, r) => r.end('dev-ok')); s.listen(0, '127.0.0.1', () => { fs.writeFileSync('port', String(s.address().port)); console.log('ready on ' + s.address().port); });\n");
  const boundary = new ManagedToolBoundary({ cwd: base, sdkRoot, protectedRoots: [], proxyPorts: [] });
  const self = { boundary };
  const tools = Object.fromEntries(processTools(self).map(tool => [tool.name, tool]));
  const call = async (name, args) => text(await tools[name].execute('id', args, undefined));
  const curl = () => boundary.invoke('bash', { command: 'curl -s "127.0.0.1:$(cat port)"' }).then(text);
  try {
    assert.match(await call('start_process', { command: 'node dev.mjs', name: 'dev server' }), /^Started p1 \(dev server\)/);
    assert.match(await call('process_output', { id: 'p1', wait_seconds: 20, until: 'ready on' }), /^p1 \(dev server\): running .*\nready on \d+/);
    // Another command reaches it; the end of a turn (stopStrays) leaves it running.
    assert.equal(await curl(), 'dev-ok');
    await boundary.stopStrays();
    assert.equal(await curl(), 'dev-ok');
    assert.match(await call('process_output', { id: 'p1' }), /\(no new output\)/);
    // It runs without network, like bash.
    assert.match(await call('start_process', { command: 'curl -sS -m 5 https://example.com -o /dev/null; echo exit=$?' }), /^Started p2/);
    assert.match(await call('process_output', { id: 'p2', wait_seconds: 20, until: 'exit=' }), /exited with code 0[\s\S]*exit=[1-9]/);
    // stop_process ends it with what it started.
    assert.match(await call('stop_process', { id: 'p1' }), /^p1 \(dev server\): stopped \(the agent stopped it\)/);
    await assert.rejects(curl(), /exit code|Command exited/);
    await assert.rejects(tools.process_output.execute('id', { id: 'p9' }), /managed-process-unknown: no background process p9 in this conversation \(known: p1, p2\)/);
    // What still runs stops with the conversation, Apple's own binaries (whose environment ps cannot read) included.
    await call('start_process', { command: `node -e "setTimeout(() => {}, 300000)" ${probe} & sleep 3${process.pid % 1000} & wait`, name: 'left running' });
    for (let i = 0; i < 50 && running() < 1; i += 1) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(running() >= 1, 'the node process (and the bash that started it) run');
  } finally { await boundary.dispose(); }
  assert.equal(running(), 0, 'nothing of the conversation keeps running');
  assert.equal(sleepers(), 0);
  fs.rmSync(base, { recursive: true, force: true });
});

// A stand-in boundary: a child that prints what the test tells it to.
function fakeBoundary() {
  const children = [], stopped = [];
  return { children, stopped, async spawnBackground(_command, key) {
    const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.pid = 2 ** 30 + children.length; child.key = key;
    children.push(child); return { child, isolated: false };
  }, async stopBackground(key) { stopped.push(key); return 1; } };
}

test(`at most ${MAX_PROCESSES} run at once; output is read once, bounded and redacted; a process ends at its lifetime`, async () => {
  const boundary = fakeBoundary(), manager = new BackgroundProcesses(boundary, { poll: 5 });
  for (let i = 0; i < MAX_PROCESSES; i += 1) await manager.start(`server ${i}`);
  await assert.rejects(manager.start('one more'), /managed-process-limit: 4 background processes already run in this conversation \(p1, p2, p3, p4\)/);
  boundary.children[0].emit('close', 0);
  assert.equal((await manager.start('one more')).id, 'p5', 'an exited process frees its place');
  // Output since the last read only; a credential never reaches the agent.
  const child = boundary.children[1];
  child.stdout.emit('data', Buffer.from(`token as_live_12345678-1234-1234-1234-123456789abc_${'b'.repeat(43)} printed\n`));
  const first = await manager.output('p2');
  assert.match(first.text, /token .*printed/); assert.doesNotMatch(first.text, /b{43}/);
  assert.equal((await manager.output('p2')).text, '');
  // More than the buffer keeps the end and says how much was not read.
  child.stdout.emit('data', Buffer.from('x'.repeat(70 * 1024) + 'END'));
  const big = await manager.output('p2');
  assert.match(big.text, /^\[… \d+ characters not read …\]\n/); assert.match(big.text, /END$/);
  // Waiting for a line returns once it appears, or when the process ends.
  setTimeout(() => child.stdout.emit('data', Buffer.from('compiled, ready\n')), 20);
  const ready = await manager.output('p2', { waitSeconds: 5, until: 'ready' });
  assert.equal(ready.matched, true);
  setTimeout(() => child.emit('close', 1), 20);
  const ended = await manager.output('p2', { waitSeconds: 5, until: 'never' });
  assert.equal(ended.matched, false); assert.equal(ended.entry.status, 'exited'); assert.equal(ended.entry.code, 1);
  // A stopped process is stopped by its own marker.
  await manager.stop('p3');
  assert.deepEqual(boundary.stopped, [boundary.children[2].key]);
  // The lifetime ends a process that is still running.
  const short = new BackgroundProcesses(fakeBoundary(), { lifetime: 20 });
  const entry = await short.start('sleep forever');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(entry.status, 'stopped'); assert.equal(entry.reason, 'its 4-hour lifetime ended');
});
