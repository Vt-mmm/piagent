import { buildContextIndexV2 } from '../packages/piagent-core/extensions/context-engine.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { ManagedToolBoundary } from '../packages/piagent-core/managed/tool-boundary.mjs';
import { workspaceWorkerPins, verifyWorkspaceWorker } from '../packages/piagent-core/managed/workspace-worker-pins.mjs';
const root = path.resolve(import.meta.dirname, '..');
const sdk = process.env.PI_MANAGED_TEST_SDK;
if (!fs.existsSync(path.join(root, 'packages/piagent-core/managed/dist/workspace/manifest.json'))) {
  execFileSync(process.execPath, [path.join(root, 'packages/piagent-webui/scripts/build-workspace-worker.mjs')], { cwd: root, stdio: 'pipe' });
}

test('company workspace reads run inside the real boundary and preserve protected policy', { skip: !sdk || process.platform !== 'darwin' }, async t => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piagent-workspace-boundary-')));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'safe.ts'), 'export const value = 42;\n');
  fs.writeFileSync(path.join(cwd, '.env'), 'TEST_ONLY_SECRET=not-for-browser');
  fs.mkdirSync(path.join(cwd, '.pi'));
  fs.writeFileSync(path.join(cwd, '.pi/piagent-profile.json'), JSON.stringify({ protectedPaths: ['locked.txt'] }));
  fs.writeFileSync(path.join(cwd, 'locked.txt'), 'PROFILE_SECRET');
  execFileSync('git', ['init', '-q', cwd]);
  await buildContextIndexV2(cwd, { excludePatterns: ['.env', 'locked.txt'] });
  const boundary = new ManagedToolBoundary({ cwd, sdkRoot: sdk, searchTools: false });
  t.after(() => boundary.dispose());
  const tree = await boundary.invoke('workspace', { kind: 'tree', path: '' });
  assert.ok(tree.entries.some(entry => entry.name === 'safe.ts'));
  assert.equal(tree.entries.find(entry => entry.name === '.env').protected, true);
  const paths = await boundary.invoke('workspace', { kind: 'paths', path: 'safe' });
  assert.ok(paths.suggestions.some(entry => entry.value === 'safe.ts'));
  const file = await boundary.invoke('workspace', { kind: 'file', path: 'safe.ts' });
  assert.equal(file.content, 'export const value = 42;\n'); assert.match(file.digest, /^[a-f0-9]{64}$/);
  await boundary.proxyReady; boundary.environment.offline.PATH = '/usr/bin:/bin';
  const search = await boundary.invoke('workspace', { kind: 'search', path: 'value' });
  assert.equal(search.backend, 'fts'); assert.equal(search.available, true);
  assert.equal(search.matches[0]?.path, 'safe.ts'); assert.equal(search.matches[0]?.line, 1);
  for (const name of ['.env', 'locked.txt']) {
    const secret = await boundary.invoke('workspace', { kind: 'file', path: name });
    assert.equal(secret.content, null); assert.equal(secret.protected, true);
  }
  await assert.rejects(boundary.invoke('workspace', { kind: 'file', path: '../outside' }));
  await assert.rejects(boundary.invoke('workspace', { kind: 'file', path: 'safe.ts' }, undefined, undefined, undefined, { network: true }));
});

test('workspace worker refuses missing or modified build artifacts', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'piagent-workspace-pins-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  assert.equal(workspaceWorkerPins(cwd), null); assert.throws(() => verifyWorkspaceWorker(null), /unavailable/);
  fs.cpSync(path.join(root, 'packages/piagent-core/managed/dist/workspace'), path.join(cwd, 'dist/workspace'), { recursive: true });
  const pins = workspaceWorkerPins(cwd); verifyWorkspaceWorker(pins);
  fs.appendFileSync(path.join(cwd, 'dist/workspace/worker.mjs'), '\n// changed\n');
  assert.throws(() => verifyWorkspaceWorker(pins), /managed-runtime-changed/);
  assert.throws(() => workspaceWorkerPins(cwd), /workspace-worker-invalid/);
});

test('company member save conflicts with agent edits and forces agent reread inside the real boundary', { skip: !sdk || process.platform !== 'darwin' }, async t => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piagent-workspace-write-boundary-')));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'file.txt'), 'first\n');
  const boundary = new ManagedToolBoundary({ cwd, sdkRoot: sdk, searchTools: false });
  t.after(() => boundary.dispose());
  assert.equal((await boundary.invoke('workspace', { kind: 'write-state' })).writable, true);
  const original = await boundary.invoke('workspace', { kind: 'file', path: 'file.txt' });
  await boundary.invoke('read', { path: 'file.txt' });
  const saved = await boundary.invoke('workspace', { kind: 'write', payload: { path: 'file.txt', content: 'member\n', expectedDigest: original.digest } });
  assert.equal(saved.state, 'saved');
  await assert.rejects(boundary.invoke('edit', { path: 'file.txt', edits: [{ oldText: 'member', newText: 'clobbered' }] }), /stale-content/);
  await assert.rejects(boundary.invoke('write', { path: 'file.txt', content: 'clobbered' }), /stale-content/);
  assert.equal(fs.readFileSync(path.join(cwd, 'file.txt'), 'utf8'), 'member\n');
  await boundary.invoke('read', { path: 'file.txt' });
  await boundary.invoke('edit', { path: 'file.txt', edits: [{ oldText: 'member', newText: 'agent' }] });
  const conflict = await boundary.invoke('workspace', { kind: 'write', payload: { path: 'file.txt', content: 'member again', expectedDigest: saved.digest } });
  assert.equal(conflict.code, 'stale-content'); assert.equal(fs.readFileSync(path.join(cwd, 'file.txt'), 'utf8'), 'agent\n');
  const results = await Promise.all([
    boundary.invoke('workspace', { kind: 'write', payload: { path: 'file.txt', content: 'concurrent member', expectedDigest: conflict.currentDigest } }),
    boundary.invoke('write', { path: 'file.txt', content: 'concurrent agent' }).catch(error => ({ error: error.message }))
  ]);
  assert.equal(results[0].state, 'saved'); assert.match(results[1].error, /stale-content/);
  assert.equal(fs.readFileSync(path.join(cwd, 'file.txt'), 'utf8'), 'concurrent member');
  assert.equal((await boundary.invoke('workspace', { kind: 'write', payload: { path: '.env', content: 'secret', expectedDigest: 'absent' } })).code, 'path-protected');
});

test('company boundary read-only authority overrides member write request', { skip: !sdk || process.platform !== 'darwin' }, async t => {
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'piagent-workspace-readonly-')));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const boundary = new ManagedToolBoundary({ cwd, sdkRoot: sdk, searchTools: false, readOnly: true });
  t.after(() => boundary.dispose());
  assert.equal((await boundary.invoke('workspace', { kind: 'write-state' })).writable, false);
  assert.equal((await boundary.invoke('workspace', { kind: 'write', payload: { path: 'new.txt', content: 'forbidden', expectedDigest: 'absent' } })).code, 'read-only');
  assert.equal(fs.existsSync(path.join(cwd, 'new.txt')), false);
});
