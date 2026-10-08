import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Continuation, turnEnd, turnEndText, IDLE_ROUNDS, MAX_ROUNDS } from '../packages/piagent-core/managed/continuation.mjs';
import { turnEndCopy, turnEndOf, turnEndShort } from '../packages/piagent-webui/shared/turn-end.ts';

// A main agent that ends its turn with checklist steps open is sent on, under
// plan "require", until the checklist is done, the member stops it, a round
// fails, two rounds in a row finish no step and change no code, or 30 rounds.
const REQUIRE = { plan: 'require' };
const plan = (done, steps) => ({ plan: Array.from({ length: steps }, (_, i) => ({ step: `STEP${i + 1}`, status: i < done ? 'completed' : i === done ? 'in_progress' : 'pending' })) });

test('a checklist left open is sent on while rounds make progress', () => {
  const c = new Continuation(REQUIRE);
  c.begin(null);
  const first = c.next({ plan: plan(1, 22), planUpdated: true, changed: true });
  assert.equal(first.details.phase, 'continue'); assert.equal(first.details.round, 1);
  assert.deepEqual([first.details.planOpen, first.details.planDone, first.details.planSteps], [21, 1, 22]);
  assert.match(first.content, /21 open step\(s\) \(1\/22 completed\)/); assert.match(first.content, /ask with ask_user/);
  // Each round completes a step: the harness goes on to the last one.
  for (let done = 2; done < 22; done += 1) {
    c.begin(plan(done - 1, 22));
    assert.ok(c.next({ plan: plan(done, 22), planUpdated: true, changed: false }), `round after STEP${done}`);
  }
  c.begin(plan(21, 22));
  assert.equal(c.next({ plan: plan(22, 22), planUpdated: true, changed: true }), null);
  assert.deepEqual({ ...turnEnd(c, plan(22, 22), {}), at: 0 }, { state: 'done', planSteps: 22, planDone: 22, rounds: 21, at: 0 });
});

test(`${IDLE_ROUNDS} rounds in a row without progress stop it; a code change counts as progress`, () => {
  const c = new Continuation(REQUIRE);
  c.begin(null); assert.ok(c.next({ plan: plan(1, 3), planUpdated: true }));
  c.begin(plan(1, 3)); assert.equal(c.next({ plan: plan(1, 3) }).details.idle, 1);
  c.begin(plan(1, 3)); assert.ok(c.next({ plan: plan(1, 3), changed: true }), 'code changed: progress');
  c.begin(plan(1, 3)); assert.ok(c.next({ plan: plan(1, 3) }));
  c.begin(plan(1, 3)); assert.equal(c.next({ plan: plan(1, 3) }), null);
  assert.equal(c.reason, 'idle');
  const end = turnEnd(c, plan(1, 3), {});
  assert.deepEqual([end.state, end.planDone, end.planSteps, end.reason, end.rounds], ['midway', 1, 3, 'idle', 4]);
  assert.match(turnEndText(end), /2 of 3 checklist step\(s\) open: the agent stopped 2 times in a row without progress/);
});

test('Stop, a failure, no checklist, a plan that is only suggested, and the round limit', () => {
  const stopped = new Continuation(REQUIRE); stopped.begin(null);
  assert.equal(stopped.next({ plan: plan(1, 3), planUpdated: true, stopped: true }), null);
  assert.equal(turnEnd(stopped, plan(1, 3), { stopped: true }).state, 'cancelled');
  // A run that could not be closed (network gone) ends the turn as failed, with a code the dashboard reads.
  const unclosed = new Continuation(REQUIRE); unclosed.begin(null);
  assert.equal(unclosed.next({ plan: plan(1, 3), planUpdated: true, failed: true }), null);
  assert.deepEqual([turnEnd(unclosed, plan(1, 3), { failure: { role: 'main', code: 'managed-broker:offline' } }).code], ['managed_broker_offline']);
  const failed = new Continuation(REQUIRE); failed.begin(null);
  assert.equal(failed.next({ plan: plan(1, 3), planUpdated: true, failed: true }), null);
  assert.deepEqual([turnEnd(failed, plan(1, 3), { failure: { role: 'main', code: 'upstream_unavailable' } }).state, turnEnd(failed, plan(1, 3), { failure: { code: 'x' } }).role], ['failed', 'main']);
  // An old checklist the turn never touched is not this message's work.
  const untouched = new Continuation(REQUIRE); untouched.begin(plan(1, 3));
  assert.equal(untouched.next({ plan: plan(1, 3), planUpdated: false }), null);
  assert.deepEqual([turnEnd(untouched, plan(1, 3), {}).state, turnEnd(untouched, plan(1, 3), {}).planSteps], ['done', 0]);
  const suggested = new Continuation({ plan: 'suggest' }); suggested.begin(null);
  assert.equal(suggested.next({ plan: plan(1, 3), planUpdated: true, changed: true }), null);
  assert.deepEqual([turnEnd(suggested, plan(1, 3), {}).state, turnEnd(suggested, plan(1, 3), {}).reason], ['midway', 'policy']);
  const long = new Continuation(REQUIRE); long.begin(null);
  let rounds = 0;
  for (let i = 0; i < 100; i += 1) { long.begin(plan(0, 30)); if (!long.next({ plan: plan(0, 30), planUpdated: true, changed: true })) break; rounds += 1; }
  assert.equal(rounds, MAX_ROUNDS); assert.equal(long.reason, 'limit');
});

test('the member reads whether the task is finished, and why not', () => {
  assert.equal(turnEndOf({ state: 'midway', planSteps: 3, planDone: 4, rounds: 0 }), null, 'more done than steps');
  assert.equal(turnEndOf({ state: 'paused', planSteps: 3, planDone: 1, rounds: 0 }), null);
  const midway = turnEndOf({ state: 'midway', planSteps: 22, planDone: 6, rounds: 2, reason: 'idle', at: 'x' });
  assert.deepEqual(midway, { state: 'midway', planSteps: 22, planDone: 6, rounds: 2, reason: 'idle' });
  const copy = turnEndCopy(midway, 'vi');
  assert.equal(copy.title, 'Dừng giữa chừng · còn 16/22 bước'); assert.equal(copy.tone, 'warning'); assert.equal(copy.continuable, true);
  assert.match(copy.text, /dừng 2 vòng liên tiếp/); assert.match(copy.text, /làm tiếp 2 vòng/);
  assert.equal(turnEndShort(midway, 'vi'), 'Dừng giữa chừng 6/22');
  const done = turnEndCopy({ state: 'done', planSteps: 22, planDone: 22, rounds: 21 }, 'vi');
  assert.deepEqual([done.title, done.tone, done.continuable], ['Hoàn thành · 22/22 bước', 'success', false]);
  const failed = turnEndCopy(turnEndOf({ state: 'failed', planSteps: 3, planDone: 1, rounds: 0, role: 'main', code: 'upstream_unavailable' }), 'vi');
  assert.equal(failed.title, 'Lượt dừng vì lỗi · Main agent'); assert.match(failed.text, /\[upstream_unavailable\]/);
  assert.equal(turnEndCopy({ state: 'cancelled', planSteps: 0, planDone: 0, rounds: 0 }, 'en').title, 'You stopped this turn');
  // The copy never names a model.
  for (const c of [copy, done, failed]) assert.doesNotMatch(c.title + c.text, /gpt|claude|sol|luna/i);
});
