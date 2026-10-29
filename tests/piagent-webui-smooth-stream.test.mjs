import test from 'node:test';
import assert from 'node:assert/strict';
import '../scripts/register-typescript-loader.mjs';
import { streamingSplit } from '../packages/piagent-webui/client/src/live-state-view-model.ts';
import { sameJson } from '../packages/piagent-webui/client/src/frame-batched-state.ts';
import { GatewayEventStore } from '../packages/piagent-webui/gateway/gateway-events.ts';

test('a streaming answer renders its finished paragraphs once and only the last one each frame', () => {
  assert.deepEqual(streamingSplit('one'), ['', 'one']);
  assert.deepEqual(streamingSplit('one\n\ntwo\n\nthr'), ['one\n\ntwo', 'thr']);
  const fenced = 'intro\n\n```js\nconst a = 1;\n\nconst b';
  assert.deepEqual(streamingSplit(fenced), ['intro', '```js\nconst a = 1;\n\nconst b'], 'never inside an open code fence');
  assert.deepEqual(streamingSplit('a\n\n```js\nx\n```\n\nb'), ['a\n\n```js\nx\n```', 'b'], 'after a closed fence');
});

test('a refresh that brings nothing new keeps the same object', () => {
  const value = { rows: [{ id: 1 }] };
  assert.equal(sameJson(value, { rows: [{ id: 1 }] }), true);
  assert.equal(sameJson(value, { rows: [{ id: 2 }] }), false);
  assert.equal(sameJson(undefined, value), false);
});

test('a client far behind reloads the snapshot instead of replaying hundreds of events', () => {
  const store = new GatewayEventStore();
  for (let index = 0; index < 300; index += 1) store.publish('catalog.changed', { reason: `change ${index}` });
  assert.equal(store.replay(290).state, 'current');
  assert.equal(store.replay(290).events.length, 10, 'a short gap replays');
  assert.equal(store.replay(10).state, 'resync-required', 'a long gap reloads the snapshot');
});
