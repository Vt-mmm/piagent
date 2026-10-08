import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { doctorReport, runDoctor } from '../packages/piagent-core/managed/doctor.mjs';

// `piagent studio --doctor` answers "will daily coding work on this machine?"
// with the real sandbox and no model request.
const sdkRoot = process.env.PI_MANAGED_TEST_SDK ?? path.join(os.homedir(), '.pi/npm-global/lib/node_modules/@earendil-works/pi-coding-agent');
const manifest = (main) => ({ schema_version: 2, credential_mode: 'managed', key_label: 'Fixture key', key_id: randomUUID(), thinking_levels: ['low', 'medium', 'high'],
  models: [{ id: 'gpt-6-sol', owned_by: 'codex', provider_model_id: 'gpt-6-sol' }, { id: 'brand-new', owned_by: 'codex', provider_model_id: 'gpt-99-unknown' }],
  harness: { configuration: { main: { model_ids: [main] }, research: { model_ids: ['gpt-6-sol'] } } } });
const brokerFor = (value, calls = []) => ({ calls, async request(action) { calls.push(action); if (action !== 'config') throw Error('the doctor must not start a run'); if (value instanceof Error) throw value; return value; } });

test('the doctor passes on a working machine and sends no model request', { skip: process.platform !== 'darwin' || !fs.existsSync(sdkRoot), timeout: 360000 }, async () => {
  const broker = brokerFor(manifest('gpt-6-sol'));
  const results = await runDoctor({ sdkRoot, origin: 'http://127.0.0.1:9', broker, network: false });
  const report = doctorReport(results);
  assert.equal(report.ok, true, report.text);
  assert.deepEqual(results.filter(result => result.required && !result.ok), []);
  for (const label of ['sandbox starts and runs a command', 'write, read, edit, list, find, search a file', 'folders outside the project are read-only',
    'commands have no network unless approved', 'git', 'node', 'this Piagent knows every harness model']) assert.equal(results.find(result => result.label === label)?.ok, true, label);
  assert.deepEqual(broker.calls, ['config']);
  assert.match(report.text, /Ready for company sessions.*No model request was sent\.$/);
  assert.equal(results.some(result => /web_fetch|Studio is reachable/.test(result.label)), false, 'nothing leaves the machine when asked not to');
});

test('the doctor names what blocks company sessions', { skip: process.platform !== 'darwin' || !fs.existsSync(sdkRoot), timeout: 360000 }, async () => {
  const unknown = doctorReport(await runDoctor({ sdkRoot, origin: 'http://127.0.0.1:9', broker: brokerFor(manifest('brand-new')), network: false }));
  assert.equal(unknown.ok, false);
  assert.match(unknown.text, / FAIL this Piagent knows every harness model — main: unknown to this Piagent; update Piagent/);
  const locked = doctorReport(await runDoctor({ sdkRoot, origin: 'http://127.0.0.1:9', broker: brokerFor(Error('managed-broker:keychainApprovalRequired')), network: false }));
  assert.match(locked.text, / FAIL Agent Watch answers with the company key — managed-broker:keychainApprovalRequired/);
  assert.match(locked.text, /Not ready: 1 required check\(s\) failed\.$/);
  // Optional tools never fail the machine.
  assert.equal(doctorReport([{ label: 'python3', required: false, ok: false, detail: 'not found' }]).ok, true);
});
