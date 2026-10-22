// How a helper's attempt ended (Agent Studio 0.34+, POST /v1/managed/settle):
// one report per attempt, sent with the helper's own run token before its
// role closes. succeeded: the helper did its job and answered in the form its
// role needs (verify's verdicts, review's findings); failed: it could not
// (an error); cancelled: the member or the main agent stopped it;
// unverifiable: it answered without what its role needs, or its review went
// stale. Studio reads a helper role that closed without a report as
// unverifiable: absence is never success or failure.
import { CLIENT_AGENT } from './client-agent.mjs';
import { hasCapability } from './studio-capabilities.mjs';
import { HELPER_ROLES } from './helper-roles.mjs';

// The task as the main agent gives it: five optional fields beside the brief.
export const SPEC_FIELDS = Object.freeze({
  target: 'The files, component or environment in scope.',
  change: 'What the helper should find, check or judge.',
  constraints: 'What must hold, and what is out of bounds.',
  ownership: 'What the helper may read or run, and what is someone else\'s.',
  acceptance: 'The evidence that answers the task (for example file:line facts, a passing check, a cited source).',
});
const field = description => ({ type: 'string', maxLength: 1000, description });
export function delegateParameters() {
  return { type: 'object', properties: { role: { type: 'string', enum: HELPER_ROLES },
    title: { type: 'string', maxLength: 120, description: 'One line naming the job, for the company logs (for example "Find where login tokens are stored").' },
    task: { type: 'string', minLength: 1, maxLength: 12000 },
    ...Object.fromEntries(Object.entries(SPEC_FIELDS).map(([name, description]) => [name, field(description)])),
    since: { type: 'string', maxLength: 200, description: 'Review only: the commit, branch or HEAD~N the work to review started from (work committed in earlier turns).' } },
  required: ['role', 'task'], additionalProperties: false };
}
export const SPEC_PROMPT = ' Give a helper target and acceptance at least (also change, constraints and ownership when they matter): it answers against them, and its ending is recorded with them.';

// The delegate call as the helper reads it: the structured fields head the
// brief; the main agent's task follows. The spec is kept for the settlement.
export function delegateArgs(self, args) {
  const spec = Object.fromEntries(Object.keys(SPEC_FIELDS).map(k => [k, typeof args?.[k] === 'string' ? args[k].trim().slice(0, 1000) : '']).filter(([, v]) => v));
  (self.helperSpecs ??= new Map()).set(args?.role, spec);
  if (!Object.keys(spec).length) return args;
  const head = Object.entries(spec).map(([k, v]) => `${k[0].toUpperCase()}${k.slice(1)}: ${v}`).join('\n');
  return { ...args, task: `${head}\n\n${args.task}`.slice(0, 12000) };
}

const jsonBlock = reply => {
  const blocks = [...String(reply).matchAll(/```json\s*([\s\S]*?)```/g)].map(m => m[1]);
  for (const raw of blocks.reverse()) { try { const v = JSON.parse(raw); if (v && typeof v === 'object') return v; } catch { /* next */ } }
  return null;
};
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const FILE_LINE = /(?:^|[\s`("'])((?:[\w@.-]+\/)*[\w@.-]+\.[A-Za-z0-9]+):(\d+)/g;

// The report of an attempt that answered.
export function answeredSettlement(role, reply, details = {}, spec = {}) {
  const parsed = jsonBlock(reply);
  const prose = String(reply).replace(/```[\s\S]*?```/g, ' ').split('\n').map(l => l.replace(/^[#>*\-\s]+/, '').trim()).find(l => l.length > 0) ?? '';
  const summary = clip(typeof parsed?.summary === 'string' && parsed.summary.trim() ? parsed.summary : prose || `${role} answered.`, 600);
  const evidence = [], files = new Set();
  let outcome = 'succeeded';
  if (role === 'verify') {
    const verdicts = Array.isArray(parsed?.verdicts) ? parsed.verdicts : null;
    if (!verdicts) outcome = 'unverifiable';
    for (const v of verdicts ?? []) evidence.push(clip(`${v?.status ?? '?'}: ${v?.claim ?? ''} — ${v?.evidence ?? ''}`, 300));
  } else if (role === 'review') {
    if (details.stale) outcome = 'unverifiable';
    else if (details.parsed === false) outcome = 'unverifiable';
    for (const f of details.findings ?? []) { evidence.push(clip(`${f.severity} ${f.file ?? ''}:${f.line ?? ''} ${f.issue ?? ''}`, 300)); if (f.file) files.add(String(f.file)); }
  }
  for (const m of String(reply).matchAll(FILE_LINE)) {
    files.add(m[1].replace(/^\.\//, ''));
    if (role !== 'verify' && role !== 'review' && evidence.length < 8) evidence.push(clip(`${m[1]}:${m[2]}`, 300));
  }
  return { outcome, summary: details.stale ? 'The patch changed during review; this review is stale.' : summary,
    evidence: [...new Set(evidence.filter(Boolean))].slice(0, 8), files: [...files].filter(f => f.length <= 300).slice(0, 50), ...(Object.keys(spec ?? {}).length ? { spec } : {}) };
}

// The report of an attempt that ended without an answer.
export function failedSettlement(role, error, signal, spec = {}) {
  const cancelled = signal?.aborted || /managed-helper-cancelled/.test(String(error?.message));
  return { outcome: cancelled ? 'cancelled' : 'failed', summary: clip(cancelled ? `The ${role} subagent was stopped.` : `The ${role} subagent failed: ${String(error?.message ?? 'unknown error').replace(/^managed-helper-failed:\s*/, '')}`, 600),
    evidence: [], files: [], ...(Object.keys(spec ?? {}).length ? { spec } : {}) };
}

// Sends the report with the attempt's own token; never fails the helper. A
// passing failure (no answer, 5xx, 429) is sent again after these pauses:
// Studio keeps one report per role, so a repeat is safe.
const SETTLE_PAUSES_MS = [500, 2_000];
export async function settleHelper(managed, grant, report, fetchImpl = (...args) => globalThis.fetch(...args), pauses = SETTLE_PAUSES_MS) {
  if (!report || !hasCapability(managed, 'managed.settle.v1')) return false;
  let held = null;
  try {
    // Studio replaces a role's token at each renewal: a lease gives the
    // current one (the attempt's first token may be stale by now).
    if (typeof grant === 'function') { held = await grant(); grant = held.grant; }
    if (!grant?.token) return false;
    for (let attempt = 0; ; attempt += 1) {
      let status = 0;
      try {
        const response = await fetchImpl(`${managed.origin}/v1/managed/settle`, { method: 'POST', signal: AbortSignal.timeout(3_000),
          headers: { Authorization: `Bearer ${grant.token}`, 'Content-Type': 'application/json', 'User-Agent': CLIENT_AGENT }, body: JSON.stringify(report) });
        void response.body?.cancel?.().catch(() => {});
        if (response.ok) return true;
        status = response.status;
      } catch { /* no answer */ }
      if ((status && status < 500 && status !== 429) || attempt >= pauses.length) return false;
      await new Promise(resolve => setTimeout(resolve, pauses[attempt]));
    }
  } catch { return false; } finally { held?.release(); }
}

export const OUTCOME_WORDS = { succeeded: 'done', failed: 'failed', cancelled: 'stopped', unverifiable: 'unverifiable' };
