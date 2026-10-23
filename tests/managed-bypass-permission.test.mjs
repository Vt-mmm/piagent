import test from 'node:test';
import assert from 'node:assert/strict';
import { bypassAllowed, effectivePermission, networkConfirmation, permissionSetter, recordBypass, restorePermission } from '../packages/piagent-core/managed/permission.mjs';
import { managedProjection } from '../packages/piagent-webui/gateway/managed-projection.ts';
const projectManagedSessionOptions = entries => managedProjection({ model: { provider: 'agent_watch_managed' } }, entries);

const manager = () => { const entries = []; return { entries, getEntries: () => entries, appendCustomEntry: (customType, data) => entries.push({ type: 'custom', customType, data }) }; };
const harness = bypass => ({ harness: { configuration: bypass === undefined ? {} : { bypass_mode: bypass } } });

test('company Bypass needs an explicit yes from the Harness', () => {
  assert.equal(bypassAllowed(harness(true)), true);
  assert.equal(bypassAllowed(harness(false)), false);
  assert.equal(bypassAllowed(harness(undefined)), false, 'an Agent Watch that drops the field gives no bypass');
  const owner = { manifest: harness(false), permission: 'workspace-write' }, log = manager();
  assert.throws(() => permissionSetter(owner, log)('bypass'), /managed-bypass-unavailable/);
  owner.manifest = harness(true); permissionSetter(owner, log)('bypass');
  assert.equal(owner.permission, 'bypass'); assert.equal(restorePermission(log), 'bypass');
});

test('Bypass asks nothing; switched off by the administrator it falls back to Full access', async () => {
  const owner = { manifest: harness(true), permission: 'bypass' };
  for (const command of ['git push origin main', 'npx prisma migrate deploy', 'curl -X POST https://example.com', 'sudo ls'])
    assert.equal(await networkConfirmation(owner, command), null, command);
  owner.manifest = harness(false);
  assert.equal(effectivePermission(owner), 'trusted-full-access');
  assert.notEqual(await networkConfirmation(owner, 'git push origin main'), null, 'Full access still asks before a push');
  assert.equal(await networkConfirmation({ manifest: harness(true), permission: 'workspace-write' }, 'npm install'), 'ask');
});

test('the dashboard sees Bypass only while the Harness allows it', () => {
  const owner = { manifest: harness(true), permission: 'bypass' }, log = manager();
  recordBypass(owner, log); log.appendCustomEntry('agent-watch-permission', { mode: 'bypass' });
  let row = projectManagedSessionOptions(log.entries);
  assert.equal(row.managedPermission, 'bypass'); assert.equal(row.managedBypass, true);
  owner.manifest = harness(false); recordBypass(owner, log);
  row = projectManagedSessionOptions(log.entries);
  assert.equal(row.managedPermission, 'trusted-full-access'); assert.equal(row.managedBypass, undefined);
});
