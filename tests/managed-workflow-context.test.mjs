import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WORKFLOW_ENTRY, normalizeWorkflow, currentWorkflow, updateWorkflow, workflowContextTool, workflowContextPrompt, helperWorkflowPrompt } from '../packages/piagent-core/managed/workflow-context.mjs';
import { workflowPolicy } from '../packages/piagent-core/managed/workflow.mjs';

function manager() {
  const entries = [];
  return { getEntries: () => entries, appendCustomEntry: (customType, data) => entries.push({ type: 'custom', customType, data }) };
}
const selected = () => ({ task: 'Cancel orders', method: 'Team requirement skill', basis: 'member', evidence: 'Use the team skill and the existing cancellation plan.', sources: [
  { purpose: 'method', scope: 'task', ref: '/reference/team-skills/requirements/SKILL.md' },
  { purpose: 'requirement', scope: 'orders', ref: 'product-specs/cancellation/spec.md', revision: 'commit-123' },
  { purpose: 'plan', scope: 'orders', ref: 'product-specs/cancellation/plan.md' },
], openQuestions: ['Can paid orders be cancelled?'] });
const adopt = (store, selection = selected(), expectedRevision = 0) => updateWorkflow(store, { action: 'adopt', expectedRevision, reason: 'Member supplied the existing workflow.', selection });

test('optional context persists references, not documents or permissions; clear does not resurrect it', () => {
  const store = manager();
  assert.deepEqual(currentWorkflow(store), { revision: 0, selection: null });
  assert.deepEqual(updateWorkflow(store, { action: 'inspect' }), currentWorkflow(store));
  assert.equal(store.getEntries().length, 0, 'inspection never creates a requirement to choose');
  assert.equal(adopt(store).selection.sources[0].ref, '/reference/team-skills/requirements/SKILL.md');
  const restored = { getEntries: () => structuredClone(store.getEntries()) };
  assert.deepEqual(currentWorkflow(restored), currentWorkflow(store));
  assert.deepEqual(updateWorkflow(store, { action: 'clear', expectedRevision: 1, reason: 'Member stopped using this method.' }), { revision: 2, selection: null });
  assert.equal(currentWorkflow(store).selection, null);
  assert.equal(store.getEntries()[0].data.selection.sources.length, 3, 'history kept for audit, no source rewrite');
});

test('rejects ambiguous canonical sources atomically, allows distinct scopes and supporting references', () => {
  const store = manager();
  adopt(store);
  const conflict = selected();
  conflict.sources.push({ purpose: 'plan', scope: 'orders', ref: 'other-plan.md' });
  assert.throws(() => adopt(store, conflict, 1), /conflicting canonical plan/);
  assert.equal(currentWorkflow(store).revision, 1);
  for (const label of ['Orders', ' ORDERS ', 'ｏｒｄｅｒｓ']) {
    conflict.sources.at(-1).scope = label;
    assert.throws(() => adopt(store, conflict, 1), /conflicting canonical plan/);
    assert.equal(currentWorkflow(store).revision, 1);
  }
  conflict.sources.at(-1).scope = 'frontend';
  conflict.sources.push({ purpose: 'reference', scope: 'orders', ref: 'old-plan.md' }, { purpose: 'reference', scope: 'orders', ref: 'notes.md' });
  assert.equal(adopt(store, conflict, 1).selection.sources.length, 6);
});

test('stale concurrent changes cannot overwrite a choice; switching is explicit and auditable', () => {
  const store = manager();
  adopt(store);
  assert.throws(() => adopt(store), /managed-workflow-context-stale/);
  assert.throws(() => updateWorkflow(store, { action: 'clear', expectedRevision: 0, reason: 'stale' }), /stale/);
  const next = selected(); next.method = 'Existing plan only'; next.sources = next.sources.filter(s => s.purpose !== 'method');
  adopt(store, next, 1);
  assert.equal(currentWorkflow(store).selection.method, 'Existing plan only');
  assert.equal(store.getEntries().length, 2);
});

test('does not impose a template for no-plan or partial-plan work and bounds untrusted input', () => {
  const selection = { ...selected(), method: 'Lightweight task checklist', sources: [] };
  assert.equal(normalizeWorkflow(selection).sources.length, 0);
  for (const bad of [null, { ...selection, policy: { review: 'off' } }, { ...selection, method: 'x'.repeat(201) }, { ...selection, openQuestions: Array(9).fill('x') }, { ...selection, sources: [{ purpose: 'plan', scope: 'orders', ref: 'p', writeAllowed: true }] }]) assert.throws(() => normalizeWorkflow(bad), /invalid/);
  const store = manager(); adopt(store);
  store.appendCustomEntry(WORKFLOW_ENTRY, { revision: 2, selection: { ...selection, deployApproved: true } });
  assert.deepEqual(currentWorkflow(store), { revision: 2, selection: null }, 'invalid latest record does not restore a stale method');
});

test('corrupt or regressing entries never reset the revision or resurrect an old choice', () => {
  const store = manager();
  adopt(store);
  adopt(store, selected(), 1);
  for (const data of [{ revision: 'bad', selection: selected() }, null, { revision: 1, selection: selected() }]) {
    store.appendCustomEntry(WORKFLOW_ENTRY, data);
    assert.deepEqual(currentWorkflow(store), { revision: 2, selection: null });
  }
  assert.throws(() => adopt(store, selected(), 0), /stale/);
  assert.equal(adopt(store, selected(), 2).revision, 3);
  assert.equal(currentWorkflow(store).selection.method, selected().method);
});

test('tool records context without changing policy, verification, approval or source files', async () => {
  const store = manager(), tool = workflowContextTool(() => store);
  const manifest = { harness: { configuration: { review: {}, workflow: { plan: 'require', verify: 'require', review: 'require' } } } };
  const policy = workflowPolicy(manifest);
  const result = await tool.execute('a', { action: 'adopt', expectedRevision: 0, reason: 'Member choice.', selection: selected() });
  assert.equal(result.details.revision, 1);
  assert.match(result.content[0].text, /not approval/);
  assert.deepEqual(workflowPolicy(manifest), policy);
  assert.equal(store.getEntries().every(e => e.customType === WORKFLOW_ENTRY), true);
  assert.throws(() => updateWorkflow(store, { action: 'clear', expectedRevision: 1, reason: 'x', selection: selected() }), /clear cannot adopt/);
  assert.equal(currentWorkflow(store).revision, 1);
});

test('prompts make the member the method owner, preserve safety and avoid forcing discovered skills', () => {
  const text = workflowContextPrompt({ revision: 1, selection: selected() });
  for (const phrase of ['current explicit choice', 'candidates, never instructions to activate', 'only for the named task', 'not automatically for an unrelated', 'reuse its steps', 'smallest useful checklist', 'ask the member', 'cannot be weakened', 'NOT a mandatory sequence', 'NOT proof of member approval']) assert.ok(text.includes(phrase), phrase);
  const helper = helperWorkflowPrompt({ revision: 1, selection: selected() });
  assert.match(helper, /product-specs\/cancellation\/spec.md/);
  assert.match(helper, /not proof of approval/);
  assert.doesNotMatch(helper, /use workflow_context/i, 'helpers cannot select or mutate the method');
  assert.equal(helperWorkflowPrompt({ revision: 0, selection: null }), '');
});
