import assert from 'node:assert/strict';
import { test } from 'node:test';
import { memberTurn, PROVIDER_RESUME_CODES, PROVIDER_RESUME_DELAYS_MS } from '../packages/piagent-core/managed/continuation.mjs';
import { STUDIO_WAIT_CODES } from '../packages/piagent-core/managed/studio-link.mjs';
import { failureCode, describeFailure } from '../packages/piagent-core/runtime/managed-failure.mjs';
import { TURN_RETRY_CODES } from '../packages/piagent-core/managed/request-stream.mjs';

// Found 2026-10-21: gpt-6-sol sent its own error event (api_error) in the
// middle of an answer after a tool ran; the round failed, nothing asked it
// again, and a long task stopped until the member wrote again 8 minutes later.

test("the provider's error event inside an answer is a passing failure the turn asks again", () => {
  for (const raw of ['Error Code server_error: An error occurred while processing your request. You can retry your request.', 'server_error: An error occurred while processing your request',
    'Error Code undefined: undefined', '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', 'api_error: Internal server error'])
    assert.equal(failureCode(raw), 'upstream_server_error', raw);
  // Studio's own end of a stream keeps its code; other failures are not this one.
  assert.equal(failureCode('{"type":"error","error":{"type":"api_error","code":"upstream_interrupted","message":"Request interrupted"}}'), 'upstream_interrupted');
  assert.equal(failureCode('API error (400): bad'), 'studio-request-failed');
  assert.equal(failureCode('{"code":"token_quota_exhausted"}'), 'token_quota_exhausted');
  assert.ok(TURN_RETRY_CODES.has('upstream_server_error'));
  assert.ok(PROVIDER_RESUME_CODES.has('upstream_server_error'));
  assert.match(describeFailure('main', 'Error Code server_error: x'), /model provider failed while answering.*\[upstream_server_error\]$/);
});

// A member turn whose rounds answer from a list: 'fail' ends a round with the
// provider's error, anything else ends it well.
function turnWith(outcomes, { delays = [10, 20, 40], stopOnHold = false } = {}) {
  const entries = [], sent = [], holds = [], logs = [], notes = [];
  let rounds = 0;
  const manager = { getEntries: () => [], appendCustomEntry: (type, data) => entries.push({ type, data }), getSessionId: () => 'conv-7' };
  const self = { manifest: {}, queued: [], providerResumeDelaysMs: delays, notify: e => notes.push(e),
    studioLink: { waits: code => STUDIO_WAIT_CODES.has(code), waitUntilBack: async () => null, log: e => logs.push(e), status: () => {},
      hold: async ms => { holds.push(ms); if (stopOnHold) { self.stopRequested = true; throw Error('managed-request-aborted'); } } },
    session: { messages: [], sendCustomMessage: async message => { sent.push(message); } } };
  const runRound = async (text, deliver) => {
    await deliver();
    const outcome = outcomes[Math.min(rounds++, outcomes.length - 1)];
    self.session.messages.push(outcome === 'fail' ? { role: 'assistant', stopReason: 'error', errorMessage: describeFailure('main', 'Error Code server_error: An error occurred while processing your request') }
      : { role: 'assistant', stopReason: 'stop' });
    return { result: rounds };
  };
  return { run: () => memberTurn(self, { manager, prompt: async () => {}, runRound }, 'migrate the reports module', async () => {}), entries, sent, holds, logs, notes, rounds: () => rounds };
}

test('a round cut by the provider goes on by itself after a pause, telling the agent why; a round that ends well resets the count', async () => {
  const t = turnWith(['fail', 'ok']);
  await t.run();
  assert.equal(t.rounds(), 2);
  assert.deepEqual(t.holds, [10]);
  assert.match(t.sent[0].content, /model provider failed while answering \[upstream_server_error\].*attempt 1 of 3/);
  assert.equal(t.entries.at(-1).data.state, 'done');
  assert.deepEqual(t.logs.map(l => [l.kind, l.code, l.attempt]), [['provider_retry', 'upstream_server_error', 1]]);
  assert.equal(t.notes.find(n => n.type === 'managed_provider_retry').attempt, 1);
});

test('a provider that keeps failing is asked again a bounded number of times, then the turn fails with its reason', async () => {
  const t = turnWith(['fail']);
  await t.run();
  assert.equal(t.rounds(), 4, 'the first round and three more');
  assert.deepEqual(t.holds, [10, 20, 40]);
  assert.equal(t.entries.at(-1).data.state, 'failed');
  assert.equal(t.entries.at(-1).data.code, 'upstream_server_error');
  assert.equal(t.logs.at(-1).outcome, 'gave_up');
  assert.equal(PROVIDER_RESUME_DELAYS_MS.reduce((a, b) => a + b, 0), 1_365_000, 'about 23 minutes in all by default');
});

test('Stop while the round waits to go on ends the turn as stopped', async () => {
  const t = turnWith(['fail', 'ok'], { stopOnHold: true });
  await t.run();
  assert.equal(t.rounds(), 1);
  assert.equal(t.sent.length, 0);
  assert.equal(t.entries.at(-1).data.state, 'cancelled');
});
