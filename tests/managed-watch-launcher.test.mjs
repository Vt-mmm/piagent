import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {chromium, expect} from '@playwright/test';
import '../scripts/register-typescript-loader.mjs';
import {requestGatewayControl} from '../packages/piagent-webui/gateway/control-socket.ts';
import {gatewayProfileState} from '../packages/piagent-webui/ownership/profile-state.ts';
import {ensureWebUiBuild} from './helpers/piagent-webui-build.mjs';

// Agent Watch's "Mở Piagent → WebUI" runs `piagent-studio.mjs --web`. The
// dashboard usually already runs this key's company Gateway (`--serve`); the
// button used to fail with managed-launch-failed. It now opens a browser
// session on the running Gateway for the chosen project.
const root = path.resolve(import.meta.dirname, '..');
const sdkRoot = process.env.PI_MANAGED_TEST_SDK ?? path.join(os.homedir(), '.pi/npm-global/lib/node_modules/@earendil-works/pi-coding-agent');
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const studioScript = fs.realpathSync(path.join(root, 'scripts/piagent-studio.mjs'));

function launch(home, args) {
  const child = spawn(process.execPath, [studioScript, ...args], {env: {HOME: home, PATH: '/usr/bin:/bin'}, stdio: ['ignore', 'pipe', 'pipe']});
  const out = {stdout: '', stderr: ''};
  child.stdout.on('data', (d) => { out.stdout += d; }); child.stderr.on('data', (d) => { out.stderr += d; });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  return {child, out, exited};
}
async function until(check, ms, what) {
  for (const started = Date.now(); !(await check());) {
    if (Date.now() - started > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

test('Watch WebUI button opens on the company Gateway the dashboard already runs', {skip: process.platform !== 'darwin' || !fs.existsSync(sdkRoot), timeout: 120000}, async () => {
  ensureWebUiBuild(root);
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'watch-launcher-')));
  const project = path.join(home, 'Dự án web'); fs.mkdirSync(project);
  const agent = path.join(home, '.pi/agent'); fs.mkdirSync(agent, {recursive: true});
  const authority = {studio_instance_id: randomUUID(), dataset_epoch: randomUUID(), auth_generation: 1}, roleID = randomUUID();
  const manifest = {schema_version: 2, credential_mode: 'managed', thinking_levels: ['low', 'medium', 'high'], authority, key_id: randomUUID(),
    models: [{id: 'gpt-6-sol', owned_by: 'codex', provider_model_id: 'gpt-6-sol'}], harness: {configuration: {main: {model_ids: ['gpt-6-sol']}}}};
  const grant = {...authority, run_id: randomUUID(), role_id: roleID, role: 'main', fence: 1, token: `as_run_${roleID}_${'x'.repeat(43)}`,
    model_id: 'gpt-6-sol', provider_model_id: 'gpt-6-sol', provider: 'codex', effort: 'medium'};
  const broker = path.join(home, 'broker');
  fs.writeFileSync(broker, `#!${process.execPath}\nimport readline from 'node:readline';const manifest=${JSON.stringify(manifest)},grant=${JSON.stringify(grant)};for await(const line of readline.createInterface({input:process.stdin})){const q=JSON.parse(line);process.stdout.write(JSON.stringify({id:q.id,result:q.action==='config'?manifest:q.action==='close'?true:grant})+'\\n');}`, {mode: 0o700});
  const profile = 'a'.repeat(64), node = fs.realpathSync(process.execPath);
  const binding = path.join(agent, 'agent-watch-managed.json');
  fs.writeFileSync(binding, JSON.stringify({schema_version: 1, model: 'agent-watch-auto', profile_id: profile, origin: 'http://127.0.0.1:9',
    node, entrypoint: studioScript, node_sha256: sha(node), entrypoint_sha256: sha(studioScript), sdk_root: sdkRoot, broker, broker_sha256: sha(broker)}));
  const control = gatewayProfileState(path.join(home, 'Library/Application Support/AgentWatch/ManagedSessions', profile)).controlSocket;
  // The dashboard's company Gateway.
  const serve = launch(home, ['--config', binding, '--serve']);
  try {
    await until(() => serve.out.stdout.includes('Agent Watch Auto: ready'), 60000, `serve ready: ${serve.out.stderr.slice(-500)}`);
    // Watch's WebUI button for a project.
    const web = launch(home, ['--config', binding, '--project', project, '--web', '--no-open']);
    const code = await web.exited;
    assert.equal(code, 0, web.out.stderr);
    assert.match(web.out.stdout, /^Agent Watch Auto: http:\/\/127\.0\.0\.1:\d+\//m);
    assert.match(web.out.stdout, /opened in the running company session service/);
    assert.doesNotMatch(web.out.stderr, /ExperimentalWarning|managed-launch-failed/);
    // The page opens a new conversation for the chosen project.
    const launchUrl = web.out.stdout.match(/^Agent Watch Auto: (http\S+)$/m)[1];
    assert.match(launchUrl, /#bootstrap=[^&]+&project=/);
    const browser = await chromium.launch({headless: true});
    try {
      const page = await browser.newPage({locale: 'vi-VN'});
      await page.goto(launchUrl);
      await expect(page.getByRole('heading', {name: /Hôm nay làm gì|What should we work on/})).toBeVisible({timeout: 15000});
      await expect(page.getByRole('button', {name: /^Project/})).toContainText('Dự án web');
    } finally { await browser.close(); }
    const paths = await requestGatewayControl(control, {action: 'project.paths'});
    assert.equal(paths.ok, true);
    assert.ok(JSON.stringify(paths.value).includes(JSON.stringify(fs.realpathSync(project)).slice(1, -1)), 'the project is listed in the running Gateway');
  } finally {
    try { await requestGatewayControl(control, {action: 'stop'}); } catch {}
    await Promise.race([serve.exited, new Promise((resolve) => setTimeout(resolve, 10000))]);
    serve.child.kill('SIGKILL');
    fs.rmSync(home, {recursive: true, force: true});
  }
});
