import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { piSdkRoot } from './helpers/pi-sdk.mjs';

// The question at the end of a change comes after the agent answered, with no
// tool running: a real Terminal must show it, take the key and let the turn go on.
const R = path.resolve(import.meta.dirname, '..'), sdkRoot = piSdkRoot();
const sha = f => createHash('sha256').update(fs.readFileSync(f)).digest('hex'), studioScript = fs.realpathSync(path.join(R, 'scripts/piagent-studio.mjs'));
let pty = null; try { pty = createRequire(import.meta.url)('@lydell/node-pty'); } catch { /* skipped below */ }
const plain = text => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g, '').replace(/\s+/g, '');

async function round(key) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'scope-terminal-'))), project = path.join(home, 'project'), agent = path.join(home, '.pi/agent');
  fs.mkdirSync(project); fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(project, 'AGENTS.md'), '## Checks\n- `npm test`\n'); fs.writeFileSync(path.join(project, 'a.test.mjs'), "import test from 'node:test'; test('a', () => {});\n");
  const git = (...a) => execFileSync('git', ['-C', project, ...a], { stdio: 'pipe' });
  git('init', '-q'); git('add', '.'); git('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'init');
  const requests = [];
  const server = http.createServer(async (req, res) => { if (req.url === '/v1/capabilities') { res.writeHead(404); res.end(); return; }
    const chunks = []; for await (const c of req) chunks.push(c); const body = JSON.parse(Buffer.concat(chunks)); requests.push(body);
    const said = JSON.stringify(body.input ?? ''), n = requests.length;
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
  const term = pty.spawn(process.execPath, [studioScript, '--config', binding, '--project', project], { cols: 160, rows: 50, cwd: project, env: { HOME: home, PATH: '/usr/bin:/bin', TERM: 'xterm-256color', LANG: 'en_US.UTF-8' } });
  let out = ''; term.onData(d => { out += d; });
  const until = async (word, ms, what = word) => { const want = word.replace(/\s+/g, ''); for (const t = Date.now(); !plain(out).includes(want);) { if (Date.now() - t > ms) throw Error(`timeout: ${what}\n${plain(out).slice(-1500)}`); await new Promise(r => setTimeout(r, 200)); } };
  try {
    await until('agent-watch-auto', 60000, 'Terminal drawn'); await new Promise(r => setTimeout(r, 1500));
    term.write('sua a.js'); await new Promise(r => setTimeout(r, 300)); term.write('\r');
    await until('Chạy phần nào?', 60000, 'question at the end of the change');
    term.write(key);
    await until('SCOPE_TURN_DONE', 60000, 'the turn goes on');
    await until('Chỉ một phần test pass trên code cuối', 60000, 'the status');
    assert.ok(requests.some(r => JSON.stringify(r.input).includes('only the tests that cover your change')), 'the agent was told to run the part');
    assert.ok(requests.some(r => JSON.stringify(r.input).includes('node --test a.test.mjs')));
  } finally { term.kill(); await new Promise(r => server.close(r)); server.closeAllConnections?.(); fs.rmSync(home, { recursive: true, force: true }); }
}

const skip = process.platform !== 'darwin' || !fs.existsSync(sdkRoot) || !pty;
test('Terminal: the question at the end of a change takes the first option', { skip, timeout: 240000 }, () => round('\r'));
test('Terminal: Esc at the question takes the cheap answer and the turn goes on', { skip, timeout: 240000 }, () => round('\x1b'));
