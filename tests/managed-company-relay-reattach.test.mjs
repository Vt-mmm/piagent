import assert from 'node:assert/strict';
import {test} from 'node:test';
import '../scripts/register-typescript-loader.mjs';
import {CompanyRelay} from '../packages/piagent-webui/gateway/company-relay.ts';

// Found live: the dashboard started before Agent Watch re-imported after an
// update, the company start failed with managed-launch-binding-changed, and
// company sessions stayed hidden (with that stale advice) although Watch had
// re-imported and the company runtime was running. Reads now re-attach.
test('after a failed start, dashboard reads re-attach to the company runtime without launching it', async () => {
  const calls = {ensure: 0, attach: 0}, published = [];
  const relay = new CompanyRelay({
    connector: {configured: () => true,
      ensure: async () => { calls.ensure += 1; throw new Error('managed-launch-binding-changed'); },
      attach: async () => { calls.attach += 1; return null; }},
    events: {publish: (kind, payload) => published.push({kind, payload})},
    hubProject: (cwd) => cwd, folder: async () => null,
  });
  try {
    relay.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(relay.status().reasonCode, 'managed-launch-binding-changed');
    assert.equal(await relay.catalog(), null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(calls, {ensure: 1, attach: 1}, 'a read attaches; it never launches (no Keychain prompt)');
    assert.equal(relay.status().reasonCode, 'company-gateway-stopped', 'the stale re-import advice is dropped');
    await relay.catalog(); await relay.models();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls.attach, 1, 'reads attach at most every 10 s');
    assert.ok(published.some((event) => event.kind === 'catalog.changed'));
  } finally { relay.close(); }
});
