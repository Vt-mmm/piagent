import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { piagentEnv } from '../lib/workspace.mjs';

// The company Terminal (`piagent studio --rpc`) driven as the member: one
// child process per conversation, Pi's RPC protocol on stdin/stdout.
const SKIP = 'Để agent tự quyết';
const OTHER = /^\d+\. Khác \(tự nhập\)$/;
const ALLOW = /^(?:allow|cho phép|đồng ý|yes|có|chạy|run)/i, DENY = /^(?:block|deny|từ chối|no|không|chặn)/i;

export function terminalSupportsRpc(piagent = 'piagent') {
  try { return execFileSync(piagent, ['studio', '--help'], { encoding: 'utf8', env: piagentEnv() }).includes('--rpc'); }
  catch { return false; }
}

// "(1/2) Header: question" and "1. Label — description" as ask_user shows them.
function parseQuestion(title, options) {
  const question = title.replace(/^\(\d+\/\d+\)\s*/, '').split('\nĐã chọn:')[0];
  const real = options.filter(o => o !== SKIP && !OTHER.test(o) && o !== 'Xong');
  return { question, options: real.map(o => { const [label, ...rest] = o.replace(/^\d+\.\s*/, '').split(' — '); return { label, description: rest.join(' — ') }; }), raw: real };
}

export class TerminalSurface {
  constructor({ piagent = 'piagent' } = {}) { this.piagent = piagent; this.seq = 0; }

  async open({ project, runDir, hooks }) {
    Object.assign(this, { project, runDir, hooks });
    this.stderrLog = fs.createWriteStream(path.join(runDir, 'terminal-stderr.log'), { flags: 'a' });
    await this.#spawn();
  }

  async #spawn() {
    const child = spawn(this.piagent, ['studio', '--rpc', '--project', this.project], { env: piagentEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child; this.pending = new Map(); this.closing = false; this.stderr = '';
    let buffer = Buffer.alloc(0);
    child.stdout.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      for (let i; (i = buffer.indexOf(10)) >= 0;) {
        const line = buffer.subarray(0, i).toString('utf8').replace(/\r$/, ''); buffer = buffer.subarray(i + 1);
        if (!line.trim()) continue;
        let record; try { record = JSON.parse(line); } catch { continue; }
        this.#onRecord(record);
      }
    });
    child.stderr.on('data', d => { this.stderr = (this.stderr + d).slice(-4000); this.stderrLog.write(d); });
    child.once('exit', (code, signal) => {
      for (const p of this.pending.values()) p.reject(Error(`terminal exited ${code ?? signal}`));
      this.pending.clear();
      if (!this.closing && this.turn) this.#endTurn({ crashed: true, error: `exit ${code ?? signal}: ${this.stderr.slice(-800)}` });
    });
    child.stdin.on('error', () => { /* the exit handler reports it */ });
    await this.#command({ type: 'get_state' }, 180_000).then(s => { this.sessionFile = s?.sessionFile ?? this.sessionFile; });
  }

  #command(command, timeoutMs = 60_000) {
    const id = `soak-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`no response to ${command.type}`)); }, timeoutMs);
      this.pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
      this.child.stdin.write(JSON.stringify({ ...command, id }) + '\n');
    });
  }
  #reply(record) { this.child.stdin.write(JSON.stringify(record) + '\n'); }

  #onRecord(r) {
    const hooks = this.hooks;
    if (r.type === 'response') {
      const p = this.pending.get(r.id); if (!p) return; this.pending.delete(r.id);
      return r.success ? p.resolve(r.data) : p.reject(Error(`${r.command}: ${r.error}`));
    }
    if (r.type === 'extension_ui_request') return this.#onUi(r);
    if (!this.turn) return;
    if (r.type === 'message_update' && r.assistantMessageEvent?.type === 'text_delta') hooks.onEvent({ type: 'text_delta' });
    else if (r.type === 'message_end' && r.message?.role === 'assistant') {
      const m = r.message, text = (m.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      if (text.trim()) this.turn.lastText = text;
      if (m.stopReason === 'error') this.turn.error = m.errorMessage ?? 'error'; else if (text.trim()) this.turn.error = null;
      hooks.onEvent({ type: 'assistant_message', stopReason: m.stopReason, inputTokens: m.usage?.input, outputTokens: m.usage?.output, error: m.errorMessage });
    }
    else if (r.type === 'message_end' && r.message?.role === 'custom') hooks.onEvent({ type: 'note', customType: r.message.customType, text: String(r.message.content ?? '').slice(0, 300) });
    else if (r.type === 'tool_execution_start') hooks.onEvent({ type: 'tool_start', name: r.toolName });
    else if (r.type === 'tool_execution_end') hooks.onEvent({ type: 'tool_end', name: r.toolName, isError: !!r.isError });
    else if (r.type === 'tool_execution_update') hooks.onEvent({ type: 'text_delta' });
    else if (r.type === 'auto_retry_start' || r.type === 'managed_provider_retry') hooks.onEvent({ type: 'provider_retry', code: r.code ?? r.errorMessage, attempt: r.attempt });
    else if (r.type === 'compaction_start') hooks.onEvent({ type: 'compaction', reason: r.reason });
    else if (r.type === 'managed_helpers') hooks.onEvent({ type: 'helpers', active: r.active });
    else if (r.type === 'managed_turn_end') this.turn.turnEnd = r.end;
    else if (r.type === 'agent_settled') this.#endTurn({});
  }

  async #onUi(r) {
    const hooks = this.hooks;
    if (r.method === 'notify') { hooks.onEvent({ type: 'notice', text: String(r.message ?? '').slice(0, 300), level: r.notifyType }); return; }
    if (r.method === 'setStatus') { if (r.statusText) hooks.onEvent({ type: 'status', key: r.statusKey, text: String(r.statusText).slice(0, 200) }); return; }
    if (!['select', 'confirm', 'input', 'editor'].includes(r.method)) return;
    if (r.method === 'select' && r.options?.includes(SKIP)) {
      const q = parseQuestion(r.title, r.options), answer = await hooks.onQuestion(q);
      const other = r.options.find(o => OTHER.test(o));
      const value = answer.skipped ? SKIP : answer.other != null ? other : q.raw[answer.selected[0]];
      this.otherText = answer.other ?? null;
      return this.#reply({ type: 'extension_ui_response', id: r.id, value });
    }
    if (r.method === 'input' && this.otherText != null) { const value = this.otherText; this.otherText = null; return this.#reply({ type: 'extension_ui_response', id: r.id, value }); }
    if (r.method === 'confirm') return this.#reply({ type: 'extension_ui_response', id: r.id, confirmed: !!(await hooks.onApproval({ title: `${r.title} ${r.message ?? ''}` })) });
    if (r.method === 'select') {
      const allow = await hooks.onApproval({ title: `${r.title} [${r.options.join(' | ')}]` });
      const value = r.options.find(o => (allow ? ALLOW : DENY).test(o));
      return this.#reply(value ? { type: 'extension_ui_response', id: r.id, value } : { type: 'extension_ui_response', id: r.id, cancelled: true });
    }
    this.#reply({ type: 'extension_ui_response', id: r.id, cancelled: true });
  }

  #endTurn(extra) {
    const turn = this.turn; if (!turn) return;
    this.turn = null;
    turn.resolve({ lastText: turn.lastText, turnEnd: turn.turnEnd, error: turn.error, ...extra });
  }

  async send(text, delivery = 'new') {
    if (delivery !== 'new' && this.turn) return this.#command({ type: delivery === 'steer' ? 'steer' : 'follow_up', message: text });
    let resolve; const ended = new Promise(r => { resolve = r; });
    this.turn = { lastText: '', turnEnd: null, error: null, resolve, ended };
    try { await this.#command({ type: 'prompt', message: text }); }
    catch (error) { this.#endTurn({ error: String(error.message) }); }
  }
  nextTurnEnd() { return this.turn ? this.turn.ended : Promise.resolve({ lastText: '', turnEnd: null, error: 'no turn running' }); }
  async stop() { if (this.child?.exitCode === null) await this.#command({ type: 'abort' }, 120_000); }

  // The member closes the Terminal window mid-task and opens the same
  // conversation again (/resume).
  async restart() { // the Terminal closing is always hard: the conversation stops with it
    if (!this.sessionFile) return false;
    this.closing = true; this.child.kill('SIGKILL');
    await new Promise(r => this.child.exitCode !== null || this.child.signalCode ? r() : this.child.once('exit', r));
    this.#endTurn({ restarted: true });
    await this.#spawn();
    const switched = await this.#command({ type: 'switch_session', sessionPath: this.sessionFile }, 120_000);
    return switched?.cancelled ? false : 'reopened';
  }

  async close() {
    this.closing = true;
    if (!this.child || this.child.exitCode !== null) return;
    const exited = new Promise(r => this.child.once('exit', r));
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 30_000);
    await exited; clearTimeout(timer); this.stderrLog.end();
  }
}
