import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createContext, createPiHarness, writeRuntimeStubs, callToolCall } from './helpers/guard-harness.mjs';
const repository = path.resolve(import.meta.dirname, '..');

async function fixture(t, mode, finalGate = 'enforce') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piagent-diagnostic-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['packages/piagent-core', 'adapters', 'packs', 'evals', 'scripts']) {
    fs.cpSync(path.join(repository, name), path.join(root, name), { recursive: true });
  }
  fs.copyFileSync(path.join(repository, 'package.json'), path.join(root, 'package.json'));
  writeRuntimeStubs(root);
  const policyPath = path.join(root, 'packages/piagent-core/policies/base-policy.json');
  const policy = JSON.parse(fs.readFileSync(policyPath));
  if (mode !== undefined) policy.finalGate.acceptanceProofMode = mode;
  fs.writeFileSync(policyPath, JSON.stringify(policy));
  const { default: guard } = await import(pathToFileURL(path.join(root, 'packages/piagent-core/extensions/piagent-guard.ts')));
  const cwd = path.join(root, 'project'); fs.mkdirSync(path.join(cwd, '.pi'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'src')); fs.mkdirSync(path.join(cwd, 'test'));
  fs.writeFileSync(path.join(cwd, 'README.md'), '# Count validation\n');
  fs.writeFileSync(path.join(cwd, '.gitignore'), '.pi/\n');
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node --test test/count.test.js' } }));
  fs.writeFileSync(path.join(cwd, 'src/count.js'), 'export function requireCount(count) { return count; }\n');
  fs.writeFileSync(path.join(cwd, 'test/count.test.js'), '// baseline\n');
  fs.writeFileSync(path.join(cwd, '.pi/piagent-profile.json'), JSON.stringify({ schemaVersion: 1, projectId: 'diagnostic-test',
    displayName: 'Diagnostic Test', mode: 'node-typescript', authorityProfile: 'strict-high-risk',
    protectedPaths: [], shellProtectedPaths: [], requiredContext: [], verifyCommands: { test: ['npm test'] },
    mcpCapabilities: ['filesystem-readonly', 'filesystem-write', 'shell'], permissionProfile: 'workspace-write',
    runtimePolicy: { execPolicy: 'enforce', contextBudget: 'enforce', toolRegistry: 'advisory', finalGate } }));
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.com'); git('add', '.'); git('commit', '-qm', 'baseline');
  const ctx = createContext(cwd, { sessionId: 'diagnostic-session', sessionName: 'DIAG-1' });
  const harness = createPiHarness({ activeTools: ['read', 'bash', 'edit', 'write'] }); guard(harness.pi);
  await harness.handlers.get('session_start')({}, ctx);
  await harness.handlers.get('tool_result')({ toolName: 'read', input: { path: 'README.md' },
    content: [{ type: 'text', text: '# Count validation' }], isError: false }, ctx);
  const started = await harness.tools.get('piagent_task_start').execute('start', { taskId: 'DIAG-1',
    summary: 'Fix requireCount in src/count.js to validate integer counts.', riskLane: 'tiny',
    expectedOutput: 'Return integer counts and reject fractional counts with TypeError.',
    acceptanceCriteria: ['`requireCount` must reject a non-integer count with `TypeError`;'],
    scope: ['src/count.js', 'test/**'] }, undefined, undefined, ctx);
  assert.equal(started.isError, undefined, JSON.stringify(started));
  await harness.handlers.get('tool_result')({ toolName: 'read', input: { path: 'README.md' },
    content: [{ type: 'text', text: fs.readFileSync(path.join(cwd, 'README.md'), 'utf8') }], isError: false }, ctx);
  await harness.tools.get('piagent_context_record').execute('context', { taskId: 'DIAG-1',
    files: [{ path: 'README.md', reason: 'Read the count validation context.' }] }, undefined, undefined, ctx);
  return { cwd, ctx, harness, started };
}

for (const [label, mode, defect, allowed, finalGate] of [
  ['default retains pending proof with a diagnostic observation', undefined, null, true],
  ['explicit enforce keeps missing proof blocked', 'enforce', null, false],
  ['diagnostic retains pending proof and records a terminal observation', 'diagnostic', null, true],
  ['diagnostic retains failed verifier as a hard block', 'diagnostic', 'wrong', false],
  ['diagnostic retains stale verifier as a hard block', 'diagnostic', 'stale', false],
  ['diagnostic retains failed focused test after configured verification passes', 'diagnostic', 'focused-failed', false],
  ['diagnostic permits a current passing focused rerun after repair', 'diagnostic', 'focused-repaired', true],
  ['diagnostic hard checks survive advisory UI mode', 'diagnostic', 'wrong', false, 'advisory'],
  ['unknown mode cannot weaken default enforcement', 'unknown-mode', null, false]
]) test(label, { timeout: 60000 }, async t => {
  const { cwd, ctx, harness, started } = await fixture(t, mode, finalGate);
  const source = 'function validate(value) { if (!Number.isInteger(value)) throw new TypeError(); }\n'
    + 'export function requireCount(count) { validate(count); return count; }\n';
  const tests = "import assert from 'node:assert/strict';import {requireCount} from '../src/count.js';assert.throws(()=>requireCount(1.5),TypeError);\n";
  for (const [name, content] of [['src/count.js', defect === 'wrong' ? 'export function requireCount(count){return count;}\n' : source], ['test/count.test.js', tests]]) {
    const input = { path: name, content };
    const decision = await callToolCall(harness.handlers.get('tool_call'), ctx, 'write', input);
    assert.equal(decision.block, undefined, decision.reason);
    fs.writeFileSync(path.join(cwd, name), content);
    await harness.handlers.get('tool_result')({ toolName: 'write', input, content: [{ type: 'text', text: `Wrote ${name}` }], isError: false }, ctx);
  }
  if (defect?.startsWith('focused-')) {
    const focusedPath = 'test/focused.test.js';
    const writeFocused = async content => {
      const input = { path: focusedPath, content };
      const decision = await callToolCall(harness.handlers.get('tool_call'), ctx, 'write', input);
      assert.equal(decision.block, undefined, decision.reason);
      fs.writeFileSync(path.join(cwd, focusedPath), content);
      await harness.handlers.get('tool_result')({ toolName: 'write', input,
        content: [{ type: 'text', text: `Wrote ${focusedPath}` }], isError: false }, ctx);
    };
    const runFocused = async expected => {
      const input = { command: `node --test ${focusedPath}` }, id = `focused-${expected}`;
      const decision = await harness.handlers.get('tool_call')({ toolCallId: id, toolName: 'bash', input }, ctx) ?? {};
      assert.equal(decision.block, undefined, decision.reason);
      const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
      const run = spawnSync(process.execPath, ['--test', focusedPath], { cwd, env, encoding: 'utf8', timeout: 10000 });
      assert.equal(run.status, expected, run.stdout + run.stderr);
      await harness.handlers.get('tool_result')({ toolCallId: id, toolName: 'bash', input,
        content: [{ type: 'text', text: run.stdout + run.stderr }], details: { exitCode: run.status },
        isError: run.status !== 0, timestamp: Date.now() }, ctx);
    };
    await writeFocused("import assert from 'node:assert/strict'; assert.equal(1, 2);\n");
    await runFocused(1);
    if (defect === 'focused-repaired') {
      await writeFocused("import assert from 'node:assert/strict'; assert.equal(1, 1);\n");
      await runFocused(0);
    }
  }
  const input = { command: 'npm test' }, id = 'diagnostic-verify';
  const decision = await harness.handlers.get('tool_call')({ toolCallId: id, toolName: 'bash', input }, ctx) ?? {};
  assert.equal(decision.block, undefined, decision.reason);
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const run = spawnSync('npm', ['test'], { cwd, env, encoding: 'utf8', timeout: 10000 });
  assert.equal(run.status, defect === 'wrong' ? 1 : 0, run.stdout + run.stderr);
  await harness.handlers.get('tool_result')({ toolCallId: id, toolName: 'bash', input,
    content: [{ type: 'text', text: run.stdout + run.stderr }], details: { exitCode: run.status }, isError: run.status !== 0, timestamp: Date.now() }, ctx);
  if (defect === 'stale') fs.appendFileSync(path.join(cwd, 'src/count.js'), '// later mutation\n');
  const result = await harness.tools.get('piagent_trace_record').execute('finish', { taskId: 'DIAG-1', outcome: 'completed', changedFiles: ['src/count.js', 'test/count.test.js', ...(defect?.startsWith('focused-') ? ['test/focused.test.js'] : [])] }, undefined, undefined, ctx).catch(error => { if (error.piagentToolResult) return error.piagentToolResult; throw error; });
  assert.equal(result.isError === true, !allowed, JSON.stringify(result));
  if (defect === 'focused-failed') assert.ok(result.details.gate.missing.includes('current passing rerun of failed focused verification'), JSON.stringify(result));
  const task = JSON.parse(fs.readFileSync(path.join(cwd, '.pi/piagent-state/tasks', started.details.taskRunId + '.json')));
  assert.ok(task.acceptanceReceipt.criteria.some(c => c.status === 'pending'));
  assert.equal(task.trace.outcome, allowed ? 'completed' : 'pending');
  if (allowed) {
    assert.equal(result.details.gate.acceptanceProof.mode, 'diagnostic');
    assert.ok(result.details.gate.acceptanceProof.pendingCriterionIds.length > 0);
    assert.match(task.trace.notes, /no quality claim/);
    assert.match(result.content[0].text, /diagnostic acceptance; no quality claim/);
  }
});
