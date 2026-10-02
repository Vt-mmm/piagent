import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, test } from 'node:test';
import { createContext, createPiHarness, writeRuntimeStubs } from './helpers/guard-harness.mjs';
import { registerInputHook, projectPiagentWireInput } from '../packages/piagent-core/runtime/hooks/input-hook.ts';
import { registerAgentStartHook } from '../packages/piagent-core/runtime/hooks/agent-start-hook.ts';
import { RuntimeSessionState } from '../packages/piagent-core/runtime/session/runtime-state.ts';
import { buildWebUiWorkflowCommand } from '../packages/piagent-core/runtime/workflows/webui-workflow.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piagent-freeform-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const prompts = ['alo 123', '  Preserve whitespace\n', 'Fix src/index.ts and test it', 'Review the current patch', '/task-looking text', 'Explain the module', 'x'.repeat(24000)];

test('messages stay freeform across WebUI, input and provider-start hooks; no task intake', async () => {
  const { pi, handlers } = createPiHarness({ activeTools: ['read', 'edit', 'write', 'bash'] });
  const ctx = createContext(root), state = new RuntimeSessionState({ maxObservedContext: 100 });
  let started = 0;
  registerInputHook(pi, { state, activeTask: () => undefined, authorityPolicy: () => { throw Error('retired'); },
    readProtectedPaths: () => ['.env'], imageAccess: () => ({ roots: [root], readProtectedPaths: ['.env'] }),
    activateToolGroups: (_ctx, groups) => assert.equal(groups.some(g => ['task', 'intake', 'recovery'].includes(g)), false), telemetry() {} });
  registerAgentStartHook(pi, { state, activeTask: () => undefined, autoContextEnabled: false,
    readProtectedPaths: () => ['.env'], contextExcludePatterns: () => [], promptPackKey: () => 'prompt', retrievalKey: () => 'retrieval',
    startAutomaticTask: async () => { started++; }, telemetry() {} });
  for (const text of prompts) {
    assert.equal(buildWebUiWorkflowCommand('task', text), text);
    assert.deepEqual(await handlers.get('input')({ text, source: 'rpc' }, ctx), { action: 'continue' });
    await handlers.get('before_agent_start')({ prompt: text, systemPrompt: 'General coding assistant.' }, ctx);
  }
  assert.equal(started, 0);
});

test('wire projection retires persisted workflow/phase state instead of reactivating it', () => {
  const projected = projectPiagentWireInput({ text: 'alo 123', source: 'rpc', activeTask: { trace: { outcome: 'pending' }, intakeMode: 'runtime' },
    readProtectedPaths: [], currentTools: ['read'], availableToolNames: ['read'], dynamicToolsEnabled: true,
    replacementIntake: false, hasImages: false, phase: 'verify' });
  assert.equal(projected.disposition, 'known'); assert.equal(projected.taskPresence, 'none');
  assert.equal(projected.phase, null); assert.deepEqual(projected.selectedTools, ['read']);
});

test('composed guard no longer publishes workflow commands or task contract tools', async () => {
  const copied = path.join(root, 'platform'); fs.mkdirSync(copied);
  writeRuntimeStubs(copied);
  const repo = path.resolve(import.meta.dirname, '..');
  for (const part of ['packages/piagent-core', 'adapters', 'packs', 'catalog', 'scripts']) fs.cpSync(path.join(repo, part), path.join(copied, part), { recursive: true });
  fs.copyFileSync(path.join(repo, 'package.json'), path.join(copied, 'package.json'));
  const { default: guard } = await import(pathToFileURL(path.join(copied, 'packages/piagent-core/extensions/piagent-guard.ts')));
  const h = createPiHarness({ activeTools: ['read', 'write', 'edit', 'bash'] }); guard(h.pi);
  for (const command of ['task', 'workflow', 'scout', 'fresh', 'fresh-task']) assert.equal(h.commands.has(command), false, command);
  for (const tool of ['piagent_task_start', 'piagent_task_progress', 'piagent_task_gate_check', 'piagent_verify_record']) assert.equal(h.tools.has(tool), false, tool);
  const ctx = createContext(root);
  const secret = await h.handlers.get('tool_call')({ toolName: 'read', input: { path: '.env' }, toolCallId: 'secret' }, ctx);
  assert.equal(secret?.block, true);
  assert.doesNotMatch(secret.reason, /start a task|piagent_task_start/i);
  assert.deepEqual(await h.handlers.get('input')({ text: 'alo 123', source: 'interactive' }, ctx), { action: 'continue' });
  assert.equal(h.entries.some(e => e.type === 'user-message'), false);
});


test('both package entrypoints leave retired workflow prompt templates unregistered', () => {
  const repo = path.resolve(import.meta.dirname, '..');
  for (const file of ['package.json', 'packages/piagent-core/package.json']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(repo, file)));
    assert.equal(manifest.pi.prompts, undefined);
    assert.ok(manifest.pi.extensions.length);
  }
});


test('old generated project instructions are replaced with freeform guidance', async () => {
  const {rewriteLegacyProjectInstructions} = await import('../packages/piagent-core/runtime/session/system-prompt.ts');
  const legacy = 'Before implementation:\n\n1. Load `.pi/piagent-profile.json` with `piagent_context`.\nOld workflow rules\n18. If the bundled `pi-subagents` parent skill is available, use it for delegation patterns, review loops, native supervisor coordination, and safety boundaries.';
  const result = rewriteLegacyProjectInstructions(legacy);
  assert.equal(result.rewritten, true);
  assert.doesNotMatch(result.systemPrompt, /30%|piagent_task_start|Runtime creates the task contract/);
  assert.match(result.systemPrompt, /at most two/);
  assert.match(result.systemPrompt, /protected paths/);
});
