import assert from 'node:assert/strict';
import test from 'node:test';
import { WORKSPACE_WRITE_ENTRY, takeWorkspaceMemberEditNotice, registerWorkspaceMemberEdits } from '../packages/piagent-core/runtime/session/workspace-member-edits.mjs';
const edit = (id, path, phase = 'settled', resultCode = 'saved') => ({ id, type: 'custom', customType: WORKSPACE_WRITE_ENTRY, data: { path, phase, resultCode } });
test('member edit notice waits for successful delivery and preserves saves arriving during delivery', () => {
  const entries = [edit('one', 'src/a.ts')], manager = { getBranch: () => entries };
  const notice = takeWorkspaceMemberEditNotice(manager);
  assert.match(notice.content, /src\/a.ts/); assert.deepEqual(takeWorkspaceMemberEditNotice(manager), notice);
  entries.push(edit('two', 'src/b.ts'), { ...notice, id: 'notice', type: 'custom_message' });
  const next = takeWorkspaceMemberEditNotice(manager);
  assert.match(next.content, /src\/b.ts/); assert.doesNotMatch(next.content, /src\/a.ts/);
  entries.push({ ...next, id: 'notice2', type: 'custom_message' });
  assert.equal(takeWorkspaceMemberEditNotice(manager), null);
});
test('member edit notice respects branches, ignores rejected writes and bounds unsafe filenames', () => {
  const entries = [edit('a', 'src/a.ts'), edit('b', 'src/a.ts'), edit('c', 'bad\nname'), edit('d', 'refused.ts', 'rejected', 'read-only')];
  const notice = takeWorkspaceMemberEditNotice({ getBranch: () => entries });
  assert.equal(notice.content.match(/src\/a.ts/g).length, 1); assert.doesNotMatch(notice.content, /bad|refused/);
  assert.equal(takeWorkspaceMemberEditNotice({ getBranch: () => [] }), null);
  const many = takeWorkspaceMemberEditNotice({ getBranch: () => Array.from({ length: 100 }, (_, n) => edit(String(n), `${n}${'a'.repeat(500)}`)) });
  assert.ok(many.content.length < 5000); assert.match(many.content, /84 more files/);
});
test('personal before_agent_start contributes the same pending member notice', () => {
  let handler; registerWorkspaceMemberEdits({ on: (event, callback) => { assert.equal(event, 'before_agent_start'); handler = callback; } });
  const sessionManager = { getBranch: () => [edit('one', 'file.ts')] };
  assert.deepEqual(handler({}, { sessionManager }), { message: takeWorkspaceMemberEditNotice(sessionManager) });
});
