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
import { piSdkRoot } from './helpers/pi-sdk.mjs';

// A member leaves a task running; Studio is updated while the agent's next
// request is in flight. The request is cut, Studio does not answer for a few
// seconds, then answers again as a new version. The task goes on by itself
// (no click), the agent is told why, the wait is in the member's local log,
// and Studio receives a report it can filter by cause.
const R = path.resolve(import.meta.dirname, '..');
const sdkRoot = piSdkRoot();
const sha = f => createHash('sha256').update(fs.readFileSync(f)).digest('hex'), studioScript = fs.realpathSync(path.join(R, 'scripts/piagent-studio.mjs'));
const find = (dir, name) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) { const f = find(p, name); if (f) return f; } else if (e.name === name) return p; } return null; };

test('a task cut by a Studio update goes on by itself when Studio is back, and the wait is logged and reported', { skip: process.platform !== 'darwin' || !fs.existsSync(sdkRoot), timeout: 240000 }, async () => {
  ensureWebUiBuild(R);
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'studio-update-'))), project = path.join(home, 'project'); fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'notes.txt'), 'FIXTURE_NOTE\n');
  const agent = path.join(home, '.pi/agent'); fs.mkdirSync(agent, { recursive: true });
  const boots = { before: randomUUID(), after: randomUUID() };
  let studio = { state: 'up', version: '0.35.3', boot: boots.before }, requests = 0, beats = 0;
  const sent = [], reports = [];
  const server = http.createServer(async (req, res) => {
    // While Studio is being updated nothing answers: every connection is cut.
    if (studio.state === 'down') { req.socket.destroy(); return; }
    const headers = { 'X-Request-ID': randomUUID(), 'X-Studio-Boot': studio.boot, 'X-Studio-Version': studio.version };
    if (req.url === '/v1/heartbeat') { beats++; res.writeHead(200, { ...headers, 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 'ready', boot_id: studio.boot, version: studio.version })); return; }
    if (req.url === '/v1/capabilities') { res.writeHead(404, headers); res.end(); return; }
    const chunks = []; for await (const c of req) chunks.push(c);
    if (req.url === '/studio/v1/managed/disconnects') { reports.push({ auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) }); res.writeHead(204, headers); res.end(); return; }
    if (req.url === '/studio/v1/managed/tool-failures') { res.writeHead(204, headers); res.end(); return; }
    const body = JSON.parse(Buffer.concat(chunks)); requests++; sent.push(JSON.stringify(body.input));
    res.writeHead(200, { ...headers, 'Content-Type': 'text/event-stream' });
    const emit = e => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    const response = { id: 'resp_' + requests, object: 'response', status: 'in_progress', model: body.model, output: [] };
    if (requests === 1) { // a tool step first
      const args = JSON.stringify({ path: 'notes.txt' }), item = { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'read', arguments: '', status: 'in_progress' };
      emit({ type: 'response.created', response }); emit({ type: 'response.output_item.added', output_index: 0, item });
      emit({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: args });
      emit({ type: 'response.output_item.done', output_index: 0, item: { ...item, arguments: args, status: 'completed' } });
      emit({ type: 'response.completed', response: { ...response, status: 'completed', output: [{ ...item, arguments: args, status: 'completed' }], usage: { input_tokens: 12, output_tokens: 9, total_tokens: 21 } } }); res.end(); return;
    }
    if (requests === 2) { // the update starts while this answer streams: Studio goes away for 5 s, then comes back as 0.36.0
      emit({ type: 'response.created', response });
      studio = { ...studio, state: 'down' };
      setTimeout(() => { res.socket.destroy(); }, 50);
      setTimeout(() => { studio = { state: 'up', version: '0.36.0', boot: boots.after }; }, 5000);
      return;
    }
    const item = { id: 'msg_' + requests, type: 'message', role: 'assistant', status: 'in_progress', content: [] };
    emit({ type: 'response.created', response }); emit({ type: 'response.output_item.added', output_index: 0, item });
    emit({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
    emit({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'RESUMED_AFTER_UPDATE' });
    emit({ type: 'response.output_item.done', output_index: 0, item: { ...item, status: 'completed', content: [{ type: 'output_text', text: 'RESUMED_AFTER_UPDATE', annotations: [] }] } });
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
  const serve = launch(['--config', binding, '--serve']);
  try {
    await until(() => serve.out.stdout.includes('ready'), 60000, 'Gateway ' + serve.out.stderr.slice(-300));
    const page = await browser.newPage({ locale: 'vi-VN', viewport: { width: 1280, height: 900 } }); await page.goto(await url());
    await expect(page.getByRole('heading', { name: 'Hôm nay làm gì?' })).toBeVisible({ timeout: 30000 });
    await page.getByPlaceholder('Nhắn cho Piagent…').fill('Read notes.txt and summarise it'); await page.getByRole('button', { name: 'Gửi', exact: true }).click();
    // No click after the update: the answer comes by itself.
    await expect(page.getByText('RESUMED_AFTER_UPDATE', { exact: true }).first()).toBeVisible({ timeout: 90000 });
    assert.equal(requests, 3, 'one request cut by the update, one after it');
    assert.match(sent.at(-1), /FIXTURE_NOTE/, 'the tool result from before the update is kept');
    // Either the cut request is asked again as it was (the turn's own retry),
    // or a new round tells the agent why its step was cut.
    assert.ok(sent[2] === sent[1] || /Studio was updated \(0\.35\.3 → 0\.36\.0\)/.test(sent[2]), 'the cut request is asked again, or the agent is told why');
    assert.ok(beats >= 1, 'the heartbeat said Studio was back before the request was asked again');
    // Studio gets the report (with a run token) once it answers again.
    await until(() => reports.length > 0, 20000, 'disconnect report');
    const event = reports[0].body.events[0];
    assert.match(reports[0].auth, /^Bearer as_run_/);
    assert.deepEqual([event.cause, event.outcome, event.version_before, event.version_after, event.boot_before, event.boot_after], ['studio_update', 'resumed', '0.35.3', '0.36.0', boots.before, boots.after]);
    assert.ok(['model', 'continue', 'broker'].includes(event.phase));
    assert.ok(event.started_age_ms - event.ended_age_ms >= 4000, 'the wait lasted the update');
    // The member's local log has the wait, filterable by kind and cause.
    const logFile = find(home, 'studio-link.jsonl');
    assert.ok(logFile, 'local log written');
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.ok(lines.some(l => l.kind === 'studio_disconnect' && l.cause === 'studio_update' && l.outcome === 'resumed'));
  } finally { await browser.close(); serve.child.kill('SIGTERM'); server.closeAllConnections?.(); await new Promise(r => server.close(r)); fs.rmSync(home, { recursive: true, force: true }); }
});
