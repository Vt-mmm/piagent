// The member's link to Studio while a company conversation runs. A long task
// (a checklist left running overnight) outlives Studio: an update restarts it,
// the office network drops, Agent Watch reconnects. When a request cannot
// reach Studio for a reason that is Studio's or the way to it (not the key,
// the quota or a policy), the work waits here, reading Studio's heartbeat,
// and goes on once Studio answers again: no limit on how long, only Stop ends
// the wait. Each wait is written to a local log (one JSON line per event,
// filterable by `kind` and `cause`) and reported to Studio
// (POST /studio/v1/managed/disconnects), which decides the cause from its own
// starts: an update (a new version), a restart (a new start, same version),
// or the member's network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { CLIENT_AGENT } from './client-agent.mjs';
import { failureCode, failureText } from '../runtime/managed-failure.mjs';

// Codes whose cause is Studio or the way to it: Studio, its gateway or its
// connector did not answer (stopped, restarting, an update), or Agent Watch
// lost Studio or stopped. Everything else fails as before.
export const STUDIO_WAIT_CODES = new Set(['studio-unreachable', 'studio-gateway-unavailable', 'connector_unavailable', 'inference_unavailable',
  'operation_unavailable', 'managed-broker:offline', 'managed-broker-timeout', 'managed-broker-disconnected',
  'managed-broker:serverUnavailable', 'managed-broker:upstreamUnavailable']);
const BROKER = /^managed-broker/;
// Answered by Studio itself or by Agent Watch on this machine: Studio's own
// failure only while Studio is away or just back (its connector or Agent
// Watch reconnect after an update). With Studio up all along they fail at
// once, as before (a connector down on a running Studio is not waited out).
const WHEN_STUDIO_AWAY = new Set(['connector_unavailable', 'inference_unavailable', 'operation_unavailable']);
const conditional = code => BROKER.test(code) || WHEN_STUDIO_AWAY.has(code);
export const LINK_LOG = 'studio-link.jsonl';
const LOG_BYTES = 2 * 1024 * 1024, QUEUE = 50, BATCH = 20, SEND_TRIES = 5;
const MIN_PAUSE_MS = 2_000, MAX_PAUSE_MS = 30_000, MAX_STREAK_PAUSE_MS = 5 * 60_000, BEAT_TIMEOUT_MS = 5_000;
// After Studio was away, Agent Watch gets this long to reach it again.
export const BROKER_GRACE_MS = 10 * 60_000;
// Agent Watch could not reach Studio while Studio answers here: its way to
// Studio failed for a moment (a gateway's 5xx, a dropped connection, a slow
// answer). Found on 2026-10-22: one such failure renewing the grant stopped a
// 25-minute task at once. It is asked again, pausing longer each time, until
// it has failed for this long without a request going through; then it fails
// as before (Agent Watch itself is broken, not the way to Studio).
export const BROKER_RETRY_MS = 3 * 60_000;

const header = (headers, name) => {
  if (!headers) return null;
  const value = typeof headers.get === 'function' ? headers.get(name) : headers[name] ?? headers[name.toLowerCase()];
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 64) : null;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,39}$/;
const clean = (boot, version) => ({ boot: UUID.test(boot ?? '') ? boot : null, version: VERSION.test(version ?? '') ? version : null });

// What Studio's starts and the heartbeat's answers say about a wait. A
// Studio that started during the wait restarted, even when the conversation
// never saw its version before (a Studio older than the heartbeat).
export function classifyWait(before, after, seen, codes, since = null) {
  if (before?.version && after?.version && before.version !== after.version) return 'studio_update';
  if (before?.boot && after?.boot && before.boot !== after.boot) return 'studio_restart';
  if (!before?.boot && since !== null && Date.parse(after?.startedAt ?? '') >= since - 60_000) return 'studio_restart';
  if (seen.has('draining') || seen.has('starting')) return 'studio_unavailable';
  if (codes.length && codes.every(c => BROKER.test(c))) return 'broker_offline';
  if (seen.has('down')) return 'network';
  return 'unknown';
}

export class StudioLink {
  constructor({ origin, agentDir = null, notify = () => {}, ui = () => null, fetchImpl = (...a) => globalThis.fetch(...a), now = () => Date.now(),
    pause = (ms, signal) => sleep(ms, undefined, { signal }), random = Math.random, minPauseMs = MIN_PAUSE_MS, maxPauseMs = MAX_PAUSE_MS } = {}) {
    Object.assign(this, { origin, notify, ui, fetchImpl, now, pause, random, minPauseMs, maxPauseMs });
    this.logFile = agentDir ? path.join(agentDir, 'logs', LINK_LOG) : null;
    this.last = { boot: null, version: null };
    // What Studio was before a wait comes from its answers' headers (observe):
    // no extra request when a conversation opens.
    this.queue = []; this.waiting = new Set(); this.streak = 0; this.disabled = false; this.sending = null;
  }

  // Studio's start and version from any of its answers (X-Studio-Boot, X-Studio-Version).
  observe(headers) {
    const seen = clean(header(headers, 'x-studio-boot'), header(headers, 'x-studio-version'));
    if (seen.boot) this.last = { boot: seen.boot, version: seen.version ?? this.last.version };
  }
  // A request went through: the next wait starts with a short pause again.
  ok() { this.streak = 0; this.brokerSince = null; }
  waits(code) { return STUDIO_WAIT_CODES.has(code); }
  // Studio or the way to it, whatever Studio's heartbeat says now.
  always(code) { return this.waits(code) && !conditional(code); }

  // GET /v1/heartbeat: ready, starting, draining, or down (no answer, or a
  // gateway's page instead of Studio's).
  async beat(signal) {
    const timeout = AbortSignal.timeout(BEAT_TIMEOUT_MS), both = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await this.fetchImpl(`${this.origin}/v1/heartbeat`, { headers: { 'User-Agent': CLIENT_AGENT, Accept: 'application/json' }, signal: both });
      // A Studio older than the heartbeat answers 404: it answers, so it is up.
      if (response.status === 404 && header(response.headers, 'x-request-id')) { void response.body?.cancel?.().catch(() => {}); return { state: 'ready', boot: null, version: null }; }
      const body = await response.json().catch(() => null);
      const state = ['ready', 'starting', 'draining'].includes(body?.status) ? body.status : 'down';
      const seen = clean(body?.boot_id, body?.version), startedAt = typeof body?.started_at === 'string' ? body.started_at.slice(0, 40) : null;
      if (state === 'ready' && response.ok && seen.boot) this.last = seen;
      return { state: state === 'ready' && !response.ok ? 'down' : state, ...seen, startedAt };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { state: 'down', boot: null, version: null };
    }
  }

  // Waits until Studio answers its heartbeat as ready, then returns what the
  // wait was; throws (AbortError) when the member stops the work meanwhile.
  // Null: nothing to wait for. Agent Watch lost Studio, or Studio's
  // connector did not answer, while Studio answers here and was not away
  // lately: that fails at once as before.
  async waitUntilBack({ phase = 'model', code = 'studio-unreachable', role = 'main', conversation = null, runId = null, signal } = {}) {
    if (signal?.aborted) throw signal.reason ?? Error('aborted');
    if (!this.waits(code)) return null;
    const first = conditional(code) ? await this.beat(signal) : null;
    if (first?.state === 'ready' && !this.justBack() && !this.brokerRetry(code)) return null;
    const controller = new AbortController(), stop = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', stop, { once: true });
    this.waiting.add(controller);
    const event = { id: randomUUID(), phase, role, codes: [code], started: this.now(), before: { ...this.last }, attempts: 0, conversation, runId };
    const seen = new Set(first ? [first.state] : []);
    this.log({ kind: 'studio_wait', state: 'start', id: event.id, phase, role, code, version: event.before.version, conversation });
    this.notify({ type: 'managed_studio_wait', id: event.id, role, phase, code, state: 'start', waitedMs: 0 });
    this.status(first?.state === 'ready' ? `Agent Watch could not reach Studio (${code}). Asking again; the work goes on by itself. Esc stops.`
      : `Studio is not answering (${code}). Waiting; the work goes on by itself when Studio is back. Esc stops.`);
    // Failing again right after a wait (Studio answers, the request does
    // not): each such wait starts with a longer pause, up to five minutes.
    let pause = Math.min(MAX_STREAK_PAUSE_MS, this.minPauseMs * 2 ** Math.min(this.streak, 8));
    let after = null;
    try {
      for (;;) {
        await this.pause(Math.round(pause * (0.75 + this.random() / 2)), controller.signal);
        event.attempts += 1;
        after = await this.beat(controller.signal);
        seen.add(after.state);
        if (after.state === 'ready') break;
        this.notify({ type: 'managed_studio_wait', id: event.id, role, phase, code, state: 'waiting', studio: after.state, waitedMs: this.now() - event.started });
        this.status(`Studio is ${after.state === 'down' ? 'out of reach' : after.state} (${Math.round((this.now() - event.started) / 60_000)} min). The work goes on by itself when Studio is back. Esc stops.`);
        pause = Math.min(this.maxPauseMs, pause * 2);
      }
      this.streak += 1;
      return this.ended(event, 'resumed', after, seen);
    } catch (error) {
      this.ended(event, 'stopped', after, seen);
      throw error;
    } finally {
      signal?.removeEventListener('abort', stop);
      this.waiting.delete(controller);
      if (!this.waiting.size) this.status(undefined);
    }
  }

  // Whether a failure with this code waits for Studio (see waitUntilBack).
  async needed(code, signal) {
    if (signal?.aborted) throw signal.reason ?? Error('aborted');
    if (!this.waits(code)) return false;
    return !(conditional(code) && (await this.beat(signal)).state === 'ready' && !this.justBack() && !this.brokerRetry(code, false));
  }
  // An Agent Watch failure on a Studio that answers: asked again within
  // BROKER_RETRY_MS of the first one since a request last went through.
  brokerRetry(code, start = true) {
    if (!BROKER.test(code)) return false;
    const since = this.brokerSince ?? this.now();
    if (start) this.brokerSince = since;
    return this.now() - since < (this.brokerRetryMs ?? BROKER_RETRY_MS);
  }
  justBack() { return !!this.recoveredAt && this.now() - this.recoveredAt < (this.brokerGraceMs ?? BROKER_GRACE_MS); }

  // A pause Stop can end (a round asked again after a provider's passing failure).
  async hold(ms, signal) {
    const controller = new AbortController(), stop = () => controller.abort(signal?.reason);
    if (signal?.aborted) throw signal.reason ?? Error('aborted');
    signal?.addEventListener('abort', stop, { once: true });
    this.waiting.add(controller);
    try { await this.pause(ms, controller.signal); }
    finally { signal?.removeEventListener('abort', stop); this.waiting.delete(controller); if (!this.waiting.size) this.status(undefined); }
  }

  // Stop ends every wait at once.
  cancel() { for (const controller of this.waiting) controller.abort(Error('managed-request-aborted')); }

  ended(event, outcome, after, seen) {
    const ended = this.now(), cause = classifyWait(event.before, after ?? {}, seen, event.codes, event.started);
    // Studio itself was away: Agent Watch gets BROKER_GRACE_MS to reach it again.
    if (outcome === 'resumed' && [...seen].some(state => state !== 'ready')) this.recoveredAt = ended;
    const record = { kind: 'studio_disconnect', id: event.id, phase: event.phase, role: event.role, cause, outcome, attempts: event.attempts, codes: event.codes,
      started_at: new Date(event.started).toISOString(), ended_at: new Date(ended).toISOString(), waited_ms: ended - event.started,
      version_before: event.before.version, version_after: after?.version ?? null, boot_before: event.before.boot, boot_after: after?.boot ?? null,
      conversation: event.conversation, run_id: event.runId };
    this.log(record);
    this.notify({ type: 'managed_studio_wait', id: event.id, role: event.role, phase: event.phase, code: event.codes[0], state: 'end', outcome, cause, waitedMs: record.waited_ms });
    if (this.queue.length >= QUEUE) this.queue.shift();
    this.queue.push({ record, tries: 0 });
    return record;
  }

  // The waits Studio has not heard of yet, sent with a token that works now.
  // A Studio without the route (404) is not asked again in this conversation.
  async flush(token) {
    if (this.disabled || !token || !this.queue.length || this.sending) return this.sending ?? false;
    const batch = this.queue.slice(0, BATCH), at = this.now();
    const events = batch.map(({ record: r }) => ({ id: r.id, phase: r.phase, cause: r.cause, outcome: r.outcome, attempts: Math.min(r.attempts, 1_000_000), codes: r.codes.slice(0, 8),
      started_age_ms: Math.max(0, at - Date.parse(r.started_at)), ended_age_ms: Math.max(0, at - Date.parse(r.ended_at)),
      ...(r.conversation && /^[A-Za-z0-9_-]{1,80}$/.test(r.conversation) ? { conversation: r.conversation } : {}), ...(UUID.test(r.run_id ?? '') ? { run_id: r.run_id } : {}),
      ...(r.boot_before ? { boot_before: r.boot_before } : {}), ...(r.boot_after ? { boot_after: r.boot_after } : {}),
      ...(r.version_before ? { version_before: r.version_before } : {}), ...(r.version_after ? { version_after: r.version_after } : {}) }))
      .filter(e => e.started_age_ms <= 7 * 24 * 3600_000);
    const done = sent => { this.queue = this.queue.filter(q => !batch.includes(q) || (!sent && ++q.tries < SEND_TRIES)); return sent; };
    if (!events.length) return done(true);
    this.sending = this.fetchImpl(`${this.origin}/studio/v1/managed/disconnects`, { method: 'POST', signal: AbortSignal.timeout(10_000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': CLIENT_AGENT },
      body: JSON.stringify({ os: `${os.platform()} ${os.release()} ${os.arch()}`.slice(0, 80), events }) })
      .then(response => {
        void response.body?.cancel?.().catch(() => {});
        if (response.status === 404) { this.disabled = true; return done(false); }
        return done(response.status === 204);
      }, () => done(false))
      .finally(() => { this.sending = null; });
    return this.sending;
  }

  // One JSON line per event in <agentDir>/logs/studio-link.jsonl (kept to
  // about 2 MB, the previous file as .1): `jq 'select(.cause=="studio_update")'`.
  log(entry) {
    if (!this.logFile) return;
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true, mode: 0o700 });
      try { if (fs.statSync(this.logFile).size > LOG_BYTES) fs.renameSync(this.logFile, `${this.logFile}.1`); } catch { /* no log yet */ }
      fs.appendFileSync(this.logFile, `${JSON.stringify({ at: new Date(this.now()).toISOString(), ...entry })}\n`, { mode: 0o600 });
    } catch { /* the wait goes on without its log line */ }
  }

  // The Terminal's working line while anything waits for Studio.
  status(text) {
    try { this.ui()?.setWorkingMessage?.(text); } catch { /* no Terminal */ }
  }
}

// What the main agent reads when its work goes on after the model provider
// failed for a passing reason in the middle of the round.
export function providerResumeMessage(code, attempt, max) {
  return { customType: 'agent-watch-process', display: true,
    content: `Harness: your last step was cut off because the model provider failed while answering [${code}]; that is a passing failure on its side (attempt ${attempt} of ${max} to go on). Nothing you asked for is lost: the files and the checklist are as you left them. Check where you were (the checklist, git status, the last command you ran) and continue the member's task from there; do not redo work that is already done.`,
    details: { phase: 'resume', cause: 'provider', code, attempt, max } };
}

// What the main agent reads when its work goes on after Studio was back.
export function resumeMessage(wait, code) {
  const why = { studio_update: `Studio was updated${wait.version_before && wait.version_after ? ` (${wait.version_before} → ${wait.version_after})` : ''}`,
    studio_restart: 'Studio restarted', studio_unavailable: 'Studio was not ready', network: 'the connection to Studio dropped',
    broker_offline: 'Agent Watch lost Studio', unknown: 'Studio could not be reached' }[wait.cause] ?? 'Studio could not be reached';
  const minutes = Math.max(1, Math.round(wait.waited_ms / 60_000));
  return { customType: 'agent-watch-process', display: true,
    content: `Harness: your last step was cut off because ${why} [${code}]; Studio answers again after about ${minutes} min. Nothing you asked for is lost: the files and the checklist are as you left them. Check where you were (the checklist, git status, the last command you ran) and continue the member's task from there; do not redo work that is already done.`,
    details: { phase: 'resume', cause: wait.cause, waitedMs: wait.waited_ms, code } };
}

// A broker call (closing the round's run) when Agent Watch's way to Studio
// fails for a moment: asked again while the link waits, so a passing gateway
// error does not fail a turn whose work is done.
export async function viaLink(link, ask, { conversation = null, runId = null } = {}) {
  for (;;) {
    try { return await ask(); }
    catch (error) {
      const code = failureCode(failureText(error));
      if (!(await link?.waitUntilBack({ phase: 'broker', code, conversation, runId }).catch(() => null))) throw error;
    }
  }
}
