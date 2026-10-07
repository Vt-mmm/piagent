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
// sends the main agent back (checks, review findings, a missing plan).
export function purposeHeaders(owner, runtime, role, context) {
  const messages = context?.messages ?? [], last = messages.at(-1);
  let purpose, after = '';
  if (systemText(context).startsWith(SUMMARY_PROMPT)) purpose = 'summary';
  else if (last?.role === 'toolResult') { purpose = 'tool_step'; after = afterTools(messages.findLast(m => m.role === 'assistant')); }
  else if (role !== 'main') purpose = 'brief';
  else if (owner.nextPurpose === 'harness') { purpose = 'harness'; owner.nextPurpose = null; }
  else purpose = 'answer';
  const title = purpose === 'brief' ? owner.jobTitles?.get(runtime) : '';
  return { 'X-Agent-Purpose': purpose, ...(after ? { 'X-Agent-After': after } : {}), ...(title ? { 'X-Agent-Task': encodeURIComponent(title) } : {}) };
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
