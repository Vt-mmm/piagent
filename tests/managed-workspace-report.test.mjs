import test from 'node:test';
import assert from 'node:assert/strict';
import { PROJECT_ENTRY, recordProjectWarnings, reportWorkspace } from '../packages/piagent-core/managed/workspace-report.mjs';
import { managedProjection } from '../packages/piagent-webui/gateway/managed-projection.ts';
import { projectWarningText } from '../packages/piagent-webui/shared/project-warning-copy.ts';

const manager = () => { const entries = []; return { entries, getEntries: () => entries, appendCustomEntry: (customType, data) => entries.push({ type: 'custom', customType, data }) }; };
const owner = (log = manager()) => ({ cwd: '/work/shop', origin: 'https://studio.example', session: { sessionManager: log }, capabilities: new Set(['managed.workspace.v1']), notified: [], notify(event) { this.notified.push(event); } });
const reply = (status, body = null) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const found = (keys, folder = null) => async () => ({ repos: keys.map(key => ({ key })), folder });

test('a conversation tells Studio its repositories once, with the run token, and keeps the warning for the member', async () => {
  const calls = [], self = owner();
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return reply(200, { team: 'Payments', warnings: [
    { repo_key: 'github.com/acme/shop', kind: 'other_team' }, { repo_key: 'github.com/acme/new', kind: 'unregistered' }] }); };
  await reportWorkspace(self, 'tok', { fetchImpl, find: found(['github.com/acme/shop', 'github.com/acme/new']), now: () => 0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://studio.example/studio/v1/managed/workspace');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(calls[0].init.body), { repositories: ['github.com/acme/shop', 'github.com/acme/new'] });
  const recorded = self.session.sessionManager.entries.filter(e => e.customType === PROJECT_ENTRY);
  assert.deepEqual(recorded.map(e => e.data.warnings), [[{ repo: 'github.com/acme/shop', kind: 'other_team' }]], 'only the warnings a member acts on');
  assert.equal(recorded[0].data.team, 'Payments');
  assert.deepEqual(self.notified.map(e => e.type), ['managed_project_warning']);
  assert.equal(await reportWorkspace(self, 'tok', { fetchImpl, find: found(['github.com/acme/shop']) }), null, 'asked once per conversation');
  assert.equal(calls.length, 1);
});

test('a folder without a repository sends its reason; Studio without the route is not asked again; passing failures retry three times', async () => {
  let body = null;
  const noRepo = owner();
  await reportWorkspace(noRepo, 'tok', { fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return reply(200, { warnings: [] }); }, find: found([], 'no_origin') });
  assert.deepEqual(body, { repositories: [], folder: 'no_origin' });
  assert.equal(noRepo.session.sessionManager.entries.length, 0, 'nothing to show, nothing recorded');
  let asked = 0;
  const old = owner();
  await reportWorkspace(old, 'tok', { fetchImpl: async () => { asked += 1; return reply(404); }, find: found(['github.com/acme/shop']) });
  assert.equal(await reportWorkspace(old, 'tok', { fetchImpl: async () => { asked += 1; return reply(404); }, find: found(['github.com/acme/shop']) }), null);
  assert.equal(asked, 1);
  asked = 0;
  const flaky = owner();
  for (let i = 0; i < 5; i += 1) await reportWorkspace(flaky, 'tok', { fetchImpl: async () => { asked += 1; return reply(503); }, find: found(['github.com/acme/shop']) });
  assert.equal(asked, 3);
  assert.equal(await reportWorkspace(owner(), null, { fetchImpl: async () => assert.fail('no token, no request'), find: found([]) }), null);
  const older = { ...owner(), capabilities: new Set(['managed.settle.v1']) };
  assert.equal(await reportWorkspace(older, 'tok', { fetchImpl: async () => assert.fail('a Studio without the route is not asked'), find: found([]) }), null);
});

test('the dashboard reads the latest warning, and a clean report clears it', () => {
  const log = manager(), context = { model: { provider: 'agent_watch_managed' } };
  recordProjectWarnings(log, [{ repo: 'github.com/acme/shop', kind: 'unlisted' }], 'Payments', () => 0);
  recordProjectWarnings(log, [{ repo: 'github.com/acme/shop', kind: 'unlisted' }], 'Payments', () => 1);
  assert.equal(log.entries.length, 1, 'the same warning is kept once');
  assert.deepEqual(managedProjection(context, log.entries).managedProjectWarning, { warnings: [{ repo: 'github.com/acme/shop', kind: 'unlisted' }], team: 'Payments' });
  recordProjectWarnings(log, [], 'Payments', () => 2);
  assert.equal(managedProjection(context, log.entries).managedProjectWarning, undefined);
  assert.equal(managedProjection({ model: { provider: 'openai' } }, log.entries).managedProjectWarning, undefined);
});

test('the member line names the repository and says administrators were told', () => {
  assert.match(projectWarningText([{ repo: 'github.com/acme/shop', kind: 'other_team' }], 'Payments', 'vi'), /github\.com\/acme\/shop thuộc team khác.*Payments.*Admin Studio đã được báo/);
  assert.match(projectWarningText([{ repo: 'github.com/acme/new', kind: 'unlisted' }], null, 'en'), /not in the repository list.*administrators were told/);
});
