import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { approve, commandTools, servicesPrompt, unsandboxedBash } from '../packages/piagent-core/managed/command-tools.mjs';
import { beforeCheckOrPush } from '../packages/piagent-core/managed/check-questions.mjs';
import { fetchDecision } from '../packages/piagent-core/managed/fetch-guard.mjs';
import { alwaysBypass, broadAccess, effectivePermission, networkConfirmation, permissionSetter, restorePermission } from '../packages/piagent-core/managed/permission.mjs';
import { ManagedToolBoundary } from '../packages/piagent-core/managed/tool-boundary.mjs';
import { criticalRemovalReason, noteRemovalExpired, projectDenyReason, removalsHeld } from '../packages/piagent-core/runtime/policy/critical-removal.mjs';
import { memberMcpGuard } from '../packages/piagent-core/managed/member-mcp.mjs';
import { managedProjection } from '../packages/piagent-webui/gateway/managed-projection.ts';

// Owner, 2026-11-02: a warning and the member's decision, based on Claude's
// bypass: no sandbox and no limit on network, MCP or files; only committing and
// pushing code and an rm on a critical path are asked. Bypass keeps asking about the whole handoff.
const base = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'pa-always-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const manager = () => { const entries = []; return { entries, getEntries: () => entries, appendCustomEntry: (customType, data) => entries.push({ type: 'custom', customType, data }) }; };
const member = (permission = 'always-bypass') => ({ permission, manifest: {}, cwd: base, grant: {}, session: { sessionManager: { getSessionId: () => 'session' } },
  boundary: { engine: null, dockerCli: null, userHome: os.homedir(), refreshEnvironment: () => false, invoke: async () => { throw Error('the sandbox was used'); } },
  changedFiles: async () => [], claimChanges: async () => {}, refreshReview: async () => {} });

test('any member turns it on, with no Harness switch, and it is kept with the conversation', () => {
  const owner = member('workspace-write'), log = manager();
  assert.throws(() => permissionSetter(owner, log)('bypass'), /managed-bypass-unavailable/, 'Bypass still needs the Harness');
  permissionSetter(owner, log)('always-bypass');
  assert.equal(owner.permission, 'always-bypass'); assert.equal(restorePermission(log), 'always-bypass');
  assert.equal(effectivePermission(owner), 'always-bypass'); assert.ok(alwaysBypass(owner)); assert.ok(broadAccess(owner));
  assert.equal(managedProjection({ model: { provider: 'agent_watch_managed' } }, log.entries).managedPermission, 'always-bypass');
});

test('only committing and pushing code is asked; Bypass keeps asking about the handoff', async () => {
  for (const command of ['npm publish', 'npx vercel deploy --prod', 'cat ~/.ssh/id_rsa', 'ssh host ls', 'curl -X POST https://example.com', 'git pull', 'git status', 'rm -rf build', 'gh pr create'])
    assert.equal(await networkConfirmation(member(), command), null, command);
  for (const command of ['git push --force origin main', 'git -C api push', 'git commit -m x', 'cd api && git commit -am x', 'bash -c "git push"', 'if true; then git commit; fi', 'env X=1 git push', 'gh pr merge 3'])
    assert.ok(await networkConfirmation(member(), command), command);
  assert.ok(await networkConfirmation({ ...member('bypass'), manifest: { harness: { configuration: { bypass_mode: true } } } }, 'git push origin main'));
  await approve(member(), 'id', undefined, undefined, { toolName: 'x', requestedScope: 'handoff-once' }, { title: 't', body: 'b' });
});

test('every run_* tool and a push run on the machine without asking or holding for tests', async () => {
  const owner = member(), host = commandTools(owner).find(tool => tool.name === 'run_on_host');
  const file = path.join(base, 'host.txt');
  const result = await host.execute('id', { command: `echo pushed > ${JSON.stringify(file)}; cat ${JSON.stringify(file)}`, reason: 'test' }, undefined, undefined, {});
  assert.match(result.content[0].text, /pushed/);
  owner.run = { checks: { commands: ['npm test'] }, policy: {} };
  await beforeCheckOrPush(owner, 'git push origin main', {}, undefined);
  const denied = commandTools(owner).find(tool => tool.name === 'run_with_network');
  await assert.rejects(denied.execute('id', { command: `touch ${JSON.stringify(path.join(base, 'pushed'))}; git push`, reason: 'test' }, undefined, undefined, { ui: { confirm: async () => false } }));
  assert.equal(fs.existsSync(path.join(base, 'pushed')), false, 'a no stops the push');
  await assert.rejects(host.execute('id', { command: 'sudo ls', reason: 'test' }, undefined, undefined, {}), /managed-host-member-only/, 'a password still needs the member');
});

test('web_fetch reads any address, for helpers too', () => {
  assert.equal(fetchDecision(member(), 'main', 'https://example.com/?d=1'), null);
  assert.equal(fetchDecision(member(), 'research', 'https://example.com/?d=1'), null);
  assert.equal(fetchDecision(member('workspace-write'), 'main', 'https://example.com/?d=1'), 'ask');
});

test('bash leaves the sandbox only while the mode is on, and the prompt says so', async () => {
  const owner = member(), calls = [];
  const [bash] = unsandboxedBash(owner, [{ name: 'bash', execute: async () => { calls.push('sandbox'); return {}; } }]);
  const result = await bash.execute('id', { command: 'echo "$HOME"' });
  assert.equal(result.content[0].text, os.homedir(), 'the member\'s own home'); assert.deepEqual(calls, []);
  owner.permission = 'workspace-write'; await bash.execute('id', { command: 'echo' });
  assert.deepEqual(calls, ['sandbox']);
  owner.permission = 'always-bypass';
  await assert.rejects(bash.execute('id', { command: 'git commit -m x' }, undefined, undefined, { ui: { confirm: async () => false } }));
  assert.match(servicesPrompt({ unsandboxed: () => true }), /no sandbox and only committing and pushing code and removing a critical path are asked/);
  assert.doesNotMatch(servicesPrompt({ engine: {}, unsandboxed: () => false }), /no sandbox/);
});

test('an rm on a critical path is asked, by Claude\'s list; other removals run', () => {
  const where = { cwd: '/Users/me/work/app', home: '/Users/me' }, flagged = command => criticalRemovalReason(command, where);
  for (const command of ['rm -rf /', 'rm -rf /usr', 'rm /etc', 'rmdir /data', 'rm -rf ~', 'rm -rf $HOME', 'rm -rf /Users/me', 'rm -rf ~/*', 'rm -rf .', 'rm -rf ./*', 'rm -rf *', 'rm -rf ..', 'rm -rf /Users/me/work',
    'rm -rf /Users/me/work/app', 'rm -rf "$DIR"/*', 'rm -rf "$1"/*', 'rm -rf "$TMPDIR/mnt"', 'D=$(pwd); rm -rf "$D"', 'rm -rf "$(pwd)"', 'rm -rf ~/$(cmd)', 'rm -rf "\\\\"', 'rm -rf logs/*/*', 'rm -rf logs/*/', 'cd logs && rm -rf a/*',
    '(rm -rf ~)', '{ rm -rf ~; }', 'echo "$(rm -rf ~)"', "bash -c 'rm -rf ~'", 'sudo rm -rf /usr', 'timeout 5 rm -rf ~', '/bin/rm -rf ~', 'rm -rf {/,}', 'cd / && rm -rf usr', 'rm -rf /Volumes/USB', 'rm -rf /mnt/data', 'rm /Volumes/USB/build/*', 'rm -rf /mnt'])
    assert.ok(flagged(command), command);
  for (const command of ['rm -rf build', 'rm -rf build/*', 'rm -rf node_modules dist', 'rm file.txt', 'rm -rf ~/.cache/x', 'rm -rf /tmp/x', 'rm -rf "${DIR:?}"/*', 'rm -rf "$DIR"', 'rm /Volumes/USB/file', "sh -c 'rm -rf \"$1\"/*' _ x", 'git rm -r src', 'npm run rm', 'echo rm -rf /'])
    assert.equal(flagged(command), null, command);
  assert.match(flagged('rm -rf "unclosed'), /not ruled out/);
  assert.equal(flagged('echo "unclosed'), null);
  assert.match(criticalRemovalReason('rm -rf build', { cwd: '/Volumes/USB', home: '/Users/me' }), /mounted drive/);
});

test('three unanswered removals are denied at once until the member sends a message', () => {
  const entries = [], manager = { getEntries: () => entries };
  for (let index = 0; index < 3; index += 1) { assert.equal(removalsHeld('s', manager), false); noteRemovalExpired('s', manager); }
  assert.equal(removalsHeld('s', manager), true);
  entries.push({ type: 'message', message: { role: 'user' } });
  assert.equal(removalsHeld('s', manager), false);
});

test('a removal asked and declined does not run; the project\'s autoDeny holds in a company session', async () => {
  const owner = member(), bash = commandTools(owner).find(tool => tool.name === 'run_on_host');
  const project = fs.mkdtempSync(path.join(base, 'deny-'));
  owner.cwd = project;
  await assert.rejects(bash.execute('id', { command: 'rm -rf .', reason: 'test' }, undefined, undefined, { ui: { confirm: async () => false } }));
  assert.equal(fs.existsSync(project), true);
  fs.mkdirSync(path.join(project, '.pi')); fs.writeFileSync(path.join(project, '.pi', 'piagent-profile.json'), JSON.stringify({ autoDeny: [{ pattern: 'terraform destroy', reason: 'no' }] }));
  assert.match(projectDenyReason('terraform destroy -auto-approve', project), /no$/);
  await assert.rejects(bash.execute('id', { command: 'terraform destroy', reason: 'test' }, undefined, undefined, {}), /managed-project-refused/);
  assert.equal((await bash.execute('id', { command: 'rm -rf build; echo ok', reason: 'test' }, undefined, undefined, {})).content[0].text, 'ok');
});

test('an MCP write is not asked', async () => {
  let handler; const pi = { on: (name, run) => { if (name === 'tool_call') handler = run; }, getAllTools: () => [] };
  memberMcpGuard(base, base, member())(pi);
  assert.equal(await handler({ toolName: 'mcp', toolCallId: 'id', input: { server: 'github', tool: 'create_pull_request' } }, {}), undefined);
});

const sdkRoot = process.env.PI_MANAGED_TEST_SDK;
test('the file tools reach outside the project only while the mode is on', { skip: !sdkRoot }, async () => {
  const project = fs.mkdtempSync(path.join(base, 'project-')), outside = path.join(fs.mkdtempSync(path.join(base, 'outside-')), 'note.txt');
  let on = false;
  const boundary = new ManagedToolBoundary({ cwd: project, sdkRoot, protectedRoots: [], proxyPorts: [] }); boundary.unsandboxed = () => on;
  try {
    await assert.rejects(boundary.invoke('write', { path: outside, content: 'x' }));
    assert.equal(fs.existsSync(outside), false);
    on = true;
    await boundary.invoke('write', { path: outside, content: 'x' });
    assert.equal(fs.readFileSync(outside, 'utf8'), 'x');
  } finally { await boundary.dispose(); }
});
