import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { searchWorkspace } from '../packages/piagent-core/extensions/workspace-search.ts';
import { buildContextIndexV2 } from '../packages/piagent-core/extensions/context-engine.js';
const policy = { policy: { protectedPaths: ['secret/**'] }, profile: {} };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piagent-search-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  fs.mkdirSync(path.join(root, 'secret'));
  fs.writeFileSync(path.join(root, 'source.md'), 'first\n  needle in source\nlast\n');
  fs.writeFileSync(path.join(root, 'secret/credentials.txt'), 'needle PRIVATE');
  fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.txt\n');
  fs.writeFileSync(path.join(root, 'ignored.txt'), 'needle IGNORED');
  return root;
}
test('ripgrep search returns current line and column without ignored, protected or symlink content', async t => {
  const root = fixture(t);
  fs.symlinkSync(path.join(root, 'secret/credentials.txt'), path.join(root, 'link.txt'));
  const result = await searchWorkspace(root, 'needle', policy);
  assert.equal(result.backend, 'ripgrep');
  assert.deepEqual(result.matches, [{ path: 'source.md', line: 2, column: 3, preview: '  needle in source' }]);
  assert.equal(result.truncated, false);
  fs.writeFileSync(path.join(root, 'source.md'), Array(150).fill('needle').join('\n'));
  const limited = await searchWorkspace(root, 'needle', policy);
  assert.equal(limited.matches.length, 100); assert.equal(limited.truncated, true);
});
test('Context Engine fallback finds current text and never serves stale indexed content', async t => {
  const root = fixture(t);
  await buildContextIndexV2(root, { excludePatterns: ['secret/**'] });
  const result = await searchWorkspace(root, 'needle', policy, { rg: null });
  assert.equal(result.backend, 'fts'); assert.equal(result.available, true);
  assert.deepEqual(result.matches, [{ path: 'source.md', line: 2, column: 3, preview: '  needle in source' }]);
  fs.writeFileSync(path.join(root, 'source.md'), 'replaced content');
  assert.deepEqual((await searchWorkspace(root, 'needle', policy, { rg: null })).matches, []);
});
test('search has a deadline and says when no fallback index is available', async t => {
  const root = fixture(t);
  assert.equal((await searchWorkspace(root, 'needle', policy, { rg: null })).available, false);
  const result = await searchWorkspace(root, 'needle', policy, { rg: null, timeout: 1 });
  assert.equal(result.truncated, true);
  await assert.rejects(searchWorkspace(root, '', policy), /query-invalid/);
});
