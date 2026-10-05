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

// The Gateway goes down while the main agent waits for the member's answer.
// After it comes back the conversation goes on with one click: the question
// that was never answered reaches the model as having no result, the agent
// asks again, and the member's answer reaches it.
const R = path.resolve(import.meta.dirname, '..');
const sdkRoot = process.env.PI_MANAGED_TEST_SDK ?? path.join(os.homedir(), '.pi/npm-global/lib/node_modules/@earendil-works/pi-coding-agent');
const sha = f => createHash('sha256').update(fs.readFileSync(f)).digest('hex'), studioScript = fs.realpathSync(path.join(R, 'scripts/piagent-studio.mjs'));
const QUESTIONS = [{ header: 'Phạm vi', question: 'Sửa cả màn hình admin không?', options: [{ label: 'Chỉ trang khách' }, { label: 'Cả admin' }] }];

test('a question left waiting when the Gateway goes down is asked again after one click on continue', { skip: process.platform !== 'darwin' || !fs.existsSync(sdkRoot), timeout: 180000 }, async () => {
  ensureWebUiBuild(R);
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'question-crash-'))), project = path.join(home, 'project'); fs.mkdirSync(project);
  const agent = path.join(home, '.pi/agent'); fs.mkdirSync(agent, { recursive: true });
  let requests = 0; const sent = [];
  // Studio: the first two requests (the first turn, then its continuation)
  // ask the member; once an answer is in the conversation the model goes on.
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c); const body = JSON.parse(Buffer.concat(chunks)); requests++; sent.push(JSON.stringify(body.input));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = e => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    const response = { id: 'resp_' + requests, object: 'response', status: 'in_progress', model: body.model, output: [] };
    emit({ type: 'response.created', response });
    if (!sent.at(-1).includes('The member answered')) {
      const args = JSON.stringify({ questions: QUESTIONS }), item = { id: 'fc_' + requests, type: 'function_call', call_id: 'call_' + requests, name: 'ask_user', arguments: '', status: 'in_progress' };
      emit({ type: 'response.output_item.added', output_index: 0, item });
      emit({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: args });
      emit({ type: 'response.output_item.done', output_index: 0, item: { ...item, arguments: args, status: 'completed' } });
      emit({ type: 'response.completed', response: { ...response, status: 'completed', output: [{ ...item, arguments: args, status: 'completed' }], usage: { input_tokens: 12, output_tokens: 9, total_tokens: 21 } } }); res.end(); return;
    }
    const item = { id: 'msg_' + requests, type: 'message', role: 'assistant', status: 'in_progress', content: [] };
    emit({ type: 'response.output_item.added', output_index: 0, item });
    emit({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    emit({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'ASKED_AGAIN_OK' });
    emit({ type: 'response.output_item.done', output_index: 0, item: { ...item, status: 'completed', content: [{ type: 'output_text', text: 'ASKED_AGAIN_OK', annotations: [] }] } });
    emit({ type: 'response.completed', response: { ...response, status: 'completed', usage: { input_tokens: 30, output_tokens: 3, total_tokens: 33 } } }); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const authority = { studio_instance_id: randomUUID(), dataset_epoch: randomUUID(), auth_generation: 1 }, roleID = randomUUID();
  const manifest = { schema_version: 2, credential_mode: 'managed', thinking_levels: ['low', 'medium', 'high'], authority, key_id: randomUUID(), user: { id: 'member-1' },
    models: [{ id: 'gpt-6-sol', owned_by: 'codex', provider_model_id: 'gpt-6-sol' }], harness: { configuration: { main: { model_ids: ['gpt-6-sol'] } } } };
  const grant = { ...authority, run_id: randomUUID(), role_id: roleID, role: 'main', token: `as_run_${roleID}_${'x'.repeat(43)}`, model_id: 'gpt-6-sol', provider_model_id: 'gpt-6-sol', provider: 'codex', effort: 'medium' };
  const broker = path.join(home, 'broker');
  fs.writeFileSync(broker, `#!${process.execPath}\nimport readline from 'node:readline';let fence=Date.now()%100000;const manifest=${JSON.stringify(manifest)},grant=${JSON.stringify(grant)};for await(const line of readline.createInterface({input:process.stdin})){const q=JSON.parse(line);process.stdout.write(JSON.stringify({id:q.id,result:q.action==='config'?manifest:q.action==='close'?true:{...grant,fence:++fence}})+'\\n');}`, { mode: 0o700 });
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
    await page.getByPlaceholder('Nhắn cho Piagent…').fill('Đổi màu nút thanh toán'); await page.getByRole('button', { name: 'Gửi', exact: true }).click();
    await expect(page.locator('.question-card').getByText('Sửa cả màn hình admin không?')).toBeVisible({ timeout: 30000 });
    // The Gateway dies while the question waits.
    serve.child.kill('SIGKILL'); await serve.exited; await page.close();
    serve = launch(['--config', binding, '--serve']);
    await until(() => serve.out.stdout.includes('ready'), 60000, 'second Gateway ' + serve.out.stderr.slice(-300));
    page = await browser.newPage({ locale: 'vi-VN', viewport: { width: 1280, height: 900 } }); await page.goto(await url());
    const row = page.locator('div:has(> button[aria-label="Tùy chọn cuộc trò chuyện"])').filter({ hasText: 'Đổi màu nút thanh toán' });
    await expect(row).toHaveCount(1, { timeout: 20000 });
    await row.locator('[role="button"]').first().click();
    // No card for a question no one can answer any more; the turn goes on.
    await expect(page.getByText(/Lượt này chưa có câu trả lời/)).toBeVisible({ timeout: 20000 });
    await expect(page.locator('.question-card')).toHaveCount(0);
    await page.getByRole('button', { name: 'Tiếp tục', exact: true }).click();
    // The model learns the question had no answer, and asks again.
    await expect(page.locator('.question-card').getByText('Sửa cả màn hình admin không?')).toBeVisible({ timeout: 30000 });
    assert.equal(requests, 2);
    assert.match(sent[1], /"call_id":"call_1"/, 'the unanswered call is closed for the model');
    assert.match(sent[1], /tiếp tục/);
    await page.locator('.question-card').focus(); await page.keyboard.press('2'); await page.keyboard.press('Enter');
    await expect(page.getByText('ASKED_AGAIN_OK', { exact: true }).first()).toBeVisible({ timeout: 30000 });
    assert.equal(requests, 3);
    assert.match(sent[2], /The member answered:[\s\S]*→ 2\. Cả admin/);
  } finally { await browser.close(); serve.child.kill('SIGTERM'); server.closeAllConnections?.(); await new Promise(r => server.close(r)); fs.rmSync(home, { recursive: true, force: true }); }
});
