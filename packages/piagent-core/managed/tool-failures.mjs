// Tool calls that failed in a company run, for Studio's logs (Logs → "Tool
// lỗi"). A failure happens on the member's machine and its output stays
// there: an administrator told "Docker does not work" had nothing to read.
// Each failed call is kept as the tool, a stable code, what it was asked to
// run (a command, path or address; never a search query or a brief), the end
// of its error output and what the machine is; secrets are redacted and the
// home folder is written "~". Studio keeps them 30 days.
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { redactedText } from '../runtime/managed-failure.mjs';
import { CLIENT_AGENT } from './client-agent.mjs';

const TOOL = /^[a-z0-9_]{1,40}$/;
const INPUT_CHARS = 500, ERROR_HEAD = 1000, ERROR_TAIL = 2000;
// One request carries at most BATCH failures; KEEP wait for the next one.
const BATCH = 20, KEEP = 100, ATTEMPTS = 3;
// The member stopped the tool or declined to approve it: not a failure.
const NOT_FAILURES = new Set(['managed_tool_cancelled', 'managed_helper_cancelled', 'managed_operation_denied']);

const text = result => typeof result === 'string' ? result
  : Array.isArray(result?.content) ? result.content.filter(part => part?.type === 'text').map(part => part.text ?? '').join('\n') : '';
function clean(value, home = os.homedir()) {
  const redacted = redactedText(value);
  return (home.length > 1 ? redacted.split(home).join('~') : redacted).replace(/\0/g, '');
}

// The runtime's own code when the error starts with one (managed-docker-
// unreachable, web-search-failed…), else how the command ended.
export function toolFailureCode(error) {
  const named = /^((?:managed|web-search)-[a-z-]{1,56})\b/.exec(error)?.[1];
  if (named) return named.replaceAll('-', '_');
  const exit = /Command exited with code (\d{1,3})\s*$/.exec(error)?.[1];
  if (exit) return `exit_${exit}`;
  if (/Command timed out after \d+ seconds\s*$/.test(error)) return 'timeout';
  if (/Command aborted\s*$/.test(error)) return 'managed_tool_cancelled';
  return 'error';
}

// One failed call as Studio stores it; null when it is not a failure to keep.
export function toolFailure({ tool, role, args, result, startedAt, endedAt, engine, home }) {
  const error = clean(text(result), home).trim(), code = toolFailureCode(error);
  if (NOT_FAILURES.has(code)) return null;
  const input = clean(args?.command ?? args?.path ?? args?.url ?? '', home).trim();
  return { id: randomUUID(), tool: TOOL.test(String(tool)) ? tool : 'other', role, code, at: endedAt,
    ...(input ? { input: input.slice(0, INPUT_CHARS) } : {}),
    // A long output keeps its start and its end: the end is where it failed.
    error: error.length <= ERROR_HEAD + ERROR_TAIL ? error : `${error.slice(0, ERROR_HEAD)}\n[… ${error.length - ERROR_HEAD - ERROR_TAIL} characters left out …]\n${error.slice(-ERROR_TAIL)}`,
    duration_ms: Math.max(0, Math.round(endedAt - (startedAt ?? endedAt))),
    engine: tool === 'run_with_docker' ? 'used' : engine ? 'available' : 'none' };
}

// Sends what is waiting with a role's token. A run's token lives two minutes
// and each model request renews it, so the request after a failed tool
// (wrapRoleStreams) carries what a lapsed token could not. A Studio without
// this log (404) is not asked again; nothing here can fail a turn.
export function sendToolFailures(owner, token, { fetchImpl = fetch, now = Date.now } = {}) {
  const log = owner.toolFailures;
  if (!log || log.off || log.sending || !log.queue.length || !token) return null;
  const batch = log.queue.splice(0, BATCH);
  const again = () => { log.queue.unshift(...batch.filter(item => (item.attempts = (item.attempts ?? 0) + 1) < ATTEMPTS)); };
  log.sending = (async () => {
    try {
      const response = await fetchImpl(`${owner.origin}/studio/v1/managed/tool-failures`, { method: 'POST', signal: AbortSignal.timeout(10_000),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': CLIENT_AGENT },
        body: JSON.stringify({ os: `${process.platform} ${os.release()} ${process.arch}`.slice(0, 80),
          failures: batch.map(({ at, attempts, ...item }) => ({ ...item, age_ms: Math.max(0, now() - at) })) }) });
      if (response.status === 404 || response.status === 405) { log.off = true; log.queue.length = 0; }
      // A refused body (400) would be refused again.
      else if (!response.ok && response.status !== 400) again();
    } catch { again(); }
    finally { log.sending = null; }
  })();
  return log.sending;
}

// Keeps a session's failed tool calls on its owner (the main agent's session,
// or a helper's with its role) and tries to send each as it happens.
export function trackToolFailures(owner, session, role = 'main', now = Date.now) {
  const log = owner.toolFailures ??= { queue: [], sending: null, off: false }, started = new Map();
  session.subscribe(event => {
    if (event?.type === 'tool_execution_start') started.set(event.toolCallId, { at: now(), args: event.args });
    if (event?.type !== 'tool_execution_end') return;
    const call = started.get(event.toolCallId); started.delete(event.toolCallId);
    if (!event.isError || log.off) return;
    let failure = null;
    try { failure = toolFailure({ tool: event.toolName, role, args: call?.args, result: event.result, startedAt: call?.at, endedAt: now(), engine: owner.boundary?.engine }); } catch { /* the log never fails a tool */ }
    if (!failure) return;
    log.queue.push(failure); if (log.queue.length > KEEP) log.queue.shift();
    void sendToolFailures(owner, owner.grant?.token);
  });
}
