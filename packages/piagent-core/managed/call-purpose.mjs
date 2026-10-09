// What a company model call is for, for Studio's logs (Logs → "Lượt agent"):
// the kind of call, the tools the answer before it called, and a subagent
// job's one-line title. No other prompt text leaves in these headers.
const SUMMARY_PROMPT = 'You are a context summarization assistant';
const TOOL = /^[a-z0-9_]{1,40}$/;
const TITLE_CHARS = 100;

// "read:3,bash": the tools of the assistant answer before this call, most
// used first, at most eight names (an unknown name counts as "other").
export function afterTools(message) {
  const counts = new Map();
  for (const part of message?.role === 'assistant' && Array.isArray(message.content) ? message.content : []) {
    if (part?.type !== 'toolCall') continue;
    const name = TOOL.test(String(part.name)) ? part.name : 'other';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, n]) => n > 1 ? `${name}:${Math.min(n, 9999)}` : name).join(',');
}

// A subagent job's title: the one the main agent gave, else the brief's
// first line; one line, at most TITLE_CHARS characters.
export function jobTitle(task, title) {
  const line = [title, ...String(task ?? '').split('\n')].map(s => String(s ?? '').replace(/[\p{Cc}\s]+/gu, ' ').trim()).find(Boolean) ?? '';
  return line.length > TITLE_CHARS ? line.slice(0, TITLE_CHARS - 1).trimEnd() + '…' : line;
}

// The headers of one call. `owner.nextPurpose` is set by the harness when it
// sends the main agent back (checks, review findings: "harness"; a checklist
// with open steps: "continue").
export function purposeHeaders(owner, runtime, role, context) {
  const messages = context?.messages ?? [], last = messages.at(-1);
  let purpose, after = '';
  if (systemText(context).startsWith(SUMMARY_PROMPT)) purpose = 'summary';
  else if (last?.role === 'toolResult') { purpose = 'tool_step'; after = afterTools(messages.findLast(m => m.role === 'assistant')); }
  else if (role !== 'main') purpose = 'brief';
  else if (['harness', 'continue'].includes(owner.nextPurpose)) { purpose = owner.nextPurpose; owner.nextPurpose = null; }
  else purpose = 'answer';
  const title = purpose === 'brief' ? owner.jobTitles?.get(runtime) : '';
  return { 'X-Agent-Purpose': purpose, ...(after ? { 'X-Agent-After': after } : {}), ...(title ? { 'X-Agent-Task': encodeURIComponent(title) } : {}),
    ...(role === 'main' ? compactionHeaders(owner, purpose) : {}) };
}

// The main agent's compaction (trackCompaction in compaction.mjs): each
// summary call names it, why it ran and which part it is ("<id>;threshold;2");
// the next other call says how it ended, with Pi's token counts before and
// after and how long it took ("<id>;threshold;done;244039;34237;81000"), once.
const count = n => Number.isFinite(n) && n >= 0 ? String(Math.round(n)) : '';
export function compactionHeaders(owner, purpose) {
  const out = {}, now = owner.compaction, ended = owner.compacted;
  if (purpose === 'summary' && now) {
    now.part = Math.min(now.part + 1, 999);
    out['X-Agent-Compaction'] = `${now.id};${now.reason};${now.part}`;
  }
  if (purpose !== 'summary' && ended) {
    owner.compacted = null;
    out['X-Agent-Compacted'] = [ended.id, ended.reason, ended.outcome, count(ended.before), count(ended.after), count(ended.ms)].join(';');
  }
  return out;
}

// Pi folds the system prompt into a leading system message before a call
// reaches a provider, so a summary is recognised in either shape.
function systemText(context) {
  if (typeof context?.systemPrompt === 'string') return context.systemPrompt;
  const first = context?.messages?.[0];
  if (first?.role !== 'system') return '';
  if (typeof first.content === 'string') return first.content;
  return Array.isArray(first.content) ? first.content.filter(p => p?.type === 'text').map(p => p.text).join('') : '';
}
