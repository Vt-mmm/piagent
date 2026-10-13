import test from 'node:test';
import assert from 'node:assert/strict';
import {declineFast, fastAllowed, fastPayload, fastRefusal, fastServed, fastSetter, fastState, recordFast, restoreFast} from '../packages/piagent-core/managed/fast-mode.mjs';
import {managedProjection} from '../packages/piagent-webui/gateway/managed-projection.ts';

const manifest = fast => ({harness: {configuration: {main: {mode: 'fixed', model_ids: ['m']}, ...(fast === undefined ? {} : {fast_mode: fast})}}});
function manager() {
  const entries = [];
  return {entries, getEntries: () => entries, appendCustomEntry: (customType, data) => entries.push({type: 'custom', customType, data})};
}
const row = entries => managedProjection({model: {provider: 'agent_watch_managed'}}, entries).managedFast;

test('fast mode exists only where the Harness allows it, and starts off', () => {
  assert.equal(fastAllowed(manifest()), false); assert.equal(fastAllowed(manifest(false)), false); assert.equal(fastAllowed(manifest('true')), false); assert.equal(fastAllowed(manifest(true)), true);
  const closed = {manifest: manifest()}, m = manager();
  closed.fast = restoreFast(m); recordFast(closed, m);
  assert.equal(fastState(closed), null); assert.equal(row(m.entries), undefined, 'no switch on the dashboard');
  assert.throws(() => fastSetter(closed, m)(true), /managed-fast-unavailable/);

  const open = {manifest: manifest(true)}, n = manager();
  open.fast = restoreFast(n); recordFast(open, n);
  assert.equal(fastState(open), 'off'); assert.equal(row(n.entries), 'off');
  const set = fastSetter(open, n);
  assert.equal(set(true), true); assert.equal(set(true), false, 'already on');
  assert.equal(fastState(open), 'on'); assert.equal(row(n.entries), 'on');
  assert.equal(restoreFast(n), true, 'kept with the conversation');
  // The administrator turns fast mode off in the Harness: the conversation follows.
  open.manifest = manifest(false); recordFast(open, n);
  assert.equal(open.fast, false); assert.equal(fastState(open), null); assert.equal(row(n.entries), undefined); assert.equal(restoreFast(n), false);
});

test('only the main agent\'s call on a model that serves fast mode asks for the priority tier', async () => {
  const on = {manifest: manifest(true), fast: true}, codex = {provider: 'codex', native: 'gpt-6-astra'};
  const body = {model: 'gpt', input: 'x'};
  assert.deepEqual(await fastPayload(on, 'main', codex)(body, {}), {model: 'gpt', input: 'x', service_tier: 'priority'});
  assert.equal(body.service_tier, undefined, 'the caller\'s payload is not changed in place');
  // An earlier hook's payload is kept and gains the tier.
  assert.deepEqual(await fastPayload(on, 'main', codex, async p => ({...p, store: false}))(body, {}), {model: 'gpt', input: 'x', store: false, service_tier: 'priority'});
  const earlier = () => undefined;
  assert.equal(fastPayload(on, 'review', codex, earlier), earlier, 'subagents run as usual');
  assert.equal(fastPayload({manifest: manifest(true), fast: false}, 'main', codex, earlier), earlier, 'off until the member turns it on');
  assert.equal(fastPayload({manifest: manifest(false), fast: true}, 'main', codex, earlier), earlier, 'the Harness stopped allowing it');
  // Every other provider and model runs at standard speed, with nothing added
  // to its request: Claude's fast mode is another protocol billed outside the
  // plan, the API-key vendors have none, and an unlisted Codex model may refuse the tier.
  for (const route of [{provider: 'claude', native: 'claude-opus-5-5'}, {provider: 'claude', native: 'claude-sonnet-5-5'}, {provider: 'opencode-go', native: 'kimi-k3'},
    {provider: 'deepseek', native: 'deepseek-v4-pro'}, {provider: 'codex', native: 'gpt-4-old'}, {provider: 'codex'}, undefined]) {
    assert.equal(fastServed(route), false, JSON.stringify(route));
    assert.equal(fastPayload(on, 'main', route, earlier), earlier, JSON.stringify(route));
  }
  for (const native of ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.5']) assert.equal(fastServed({provider: 'codex', native}), true, native);
});

test('a refused fast request puts the conversation back to standard speed', () => {
  assert.equal(fastRefusal('policy_denied'), true); assert.equal(fastRefusal('upstream_request_rejected'), true);
  for (const code of ['token_quota_exhausted', 'upstream_rate_limited', 'concurrency_limit', 'upstream_interrupted', 'studio-unreachable']) assert.equal(fastRefusal(code), false, code);
  const m = manager(), notices = [];
  const owner = {manifest: manifest(true), fast: true, session: {sessionManager: m, sendCustomMessage: message => { notices.push(message); return Promise.resolve(); }}};
  recordFast(owner, m);
  assert.equal(row(m.entries), 'on');
  declineFast(owner, 'policy_denied');
  assert.equal(owner.fast, false); assert.equal(row(m.entries), 'off'); assert.equal(restoreFast(m), false);
  assert.equal(notices.length, 1); assert.match(notices[0].content, /policy_denied.*standard speed/); assert.equal(notices[0].customType, 'agent-watch-fast-notice');
  const earlier = () => undefined;
  assert.equal(fastPayload(owner, 'main', {provider: 'codex', native: 'gpt-6-sol'}, earlier), earlier, 'the next ask carries no tier');
  // A session that cannot post the notice still goes on at standard speed.
  const bare = {manifest: manifest(true), fast: true, session: {}};
  declineFast(bare, 'upstream_request_rejected'); assert.equal(bare.fast, false);
});
