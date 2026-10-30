import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { snapshotRuntime } from '../packages/piagent-core/managed/runtime-snapshot.mjs';
import { RunProcess, completionGate } from '../packages/piagent-core/managed/workflow.mjs';

// An update rewrites the install in place. A running session keeps its own
// copy of the workers, and its pins keep guarding that copy.
function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-snapshot-')));
  t.after(() => { fs.rmSync(base, { recursive: true, force: true }); });
  const source = path.join(base, 'managed'), home = path.join(base, 'home');
  fs.mkdirSync(path.join(source, 'dist/workspace/assets'), { recursive: true }); fs.mkdirSync(home);
  fs.writeFileSync(path.join(source, 'tool-worker.mjs'), 'export const release = 1;\n');
  fs.writeFileSync(path.join(source, 'dist/workspace/assets/a.js'), 'export const a = 1;\n');
  return { source, home };
}

test('a copy survives the install changing; the next process gets a copy of the new files', async (t) => {
  const { source, home } = fixture(t), first = snapshotRuntime(source, { home });
  assert.equal(snapshotRuntime(source, { home }), first, 'the same files share one copy');
  assert.equal((await import(path.join(first, 'dist/workspace/assets/a.js'))).a, 1, 'its .js files load as modules');
  fs.writeFileSync(path.join(source, 'tool-worker.mjs'), 'export const release = 2;\n');
  assert.equal(fs.readFileSync(path.join(first, 'tool-worker.mjs'), 'utf8'), 'export const release = 1;\n');
  const second = snapshotRuntime(source, { home });
  assert.notEqual(second, first);
  assert.equal(fs.readFileSync(path.join(second, 'tool-worker.mjs'), 'utf8'), 'export const release = 2;\n');
});

test('a damaged copy is rebuilt, and a copy unused for a month is removed', (t) => {
  const { source, home } = fixture(t), now = Date.now(), first = snapshotRuntime(source, { home, now });
  fs.chmodSync(path.join(first, 'tool-worker.mjs'), 0o600); fs.writeFileSync(path.join(first, 'tool-worker.mjs'), 'tampered');
  assert.equal(snapshotRuntime(source, { home, now }), first);
  assert.equal(fs.readFileSync(path.join(first, 'tool-worker.mjs'), 'utf8'), 'export const release = 1;\n');
  fs.writeFileSync(path.join(source, 'tool-worker.mjs'), 'export const release = 2;\n');
  const second = snapshotRuntime(source, { home, now: now + 40 * 24 * 60 * 60 * 1000 });
  assert.equal(fs.existsSync(first), false); assert.equal(fs.existsSync(second), true);
});

test('code that cannot be read is not reported as changed unless a real edit happened', async () => {
  for (const [edited, expected] of [[false, 'no_change'], [true, 'unverified']]) {
    const run = new RunProcess({ plan: 'off', verify: 'require', review: 'off', maxFixLoops: 0, lanes: false }, { request: 'x', complex: false, checks: { commands: [] } });
    run.startDigest = 's'.repeat(64);
    await run.afterTool('bash', { command: 'git status' }, false, async () => null);
    if (edited) await run.afterTool('edit', { path: 'a.js' }, true, async () => null);
    const entries = [], managed = { ownPaths: new Set(), review: null, changeDigest: async () => { throw Error('managed-runtime-changed'); }, patchDigest: async () => { throw Error('managed-runtime-changed'); },
      session: { messages: [], sessionManager: { getEntries: () => entries, appendCustomEntry: () => {} }, sendCustomMessage: async () => {} } };
    await completionGate(managed, run, undefined);
    assert.equal(run.outcome, expected);
  }
});
