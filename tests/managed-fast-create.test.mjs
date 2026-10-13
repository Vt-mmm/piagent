import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fastPayload, fastSetter} from '../packages/piagent-core/managed/fast-mode.mjs';
import {managedModelOption} from '../packages/piagent-webui/gateway/managed-gateway.mjs';
import {executeFastCommand} from '../packages/piagent-webui/gateway/runtime-session-controls.ts';
import {SessionCommandController} from '../packages/piagent-webui/gateway/session-command-controller.ts';
import {SessionCommandStore} from '../packages/piagent-webui/gateway/session-command-store.ts';
import {GatewayEventStore} from '../packages/piagent-webui/gateway/gateway-events.ts';
import {buildSessionCatalog, sessionRefForPath} from '../packages/piagent-webui/gateway/session-catalog.ts';
import {SessionInspectionRegistry} from '../packages/piagent-webui/gateway/session-inspection-registry.ts';
import {createWebUiSchemaRegistry, validateFixture} from './helpers/piagent-webui-schema-registry.mjs';

const registry = createWebUiSchemaRegistry();
const manifest = fast => ({models: [], harness: {configuration: {main: {mode: 'fixed', model_ids: []}, ...(fast === undefined ? {} : {fast_mode: fast})}}});

// A company conversation created from the new chat page: the runtimes double
// opens a managed session whose Fast switch is the real one (fast-mode.mjs),
// applied through the same control the header uses (executeFastCommand).
function fixture(t, allowed) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piagent-fast-create-')); fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const key = Buffer.alloc(32, 23), info = {path: path.join(root, 'created.jsonl'), id: 'raw-created', cwd: path.join(root, 'project'),
    name: 'New session', created: new Date('2026-10-13T09:05:01.000Z'), modified: new Date('2026-10-13T09:05:02.000Z'),
    messageCount: 1, firstMessage: 'Build fast.', allMessagesText: 'Build fast.'};
  const entries = [], manager = {getEntries: () => entries, appendCustomEntry: (customType, data) => entries.push({type: 'custom', customType, data})};
  const owner = {manifest: manifest(allowed), fast: false};
  const session = {managedExecution: true, managedSetFast: fastSetter(owner, manager)};
  const steps = [];
  let sessions = [];
  const runtimes = {
    async create() { steps.push('create'); sessions = [info]; return sessionRefForPath(key, info.path); },
    async setFast(sessionRef, fast) {
      assert.equal(sessionRef, sessionRefForPath(key, info.path));
      steps.push(`fast:${fast}`); return executeFastCommand(session, fast) ? 'fast-changed' : 'no-change';
    },
    async send(sessionRef, payload) {
      // What the first run's main-agent request will carry, decided now.
      const body = await fastPayload(owner, 'main', {provider: 'codex', native: 'gpt-6-sol'})?.({input: payload.message}, {});
      steps.push(`send:fast=${owner.fast}:tier=${body?.service_tier ?? 'none'}`);
      return {resultCode: 'started', operationRef: 'operation_fast_01'};
    }
  };
  const catalog = () => buildSessionCatalog({gatewayInstanceRef: 'gateway_fast_create', key, listSessions: async () => sessions});
  const controller = new SessionCommandController({catalog, runtimes, store: new SessionCommandStore(root, key), events: new GatewayEventStore(),
    now: () => new Date('2026-10-13T09:06:00.000Z')});
  const command = async (payload, suffix = 'a') => ({schemaVersion: 1, version: 'piagent-session-command-v1', messageType: 'command',
    commandId: `command_fast_${suffix}`, idempotencyKey: `idempotency_fast_${suffix}_1234567890`, action: 'session.create',
    requestedAt: '2026-10-13T09:05:00.000Z', expiresAt: '2026-10-13T09:10:00.000Z', sessionRef: null,
    expectedCatalogRevision: (await catalog()).catalogRevision, expectedSessionRevision: null,
    payload: {projectRef: 'project_fast_01', placeRef: 'project_fast_01', modelRef: null, thinkingLevel: 'high',
      message: 'Build fast.', messageRequestId: `message_fast_${suffix}`, ...payload}});
  return {controller, command, steps, owner, entries};
}

test('a conversation created with Fast starts on Fast before its first message runs', async t => {
  const f = fixture(t, true), command = await f.command({fast: true});
  assert.equal(validateFixture(registry, 'session-command-v1', command).valid, true);
  const receipt = await f.controller.execute(command);
  assert.equal(validateFixture(registry, 'session-command-v1', receipt).valid, true);
  assert.deepEqual([receipt.phase, receipt.resultCode], ['settled', 'started']);
  assert.deepEqual(f.steps, ['create', 'fast:true', 'send:fast=true:tier=priority']);
  assert.equal(f.entries.at(-1).data.enabled, true, 'kept with the conversation');
});

test('a conversation created without Fast never touches it', async t => {
  for (const [payload, suffix] of [[{}, 'none'], [{fast: false}, 'off']]) {
    const f = fixture(t, true), receipt = await f.controller.execute(await f.command(payload, suffix));
    assert.equal(receipt.phase, 'settled');
    assert.deepEqual(f.steps, ['create', 'send:fast=false:tier=none'], suffix);
  }
});

test('Fast asked for where the Harness does not allow it is refused, and nothing is sent', async t => {
  const f = fixture(t, false), receipt = await f.controller.execute(await f.command({fast: true}));
  assert.equal(validateFixture(registry, 'session-command-v1', receipt).valid, true);
  assert.deepEqual([receipt.phase, receipt.resultCode], ['rejected', 'unavailable']);
  assert.equal(receipt.error?.code, 'company-policy', "the Harness's refusal (managed-fast-unavailable)");
  assert.deepEqual(f.steps, ['create', 'fast:true']);
  assert.equal(f.owner.fast, false);
  // A conversation that is not a company one has no Fast switch at all.
  assert.throws(() => executeFastCommand({}, true), /managed-fast-unavailable/);
});

test('the create payload carries Fast only as a boolean', async t => {
  const f = fixture(t, true);
  for (const [fast, suffix] of [['yes', 'str'], [1, 'num'], [null, 'nul']]) {
    const command = await f.command({fast}, suffix);
    assert.equal(validateFixture(registry, 'session-command-v1', command).valid, false, suffix);
    await assert.rejects(() => f.controller.execute(command), /invalid-session-command/, suffix);
  }
  assert.deepEqual(f.steps, []);
});

test('the new chat page learns whether the Harness allows Fast from the company model', async () => {
  assert.equal(managedModelOption(manifest(true), {}, {provider: 'agent_watch_managed', id: 'agent-watch-auto'}).managedFast, true);
  assert.equal(managedModelOption(manifest(false), {}, {provider: 'agent_watch_managed', id: 'agent-watch-auto'}).managedFast, false);
  assert.equal(managedModelOption(manifest(), {}, {provider: 'agent_watch_managed', id: 'agent-watch-auto'}).managedFast, false);
  const options = async snapshot => (await new SessionInspectionRegistry({gatewayInstanceRef: 'gateway_fast_options', key: Buffer.alloc(32, 5),
    packageRoot: os.tmpdir(), host: {SessionManager: {listAll: async () => []}}, models: {getModel() {}, getAvailableSnapshot: () => snapshot}}).creationOptions()).models;
  const company = {provider: 'agent_watch_managed', id: 'agent-watch-auto', name: 'agent-watch-auto', reasoning: true, managedThinkingLevels: ['high']};
  assert.equal((await options([{...company, managedFast: true}]))[0].managedFast, true);
  assert.equal((await options([{...company, managedFast: false}]))[0].managedFast, undefined, 'no switch');
  // A personal model never offers it, whatever its snapshot says.
  assert.equal((await options([{provider: 'openai-codex', id: 'gpt-6-sol', name: 'GPT-6 Sol', reasoning: true, managedFast: true}]))[0].managedFast, undefined);
});
