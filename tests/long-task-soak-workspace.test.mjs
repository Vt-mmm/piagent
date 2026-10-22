import '../scripts/register-typescript-loader.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { WorkspaceWriteController } from '../packages/piagent-webui/server/workspace-write-controller.ts';
import { writeWorkspaceFile } from '../packages/piagent-core/extensions/workspace-write.ts';
import { editWorkspace, runTerminal } from '../evals/long-task-soak-v1/surfaces/workspace-actions.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
test('soak editor action binds the read digest, uses guarded save and verifies actual saved bytes', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-editor-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const file = path.join(cwd, 'README.md'); fs.writeFileSync(file, 'before');
  const history = [], identity = { projectRef: 'p', runtimeInstanceId: 'r', sessionRef: 's', taskId: null,
    taskRunId: null, agentOperationId: null, toolCallId: null };
  let writes = 0, drift = false;
  const controller = new WorkspaceWriteController({ facts: () => ({ identity, revisions: { workspaceRevision: 'w' }, writable: true, agentRunning: false }),
    history: () => history, append: receipt => history.push(receipt), write: payload => {
      writes++; if (drift) fs.writeFileSync(file, 'concurrent member edit');
      return { state: 'saved', ...writeWorkspaceFile(cwd, payload, { policy: {}, profile: {}, readOnly: false }) };
    } });
  const surface = { sessionRef: 's', http: async (method, url, body) => {
    if (url.endsWith('/workspace/write')) return { status: 200, value: method === 'GET' ? await controller.state() : await controller.execute(body) };
    assert.equal(method, 'GET'); assert.match(url, /inspection\/workspace\/file\?path=README.md$/);
    const content = fs.readFileSync(file, 'utf8');
    return { status: 200, value: { content, digest: sha(content), protected: false, readOnly: false, binary: false, oversized: false } };
  } };
  await editWorkspace(surface, { path: 'README.md', append: '\nmember note' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'before\nmember note'); assert.equal(writes, 1);
  drift = true;
  await assert.rejects(editWorkspace(surface, { path: 'README.md', append: '\nsecond note' }), /rejected:stale-content/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'concurrent member edit'); assert.equal(writes, 2, 'no retry after failed save');
});

test('soak terminal refuses unavailable transport without host execution', async () => {
  let requests = 0, unsubscribed = false;
  const surface = { sessionRef: 's', csrf: 'csrf', onTerminal: () => () => { unsubscribed = true; },
    gatewayRequest: async method => { requests++; assert.equal(method, 'terminals.state');
      return { messageType: 'state', available: false, reasonCode: 'sandbox-pty-unavailable', identity: { sessionRef: 's' } }; } };
  await assert.rejects(runTerminal(surface, { command: 'exit 0' }), /terminal-unavailable:sandbox-pty-unavailable/);
  assert.equal(requests, 1); assert.equal(unsubscribed, true);
});
