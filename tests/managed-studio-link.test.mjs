import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { StudioLink, STUDIO_WAIT_CODES, classifyWait, resumeMessage, LINK_LOG, viaLink } from '../packages/piagent-core/managed/studio-link.mjs';
import { enableCompanyTurnRetry } from '../packages/piagent-core/managed/request-stream.mjs';
import { memberTurn } from '../packages/piagent-core/managed/continuation.mjs';
import { failureCode, describeFailure } from '../packages/piagent-core/runtime/managed-failure.mjs';

const BEFORE = '11111111-1111-4111-8111-111111111111', AFTER = '22222222-2222-4222-8222-222222222222';
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'studio-link-'));
const lines = dir => fs.readFileSync(path.join(dir, 'logs', LINK_LOG), 'utf8').trim().split('\n').map(l => JSON.parse(l));

// A link whose heartbeat answers come from a list (the last one repeats),
// with no real pauses; `calls` records every request.
function linkWith(answers, { agentDir = null, post = () => new Response(null, { status: 204 }) } = {}) {
  const calls = [], events = [], statuses = [];
  let i = 0, clock = Date.parse('2026-10-21T01:00:00Z');
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith('/studio/v1/managed/disconnects')) return post(url, init);
    const next = answers[Math.min(i++, answers.length - 1)];
    if (next instanceof Error) throw next;
    return next();
  };
  const link = new StudioLink({ origin: 'https://studio.example', agentDir, fetchImpl, notify: e => events.push(e), ui: () => ({ setWorkingMessage: t => statuses.push(t) }),
    now: () => clock, pause: async (ms, signal) => { await new Promise(r => setImmediate(r)); if (signal?.aborted) throw signal.reason ?? Error('aborted'); clock += ms; }, random: () => 0.5 });
  return { link, calls, events, statuses, advance: ms => { clock += ms; } };
}

test('a wait across a Studio update is told as an update, logged and reported once Studio answers', async () => {
  const dir = tmp();
  const ready = (boot, version) => () => json(200, { status: 'ready', boot_id: boot, version });
  const { link, calls, events, statuses } = linkWith([
    Object.assign(Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
    () => new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    () => json(503, { status: 'starting', boot_id: AFTER, version: '0.36.0' }),
    ready(AFTER, '0.36.0'),
  ], { agentDir: dir });
  link.observe({ 'x-studio-boot': BEFORE, 'x-studio-version': '0.35.3' });
  const wait = await link.waitUntilBack({ phase: 'continue', code: 'studio-unreachable', conversation: 'conv-1' });
  assert.equal(wait.cause, 'studio_update');
  assert.equal(wait.outcome, 'resumed');
  assert.equal(wait.attempts, 4);
  assert.deepEqual([wait.version_before, wait.version_after, wait.boot_before, wait.boot_after], ['0.35.3', '0.36.0', BEFORE, AFTER]);
  assert.ok(wait.waited_ms >= 2_000);
  assert.deepEqual(events.map(e => e.state), ['start', 'waiting', 'waiting', 'waiting', 'end']);
  assert.equal(events.at(-1).cause, 'studio_update');
  assert.match(statuses[0], /goes on by itself/); assert.equal(statuses.at(-1), undefined);
  // The local log: a start line, then the whole wait, filterable by kind and cause.
  const log = lines(dir);
  assert.deepEqual(log.map(l => l.kind), ['studio_wait', 'studio_disconnect']);
  assert.equal(log[1].cause, 'studio_update'); assert.equal(log[1].conversation, 'conv-1');
  // Reported with the next token; sent once.
  assert.equal(await link.flush('as_run_x'), true);
  const sent = calls.filter(c => c.url.endsWith('/studio/v1/managed/disconnects'));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].init.headers.Authorization, 'Bearer as_run_x');
  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.events.length, 1);
  const e = body.events[0];
  assert.deepEqual([e.phase, e.cause, e.outcome, e.attempts, e.codes[0], e.conversation, e.version_after], ['continue', 'studio_update', 'resumed', 4, 'studio-unreachable', 'conv-1', '0.36.0']);
  assert.ok(e.started_age_ms >= e.ended_age_ms);
  assert.equal(await link.flush('as_run_x'), false, 'nothing left to send');
});

test('the causes Studio and the heartbeat can tell', () => {
  const seen = (...s) => new Set(s);
  assert.equal(classifyWait({ boot: BEFORE, version: '1' }, { boot: AFTER, version: '1' }, seen('down', 'ready'), ['studio-unreachable']), 'studio_restart');
  assert.equal(classifyWait({ boot: BEFORE, version: '1' }, { boot: BEFORE, version: '1' }, seen('draining', 'ready'), ['studio-unreachable']), 'studio_unavailable');
  assert.equal(classifyWait({ boot: BEFORE }, { boot: BEFORE }, seen('down', 'ready'), ['studio-unreachable']), 'network');
  assert.equal(classifyWait({ boot: BEFORE }, { boot: BEFORE }, seen('ready'), ['managed-broker:offline']), 'broker_offline');
  assert.equal(classifyWait({}, {}, seen('ready'), ['studio-unreachable']), 'unknown');
  for (const code of ['studio-unreachable', 'studio-gateway-unavailable', 'managed-broker:offline', 'connector_unavailable']) assert.ok(STUDIO_WAIT_CODES.has(code), code);
  for (const code of ['invalid_api_key', 'quota_exceeded', 'studio-request-failed', 'upstream_policy_refusal']) assert.ok(!STUDIO_WAIT_CODES.has(code), code);
});

test("a gateway's page instead of Studio's answer is its own code; other answers are not", () => {
  for (const raw of ['API error (502): <html>Bad gateway</html>', '503 <html>Service Unavailable</html>', 'API error (524): A timeout occurred', '530 <!DOCTYPE html>'])
    assert.equal(failureCode(raw), 'studio-gateway-unavailable', raw);
  assert.equal(failureCode('API error (400): bad'), 'studio-request-failed');
  assert.equal(failureCode('503 {"error":{"code":"connector_unavailable"}}'), 'connector_unavailable');
  assert.match(describeFailure('main', 'API error (502): x'), /gateway.*\[studio-gateway-unavailable\]$/);
});

test('Stop ends a wait, which is logged and reported as stopped', async () => {
  const dir = tmp();
  const { link } = linkWith([() => new Response('down', { status: 502 })], { agentDir: dir });
  const controller = new AbortController();
  const waiting = link.waitUntilBack({ phase: 'model', code: 'studio-unreachable', signal: controller.signal });
  setTimeout(() => link.cancel(), 5);
  await assert.rejects(waiting);
  assert.equal(lines(dir).at(-1).outcome, 'stopped');
  assert.equal(link.queue.at(-1).record.outcome, 'stopped');
});

test('an older Studio without the heartbeat counts as up; a Studio without the report route is not asked again', async () => {
  const { link, calls } = linkWith([() => new Response('not found', { status: 404, headers: { 'x-request-id': '0b8f6a36-1e0f-4a51-9d9e-3b3f0c0a1a11' } })],
    { post: () => new Response(null, { status: 404 }) });
  const wait = await link.waitUntilBack({ code: 'studio-unreachable' });
  assert.equal(wait.outcome, 'resumed');
  assert.equal(await link.flush('as_run_x'), false);
  assert.equal(link.disabled, true);
  link.queue.push({ record: wait, tries: 0 });
  assert.equal(await link.flush('as_run_x'), false);
  assert.equal(calls.filter(c => c.url.endsWith('/disconnects')).length, 1);
});

test('failing again right after Studio answers waits longer each time, and a request that goes through resets it', async () => {
  const { link } = linkWith([() => json(200, { status: 'ready', boot_id: BEFORE, version: '1' })]);
  const waited = [];
  for (let i = 0; i < 4; i++) waited.push((await link.waitUntilBack({ code: 'studio-unreachable' })).waited_ms);
  assert.deepEqual(waited, [2_000, 4_000, 8_000, 16_000]);
  link.ok();
  assert.equal((await link.waitUntilBack({ code: 'studio-unreachable' })).waited_ms, 2_000);
});

test("an answer cut because Studio stopped is asked again with no limit, after Studio's heartbeat; other failures keep two asks", async () => {
  const waits = [];
  const link = { waits: code => STUDIO_WAIT_CODES.has(code), needed: async code => STUDIO_WAIT_CODES.has(code), waitUntilBack: async (o) => { waits.push(o); return {}; } };
  const prepared = [];
  const session = { _retryAttempt: 2, _isRetryableError() { return false; }, _agentRunAbortRequested: false,
    async _prepareRetry(message) { this._retryAttempt += 1; prepared.push(this._retryAttempt); return this._retryAttempt <= 2; } };
  const overrides = [];
  assert.equal(enableCompanyTurnRetry(session, { applyOverrides: o => overrides.push(o) }, link), true);
  const cut = { stopReason: 'error', errorMessage: describeFailure('main', 'fetch failed: other side closed') };
  assert.equal(failureCode(cut.errorMessage), 'studio-unreachable');
  assert.equal(session._isRetryableError(cut), true);
  // The third, the tenth time: still asked again, each after a wait for Studio.
  for (let i = 0; i < 10; i++) assert.equal(await session._prepareRetry(cut), true);
  assert.equal(waits.length, 10);
  assert.deepEqual(prepared.slice(0, 3), [1, 1, 1]);
  // A key or quota failure is not Studio's: Pi's own two asks, no wait.
  const quota = { stopReason: 'error', errorMessage: describeFailure('main', '{"code":"quota_exceeded"}') };
  session._retryAttempt = 2;
  assert.equal(await session._prepareRetry(quota), false);
  assert.equal(waits.length, 10);
});

test("a round cut by a Studio update goes on by itself once Studio is back, with the reason told to the agent", async () => {
  const entries = [], notified = [], sent = [];
  let rounds = 0;
  const manager = { getBranch: () => [], getEntries: () => [], appendCustomEntry: (type, data) => entries.push({ type, data }), getSessionId: () => 'conv-9' };
  const waits = [];
  const self = { manifest: {}, queued: [], notify: e => notified.push(e),
    studioLink: { waits: code => STUDIO_WAIT_CODES.has(code), waitUntilBack: async o => { waits.push(o); return { cause: 'studio_update', waited_ms: 7 * 60_000, version_before: '0.35.3', version_after: '0.36.0' }; } },
    session: { messages: [], sendCustomMessage: async (message, opts) => { sent.push({ message, opts }); } } };
  const runRound = async (text, deliver) => {
    rounds += 1;
    await deliver();
    // Round 1: Agent Watch could not renew the grant while Studio was being updated.
    self.session.messages.push(rounds === 1 ? { role: 'assistant', stopReason: 'error', errorMessage: describeFailure('main', 'managed-broker:offline') } : { role: 'assistant', stopReason: 'stop' });
    return { result: rounds, planUpdated: false, changed: false };
  };
  await memberTurn(self, { manager, prompt: async () => {}, runRound }, 'build the report', async () => {});
  assert.equal(rounds, 2);
  assert.equal(waits.length, 1); assert.equal(waits[0].phase, 'continue'); assert.equal(waits[0].code, 'managed-broker:offline'); assert.equal(waits[0].conversation, 'conv-9');
  assert.equal(sent.length, 1);
  assert.match(sent[0].message.content, /Studio was updated \(0\.35\.3 → 0\.36\.0\) \[managed-broker:offline\]/);
  assert.equal(sent[0].message.details.phase, 'resume');
  assert.equal(entries.at(-1).data.state, 'done');
});

test('Stop while a round waits for Studio ends the turn as stopped', async () => {
  const entries = [];
  const manager = { getBranch: () => [], getEntries: () => [], appendCustomEntry: (type, data) => entries.push({ type, data }), getSessionId: () => 'conv-9' };
  const self = { manifest: {}, queued: [], notify: () => {},
    studioLink: { waits: code => STUDIO_WAIT_CODES.has(code), waitUntilBack: async () => { self.stopRequested = true; throw Error('managed-request-aborted'); } },
    session: { messages: [], sendCustomMessage: async () => assert.fail('no round after Stop') } };
  const runRound = async () => { self.session.messages.push({ role: 'assistant', stopReason: 'error', errorMessage: describeFailure('main', 'fetch failed') }); return { result: 1 }; };
  await memberTurn(self, { manager, prompt: async () => {}, runRound }, 'x', async () => {});
  assert.equal(entries.at(-1).data.state, 'cancelled');
});

test('the message that resumes the work says why it stopped and not to redo work', () => {
  const m = resumeMessage({ cause: 'network', waited_ms: 30_000 }, 'studio-unreachable');
  assert.match(m.content, /the connection to Studio dropped \[studio-unreachable\]; Studio answers again after about 1 min/);
  assert.match(m.content, /do not redo work that is already done/);
});

test('Agent Watch losing Studio while Studio answers here is asked again for a few minutes, then fails', async () => {
  const ready = () => json(200, { status: 'ready', boot_id: AFTER, version: '0.36.0' });
  const { link, statuses } = linkWith([ready]);
  // 2026-10-22: one gateway 5xx renewing the grant stopped a 25-minute task.
  const first = await link.waitUntilBack({ code: 'managed-broker:serverUnavailable' });
  assert.equal(first.outcome, 'resumed');
  assert.equal(first.cause, 'broker_offline');
  assert.match(statuses.find(Boolean), /Agent Watch could not reach Studio \(managed-broker:serverUnavailable\)/);
  assert.equal(await link.needed('managed-broker:serverUnavailable'), true);
  // Pausing longer each time; past BROKER_RETRY_MS without a request going through it fails as before.
  let asks = 1;
  while (await link.waitUntilBack({ code: 'managed-broker:serverUnavailable' })) asks += 1;
  assert.ok(asks >= 5 && asks <= 8, `asked ${asks} times`);
  assert.equal(await link.needed('managed-broker:offline'), false);
  // A request that goes through starts the window over.
  link.ok();
  assert.equal((await link.waitUntilBack({ code: 'managed-broker:offline' })).outcome, 'resumed');
  // Studio was away and is back: Agent Watch gets a few minutes to reach it again.
  const away = linkWith([() => new Response('x', { status: 502 }), ready]);
  assert.equal((await away.link.waitUntilBack({ code: 'studio-unreachable' })).outcome, 'resumed');
  assert.equal((await away.link.waitUntilBack({ code: 'managed-broker:offline' })).outcome, 'resumed');
});

test("Codes that are not Agent Watch's still fail at once on a running Studio", async () => {
  const ready = () => json(200, { status: 'ready', boot_id: AFTER, version: '0.36.0' });
  const { link } = linkWith([ready]);
  assert.equal(await link.waitUntilBack({ code: 'operation_unavailable' }), null);
  assert.equal(await link.waitUntilBack({ code: 'managed-broker:invalidKey' }), null);
});

test("Studio's connector not answering on a running Studio fails at once; right after Studio was away it is waited out", async () => {
  const ready = () => json(200, { status: 'ready', boot_id: AFTER, version: '0.36.0' });
  const up = linkWith([ready]);
  assert.equal(await up.link.waitUntilBack({ code: 'connector_unavailable' }), null);
  const back = linkWith([() => json(503, { status: 'starting' }), ready]);
  assert.equal((await back.link.waitUntilBack({ code: 'connector_unavailable' })).cause, 'studio_unavailable');
  assert.equal((await back.link.waitUntilBack({ code: 'connector_unavailable' })).outcome, 'resumed', 'just back: the connector gets time too');
});

test('a Studio that started during the wait restarted, even when its earlier version was never seen', () => {
  const since = Date.parse('2026-10-20T16:19:26Z');
  const after = { boot: AFTER, version: '0.36.0', startedAt: '2026-10-20T16:19:41Z' };
  assert.equal(classifyWait({ boot: null, version: null }, after, new Set(['down', 'ready']), ['managed-broker:serverUnavailable'], since), 'studio_restart');
  assert.equal(classifyWait({ boot: null, version: null }, { ...after, startedAt: '2026-10-19T08:00:00Z' }, new Set(['ready']), ['managed-broker:offline'], since), 'broker_offline');
});

test("Closing the round's run is asked again when Agent Watch's way to Studio fails for a moment", async () => {
  const ready = () => json(200, { status: 'ready', boot_id: AFTER, version: '0.36.0' });
  const { link } = linkWith([ready]);
  let asks = 0;
  const closed = await viaLink(link, async () => { if (++asks < 3) throw Error('managed-broker:serverUnavailable'); return 'closed'; }, { runId: AFTER });
  assert.equal(closed, 'closed');
  assert.equal(asks, 3);
  await assert.rejects(viaLink(link, async () => { throw Error('managed-broker:invalidResponse'); }), /invalidResponse/, 'a refusal is not asked again');
  await assert.rejects(viaLink(null, async () => { throw Error('managed-broker:serverUnavailable'); }), /serverUnavailable/, 'no link: fails as before');
});
