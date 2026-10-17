// Team/repository memory for managed conversations. Briefs are scoped to the
// current branch and refreshed after successful compaction. Each member turn
// has a durable event identity; failed writes wait in a scoped local outbox.
// Optional network work uses bounded deadlines and the shared run-token owner.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemoryOutbox, memoryScope, scopeID } from './memory-outbox.mjs';
import { execFile } from 'node:child_process';
import { CheckLessons } from './memory-lessons.mjs';
import { CLIENT_AGENT } from './client-agent.mjs';
import { redactedText } from '../runtime/managed-failure.mjs';
import { shareGrant, releaseGrant } from './grant-share.mjs';

export const MEMORY_ENTRY = 'agent-watch-memory';
const BRIEF_MS = 5_000, WRITE_MS = 4_000, GIT_MS = 6_000, TOOL_MS = 10_000;
const OFF_MS = 30 * 60_000, KNOWN_MS = 7 * 24 * 3600_000;
// A brief that came back empty, or failed, is not asked again every round of
// the same context; closing a round (retain + telemetry) stays within CLOSE_MS.
const EMPTY_BRIEF_MS = 30 * 60_000, FAILED_BRIEF_MS = 5 * 60_000, CLOSE_MS = 4_500;
const MAX_TURN = 30 * 1024, MAX_COMMITS = 300, MAX_GIT_BODY = 60 * 1024, MAX_COMMIT_BODY = 2_000;

// The repository's identity: its origin remote without scheme, user, port
// or ".git", lower case ("github.com/acme/shop"). null: no memory here.
export function repoKey(remote) {
  let s = String(remote ?? '').trim();
  if (!s) return null;
  const scp = /^[\w.-]+@([^:/]+):(.+)$/.exec(s); // git@github.com:acme/shop.git
  if (scp) s = `${scp[1]}/${scp[2]}`;
  else {
    try { const u = new URL(s); if (!['http:', 'https:', 'ssh:', 'git:'].includes(u.protocol)) return null; s = `${u.hostname}${u.pathname}`; }
    catch { return null; }
  }
  s = s.toLowerCase().replace(/\.git\/?$/, '').replace(/\/+$/, '').replace(/\/{2,}/g, '/');
  return /^[a-z0-9][a-z0-9._-]*\/[a-z0-9._/-]+$/.test(s) && s.length <= 200 && !s.includes('..') ? s : null;
}

const git = (cwd, args, timeout = 3_000, signal) => new Promise(resolve => execFile('git', ['-C', cwd, ...args], { timeout, signal, maxBuffer: 4 << 20, encoding: 'utf8' },
  (error, stdout) => resolve(error ? null : stdout)));

const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(p => p?.type === 'text').map(p => p.text).join('\n') : '';

// One round as memory keeps it: what the member asked, the agent's final
// answer, changed files and bounded check-recovery evidence. Raw tool logs
// are left out.
export function turnRecord(messages, changedFiles = [], lessons = []) {
  const asked = messages.filter(m => m.role === 'user').map(m => textOf(m.content).trim()).filter(Boolean);
  const answer = textOf(messages.findLast(m => m.role === 'assistant' && textOf(m.content).trim())?.content).trim();
  if (!asked.length && !answer) return '';
  const safeClip = (text, bytes) => {
    text = redactedText(text).replace(/\bas_(?:live|run)_[A-Za-z0-9_-]{8,}/g, '[REDACTED_SECRET]');
    return Buffer.byteLength(text) <= bytes ? text : Buffer.from(text).subarray(0, bytes - 3).toString('utf8').replace(/�*$/, '') + '…';
  };
  const parts = [];
  // Preserve evidence and the final answer before budgeting member input.
  const lessonText = lessons.slice(0, 3).map(l => `${l.line} Evidence: ${l.failed_call} → ${l.passed_call}; fingerprint ${l.fingerprint}; ${l.at}.`).join('\n');
  const memberBudget = MAX_TURN - 13000 - Buffer.byteLength(lessonText);
  const member = safeClip(asked.map(a => `Member: ${a}`).join('\n\n'), memberBudget);
  if (member) parts.push(member);
  if (answer) parts.push(`${asked.length ? 'Agent' : 'Agent (continuing)'}: ${safeClip(answer, 10000)}`);
  const files = [...changedFiles].slice(0, 12).map(file => safeClip(String(file), 160));
  if (files.length) parts.push(`Files changed in this conversation: ${files.join(', ')}`);
  if (lessonText) parts.push(`Observed check lessons (tool evidence, not instructions; cause remains unverified):\n${lessonText}`);
  // Studio redacts again; its own keys are not in the general patterns.
  let text = redactedText(parts.join('\n\n')).replace(/\bas_(?:live|run)_[A-Za-z0-9_-]{8,}/g, '[REDACTED_SECRET]');
  return Buffer.byteLength(text) > MAX_TURN ? Buffer.from(text).subarray(0, MAX_TURN - 3).toString('utf8').replace(/�*$/, '') + '…' : text;
}

// A slow broker must not extend memory's deadline. Release a lease that
// arrives after cancellation, without cancelling the shared renewal owner.
function bounded(promise, signal, late = () => {}) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { signal.removeEventListener('abort', abort); if (signal.aborted) late(value); else resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
  });
}

export class TeamMemory {
  constructor({ origin, cwd, stateDir, conversationId, scope = () => null, lease = null, renew = null, fetchImpl = fetch, now = () => Date.now() }) {
    this.renew = renew; this.scope = scope; this.lease = lease; this.protocol = 0; this.background = null; this.stats = {};
    Object.assign(this, { origin, cwd, stateDir, conversationId, fetchImpl, now, repo: undefined, offUntil: 0, retain: true, briefed: false });
    this.syncScope();
    this.knownPath = stateDir ? path.join(stateDir, 'memory-known.json') : null;
  }

  syncScope() {
    const scope = this.scope(), id = scopeID(scope);
    if (id !== this.scopeHash) {
      this.scopeHash = id; this.outbox = new MemoryOutbox(this.stateDir, scope, this.now);
      this.protocol = 0; this.briefed = false; this.offUntil = 0; this.retain = true;
    }
    return scope;
  }
  count(name, n = 1) { this.stats[name] = (this.stats[name] ?? 0) + n; }

  // Memory answered for this Studio recently: the conversation gets the
  // memory tools (their schema is fixed when it opens).
  static known(stateDir, origin, scope, now = Date.now()) {
    try { const k = JSON.parse(fs.readFileSync(path.join(stateDir, 'memory-known.json'), 'utf8')); return k.origin === origin && k.scope === scopeID(scope) && !!k.scope && now - k.at < KNOWN_MS; }
    catch { return false; }
  }
  #remember(on) {
    if (!this.knownPath) return;
    try { if (on) fs.writeFileSync(this.knownPath, JSON.stringify({ origin: this.origin, scope: this.scopeHash, at: this.now() })); else fs.rmSync(this.knownPath, { force: true }); } catch { /* best effort */ }
  }

  async repository() {
    if (this.repo === undefined) this.repo = repoKey(await git(this.cwd, ['remote', 'get-url', 'origin']));
    return this.repo;
  }
  get active() { return this.now() >= this.offUntil; }

  async #post(grant, op, body, timeout, renew = this.renew, signal) {
    const expectedScope = this.scopeHash;
    const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
    const send = async g => {
      if (scopeID(this.scope()) !== expectedScope) throw Error('memory-scope-changed');
      return this.fetchImpl(`${this.origin}/v1/memory/${op}`, { method: 'POST',
        signal: deadline,
        headers: { Authorization: `Bearer ${g.token}`, 'Content-Type': 'application/json', 'User-Agent': CLIENT_AGENT, 'X-Session-Id': g.role_id }, body: JSON.stringify(body) });
    };
    let held;
    try {
      // Share the same token owner as model requests, holding the lease until
      // the request has been admitted. Helpers supply their own renewal path.
      const lease = renew?.lease ?? (renew === this.renew ? this.lease : null);
      if (lease) { held = await bounded(lease(), deadline, value => value.release()); grant = held.grant; }
      let response = await send(grant);
      if (response.status === 401 && renew) {
        this.count('auth_retries');
        held?.release(); held = null;
        const fresh = await bounded(renew(grant), deadline).catch(() => null);
        if (fresh?.token && fresh.token !== grant.token) response = await send(fresh);
      }
      if (response.status === 204 || response.status === 404) {
        // Old servers use 204 for retain opt-out as well as global off.
        if (op !== 'retain' || this.protocol >= 2) { this.offUntil = this.now() + OFF_MS; this.#remember(false); }
        else this.retain = false;
        return null;
      }
      if (!response.ok) {
        const error = Error(`memory-${op}-${response.status}`); error.status = response.status; throw error;
      }
      this.#remember(true);
      return response.json();
    } finally { held?.release(); }
  }

  async beforeRound(grant, prompt, hasBrief) {
    this.syncScope();
    if (!grant || !this.active || !(await this.repository())) return null;
    if ((hasBrief || this.briefed) && this.protocol) { this.startBackground(grant); return null; }
    this.count('brief_attempts');
    let brief;
    this.lastBrief = 'error';
    try { brief = await this.#post(grant, 'brief', { repo_key: this.repo, prompt: String(prompt ?? '').slice(0, 2000) }, BRIEF_MS); }
    catch { this.count('brief_errors'); return null; }
    this.lastBrief = !brief ? 'off' : brief.text?.trim() ? 'ok' : 'empty';
    if (!brief) return null;
    this.briefed = true; this.protocol = brief.protocol_version ?? 1;
    this.retain = brief.retain_sessions !== false;
    this.count('brief_successes'); if (brief.text?.trim()) this.count('brief_nonempty');
    this.startBackground(grant, brief.git_head ?? null);
    return { text: typeof brief.text === 'string' ? brief.text : '', facts: brief.facts ?? 0, pages: Array.isArray(brief.pages) ? brief.pages : [] };
  }

  startBackground(grant, gitHead = undefined) {
    if (this.background || !this.active) return;
    // One deadline for the whole backlog, not one deadline per old event.
    const signal = AbortSignal.timeout(WRITE_MS);
    this.background = Promise.allSettled([
      this.#drain(grant, signal),
      ...(gitHead !== undefined ? [this.#sendGit(grant, gitHead, AbortSignal.timeout(GIT_MS))] : []),
    ]).finally(() => { this.background = null; });
  }

  async #sendGit(grant, known, signal) {
    const head = (await git(this.cwd, ['rev-parse', 'HEAD'], 3000, signal))?.trim();
    if (!/^[0-9a-f]{40}$/.test(head ?? '') || head === known) return;
    const range = known && (await git(this.cwd, ['merge-base', '--is-ancestor', known, head], 3000, signal).then(out => out !== null)) ? [`${known}..${head}`] : [head];
    const log = await git(this.cwd, ['log', `-n${MAX_COMMITS}`, '--no-merges', '--format=%H%x1f%cI%x1f%s%x1f%b%x1e', ...range], 5_000, signal);
    if (!log) return;
    const commits = log.split('\x1e').map(r => r.trim()).filter(Boolean).map(r => { const [sha, date, subject, body = ''] = r.split('\x1f'); return { sha, date, subject, body: body.trim().slice(0, MAX_COMMIT_BODY) }; })
      .filter(c => /^[0-9a-f]{40}$/.test(c.sha) && c.subject?.trim() && c.date);
    if (!commits.length) return;
    // Oldest first, in calls under the body cap; the head is recorded with the last.
    commits.reverse();
    for (let i = 0; i < commits.length && !signal?.aborted;) {
      const batch = []; let bytes = 0;
      while (i < commits.length && (bytes += Buffer.byteLength(JSON.stringify(commits[i]))) < MAX_GIT_BODY) batch.push(commits[i++]);
      if (!batch.length) batch.push(commits[i++]);
      const last = i >= commits.length;
      if (!(await this.#post(grant, 'git', { repo_key: this.repo, head: last ? head : batch.at(-1).sha, commits: batch }, GIT_MS, this.renew, signal))) return;
    }
  }

  // Persist before sending. The same event ID and source identity survive
  // crashes, lost acknowledgements and concurrent sessions.
  async afterRound(grant, messages, changedFiles, event = {}, signal) {
    // The backlog started with the round may still run; wait for it only within the close budget.
    if (this.background) await (signal ? Promise.race([this.background, new Promise(done => signal.addEventListener('abort', done, { once: true }))]) : this.background);
    if (!grant || !this.active || !this.retain || !(await this.repository())) return;
    const text = turnRecord(messages, changedFiles, event.lessons ?? []);
    if (!text) return;
    const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(WRITE_MS)]) : AbortSignal.timeout(WRITE_MS);
    // A v1 Studio (0.27.x) takes the round in its old body, best effort and
    // without the outbox: it refuses unknown fields and has no event identity.
    if (this.protocol === 1) {
      if (deadline.aborted) return;
      try { if (await this.#post(grant, 'retain', { repo_key: this.repo, conversation_id: this.conversationId, text }, WRITE_MS, this.renew, deadline)) this.count('accepted'); } catch { /* memory is optional */ }
      return;
    }
    const source = event.scope ?? this.scope();
    if (!source?.key_id) return;
    const item = { repo_key: this.repo, conversation_id: this.conversationId, text,
      event_id: event.id ?? randomUUID(), source_key_id: source.key_id, occurred_at: event.at ?? new Date(this.now()).toISOString() };
    const box = new MemoryOutbox(this.stateDir, source, this.now);
    if (!box.put(item)) { this.count('queue_rejected'); return; }
    this.count('queued');
    // A rebind cannot send the old round using the new key.
    if (scopeID(source) !== scopeID(this.scope())) return;
    await this.#drain(grant, deadline);
  }

  async #drain(grant, signal) {
    if (this.protocol < 2 || !this.outbox?.directory) return;
    const box = this.outbox;
    let sent = 0;
    for (const name of box.files()) {
      if (sent >= 5 || signal?.aborted || !this.active || box.scope !== scopeID(this.scope())) break;
      const before = box.quarantined;
      const claim = box.claim(name); if (box.quarantined > before) this.count('quarantined', box.quarantined - before);
      if (!claim) continue;
      sent++;
      let outcome = 'retry';
      try {
        if (claim.record.attempts) this.count('write_retries');
        const ack = await this.#post(grant, 'retain', claim.record.item, WRITE_MS, this.renew, signal);
        if (!ack || ack.status === 'retain_disabled') { this.retain = false; outcome = 'discard'; }
        else if (ack.event_id === claim.record.item.event_id && ack.operation_id && ['pending','processing','completed','failed','cancelled','unknown'].includes(ack.status)) {
          outcome = 'ack'; this.count('accepted'); if (ack.duplicate) this.count('duplicates');
        }
      } catch (error) { if ([400,409].includes(error.status)) { outcome = 'quarantine'; this.count('quarantined'); } }
      finally { box.finish(claim, outcome); }
    }
  }

  async reportTurn(grant, turn, outcome, timeout = 2000) {
    if (timeout < 250 || !grant || !this.active || this.protocol < 2 || !this.repo || scopeID(turn.scope) !== scopeID(this.scope())) return;
    // Counters only. Missing delivery stays unknown; it is never counted as
    // a control conversation. Retain opt-out does not disable measurement.
    const body = { repo_key: this.repo, event_id: turn.id, source_key_id: turn.scope.key_id,
      conversation_id: this.conversationId, counters: { ...this.stats }, outcome,
      duration_ms: Math.min(604800000, Math.max(0, Date.now() - Date.parse(turn.at))) };
    try { await this.#post(grant, 'telemetry', body, timeout); } catch { /* best effort, no prompt data */ }
  }

  async search(grant, query, renew) {
    if (!grant || !(await this.repository())) return 'Team memory is not available for this folder (no origin remote).';
    this.count(renew?.role && renew.role !== 'main' ? 'helper_search_calls' : 'search_calls');
    try { return (await this.#post(grant, 'search', { repo_key: this.repo, query }, TOOL_MS, renew ?? this.renew))?.text ?? 'Team memory is off for this team.'; }
    catch { return 'Team memory did not answer; go on without it.'; }
  }
  async page(grant, name, renew) {
    if (!grant || !(await this.repository())) return 'Team memory is not available for this folder (no origin remote).';
    this.count('page_calls');
    try {
      const page = await this.#post(grant, 'page', { repo_key: this.repo, name }, TOOL_MS, renew ?? this.renew);
      return page ? (page.markdown?.trim() || `The page "${name}" has no content yet.`) : 'Team memory is off for this team.';
    } catch { return `No knowledge page named "${name}", or team memory did not answer.`; }
  }
}

export const PAGE_NAMES = ['Component map', 'Core concepts', 'Conventions and patterns', 'Key decisions and rationale', 'Initiatives and work in progress'];

// The agent's memory tools; helpers get only the search, on their own run.
// A fresh token for a role, shared with that role's requests running beside it.
export const renewer = (owner, role, verify) => {
  const lease = async () => {
    const share = shareGrant(owner, role);
    try { const grant = await share.grant; verify?.(grant); if (role === 'main') owner.grant = grant;
      return { grant, release: () => releaseGrant(owner, role, share) };
    } catch (error) { releaseGrant(owner, role, share); throw error; }
  };
  const renew = async () => { const held = await lease(); try { return held.grant; } finally { held.release(); } };
  renew.lease = lease; renew.role = role; return renew;
};
export function memoryTools(self, { pages = true, grant = () => self.grant, renew } = {}) {
  const tools = [{ name: 'memory_search', label: 'Team memory',
    description: 'Search the team memory of this repository: decisions, rules and conventions from the team\'s earlier conversations and commits, and its knowledge pages. Use it before asking the member something the team may already have settled. Memory is a record of the past: check what it says against the code.',
    parameters: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: 2000 } }, required: ['query'], additionalProperties: false },
    execute: async (_id, args) => ({ content: [{ type: 'text', text: await self.memory.search(grant(), args.query, renew) }], details: {} }) }];
  if (pages) tools.push({ name: 'memory_page', label: 'Team knowledge page',
    description: `Read one knowledge page the team memory keeps for this repository: ${PAGE_NAMES.join(', ')}.`,
    parameters: { type: 'object', properties: { name: { type: 'string', enum: PAGE_NAMES } }, required: ['name'], additionalProperties: false },
    execute: async (_id, args) => ({ content: [{ type: 'text', text: await self.memory.page(grant(), args.name, renew) }], details: {} }) });
  return tools;
}

// The brief as the conversation keeps it: a custom message the member does
// not see; the model reads it as context before the member's message.
export function briefMessage(brief) {
  const pages = brief.pages.length ? `\n\nKnowledge pages (read with memory_page): ${brief.pages.join(', ')}.` : '';
  return { customType: MEMORY_ENTRY, content: brief.text + pages, display: false, details: { facts: brief.facts } };
}
export const hasBrief = manager => manager.buildSessionContext().messages.some(m => m.role === 'custom' && m.customType === MEMORY_ENTRY);
const generationOf = manager => manager.getBranch().findLast(e => e.type === 'compaction')?.id ?? 'initial';
const scopedBrief = (messages, scope, generation) => messages.findLast(m => m.role === 'custom' && m.customType === MEMORY_ENTRY && m.details?.scope === scope && (generation === undefined || m.details?.generation === generation));

// Called from the awaited context transform, so a successful compaction can
// never race its next model call. Failed/aborted compactions add no generation.
export async function prepareMemoryContext(self, messages, signal, exposure = true) {
  if (!self.memory || !self.grant || self.preflight || self.compaction || signal?.aborted) return messages;
  const memory = self.memory, manager = self.session.sessionManager;
  memory.syncScope();
  const generation = generationOf(manager), scope = memory.scopeHash;
  const active = scopedBrief(messages, scope, generation);
  const cached = self.memoryBrief?.generation === generation && self.memoryBrief.scope === scope && manager.getBranch().some(e => e.id === self.memoryBrief.branchEntry) ? self.memoryBrief.message : null;
  let selected = active ?? cached;
  // Until Studio has answered a brief once (protocol unknown) every round asks: the outbox can only drain after that handshake.
  const pause = self.memoryBriefPause, paused = memory.protocol > 0 && pause?.scope === scope && pause.generation === generation && Date.now() < pause.until;
  if (!selected && !paused && self.memoryAttempt !== `${self.memoryTurn?.id}:${generation}`) {
    self.memoryAttempt = `${self.memoryTurn?.id}:${generation}`; memory.briefed = false;
    const previous = manager.getBranch().filter(e => e.type === 'message' && e.message.role === 'user').map(e => textOf(e.message.content)).findLast(t => t.trim().length > 40);
    const prompt = [self.memoryTurn?.request ?? '', previous ? `Recent task context: ${previous}` : ''].filter(Boolean).join('\n').slice(0, 2000);
    const brief = await memory.beforeRound(self.grant, prompt, false);
    if (['empty', 'error'].includes(memory.lastBrief)) self.memoryBriefPause = { scope, generation, until: Date.now() + (memory.lastBrief === 'empty' ? EMPTY_BRIEF_MS : FAILED_BRIEF_MS) };
    if (signal?.aborted || scope !== scopeID(memory.scope())) return messages.filter(m => !(m.role === 'custom' && m.customType === MEMORY_ENTRY));
    if (brief?.text) {
      selected = { role: 'custom', ...briefMessage(brief), timestamp: Date.now(), details: { facts: brief.facts, scope, generation } };
      self.memoryBrief = { generation, scope, branchEntry: self.memoryTurn?.entry, message: selected };
      memory.count('brief_injected'); if (generation !== 'initial') memory.count('brief_refreshes');
    }
  }
  // A single scoped brief, including after branch changes or a key rebind.
  const clean = messages.filter(m => !(m.role === 'custom' && m.customType === MEMORY_ENTRY));
  if (selected && memory.active) { if (exposure) memory.count('brief_exposed_requests'); return [selected, ...clean]; }
  return clean;
}

// The managed session's three hooks (session.mjs): the memory and its tools
// when the conversation opens, a round's start once its run is granted, and
// a round's end while its run token is still valid. None can fail a turn.
export function attachMemory(self, manager, agentDir, verify) {
  self.memory = new TeamMemory({ origin: self.origin, cwd: self.cwd, stateDir: agentDir ?? null, conversationId: manager.getSessionId(), scope: () => memoryScope(self.origin, self.manifest), renew: renewer(self, 'main', verify) });
  return self.memory;
}
export function trackMemoryLessons(self) {
  self.session.subscribe(event => { try { self.memoryTurn?.checks?.event(event); } catch { /* optional evidence */ } });
}
export const memoryToolsFor = (self, agentDir) => agentDir && TeamMemory.known(agentDir, self.origin, memoryScope(self.origin, self.manifest)) ? memoryTools(self) : [];
// A helper (scout, research, verify, review) reads the team memory with its own run token; it never writes.
export const helperMemoryTools = (managed, grant, renew) => managed.memory?.stateDir && TeamMemory.known(managed.memory.stateDir, managed.origin, memoryScope(managed.origin, managed.manifest))
  ? memoryTools(managed, { pages: false, grant, renew }) : [];
export async function openRound(self, manager, text) {
  if (!self.memory) return;
  self.memory.stats = {};
  const turn = self.memoryTurn = { id: randomUUID(), at: new Date().toISOString(), scope: memoryScope(self.origin, self.manifest), request: text, users: [text], checks: new CheckLessons(self.checks?.commands ?? []) };
  turn.entry = manager.appendCustomEntry('agent-watch-memory-turn', { id: turn.id, at: turn.at, scope: turn.scope });
  try {
    // Preserve the first brief in history; later refreshes are injected by the
    // context transform without appending a message while the agent streams.
    const messages = self.session.messages;
    const prepared = await prepareMemoryContext(self, messages, undefined, false);
    const fresh = scopedBrief(prepared, self.memory.scopeHash);
    if (fresh && !scopedBrief(messages, self.memory.scopeHash)) {
      await self.session.sendCustomMessage({ customType: MEMORY_ENTRY, content: fresh.content, details: fresh.details, display: false }, { triggerTurn: false });
    }
    self.memory.startBackground(self.grant);
  } catch { /* memory is optional */ }
}
export async function closeRound(self) {
  if (!self.grant || self.preflight || !self.memory || !self.memoryTurn) return;
  const turn = self.memoryTurn, closing = AbortSignal.timeout(CLOSE_MS), started = Date.now();
  let outcome = 'unknown';
  try {
    // Entry identities survive context compaction. Read only this branch and
    // this turn; harness-generated prompts are not mistaken for member words.
    const entries = self.session.sessionManager.getBranch(), at = entries.findIndex(e => e.id === turn.entry);
    if (at < 0) return;
    const answer = entries.slice(at + 1).findLast(e => e.type === 'message' && e.message.role === 'assistant' && textOf(e.message.content).trim())?.message;
    outcome = answer?.stopReason === 'stop' ? 'answered' : ['aborted','error'].includes(answer?.stopReason) ? answer.stopReason : 'unknown';
    const messages = [...turn.users.map(content => ({ role: 'user', content })), ...(answer ? [answer] : [])];
    turn.lessons = turn.checks.lessons;
    self.memory.stats.lessons = turn.lessons.length; self.memory.stats.checks_failed = turn.checks.failed; self.memory.stats.checks_passed = turn.checks.passed;
    await self.memory.afterRound(self.grant, messages, self.ownPaths, turn, closing);
  } catch { /* memory is optional */ }
  finally { await self.memory.reportTurn(self.grant, turn, outcome, Math.min(2000, CLOSE_MS - (Date.now() - started))); }
}
