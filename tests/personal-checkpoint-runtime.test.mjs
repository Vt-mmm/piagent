import '../scripts/register-typescript-loader.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { PersonalCheckpointRuntime } from '../packages/piagent-core/runtime/checkpoints/personal-runtime.ts';
import { registerToolCallHook } from '../packages/piagent-core/runtime/hooks/tool-call-hook.ts';
import { registerSessionHooks } from '../packages/piagent-core/runtime/hooks/session-hooks.ts';
import { CheckpointStore } from '../packages/piagent-core/runtime/checkpoints/checkpoint-store.mjs';
import { checkpointAuthority } from '../packages/piagent-core/runtime/checkpoints/checkpoint-authority.ts';

test('agent settlement awaits checkpoint completion before returning to the host', async () => {
  const handlers = new Map();
  let release, returned = false;
  const saving = new Promise(resolve => { release = resolve; });
  registerSessionHooks({ on: (name, fn) => handlers.set(name, fn) }, {
    state: {}, maxManifestFiles: 1, telemetry: () => {}, activeTask: () => undefined,
    onAgentSettled: () => saving,
  });
  const result = handlers.get('agent_settled')({}, { cwd: '/fixture', isIdle: () => true,
    sessionManager: { getSessionId: () => 'session' } }).then(() => { returned = true; });
  await Promise.resolve();
  assert.equal(returned, false);
  release(); await result;
  assert.equal(returned, true);
});

test('shutdown clears runtime state even when final checkpoint persistence fails', async () => {
  const handlers = new Map(), observed = [];
  const failure = Error('fixture-checkpoint-save-failed');
  registerSessionHooks({ on: (name, fn) => handlers.set(name, fn) }, {
    state: { qualifiedTaskContext: () => [], clearSession: () => observed.push('cleared') },
    maxManifestFiles: 1, telemetry: () => observed.push('telemetry'), activeTask: () => undefined,
    flushObservedTaskContext: () => observed.push('flushed'), beforeShutdown: async () => { throw failure; },
  });
  await assert.rejects(handlers.get('session_shutdown')({ reason: 'exit' }, {}), error => error === failure);
  assert.deepEqual(observed, ['flushed', 'telemetry', 'cleared']);
});

test('tool hook awaits capture after authorization and records capture refusal as blocked', async () => {
  let handler, release, started;
  const waiting = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const events = [], observed = [];
  let deny = false, captureDeny = false;
  registerToolCallHook({ on: (_name, fn) => { handler = fn; } }, {
    extractLikelyPath: () => undefined, redactText: text => text,
    telemetry: (_ctx, event) => observed.push(event),
    authorize: () => deny ? { block: true, reason: 'policy denied' } : undefined,
    beforeStart: async () => { events.push('capture'); started(); await waiting; return captureDeny ? { block: true, reason: 'capture failed' } : undefined; },
    afterAuthorized: () => { events.push('authorized'); },
  });
  const ctx = { cwd: '/fixture' }, event = { toolName: 'write', toolCallId: 'one', input: { path: 'a', content: 'x' } };
  const running = handler(event, ctx).then(result => { events.push('returned'); return result; });
  await entered;
  assert.deepEqual(events, ['capture']);
  assert.equal(observed.some(item => item.decision === 'allowed'), false);
  release(); await running;
  assert.deepEqual(events, ['capture', 'authorized', 'returned']);
  deny = true; events.length = 0;
  assert.equal((await handler(event, ctx)).block, true);
  assert.deepEqual(events, [], 'denied tools never snapshot');
  deny = false; captureDeny = true; events.length = 0;
  assert.equal((await handler(event, ctx)).block, true);
  assert.deepEqual(events, ['capture']);
  assert.equal(observed.at(-1).decision, 'blocked');
});

test('personal runtime binds exact user turns, captures once, settles on close and restores after restart', async t => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-runtime-')));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', cwd]);
  const file = path.join(cwd, 'file.txt'); fs.writeFileSync(file, 'before');
  const branch = [{ id: 'user-one', type: 'message', message: { role: 'user' } }];
  let idle = false;
  const ctx = { cwd, isIdle: () => idle, sessionManager: {
    getSessionId: () => 'session', getSessionFile: () => undefined, getEntries: () => branch, getBranch: () => branch,
  } };
  const runtime = () => new PersonalCheckpointRuntime(() => ({ policy: {}, profile: {}, readOnly: false }));
  let checkpoints = runtime();
  checkpoints.bind(ctx);
  const originalPort = checkpointAuthority.resolve(cwd, 'session');
  await checkpoints.beforeMutation(ctx); fs.writeFileSync(file, 'first edit');
  await checkpoints.beforeMutation(ctx); fs.writeFileSync(file, 'turn one');
  branch.push({ id: 'user-two', type: 'message', message: { role: 'user' } });
  await checkpoints.beforeMutation(ctx); fs.writeFileSync(file, 'turn two');
  assert.equal((await checkpoints.undo(ctx)).result, 'busy');
  idle = true;
  await checkpoints.close(ctx);
  assert.equal(originalPort.current(), false);
  assert.throws(() => originalPort.list(), /checkpoint-authority-changed/);
  assert.throws(() => checkpointAuthority.resolve(cwd, 'session'), /checkpoint-runtime-unavailable/);
  const store = new CheckpointStore(cwd, 'session');
  assert.deepEqual(store.load().points.map(point => point.turnRef), ['user-one', 'user-two']);
  checkpoints = runtime();
  assert.equal((await checkpoints.undo(ctx)).result, 'done');
  assert.equal(fs.readFileSync(file, 'utf8'), 'turn one');
  assert.equal((await checkpoints.undo(ctx)).result, 'done');
  assert.equal(fs.readFileSync(file, 'utf8'), 'before');
  branch.length = 0;
  await assert.rejects(checkpoints.beforeMutation(ctx), /checkpoint-turn-unavailable/);
  const company = { ...ctx, model: { provider: 'agent_watch_managed' } };
  await assert.rejects(checkpoints.beforeMutation(company), /company-boundary-required/);
  await assert.rejects(checkpoints.undo(company), /company-boundary-required/);
  await checkpoints.close(company);
  await checkpoints.close(ctx);
});

test('replacement runtime revokes old tools, queued commands and handles without letting old close unbind the new owner', async t => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-owner-')));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', cwd]);
  const ctx = { cwd, isIdle: () => true, sessionManager: {
    getSessionId: () => 'owned-session', getSessionFile: () => undefined, getEntries: () => [],
    getBranch: () => [{ id: 'user', type: 'message', message: { role: 'user' } }],
  } };
  const policy = () => ({ policy: {}, profile: {}, readOnly: false });
  const old = new PersonalCheckpointRuntime(policy), replacement = new PersonalCheckpointRuntime(policy);
  fs.writeFileSync(path.join(cwd, 'file'), 'before');
  old.bind(ctx); const handle = checkpointAuthority.resolve(cwd, 'owned-session');
  await old.beforeMutation(ctx);
  fs.writeFileSync(path.join(cwd, 'file'), 'unfinished edit');
  const queued = handle.list();
  replacement.bind(ctx);
  await assert.rejects(queued, /checkpoint-authority-changed/);
  await assert.rejects(old.beforeMutation(ctx), /checkpoint-authority-changed/);
  assert.equal(handle.current(), false);
  await old.close(ctx);
  const current = checkpointAuthority.resolve(cwd, 'owned-session');
  assert.equal(current.current(), true); assert.deepEqual((await current.list()).points, []);
  assert.equal(fs.readFileSync(path.join(cwd, 'file'), 'utf8'), 'unfinished edit');
  assert.equal(new CheckpointStore(cwd, 'owned-session').load().capture, null);
  await replacement.beforeMutation(ctx);
  fs.writeFileSync(path.join(cwd, 'file'), 'replacement edit');
  await replacement.finish(ctx);
  assert.equal((await current.list()).points.length, 1);
  assert.throws(() => checkpointAuthority.resolve(cwd, 'other-session'), /checkpoint-runtime-unavailable/);
  await replacement.close(ctx);
});
