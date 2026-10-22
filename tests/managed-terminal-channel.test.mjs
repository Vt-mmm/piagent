import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { terminalChannel } from '../packages/piagent-core/managed/terminal-channel.mjs';

function fixture(t) {
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const events = [], sent = [];
  child.stdin.on('data', data => sent.push(JSON.parse(data.toString())));
  const channel = terminalChannel(child, event => events.push(event));
  const send = value => child.stdout.write(JSON.stringify(value) + '\n');
  t.after(() => child.emit('close'));
  return { child, events, sent, channel, send };
}

test('company channel acknowledges each native effect once and does not replay after lost receipt', async t => {
  const { child, channel, send, sent, events } = fixture(t);
  send({ kind: 'ready' }); await channel.initialized;
  const input = channel.execute({ kind: 'input', data: 'one\n' });
  assert.equal(sent.length, 1);
  send({ kind: 'output', data: 'one\r\n' });
  send({ kind: 'ack', id: sent[0].id }); await input;
  assert.deepEqual(events, [{ kind: 'output', data: 'one\r\n' }]);
  const pending = channel.execute({ kind: 'input', data: 'two\n' });
  child.emit('close');
  await assert.rejects(pending, /effect-uncertain/);
  await assert.rejects(channel.execute({ kind: 'input', data: 'three\n' }), /terminal-exited/);
  assert.deepEqual(sent.map(value => value.data), ['one\n', 'two\n']);
});

test('company channel refuses invalid startup frames and bounds in-flight commands', async t => {
  const first = fixture(t);
  const rejection = assert.rejects(first.channel.initialized, /protocol-invalid/);
  first.send({ kind: 'output', data: 'before ready' }); first.child.emit('close'); await rejection;
  const { child, channel, send } = fixture(t);
  send({ kind: 'ready' }); await channel.initialized;
  const outcomes = [];
  for (let i = 0; i < 128; i++) outcomes.push(assert.rejects(channel.execute({ kind: 'input', data: 'x' }), /effect-uncertain/));
  await assert.rejects(channel.execute({ kind: 'input', data: 'overflow' }), /terminal-capacity/);
  child.emit('close'); await Promise.all(outcomes);
});

test('company channel rejects oversized frames and does not publish forged output', async t => {
  const { child, channel, send, events } = fixture(t);
  send({ kind: 'ready' }); await channel.initialized;
  const rejected = assert.rejects(channel.execute({ kind: 'resize', cols: 80, rows: 24 }), /protocol-invalid/);
  send({ kind: 'output', data: 'x'.repeat(8193) }); child.emit('close'); await rejected;
  assert.equal(events.some(event => event.kind === 'output'), false);
});
