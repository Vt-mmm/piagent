import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { piagentEnv } from '../lib/workspace.mjs';
import { editWorkspace, runTerminal } from './workspace-actions.mjs';

// The company WebUI (Agent Watch Auto) used the way the browser app uses it:
// the launch link's capability for a cookie and CSRF token, the Gateway
// WebSocket for commands and live events, HTTP for questions, approvals and
// the transcript. No browser: what is measured is the agent, not the page.
const opaque = prefix => `${prefix}_${randomUUID().replaceAll('-', '')}`;
const PROTOCOL = { schemaVersion: 1, version: 'piagent-gateway-protocol-v1' };
const wait = ms => new Promise(r => setTimeout(r, ms));

export class WebUiSurface {
  constructor({ piagent = 'piagent' } = {}) { this.piagent = piagent; this.pending = new Map(); this.answered = new Set(); this.terminalListeners = new Set(); }
  onTerminal(listener) { this.terminalListeners.add(listener); return () => this.terminalListeners.delete(listener); }
  memberAction(action) {
    if (action.do === 'editor_save') return editWorkspace(this, action);
    if (action.do === 'terminal_test') return runTerminal(this, action);
    throw Error('unsupported-workspace-action');
  }

  // `--web` prints the launch link; when no company Gateway runs yet it starts
  // one and keeps serving it, so read the link without waiting for an exit
  // and keep that process until the run closes.
  #launch() {
    return new Promise((resolve, reject) => {
      const child = spawn(this.piagent, ['studio', '--web', '--no-open', '--project', this.project], { env: piagentEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      const timer = setTimeout(() => { child.kill(); reject(Error(`no launch link in 180 s: ${out.slice(-300)}`)); }, 180_000);
      const read = d => {
        out += d;
        const url = out.match(/Agent Watch Auto: (http\S+)/)?.[1];
        if (!url) return;
        clearTimeout(timer); child.stdout.off('data', read);
        if (child.exitCode === null) this.gatewayOwner ??= child;
        const parsed = new URL(url), hash = new URLSearchParams(parsed.hash.slice(1));
        resolve({ origin: parsed.origin, capability: hash.get('bootstrap'), projectRef: hash.get('project') });
      };
      child.stdout.on('data', read); child.stderr.on('data', d => { out += d; });
      child.once('exit', code => { clearTimeout(timer); if (!out.includes('Agent Watch Auto: http')) reject(Error(`studio --web exited ${code}: ${out.slice(-400)}`)); });
    });
  }

  async #login() {
    // Right after another run's Gateway stopped, a launch can fail once
    // (managed-launch-failed) while that Gateway is still going away.
    let launched;
    try { launched = await this.#launch(); } catch { await wait(15_000); launched = await this.#launch(); }
    const { origin, capability, projectRef } = launched;
    const response = await fetch(`${origin}/api/v1/bootstrap`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ capability }) });
    const cookie = response.headers.get('set-cookie')?.split(';', 1)[0], body = await response.json().catch(() => null);
    if (!response.ok || !cookie || !body?.csrfToken) throw Error(`bootstrap failed ${response.status}`);
    Object.assign(this, { origin, cookie, csrf: body.csrfToken, projectRef });
  }

  async http(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${this.origin}${path}`, { method, headers: { Accept: 'application/json', Origin: this.origin, Cookie: this.cookie,
        ...(method === 'POST' ? { 'Content-Type': 'application/json', 'X-Piagent-CSRF': this.csrf } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (response.status === 401 && attempt === 0) { await this.#login(); continue; }
      return { status: response.status, value: await response.json().catch(() => null) };
    }
  }

  #connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${this.origin.replace('http:', 'ws:')}/api/v1/gateway`, 'piagent.gateway.v1', { headers: { Origin: this.origin, Cookie: this.cookie }, perMessageDeflate: false });
      const timer = setTimeout(() => { ws.terminate(); reject(Error('gateway hello timeout')); }, 10_000);
      ws.on('open', () => ws.send(JSON.stringify({ ...PROTOCOL, messageType: 'connect', clientRef: 'soak_member', minimumProtocol: 1, maximumProtocol: 1, lastEventSequence: null, catalogRevision: null })));
      ws.on('message', data => {
        let frame; try { frame = JSON.parse(String(data)); } catch { return; }
        if (frame.version === 'piagent-terminal-v1') {
          for (const listener of this.terminalListeners) listener(frame);
          return;
        }
        if (frame.messageType === 'hello') { clearTimeout(timer); resolve(ws); return; }
        if (frame.messageType === 'response') {
          const p = this.pending.get(frame.requestId); if (!p) return; this.pending.delete(frame.requestId);
          return frame.ok ? p.resolve(frame.result) : p.reject(Error(String(frame.error?.code ?? 'gateway-request-failed')));
        }
        if (frame.messageType === 'event') this.#onEvent(frame.kind, frame.payload ?? {});
      });
      ws.on('close', () => { if (!this.closing) this.socketLost = true; });
      ws.on('error', error => { clearTimeout(timer); reject(error); });
    });
  }

  #request(command) {
    return this.gatewayRequest('sessions.command', { command });
  }

  gatewayRequest(method, params) {
    const requestId = opaque('request');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(Error('gateway command timeout')); }, 60_000);
      this.pending.set(requestId, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
      this.ws.send(JSON.stringify({ ...PROTOCOL, messageType: 'request', requestId, method, params }));
    });
  }

  async #command(action, payload) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const catalog = (await this.http('GET', '/api/v1/session-catalog')).value;
      const row = this.sessionRef ? catalog?.sessions?.find(s => s.sessionRef === this.sessionRef) : null;
      const now = new Date();
      const receipt = await this.#request({ schemaVersion: 1, version: 'piagent-session-command-v1', messageType: 'command', commandId: opaque('command'), idempotencyKey: opaque('idempotency'),
        action, requestedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(), sessionRef: action === 'session.create' ? null : this.sessionRef,
        expectedCatalogRevision: catalog.catalogRevision, expectedSessionRevision: action === 'session.create' ? null : row?.sessionRevision ?? null, payload });
      if (receipt?.resultCode === 'stale-revision') { await wait(500); continue; }
      return receipt;
    }
    throw Error(`${action}: stale revision four times`);
  }

  async open({ project, hooks }) {
    Object.assign(this, { project, hooks });
    await this.#login();
    this.ws = await this.#connect();
    const options = (await this.http('GET', '/api/v1/session-creation-options')).value;
    const place = options?.projects?.find(p => p.projectRef === this.projectRef);
    if (!place) throw Error('project not offered for new conversations');
    this.create = { projectRef: this.projectRef, placeRef: place.placeRef, modelRef: options.defaultModelRef ?? null, thinkingLevel: options.defaultThinkingLevel ?? 'medium' };
    this.poller = setInterval(() => void this.#poll().catch(() => {}), 3000);
  }

  #onEvent(kind, p) {
    if (!this.sessionRef || p.sessionRef !== this.sessionRef) return;
    const hooks = this.hooks;
    if (p.operationRef) this.operationRef = p.operationRef;
    if (kind === 'message.delta') hooks.onEvent({ type: 'text_delta' });
    else if (kind === 'tool.started') {
      if (p.toolLabel === 'compaction') hooks.onEvent({ type: 'compaction' });
      else if (p.toolLabel === 'capacity-wait') hooks.onEvent({ type: 'capacity_wait' });
      else hooks.onEvent({ type: 'tool_start', name: p.toolLabel });
    }
    else if (kind === 'tool.completed') hooks.onEvent({ type: 'tool_end', name: p.toolLabel, isError: !!p.isError, reasonCode: p.reasonCode });
    else if (kind === 'message.completed') hooks.onEvent({ type: 'assistant_message' });
    else if (kind === 'runtime.changed') hooks.onEvent({ type: 'status', key: 'liveState', text: `${p.liveState} ${p.reasonCode ?? ''}`.trim() });
    else if (kind === 'operation.settled') void this.#settled(p);
  }

  async #settled(p) {
    if (!this.turn) return;
    const page = (await this.http('GET', `/api/v1/sessions/${encodeURIComponent(this.sessionRef)}/inspection/transcript?limit=60`)).value;
    const items = page?.items ?? [];
    const end = items.findLast(i => i.turnEnd)?.turnEnd ?? null;
    const last = items.findLast(i => i.role === 'assistant' && i.content?.text);
    const turn = this.turn; this.turn = null;
    turn.resolve({ lastText: last?.content?.text ?? '', turnEnd: end, error: p.settlement === 'error' ? p.reasonCode ?? 'error' : null, settlement: p.settlement });
  }

  // Questions and approvals waiting for the member, as the page shows them.
  async #poll() {
    if (!this.sessionRef || !this.turn) return;
    const base = `/api/v1/sessions/${encodeURIComponent(this.sessionRef)}`;
    const asked = (await this.http('GET', `${base}/questions`)).value?.questions ?? [];
    for (const entry of asked) {
      if (this.answered.has(entry.questionRef)) continue;
      this.answered.add(entry.questionRef);
      const answers = [];
      for (const q of entry.questions) {
        const a = await this.hooks.onQuestion(q);
        answers.push(a.skipped ? null : a.other != null ? { selected: [], other: a.other } : { selected: a.selected, other: null });
      }
      const body = answers.every(a => a === null) ? { skipped: true } : { answers: answers.map(a => a ?? { selected: [0], other: null }) };
      await this.http('POST', `${base}/questions/${encodeURIComponent(entry.questionRef)}/answer`, body);
    }
    const snapshot = (await this.http('GET', `${base}/inspection/snapshot`)).value;
    for (const summary of snapshot?.approvals?.pending ?? []) {
      const ref = summary.approvalRef; if (!ref || this.answered.has(ref)) continue;
      this.answered.add(ref);
      const req = (await this.http('GET', `${base}/inspection/approvals/${encodeURIComponent(ref)}`)).value;
      const allow = await this.hooks.onApproval({ title: req?.action?.summary ?? req?.title ?? ref });
      await this.http('POST', `/api/v1/approvals/${encodeURIComponent(ref)}/decision`, { schemaVersion: 1, version: 'piagent-webui-approval-v1', recordType: 'decision', approvalRef: ref,
        decisionId: `decision.${randomUUID()}`, decisionToken: req.decisionToken, identity: req.identity, actionDigest: req.action?.actionDigest, expectedRevisions: req.expectedRevisions,
        decision: allow ? 'allow' : 'deny', reason: null, decidedAt: new Date().toISOString(), expiresAt: req.expiresAt, decisionSurface: 'webui', executor: 'pi-guard', directExecution: false });
    }
  }

  async send(text, delivery = 'new') {
    const messageRequestId = opaque('message');
    if (delivery !== 'new' && this.turn && this.operationRef) {
      await this.#command('session.send', { delivery: delivery === 'steer' ? 'steer' : 'follow-up', message: text, messageRequestId, expectedOperationRef: this.operationRef, attachmentRefs: [] });
      return;
    }
    let resolve; const ended = new Promise(r => { resolve = r; });
    this.turn = { resolve, ended };
    const receipt = this.sessionRef
      ? await this.#command('session.send', { delivery: 'new-operation', message: text, messageRequestId, expectedOperationRef: null, attachmentRefs: [] })
      : await this.#command('session.create', { ...this.create, message: text, messageRequestId });
    if (!receipt?.sessionRef && !this.sessionRef) { const t = this.turn; this.turn = null; t.resolve({ lastText: '', turnEnd: null, error: receipt?.error?.code ?? receipt?.resultCode ?? 'create-failed' }); return; }
    this.sessionRef ??= receipt.sessionRef;
    if (receipt.operationRef) this.operationRef = receipt.operationRef;
  }
  nextTurnEnd() { return this.turn ? this.turn.ended : Promise.resolve({ lastText: '', turnEnd: null, error: 'no turn running' }); }
  async stop() { if (this.operationRef) await this.#command('session.abort', { operationRef: this.operationRef, clearQueued: true }); }

  // soft: the member reloads the page (or reopens it from Agent Watch): a
  // new login and socket while the conversation keeps running in the
  // Gateway. hard: the Gateway itself goes away mid-task (a Piagent update,
  // the dashboard closed) and is started again; the running turn is gone and
  // the member writes again in the same conversation.
  async restart({ hard = false } = {}) {
    const owner = hard ? this.gatewayOwner : null;
    this.closing = true; this.ws?.close();
    if (owner && owner.exitCode === null) {
      const gone = new Promise(r => owner.once('exit', r));
      owner.kill('SIGTERM'); await Promise.race([gone, wait(30_000)]);
      this.gatewayOwner = null;
      const turn = this.turn; this.turn = null; this.operationRef = null;
      turn?.resolve({ lastText: '', turnEnd: null, error: null, restarted: true });
    }
    this.closing = false;
    await this.#login(); this.ws = await this.#connect();
    return owner ? 'reopened' : 'reattached';
  }

  // A Gateway this run started stops with it, as when its window closes.
  async close() {
    this.closing = true; clearInterval(this.poller); this.ws?.close();
    const owner = this.gatewayOwner;
    if (!owner || owner.exitCode !== null) return;
    const gone = new Promise(r => owner.once('exit', r));
    owner.kill('SIGTERM');
    await Promise.race([gone, wait(30_000)]);
  }
}
