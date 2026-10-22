import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileWorkspaceRead } from '../packages/piagent-webui/client/src/workspace-refresh-model.ts';

test('refresh replaces clean bytes but preserves drafts, pending saves and newer baselines', () => {
  const file = { path: 'a.txt', content: 'old', digest: 'old', protected: false, readOnly: false };
  const incoming = { ...file, content: 'agent', digest: 'new' };
  const tab = { file, draft: 'old', fresh: false, line: 7 };
  const clean = reconcileWorkspaceRead(tab, file, incoming);
  assert.equal(clean.tab.draft, 'agent'); assert.equal(clean.tab.file, incoming); assert.equal(clean.tab.line, 7);
  const typing = { ...tab, draft: 'member typed while reading' };
  const conflict = reconcileWorkspaceRead(typing, file, incoming);
  assert.equal(conflict.tab, typing); assert.equal(conflict.conflict, incoming);
  for (const current of [{ ...tab, pending: {} }, { ...tab, fresh: true }, { ...tab, file: { ...incoming }, draft: 'new baseline' }])
    assert.equal(reconcileWorkspaceRead(current, file, incoming).tab, current);
  assert.equal(reconcileWorkspaceRead(tab, file, { ...file }).tab, tab);
  const protectedFile = { ...incoming, digest: null, content: null, protected: true };
  assert.equal(reconcileWorkspaceRead(tab, file, protectedFile).tab.draft, '');
  assert.equal(reconcileWorkspaceRead(typing, file, protectedFile).conflict, protectedFile);
});
