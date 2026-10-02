import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { chromium, expect } from '@playwright/test';
import { ensureWebUiBuild } from './helpers/piagent-webui-build.mjs';

// A member's machine goes down (or the Gateway is killed) while a task runs.
// After it comes back the conversation must be there, say that the turn has
// no answer, and go on with one click, from the steps already taken.
const R = path.resolve(import.meta.dirname, '..');
const sdkRoot = process.env.PI_MANAGED_TEST_SDK ?? path.join(os.homedir(), '.pi/npm-global/lib/node_modules/@earendil-works/pi-coding-agent');
const sha = f => createHash('sha256').update(fs.readFileSync(f)).digest('hex'), studioScript = fs.realpathSync(path.join(R, 'scripts/piagent-studio.mjs'));

test('a conversation interrupted by a crash is listed again and continues with one click', { skip: process.platform !== 'darwin' || !fs.existsSync(sdkRoot), timeout: 180000 }, async () => {
  ensureWebUiBuild(R);
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crash-probe-'))), project = path.join(home, 'project'); fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'notes.txt'), 'FIXTURE_NOTE\n');
  const agent = path.join(home, '.pi/agent'); fs.mkdirSync(agent, { recursive: true });
  let hold = true, requests = 0; const sent = [];
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c); const body = JSON.parse(Buffer.concat(chunks)); requests++; sent.push(JSON.stringify(body.input));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = e => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    const response = { id: 'resp_' + requests, object: 'response', status: 'in_progress', model: body.model, output: [] };
    if (requests === 1) { // a tool step first
      const args = JSON.stringify({ path: 'notes.txt' }), item = { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'read', arguments: '', status: 'in_progress' };
      emit({ type: 'response.created', response }); emit({ type: 'response.output_item.added', output_index: 0, item });
      emit({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: args });
      emit({ type: 'response.output_item.done', output_index: 0, item: { ...item, arguments: args, status: 'completed' } });
      emit({ type: 'response.completed', response: { ...response, status: 'completed', output: [{ ...item, arguments: args, status: 'completed' }], usage: { input_tokens: 12, output_tokens: 9, total_tokens: 21 } } }); res.end(); return;
    }
    if (hold) { emit({ type: 'response.created', response }); return; } // never finishes: the machine "goes down" here
    const item = { id: 'msg_' + requests, type: 'message', role: 'assistant', status: 'in_progress', content: [] };
    emit({ type: 'response.created', response }); emit({ type: 'response.output_item.added', output_index: 0, item });
    emit({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    emit({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'RESUMED_OK' });
    emit({ type: 'response.output_item.done', output_index: 0, item: { ...item, status: 'completed', content: [{ type: 'output_text', text: 'RESUMED_OK', annotations: [] }] } });
    emit({ type: 'response.completed', response: { ...response, status: 'completed', usage: { input_tokens: 30, output_tokens: 3, total_tokens: 33 } } }); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const authority = { studio_instance_id: randomUUID(), dataset_epoch: randomUUID(), auth_generation: 1 }, roleID = randomUUID();
  const manifest = { schema_version: 2, credential_mode: 'managed', thinking_levels: ['low', 'medium', 'high'], authority, key_id: randomUUID(), user: { id: 'member-1' },
    models: [{ id: 'gpt-6-sol', owned_by: 'codex', provider_model_id: 'gpt-6-sol' }], harness: { configuration: { main: { model_ids: ['gpt-6-sol'] } } } };
  const grant = { ...authority, run_id: randomUUID(), role_id: roleID, role: 'main', token: `as_run_${roleID}_${'x'.repeat(43)}`, model_id: 'gpt-6-sol', provider_model_id: 'gpt-6-sol', provider: 'codex', effort: 'medium' };
  const broker = path.join(home, 'broker'), log = path.join(home, 'broker.log');
  fs.writeFileSync(broker, `#!${process.execPath}\nimport readline from 'node:readline';import fs from 'node:fs';let fence=Date.now()%100000;const manifest=${JSON.stringify(manifest)},grant=${JSON.stringify(grant)};for await(const line of readline.createInterface({input:process.stdin})){const q=JSON.parse(line);fs.appendFileSync(${JSON.stringify(log)},q.action+'\\n');process.stdout.write(JSON.stringify({id:q.id,result:q.action==='config'?manifest:q.action==='close'?true:{...grant,fence:++fence}})+'\\n');}`, { mode: 0o700 });
  const node = fs.realpathSync(process.execPath), binding = path.join(agent, 'agent-watch-managed.json');
  fs.writeFileSync(binding, JSON.stringify({ schema_version: 1, model: 'agent-watch-auto', profile_id: 'a'.repeat(64), origin: `http://127.0.0.1:${server.address().port}`, node, entrypoint: studioScript, node_sha256: sha(node), entrypoint_sha256: sha(studioScript), sdk_root: sdkRoot, broker, broker_sha256: sha(broker) }));
  function launch(args) { const child = spawn(process.execPath, [studioScript, ...args], { env: { HOME: home, PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] }); const out = { stdout: '', stderr: '' }; child.stdout.on('data', d => out.stdout += d); child.stderr.on('data', d => out.stderr += d); return { child, out, exited: new Promise(r => child.once('exit', r)) }; }
  const until = async (check, ms, what) => { for (const t = Date.now(); !(await check());) { if (Date.now() - t > ms) throw Error('timeout: ' + what); await new Promise(r => setTimeout(r, 200)); } };
  const url = async () => { const web = launch(['--config', binding, '--project', project, '--web', '--no-open']); await web.exited; return web.out.stdout.match(/Agent Watch Auto: (http\S+)/)[1]; };
  const browser = await chromium.launch({ headless: true });
  let serve = launch(['--config', binding, '--serve']);
  try {
    await until(() => serve.out.stdout.includes('ready'), 60000, 'first Gateway ' + serve.out.stderr.slice(-300));
    let page = await browser.newPage({ locale: 'vi-VN', viewport: { width: 1280, height: 900 } }); await page.goto(await url());
    await expect(page.getByRole('heading', { name: 'Hôm nay làm gì?' })).toBeVisible({ timeout: 30000 });
    await page.getByPlaceholder('Nhắn cho Piagent…').fill('Read notes.txt and summarise it'); await page.getByRole('button', { name: 'Gửi', exact: true }).click();
    // One tool step is done and stored; the next request is in flight when the process dies.
    await until(() => requests >= 2, 30000, 'the request after the tool step');
    await new Promise(r => setTimeout(r, 1000));
    serve.child.kill('SIGKILL'); await serve.exited; await page.close();
    hold = false; fs.writeFileSync(log, '');
    serve = launch(['--config', binding, '--serve']);
    await until(() => serve.out.stdout.includes('ready'), 60000, 'second Gateway ' + serve.out.stderr.slice(-300));
    page = await browser.newPage({ locale: 'vi-VN', viewport: { width: 1280, height: 900 } }); await page.goto(await url());
    const row = page.locator('div:has(> button[aria-label="Tùy chọn cuộc trò chuyện"])').filter({ hasText: 'Read notes.txt and summarise it' });
    await expect(row).toHaveCount(1, { timeout: 20000 });
    await expect(row).not.toContainText(/Cần duyệt|Cần khôi phục/);
    await row.locator('[role="button"]').first().click();
    // The step taken before the crash is there; the turn says it has no answer; the composer is usable.
    await expect(page.getByText('notes.txt').first()).toBeVisible({ timeout: 20000 });
    await expect(page.getByText(/Lượt này chưa có câu trả lời/)).toBeVisible();
    await expect(page.getByText('Session hiện chỉ đọc')).toHaveCount(0);
    await expect(page.getByPlaceholder('Nhắn cho Piagent…').last()).toBeEnabled();
    await page.getByRole('button', { name: 'Tiếp tục', exact: true }).click();
    await expect(page.getByText('RESUMED_OK', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    await expect(page.getByText(/Lượt này chưa có câu trả lời/)).toHaveCount(0);
    assert.equal(requests, 3, 'the continuation is one new request, nothing is replayed');
    assert.match(sent.at(-1), /FIXTURE_NOTE[\s\S]*tiếp tục/, 'the model gets the tool result from before the crash, then the new message');
    // The run that was open is recovered (or left behind) by the broker; no second run is started blindly.
    assert.match(fs.readFileSync(log, 'utf8'), /recover/);
  } finally { await browser.close(); serve.child.kill('SIGTERM'); server.closeAllConnections?.(); await new Promise(r => server.close(r)); fs.rmSync(home, { recursive: true, force: true }); }
});
