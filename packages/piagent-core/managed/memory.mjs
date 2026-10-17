// Team memory for company conversations (Studio docs/team-memory/PLAN.md):
// Studio keeps one memory per team and repository. On a conversation's first
// round the agent gets a brief of what the team's earlier conversations and
// commits say about the member's request; every round is sent back to grow
// it; new commits are sent when HEAD moved. Everything goes through Studio on
// the round's run token, and nothing here may fail or slow a turn: every call
// is bounded, a failed write waits in a small outbox for the next round, and
// Studio's 204 (memory off for the team) turns memory off for a while.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { CLIENT_AGENT } from './client-agent.mjs';
import { redactedText } from '../runtime/managed-failure.mjs';
import { shareGrant, releaseGrant } from './grant-share.mjs';

export const MEMORY_ENTRY = 'agent-watch-memory';
const BRIEF_MS = 5_000, WRITE_MS = 4_000, GIT_MS = 6_000, TOOL_MS = 10_000;
const OFF_MS = 30 * 60_000, KNOWN_MS = 7 * 24 * 3600_000;
const MAX_TURN = 30 * 1024, MAX_OUTBOX = 2 * 1024 * 1024, MAX_COMMITS = 300, MAX_GIT_BODY = 60 * 1024, MAX_COMMIT_BODY = 2_000;

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

const git = (cwd, args, timeout = 3_000) => new Promise(resolve => execFile('git', ['-C', cwd, ...args], { timeout, maxBuffer: 4 << 20, encoding: 'utf8' },
  (error, stdout) => resolve(error ? null : stdout)));

const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(p => p?.type === 'text').map(p => p.text).join('\n') : '';

// One round as memory keeps it: what the member asked, the agent's final
// answer and the files the conversation changed. Tool calls and their output
// are left out.
export function turnRecord(messages, changedFiles = []) {
  const asked = messages.filter(m => m.role === 'user').map(m => textOf(m.content).trim()).filter(Boolean);
  const answer = textOf(messages.findLast(m => m.role === 'assistant' && textOf(m.content).trim())?.content).trim();
  if (!asked.length && !answer) return '';
  const parts = [];
  for (const a of asked) parts.push(`Member: ${a}`);
  if (answer) parts.push(`${asked.length ? 'Agent' : 'Agent (continuing)'}: ${answer}`);
  const files = [...changedFiles].slice(0, 40);
  if (files.length) parts.push(`Files changed in this conversation: ${files.join(', ')}`);
  // Studio redacts again; its own keys are not in the general patterns.
  let text = redactedText(parts.join('\n\n')).replace(/\bas_(?:live|run)_[A-Za-z0-9_-]{8,}/g, '[REDACTED_SECRET]');
  return Buffer.byteLength(text) > MAX_TURN ? Buffer.from(text).subarray(0, MAX_TURN - 3).toString('utf8').replace(/�*$/, '') + '…' : text;
}

export class TeamMemory {
  constructor({ origin, cwd, stateDir, conversationId, renew = null, fetchImpl = fetch, now = () => Date.now() }) {
    this.renew = renew;
    Object.assign(this, { origin, cwd, stateDir, conversationId, fetchImpl, now, repo: undefined, offUntil: 0, retain: true, pendingGit: null, briefed: false });
    this.outboxPath = stateDir ? path.join(stateDir, 'memory-outbox.jsonl') : null;
    this.knownPath = stateDir ? path.join(stateDir, 'memory-known.json') : null;
  }

  // Memory answered for this Studio recently: the conversation gets the
  // memory tools (their schema is fixed when it opens).
  static known(stateDir, origin, now = Date.now()) {
    try { const k = JSON.parse(fs.readFileSync(path.join(stateDir, 'memory-known.json'), 'utf8')); return k.origin === origin && now - k.at < KNOWN_MS; }
    catch { return false; }
  }
  #remember(on) {
    if (!this.knownPath) return;
    try { if (on) fs.writeFileSync(this.knownPath, JSON.stringify({ origin: this.origin, at: this.now() })); else fs.rmSync(this.knownPath, { force: true }); } catch { /* best effort */ }
  }

  async repository() {
    if (this.repo === undefined) this.repo = repoKey(await git(this.cwd, ['remote', 'get-url', 'origin']));
    return this.repo;
  }
  get active() { return this.now() >= this.offUntil; }

  async #post(grant, op, body, timeout, renew = this.renew) {
    const send = g => this.fetchImpl(`${this.origin}/v1/memory/${op}`, { method: 'POST', signal: AbortSignal.timeout(timeout),
      headers: { Authorization: `Bearer ${g.token}`, 'Content-Type': 'application/json', 'User-Agent': CLIENT_AGENT, 'X-Session-Id': g.role_id },
      body: JSON.stringify(body) });
    let response = await send(grant);
    // Every model request renews its role's token and voids the one before, so
    // a memory call beside one (the commits after the brief, a search) can
    // carry a dead token: renew once, the way a web search does, and ask again.
    if (response.status === 401 && renew) {
      const fresh = await renew(grant).catch(() => null);
      if (fresh?.token && fresh.token !== grant.token) response = await send(fresh);
    }
    // 204: memory is off for the team; 404: a Studio without team memory.
    if (response.status === 204 || response.status === 404) { this.offUntil = this.now() + OFF_MS; this.#remember(false); return null; }
    if (!response.ok) throw Error(`memory-${op}-${response.status}`);
    this.#remember(true);
    return response.json();
  }

  // The round's start: send what waited, and on a conversation's first
  // round the brief (returned for the caller to add to the conversation).
  async beforeRound(grant, prompt, hasBrief) {
    if (!grant || !this.active || !(await this.repository())) return null;
    await this.#drain(grant);
    if (hasBrief || this.briefed || !this.active) return null;
    this.briefed = true;
    let brief;
    try { brief = await this.#post(grant, 'brief', { repo_key: this.repo, prompt: String(prompt ?? '').slice(0, 2000) }, BRIEF_MS); }
    catch { return null; }
    if (!brief) return null;
    this.retain = brief.retain_sessions !== false;
    this.pendingGit = this.#sendGit(grant, brief.git_head ?? null).catch(() => {});
    return { text: typeof brief.text === 'string' ? brief.text : '', facts: brief.facts ?? 0, pages: Array.isArray(brief.pages) ? brief.pages : [] };
  }

  async #sendGit(grant, known) {
    const head = (await git(this.cwd, ['rev-parse', 'HEAD']))?.trim();
    if (!/^[0-9a-f]{40}$/.test(head ?? '') || head === known) return;
    const range = known && (await git(this.cwd, ['merge-base', '--is-ancestor', known, head]).then(out => out !== null)) ? [`${known}..${head}`] : [head];
    const log = await git(this.cwd, ['log', `-n${MAX_COMMITS}`, '--no-merges', '--format=%H%x1f%cI%x1f%s%x1f%b%x1e', ...range], 5_000);
    if (!log) return;
    const commits = log.split('\x1e').map(r => r.trim()).filter(Boolean).map(r => { const [sha, date, subject, body = ''] = r.split('\x1f'); return { sha, date, subject, body: body.trim().slice(0, MAX_COMMIT_BODY) }; })
      .filter(c => /^[0-9a-f]{40}$/.test(c.sha) && c.subject?.trim() && c.date);
    if (!commits.length) return;
    // Oldest first, in calls under the body cap; the head is recorded with the last.
    commits.reverse();
    for (let i = 0; i < commits.length;) {
      const batch = []; let bytes = 0;
      while (i < commits.length && (bytes += Buffer.byteLength(JSON.stringify(commits[i]))) < MAX_GIT_BODY) batch.push(commits[i++]);
      if (!batch.length) batch.push(commits[i++]);
      const last = i >= commits.length;
      if (!(await this.#post(grant, 'git', { repo_key: this.repo, head: last ? head : batch.at(-1).sha, commits: batch }, GIT_MS))) return;
    }
  }

  // The round's end, before its run closes: the round goes to memory, or to
  // the outbox when Studio did not take it.
  async afterRound(grant, messages, changedFiles) {
    if (this.pendingGit) { await this.pendingGit; this.pendingGit = null; }
    if (!grant || !this.active || !this.retain || !(await this.repository())) return;
    const text = turnRecord(messages, changedFiles);
    if (!text) return;
    const item = { repo_key: this.repo, conversation_id: this.conversationId, text };
    try { await this.#post(grant, 'retain', item, WRITE_MS); }
    catch { this.#queue(item); }
  }

  #queue(item) {
    if (!this.outboxPath) return;
    try {
      const size = fs.existsSync(this.outboxPath) ? fs.statSync(this.outboxPath).size : 0;
      if (size + Buffer.byteLength(JSON.stringify(item)) > MAX_OUTBOX) return;
      fs.mkdirSync(path.dirname(this.outboxPath), { recursive: true });
      fs.appendFileSync(this.outboxPath, JSON.stringify(item) + '\n', { mode: 0o600 });
    } catch { /* memory is optional */ }
  }

  async #drain(grant) {
    if (!this.outboxPath || !fs.existsSync(this.outboxPath)) return;
    let items;
    try { items = fs.readFileSync(this.outboxPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); fs.rmSync(this.outboxPath, { force: true }); }
    catch { return; }
    const left = [];
    for (const [i, item] of items.entries()) {
      if (i >= 5 || !this.active) { left.push(item); continue; }
      try { await this.#post(grant, 'retain', item, WRITE_MS); } catch { left.push(item); }
    }
    for (const item of left) if (this.active) this.#queue(item);
  }

  async search(grant, query, renew) {
    if (!grant || !(await this.repository())) return 'Team memory is not available for this folder (no origin remote).';
    try { return (await this.#post(grant, 'search', { repo_key: this.repo, query }, TOOL_MS, renew ?? this.renew))?.text ?? 'Team memory is off for this team.'; }
    catch { return 'Team memory did not answer; go on without it.'; }
  }
  async page(grant, name, renew) {
    if (!grant || !(await this.repository())) return 'Team memory is not available for this folder (no origin remote).';
    try {
      const page = await this.#post(grant, 'page', { repo_key: this.repo, name }, TOOL_MS, renew ?? this.renew);
      return page ? (page.markdown?.trim() || `The page "${name}" has no content yet.`) : 'Team memory is off for this team.';
    } catch { return `No knowledge page named "${name}", or team memory did not answer.`; }
  }
}

export const PAGE_NAMES = ['Component map', 'Core concepts', 'Conventions and patterns', 'Key decisions and rationale', 'Initiatives and work in progress'];

// The agent's memory tools; helpers get only the search, on their own run.
// A fresh token for a role, shared with that role's requests running beside it.
export const renewer = (owner, role, verify) => async () => {
  const share = shareGrant(owner, role);
  try { const grant = await share.grant; verify?.(grant); if (role === 'main') owner.grant = grant; return grant; }
  finally { releaseGrant(owner, role, share); }
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
export const hasBrief = manager => manager.getEntries().some(e => (e.type === 'custom_message' || e.type === 'custom') && e.customType === MEMORY_ENTRY);

// The managed session's three hooks (session.mjs): the memory and its tools
// when the conversation opens, a round's start once its run is granted, and
// a round's end while its run token is still valid. None can fail a turn.
export function attachMemory(self, manager, agentDir, verify) {
  self.memory = new TeamMemory({ origin: self.origin, cwd: self.cwd, stateDir: agentDir ?? null, conversationId: manager.getSessionId(), renew: renewer(self, 'main', verify) });
  return self.memory;
}
export const memoryToolsFor = (self, agentDir) => agentDir && TeamMemory.known(agentDir, self.origin) ? memoryTools(self) : [];
// A helper (scout, research, verify, review) reads the team memory with its own run token; it never writes.
export const helperMemoryTools = (managed, grant, renew) => managed.memory?.stateDir && TeamMemory.known(managed.memory.stateDir, managed.origin)
  ? memoryTools(managed, { pages: false, grant, renew }) : [];
export async function openRound(self, manager, text) {
  self.roundStart = self.session.messages.length;
  try {
    const brief = await self.memory?.beforeRound(self.grant, text, hasBrief(manager));
    if (brief?.text) await self.session.sendCustomMessage(briefMessage(brief), { triggerTurn: false });
  } catch { /* memory is optional */ }
}
export async function closeRound(self) {
  if (!self.grant || self.preflight || !self.memory) return;
  try { await self.memory.afterRound(self.grant, self.session.messages.slice(self.roundStart ?? 0), self.ownPaths); } catch { /* memory is optional */ }
}
