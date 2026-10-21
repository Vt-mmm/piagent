// Team/repository memory for managed conversations. Briefs are scoped to the
// current branch and refreshed after successful compaction. Each member turn
// has a durable event identity; failed writes wait in a scoped local outbox.
// Optional network work uses bounded deadlines and the shared run-token owner.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemoryOutbox, memoryScope, scopeID } from './memory-outbox.mjs';
import { CheckLessons } from './memory-lessons.mjs'; import { SkillFeedback } from './skill-feedback.mjs'; import { RoundServes, FEEDBACK_PROTOCOL } from './memory-serves.mjs';
import { CLIENT_AGENT } from './client-agent.mjs'; import { knownCapabilities, refreshCapabilities } from './studio-capabilities.mjs';
import { redactedText } from '../runtime/managed-failure.mjs';
import { git, repoKey, repositoryAt, findRepositories, topDirs, eventFor, commitChanges } from './memory-repos.mjs';
import { PAGE_NAMES, renewer, memoryTools } from './memory-tools.mjs';

export { git, repoKey, repositoryAt, findRepositories, PAGE_NAMES, renewer, memoryTools };

export const MEMORY_ENTRY = 'agent-watch-memory';
const BRIEF_MS = 5_000, WRITE_MS = 4_000, GIT_MS = 6_000, TOOL_MS = 10_000;
const OFF_MS = 30 * 60_000, KNOWN_MS = 7 * 24 * 3600_000;
// A brief that came back empty, or failed, is not asked again every round of
// the same context; closing a round (retain + telemetry) stays within CLOSE_MS.
const EMPTY_BRIEF_MS = 30 * 60_000, FAILED_BRIEF_MS = 5 * 60_000, CLOSE_MS = 4_500;
const MAX_TURN = 30 * 1024, MAX_COMMITS = 300, MAX_GIT_BODY = 60 * 1024, MAX_COMMIT_BODY = 2_000;
// A round is written to at most three of a folder's repositories (memory-repos.mjs).
const MAX_ROUND_REPOS = 3, ASK_MS = 50_000;
// Studio protocol 3 (Agent Studio 0.30): rounds and commits carry where the
// work happened and how its checks ended; memory_ask. Older Studios refuse
// unknown fields, so these are sent only once Studio has said it speaks 3.
export const PROTOCOL = 3;

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
  const lessonText = lessons.slice(0, 3).map(l => `${l.line} Evidence: ${l.failed_call} ${l.kind === 'tool_error' ? 'and' : '→'} ${l.passed_call}; fingerprint ${l.fingerprint}; ${l.at}.`).join('\n');
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
  constructor({ origin, cwd, stateDir, conversationId, scope = () => null, lease = null, renew = null, fetchImpl = fetch, now = () => Date.now(), changed = () => [] }) {
    this.renew = renew; this.scope = scope; this.lease = lease; this.protocol = 0; this.background = null; this.stats = {}; this.serves = new RoundServes();
    Object.assign(this, { origin, cwd, stateDir, conversationId, fetchImpl, now, changed, repo: undefined, repos: undefined, folder: null, heads: {}, offUntil: 0, retain: true, briefed: false });
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
  static #known(stateDir, origin, scope, now) {
    try { const k = JSON.parse(fs.readFileSync(path.join(stateDir, 'memory-known.json'), 'utf8')); return k.origin === origin && k.scope === scopeID(scope) && !!k.scope && now - k.at < KNOWN_MS ? k : null; }
    catch { return null; }
  }
  static known(stateDir, origin, scope, now = Date.now()) { return !!TeamMemory.#known(stateDir, origin, scope, now); }
  // The memory protocol that Studio last answered with on this Mac (0: unknown).
  static knownProtocol(stateDir, origin, scope, now = Date.now()) { return stateDir ? TeamMemory.#known(stateDir, origin, scope, now)?.protocol ?? 0 : 0; }
  #remember(on) {
    if (!this.knownPath) return;
    try { if (on) fs.writeFileSync(this.knownPath, JSON.stringify({ origin: this.origin, scope: this.scopeHash, at: this.now(), protocol: this.protocol || undefined })); else fs.rmSync(this.knownPath, { force: true }); } catch { /* best effort */ }
  }
  // What this Studio speaks: from this conversation's brief, else from the last one on this Mac.
  get speaks() { return this.protocol || TeamMemory.knownProtocol(this.stateDir, this.origin, this.scope(), this.now()); }

  // The repositories memory uses here; this.repo is the first (the folder's own).
  async repositories() {
    if (this.repos) return this.repos;
    if (typeof this.repo === 'string') return (this.repos = [{ key: this.repo, dir: this.cwd, name: '' }]);
    const found = await findRepositories(this.cwd);
    this.repos = found.repos; this.folder = found.folder; this.repo = found.repos[0]?.key ?? null;
    return this.repos;
  }
  async repository() { await this.repositories(); return this.repo; }
  get active() { return this.now() >= this.offUntil; }

  async #post(grant, op, body, timeout, renew = this.renew, signal, { remember = true, offOnMissing = true } = {}) {
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
      // An operation an older Studio does not have (404) is not memory being off.
      if (response.status === 404 && !offOnMissing) return null;
      if (response.status === 204 || response.status === 404) {
        // Old servers use 204 for retain opt-out as well as global off.
        if (op !== 'retain' || this.protocol >= 2) { this.offUntil = this.now() + OFF_MS; this.#remember(false); }
        else this.retain = false;
        return null;
      }
      if (!response.ok) {
        const error = Error(`memory-${op}-${response.status}`); error.status = response.status; throw error;
      }
      const answer = await response.json();
      if (op === 'brief' && Number.isInteger(answer?.protocol_version)) this.protocol = answer.protocol_version;
      if (remember) this.#remember(true);
      return answer;
    } finally { held?.release(); }
  }

  // Where the member works in a repository now: its branch and the top
  // folders of the files this conversation changed or the working tree holds.
  async #context(repo, signal) {
    const branch = (await git(repo.dir, ['rev-parse', '--abbrev-ref', 'HEAD'], 2_000, signal))?.trim();
    const own = this.#repoFiles(repo, [...(this.changed() ?? [])]);
    const status = (await git(repo.dir, ['status', '--porcelain', '--untracked-files=no'], 2_000, signal)) ?? '';
    const pending = status.split('\n').map(l => l.slice(3).split(' -> ').at(-1)?.trim()).filter(Boolean);
    const paths = topDirs([...own, ...pending]);
    return { ...(branch && branch !== 'HEAD' ? { branch: branch.slice(0, 100) } : {}), ...(paths.length ? { paths } : {}) };
  }
  // The conversation's changed files (relative to cwd) that lie in repo, relative to its top.
  #repoFiles(repo, files) {
    return files.map(f => path.relative(repo.dir, path.resolve(this.cwd, String(f)))).filter(f => f && !f.startsWith('..') && !path.isAbsolute(f)).map(f => f.split(path.sep).join('/'));
  }
  // A brief, search or ask body for one repository; context only for protocol 3.
  async #body(repo, fields, signal) {
    const body = { repo_key: repo.key, ...fields };
    if (this.speaks >= PROTOCOL) { const context = await this.#context(repo, signal).catch(() => ({})); if (Object.keys(context).length) body.context = context; }
    return body;
  }
  // The repositories a question or a round is about: those it names (by folder
  // or repository name) when the folder holds several, else all of them.
  #about(text, max = MAX_ROUND_REPOS) {
    const repos = this.repos ?? [];
    if (repos.length <= 1) return repos;
    const t = String(text ?? '').toLowerCase();
    const named = repos.filter(r => t.includes(r.name.toLowerCase()) || t.includes(r.key.split('/').at(-1)));
    return (named.length ? named : repos).slice(0, max);
  }
  #pick(repository) {
    const repos = this.repos ?? [];
    if (!repository) return null;
    const want = String(repository).toLowerCase().replace(/\/+$/, '');
    return repos.find(r => r.name.toLowerCase() === want || r.key === want || r.key.split('/').at(-1) === want) ?? null;
  }

  // A folder memory cannot use is told to Studio once, so its admins can see
  // it; only where Studio has answered memory on this Mac (a member of a team
  // without memory sends nothing it does not need).
  async #reportFolder(grant) {
    if (this.folderReported || !this.folder || !this.stateDir || !TeamMemory.known(this.stateDir, this.origin, this.scope(), this.now())) return;
    this.folderReported = true;
    try { await this.#post(grant, 'brief', { repo_key: '', prompt: '', folder: this.folder }, BRIEF_MS, this.renew, undefined, { remember: false }); } catch { /* older Studio: 400 */ }
  }

  async beforeRound(grant, prompt, hasBrief) {
    this.syncScope();
    if (!grant || !this.active) return null;
    const repos = await this.repositories();
    if (!repos.length) { await this.#reportFolder(grant); return null; }
    if ((hasBrief || this.briefed) && this.protocol) { this.startBackground(grant); return null; }
    this.count('brief_attempts');
    this.lastBrief = 'error';
    const ask = String(prompt ?? '').slice(0, 2000);
    const answers = await Promise.allSettled(repos.map(async r => [r, await this.#post(grant, 'brief', await this.#body(r, { prompt: ask }), BRIEF_MS)]));
    const ok = answers.filter(a => a.status === 'fulfilled').map(a => a.value);
    if (!ok.length) { this.count('brief_errors'); return null; }
    const answered = ok.filter(([, b]) => b);
    this.lastBrief = !answered.length ? 'off' : answered.some(([, b]) => b.text?.trim()) ? 'ok' : 'empty';
    if (!answered.length) return null;
    this.briefed = true; this.protocol = Math.min(...answered.map(([, b]) => b.protocol_version ?? 1));
    this.retain = answered.every(([, b]) => b.retain_sessions !== false);
    this.count('brief_successes'); if (this.lastBrief === 'ok') this.count('brief_nonempty');
    const heads = {};
    for (const [r, b] of answered) { heads[r.key] = b.git_head ?? null; this.serves.add(r.key, b.serve_id); }
    this.startBackground(grant, heads);
    const several = repos.length > 1, pages = new Set(), parts = [];
    let facts = 0;
    for (const [r, b] of answered) {
      facts += b.facts ?? 0; (Array.isArray(b.pages) ? b.pages : []).forEach(p => pages.add(p));
      const text = typeof b.text === 'string' ? b.text.trim() : '';
      if (text) parts.push(several ? `Repository ${r.name}/ (${r.key}):\n${text}` : text);
    }
    return { text: parts.join('\n\n'), facts, pages: [...pages] };
  }

  startBackground(grant, heads = undefined) {
    if (this.background || !this.active) return;
    // One deadline for the whole backlog, not one deadline per old event.
    const signal = AbortSignal.timeout(WRITE_MS);
    const git = heads === undefined ? [] : (this.repos ?? []).filter(r => r.key in heads).map(r => this.#sendGit(grant, r, heads[r.key], AbortSignal.timeout(GIT_MS)));
    this.background = Promise.allSettled([this.#drain(grant, signal), ...git]).finally(() => { this.background = null; });
  }

  async #sendGit(grant, repo, known, signal) {
    const head = (await git(repo.dir, ['rev-parse', 'HEAD'], 3000, signal))?.trim();
    if (!/^[0-9a-f]{40}$/.test(head ?? '') || head === known) return;
    const range = known && (await git(repo.dir, ['merge-base', '--is-ancestor', known, head], 3000, signal).then(out => out !== null)) ? [`${known}..${head}`] : [head];
    const v3 = this.protocol >= PROTOCOL;
    // Protocol 3 adds the files each commit touched: folders for tags, deletions/renames/rewrites for staleness.
    const log = await git(repo.dir, ['log', `-n${MAX_COMMITS}`, '--no-merges', ...(v3 ? ['-M', '--numstat', '--summary'] : []), '--format=%x1e%H%x1f%cI%x1f%s%x1f%b%x1d', ...range], 5_000, signal);
    if (!log) return;
    const commits = log.split('\x1e').map(r => r.trim()).filter(Boolean).map(r => {
      const [meta, files = ''] = r.split('\x1d'), [sha, date, subject, body = ''] = meta.split('\x1f');
      const commit = { sha, date, subject, body: body.trim().slice(0, MAX_COMMIT_BODY) };
      if (v3) { const { dirs, changes } = commitChanges(files.split('\n')); if (dirs.length) commit.dirs = dirs; if (changes.length) commit.changes = changes; }
      return commit;
    }).filter(c => /^[0-9a-f]{40}$/.test(c.sha) && c.subject?.trim() && c.date);
    if (!commits.length) return;
    // Oldest first, in calls under the body cap; the head is recorded with the last.
    commits.reverse();
    for (let i = 0; i < commits.length && !signal?.aborted;) {
      const batch = []; let bytes = 0;
      while (i < commits.length && (bytes += Buffer.byteLength(JSON.stringify(commits[i]))) < MAX_GIT_BODY) batch.push(commits[i++]);
      if (!batch.length) batch.push(commits[i++]);
      const last = i >= commits.length;
      if (!(await this.#post(grant, 'git', { repo_key: repo.key, head: last ? head : batch.at(-1).sha, commits: batch }, GIT_MS, this.renew, signal))) return;
    }
  }

  // The repositories a round goes to: those its changed files are in, else
  // those it names, else (a folder with several) all of them, at most three.
  #targets(changedFiles, messages) {
    const repos = this.repos ?? [];
    if (repos.length <= 1) return repos;
    const touched = repos.filter(r => this.#repoFiles(r, [...changedFiles]).length);
    return touched.length ? touched.slice(0, MAX_ROUND_REPOS) : this.#about(messages.map(m => textOf(m.content)).join('\n'));
  }

  // Persist before sending. The same event ID and source identity survive
  // crashes, lost acknowledgements and concurrent sessions.
  async afterRound(grant, messages, changedFiles, event = {}, signal) {
    // The backlog started with the round may still run; wait for it only within the close budget.
    if (this.background) await (signal ? Promise.race([this.background, new Promise(done => signal.addEventListener('abort', done, { once: true }))]) : this.background);
    if (!grant || !this.active || !this.retain || !(await this.repositories()).length) return;
    const targets = this.#targets(changedFiles ?? [], messages);
    this.lastTargets = targets;
    const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(WRITE_MS)]) : AbortSignal.timeout(WRITE_MS);
    const several = (this.repos ?? []).length > 1;
    // The record names files as the member sees them; protocol 3 also sends them relative to the repository's top.
    const filesOf = r => several ? this.#repoFiles(r, [...(changedFiles ?? [])]) : [...(changedFiles ?? [])];
    const checks = event.checks?.summary ?? null;
    // A v1 Studio (0.27.x) takes the round in its old body, best effort and
    // without the outbox: it refuses unknown fields and has no event identity.
    if (this.protocol === 1) {
      for (const r of targets) {
        const text = turnRecord(messages, filesOf(r), event.lessons ?? []);
        if (!text || deadline.aborted) return;
        try { if (await this.#post(grant, 'retain', { repo_key: r.key, conversation_id: this.conversationId, text }, WRITE_MS, this.renew, deadline)) this.count('accepted'); } catch { /* memory is optional */ }
      }
      return;
    }
    const source = event.scope ?? this.scope();
    if (!source?.key_id) return;
    const box = new MemoryOutbox(this.stateDir, source, this.now), id = event.id ?? randomUUID();
    let queued = false;
    for (const [i, r] of targets.entries()) {
      const files = filesOf(r), text = turnRecord(messages, files, event.lessons ?? []);
      if (!text) return;
      const item = { repo_key: r.key, conversation_id: this.conversationId, text,
        event_id: eventFor(id, r.key, i), source_key_id: source.key_id, occurred_at: event.at ?? new Date(this.now()).toISOString() };
      if (this.protocol >= PROTOCOL) {
        const context = await this.#context(r, deadline).catch(() => ({}));
        if (Object.keys(context).length) item.context = context;
        const own = this.#repoFiles(r, [...(changedFiles ?? [])]);
        if (own.length) item.files = own.slice(0, 12).map(f => String(f).slice(0, 200));
        if (checks) item.checks = checks;
      }
      if (this.protocol >= FEEDBACK_PROTOCOL && this.serves.of(r.key).length) item.serves = this.serves.of(r.key);
      if (!box.put(item)) { this.count('queue_rejected'); continue; }
      this.count('queued'); queued = true;
    }
    // A serve belongs to the round that used it. A rebind cannot send the old round using the new key.
    this.serves.clear(); if (!queued || scopeID(source) !== scopeID(this.scope())) return;
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
        // A round queued for protocol 3 meets a Studio that went back to 2: send the fields 2 knows.
        const { serves, ...v3 } = claim.record.item, item = this.protocol >= FEEDBACK_PROTOCOL ? claim.record.item : this.protocol >= PROTOCOL ? v3 : (({ context, files, checks, ...v2 }) => v2)(v3);
        const ack = await this.#post(grant, 'retain', item, WRITE_MS, this.renew, signal);
        if (!ack || ack.status === 'retain_disabled') { this.retain = false; outcome = 'discard'; }
        else if (ack.event_id === claim.record.item.event_id && ack.operation_id && ['pending','processing','completed','failed','cancelled','unknown'].includes(ack.status)) {
          outcome = 'ack'; this.count('accepted'); if (ack.duplicate) this.count('duplicates');
        }
      } catch (error) { if ([400,409].includes(error.status)) { outcome = 'quarantine'; this.count('quarantined'); } }
      finally { box.finish(claim, outcome); }
    }
  }

  async reportTurn(grant, turn, outcome, timeout = 2000) {
    const repo = this.lastTargets?.[0]?.key ?? this.repo;
    if (timeout < 250 || !grant || !this.active || this.protocol < 2 || !repo || scopeID(turn.scope) !== scopeID(this.scope())) return;
    // Counters only. Missing delivery stays unknown; it is never counted as
    // a control conversation. Retain opt-out does not disable measurement.
    const body = { repo_key: repo, event_id: turn.id, source_key_id: turn.scope.key_id,
      conversation_id: this.conversationId, counters: { ...this.stats }, outcome,
      duration_ms: Math.min(604800000, Math.max(0, Date.now() - Date.parse(turn.at))) };
    try { await this.#post(grant, 'telemetry', body, timeout); } catch { /* best effort, no prompt data */ }
  }

  // The tools' answers, one per repository when the folder holds several.
  async #each(repos, run) {
    const out = await Promise.all(repos.map(async r => [r, await run(r)]));
    return out.length === 1 ? out[0][1] : out.map(([r, text]) => `## ${r.name}/ (${r.key})\n${text}`).join('\n\n');
  }
  #none(repository) {
    if (!(this.repos ?? []).length) return 'Team memory is not available for this folder (no repository with a remote).';
    return `No repository named "${repository}" here; this folder has: ${this.repos.map(r => r.name || r.key).join(', ')}.`;
  }

  async search(grant, query, renew, repository) {
    if (!grant || !(await this.repositories()).length) return this.#none();
    const picked = repository ? this.#pick(repository) : null;
    if (repository && !picked && this.repos.length > 1) return this.#none(repository);
    this.count(renew?.role && renew.role !== 'main' ? 'helper_search_calls' : 'search_calls');
    return this.#each(picked ? [picked] : this.#about(query), async r => {
      try { const answer = await this.#post(grant, 'search', await this.#body(r, { query }), TOOL_MS, renew ?? this.renew); this.serves.add(r.key, answer?.serve_id); return answer?.text ?? 'Team memory is off for this team.'; }
      catch { return 'Team memory did not answer; go on without it.'; }
    });
  }
  async page(grant, name, renew, repository) {
    if (!grant || !(await this.repositories()).length) return this.#none();
    const picked = repository ? this.#pick(repository) : this.repos[0];
    if (!picked) return this.#none(repository);
    this.count('page_calls');
    try {
      const page = await this.#post(grant, 'page', { repo_key: picked.key, name }, TOOL_MS, renew ?? this.renew);
      return page ? (page.markdown?.trim() || `The page "${name}" has no content yet.`) : 'Team memory is off for this team.';
    } catch { return `No knowledge page named "${name}", or team memory did not answer.`; }
  }
  // memory_ask: one synthesized answer with its sources (Studio protocol 3).
  async ask(grant, question, renew, repository) {
    if (!grant || !(await this.repositories()).length) return this.#none();
    const picked = repository ? this.#pick(repository) : null;
    if (repository && !picked && this.repos.length > 1) return this.#none(repository);
    this.count(renew?.role && renew.role !== 'main' ? 'helper_ask_calls' : 'ask_calls');
    return this.#each(picked ? [picked] : this.#about(question, 2), async r => {
      try {
        const answer = await this.#post(grant, 'ask', await this.#body(r, { question }), ASK_MS, renew ?? this.renew, undefined, { offOnMissing: false });
        return answer?.text ?? 'This Studio cannot answer memory_ask yet; use memory_search.';
      } catch { return 'Team memory did not answer; use memory_search or go on without it.'; }
    });
  }
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
  self.memory = new TeamMemory({ origin: self.origin, cwd: self.cwd, stateDir: agentDir ?? null, conversationId: manager.getSessionId(), scope: () => memoryScope(self.origin, self.manifest), renew: renewer(self, 'main', verify), changed: () => self.ownPaths ?? [] });
  return self.memory;
}
export function trackMemoryLessons(self) {
  self.session.subscribe(event => { try { self.memoryTurn?.checks?.event(event); self.memoryTurn?.skills?.event(event); } catch { /* optional evidence */ } });
}
// Whether this conversation has team memory now: Studio answered memory for
// this key recently and has not switched it off since (the Terminal's header).
export const memoryOn = self => !!self?.memory?.stateDir && self.memory.active && TeamMemory.known(self.memory.stateDir, self.origin, memoryScope(self.origin, self.manifest));
// memory_ask is offered unless this Studio listed its capabilities without
// memory.ask.v1 (studio-capabilities.mjs). With no list heard (a Studio older
// than 0.34) it is offered; on a Studio without /v1/memory/ask the tool says
// to use memory_search instead (ask() does not turn memory off on a 404).
const speaksAsk = (self, agentDir) => knownCapabilities(agentDir ?? self.memory?.stateDir, self.origin, self.manifest)?.has('memory.ask.v1') ?? true;
export const memoryToolsFor = (self, agentDir) => agentDir && TeamMemory.known(agentDir, self.origin, memoryScope(self.origin, self.manifest)) ? memoryTools(self, { ask: speaksAsk(self, agentDir) }) : [];
// A helper (scout, research, verify, review) reads the team memory with its own run token; it never writes.
export const helperMemoryTools = (managed, grant, renew) => managed.memory?.stateDir && TeamMemory.known(managed.memory.stateDir, managed.origin, memoryScope(managed.origin, managed.manifest))
  ? memoryTools(managed, { pages: false, ask: speaksAsk(managed), grant, renew }) : [];
export async function openRound(self, manager, text) {
  if (!self.memory) return;
  self.memory.stats = {};
  const turn = self.memoryTurn = { id: randomUUID(), at: new Date().toISOString(), scope: memoryScope(self.origin, self.manifest), request: text, users: [text], checks: new CheckLessons(self.checks?.commands ?? []), skills: SkillFeedback.forRound(self, text) };
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
    self.memory.startBackground(self.grant); if (self.memory.stateDir) void refreshCapabilities(self, self.grant, { agentDir: self.memory.stateDir });
  } catch { /* memory is optional */ }
}
export async function closeRound(self) {
  try { const t = self.memoryTurn; t?.skills?.close({ checks: t.checks?.last, lessons: t.checks?.lessons ?? [] }); } catch { /* optional evidence */ }
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
