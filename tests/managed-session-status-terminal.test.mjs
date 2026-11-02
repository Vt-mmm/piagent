import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { piSdkRoot } from './helpers/pi-sdk.mjs';

// A company message is many rounds (checks, review, retries). From outside, a
// real company Terminal reads processing until the turn itself ends, paused at
// its question, then done or failed, and never done between rounds.
const R = path.resolve(import.meta.dirname, '..'), sdkRoot = piSdkRoot();
const sha = f => createHash('sha256').update(fs.readFileSync(f)).digest('hex'), studioScript = fs.realpathSync(path.join(R, 'scripts/piagent-studio.mjs'));
let pty = null; try { pty = createRequire(import.meta.url)('@lydell/node-pty'); } catch { /* skipped below */ }
const plain = text => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g, '').replace(/\s+/g, '');

async function round(prompt) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scope-terminal-'))), project = path.join(home, 'project'), agent = path.join(home, '.pi/agent');
  fs.mkdirSync(project); fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(project, 'AGENTS.md'), '## Checks\n- `npm test`\n'); fs.writeFileSync(path.join(project, 'a.test.mjs'), "import test from 'node:test'; test('a', () => {});\n");
  const git = (...a) => execFileSync('git', ['-C', project, ...a], { stdio: 'pipe' });
  git('init', '-q'); git('add', '.'); git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init');
  const requests = [];
  const server = http.createServer(async (req, res) => { if (req.url === '/v1/capabilities') { res.writeHead(404); res.end(); return; }
    const chunks = []; for await (const c of req) chunks.push(c); const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
    const said = JSON.stringify(body.input ?? ''), n = requests.length;
    if (said.includes('BOOM')) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'refused' } })); return; }
    const step = !body.tools?.length ? null : !said.includes('function_call') ? 'echo 1 > a.js' : said.includes('Harness process check') && !said.includes('a.test.mjs') ? 'node --test a.test.mjs' : null;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = e => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`), response = { id: 'resp_' + n, object: 'response', status: 'in_progress', model: body.model, output: [] };
    emit({ type: 'response.created', response });
    const item = step ? { id: 'fc_' + n, type: 'function_call', call_id: 'call_' + n, name: 'bash', arguments: JSON.stringify({ command: step }), status: 'completed' }
      : { id: 'msg_' + n, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'SCOPE_TURN_DONE', annotations: [] }] };
    if (step) { emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } }); emit({ type: 'response.function_call_arguments.done', item_id: item.id, output_index: 0, arguments: item.arguments }); }
    else { emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [], status: 'in_progress' } }); emit({ type: 'response.content_part.added', item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }); emit({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'SCOPE_TURN_DONE' }); }
    emit({ type: 'response.output_item.done', output_index: 0, item }); emit({ type: 'response.completed', response: { ...response, status: 'completed', output: [item], usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } } }); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const authority = { studio_instance_id: randomUUID(), dataset_epoch: randomUUID(), auth_generation: 1 }, roleID = randomUUID();
  const manifest = { schema_version: 2, credential_mode: 'managed', thinking_levels: ['low', 'medium', 'high'], authority, key_id: randomUUID(), user: { id: 'member-1' }, models: [{ id: 'gpt-6-sol', owned_by: 'codex', provider_model_id: 'gpt-6-sol' }],
    harness: { configuration: { main: { model_ids: ['gpt-6-sol'] }, workflow: { plan: 'off', verify: 'require', review: 'off' } } } };
  const grant = { ...authority, run_id: randomUUID(), role_id: roleID, role: 'main', token: `as_run_${roleID}_${'x'.repeat(43)}`, model_id: 'gpt-6-sol', provider_model_id: 'gpt-6-sol', provider: 'codex', effort: 'medium' };
  const broker = path.join(home, 'broker');
  fs.writeFileSync(broker, `#!${process.execPath}\nimport readline from 'node:readline';let fence=Date.now()%100000;const manifest=${JSON.stringify(manifest)},grant=${JSON.stringify(grant)};for await(const line of readline.createInterface({input:process.stdin})){const q=JSON.parse(line);process.stdout.write(JSON.stringify({id:q.id,result:q.action==='config'?manifest:q.action==='close'?true:{...grant,fence:++fence}})+'\\n');}`, { mode: 0o700 });
  const node = fs.realpathSync(process.execPath), binding = path.join(agent, 'agent-watch-managed.json');
  fs.writeFileSync(binding, JSON.stringify({ schema_version: 1, model: 'agent-watch-auto', profile_id: 'a'.repeat(64), origin: `http://127.0.0.1:${server.address().port}`, node, entrypoint: studioScript, node_sha256: sha(node), entrypoint_sha256: sha(studioScript), sdk_root: sdkRoot, broker, broker_sha256: sha(broker) }));
  const herdrSocket = path.join(home, 'h.sock'), herdr = [];
  const herdrServer = net.createServer(c => c.on('data', chunk => { for (const line of String(chunk).split('\n').filter(Boolean)) { const r = JSON.parse(line); herdr.push(r); c.write(JSON.stringify({ id: r.id, result: {} }) + '\n'); } }));
  await new Promise(r => herdrServer.listen(herdrSocket, r));
  const term = pty.spawn(process.execPath, [studioScript, '--config', binding, '--project', project], { cols: 160, rows: 50, cwd: project, env: { HERDR_ENV: '1', HERDR_SOCKET_PATH: herdrSocket, HERDR_PANE_ID: 'w7:p1', HOME: home, PATH: '/usr/bin:/bin', TERM: 'xterm-256color', LANG: 'en_US.UTF-8' } });
  let out = ''; term.onData(d => { out += d; });
  const until = async (word, ms, what = word) => { const want = word.replace(/\s+/g, ''); for (const t = Date.now(); !plain(out).includes(want);) { if (Date.now() - t > ms) throw Error(`timeout: ${what}\n${plain(out).slice(-1500)}`); await new Promise(r => setTimeout(r, 200)); } };
  const statusDir = path.join(home, '.piagent/agent/status/sessions'), seen = [];
  const poll = setInterval(() => { try { for (const f of fs.readdirSync(statusDir)) { const v = JSON.parse(fs.readFileSync(path.join(statusDir, f), 'utf8')); if (seen.at(-1)?.state !== v.state) seen.push(v); } } catch { /* between writes */ } }, 20);
  try {
    await until('agent-watch-auto', 60000, 'Terminal drawn'); await new Promise(r => setTimeout(r, 1500));
    term.write(prompt); await new Promise(r => setTimeout(r, 300)); term.write('\r');
    if (prompt === 'BOOM') {
      for (const t = Date.now(); seen.at(-1)?.state !== 'failed';) { if (Date.now() - t > 60000) throw Error(`no failed: ${JSON.stringify(seen)} ${plain(out).slice(-300)}`); await new Promise(r => setTimeout(r, 100)); }
      assert.match(seen.at(-1).message, /main agent/);
      assert.deepEqual(seen.map(v => v.state), ['idle', 'processing', 'failed']);
    } else {
      await until('Chạy phần nào?', 60000, 'question at the end of the change');
      await new Promise(r => setTimeout(r, 200));
      assert.equal(seen.at(-1).state, 'paused', 'the question reads as paused');
      term.write('\r');
      await until('Chỉ một phần test pass trên code cuối', 60000, 'the status');
      for (const t = Date.now(); seen.at(-1)?.state !== 'done';) { if (Date.now() - t > 30000) throw Error(`no done: ${JSON.stringify(seen.map(v => v.state))}`); await new Promise(r => setTimeout(r, 50)); }
      assert.deepEqual(seen.map(v => v.state), ['idle', 'processing', 'paused', 'processing', 'done'], 'no done or failed between rounds');
      const reports = herdr.filter(r => r.method === 'pane.report_agent').map(r => r.params.state);
      assert.ok(reports.indexOf('blocked') > reports.indexOf('working'), 'Herdr hears the question');
      assert.equal(reports.slice(reports.indexOf('working'), reports.indexOf('blocked')).includes('idle'), false, 'Herdr hears no idle between rounds');
    }
    const space = herdr.filter(r => r.method === 'workspace.report_metadata').at(-1);
    assert.equal(space.params.workspace_id, 'w7');
    assert.equal(seen.at(-1).project, 'project');
    assert.ok(!JSON.stringify(seen).includes(prompt === 'BOOM' ? 'BOOM' : 'sua a.js'), 'the prompt is not written out');
  } finally { clearInterval(poll); term.kill(); herdrServer.close(); await new Promise(r => server.close(r)); server.closeAllConnections?.(); fs.rmSync(home, { recursive: true, force: true }); }
}

const skip = process.platform !== 'darwin' || !fs.existsSync(sdkRoot) || !pty;
test('company Terminal: processing, paused at the question, then done', { skip, timeout: 240000 }, () => round('sua a.js'));
test('company Terminal: a refused request reads as failed', { skip, timeout: 240000 }, () => round('BOOM'));
